# IMS backend

Modular monolith (ADR-001): one deployable image, two process types — **API** (`dist/main.js`) and **worker** (`dist/worker.js`).
This repository state is **Slice 0 (scaffold)**: infrastructure only, no domain behaviour.

## Quick start

```bash
cp .env.example .env
docker compose up -d postgres redis      # PostgreSQL 16 + Redis 7
npm install
npm run prisma:generate                   # generates src/generated/prisma (git-ignored)
npm run start:dev                         # API on :3000   (worker: npm run start:worker:dev)
```

## Scripts

| Script | Purpose |
|---|---|
| `npm run build` | `prisma generate` + compile to `dist/` |
| `npm test` | unit tests (no services needed) |
| `npm run test:int` | integration tests (need PostgreSQL + Redis from `.env`/defaults) |
| `npm run typecheck` | type-check sources and tests |

## Layout

```
src/
  config/           env schema (zod) + global ConfigModule
  infrastructure/   database (Prisma + pg adapter), redis, queue (BullMQ root), logging (pino)
  common/           errors (central exception filter), validation (zod pipe)
  modules/          identity, app-service, alerts, incident, notifications, ai   (empty shells)
  main.ts / worker.ts                          process entrypoints
prisma/schema.prisma  datasource + generator only (models arrive with their slices)
```

Module convention: `Module -> Controller -> Service -> Repository -> PostgreSQL`. Cross-module access goes through the owning module's exported service; boundary discipline is by convention (ADR-001).

## Environment

See `.env.example`. `DATABASE_URL` is the runtime connection (Supabase transaction pooler, port 6543); `DIRECT_URL` is used only by the Prisma CLI for migrations (direct, port 5432). In `NODE_ENV=production`, `DATABASE_URL` must carry `sslmode=require` (or stronger).

## Deliberately not in this slice

Auth, any domain logic, schema models/migrations, outbox/audit contracts, queues/processors and their retry/DLQ policy, health/readiness endpoint (none is specified in the project documents), CI.
