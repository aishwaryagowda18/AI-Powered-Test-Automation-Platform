import { CATEGORIES } from './categories.js';

/**
 * Rule-based root-cause analysis. Used when no AI provider is
 * configured, as the instant first pass after every run, and as the fallback
 * if an AI call fails. Returns the same shape as the AI analysis.
 */

const snippet = (text, max = 200) => {
  if (!text) return '';
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

/** Status flips across recent history (newest first) — a cheap flakiness signal. */
export function flakinessFromHistory(history = []) {
  const statuses = history.map((h) => h.status).filter((s) => s === 'passed' || s === 'failed' || s === 'error');
  if (statuses.length < 3) return { flaky: false, flips: 0, passRate: null, sample: statuses.length };
  let flips = 0;
  for (let i = 1; i < statuses.length; i++) if ((statuses[i] === 'passed') !== (statuses[i - 1] === 'passed')) flips++;
  const passes = statuses.filter((s) => s === 'passed').length;
  const passRate = passes / statuses.length;
  return { flaky: flips >= 2 && passRate > 0 && passRate < 1, flips, passRate, sample: statuses.length };
}

function make(category, fields) {
  return {
    category,
    categoryLabel: CATEGORIES[category],
    summary: fields.summary,
    rootCause: fields.rootCause,
    evidence: fields.evidence ?? [],
    suggestedFixes: fields.suggestedFixes ?? [],
    confidence: fields.confidence ?? 'medium',
    owner: fields.owner ?? 'unknown',
    isLikelyFlaky: Boolean(fields.isLikelyFlaky),
  };
}

export function analyzeHeuristically({ result, testCase, history = [] }) {
  const error = result.errorMessage ?? '';
  const stack = result.errorStack ?? '';
  const status = result.response?.status;
  const failed = (result.assertions ?? []).filter((a) => !a.passed);
  const flake = flakinessFromHistory(history);
  const evidence = [];
  if (error) evidence.push(`Error: ${snippet(error, 240)}`);
  for (const a of failed.slice(0, 3)) if (a.message && a.message !== error) evidence.push(snippet(a.message, 240));
  if (status) evidence.push(`HTTP ${status}${result.response?.durationMs != null ? ` in ${result.response.durationMs} ms` : ''}`);
  if (flake.sample >= 3) {
    evidence.push(`Recent history: ${Math.round((flake.passRate ?? 0) * 100)}% pass rate over ${flake.sample} runs, ${flake.flips} status flips`);
  }
  const url = result.request?.url;

  let analysis;

  if (/ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|EHOSTUNREACH|ENETUNREACH|socket hang up|Network error/i.test(error)) {
    const code = error.match(/E[A-Z_]{4,}/)?.[0];
    analysis = make('network_connectivity', {
      summary: `The test could not reach ${url ? new URL(url).host : 'the target service'}${code ? ` (${code})` : ''}.`,
      rootCause:
        code === 'ENOTFOUND' || code === 'EAI_AGAIN'
          ? 'DNS resolution failed for the target host. The hostname is wrong for this environment, or DNS is unavailable from the test runner.'
          : 'The connection was refused or dropped before any HTTP response arrived. The service is probably down, listening on a different port, or blocked by a firewall/proxy.',
      suggestedFixes: [
        'Verify the service is running and healthy in the selected environment.',
        'Check the base URL / port variables in the environment settings.',
        'If the dependency is optional for this suite, stub it or tag the test so it can be excluded.',
      ],
      confidence: 'high',
      owner: 'environment',
    });
  } else if (/timed out|TimeoutError|ETIMEDOUT/i.test(error)) {
    analysis = make('timeout_performance', {
      summary: 'The request did not finish within the configured timeout.',
      rootCause: `No response arrived within the test timeout (${testCase?.timeoutMs ?? 'default'} ms). The endpoint is overloaded, blocked on a slow downstream dependency, or the timeout is too tight for this environment.`,
      suggestedFixes: [
        'Profile the endpoint server-side for slow queries or downstream calls.',
        'Compare with recent successful runs to see if latency regressed.',
        'If the latency is expected, raise the test timeout.',
      ],
      confidence: 'medium',
      owner: 'application',
    });
  } else if (status === 401 || status === 403) {
    analysis = make('authentication', {
      summary: `The request was rejected with HTTP ${status}.`,
      rootCause:
        status === 401
          ? 'The request had no valid credentials: the token is missing, expired, or for a different environment.'
          : 'The credentials were accepted, but this identity lacks permission for the resource.',
      suggestedFixes: [
        'Confirm the Authorization header is set and the token variable resolves in this environment.',
        'Refresh test credentials / API keys if they rotate.',
        'Check recent changes to role or permission configuration.',
      ],
      confidence: 'high',
      owner: 'test',
    });
  } else if (status === 404) {
    analysis = make('not_found_routing', {
      summary: `The endpoint returned HTTP 404 for ${result.request?.method ?? 'the'} ${url ? new URL(url).pathname : 'request'}.`,
      rootCause: 'The route or resource does not exist at this URL. The path changed, an ID in the test data is missing, or the base URL points at the wrong service version.',
      suggestedFixes: [
        'Verify the path against the current API spec / route table.',
        'Ensure the referenced test data (IDs) exists in this environment.',
        'Check the base URL and API version prefix.',
      ],
      confidence: 'medium',
      owner: 'test',
    });
  } else if (status >= 500) {
    const body = result.response?.body;
    let serverMessage = '';
    try {
      const parsed = JSON.parse(body);
      serverMessage = parsed.error || parsed.message || parsed.detail || '';
    } catch {
      serverMessage = snippet(body, 160);
    }
    if (serverMessage) evidence.push(`Server said: ${snippet(serverMessage, 200)}`);
    analysis = make(flake.flaky || status === 503 ? 'flaky' : 'server_error', {
      summary: `The server failed with HTTP ${status}${serverMessage ? `: ${snippet(serverMessage, 100)}` : ''}.`,
      rootCause:
        status === 503
          ? 'The service reported itself temporarily unavailable. That usually means an overloaded instance, a failing health check, or a downstream dependency that is down. These failures tend to be intermittent.'
          : `An unhandled exception or failed dependency inside the application produced a ${status}.${serverMessage ? ` The response body points to: "${snippet(serverMessage, 120)}".` : ''}`,
      suggestedFixes: [
        'Inspect application logs around the run timestamp for the stack trace.',
        status === 503 ? 'Add retries with backoff to the test, or fix the capacity/health issue upstream.' : 'Reproduce the request locally and fix the server-side exception.',
        'Add a regression test once fixed.',
      ],
      confidence: serverMessage ? 'high' : 'medium',
      owner: 'application',
      isLikelyFlaky: flake.flaky || status === 503,
    });
  } else if (/TypeError|ReferenceError|SyntaxError|RangeError|is not a function|is not defined|Cannot read propert/i.test(error + stack)) {
    analysis = make('test_code_error', {
      summary: 'The test script threw a JavaScript error before its assertions ran.',
      rootCause: `The failure comes from the test code, not the system under test: ${snippet(error, 160)}. Common causes are a typo, a missing variable, or a response shape the script didn't expect (e.g. reading a property of undefined).`,
      suggestedFixes: [
        'Open the script and fix the line referenced in the stack trace.',
        'Guard property access on response data (optional chaining) and assert the shape first.',
        'Use "Try it" in the editor to iterate quickly.',
      ],
      confidence: 'high',
      owner: 'test',
    });
  } else if (failed.some((a) => a.type === 'responseTime')) {
    const a = failed.find((x) => x.type === 'responseTime');
    analysis = make('timeout_performance', {
      summary: `The response arrived, but slower than the SLA (${a.actual} ms vs < ${a.expected} ms).`,
      rootCause: 'Performance regression or environmental slowness. The endpoint works but misses its latency budget.',
      suggestedFixes: [
        'Compare latency across recent runs in Analytics to spot a regression point.',
        'Check for N+1 queries, missing indexes, or slow downstream calls.',
        'If the budget is unrealistic for this environment, adjust the threshold per environment.',
      ],
      confidence: 'medium',
      owner: 'application',
    });
  } else if (failed.some((a) => a.type === 'jsonPath' && a.actual === 'undefined' && a.operator !== 'notExists')) {
    const a = failed.find((x) => x.type === 'jsonPath' && x.actual === 'undefined');
    let keys = '';
    try {
      const parsed = JSON.parse(result.response?.body ?? '');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) keys = Object.keys(parsed).slice(0, 12).join(', ');
    } catch {
      /* not JSON */
    }
    if (keys) evidence.push(`Top-level fields present: ${keys}`);
    analysis = make('contract_change', {
      summary: `The response no longer contains the field "${a.target}".`,
      rootCause: `The request succeeded, but the expected field is missing from the payload. The response schema was probably changed (field renamed, moved, or removed)${keys ? `. Fields now present: ${keys}` : ''}.`,
      suggestedFixes: [
        'Check the API changelog / recent deployments for schema changes.',
        'If the rename is intentional, update the test and notify API consumers.',
        'Consider contract tests (e.g. JSON Schema) to catch this earlier.',
      ],
      confidence: 'high',
      owner: 'application',
    });
  } else if (failed.length) {
    const a = failed[0];
    analysis = make(flake.flaky ? 'flaky' : 'assertion_mismatch', {
      summary: `Assertion failed: ${snippet(a.description ?? a.message, 140)}.`,
      rootCause: flake.flaky
        ? 'This test alternates between passing and failing with no change to the test, which points to non-determinism: shared test data, ordering, timing, or an unstable dependency.'
        : `The system returned ${a.actual} where the test expected ${a.expected ?? 'a different value'}. Either the application behaviour changed (a regression), or the test's expectation or test data is outdated.`,
      suggestedFixes: flake.flaky
        ? ['Isolate test data per run.', 'Add retries only as a stop-gap; find the shared-state source.', 'Quarantine with a tag until fixed.']
        : [
            'Diff the actual response against the last passing run.',
            'Confirm with the feature owner whether the new behaviour is intended.',
            'Update the expectation if the change is intended; otherwise file a bug.',
          ],
      confidence: 'medium',
      owner: flake.flaky ? 'test' : 'unknown',
      isLikelyFlaky: flake.flaky,
    });
  } else {
    analysis = make('unknown', {
      summary: error ? snippet(error, 160) : 'The test failed without a specific error signal.',
      rootCause: 'Not enough signal to classify this failure automatically. Review the logs and response in detail.',
      suggestedFixes: ['Open the execution logs for this result.', 'Re-run the test in isolation to check reproducibility.'],
      confidence: 'low',
    });
  }

  analysis.evidence = evidence.length ? evidence : analysis.evidence;
  if (flake.flaky && !analysis.isLikelyFlaky) {
    analysis.isLikelyFlaky = true;
    analysis.suggestedFixes = [...analysis.suggestedFixes, 'This test has a flaky history. Check whether this failure is intermittent before chasing it.'];
  }
  return { ...analysis, source: 'heuristic', analyzedAt: new Date().toISOString() };
}

