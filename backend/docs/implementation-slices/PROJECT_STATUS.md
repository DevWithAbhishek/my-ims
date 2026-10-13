# PROJECT_STATUS.md

Snapshot of the repository (`DevWithAbhishek/my-ims`, base `45c9468 "feat: establish config, infra, error handling, and runtime entrypoints"` plus the SLICE-01, SLICE-02 and SLICE-08 patches) and the supplied design documents. Checks marked **Verified** were actually run on 2026-10-13 (Node 22 sandbox, local PostgreSQL 16 + Redis 7 installed via apt); anything else is **Not verified**. Update this file at the end of every slice.

## 1. Project

| Item | Value |
|---|---|
| Name | IMS — Incident Management System (backend) |
| Phase | Implementation: foundation, identity, service catalog and outbox/queue/worker reliability implemented |
| Current slice | SLICE-08 (Outbox, Queue & Worker Reliability) — IMPLEMENTED (`slice-08.patch`); SLICE-00 still pending the unverified items in §4 |
| Overall progress | 3 of 12 feature slices implemented (SLICE-01, SLICE-02, SLICE-08) plus the foundation |

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
| SLICE-00 Foundation | IMPLEMENTED (patch `slice-00.patch`) | Completed |
| SLICE-01 Identity, Auth & Team Isolation | IMPLEMENTED (patch `slice-01.patch`) | All 12 endpoints (A1–A4, T1–T4, U1–U4), guard/helpers exported from `src/modules/identity/index.ts`, `npm run seed:admin` |
| SLICE-02 Service Catalog, SLA Config & Escalation Policy | IMPLEMENTED (patch `slice-02.patch`) | Endpoints S1–S7 under `/api/v1/services`, configuration read-contract exported from `src/modules/appService/index.ts`; no schema change, no migration |
| SLICE-03 Alert Source Trust Gate | NOT STARTED | |
| SLICE-04 Alert Ingestion, Dedup & Incident Creation | NOT STARTED | The lookup indexes on `Alert(alertSourceId, sourceEventId/sourceFingerprint)` are present in the init migration (partial unique indexes `uq_alert_source_*`) |
| SLICE-05 Incident Lifecycle & Assignment | NOT STARTED | |
| SLICE-06 Visibility, Comments & Timeline | NOT STARTED | |
| SLICE-07 SLA Monitoring & Escalation | NOT STARTED | Blocked on two undefined inputs (see slice) |
| SLICE-08 Outbox, Queue & Worker Reliability | IMPLEMENTED (patch `slice-08.patch`) | `src/infra/jobs` (enqueue contract, relay, BullMQ gateway/workers, retry classification, dead letter, stale recovery, retention, re-drive), `src/infra/audit`, audit retrofit of T4/U4/S4/S7, two migrations, `npm run redrive:outbox`. No consumers yet: later slices register processors |
| SLICE-09 Notifications | NOT STARTED | |
| SLICE-10 AI Alert Triage | NOT STARTED | Blocked on LLM data allow-list |
| SLICE-11 Postmortem, Review & Closure | NOT STARTED | Blocked on LLM data allow-list (generation part) |
| SLICE-12 AI Investigation & Evaluation | NOT STARTED | Blocked on LLM data allow-list; retrieval source set undefined |

## 4. Repository State (verified 2026-10-05)

