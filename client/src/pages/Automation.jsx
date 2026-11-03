import { BellRing, CalendarClock, CheckCircle2, Hash, Pencil, Play, Plus, Send, Trash2, Webhook, XCircle } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { usePageMeta } from '../components/Layout.jsx';
import { Empty, ErrorState, Loading, Modal, StatusBadge } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useLiveReload } from '../lib/events.jsx';
import { fmtDateTime, timeAgo, timeUntil } from '../lib/format.js';
import { useFetch, useTick } from '../lib/hooks.js';
import { useToast } from '../lib/toast.jsx';

export default function Automation() {
  usePageMeta('Schedules & alerts', 'Run suites automatically and notify your team about results');
  return (
    <div className="stack">
      <Schedules />
      <Channels />
    </div>
  );
}

// ---------------------------------------------------------------- schedules

const PRESETS = [
  ['*/15 * * * *', 'Every 15 minutes'],
  ['0 * * * *', 'Every hour'],
  ['0 */6 * * *', 'Every 6 hours'],
  ['0 2 * * *', 'Daily at 02:00'],
  ['0 9 * * 1-5', 'Weekdays at 09:00'],
  ['0 6 * * 1', 'Mondays at 06:00'],
];

function Schedules() {
  const toast = useToast();
  const navigate = useNavigate();
  const { data: schedules, error, loading, reload } = useFetch('/schedules');
  useLiveReload(reload, ['schedule:updated', 'run:finished'], 500);
  useTick(20000);
  const [editing, setEditing] = useState(null);

  const toggle = async (s) => {
    try {
      await api.put(`/schedules/${s.id}`, { enabled: !s.enabled });
      toast.success(s.enabled ? 'Schedule paused' : 'Schedule enabled', s.name);
      reload(true);
    } catch (err) {
      toast.error('Update failed', err.message);
    }
  };
  const runNow = async (s) => {
    try {
      const run = await api.post(`/schedules/${s.id}/run`);
      navigate(`/runs/${run.id}`);
    } catch (err) {
      toast.error('Could not start', err.message);
    }
  };
  const remove = async (s) => {
    if (!window.confirm(`Delete schedule "${s.name}"?`)) return;
    await api.del(`/schedules/${s.id}`);
    reload(true);
  };

  if (error) return <ErrorState error={error} onRetry={reload} />;

  return (
    <div className="card card-flush">
      <div className="card-head" style={{ paddingBottom: 14 }}>
        <CalendarClock size={18} style={{ color: 'var(--primary)' }} />
        <h3>Schedules</h3>
        <span className="sub">Times use the server&apos;s local time zone</span>
        <span className="spacer" />
        <button className="btn btn-dark btn-sm" onClick={() => setEditing({ name: '', cron: '0 2 * * *', suiteId: '', environmentId: '', enabled: true })}>
          <Plus size={13} /> New schedule
        </button>
      </div>
      {loading ? (
        <div style={{ padding: 20 }}>
          <Loading rows={3} />
        </div>
      ) : schedules.length === 0 ? (
        <Empty icon={CalendarClock} title="No schedules yet">
          Run a suite every few minutes as a health check, or nightly as a full regression.
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>On</th>
                <th>Schedule</th>
                <th className="hide-sm">Runs</th>
                <th>Next run</th>
                <th className="hide-sm">Last run</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {schedules.map((s) => (
                <tr key={s.id} style={{ opacity: s.enabled ? 1 : 0.65 }}>
                  <td>
                    <label className="check">
                      <input type="checkbox" checked={s.enabled} onChange={() => toggle(s)} aria-label={`${s.enabled ? 'Pause' : 'Enable'} ${s.name}`} />
                    </label>
                  </td>
                  <td>
                    <div className="cell-title">{s.name}</div>
                    <div className="cell-sub">
                      {s.description} · <code>{s.cron}</code>
                    </div>
                  </td>
                  <td className="hide-sm ink-2">
                    {s.suiteName ?? (s.testIds.length ? `${s.testIds.length} tests` : 'All enabled tests')}
                    <div className="cell-sub">{s.environmentName ?? 'default environment'}</div>
                  </td>
                  <td>
                    {s.enabled && s.nextRunAt ? (
                      <>
                        <div style={{ fontWeight: 600 }}>{timeUntil(s.nextRunAt)}</div>
                        <div className="cell-sub">{fmtDateTime(s.nextRunAt)}</div>
                      </>
                    ) : (
                      <span className="badge badge-neutral">Paused</span>
                    )}
                  </td>
                  <td className="hide-sm">
                    {s.lastRunId ? (
                      <Link to={`/runs/${s.lastRunId}`}>
                        <StatusBadge status={s.lastRunStatus ?? 'queued'} />
                        <div className="cell-sub">{timeAgo(s.lastRunAt)}</div>
                      </Link>
                    ) : (
                      <span className="muted small">Never</span>
                    )}
                    {s.lastError && <div className="small error-text">{s.lastError}</div>}
                  </td>
                  <td>
                    <div className="row" style={{ justifyContent: 'flex-end', gap: 2, flexWrap: 'nowrap' }}>
                      <button className="btn btn-ghost btn-icon btn-sm" title="Run now" aria-label={`Run ${s.name} now`} onClick={() => runNow(s)}>
                        <Play size={14} />
                      </button>
                      <button className="btn btn-ghost btn-icon btn-sm" title="Edit" aria-label={`Edit ${s.name}`} onClick={() => setEditing({ ...s, suiteId: s.suiteId ?? '', environmentId: s.environmentId ?? '' })}>
                        <Pencil size={14} />
                      </button>
                      <button className="btn btn-ghost btn-icon btn-sm btn-danger" title="Delete" aria-label={`Delete ${s.name}`} onClick={() => remove(s)}>
                        <Trash2 size={14} />
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && (
        <ScheduleModal
          schedule={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload(true);
          }}
        />
      )}
    </div>
  );
}

function ScheduleModal({ schedule, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState(schedule);
  const [suites, setSuites] = useState([]);
  const [envs, setEnvs] = useState([]);
  const [preview, setPreview] = useState(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    Promise.all([api.get('/suites'), api.get('/environments')]).then(([s, e]) => {
      setSuites(s);
      setEnvs(e);
    });
  }, []);

  useEffect(() => {
    const t = setTimeout(() => {
      api
        .post('/schedules/preview', { cron: form.cron })
        .then((p) => setPreview({ ok: true, ...p }))
        .catch((err) => setPreview({ ok: false, error: err.message }));
    }, 300);
    return () => clearTimeout(t);
  }, [form.cron]);

  const preset = PRESETS.find(([c]) => c === form.cron)?.[0] ?? 'custom';

  const save = async () => {
    setSaving(true);
    try {
      const body = {
        name: form.name,
        cron: form.cron,
        suiteId: form.suiteId === '' ? null : Number(form.suiteId),
        environmentId: form.environmentId === '' ? null : Number(form.environmentId),
        enabled: form.enabled,
      };
      if (form.id) await api.put(`/schedules/${form.id}`, body);
      else await api.post('/schedules', body);
      toast.success('Schedule saved', form.name);
      onSaved();
    } catch (err) {
      toast.error('Save failed', err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      title={form.id ? 'Edit schedule' : 'New schedule'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={saving || !form.name.trim() || !preview?.ok}>
            Save schedule
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 14 }}>
        <label className="field">
          <span>Name</span>
          <input className="input" autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Smoke health check" />
        </label>
        <div className="form-grid">
          <label className="field">
            <span>What to run</span>
            <select className="select" value={form.suiteId} onChange={(e) => setForm({ ...form, suiteId: e.target.value })}>
              <option value="">All enabled tests</option>
              {suites.map((s) => (
                <option key={s.id} value={s.id}>
                  Suite: {s.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Environment</span>
            <select className="select" value={form.environmentId} onChange={(e) => setForm({ ...form, environmentId: e.target.value })}>
              <option value="">Default environment</option>
              {envs.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Frequency</span>
            <select className="select" value={preset} onChange={(e) => e.target.value !== 'custom' && setForm({ ...form, cron: e.target.value })}>
              {PRESETS.map(([c, l]) => (
                <option key={c} value={c}>
                  {l}
                </option>
              ))}
              <option value="custom">Custom (cron)</option>
            </select>
          </label>
          <label className="field">
            <span>Cron expression</span>
            <input className="input mono" value={form.cron} onChange={(e) => setForm({ ...form, cron: e.target.value })} placeholder="m h dom mon dow" />
          </label>
        </div>
        <div className={`notice small ${preview && !preview.ok ? 'notice-error' : ''}`}>
          <CalendarClock size={16} />
          {preview?.ok ? (
            <div>
              <strong>{preview.description}</strong>
              <div className="ink-2">Next: {preview.upcoming.map((u) => new Date(u).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })).join(' · ')}</div>
            </div>
          ) : (
            <span>{preview?.error ?? 'Checking…'}</span>
          )}
        </div>
        <label className="check">
          <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
          Enabled
        </label>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------ notifications

const TYPES = {
  slack: { label: 'Slack', icon: Hash, help: 'Slack → Apps → Incoming Webhooks → Add to a channel, then paste the https://hooks.slack.com/… URL.' },
  teams: { label: 'Microsoft Teams', icon: BellRing, help: 'In a Teams channel: Workflows → "Post to a channel when a webhook request is received", then paste the URL it gives you.' },
  webhook: { label: 'Webhook', icon: Webhook, help: 'Any endpoint that accepts a JSON POST: run status, counts, AI summary, failures with diagnoses, and a link.' },
};

const maskUrl = (url) => {
  try {
    const u = new URL(url);
    const tail = u.pathname.length > 12 ? `…${u.pathname.slice(-6)}` : u.pathname;
    return `${u.host}${tail}`;
  } catch {
    return url;
  }
};

function Channels() {
  const toast = useToast();
  const { data: channels, error, loading, reload } = useFetch('/notifications');
  useLiveReload(reload, ['channel:updated'], 300);
  const [editing, setEditing] = useState(null);
  const [testing, setTesting] = useState(null);

  const sendTest = async (c) => {
    setTesting(c.id);
    try {
      const res = await api.post(`/notifications/${c.id}/test`);
      res.ok ? toast.success('Test message sent', c.name) : toast.error('Delivery failed', res.error);
      reload(true);
    } finally {
      setTesting(null);
    }
  };
  const toggle = async (c) => {
    await api.put(`/notifications/${c.id}`, { enabled: !c.enabled });
    reload(true);
  };
  const remove = async (c) => {
    if (!window.confirm(`Delete "${c.name}"?`)) return;
    await api.del(`/notifications/${c.id}`);
    reload(true);
  };

  if (error) return <ErrorState error={error} onRetry={reload} />;

  return (
    <div className="card">
      <div className="card-head">
        <BellRing size={18} style={{ color: 'var(--primary)' }} />
        <h3>Notifications</h3>
        <span className="sub">Run results with the AI summary, sent to Slack, Teams or a webhook</span>
        <span className="spacer" />
        <button className="btn btn-dark btn-sm" onClick={() => setEditing({ name: '', type: 'slack', url: '', notifyOn: 'failures', scope: 'all', enabled: true })}>
          <Plus size={13} /> Add channel
        </button>
      </div>
      {loading ? (
        <Loading rows={2} />
      ) : channels.length === 0 ? (
        <Empty icon={BellRing} title="No channels yet">
          Connect Slack or Teams to hear about failing runs, with the AI&apos;s explanation, as soon as they happen.
        </Empty>
      ) : (
        <div className="grid grid-3">
          {channels.map((c) => {
            const T = TYPES[c.type];
            return (
              <div key={c.id} className="card" style={{ boxShadow: 'none', padding: 16, opacity: c.enabled ? 1 : 0.65 }}>
                <div className="row" style={{ flexWrap: 'nowrap', marginBottom: 8 }}>
                  <span className="stat-icon">
                    <T.icon size={16} />
                  </span>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="cell-title truncate">{c.name}</div>
                    <div className="cell-sub truncate" title={c.url}>
                      {T.label} · {maskUrl(c.url)}
                    </div>
                  </div>
                  <label className="check" title={c.enabled ? 'Enabled' : 'Disabled'}>
                    <input type="checkbox" checked={c.enabled} onChange={() => toggle(c)} aria-label="Enabled" />
                  </label>
                </div>
                <div className="row" style={{ gap: 6, marginBottom: 10 }}>
                  <span className="chip">{c.notifyOn === 'failures' ? 'Failed runs only' : 'Every run'}</span>
                  <span className="chip">{c.scope === 'scheduled' ? 'Scheduled runs' : 'All runs'}</span>
                </div>
                <div className="small" style={{ minHeight: 20 }}>
                  {c.lastStatus === 'ok' && (
                    <span className="delta-up">
                      <CheckCircle2 size={13} style={{ verticalAlign: -2 }} /> Delivered {timeAgo(c.lastSentAt)}
                    </span>
                  )}
                  {c.lastStatus === 'error' && (
                    <span className="error-text" title={c.lastError}>
                      <XCircle size={13} style={{ verticalAlign: -2 }} /> Failed {timeAgo(c.lastSentAt)}: {c.lastError}
                    </span>
                  )}
                  {!c.lastStatus && <span className="muted">Nothing sent yet</span>}
                </div>
                <div className="row" style={{ marginTop: 10, gap: 4 }}>
                  <button className="btn btn-sm" onClick={() => sendTest(c)} disabled={testing === c.id}>
                    <Send size={13} /> Send test
                  </button>
                  <span className="spacer" />
                  <button className="btn btn-ghost btn-icon btn-sm" onClick={() => setEditing(c)} aria-label={`Edit ${c.name}`}>
                    <Pencil size={14} />
                  </button>
                  <button className="btn btn-ghost btn-icon btn-sm btn-danger" onClick={() => remove(c)} aria-label={`Delete ${c.name}`}>
                    <Trash2 size={14} />
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}
      {editing && (
        <ChannelModal
          channel={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            reload(true);
          }}
        />
      )}
    </div>
  );
}

function ChannelModal({ channel, onClose, onSaved }) {
  const toast = useToast();
  const [form, setForm] = useState(channel);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      const body = { name: form.name, type: form.type, url: form.url, notifyOn: form.notifyOn, scope: form.scope, enabled: form.enabled };
      if (form.id) await api.put(`/notifications/${form.id}`, body);
      else await api.post('/notifications', body);
      toast.success('Channel saved', 'Use "Send test" to check delivery.');
      onSaved();
    } catch (err) {
      toast.error('Save failed', err.details?.join('; ') ?? err.message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      title={form.id ? 'Edit channel' : 'Add notification channel'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={save} disabled={saving || !form.name.trim() || !form.url.trim()}>
            Save channel
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 14 }}>
        <div className="segmented">
          {Object.entries(TYPES).map(([k, t]) => (
            <button key={k} className={form.type === k ? 'active' : ''} onClick={() => setForm({ ...form, type: k })}>
              <t.icon size={13} /> {t.label}
            </button>
          ))}
        </div>
        <label className="field">
          <span>Name</span>
          <input className="input" autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. #qa-alerts" />
        </label>
        <label className="field">
          <span>Webhook URL</span>
          <input className="input mono" value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://…" />
          <span className="hint">{TYPES[form.type].help}</span>
        </label>
        <div className="form-grid">
          <label className="field">
            <span>Notify on</span>
            <select className="select" value={form.notifyOn} onChange={(e) => setForm({ ...form, notifyOn: e.target.value })}>
              <option value="failures">Failed runs only</option>
              <option value="always">Every run</option>
            </select>
          </label>
          <label className="field">
            <span>Which runs</span>
            <select className="select" value={form.scope} onChange={(e) => setForm({ ...form, scope: e.target.value })}>
              <option value="all">All runs</option>
              <option value="scheduled">Scheduled runs only</option>
            </select>
          </label>
        </div>
        <label className="check">
          <input type="checkbox" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />
          Enabled
        </label>
        <p className="hint" style={{ margin: 0 }}>
          The webhook URL is stored in the local database. Anyone with access to this instance can read it.
        </p>
      </div>
    </Modal>
  );
}
