import { Bot, KeyRound, Loader2, Sparkles, Wand2 } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AnalysisCard } from '../components/AnalysisCard.jsx';
import { FixModal } from '../components/FixModal.jsx';
import { HBarList } from '../components/charts.jsx';
import { usePageMeta } from '../components/Layout.jsx';
import { Empty, ErrorState, Loading, StatusBadge } from '../components/ui.jsx';
import { isAI } from '../lib/ai.js';
import { api } from '../lib/api.js';
import { useLiveReload } from '../lib/events.jsx';
import { CATEGORY_LABELS, timeAgo } from '../lib/format.js';
import { useFetch } from '../lib/hooks.js';
import { useToast } from '../lib/toast.jsx';

export default function Insights() {
  usePageMeta('AI insights', 'Root-cause analysis and suggested fixes for every failure');
  const toast = useToast();
  const { data, error, loading, reload, setData } = useFetch('/insights?limit=150');
  useLiveReload(reload, ['analysis:updated', 'run:finished'], 800);
  const [category, setCategory] = useState('');
  const [busy, setBusy] = useState(new Set());
  const [bulk, setBulk] = useState(false);
  const [fixing, setFixing] = useState(null);

  const analyze = async (resultId) => {
    setBusy((s) => new Set(s).add(resultId));
    try {
      const updated = await api.post(`/results/${resultId}/analyze`, { useAI: true });
      setData((prev) => ({ ...prev, failures: prev.failures.map((f) => (f.id === resultId ? { ...f, analysis: updated.analysis } : f)) }));
    } catch (err) {
      toast.error('Analysis failed', err.message);
    } finally {
      setBusy((s) => {
        const next = new Set(s);
        next.delete(resultId);
        return next;
      });
    }
  };

  const analyzePending = async (upgrade) => {
    setBulk(true);
    try {
      const res = await api.post('/insights/analyze-pending', { limit: 10, upgrade });
      toast.success('Analysis complete', `${res.analyzed} failures analyzed`);
      reload(true);
    } catch (err) {
      toast.error('Bulk analysis failed', err.message);
    } finally {
      setBulk(false);
    }
  };

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading && !data) return <Loading rows={8} />;

  const { failures, categories, unanalyzed, ai } = data;
  const visible = category ? failures.filter((f) => (f.analysis?.category ?? 'unanalyzed') === category) : failures;
  const heuristicCount = failures.filter((f) => f.analysis && !isAI(f.analysis.source)).length;

  return (
    <div className="stack">
      {ai.enabled ? (
        <div className="notice">
          <span className="ai-icon">
            <Sparkles size={15} />
          </span>
          <div style={{ flex: 1 }}>
            <strong>{ai.providerLabel} is analyzing failures</strong>
            <div className="small ink-2">
              Model <code>{ai.model}</code>{ai.fallbackModels?.length ? <> (fallback <code>{ai.fallbackModels.join(', ')}</code>)</> : null}. After each run the first few failures get an AI diagnosis automatically. The rest get an instant heuristic pass that you can upgrade.
            </div>
            {ai.lastError && <div className="small error-text">Last error: {ai.lastError}</div>}
          </div>
          {heuristicCount > 0 && (
            <button className="btn btn-primary btn-sm" onClick={() => analyzePending(true)} disabled={bulk}>
              {bulk ? <Loader2 size={13} className="spin" /> : <Sparkles size={13} />} Upgrade {Math.min(heuristicCount, 10)} with {ai.providerLabel}
            </button>
          )}
        </div>
      ) : (
        <div className="notice notice-warn">
          <KeyRound size={18} />
          <div style={{ flex: 1 }}>
            <strong>Running on the built-in heuristic engine</strong>
            <div className="small">
              Diagnoses come from rule-based pattern matching over errors, status codes, assertions and history. For deeper, context-aware root-cause analysis, set <code>GEMINI_API_KEY</code> in <code>.env</code> and restart. <Link to="/settings">Learn more</Link>
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-main-side">
        <div className="stack">
          <div className="row">
            <h3 style={{ fontSize: 16 }}>{category ? CATEGORY_LABELS[category] : 'All recent failures'}</h3>
            <span className="muted small">{visible.length}</span>
            <span className="spacer" />
            {unanalyzed > 0 && (
              <button className="btn btn-sm" onClick={() => analyzePending(false)} disabled={bulk}>
                {bulk ? <Loader2 size={13} className="spin" /> : <Wand2 size={13} />} Analyze {Math.min(unanalyzed, 10)} pending
              </button>
            )}
          </div>
          {visible.length === 0 ? (
            <div className="card">
              <Empty icon={Bot} title="No failures to analyze">
                When tests fail, their diagnoses show up here.
              </Empty>
            </div>
          ) : (
            visible.slice(0, 40).map((f) => (
              <div key={f.id} className="card" style={{ padding: 16 }}>
                <div className="row" style={{ marginBottom: 10 }}>
                  <StatusBadge status={f.status} />
                  <Link to={f.testCaseId ? `/tests/${f.testCaseId}` : '#'} className="cell-title">
                    {f.testName}
                  </Link>
                  <span className="spacer" />
                  <Link to={`/runs/${f.runId}`} className="small">
                    {f.runName} #{f.runId}
                  </Link>
                  <span className="small muted">{timeAgo(f.finishedAt)}</span>
                </div>
                <AnalysisCard
                  analysis={f.analysis}
                  onAnalyze={() => analyze(f.id)}
                  busy={busy.has(f.id)}
                  aiEnabled={ai.enabled}
                  aiLabel={ai.providerLabel}
                  onFix={f.testCaseId ? () => setFixing(f.id) : undefined}
                  compact
                />
              </div>
            ))
          )}
        </div>

        <div className="stack">
          <div className="card">
            <div className="card-head">
              <h3>Root-cause breakdown</h3>
            </div>
            {categories.length === 0 ? (
              <p className="muted small">Nothing yet.</p>
            ) : (
              <>
                <HBarList items={categories} value={(c) => c.count} label={(c) => c.label} />
                <div className="row mt-16" style={{ gap: 6 }}>
                  <button className={`btn btn-sm ${!category ? 'btn-primary' : ''}`} onClick={() => setCategory('')}>
                    All
                  </button>
                  {categories.map((c) => (
                    <button key={c.category} className={`btn btn-sm ${category === c.category ? 'btn-primary' : ''}`} onClick={() => setCategory(c.category)}>
                      {c.label} · {c.count}
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
          <div className="card">
            <div className="card-head">
              <h3>How analysis works</h3>
            </div>
            <ol className="small ink-2" style={{ paddingLeft: 18, margin: 0 }}>
              <li>Every failure is classified instantly by the heuristic engine (network, timeouts, auth, 5xx, contract changes, script bugs…).</li>
              <li>With an AI provider (Gemini or Claude) enabled, the test definition, request, response, assertions, logs and pass/fail history are sent to it, and it returns a structured diagnosis.</li>
              <li>Recent history is used to flag flaky tests, so you don&apos;t chase intermittent failures.</li>
              <li>Each run gets a summary that groups failures into shared root-cause themes and rates release risk.</li>
              <li>
                <strong>Suggest fix</strong> proposes a minimal change when a test&apos;s expectations are outdated (renamed field, new status code…), verifies it against the live API, and
                lets you apply it in one click. Real application bugs are never &quot;fixed&quot; by weakening the test.
              </li>
            </ol>
          </div>
        </div>
      </div>
      {fixing && <FixModal resultId={fixing} onClose={() => setFixing(null)} onApplied={() => reload(true)} />}
    </div>
  );
}
