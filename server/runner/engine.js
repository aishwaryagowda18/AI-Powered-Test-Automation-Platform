import { describeRow, parseDataset } from './dataset.js';
import { findMissingProducers, planDependencies, variablesProvided } from './dependencies.js';
import { runHttpTest } from './http-runner.js';
import { runScriptTest } from './script-runner.js';
import { resolveVariables } from './template.js';

const RUNNERS = { http: runHttpTest, script: runScriptTest };
const MAX_LOG_ENTRIES = 500;

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** One run item per test, or one per dataset row for data-driven tests. */
export function expandIterations(test) {
  const content = test.config?.dataset?.content;
  if (!content?.trim()) return [{ test, iteration: null }];
  try {
    const { rows } = parseDataset(content);
    if (!rows.length) return [{ test, iteration: null }];
    return rows.map((data, i) => ({ test, iteration: { index: i + 1, total: rows.length, data } }));
  } catch {
    return [{ test, iteration: null }];
  }
}

/** Order tests so that producers of variables come before their consumers. */
function topologicalOrder(tests) {
  const items = tests.map((test, i) => ({ key: i, test }));
  const { deps } = planDependencies(items);
  const done = new Set();
  const out = [];
  while (out.length < items.length) {
    const next = items.find((it) => !done.has(it.key) && [...deps.get(it.key)].every((d) => done.has(d))) ?? items.find((it) => !done.has(it.key));
    done.add(next.key);
    out.push(next.test);
  }
  return out;
}

/**
 * Orchestrates test runs: resolves which tests to run (pulling in producers of
 * chained variables), expands data-driven tests into one item per row, executes
 * items with a bounded worker pool in dependency order, retries failures,
 * records results, and streams progress through the event bus.
 */
export class TestEngine {
  /** @type {Map<number, AbortController>} */
  #active = new Map();

  constructor({ store, bus, analyzer, serverUrl }) {
    this.store = store;
    this.bus = bus;
    this.analyzer = analyzer;
    this.serverUrl = serverUrl;
  }

