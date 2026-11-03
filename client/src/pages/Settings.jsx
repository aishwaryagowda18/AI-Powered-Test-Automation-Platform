import { Bot, Check, Cpu, Database, Globe2, Loader2, Plus, Save, Sparkles, Star, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { KeyValueEditor } from '../components/Editors.jsx';
import { usePageMeta } from '../components/Layout.jsx';
import { ErrorState, Loading } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { downloadJson } from '../lib/format.js';
import { useFetch } from '../lib/hooks.js';
import { useToast } from '../lib/toast.jsx';

export default function Settings() {
  usePageMeta('Settings', 'Environments, execution and AI configuration');
  return (
    <div className="grid grid-main-side">
      <Environments />
      <div className="stack">
        <RunnerSettings />
        <AiSettings />
        <DataSettings />
      </div>
    </div>
  );
}

function Environments() {
  const toast = useToast();
  const { data: envs, error, loading, reload } = useFetch('/environments');
  // The editor's draft is the single source of truth for which environment is selected.
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);

  const toDraft = (env) => ({ ...env, rows: Object.entries(env.variables).map(([key, value]) => ({ key, value })) });

  // Keep the editor in sync with the server list: stay on the same environment
  // when it still exists, keep an unsaved new one, otherwise show the default.
  useEffect(() => {
    if (!envs?.length) return;
    setDraft((current) => {
      if (current && !current.id) return current;
      const env = envs.find((e) => e.id === current?.id) ?? envs.find((e) => e.isDefault) ?? envs[0];
      return toDraft(env);
    });
  }, [envs]);

  const save = async () => {
    setSaving(true);
    try {
      const body = { name: draft.name, isDefault: draft.isDefault, variables: Object.fromEntries(draft.rows.filter((r) => r.key.trim()).map((r) => [r.key.trim(), r.value])) };
      const saved = draft.id ? await api.put(`/environments/${draft.id}`, body) : await api.post('/environments', body);
      setDraft(toDraft(saved));
      toast.success('Environment saved', saved.name);
      await reload(true);
    } catch (err) {
      toast.error('Save failed', err.message);
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    if (envs.length === 1) {
      toast.error('Cannot delete', 'Keep at least one environment. Edit this one instead.');
      return;
    }
    if (!window.confirm(`Delete environment "${draft.name}"? Tests and schedules that use it will fall back to the default environment.`)) return;
    try {
      await api.del(`/environments/${draft.id}`);
      toast.success('Environment deleted', draft.name);
      setDraft(null);
      await reload(true);
    } catch (err) {
      toast.error('Delete failed', err.message);
    }
  };

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading) return <Loading rows={6} />;

  return (
    <div className="card">
      <div className="card-head">
        <Globe2 size={18} style={{ color: 'var(--primary)' }} />
        <h3>Environments</h3>
        <span className="sub">Variables referenced as {'{{name}}'} in tests</span>
        <span className="spacer" />
        <button className="btn btn-sm btn-dark" onClick={() => setDraft({ name: 'New environment', isDefault: false, rows: [{ key: 'baseUrl', value: '' }] })}>
          <Plus size={13} /> New environment
        </button>
      </div>
      <div className="row" style={{ marginBottom: 16, gap: 6 }}>
        {envs.map((e) => (
          <button key={e.id} className={`btn btn-sm ${draft?.id === e.id ? 'btn-primary' : ''}`} onClick={() => setDraft(toDraft(e))}>
            {e.isDefault && <Star size={12} />} {e.name}
          </button>
        ))}
        {draft && !draft.id && <span className="badge badge-running">unsaved</span>}
      </div>
      {draft && (
        <div className="stack" style={{ gap: 14 }}>
          <div className="form-grid">
            <label className="field">
              <span>Name</span>
              <input className="input" value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
            </label>
            <label className="check" style={{ alignSelf: 'end', paddingBottom: 10 }}>
              <input type="checkbox" checked={draft.isDefault} onChange={(e) => setDraft({ ...draft, isDefault: e.target.checked })} />
              Default environment
            </label>
          </div>
          <div>
            <div className="label" style={{ marginBottom: 8 }}>
              Variables
            </div>
            <KeyValueEditor rows={draft.rows} onChange={(rows) => setDraft({ ...draft, rows })} keyPlaceholder="name" valuePlaceholder="value, may use {{$serverUrl}}" addLabel="Add variable" />
            <p className="hint">
              Built-ins: <code>{'{{$serverUrl}}'}</code> <code>{'{{$timestamp}}'}</code> <code>{'{{$isoDate}}'}</code> <code>{'{{$uuid}}'}</code> <code>{'{{$randomInt}}'}</code>. Values are stored in
              plain text in the local database. Don&apos;t put production secrets here.
            </p>
          </div>
          <div className="row">
            {draft.id && (
              <button className="btn btn-sm btn-danger" onClick={remove}>
                <Trash2 size={13} /> Delete
              </button>
            )}
            <span className="spacer" />
            <button className="btn btn-primary btn-sm" onClick={save} disabled={saving || !draft.name.trim()}>
              {saving ? <Loader2 size={13} className="spin" /> : <Save size={13} />} Save environment
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function RunnerSettings() {
  const toast = useToast();
  const { data, reload } = useFetch('/settings');
  const [form, setForm] = useState(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => {
    if (data) setForm(data.settings);
  }, [data]);

  const save = async () => {
    try {
      await api.put('/settings', form);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
      reload(true);
    } catch (err) {
      toast.error('Save failed', err.message);
    }
  };

  if (!form) return <div className="card"><Loading rows={3} /></div>;
  return (
    <div className="card">
      <div className="card-head">
        <Cpu size={18} style={{ color: 'var(--primary)' }} />
        <h3>Execution</h3>
      </div>
      <div className="form-grid">
        <label className="field">
          <span>Parallel workers</span>
          <input className="input" type="number" min={1} max={16} value={form.maxConcurrency} onChange={(e) => setForm({ ...form, maxConcurrency: Number(e.target.value) })} />
        </label>
        <label className="field">
          <span>Default timeout (ms)</span>
          <input className="input" type="number" min={100} value={form.defaultTimeoutMs} onChange={(e) => setForm({ ...form, defaultTimeoutMs: Number(e.target.value) })} />
        </label>
        <label className="check full">
          <input type="checkbox" checked={form.autoAnalyze} onChange={(e) => setForm({ ...form, autoAnalyze: e.target.checked })} />
          Analyze failures automatically when a run finishes
        </label>
        <label className="field full">
          <span>AI analyses per run (auto)</span>
          <input className="input" type="number" min={0} max={50} value={form.aiAutoAnalyzeLimit} onChange={(e) => setForm({ ...form, aiAutoAnalyzeLimit: Number(e.target.value) })} />
          <span className="hint">Caps API spend. Remaining failures get the instant heuristic analysis.</span>
        </label>
      </div>
      <div className="row mt-16">
        <span className="spacer" />
        <button className="btn btn-primary btn-sm" onClick={save}>
          {saved ? <Check size={13} /> : <Save size={13} />} {saved ? 'Saved' : 'Save settings'}
        </button>
      </div>
    </div>
  );
}

function AiSettings() {
  const { data } = useFetch('/ai/status');
  if (!data) return null;
  return (
    <div className="card">
      <div className="card-head">
        {data.enabled ? <Sparkles size={18} style={{ color: 'var(--primary)' }} /> : <Bot size={18} />}
        <h3>AI analysis</h3>
        <span className={`badge ${data.enabled ? 'badge-passed' : 'badge-neutral'}`}>{data.enabled ? `${data.providerLabel} connected` : 'Heuristic mode'}</span>
      </div>
      {data.enabled ? (
        <dl className="kv-table">
          <dt>Provider</dt>
          <dd>{data.providerLabel}</dd>
          <dt>Model</dt>
          <dd>{data.model}</dd>
          {data.fallbackModels?.length > 0 && (
            <>
              <dt>Fallback models</dt>
              <dd>{data.fallbackModels.join(', ')}</dd>
            </>
          )}
          {data.effort && (
            <>
              <dt>Effort</dt>
              <dd>{data.effort}</dd>
            </>
          )}
          {data.lastError && (
            <>
              <dt>Last error</dt>
              <dd className="error-text">{data.lastError}</dd>
            </>
          )}
        </dl>
      ) : (
        <div className="small ink-2">
          <p style={{ marginTop: 0 }}>To enable AI root-cause analysis, test generation and fixes:</p>
          <pre className="code-block">{`# .env
GEMINI_API_KEY=...            # aistudio.google.com/apikey
GEMINI_MODEL=gemini-3.5-flash # optional
AI_EFFORT=medium           # low | medium | high`}</pre>
          <p>Then restart the server. The key stays on the server and is never sent to the browser.</p>
        </div>
      )}
    </div>
  );
}

function DataSettings() {
  const toast = useToast();
  const exportTests = async () => downloadJson('testforge-tests.json', await api.get('/tests/export'));
  const clearRuns = async () => {
    if (!window.confirm('Delete ALL run history and results? Test cases are kept.')) return;
    try {
      await api.del('/runs');
      toast.success('Run history cleared');
    } catch (err) {
      toast.error('Could not clear', err.message);
    }
  };
  return (
    <div className="card">
      <div className="card-head">
        <Database size={18} style={{ color: 'var(--primary)' }} />
        <h3>Data</h3>
      </div>
      <div className="btn-group">
        <button className="btn btn-sm" onClick={exportTests}>
          Export test cases
        </button>
        <button className="btn btn-sm btn-danger" onClick={clearRuns}>
          <Trash2 size={13} /> Clear run history
        </button>
      </div>
    </div>
  );
}
