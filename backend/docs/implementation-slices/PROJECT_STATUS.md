# PROJECT_STATUS.md

Snapshot of the repository (`DevWithAbhishek/my-ims`, base `45c9468 "feat: establish config, infra, error handling, and runtime entrypoints"` plus the SLICE-01, SLICE-02, SLICE-08 and SLICE-06 patches) and the supplied design documents. Checks marked **Verified** were actually run on 2026-10-14 (SLICE-06 pass; earlier slices 2026-10-13) (Node 22 sandbox, local PostgreSQL 16 + Redis 7 installed via apt); anything else is **Not verified**. Update this file at the end of every slice.

## 1. Project

| Item | Value |
|---|---|
| Name | IMS — Incident Management System (backend) |
| Phase | Implementation: foundation, identity, service catalog, outbox/queue/worker reliability and incident visibility (feed, detail, comments, timeline, audit store) implemented |
| Current slice | SLICE-06 (Incident Visibility, Comments & Timeline) — IMPLEMENTED (`slice-06.patch`); SLICE-00 still pending the unverified items in §4 |
| Overall progress | 4 of 12 feature slices implemented (SLICE-01, SLICE-02, SLICE-06, SLICE-08) plus the foundation |

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
| SLICE-06 Visibility, Comments & Timeline | IMPLEMENTED (patch `slice-06.patch`) | I1, I2, I10 (`comment` row of `PATCH /incidents/:incidentId`), I11 under `/api/v1/incidents`; new `src/modules/incidents/`; audit append contract hardened (`src/infra/audit`); no schema change, no migration. SLICE-05 adds its rows to the dispatcher |
| SLICE-07 SLA Monitoring & Escalation | NOT STARTED | Blocked on two undefined inputs (see slice) |
| SLICE-08 Outbox, Queue & Worker Reliability | IMPLEMENTED (patch `slice-08.patch`) | `src/infra/jobs` (enqueue contract, relay, BullMQ gateway/workers, retry classification, dead letter, stale recovery, retention, re-drive), `src/infra/audit`, audit retrofit of T4/U4/S4/S7, two migrations, `npm run redrive:outbox`. No consumers yet: later slices register processors |
| SLICE-09 Notifications | NOT STARTED | |
| SLICE-10 AI Alert Triage | NOT STARTED | Blocked on LLM data allow-list |
| SLICE-11 Postmortem, Review & Closure | NOT STARTED | Blocked on LLM data allow-list (generation part) |
| SLICE-12 AI Investigation & Evaluation | NOT STARTED | Blocked on LLM data allow-list; retrieval source set undefined |

## 4. Repository State (verified 2026-10-14)

