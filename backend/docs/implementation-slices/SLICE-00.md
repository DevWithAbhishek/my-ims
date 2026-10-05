# SLICE-00 — Foundation (Scaffold Completion)

## 1. Purpose

Bring the existing scaffold to the baseline every feature slice assumes: a bootable API and worker entrypoint, validated configuration, database and Redis wiring, the finalized error envelope and request context, a working lint/format/test toolchain, and a test harness. No product behavior is added.

The scaffold commit already provides: Express 5 app with JSON parsing and request-id middleware, `GET /health`, `AppError` classes, pino logger, Prisma schema + init migration, Dockerfile, PostgreSQL in `docker-compose.yml`, Jest/ESLint/Prettier configs. The work below is what is genuinely missing or broken (verified against the repository).

## 2. Scope

### In Scope
- Fix toolchain: ESLint config crash and module-boundary patterns; Prettier compliance for existing files; scripts; Prisma config naming; compose healthcheck.
- Entrypoints and build: `build` script, `src/main.ts` (API), `src/worker.ts` (worker bootstrap shell only), matching `start`/`start:worker` and the Dockerfile.
- Configuration with validation (Zod), including Redis.
- Database client (Prisma 7 + `@prisma/adapter-pg`) and Redis client (ioredis) as `src/infra` singletons with graceful shutdown.
- Error envelope, error classes, request-id/context, and request-validation helpers matching the finalized API conventions.
- `/api/v1` mounting and health/readiness endpoints.
- Test infrastructure for unit and integration tests.

### Out of Scope
Any authentication, module business logic, endpoints beyond health/readiness, outbox/queue/worker logic (SLICE-08), rate limiting (owned by the slices that use it), AI provider code, new Prisma models, other migrations.

## 3. Actors & Responsibilities
Developer/CI running the app and checks. The API process serves HTTP; the worker process (same image) will host BullMQ workers in later slices.

## 4. Capability Behavior

**4.1 Configuration.** One validated config object loaded at startup; invalid or missing required values fail startup with a clear message that never prints secret values. Required: `NODE_ENV`, `PORT`, `DATABASE_URL`, `DIRECT_URL`, `JWT_SECRET`, `REDIS_URL`, access/refresh token expiries (defaults `15m` / `7d`). Add an `.env.example` listing every variable (no real secrets). `server.ts`/`main.ts` use `config.port`.

**4.2 Error envelope.** Errors serialize as `{ "error": { "code", "message", "details": [], "requestId" } }` with `details` always an array. `AppError` carries `statusCode`, `code`, `message`, `details`. Provide classes for the finalized statuses (400, 401, 403, 404, 409, 413, 422, 429, 500, 503). Unknown errors → `500 INTERNAL_ERROR` with only `requestId`, logged at `error` level with the stack (never in the body). Express body-parser errors map to `400 BAD_REQUEST`. Retain `Retry-After` support on `429` and `503`. Zod errors map to `422 VALIDATION_FAILED` with `details: [{ field, issue }]` (strict-unknown-key failures map to `400 BAD_REQUEST`). Error codes themselves are defined by feature slices; this slice defines the mechanism plus: `BAD_REQUEST`, `VALIDATION_FAILED`, `UNAUTHENTICATED`, `INTERNAL_ERROR`, `DEPENDENCY_UNAVAILABLE`.

**4.3 Request context.** Request id accepted if ≤128 chars of `[A-Za-z0-9-_]`, otherwise replaced with a new UUID; set on `res.locals.requestId`, echoed as `X-Request-Id` and in `error.requestId`; request-scoped logging via pino-http/`childLogger`. A typed place for the authenticated context (`userId`, `email`, `role`, `teamId`, `sessionId`) exists on the request type for SLICE-01 to fill.

**4.4 Routing.** All application routes mount under `/api/v1`. `GET /health` (liveness, no dependencies) and `GET /ready` (checks PostgreSQL `SELECT 1` and Redis `PING`; `200 { data: { status: "ok" } }` or `503 DEPENDENCY_UNAVAILABLE` with `Retry-After`) remain outside `/api/v1`. Remove the `GET /` welcome route only if nothing depends on it.

