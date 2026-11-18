const express = require('express');
const { MongoClient } = require('mongodb');
const { metrics, trace } = require('@opentelemetry/api');
const sdk = require('./tracing');

const app = express();
app.use(express.json());
const port = Number(process.env.PORT || 3000);
const client = new MongoClient(
  process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/',
  { serverSelectionTimeoutMS: 5000 },
);
let db;
let server;

const meter = metrics.getMeter('todo-application');
const requestCount = meter.createCounter('todo.http.requests', {
  description: 'Completed HTTP requests',
});
const requestDuration = meter.createHistogram('todo.http.duration', {
  description: 'HTTP request duration',
  unit: 'ms',
});

app.use((req, res, next) => {
  const started = process.hrtime.bigint();
  const spanContext = trace.getActiveSpan()?.spanContext();
  res.on('finish', () => {
    const duration = Number(process.hrtime.bigint() - started) / 1e6;
    const route = req.route?.path || 'unmatched';
    const attributes = {
      'http.request.method': req.method,
      'http.route': route,
      'http.response.status_code': res.statusCode,
    };
    requestCount.add(1, attributes);
    requestDuration.record(duration, attributes);
    console.log(JSON.stringify({
      timestamp: new Date().toISOString(),
      event: 'request_completed',
      method: req.method,
      route,
      status: res.statusCode,
      duration_ms: Number(duration.toFixed(3)),
      trace_id: spanContext?.traceId,
      span_id: spanContext?.spanId,
    }));
  });
  next();
});

app.get('/todo', async (req, res) => {
  const todos = await db.collection('todos').find({}).toArray();
  res.send(todos);
});

app.get('/todo/:id', async (req, res) => {
  const todo = await db.collection('todos').findOne({ id: req.params.id });
  if (!todo) return res.status(404).json({ error: 'Todo not found' });
  res.send(todo);
});

app.use((error, req, res, next) => {
  const span = trace.getActiveSpan();
  span?.recordException(error);
  span?.setStatus({ code: 2, message: error.message });
  console.error(JSON.stringify({
    timestamp: new Date().toISOString(),
    event: 'request_failed',
    message: error.message,
    trace_id: span?.spanContext().traceId,
  }));
  if (res.headersSent) return next(error);
  res.status(500).json({ error: 'Unable to retrieve todos' });
});

const startServer = async () => {
  await client.connect();
  db = client.db('todo');
  const samples = [
    { id: '1', title: 'Buy groceries' },
    { id: '2', title: 'Install Aspecto' },
    { id: '3', title: 'buy my own name domain' },
  ];
  await db.collection('todos').createIndex({ id: 1 }, { unique: true });
  await db.collection('todos').bulkWrite(samples.map(todo => ({
    updateOne: { filter: { id: todo.id }, update: { $setOnInsert: todo }, upsert: true },
  })));
  server = app.listen(port, '127.0.0.1', () => {
    console.log(`Example app listening on http://127.0.0.1:${port}`);
  });
};

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  try {
    if (server) await new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
    });
    await client.close();
    await sdk.shutdown();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

startServer().catch(async error => {
  console.error('Startup failed:', error.message);
  process.exitCode = 1;
  await shutdown();
});
