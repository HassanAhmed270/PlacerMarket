const request = require('supertest');

// db.service.js constructs a pg Pool at require time but doesn't connect
// until a query actually runs — safe to require the real app here as long
// as the routes under test don't touch the DB.
const app = require('../../src/app');

describe('smoke: app boots and routes respond', () => {
  test('GET /api/catalog/condition-types returns the fixed list (no DB touch)', async () => {
    const res = await request(app).get('/api/catalog/condition-types');
    expect(res.status).toBe(200);
    expect(res.body).toEqual(['brand_new', 'pre_owned', 'custom_made', 'replica']);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-security-policy']).toContain('default-src');
    expect(res.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/i);
  });

  test('SEC-01: public registration stays unavailable until server-side password hashing is implemented', async () => {
    const res = await request(app).post('/api/users/register').send({ passwordHash: 'client-controlled' });
    expect(res.status).toBe(501);
  });

  test('SEC-25: rejects JSON bodies larger than the explicit one-megabyte limit', async () => {
    const res = await request(app).post('/api/users/register').send({ data: 'x'.repeat(1024 * 1024) });
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ error: 'Request body too large' });
  });

  test('POST /api/listings without auth returns 401 (requireAuth middleware)', async () => {
    const res = await request(app).post('/api/listings').send({});
    expect(res.status).toBe(401);
  });

  test('a POST with no body still gives handlers an empty req.body (Express 5 leaves it undefined)', async () => {
    app.post('/__probe', (req, res) => res.json({ reason: req.body.reason ?? null }));
    const res = await request(app).post('/__probe');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reason: null });
  });

  test('a rejected async handler (no wrapper) reaches the error handler with its status', async () => {
    const { NotFoundError } = require('../../src/lib/errors');
    app.get('/__boom', async () => { throw new NotFoundError('order', 'x'); });
    const res = await request(app).get('/__boom');
    expect(res.status).toBe(404);
  });

  test('unknown route falls through to Express 404, not a crash', async () => {
    const res = await request(app).get('/api/does-not-exist');
    expect(res.status).toBe(404);
  });
});
