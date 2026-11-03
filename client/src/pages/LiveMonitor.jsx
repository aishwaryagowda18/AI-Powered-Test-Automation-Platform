import { Activity, ArrowDownToLine, Ban, Pause, Play, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { usePageMeta, useRunLauncher } from '../components/Layout.jsx';
import { Empty, RunProgress, StatusBadge } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useEvents, useEventsStatus } from '../lib/events.jsx';
import { fmtDuration, fmtTime } from '../lib/format.js';
import { useToast } from '../lib/toast.jsx';

const MAX_LINES = 1000;
const LEVELS = ['all', 'info', 'pass', 'fail', 'warn', 'error', 'debug'];

export default function LiveMonitor() {
  usePageMeta('Live monitor', 'Real-time execution progress and streaming logs');
  const launch = useRunLauncher();
  const toast = useToast();
  const connected = useEventsStatus();
  const [runs, setRuns] = useState(new Map());
  const [running, setRunning] = useState(new Map()); // resultId -> { testName, runId, startedAt }
  const [lines, setLines] = useState([]);
  const [paused, setPaused] = useState(false);
  const [follow, setFollow] = useState(true);
  const [level, setLevel] = useState('all');
  const consoleRef = useRef(null);
  const buffer = useRef([]);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;

  // Seed with whatever is currently active.
  useEffect(() => {
    api
      .get('/runs?limit=20')
      .then(({ runs: list }) => {
        const active = list.filter((r) => r.status === 'running' || r.status === 'queued' || Date.now() - new Date(r.createdAt) < 5 * 60000);
        setRuns(new Map(active.slice(0, 6).map((r) => [r.id, r])));
      })
      .catch(() => {});
  }, []);

  useEvents((e) => {
    if (e.type === 'run:created' || e.type === 'run:updated') {
      setRuns((prev) => new Map(prev).set(e.data.id, e.data));
    } else if (e.type === 'result:updated') {
      setRunning((prev) => {
        const next = new Map(prev);
        if (e.data.status === 'running') next.set(e.data.id, { testName: e.data.testName, runId: e.data.runId, startedAt: e.data.startedAt });
        else next.delete(e.data.id);
        return next;
      });
    } else if (e.type === 'log') {
      buffer.current.push(e.data);
      if (!pausedRef.current) flush();
    }
  });

  const flush = () => {
    if (!buffer.current.length) return;
    const incoming = buffer.current;
    buffer.current = [];
    setLines((prev) => {
      const next = prev.concat(incoming);
      return next.length > MAX_LINES ? next.slice(next.length - MAX_LINES) : next;
    });
  };

  useEffect(() => {
    if (!paused) flush();
  }, [paused]);

  useEffect(() => {
    if (follow && consoleRef.current) consoleRef.current.scrollTop = consoleRef.current.scrollHeight;
  }, [lines, follow]);

  const visible = useMemo(() => (level === 'all' ? lines : lines.filter((l) => l.level === level)), [lines, level]);
  const runList = [...runs.values()].sort((a, b) => b.id - a.id);
  const activeRuns = runList.filter((r) => r.status === 'running' || r.status === 'queued');

  const cancel = async (id) => {
    try {
      await api.post(`/runs/${id}/cancel`);
      toast.info('Cancelling run', `Run #${id} will stop after in-flight tests finish.`);
    } catch (err) {
      toast.error('Could not cancel', err.message);
    }
  };

  return (
    <div className="stack">
      <div className="grid grid-main-side">
        <div className="card">
          <div className="card-head">
            <Activity size={18} style={{ color: 'var(--primary)' }} />
            <h3>Runs</h3>
            <span className="sub">{activeRuns.length ? `${activeRuns.length} active` : 'idle'}</span>
            <span className="spacer" />
            <button className="btn btn-primary btn-sm" onClick={() => launch()}>
              <Play size={13} /> Start a run
            </button>
          </div>
          {runList.length === 0 ? (
            <Empty icon={Activity} title="Waiting for runs">
              Start a run. Progress and logs stream here as each test executes.
            </Empty>
          ) : (
            <div className="list">
              {runList.map((r) => {
                const done = r.passed + r.failed + r.errored + r.skipped;
                const isActive = r.status === 'running' || r.status === 'queued';
                return (
                  <div key={r.id} className="list-item" style={{ alignItems: 'flex-start' }}>
                    <StatusBadge status={r.status} />
                    <div className="grow">
                      <div className="row">
                        <Link to={`/runs/${r.id}`} className="cell-title">
                          #{r.id} {r.name}
                        </Link>
                        <span className="spacer" />
                        <span className="small muted num">
                          {done}/{r.total} · ✓ {r.passed} · ✗ {r.failed + r.errored}
                          {r.durationMs != null && ` · ${fmtDuration(r.durationMs)}`}
                        </span>
                      </div>
                      <div style={{ marginTop: 8 }}>
                        <RunProgress run={r} large />
                      </div>
                    </div>
                    {isActive && (
                      <button className="btn btn-sm btn-danger" onClick={() => cancel(r.id)}>
                        <Ban size={13} /> Cancel
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="card">
          <div className="card-head">
            <h3>Executing now</h3>
            <span className="sub">{running.size} in flight</span>
          </div>
          {running.size === 0 ? (
            <p className="muted small">No tests executing right now.</p>
          ) : (
            <div className="list">
              {[...running.entries()].map(([id, t]) => (
                <div key={id} className="list-item">
                  <StatusBadge status="running" />
                  <span className="grow truncate" style={{ fontWeight: 600 }}>
                    {t.testName}
                  </span>
                  <span className="small muted">#{t.runId}</span>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h3>Live console</h3>
          <span className="live-pill">
            <span className={`dot ${connected && !paused ? 'dot-live' : ''}`} />
            {paused ? `Paused (${buffer.current.length} buffered)` : connected ? 'Streaming' : 'Reconnecting'}
          </span>
          <span className="spacer" />
          <select className="select select-sm" style={{ width: 'auto' }} value={level} onChange={(e) => setLevel(e.target.value)} aria-label="Filter by level">
            {LEVELS.map((l) => (
              <option key={l} value={l}>
                {l === 'all' ? 'All levels' : l}
              </option>
            ))}
          </select>
          <button className="btn btn-sm" onClick={() => setPaused((p) => !p)}>
            {paused ? <Play size={13} /> : <Pause size={13} />} {paused ? 'Resume' : 'Pause'}
          </button>
          <button className={`btn btn-sm ${follow ? 'btn-primary' : ''}`} onClick={() => setFollow((f) => !f)} title="Auto-scroll">
            <ArrowDownToLine size={13} /> Follow
          </button>
          <button className="btn btn-sm btn-ghost" onClick={() => setLines([])}>
            <Trash2 size={13} /> Clear
          </button>
        </div>
        <div className="console console-lg" ref={consoleRef} role="log" aria-live="off">
          {visible.length === 0 ? (
            <span style={{ color: '#7d7894' }}>Log output from running tests appears here…</span>
          ) : (
            visible.map((l, i) => (
              <div key={i} className="log-line with-test">
                <span className="log-ts">{fmtTime(l.ts)}</span>
                <span className={`lvl lvl-${l.level}`}>{l.level.toUpperCase()}</span>
                <span className="log-test" title={l.testName}>
                  #{l.runId} {l.testName}
                </span>
                <span>{l.message}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
