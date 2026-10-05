import { randomBytes } from 'node:crypto';
import argon2 from 'argon2';

/** Argon2 with the library's default configuration (no custom cost parameters). */
export function hashPassword(password: string): Promise<string> {
  return argon2.hash(password);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, password);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | undefined;

/**
 * Verifies `password` against `hash`, or against a throwaway hash when there is no user, so that
 * an unknown email costs the same as a wrong password.
 */
export async function verifyPasswordOrDummy(
  hash: string | undefined,
  password: string,
): Promise<boolean> {
  if (hash !== undefined) return verifyPassword(hash, password);
  dummyHash ??= hashPassword(randomBytes(16).toString('hex'));
  await verifyPassword(await dummyHash, password);
  return false;
}
