import { ASSERTION_TYPES, OPERATORS } from './runner/assertions.js';
import { parseDataset } from './runner/dataset.js';
import { parseCron } from './scheduler/cron.js';

export class ValidationError extends Error {
  constructor(errors) {
    super(errors.join('; '));
    this.status = 400;
    this.errors = errors;
  }
}

const METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
const PRIORITIES = ['low', 'medium', 'high'];
const EXTRACT_FROM = ['jsonPath', 'header', 'status', 'regex'];
const VAR_NAME = /^[A-Za-z_][\w.-]*$/;
const MAX_DATASET_CHARS = 200_000;

/** Validate `config.extract` (HTTP only) and `config.dataset`; returns the cleaned fields. */
function validateChaining(cfg, errors, { allowExtract }) {
  const out = {};
  if (allowExtract && cfg.extract != null) {
    if (!Array.isArray(cfg.extract)) errors.push('config.extract must be an array');
    else {
      out.extract = [];
      for (const [i, rule] of cfg.extract.entries()) {
        const variable = String(rule?.variable ?? '').trim();
        if (!variable && !String(rule?.path ?? '').trim()) continue; // blank row from the editor
        if (!VAR_NAME.test(variable)) errors.push(`extract[${i}].variable must be a valid name (letters, digits, _ . -)`);
        if (variable.startsWith('$')) errors.push(`extract[${i}].variable cannot start with $ (reserved for built-ins)`);
        if (!EXTRACT_FROM.includes(rule.from)) errors.push(`extract[${i}].from must be one of ${EXTRACT_FROM.join(', ')}`);
        if (rule.from !== 'status' && !String(rule.path ?? '').trim()) errors.push(`extract[${i}].path is required for ${rule.from}`);
        if (rule.from === 'regex') {
          try {
            new RegExp(rule.path);
          } catch {
            errors.push(`extract[${i}].path is not a valid regular expression`);
          }
        }
        out.extract.push({ variable, from: rule.from, path: rule.from === 'status' ? '' : String(rule.path ?? '').trim() });
      }
      if (!out.extract.length) delete out.extract;
    }
  }
  if (cfg.dataset != null) {
    const content = typeof cfg.dataset === 'string' ? cfg.dataset : cfg.dataset.content;
    if (typeof content !== 'string') errors.push('config.dataset.content must be a string');
    else if (content.length > MAX_DATASET_CHARS) errors.push(`Dataset is too large (max ${MAX_DATASET_CHARS / 1000} KB)`);
    else if (content.trim()) {
      try {
        parseDataset(content);
        out.dataset = { content };
      } catch (err) {
        errors.push(`Dataset: ${err.message}`);
      }
    }
  }
  return out;
}

/** Validate and normalise a test case payload. `partial` allows PATCH-style updates. */
export function validateTest(body, { partial = false } = {}) {
  const errors = [];
  const out = {};
  const has = (k) => body[k] !== undefined;

  if (!partial || has('name')) {
    if (typeof body.name !== 'string' || !body.name.trim()) errors.push('name is required');
    else out.name = body.name.trim().slice(0, 200);
  }
  if (!partial || has('type')) {
    if (!['http', 'script'].includes(body.type)) errors.push('type must be "http" or "script"');
    else out.type = body.type;
  }
  if (has('description')) out.description = String(body.description ?? '').slice(0, 2000);
  if (has('suiteId')) out.suiteId = body.suiteId === null || body.suiteId === '' ? null : Number(body.suiteId);
  if (has('tags')) {
    const tags = Array.isArray(body.tags) ? body.tags : String(body.tags).split(',');
    out.tags = [...new Set(tags.map((t) => String(t).trim()).filter(Boolean))].slice(0, 20);
  }
  if (has('priority')) {
    if (!PRIORITIES.includes(body.priority)) errors.push(`priority must be one of ${PRIORITIES.join(', ')}`);
    else out.priority = body.priority;
  }
  if (has('timeoutMs')) {
    const n = Number(body.timeoutMs);
    if (!Number.isInteger(n) || n < 100 || n > 300000) errors.push('timeoutMs must be an integer between 100 and 300000');
    else out.timeoutMs = n;
  }
  if (has('retries')) {
    const n = Number(body.retries);
    if (!Number.isInteger(n) || n < 0 || n > 5) errors.push('retries must be an integer between 0 and 5');
    else out.retries = n;
  }
  if (has('enabled')) out.enabled = Boolean(body.enabled);

  const type = out.type ?? body.type;
  if (!partial || has('config')) {
    const cfg = body.config ?? {};
    if (typeof cfg !== 'object' || Array.isArray(cfg)) errors.push('config must be an object');
    else if (type === 'http') {
      if (!cfg.url || typeof cfg.url !== 'string') errors.push('config.url is required for HTTP tests');
      const method = String(cfg.method ?? 'GET').toUpperCase();
      if (!METHODS.includes(method)) errors.push(`config.method must be one of ${METHODS.join(', ')}`);
      for (const [i, a] of (cfg.assertions ?? []).entries()) {
        if (!ASSERTION_TYPES.includes(a.type)) errors.push(`assertions[${i}].type is invalid`);
        if (!OPERATORS.includes(a.operator)) errors.push(`assertions[${i}].operator is invalid`);
        if (a.operator === 'matches') {
          try {
            new RegExp(a.expected);
          } catch {
            errors.push(`assertions[${i}].expected is not a valid regular expression`);
          }
        }
      }
      const { extract, dataset, ...rest } = cfg;
      out.config = { ...rest, method, ...validateChaining(cfg, errors, { allowExtract: true }) };
    } else if (type === 'script') {
      if (typeof cfg.code !== 'string' || !cfg.code.trim()) errors.push('config.code is required for script tests');
      out.config = { code: cfg.code, ...validateChaining(cfg, errors, { allowExtract: false }) };
    }
  }

  if (errors.length) throw new ValidationError(errors);
  return out;
}

