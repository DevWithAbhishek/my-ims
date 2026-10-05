import express from 'express';
import request from 'supertest';
import { errorMappingMiddleware } from './error-mapping.js';
import { requireJsonBody } from './json-body.js';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.post('/echo', requireJsonBody, (req, res) => {
    res.json({ body: req.body ?? null });
  });
  app.use(errorMappingMiddleware);
  return app;
}

describe('requireJsonBody', () => {
  it('accepts a JSON body', async () => {
    const res = await request(buildApp()).post('/echo').send({ a: 1 });
    expect(res.status).toBe(200);
  });

  it('accepts a request without a body', async () => {
    const res = await request(buildApp()).post('/echo');
    expect(res.status).toBe(200);
  });

  it('rejects a non-JSON body with 400 BAD_REQUEST', async () => {
    const res = await request(buildApp())
      .post('/echo')
      .set('Content-Type', 'text/plain')
      .send('hi');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('BAD_REQUEST');
  });
});
