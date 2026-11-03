import { History, Play, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { usePageMeta, useRunLauncher } from '../components/Layout.jsx';
import { Empty, ErrorState, Loading, RunProgress, StatusBadge } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useLiveReload } from '../lib/events.jsx';
import { fmtDateTime, fmtDuration, fmtPct, passRateOf, timeAgo } from '../lib/format.js';
import { useFetch, useTick } from '../lib/hooks.js';
import { useToast } from '../lib/toast.jsx';

const PAGE = 25;
const STATUSES = ['', 'running', 'passed', 'failed', 'cancelled'];

export default function Runs() {
  usePageMeta('Run history', 'Every execution with results, logs and reports');
  const launch = useRunLauncher();
  const navigate = useNavigate();
  const toast = useToast();
  const [status, setStatus] = useState('');
  const [limit, setLimit] = useState(PAGE);
  const { data, error, loading, reload } = useFetch(`/runs?limit=${limit}${status ? `&status=${status}` : ''}`);
  useLiveReload(reload, ['run:created', 'run:updated', 'run:finished'], 400);
  useTick();

  const remove = async (e, run) => {
    e.stopPropagation();
    if (!window.confirm(`Delete run #${run.id} and its results?`)) return;
    try {
      await api.del(`/runs/${run.id}`);
      reload(true);
    } catch (err) {
      toast.error('Delete failed', err.message);
    }
  };

  if (error) return <ErrorState error={error} onRetry={reload} />;

  return (
    <div className="card card-flush">
      <div className="card-head" style={{ paddingBottom: 16 }}>
        <div className="segmented" role="tablist" aria-label="Filter by status">
          {STATUSES.map((s) => (
            <button key={s || 'all'} className={status === s ? 'active' : ''} onClick={() => setStatus(s)}>
              {s ? s[0].toUpperCase() + s.slice(1) : 'All'}
            </button>
          ))}
        </div>
        <span className="spacer" />
        {data && <span className="sub">{data.total} runs</span>}
        <button className="btn btn-primary btn-sm" onClick={() => launch()}>
          <Play size={13} /> New run
        </button>
      </div>
      {loading && !data ? (
        <div style={{ padding: 20 }}>
          <Loading rows={6} />
        </div>
      ) : data.runs.length === 0 ? (
        <Empty
          icon={History}
          title={status ? `No ${status} runs` : 'No runs yet'}
          action={
            <button className="btn btn-primary" onClick={() => launch()}>
              <Play size={15} /> Start a run
            </button>
          }
        >
          Runs record every result, log line and AI diagnosis.
        </Empty>
      ) : (
        <>
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Run</th>
                  <th className="hide-sm">Results</th>
                  <th className="num">Pass rate</th>
                  <th className="num hide-sm">Duration</th>
                  <th className="hide-sm">Started</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {data.runs.map((r) => (
                  <tr key={r.id} className="clickable" onClick={() => navigate(`/runs/${r.id}`)}>
                    <td>
                      <StatusBadge status={r.status} />
                    </td>
                    <td>
                      <Link to={`/runs/${r.id}`} className="cell-title" onClick={(e) => e.stopPropagation()}>
                        {r.name}
                      </Link>
                      <div className="cell-sub">
                        #{r.id} · {r.environmentName ?? 'default env'} · {r.trigger}
                      </div>
                    </td>
                    <td className="hide-sm" style={{ minWidth: 200 }}>
                      <RunProgress run={r} />
                      <div className="cell-sub num" style={{ marginTop: 4 }}>
                        ✓ {r.passed} · ✗ {r.failed} · ! {r.errored}
                        {r.skipped ? ` · – ${r.skipped}` : ''}
                        {r.flaky ? ` · ${r.flaky} flaky` : ''}
                      </div>
                    </td>
                    <td className="num">{fmtPct(passRateOf(r))}</td>
                    <td className="num hide-sm">{fmtDuration(r.durationMs)}</td>
                    <td className="hide-sm" title={fmtDateTime(r.createdAt)}>
                      {timeAgo(r.createdAt)}
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      <button className="btn btn-ghost btn-icon btn-sm btn-danger" onClick={(e) => remove(e, r)} aria-label={`Delete run ${r.id}`}>
                        <Trash2 size={14} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {data.total > data.runs.length && (
            <div style={{ padding: 16, textAlign: 'center' }}>
              <button className="btn" onClick={() => setLimit((l) => l + PAGE)}>
                Load more
              </button>
            </div>
          )}
        </>
      )}
    </div>
  );
}
