import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluateAssertion, getPath, parseExpected } from '../server/runner/assertions.js';
import { interpolate, resolveVariables, unresolvedPlaceholders } from '../server/runner/template.js';

describe('getPath', () => {
  const doc = { data: { items: [{ id: 7, name: 'a' }, { id: 8 }] }, 'odd key': 1 };

  it('reads dotted, bracketed and $-prefixed paths', () => {
    assert.equal(getPath(doc, 'data.items[0].id'), 7);
    assert.equal(getPath(doc, '$.data.items.1.id'), 8);
    assert.equal(getPath(doc, "$['odd key']"), 1);
  });

  it('supports .length and returns undefined for missing segments', () => {
    assert.equal(getPath(doc, 'data.items.length'), 2);
    assert.equal(getPath(doc, 'data.missing.deep'), undefined);
    assert.deepEqual(getPath(doc, '$'), doc);
  });
});

describe('parseExpected', () => {
  it('parses JSON literals and keeps plain strings', () => {
    assert.equal(parseExpected('200'), 200);
    assert.equal(parseExpected('true'), true);
    assert.deepEqual(parseExpected('[1,2]'), [1, 2]);
    assert.equal(parseExpected('ok'), 'ok');
  });
});

describe('evaluateAssertion', () => {
  const ctx = {
    status: 201,
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: '{"id":5,"tags":["a","b"],"name":"Ada"}',
    json: { id: 5, tags: ['a', 'b'], name: 'Ada' },
    durationMs: 120,
  };
  const check = (a) => evaluateAssertion(a, ctx).passed;

  it('evaluates status, timing and header assertions', () => {
    assert.ok(check({ type: 'status', operator: 'equals', expected: '201' }));
    assert.ok(!check({ type: 'status', operator: 'equals', expected: '200' }));
    assert.ok(check({ type: 'responseTime', operator: 'lessThan', expected: '500' }));
    assert.ok(check({ type: 'header', target: 'Content-Type', operator: 'contains', expected: 'json' }));
  });

  it('evaluates JSON path operators', () => {
    assert.ok(check({ type: 'jsonPath', target: 'id', operator: 'equals', expected: '5' }));
    assert.ok(check({ type: 'jsonPath', target: 'tags', operator: 'contains', expected: 'b' }));
    assert.ok(check({ type: 'jsonPath', target: 'tags', operator: 'isType', expected: 'array' }));
    assert.ok(check({ type: 'jsonPath', target: 'missing', operator: 'notExists' }));
    assert.ok(check({ type: 'jsonPath', target: 'name', operator: 'matches', expected: '^A' }));
    assert.ok(check({ type: 'jsonPath', target: 'name', operator: 'exists' }));
  });

  it('produces a readable failure message with the actual value', () => {
    const r = evaluateAssertion({ type: 'jsonPath', target: 'name', operator: 'equals', expected: 'Grace' }, ctx);
    assert.equal(r.passed, false);
    assert.match(r.message, /Assertion failed: JSON name equals Grace \(actual: "Ada"\)/);
  });

  it('fails JSON assertions gracefully on non-JSON bodies', () => {
    const r = evaluateAssertion({ type: 'jsonPath', target: 'x', operator: 'exists' }, { ...ctx, json: undefined });
    assert.equal(r.passed, false);
    assert.match(r.message, /not valid JSON/);
  });
});

describe('templating', () => {
  it('interpolates nested structures and leaves unknown placeholders', () => {
    const out = interpolate({ url: '{{baseUrl}}/x', list: ['{{ id }}'], keep: '{{nope}}' }, { baseUrl: 'http://h', id: 3 });
    assert.deepEqual(out, { url: 'http://h/x', list: ['3'], keep: '{{nope}}' });
    assert.deepEqual(unresolvedPlaceholders(out), ['nope']);
  });

  it('lets environment variables reference built-ins', () => {
    const vars = resolveVariables({ baseUrl: '{{$serverUrl}}/api' }, { serverUrl: 'http://127.0.0.1:1' });
    assert.equal(vars.baseUrl, 'http://127.0.0.1:1/api');
    assert.ok(vars.$uuid.length > 10);
  });
});
