import { ArrowLeft, Ban, ChevronDown, ChevronRight, Download, FileCode2, FileJson, FileSpreadsheet, FileText, Loader2, RotateCcw, Sparkles } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { SourceBadge } from '../components/AnalysisCard.jsx';
import { FixModal } from '../components/FixModal.jsx';
import { usePageMeta } from '../components/Layout.jsx';
import { ResultDetail } from '../components/ResultDetail.jsx';
import { ErrorState, Loading, RunProgress, StatTile, StatusBadge, TypeChip } from '../components/ui.jsx';
import { isAI } from '../lib/ai.js';
import { api, reportUrl } from '../lib/api.js';
import { useEvents } from '../lib/events.jsx';
import { CATEGORY_LABELS, fmtDateTime, fmtDuration, fmtPct, passRateOf } from '../lib/format.js';
import { useFetch, useTick } from '../lib/hooks.js';
import { useToast } from '../lib/toast.jsx';

const FILTERS = [
  ['all', 'All'],
  ['failed', 'Failures'],
  ['passed', 'Passed'],
  ['running', 'In progress'],
];
const REPORTS = [
  ['html', 'HTML report', FileText],
  ['junit', 'JUnit XML', FileCode2],
  ['json', 'JSON', FileJson],
  ['csv', 'CSV', FileSpreadsheet],
];
const RISK_TONE = { low: 'badge-passed', medium: 'badge-flaky', high: 'badge-failed' };

