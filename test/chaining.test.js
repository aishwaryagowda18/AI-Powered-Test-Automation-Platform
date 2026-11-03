import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../server/app.js';
import { parseCsv, parseDataset } from '../server/runner/dataset.js';
import { findMissingProducers, planDependencies, variablesNeeded, variablesProvided } from '../server/runner/dependencies.js';
import { extractVariables } from '../server/runner/http-runner.js';

const http = (id, config, extra = {}) => ({ id, name: `t${id}`, type: 'http', enabled: true, config: { method: 'GET', ...config }, ...extra });

describe('datasets', () => {
  it('parses quoted CSV fields, escaped quotes, blank lines and CRLF', () => {
    assert.deepEqual(parseCsv('a,b\r\n"x, y","say ""hi"""\r\n\r\n1,\n'), [['a', 'b'], ['x, y', 'say "hi"'], ['1', '']]);
  });

  it('parses CSV and JSON datasets into rows', () => {
    assert.deepEqual(parseDataset('id,name\n1,Ada\n2,Alan'), { columns: ['id', 'name'], rows: [{ id: '1', name: 'Ada' }, { id: '2', name: 'Alan' }] });
    const fromJson = parseDataset('[{"id":1,"tags":["a"]},{"id":2,"extra":true}]');
    assert.deepEqual(fromJson.columns, ['id', 'tags', 'extra']);
    assert.deepEqual(fromJson.rows[0], { id: '1', tags: '["a"]', extra: '' });
  });

  it('rejects bad datasets with clear messages', () => {
    assert.throws(() => parseDataset('only-header'), /header row and at least one data row/);
    assert.throws(() => parseDataset('a,a\n1,2'), /Duplicate column: a/);
    assert.throws(() => parseDataset('1st,b\n1,2'), /not a valid variable name/);
    assert.throws(() => parseDataset('a\n1,2'), /Row 1 has 2 values/);
    assert.throws(() => parseDataset(`a\n${'1\n'.repeat(101)}`), /limited to 100 rows/);
  });
});

describe('dependency analysis', () => {
  const login = http(1, { url: '{{baseUrl}}/login', extract: [{ variable: 'token', from: 'jsonPath', path: 'token' }] });
  const orders = http(2, { url: '{{baseUrl}}/orders', headers: [{ key: 'Authorization', value: 'Bearer {{token}}' }] });
  const script = { id: 3, name: 's', type: 'script', enabled: true, config: { code: "const t = vars.token; setVar('orderId', '7'); vars['region'];" } };
  const rowTest = http(4, { url: '{{baseUrl}}/users/{{id}}', dataset: { content: 'id\n1' } });

  it('finds needed and provided variables for HTTP and script tests', () => {
    assert.deepEqual([...variablesNeeded(orders)], ['baseUrl', 'token']);
    assert.deepEqual([...variablesProvided(login)], ['token']);
    assert.deepEqual([...variablesNeeded(script)].sort(), ['region', 'token']);
    assert.deepEqual([...variablesProvided(script)], ['orderId']);
    assert.deepEqual([...variablesNeeded(rowTest)], ['baseUrl'], 'dataset columns are satisfied by the row');
  });

  it('orders consumers after producers and drops cycles', () => {
    const { deps } = planDependencies([
      { key: 'a', test: login },
      { key: 'b', test: orders },
    ]);
    assert.deepEqual([...deps.get('b')], ['a']);
    assert.equal(deps.get('a').size, 0);

    const x = http(5, { url: '{{y}}', extract: [{ variable: 'x', from: 'status' }] });
    const y = http(6, { url: '{{x}}', extract: [{ variable: 'y', from: 'status' }] });
    const plan = planDependencies([
      { key: 'x', test: x },
      { key: 'y', test: y },
    ]);
    assert.equal(plan.cycles.length, 1);
    assert.ok(plan.deps.get('x').size + plan.deps.get('y').size === 1);
  });

  it('pulls in missing producers, unless the environment already has the variable', () => {
    assert.deepEqual(findMissingProducers([orders], [login, orders], { baseUrl: 'x' }).map((a) => a.test.id), [1]);
    assert.deepEqual(findMissingProducers([orders], [login, orders], { baseUrl: 'x', token: 'static' }), []);
  });
});

