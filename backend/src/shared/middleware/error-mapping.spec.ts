import express, { type Express, type RequestHandler } from 'express';
import request from 'supertest';
import { z } from 'zod';
import {
  AppError,
  BadRequestError,
  ConflictError,
  ForbiddenError,
  InternalError,
  NotFoundError,
  PayloadTooLargeError,
  ServiceUnavailableError,
  TooManyRequestsError,
  UnauthorizedError,
  ValidationError,
} from '../errors/AppError.js';
import { parseOrThrow } from '../errors/zod.js';
import * as loggerModule from '../observability/logger.js';
import { errorMappingMiddleware } from './error-mapping.js';
import { requestMiddleware } from './request-ids.js';

const log = { error: jest.fn(), warn: jest.fn() };

beforeEach(() => {
  log.error.mockClear();
  log.warn.mockClear();
  jest
    .spyOn(loggerModule, 'childLogger')
    .mockReturnValue(log as unknown as ReturnType<typeof loggerModule.childLogger>);
});

afterEach(() => {
  jest.restoreAllMocks();
});

const detail = { field: 'x', issue: 'bad' };

const cases: [string, () => AppError, number, string, Record<string, string>][] = [
  [
    'BadRequestError',
    () => new BadRequestError('bad', 'BAD_REQUEST', [detail]),
    400,
    'BAD_REQUEST',
    {},
  ],
  ['UnauthorizedError', () => new UnauthorizedError(), 401, 'UNAUTHENTICATED', {}],
  ['ForbiddenError', () => new ForbiddenError(), 403, 'FORBIDDEN', {}],
  ['NotFoundError', () => new NotFoundError('nope', 'THING_NOT_FOUND'), 404, 'THING_NOT_FOUND', {}],
  ['ConflictError', () => new ConflictError('clash', 'THING_CONFLICT'), 409, 'THING_CONFLICT', {}],
  ['PayloadTooLargeError', () => new PayloadTooLargeError('big', 'TOO_BIG'), 413, 'TOO_BIG', {}],
  [
    'ValidationError',
    () => new ValidationError('invalid', 'VALIDATION_FAILED', [detail]),
    422,
    'VALIDATION_FAILED',
    {},
  ],
  [
    'TooManyRequestsError',
    () => new TooManyRequestsError('slow', 'RATE_LIMITED', 30),
    429,
    'RATE_LIMITED',
    { 'retry-after': '30' },
  ],
  ['InternalError', () => new InternalError(), 500, 'INTERNAL_ERROR', {}],
  [
    'ServiceUnavailableError',
    () => new ServiceUnavailableError('down', 'DEPENDENCY_UNAVAILABLE', 7),
    503,
    'DEPENDENCY_UNAVAILABLE',
    { 'retry-after': '7' },
  ],
];

function buildApp(route: RequestHandler): Express {
  const app = express();
  app.use(requestMiddleware);
  app.use(express.json());
  app.post('/fail', route);
  app.use(errorMappingMiddleware);
  return app;
}

describe('errorMappingMiddleware', () => {
  it.each(cases)('maps %s to the envelope', async (_name, make, status, code, headers) => {
    const error = make();
    const res = await request(
      buildApp(() => {
        throw error;
      }),
    )
      .post('/fail')
      .set('X-Request-Id', 'req-1');

    expect(res.status).toBe(status);
    expect(res.body).toEqual({
      error: {
        code,
        message: status === 500 ? 'Internal server error' : error.message,
        details: error.details,
        requestId: 'req-1',
      },
    });
    expect(Array.isArray(res.body.error.details)).toBe(true);
    for (const [name, value] of Object.entries(headers)) {
      expect(res.headers[name]).toBe(value);
    }
  });

  it('does not set Retry-After when none is configured', async () => {
    const res = await request(
      buildApp(() => {
        throw new ServiceUnavailableError();
      }),
    ).post('/fail');
    expect(res.status).toBe(503);
    expect(res.headers['retry-after']).toBeUndefined();
  });

  it('forwards errors rejected from async handlers', async () => {
    const res = await request(
      buildApp(async () => {
        throw new ConflictError('clash', 'X_CONFLICT');
      }),
    ).post('/fail');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('X_CONFLICT');
  });

  it('echoes the generated request id in error.requestId', async () => {
    const res = await request(
      buildApp(() => {
        throw new ForbiddenError();
      }),
    ).post('/fail');
    expect(res.body.error.requestId).toBe(res.headers['x-request-id']);
  });

  describe('unknown errors', () => {
    it('returns only INTERNAL_ERROR and the request id, without leaking details', async () => {
      const secret = 'select * from "User" where password = $1 -- leaked';
      const res = await request(
        buildApp(() => {
          throw new Error(secret);
        }),
      )
        .post('/fail')
        .set('X-Request-Id', 'req-500');

      expect(res.status).toBe(500);
      expect(res.body).toEqual({
        error: {
          code: 'INTERNAL_ERROR',
          message: 'Internal server error',
          details: [],
          requestId: 'req-500',
        },
      });
      expect(JSON.stringify(res.body)).not.toContain('leaked');
      expect(JSON.stringify(res.body)).not.toContain('at ');
    });

    it('logs at error level with the stack', async () => {
      const error = new Error('boom');
      await request(
        buildApp(() => {
          throw error;
        }),
      ).post('/fail');

      expect(log.error).toHaveBeenCalledWith({ err: error }, 'Unhandled error');
      expect(log.warn).not.toHaveBeenCalled();
    });
  });

  describe('logging of AppErrors', () => {
    it('logs 4xx at warn without a stack', async () => {
      await request(
        buildApp(() => {
          throw new ForbiddenError();
        }),
      ).post('/fail');

      expect(log.warn).toHaveBeenCalledWith(
        { errorCode: 'FORBIDDEN', statusCode: 403 },
        'Forbidden',
      );
      expect(log.error).not.toHaveBeenCalled();
    });

    it('logs 5xx at error', async () => {
      await request(
        buildApp(() => {
          throw new ServiceUnavailableError();
        }),
      ).post('/fail');

      expect(log.error).toHaveBeenCalledTimes(1);
    });
  });

  describe('Zod errors', () => {
    const schema = z.strictObject({ name: z.string() });
    const validated: RequestHandler = (req) => {
      parseOrThrow(schema, req.body);
    };
    const rawParse: RequestHandler = (req) => {
      schema.parse(req.body);
    };

    it('maps a validation failure to 422 with details', async () => {
      const res = await request(buildApp(validated)).post('/fail').send({});
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
      expect(res.body.error.details).toEqual([{ field: 'name', issue: expect.any(String) }]);
    });

    it('maps an unknown key to 400 BAD_REQUEST', async () => {
      const res = await request(buildApp(validated)).post('/fail').send({ name: 'a', extra: 1 });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
    });

    it('also maps a ZodError thrown directly by schema.parse', async () => {
      const res = await request(buildApp(rawParse)).post('/fail').send({});
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('VALIDATION_FAILED');
    });
  });

  describe('body parser errors', () => {
    it('maps malformed JSON to 400 BAD_REQUEST', async () => {
      const res = await request(buildApp(() => undefined))
        .post('/fail')
        .set('Content-Type', 'application/json')
        .send('{"name": ');
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('BAD_REQUEST');
      expect(res.body.error.details).toEqual([]);
      expect(typeof res.body.error.requestId).toBe('string');
    });
  });
});
