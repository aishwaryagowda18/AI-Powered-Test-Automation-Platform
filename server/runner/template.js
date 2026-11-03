import { randomUUID } from 'node:crypto';

const PLACEHOLDER = /\{\{\s*([$\w.-]+)\s*\}\}/g;

/** Built-in dynamic variables, available in every environment. */
export function builtinVariables({ serverUrl } = {}) {
  return {
    $serverUrl: serverUrl ?? '',
    $timestamp: String(Date.now()),
    $isoDate: new Date().toISOString(),
    $uuid: randomUUID(),
    $randomInt: String(Math.floor(Math.random() * 100000)),
  };
}

/**
 * Resolve environment variables; values may themselves reference built-ins,
 * e.g. `baseUrl = {{$serverUrl}}/demo-api`.
 */
export function resolveVariables(envVars = {}, context = {}) {
  const builtins = builtinVariables(context);
  const resolved = { ...builtins };
  for (const [key, value] of Object.entries(envVars)) {
    resolved[key] = interpolate(String(value), builtins);
  }
  return resolved;
}

/** Deep-replace `{{name}}` placeholders in strings, arrays and plain objects. */
export function interpolate(value, vars) {
  if (typeof value === 'string') {
    return value.replace(PLACEHOLDER, (match, name) => (name in vars ? String(vars[name]) : match));
  }
  if (Array.isArray(value)) return value.map((v) => interpolate(v, vars));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, interpolate(v, vars)]));
  }
  return value;
}

/** Placeholder names that have no value in `vars` — surfaced as warnings in the test log. */
export function unresolvedPlaceholders(value) {
  const found = new Set();
  const visit = (v) => {
    if (typeof v === 'string') for (const m of v.matchAll(PLACEHOLDER)) found.add(m[1]);
    else if (Array.isArray(v)) v.forEach(visit);
    else if (v && typeof v === 'object') Object.values(v).forEach(visit);
  };
  visit(value);
  return [...found];
}
