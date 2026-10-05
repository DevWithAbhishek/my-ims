import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import type { Client } from 'pg';

const MIGRATIONS_DIR = path.resolve(__dirname, '../../prisma/migrations');

/** Applies every `prisma/migrations/<name>/migration.sql` in order, as `migrate deploy` would. */
export async function applyMigrations(client: Client): Promise<string[]> {
  const names = readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();

  for (const name of names) {
    await client.query(readFileSync(path.join(MIGRATIONS_DIR, name, 'migration.sql'), 'utf8'));
  }
  return names;
}
