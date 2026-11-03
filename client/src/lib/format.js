export function fmtDuration(ms) {
  if (ms == null || Number.isNaN(ms)) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(ms < 10000 ? 2 : 1)} s`;
  const m = Math.floor(ms / 60000);
  const s = Math.round((ms % 60000) / 1000);
  return `${m}m ${s}s`;
}

export function timeAgo(iso) {
  if (!iso) return '—';
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 10) return 'just now';
  if (diff < 60) return `${Math.floor(diff)}s ago`;
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  if (diff < 86400 * 7) return `${Math.floor(diff / 86400)}d ago`;
  return new Date(iso).toLocaleDateString();
}

export function timeUntil(iso) {
  if (!iso) return '—';
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  if (diff <= 30) return 'any moment';
  if (diff < 3600) return `in ${Math.round(diff / 60)} min`;
  if (diff < 86400) return `in ${Math.floor(diff / 3600)}h ${Math.round((diff % 3600) / 60)}m`;
  return `in ${Math.round(diff / 86400)} days`;
}

export const fmtDateTime =(iso) => (iso ? new Date(iso).toLocaleString() : '—');
export const fmtTime = (iso) => (iso ? new Date(iso).toLocaleTimeString([], { hour12: false }) : '');
export const fmtPct = (n) => (n == null ? '—' : `${Math.round(n * 10) / 10}%`);

export const passRateOf = (run) => {
  const executed = (run.passed ?? 0) + (run.failed ?? 0) + (run.errored ?? 0);
  return executed ? (run.passed / executed) * 100 : null;
};

export const CATEGORY_LABELS = {
  assertion_mismatch: 'Assertion mismatch',
  contract_change: 'API contract change',
  server_error: 'Server error',
  timeout_performance: 'Timeout / performance',
  network_connectivity: 'Network / connectivity',
  authentication: 'Auth / permissions',
  not_found_routing: 'Not found / routing',
  test_code_error: 'Test code error',
  flaky: 'Flaky / intermittent',
  configuration: 'Configuration',
  unknown: 'Unknown',
  unanalyzed: 'Not analyzed yet',
};

export const OWNER_LABELS = {
  application: 'Application code',
  test: 'Test definition',
  environment: 'Environment / infra',
  unknown: 'Unclear',
};

export function downloadJson(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}
