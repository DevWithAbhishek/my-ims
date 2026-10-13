# Incident Management System (IMS) Backend

A production-oriented Incident Management System built as a modular monolith, focused on reliable background processing, fault recovery, testing, and AI-assisted incident operations.

The goal is to build a backend whose behavior can be inspected, tested, and explained—not merely one whose code can be generated quickly.

## Architecture

Modular monolith (ADR-001): one deployable image with two process types.

- **API:** `dist/main.js`
- **Worker:** `dist/worker.js`

The API handles synchronous requests. The worker executes background jobs. Both use the same application codebase and deployment image.

The transactional outbox records background-work requests in PostgreSQL before a relay publishes them to BullMQ. Worker execution is designed around bounded retries, backoff, and idempotency safeguards.

## Technology Stack

| Area | Technology |
|---|---|
| Runtime | Node.js |
| Language | TypeScript |
| HTTP API | Express 5 |
| Database | PostgreSQL 16 |
| ORM | Prisma 7 with `@prisma/adapter-pg` |
| Background jobs | BullMQ |
| Queue infrastructure | Redis 7 |
| Validation | Zod |
| Logging | Pino |
| Local infrastructure | Docker Compose |

## Key Engineering Focus

- **Reliable asynchronous processing:** Transactional outbox, queue workers, bounded retries, backoff, and dead-letter handling.
- **Data integrity:** PostgreSQL transactions and database constraints for important invariants.
- **Testing:** Unit tests and integration tests against real PostgreSQL and Redis infrastructure.
- **Failure handling:** Fault-injection tests to verify expected behavior during infrastructure failures.
- **AI-assisted incident operations:** Planned capabilities include AI-assisted triage, investigation, and postmortem generation, with deterministic validation and human oversight.
- **Maintainable architecture:** Explicit module boundaries, documented architectural decisions, and reviewable implementation slices.

## Quick Start

```bash
cp .env.example .env

docker compose up -d postgres redis

npm install
npm run prisma:generate
npm run start:dev
```

The API listens on port `3000`. Start the worker separately:

```bash
npm run start:worker:dev
```

Configure environment variables in `.env`; see `.env.example` for the required settings.

- `DATABASE_URL` is the runtime database connection, configured for the Supabase transaction pooler on port `6543`.
- `DIRECT_URL` is used by the Prisma CLI for migrations through a direct connection on port `5432`.
- In `NODE_ENV=production`, `DATABASE_URL` must use `sslmode=require` or stronger.

Never commit real credentials or production connection strings.

## Available Scripts

| Script | Purpose |
|---|---|
| `npm run build` | Generate Prisma client and compile TypeScript |
| `npm test` | Run unit tests without external services |
| `npm run test:int` | Run integration tests against PostgreSQL and Redis |
| `npm run typecheck` | Type-check application code and tests |
| `npm run prisma:generate` | Generate the Prisma client |

## Repository Structure

```text
src/
  config/             Environment schema and global ConfigModule
  infrastructure/     Prisma/pg adapter, Redis, BullMQ, Pino
  common/             Shared errors and Zod validation
  modules/
    identity/         Identity and access management
    app-service/      Service catalog
    alerts/           Alert ingestion and processing
    incident/         Incident lifecycle
    notifications/    Notification workflows
    ai/               AI integrations
  main.ts             API process entrypoint
  worker.ts           Worker process entrypoint

prisma/
  schema.prisma       Prisma schema
  migrations/         Database migrations as introduced
```

Module convention:

`Module → Controller → Service → Repository → PostgreSQL`

Cross-module access goes through the owning module's exported service. Module boundary enforcement is currently by convention, as documented in ADR-001.

## Project Status

The repository is being developed incrementally. Current implementation status should be assessed from the code and tests in the repository; planned capabilities are not represented as completed features.

## Engineering Principles

- PostgreSQL is the durable source of truth.
- Required background work is recorded transactionally before queue publication.
- Consumers must tolerate duplicate delivery.
- Retries are bounded, and terminal failures should be observable.
- AI output is advisory and subject to validation; it does not replace business rules or engineering review.
- Tests should verify actual behavior, including failure paths, rather than merely passing for an unrelated reason.
- Architectural decisions and important trade-offs are documented.
