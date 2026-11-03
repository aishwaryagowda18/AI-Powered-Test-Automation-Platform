import { parseDataset } from './dataset.js';
import { unresolvedPlaceholders } from './template.js';

/**
 * Test chaining: which run-scoped variables a test needs and provides, and the
 * resulting execution order. HTTP tests provide variables through
 * `config.extract`; script tests through `setVar('name', value)`. Tests consume
 * them as {{name}} (HTTP) or `vars.name` (scripts).
 */

const SCRIPT_READ = /\bvars\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*['"]([^'"]+)['"]\s*\])/g;
const SCRIPT_WRITE = /\bsetVar\s*\(\s*['"]([^'"]+)['"]/g;

export function datasetColumns(test) {
  try {
    return new Set(parseDataset(test.config?.dataset?.content).columns);
  } catch {
    return new Set();
  }
}

/** Variables a test references that aren't built-ins or its own dataset columns. */
export function variablesNeeded(test) {
  const names = new Set();
  if (test.type === 'script') {
    for (const m of String(test.config?.code ?? '').matchAll(SCRIPT_READ)) names.add(m[1] ?? m[2]);
  } else {
    const { extract, dataset, ...rest } = test.config ?? {};
    for (const n of unresolvedPlaceholders(rest)) names.add(n);
  }
  const own = datasetColumns(test);
  return new Set([...names].filter((n) => !n.startsWith('$') && !own.has(n)));
}

export function variablesProvided(test) {
  if (test.type === 'script') return new Set([...String(test.config?.code ?? '').matchAll(SCRIPT_WRITE)].map((m) => m[1]));
  return new Set((test.config?.extract ?? []).filter((e) => e.variable && e.enabled !== false).map((e) => e.variable));
}

/**
 * For a set of tests, pull in enabled producer tests (transitively) for any
 * variable that neither the environment nor the selected tests provide.
 * Returns the tests to add, each with the variables it was added for.
 */
export function findMissingProducers(selected, candidates, envVars = {}) {
  const chosen = new Map(selected.map((t) => [t.id, t]));
  const added = [];
  let changed = true;
  while (changed) {
    changed = false;
    const provided = new Set([...chosen.values()].flatMap((t) => [...variablesProvided(t)]));
    for (const t of [...chosen.values()]) {
      for (const v of variablesNeeded(t)) {
        if (provided.has(v) || v in envVars) continue;
        const producer = candidates.find((c) => c.enabled !== false && !chosen.has(c.id) && variablesProvided(c).has(v));
        if (!producer) continue;
        chosen.set(producer.id, producer);
        added.push({ test: producer, forVariables: [v] });
        provided.add(v);
        changed = true;
      }
    }
  }
  return added;
}

/**
 * Build the dependency graph for run items ({ key, test }): an item depends on
 * every other item that provides a variable it needs. Edges that would form a
 * cycle are dropped (reported in `cycles`) so the run can't deadlock.
 */
export function planDependencies(items) {
  const providers = new Map();
  for (const item of items) {
    for (const v of variablesProvided(item.test)) {
      if (!providers.has(v)) providers.set(v, []);
      providers.get(v).push(item.key);
    }
  }
  const deps = new Map();
  const needs = new Map();
  for (const item of items) {
    const need = variablesNeeded(item.test);
    needs.set(item.key, need);
    const set = new Set();
    for (const v of need) for (const p of providers.get(v) ?? []) if (p !== item.key) set.add(p);
    deps.set(item.key, set);
  }

  // Drop back-edges found by DFS so the graph is acyclic.
  const cycles = [];
  const state = new Map(); // 1 = visiting, 2 = done
  const visit = (k) => {
    state.set(k, 1);
    for (const d of [...deps.get(k)]) {
      if (state.get(d) === 1) {
        deps.get(k).delete(d);
        cycles.push([k, d]);
      } else if (!state.get(d)) visit(d);
    }
    state.set(k, 2);
  };
  for (const item of items) if (!state.get(item.key)) visit(item.key);

  return { deps, needs, providers, cycles };
}
