import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../server/app.js';
import { findRenamedField, proposeFixRuleBased, splitPath } from '../server/ai/fixer.js';

describe('rule-based fixer', () => {
  it('splits paths', () => {
    assert.deepEqual(splitPath('data.items[0].name'), { parent: 'data.items.0', last: 'name', parts: ['data', 'items', '0'] });
  });

  it('finds renamed fields: value match beats name similarity', () => {
    const current = { id: 1, fullName: 'Ada', label: 'x' };
    assert.equal(findRenamedField('name', current, { id: 1, name: 'Ada' }).path, 'fullName');
    assert.equal(findRenamedField('user.Email', { user: { email: 'a@b.c' } }, undefined).path, 'user.email');
    assert.equal(findRenamedField('zzz', current, undefined), null);
  });

  const test = {
    type: 'http',
    config: {
      method: 'GET',
      url: '{{baseUrl}}/x',
      assertions: [
        { type: 'status', operator: 'equals', expected: '200' },
        { type: 'jsonPath', target: 'name', operator: 'exists', expected: '' },
        { type: 'responseTime', operator: 'lessThan', expected: '500' },
        { type: 'jsonPath', target: 'role', operator: 'equals', expected: '{{role}}' },
      ],
    },
  };
  const result = (overrides) => ({
    status: 'failed',
    response: { status: 201, body: JSON.stringify({ fullName: 'Ada', role: 'member' }), durationMs: 900 },
    assertions: [
      { passed: false, actual: '201', description: 'Status code equals 200' },
      { passed: false, actual: 'undefined', description: 'JSON name exists' },
      { passed: false, actual: '900', description: 'Response time (ms) is less than 500' },
      { passed: false, actual: '"member"', description: 'JSON role equals admin' },
    ],
    ...overrides,
  });

  it('proposes minimal assertion changes with an honest risk level', () => {
    const p = proposeFixRuleBased({ test, result: result(), previousPass: null });
    assert.equal(p.fixable, true);
    assert.equal(p.assertions[0].expected, '201');
    assert.equal(p.assertions[1].target, 'fullName');
    assert.equal(p.assertions[2].expected, '1200');
    assert.equal(p.assertions[3].expected, '{{role}}', 'values from variables are never replaced');
    assert.equal(p.risk, 'high');
    assert.match(p.rationale, /Not changed: Assertion 4.*variable or dataset row/);
  });

  it('refuses to "fix" server errors, auth failures and network errors', () => {
    assert.equal(proposeFixRuleBased({ test, result: result({ response: { status: 500, body: '{}' } }) }).fixable, false);
    assert.equal(proposeFixRuleBased({ test, result: result({ response: { status: 401, body: '{}' } }) }).fixable, false);
    const err = proposeFixRuleBased({ test, result: { status: 'error', errorMessage: 'ECONNREFUSED', assertions: [] } });
    assert.equal(err.fixable, false);
    assert.match(err.rationale, /hide/);
  });
});

describe('fix API', () => {
  let ctx;
  let server;
  let base;
  let dir;
  const api = async (method, url, body) => {
    const res = await fetch(`${base}/api${url}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: res.status === 204 ? null : await res.json() };
  };
  const runAndWait = async (body) => {
    const { data } = await api('POST', '/runs', body);
    await ctx.engine.waitForIdle(15000);
    return (await api('GET', `/runs/${data.id}`)).data;
  };

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'testforge-fix-'));
    ctx = createApp({ dbPath: path.join(dir, 'f.db'), port: 0, ai: { enabled: false } });
    await ctx.store.updateSettings({ autoAnalyze: false });
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

  it('proposes, verifies, applies and re-runs a fix for the contract-change demo', async () => {
    const test = (await api('GET', '/tests')).data.find((t) => t.name === 'User profile v2 contract');
    const run = await runAndWait({ testIds: [test.id] });
    const failed = run.results[0];
    assert.equal(failed.status, 'failed');

    const { data: proposal } = await api('POST', `/results/${failed.id}/fix`);
    assert.equal(proposal.source, 'rules');
    assert.equal(proposal.fixable, true);
    assert.equal(proposal.after.assertions.find((a) => a.type === 'jsonPath' && a.operator === 'exists' && a.target !== 'email').target, 'fullName');
    assert.equal(proposal.verification.status, 'passed', 'the fixed test passes against the live API');

    const applied = await api('POST', `/tests/${test.id}/apply-fix`, { baseUpdatedAt: proposal.baseUpdatedAt, assertions: proposal.after.assertions });
    assert.equal(applied.status, 200);
    const rerun = await runAndWait({ testIds: [test.id] });
    assert.equal(rerun.results[0].status, 'passed');

    // The proposal is now stale: applying it again must be refused.
    const stale = await api('POST', `/tests/${test.id}/apply-fix`, { baseUpdatedAt: proposal.baseUpdatedAt, assertions: proposal.after.assertions });
    assert.equal(stale.status, 409);
  });

  it('declines to fix a real server error', async () => {
    const test = (await api('GET', '/tests')).data.find((t) => t.name === 'Inventory service healthy');
    const run = await runAndWait({ testIds: [test.id] });
    const { data } = await api('POST', `/results/${run.results[0].id}/fix`);
    assert.equal(data.fixable, false);
    assert.match(data.summary, /Fix the application, not the test/);
    assert.equal(data.verification, null);
  });

  it('verifies against the failing data row', async () => {
    const created = await api('POST', '/tests', {
      name: 'Row fix',
      type: 'http',
      config: { method: 'GET', url: '{{baseUrl}}/users/{{id}}', assertions: [{ type: 'status', operator: 'equals', expected: '200' }, { type: 'jsonPath', target: 'nickname', operator: 'exists' }], dataset: { content: 'id\n1\n2' } },
    });
    const run = await runAndWait({ testIds: [created.data.id] });
    const row2 = run.results.find((r) => r.iteration.index === 2);
    const { data } = await api('POST', `/results/${row2.id}/fix`);
    assert.equal(data.fixable, true);
    assert.equal(data.after.assertions[1].target, 'name', '"nickname" looks like a renamed "name"');
    assert.equal(data.iteration.index, 2, 'proposal is tied to the failing row');
    assert.equal(data.verification.status, 'passed', 'verified by running row 2 (id=2)');
  });
});
