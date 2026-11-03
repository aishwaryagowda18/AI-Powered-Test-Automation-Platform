import { Bot, Loader2, RefreshCw, Sparkles, Wand2, Wrench } from 'lucide-react';
import { isAI, providerName } from '../lib/ai.js';
import { CATEGORY_LABELS, OWNER_LABELS, timeAgo } from '../lib/format.js';
import { Confidence } from './ui.jsx';

export function SourceBadge({ analysis }) {
  if (!analysis) return null;
  return isAI(analysis.source) ? (
    <span className="badge badge-ai" title={analysis.model}>
      <Sparkles size={12} /> {providerName(analysis.source)}
    </span>
  ) : (
    <span className="badge badge-neutral">
      <Bot size={12} /> Heuristic
    </span>
  );
}

/** Root-cause analysis for a single failed result. */
export function AnalysisCard({ analysis, onAnalyze, busy, aiEnabled, aiLabel = 'AI', compact, onFix }) {
  if (!analysis) {
    return (
      <div className="ai-card">
        <div className="ai-head">
          <span className="ai-icon">
            <Wand2 size={15} />
          </span>
          <h4 style={{ flex: 1 }}>No root-cause analysis yet</h4>
          {onAnalyze && (
            <button className="btn btn-primary btn-sm" onClick={() => onAnalyze(true)} disabled={busy}>
              {busy ? <Loader2 size={14} className="spin" /> : <Sparkles size={14} />}
              {aiEnabled ? `Analyze with ${aiLabel}` : 'Analyze'}
            </button>
          )}
          {onFix && (
            <button className="btn btn-sm" onClick={onFix}>
              <Wrench size={13} /> Suggest fix
            </button>
          )}
        </div>
      </div>
    );
  }
  return (
    <div className="ai-card">
      <div className="ai-head">
        <span className="ai-icon">
          <Sparkles size={15} />
        </span>
        <span className="badge badge-ai">{analysis.categoryLabel ?? CATEGORY_LABELS[analysis.category] ?? analysis.category}</span>
        <SourceBadge analysis={analysis} />
        {analysis.isLikelyFlaky && <span className="badge badge-flaky">Likely flaky</span>}
        <span className="spacer" />
        <Confidence level={analysis.confidence} />
      </div>
      <h4>{analysis.summary}</h4>
      <p>{analysis.rootCause}</p>

      {!compact && analysis.evidence?.length > 0 && (
        <>
          <div className="ai-section-title">Evidence</div>
          <ul>
            {analysis.evidence.map((e, i) => (
              <li key={i} className="small">
                {e}
              </li>
            ))}
          </ul>
        </>
      )}
      {analysis.suggestedFixes?.length > 0 && (
        <>
          <div className="ai-section-title">Suggested fixes</div>
          <ol>
            {(compact ? analysis.suggestedFixes.slice(0, 2) : analysis.suggestedFixes).map((f, i) => (
              <li key={i}>{f}</li>
            ))}
          </ol>
        </>
      )}
      <div className="row small muted" style={{ marginTop: 12 }}>
        <span>
          Fix most likely belongs in: <strong className="ink-2">{OWNER_LABELS[analysis.owner] ?? analysis.owner}</strong>
        </span>
        <span>· analyzed {timeAgo(analysis.analyzedAt)}</span>
        {analysis.model && <span>· {analysis.model}</span>}
        <span className="spacer" />
        {onAnalyze && (
          <button className="btn btn-sm" onClick={() => onAnalyze(true)} disabled={busy}>
            {busy ? <Loader2 size={13} className="spin" /> : <RefreshCw size={13} />}
            {aiEnabled ? (isAI(analysis.source) ? 'Re-analyze' : `Deep-analyze with ${aiLabel}`) : 'Re-analyze'}
          </button>
        )}
        {onFix && (
          <button className="btn btn-sm btn-primary" onClick={onFix} title="Propose a change to the test and verify it against the live API">
            <Wrench size={13} /> Suggest fix
          </button>
        )}
      </div>
      {analysis.aiError && (
        <div className="notice notice-warn small" style={{ marginTop: 10 }}>
          {aiLabel} analysis unavailable, so this shows the heuristic result. {analysis.aiError}
        </div>
      )}
    </div>
  );
}
