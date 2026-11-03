import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';
import { createApp } from '../server/app.js';
import { AIError } from '../server/ai/providers/errors.js';
import { GeminiProvider } from '../server/ai/providers/gemini.js';

// A local stand-in for the Gemini generateContent API. `script` decides each reply.
let mock;
let mockUrl;
let calls = [];
let script = () => ({ status: 200, json: {} });

const reply = (payload, model = 'gemini-test') => ({
  status: 200,
  json: {
    candidates: [{ content: { role: 'model', parts: [{ text: 'thinking…', thought: true }, { text: JSON.stringify(payload) }] }, finishReason: 'STOP' }],
    usageMetadata: { promptTokenCount: 100, candidatesTokenCount: 20, thoughtsTokenCount: 50 },
    modelVersion: model,
  },
});

before(async () => {
  mock = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const model = decodeURIComponent(req.url.match(/models\/([^:]+):generateContent/)?.[1] ?? '');
      const call = { model, key: req.headers['x-goog-api-key'], body: JSON.parse(body || '{}') };
      calls.push(call);
      const out = script(call, calls.length);
      res.writeHead(out.status, { 'Content-Type': 'application/json' }).end(JSON.stringify(out.json));
    });
  });
  await new Promise((r) => mock.listen(0, '127.0.0.1', r));
  mockUrl = `http://127.0.0.1:${mock.address().port}/v1beta`;
});

after(() => new Promise((r) => mock.close(r)));
beforeEach(() => {
  calls = [];
});

const provider = (extra = {}) =>
  new GeminiProvider({ apiKey: 'test-key', model: 'main-model', fallbackModels: ['lite-model'], baseUrl: mockUrl, backoffMs: 5, ...extra });
const schema = { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } }, required: ['ok'] };

describe('GeminiProvider', () => {
  it('sends a schema-constrained request and parses JSON, ignoring thought parts', async () => {
    script = () => reply({ ok: true }, 'main-model-001');
    const out = await provider().structured({ system: 'sys', prompt: 'hello', schema });
    assert.deepEqual(out.data, { ok: true });
    assert.equal(out.model, 'main-model-001');
    assert.deepEqual(out.usage, { input: 100, output: 20, thinking: 50 });
    const [call] = calls;
    assert.equal(call.key, 'test-key');
    assert.equal(call.body.systemInstruction.parts[0].text, 'sys');
    assert.equal(call.body.generationConfig.responseMimeType, 'application/json');
    assert.deepEqual(call.body.generationConfig.responseJsonSchema, schema);
  });

  it('retries 503s on the same model before succeeding', async () => {
    script = (_c, n) => (n < 3 ? { status: 503, json: { error: { code: 503, message: 'high demand', status: 'UNAVAILABLE' } } } : reply({ ok: true }));
    const out = await provider().structured({ system: 's', prompt: 'p', schema });
    assert.deepEqual(out.data, { ok: true });
    assert.deepEqual(calls.map((c) => c.model), ['main-model', 'main-model', 'main-model']);
  });

  it('falls back to the next model when the main one stays overloaded or out of quota', async () => {
    script = (c) => (c.model === 'main-model' ? { status: 429, json: { error: { code: 429, message: 'quota', status: 'RESOURCE_EXHAUSTED' } } } : reply({ ok: true }, 'lite-model'));
    const out = await provider().structured({ system: 's', prompt: 'p', schema });
    assert.equal(out.model, 'lite-model');
    assert.deepEqual([...new Set(calls.map((c) => c.model))], ['main-model', 'lite-model']);
  });

  it('does not retry or fall back on a rejected key', async () => {
    script = () => ({ status: 403, json: { error: { code: 403, message: 'API key not valid', status: 'PERMISSION_DENIED' } } });
    await assert.rejects(provider().structured({ system: 's', prompt: 'p', schema }), (err) => {
      assert.ok(err instanceof AIError);
      assert.match(err.message, /Gemini rejected the API key \(403\).*GEMINI_API_KEY/);
      return true;
    });
    assert.equal(calls.length, 1);
  });

  it('reports blocked prompts and truncated output clearly', async () => {
    script = () => ({ status: 200, json: { promptFeedback: { blockReason: 'SAFETY' } } });
    await assert.rejects(provider().structured({ system: 's', prompt: 'p', schema }), /declined this input \(SAFETY\)/);
    script = () => ({ status: 200, json: { candidates: [{ content: { parts: [{ text: '{"ok":' }] }, finishReason: 'MAX_TOKENS' }] } });
    await assert.rejects(provider().structured({ system: 's', prompt: 'p', schema }), /truncated/);
  });
});

