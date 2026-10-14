import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import request from 'supertest';
import { errorMappingMiddleware } from '../../shared/middleware/error-mapping.js';
import { logger } from '../../shared/observability/logger.js';
import { captureRawBody, RAW_BODY_KEY } from './raw-body.js';

logger.level = 'silent';

const LIMIT = 1024;

function buildApp() {
  const app = express();
  app.post('/raw', captureRawBody(LIMIT), (_req, res) => {
    const raw = res.locals[RAW_BODY_KEY] as Buffer;
    res.json({ length: raw.length, text: raw.toString('utf8') });
  });
  app.use(errorMappingMiddleware);
  return app;
}

describe('captureRawBody', () => {
  it('captures the exact bytes, whatever the content type', async () => {
    const res = await request(buildApp())
      .post('/raw')
      .set('Content-Type', 'text/plain')
      .send('{ "a" :  1 }');
    expect(res.body).toEqual({ length: 12, text: '{ "a" :  1 }' });
  });

  it('accepts an empty body', async () => {
    const res = await request(buildApp()).post('/raw');
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(0);
  });

  it('accepts a body of exactly the limit', async () => {
    const res = await request(buildApp()).post('/raw').send('x'.repeat(LIMIT));
    expect(res.status).toBe(200);
    expect(res.body.length).toBe(LIMIT);
  });

  it('rejects a body one byte over the limit with 413 PAYLOAD_TOO_LARGE', async () => {
    const res = await request(buildApp())
      .post('/raw')
      .send('x'.repeat(LIMIT + 1));
    expect(res.status).toBe(413);
    expect(res.body.error).toMatchObject({ code: 'PAYLOAD_TOO_LARGE', details: [] });
  });

  it('stops a chunked body (no Content-Length) once it passes the limit', async () => {
    const server = buildApp().listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const status = await new Promise<number>((resolve, reject) => {
        const req = http.request(
          { port, method: 'POST', path: '/raw', headers: { 'Transfer-Encoding': 'chunked' } },
          (res) => {
            res.resume();
            resolve(res.statusCode ?? 0);
          },
        );
        req.on('error', reject);
        req.write('x'.repeat(LIMIT));
        req.write('y'); // one byte over
        req.end();
      });
      expect(status).toBe(413);
    } finally {
      server.close();
      server.closeAllConnections();
    }
  });
});
