import { CATEGORIES } from './ai/categories.js';
import { flakinessFromHistory } from './ai/heuristics.js';

const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);
const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);

/**
 * Aggregate metrics over the most recent `limit` finished runs.
 * Computed in JS from SQLite rows — fine for the data volumes a single
 * instance of the platform accumulates.
 */
export function buildAnalytics(store, { limit = 20, activeRunIds = [] } = {}) {
  const { runs: finishedDesc, total: finishedTotal } = store.listRuns({ limit, finishedOnly: true });
  const runs = [...finishedDesc].reverse();
  const runIds = runs.map((r) => r.id);
  const results = store.listFinishedResults({ runIds }).filter((r) => r.status !== 'skipped');
  const tests = store.listTests();

  const trend = runs.map((r) => {
    const executed = r.passed + r.failed + r.errored;
    return {
      runId: r.id,
      label: `#${r.id}`,
      name: r.name,
      status: r.status,
      passRate: pct(r.passed, executed),
      passed: r.passed,
      failed: r.failed,
      errored: r.errored,
      skipped: r.skipped,
      flaky: r.flaky,
      durationMs: r.durationMs ?? 0,
      createdAt: r.createdAt,
    };
  });

  // Per-test stability over the window (results are newest-first).
  const byTest = new Map();
  for (const r of results) {
    // Each dataset row is tracked as its own test, so one bad row doesn't look like flakiness.
    const row = r.iteration?.index;
    const key = `${r.testCaseId ?? `name:${r.testName}`}${row ? `#${row}` : ''}`;
    const testName = row ? `${r.testName} [row ${row}]` : r.testName;
    if (!byTest.has(key)) byTest.set(key, { testCaseId: r.testCaseId, testName, suiteName: r.suiteName, type: r.testType, items: [] });
    byTest.get(key).items.push(r);
  }
  const stability = [...byTest.values()]
    .map((t) => {
      const passed = t.items.filter((i) => i.status === 'passed').length;
      const failures = t.items.length - passed;
      const flake = flakinessFromHistory(t.items);
      const retriedPasses = t.items.filter((i) => i.flaky).length;
      const flakyScore = t.items.length > 1 ? Math.round(((flake.flips + retriedPasses) / (t.items.length - 1)) * 100) / 100 : 0;
      const lastFailure = t.items.find((i) => i.status !== 'passed');
      return {
        testCaseId: t.testCaseId,
        testName: t.testName,
        suiteName: t.suiteName,
        type: t.type,
        runs: t.items.length,
        passed,
        failures,
        passRate: pct(passed, t.items.length),
        flips: flake.flips,
        retriedPasses,
        flakyScore: Math.min(1, flakyScore),
        isFlaky: flake.flaky || retriedPasses > 0,
        avgDurationMs: avg(t.items.map((i) => i.durationMs ?? 0)),
        p95DurationMs: (() => {
          const sorted = t.items.map((i) => i.durationMs ?? 0).sort((a, b) => a - b);
          return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? 0;
        })(),
        lastStatus: t.items[0]?.status,
        lastError: lastFailure?.errorMessage ?? null,
        lastFailureCategory: lastFailure?.analysis?.category ?? null,
        recent: t.items.slice(0, 12).map((i) => i.status),
      };
    })
    .sort((a, b) => a.passRate - b.passRate || b.flakyScore - a.flakyScore);

  const topFailing = stability
    .filter((s) => s.failures > 0)
    .sort((a, b) => b.failures - a.failures || a.passRate - b.passRate)
    .slice(0, 8);
  const slowest = [...stability].sort((a, b) => b.avgDurationMs - a.avgDurationMs).slice(0, 8);
  const flakyTests = stability.filter((s) => s.isFlaky).sort((a, b) => b.flakyScore - a.flakyScore);

  const suites = new Map();
  for (const r of results) {
    const key = r.suiteName ?? 'Ungrouped';
    if (!suites.has(key)) suites.set(key, { suite: key, passed: 0, total: 0 });
    const s = suites.get(key);
    s.total++;
    if (r.status === 'passed') s.passed++;
  }
  const bySuite = [...suites.values()].map((s) => ({ ...s, failed: s.total - s.passed, passRate: pct(s.passed, s.total) })).sort((a, b) => a.passRate - b.passRate);

  const categoryCounts = new Map();
  for (const r of results) {
    if (r.status !== 'failed' && r.status !== 'error') continue;
    const key = r.analysis?.category ?? 'unanalyzed';
    categoryCounts.set(key, (categoryCounts.get(key) ?? 0) + 1);
  }
  const failureCategories = [...categoryCounts.entries()]
    .map(([category, count]) => ({ category, label: CATEGORIES[category] ?? 'Not analyzed yet', count }))
    .sort((a, b) => b.count - a.count);

  const executed = results.length;
  const passedCount = results.filter((r) => r.status === 'passed').length;
  const latest = trend.at(-1);
  const previous = trend.at(-2);

  const { runs: recentRuns } = store.listRuns({ limit: 8 });

  return {
    window: { runs: runs.length, limit },
    kpis: {
      totalTests: tests.length,
      enabledTests: tests.filter((t) => t.enabled).length,
      httpTests: tests.filter((t) => t.type === 'http').length,
      scriptTests: tests.filter((t) => t.type === 'script').length,
      totalRuns: finishedTotal,
      passRate: pct(passedCount, executed),
      latestPassRate: latest?.passRate ?? null,
      passRateDelta: latest && previous ? Math.round((latest.passRate - previous.passRate) * 10) / 10 : null,
      avgRunDurationMs: avg(runs.map((r) => r.durationMs ?? 0)),
      avgTestDurationMs: avg(results.map((r) => r.durationMs ?? 0)),
      flakyTests: flakyTests.length,
      failingTests: stability.filter((s) => s.lastStatus === 'failed' || s.lastStatus === 'error').length,
      activeRuns: activeRunIds.length,
      executedTests: executed,
    },
    trend,
    stability,
    topFailing,
    slowest,
    flakyTests,
    bySuite,
    failureCategories,
    recentRuns,
  };
}
