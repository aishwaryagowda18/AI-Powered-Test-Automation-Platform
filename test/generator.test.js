import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { draftsFromAI, exampleFromSchema, shellSplit, testFromCurl, testsFromOpenApi } from '../server/ai/generator.js';
import { buildPayload, shouldNotify } from '../server/notifications.js';
import { validateTest } from '../server/validation.js';

const spec = {
  openapi: '3.0.0',
  security: [{ bearer: [] }],
  paths: {
    '/pets': {
      get: {
        summary: 'List pets',
        tags: ['Pets'],
        security: [],
        parameters: [{ name: 'limit', in: 'query', required: true, schema: { type: 'integer', example: 10 } }],
        responses: { 200: { content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Pet' } } } } } },
      },
      post: {
        summary: 'Create pet',
        requestBody: { content: { 'application/json': { schema: { $ref: '#/components/schemas/NewPet' } } } },
        responses: { 201: { content: { 'application/json': { schema: { $ref: '#/components/schemas/Pet' } } } }, 400: {} },
      },
    },
    '/pets/{petId}': {
      parameters: [{ name: 'petId', in: 'path', required: true, schema: { type: 'string', format: 'uuid' } }],
      delete: { operationId: 'deletePet', responses: { 204: {} } },
    },
  },
  components: {
    schemas: {
      Pet: { type: 'object', required: ['id', 'name'], properties: { id: { type: 'integer', readOnly: true }, name: { type: 'string' }, tag: { type: 'string' } } },
      NewPet: { allOf: [{ $ref: '#/components/schemas/Pet' }, { type: 'object', properties: { email: { type: 'string', format: 'email' } } }] },
    },
  },
};

describe('OpenAPI → tests', () => {
  const { tests, warnings } = testsFromOpenApi(spec);

  it('creates one valid test per operation', () => {
    assert.equal(tests.length, 3);
    for (const t of tests) validateTest(t); // throws if the draft is not importable
  });

  it('fills query/path params, bodies, auth and assertions', () => {
    const [list, create, del] = tests;
    assert.equal(list.config.url, '{{baseUrl}}/pets');
    assert.deepEqual(list.config.query, [{ key: 'limit', value: '10' }]);
    assert.ok(!list.config.headers.some((h) => h.key === 'Authorization'), 'operation-level security: [] disables auth');
    assert.deepEqual(list.config.assertions[1], { type: 'jsonPath', target: '$', operator: 'isType', expected: 'array' });

    assert.equal(create.config.method, 'POST');
    assert.deepEqual(JSON.parse(create.config.body), { name: 'string', tag: 'string', email: 'user@example.com' });
    assert.equal(create.config.assertions[0].expected, '201');
    assert.deepEqual(create.config.assertions.slice(1).map((a) => a.target), ['id', 'name']);
    assert.ok(create.config.headers.some((h) => h.value === 'Bearer {{token}}'));

    assert.equal(del.name, 'deletePet');
    assert.match(del.config.url, /\/pets\/00000000-0000-4000-8000-000000000001$/);
    assert.ok(warnings.some((w) => w.includes('{{token}}')));
  });

  it('rejects documents without paths', () => {
    assert.throws(() => testsFromOpenApi({ info: {} }), /OpenAPI/);
  });

  it('builds examples from schemas', () => {
    assert.deepEqual(exampleFromSchema({ type: 'array', items: { type: 'boolean' } }, {}), [true]);
    assert.equal(exampleFromSchema({ enum: ['a', 'b'] }, {}), 'a');
  });
});

describe('cURL → test', () => {
  it('splits shell arguments with quotes and continuations', () => {
    assert.deepEqual(shellSplit(`curl -H "A: b c" \\\n 'http://x/y?q=1'`), ['curl', '-H', 'A: b c', 'http://x/y?q=1']);
  });

  it('parses method, headers, JSON body and maps baseUrl', () => {
    const { tests, warnings } = testFromCurl(
      `curl -X POST 'http://localhost:4000/demo-api/users' -H 'Content-Type: application/json' -H "Authorization: Bearer abc" -d '{"name":"Ada"}'`,
      { baseUrl: 'http://localhost:4000/demo-api' },
    );
    const t = tests[0];
    validateTest(t);
    assert.equal(t.config.method, 'POST');
    assert.equal(t.config.url, '{{baseUrl}}/users');
    assert.equal(t.config.bodyType, 'json');
    assert.deepEqual(JSON.parse(t.config.body), { name: 'Ada' });
    assert.equal(t.config.headers.length, 2);
    assert.equal(warnings.length, 0);
  });

  it('treats localhost and 127.0.0.1 as the same host when mapping baseUrl', () => {
    const t = testFromCurl('curl http://localhost:4000/demo-api/health', { baseUrl: 'http://127.0.0.1:4000/demo-api' }).tests[0];
    assert.equal(t.config.url, '{{baseUrl}}/health');
  });

  it('defaults to POST when data is present and handles basic auth', () => {
    const t = testFromCurl('curl https://api.example.com/login -u alice:secret --data user=alice').tests[0];
    assert.equal(t.config.method, 'POST');
    assert.equal(t.config.bodyType, 'text');
    assert.ok(t.config.headers.some((h) => h.key === 'Authorization' && h.value === `Basic ${Buffer.from('alice:secret').toString('base64')}`));
  });

  it('rejects non-curl input', () => {
    assert.throws(() => testFromCurl('wget http://x'), /curl/);
  });
});

describe('AI drafts', () => {
  it('converts structured output into importable tests', () => {
    const [t] = draftsFromAI({
      tests: [
        {
          name: 'Create user',
          description: 'd',
          method: 'POST',
          url: '{{baseUrl}}/users',
          query: [],
          headers: [],
          body: '{"name":"{{username}}"}',
          tags: ['Users'],
          priority: 'high',
          assertions: [{ type: 'status', target: '', operator: 'equals', expected: '201' }],
        },
      ],
    });
    validateTest(t);
    assert.equal(t.config.bodyType, 'json');
    assert.deepEqual(t.tags, ['users', 'generated', 'ai']);
  });
});

describe('notification payloads', () => {
  const run = { id: 7, name: 'Nightly', status: 'failed', trigger: 'schedule', total: 3, passed: 1, failed: 1, errored: 1, skipped: 0, flaky: 0, durationMs: 1500, environmentName: 'Local', aiSummary: { headline: '2 failures', riskLevel: 'high', source: 'claude', recommendations: ['Fix DB'] } };
  const failures = [{ testName: 'Inventory', status: 'failed', errorMessage: '500', analysis: { categoryLabel: 'Server error', summary: 'DB pool exhausted' } }];

  it('filters by outcome and scope', () => {
    assert.equal(shouldNotify({ enabled: true, notifyOn: 'failures', scope: 'all' }, run), true);
    assert.equal(shouldNotify({ enabled: true, notifyOn: 'failures', scope: 'all' }, { ...run, status: 'passed' }), false);
    assert.equal(shouldNotify({ enabled: true, notifyOn: 'always', scope: 'scheduled' }, { ...run, trigger: 'manual' }), false);
    assert.equal(shouldNotify({ enabled: false, notifyOn: 'always', scope: 'all' }, run), false);
  });

  it('builds Slack, Teams and generic payloads', () => {
    const slack = buildPayload('slack', { run, failures, link: 'http://x/runs/7' });
    assert.match(slack.text, /Nightly: FAILED/);
    assert.ok(JSON.stringify(slack.blocks).includes('DB pool exhausted'));
    assert.ok(JSON.stringify(slack.blocks).includes('release risk: high'));

    const teams = buildPayload('teams', { run, failures, link: 'http://x/runs/7' });
    assert.equal(teams.attachments[0].contentType, 'application/vnd.microsoft.card.adaptive');
    assert.equal(teams.attachments[0].content.actions[0].url, 'http://x/runs/7');

    const hook = buildPayload('webhook', { run, failures, link: 'http://x/runs/7' });
    assert.equal(hook.event, 'run.finished');
    assert.equal(hook.run.passRate, 33.3);
    assert.equal(hook.failures[0].diagnosis, 'DB pool exhausted');
  });
});