| Check | Result |
|---|---|
| `npm run typecheck` | Verified: passes |
| `npm run lint` | Verified: exit 0 (same boundaries v7 deprecation warnings as before) |
| `npm run format:check` | Verified: passes |
| `npm test` | Verified: 17 suites, 203 tests pass |
| `npm run test:int` | Verified: 9 suites, 232 tests pass against local PostgreSQL 16 + Redis 7 (test DB `ims_test`, Redis db 15), including real BullMQ workers and an unreachable-Redis publish |
| `npm run build` | Verified: `prisma generate` + `tsc` produce `dist/main.js`, `dist/worker.js`, `dist/scripts/seed-admin.js`, `dist/scripts/redrive-outbox.js`, `dist/infra/jobs/` and `dist/modules/appService/`; no spec files in `dist` |
| Runtime | Verified (SLICE-00; re-checked for SLICE-01 with the built server; **not re-run for SLICE-02** (HTTP behavior covered by the integration suite on the real app wiring): login, team create/list, seed script run twice): built API boots; `/health` 200; `/ready` 200, 503 + `Retry-After: 5` with Redis stopped, recovers; `SIGTERM` exits 0; startup exits 1 on invalid config, unreachable DB, unreachable Redis, port in use; worker stays up, logs ready, exits 0 on `SIGTERM` |
| Migration | Verified: all three migrations apply to an empty PostgreSQL database and the two SLICE-08 migrations also apply over existing outbox rows (integration test, via `pg`; also applied with `psql`). **Not verified:** `prisma migrate deploy` / `prisma validate` / `prisma migrate diff` (so that the hand-written SLICE-08 SQL matches `schema.prisma` without drift is checked by review and tests only; Prisma engine download is blocked; `prisma generate` was run with a sandbox-only stand-in `PRISMA_SCHEMA_ENGINE_BINARY`) |
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

- `src/modules/identity/` (single module; `auth/`, `teams/`, `users/`): controller → service → repository per area. Public interface (`index.ts`): `authenticate`, `requireRoles`, `requireTeam`, `assertSameTeam`, `getAuth`, `createIdentityRouter`, `seedAdminUser`. Composition in `src/api-router.ts` (used by `main.ts` and `test/helpers/app.ts`).
- Tokens: HS256 JWT (15 min) from `JWT_SECRET`; refresh cookie value `<sessionId>.<base64url(email)>.<secret>`, only SHA-256 of the secret is stored; `Set-Cookie` built by hand to carry exactly the specified attributes. Passwords: Argon2 default configuration.
- Rate limiting: Redis Lua script (atomic counter + ladder 10 min → 20 min → 60 min → 4 h → 24 h IP block); fails closed with 503. Keys hold hashes, never raw emails or IPs.
- Lint: one boundaries rule lets every module import `identity` through its `index.ts` (enforced; verified with temporary files).
- Shared additions: `src/infra/db/errors.ts` (unique violation / concurrency failure detection), `src/shared/middleware/json-body.ts` (non-JSON body → 400).
- `.env.example` (was missing from the repo) with the seed variables `SEED_ADMIN_NAME/EMAIL/PASSWORD`.