/** Aggregate per-test analyses into a run-level summary. */
export function summarizeRunHeuristically({ run, results }) {
  const failures = results.filter((r) => r.status === 'failed' || r.status === 'error');
  if (!failures.length) {
    return {
      headline: `All ${run.passed} tests passed`,
      overview: 'No failures in this run.',
      themes: [],
      recommendations: [],
      riskLevel: 'low',
      source: 'heuristic',
      analyzedAt: new Date().toISOString(),
    };
  }
  const groups = new Map();
  for (const r of failures) {
    const category = r.analysis?.category ?? 'unknown';
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(r);
  }
  const themes = [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length)
    .map(([category, items]) => ({
      title: CATEGORIES[category] ?? category,
      category,
      testNames: items.map((i) => i.displayName ?? i.testName),
      explanation: items[0].analysis?.rootCause ?? items[0].errorMessage ?? '',
    }));
  const recommendations = [...new Set(failures.flatMap((r) => r.analysis?.suggestedFixes?.slice(0, 1) ?? []))].slice(0, 5);
  const appFailures = failures.filter((r) => r.analysis?.owner === 'application').length;
  const riskLevel = appFailures >= 2 || failures.length / Math.max(1, results.length) > 0.3 ? 'high' : appFailures ? 'medium' : 'low';
  return {
    headline: `${failures.length} of ${results.length} tests failed across ${themes.length} root-cause ${themes.length === 1 ? 'theme' : 'themes'}`,
    overview: themes.map((t) => `${t.title}: ${t.testNames.length}`).join(' · '),
    themes,
    recommendations,
    riskLevel,
    source: 'heuristic',
    analyzedAt: new Date().toISOString(),
  };
}
