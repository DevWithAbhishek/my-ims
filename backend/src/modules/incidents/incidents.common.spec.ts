import { Prisma } from '../../generated/prisma/client.js';
import { ServiceUnavailableError } from '../../shared/errors/AppError.js';
import { assertIncidentAccess, withDatabaseOutageMapping } from './incidents.common.js';

const auth = {
  userId: 'u',
  email: 'e',
  role: 'ENGINEER',
  sessionId: 's',
  teamId: 'team-a',
} as const;

describe('withDatabaseOutageMapping', () => {
  it('maps a connection failure to 503 DEPENDENCY_UNAVAILABLE with Retry-After', async () => {
    const outage = new Prisma.PrismaClientKnownRequestError('down', {
      code: 'P1001',
      clientVersion: 'test',
    });
    const error = await withDatabaseOutageMapping(() => Promise.reject(outage)).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ServiceUnavailableError);
    expect(error).toMatchObject({
      statusCode: 503,
      code: 'DEPENDENCY_UNAVAILABLE',
      retryAfterSeconds: 5,
    });
  });

  it('passes every other error and result through', async () => {
    const other = new Error('query bug');
    await expect(withDatabaseOutageMapping(() => Promise.reject(other))).rejects.toBe(other);
    await expect(withDatabaseOutageMapping(() => Promise.resolve(7))).resolves.toBe(7);
  });
});

describe('assertIncidentAccess', () => {
  it('404s an unknown incident and 403s another team without leaking either way', () => {
    expect(() => assertIncidentAccess(auth, null)).toThrow(
      expect.objectContaining({ statusCode: 404, code: 'INCIDENT_NOT_FOUND' }),
    );
    expect(() => assertIncidentAccess(auth, { teamId: 'team-b' })).toThrow(
      expect.objectContaining({ statusCode: 403, code: 'TEAM_ACCESS_DENIED' }),
    );
    expect(() => assertIncidentAccess(auth, { teamId: 'team-a' })).not.toThrow();
  });
});
