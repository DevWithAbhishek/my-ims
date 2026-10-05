# AGENTS.md — IMS Repository Rules for AI Coding Agents

Reusable across every implementation chat. It is not slice-specific. The active slice file says _what_ to build; this file says _how to work_ and defines repository-wide conventions that apply to every slice.

---

## 1. Repository Purpose

IMS is an Incident Management System backend (portfolio project). It ingests authenticated alerts, creates and deduplicates incidents, drives an incident lifecycle (`OPEN → ACKNOWLEDGED → MITIGATING → RESOLVED → CLOSED`) with SLA monitoring and escalation, sends notifications, and uses advisory AI (alert triage, postmortem drafts, investigation briefs). Engineering goals: transactional correctness, concurrency safety, idempotent async processing, strict team isolation.

Stack (from `backend/package.json`): Node 22, TypeScript (strict), Express 5, Zod 4, Prisma 7 + `@prisma/adapter-pg` on PostgreSQL, BullMQ + ioredis (Redis), pino logging, argon2, jsonwebtoken, Jest + ts-jest + supertest, ESLint (typescript-eslint + eslint-plugin-boundaries), Prettier.

## 2. Source of Truth

| Question                                              | Authority                                         |
| ----------------------------------------------------- | ------------------------------------------------- |
| What exists in code right now                         | **The repository** (never assume docs match code) |
| What the active capability must do                    | **The active `SLICE-XX.md`**                      |
| How to work / repo-wide rules                         | **This file**                                     |
| Project-state snapshot (what is done, what is broken) | **`PROJECT_STATUS.md`**                           |

The master design documents (PRD, Domain Model, DB schema, API, Index) are **not** inputs to normal slice implementation. Each slice already contains the endpoint contracts and data context it needs. If the slice and the repository disagree about _current implementation_, the repository wins; if they disagree about _required behavior_, the slice wins. Do not edit `prisma/schema.prisma` semantics away from what the slice states.

## 3. Before Changing Anything

1. Read the active slice completely, then `PROJECT_STATUS.md`.
2. Inspect the repository: `src/` structure, existing modules and their `index.ts` public interfaces, `src/shared`, `src/infra`, `prisma/schema.prisma`, `prisma/migrations/`, `test/` and `src/**/*.spec.ts`, `package.json` scripts, `eslint.config.mjs`, `docker-compose.yml`.
3. Find the existing pattern for what you are about to build (controller/service/repository shape, error classes, logging, test helpers) and follow it.
4. Run the existing checks first (`typecheck`, `lint`, `test`) so you know the baseline. Record pre-existing failures; do not hide them and do not "fix" them unless the slice says to.
5. Do not trust comments, README text, or old docs under `backend/docs/` over the code. `backend/docs/implementation-slices/*` and `backend/docs/API.md` in the repo may be stale drafts; the active slice supersedes them.

## 4. Scope

- Implement **only the active slice**. Do not implement future slices, even partially, even "while you are there".
- If the slice depends on behavior owned by another slice and it is missing in the repo, implement only the **minimum contract the slice's Dependencies section describes**, in the owning module's location, and say so in your final report.
- No unrelated refactoring, renaming, reformatting of untouched files, dependency upgrades, or speculative abstractions. Preserve behavior outside the slice.
- Do not redesign finalized behavior (state machine, error codes, status codes, authorization rules, response shapes). Implement what the slice says.

## 5. Architecture (as established by the project)

- **Modular monolith** (one deployable API process + a separate worker process from the same image). Modules per the architecture: Identity (auth/users/teams), AppService (services, SLA config, escalation policy), Alerts (sources, alerts, ingestion), Incident (lifecycle, comments, audit/timeline, postmortem lifecycle), Notifications, AI (triage, postmortem generation, investigation). Intended layout: `src/modules/<module>/`, `src/infra/{db,redis,jobs}`, `src/shared/{errors,middleware,observability}`, `src/workers/`. If the repo's actual directory names differ, follow the repo and note it.
- **Layering inside a module:** Controller → Service → Repository → PostgreSQL. Controllers handle HTTP and validation only; services hold business rules and transaction boundaries; repositories are the only place that talks to Prisma/SQL.
- **Dependency direction:** modules may use `shared` and `infra`; a module may use another module only through that module's public `index.ts`. Declared direction: Alerts → Incident, AppService. Other cross-module use must go through a public interface and be justified by the slice. Do not import another module's internals or repository directly.
- **Shared/common code** (`src/shared`) is for cross-cutting helpers only (errors, middleware, logging, request context). Business logic does not live there.
- External calls (email provider, LLM provider) happen **only inside workers**, never inline in an HTTP request and never inside a database transaction.
- The AI provider is behind an abstraction (ADR-013); no module calls a vendor SDK directly from business code.

## 6. API Conventions (finalized design; apply to every endpoint)

