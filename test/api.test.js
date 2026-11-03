import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../server/app.js';

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
  const data = res.status === 204 ? null : await res.json();
  return { status: res.status, data };
};

async function waitForRun(id, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const { data } = await api('GET', `/runs/${id}`);
    if (!['queued', 'running'].includes(data.status)) return data;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`run ${id} did not finish`);
}

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'testforge-'));
  ctx = createApp({ dbPath: path.join(dir, 'test.db'), port: 0, ai: { enabled: false } });
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

describe('API', () => {
  it('seeds demo data on first boot', async () => {
    const tests = await api('GET', '/tests');
    const suites = await api('GET', '/suites');
    const envs = await api('GET', '/environments');
    assert.ok(tests.data.length >= 10);
    assert.deepEqual(suites.data.map((s) => s.name).sort(), ['Resilience & Performance', 'Smoke', 'Users API']);
    assert.ok(envs.data.some((e) => e.isDefault));
  });

  it('runs the Smoke suite and everything passes', async () => {
    const smoke = (await api('GET', '/suites')).data.find((s) => s.name === 'Smoke');
    const { status, data: queued } = await api('POST', '/runs', { suiteId: smoke.id });
    assert.equal(status, 202);
    const run = await waitForRun(queued.id);
    assert.equal(run.status, 'passed');
    assert.equal(run.passed, run.total);
    for (const r of run.results) {
      assert.equal(r.status, 'passed', `${r.testName}: ${r.errorMessage}`);
      assert.ok(r.logs.length > 0);
    }
  });

  it('runs everything, records failures and analyzes them', async () => {
    const { data: queued } = await api('POST', '/runs', { name: 'full' });
    const run = await waitForRun(queued.id);
    assert.equal(run.status, 'failed');
    const byName = Object.fromEntries(run.results.map((r) => [r.testName, r]));
    assert.equal(byName['Create then fetch a user (script)'].status, 'passed');
    assert.equal(byName['Orders require authentication (script)'].status, 'passed');
    assert.equal(byName['User profile v2 contract'].status, 'failed');
    assert.equal(byName['Payment gateway reachable'].status, 'error');

    // Auto-analysis runs after the run finishes.
    let analyzed;
    for (let i = 0; i < 50 && !analyzed?.aiSummary; i++) {
      await new Promise((r) => setTimeout(r, 100));
      analyzed = (await api('GET', `/runs/${run.id}`)).data;
    }
    assert.ok(analyzed.aiSummary, 'run summary was generated');
    const contract = analyzed.results.find((r) => r.testName === 'User profile v2 contract');
    assert.equal(contract.analysis.category, 'contract_change');
    const payment = analyzed.results.find((r) => r.testName === 'Payment gateway reachable');
    assert.equal(payment.analysis.category, 'network_connectivity');
  });

  it('serves reports in every format', async () => {
    const { data } = await api('GET', '/runs?limit=1');
    const id = data.runs[0].id;
    for (const [format, type] of [
      ['html', 'text/html'],
      ['junit', 'application/xml'],
      ['json', 'application/json'],
      ['csv', 'text/csv'],
    ]) {
      const res = await fetch(`${base}/api/runs/${id}/report?format=${format}`);
      assert.equal(res.status, 200);
      assert.ok(res.headers.get('content-type').startsWith(type), format);
    }
  });

  it('creates, tries and validates test cases', async () => {
    const bad = await api('POST', '/tests', { name: '', type: 'http', config: {} });
    assert.equal(bad.status, 400);
    assert.ok(bad.data.details.length >= 2);

    const def = {
      name: 'Products list',
      type: 'http',
      config: { method: 'GET', url: '{{baseUrl}}/products', assertions: [{ type: 'jsonPath', target: 'total', operator: 'equals', expected: '4' }] },
    };
    const tried = await api('POST', '/tests/try', { test: def });
    assert.equal(tried.data.status, 'passed');
    assert.equal(tried.data.response.status, 200);

    const created = await api('POST', '/tests', def);
    assert.equal(created.status, 201);
    const updated = await api('PUT', `/tests/${created.data.id}`, { retries: 2, tags: 'a, b' });
    assert.equal(updated.data.retries, 2);
    assert.deepEqual(updated.data.tags, ['a', 'b']);
  });

  it('times out runaway scripts', async () => {
    const { data } = await api('POST', '/tests/try', {
      test: { name: 'hang', type: 'script', timeoutMs: 300, config: { code: 'await new Promise(() => {});' } },
    });
    assert.equal(data.status, 'error');
    assert.match(data.errorMessage, /timed out/);
  });

  it('reports script assertion failures as failed, and script bugs as errors', async () => {
    const failed = await api('POST', '/tests/try', { test: { name: 'f', type: 'script', config: { code: 'expect(1 + 1).toBe(3);' } } });
    assert.equal(failed.data.status, 'failed');
    assert.match(failed.data.errorMessage, /to be 3/);
    const errored = await api('POST', '/tests/try', { test: { name: 'e', type: 'script', config: { code: 'undefinedThing.call();' } } });
    assert.equal(errored.data.status, 'error');
    assert.match(errored.data.errorMessage, /ReferenceError/);
  });

  it('cancels an in-flight run', async () => {
    const slow = await api('POST', '/tests', {
      name: 'slow',
      type: 'http',
      timeoutMs: 5000,
      config: { method: 'GET', url: '{{baseUrl}}/search?delay=2000', assertions: [] },
    });
    const others = (await api('GET', '/tests')).data.slice(0, 5).map((t) => t.id);
    const { data: queued } = await api('POST', '/runs', { testIds: [slow.data.id, ...others] });
    await new Promise((r) => setTimeout(r, 150));
    const cancel = await api('POST', `/runs/${queued.id}/cancel`);
    assert.equal(cancel.status, 200);
    const run = await waitForRun(queued.id);
    assert.equal(run.status, 'cancelled');
  });

  it('builds analytics', async () => {
    const { data } = await api('GET', '/analytics?limit=10');
    assert.ok(data.trend.length >= 2);
    assert.ok(data.kpis.totalTests > 10);
    assert.ok(data.stability.some((s) => s.testName === 'Health check returns OK' && s.passRate === 100));
    assert.ok(data.failureCategories.length > 0);
  });

  it('returns 404 for unknown resources', async () => {
    assert.equal((await api('GET', '/runs/99999')).status, 404);
    assert.equal((await api('GET', '/nope')).status, 404);
  });
});
