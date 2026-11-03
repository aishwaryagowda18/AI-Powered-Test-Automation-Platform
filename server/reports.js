const PROVIDERS = { gemini: 'Gemini', claude: 'Claude' };

const esc = (value) =>
  String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const xmlEsc = (value) =>
  esc(value)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

const seconds = (ms) => ((ms ?? 0) / 1000).toFixed(3);
const fmtMs = (ms) => (ms == null ? '—' : ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`);
const passRate = (run) => (run.total ? Math.round((run.passed / run.total) * 100) : 0);

export const REPORT_FORMATS = {
  html: { ext: 'html', type: 'text/html; charset=utf-8' },
  junit: { ext: 'xml', type: 'application/xml; charset=utf-8' },
  json: { ext: 'json', type: 'application/json; charset=utf-8' },
  csv: { ext: 'csv', type: 'text/csv; charset=utf-8' },
};

export function generateReport(format, run, results) {
  switch (format) {
    case 'junit':
      return junitReport(run, results);
    case 'json':
      return JSON.stringify({ generatedAt: new Date().toISOString(), run, results }, null, 2);
    case 'csv':
      return csvReport(run, results);
    case 'html':
    default:
      return htmlReport(run, results);
  }
}

export function junitReport(run, results) {
  const bySuite = new Map();
  for (const r of results) {
    const key = r.suiteName || 'Ungrouped';
    if (!bySuite.has(key)) bySuite.set(key, []);
    bySuite.get(key).push(r);
  }
  const suites = [...bySuite.entries()].map(([name, items]) => {
    const failures = items.filter((r) => r.status === 'failed').length;
    const errors = items.filter((r) => r.status === 'error').length;
    const skipped = items.filter((r) => r.status === 'skipped').length;
    const time = items.reduce((sum, r) => sum + (r.durationMs ?? 0), 0);
    const cases = items
      .map((r) => {
        const open = `    <testcase classname="${xmlEsc(name)}" name="${xmlEsc(r.displayName ?? r.testName)}" time="${seconds(r.durationMs)}"`;
        const logs = (r.logs ?? []).map((l) => `[${l.level}] ${l.message}`).join('\n');
        const out = logs ? `\n      <system-out>${xmlEsc(logs)}</system-out>` : '';
        if (r.status === 'failed') {
          return `${open}>\n      <failure message="${xmlEsc(r.errorMessage)}" type="AssertionError">${xmlEsc(
            (r.assertions ?? []).filter((a) => !a.passed).map((a) => a.message).join('\n'),
          )}</failure>${out}\n    </testcase>`;
        }
        if (r.status === 'error') {
          return `${open}>\n      <error message="${xmlEsc(r.errorMessage)}" type="Error">${xmlEsc(r.errorStack ?? r.errorMessage)}</error>${out}\n    </testcase>`;
        }
        if (r.status === 'skipped') return `${open}>\n      <skipped message="${xmlEsc(r.errorMessage ?? 'skipped')}"/>\n    </testcase>`;
        return `${open}>${out}\n    </testcase>`;
      })
      .join('\n');
    return `  <testsuite name="${xmlEsc(name)}" tests="${items.length}" failures="${failures}" errors="${errors}" skipped="${skipped}" time="${seconds(time)}" timestamp="${xmlEsc(run.startedAt ?? run.createdAt)}">\n${cases}\n  </testsuite>`;
  });
  return `<?xml version="1.0" encoding="UTF-8"?>
<testsuites name="${xmlEsc(run.name)}" tests="${run.total}" failures="${run.failed}" errors="${run.errored}" skipped="${run.skipped}" time="${seconds(run.durationMs)}">
${suites.join('\n')}
</testsuites>
`;
}

export function csvReport(run, results) {
  const cell = (v) => {
    const s = String(v ?? '');
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = ['run_id', 'run_name', 'test_name', 'suite', 'type', 'status', 'duration_ms', 'attempts', 'flaky', 'error', 'ai_category', 'ai_summary'];
  const rows = results.map((r) =>
    [run.id, run.name, r.displayName ?? r.testName, r.suiteName, r.testType, r.status, r.durationMs, r.attempts, r.flaky, r.errorMessage, r.analysis?.category, r.analysis?.summary]
      .map(cell)
      .join(','),
  );
  return `${header.join(',')}\n${rows.join('\n')}\n`;
}

function donut(run) {
  const segments = [
    ['passed', run.passed, '#0ca30c'],
    ['failed', run.failed, '#d03b3b'],
    ['error', run.errored, '#ec835a'],
    ['skipped', run.skipped, '#898781'],
  ].filter(([, n]) => n > 0);
  const total = segments.reduce((s, [, n]) => s + n, 0) || 1;
  const r = 52;
  const c = 2 * Math.PI * r;
  let offset = 0;
  const arcs = segments
    .map(([label, n, color]) => {
      const len = (n / total) * c;
      const gap = segments.length > 1 ? 2 : 0;
      const arc = `<circle r="${r}" cx="64" cy="64" fill="none" stroke="${color}" stroke-width="16" stroke-dasharray="${Math.max(0, len - gap)} ${c}" stroke-dashoffset="${-offset}"><title>${label}: ${n}</title></circle>`;
      offset += len;
      return arc;
    })
    .join('');
  return `<svg width="128" height="128" viewBox="0 0 128 128" role="img" aria-label="Result breakdown"><g transform="rotate(-90 64 64)">${arcs}</g><text x="64" y="62" text-anchor="middle" font-size="22" font-weight="600" fill="currentColor">${passRate(run)}%</text><text x="64" y="80" text-anchor="middle" font-size="11" fill="#898781">pass rate</text></svg>`;
}

export function htmlReport(run, results) {
  const statusLabel = { passed: '✓ Passed', failed: '✗ Failed', error: '! Error', skipped: '– Skipped', cancelled: '– Cancelled' };
  const rows = results
    .map((r) => {
      const failedAssertions = (r.assertions ?? []).filter((a) => !a.passed);
      const analysis = r.analysis
        ? `<div class="ai"><div class="ai-head">AI root-cause analysis · ${esc(r.analysis.categoryLabel ?? r.analysis.category)} · ${esc(r.analysis.confidence)} confidence · ${esc(r.analysis.source === 'heuristic' ? 'heuristic engine' : `${PROVIDERS[r.analysis.source] ?? 'AI'} (${r.analysis.model ?? ''})`)}</div>
           <p><strong>${esc(r.analysis.summary)}</strong></p><p>${esc(r.analysis.rootCause)}</p>
           ${r.analysis.suggestedFixes?.length ? `<ol>${r.analysis.suggestedFixes.map((f) => `<li>${esc(f)}</li>`).join('')}</ol>` : ''}</div>`
        : '';
      const details =
        r.status === 'passed'
          ? ''
          : `<tr class="detail"><td colspan="5">
            ${r.errorMessage ? `<div class="err">${esc(r.errorMessage)}</div>` : ''}
            ${failedAssertions.length ? `<ul>${failedAssertions.map((a) => `<li>${esc(a.message)}</li>`).join('')}</ul>` : ''}
            ${analysis}
            ${r.logs?.length ? `<details><summary>Execution log (${r.logs.length} lines)</summary><pre>${esc(r.logs.map((l) => `${l.ts.slice(11, 23)} [${l.level}] ${l.message}`).join('\n'))}</pre></details>` : ''}
          </td></tr>`;
      return `<tr><td><span class="badge ${esc(r.status)}">${statusLabel[r.status] ?? esc(r.status)}</span>${r.flaky ? ' <span class="badge flaky">flaky</span>' : ''}</td>
        <td>${esc(r.displayName ?? r.testName)}</td><td>${esc(r.suiteName ?? '—')}</td><td>${esc(r.testType)}</td><td class="num">${fmtMs(r.durationMs)}</td></tr>${details}`;
    })
    .join('\n');

  const summary = run.aiSummary;
  const summaryBlock = summary
    ? `<section class="card"><h2>Run summary${summary.source === 'heuristic' ? ' · heuristic' : ` · ${PROVIDERS[summary.source] ?? 'AI'}`}</h2><p><strong>${esc(summary.headline)}</strong></p><p>${esc(summary.overview)}</p>
       ${summary.recommendations?.length ? `<h3>Recommendations</h3><ol>${summary.recommendations.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>` : ''}</section>`
    : '';

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Test report · ${esc(run.name)} · #${run.id}</title>
<style>
  :root { --bg:#f9f9f7; --surface:#fcfcfb; --ink:#0b0b0b; --ink2:#52514e; --muted:#898781; --line:#e1e0d9; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0d0d0d; --surface:#1a1a19; --ink:#f0efec; --ink2:#c3c2b7; --line:#2c2c2a; } }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--ink); font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif; }
  main { max-width:1100px; margin:0 auto; padding:32px 16px; }
  h1 { margin:0 0 4px; font-size:24px; } h2 { font-size:16px; margin:0 0 12px; } h3 { font-size:14px; }
  .sub { color:var(--ink2); margin:0 0 24px; }
  .card { background:var(--surface); border:1px solid var(--line); border-radius:12px; padding:20px; margin-bottom:16px; }
  .top { display:flex; gap:24px; align-items:center; flex-wrap:wrap; }
  .stats { display:grid; grid-template-columns:repeat(auto-fit,minmax(120px,1fr)); gap:12px; flex:1; }
  .stat .v { font-size:24px; font-weight:600; } .stat .l { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; }
  table { width:100%; border-collapse:collapse; } th,td { text-align:left; padding:10px 8px; border-bottom:1px solid var(--line); vertical-align:top; }
  th { color:var(--muted); font-size:12px; text-transform:uppercase; letter-spacing:.04em; font-weight:600; }
  .num { text-align:right; font-variant-numeric:tabular-nums; white-space:nowrap; }
  .badge { display:inline-block; padding:2px 8px; border-radius:999px; font-size:12px; font-weight:600; white-space:nowrap; }
  .passed { background:#0ca30c22; color:#0a7d0a; } .failed { background:#d03b3b22; color:#b52f2f; } .error { background:#ec835a2a; color:#b55a32; }
  .skipped, .cancelled { background:#89878122; color:var(--ink2); } .flaky { background:#fab21933; color:#8a5d00; }
  @media (prefers-color-scheme: dark) { .passed{color:#4cc94c} .failed{color:#ec7272} .error{color:#f0a07e} .flaky{color:#fab219} }
  tr.detail td { background:color-mix(in srgb, var(--surface) 92%, var(--ink) 8%); }
  .err { font-family:ui-monospace,Consolas,monospace; font-size:13px; color:var(--ink); margin-bottom:8px; }
  .ai { border-left:3px solid #6250d6; padding:8px 12px; margin:8px 0; } .ai-head { font-size:12px; color:var(--muted); }
  pre { white-space:pre-wrap; font:12px/1.5 ui-monospace,Consolas,monospace; max-height:320px; overflow:auto; }
  footer { color:var(--muted); font-size:12px; margin-top:24px; }
</style></head>
<body><main>
  <h1>${esc(run.name)} <span class="badge ${esc(run.status)}">${statusLabel[run.status] ?? esc(run.status)}</span></h1>
  <p class="sub">Run #${run.id} · ${esc(run.environmentName ?? 'default environment')} · started ${esc(run.startedAt ?? run.createdAt)} · ${fmtMs(run.durationMs)} · trigger: ${esc(run.trigger)}</p>
  <section class="card top">
    ${donut(run)}
    <div class="stats">
      <div class="stat"><div class="v">${run.total}</div><div class="l">Total</div></div>
      <div class="stat"><div class="v">${run.passed}</div><div class="l">Passed</div></div>
      <div class="stat"><div class="v">${run.failed}</div><div class="l">Failed</div></div>
      <div class="stat"><div class="v">${run.errored}</div><div class="l">Errors</div></div>
      <div class="stat"><div class="v">${run.skipped}</div><div class="l">Skipped</div></div>
      <div class="stat"><div class="v">${run.flaky}</div><div class="l">Flaky</div></div>
    </div>
  </section>
  ${summaryBlock}
  <section class="card"><h2>Results</h2>
    <table><thead><tr><th>Status</th><th>Test</th><th>Suite</th><th>Type</th><th class="num">Duration</th></tr></thead><tbody>${rows}</tbody></table>
  </section>
  <footer>Generated by TestForge AI on ${new Date().toISOString()}</footer>
</main></body></html>`;
}
