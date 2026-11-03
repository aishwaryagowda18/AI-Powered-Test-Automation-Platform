#!/usr/bin/env node
/**
 * TestForge CLI — trigger a run on a TestForge server and wait for the result.
 * Exits non-zero when any test fails, so it can gate CI pipelines.
 *
 *   node cli/testforge.js run [--suite "Smoke"] [--tests 1,2,3] [--env "Local demo"]
 *                             [--url http://localhost:4000] [--junit report.xml] [--html report.html]
 *   node cli/testforge.js list
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: 'string', default: process.env.TESTFORGE_URL || 'http://localhost:4000' },
    suite: { type: 'string' },
    tests: { type: 'string' },
    env: { type: 'string' },
    name: { type: 'string' },
    junit: { type: 'string' },
    html: { type: 'string' },
    timeout: { type: 'string', default: '600' },
    help: { type: 'boolean', short: 'h' },
  },
});

const command = positionals[0] ?? 'run';
const base = values.url.replace(/\/$/, '');
const color = process.stdout.isTTY ? (code, s) => `\x1b[${code}m${s}\x1b[0m` : (_c, s) => s;
const ICON = { passed: color(32, '✓'), failed: color(31, '✗'), error: color(33, '!'), skipped: color(90, '–') };

async function api(method, path, body) {
  const res = await fetch(`${base}/api${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(`${method} ${path} → ${res.status}: ${data.error ?? res.statusText}`);
  }
  return res.status === 204 ? null : res.json();
}

async function download(path, file) {
  const res = await fetch(`${base}/api${path}`);
  if (!res.ok) throw new Error(`Could not download ${path}: ${res.status}`);
  mkdirSync(dirname(resolve(file)), { recursive: true });
  writeFileSync(file, await res.text());
  console.log(`  report written to ${file}`);
}

async function run() {
  const body = { trigger: 'ci', name: values.name };
  if (values.suite) {
    const suites = await api('GET', '/suites');
    const suite = suites.find((s) => s.name.toLowerCase() === values.suite.toLowerCase() || String(s.id) === values.suite);
    if (!suite) throw new Error(`Suite "${values.suite}" not found. Available: ${suites.map((s) => s.name).join(', ')}`);
    body.suiteId = suite.id;
  }
  if (values.tests) body.testIds = values.tests.split(',').map((x) => Number(x.trim()));
  if (values.env) {
    const envs = await api('GET', '/environments');
    const env = envs.find((e) => e.name.toLowerCase() === values.env.toLowerCase() || String(e.id) === values.env);
    if (!env) throw new Error(`Environment "${values.env}" not found. Available: ${envs.map((e) => e.name).join(', ')}`);
    body.environmentId = env.id;
  }

  const started = await api('POST', '/runs', body);
  console.log(`\n  ${color(35, 'TestForge')} run #${started.id} "${started.name}" (${started.total} tests) → ${base}/runs/${started.id}\n`);

  const deadline = Date.now() + Number(values.timeout) * 1000;
  let run;
  const printed = new Set();
  while (Date.now() < deadline) {
    run = await api('GET', `/runs/${started.id}`);
    for (const r of run.results) {
      if (printed.has(r.id) || ['queued', 'running'].includes(r.status)) continue;
      printed.add(r.id);
      const ms = r.durationMs != null ? color(90, ` ${r.durationMs} ms`) : '';
      console.log(`  ${ICON[r.status] ?? '?'} ${r.displayName ?? r.testName}${ms}${r.flaky ? color(33, ' (flaky)') : ''}`);
      if (r.errorMessage && r.status !== 'passed') console.log(color(90, `      ${r.errorMessage}`));
    }
    if (!['queued', 'running'].includes(run.status)) break;
    await new Promise((r) => setTimeout(r, 750));
  }
  if (['queued', 'running'].includes(run.status)) {
    await api('POST', `/runs/${started.id}/cancel`).catch(() => {});
    throw new Error(`Timed out after ${values.timeout}s`);
  }

  const verdict = run.status === 'passed' ? color(32, 'PASSED') : color(31, run.status.toUpperCase());
  console.log(`\n  ${verdict}  ${run.passed} passed · ${run.failed} failed · ${run.errored} errors · ${run.skipped} skipped · ${run.durationMs} ms\n`);

  if (values.junit) await download(`/runs/${run.id}/report?format=junit`, values.junit);
  if (values.html) await download(`/runs/${run.id}/report?format=html`, values.html);
  return run.status === 'passed' ? 0 : 1;
}

async function list() {
  const [suites, tests] = await Promise.all([api('GET', '/suites'), api('GET', '/tests')]);
  for (const s of suites) {
    console.log(`\n${color(35, s.name)} (#${s.id})`);
    for (const t of tests.filter((x) => x.suiteId === s.id)) console.log(`  #${t.id} [${t.type}] ${t.name}${t.enabled ? '' : color(90, ' (disabled)')}`);
  }
  const loose = tests.filter((t) => !t.suiteId);
  if (loose.length) {
    console.log(`\n${color(35, 'Ungrouped')}`);
    for (const t of loose) console.log(`  #${t.id} [${t.type}] ${t.name}`);
  }
  return 0;
}

if (values.help) {
  console.log(`Usage:
  testforge run  [--suite <name|id>] [--tests 1,2] [--env <name|id>] [--name <run name>]
                 [--junit file.xml] [--html file.html] [--timeout seconds] [--url ${values.url}]
  testforge list [--url ...]

Exit code is 0 when the run passes, 1 when any test fails or errors, 2 on usage/connection errors.`);
  process.exit(0);
}

try {
  const code = command === 'list' ? await list() : command === 'run' ? await run() : (console.error(`Unknown command "${command}"`), 2);
  process.exit(code);
} catch (err) {
  console.error(color(31, `\n  ${err.message}`));
  if (err.cause?.code === 'ECONNREFUSED') console.error(`  Is the TestForge server running at ${base}?`);
  process.exit(2);
}
