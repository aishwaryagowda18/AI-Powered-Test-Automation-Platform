import { ArrowLeft, Code2, FlaskConical, Globe, Link2, Loader2, Play, Save, Trash2, Zap } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AssertionEditor, DatasetEditor, ExtractEditor, KeyValueEditor } from '../components/Editors.jsx';
import { usePageMeta } from '../components/Layout.jsx';
import { ResultDetail } from '../components/ResultDetail.jsx';
import { ErrorState, Loading, Spark, StatusBadge } from '../components/ui.jsx';
import { api } from '../lib/api.js';
import { fmtDuration, timeAgo } from '../lib/format.js';
import { useFetch } from '../lib/hooks.js';
import { useToast } from '../lib/toast.jsx';

const SCRIPT_TEMPLATE = `// Available: http, expect, assert, log, sleep, vars, fetch
const res = await http.get(\`\${vars.baseUrl}/health\`);
expect(res.status, 'status').toBe(200);
expect(res.json.status).toBe('ok');
log('Health check took', res.durationMs, 'ms');
`;

const BLANK = {
  name: '',
  description: '',
  type: 'http',
  suiteId: '',
  tags: [],
  priority: 'medium',
  timeoutMs: 10000,
  retries: 0,
  enabled: true,
  config: { method: 'GET', url: '{{baseUrl}}/health', query: [], headers: [], bodyType: 'json', body: '', assertions: [{ type: 'status', operator: 'equals', expected: '200', target: '' }] },
};

const toRows = (v) => (Array.isArray(v) ? v : Object.entries(v ?? {}).map(([key, value]) => ({ key, value })));
const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];