export function validateEnvironment(body, { partial = false } = {}) {
  const errors = [];
  const out = {};
  if (!partial || body.name !== undefined) {
    if (typeof body.name !== 'string' || !body.name.trim()) errors.push('name is required');
    else out.name = body.name.trim();
  }
  if (body.variables !== undefined) {
    if (!body.variables || typeof body.variables !== 'object' || Array.isArray(body.variables)) errors.push('variables must be an object');
    else out.variables = Object.fromEntries(Object.entries(body.variables).filter(([k]) => k.trim()).map(([k, v]) => [k.trim(), String(v ?? '')]));
  }
  if (body.isDefault !== undefined) out.isDefault = Boolean(body.isDefault);
  if (errors.length) throw new ValidationError(errors);
  return out;
}

export function validateSchedule(body, { partial = false } = {}) {
  const errors = [];
  const out = {};
  const has = (k) => body[k] !== undefined;
  if (!partial || has('name')) {
    if (typeof body.name !== 'string' || !body.name.trim()) errors.push('name is required');
    else out.name = body.name.trim().slice(0, 120);
  }
  if (!partial || has('cron')) {
    try {
      parseCron(body.cron);
      out.cron = String(body.cron).trim().split(/\s+/).join(' ');
    } catch (err) {
      errors.push(`cron: ${err.message}`);
    }
  }
  if (has('suiteId')) out.suiteId = body.suiteId === null || body.suiteId === '' ? null : Number(body.suiteId);
  if (has('testIds')) out.testIds = Array.isArray(body.testIds) ? body.testIds.map(Number).filter(Number.isInteger) : [];
  if (has('environmentId')) out.environmentId = body.environmentId === null || body.environmentId === '' ? null : Number(body.environmentId);
  if (has('enabled')) out.enabled = Boolean(body.enabled);
  if (errors.length) throw new ValidationError(errors);
  return out;
}

export function validateChannel(body, { partial = false } = {}) {
  const errors = [];
  const out = {};
  const has = (k) => body[k] !== undefined;
  if (!partial || has('name')) {
    if (typeof body.name !== 'string' || !body.name.trim()) errors.push('name is required');
    else out.name = body.name.trim().slice(0, 120);
  }
  if (!partial || has('type')) {
    if (!['slack', 'teams', 'webhook'].includes(body.type)) errors.push('type must be slack, teams or webhook');
    else out.type = body.type;
  }
  if (!partial || has('url')) {
    try {
      const u = new URL(body.url);
      if (!['http:', 'https:'].includes(u.protocol)) throw new Error();
      out.url = u.toString();
    } catch {
      errors.push('url must be a valid http(s) URL');
    }
  }
  if (has('notifyOn')) {
    if (!['failures', 'always'].includes(body.notifyOn)) errors.push('notifyOn must be failures or always');
    else out.notifyOn = body.notifyOn;
  }
  if (has('scope')) {
    if (!['all', 'scheduled'].includes(body.scope)) errors.push('scope must be all or scheduled');
    else out.scope = body.scope;
  }
  if (has('enabled')) out.enabled = Boolean(body.enabled);
  if (errors.length) throw new ValidationError(errors);
  return out;
}

export function validateSettings(body) {
  const errors = [];
  const out = {};
  if (body.maxConcurrency !== undefined) {
    const n = Number(body.maxConcurrency);
    if (!Number.isInteger(n) || n < 1 || n > 16) errors.push('maxConcurrency must be between 1 and 16');
    else out.maxConcurrency = n;
  }
  if (body.defaultTimeoutMs !== undefined) {
    const n = Number(body.defaultTimeoutMs);
    if (!Number.isInteger(n) || n < 100 || n > 300000) errors.push('defaultTimeoutMs must be between 100 and 300000');
    else out.defaultTimeoutMs = n;
  }
  if (body.autoAnalyze !== undefined) out.autoAnalyze = Boolean(body.autoAnalyze);
  if (body.aiAutoAnalyzeLimit !== undefined) {
    const n = Number(body.aiAutoAnalyzeLimit);
    if (!Number.isInteger(n) || n < 0 || n > 50) errors.push('aiAutoAnalyzeLimit must be between 0 and 50');
    else out.aiAutoAnalyzeLimit = n;
  }
  if (errors.length) throw new ValidationError(errors);
  return out;
}
