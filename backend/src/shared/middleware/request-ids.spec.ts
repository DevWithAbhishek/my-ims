import express from 'express';
import request from 'supertest';
import { requestIdHeader, requestMiddleware } from './request-ids.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const app = express();
app.use(requestMiddleware);
app.get('/id', (_req, res) => {
  res.json({ requestId: res.locals.requestId });
});

describe('requestMiddleware', () => {
  it('accepts a valid incoming request id and echoes it', async () => {
    const res = await request(app).get('/id').set(requestIdHeader, 'client-req_123-ABC');
    expect(res.headers['x-request-id']).toBe('client-req_123-ABC');
    expect(res.body.requestId).toBe('client-req_123-ABC');
  });

  it('accepts an id of exactly 128 characters', async () => {
    const id = 'a'.repeat(128);
    const res = await request(app).get('/id').set(requestIdHeader, id);
    expect(res.headers['x-request-id']).toBe(id);
  });

  it('replaces an id longer than 128 characters', async () => {
    const res = await request(app).get('/id').set(requestIdHeader, 'a'.repeat(129));
    expect(res.headers['x-request-id']).toMatch(UUID);
  });

  it.each(['bad id', 'bad.id', 'bad/id', 'bad;id', 'bad\u00e9id'])(
    'replaces an id with invalid characters (%s)',
    async (id) => {
      const res = await request(app).get('/id').set(requestIdHeader, id);
      expect(res.headers['x-request-id']).toMatch(UUID);
      expect(res.body.requestId).toBe(res.headers['x-request-id']);
    },
  );

  it('generates a UUID when no id is sent', async () => {
    const res = await request(app).get('/id');
    expect(res.headers['x-request-id']).toMatch(UUID);
  });
});