export default function TestEditor() {
  const { id } = useParams();
  const isNew = !id;
  const navigate = useNavigate();
  const toast = useToast();
  const { data: existing, error, loading } = useFetch(isNew ? null : `/tests/${id}`);
  const { data: history } = useFetch(isNew ? null : `/tests/${id}/history?limit=20`);
  const { data: suites } = useFetch('/suites');
  const { data: envs } = useFetch('/environments');
  const { data: allTests } = useFetch('/tests');

  const [form, setForm] = useState(BLANK);
  const [tagText, setTagText] = useState('');
  const [section, setSection] = useState('assertions');
  const [saving, setSaving] = useState(false);
  const [trying, setTrying] = useState(false);
  const [tryResult, setTryResult] = useState(null);
  const [envId, setEnvId] = useState('');
  const [errors, setErrors] = useState([]);

  usePageMeta(isNew ? 'New test case' : form.name || 'Edit test case', isNew ? 'Define a request and its assertions, or write a script' : `Test #${id}`);

  useEffect(() => {
    if (existing) {
      setForm({
        ...existing,
        suiteId: existing.suiteId ?? '',
        config: existing.type === 'http' ? { query: [], headers: [], bodyType: 'json', body: '', assertions: [], ...existing.config, query: toRows(existing.config.query), headers: toRows(existing.config.headers) } : existing.config,
      });
      setTagText(existing.tags.join(', '));
    }
  }, [existing]);

  useEffect(() => {
    if (envs && !envId) setEnvId((envs.find((e) => e.isDefault) ?? envs[0])?.id ?? '');
  }, [envs, envId]);

  const set = (patch) => setForm((f) => ({ ...f, ...patch }));
  const setConfig = (patch) => setForm((f) => ({ ...f, config: { ...f.config, ...patch } }));

  const switchType = (type) => {
    if (type === form.type) return;
    set({ type, config: type === 'script' ? { code: SCRIPT_TEMPLATE } : BLANK.config });
  };

  const payload = () => ({
    ...form,
    name: form.name.trim() || 'Untitled test',
    suiteId: form.suiteId === '' ? null : Number(form.suiteId),
    tags: tagText.split(',').map((t) => t.trim()).filter(Boolean),
    timeoutMs: Number(form.timeoutMs),
    retries: Number(form.retries),
  });

  const save = async (andRun = false) => {
    if (!form.name.trim()) {
      setErrors(['Give the test a name']);
      return;
    }
    setSaving(true);
    setErrors([]);
    try {
      const body = payload();
      const saved = isNew ? await api.post('/tests', body) : await api.put(`/tests/${id}`, body);
      toast.success(isNew ? 'Test created' : 'Test saved', saved.name);
      if (andRun) {
        const run = await api.post('/runs', { testIds: [saved.id], environmentId: envId || undefined });
        navigate(`/runs/${run.id}`);
      } else if (isNew) navigate(`/tests/${saved.id}`, { replace: true });
    } catch (err) {
      setErrors(err.details ?? [err.message]);
      toast.error('Save failed', err.message);
    } finally {
      setSaving(false);
    }
  };

  const tryIt = async () => {
    setTrying(true);
    setTryResult(null);
    setErrors([]);
    try {
      setTryResult(await api.post('/tests/try', { test: payload(), environmentId: envId || undefined }));
    } catch (err) {
      setErrors(err.details ?? [err.message]);
    } finally {
      setTrying(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete "${form.name}"?`)) return;
    await api.del(`/tests/${id}`);
    toast.success('Test deleted');
    navigate('/tests');
  };

  if (error) return <ErrorState error={error} />;
  if (!isNew && (loading || !existing)) return <Loading rows={8} />;

  const cfg = form.config;
  const env = envs?.find((e) => String(e.id) === String(envId));

  return (
    <div className="stack">
      <div className="row">
        <Link to="/tests" className="btn btn-ghost btn-sm">
          <ArrowLeft size={14} /> All tests
        </Link>
        <span className="spacer" />
        {!isNew && (
          <button className="btn btn-sm btn-danger" onClick={remove}>
            <Trash2 size={13} /> Delete
          </button>
        )}
        <select className="select select-sm" style={{ width: 'auto' }} value={envId} onChange={(e) => setEnvId(e.target.value)} aria-label="Environment for Try it / Run">
          {envs?.map((e) => (
            <option key={e.id} value={e.id}>
              {e.name}
            </option>
          ))}
        </select>
        <button className="btn btn-sm" onClick={tryIt} disabled={trying}>
          {trying ? <Loader2 size={13} className="spin" /> : <Zap size={13} />} Try it
        </button>
        <button className="btn btn-sm" onClick={() => save(true)} disabled={saving}>
          <Play size={13} /> Save & run
        </button>
        <button className="btn btn-primary btn-sm" onClick={() => save(false)} disabled={saving}>
          {saving ? <Loader2 size={13} className="spin" /> : <Save size={13} />} Save
        </button>
      </div>

      {errors.length > 0 && (
        <div className="notice notice-error small">
          <div>
            {errors.map((e, i) => (
              <div key={i}>{e}</div>
            ))}
          </div>
        </div>
      )}

      <div className="grid grid-main-side">
        <div className="stack">
          <div className="card">
            <div className="card-head">
              <FlaskConical size={18} style={{ color: 'var(--primary)' }} />
              <h3>Details</h3>
              <span className="spacer" />
              <div className="segmented" role="radiogroup" aria-label="Test type">
                <button className={form.type === 'http' ? 'active' : ''} onClick={() => switchType('http')} aria-pressed={form.type === 'http'}>
                  <Globe size={13} /> HTTP API
                </button>
                <button className={form.type === 'script' ? 'active' : ''} onClick={() => switchType('script')} aria-pressed={form.type === 'script'}>
                  <Code2 size={13} /> Script
                </button>
              </div>
            </div>
            <div className="form-grid">
              <label className="field full">
                <span>Name</span>
                <input className="input" value={form.name} onChange={(e) => set({ name: e.target.value })} placeholder="e.g. Checkout returns order id" autoFocus={isNew} />
              </label>
              <label className="field full">
                <span>Description</span>
                <input className="input" value={form.description} onChange={(e) => set({ description: e.target.value })} placeholder="What does this test verify?" />
              </label>
              <label className="field">
                <span>Suite</span>
                <select className="select" value={form.suiteId} onChange={(e) => set({ suiteId: e.target.value })}>
                  <option value="">No suite</option>
                  {suites?.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
              <label className="field">
                <span>Tags</span>
                <input className="input" value={tagText} onChange={(e) => setTagText(e.target.value)} placeholder="smoke, auth" />
              </label>
              <label className="field">
                <span>Priority</span>
                <select className="select" value={form.priority} onChange={(e) => set({ priority: e.target.value })}>
                  <option value="low">Low</option>
                  <option value="medium">Medium</option>
                  <option value="high">High</option>
                </select>
              </label>
              <div className="form-grid" style={{ gap: 10 }}>
                <label className="field">
                  <span>Timeout (ms)</span>
                  <input className="input" type="number" min={100} max={300000} value={form.timeoutMs} onChange={(e) => set({ timeoutMs: e.target.value })} />
                </label>
                <label className="field">
                  <span>Retries</span>
                  <input className="input" type="number" min={0} max={5} value={form.retries} onChange={(e) => set({ retries: e.target.value })} />
                </label>
              </div>
              <label className="check full">
                <input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} />
                Enabled (included in suite and "all tests" runs)
              </label>
            </div>
          </div>

          {form.type === 'http' ? (
            <div className="card">
              <div className="card-head">
                <h3>Request</h3>
                <span className="sub">
                  Use <code>{'{{variable}}'}</code> placeholders from the environment
                </span>
              </div>
              <div className="row" style={{ flexWrap: 'nowrap', marginBottom: 14 }}>
                <select className="select" style={{ width: 120 }} value={cfg.method} onChange={(e) => setConfig({ method: e.target.value })} aria-label="Method">
                  {METHODS.map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
                <input className="input mono" value={cfg.url} onChange={(e) => setConfig({ url: e.target.value })} placeholder="{{baseUrl}}/path" aria-label="URL" />
              </div>
              <div className="tabs" role="tablist">
                {[
                  ['assertions', 'Assertions', cfg.assertions?.length],
                  ['query', 'Query', cfg.query?.length],
                  ['headers', 'Headers', cfg.headers?.length],
                  ['body', 'Body'],
                  ['extract', 'Capture', cfg.extract?.filter((r) => r.variable).length],
                  ['data', 'Data', cfg.dataset?.content?.trim() ? 'on' : null],
                ].map(([k, label, n]) => (
                  <button key={k} role="tab" aria-selected={section === k} className={`tab ${section === k ? 'active' : ''}`} onClick={() => setSection(k)}>
                    {label}
                    {n ? <span className="n">{n}</span> : null}
                  </button>
                ))}
              </div>
              {section === 'assertions' && <AssertionEditor assertions={cfg.assertions ?? []} onChange={(assertions) => setConfig({ assertions })} />}
              {section === 'extract' && <ExtractEditor rules={cfg.extract ?? []} onChange={(extract) => setConfig({ extract })} />}
              {section === 'data' && <DatasetEditor content={cfg.dataset?.content ?? ''} onChange={(content) => setConfig({ dataset: content ? { content } : undefined })} />}
              {section === 'query' && <KeyValueEditor rows={cfg.query ?? []} onChange={(query) => setConfig({ query })} addLabel="Add parameter" />}
              {section === 'headers' && (
                <KeyValueEditor rows={cfg.headers ?? []} onChange={(headers) => setConfig({ headers })} keyPlaceholder="Header" valuePlaceholder="Value, e.g. Bearer {{token}}" addLabel="Add header" />
              )}
              {section === 'body' && (
                <div className="stack" style={{ gap: 10 }}>
                  <div className="segmented">
                    {['json', 'text', 'none'].map((b) => (
                      <button key={b} className={cfg.bodyType === b ? 'active' : ''} onClick={() => setConfig({ bodyType: b })}>
                        {b.toUpperCase()}
                      </button>
                    ))}
                  </div>
                  {cfg.bodyType !== 'none' && (
                    <>
                      <textarea className="textarea code-input" rows={8} value={cfg.body ?? ''} onChange={(e) => setConfig({ body: e.target.value })} placeholder={'{\n  "key": "value"\n}'} spellCheck={false} />
                      {cfg.bodyType === 'json' && cfg.body && !isJsonish(cfg.body) && <span className="error-text">Body is not valid JSON (placeholders are fine).</span>}
                    </>
                  )}
                </div>
              )}
            </div>
          ) : (
            <div className="card">
              <div className="card-head">
                <h3>Script</h3>
                <span className="sub">Async JavaScript. A thrown error or failed expect fails the test.</span>
              </div>
              <textarea
                className="textarea code-input"
                rows={18}
                value={cfg.code ?? ''}
                onChange={(e) => setConfig({ code: e.target.value })}
                spellCheck={false}
                onKeyDown={(e) => {
                  if (e.key === 'Tab') {
                    e.preventDefault();
                    const el = e.target;
                    const { selectionStart: s, selectionEnd: end } = el;
                    const code = `${el.value.slice(0, s)}  ${el.value.slice(end)}`;
                    setConfig({ code });
                    requestAnimationFrame(() => el.setSelectionRange(s + 2, s + 2));
                  }
                }}
                aria-label="Script code"
              />
              <details style={{ marginTop: 14 }} open={Boolean(cfg.dataset?.content?.trim())}>
                <summary className="label" style={{ cursor: 'pointer' }}>
                  Data-driven (optional): run this script once per row
                </summary>
                <div style={{ marginTop: 10 }}>
                  <DatasetEditor content={cfg.dataset?.content ?? ''} onChange={(content) => setConfig({ dataset: content ? { content } : undefined })} />
                </div>
              </details>
            </div>
          )}

          {tryResult && (
            <div className="card">
              <div className="card-head">
                <Zap size={17} style={{ color: 'var(--primary)' }} />
                <h3>Try-it result</h3>
                <StatusBadge status={tryResult.status} />
                <span className="sub">{fmtDuration(tryResult.durationMs)} · not saved to history</span>
              </div>
              <ResultDetail result={tryResult} showAnalysis={false} />
            </div>
          )}
        </div>

        <div className="stack">
          {form.type === 'script' && (
            <div className="card">
              <div className="card-head">
                <h3>Script API</h3>
              </div>
              <pre className="code-block" style={{ maxHeight: 'none' }}>{`http.get(url, { headers })
http.post(url, body, { headers })
  → { status, ok, json, text,
      headers, durationMs }

expect(value, 'label')
  .toBe(x)  .toEqual(obj)
  .toContain(x)  .toMatch(/re/)
  .toBeGreaterThan(n)
  .toBeLessThan(n)
  .toHaveProperty('key')
  .toHaveLength(n)
  .toBeTruthy()  .not.toBe(x)

assert(condition, 'message')
log(...values)   sleep(ms)
vars.baseUrl     // environment, data row
                 // & chained values

setVar('orderId', res.json.id)
  // share with later tests
  // as {{orderId}} / vars.orderId`}</pre>
            </div>
          )}

          <ChainingCard form={form} env={env} allTests={allTests ?? []} />

          <div className="card">
            <div className="card-head">
              <h3>Variables</h3>
              <span className="sub">{env?.name}</span>
            </div>
            {env && Object.keys(env.variables).length ? (
              <dl className="kv-table">
                {Object.entries(env.variables).map(([k, v]) => (
                  <div key={k} style={{ display: 'contents' }}>
                    <dt>{`{{${k}}}`}</dt>
                    <dd className="truncate" title={v}>
                      {v}
                    </dd>
                  </div>
                ))}
                {['$serverUrl', '$timestamp', '$uuid', '$randomInt'].map((k) => (
                  <div key={k} style={{ display: 'contents' }}>
                    <dt>{`{{${k}}}`}</dt>
                    <dd className="muted">built-in</dd>
                  </div>
                ))}
              </dl>
            ) : (
              <p className="muted small">
                No variables. Add some in <Link to="/settings">Settings</Link>.
              </p>
            )}
          </div>

          {!isNew && (
            <div className="card">
              <div className="card-head">
                <h3>History</h3>
                {history?.length > 0 && <Spark statuses={history.slice(0, 16).map((h) => h.status)} />}
              </div>
              {!history?.length ? (
                <p className="muted small">This test hasn&apos;t run yet.</p>
              ) : (
                <div className="list">
                  {history.slice(0, 8).map((h) => (
                    <Link key={h.id} to={`/runs/${h.runId}`} className="list-item">
                      <StatusBadge status={h.status} />
                      <span className="grow small truncate">
                        <span className="cell-title">{h.runName}</span>
                        {h.iteration && (
                          <span className="chip chip-script" style={{ marginLeft: 6 }}>
                            row {h.iteration.index}
                          </span>
                        )}
                        <div className="cell-sub">{timeAgo(h.finishedAt)}</div>
                      </span>
                      <span className="small num muted">{fmtDuration(h.durationMs)}</span>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

const PLACEHOLDER = /\{\{\s*([$\w.-]+)\s*\}\}/g;

/** Column names of a CSV/JSON dataset (header row or first object's keys). */
function datasetColumns(content) {
  const text = content?.trim();
  if (!text) return [];
  try {
    if (text.startsWith('[')) return Object.keys(JSON.parse(text)[0] ?? {});
  } catch {
    return [];
  }
  return text.split(/\r?\n/)[0].split(',').map((c) => c.trim().replace(/^"|"$/g, ''));
}

/** Live view of which run variables this test captures and which it needs. */
function liveChaining(form) {
  const cfg = form.config ?? {};
  const own = new Set(datasetColumns(cfg.dataset?.content));
  let needs = [];
  let provides = [];
  if (form.type === 'script') {
    const code = cfg.code ?? '';
    needs = [...code.matchAll(/\bvars\s*(?:\.\s*([A-Za-z_$][\w$]*)|\[\s*['"]([^'"]+)['"]\s*\])/g)].map((m) => m[1] ?? m[2]);
    provides = [...code.matchAll(/\bsetVar\s*\(\s*['"]([^'"]+)['"]/g)].map((m) => m[1]);
  } else {
    const { extract, dataset, ...rest } = cfg;
    needs = [...JSON.stringify(rest).matchAll(PLACEHOLDER)].map((m) => m[1]);
    provides = (extract ?? []).map((r) => r.variable).filter(Boolean);
  }
  return {
    needs: [...new Set(needs)].filter((v) => !v.startsWith('$') && !own.has(v)),
    provides: [...new Set(provides)],
    columns: [...own],
  };
}

function ChainingCard({ form, env, allTests }) {
  const { needs, provides, columns } = liveChaining(form);
  const others = allTests.filter((t) => t.id !== form.id);
  const fromRun = needs.filter((v) => !(v in (env?.variables ?? {})));
  if (!fromRun.length && !provides.length && !columns.length) return null;
  return (
    <div className="card">
      <div className="card-head">
        <Link2 size={17} style={{ color: 'var(--primary)' }} />
        <h3>Chaining & data</h3>
      </div>
      <div className="stack" style={{ gap: 12 }}>
        {provides.length > 0 && (
          <div>
            <div className="label">Captures</div>
            {provides.map((v) => {
              const consumers = others.filter((t) => t.needs?.includes(v));
              return (
                <div key={v} className="small" style={{ marginTop: 4 }}>
                  <code>{`{{${v}}}`}</code>{' '}
                  <span className="muted">{consumers.length ? `→ used by ${consumers.map((c) => c.name).join(', ')}` : '→ not used by other tests yet'}</span>
                </div>
              );
            })}
          </div>
        )}
        {fromRun.length > 0 && (
          <div>
            <div className="label">Needs from other tests</div>
            {fromRun.map((v) => {
              const producers = others.filter((t) => t.provides?.includes(v));
              return (
                <div key={v} className="small" style={{ marginTop: 4 }}>
                  <code>{`{{${v}}}`}</code>{' '}
                  {producers.length ? (
                    <span className="muted">
                      ← captured by{' '}
                      {producers.map((p, i) => (
                        <span key={p.id}>
                          {i > 0 && ', '}
                          <Link to={`/tests/${p.id}`}>{p.name}</Link>
                        </span>
                      ))}
                      . It runs first automatically.
                    </span>
                  ) : (
                    <span className="error-text">Not defined in this environment and no test captures it</span>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {columns.length > 0 && (
          <div>
            <div className="label">From dataset rows</div>
            <div className="small muted" style={{ marginTop: 4 }}>
              {columns.map((c) => `{{${c}}}`).join(' ')}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function isJsonish(text) {
  try {
    JSON.parse(text.replace(/\{\{\s*[$\w.-]+\s*\}\}/g, '0'));
    return true;
  } catch {
    return false;
  }
}
