import { evaluateAssertion, getPath } from './assertions.js';
import { interpolate, unresolvedPlaceholders } from './template.js';

const MAX_BODY_CHARS = 20000;

const toPairs = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) return value.filter((p) => p && p.key && p.enabled !== false).map((p) => [p.key, p.value ?? '']);
  return Object.entries(value);
};

/** Turn fetch's opaque "fetch failed" into something a human (or the analyzer) can act on. */
export function describeFetchError(err, timeoutMs) {
  if (err?.name === 'TimeoutError') return `Request timed out after ${timeoutMs} ms`;
  if (err?.name === 'AbortError') return 'Request aborted (run cancelled)';
  const cause = err?.cause;
  if (cause?.code) {
    const where = cause.address ? ` ${cause.address}${cause.port ? `:${cause.port}` : ''}` : cause.hostname ? ` ${cause.hostname}` : '';
    return `Network error: ${cause.code}${where}${cause.message && !cause.message.includes(cause.code) ? ` — ${cause.message}` : ''}`;
  }
  if (cause?.message) return `Network error: ${cause.message}`;
  return err?.message || String(err);
}

/**
 * Execute an HTTP test case.
 * config: { method, url, query: [{key,value}], headers: [{key,value}], bodyType: 'json'|'text'|'none', body, assertions: [...] }
 */
export async function runHttpTest(testCase, { vars, signal, log, timeoutMs }) {
  const cfg = interpolate(testCase.config ?? {}, vars);
  const method = (cfg.method || 'GET').toUpperCase();

  const missing = unresolvedPlaceholders(cfg);
  if (missing.length) log('warn', `Unresolved variables: ${missing.map((m) => `{{${m}}}`).join(', ')}`);

  if (!cfg.url) throw new Error('Test has no URL configured');
  let url;
  try {
    url = new URL(cfg.url);
  } catch {
    throw new Error(`Invalid URL "${cfg.url}"`);
  }
  for (const [k, v] of toPairs(cfg.query)) url.searchParams.append(k, v);

  const headers = Object.fromEntries(toPairs(cfg.headers));
  let body;
  if (!['GET', 'HEAD'].includes(method) && cfg.bodyType !== 'none' && cfg.body != null && cfg.body !== '') {
    body = typeof cfg.body === 'string' ? cfg.body : JSON.stringify(cfg.body);
    if (cfg.bodyType !== 'text' && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = 'application/json';
    }
  }

  const request = { method, url: url.toString(), headers, body: body ?? null };
  log('info', `→ ${method} ${request.url}`);
  if (body) log('debug', `Request body: ${body.length > 500 ? `${body.slice(0, 500)}…` : body}`);

  const started = performance.now();
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body,
      redirect: 'follow',
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
    });
  } catch (err) {
    const message = describeFetchError(err, timeoutMs);
    log('error', message);
    const e = new Error(message);
    e.request = request;
    e.durationMs = Math.round(performance.now() - started);
    throw e;
  }
  const text = await res.text();
  const durationMs = Math.round(performance.now() - started);

  const responseHeaders = Object.fromEntries([...res.headers.entries()].map(([k, v]) => [k.toLowerCase(), v]));
  let parsed;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = undefined;
    }
  }

  log(res.ok ? 'info' : 'warn', `← ${res.status} ${res.statusText} in ${durationMs} ms (${text.length} bytes)`);

  const response = {
    status: res.status,
    statusText: res.statusText,
    headers: responseHeaders,
    body: text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS)}\n… [truncated ${text.length - MAX_BODY_CHARS} chars]` : text,
    durationMs,
    size: text.length,
  };

  const definitions = cfg.assertions?.length
    ? cfg.assertions.filter((a) => a.enabled !== false)
    : [{ type: 'status', operator: 'lessThan', expected: '400', implicit: true }];
  const ctx = { status: res.status, headers: responseHeaders, body: text, json: parsed, durationMs };
  const assertions = definitions.map((a) => evaluateAssertion(a, ctx));

  for (const a of assertions) log(a.passed ? 'pass' : 'fail', `${a.passed ? '✓' : '✗'} ${a.passed ? a.description : a.message}`);

  const extracted = extractVariables(cfg.extract, ctx, log);

  const firstFailure = assertions.find((a) => !a.passed);
  return {
    status: firstFailure ? 'failed' : 'passed',
    errorMessage: firstFailure?.message ?? null,
    assertions,
    request,
    response,
    extracted,
  };
}

/** Mask a captured value for logs: tokens and IDs are useful to recognise, not to leak. */
export const maskValue = (v) => (v.length <= 8 ? v : `${v.slice(0, 4)}…${v.slice(-2)} (${v.length} chars)`);

/**
 * Capture values from a response into run-scoped variables.
 * rules: [{ variable, from: 'jsonPath'|'header'|'status'|'regex', path }]
 */
export function extractVariables(rules = [], ctx, log = () => {}) {
  const extracted = {};
  for (const rule of rules) {
    if (!rule?.variable || rule.enabled === false) continue;
    let value;
    let where = rule.from;
    try {
      if (rule.from === 'jsonPath') {
        value = ctx.json === undefined ? undefined : getPath(ctx.json, rule.path);
        where = `JSON ${rule.path || '$'}`;
      } else if (rule.from === 'header') {
        value = ctx.headers?.[String(rule.path ?? '').toLowerCase()];
        where = `header "${rule.path}"`;
      } else if (rule.from === 'status') {
        value = ctx.status;
        where = 'status code';
      } else if (rule.from === 'regex') {
        const m = new RegExp(rule.path).exec(ctx.body ?? '');
        value = m ? (m[1] ?? m[0]) : undefined;
        where = `body /${rule.path}/`;
      }
    } catch (err) {
      log('warn', `Could not extract {{${rule.variable}}}: ${err.message}`);
      continue;
    }
    if (value === undefined || value === null) {
      log('warn', `Could not extract {{${rule.variable}}}: ${where} not found in the response`);
      continue;
    }
    extracted[rule.variable] = typeof value === 'object' ? JSON.stringify(value) : String(value);
    log('info', `Captured {{${rule.variable}}} from ${where} = ${maskValue(extracted[rule.variable])}`);
  }
  return extracted;
}
