/**
 * Provider-neutral prompts and JSON schemas for every AI task. Providers
 * (Gemini, Claude) receive a system prompt, a user prompt and a schema, and
 * must return JSON matching the schema.
 */
import { CATEGORIES, CATEGORY_KEYS, CONFIDENCE, OWNERS } from './categories.js';

export const truncate = (text, max) => {
  if (text == null) return text;
  const s = typeof text === 'string' ? text : JSON.stringify(text, null, 2);
  return s.length > max ? `${s.slice(0, max)}\n… [truncated]` : s;
};

// ----------------------------------------------------------------- schemas

export const FAILURE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    category: { type: 'string', enum: CATEGORY_KEYS },
    summary: { type: 'string', description: 'One sentence: what failed, in plain language.' },
    rootCause: { type: 'string', description: 'The most likely root cause and the reasoning that supports it (2-4 sentences).' },
    evidence: { type: 'array', items: { type: 'string' }, description: 'Concrete facts from the input that support the diagnosis.' },
    suggestedFixes: { type: 'array', items: { type: 'string' }, description: 'Ordered, actionable next steps (most useful first).' },
    confidence: { type: 'string', enum: CONFIDENCE },
    owner: { type: 'string', enum: OWNERS, description: 'Where the fix most likely belongs.' },
    isLikelyFlaky: { type: 'boolean' },
  },
  required: ['category', 'summary', 'rootCause', 'evidence', 'suggestedFixes', 'confidence', 'owner', 'isLikelyFlaky'],
};

export const RUN_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    headline: { type: 'string', description: 'One-line verdict on the run.' },
    overview: { type: 'string', description: '2-4 sentences: what broke, whether failures share a cause, and how risky a release would be.' },
    themes: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          category: { type: 'string', enum: CATEGORY_KEYS },
          testNames: { type: 'array', items: { type: 'string' } },
          explanation: { type: 'string' },
        },
        required: ['title', 'category', 'testNames', 'explanation'],
      },
    },
    recommendations: { type: 'array', items: { type: 'string' } },
    riskLevel: { type: 'string', enum: ['low', 'medium', 'high'] },
  },
  required: ['headline', 'overview', 'themes', 'recommendations', 'riskLevel'],
};

const KV_ARRAY = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: { key: { type: 'string' }, value: { type: 'string' } },
    required: ['key', 'value'],
  },
};

const ASSERTIONS = {
  type: 'array',
  items: {
    type: 'object',
    additionalProperties: false,
    properties: {
      type: { type: 'string', enum: ['status', 'responseTime', 'header', 'jsonPath', 'body'] },
      target: { type: 'string', description: 'JSON path or header name; empty otherwise' },
      operator: {
        type: 'string',
        enum: ['equals', 'notEquals', 'contains', 'notContains', 'lessThan', 'greaterThan', 'exists', 'notExists', 'matches', 'isType'],
      },
      expected: { type: 'string' },
    },
    required: ['type', 'target', 'operator', 'expected'],
  },
};

export const GENERATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    tests: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'] },
          url: { type: 'string', description: 'Absolute URL or one starting with {{baseUrl}}' },
          query: KV_ARRAY,
          headers: KV_ARRAY,
          body: { type: 'string', description: 'Request body (JSON text) or empty string' },
          tags: { type: 'array', items: { type: 'string' } },
          priority: { type: 'string', enum: ['low', 'medium', 'high'] },
          assertions: ASSERTIONS,
        },
        required: ['name', 'description', 'method', 'url', 'query', 'headers', 'body', 'tags', 'priority', 'assertions'],
      },
    },
    notes: { type: 'string', description: 'Assumptions made and anything the user must configure (e.g. variables).' },
  },
  required: ['tests', 'notes'],
};

export const FIX_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    fixable: { type: 'boolean', description: 'false when the failure reflects a real application/environment problem' },
    summary: { type: 'string', description: 'One line: what the fix changes (or why no fix is proposed).' },
    rationale: { type: 'string', description: 'Evidence for the change and anything the reviewer should double-check.' },
    risk: { type: 'string', enum: ['low', 'medium', 'high'], description: 'low = clearly outdated expectation; high = could hide a regression' },
    assertions: { ...ASSERTIONS, description: 'HTTP tests: the complete corrected assertion list. Script tests: [].' },
    code: { type: 'string', description: 'Script tests: the complete corrected script. HTTP tests: empty string.' },
  },
  required: ['fixable', 'summary', 'rationale', 'risk', 'assertions', 'code'],
};

// ---------------------------------------------------------- system prompts

export const FAILURE_SYSTEM = `You are a senior QA and reliability engineer embedded in a test automation platform. You diagnose why an automated test failed and tell the team exactly what to do next.

Ground every claim in the data you are given: the test definition, the request/response, assertion results, execution logs, and the test's recent pass/fail history. Prefer the simplest explanation the evidence supports. When the evidence is thin, say so and lower your confidence instead of speculating.

Categories:
${Object.entries(CATEGORIES)
  .map(([k, v]) => `- ${k}: ${v}`)
  .join('\n')}

Decide whether the fix belongs in the application, the test itself, or the environment. Treat a history that alternates between pass and fail as a strong flakiness signal. Suggested fixes should be specific to this failure, never generic advice.`;

export const RUN_SYSTEM = `You are a senior QA lead summarizing an automated test run for an engineering team. Group failures that share a root cause into themes, say what is most urgent, and judge release risk. Be concise and specific; use the provided per-test diagnoses as your primary evidence.`;