- `src/modules/appService/` (`services/`, `escalation-policies/`): controller → service → repository per area, mounted in `src/api-router.ts` via `createAppServiceRouter()`. Public interface (`index.ts`): `createAppServiceRouter`, `getServiceConfig(serviceId)` → `{ id, name, status, teamId, defaultSeverity, escalationPolicyId, sla: { P0..P3: { responseMinutes, resolutionMinutes } } }` or `null`, `getEscalationPolicyByService(serviceId)` → `{ level1, level2, level3, fallbackAdmin }` or `null`. Pure rules with unit tests: `sla.rules.ts` (ordering on merged values), `policy-users.rules.ts` (role/team/status per level).
- Concurrency: S4/S7 lock the `AppService` row `FOR UPDATE` and re-check incidents under it (an in-flight incident insert holds a key-share lock on that row, so the check waits for it; proven by tests that hold an uncommitted incident insert on a second connection). S1 and S4 team changes take `FOR SHARE` on the `Team` row (closes the race with T4's attached-services check); S1/S7 read policy users `FOR SHARE`; S4 policy reassignment locks the policy row so two services cannot claim one orphaned policy.

- **SLICE-08.** `src/infra/jobs/`: `enqueueOutbox(tx, …)` (validates event type + ids-only payload from `events.ts`, writes one `PENDING` row, never commits or touches Redis); raw-SQL `outbox.repository.ts` (claim with `FOR UPDATE SKIP LOCKED`, every transition conditional on status and, for relay updates, on the claim's lease); `relay.ts` (claim in a short transaction, publish outside it with a timeout, publication retried without a maximum with capped exponential backoff, unsupported type / invalid payload → `DEAD_LETTER`); `processor.ts` (common worker wrapper: success → `SUCCESS`, retryable → counted and rethrown, non-retryable or 5th failure → `DEAD_LETTER` first, then a `dead-letter` job); `errors.ts` (`RetryableJobError`, `NonRetryableJobError`, `classifyError`, `sanitizeError`); `gateway.ts` (BullMQ producer, `jobId` = outbox id, finished jobs removed, custom backoff); `maintenance.ts` (stale-`PROCESSING` recovery, `SUCCESS` retention); `redrive.ts` + `npm run redrive:outbox -- <id> [--operator <name>]`; `registry.ts` (`registerProcessor(queue, handler)`); `runtime.ts` started from `src/workers/index.ts` by `src/worker.ts`. Producer-facing exports: `src/infra/jobs/index.ts`.
- **Configuration.** `getJobsConfig()` in `src/config/env.ts`: every tunable is a required variable with no default (see `.env.example`, which now exists and is un-ignored via `!.env.example` in the root `.gitignore`); the worker and the CLI fail startup when any is missing or invalid; the API does not read them.
- **Schema.** `OutboxStatus` enum (`PENDING/PROCESSING/SUCCESS/DEAD_LETTER`, replaces `LifecycleStates` on `OutboxEvent` only), `publishAttemptCount`, `executionAttemptCount`, `publishedAt`, `leaseExpiresAt`, `errorClass`, `lastError`, indexes `idx_outbox_claim` / `idx_outbox_retention`; eight new `AuditEventType` values. Migrations `20261012120000_add_admin_audit_event_types` and `20261012120100_outbox_lifecycle` are hand-written (existing rows converted: `FAILED` → `DEAD_LETTER`, old `attemptCount` → `executionAttemptCount`).
- **Audit retrofit.** `src/infra/audit/append-audit-event.ts`; T4/U4/S4/S7 take the acting Admin id from the controller and write one event inside their existing transaction (`*_DEACTIVATED` when deactivating, else `*_UPDATED`/`ESCALATION_POLICY_UPDATED`), `incidentId = null`, metadata = entity id + changed field names.

Not present: any module other than `identity` and `appService`, any consumer registered on a queue, alert-source audit events (`ALERT_SOURCE_UPDATED` exists but nothing writes it yet).

## 6. Known Issues

1. ESLint uses the legacy boundaries rule syntax (deprecated in eslint-plugin-boundaries v7); migrate to `boundaries/dependencies` in a tooling follow-up.
2. Integration helpers import `pg`, typed only via a transitive `@types/pg`; declare it as a devDependency if kept.
3. Unknown routes return Express' default 404 (not the error envelope); the slice does not define a route-not-found code.
4. Oversized JSON bodies return `400 BAD_REQUEST` per SLICE-00 §4.2; the 413 class is unused until SLICE-03.
5. The rate limiter keys on `req.ip`; `trust proxy` is not configured, so behind a reverse proxy all clients share the proxy's IP. Configure it at deployment.
6. The refresh-cookie email is client-controlled until the token is validated; it only feeds the A2 limiter key (project-owner decision) and never authorization.
7. A seeded Admin has `teamId = null` and gets `403 INVALID_ACTION` on incident-scoped endpoints until an Admin sets a team via U4 (login, create a team with T1, `PATCH` the Admin's `teamId`).
8. T4/U4 conflict checks (open incidents, `acknowledgedBy`) read committed state under row locks on `Team`/`User`. Later slices that create incidents or acknowledge them must lock the team / user row (or `FOR SHARE`) to close the race.
9. Interpretation choices where SLICE-01 is silent: "services attached" = any `AppService` of the team, any status; "engineers reporting to a lead" counts users of any status; `403 INVALID_ACTION` checks run before the `409` checks in U4; `409 CONCURRENCY_CONFLICT` (AGENTS §7) is returned for deadlocks / lock timeouts although the slice does not list it.
10. Prisma `migrate deploy` / `validate` and `docker build` remain unverified here (see §4); no migration was added (SLICE-01 or SLICE-02).
11. SLICE-02 interpretation choices where the slice is silent: S4 changing `teamId` or attaching an orphaned policy does **not** re-validate the policy's users against the (new) team, so a moved service can keep a policy of users from its old team; an unknown policy-user id is `403 INVALID_ACTION` (not 404); in S4/S7 only fields whose value actually differs count as a "change" (a repeat of stored values returns `200` with the current state, skips the incident conflicts and does not bump `updatedAt`); check order is validation (422/400) → 404 → 403 `INVALID_ACTION` → 409; SLA values are capped at 2147483647 (PostgreSQL `integer`) with `422` above it.
12. Read-contract shape (`sla` map, `null` for a missing service, no transaction parameter) is a SLICE-02 choice; SLICE-04 may need an optional transaction client if it reads the configuration inside its own transaction.
13. Deactivating a user does not touch escalation policies (per slice); a policy pointing at a deactivated user is a runtime failure in SLICE-07. U4/T4 do not check policy membership.

14. SLICE-08 interpretation choices where the slice is silent or inconsistent: (a) U4 `changedFields` is "keys of `plan.data`" in the table but "fields that actually changed" and "no event for a no-op" in the rules; an unchanged re-sent `name` is therefore excluded (U4 still writes it as before). (b) `DEAD_LETTER` rows do not set `processedAt` (only `SUCCESS` does); failure time is in the log. (c) Added one tunable not listed in §4.9, `OUTBOX_PUBLISH_TIMEOUT_MS`, because BullMQ's `queue.add` can wait indefinitely when Redis is down. (d) Per-queue rate limits are flat variables `JOBS_RATE_<QUEUE>_MAX` / `_DURATION_MS`; `WORKER_CONCURRENCY` is shared by all queues. (e) `lastError` keeps the message only for errors thrown as `RetryableJobError`/`NonRetryableJobError` (redacted, 500 chars); any other error is reduced to its name and code. (f) A worker starts only for queues with a registered processor; the relay still publishes every queue, so events for a queue without a consumer stay `PROCESSING` and are republished after the processing window. (g) The re-drive CLI operator defaults to the OS user name. (h) A successful publish clears `errorClass`/`lastError` from earlier failed publish attempts.
15. A worker that finishes a job before the relay has recorded `PROCESSING` cannot mark `SUCCESS` (the update requires `PROCESSING`); the row is recovered after the processing window and the idempotent consumer re-marks it. Rare and harmless, but it costs one extra delivery.
16. The runtime check of the built worker (valid config: ready, relay publishes a row, `SIGTERM` exit 0; missing variable: exit 1) and of the re-drive CLI was done against a local database; Docker was not available.

## 7. Blockers

Design inputs not defined in the supplied design (details in the affected slices): delay between escalation levels and the SLA scheduling mechanism (SLICE-07); LLM data allow-list/redaction (SLICE-10, 11, 12); investigation knowledge-source set and "no relevant evidence" representation (SLICE-12); notification recipient resolution when there is no assignee (SLICE-09); alert-source configuration JSON shape (SLICE-03/04). None blocks SLICE-01, 02, 05, 06 or 08.

## 8. Next Step

- Implement SLICE-06 next (suggested order 00 → 01 → 02 → 08 → 06 → 03 → 04 → 05 → 09 → 07 → 10 → 11 → 12). Producers of outbox events call `enqueueOutbox(tx, …)` inside their own transaction; consumers register with `registerProcessor` from `src/workers/index.ts`.

<!-- Locally: apply the patch, run `npm ci && npm run build`, `npx prisma validate`, `npx prisma migrate deploy` against the compose database, `docker build`, then close SLICE-00. Then continue with SLICE-06. See `SLICE_IMPLEMENTATION_GUIDE.md` §Suggested order. -->
