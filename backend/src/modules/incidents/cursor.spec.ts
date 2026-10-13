import { ValidationError } from '../../shared/errors/AppError.js';
import { decodeCursor, encodeCursor, type Cursor } from './cursor.js';

const ID = '0199c1a4-7b1e-7000-8000-000000000001';
const base: Cursor = { orderBy: 'severity', sort: 'asc', value: 'P1', id: ID };

const wrap = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('cursor', () => {
  it('round-trips for every ordering', () => {
    const cursors: Cursor[] = [
      { orderBy: 'createdAt', sort: 'desc', value: '2026-01-01T00:00:00.123Z', id: ID },
      base,
      { orderBy: 'status', sort: 'asc', value: 'MITIGATING', id: ID },
      { orderBy: 'title', sort: 'asc', value: 'Disk "full" ünïcode', id: ID },
      { orderBy: 'affectedServiceId', sort: 'desc', value: ID, id: ID },
      { orderBy: 'teamId', sort: 'asc', value: ID, id: ID },
    ];
    for (const cursor of cursors) {
      const decoded = decodeCursor(encodeCursor(cursor), cursor);
      expect(decoded).toEqual(cursor);
    }
  });

  it('is base64url (no padding or reserved characters)', () => {
    expect(encodeCursor(base)).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it.each([
    ['not base64 json', '%%%'],
    ['json of the wrong type', wrap([1, 2])],
    ['missing fields', wrap({ o: 'severity', s: 'asc' })],
    ['unknown extra field', wrap({ o: 'severity', s: 'asc', v: 'P1', id: ID, x: 1 })],
    ['unknown orderBy', wrap({ o: 'description', s: 'asc', v: 'x', id: ID })],
    ['id that is not a uuid', wrap({ o: 'severity', s: 'asc', v: 'P1', id: 'nope' })],
    ['severity value out of range', wrap({ o: 'severity', s: 'asc', v: 'P9', id: ID })],
    ['createdAt value that is not an ISO date', wrap({ o: 'createdAt', s: 'asc', v: 'x', id: ID })],
    ['title value with a NUL byte', wrap({ o: 'title', s: 'asc', v: 'a\u0000b', id: ID })],
  ])('rejects %s with INVALID_CURSOR', (_name, raw) => {
    const attempt = () => decodeCursor(raw, { orderBy: 'severity', sort: 'asc' });
    expect(attempt).toThrow(ValidationError);
    try {
      attempt();
    } catch (error) {
      expect((error as ValidationError).code).toBe('INVALID_CURSOR');
    }
  });

  it('rejects a cursor issued under another orderBy or sort', () => {
    const encoded = encodeCursor(base);
    expect(() => decodeCursor(encoded, { orderBy: 'status', sort: 'asc' })).toThrow(
      ValidationError,
    );
    expect(() => decodeCursor(encoded, { orderBy: 'severity', sort: 'desc' })).toThrow(
      ValidationError,
    );
  });
});
