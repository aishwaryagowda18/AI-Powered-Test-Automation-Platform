import { AlertTriangle, Bot, CheckCircle2, Loader2, Play, ShieldAlert, Sparkles, Wrench, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { isAI, providerName } from '../lib/ai.js';
import { api } from '../lib/api.js';
import { useToast } from '../lib/toast.jsx';
import { Modal } from './ui.jsx';

const TYPE_LABELS = { status: 'Status', responseTime: 'Response time', header: 'Header', jsonPath: 'JSON', body: 'Body' };
const RISK = {
  low: { cls: 'badge-passed', text: 'Low risk' },
  medium: { cls: 'badge-flaky', text: 'Medium risk: review' },
  high: { cls: 'badge-failed', text: 'High risk: could hide a regression' },
};

const describe = (a) => (a ? `${TYPE_LABELS[a.type] ?? a.type}${a.target ? ` ${a.target}` : ''} ${a.operator}${['exists', 'notExists'].includes(a.operator) ? '' : ` ${a.expected}`}` : '—');

/** Minimal LCS line diff for script changes. */
function diffLines(before, after) {
  const a = before.split('\n');
  const b = after.split('\n');
  const dp = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) for (let j = b.length - 1; j >= 0; j--) dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) out.push({ op: ' ', text: a[i++], n: j++ });
    else if (dp[i + 1][j] >= dp[i][j + 1]) out.push({ op: '-', text: a[i++] });
    else out.push({ op: '+', text: b[j++] });
  }
  while (i < a.length) out.push({ op: '-', text: a[i++] });
  while (j < b.length) out.push({ op: '+', text: b[j++] });
  return out;
}

