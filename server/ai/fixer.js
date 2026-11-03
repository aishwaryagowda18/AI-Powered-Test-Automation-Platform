import { isDeepStrictEqual } from 'node:util';
import { getPath, typeOf } from '../runner/assertions.js';

/**
 * Rule-based fix proposals for failed tests whose *expectations* are outdated.
 * Proposals only touch `config.assertions` and are deliberately conservative:
 * failures that point at a real application problem (5xx, auth, network,
 * timeouts) are never "fixed" by loosening the test.
 */

const parseJson = (text) => {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
};
const hasPlaceholder = (v) => /\{\{\s*[$\w.-]+\s*\}\}/.test(String(v ?? ''));

/** Split `data.items[0].name` into parent path `data.items[0]` and last key `name`. */
export function splitPath(path) {
  const normalized = String(path ?? '')
    .replace(/^\$\.?/, '')
    .replace(/\[(\d+)\]/g, '.$1')
    .replace(/\[["']([^"']+)["']\]/g, '.$1');
  const parts = normalized.split('.').filter(Boolean);
  const last = parts.pop();
  return { parent: parts.join('.'), last, parts };
}

function levenshtein(a, b) {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
  }
  return dp[a.length][b.length];
}

/**
 * Find the most likely new name for a missing field. Strongest evidence: a key
 * in the current response that holds the value the old field had in the last
 * passing response. Otherwise fall back to name similarity.
 */
export function findRenamedField(missingPath, json, previousJson) {
  const { parent, last } = splitPath(missingPath);
  const container = parent ? getPath(json, parent) : json;
  if (!container || typeof container !== 'object' || Array.isArray(container) || !last) return null;
  const previousValue = previousJson === undefined ? undefined : getPath(previousJson, missingPath);
  const previousKeys = new Set(Object.keys((parent ? getPath(previousJson, parent) : previousJson) ?? {}));

  let best = null;
  for (const key of Object.keys(container)) {
    if (key === last) continue;
    const a = key.toLowerCase();
    const b = last.toLowerCase();
    let score = 0;
    let why = '';
    if (previousValue !== undefined && isDeepStrictEqual(container[key], previousValue) && !previousKeys.has(key)) {
      score = 120;
      why = `"${key}" now holds the value "${last}" had in the last passing run`;
    } else if (a === b) {
      score = 100;
      why = `only the letter case changed ("${last}" → "${key}")`;
    } else if ((a.includes(b) || b.includes(a)) && Math.min(a.length, b.length) >= 2) {
      score = 80;
      why = `"${key}" looks like a renamed "${last}"`;
    } else if (levenshtein(a, b) <= 2 && b.length >= 4) {
      score = 60;
      why = `"${key}" is spelled almost like "${last}"`;
    }
    if (!previousKeys.has(key) && previousKeys.size && score && score < 120) score += 5; // brand-new key
    if (score > (best?.score ?? 0)) best = { key, score, why };
  }
  if (!best || best.score < 60) return null;
  const newPath = missingPath.endsWith(last) ? `${missingPath.slice(0, -last.length)}${best.key}` : parent ? `${parent}.${best.key}` : best.key;
  return { path: newPath, ...best };
}

/** Map evaluated (enabled) assertions back to their index in the stored definition. */
function enabledIndexMap(definitions) {
  return definitions.map((a, i) => ({ a, i })).filter(({ a }) => a.enabled !== false).map(({ i }) => i);
}

const notFixable = (summary, rationale) => ({ fixable: false, summary, rationale, risk: 'low', assertions: [], code: '', changes: [] });

/**
 * Propose new assertions for a failed HTTP result.
 * ctx: { test, result, previousPass } where previousPass is the last passing result (same row) or null.
 */
