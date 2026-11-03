/**
 * Worker-thread entry point for "script" test cases.
 *
 * The test body runs inside a vm context that exposes a small, test-oriented API:
 * expect, assert, log, sleep, http, fetch, vars and setVar. The vm context keeps the
 * global scope tidy, and the worker lets the engine hard-kill runaway scripts —
 * but neither is a security boundary. Only run scripts you trust.
 */
import vm from 'node:vm';
import { isDeepStrictEqual } from 'node:util';
import { parentPort, workerData } from 'node:worker_threads';

const { code, vars, timeoutMs } = workerData;
const assertions = [];

const fmt = (value) => {
  if (typeof value === 'string') return JSON.stringify(value);
  try {
    const s = JSON.stringify(value);
    return s === undefined ? String(value) : s.length > 120 ? `${s.slice(0, 120)}…` : s;
  } catch {
    return String(value);
  }
};

const send = (level, args) =>
  parentPort.postMessage({
    type: 'log',
    level,
    message: args.map((a) => (typeof a === 'string' ? a : fmt(a))).join(' '),
  });

class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'AssertionError';
  }
}

function record(passed, description, actual, expected) {
  const entry = { type: 'expect', description, passed, actual: fmt(actual), expected: expected === undefined ? undefined : fmt(expected) };
  entry.message = passed ? description : `Assertion failed: ${description} (actual: ${entry.actual})`;
  assertions.push(entry);
  send(passed ? 'pass' : 'fail', [`${passed ? '✓' : '✗'} ${entry.message}`]);
  if (!passed) throw new AssertionError(entry.message);
}

function expect(actual, label) {
  const subject = label ?? fmt(actual);
  const build = (negate) => {
    const check = (ok, text, expected) => record(negate ? !ok : ok, `${subject} ${negate ? 'not ' : ''}${text}`, actual, expected);
    return {
      toBe: (e) => check(Object.is(actual, e), `to be ${fmt(e)}`, e),
      toEqual: (e) => check(isDeepStrictEqual(actual, e), `to equal ${fmt(e)}`, e),
      toBeTruthy: () => check(Boolean(actual), 'to be truthy'),
      toBeFalsy: () => check(!actual, 'to be falsy'),
      toBeDefined: () => check(actual !== undefined, 'to be defined'),
      toBeNull: () => check(actual === null, 'to be null'),
      toContain: (e) =>
        check(
          Array.isArray(actual) ? actual.some((x) => isDeepStrictEqual(x, e)) : String(actual).includes(String(e)),
          `to contain ${fmt(e)}`,
          e,
        ),
      toBeGreaterThan: (e) => check(actual > e, `to be greater than ${e}`, e),
      toBeLessThan: (e) => check(actual < e, `to be less than ${e}`, e),
      toMatch: (re) => check(new RegExp(re).test(String(actual)), `to match ${re}`, String(re)),
      toHaveProperty: (key) => check(actual != null && Object.hasOwn(actual, key), `to have property "${key}"`, key),
      toHaveLength: (n) => check(actual?.length === n, `to have length ${n}`, n),
    };
  };
  return Object.assign(build(false), { not: build(true) });
}

const assert = (condition, message = 'assertion') => record(Boolean(condition), message, condition);

/** Minimal fetch wrapper: resolves to { status, ok, headers, text, json, durationMs }. */
async function request(method, url, { body, headers = {}, ...rest } = {}) {
  const init = { method, headers: { ...headers }, ...rest };
  if (body !== undefined) {
    if (typeof body === 'string') init.body = body;
    else {
      init.body = JSON.stringify(body);
      init.headers['Content-Type'] ??= 'application/json';
    }
  }
  send('info', [`→ ${method} ${url}`]);
  const started = performance.now();
  const res = await fetch(url, init);
  const text = await res.text();
  const durationMs = Math.round(performance.now() - started);
  let json;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }
  send(res.ok ? 'info' : 'warn', [`← ${res.status} ${res.statusText} in ${durationMs} ms`]);
  return { status: res.status, ok: res.ok, headers: Object.fromEntries(res.headers), text, json, durationMs };
}

const http = {
  get: (url, opts) => request('GET', url, opts),
  delete: (url, opts) => request('DELETE', url, opts),
  post: (url, body, opts) => request('POST', url, { ...opts, body }),
  put: (url, body, opts) => request('PUT', url, { ...opts, body }),
  patch: (url, body, opts) => request('PATCH', url, { ...opts, body }),
};

const consoleShim = {
  log: (...a) => send('info', a),
  info: (...a) => send('info', a),
  warn: (...a) => send('warn', a),
  error: (...a) => send('error', a),
  debug: (...a) => send('debug', a),
};

const runVars = { ...vars };
/** Share a value with later tests in the same run as {{name}} / vars.name. */
function setVar(name, value) {
  if (!/^[A-Za-z_][\w.-]*$/.test(String(name))) throw new TypeError(`setVar: invalid variable name "${name}"`);
  const text = value !== null && typeof value === 'object' ? JSON.stringify(value) : String(value);
  runVars[name] = text;
  parentPort.postMessage({ type: 'var', name: String(name), value: text });
}

const context = vm.createContext({
  expect,
  assert,
  http,
  fetch,
  setVar,
  vars: new Proxy(runVars, { set: () => false, deleteProperty: () => false }),
  log: consoleShim.log,
  console: consoleShim,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  setTimeout,
  clearTimeout,
  URL,
  URLSearchParams,
  TextEncoder,
  TextDecoder,
  structuredClone,
  crypto: globalThis.crypto,
});

// Keep the event loop alive while the script is pending. Otherwise a script that
// awaits a never-settling promise exits the worker (code 13) instead of letting
// the engine report a proper timeout.
const keepAlive = setInterval(() => {}, 60_000);

try {
  const script = new vm.Script(`(async () => {\n${code}\n})()`, { filename: 'test-script.js', lineOffset: -1 });
  await script.runInContext(context, { timeout: timeoutMs });
  parentPort.postMessage({ type: 'done', status: 'passed', assertions });
} catch (err) {
  const isAssertion = err?.name === 'AssertionError';
  if (!isAssertion) send('error', [`${err?.name ?? 'Error'}: ${err?.message ?? err}`]);
  parentPort.postMessage({
    type: 'done',
    status: isAssertion ? 'failed' : 'error',
    assertions,
    errorMessage: isAssertion ? err.message : `${err?.name ?? 'Error'}: ${err?.message ?? String(err)}`,
    errorStack: err?.stack ? String(err.stack).split('\n').slice(0, 8).join('\n') : null,
  });
} finally {
  clearInterval(keepAlive);
}
