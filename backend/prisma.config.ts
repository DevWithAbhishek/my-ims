import 'dotenv/config';
import { defineConfig } from 'prisma/config';

// Prisma CLI (generate, migrate) reads the process environment directly so it does not
// depend on the application config. Migrations use the direct (non-pooled) connection.
export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
  },
  datasource: {
    url: process.env.DIRECT_URL ?? process.env.DATABASE_URL ?? '',
  },
});
