import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { WEBHOOK } from './webhook.config.js';

const SIGNATURE_HEADER = /^sha256=([0-9a-fA-F]{64})$/;
const TIMESTAMP_HEADER = /^\d{1,15}$/;

/** Stands in for the secret of an unknown source, so its check costs the same as a real one. */
const DUMMY_SECRET = randomBytes(32);
const ZERO_DIGEST = Buffer.alloc(32);

/** HMAC-SHA256 of `"<timestamp>.<raw body>"`, computed over the raw bytes. */
export function computeSignature(
  secret: string | Buffer,
  timestamp: string,
  rawBody: Buffer,
): Buffer {
  return createHmac('sha256', secret).update(timestamp).update('.').update(rawBody).digest();
}

export type ParsedSignature = { digest: Buffer; hex: string };

/** Parses `sha256=<64 hex>`; anything else cannot be a valid signature. */
export function parseSignatureHeader(value: string | undefined): ParsedSignature | null {
  const match = value === undefined ? null : SIGNATURE_HEADER.exec(value);
  if (!match?.[1]) return null;
  const hex = match[1].toLowerCase();
  return { digest: Buffer.from(hex, 'hex'), hex };
}

export type SignatureInput = {
  /** The source's signing secret, or `null` when there is no usable source. */
  secret: string | null;
  timestampHeader: string | undefined;
  signatureHeader: string | undefined;
  rawBody: Buffer;
};

/**
 * Verifies the signature in constant time. The HMAC is always computed (with a dummy secret when
 * the source is unknown, deactivated or misconfigured) and the outcome is decided only at the end.
 */
export function verifySignature(input: SignatureInput): boolean {
  const signature = parseSignatureHeader(input.signatureHeader);
  const timestamp =
    input.timestampHeader !== undefined && TIMESTAMP_HEADER.test(input.timestampHeader)
      ? input.timestampHeader
      : null;

  const expected = computeSignature(input.secret ?? DUMMY_SECRET, timestamp ?? '', input.rawBody);
  const digestsMatch = timingSafeEqual(expected, signature?.digest ?? ZERO_DIGEST);

  return digestsMatch && input.secret !== null && signature !== null && timestamp !== null;
}

/** Whether a (verified, numeric) timestamp is within ±300 s of server time. */
export function isTimestampFresh(
  timestamp: string,
  nowMs: number,
  toleranceSeconds: number = WEBHOOK.timestampToleranceSeconds,
): boolean {
  return Math.abs(Math.floor(nowMs / 1000) - Number(timestamp)) <= toleranceSeconds;
}
