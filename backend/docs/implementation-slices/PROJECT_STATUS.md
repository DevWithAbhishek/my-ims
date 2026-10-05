# PROJECT_STATUS.md

Snapshot of the repository (`DevWithAbhishek/my-ims`, base `d216636 "feat: project scaffold completed"` plus the SLICE-00 patch) and the supplied design documents. Checks marked **Verified** were actually run on 2026-10-05 (Node 22 sandbox, local PostgreSQL 16 + Redis 7 installed via apt); anything else is **Not verified**. Update this file at the end of every slice.

## 1. Project

| Item | Value |
|---|---|
| Name | IMS — Incident Management System (backend) |
| Phase | Pre-implementation: design finalized, foundation implemented |
| Current slice | SLICE-00 (Foundation) — IMPLEMENTED, pending the unverified items in §4 |
| Overall progress | 0 of 12 feature slices implemented; foundation only |

## 2. Design Status

| Artifact | Status |
|---|---|
| API (`API.md`) | Complete — states "no open items remain"; latest contract |
| DB schema (`schema.prisma`) | Final per `API.md`. Only change in SLICE-00: generator `output` is now `../src/generated/prisma` (no model or migration change) |
| PRD | Written; partially stale — still describes a single postmortem lifecycle and 1..4 escalation policies per service (per `API.md` §13) |
| Domain Model | Written; partially stale — still shows `UNIQUE(service_id, escalation_policy.severity)`, `PENDING→DONE` investigation states |
| Index (`00-INDEX.md`) | Written against the older draft; open-question register predates the final API |
| Slices 01–12 | Regenerated against the final API in the consolidation pass |

Repo copies of `backend/docs/API.md`, `docs/PRD.md`, `docs/Domain_Model.md`, `backend/docs/implementation-slices/*` differ from the latest supplied versions and are superseded.

## 3. Slice Status

| Slice | Status | Notes |
|---|---|---|
| SLICE-00 Foundation | IMPLEMENTED (patch `slice-00.patch`) | Docker build and `prisma migrate deploy` not verified (§4) |
| SLICE-01 Identity, Auth & Team Isolation | NOT STARTED | Auth context type slot exists (`src/shared/types`); no auth code |
| SLICE-02 Service Catalog, SLA Config & Escalation Policy | NOT STARTED | |
| SLICE-03 Alert Source Trust Gate | NOT STARTED | |
| SLICE-04 Alert Ingestion, Dedup & Incident Creation | NOT STARTED | The lookup indexes on `Alert(alertSourceId, sourceEventId/sourceFingerprint)` are present in the init migration (partial unique indexes `uq_alert_source_*`) |
| SLICE-05 Incident Lifecycle & Assignment | NOT STARTED | |
| SLICE-06 Visibility, Comments & Timeline | NOT STARTED | |
| SLICE-07 SLA Monitoring & Escalation | NOT STARTED | Blocked on two undefined inputs (see slice) |
| SLICE-08 Outbox, Queue & Worker Reliability | NOT STARTED | Redis in compose and `createRedisConnection('bullmq')` exist; worker entrypoint is a shell with no workers |
| SLICE-09 Notifications | NOT STARTED | |
| SLICE-10 AI Alert Triage | NOT STARTED | Blocked on LLM data allow-list |
| SLICE-11 Postmortem, Review & Closure | NOT STARTED | Blocked on LLM data allow-list (generation part) |
| SLICE-12 AI Investigation & Evaluation | NOT STARTED | Blocked on LLM data allow-list; retrieval source set undefined |

## 4. Repository State (verified 2026-10-05)

