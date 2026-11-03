import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { analyzeHeuristically, flakinessFromHistory, summarizeRunHeuristically } from '../server/ai/heuristics.js';

const base = { status: 'failed', assertions: [], logs: [], request: { method: 'GET', url: 'http://api.test/users/1' } };

describe('heuristic root-cause analysis', () => {
  it('classifies connection failures as network issues owned by the environment', () => {
    const a = analyzeHeuristically({ result: { ...base, status: 'error', errorMessage: 'Network error: ECONNREFUSED 127.0.0.1:59999' } });
    assert.equal(a.category, 'network_connectivity');
    assert.equal(a.owner, 'environment');
    assert.equal(a.confidence, 'high');
    assert.equal(a.source, 'heuristic');
  });

  it('classifies timeouts', () => {
    const a = analyzeHeuristically({ result: { ...base, status: 'error', errorMessage: 'Request timed out after 3000 ms' } });
    assert.equal(a.category, 'timeout_performance');
  });

  it('classifies 5xx and quotes the server message as evidence', () => {
    const a = analyzeHeuristically({
      result: {
        ...base,
        errorMessage: 'Assertion failed: Status code equals 200 (actual: 500)',
        response: { status: 500, body: '{"error":"Database connection pool exhausted"}' },
        assertions: [{ type: 'status', passed: false, actual: '500', expected: '200', message: 'Assertion failed' }],
      },
    });
    assert.equal(a.category, 'server_error');
    assert.equal(a.owner, 'application');
    assert.ok(a.evidence.some((e) => e.includes('Database connection pool exhausted')));
  });

  it('detects contract changes when an expected JSON field disappears', () => {
    const a = analyzeHeuristically({
      result: {
        ...base,
        response: { status: 200, body: '{"id":1,"fullName":"Ada"}' },
        assertions: [{ type: 'jsonPath', target: 'name', operator: 'exists', passed: false, actual: 'undefined', message: 'x' }],
      },
    });
    assert.equal(a.category, 'contract_change');
    assert.match(a.rootCause, /fullName/);
  });

  it('blames the test for script errors', () => {
    const a = analyzeHeuristically({ result: { ...base, status: 'error', errorMessage: "TypeError: Cannot read properties of undefined (reading 'id')" } });
    assert.equal(a.category, 'test_code_error');
    assert.equal(a.owner, 'test');
  });

  it('flags flaky history', () => {
    const history = ['failed', 'passed', 'failed', 'passed', 'passed'].map((status) => ({ status }));
    assert.equal(flakinessFromHistory(history).flaky, true);
    assert.equal(flakinessFromHistory(history.map(() => ({ status: 'failed' }))).flaky, false);

    const a = analyzeHeuristically({
      result: { ...base, assertions: [{ type: 'jsonPath', target: 'n', operator: 'equals', expected: '1', passed: false, actual: '2', message: 'x' }] },
      history,
    });
    assert.equal(a.category, 'flaky');
    assert.equal(a.isLikelyFlaky, true);
  });
});

describe('run summary', () => {
  it('groups failures into themes', () => {
    const results = [
      { status: 'passed', testName: 'ok' },
      { status: 'failed', testName: 'a', analysis: { category: 'server_error', owner: 'application', rootCause: 'boom', suggestedFixes: ['fix a'] } },
      { status: 'error', testName: 'b', analysis: { category: 'server_error', owner: 'application', rootCause: 'boom', suggestedFixes: ['fix a'] } },
      { status: 'error', testName: 'c', analysis: { category: 'network_connectivity', owner: 'environment', rootCause: 'down', suggestedFixes: ['fix c'] } },
    ];
    const s = summarizeRunHeuristically({ run: { passed: 1 }, results });
    assert.equal(s.themes.length, 2);
    assert.deepEqual(s.themes[0].testNames, ['a', 'b']);
    assert.deepEqual(s.recommendations, ['fix a', 'fix c']);
    assert.equal(s.riskLevel, 'high');
  });
});
