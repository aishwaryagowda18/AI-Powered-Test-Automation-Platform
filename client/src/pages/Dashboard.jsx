import { Activity, ArrowRight, CheckCircle2, Clock, FlaskConical, Play, Plus, Shuffle, Sparkles, TrendingDown, TrendingUp, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { PassRateChart, ResultsStackChart } from '../components/charts.jsx';
import { usePageMeta, useRunLauncher } from '../components/Layout.jsx';
import { Empty, ErrorState, Loading, RunProgress, Spark, StatTile, StatusBadge } from '../components/ui.jsx';
import { useLiveReload } from '../lib/events.jsx';
import { CATEGORY_LABELS, fmtDuration, fmtPct, timeAgo } from '../lib/format.js';
import { useFetch, useTick } from '../lib/hooks.js';

export default function Dashboard() {
  usePageMeta('Dashboard', 'Quality at a glance across your latest runs');
  const launch = useRunLauncher();
  const { data, error, loading, reload } = useFetch('/analytics?limit=20');
  useLiveReload(reload, ['run:created', 'run:updated', 'run:finished', 'analysis:updated'], 800);
  useTick();

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading || !data) return <Loading rows={8} />;

  const { kpis, trend, topFailing, recentRuns, failureCategories, flakyTests } = data;
  const delta = kpis.passRateDelta;
  const active = recentRuns.filter((r) => r.status === 'running' || r.status === 'queued');

  return (
    <>
      <section className="hero">
        <div className="hero-text">
          <span className="eyebrow">
            <Sparkles size={13} /> AI-powered test automation
          </span>
          <HeroHeadline />
          <p>
            {kpis.totalRuns
              ? `${kpis.totalTests} test cases, ${kpis.totalRuns} runs recorded. Failures get an automatic root-cause diagnosis and suggested fixes.`
              : 'Create API or script tests, run them with live progress, and get root-cause analysis for every failure.'}
          </p>
          <div className="btn-group">
            <button className="btn btn-primary" onClick={() => launch()}>
              <Play size={15} /> Run tests
            </button>
            <Link className="btn btn-dark" to="/tests/new">
              <Plus size={15} /> New test case
            </Link>
          </div>
        </div>
        <div className="hero-figure">
          <div className="hero-stat">
            <div className="v num">{kpis.latestPassRate == null ? '—' : fmtPct(kpis.latestPassRate)}</div>
            <div className="l">Latest pass rate</div>
          </div>
          <div className="hero-stat">
            <div className="v num">{kpis.failingTests}</div>
            <div className="l">Currently failing</div>
          </div>
        </div>
      </section>

      {active.length > 0 && (
        <div className="card" style={{ marginBottom: 16 }}>
          <div className="card-head" style={{ marginBottom: 10 }}>
            <Activity size={18} style={{ color: 'var(--primary)' }} />
            <h3>Running now</h3>
            <span className="spacer" />
            <Link to="/live" className="btn btn-sm">
              Open live monitor <ArrowRight size={13} />
            </Link>
          </div>
          {active.map((r) => (
            <Link key={r.id} to={`/runs/${r.id}`} className="list-item">
              <StatusBadge status={r.status} />
              <span className="grow">
                <span className="cell-title">{r.name}</span>
                <div style={{ marginTop: 6 }}>
                  <RunProgress run={r} />
                </div>
              </span>
              <span className="small muted num">
                {r.passed + r.failed + r.errored + r.skipped}/{r.total}
              </span>
            </Link>
          ))}
        </div>
      )}

      <div className="grid grid-4">
        <StatTile
          icon={CheckCircle2}
          tone="good"
          label="Pass rate"
          value={fmtPct(kpis.passRate)}
          foot={
            delta == null ? (
              `across last ${data.window.runs} runs`
            ) : (
              <>
                {delta >= 0 ? <TrendingUp size={13} className="delta-up" /> : <TrendingDown size={13} className="delta-down" />}
                <span className={delta >= 0 ? 'delta-up' : 'delta-down'}>
                  {delta >= 0 ? '+' : ''}
                  {delta} pts
                </span>
                vs previous run
              </>
            )
          }
        />
        <StatTile icon={FlaskConical} label="Test cases" value={kpis.totalTests} foot={`${kpis.httpTests} HTTP · ${kpis.scriptTests} script · ${kpis.enabledTests} enabled`} />
        <StatTile icon={Clock} label="Avg run duration" value={fmtDuration(kpis.avgRunDurationMs)} foot={`avg test ${fmtDuration(kpis.avgTestDurationMs)}`} />
        <StatTile icon={Shuffle} tone="warning" label="Flaky tests" value={kpis.flakyTests} foot="pass/fail flips or retry-passes" />
      </div>

      {trend.length === 0 ? (
        <div className="card mt-16">
          <Empty
            icon={Play}
            title="No runs yet"
            action={
              <button className="btn btn-primary" onClick={() => launch()}>
                <Play size={15} /> Run your first tests
              </button>
            }
          >
            Execute a suite to populate trends, analytics and AI insights.
          </Empty>
        </div>
      ) : (
        <div className="grid grid-2 mt-16">
          <div className="card">
            <div className="card-head">
              <h3>Pass rate per run</h3>
              <span className="sub">last {trend.length} runs</span>
            </div>
            <PassRateChart data={trend} />
          </div>
          <div className="card">
            <div className="card-head">
              <h3>Results per run</h3>
              <span className="sub">tests by outcome</span>
            </div>
            <ResultsStackChart data={trend} height={232} />
          </div>
        </div>
      )}

      <div className="grid grid-main-side mt-16">
        <div className="card card-flush">
          <div className="card-head">
            <h3>Recent runs</h3>
            <span className="spacer" />
            <Link to="/runs" className="btn btn-sm btn-ghost">
              View all <ArrowRight size={13} />
            </Link>
          </div>
          {recentRuns.length === 0 ? (
            <Empty title="Nothing here yet">Runs you start will appear here.</Empty>
          ) : (
            <div className="table-wrap">
              <table className="table">
                <thead>
                  <tr>
                    <th>Status</th>
                    <th>Run</th>
                    <th className="hide-sm">Progress</th>
                    <th className="num">Pass rate</th>
                    <th className="num hide-sm">Duration</th>
                  </tr>
                </thead>
                <tbody>
                  {recentRuns.map((r) => {
                    const exec = r.passed + r.failed + r.errored;
                    return (
                      <tr key={r.id}>
                        <td>
                          <StatusBadge status={r.status} />
                        </td>
                        <td>
                          <Link to={`/runs/${r.id}`} className="cell-title">
                            {r.name}
                          </Link>
                          <div className="cell-sub">
                            #{r.id} · {timeAgo(r.createdAt)} · {r.environmentName ?? 'default env'}
                          </div>
                        </td>
                        <td className="hide-sm" style={{ minWidth: 140 }}>
                          <RunProgress run={r} />
                        </td>
                        <td className="num">{exec ? fmtPct((r.passed / exec) * 100) : '—'}</td>
                        <td className="num hide-sm">{fmtDuration(r.durationMs)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <div className="stack">
          <div className="card">
            <div className="card-head">
              <XCircle size={17} style={{ color: 'var(--critical-ink)' }} />
              <h3>Top failing tests</h3>
            </div>
            {topFailing.length === 0 ? (
              <p className="muted small">No failures in the current window. 🎉</p>
            ) : (
              <div className="list">
                {topFailing.slice(0, 5).map((t) => (
                  <Link key={t.testName} to={t.testCaseId ? `/tests/${t.testCaseId}` : '/tests'} className="list-item">
                    <span className="grow">
                      <div className="cell-title truncate">{t.testName}</div>
                      <div className="cell-sub truncate">
                        {t.lastFailureCategory ? CATEGORY_LABELS[t.lastFailureCategory] : t.lastError ?? '—'}
                      </div>
                    </span>
                    <span style={{ textAlign: 'right' }}>
                      <Spark statuses={t.recent.slice(0, 8)} />
                      <div className="small muted num">
                        {t.failures}/{t.runs} failed
                      </div>
                    </span>
                  </Link>
                ))}
              </div>
            )}
          </div>

          <div className="card">
            <div className="card-head">
              <Sparkles size={17} style={{ color: 'var(--primary)' }} />
              <h3>Failure root causes</h3>
              <span className="spacer" />
              <Link to="/insights" className="btn btn-sm btn-ghost">
                Insights <ArrowRight size={13} />
              </Link>
            </div>
            {failureCategories.length === 0 ? (
              <p className="muted small">No analyzed failures yet.</p>
            ) : (
              <div className="list">
                {failureCategories.slice(0, 5).map((c) => (
                  <div key={c.category} className="list-item">
                    <span className="grow ink-2" style={{ fontWeight: 600 }}>
                      {c.label}
                    </span>
                    <span className="badge badge-neutral num">{c.count}</span>
                  </div>
                ))}
              </div>
            )}
            {flakyTests.length > 0 && (
              <div className="notice notice-warn small mt-16">
                <Shuffle size={16} />
                <span>
                  <strong>{flakyTests[0].testName}</strong> is the flakiest test (score {flakyTests[0].flakyScore}).
                </span>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}

const HEADLINES = [
  ['Stop guessing why tests fail.', 'Let AI tell you.'],
  ['From red build to root cause', 'in seconds.'],
  ['Tests that write themselves.', 'Failures that explain themselves.'],
  ['Catch every regression.', 'Fix it in one click.'],
];

/** Hero headline that cycles through the product's promises (static when reduced motion is preferred). */
function HeroHeadline() {
  const [index, setIndex] = useState(0);
  useEffect(() => {
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return undefined;
    const id = setInterval(() => setIndex((i) => (i + 1) % HEADLINES.length), 5000);
    return () => clearInterval(id);
  }, []);
  // All headlines share one grid cell, so the heading is as tall as the longest
  // one at the current width: no empty gap and no layout jump while rotating.
  return (
    <h2 className="hero-headline">
      {HEADLINES.map(([lead, accent], i) => (
        <span key={i === index ? `active-${index}` : i} className={`hero-headline-text${i === index ? ' active' : ''}`} aria-hidden={i !== index}>
          {lead} <span className="grad">{accent}</span>
        </span>
      ))}
    </h2>
  );
}
