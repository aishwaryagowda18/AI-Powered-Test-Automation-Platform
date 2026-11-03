import { AlertTriangle, Plus, Table2, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { api } from '../lib/api.js';

const EXTRACT_SOURCES = [
  ['jsonPath', 'JSON path', 'e.g. token or data.id'],
  ['header', 'Header', 'e.g. location'],
  ['status', 'Status code', ''],
  ['regex', 'Body regex', 'e.g. id=(\\w+)  (group 1)'],
];

/** Rules that capture response values into run-scoped {{variables}}. */
export function ExtractEditor({ rules, onChange }) {
  const update = (i, patch) => onChange(rules.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  return (
    <div>
      <p className="hint" style={{ marginTop: 0 }}>
        Capture values from the response so later tests in the same run can use them as <code>{'{{name}}'}</code>. Tests that use a captured variable automatically run after this one,
        and running them alone pulls this test in.
      </p>
      {rules.map((r, i) => {
        const source = EXTRACT_SOURCES.find(([k]) => k === r.from) ?? EXTRACT_SOURCES[0];
        return (
          <div className="assert-row" key={i} style={{ gridTemplateColumns: 'minmax(0, 1fr) 150px minmax(0, 1.4fr) auto' }}>
            <input className="input input-sm mono" value={r.variable} placeholder="variable, e.g. token" onChange={(e) => update(i, { variable: e.target.value.trim() })} aria-label="Variable name" />
            <select className="select select-sm" value={r.from} onChange={(e) => update(i, { from: e.target.value })} aria-label="Capture from">
              {EXTRACT_SOURCES.map(([k, label]) => (
                <option key={k} value={k}>
                  {label}
                </option>
              ))}
            </select>
            <input className="input input-sm mono" value={r.path ?? ''} disabled={r.from === 'status'} placeholder={source[2] || '—'} onChange={(e) => update(i, { path: e.target.value })} aria-label="Path" />
            <button className="btn btn-ghost btn-icon btn-sm btn-danger" onClick={() => onChange(rules.filter((_, idx) => idx !== i))} aria-label="Remove capture rule">
              <Trash2 size={14} />
            </button>
          </div>
        );
      })}
      <button className="btn btn-sm" onClick={() => onChange([...rules, { variable: '', from: 'jsonPath', path: '' }])}>
        <Plus size={13} /> Add capture
      </button>
    </div>
  );
}

/** CSV / JSON dataset with a live, server-validated preview. */
export function DatasetEditor({ content, onChange }) {
  const [preview, setPreview] = useState(null);
  useEffect(() => {
    if (!content?.trim()) {
      setPreview(null);
      return undefined;
    }
    const t = setTimeout(() => {
      api
        .post('/tests/dataset/preview', { content })
        .then((p) => setPreview({ ok: true, ...p }))
        .catch((err) => setPreview({ ok: false, error: err.message }));
    }, 350);
    return () => clearTimeout(t);
  }, [content]);

  return (
    <div className="stack" style={{ gap: 10 }}>
      <p className="hint" style={{ margin: 0 }}>
        The test runs once per row, and each column is available as <code>{'{{column}}'}</code> (or <code>vars.column</code> in scripts). Paste CSV with a header row, or a JSON array of
        objects. Up to 100 rows.
      </p>
      <textarea
        className="textarea code-input"
        rows={6}
        value={content ?? ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={'username,password,expectedStatus\ndemo,demo123,200\ndemo,wrong,401'}
        spellCheck={false}
        aria-label="Dataset"
      />
      {preview?.ok === false && (
        <div className="notice notice-error small">
          <AlertTriangle size={15} />
          <span>{preview.error}</span>
        </div>
      )}
      {preview?.ok && (
        <div>
          <div className="row small" style={{ marginBottom: 6 }}>
            <Table2 size={14} />
            <strong>
              {preview.total} {preview.total === 1 ? 'row' : 'rows'}
            </strong>
            <span className="muted">→ {preview.total} test executions per run · variables: {preview.columns.map((c) => `{{${c}}}`).join(' ')}</span>
          </div>
          <div className="table-wrap" style={{ border: '1px solid var(--line)', borderRadius: 'var(--r-md)', maxHeight: 220 }}>
            <table className="table">
              <thead>
                <tr>
                  <th className="num">#</th>
                  {preview.columns.map((c) => (
                    <th key={c}>{c}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {preview.rows.map((r, i) => (
                  <tr key={i}>
                    <td className="num muted">{i + 1}</td>
                    {preview.columns.map((c) => (
                      <td key={c} className="mono small">
                        {r[c] === '' ? <span className="muted">(empty)</span> : r[c]}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {preview.total > preview.rows.length && <div className="hint">Showing the first {preview.rows.length} rows.</div>}
        </div>
      )}
      {content?.trim() && (
        <div>
          <button className="btn btn-sm btn-ghost btn-danger" onClick={() => onChange('')}>
            <Trash2 size={13} /> Remove dataset
          </button>
        </div>
      )}
    </div>
  );
}

/** Editable list of { key, value } rows (headers, query params, env variables). */
export function KeyValueEditor({ rows, onChange, keyPlaceholder = 'Key', valuePlaceholder = 'Value', addLabel = 'Add row' }) {
  const update = (i, patch) => onChange(rows.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  return (
    <div>
      {rows.map((row, i) => (
        <div className="kv-row" key={i}>
          <input className="input input-sm mono" value={row.key} placeholder={keyPlaceholder} onChange={(e) => update(i, { key: e.target.value })} aria-label="Key" />
          <input className="input input-sm mono" value={row.value} placeholder={valuePlaceholder} onChange={(e) => update(i, { value: e.target.value })} aria-label="Value" />
          <button className="btn btn-ghost btn-icon btn-sm btn-danger" onClick={() => onChange(rows.filter((_, idx) => idx !== i))} aria-label="Remove row">
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <button className="btn btn-sm" onClick={() => onChange([...rows, { key: '', value: '' }])}>
        <Plus size={13} /> {addLabel}
      </button>
    </div>
  );
}

const TYPES = [
  { value: 'status', label: 'Status code', target: false },
  { value: 'jsonPath', label: 'JSON path', target: 'e.g. data[0].id' },
  { value: 'header', label: 'Header', target: 'e.g. content-type' },
  { value: 'responseTime', label: 'Response time', target: false },
  { value: 'body', label: 'Body text', target: false },
];
const OPERATORS = [
  ['equals', 'equals'],
  ['notEquals', 'does not equal'],
  ['contains', 'contains'],
  ['notContains', 'does not contain'],
  ['lessThan', 'less than'],
  ['greaterThan', 'greater than'],
  ['exists', 'exists'],
  ['notExists', 'does not exist'],
  ['matches', 'matches regex'],
  ['isType', 'is of type'],
];

export function AssertionEditor({ assertions, onChange }) {
  const update = (i, patch) => onChange(assertions.map((a, idx) => (idx === i ? { ...a, ...patch } : a)));
  return (
    <div>
      {assertions.length === 0 && <p className="hint">No assertions: the test passes on any status below 400.</p>}
      {assertions.map((a, i) => {
        const type = TYPES.find((t) => t.value === a.type) ?? TYPES[0];
        const noValue = a.operator === 'exists' || a.operator === 'notExists';
        return (
          <div className="assert-row" key={i}>
            <select className="select select-sm" value={a.type} onChange={(e) => update(i, { type: e.target.value })} aria-label="Assertion type">
              {TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
            <input
              className="input input-sm mono"
              value={a.target ?? ''}
              disabled={!type.target}
              placeholder={type.target || '—'}
              onChange={(e) => update(i, { target: e.target.value })}
              aria-label="Target"
            />
            <select className="select select-sm" value={a.operator} onChange={(e) => update(i, { operator: e.target.value })} aria-label="Operator">
              {OPERATORS.map(([v, l]) => (
                <option key={v} value={v}>
                  {l}
                </option>
              ))}
            </select>
            <input
              className="input input-sm mono"
              value={a.expected ?? ''}
              disabled={noValue}
              placeholder={noValue ? '—' : a.operator === 'isType' ? 'array | object | string | number' : 'Expected value'}
              onChange={(e) => update(i, { expected: e.target.value })}
              aria-label="Expected"
            />
            <button className="btn btn-ghost btn-icon btn-sm btn-danger" onClick={() => onChange(assertions.filter((_, idx) => idx !== i))} aria-label="Remove assertion">
              <Trash2 size={14} />
            </button>
          </div>
        );
      })}
      <button className="btn btn-sm" onClick={() => onChange([...assertions, { type: 'status', operator: 'equals', expected: '200', target: '' }])}>
        <Plus size={13} /> Add assertion
      </button>
    </div>
  );
}
