import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS suites (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  description TEXT NOT NULL DEFAULT '',
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS test_cases (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  type        TEXT NOT NULL CHECK (type IN ('http', 'script')),
  suite_id    INTEGER REFERENCES suites(id) ON DELETE SET NULL,
  tags        TEXT NOT NULL DEFAULT '[]',
  priority    TEXT NOT NULL DEFAULT 'medium',
  config      TEXT NOT NULL DEFAULT '{}',
  timeout_ms  INTEGER NOT NULL DEFAULT 10000,
  retries     INTEGER NOT NULL DEFAULT 0,
  enabled     INTEGER NOT NULL DEFAULT 1,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS environments (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL UNIQUE,
  variables   TEXT NOT NULL DEFAULT '{}',
  is_default  INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS runs (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  name             TEXT NOT NULL,
  trigger          TEXT NOT NULL DEFAULT 'manual',
  status           TEXT NOT NULL,
  suite_id         INTEGER REFERENCES suites(id) ON DELETE SET NULL,
  environment_id   INTEGER REFERENCES environments(id) ON DELETE SET NULL,
  environment_name TEXT,
  total            INTEGER NOT NULL DEFAULT 0,
  passed           INTEGER NOT NULL DEFAULT 0,
  failed           INTEGER NOT NULL DEFAULT 0,
  errored          INTEGER NOT NULL DEFAULT 0,
  skipped          INTEGER NOT NULL DEFAULT 0,
  flaky            INTEGER NOT NULL DEFAULT 0,
  duration_ms      INTEGER,
  ai_summary       TEXT,
  created_at       TEXT NOT NULL,
  started_at       TEXT,
  finished_at      TEXT
);

CREATE TABLE IF NOT EXISTS results (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id         INTEGER NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  test_case_id   INTEGER REFERENCES test_cases(id) ON DELETE SET NULL,
  test_name      TEXT NOT NULL,
  test_type      TEXT NOT NULL,
  suite_name     TEXT,
  status         TEXT NOT NULL,
  duration_ms    INTEGER,
  attempts       INTEGER NOT NULL DEFAULT 0,
  flaky          INTEGER NOT NULL DEFAULT 0,
  error_message  TEXT,
  error_stack    TEXT,
  assertions     TEXT NOT NULL DEFAULT '[]',
  logs           TEXT NOT NULL DEFAULT '[]',
  request        TEXT,
  response       TEXT,
  analysis       TEXT,
  started_at     TEXT,
  finished_at    TEXT
);

CREATE INDEX IF NOT EXISTS idx_results_run ON results(run_id);
CREATE INDEX IF NOT EXISTS idx_results_test ON results(test_case_id);
CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at);

CREATE TABLE IF NOT EXISTS schedules (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  name           TEXT NOT NULL,
  cron           TEXT NOT NULL,
  suite_id       INTEGER REFERENCES suites(id) ON DELETE SET NULL,
  test_ids       TEXT NOT NULL DEFAULT '[]',
  environment_id INTEGER REFERENCES environments(id) ON DELETE SET NULL,
  enabled        INTEGER NOT NULL DEFAULT 1,
  next_run_at    TEXT,
  last_run_at    TEXT,
  last_run_id    INTEGER,
  last_error     TEXT,
  created_at     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS notification_channels (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT NOT NULL,
  type         TEXT NOT NULL CHECK (type IN ('slack', 'teams', 'webhook')),
  url          TEXT NOT NULL,
  notify_on    TEXT NOT NULL DEFAULT 'failures',
  scope        TEXT NOT NULL DEFAULT 'all',
  enabled      INTEGER NOT NULL DEFAULT 1,
  last_sent_at TEXT,
  last_status  TEXT,
  last_error   TEXT,
  created_at   TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

export const DEFAULT_SETTINGS = {
  maxConcurrency: 3,
  defaultTimeoutMs: 10000,
  autoAnalyze: true,
  aiAutoAnalyzeLimit: 5,
};

const now = () => new Date().toISOString();
const json = (value, fallback) => {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
};

const mapSuite = (row) => row && { ...row };

const mapTest = (row) =>
  row && {
    id: row.id,
    name: row.name,
    description: row.description,
    type: row.type,
    suiteId: row.suite_id,
    suiteName: row.suite_name ?? null,
    tags: json(row.tags, []),
    priority: row.priority,
    config: json(row.config, {}),
    timeoutMs: row.timeout_ms,
    retries: row.retries,
    enabled: Boolean(row.enabled),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastStatus: row.last_status ?? null,
    lastDurationMs: row.last_duration_ms ?? null,
    lastRunAt: row.last_run_at ?? null,
  };

const mapEnv = (row) =>
  row && {
    id: row.id,
    name: row.name,
    variables: json(row.variables, {}),
    isDefault: Boolean(row.is_default),
    createdAt: row.created_at,
  };

const mapRun = (row) =>
  row && {
    id: row.id,
    name: row.name,
    trigger: row.trigger,
    status: row.status,
    suiteId: row.suite_id,
    environmentId: row.environment_id,
    environmentName: row.environment_name,
    total: row.total,
    passed: row.passed,
    failed: row.failed,
    errored: row.errored,
    skipped: row.skipped,
    flaky: row.flaky,
    durationMs: row.duration_ms,
    aiSummary: json(row.ai_summary, null),
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };

const mapResult = (row) =>
  row && {
    id: row.id,
    runId: row.run_id,
    testCaseId: row.test_case_id,
    testName: row.test_name,
    testType: row.test_type,
    suiteName: row.suite_name,
    status: row.status,
    durationMs: row.duration_ms,
    attempts: row.attempts,
    flaky: Boolean(row.flaky),
    errorMessage: row.error_message,
    errorStack: row.error_stack,
    assertions: json(row.assertions, []),
    logs: json(row.logs, []),
    request: json(row.request, null),
    response: json(row.response, null),
    analysis: json(row.analysis, null),
    iteration: json(row.iteration, null),
    displayName: row.iteration ? `${row.test_name} [row ${json(row.iteration, {}).index}]` : row.test_name,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    runName: row.run_name,
    runCreatedAt: row.run_created_at,
  };

const mapSchedule = (row) =>
  row && {
    id: row.id,
    name: row.name,
    cron: row.cron,
    suiteId: row.suite_id,
    suiteName: row.suite_name ?? null,
    testIds: json(row.test_ids, []),
    environmentId: row.environment_id,
    environmentName: row.environment_name ?? null,
    enabled: Boolean(row.enabled),
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastRunId: row.last_run_id,
    lastRunStatus: row.last_run_status ?? null,
    lastError: row.last_error,
    createdAt: row.created_at,
  };

const mapChannel = (row) =>
  row && {
    id: row.id,
    name: row.name,
    type: row.type,
    url: row.url,
    notifyOn: row.notify_on,
    scope: row.scope,
    enabled: Boolean(row.enabled),
    lastSentAt: row.last_sent_at,
    lastStatus: row.last_status,
    lastError: row.last_error,
    createdAt: row.created_at,
  };

/** Data-access layer over node:sqlite. All methods are synchronous. */
export class Store {
  constructor(file) {
    if (file !== ':memory:') mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.db.exec(SCHEMA);
    this.#migrate();
  }

  /** Additive migrations for databases created by earlier versions. */
  #migrate() {
    const columns = new Set(this.db.prepare('PRAGMA table_info(results)').all().map((c) => c.name));
    if (!columns.has('iteration')) this.db.exec('ALTER TABLE results ADD COLUMN iteration TEXT');
  }

  close() {
    this.db.close();
  }

  transaction(fn) {
    this.db.exec('BEGIN');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  isEmpty() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM test_cases').get().n === 0;
  }

  // ---------------------------------------------------------------- settings
  getSettings() {
    const rows = this.db.prepare('SELECT key, value FROM settings').all();
    const stored = Object.fromEntries(rows.map((r) => [r.key, json(r.value, null)]));
    return { ...DEFAULT_SETTINGS, ...stored };
  }

  updateSettings(patch) {
    const stmt = this.db.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
    );
    for (const [key, value] of Object.entries(patch)) {
      if (key in DEFAULT_SETTINGS) stmt.run(key, JSON.stringify(value));
    }
    return this.getSettings();
  }

  // ------------------------------------------------------------------ suites
  listSuites() {
    const rows = this.db
      .prepare(
        `SELECT s.*,
           (SELECT COUNT(*) FROM test_cases t WHERE t.suite_id = s.id) AS test_count,
           (SELECT r.status FROM runs r WHERE r.suite_id = s.id AND r.finished_at IS NOT NULL
              ORDER BY r.id DESC LIMIT 1) AS last_run_status,
           (SELECT r.id FROM runs r WHERE r.suite_id = s.id ORDER BY r.id DESC LIMIT 1) AS last_run_id
         FROM suites s ORDER BY s.name`,
      )
      .all();
    return rows.map((r) => ({
      id: r.id,
      name: r.name,
      description: r.description,
      createdAt: r.created_at,
      testCount: r.test_count,
      lastRunStatus: r.last_run_status,
      lastRunId: r.last_run_id,
    }));
  }

  getSuite(id) {
    return mapSuite(this.db.prepare('SELECT * FROM suites WHERE id = ?').get(id));
  }

  createSuite({ name, description = '' }) {
    const { lastInsertRowid } = this.db
      .prepare('INSERT INTO suites (name, description, created_at) VALUES (?, ?, ?)')
      .run(name, description, now());
    return this.getSuite(Number(lastInsertRowid));
  }

  updateSuite(id, { name, description }) {
    const current = this.getSuite(id);
    if (!current) return null;
    this.db
      .prepare('UPDATE suites SET name = ?, description = ? WHERE id = ?')
      .run(name ?? current.name, description ?? current.description, id);
    return this.getSuite(id);
  }

  deleteSuite(id) {
    return this.db.prepare('DELETE FROM suites WHERE id = ?').run(id).changes > 0;
  }

  // -------------------------------------------------------------- test cases
  #testSelect = `
    SELECT t.*, s.name AS suite_name,
      lr.status AS last_status, lr.duration_ms AS last_duration_ms, lr.finished_at AS last_run_at
    FROM test_cases t
    LEFT JOIN suites s ON s.id = t.suite_id
    LEFT JOIN results lr ON lr.id = (
      SELECT r.id FROM results r
      WHERE r.test_case_id = t.id AND r.status NOT IN ('queued', 'running')
      ORDER BY r.id DESC LIMIT 1
    )`;

  listTests({ search, type, suiteId, tag, enabledOnly } = {}) {
    const where = [];
    const params = [];
    if (search) {
      where.push('(t.name LIKE ? OR t.description LIKE ?)');
      params.push(`%${search}%`, `%${search}%`);
    }
    if (type) {
      where.push('t.type = ?');
      params.push(type);
    }
    if (suiteId) {
      where.push('t.suite_id = ?');
      params.push(Number(suiteId));
    }
    if (enabledOnly) where.push('t.enabled = 1');
    const sql = `${this.#testSelect} ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY t.id`;
    let tests = this.db.prepare(sql).all(...params).map(mapTest);
    if (tag) tests = tests.filter((t) => t.tags.includes(tag));
    return tests;
  }

  getTest(id) {
    return mapTest(this.db.prepare(`${this.#testSelect} WHERE t.id = ?`).get(id));
  }

  getTestsByIds(ids) {
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    return this.db
      .prepare(`${this.#testSelect} WHERE t.id IN (${placeholders}) ORDER BY t.id`)
      .all(...ids.map(Number))
      .map(mapTest);
  }

  createTest(test) {
    const ts = now();
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO test_cases
          (name, description, type, suite_id, tags, priority, config, timeout_ms, retries, enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        test.name,
        test.description ?? '',
        test.type,
        test.suiteId ?? null,
        JSON.stringify(test.tags ?? []),
        test.priority ?? 'medium',
        JSON.stringify(test.config ?? {}),
        test.timeoutMs ?? 10000,
        test.retries ?? 0,
        test.enabled === false ? 0 : 1,
        ts,
        ts,
      );
    return this.getTest(Number(lastInsertRowid));
  }

  updateTest(id, test) {
    const current = this.getTest(id);
    if (!current) return null;
    const next = { ...current, ...test };
    this.db
      .prepare(
        `UPDATE test_cases SET name = ?, description = ?, type = ?, suite_id = ?, tags = ?, priority = ?,
           config = ?, timeout_ms = ?, retries = ?, enabled = ?, updated_at = ? WHERE id = ?`,
      )
      .run(
        next.name,
        next.description ?? '',
        next.type,
        next.suiteId ?? null,
        JSON.stringify(next.tags ?? []),
        next.priority ?? 'medium',
        JSON.stringify(next.config ?? {}),
        next.timeoutMs,
        next.retries,
        next.enabled ? 1 : 0,
        now(),
        id,
      );
    return this.getTest(id);
  }

  deleteTest(id) {
    return this.db.prepare('DELETE FROM test_cases WHERE id = ?').run(id).changes > 0;
  }

  getTestHistory(testCaseId, limit = 20) {
    return this.db
      .prepare(
        `SELECT r.*, ru.name AS run_name, ru.created_at AS run_created_at
         FROM results r JOIN runs ru ON ru.id = r.run_id
         WHERE r.test_case_id = ? AND r.status NOT IN ('queued', 'running')
         ORDER BY r.id DESC LIMIT ?`,
      )
      .all(testCaseId, limit)
      .map(mapResult);
  }

  // ------------------------------------------------------------ environments
  listEnvironments() {
    return this.db.prepare('SELECT * FROM environments ORDER BY is_default DESC, name').all().map(mapEnv);
  }

  getEnvironment(id) {
    return mapEnv(this.db.prepare('SELECT * FROM environments WHERE id = ?').get(id));
  }

  getDefaultEnvironment() {
    return mapEnv(this.db.prepare('SELECT * FROM environments ORDER BY is_default DESC, id LIMIT 1').get());
  }

  createEnvironment({ name, variables = {}, isDefault = false }) {
    return this.transaction(() => {
      if (isDefault) this.db.exec('UPDATE environments SET is_default = 0');
      const { lastInsertRowid } = this.db
        .prepare('INSERT INTO environments (name, variables, is_default, created_at) VALUES (?, ?, ?, ?)')
        .run(name, JSON.stringify(variables), isDefault ? 1 : 0, now());
      return this.getEnvironment(Number(lastInsertRowid));
    });
  }

  updateEnvironment(id, { name, variables, isDefault }) {
    const current = this.getEnvironment(id);
    if (!current) return null;
    return this.transaction(() => {
      if (isDefault) this.db.exec('UPDATE environments SET is_default = 0');
      this.db
        .prepare('UPDATE environments SET name = ?, variables = ?, is_default = ? WHERE id = ?')
        .run(
          name ?? current.name,
          JSON.stringify(variables ?? current.variables),
          (isDefault ?? current.isDefault) ? 1 : 0,
          id,
        );
      return this.getEnvironment(id);
    });
  }

  deleteEnvironment(id) {
    return this.db.prepare('DELETE FROM environments WHERE id = ?').run(id).changes > 0;
  }

  // -------------------------------------------------------------------- runs
  /** `items` are { test, iteration } — one per test, or one per dataset row. */
  createRun({ name, trigger, suiteId, environment, items }) {
    return this.transaction(() => {
      const { lastInsertRowid } = this.db
        .prepare(
          `INSERT INTO runs (name, trigger, status, suite_id, environment_id, environment_name, total, created_at)
           VALUES (?, ?, 'queued', ?, ?, ?, ?, ?)`,
        )
        .run(name, trigger, suiteId ?? null, environment?.id ?? null, environment?.name ?? null, items.length, now());
      const runId = Number(lastInsertRowid);
      const insert = this.db.prepare(
        `INSERT INTO results (run_id, test_case_id, test_name, test_type, suite_name, status, iteration)
         VALUES (?, ?, ?, ?, ?, 'queued', ?)`,
      );
      for (const { test: t, iteration } of items) {
        insert.run(runId, t.id, t.name, t.type, t.suiteName ?? null, iteration ? JSON.stringify(iteration) : null);
      }
      return this.getRun(runId);
    });
  }

  getRun(id) {
    return mapRun(this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id));
  }

  listRuns({ status, limit = 50, offset = 0, finishedOnly = false } = {}) {
    const where = [];
    const params = [];
    if (status) {
      where.push('status = ?');
      params.push(status);
    }
    if (finishedOnly) where.push('finished_at IS NOT NULL');
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = this.db
      .prepare(`SELECT * FROM runs ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .all(...params, limit, offset)
      .map(mapRun);
    const { n } = this.db.prepare(`SELECT COUNT(*) AS n FROM runs ${clause}`).get(...params);
    return { runs: rows, total: n };
  }

  updateRun(id, patch) {
    const columns = {
      status: 'status',
      total: 'total',
      passed: 'passed',
      failed: 'failed',
      errored: 'errored',
      skipped: 'skipped',
      flaky: 'flaky',
      durationMs: 'duration_ms',
      startedAt: 'started_at',
      finishedAt: 'finished_at',
      aiSummary: 'ai_summary',
    };
    const sets = [];
    const params = [];
    for (const [key, value] of Object.entries(patch)) {
      if (!columns[key]) continue;
      sets.push(`${columns[key]} = ?`);
      params.push(key === 'aiSummary' ? JSON.stringify(value) : value);
    }
    if (sets.length) this.db.prepare(`UPDATE runs SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    return this.getRun(id);
  }

  deleteRun(id) {
    return this.db.prepare('DELETE FROM runs WHERE id = ?').run(id).changes > 0;
  }

  clearRuns() {
    this.db.exec('DELETE FROM results; DELETE FROM runs;');
  }

  /** Runs left in a non-terminal state by a crash or restart. */
  recoverInterruptedRuns() {
    const ts = now();
    this.db
      .prepare(
        `UPDATE results SET status = 'skipped', error_message = 'Server restarted before this test ran'
         WHERE status IN ('queued', 'running')`,
      )
      .run();
    this.db
      .prepare(`UPDATE runs SET status = 'cancelled', finished_at = ? WHERE status IN ('queued', 'running')`)
      .run(ts);
  }

  // ----------------------------------------------------------------- results
  listResults(runId) {
    return this.db.prepare('SELECT * FROM results WHERE run_id = ? ORDER BY id').all(runId).map(mapResult);
  }

  getResult(id) {
    return mapResult(
      this.db
        .prepare(
          `SELECT r.*, ru.name AS run_name, ru.created_at AS run_created_at
           FROM results r JOIN runs ru ON ru.id = r.run_id WHERE r.id = ?`,
        )
        .get(id),
    );
  }

  updateResult(id, patch) {
    const columns = {
      status: 'status',
      durationMs: 'duration_ms',
      attempts: 'attempts',
      flaky: 'flaky',
      errorMessage: 'error_message',
      errorStack: 'error_stack',
      assertions: 'assertions',
      logs: 'logs',
      request: 'request',
      response: 'response',
      analysis: 'analysis',
      startedAt: 'started_at',
      finishedAt: 'finished_at',
    };
    const jsonColumns = new Set(['assertions', 'logs', 'request', 'response', 'analysis']);
    const sets = [];
    const params = [];
    for (const [key, value] of Object.entries(patch)) {
      if (!columns[key]) continue;
      sets.push(`${columns[key]} = ?`);
      if (jsonColumns.has(key)) params.push(value == null ? null : JSON.stringify(value));
      else if (typeof value === 'boolean') params.push(value ? 1 : 0);
      else params.push(value ?? null);
    }
    if (sets.length) this.db.prepare(`UPDATE results SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    return this.getResult(id);
  }

  // --------------------------------------------------------------- schedules
  #scheduleSelect = `
    SELECT sc.*, s.name AS suite_name, e.name AS environment_name, r.status AS last_run_status
    FROM schedules sc
    LEFT JOIN suites s ON s.id = sc.suite_id
    LEFT JOIN environments e ON e.id = sc.environment_id
    LEFT JOIN runs r ON r.id = sc.last_run_id`;

  listSchedules() {
    return this.db.prepare(`${this.#scheduleSelect} ORDER BY sc.id`).all().map(mapSchedule);
  }

  getSchedule(id) {
    return mapSchedule(this.db.prepare(`${this.#scheduleSelect} WHERE sc.id = ?`).get(id));
  }

  createSchedule({ name, cron, suiteId = null, testIds = [], environmentId = null, enabled = true }) {
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO schedules (name, cron, suite_id, test_ids, environment_id, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(name, cron, suiteId, JSON.stringify(testIds), environmentId, enabled ? 1 : 0, now());
    return this.getSchedule(Number(lastInsertRowid));
  }

  updateSchedule(id, patch) {
    const current = this.getSchedule(id);
    if (!current) return null;
    const next = { ...current, ...patch };
    this.db
      .prepare('UPDATE schedules SET name = ?, cron = ?, suite_id = ?, test_ids = ?, environment_id = ?, enabled = ? WHERE id = ?')
      .run(next.name, next.cron, next.suiteId ?? null, JSON.stringify(next.testIds ?? []), next.environmentId ?? null, next.enabled ? 1 : 0, id);
    return this.getSchedule(id);
  }

  /** Bookkeeping written by the scheduler (not user-editable fields). */
  updateScheduleState(id, { nextRunAt, lastRunAt, lastRunId, lastError }) {
    const sets = [];
    const params = [];
    const add = (col, v) => {
      if (v !== undefined) {
        sets.push(`${col} = ?`);
        params.push(v);
      }
    };
    add('next_run_at', nextRunAt);
    add('last_run_at', lastRunAt);
    add('last_run_id', lastRunId);
    add('last_error', lastError);
    if (sets.length) this.db.prepare(`UPDATE schedules SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
  }

  deleteSchedule(id) {
    return this.db.prepare('DELETE FROM schedules WHERE id = ?').run(id).changes > 0;
  }

  // ------------------------------------------------------ notification channels
  listChannels() {
    return this.db.prepare('SELECT * FROM notification_channels ORDER BY id').all().map(mapChannel);
  }

  getChannel(id) {
    return mapChannel(this.db.prepare('SELECT * FROM notification_channels WHERE id = ?').get(id));
  }

  createChannel({ name, type, url, notifyOn = 'failures', scope = 'all', enabled = true }) {
    const { lastInsertRowid } = this.db
      .prepare(
        `INSERT INTO notification_channels (name, type, url, notify_on, scope, enabled, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(name, type, url, notifyOn, scope, enabled ? 1 : 0, now());
    return this.getChannel(Number(lastInsertRowid));
  }

  updateChannel(id, patch) {
    const current = this.getChannel(id);
    if (!current) return null;
    const n = { ...current, ...patch };
    this.db
      .prepare('UPDATE notification_channels SET name = ?, type = ?, url = ?, notify_on = ?, scope = ?, enabled = ? WHERE id = ?')
      .run(n.name, n.type, n.url, n.notifyOn, n.scope, n.enabled ? 1 : 0, id);
    return this.getChannel(id);
  }

  recordDelivery(id, { ok, error }) {
    this.db
      .prepare('UPDATE notification_channels SET last_sent_at = ?, last_status = ?, last_error = ? WHERE id = ?')
      .run(now(), ok ? 'ok' : 'error', error ?? null, id);
  }

  deleteChannel(id) {
    return this.db.prepare('DELETE FROM notification_channels WHERE id = ?').run(id).changes > 0;
  }

  /** Finished results joined with run metadata, newest first — used by analytics & insights. */
  listFinishedResults({ runIds, failuresOnly = false, limit = 5000 } = {}) {
    const where = [`r.status NOT IN ('queued', 'running')`];
    const params = [];
    if (runIds) {
      if (!runIds.length) return [];
      where.push(`r.run_id IN (${runIds.map(() => '?').join(',')})`);
      params.push(...runIds);
    }
    if (failuresOnly) where.push(`r.status IN ('failed', 'error')`);
    return this.db
      .prepare(
        `SELECT r.*, ru.name AS run_name, ru.created_at AS run_created_at
         FROM results r JOIN runs ru ON ru.id = r.run_id
         WHERE ${where.join(' AND ')} ORDER BY r.id DESC LIMIT ?`,
      )
      .all(...params, limit)
      .map(mapResult);
  }
}
