import { Layers, ListChecks, Loader2, Play, Rocket } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api } from '../lib/api.js';
import { useToast } from '../lib/toast.jsx';
import { Modal, TypeChip } from './ui.jsx';

/**
 * Launch a run. `preset` may pre-select { scope: 'all'|'suite'|'selected', suiteId, testIds }.
 */
export function RunModal({ preset = {}, onClose }) {
  const navigate = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const [scope, setScope] = useState(preset.scope ?? (preset.testIds?.length ? 'selected' : preset.suiteId ? 'suite' : 'all'));
  const [suiteId, setSuiteId] = useState(preset.suiteId ?? '');
  const [testIds, setTestIds] = useState(new Set(preset.testIds ?? []));
  const [environmentId, setEnvironmentId] = useState('');
  const [name, setName] = useState('');
  const [suites, setSuites] = useState([]);
  const [tests, setTests] = useState([]);
  const [envs, setEnvs] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    Promise.all([api.get('/suites'), api.get('/tests'), api.get('/environments')])
      .then(([s, t, e]) => {
        setSuites(s);
        setTests(t);
        setEnvs(e);
        if (!preset.suiteId && s[0]) setSuiteId(s[0].id);
        const def = e.find((x) => x.isDefault) ?? e[0];
        if (def) setEnvironmentId(def.id);
      })
      .catch((err) => toast.error('Could not load run options', err.message));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const enabledCount = useMemo(() => tests.filter((t) => t.enabled).length, [tests]);
  const suiteCount = useMemo(() => tests.filter((t) => t.enabled && t.suiteId === Number(suiteId)).length, [tests, suiteId]);
  const count = scope === 'all' ? enabledCount : scope === 'suite' ? suiteCount : testIds.size;

  const toggle = (id) =>
    setTestIds((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const start = async () => {
    setBusy(true);
    try {
      const body = { environmentId: environmentId || undefined, name: name || undefined };
      if (scope === 'suite') body.suiteId = Number(suiteId);
      if (scope === 'selected') body.testIds = [...testIds];
      const run = await api.post('/runs', body);
      toast.success('Run started', `${run.name} · ${run.total} tests`);
      onClose();
      // On the Live monitor, stay put so the run can be watched streaming in.
      if (location.pathname !== '/live') navigate(`/runs/${run.id}`);
    } catch (err) {
      toast.error('Could not start run', err.message);
    } finally {
      setBusy(false);
    }
  };

  const options = [
    { key: 'all', icon: Rocket, title: 'All enabled tests', sub: `${enabledCount} tests across every suite` },
    { key: 'suite', icon: Layers, title: 'A test suite', sub: 'Run one suite end to end' },
    { key: 'selected', icon: ListChecks, title: 'Hand-picked tests', sub: 'Choose exactly what to run' },
  ];

  return (
    <Modal
      title="Run tests"
      subtitle="Execution streams live. You can watch progress and logs in real time."
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={start} disabled={busy || count === 0}>
            {busy ? <Loader2 size={15} className="spin" /> : <Play size={15} />}
            Run {count} {count === 1 ? 'test' : 'tests'}
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 10 }}>
        {options.map((o) => (
          <label key={o.key} className={`option-card ${scope === o.key ? 'selected' : ''}`}>
            <input type="radio" name="scope" checked={scope === o.key} onChange={() => setScope(o.key)} />
            <o.icon size={18} style={{ color: 'var(--primary)', marginTop: 2 }} />
            <div>
              <div style={{ fontWeight: 700 }}>{o.title}</div>
              <div className="small muted">{o.sub}</div>
            </div>
          </label>
        ))}

        {scope === 'suite' && (
          <label className="field">
            <span>Suite</span>
            <select className="select" value={suiteId} onChange={(e) => setSuiteId(e.target.value)}>
              {suites.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.name} ({s.testCount})
                </option>
              ))}
            </select>
          </label>
        )}

        {scope === 'selected' && (
          <div className="picker">
            {tests.map((t) => (
              <label key={t.id}>
                <input type="checkbox" checked={testIds.has(t.id)} onChange={() => toggle(t.id)} style={{ accentColor: 'var(--primary)' }} />
                <TypeChip type={t.type} />
                <span className="truncate" style={{ flex: 1 }}>
                  {t.name}
                </span>
                <span className="small muted">{t.suiteName}</span>
              </label>
            ))}
          </div>
        )}

        <div className="form-grid">
          <label className="field">
            <span>Environment</span>
            <select className="select" value={environmentId} onChange={(e) => setEnvironmentId(e.target.value)}>
              {envs.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.name}
                  {e.isDefault ? ' (default)' : ''}
                </option>
              ))}
            </select>
          </label>
          <label className="field">
            <span>Run name (optional)</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Release 2.5 smoke" />
          </label>
        </div>
      </div>
    </Modal>
  );
}
