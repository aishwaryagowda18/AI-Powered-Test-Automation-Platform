/** Failure taxonomy shared by the heuristic engine, the AI prompts and the UI. */
export const CATEGORIES = {
  assertion_mismatch: 'Assertion mismatch',
  contract_change: 'API contract change',
  server_error: 'Server error',
  timeout_performance: 'Timeout / performance',
  network_connectivity: 'Network / connectivity',
  authentication: 'Authentication / authorization',
  not_found_routing: 'Not found / routing',
  test_code_error: 'Test code error',
  flaky: 'Flaky / intermittent',
  configuration: 'Configuration',
  unknown: 'Unknown',
};

export const CATEGORY_KEYS = Object.keys(CATEGORIES);
export const OWNERS = ['application', 'test', 'environment', 'unknown'];
export const CONFIDENCE = ['low', 'medium', 'high'];
