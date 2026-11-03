import { CheckCircle2, XCircle } from 'lucide-react';
import { useState } from 'react';
import { fmtDuration, fmtTime } from '../lib/format.js';
import { AnalysisCard } from './AnalysisCard.jsx';

const pretty = (text) => {
  if (text == null) return '';
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
};

export function AssertionList({ assertions }) {
  if (!assertions?.length) return <p className="muted small">No assertions were evaluated.</p>;
  return (
    <div>
      {assertions.map((a, i) => (
        <div key={i} className={`assertion ${a.passed ? 'ok' : 'bad'}`}>
          {a.passed ? <CheckCircle2 size={15} /> : <XCircle size={15} />}
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>
              {a.description}
              {a.implicit && <span className="muted small"> (default)</span>}
            </div>
            {!a.passed && (
              <div className="small mono ink-2" style={{ wordBreak: 'break-word' }}>
                actual: {a.actual}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

export function LogConsole({ logs }) {
  if (!logs?.length) return <p className="muted small">No log output.</p>;
  return (
    <div className="console">
      {logs.map((l, i) => (
        <div key={i} className="log-line">
          <span className="log-ts">{fmtTime(l.ts)}</span>
          <span className={`lvl lvl-${l.level}`}>{l.level.toUpperCase()}</span>
          <span>{l.message}</span>
        </div>
      ))}
    </div>
  );
}

function Headers({ headers }) {
  const entries = Object.entries(headers ?? {});
  if (!entries.length) return <p className="muted small">No headers.</p>;
  return (
    <dl className="kv-table">
      {entries.map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <dt>{k}</dt>
          <dd>{String(v)}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Tabbed detail view for one result (or a "Try it" outcome). */
export function ResultDetail({ result, onAnalyze, analyzing, aiEnabled, aiLabel, onFix, showAnalysis = true }) {
  const failed = result.status === 'failed' || result.status === 'error';
  const tabs = [
    showAnalysis && failed && { key: 'ai', label: 'AI analysis' },
    { key: 'assertions', label: 'Assertions', n: result.assertions?.length },
    { key: 'logs', label: 'Logs', n: result.logs?.length },
    result.request && { key: 'request', label: 'Request' },
    result.response && { key: 'response', label: 'Response' },
  ].filter(Boolean);
  const [tab, setTab] = useState(tabs[0].key);

  return (
    <div>
      {result.iteration && (
        <div className="row small" style={{ margin: '12px 0 0', gap: 6 }}>
          <span className="label">
            Data row {result.iteration.index}/{result.iteration.total}:
          </span>
          {Object.entries(result.iteration.data).map(([k, v]) => (
            <span key={k} className="chip mono">
              {k}={v === '' ? '∅' : v}
            </span>
          ))}
        </div>
      )}
      {result.errorMessage && (
        <div className="notice notice-error small" style={{ margin: '12px 0' }}>
          <XCircle size={16} />
          <div style={{ minWidth: 0, wordBreak: 'break-word' }}>
            <strong>{result.status === 'error' ? 'Error' : result.status === 'skipped' ? 'Skipped' : 'Failure'}:</strong> {result.errorMessage.replace(/^Skipped: /, '')}
          </div>
        </div>
      )}
      <div className="tabs" role="tablist">
        {tabs.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} className={`tab ${tab === t.key ? 'active' : ''}`} onClick={() => setTab(t.key)}>
            {t.label}
            {t.n != null && <span className="n">{t.n}</span>}
          </button>
        ))}
      </div>

      {tab === 'ai' && <AnalysisCard analysis={result.analysis} onAnalyze={onAnalyze} busy={analyzing} aiEnabled={aiEnabled} aiLabel={aiLabel} onFix={onFix} />}
      {tab === 'assertions' && <AssertionList assertions={result.assertions} />}
      {tab === 'logs' && <LogConsole logs={result.logs} />}
      {tab === 'request' && result.request && (
        <div className="stack" style={{ gap: 12 }}>
          <div className="mono" style={{ wordBreak: 'break-all' }}>
            <span className={`method method-${result.request.method}`}>{result.request.method}</span> {result.request.url}
          </div>
          <div>
            <div className="label" style={{ marginBottom: 6 }}>
              Headers
            </div>
            <Headers headers={result.request.headers} />
          </div>
          {result.request.body && (
            <div>
              <div className="label" style={{ marginBottom: 6 }}>
                Body
              </div>
              <pre className="code-block">{pretty(result.request.body)}</pre>
            </div>
          )}
        </div>
      )}
      {tab === 'response' && result.response && (
        <div className="stack" style={{ gap: 12 }}>
          <div className="row">
            <span className={`badge ${result.response.status < 400 ? 'badge-passed' : 'badge-failed'}`}>
              {result.response.status} {result.response.statusText}
            </span>
            <span className="small muted">
              {fmtDuration(result.response.durationMs)} · {result.response.size} bytes
            </span>
          </div>
          <div>
            <div className="label" style={{ marginBottom: 6 }}>
              Body
            </div>
            <pre className="code-block">{pretty(result.response.body) || '(empty)'}</pre>
          </div>
          <details>
            <summary className="label" style={{ cursor: 'pointer' }}>
              Headers
            </summary>
            <div style={{ marginTop: 8 }}>
              <Headers headers={result.response.headers} />
            </div>
          </details>
        </div>
      )}
    </div>
  );
}