describe('extractVariables', () => {
  const ctx = { status: 201, headers: { location: '/users/9' }, body: 'id=abc-123;', json: { data: { token: 'secret-token-value', list: [1, 2] } } };
  it('captures from JSON, headers, status and regex', () => {
    const logs = [];
    const out = extractVariables(
      [
        { variable: 'token', from: 'jsonPath', path: 'data.token' },
        { variable: 'list', from: 'jsonPath', path: 'data.list' },
        { variable: 'loc', from: 'header', path: 'Location' },
        { variable: 'code', from: 'status' },
        { variable: 'rid', from: 'regex', path: 'id=([\\w-]+)' },
        { variable: 'missing', from: 'jsonPath', path: 'nope' },
      ],
      ctx,
      (level, msg) => logs.push([level, msg]),
    );
    assert.deepEqual(out, { token: 'secret-token-value', list: '[1,2]', loc: '/users/9', code: '201', rid: 'abc-123' });
    assert.ok(logs.some(([l, m]) => l === 'warn' && m.includes('{{missing}}')));
    assert.ok(!logs.some(([, m]) => m.includes('secret-token-value')), 'captured values are masked in logs');
  });
});

// --------------------------------------------------------------- integration

let ctx;
let server;
let base;
let dir;

const api = async (method, url, body) => {
  const res = await fetch(`${base}/api${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: res.status === 204 ? null : await res.json() };
};

async function runAndWait(body) {
  const { status, data } = await api('POST', '/runs', body);
  assert.equal(status, 202, JSON.stringify(data));
  await ctx.engine.waitForIdle(20000);
  return (await api('GET', `/runs/${data.id}`)).data;
}

const testByName = async (name) => (await api('GET', '/tests')).data.find((t) => t.name === name);

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'testforge-chain-'));
  ctx = createApp({ dbPath: path.join(dir, 'c.db'), port: 0, ai: { enabled: false } });
  await ctx.store.updateSettings({ maxConcurrency: 4, autoAnalyze: false });
  server = await new Promise((resolve) => {
    const s = ctx.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
  ctx.setServerUrl(base);
});

after(async () => {
  await ctx.engine.waitForIdle(10000);
  await new Promise((r) => server.close(r));
  ctx.store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('chained runs', () => {
  it('runs the consumer after the producer even with parallel workers', async () => {
    const smoke = (await api('GET', '/suites')).data.find((s) => s.name === 'Smoke');
    const run = await runAndWait({ suiteId: smoke.id });
    const orders = run.results.find((r) => r.testName === 'List orders with captured token');
    const login = run.results.find((r) => r.testName === 'Login with valid credentials');
    assert.equal(orders.status, 'passed', orders.errorMessage);
    assert.ok(new Date(orders.startedAt) >= new Date(login.finishedAt), 'consumer started after producer finished');
    assert.ok(login.logs.some((l) => l.message.startsWith('Captured {{token}}')));
    assert.ok(orders.logs.some((l) => l.message.includes('Using chained variables: {{token}}')));
  });

  it('auto-includes the producer when running a consumer alone', async () => {
    const orders = await testByName('List orders with captured token');
    assert.deepEqual(orders.needs.sort(), ['baseUrl', 'token']);
    const run = await runAndWait({ testIds: [orders.id] });
    assert.equal(run.total, 2);
    assert.deepEqual(run.results.map((r) => r.status), ['passed', 'passed']);
    assert.ok(run.results[0].logs.some((l) => l.message.includes('Added to this run automatically')));
  });

  it('skips dependents with a clear reason when the producer does not capture the value', async () => {
    const producer = await api('POST', '/tests', {
      name: 'Broken producer',
      type: 'http',
      config: { method: 'GET', url: '{{baseUrl}}/health', extract: [{ variable: 'sessionId', from: 'jsonPath', path: 'session.id' }] },
    });
    const consumer = await api('POST', '/tests', { name: 'Needs session', type: 'http', config: { method: 'GET', url: '{{baseUrl}}/users/{{sessionId}}' } });
    const run = await runAndWait({ testIds: [producer.data.id, consumer.data.id] });
    const skipped = run.results.find((r) => r.testName === 'Needs session');
    assert.equal(skipped.status, 'skipped');
    assert.match(skipped.errorMessage, /\{\{sessionId\}\} was not captured because "Broken producer" did not provide it/);
    await api('DELETE', `/tests/${producer.data.id}`);
    await api('DELETE', `/tests/${consumer.data.id}`);
  });

  it('chains values between script tests via setVar / vars', async () => {
    const a = await api('POST', '/tests', { name: 'Script producer', type: 'script', config: { code: "setVar('greeting', 'hello'); setVar('obj', { n: 1 });" } });
    const b = await api('POST', '/tests', { name: 'Script consumer', type: 'script', config: { code: "expect(vars.greeting).toBe('hello'); expect(JSON.parse(vars.obj).n).toBe(1);" } });
    const run = await runAndWait({ testIds: [b.data.id, a.data.id] });
    assert.deepEqual(run.results.map((r) => [r.testName, r.status]).sort(), [['Script consumer', 'passed'], ['Script producer', 'passed']]);
    await api('DELETE', `/tests/${a.data.id}`);
    await api('DELETE', `/tests/${b.data.id}`);
  });

  it('runs dependencies first in "Try it"', async () => {
    const orders = await testByName('List orders with captured token');
    const { data } = await api('POST', '/tests/try', { test: { ...orders, id: undefined, name: 'Draft orders' } });
    assert.equal(data.status, 'passed', data.errorMessage);
    assert.ok(data.logs.some((l) => l.message.includes('Running dependency "Login with valid credentials"')));
  });
});

describe('data-driven runs', () => {
  it('runs one result per dataset row with row variables', async () => {
    const t = await testByName('Fetch users by id (data-driven)');
    assert.equal(t.datasetRows, 4);
    const run = await runAndWait({ testIds: [t.id] });
    assert.equal(run.total, 4);
    assert.deepEqual(run.results.map((r) => r.iteration.index), [1, 2, 3, 4]);
    assert.ok(run.results.every((r) => r.status === 'passed'), JSON.stringify(run.results.map((r) => r.errorMessage)));
    assert.equal(run.results[1].displayName, 'Fetch users by id (data-driven) [row 2]');
    assert.equal(run.results[1].iteration.data.name, 'Alan Turing');
  });

  it('interpolates row values into assertions (expected status per row)', async () => {
    const t = await testByName('Login outcomes (data-driven)');
    const run = await runAndWait({ testIds: [t.id] });
    assert.deepEqual(run.results.map((r) => r.status), ['passed', 'passed', 'passed', 'passed']);
  });

  it('reports a failing row on its own and labels it in reports and analytics', async () => {
    const created = await api('POST', '/tests', {
      name: 'Roles',
      type: 'http',
      config: { method: 'GET', url: '{{baseUrl}}/users/{{id}}', assertions: [{ type: 'jsonPath', target: 'role', operator: 'equals', expected: '{{role}}' }], dataset: { content: 'id,role\n1,admin\n2,admin' } },
    });
    const run = await runAndWait({ testIds: [created.data.id] });
    assert.deepEqual(run.results.map((r) => r.status), ['passed', 'failed']);
    const junit = await (await fetch(`${base}/api/runs/${run.id}/report?format=junit`)).text();
    assert.match(junit, /name="Roles \[row 2\]"/);
    const { data } = await api('GET', '/analytics?limit=50');
    const rows = data.stability.filter((s) => s.testName.startsWith('Roles'));
    assert.deepEqual(rows.map((s) => s.testName).sort(), ['Roles [row 1]', 'Roles [row 2]']);
  });

  it('validates datasets and extraction rules', async () => {
    const bad = await api('POST', '/tests', {
      name: 'bad',
      type: 'http',
      config: { method: 'GET', url: 'http://x', dataset: { content: 'a,a\n1,2' }, extract: [{ variable: '9lives', from: 'jsonPath', path: 'x' }] },
    });
    assert.equal(bad.status, 400);
    assert.ok(bad.data.details.some((d) => d.includes('Duplicate column')));
    assert.ok(bad.data.details.some((d) => d.includes('extract[0].variable')));
    const preview = await api('POST', '/tests/dataset/preview', { content: 'u,p\na,b\nc,d' });
    assert.deepEqual(preview.data, { columns: ['u', 'p'], rows: [{ u: 'a', p: 'b' }, { u: 'c', p: 'd' }], total: 2 });
  });
});
