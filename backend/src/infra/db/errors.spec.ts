import { Prisma } from '../../generated/prisma/client.js';
import { isDatabaseUnavailable } from './errors.js';

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
