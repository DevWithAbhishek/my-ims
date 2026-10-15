import { Prisma } from '../../generated/prisma/client.js';
import { isConcurrencyFailure, isDatabaseUnavailable } from './errors.js';

function known(code: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError('boom', { code, clientVersion: 'test', meta });
}

describe('isDatabaseUnavailable', () => {
  it.each(['P1001', 'P1002', 'P1008', 'P1017', 'P2024'])(
    'treats Prisma %s as an outage',
    (code) => {
      expect(isDatabaseUnavailable(known(code))).toBe(true);
    },
  );

  it('treats a raw query that could not reach the database as an outage', () => {
    const error = known('P2010', {
      driverAdapterError: { cause: { kind: 'DatabaseNotReachable', host: 'h', port: 5432 } },
    });
    expect(isDatabaseUnavailable(error)).toBe(true);
  });

  it('treats an initialization error and a refused connection as an outage', () => {
    expect(
      isDatabaseUnavailable(new Prisma.PrismaClientInitializationError('x', 'test', 'P1001')),
    ).toBe(true);
    expect(isDatabaseUnavailable(Object.assign(new Error('x'), { code: 'ECONNREFUSED' }))).toBe(
      true,
    );
  });

  it('does not treat query, constraint or unknown errors as an outage', () => {
    expect(isDatabaseUnavailable(known('P2002'))).toBe(false);
    expect(
      isDatabaseUnavailable(known('P2010', { driverAdapterError: { cause: { kind: 'x' } } })),
    ).toBe(false);
    expect(isDatabaseUnavailable(new Error('nope'))).toBe(false);
    expect(isDatabaseUnavailable(undefined)).toBe(false);
  });
});

describe('isConcurrencyFailure', () => {
  it('recognizes Prisma P2034 and a bare SQLSTATE', () => {
    expect(isConcurrencyFailure(known('P2034'))).toBe(true);
    for (const code of ['40001', '40P01', '55P03']) {
      expect(isConcurrencyFailure(Object.assign(new Error('x'), { code }))).toBe(true);
    }
  });

  it.each(['40001', '40P01', '55P03'])(
    'recognizes SQLSTATE %s inside the driver adapter error of a failed raw query',
    (code) => {
      const error = known('P2010', { driverAdapterError: { cause: { kind: 'postgres', code } } });
      expect(isConcurrencyFailure(error)).toBe(true);
    },
  );

  it('does not treat other errors as a concurrency failure', () => {
    expect(isConcurrencyFailure(known('P2002'))).toBe(false);
    expect(
      isConcurrencyFailure(known('P2010', { driverAdapterError: { cause: { code: '23505' } } })),
    ).toBe(false);
    expect(isConcurrencyFailure(new Error('nope'))).toBe(false);
    expect(isConcurrencyFailure(undefined)).toBe(false);
  });
});