export const GENERATION_SYSTEM = `You are a senior QA automation engineer. You write executable HTTP API test cases for a test automation platform.

Each test is one HTTP request plus assertions:
- status (operator equals / lessThan / ...)
- jsonPath (target like "data[0].id" or "token"; operators equals, exists, notExists, isType [array|object|string|number|boolean], contains, matches, greaterThan, lessThan)
- header (target is the header name)
- responseTime (expected in ms)
- body (raw text)

Rules:
- Build URLs as {{baseUrl}}/path, and use other {{variables}} from the provided environment where they fit (credentials, tokens). Don't hard-code secrets.
- Cover the happy path, then the most valuable negative cases: validation errors, missing auth, unknown IDs.
- Assertions should be specific enough to catch real regressions without being brittle. Prefer field existence and types over exact dynamic values.
- When a spec is provided, only use endpoints that exist in it. When working from a description, infer conventional REST endpoints and state your assumptions in "notes".
- Give each test a clear, behaviour-focused name. Return at most 20 tests.`;

export const FIX_SYSTEM = `You repair automated API tests whose expectations have gone stale. You are given a failing test, the response it got, and, when available, the response from its last passing run.

Rules:
- Only propose a change when the evidence shows the test is out of date (a field was renamed, a success code changed from 200 to 201, a value changed intentionally) or the test itself is wrong (a bug in script code).
- Return fixable=false for real application or environment problems: 5xx errors, auth failures caused by bad credentials, network errors and genuine regressions. Never weaken a test to make a bug pass.
- Change as little as possible and keep every {{variable}} placeholder intact. Values that come from {{variables}} or dataset rows are not to be replaced with literals.
- For HTTP tests, return the complete corrected assertion list in the original order. For script tests, return the complete corrected code.
- Rate risk honestly: raising a latency budget or accepting a new value can hide a regression, so mark those medium or high.`;

// ------------------------------------------------------------ user prompts

export function failurePrompt({ result, testCase, history }) {
  const historyLine = history
    .slice(0, 15)
    .map((h) => (h.status === 'passed' ? 'P' : h.status === 'failed' ? 'F' : h.status === 'error' ? 'E' : '-'))
    .join(' ');
  const definition = testCase
    ? { name: testCase.name, description: testCase.description, type: testCase.type, timeoutMs: testCase.timeoutMs, retries: testCase.retries, config: testCase.config }
    : { name: result.testName, type: result.testType };

  return `<test_definition>
${truncate(definition, 6000)}
</test_definition>

<result status="${result.status}" attempts="${result.attempts}" duration_ms="${result.durationMs ?? ''}"${result.iteration ? ` data_row="${result.iteration.index}"` : ''}>
<error_message>${result.errorMessage ?? ''}</error_message>
<error_stack>${truncate(result.errorStack, 1500) ?? ''}</error_stack>
<assertions>
${truncate(result.assertions, 4000)}
</assertions>
<request>
${truncate(result.request, 3000) ?? 'n/a'}
</request>
<response>
${truncate(result.response, 6000) ?? 'n/a'}
</response>
<logs>
${truncate((result.logs ?? []).map((l) => `[${l.level}] ${l.message}`).join('\n'), 4000)}
</logs>
</result>

<recent_history newest_first="true">${historyLine || 'no prior runs'}</recent_history>

Diagnose this failure.`;
}

export function runPrompt({ run, results }) {
  const failures = results
    .filter((r) => r.status === 'failed' || r.status === 'error')
    .map((r) => ({
      test: r.displayName ?? r.testName,
      suite: r.suiteName,
      status: r.status,
      error: truncate(r.errorMessage, 400),
      diagnosis: r.analysis ? { category: r.analysis.category, rootCause: r.analysis.rootCause, owner: r.analysis.owner } : null,
    }));
  return `<run name="${run.name}" environment="${run.environmentName ?? 'default'}" total="${run.total}" passed="${run.passed}" failed="${run.failed}" errored="${run.errored}" flaky="${run.flaky}" duration_ms="${run.durationMs}">
<failures>
${truncate(failures, 20000)}
</failures>
<passed_tests>${results
    .filter((r) => r.status === 'passed')
    .map((r) => r.displayName ?? r.testName)
    .join(', ')}</passed_tests>
</run>

Summarize this run.`;
}

const SOURCE_LABELS = { openapi: 'OpenAPI / Swagger specification', curl: 'cURL command', description: 'plain-English description' };

export function generationPrompt({ source, input, variables }) {
  const label = SOURCE_LABELS[source];
  return `<environment_variables>
${Object.keys(variables).filter((k) => !k.startsWith('$')).map((k) => `{{${k}}}`).join(', ') || 'none'}
</environment_variables>

<source type="${label}">
${truncate(input, 120000)}
</source>

Generate test cases for this ${label}.`;
}

export function fixPrompt({ test, result, previousPass }) {
  return `<test type="${test.type}">
${truncate({ name: test.name, description: test.description, config: test.config }, 12000)}
</test>

<failed_result status="${result.status}"${result.iteration ? ` data_row="${result.iteration.index}"` : ''}>
<error>${result.errorMessage ?? ''}</error>
<assertions>
${truncate(result.assertions, 4000)}
</assertions>
<response>
${truncate(result.response, 8000) ?? 'n/a'}
</response>
<logs>
${truncate((result.logs ?? []).map((l) => `[${l.level}] ${l.message}`).join('\n'), 3000)}
</logs>
</failed_result>

<last_passing_response>
${previousPass ? truncate(previousPass.response, 6000) : 'none recorded'}
</last_passing_response>

<diagnosis>${result.analysis ? truncate({ category: result.analysis.category, rootCause: result.analysis.rootCause, owner: result.analysis.owner }, 1500) : 'none'}</diagnosis>

Propose a fix for this test, or explain why it should not be changed.`;
}
