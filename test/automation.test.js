import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../server/app.js';

// Schedules, notifications and test generation, exercised through the real API.
let ctx;
let server;
let base;
let dir;
let receiver;
let receiverUrl;
const received = [];

const api = async (method, url, body) => {
  const res = await fetch(`${base}/api${url}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: res.status === 204 ? null : await res.json() };
};

const waitFor = async (fn, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('condition not met in time');
};

before(async () => {
  dir = mkdtempSync(path.join(tmpdir(), 'testforge-auto-'));
  ctx = createApp({ dbPath: path.join(dir, 'a.db'), port: 0, ai: { enabled: false } });
  server = await new Promise((resolve) => {
    const s = ctx.app.listen(0, '127.0.0.1', () => resolve(s));
  });
  base = `http://127.0.0.1:${server.address().port}`;
  ctx.setServerUrl(base);

  receiver = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received.push({ path: req.url, body: JSON.parse(body) });
      res.writeHead(req.url === '/fail' ? 500 : 200).end('ok');
    });
  });
  await new Promise((r) => receiver.listen(0, '127.0.0.1', r));
  receiverUrl = `http://127.0.0.1:${receiver.address().port}`;
});

after(async () => {
  await ctx.engine.waitForIdle(10000);
  await new Promise((r) => server.close(r));
  await new Promise((r) => receiver.close(r));
  ctx.store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('schedules', () => {
  it('seeds example schedules disabled', async () => {
    const { data } = await api('GET', '/schedules');
    assert.equal(data.length, 2);
    assert.ok(data.every((s) => !s.enabled && s.upcoming.length === 0));
    assert.equal(data[0].description, 'Every 15 minutes');
  });

  it('validates cron expressions', async () => {
    const bad = await api('POST', '/schedules', { name: 'x', cron: 'every day' });
    assert.equal(bad.status, 400);
    const preview = await api('POST', '/schedules/preview', { cron: '0 9 * * 1-5' });
    assert.equal(preview.data.description, 'Weekdays at 09:00');
    assert.equal(preview.data.upcoming.length, 5);
  });

  it('fires due schedules on tick and records the run', async () => {
    const smoke = (await api('GET', '/suites')).data.find((s) => s.name === 'Smoke');
    const { data: created } = await api('POST', '/schedules', { name: 'Smoke CI', cron: '*/5 * * * *', suiteId: smoke.id });
    assert.ok(created.nextRunAt);
    assert.equal(created.upcoming.length, 3);

    // Pretend the clock reached the next slot.
    const fired = ctx.scheduler.tick(new Date(new Date(created.nextRunAt).getTime() + 1000));
    assert.equal(fired.length, 1);
    assert.equal(fired[0].trigger, 'schedule');
    assert.equal(fired[0].name, '⏱ Smoke CI');

    const after = (await api('GET', '/schedules')).data.find((s) => s.id === created.id);
    assert.equal(after.lastRunId, fired[0].id);
    assert.ok(new Date(after.nextRunAt) > new Date(created.nextRunAt));
    await ctx.engine.waitForIdle();
  });

  it('runs a schedule on demand', async () => {
    const { data: list } = await api('GET', '/schedules');
    const { status, data: run } = await api('POST', `/schedules/${list[0].id}/run`);
    assert.equal(status, 202);
    assert.equal(run.trigger, 'schedule');
    await ctx.engine.waitForIdle();
  });
});

describe('notifications', () => {
  it('validates channels and sends a test message', async () => {
    assert.equal((await api('POST', '/notifications', { name: 'x', type: 'slack', url: 'not a url' })).status, 400);
    const { data: ch } = await api('POST', '/notifications', { name: 'Hook', type: 'webhook', url: `${receiverUrl}/hook`, notifyOn: 'always' });
    const { data: result } = await api('POST', `/notifications/${ch.id}/test`);
    assert.equal(result.ok, true);
    assert.equal(received.at(-1).body.event, 'test');
    const failing = await api('POST', '/notifications', { name: 'Bad', type: 'slack', url: `${receiverUrl}/fail` });
    const { data: badResult } = await api('POST', `/notifications/${failing.data.id}/test`);
    assert.equal(badResult.ok, false);
    assert.match(badResult.error, /HTTP 500/);
    await api('DELETE', `/notifications/${failing.data.id}`);
  });

  it('delivers run results, including the AI summary for failed runs', async () => {
    received.length = 0;
    const resilience = (await api('GET', '/suites')).data.find((s) => s.name === 'Resilience & Performance');
    const { data: run } = await api('POST', '/runs', { suiteId: resilience.id });
    const msg = await waitFor(() => received.find((r) => r.body.run?.id === run.id));
    assert.equal(msg.body.event, 'run.finished');
    assert.equal(msg.body.run.status, 'failed');
    assert.ok(msg.body.summary?.headline, 'summary included');
    assert.ok(msg.body.failures.some((f) => f.category === 'server_error'));
    assert.equal(msg.body.url, `${base.replace('127.0.0.1', 'localhost')}/runs/${run.id}`);
    const channel = (await api('GET', '/notifications')).data[0];
    assert.equal(channel.lastStatus, 'ok');
  });
});

describe('test generation', () => {
  it('converts a cURL command using the environment baseUrl', async () => {
    const env = (await api('GET', '/environments')).data.find((e) => e.isDefault);
    const { data } = await api('POST', '/generate', {
      source: 'curl',
      input: `curl ${base}/demo-api/products?category=displays`,
      environmentId: env.id,
    });
    assert.equal(data.generator, 'rules');
    assert.equal(data.tests[0].config.url, '{{baseUrl}}/products?category=displays');

    // The generated draft imports and passes against the demo API.
    const { data: imported } = await api('POST', '/tests/import', { tests: data.tests.map((t) => ({ ...t, suite: 'Generated' })) });
    const tried = await api('POST', '/tests/try', { test: imported.tests[0] });
    assert.equal(tried.data.status, 'passed');
  });

  it('converts an OpenAPI JSON spec', async () => {
    const spec = { openapi: '3.0.0', paths: { '/health': { get: { summary: 'Health', responses: { 200: {} } } } } };
    const { data } = await api('POST', '/generate', { source: 'openapi', input: JSON.stringify(spec) });
    assert.equal(data.tests.length, 1);
    assert.equal(data.tests[0].name, 'Health');
  });

  it('explains that descriptions need an AI provider when none is configured', async () => {
    const res = await api('POST', '/generate', { source: 'description', input: 'test the login endpoint' });
    assert.equal(res.status, 400);
    assert.match(res.data.error, /needs an AI provider/);
  });
});
