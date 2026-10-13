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

const UNAVAILABLE_PRISMA_CODES = new Set(['P1001', 'P1002', 'P1008', 'P1017', 'P2024']);
const UNAVAILABLE_ADAPTER_KINDS = new Set([
  'DatabaseNotReachable',
  'ConnectionClosed',
  'TooManyConnections',
  'SocketTimeout',
]);
const UNAVAILABLE_NETWORK_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND']);

function adapterErrorKind(error: Prisma.PrismaClientKnownRequestError): string | undefined {
  const meta = error.meta as { driverAdapterError?: { cause?: { kind?: unknown } } } | undefined;
  const kind = meta?.driverAdapterError?.cause?.kind;
  return typeof kind === 'string' ? kind : undefined;
}

/**
 * The database cannot be reached or its connection pool is exhausted: a connection failure, not a
 * query or data error. Raw queries report this as `P2010` with the cause in the driver adapter error.
 */
export function isDatabaseUnavailable(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientInitializationError) return true;
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (UNAVAILABLE_PRISMA_CODES.has(error.code)) return true;
    const kind = adapterErrorKind(error);
    return kind !== undefined && UNAVAILABLE_ADAPTER_KINDS.has(kind);
  }
  const state = sqlState(error);
  return state !== undefined && UNAVAILABLE_NETWORK_CODES.has(state);
}
