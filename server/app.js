import { existsSync } from 'node:fs';
import path from 'node:path';
import express from 'express';
import { Analyzer } from './ai/analyzer.js';
import { config as defaultConfig } from './config.js';
import { Store } from './db.js';
import { createDemoApi } from './demo-api.js';
import { EventBus } from './events.js';
import { Notifier } from './notifications.js';
import { Scheduler } from './scheduler/scheduler.js';
import { createApiRouter } from './routes.js';
import { TestEngine } from './runner/engine.js';
import { seedDatabase } from './seed.js';

/**
 * Build the application. Kept separate from `listen()` so tests can create
 * isolated instances against a temporary database.
 */
export function createApp(overrides = {}) {
  const config = { ...defaultConfig, ...overrides, ai: { ...defaultConfig.ai, ...overrides.ai } };
  const store = new Store(config.dbPath);
  store.recoverInterruptedRuns();

  const seeded = store.isEmpty();
  if (seeded && config.seed !== false) seedDatabase(store);

  const bus = new EventBus();
  const analyzer = new Analyzer({ store, bus, aiConfig: config.ai });
  const state = { serverUrl: `http://127.0.0.1:${config.port}` };
  const engine = new TestEngine({ store, bus, analyzer, serverUrl: () => state.serverUrl });
  const scheduler = new Scheduler({ store, engine, bus });
  const notifier = new Notifier({ store, bus, publicUrl: () => config.publicUrl || state.serverUrl.replace('127.0.0.1', 'localhost') });

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  app.use('/demo-api', createDemoApi());
  app.use('/api', createApiRouter({ store, bus, engine, analyzer, scheduler, notifier }));

  if (existsSync(config.clientDist)) {
    app.use(express.static(config.clientDist, { index: false, maxAge: '1h' }));
    app.use((req, res, next) => {
      if (req.method !== 'GET' || req.path.startsWith('/api') || req.path.startsWith('/demo-api')) return next();
      // index.html must never be cached, so a refresh always picks up the latest hashed bundle.
      res.sendFile(path.join(config.clientDist, 'index.html'), { headers: { 'Cache-Control': 'no-cache' } });
    });
  } else {
    app.get('/', (_req, res) =>
      res
        .type('html')
        .send('<p style="font-family:system-ui">API is running. Start the UI with <code>npm run dev</code> (http://localhost:5173) or build it with <code>npm run build</code>.</p>'),
    );
  }

  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    const status = err.status ?? err.statusCode ?? 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: err.message ?? 'Internal error', ...(err.errors ? { details: err.errors } : {}) });
  });

  return {
    app,
    store,
    bus,
    engine,
    analyzer,
    scheduler,
    notifier,
    config,
    seeded,
    setServerUrl: (url) => {
      state.serverUrl = url;
    },
  };
}
