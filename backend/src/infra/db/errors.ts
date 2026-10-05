import { Prisma } from '../../generated/prisma/client.js';

function sqlState(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const { code } = error as { code?: unknown };
  return typeof code === 'string' ? code : undefined;
}

/** A PostgreSQL unique-constraint violation (Prisma `P2002` or raw SQLSTATE `23505`). */
export function isUniqueViolation(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') return true;
  return sqlState(error) === '23505';
}

/** Deadlock, serialization failure or lock timeout (Prisma `P2034` or SQLSTATE 40001/40P01/55P03). */
export function isConcurrencyFailure(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') return true;
  const state = sqlState(error);
  return state === '40001' || state === '40P01' || state === '55P03';
}