- Base path `/api/v1`. JSON `camelCase` fields; enums `UPPER_SNAKE`; ids are UUID strings; timestamps ISO-8601 UTC with `Z`. The eight flat service SLA fields keep DB names (`P0ResponseSlaMinutes` …) — the one exception.
- **Envelope:** `{ "data": … }` for one resource/command result; `{ "data": [...], "pagination": {...} }` for lists; errors `{ "error": { "code", "message", "details": [], "requestId" } }`. `details` is always an array. Optional absent values are `null`, never omitted. Never return stack traces, SQL messages, secrets, `passwordHash`, signing secrets, prompts, or raw model input. A `500` returns only `INTERNAL_ERROR` + `requestId`.
- Request DTOs are **Zod-strict**: unknown fields → `400 BAD_REQUEST`. Missing/invalid fields, malformed path ids, bad query values → `422 VALIDATION_FAILED` with `details: [{ field, issue }]`. Malformed JSON / wrong `Content-Type` (non-webhook) → `400 BAD_REQUEST`. Validation runs **before** state checks.
- **Authorization gates, in order:** Gate 0 authentication `401 UNAUTHENTICATED` → Gate 1 role `403 FORBIDDEN_ROLE` → Gate 2 team isolation `403 TEAM_ACCESS_DENIED` (resource of another team) / escalation-chain membership `403 FORBIDDEN` → Gate 3 state/business `409 INVALID_STATE_TRANSITION | POSTMORTEM_STATE_INVALID | …` or `403 INVALID_ACTION`. A non-existent id is `404 <RESOURCE>_NOT_FOUND` with `details: [{ resource }]`.
- Access token: JWT, 15 min, in `Authorization: Bearer`. Claims: `userId`, `email`, `role`, `teamId` (`null` when no team), `sessionId`, `exp`. The guard trusts the JWT until `exp` and does **not** read the database on protected requests. Team scope for incidents is **always** the caller's `teamId` claim, never a client parameter. Roles: `ENGINEER`, `TEAM_LEAD`, `ADMIN`. A caller with `teamId = null` gets `403 INVALID_ACTION` on every incident-scoped endpoint (Admins included).
- "Unresolved incident" = status `OPEN`, `ACKNOWLEDGED` or `MITIGATING`. "Escalation chain" of an incident = the four users of its service's escalation policy (`level1`, `level2`, `level3`, `fallbackAdmin`).
- Headers: `X-Request-Id` accepted if ≤128 chars of `[A-Za-z0-9-_]` else replaced; always echoed in the response and `error.requestId`. `Retry-After` (seconds) on `429` and `503`. `Idempotency-Key` is accepted only on the investigation request endpoint.
- HTTP status use: 200 read/command/update/idempotent replay; 201 new stored resource; 202 only for the investigation request (first time); no `204`; no `DELETE` endpoints anywhere.
- Error codes are stable; messages are not. One status per code (`INVALID_ACTION` is always `403`). Full code list lives in the slice that emits each code.
- Pagination: offset lists return `pagination: { limit, offset, hasMore }` (no `total`); the incident list uses an opaque cursor `pagination: { nextCursor, hasMore }`. `limit` over max → `422 VALIDATION_FAILED`. Tie-breaker is always `id` in the same direction as `sort`.

## 7. Database

- PostgreSQL via Prisma 7 (`@prisma/adapter-pg`). `DATABASE_URL` (pooled; used by API and workers) and `DIRECT_URL` (direct; migrations). Do not use session-level features through the pooler. Keep the app pool small (about 5–10 per instance).
- Prisma schema changes always go through a **migration**; inspect the generated SQL before applying it. Constraints the design relies on that Prisma cannot express (partial/conditional indexes, extra lookup indexes) are added as hand-written SQL in a migration.
- Business state changes use explicit transactions. Where a slice says "lock", lock the row (`SELECT … FOR UPDATE` via raw SQL) and **re-check state under the lock**; do not read-then-write. Lock-timeout/serialization failures map to `409 CONCURRENCY_CONFLICT`.
- A successful incident state change, its audit event(s) and its required outbox event(s) commit in **one transaction**; the HTTP response is sent only after commit.
- Uniqueness and invariants the design depends on must be enforced by the database, not only in code. Catch unique-violation errors and map them to the specified outcome.
- Repository layer maps API names to schema names (e.g. `acknowledgedAt ↔ acknowledgedTimestamp`, `body ↔ comment.description`, `contributingFactors ↔ factors`, `mttrMinutes ↔ MTTR`, `level1 ↔ level1Id`, `currentAssignee ↔ currentAssigneeId`, `startedAt ↔ startedTimestamp`, `relevance ↔ relevanceInfo`, `reasoningSummary ↔ AITriage.reasoning`). DB names never leak into API responses (except the flat SLA fields).

## 8. Async / Queues