| Check | Result |
|---|---|
| `npm run typecheck` | Verified (SLICE-06 pass): passes |
| `npm run lint` | Verified (SLICE-06 pass): exit 0 (same boundaries v7 deprecation warnings as before) |
| `npm run format:check` | Verified (SLICE-06 pass): `src/` and `test/` clean; the same 11 `docs/*.md` files fail as before the slice (pre-existing, untouched) |
| `npm test` | Verified (SLICE-06 pass): 25 suites, 308 tests pass |
| `npm run test:int` | Verified (SLICE-06 pass): 12 suites, 313 tests pass against local PostgreSQL 16 + Redis 7 (test DB `ims_test`, Redis db 15; PostgreSQL on port 5432 via `TEST_DATABASE_URL`), including real BullMQ workers and an unreachable-Redis publish |
| `npm run build` | Verified: `prisma generate` + `tsc` produce `dist/main.js`, `dist/worker.js`, `dist/scripts/seed-admin.js`, `dist/scripts/redrive-outbox.js`, `dist/infra/jobs/` and `dist/modules/appService/`; no spec files in `dist` |
| Runtime | Verified (SLICE-00; re-checked for SLICE-01 with the built server; **not re-run for SLICE-02** (HTTP behavior covered by the integration suite on the real app wiring): login, team create/list, seed script run twice): built API boots; `/health` 200; `/ready` 200, 503 + `Retry-After: 5` with Redis stopped, recovers; `SIGTERM` exits 0; startup exits 1 on invalid config, unreachable DB, unreachable Redis, port in use; worker stays up, logs ready, exits 0 on `SIGTERM` |
| Migration | Verified: all three migrations apply to an empty PostgreSQL database and the two SLICE-08 migrations also apply over existing outbox rows (integration test, via `pg`; also applied with `psql`). **Not verified:** `prisma migrate deploy` / `prisma validate` / `prisma migrate diff` (so that the hand-written SLICE-08 SQL matches `schema.prisma` without drift is checked by review and tests only; Prisma engine download is blocked; `prisma generate` was run with a sandbox-only stand-in `PRISMA_SCHEMA_ENGINE_BINARY`) |
| Runtime (SLICE-06) | Verified: with PostgreSQL stopped, `GET /incidents`, `GET /incidents/:id`, `GET …/timeline` and `PATCH … {comment}` each return `503 DEPENDENCY_UNAVAILABLE` + `Retry-After: 5` in the standard error envelope (script against the real app wiring; PostgreSQL restarted afterwards). Feed latency over HTTP with 100,000 incidents (50,000 in the caller's team), 50-row pages: p95 27–47 ms for `severity`/`createdAt`/`title`/`status` |
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

- **SLICE-06.** `src/modules/incidents/` (directory is plural to match the ESLint boundaries config), mounted in `src/api-router.ts` via `createIncidentsRouter()`; public interface `index.ts` exports only that. Layout: `incident.{controller,service,repository,mapper,schema}.ts` (I1, I2), `timeline/` (I11), `comments/` (I10 handler and repository), `update/` (the `PATCH /incidents/:incidentId` dispatcher skeleton: full strict `UpdateIncidentDto`, rows registry `UPDATE_ROWS`, `selectRow` = exactly one row else `422`; only the `comment` row exists), pure units `sla.ts`, `cursor.ts`, `ai-triage.ts`, `timeline/timeline.mapper.ts`, shared `incidents.common.ts` (`assertIncidentAccess` = 404 / `403 TEAM_ACCESS_DENIED`, `runIncidentTransaction`, `withDatabaseOutageMapping`).
- **I1** keyset pagination in raw SQL on `(sort column, id)` (Prisma cannot compare enums with `>`/`<`), column names from a whitelist, cursor values validated before they are cast; two queries (ids, then rows with relation selects). **I2** explicit `select` (never `originalPayload`, triage `summary`/`rawOutput`); `aiTriage` from the latest accepted alert (last by `createdAt`, `id`). **I10** in one transaction: `FOR SHARE` lock on the incident, `CLOSED` check under the lock, `Comment` insert, `COMMENT_ADDED` audit event. **I11** reads only the 22 incident event types; user ids resolved with one query.
- **Audit append contract.** `appendAuditEvent` now stamps `createdAt` explicitly, strictly increasing per transaction handle (the database default is the transaction start time; measured 242 distinct timestamps for 300 events in one transaction before the change). It remains the only export of the audit store (append-only; verified by a test and by source search). `src/infra/db/errors.ts` gained `isDatabaseUnavailable`.
- **Audit metadata contract for producers (SLICE-03/04/05/07/09/10/11/12).** For each incident event type, stored `metadata` carries the public `details` keys of the timeline whitelist, except that every `UserSummary` field holds the user's uuid (resolved at read time); `NOTIFIED.recipients` is a uuid array; `COMMENT_ADDED` stores a snapshot `{ id, title, body, authorId, createdAt }` under `comment`. Unknown keys are never exposed. Documented in `timeline/timeline.mapper.ts`.

Not present: any module other than `identity`, `appService` and `incidents`, any consumer registered on a queue, alert-source audit events (`ALERT_SOURCE_UPDATED` exists but nothing writes it yet).

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

17. SLICE-06 interpretation choices where the slice is silent: (a) `SlaStatus`: `BREACHED` when `now > deadline`, `WARNING` from 80 % elapsed, `MET` once acknowledged/resolved even if late; shape from `API.md` §3.1 because the slice defers to SLICE-05, which was not supplied. (b) SLA thresholds are read through the `Incident → AppService` relation in the incidents repository (one joined query, no import of `appService`, no ESLint boundary change) instead of `getServiceConfig`, to avoid up to 50 extra queries per page; the 8 column names are mapped again in `incident.mapper.ts`. (c) A cursor reused under another `orderBy`/`sort`, an empty `cursor=` and any wrong-shape or invalid-value cursor are `422 INVALID_CURSOR`; unknown query parameters (including `teamId`) are `400 BAD_REQUEST` like the other strict DTOs. (d) Check order: validation (400/422) → `teamId = null` `403 INVALID_ACTION` (before any lookup, so such callers cannot probe ids) → `404` → `403 TEAM_ACCESS_DENIED` → `409`. (e) I10 locks the incident `FOR SHARE` (comments do not serialize; a close needing `FOR UPDATE` waits) rather than `API.md`'s generic row lock; its `409` has `details: [{ currentStatus: 'CLOSED' }]` (no single `requiredStatus` exists). (f) Bodies of actions owned by SLICE-05 (`status`, `severity`, `currentAssignee`, …) pass strict parsing but match no row, so they return `422` until SLICE-05 adds rows. (g) `503 DEPENDENCY_UNAVAILABLE` for a database outage is mapped only inside the incidents handlers (`Retry-After: 5`); the global error middleware is unchanged, so other modules still answer `500`. (h) A user id that cannot be resolved in the timeline becomes `{ id, name: '' }` (users are never deleted, so this is defensive); the timeline filters to the 22 incident types even if an administrative event carried an `incidentId`. (i) `alerts` are ordered by `createdAt`, `id` ascending; `aiTriage.generatedAt` is `AITriage.createdAt`. (j) The slice's §5 says its migration adds the 8 administrative enum values, §4/§11 say SLICE-08 already did; verified present, no migration added. (k) No index migration: with 100,000 incidents the feed query is a parallel scan with top-N sort (about 16 ms) and p95 stayed under 50 ms; add `(teamId, <sort column>, id)` indexes only if the volume grows.
18. Not covered by tests: the `503` mapping is verified by unit tests of the predicate/wrapper and by the manual outage run in §4, not by an automated integration test (stopping PostgreSQL inside the suite would break the other suites).

## 7. Blockers

Design inputs not defined in the supplied design (details in the affected slices): delay between escalation levels and the SLA scheduling mechanism (SLICE-07); LLM data allow-list/redaction (SLICE-10, 11, 12); investigation knowledge-source set and "no relevant evidence" representation (SLICE-12); notification recipient resolution when there is no assignee (SLICE-09); alert-source configuration JSON shape (SLICE-03/04). None blocks SLICE-01, 02, 05, 06 or 08.

## 8. Next Step

- Implement SLICE-03 next (suggested order 00 → 01 → 02 → 08 → 06 → 03 → 04 → 05 → 09 → 07 → 10 → 11 → 12). SLICE-03 writes `ALERT_SOURCE_UPDATED` (null actor) through `appendAuditEvent`. SLICE-04/05/07/09/10/11/12 write incident audit events with the metadata contract in §5; SLICE-05 adds its rows to `UPDATE_ROWS` in `src/modules/incidents/update/incident-update.dispatcher.ts` (it can take `FOR UPDATE` locks; I10 only needs `FOR SHARE`). Producers of outbox events call `enqueueOutbox(tx, …)` inside their own transaction; consumers register with `registerProcessor` from `src/workers/index.ts`.

<!-- Locally: apply the patch, run `npm ci && npm run build`, `npx prisma validate`, `npx prisma migrate deploy` against the compose database, `docker build`, then close SLICE-00. Then continue with SLICE-06. See `SLICE_IMPLEMENTATION_GUIDE.md` §Suggested order. -->