  get activeRunIds() {
    return [...this.#active.keys()];
  }

  resolveEnvironment(environmentId) {
    const env = environmentId ? this.store.getEnvironment(environmentId) : this.store.getDefaultEnvironment();
    if (environmentId && !env) throw new HttpError(404, `Environment ${environmentId} not found`);
    return env;
  }

  variablesFor(env) {
    return resolveVariables(env?.variables ?? {}, { serverUrl: this.serverUrl() });
  }

  /** Create a run and start executing it in the background. Returns the queued run. */
  startRun({ testIds, suiteId, environmentId, name, trigger = 'manual' } = {}) {
    let tests;
    let label;
    if (testIds?.length) {
      tests = this.store.getTestsByIds(testIds);
      if (tests.length !== new Set(testIds.map(Number)).size) throw new HttpError(404, 'One or more tests were not found');
      label = tests.length === 1 ? tests[0].name : `${tests.length} selected tests`;
    } else if (suiteId) {
      const suite = this.store.getSuite(suiteId);
      if (!suite) throw new HttpError(404, `Suite ${suiteId} not found`);
      tests = this.store.listTests({ suiteId, enabledOnly: true });
      label = suite.name;
    } else {
      tests = this.store.listTests({ enabledOnly: true });
      label = 'All tests';
    }
    if (!tests.length) throw new HttpError(400, 'No enabled tests to run');

    const environment = this.resolveEnvironment(environmentId);
    // Pull in tests that capture variables the selection needs (e.g. a login that provides {{token}}).
    const added = findMissingProducers(tests, this.store.listTests({ enabledOnly: true }), this.variablesFor(environment));
    const allTests = [...added.map((a) => a.test), ...tests];
    const reasons = new Map(added.map((a) => [a.test.id, a.forVariables]));

    const run = this.store.createRun({
      name: name?.trim() || label,
      trigger,
      suiteId: suiteId ?? null,
      environment,
      items: allTests.flatMap(expandIterations),
    });
    this.bus.publish('run:created', run);

    const controller = new AbortController();
    this.#active.set(run.id, controller);
    setImmediate(() =>
      this.#execute(run, allTests, environment, controller.signal, reasons).catch((err) => {
        console.error(`[engine] run ${run.id} crashed:`, err);
      }),
    );
    return run;
  }

  /**
   * Execute a single test definition without persisting anything (the editor's
   * "Try it"). Producers of variables it needs run first; datasets use row 1.
   */
  async tryTest(test, environmentId, { iteration: forcedIteration } = {}) {
    const env = this.resolveEnvironment(environmentId);
    const baseVars = this.variablesFor(env);
    const logs = [];
    const log = (level, message) => logs.push({ ts: new Date().toISOString(), level, message });
    const signal = new AbortController().signal;
    const runVars = {};

    const self = { ...test, id: test.id ?? 'draft' };
    const candidates = this.store.listTests({ enabledOnly: true }).filter((t) => t.id !== test.id);
    const producers = findMissingProducers([self], candidates, baseVars);
    for (const p of topologicalOrder(producers.map((x) => x.test))) {
      const reason = producers.find((x) => x.test.id === p.id)?.forVariables ?? [];
      log('info', `Running dependency "${p.name}" to capture ${reason.map((v) => `{{${v}}}`).join(', ')}`);
      const row = expandIterations(p)[0].iteration?.data ?? {};
      const out = await this.#attempt(p, { ...baseVars, ...runVars, ...row }, signal, (lvl, msg) => log(lvl, `  ↳ ${msg}`));
      Object.assign(runVars, out.extracted ?? {});
      if (out.status !== 'passed') log('warn', `Dependency "${p.name}" ${out.status}: ${out.errorMessage ?? ''}`);
    }

    const iteration = forcedIteration ?? expandIterations(test)[0].iteration;
    if (iteration) {
      log('info', `Data row ${iteration.index}/${iteration.total}: ${describeRow(iteration.data)}${iteration.total > 1 && !forcedIteration ? ' (Try it runs the first row only)' : ''}`);
    }
    const outcome = await this.#attempt(test, { ...baseVars, ...runVars, ...(iteration?.data ?? {}) }, signal, log);
    return { ...outcome, logs, iteration };
  }

  cancel(runId) {
    const controller = this.#active.get(Number(runId));
    if (!controller) return false;
    controller.abort();
    return true;
  }

  async waitForIdle(timeoutMs = 30000) {
    const deadline = Date.now() + timeoutMs;
    while (this.#active.size && Date.now() < deadline) await new Promise((r) => setTimeout(r, 50));
  }

  async #execute(run, tests, environment, signal, reasons) {
    const startedAt = new Date();
    this.bus.publish('run:updated', this.store.updateRun(run.id, { status: 'running', startedAt: startedAt.toISOString() }));

    const settings = this.store.getSettings();
    const baseVars = this.variablesFor(environment);
    const runVars = {};
    const testsById = new Map(tests.map((t) => [t.id, t]));
    const items = this.store.listResults(run.id).map((r) => ({ key: r.id, result: r, test: testsById.get(r.testCaseId), iteration: r.iteration }));
    const plan = planDependencies(items.filter((i) => i.test));
    for (const [a, b] of plan.cycles) {
      console.warn(`[engine] run ${run.id}: circular variable dependency between results ${a} and ${b}; ignoring that edge`);
    }

    const state = new Map(items.map((i) => [i.key, 'pending']));
    const counts = { passed: 0, failed: 0, errored: 0, skipped: 0, flaky: 0 };
    let waiters = [];
    const notify = () => {
      const w = waiters;
      waiters = [];
      w.forEach((resolve) => resolve());
    };
    signal.addEventListener('abort', notify, { once: true });

    const nextReady = () => {
      const pending = items.filter((i) => state.get(i.key) === 'pending');
      if (!pending.length) return { done: true };
      const ready = pending.find((i) => [...(plan.deps.get(i.key) ?? [])].every((d) => state.get(d) === 'done'));
      if (ready) return { item: ready };
      // Nothing ready and nothing running would mean a deadlock; cycles are removed, so this is defensive.
      if (![...state.values()].includes('running')) return { item: pending[0] };
      return {};
    };

    const worker = async () => {
      while (!signal.aborted) {
        const { item, done } = nextReady();
        if (done) return;
        if (!item) {
          await new Promise((resolve) => waiters.push(resolve));
          continue;
        }
        state.set(item.key, 'running');
        const finished = await this.#runOne(run.id, item, { baseVars, runVars, plan, items, signal, settings, reasons });
        if (finished.status === 'passed') counts.passed++;
        else if (finished.status === 'failed') counts.failed++;
        else if (finished.status === 'error') counts.errored++;
        else counts.skipped++;
        if (finished.flaky) counts.flaky++;
        state.set(item.key, 'done');
        this.bus.publish('run:updated', this.store.updateRun(run.id, counts));
        notify();
      }
    };

    const concurrency = Math.max(1, Math.min(Number(settings.maxConcurrency) || 1, 16, items.length));
    await Promise.all(Array.from({ length: concurrency }, worker));

    // Anything still pending was cut off by a cancel.
    for (const item of items.filter((i) => state.get(i.key) === 'pending')) {
      counts.skipped++;
      this.bus.publish(
        'result:updated',
        this.store.updateResult(item.result.id, { status: 'skipped', errorMessage: 'Run cancelled before this test started' }),
      );
    }

    const status = signal.aborted ? 'cancelled' : counts.failed + counts.errored > 0 ? 'failed' : 'passed';
    const finishedAt = new Date();
    const finalRun = this.store.updateRun(run.id, {
      ...counts,
      status,
      finishedAt: finishedAt.toISOString(),
      durationMs: finishedAt - startedAt,
    });
    this.#active.delete(run.id);
    this.bus.publish('run:updated', finalRun);
    this.bus.publish('run:finished', finalRun);

    if (settings.autoAnalyze && counts.failed + counts.errored > 0) {
      this.analyzer
        .autoAnalyzeRun(run.id, { aiLimit: Number(settings.aiAutoAnalyzeLimit) || 0 })
        .catch((err) => console.error(`[engine] auto-analysis of run ${run.id} failed:`, err.message));
    }
  }

  async #runOne(runId, item, { baseVars, runVars, plan, items, signal, settings, reasons }) {
    const { result, test, iteration } = item;
    if (!test) {
      return this.store.updateResult(result.id, { status: 'skipped', errorMessage: 'Test case was deleted' });
    }
    const logs = [];
    const log = (level, message) => {
      const entry = { ts: new Date().toISOString(), level, message: String(message) };
      if (logs.length < MAX_LOG_ENTRIES) logs.push(entry);
      this.bus.publish('log', { runId, resultId: result.id, testName: iteration ? `${test.name} [row ${iteration.index}]` : test.name, ...entry });
    };
    const row = iteration?.data ?? {};

    // A chained variable that the run was supposed to capture is missing: the producer failed.
    const available = { ...baseVars, ...runVars, ...row };
    const missing = [...(plan.needs.get(item.key) ?? [])].filter((v) => !(v in available) && plan.providers.get(v)?.length);
    if (missing.length) {
      const producerNames = [...new Set(missing.flatMap((v) => plan.providers.get(v)).map((k) => items.find((i) => i.key === k)?.test?.name).filter(Boolean))];
      const message = `Skipped: ${missing.map((v) => `{{${v}}}`).join(', ')} was not captured because ${producerNames.map((n) => `"${n}"`).join(', ')} did not provide it`;
      log('warn', message);
      const skipped = this.store.updateResult(result.id, { status: 'skipped', errorMessage: message, logs, finishedAt: new Date().toISOString() });
      this.bus.publish('result:updated', skipped);
      return skipped;
    }

    const startedAt = new Date();
    this.bus.publish('result:updated', this.store.updateResult(result.id, { status: 'running', startedAt: startedAt.toISOString() }));
    log('info', `Starting "${test.name}" (${test.type.toUpperCase()})`);
    if (reasons.has(test.id)) {
      log('info', `Added to this run automatically: it captures ${reasons.get(test.id).map((v) => `{{${v}}}`).join(', ')} needed by other tests`);
    }
    if (iteration) log('info', `Data row ${iteration.index}/${iteration.total}: ${describeRow(row)}`);
    const used = [...(plan.needs.get(item.key) ?? [])].filter((v) => v in runVars);
    if (used.length) log('debug', `Using chained variables: ${used.map((v) => `{{${v}}}`).join(', ')}`);

    const maxAttempts = Math.max(1, (Number(test.retries) || 0) + 1);
    let outcome;
    let attempt = 0;
    while (attempt < maxAttempts && !signal.aborted) {
      attempt++;
      if (attempt > 1) log('warn', `Retrying (attempt ${attempt} of ${maxAttempts})`);
      outcome = await this.#attempt(test, { ...baseVars, ...runVars, ...row }, signal, log, settings);
      if (outcome.status === 'passed') break;
    }

    if (signal.aborted && outcome?.status !== 'passed') {
      outcome = { ...outcome, status: 'skipped', errorMessage: 'Run cancelled' };
    }
    // Share captured values with the rest of the run (last writer wins).
    if (outcome.extracted) Object.assign(runVars, outcome.extracted);
    const expected = [...variablesProvided(test)].filter((v) => !(v in (outcome.extracted ?? {})));
    if (expected.length && outcome.status !== 'skipped') {
      log('warn', `Did not capture ${expected.map((v) => `{{${v}}}`).join(', ')}. Tests that depend on it will be skipped.`);
    }

    const flaky = outcome.status === 'passed' && attempt > 1;
    if (flaky) log('warn', `Passed on attempt ${attempt} — marked as flaky`);
    const finishedAt = new Date();
    log(outcome.status === 'passed' ? 'pass' : 'fail', `Finished with status ${outcome.status.toUpperCase()} in ${finishedAt - startedAt} ms`);

    const final = this.store.updateResult(result.id, {
      status: outcome.status,
      durationMs: outcome.durationMs ?? finishedAt - startedAt,
      attempts: attempt,
      flaky,
      errorMessage: outcome.errorMessage,
      errorStack: outcome.errorStack,
      assertions: outcome.assertions ?? [],
      logs,
      request: outcome.request,
      response: outcome.response,
      finishedAt: finishedAt.toISOString(),
    });
    this.bus.publish('result:updated', final);
    return final;
  }

  async #attempt(test, vars, signal, log, settings = this.store.getSettings()) {
    const runner = RUNNERS[test.type];
    const timeoutMs = Number(test.timeoutMs) || Number(settings.defaultTimeoutMs) || 10000;
    const started = performance.now();
    if (!runner) return { status: 'error', errorMessage: `Unsupported test type "${test.type}"`, assertions: [] };
    try {
      const outcome = await runner(test, { vars, signal, log, timeoutMs });
      return { ...outcome, durationMs: Math.round(performance.now() - started) };
    } catch (err) {
      return {
        status: 'error',
        errorMessage: err.message,
        errorStack: err.stack ? String(err.stack).split('\n').slice(0, 6).join('\n') : null,
        assertions: [],
        request: err.request ?? null,
        response: null,
        durationMs: Math.round(performance.now() - started),
      };
    }
  }
}
