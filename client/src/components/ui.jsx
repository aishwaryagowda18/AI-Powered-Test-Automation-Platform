import { AlertTriangle, Ban, CheckCircle2, Clock, Inbox, Loader2, MinusCircle, X, XCircle } from 'lucide-react';
import { useEffect } from 'react';

const STATUS = {
  passed: { label: 'Passed', icon: CheckCircle2 },
  failed: { label: 'Failed', icon: XCircle },
  error: { label: 'Error', icon: AlertTriangle },
  skipped: { label: 'Skipped', icon: MinusCircle },
  cancelled: { label: 'Cancelled', icon: Ban },
  running: { label: 'Running', icon: Loader2 },
  queued: { label: 'Queued', icon: Clock },
};

/** Status always carries icon + label, never color alone. */
export function StatusBadge({ status, size = 14 }) {
  if (!status) return <span className="badge badge-neutral">No runs</span>;
  const meta = STATUS[status] ?? { label: status, icon: MinusCircle };
  const Icon = meta.icon;
  return (
    <span className={`badge badge-${status}`}>
      <Icon size={size} className={status === 'running' ? 'spin' : undefined} />
      {meta.label}
    </span>
  );
}

export function TypeChip({ type }) {
  return <span className={`chip chip-${type}`}>{type === 'http' ? 'HTTP' : 'Script'}</span>;
}

export function Empty({ icon: Icon = Inbox, title, children, action }) {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon size={24} />
      </div>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}

export function Loading({ rows = 4 }) {
  return (
    <div className="stack" style={{ gap: 10 }} aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton" style={{ height: 18, width: `${90 - i * 12}%` }} />
      ))}
    </div>
  );
}

export function ErrorState({ error, onRetry }) {
  return (
    <div className="notice notice-error">
      <AlertTriangle size={18} />
      <div style={{ flex: 1 }}>
        <strong>Something went wrong</strong>
        <div className="small">{error?.message ?? String(error)}</div>
      </div>
      {onRetry && (
        <button className="btn btn-sm" onClick={() => onRetry()}>
          Retry
        </button>
      )}
    </div>
  );
}

export function Modal({ title, subtitle, onClose, children, footer, wide }) {
  useEffect(() => {
    const onKey = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal ${wide ? 'modal-wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <div style={{ flex: 1 }}>
            <h2>{title}</h2>
            {subtitle && <p>{subtitle}</p>}
          </div>
          <button className="btn btn-ghost btn-icon" onClick={onClose} aria-label="Close">
            <X size={18} />
          </button>
        </div>
        {children}
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function StatTile({ icon: Icon, label, value, foot, tone }) {
  return (
    <div className="card stat">
      <div className="stat-label">
        {Icon && (
          <span className="stat-icon" style={tone ? { background: `var(--${tone}-soft)`, color: `var(--${tone}-ink)` } : undefined}>
            <Icon size={16} />
          </span>
        )}
        {label}
      </div>
      <div className="stat-value num">{value}</div>
      {foot && <div className="stat-foot">{foot}</div>}
    </div>
  );
}

/** Segmented progress bar for a run (passed / failed / error / skipped / in-flight). */
export function RunProgress({ run, large }) {
  const total = Math.max(run.total || 0, 1);
  const done = run.passed + run.failed + run.errored + run.skipped;
  const active = run.status === 'running' || run.status === 'queued';
  const segments = [
    ['passed', run.passed],
    ['failed', run.failed],
    ['error', run.errored],
    ['skipped', run.skipped],
  ];
  return (
    <div
      className={`progress ${large ? 'progress-lg' : ''}`}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={run.total}
      aria-valuenow={done}
      aria-label={`${done} of ${run.total} tests finished`}
    >
      {segments.map(([k, n]) => (n ? <span key={k} className={`p-${k}`} style={{ width: `${(n / total) * 100}%` }} /> : null))}
      {active && done < total && <span className="p-running" style={{ width: `${Math.max(((total - done) / total) * 100, 4)}%`, opacity: 0.35 }} />}
    </div>
  );
}

export function Spark({ statuses = [] }) {
  return (
    <span className="spark" aria-label={`Recent results: ${statuses.join(', ')}`}>
      {[...statuses].reverse().map((s, i) => (
        <i key={i} className={`s-${s}`} title={s} />
      ))}
    </span>
  );
}

export function Confidence({ level }) {
  const n = { low: 1, medium: 2, high: 3 }[level] ?? 0;
  return (
    <span className="confidence" title={`${level} confidence`}>
      {[1, 2, 3].map((i) => (
        <i key={i} className={i <= n ? 'on' : ''} />
      ))}
      <span className="small ink-2" style={{ marginLeft: 6, fontWeight: 700 }}>
        {level} confidence
      </span>
    </span>
  );
}
