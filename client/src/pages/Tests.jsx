import { Copy, Download, FlaskConical, Link2, Pencil, Play, Plus, Search, Sparkles, Table2, Trash2, Upload } from 'lucide-react';
import { GenerateModal } from '../components/GenerateModal.jsx';
import { useMemo, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { usePageMeta, useRunLauncher } from '../components/Layout.jsx';
import { Empty, ErrorState, Loading, StatusBadge, TypeChip } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { useLiveReload } from '../lib/events.jsx';
import { downloadJson, fmtDuration, timeAgo } from '../lib/format.js';
import { useFetch, useLocalState } from '../lib/hooks.js';
import { useToast } from '../lib/toast.jsx';

export default function Tests() {
  usePageMeta('Test cases', 'Author, organise and run API and script tests');
  const toast = useToast();
  const navigate = useNavigate();
  const launch = useRunLauncher();
  const fileRef = useRef(null);
  const { data: tests, error, loading, reload } = useFetch('/tests');
  const { data: suites } = useFetch('/suites');
  useLiveReload(reload, ['run:finished'], 600);

  const [query, setQuery] = useState('');
  const [filters, setFilters] = useLocalState('tf-test-filters', { type: '', suiteId: '', status: '' });
  const [selected, setSelected] = useState(new Set());
  const [generating, setGenerating] = useState(false);

  const visible = useMemo(() => {
    if (!tests) return [];
    const q = query.trim().toLowerCase();
    return tests.filter(
      (t) =>
        (!q || t.name.toLowerCase().includes(q) || t.description.toLowerCase().includes(q) || t.tags.some((tag) => tag.includes(q))) &&
        (!filters.type || t.type === filters.type) &&
        (!filters.suiteId || String(t.suiteId) === String(filters.suiteId)) &&
        (!filters.status || (filters.status === 'never' ? !t.lastStatus : t.lastStatus === filters.status)),
    );
  }, [tests, query, filters]);

  /** Variables this test uses that another test captures (chaining). */
  const chainedNeeds = (t) => (t.needs ?? []).filter((v) => tests.some((o) => o.id !== t.id && o.provides?.includes(v)));

  const allSelected = visible.length > 0 && visible.every((t) => selected.has(t.id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(visible.map((t) => t.id)));
  const toggle = (id) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  const runOne = async (test) => {
    try {
      const run = await api.post('/runs', { testIds: [test.id] });
      navigate(`/runs/${run.id}`);
    } catch (err) {
      toast.error('Could not start run', err.message);
    }
  };

  const duplicate = async (test) => {
    try {
      const copy = await api.post(`/tests/${test.id}/duplicate`);
      toast.success('Test duplicated', copy.name);
      reload(true);
    } catch (err) {
      toast.error('Duplicate failed', err.message);
    }
  };

  const remove = async (test) => {
    if (!window.confirm(`Delete "${test.name}"? Its run history is kept.`)) return;
    try {
      await api.del(`/tests/${test.id}`);
      toast.success('Test deleted');
      setSelected((s) => {
        const next = new Set(s);
        next.delete(test.id);
        return next;
      });
      reload(true);
    } catch (err) {
      toast.error('Delete failed', err.message);
    }
  };

  const toggleEnabled = async (test) => {
    try {
      await api.put(`/tests/${test.id}`, { enabled: !test.enabled });
      reload(true);
    } catch (err) {
      toast.error('Update failed', err.message);
    }
  };

  const exportTests = async () => {
    try {
      downloadJson('testforge-tests.json', await api.get('/tests/export'));
    } catch (err) {
      toast.error('Export failed', err.message);
    }
  };

  const importTests = async (file) => {
    try {
      const parsed = JSON.parse(await file.text());
      const res = await api.post('/tests/import', parsed);
      toast.success('Import complete', `${res.imported} tests imported`);
      reload(true);
    } catch (err) {
      toast.error('Import failed', err.message);
    } finally {
      fileRef.current.value = '';
    }
  };

  if (error) return <ErrorState error={error} onRetry={reload} />;

  return (
    <div className="card card-flush">
      <div className="card-head" style={{ paddingBottom: 16 }}>
        <div className="search">
          <Search size={15} />
          <input className="input" placeholder="Search name, description or tag…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search tests" />
        </div>
        <select className="select select-sm" style={{ width: 'auto' }} value={filters.type} onChange={(e) => setFilters({ ...filters, type: e.target.value })} aria-label="Type">
          <option value="">All types</option>
          <option value="http">HTTP</option>
          <option value="script">Script</option>
        </select>
        <select className="select select-sm" style={{ width: 'auto' }} value={filters.suiteId} onChange={(e) => setFilters({ ...filters, suiteId: e.target.value })} aria-label="Suite">
          <option value="">All suites</option>
          {suites?.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name}
            </option>
          ))}
        </select>
        <select className="select select-sm" style={{ width: 'auto' }} value={filters.status} onChange={(e) => setFilters({ ...filters, status: e.target.value })} aria-label="Last status">
          <option value="">Any status</option>
          <option value="passed">Passing</option>
          <option value="failed">Failing</option>
          <option value="error">Erroring</option>
          <option value="never">Never run</option>
        </select>
        <span className="spacer" />
        {selected.size > 0 && (
          <button className="btn btn-primary btn-sm" onClick={() => launch({ scope: 'selected', testIds: [...selected] })}>
            <Play size={13} /> Run {selected.size} selected
          </button>
        )}
        <input ref={fileRef} type="file" accept="application/json" hidden onChange={(e) => e.target.files[0] && importTests(e.target.files[0])} />
        <button className="btn btn-sm" onClick={() => fileRef.current.click()}>
          <Upload size={13} /> Import
        </button>
        <button className="btn btn-sm" onClick={exportTests}>
          <Download size={13} /> Export
        </button>
        <button className="btn btn-sm" onClick={() => setGenerating(true)}>
          <Sparkles size={13} /> Generate
        </button>
        <Link className="btn btn-dark btn-sm" to="/tests/new">
          <Plus size={13} /> New test
        </Link>
      </div>
      {generating && <GenerateModal onClose={() => setGenerating(false)} onImported={() => reload(true)} />}

      {loading ? (
        <div style={{ padding: 20 }}>
          <Loading rows={6} />
        </div>
      ) : tests.length === 0 ? (
        <Empty
          icon={FlaskConical}
          title="No test cases yet"
          action={
            <Link className="btn btn-primary" to="/tests/new">
              <Plus size={15} /> Create a test case
            </Link>
          }
        >
          Create an HTTP API test with assertions, or write a JavaScript test script.
        </Empty>
      ) : visible.length === 0 ? (
        <Empty icon={Search} title="No matches">
          No tests match the current search and filters.
        </Empty>
      ) : (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 36 }}>
                  <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all" style={{ accentColor: 'var(--primary)' }} />
                </th>
                <th>Test</th>
                <th>Type</th>
                <th className="hide-sm">Suite</th>
                <th>Last result</th>
                <th className="num hide-sm">Duration</th>
                <th className="hide-sm">Enabled</th>
                <th style={{ textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {visible.map((t) => (
                <tr key={t.id} style={{ opacity: t.enabled ? 1 : 0.6 }}>
                  <td>
                    <input type="checkbox" checked={selected.has(t.id)} onChange={() => toggle(t.id)} aria-label={`Select ${t.name}`} style={{ accentColor: 'var(--primary)' }} />
                  </td>
                  <td style={{ maxWidth: 380 }}>
                    <Link to={`/tests/${t.id}`} className="cell-title">
                      {t.name}
                    </Link>
                    <div className="cell-sub truncate">
                      {t.type === 'http' && (
                        <>
                          <span className={`method method-${t.config.method}`}>{t.config.method}</span>{' '}
                        </>
                      )}
                      {t.type === 'http' ? t.config.url : t.description}
                    </div>
                    {(t.tags.length > 0 || t.provides?.length > 0 || t.datasetRows > 0 || chainedNeeds(t).length > 0) && (
                      <div className="row" style={{ gap: 4, marginTop: 4 }}>
                        {t.datasetRows > 0 && (
                          <span className="chip chip-script" title="Data-driven: runs once per dataset row">
                            <Table2 size={11} /> {t.datasetRows} rows
                          </span>
                        )}
                        {t.provides?.map((v) => (
                          <span key={`p-${v}`} className="chip chip-http" title={`Captures {{${v}}} for later tests`}>
                            <Link2 size={11} /> sets {v}
                          </span>
                        ))}
                        {chainedNeeds(t).map((v) => (
                          <span key={`n-${v}`} className="chip chip-http" title={`Uses {{${v}}} captured by another test`}>
                            <Link2 size={11} /> uses {v}
                          </span>
                        ))}
                        {t.tags.map((tag) => (
                          <span key={tag} className="chip">
                            {tag}
                          </span>
                        ))}
                      </div>
                    )}
                  </td>
                  <td>
                    <TypeChip type={t.type} />
                  </td>
                  <td className="hide-sm ink-2">{t.suiteName ?? '—'}</td>
                  <td>
                    <StatusBadge status={t.lastStatus} />
                    {t.lastRunAt && <div className="cell-sub">{timeAgo(t.lastRunAt)}</div>}
                  </td>
                  <td className="num hide-sm">{fmtDuration(t.lastDurationMs)}</td>
                  <td className="hide-sm">
                    <label className="check">
                      <input type="checkbox" checked={t.enabled} onChange={() => toggleEnabled(t)} aria-label="Enabled" />
                    </label>
                  </td>
                  <td>
                    <div className="row" style={{ justifyContent: 'flex-end', gap: 2, flexWrap: 'nowrap' }}>
                      <button className="btn btn-ghost btn-icon btn-sm" title="Run" aria-label={`Run ${t.name}`} onClick={() => runOne(t)}>
                        <Play size={14} />
                      </button>
                      <Link className="btn btn-ghost btn-icon btn-sm" title="Edit" aria-label={`Edit ${t.name}`} to={`/tests/${t.id}`}>
                        <Pencil size={14} />
                      </Link>
                      <button className="btn btn-ghost btn-icon btn-sm" title="Duplicate" aria-label={`Duplicate ${t.name}`} onClick={() => duplicate(t)}>
                        <Copy size={14} />
                      </button>
                      <button className="btn btn-ghost btn-icon btn-sm btn-danger" title="Delete" aria-label={`Delete ${t.name}`} onClick={() => remove(t)}>
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
    </div>
  );
}
