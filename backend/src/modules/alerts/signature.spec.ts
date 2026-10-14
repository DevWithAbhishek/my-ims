import { createHmac } from 'node:crypto';
import {
  computeSignature,
  isTimestampFresh,
  parseSignatureHeader,
  verifySignature,
} from './signature.js';

const SECRET = 'unit-test-signing-secret-0123456789';
const BODY = Buffer.from('{"alerts":[{"name":"a  b"}]}');
const TS = '1800000000';

function header(secret = SECRET, timestamp = TS, body = BODY): string {
  return `sha256=${computeSignature(secret, timestamp, body).toString('hex')}`;
}

describe('computeSignature', () => {
  it('is HMAC-SHA256 of "<timestamp>.<raw body>" with the secret', () => {
    const expected = createHmac('sha256', SECRET).update(`${TS}.`).update(BODY).digest('hex');
    expect(computeSignature(SECRET, TS, BODY).toString('hex')).toBe(expected);
  });

  it('covers the raw bytes, not a re-serialization', () => {
    const spaced = Buffer.from('{ "alerts": [ { "name": "a  b" } ] }');
    expect(computeSignature(SECRET, TS, spaced).equals(computeSignature(SECRET, TS, BODY))).toBe(
      false,
    );
  });
});

describe('parseSignatureHeader', () => {
  const hex = 'ab'.repeat(32);

  it('accepts sha256=<64 hex> and normalizes the case', () => {
    expect(parseSignatureHeader(`sha256=${hex.toUpperCase()}`)?.hex).toBe(hex);
  });

  it.each([
    undefined,
    '',
    hex,
    `sha1=${hex}`,
    `sha256=${hex.slice(1)}`,
    `sha256=${hex}00`,
    `sha256=${'zz'.repeat(32)}`,
    ` sha256=${hex}`,
  ])('rejects %p', (value) => {
    expect(parseSignatureHeader(value)).toBeNull();
  });
});

describe('verifySignature', () => {
  const base = { secret: SECRET, timestampHeader: TS, signatureHeader: header(), rawBody: BODY };

  it('accepts a valid signature', () => {
    expect(verifySignature(base)).toBe(true);
  });

  it('rejects a wrong secret', () => {
    expect(verifySignature({ ...base, secret: 'another-secret-another-secret-1234' })).toBe(false);
  });

  it('rejects a tampered body and a different timestamp', () => {
    expect(verifySignature({ ...base, rawBody: Buffer.from('{"alerts":[]}') })).toBe(false);
    expect(verifySignature({ ...base, timestampHeader: '1800000001' })).toBe(false);
  });

  it('rejects when there is no secret (unknown, deactivated or misconfigured source)', () => {
    expect(verifySignature({ ...base, secret: null })).toBe(false);
  });

  it.each([
    ['missing signature', { signatureHeader: undefined }],
    ['unparseable signature', { signatureHeader: 'nope' }],
    ['missing timestamp', { timestampHeader: undefined }],
    ['non-numeric timestamp', { timestampHeader: '17e8' }],
    ['fractional timestamp', { timestampHeader: '1800000000.5' }],
  ])('rejects %s', (_name, override) => {
    expect(verifySignature({ ...base, ...override })).toBe(false);
  });
});

describe('isTimestampFresh', () => {
  const now = 1_800_000_000_500; // 500 ms into second 1800000000

  it.each([
    ['now', 1_800_000_000, true],
    ['300 s in the past', 1_799_999_700, true],
    ['301 s in the past', 1_799_999_699, false],
    ['300 s in the future', 1_800_000_300, true],
    ['301 s in the future', 1_800_000_301, false],
  ])('%s', (_name, timestamp, fresh) => {
    expect(isTimestampFresh(String(timestamp), now)).toBe(fresh);
  });
});