function AssertionDiff({ before, after }) {
  const rows = Array.from({ length: Math.max(before.length, after.length) }, (_, i) => ({
    i,
    before: before[i],
    after: after[i],
    changed: JSON.stringify(before[i] ?? null) !== JSON.stringify(after[i] ?? null),
  }));
  return (
    <div className="table-wrap" style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-md)' }}>
      <table className="table">
        <thead>
          <tr>
            <th className="num">#</th>
            <th>Before</th>
            <th>After</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.i} className={r.changed ? 'diff-changed' : ''}>
              <td className="num muted">{r.i + 1}</td>
              <td className={`mono small ${r.changed ? 'diff-del' : 'muted'}`}>{describe(r.before)}</td>
              <td className={`mono small ${r.changed ? 'diff-add' : 'muted'}`}>{describe(r.after)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function CodeDiff({ before, after }) {
  return (
    <pre className="code-block" style={{ padding: 0, maxHeight: 340 }}>
      {diffLines(before ?? '', after ?? '').map((l, k) => (
        <div key={k} className={l.op === '+' ? 'diff-line-add' : l.op === '-' ? 'diff-line-del' : ''} style={{ padding: '0 12px' }}>
          {l.op} {l.text}
        </div>
      ))}
    </pre>
  );
}

/** Propose → review → apply a fix for one failed result. */
export function FixModal({ resultId, onClose, onApplied }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [proposal, setProposal] = useState(null);
  const [error, setError] = useState(null);
  const [applying, setApplying] = useState(false);

  useEffect(() => {
    api
      .post(`/results/${resultId}/fix`, { useAI: true })
      .then(setProposal)
      .catch((err) => setError(err.message));
  }, [resultId]);

  const apply = async (rerun) => {
    setApplying(true);
    try {
      const body = { baseUpdatedAt: proposal.baseUpdatedAt, ...(proposal.testType === 'http' ? { assertions: proposal.after.assertions } : { code: proposal.after.code }) };
      await api.post(`/tests/${proposal.testId}/apply-fix`, body);
      toast.success('Fix applied', proposal.testName);
      onApplied?.();
      if (rerun) {
        const run = await api.post('/runs', { testIds: [proposal.testId], environmentId: proposal.environmentId ?? undefined, name: `Verify fix: ${proposal.testName}` });
        navigate(`/runs/${run.id}`);
      }
      onClose();
    } catch (err) {
      toast.error('Could not apply fix', err.message);
    } finally {
      setApplying(false);
    }
  };

  const risk = RISK[proposal?.risk] ?? RISK.medium;
  const verified = proposal?.verification;

  return (
    <Modal
      wide
      title="Suggested fix"
      subtitle={proposal ? `${proposal.testName}${proposal.iteration ? ` · data row ${proposal.iteration.index}` : ''}` : 'Analyzing the failure and checking a fix against the live API…'}
      onClose={onClose}
      footer={
        proposal?.fixable ? (
          <>
            <button className="btn" onClick={onClose} disabled={applying}>
              Cancel
            </button>
            <button className="btn" onClick={() => apply(false)} disabled={applying}>
              <Wrench size={14} /> Apply fix
            </button>
            <button className="btn btn-primary" onClick={() => apply(true)} disabled={applying}>
              {applying ? <Loader2 size={14} className="spin" /> : <Play size={14} />} Apply & re-run
            </button>
          </>
        ) : (
          <button className="btn" onClick={onClose}>
            Close
          </button>
        )
      }
    >
      {!proposal && !error && (
        <div className="row" style={{ padding: '24px 0', justifyContent: 'center' }}>
          <Loader2 size={18} className="spin" />
          <span className="ink-2">Working out a minimal fix and verifying it…</span>
        </div>
      )}
      {error && (
        <div className="notice notice-error small">
          <AlertTriangle size={16} />
          <span>{error}</span>
        </div>
      )}
      {proposal && (
        <div className="stack" style={{ gap: 14 }}>
          <div className="row">
            <span className={`badge ${isAI(proposal.source) ? 'badge-ai' : 'badge-neutral'}`}>
              {isAI(proposal.source) ? <Sparkles size={12} /> : <Bot size={12} />}
              {isAI(proposal.source) ? `${providerName(proposal.source)}${proposal.model ? ` (${proposal.model})` : ''}` : 'Rule-based fixer'}
            </span>
            {proposal.fixable && <span className={`badge ${risk.cls}`}>{risk.text}</span>}
          </div>
          {proposal.aiError && (
            <div className="notice notice-warn small">
              <AlertTriangle size={15} />
              <span>AI unavailable ({proposal.aiError}). This proposal comes from the rule-based fixer.</span>
            </div>
          )}
          {proposal.staleRun && (
            <div className="notice notice-warn small">
              <AlertTriangle size={15} />
              <span>The test was edited after this run. The proposal is based on the current definition.</span>
            </div>
          )}

          <div className={proposal.fixable ? '' : 'notice'}>
            {!proposal.fixable && <ShieldAlert size={18} style={{ color: 'var(--primary)', flex: 'none' }} />}
            <div>
              <h4 style={{ fontSize: 15, marginBottom: 4 }}>{proposal.summary}</h4>
              <div className="small ink-2" style={{ whiteSpace: 'pre-line' }}>
                {proposal.rationale}
              </div>
            </div>
          </div>

          {proposal.fixable && (
            <>
              {verified && (
                <div className={`notice small ${verified.status === 'passed' ? '' : 'notice-warn'}`}>
                  {verified.status === 'passed' ? <CheckCircle2 size={16} style={{ color: 'var(--good-ink)' }} /> : <XCircle size={16} style={{ color: 'var(--critical-ink)' }} />}
                  <span>
                    {verified.status === 'passed' ? (
                      <>
                        <strong>Verified:</strong> the fixed test passes against the live API{proposal.iteration ? ` (row ${proposal.iteration.index})` : ''}.
                      </>
                    ) : (
                      <>
                        <strong>Not verified:</strong> the fixed test still {verified.status === 'error' ? 'errors' : 'fails'}: {verified.errorMessage}. Review before applying.
                      </>
                    )}
                  </span>
                </div>
              )}
              <div>
                <div className="label" style={{ marginBottom: 6 }}>
                  {proposal.testType === 'http' ? 'Assertion changes' : 'Code changes'}
                </div>
                {proposal.testType === 'http' ? <AssertionDiff before={proposal.before.assertions} after={proposal.after.assertions} /> : <CodeDiff before={proposal.before.code} after={proposal.after.code} />}
              </div>
            </>
          )}
        </div>
      )}
    </Modal>
  );
}
