import { BarChart3, Clock, Gauge, Shuffle, Table2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { DurationChart, HBarList, PassRateChart, ResultsStackChart } from '../components/charts.jsx';
import { usePageMeta } from '../components/Layout.jsx';
import { Empty, ErrorState, Loading, Spark, StatTile, StatusBadge, TypeChip } from '../components/ui.jsx';
import { useLiveReload } from '../lib/events.jsx';
import { CATEGORY_LABELS, fmtDuration, fmtPct } from '../lib/format.js';
import { useFetch, useLocalState } from '../lib/hooks.js';

const WINDOWS = [10, 25, 50, 100];

export default function Analytics() {
  usePageMeta('Analytics', 'Trends, stability and performance across runs');
  const [limit, setLimit] = useLocalState('tf-analytics-window', 25);
  const [sort, setSort] = useState('passRate');
  const { data, error, loading, reload } = useFetch(`/analytics?limit=${limit}`);
  useLiveReload(reload, ['run:finished', 'analysis:updated'], 800);

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading && !data) return <Loading rows={8} />;
  const { kpis, trend, slowest, bySuite, failureCategories, stability, flakyTests } = data;

  const sorted = [...stability].sort((a, b) =>
    sort === 'passRate' ? a.passRate - b.passRate : sort === 'flaky' ? b.flakyScore - a.flakyScore : sort === 'duration' ? b.avgDurationMs - a.avgDurationMs : a.testName.localeCompare(b.testName),
  );

  return (
    <div className="stack">
      <div className="row">
        <span className="muted">Window:</span>
        <div className="segmented">
          {WINDOWS.map((w) => (
            <button key={w} className={limit === w ? 'active' : ''} onClick={() => setLimit(w)}>
              Last {w} runs
            </button>
          ))}
        </div>
      </div>

      {trend.length === 0 ? (
        <div className="card">
          <Empty icon={BarChart3} title="No finished runs yet">
            Analytics appear after your first completed run.
          </Empty>
        </div>
      ) : (
        <>
          <div className="grid grid-4">
            <StatTile icon={Gauge} label="Pass rate" value={fmtPct(kpis.passRate)} foot={`${kpis.executedTests} test executions`} tone="good" />
            <StatTile icon={BarChart3} label="Runs analysed" value={data.window.runs} foot={`${kpis.totalRuns} finished in total`} />
            <StatTile icon={Clock} label="Avg test duration" value={fmtDuration(kpis.avgTestDurationMs)} foot={`avg run ${fmtDuration(kpis.avgRunDurationMs)}`} />
            <StatTile icon={Shuffle} label="Flaky tests" value={kpis.flakyTests} foot={`${kpis.failingTests} failing on latest run`} tone="warning" />
          </div>

          <div className="grid grid-2">
            <div className="card">
              <div className="card-head">
                <h3>Pass rate trend</h3>
              </div>
              <PassRateChart data={trend} />
            </div>
            <div className="card">
              <div className="card-head">
                <h3>Outcomes per run</h3>
              </div>
              <ResultsStackChart data={trend} height={232} />
            </div>
          </div>

          <div className="grid grid-3">
            <div className="card">
              <div className="card-head">
                <h3>Run duration</h3>
              </div>
              <DurationChart data={trend} height={220} />
            </div>
            <div className="card">
              <div className="card-head">
                <h3>Slowest tests</h3>
                <span className="sub">avg duration</span>
              </div>
              <HBarList items={slowest} value={(s) => s.avgDurationMs} label={(s) => s.testName} format={fmtDuration} color="var(--violet)" />
            </div>
            <div className="card">
              <div className="card-head">
                <h3>Pass rate by suite</h3>
              </div>
              <HBarList items={bySuite} value={(s) => s.passRate} label={(s) => s.suite} format={(v) => `${v}%`} max={100} color="var(--good)" />
            </div>
          </div>

          <div className="grid grid-2">
            <div className="card">
              <div className="card-head">
                <h3>Failure root causes</h3>
                <span className="sub">from AI analysis</span>
                <span className="spacer" />
                <Link to="/insights" className="btn btn-sm btn-ghost">
                  View insights →
                </Link>
              </div>
              {failureCategories.length === 0 ? (
                <p className="muted small">No failures in this window.</p>
              ) : (
                <HBarList items={failureCategories} value={(c) => c.count} label={(c) => c.label} />
              )}
            </div>
            <div className="card">
              <div className="card-head">
                <Shuffle size={17} style={{ color: 'var(--warning-ink)' }} />
                <h3>Flaky tests</h3>
              </div>
              {flakyTests.length === 0 ? (
                <p className="muted small">No flaky behaviour detected in this window.</p>
              ) : (
                <div className="list">
                  {flakyTests.slice(0, 6).map((t) => (
                    <div key={t.testName} className="list-item">
                      <span className="grow">
                        <div className="cell-title truncate">{t.testName}</div>
                        <div className="cell-sub">
                          {t.flips} flips · {t.retriedPasses} retry-passes · {fmtPct(t.passRate)} pass
                        </div>
                      </span>
                      <Spark statuses={t.recent} />
                      <span className="badge badge-flaky num">{t.flakyScore}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div className="card card-flush">
            <div className="card-head">
              <Table2 size={17} />
              <h3>Test stability</h3>
              <span className="spacer" />
              <select className="select select-sm" style={{ width: 'auto' }} value={sort} onChange={(e) => setSort(e.target.value)} aria-label="Sort">
                <option value="passRate">Least stable first</option>
                <option value="flaky">Flakiest first</option>
                <option value="duration">Slowest first</option>
                <option value="name">Name</option>
              </select>
            </div>
            <div className="table-wrap" style={{ marginTop: 14 }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Test</th>
                    <th className="hide-sm">Type</th>
                    <th>Recent</th>
                    <th className="num">Pass rate</th>
                    <th className="num hide-sm">Flaky score</th>
                    <th className="num hide-sm">Avg / p95</th>
                    <th className="hide-sm">Last failure cause</th>
                    <th>Last</th>
                  </tr>
                </thead>
                <tbody>
                  {sorted.map((t) => (
                    <tr key={t.testName}>
                      <td>
                        {t.testCaseId ? (
                          <Link to={`/tests/${t.testCaseId}`} className="cell-title">
                            {t.testName}
                          </Link>
                        ) : (
                          <span className="cell-title">{t.testName}</span>
                        )}
                        <div className="cell-sub">
                          {t.suiteName ?? 'Ungrouped'} · {t.runs} runs
                        </div>
                      </td>
                      <td className="hide-sm">
                        <TypeChip type={t.type} />
                      </td>
                      <td>
                        <Spark statuses={t.recent} />
                      </td>
                      <td className="num">{fmtPct(t.passRate)}</td>
                      <td className="num hide-sm">{t.flakyScore}</td>
                      <td className="num hide-sm">
                        {fmtDuration(t.avgDurationMs)} / {fmtDuration(t.p95DurationMs)}
                      </td>
                      <td className="hide-sm small ink-2">{t.lastFailureCategory ? CATEGORY_LABELS[t.lastFailureCategory] : '—'}</td>
                      <td>
                        <StatusBadge status={t.lastStatus} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
