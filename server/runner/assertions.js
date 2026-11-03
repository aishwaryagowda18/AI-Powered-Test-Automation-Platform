import { isDeepStrictEqual } from 'node:util';

export const ASSERTION_TYPES = ['status', 'responseTime', 'header', 'jsonPath', 'body'];
export const OPERATORS = [
  'equals',
  'notEquals',
  'contains',
  'notContains',
  'lessThan',
  'greaterThan',
  'exists',
  'notExists',
  'matches',
  'isType',
];

/**
 * Read a value by path: `$.data.items[0].name`, `data.items.0.name`, `items.length`.
 * Returns undefined when any segment is missing.
 */
export function getPath(obj, path) {
  if (path == null || path === '' || path === '$') return obj;
  const segments = String(path)
    .replace(/^\$\.?/, '')
    .replace(/\[(\d+)\]/g, '.$1')
    .replace(/\[["']([^"']+)["']\]/g, '.$1')
    .split('.')
    .filter(Boolean);
  let current = obj;
  for (const segment of segments) {
    if (current == null) return undefined;
    if (segment === 'length' && (Array.isArray(current) || typeof current === 'string')) {
      current = current.length;
      continue;
    }
    current = current[segment];
  }
  return current;
}

/** Expected values arrive as strings from the UI; parse JSON literals (numbers, booleans, objects). */
export function parseExpected(expected) {
  if (typeof expected !== 'string') return expected;
  const trimmed = expected.trim();
  if (trimmed === '') return '';
  try {
    return JSON.parse(trimmed);
  } catch {
    return expected;
  }
}

export function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

export const preview = (value, max = 120) => {
  let text;
  if (value === undefined) text = 'undefined';
  else if (typeof value === 'string') text = JSON.stringify(value);
  else {
    try {
      text = JSON.stringify(value);
    } catch {
      text = String(value);
    }
  }
  return text.length > max ? `${text.slice(0, max)}…` : text;
};

function compare(operator, actual, expectedRaw) {
  const expected = parseExpected(expectedRaw);
  switch (operator) {
    case 'equals':
      return isDeepStrictEqual(actual, expected) || (actual != null && String(actual) === String(expectedRaw));
    case 'notEquals':
      return !(isDeepStrictEqual(actual, expected) || (actual != null && String(actual) === String(expectedRaw)));
    case 'contains':
      if (Array.isArray(actual)) return actual.some((item) => isDeepStrictEqual(item, expected) || item === expectedRaw);
      return actual != null && String(typeof actual === 'object' ? JSON.stringify(actual) : actual).includes(String(expectedRaw));
    case 'notContains':
      return !compare('contains', actual, expectedRaw);
    case 'lessThan':
      return Number(actual) < Number(expected);
    case 'greaterThan':
      return Number(actual) > Number(expected);
    case 'exists':
      return actual !== undefined;
    case 'notExists':
      return actual === undefined;
    case 'matches':
      return actual != null && new RegExp(String(expectedRaw)).test(String(actual));
    case 'isType':
      return typeOf(actual) === String(expectedRaw).trim().toLowerCase();
    default:
      throw new Error(`Unknown operator "${operator}"`);
  }
}

const OPERATOR_TEXT = {
  equals: 'equals',
  notEquals: 'does not equal',
  contains: 'contains',
  notContains: 'does not contain',
  lessThan: 'is less than',
  greaterThan: 'is greater than',
  exists: 'exists',
  notExists: 'does not exist',
  matches: 'matches',
  isType: 'is of type',
};

export function describeAssertion(a) {
  const subject = {
    status: 'Status code',
    responseTime: 'Response time (ms)',
    header: `Header "${a.target}"`,
    jsonPath: `JSON ${a.target || '$'}`,
    body: 'Response body',
  }[a.type] ?? a.type;
  const needsValue = !['exists', 'notExists'].includes(a.operator);
  return `${subject} ${OPERATOR_TEXT[a.operator] ?? a.operator}${needsValue ? ` ${a.expected}` : ''}`;
}

/**
 * Evaluate one HTTP assertion against a response context:
 * `{ status, headers (lower-cased keys), body (text), json, durationMs }`.
 */
export function evaluateAssertion(assertion, ctx) {
  const description = describeAssertion(assertion);
  let actual;
  switch (assertion.type) {
    case 'status':
      actual = ctx.status;
      break;
    case 'responseTime':
      actual = ctx.durationMs;
      break;
    case 'header':
      actual = ctx.headers?.[String(assertion.target ?? '').toLowerCase()];
      break;
    case 'jsonPath':
      if (ctx.json === undefined) {
        return {
          ...assertion,
          description,
          passed: false,
          actual: 'response is not JSON',
          message: `${description} — response body is not valid JSON`,
        };
      }
      actual = getPath(ctx.json, assertion.target);
      break;
    case 'body':
      actual = ctx.body;
      break;
    default:
      return { ...assertion, description, passed: false, actual: undefined, message: `Unknown assertion type "${assertion.type}"` };
  }

  let passed;
  try {
    passed = compare(assertion.operator, actual, assertion.expected);
  } catch (err) {
    return { ...assertion, description, passed: false, actual: preview(actual), message: err.message };
  }

  return {
    ...assertion,
    description,
    passed,
    actual: preview(actual),
    message: passed ? description : `Assertion failed: ${description} (actual: ${preview(actual)})`,
  };
}
