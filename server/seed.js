/** Demo suites, environments and test cases created on first boot. */

const status = (expected) => ({ type: 'status', operator: 'equals', expected: String(expected) });
const json = (target, operator, expected = '') => ({ type: 'jsonPath', target, operator, expected });
const fast = (ms) => ({ type: 'responseTime', operator: 'lessThan', expected: String(ms) });

export function seedDatabase(store) {
  const env = store.createEnvironment({
    name: 'Local demo',
    isDefault: true,
    variables: {
      baseUrl: '{{$serverUrl}}/demo-api',
      username: 'demo',
      password: 'demo123',
      paymentUrl: 'http://127.0.0.1:59999',
    },
  });
  store.createEnvironment({
    name: 'Staging (example)',
    variables: {
      baseUrl: 'https://staging.example.com/api',
      username: 'qa-bot',
      password: 'change-me',
      paymentUrl: 'https://payments.staging.example.com',
    },
  });

  const smoke = store.createSuite({ name: 'Smoke', description: 'Fast checks that the platform is up and core auth works.' });
  const users = store.createSuite({ name: 'Users API', description: 'CRUD and contract checks for the users service.' });
  const resilience = store.createSuite({ name: 'Resilience & Performance', description: 'Dependencies, SLAs and known-unstable services.' });

  const http = (suite, name, description, config, extra = {}) =>
    store.createTest({ name, description, type: 'http', suiteId: suite.id, config, ...extra });
  const script = (suite, name, description, code, extra = {}) =>
    store.createTest({ name, description, type: 'script', suiteId: suite.id, config: { code }, ...extra });

  http(smoke, 'Health check returns OK', 'Service responds and reports healthy status.', {
    method: 'GET',
    url: '{{baseUrl}}/health',
    assertions: [status(200), json('status', 'equals', 'ok'), fast(1000)],
  }, { tags: ['smoke', 'critical'], priority: 'high' });

  http(smoke, 'Login with valid credentials', 'Valid credentials return a bearer token, captured as {{token}} for later tests.', {
    method: 'POST',
    url: '{{baseUrl}}/auth/login',
    bodyType: 'json',
    body: '{\n  "username": "{{username}}",\n  "password": "{{password}}"\n}',
    assertions: [status(200), json('token', 'exists'), json('expiresIn', 'greaterThan', '0')],
    extract: [{ variable: 'token', from: 'jsonPath', path: 'token' }],
  }, { tags: ['smoke', 'auth'], priority: 'high' });

  http(smoke, 'List orders with captured token', 'Chained test: uses the {{token}} captured by the login test.', {
    method: 'GET',
    url: '{{baseUrl}}/orders',
    headers: [{ key: 'Authorization', value: 'Bearer {{token}}' }],
    assertions: [status(200), json('data', 'isType', 'array'), json('data.length', 'equals', '2')],
  }, { tags: ['smoke', 'auth', 'chained'], priority: 'high' });

  http(smoke, 'Login rejects wrong password', 'Bad credentials must return 401.', {
    method: 'POST',
    url: '{{baseUrl}}/auth/login',
    bodyType: 'json',
    body: '{ "username": "{{username}}", "password": "wrong" }',
    assertions: [status(401), json('error', 'contains', 'Invalid')],
  }, { tags: ['auth', 'negative'] });

  http(users, 'List users', 'Returns the full user collection.', {
    method: 'GET',
    url: '{{baseUrl}}/users',
    assertions: [status(200), json('data', 'isType', 'array'), json('total', 'equals', '5'), { type: 'header', target: 'content-type', operator: 'contains', expected: 'application/json' }],
  }, { tags: ['users'] });

  http(users, 'Get user by id', 'Fetches a single user and checks the payload.', {
    method: 'GET',
    url: '{{baseUrl}}/users/1',
    assertions: [status(200), json('name', 'equals', 'Ada Lovelace'), json('email', 'matches', '^[^@]+@example\\.com$')],
  }, { tags: ['users'] });

  http(users, 'Unknown user returns 404', 'Non-existent IDs must 404, not 500.', {
    method: 'GET',
    url: '{{baseUrl}}/users/9999',
    assertions: [status(404)],
  }, { tags: ['users', 'negative'] });

  http(users, 'Create user validates email', 'Invalid email is rejected with a field-level error.', {
    method: 'POST',
    url: '{{baseUrl}}/users',
    bodyType: 'json',
    body: '{ "name": "Test User", "email": "not-an-email" }',
    assertions: [status(400), json('details[0].field', 'equals', 'email')],
  }, { tags: ['users', 'validation'] });

  http(users, 'Fetch users by id (data-driven)', 'Runs once per CSV row; each row checks a different user.', {
    method: 'GET',
    url: '{{baseUrl}}/users/{{id}}',
    assertions: [status(200), json('name', 'equals', '{{name}}'), json('role', 'equals', '{{role}}')],
    dataset: { content: 'id,name,role\n1,Ada Lovelace,admin\n2,Alan Turing,member\n3,Grace Hopper,member\n5,Linus Torvalds,viewer' },
  }, { tags: ['users', 'data-driven'] });

  http(users, 'Login outcomes (data-driven)', 'Valid and invalid credential combinations with their expected status codes.', {
    method: 'POST',
    url: '{{baseUrl}}/auth/login',
    bodyType: 'json',
    body: '{ "username": "{{user}}", "password": "{{pass}}" }',
    assertions: [{ type: 'status', operator: 'equals', expected: '{{expectedStatus}}' }],
    dataset: { content: 'user,pass,expectedStatus\ndemo,demo123,200\ndemo,wrong-password,401\nunknown,demo123,401\n,,401' },
  }, { tags: ['auth', 'data-driven', 'negative'] });

  http(users, 'User profile v2 contract', 'v2 profile must keep the `name` field for backwards compatibility.', {
    method: 'GET',
    url: '{{baseUrl}}/v2/users/1',
    assertions: [status(200), json('name', 'exists'), json('email', 'exists')],
  }, { tags: ['users', 'contract'], priority: 'high' });

  script(users, 'Create then fetch a user (script)', 'End-to-end flow written as a script test.', `// Scripts get: http, expect, assert, log, sleep, vars
const email = \`user\${Date.now()}@example.com\`;
const created = await http.post(\`\${vars.baseUrl}/users\`, { name: 'Script User', email });
expect(created.status, 'create status').toBe(201);
expect(created.json, 'created user').toHaveProperty('id');
log('Created user', created.json.id);

const fetched = await http.get(\`\${vars.baseUrl}/users/1\`);
expect(fetched.status, 'fetch status').toBe(200);
expect(fetched.json.role, 'role').toBe('admin');`, { tags: ['users', 'e2e'] });

  script(resilience, 'Orders require authentication (script)', 'Logs in, then uses the token to read orders.', `const anon = await http.get(\`\${vars.baseUrl}/orders\`);
expect(anon.status, 'anonymous status').toBe(401);

const login = await http.post(\`\${vars.baseUrl}/auth/login\`, { username: vars.username, password: vars.password });
expect(login.status, 'login status').toBe(200);

const orders = await http.get(\`\${vars.baseUrl}/orders\`, {
  headers: { Authorization: \`Bearer \${login.json.token}\` },
});
expect(orders.status, 'orders status').toBe(200);
expect(orders.json.data, 'orders').toHaveLength(2);`, { tags: ['auth', 'e2e'], priority: 'high' });

  http(resilience, 'Inventory service healthy', 'Inventory dependency health endpoint.', {
    method: 'GET',
    url: '{{baseUrl}}/inventory/health',
    assertions: [status(200)],
  }, { tags: ['dependency'], priority: 'high' });

  http(resilience, 'Search responds within SLA', 'Search must answer in under 500 ms.', {
    method: 'GET',
    url: '{{baseUrl}}/search',
    query: [{ key: 'q', value: 'keyboard' }],
    assertions: [status(200), fast(500)],
  }, { tags: ['performance'] });

  http(resilience, 'Recommendations available', 'Recommendation engine (known to be unstable).', {
    method: 'GET',
    url: '{{baseUrl}}/recommendations',
    assertions: [status(200), json('items', 'isType', 'array')],
  }, { tags: ['dependency', 'flaky'], retries: 1 });

  http(resilience, 'Payment gateway reachable', 'External payment provider ping.', {
    method: 'GET',
    url: '{{paymentUrl}}/ping',
    assertions: [status(200)],
  }, { tags: ['dependency', 'external'], timeoutMs: 3000 });

  // Example schedules, created disabled so a fresh install doesn't run on its own.
  store.createSchedule({ name: 'Smoke check every 15 minutes', cron: '*/15 * * * *', suiteId: smoke.id, environmentId: env.id, enabled: false });
  store.createSchedule({ name: 'Nightly full regression', cron: '0 2 * * *', environmentId: env.id, enabled: false });

  script(resilience, 'Product stock sanity (script)', 'Every in-stock product must have a positive price.', `const res = await http.get(\`\${vars.baseUrl}/products\`);
expect(res.status).toBe(200);
const inStock = res.json.data.filter((p) => p.stock > 0);
log(\`\${inStock.length} products in stock\`);
for (const p of inStock) expect(p.price, \`\${p.sku} price\`).toBeGreaterThan(0);`, { tags: ['data'] });
}