**4.5 Lifecycle.** API handles `SIGTERM`/`SIGINT`: stop accepting connections, drain, close Prisma and Redis, exit. Worker entrypoint boots config, DB and Redis, logs readiness, and shuts down the same way; it registers no workers yet. A startup failure exits non-zero with a fatal log.

**4.6 Infra.** `src/infra/db` exports a single Prisma client configured with the pg adapter (small pool, TLS when the URL requires it) and a helper to run an interactive transaction and a helper for row-lock raw queries; `src/infra/redis` exports a connection factory suitable for both general use and BullMQ (BullMQ requires `maxRetriesPerRequest: null` on its connection). No business queries here.

## 5. Domain & Data Context
No schema change. The init migration already creates the full schema. Do not add models. The schema's Prisma generator outputs to `../generated/prisma` (git-ignored); the build must run `prisma generate`.

## 6. API Contract
`GET /health` — keep the existing behavior: `200` with body `{ "status": "ok" }` (liveness, no dependencies, outside `/api/v1`, no authentication).
`GET /ready` — `200 { "data": { "status": "ok" } }` when PostgreSQL and Redis respond; otherwise `503` with the standard error envelope (`DEPENDENCY_UNAVAILABLE`) and a `Retry-After` header. No authentication.
No other endpoints.

## 7. Authorization & Security
None required. Never log secrets; config validation errors list variable names only. JSON body limit set explicitly (default for non-webhook routes; the webhook raw-body/1 MB handling belongs to SLICE-03).

## 8. Consistency & Concurrency
Not applicable beyond clean connection shutdown.

## 9. Async / Events / Workers
Only the worker process shell and the Redis connection factory. No queues, no relay.

## 10. Failure & Recovery
Database or Redis unreachable at startup → fail fast (API and worker). At runtime `/ready` reports `503`. Errors thrown in async handlers reach the error middleware (Express 5 forwards rejected promises).

## 11. Implementation Surface
- Config/tooling: `eslint.config.mjs`, `package.json` scripts (`build`, `start`, `start:worker`, `prisma:generate` with `--config`/rename of `prisma7.config.ts` to the name the Prisma 7 CLI detects), `tsconfig*.json` (`include` of the actual Prisma config file), `.env.example`, `docker-compose.yml` (enable Redis per the existing commented block with `noeviction` + AOF; fix healthcheck user), `jest*.config.js`, Prettier run over existing sources.
- Application: `src/config/env.ts`, `src/main.ts`, `src/worker.ts`, `src/app.ts`, `src/shared/errors`, `src/shared/middleware`, `src/shared/observability`, `src/infra/db`, `src/infra/redis`.
- Tests: `test/integration/env.ts` (referenced by `jest.int.config.js`), helpers for app + DB reset, unit specs for config, error mapping, request-id.
- Boundary lint: align `boundaries/elements` patterns with the real layout (`src/modules/<name>/**`, `src/infra/**`, `src/shared/**`, `src/workers/**`), keep "modules enter other modules only via `index.ts`" and "Alerts may use Incident and AppService".

## 12. Verification Requirements
- Unit: config validation (missing/invalid values), error mapping for each error class and for unknown errors (no leakage), request-id acceptance/replacement, Zod→`422`/`400` mapping.
- Integration (real PostgreSQL + Redis): `/ready` returns `200`; stopping Redis (or pointing at a bad URL) makes it `503` with `Retry-After`; migrations apply to an empty database.
- Tooling: `npm run lint`, `typecheck`, `format:check`, `test`, `test:int`, `build` all run and pass; `node dist/main.js` boots; the Docker image builds.

## 13. Completion Criteria
- `npm run lint` executes without crashing and passes; boundary rules reflect the real layout.
- `npm run format:check` passes for all tracked source files.
- `npm run build` produces `dist/main.js` and `dist/worker.js`; `start` and `start:worker` work; `docker build` succeeds.
- Startup fails clearly on invalid config; `config.port` is honored.
- Error envelope matches 4.2 for all mapped cases; request-id behavior matches 4.3.
- `/health`, `/ready`, and `/api/v1` mounting work; Redis is available in compose; `.env.example` exists.
- Prisma CLI commands run from `package.json` scripts without extra flags; init migration applies to an empty database.
- Tests above exist and pass; no feature behavior was added.