describe('Gemini end to end (analysis, summary, generation, fixes)', () => {
  let ctx;
  let server;
  let base;
  let dir;
  const api = async (method, url, body) => {
    const res = await fetch(`${base}/api${url}`, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: res.status === 204 ? null : await res.json() };
  };

  before(async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'testforge-gemini-'));
    ctx = createApp({
      dbPath: path.join(dir, 'g.db'),
      port: 0,
      ai: { provider: 'gemini', enabled: true, gemini: { apiKey: 'test-key', model: 'main-model', fallbackModels: [], baseUrl: mockUrl } },
    });
    server = await new Promise((resolve) => {
      const s = ctx.app.listen(0, '127.0.0.1', () => resolve(s));
    });
    base = `http://127.0.0.1:${server.address().port}`;
    ctx.setServerUrl(base);
  });

  after(async () => {
    await ctx.engine.waitForIdle(15000);
    await new Promise((r) => server.close(r));
    ctx.store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reports Gemini as the active provider', async () => {
    const { data } = await api('GET', '/ai/status');
    assert.equal(data.provider, 'gemini');
    assert.equal(data.providerLabel, 'Gemini');
    assert.equal(data.model, 'main-model');
  });

  it('diagnoses failures and summarizes runs with Gemini', async () => {
    script = (call) => {
      const props = call.body.generationConfig.responseJsonSchema.properties;
      if (props.headline) return reply({ headline: 'Gemini headline', overview: 'o', themes: [], recommendations: ['r'], riskLevel: 'medium' });
      return reply({ category: 'contract_change', summary: 'Gemini: field renamed', rootCause: 'name → fullName', evidence: ['e'], suggestedFixes: ['f'], confidence: 'high', owner: 'application', isLikelyFlaky: false });
    };
    const users = (await api('GET', '/suites')).data.find((s) => s.name === 'Users API');
    const { data: run } = await api('POST', '/runs', { suiteId: users.id });
    await ctx.engine.waitForIdle(15000);
    let done;
    for (let i = 0; i < 60 && !done?.aiSummary; i++) {
      await new Promise((r) => setTimeout(r, 100));
      done = (await api('GET', `/runs/${run.id}`)).data;
    }
    assert.equal(done.aiSummary.source, 'gemini');
    assert.equal(done.aiSummary.headline, 'Gemini headline');
    const contract = done.results.find((r) => r.testName === 'User profile v2 contract');
    assert.equal(contract.analysis.source, 'gemini');
    assert.equal(contract.analysis.summary, 'Gemini: field renamed');
    const html = await (await fetch(`${base}/api/runs/${run.id}/report?format=html`)).text();
    assert.match(html, /Gemini \(gemini-test\)/);
  });

  it('generates tests from a description with Gemini', async () => {
    script = () =>
      reply({
        tests: [{ name: 'Health is ok', description: 'd', method: 'GET', url: '{{baseUrl}}/health', query: [], headers: [], body: '', tags: ['smoke'], priority: 'high', assertions: [{ type: 'status', target: '', operator: 'equals', expected: '200' }] }],
        notes: 'Assumed /health.',
      });
    const { status, data } = await api('POST', '/generate', { source: 'description', input: 'check health' });
    assert.equal(status, 200);
    assert.equal(data.generator, 'gemini');
    assert.equal(data.tests[0].config.url, '{{baseUrl}}/health');
    assert.deepEqual(data.warnings, ['Assumed /health.']);
  });

  it('proposes a verified fix with Gemini', async () => {
    const results = ctx.store.listFinishedResults({ failuresOnly: true });
    const contract = results.find((r) => r.testName === 'User profile v2 contract');
    const test = ctx.store.getTest(contract.testCaseId);
    script = () =>
      reply({
        fixable: true,
        summary: 'Use fullName',
        rationale: 'renamed',
        risk: 'low',
        assertions: test.config.assertions.map((a) => (a.target === 'name' ? { ...a, target: 'fullName' } : a)),
        code: '',
      });
    const { data } = await api('POST', `/results/${contract.id}/fix`);
    assert.equal(data.source, 'gemini');
    assert.equal(data.fixable, true);
    assert.equal(data.verification.status, 'passed');
  });

  it('falls back to rule-based generation with a clear warning when Gemini fails', async () => {
    script = () => ({ status: 403, json: { error: { code: 403, message: 'API key not valid', status: 'PERMISSION_DENIED' } } });
    const { data } = await api('POST', '/generate', { source: 'curl', input: `curl ${base}/demo-api/health` });
    assert.equal(data.generator, 'rules');
    assert.match(data.warnings[0], /^Gemini unavailable \(Gemini rejected the API key/);
  });
});
