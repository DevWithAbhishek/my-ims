import { isUniqueViolation } from '../../infra/db/errors.js';
import { getPrisma } from '../../infra/db/prisma.js';
import { hashPassword } from './auth/password.js';

export type SeedAdminInput = { name: string; email: string; password: string };

/**
 * Creates an `ADMIN` user unless one with this email already exists (idempotent by email).
 * Returns whether a user was created.
 */
export async function seedAdminUser(input: SeedAdminInput): Promise<boolean> {
  const db = getPrisma();
  const email = input.email.toLowerCase();
  if (await db.user.findUnique({ where: { email }, select: { id: true } })) return false;

  try {
    await db.user.create({
      data: {
        name: input.name,
        email,
        passwordHash: await hashPassword(input.password),
        role: 'ADMIN',
      },
    });
    return true;
  } catch (error) {
    if (isUniqueViolation(error)) return false;
    throw error;
  }
}