| Check | Result |
|---|---|
| `npm run typecheck` | Verified: passes |
| `npm run lint` | Verified: exit 0. Prints eslint-plugin-boundaries v7 deprecation warnings (legacy `element-types`/`entry-point` rule names) |
| `npm run format:check` | Verified: passes (`docs/`, `README.md`, `src/generated` are in `.prettierignore`) |
| `npm test` | Verified: 5 suites, 67 tests pass |
| `npm run test:int` | Verified: 2 suites, 5 tests pass against local PostgreSQL + Redis (test DB `ims_test`, Redis db 15; override with `TEST_DATABASE_URL` / `TEST_REDIS_URL`) |
| `npm run build` | Verified: `prisma generate` + `tsc` produce `dist/main.js` and `dist/worker.js`; no spec files in `dist` |
| Runtime | Verified: built API boots; `/health` 200; `/ready` 200, 503 + `Retry-After: 5` with Redis stopped, recovers; `SIGTERM` exits 0; startup exits 1 on invalid config, unreachable DB, unreachable Redis, port in use; worker stays up, logs ready, exits 0 on `SIGTERM` |
| Migration | Verified: init migration SQL applies to an empty PostgreSQL database (integration test, via `pg`). **Not verified:** `prisma migrate deploy` / `prisma validate` (Prisma engine download returned 403; `prisma generate` was run with a sandbox-only stand-in `PRISMA_SCHEMA_ENGINE_BINARY`) |
| Docker | Not verified: `docker build` and `docker compose up` (no Docker in the sandbox) |
| Fresh clone | `src/generated` is git-ignored: run `npm run prisma:generate` (or `build`) before `typecheck` / `test:int` |

## 5. Current Implementation

- Entrypoints: `src/main.ts` (API, honors `config.port`, fail-fast on DB/Redis, graceful shutdown) and `src/worker.ts` (bootstrap shell, no workers). `src/server.ts` removed.
- `src/config/env.ts`: Zod-validated config (`parseConfig`, memoized `getConfig`); errors name variables only. `.env.example` added.
- `src/app.ts`: `createApp({ readinessChecks, apiRouter })`; request-id, pino-http (method/path/status only), JSON limit `100kb`, `/health`, `/ready`, `/api/v1` mount, error middleware. `GET /` removed.
- Errors: `AppError` with `details`, `retryAfterSeconds`; classes for 400/401/403/404/409/413/422/429/500/503; envelope `{ error: { code, message, details, requestId } }`; Zod → 422 `VALIDATION_FAILED` (unknown keys → 400 `BAD_REQUEST`); body-parser errors → 400; unknown errors → 500 `INTERNAL_ERROR` logged at `error` with stack. Helper `parseOrThrow`.
- Infra: `src/infra/db/prisma.ts` (Prisma 7 + pg adapter, pool max 10, `runInTransaction`, `lockRowForUpdate`, `pingDatabase`), `src/infra/redis/redis.ts` (`createRedisConnection('general' | 'bullmq')`, `getRedis`, `pingRedis`, `closeRedis`), `src/infra/readiness.ts`.
- Tooling: ESLint boundaries match `src/modules/<name>/**`, `src/infra`, `src/shared`, `src/workers`; `prisma.config.ts` (renamed from `prisma7.config.ts`); compose has PostgreSQL (healthcheck user fixed) and Redis (`noeviction`, AOF).
- Tests: `src/**/*.spec.ts` (unit), `test/integration/*.int-spec.ts`, helpers in `test/helpers`.

Not present: any module under `src/modules`, `src/workers`, authentication, outbox/queues/BullMQ workers, audit, rate limiting.

## 6. Known Issues

1. `docker-compose.yml`: the commented-out `api` / `worker` blocks still carry stale credentials (`ims:ims`) and lack `DIRECT_URL` / `JWT_SECRET`; PostgreSQL host port is 5431.
2. ESLint uses the legacy boundaries rule syntax (deprecated in eslint-plugin-boundaries v7); migrate to `boundaries/dependencies` in a tooling follow-up.
3. Integration helpers import `pg`, typed only via a transitive `@types/pg`; declare it as a devDependency if kept.
4. Unknown routes return Express' default 404 (not the error envelope); the slice does not define a route-not-found code.
5. Oversized JSON bodies return `400 BAD_REQUEST` per SLICE-00 §4.2; the 413 class is unused until SLICE-03.

## 7. Blockers

Design inputs not defined in the supplied design (details in the affected slices): delay between escalation levels and the SLA scheduling mechanism (SLICE-07); LLM data allow-list/redaction (SLICE-10, 11, 12); investigation knowledge-source set and "no relevant evidence" representation (SLICE-12); notification recipient resolution when there is no assignee (SLICE-09); alert-source configuration JSON shape (SLICE-03/04). None blocks SLICE-01, 02, 05, 06 or 08.

## 8. Next Step

Locally: apply the patch, run `npm ci && npm run build`, `npx prisma validate`, `npx prisma migrate deploy` against the compose database, `docker build`, then close SLICE-00. Then implement SLICE-01. See `SLICE_IMPLEMENTATION_GUIDE.md` §Suggested order.