export default function RunDetail() {
  const { id } = useParams();
  const runId = Number(id);
  const navigate = useNavigate();
  const toast = useToast();
  const { data: run, error, loading, reload, setData } = useFetch(`/runs/${runId}`);
  const { data: ai } = useFetch('/ai/status');
  const [open, setOpen] = useState(new Set());
  const [filter, setFilter] = useState('all');
  const [analyzing, setAnalyzing] = useState(new Set());
  const [summarizing, setSummarizing] = useState(false);
  const [reportMenu, setReportMenu] = useState(false);
  const [fixing, setFixing] = useState(null);
  const autoOpened = useRef(false);
  useTick(5000);

  usePageMeta(run ? `${run.name}` : `Run #${runId}`, run ? `Run #${run.id} · ${run.environmentName ?? 'default environment'} · ${fmtDateTime(run.createdAt)}` : '');

  // Apply live events directly to local state: no refetch needed per event.
  useEvents((e) => {
    if (e.type === 'run:updated' && e.data.id === runId) setData((prev) => (prev ? { ...prev, ...e.data, results: prev.results } : prev));
    else if (e.type === 'result:updated' && e.data.runId === runId) {
      setData((prev) => (prev ? { ...prev, results: prev.results.map((r) => (r.id === e.data.id ? { ...r, ...e.data } : r)) } : prev));
    } else if (e.type === 'log' && e.data.runId === runId) {
      setData((prev) =>
        prev
          ? {
              ...prev,
              results: prev.results.map((r) =>
                r.id === e.data.resultId && r.status === 'running' ? { ...r, logs: [...(r.logs ?? []), { ts: e.data.ts, level: e.data.level, message: e.data.message }] } : r,
              ),
            }
          : prev,
      );
    } else if (e.type === 'analysis:updated' && e.data.runId === runId) {
      setData((prev) => (prev ? { ...prev, results: prev.results.map((r) => (r.id === e.data.resultId ? { ...r, analysis: e.data.analysis } : r)) } : prev));
    } else if (e.type === 'run-analysis:updated' && e.data.runId === runId) {
      setData((prev) => (prev ? { ...prev, aiSummary: e.data.aiSummary } : prev));
    }
  });

  // Open the first failure once, so the "why" is one glance away.
  useEffect(() => {
    if (!run || autoOpened.current || run.status === 'running' || run.status === 'queued') return;
    const firstFail = run.results.find((r) => r.status === 'failed' || r.status === 'error');
    if (firstFail) setOpen(new Set([firstFail.id]));
    autoOpened.current = true;
  }, [run]);

  const results = useMemo(() => {
    if (!run) return [];
    const order = { running: 0, failed: 1, error: 1, queued: 2, passed: 3, skipped: 4 };
    const list = run.results.filter((r) =>
      filter === 'all' ? true : filter === 'failed' ? r.status === 'failed' || r.status === 'error' : filter === 'running' ? r.status === 'running' || r.status === 'queued' : r.status === filter,
    );
    return [...list].sort((a, b) => (order[a.status] ?? 5) - (order[b.status] ?? 5) || a.id - b.id);
  }, [run, filter]);

  const toggle = (rid) =>
    setOpen((prev) => {
      const next = new Set(prev);
      next.has(rid) ? next.delete(rid) : next.add(rid);
      return next;
    });

  const analyze = async (resultId) => {
    setAnalyzing((s) => new Set(s).add(resultId));
    try {
      const updated = await api.post(`/results/${resultId}/analyze`, { useAI: true });
      setData((prev) => ({ ...prev, results: prev.results.map((r) => (r.id === resultId ? { ...r, analysis: updated.analysis } : r)) }));
      if (updated.analysis?.aiError) toast.error(`${ai?.providerLabel ?? 'AI'} unavailable, showing heuristic result`, updated.analysis.aiError);
    } catch (err) {
      toast.error('Analysis failed', err.message);
    } finally {
      setAnalyzing((s) => {
        const next = new Set(s);
        next.delete(resultId);
        return next;
      });
    }
  };

  const summarize = async () => {
    setSummarizing(true);
    try {
      const updated = await api.post(`/runs/${runId}/analyze`, { useAI: true });
      setData((prev) => ({ ...prev, aiSummary: updated.aiSummary }));
      reload(true);
    } catch (err) {
      toast.error('Summary failed', err.message);
    } finally {
      setSummarizing(false);
    }
  };

  const cancel = async () => {
    try {
      await api.post(`/runs/${runId}/cancel`);
      toast.info('Cancelling…');
    } catch (err) {
      toast.error('Could not cancel', err.message);
    }
  };

  const rerun = async (onlyFailed) => {
    try {
      const next = await api.post(`/runs/${runId}/rerun`, { onlyFailed });
      navigate(`/runs/${next.id}`);
    } catch (err) {
      toast.error('Could not re-run', err.message);
    }
  };

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading || !run) return <Loading rows={8} />;

  const active = run.status === 'running' || run.status === 'queued';
  const done = run.passed + run.failed + run.errored + run.skipped;
  const failures = run.failed + run.errored;
  const summary = run.aiSummary;
  const elapsed = run.durationMs ?? (run.startedAt ? Date.now() - new Date(run.startedAt).getTime() : null);

  return (
    <div className="stack">
      <div className="row">
        <Link to="/runs" className="btn btn-ghost btn-sm">
          <ArrowLeft size={14} /> Run history
        </Link>
        <span className="spacer" />
        {active ? (
          <button className="btn btn-sm btn-danger" onClick={cancel}>
            <Ban size={13} /> Cancel run
          </button>
        ) : (
          <>
            {failures > 0 && (
              <button className="btn btn-sm" onClick={() => rerun(true)}>
                <RotateCcw size={13} /> Re-run failed
              </button>
            )}
            <button className="btn btn-sm" onClick={() => rerun(false)}>
              <RotateCcw size={13} /> Re-run all
            </button>
          </>
        )}
        <div style={{ position: 'relative' }}>
          <button className="btn btn-sm btn-dark" onClick={() => setReportMenu((m) => !m)} aria-expanded={reportMenu} disabled={active}>
            <Download size={13} /> Report <ChevronDown size={13} />
          </button>
          {reportMenu && (
            <div className="card" style={{ position: 'absolute', right: 0, top: 'calc(100% + 6px)', zIndex: 30, padding: 6, minWidth: 180, background: 'var(--surface-solid)' }} onMouseLeave={() => setReportMenu(false)}>
              {REPORTS.map(([fmt, label, Icon]) => (
                <a key={fmt} className="nav-link" href={reportUrl(run.id, fmt)} onClick={() => setReportMenu(false)} download>
                  <Icon size={15} /> {label}
                </a>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="row" style={{ marginBottom: 14 }}>
          <StatusBadge status={run.status} />
          <span className="ink-2 small">
            {done}/{run.total} complete · trigger: {run.trigger}
          </span>
          <span className="spacer" />
          <span className="small muted num">{fmtDuration(elapsed)}</span>
        </div>
        <RunProgress run={run} large />
      </div>

      <div className="grid grid-4">
        <StatTile label="Pass rate" value={fmtPct(passRateOf(run))} foot={`${run.passed} of ${run.passed + failures} executed`} />
        <StatTile label="Failed" value={run.failed} foot="assertion failures" tone="critical" />
        <StatTile label="Errors" value={run.errored} foot="exceptions, timeouts, network" tone="serious" />
        <StatTile label="Flaky" value={run.flaky} foot={`passed on retry · ${run.skipped} skipped`} tone="warning" />
      </div>

      {!active && failures > 0 && (
        <div className="ai-card">
          <div className="ai-head">
            <span className="ai-icon">
              <Sparkles size={15} />
            </span>
            <h4 style={{ margin: 0 }}>AI run summary</h4>
            {summary && <SourceBadge analysis={summary} />}
            {summary?.riskLevel && <span className={`badge ${RISK_TONE[summary.riskLevel]}`}>Release risk: {summary.riskLevel}</span>}
            <span className="spacer" />
            <button className="btn btn-sm btn-primary" onClick={summarize} disabled={summarizing}>
              {summarizing ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />}
              {summary ? (ai?.enabled && !isAI(summary.source) ? `Summarize with ${ai.providerLabel}` : 'Regenerate') : 'Summarize run'}
            </button>
          </div>
          {summary ? (
            <>
              <h4>{summary.headline}</h4>
              <p>{summary.overview}</p>
              {summary.themes?.length > 0 && (
                <div className="grid grid-2" style={{ marginTop: 10, gap: 10 }}>
                  {summary.themes.map((t, i) => (
                    <div key={i} className="card" style={{ padding: 14, boxShadow: 'none' }}>
                      <div className="row" style={{ marginBottom: 4 }}>
                        <strong>{t.title}</strong>
                        <span className="badge badge-neutral">{t.testNames.length}</span>
                      </div>
                      <div className="small ink-2">{t.explanation}</div>
                      <div className="small muted" style={{ marginTop: 6 }}>
                        {t.testNames.join(' · ')}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {summary.recommendations?.length > 0 && (
                <>
                  <div className="ai-section-title">Recommended next steps</div>
                  <ol>
                    {summary.recommendations.map((r, i) => (
                      <li key={i}>{r}</li>
                    ))}
                  </ol>
                </>
              )}
              {summary.aiError && <div className="notice notice-warn small mt-16">{ai?.providerLabel ?? 'AI'} unavailable: {summary.aiError}</div>}
            </>
          ) : (
            <p>Analysis is being prepared… or click “Summarize run”.</p>
          )}
        </div>
      )}

      <div className="card">
        <div className="card-head">
          <h3>Results</h3>
          <span className="spacer" />
          <div className="segmented">
            {FILTERS.map(([k, label]) => (
              <button key={k} className={filter === k ? 'active' : ''} onClick={() => setFilter(k)}>
                {label}
              </button>
            ))}
          </div>
        </div>
        {results.length === 0 && <p className="muted small">No results match this filter.</p>}
        {results.map((r) => {
          const isOpen = open.has(r.id);
          return (
            <div key={r.id} className={`result-item ${isOpen ? 'open' : ''}`}>
              <button className="result-head" onClick={() => toggle(r.id)} aria-expanded={isOpen}>
                <StatusBadge status={r.status} />
                <span style={{ minWidth: 0 }}>
                  <span className="cell-title truncate" style={{ display: 'block' }}>
                    {r.testName}
                    {r.iteration && (
                      <span className="chip chip-script" style={{ marginLeft: 8, verticalAlign: 1 }} title={Object.entries(r.iteration.data).map(([k, v]) => `${k}=${v}`).join('\n')}>
                        row {r.iteration.index}/{r.iteration.total}
                      </span>
                    )}
                  </span>
                  <span className="cell-sub truncate" style={{ display: 'block' }}>
                    {r.analysis ? `${CATEGORY_LABELS[r.analysis.category] ?? r.analysis.category}: ${r.analysis.summary}` : (r.errorMessage ?? r.suiteName ?? '')}
                  </span>
                </span>
                <span className="row hide-sm" style={{ gap: 6, flexWrap: 'nowrap' }}>
                  {r.flaky && <span className="badge badge-flaky">flaky</span>}
                  {r.attempts > 1 && <span className="chip">{r.attempts} attempts</span>}
                  <TypeChip type={r.testType} />
                </span>
                <span className="small num muted">{r.status === 'queued' ? '—' : fmtDuration(r.durationMs)}</span>
                {isOpen ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              </button>
              {isOpen && (
                <div className="result-body">
                  {r.status === 'queued' ? (
                    <p className="muted small">Waiting for a free worker…</p>
                  ) : (
                    <ResultDetail
                      key={`${r.id}-${r.status === 'running' ? 'live' : 'done'}`}
                      result={r}
                      onAnalyze={() => analyze(r.id)}
                      analyzing={analyzing.has(r.id)}
                      aiEnabled={ai?.enabled}
                      aiLabel={ai?.providerLabel}
                      onFix={r.testCaseId ? () => setFixing(r.id) : undefined}
                    />
                  )}
                  {r.testCaseId && (
                    <div className="row" style={{ marginTop: 12 }}>
                      <Link to={`/tests/${r.testCaseId}`} className="btn btn-sm btn-ghost">
                        Open test definition →
                      </Link>
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
      {fixing && <FixModal resultId={fixing} onClose={() => setFixing(null)} />}
    </div>
  );
}
