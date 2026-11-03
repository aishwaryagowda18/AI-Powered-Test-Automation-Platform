import { Layers, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { usePageMeta } from '../components/Layout.jsx';
import { Empty, ErrorState, Loading, Modal, StatusBadge } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useLiveReload } from '../lib/events.jsx';
import { useFetch } from '../lib/hooks.js';
import { useToast } from '../lib/toast.jsx';

export default function Suites() {
  usePageMeta('Suites', 'Group related tests and run them together');
  const toast = useToast();
  const navigate = useNavigate();
  const { data: suites, error, loading, reload } = useFetch('/suites');
  useLiveReload(reload, ['run:finished'], 600);
  const [editing, setEditing] = useState(null);

  const run = async (suite) => {
    try {
      const r = await api.post('/runs', { suiteId: suite.id });
      navigate(`/runs/${r.id}`);
    } catch (err) {
      toast.error('Could not start run', err.message);
    }
  };

  const remove = async (suite) => {
    if (!window.confirm(`Delete suite "${suite.name}"? Its ${suite.testCount} tests are kept, ungrouped.`)) return;
    try {
      await api.del(`/suites/${suite.id}`);
      reload(true);
    } catch (err) {
      toast.error('Delete failed', err.message);
    }
  };

  const save = async (form) => {
    try {
      if (form.id) await api.put(`/suites/${form.id}`, form);
      else await api.post('/suites', form);
      toast.success(form.id ? 'Suite updated' : 'Suite created', form.name);
      setEditing(null);
      reload(true);
    } catch (err) {
      toast.error('Save failed', err.message);
    }
  };

  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (loading) return <Loading rows={5} />;

  return (
    <>
      <div className="row" style={{ marginBottom: 16 }}>
        <span className="muted">{suites.length} suites</span>
        <span className="spacer" />
        <button className="btn btn-dark btn-sm" onClick={() => setEditing({ name: '', description: '' })}>
          <Plus size={13} /> New suite
        </button>
      </div>
      {suites.length === 0 ? (
        <div className="card">
          <Empty
            icon={Layers}
            title="No suites yet"
            action={
              <button className="btn btn-primary" onClick={() => setEditing({ name: '', description: '' })}>
                <Plus size={15} /> Create a suite
              </button>
            }
          >
            Suites group tests for targeted runs, like smoke, regression or a single service.
          </Empty>
        </div>
      ) : (
        <div className="grid grid-3">
          {suites.map((s) => (
            <div key={s.id} className="card" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <div className="row" style={{ flexWrap: 'nowrap' }}>
                <span className="stat-icon">
                  <Layers size={16} />
                </span>
                <h3 className="truncate" style={{ flex: 1, fontSize: 17 }}>
                  {s.name}
                </h3>
                <button className="btn btn-ghost btn-icon btn-sm" onClick={() => setEditing(s)} aria-label={`Edit ${s.name}`}>
                  <Pencil size={14} />
                </button>
                <button className="btn btn-ghost btn-icon btn-sm btn-danger" onClick={() => remove(s)} aria-label={`Delete ${s.name}`}>
                  <Trash2 size={14} />
                </button>
              </div>
              <p className="ink-2 small" style={{ margin: 0, flex: 1 }}>
                {s.description || 'No description.'}
              </p>
              <div className="row small">
                <Link to={`/tests`} onClick={() => localStorage.setItem('tf-test-filters', JSON.stringify({ type: '', status: '', suiteId: String(s.id) }))}>
                  {s.testCount} {s.testCount === 1 ? 'test' : 'tests'}
                </Link>
                <span className="muted">· last run</span>
                {s.lastRunId ? (
                  <Link to={`/runs/${s.lastRunId}`}>
                    <StatusBadge status={s.lastRunStatus} />
                  </Link>
                ) : (
                  <span className="muted">never</span>
                )}
              </div>
              <button className="btn btn-primary" onClick={() => run(s)} disabled={!s.testCount}>
                <Play size={14} /> Run suite
              </button>
            </div>
          ))}
        </div>
      )}
      {editing && <SuiteModal suite={editing} onSave={save} onClose={() => setEditing(null)} />}
    </>
  );
}

function SuiteModal({ suite, onSave, onClose }) {
  const [form, setForm] = useState(suite);
  return (
    <Modal
      title={suite.id ? 'Edit suite' : 'New suite'}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button className="btn btn-primary" onClick={() => onSave(form)} disabled={!form.name.trim()}>
            Save
          </button>
        </>
      }
    >
      <div className="stack" style={{ gap: 12 }}>
        <label className="field">
          <span>Name</span>
          <input className="input" autoFocus value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. Checkout regression" />
        </label>
        <label className="field">
          <span>Description</span>
          <textarea className="textarea" rows={3} style={{ minHeight: 80 }} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </label>
      </div>
    </Modal>
  );
}