export function proposeFixRuleBased({ test, result, previousPass }) {
  if (test.type !== 'http') return notFixable('Automatic fixes for script tests need an AI provider.', 'Rule-based fixes only rewrite HTTP assertions. Set GEMINI_API_KEY to get a proposed code change for scripts.');
  if (result.status === 'error') {
    return notFixable(
      'This failure is not caused by the test definition.',
      `The request never produced a checkable response (${result.errorMessage ?? 'error'}). That's an environment or application problem, so changing assertions would only hide it.`,
    );
  }
  const status = result.response?.status;
  if (status >= 500) return notFixable('The server returned an error. Fix the application, not the test.', `HTTP ${status} means the application failed. Updating the test to expect it would mask a real defect.`);
  if ((status === 401 || status === 403) && !(test.config.assertions ?? []).some((a) => a.type === 'status' && /^40[13]$/.test(String(a.expected)))) {
    return notFixable('The request was rejected as unauthorized.', `HTTP ${status} usually means missing or expired credentials. Check the token or environment variables instead of changing the expectation.`);
  }

  const definitions = test.config.assertions ?? [];
  const indexMap = enabledIndexMap(definitions);
  const evaluated = result.assertions ?? [];
  if (!definitions.length || evaluated.length !== indexMap.length) {
    return notFixable('The test changed since this run.', 'The assertions no longer line up with this result. Re-run the test and try again.');
  }

  const json = parseJson(result.response?.body);
  const previousJson = previousPass ? parseJson(previousPass.response?.body) : undefined;
  const after = definitions.map((a) => ({ ...a }));
  const changes = [];
  const shorts = [];
  const skipped = [];
  const change = (short, detail) => {
    shorts.push(short);
    changes.push(detail);
  };
  let risk = 'low';

  evaluated.forEach((ev, k) => {
    if (ev.passed) return;
    const i = indexMap[k];
    const def = definitions[i];
    const label = `Assertion ${i + 1} (${ev.description})`;

    if (def.type === 'jsonPath' && ev.actual === 'undefined' && def.operator !== 'notExists') {
      if (hasPlaceholder(def.target)) return skipped.push(`${label}: its path comes from a variable`);
      const renamed = json === undefined ? null : findRenamedField(def.target, json, previousJson);
      if (!renamed) return skipped.push(`${label}: field "${def.target}" is gone and no likely replacement was found. Confirm with the API owner.`);
      after[i].target = renamed.path;
      change(`Use "${renamed.path}" instead of "${def.target}"`, `${label}: path "${def.target}" → "${renamed.path}". Reason: ${renamed.why}`);
      if (renamed.score < 100) risk = 'medium';
      return;
    }

    if (hasPlaceholder(def.expected)) return skipped.push(`${label}: the expected value comes from a variable or dataset row. Edit the data instead.`);

    if (def.type === 'status' && def.operator === 'equals') {
      const expected = Number(def.expected);
      if (status >= 200 && status < 300 && expected >= 200 && expected < 300) {
        after[i].expected = String(status);
        change(`Expect status ${status} instead of ${expected}`, `${label}: expect ${status} instead of ${expected} (still a success response)`);
        risk = risk === 'high' ? 'high' : 'medium';
      } else if (expected >= 400 && status >= 400 && status < 500) {
        after[i].expected = String(status);
        change(`Expect status ${status} instead of ${expected}`, `${label}: expect ${status} instead of ${expected} (a different client error)`);
        risk = 'medium';
      } else skipped.push(`${label}: got ${status} where ${expected} was expected. That's a behaviour change worth investigating, not an outdated expectation.`);
      return;
    }

    if (def.type === 'responseTime' && def.operator === 'lessThan') {
      const actual = result.response?.durationMs ?? Number(ev.actual);
      const budget = Math.ceil((actual * 1.25) / 100) * 100;
      after[i].expected = String(budget);
      change(`Raise the response-time budget to ${budget} ms`, `${label}: raise the budget from ${def.expected} ms to ${budget} ms (observed ${actual} ms + 25% headroom). Only do this if the slower response is acceptable.`);
      risk = 'high';
      return;
    }

    if (def.type === 'jsonPath' && json !== undefined) {
      const actual = getPath(json, def.target);
      if (def.operator === 'isType') {
        after[i].expected = typeOf(actual);
        change(`Expect type ${typeOf(actual)}`, `${label}: type is now ${typeOf(actual)}`);
        risk = 'medium';
        return;
      }
      if (def.operator === 'equals' && actual !== undefined && (actual === null || typeof actual !== 'object')) {
        after[i].expected = String(actual);
        change(`Expect ${JSON.stringify(actual)} for ${def.target}`, `${label}: expect ${JSON.stringify(actual)} instead of ${JSON.stringify(def.expected)}. Apply only if the new value is intended.`);
        risk = 'high';
        return;
      }
    }

    if (def.type === 'header' && def.operator === 'equals') {
      const actual = result.response?.headers?.[String(def.target).toLowerCase()];
      if (actual !== undefined) {
        after[i].expected = actual;
        change(`Expect header ${def.target} = "${actual}"`, `${label}: expect "${actual}"`);
        risk = 'high';
        return;
      }
    }

    skipped.push(`${label}: no safe automatic change`);
  });

  if (!changes.length) {
    return notFixable('No safe automatic fix found.', skipped.length ? skipped.join(' ') : 'The failure does not match a known outdated-expectation pattern.');
  }
  return {
    fixable: true,
    summary: shorts.length === 1 ? shorts[0] : `${shorts.join('; ')}`,
    rationale: [...changes, ...skipped.map((s) => `Not changed: ${s}`)].join('\n'),
    risk,
    assertions: after,
    code: '',
    changes,
  };
}
