import express from 'express';
import { CATEGORIES } from './ai/categories.js';
import { buildAnalytics } from './analytics.js';
import { REPORT_FORMATS, generateReport } from './reports.js';
import { parseDataset } from './runner/dataset.js';
import { variablesNeeded, variablesProvided } from './runner/dependencies.js';
import { HttpError } from './runner/engine.js';
import { describeCron, nextRun } from './scheduler/cron.js';
import { validateChannel, validateEnvironment, validateSchedule, validateSettings, validateTest } from './validation.js';

const id = (req) => {
  const n = Number(req.params.id);
  if (!Number.isInteger(n) || n < 1) throw new HttpError(400, 'Invalid id');
  return n;
};
const notFound = (what) => new HttpError(404, `${what} not found`);

export function createApiRouter({ store, bus, engine, analyzer, scheduler, notifier }) {
  const api = express.Router();

  api.get('/health', (_req, res) => res.json({ status: 'ok', activeRuns: engine.activeRunIds.length, ai: analyzer.status() }));
  api.get('/events', bus.sseHandler());

  // ------------------------------------------------------------- test cases
  /** Chaining & data metadata the UI shows next to each test. */
  const withChaining = (t) => {
    let datasetRows = 0;
    try {
      datasetRows = parseDataset(t.config?.dataset?.content).rows.length;
    } catch {
      datasetRows = 0;
    }
    return { ...t, provides: [...variablesProvided(t)], needs: [...variablesNeeded(t)], datasetRows };
  };

  api.get('/tests', (req, res) => {
    const { search, type, suiteId, tag } = req.query;
    res.json(store.listTests({ search, type, suiteId, tag }).map(withChaining));
  });

  api.post('/tests/dataset/preview', (req, res) => {
    try {
      const { columns, rows } = parseDataset(req.body?.content);
      res.json({ columns, rows: rows.slice(0, 20), total: rows.length });
    } catch (err) {
      throw new HttpError(400, err.message);
    }
  });

  api.get('/tests/export', (_req, res) => {
    const suites = Object.fromEntries(store.listSuites().map((s) => [s.id, s.name]));
    const tests = store.listTests().map(({ name, description, type, suiteId, tags, priority, config, timeoutMs, retries, enabled }) => ({
      name,
      description,
      type,
      suite: suiteId ? suites[suiteId] : null,
      tags,
      priority,
      config,
      timeoutMs,
      retries,
      enabled,
    }));
    res.setHeader('Content-Disposition', 'attachment; filename="testforge-tests.json"');
    res.json({ version: 1, exportedAt: new Date().toISOString(), tests });
  });

  api.post('/tests/import', (req, res) => {
    const items = Array.isArray(req.body) ? req.body : req.body?.tests;
    if (!Array.isArray(items) || !items.length) throw new HttpError(400, 'Expected an array of tests (or { tests: [...] })');
    const suitesByName = new Map(store.listSuites().map((s) => [s.name, s.id]));
    const created = store.transaction(() =>
      items.map((item, i) => {
        let suiteId = item.suiteId ?? null;
        if (item.suite) {
          if (!suitesByName.has(item.suite)) suitesByName.set(item.suite, store.createSuite({ name: item.suite }).id);
          suiteId = suitesByName.get(item.suite);
        }
        try {
          return store.createTest(validateTest({ ...item, suiteId }));
        } catch (err) {
          throw new HttpError(400, `Test #${i + 1} (${item.name ?? 'unnamed'}): ${err.message}`);
        }
      }),
    );
    res.status(201).json({ imported: created.length, tests: created });
  });

  api.post('/tests/try', async (req, res) => {
    const test = validateTest(req.body.test ?? {});
    const outcome = await engine.tryTest({ ...test, timeoutMs: test.timeoutMs ?? 10000 }, req.body.environmentId);
    res.json(outcome);
  });

  api.post('/tests', (req, res) => res.status(201).json(store.createTest(validateTest(req.body))));

  api.get('/tests/:id', (req, res) => {
    const test = store.getTest(id(req));
    if (!test) throw notFound('Test');
    res.json(withChaining(test));
  });

  api.put('/tests/:id', (req, res) => {
    const test = store.updateTest(id(req), validateTest(req.body, { partial: true }));
    if (!test) throw notFound('Test');
    res.json(test);
  });

  api.delete('/tests/:id', (req, res) => {
    if (!store.deleteTest(id(req))) throw notFound('Test');
    res.status(204).end();
  });

  api.post('/tests/:id/duplicate', (req, res) => {
    const test = store.getTest(id(req));
    if (!test) throw notFound('Test');
    const { id: _id, createdAt, updatedAt, lastStatus, lastDurationMs, lastRunAt, suiteName, ...rest } = test;
    res.status(201).json(store.createTest({ ...rest, name: `${test.name} (copy)` }));
  });

  api.get('/tests/:id/history', (req, res) => {
    const testId = id(req);
    if (!store.getTest(testId)) throw notFound('Test');
    res.json(store.getTestHistory(testId, Number(req.query.limit) || 30).map(({ logs, request, response, ...r }) => r));
  });

  // ----------------------------------------------------------------- suites
  api.get('/suites', (_req, res) => res.json(store.listSuites()));

  api.post('/suites', (req, res) => {
    const name = String(req.body.name ?? '').trim();
    if (!name) throw new HttpError(400, 'name is required');
    try {
      res.status(201).json(store.createSuite({ name, description: String(req.body.description ?? '') }));
    } catch {
      throw new HttpError(409, `A suite named "${name}" already exists`);
    }
  });

  api.put('/suites/:id', (req, res) => {
    const suite = store.updateSuite(id(req), { name: req.body.name?.trim() || undefined, description: req.body.description });
    if (!suite) throw notFound('Suite');
    res.json(suite);
  });

  api.delete('/suites/:id', (req, res) => {
    if (!store.deleteSuite(id(req))) throw notFound('Suite');
    res.status(204).end();
  });

  // ----------------------------------------------------------- environments
  api.get('/environments', (_req, res) => res.json(store.listEnvironments()));

  api.post('/environments', (req, res) => {
    try {
      res.status(201).json(store.createEnvironment(validateEnvironment(req.body)));
    } catch (err) {
      if (err.status) throw err;
      throw new HttpError(409, 'An environment with that name already exists');
    }
  });

  api.put('/environments/:id', (req, res) => {
    const env = store.updateEnvironment(id(req), validateEnvironment(req.body, { partial: true }));
    if (!env) throw notFound('Environment');
    res.json(env);
  });

  api.delete('/environments/:id', (req, res) => {
    if (!store.deleteEnvironment(id(req))) throw notFound('Environment');
    res.status(204).end();
  });

  // ------------------------------------------------------------------- runs
  api.get('/runs', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 50, 200);
    const offset = Number(req.query.offset) || 0;
    res.json(store.listRuns({ status: req.query.status || undefined, limit, offset }));
  });

  api.post('/runs', (req, res) => {
    const { testIds, suiteId, environmentId, name } = req.body ?? {};
    const run = engine.startRun({
      testIds: Array.isArray(testIds) ? testIds.map(Number) : undefined,
      suiteId: suiteId ? Number(suiteId) : undefined,
      environmentId: environmentId ? Number(environmentId) : undefined,
      name,
      trigger: req.body?.trigger === 'ci' ? 'ci' : 'manual',
    });
    res.status(202).json(run);
  });

  api.get('/runs/:id', (req, res) => {
    const run = store.getRun(id(req));
    if (!run) throw notFound('Run');
    res.json({ ...run, results: store.listResults(run.id) });
  });

  api.post('/runs/:id/cancel', (req, res) => {
    const runId = id(req);
    if (!store.getRun(runId)) throw notFound('Run');
    if (!engine.cancel(runId)) throw new HttpError(409, 'Run is not active');
    res.json({ cancelled: true });
  });

  api.post('/runs/:id/rerun', (req, res) => {
    const run = store.getRun(id(req));
    if (!run) throw notFound('Run');
    const onlyFailed = req.body?.onlyFailed !== false;
    const ids = store
      .listResults(run.id)
      .filter((r) => r.testCaseId && (!onlyFailed || r.status === 'failed' || r.status === 'error'))
      .map((r) => r.testCaseId);
    if (!ids.length) throw new HttpError(400, onlyFailed ? 'This run has no failed tests to re-run' : 'No tests to re-run');
    const next = engine.startRun({
      testIds: ids,
      environmentId: run.environmentId ?? undefined,
      name: `${onlyFailed ? 'Re-run failed' : 'Re-run'}: ${run.name}`,
    });
    res.status(202).json(next);
  });

  api.delete('/runs/:id', (req, res) => {
    const runId = id(req);
    if (engine.activeRunIds.includes(runId)) throw new HttpError(409, 'Cancel the run before deleting it');
    if (!store.deleteRun(runId)) throw notFound('Run');
    res.status(204).end();
  });

  api.delete('/runs', (_req, res) => {
    if (engine.activeRunIds.length) throw new HttpError(409, 'Runs are in progress');
    store.clearRuns();
    res.status(204).end();
  });

  api.get('/runs/:id/report', (req, res) => {
    const run = store.getRun(id(req));
    if (!run) throw notFound('Run');
    const format = REPORT_FORMATS[req.query.format] ? req.query.format : 'html';
    const { ext, type } = REPORT_FORMATS[format];
    const body = generateReport(format, run, store.listResults(run.id));
    res.setHeader('Content-Type', type);
    if (req.query.download !== '0') {
      res.setHeader('Content-Disposition', `attachment; filename="testforge-run-${run.id}${format === 'junit' ? '-junit' : ''}.${ext}"`);
    }
    res.send(body);
  });

  api.post('/runs/:id/analyze', async (req, res) => {
    const run = await analyzer.summarizeRun(id(req), { useAI: req.body?.useAI !== false });
    if (!run) throw notFound('Run');
    res.json(run);
  });

  // --------------------------------------------------------------- results
  api.post('/results/:id/analyze', async (req, res) => {
    const result = await analyzer.analyzeResult(id(req), { useAI: req.body?.useAI !== false });
    if (!result) throw notFound('Result');
    res.json(result);
  });

  // ------------------------------------------------------------- AI fixes
  /** Propose a fix and verify it by executing the fixed test against the live target. */
  api.post('/results/:id/fix', async (req, res) => {
    const proposal = await analyzer.proposeFix(id(req), { useAI: req.body?.useAI !== false });
    if (!proposal) throw notFound('Result');
    let verification = null;
    if (proposal.fixable) {
      const test = store.getTest(proposal.testId);
      const fixed = { ...test, config: test.type === 'http' ? { ...test.config, assertions: proposal.after.assertions } : { ...test.config, code: proposal.after.code } };
      try {
        validateTest(fixed);
        const outcome = await engine.tryTest(fixed, proposal.environmentId ?? undefined, { iteration: proposal.iteration ?? undefined });
        verification = {
          status: outcome.status,
          errorMessage: outcome.errorMessage,
          assertions: outcome.assertions,
          durationMs: outcome.durationMs,
        };
      } catch (err) {
        verification = { status: 'error', errorMessage: err.message, assertions: [] };
      }
    }
    res.json({ ...proposal, verification });
  });

  /** Apply a proposed fix. Refuses if the test changed after the proposal was made. */
  api.post('/tests/:id/apply-fix', (req, res) => {
    const test = store.getTest(id(req));
    if (!test) throw notFound('Test');
    const { baseUpdatedAt, assertions, code } = req.body ?? {};
    if (baseUpdatedAt && baseUpdatedAt !== test.updatedAt) {
      throw new HttpError(409, 'The test was edited after this fix was proposed. Generate a new proposal.');
    }
    const config = test.type === 'http' ? { ...test.config, assertions } : { ...test.config, code };
    if (test.type === 'http' && !Array.isArray(assertions)) throw new HttpError(400, 'assertions must be an array');
    if (test.type === 'script' && typeof code !== 'string') throw new HttpError(400, 'code must be a string');
    const updated = store.updateTest(test.id, validateTest({ type: test.type, config }, { partial: true }));
    bus.publish('test:updated', updated);
    res.json(withChaining(updated));
  });

  // ------------------------------------------------------------ AI insights
  api.get('/ai/status', (_req, res) => res.json({ ...analyzer.status(), categories: CATEGORIES }));

  api.get('/insights', (req, res) => {
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    const failures = store.listFinishedResults({ failuresOnly: true, limit }).map(({ logs, response, request, ...r }) => r);
    const counts = {};
    for (const f of failures) {
      const key = f.analysis?.category ?? 'unanalyzed';
      counts[key] = (counts[key] ?? 0) + 1;
    }
    res.json({
      failures,
      categories: Object.entries(counts)
        .map(([category, count]) => ({ category, label: CATEGORIES[category] ?? 'Not analyzed yet', count }))
        .sort((a, b) => b.count - a.count),
      unanalyzed: failures.filter((f) => !f.analysis).length,
      ai: analyzer.status(),
    });
  });

  api.post('/insights/analyze-pending', async (req, res) => {
    const limit = Math.min(Number(req.body?.limit) || 10, 50);
    const pending = store
      .listFinishedResults({ failuresOnly: true, limit: 500 })
      .filter((r) => !r.analysis || (req.body?.upgrade && r.analysis.source === 'heuristic'))
      .slice(0, limit);
    for (const r of pending) await analyzer.analyzeResult(r.id, { useAI: req.body?.useAI !== false });
    res.json({ analyzed: pending.length });
  });

  // ------------------------------------------------------- test generation
  api.post('/generate', async (req, res) => {
    const { source, input, useAI, environmentId } = req.body ?? {};
    const env = engine.resolveEnvironment(environmentId ? Number(environmentId) : undefined);
    res.json(await analyzer.generateTests({ source, input, useAI: useAI !== false, variables: engine.variablesFor(env) }));
  });

  // -------------------------------------------------------------- schedules
  const withNext = (s) => ({ ...s, description: describeCron(s.cron), upcoming: s.enabled ? upcomingRuns(s.cron, 3) : [] });
  const upcomingRuns = (cron, n) => {
    const out = [];
    let from = new Date();
    for (let i = 0; i < n; i++) {
      const next = nextRun(cron, from);
      if (!next) break;
      out.push(next.toISOString());
      from = next;
    }
    return out;
  };
  const checkScheduleTarget = (s) => {
    if (s.suiteId && !store.getSuite(s.suiteId)) throw new HttpError(400, 'Suite not found');
    if (s.environmentId && !store.getEnvironment(s.environmentId)) throw new HttpError(400, 'Environment not found');
  };

  api.get('/schedules', (_req, res) => res.json(store.listSchedules().map(withNext)));

  api.post('/schedules/preview', (req, res) => {
    try {
      res.json({ description: describeCron(req.body.cron), upcoming: upcomingRuns(req.body.cron, 5) });
    } catch (err) {
      throw new HttpError(400, err.message);
    }
  });

  api.post('/schedules', (req, res) => {
    const data = validateSchedule(req.body ?? {});
    checkScheduleTarget(data);
    const created = store.createSchedule(data);
    scheduler.resync();
    res.status(201).json(withNext(store.getSchedule(created.id)));
  });

  api.put('/schedules/:id', (req, res) => {
    const data = validateSchedule(req.body ?? {}, { partial: true });
    checkScheduleTarget(data);
    if (!store.updateSchedule(id(req), data)) throw notFound('Schedule');
    scheduler.resync();
    res.json(withNext(store.getSchedule(id(req))));
  });

  api.post('/schedules/:id/run', (req, res) => {
    const schedule = store.getSchedule(id(req));
    if (!schedule) throw notFound('Schedule');
    const run = scheduler.runNow(schedule);
    if (!run) throw new HttpError(400, store.getSchedule(schedule.id).lastError ?? 'Could not start run');
    res.status(202).json(run);
  });

  api.delete('/schedules/:id', (req, res) => {
    if (!store.deleteSchedule(id(req))) throw notFound('Schedule');
    res.status(204).end();
  });

  // ---------------------------------------------------------- notifications
  api.get('/notifications', (_req, res) => res.json(store.listChannels()));

  api.post('/notifications', (req, res) => res.status(201).json(store.createChannel(validateChannel(req.body ?? {}))));

  api.put('/notifications/:id', (req, res) => {
    const channel = store.updateChannel(id(req), validateChannel(req.body ?? {}, { partial: true }));
    if (!channel) throw notFound('Notification channel');
    res.json(channel);
  });

  api.post('/notifications/:id/test', async (req, res) => {
    const channel = store.getChannel(id(req));
    if (!channel) throw notFound('Notification channel');
    res.json(await notifier.sendTest(channel));
  });

  api.delete('/notifications/:id', (req, res) => {
    if (!store.deleteChannel(id(req))) throw notFound('Notification channel');
    res.status(204).end();
  });

  // -------------------------------------------------------------- analytics
  api.get('/analytics', (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), 200);
    res.json(buildAnalytics(store, { limit, activeRunIds: engine.activeRunIds }));
  });

  // --------------------------------------------------------------- settings
  api.get('/settings', (_req, res) => res.json({ settings: store.getSettings(), ai: analyzer.status() }));
  api.put('/settings', (req, res) => res.json({ settings: store.updateSettings(validateSettings(req.body ?? {})), ai: analyzer.status() }));

  api.use((_req, _res, next) => next(new HttpError(404, 'API route not found')));
  return api;
}