- Pattern: **transactional outbox → relay → BullMQ → worker**. Business code only writes an `OutboxEvent` row inside its transaction; it never enqueues to Redis directly.
- Delivery is **at-least-once**; every consumer is idempotent and enforces its own once-only guarantee with a database key (notification `idempotencyKey`, `Postmortem.incidentId` unique, alert active identity key, etc.). Never rely on the queue alone for exactly-once.
- Retries: exponential backoff, bounded attempts, retryable vs non-retryable classification, and a dead-letter/failure state on exhaustion that remains observable. Retry values are configuration, defined in one place.
- **Outbox event catalog** (repo-wide contract; one module exports these constants, payloads carry ids and the minimum facts only, plus the originating `requestId` for log correlation — never secrets, prompts, or payload bodies). Queue names: `ai-triage`, `sla-escalation`, `notifications`, `postmortem`, `investigation`.

  | Event type                        | Written (in the producer's transaction) by                                                         | Consumer queue   | Payload                                                               |
  | --------------------------------- | -------------------------------------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------- |
  | `ALERT_TRIAGE_REQUESTED`          | alert ingestion (incident created)                                                                 | `ai-triage`      | `{ alertId, incidentId }`                                             |
  | `SLA_EVALUATION_REQUESTED`        | ingestion; severity/ack/unassign changes, when the SLA scheduling mechanism needs it               | `sla-escalation` | `{ incidentId }`                                                      |
  | `NOTIFICATION_REQUESTED`          | lifecycle actions, SLA/escalation, postmortem generation failure/closure, admin rate-limit notices | `notifications`  | `{ kind, incidentId?, actorId?, … ids needed to resolve recipients }` |
  | `POSTMORTEM_GENERATION_REQUESTED` | resolve (I8), retry (P4)                                                                           | `postmortem`     | `{ postmortemId, incidentId }`                                        |
  | `INVESTIGATION_REQUESTED`         | investigation request (N1)                                                                         | `investigation`  | `{ investigationId, incidentId }`                                     |

- Redis is never the source of truth for business state. Workers run as a separate process (`dist/worker.js`).
- No LLM or email call inside an HTTP request or a DB transaction. AI failure never blocks persistence or lifecycle transitions.

## 9. Security

- Passwords hashed with argon2; never logged or returned. Refresh tokens stored only as hashes. Access tokens are never logged.
- All authorization is server-side; team isolation applies to 100% of incident operations. Never accept a team id from the client for incident scope.
- Secrets (JWT secret, source signing secrets, LLM credentials) come from environment/config, never source code; never logged, audited, returned, or put in error messages.
- Logs: structured pino; include `requestId`, `actorId`, `actorRole`, `teamId`, `incidentId` where known (see `src/shared/observability/logger.ts`). Never log passwords, tokens, signing secrets, raw alert payload bodies, prompts, or raw model input/output.
- AI data sent to a provider is limited to an approved allow-list; never send credentials or unapproved fields.

## 10. Testing

- Unit tests: `src/**/*.spec.ts` (`npm test`), no external services. Integration tests: `test/integration/*.int-spec.ts` (`npm run test:int`), real PostgreSQL + Redis from `docker compose up -d postgres redis`; run serially.
- Every slice needs tests for: happy paths; validation (`422`/`400`); each documented error code; authorization (each role, each gate, cross-team, `teamId = null`); database constraints; and, where the slice says so, concurrency (parallel requests, single winner), idempotency (replay/duplicate job), failure paths (dependency down, retries, exhaustion), and atomicity (rollback leaves no partial audit/outbox).
- Do not weaken, skip, or delete a test or requirement to get green. Fix the code. If a test is wrong, say why in the report.
- External providers (LLM, email) are faked behind their abstraction in tests.

## 11. Code Quality

- Follow `.prettierrc.json` (single quotes, semicolons, trailing commas, width 100, 2 spaces) and `eslint.config.mjs`. TypeScript strict; no `any` without justification; ESM-style imports with `.js` extension as already used in the repo.
- Errors: throw the shared `AppError` subclasses (`src/shared/errors/AppError.ts`); the error-mapping middleware produces the envelope. Add error classes/codes only as the slice specifies.
- Small, readable functions; no dead code, no commented-out blocks, no TODOs left behind. Match existing naming.

## 12. Scope Control (prohibited)

- Implementing future slices
- unrelated refactors
- changing finalized behavior or contracts
- speculative abstractions/frameworks
- adding endpoints, fields, states, or events the slice does not define
- installing packages the slice does not need (justify any addition)
- editing historical migrations that have been applied.

## 13. Blockers

If you cannot complete the slice without a significant design decision (the slice is silent or contradicts itself, or the repository state makes the specified behavior impossible without redesign): **stop**, explain the conflict precisely (what the slice says, what the repo shows, options), and do not invent product behavior. Where a slice states that a value is "supplied by the project owner", do not choose it yourself.

## 14. Completion — verify before declaring a slice done

1. Every in-scope endpoint/worker/behavior in the slice works as specified (request, response, status codes, error codes, authorization, side effects).
2. Persistence is correct; constraints and indexes exist via a reviewed migration that applies cleanly on an empty database.
3. Required transactions are atomic; concurrency and idempotency requirements hold under test.
4. `npm run typecheck`, `npm run lint`, `npm test`, `npm run test:int` (when the slice has DB/Redis behavior), and `npm run format:check` on touched files — report actual results; if a check cannot run, write "Not verified" and why. Never fabricate results.
5. Existing behavior and tests still pass; no unrelated files changed.
6. The slice's Completion Criteria are each checked and reported.
7. Report: what was implemented, files touched, migrations added, checks run with real results, deviations/blockers. Then update `PROJECT_STATUS.md` (see the implementation guide).
