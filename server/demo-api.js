import express from 'express';

/**
 * A small, deliberately imperfect API mounted at /demo-api so the seeded test
 * cases have something real to exercise. Some endpoints are designed to fail
 * (server errors, slowness, flakiness, a renamed field) to showcase reporting
 * and AI root-cause analysis.
 */
export function createDemoApi() {
  const router = express.Router();
  const startedAt = Date.now();
  const DEMO_TOKEN = 'demo-token-7f3a';

  const users = [
    { id: 1, name: 'Ada Lovelace', email: 'ada@example.com', role: 'admin' },
    { id: 2, name: 'Alan Turing', email: 'alan@example.com', role: 'member' },
    { id: 3, name: 'Grace Hopper', email: 'grace@example.com', role: 'member' },
    { id: 4, name: 'Katherine Johnson', email: 'katherine@example.com', role: 'member' },
    { id: 5, name: 'Linus Torvalds', email: 'linus@example.com', role: 'viewer' },
  ];
  let nextId = 100;

  const products = [
    { sku: 'KB-01', name: 'Mechanical Keyboard', category: 'peripherals', price: 129.0, stock: 42 },
    { sku: 'MS-02', name: 'Wireless Mouse', category: 'peripherals', price: 49.5, stock: 0 },
    { sku: 'MN-27', name: '27" 4K Monitor', category: 'displays', price: 399.0, stock: 7 },
    { sku: 'HD-10', name: 'USB-C Hub', category: 'accessories', price: 39.99, stock: 120 },
  ];

  const requireToken = (req, res, next) => {
    const header = req.get('authorization') ?? '';
    if (header !== `Bearer ${DEMO_TOKEN}`) return res.status(401).json({ error: 'Missing or invalid bearer token' });
    next();
  };

  router.get('/health', (_req, res) => res.json({ status: 'ok', uptimeSeconds: Math.round((Date.now() - startedAt) / 1000), version: '2.4.1' }));

  router.post('/auth/login', (req, res) => {
    const { username, password } = req.body ?? {};
    if (username === 'demo' && password === 'demo123') return res.json({ token: DEMO_TOKEN, expiresIn: 3600, user: { username } });
    res.status(401).json({ error: 'Invalid credentials' });
  });

  router.get('/users', (_req, res) => res.json({ data: users, total: users.length }));

  router.get('/users/:id', (req, res) => {
    const user = users.find((u) => u.id === Number(req.params.id));
    if (!user) return res.status(404).json({ error: `User ${req.params.id} not found` });
    res.json(user);
  });

  router.post('/users', (req, res) => {
    const { name, email, role = 'member' } = req.body ?? {};
    const errors = [];
    if (!name || typeof name !== 'string') errors.push({ field: 'name', message: 'name is required' });
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) errors.push({ field: 'email', message: 'email must be a valid address' });
    if (errors.length) return res.status(400).json({ error: 'Validation failed', details: errors });
    const user = { id: nextId++, name, email, role };
    res.status(201).location(`/demo-api/users/${user.id}`).json(user);
  });

  // v2 "accidentally" renamed `name` -> `fullName`: a contract change.
  router.get('/v2/users/:id', (req, res) => {
    const user = users.find((u) => u.id === Number(req.params.id));
    if (!user) return res.status(404).json({ error: 'not found' });
    const { name, ...rest } = user;
    res.json({ ...rest, fullName: name, apiVersion: 2 });
  });

  router.get('/products', (req, res) => {
    const { category } = req.query;
    const data = category ? products.filter((p) => p.category === category) : products;
    res.json({ data, total: data.length });
  });

  router.get('/orders', requireToken, (_req, res) =>
    res.json({
      data: [
        { id: 'ORD-1001', sku: 'KB-01', quantity: 2, status: 'shipped' },
        { id: 'ORD-1002', sku: 'MN-27', quantity: 1, status: 'processing' },
      ],
    }),
  );

  router.get('/search', async (req, res) => {
    const ms = Math.min(Number(req.query.delay) || 900, 10000);
    await new Promise((r) => setTimeout(r, ms + Math.random() * 120));
    res.json({ query: req.query.q ?? '', results: products.slice(0, 2), tookMs: ms });
  });

  // Fails roughly 40% of the time.
  router.get('/recommendations', (_req, res) => {
    if (Math.random() < 0.4) return res.status(503).json({ error: 'Recommendation engine unavailable', retryAfter: 2 });
    res.json({ items: products.slice(1, 3).map((p) => p.sku) });
  });

  router.get('/inventory/health', (_req, res) =>
    res.status(500).json({ error: 'Database connection pool exhausted', code: 'DB_POOL_EXHAUSTED', activeConnections: 50, maxConnections: 50 }),
  );

  router.use((_req, res) => res.status(404).json({ error: 'Not found' }));
  return router;
}
