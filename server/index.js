import { createApp } from './app.js';

const { app, store, engine, analyzer, scheduler, config, seeded, setServerUrl } = createApp();

const server = app.listen(config.port, () => {
  const url = `http://localhost:${config.port}`;
  setServerUrl(`http://127.0.0.1:${config.port}`);
  const ai = analyzer.status();
  console.log(`\n  TestForge AI  →  ${url}`);
  console.log(`  Database      →  ${config.dbPath}`);
  const fallback = ai.fallbackModels?.length ? `, fallback ${ai.fallbackModels.join(', ')}` : '';
  console.log(`  AI analysis   →  ${ai.enabled ? `${ai.providerLabel} (${ai.model}${fallback})` : 'heuristic engine (set GEMINI_API_KEY to enable AI)'}\n`);

  scheduler.start();
  const active = store.listSchedules().filter((s) => s.enabled).length;
  if (active) console.log(`  Scheduler     →  ${active} active schedule${active === 1 ? '' : 's'}\n`);

  if (seeded && config.seedDemoRuns > 0) seedDemoRuns(config.seedDemoRuns);
});

/** Execute a few real runs on first boot so the dashboard has history. */
async function seedDemoRuns(count) {
  console.log(`  Seeding: executing ${count} demo runs against the built-in demo API…`);
  for (let i = 0; i < count; i++) {
    try {
      engine.startRun({ name: i === count - 1 ? 'Nightly regression' : `Nightly regression (seed ${i + 1})`, trigger: 'seed' });
      await engine.waitForIdle(60000);
    } catch (err) {
      console.error('  Seeding run failed:', err.message);
      return;
    }
  }
  console.log('  Seeding complete.\n');
}

const shutdown = () => {
  console.log('\nShutting down…');
  scheduler.stop();
  for (const runId of engine.activeRunIds) engine.cancel(runId);
  server.close(() => {
    store.close();
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 3000).unref();
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
