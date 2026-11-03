import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { csvReport, htmlReport, junitReport } from '../server/reports.js';

const run = {
  id: 9,
  name: 'Nightly <prod>',
  status: 'failed',
  trigger: 'ci',
  total: 3,
  passed: 1,
  failed: 1,
  errored: 1,
  skipped: 0,
  flaky: 0,
  durationMs: 1234,
  createdAt: '2026-01-01T00:00:00Z',
  startedAt: '2026-01-01T00:00:00Z',
};
const results = [
  { testName: 'ok', suiteName: 'Smoke', testType: 'http', status: 'passed', durationMs: 10, attempts: 1, logs: [], assertions: [] },
  {
    testName: 'bad "quote"',
    suiteName: 'Smoke',
    testType: 'http',
    status: 'failed',
    durationMs: 20,
    attempts: 1,
    errorMessage: 'Assertion failed: a < b',
    logs: [{ ts: '2026-01-01T00:00:00.000Z', level: 'fail', message: 'x' }],
    assertions: [{ passed: false, message: 'Assertion failed: a < b' }],
    analysis: { category: 'server_error', summary: 'Server, boom', rootCause: 'r', suggestedFixes: ['f'], confidence: 'high', source: 'heuristic' },
  },
  { testName: 'err', suiteName: null, testType: 'script', status: 'error', durationMs: 5, attempts: 1, errorMessage: 'TypeError', logs: [], assertions: [] },
];

describe('reports', () => {
  it('JUnit XML groups by suite and escapes content', () => {
    const xml = junitReport(run, results);
    assert.match(xml, /^<\?xml version="1.0"/);
    assert.match(xml, /<testsuites name="Nightly &lt;prod&gt;" tests="3" failures="1" errors="1"/);
    assert.match(xml, /<testsuite name="Smoke" tests="2" failures="1" errors="0"/);
    assert.match(xml, /<testsuite name="Ungrouped" tests="1" failures="0" errors="1"/);
    assert.match(xml, /name="bad &quot;quote&quot;"/);
    assert.match(xml, /<failure message="Assertion failed: a &lt; b"/);
  });

  it('CSV quotes fields that need it', () => {
    const csv = csvReport(run, results);
    const lines = csv.trim().split('\n');
    assert.equal(lines.length, 4);
    assert.match(lines[2], /"bad ""quote"""/);
    assert.match(lines[2], /"Server, boom"/);
  });

  it('HTML report is self-contained and escaped', () => {
    const html = htmlReport(run, results);
    assert.match(html, /<!doctype html>/);
    assert.match(html, /Nightly &lt;prod&gt;/);
    assert.ok(!html.includes('<prod>'));
    assert.match(html, /AI root-cause analysis/);
  });
});
