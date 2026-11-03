import { AlertTriangle, Bot, FileCode2, Loader2, MessageSquareText, Play, Sparkles, Terminal, Wand2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { isAI, providerName } from '../lib/ai.js';
import { api } from '../lib/api.js';
import { useToast } from '../lib/toast.jsx';
import { Modal } from './ui.jsx';

const SOURCES = [
  { key: 'openapi', label: 'OpenAPI spec', icon: FileCode2, hint: 'Paste an OpenAPI 3 / Swagger 2 document. JSON works offline; YAML needs an AI provider.' },
  { key: 'curl', label: 'cURL', icon: Terminal, hint: 'Paste a cURL command, e.g. "Copy as cURL" from browser dev tools or Postman.' },
  { key: 'description', label: 'Describe it', icon: MessageSquareText, hint: 'Describe what to test in plain English. The AI writes the test cases.' },
];

const demoSpec = (origin) =>
  JSON.stringify(
    {
      openapi: '3.0.0',
      info: { title: 'Demo API', version: '2.4.1' },
      servers: [{ url: `${origin}/demo-api` }],
      paths: {
        '/health': { get: { summary: 'Service health', responses: { 200: { content: { 'application/json': { schema: { type: 'object', required: ['status'], properties: { status: { type: 'string' } } } } } } } } },
        '/products': {
          get: {
            summary: 'List products by category',
            parameters: [{ name: 'category', in: 'query', required: true, schema: { type: 'string', example: 'peripherals' } }],
            responses: { 200: { content: { 'application/json': { schema: { type: 'object', required: ['data', 'total'], properties: { data: { type: 'array' }, total: { type: 'integer' } } } } } } },
          },
        },
        '/users': {
          post: {
            summary: 'Create a user',
            requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string', example: 'Grace Hopper' }, email: { type: 'string', format: 'email' } } } } } },
            responses: { 201: { content: { 'application/json': { schema: { type: 'object', required: ['id', 'email'], properties: { id: { type: 'integer' }, email: { type: 'string' } } } } } } },
          },
        },
      },
    },
    null,
    2,
  );

const EXAMPLES = {
  openapi: demoSpec,
  curl: (origin) => `curl -X POST '${origin}/demo-api/auth/login' \\\n  -H 'Content-Type: application/json' \\\n  -d '{"username":"demo","password":"demo123"}'`,
  description: () => 'Test the users API: listing users, fetching a user by id, a 404 for an unknown id, and email validation when creating a user. Also check that orders require a bearer token from /auth/login.',
};

export function GenerateModal({ onClose, onImported }) {
  const toast = useToast();
  const navigate = useNavigate();
  const [source, setSource] = useState('openapi');
  const [input, setInput] = useState('');
  const [useAI, setUseAI] = useState(true);
  const [ai, setAi] = useState(null);
  const [envs, setEnvs] = useState([]);
  const [suites, setSuites] = useState([]);
  const [environmentId, setEnvironmentId] = useState('');
  const [result, setResult] = useState(null);
  const [selected, setSelected] = useState(new Set());
  const [suite, setSuite] = useState('Generated');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    Promise.all([api.get('/ai/status'), api.get('/environments'), api.get('/suites')]).then(([a, e, s]) => {
      setAi(a);
      setEnvs(e);
      setSuites(s);
      setEnvironmentId((e.find((x) => x.isDefault) ?? e[0])?.id ?? '');
    });
  }, []);

  const meta = SOURCES.find((s) => s.key === source);
  const aiAvailable = Boolean(ai?.enabled);
  const aiLabel = ai?.providerLabel ?? 'AI';
  const willUseAI = source === 'description' || (useAI && aiAvailable);

  const generate = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const res = await api.post('/generate', { source, input, useAI: willUseAI, environmentId: environmentId || undefined });
      setResult(res);
      setSelected(new Set(res.tests.map((_, i) => i)));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const importTests = async (andRun) => {
    setBusy(true);
    try {
      const tests = result.tests.filter((_, i) => selected.has(i)).map((t) => ({ ...t, suite: suite.trim() || undefined }));
      const res = await api.post('/tests/import', { tests });
      toast.success('Tests imported', `${res.imported} tests added${suite ? ` to "${suite}"` : ''}`);
      onImported?.();
      if (andRun) {
        const run = await api.post('/runs', { testIds: res.tests.map((t) => t.id), environmentId: environmentId || undefined, name: `Generated: ${suite || 'tests'}` });
        navigate(`/runs/${run.id}`);
      }
      onClose();
    } catch (err) {
      toast.error('Import failed', err.message);
    } finally {
      setBusy(false);
    }
  };

  const toggle = (i) =>
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });

  return (
    <Modal
      wide
      title="Generate tests"
      subtitle="Turn an API spec, a cURL command or a plain-English description into runnable test cases."
      onClose={onClose}
      footer={
        result ? (
          <>
            <button className="btn" onClick={() => setResult(null)} disabled={busy}>
              Back
            </button>
            <button className="btn" onClick={() => importTests(false)} disabled={busy || !selected.size}>
              Import {selected.size}
            </button>
            <button className="btn btn-primary" onClick={() => importTests(true)} disabled={busy || !selected.size}>
              {busy ? <Loader2 size={15} className="spin" /> : <Play size={15} />} Import & run
            </button>
          </>
        ) : (
          <>
            <button className="btn" onClick={onClose}>
              Cancel
            </button>
            <button className="btn btn-primary" onClick={generate} disabled={busy || !ai || !input.trim() || (source === 'description' && !aiAvailable)}>
              {busy ? <Loader2 size={15} className="spin" /> : willUseAI ? <Sparkles size={15} /> : <Wand2 size={15} />}
              {busy ? (willUseAI ? `${aiLabel} is writing tests…` : 'Generating…') : 'Generate'}
            </button>
          </>
        )
      }
    >
      {!result ? (
        <div className="stack" style={{ gap: 14 }}>
          <div className="segmented" role="tablist">
            {SOURCES.map((s) => (
              <button key={s.key} className={source === s.key ? 'active' : ''} onClick={() => setSource(s.key)}>
                <s.icon size={13} /> {s.label}
              </button>
            ))}
          </div>
          <div className="row">
            <span className="hint" style={{ flex: 1 }}>
              {meta.hint}
            </span>
            <button className="btn btn-sm btn-ghost" onClick={() => setInput(EXAMPLES[source](window.location.origin))}>
              Load example
            </button>
          </div>
          <textarea
            className="textarea code-input"
            rows={source === 'description' ? 5 : 12}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder={source === 'openapi' ? '{\n  "openapi": "3.0.0",\n  "paths": { ... }\n}' : source === 'curl' ? "curl -X GET 'https://api.example.com/users' -H 'Accept: application/json'" : 'e.g. Verify checkout: add to cart, apply a coupon, reject expired coupons…'}
            spellCheck={false}
            aria-label="Generation input"
          />
          <div className="form-grid">
            <label className="field">
              <span>Environment (for {'{{variables}}'})</span>
              <select className="select" value={environmentId} onChange={(e) => setEnvironmentId(e.target.value)}>
                {envs.map((e) => (
                  <option key={e.id} value={e.id}>
                    {e.name}
                  </option>
                ))}
              </select>
            </label>
            <div className="field">
              <span>Generator</span>
              {source === 'description' ? (
                <span className={`badge ${aiAvailable ? 'badge-ai' : 'badge-neutral'}`} style={{ alignSelf: 'flex-start', marginTop: 8 }}>
                  <Sparkles size={12} /> {aiAvailable ? aiLabel : 'AI (not configured)'}
                </span>
              ) : (
                <label className="check" style={{ marginTop: 8 }}>
                  <input type="checkbox" checked={useAI && aiAvailable} disabled={!aiAvailable} onChange={(e) => setUseAI(e.target.checked)} />
                  {aiAvailable ? `Use ${aiLabel} (adds negative & edge cases)` : 'Rule-based converter (no AI provider configured)'}
                </label>
              )}
            </div>
          </div>
          {source === 'description' && !aiAvailable && (
            <div className="notice notice-warn small">
              <AlertTriangle size={16} />
              <span>
                Generating from a description needs an AI provider. Set <code>GEMINI_API_KEY</code> in <code>.env</code> and restart, or use the OpenAPI / cURL tabs, which work offline.
              </span>
            </div>
          )}
          {ai?.lastError && willUseAI && <div className="small error-text">Last {aiLabel} error: {ai.lastError}</div>}
          {error && (
            <div className="notice notice-error small">
              <AlertTriangle size={16} />
              <span>{error}</span>
            </div>
          )}
        </div>
      ) : (
        <div className="stack" style={{ gap: 12 }}>
          <div className="row">
            <span className={`badge ${isAI(result.generator) ? 'badge-ai' : 'badge-neutral'}`}>
              {isAI(result.generator) ? <Sparkles size={12} /> : <Bot size={12} />}
              {isAI(result.generator) ? `${providerName(result.generator)} (${result.model})` : 'Rule-based'}
            </span>
            <span className="small muted">
              {result.tests.length} {result.tests.length === 1 ? 'test' : 'tests'} generated · {selected.size} selected
            </span>
            <span className="spacer" />
            <button className="btn btn-sm btn-ghost" onClick={() => setSelected(selected.size === result.tests.length ? new Set() : new Set(result.tests.map((_, i) => i)))}>
              {selected.size === result.tests.length ? 'Select none' : 'Select all'}
            </button>
          </div>
          {result.warnings?.map((w, i) => (
            <div key={i} className="notice notice-warn small">
              <AlertTriangle size={15} />
              <span>{w}</span>
            </div>
          ))}
          <div className="picker" style={{ maxHeight: 320 }}>
            {result.tests.map((t, i) => (
              <label key={i} style={{ alignItems: 'flex-start' }}>
                <input type="checkbox" checked={selected.has(i)} onChange={() => toggle(i)} style={{ accentColor: 'var(--primary)', marginTop: 3 }} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="cell-title" style={{ display: 'block' }}>
                    {t.name}
                  </span>
                  <span className="cell-sub truncate" style={{ display: 'block' }}>
                    <span className={`method method-${t.config.method}`}>{t.config.method}</span> {t.config.url}
                  </span>
                </span>
                <span className="chip">
                  {t.config.assertions.length} {t.config.assertions.length === 1 ? 'check' : 'checks'}
                </span>
              </label>
            ))}
          </div>
          <label className="field">
            <span>Add to suite</span>
            <input className="input" list="suite-names" value={suite} onChange={(e) => setSuite(e.target.value)} placeholder="Leave empty for no suite" />
            <datalist id="suite-names">
              {suites.map((s) => (
                <option key={s.id} value={s.name} />
              ))}
            </datalist>
            <span className="hint">A new suite is created if the name doesn&apos;t exist.</span>
          </label>
        </div>
      )}
    </Modal>
  );
}
