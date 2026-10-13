# SLICE-08 — Outbox, Queue & Worker Reliability

## 1. Purpose
Provide the durable handoff from committed database state to asynchronous processing: the transactional outbox write contract, a relay that claims and publishes outbox rows to BullMQ, and the common worker reliability rules — at-least-once delivery, idempotent consumers, bounded exponential retry, a durable dead-letter state, and recovery after relay/worker/Redis failure. The outbox acts as both the hand-off queue and the execution ledger.

## 2. Scope
### In Scope
The `enqueueOutbox` in-transaction contract and event-catalog module; the outbox lifecycle and its migration; the relay (claim, publish, mark, stale-work recovery); queue and worker bootstrap for the five queues plus the shared `dead-letter` queue; the shared retry/backoff/classification policy; the durable failure record; the operator re-drive CLI; retention deletion of finished rows; a single configuration module for all tunable values; observability; and the **retrofit of administrative audit events into the existing SLICE-01 and SLICE-02 endpoints** (§4.11), so those two slices stay unchanged.
### Out of Scope
The business logic of any consumer (SLICE-07, 09, 10, 11, 12); the SLA reconciliation scanner and deadline logic (SLICE-07); notification records/email (SLICE-09); any HTTP endpoint (none exists for outbox, queues or DLQ); LLM calls.

## 3. Dependencies
SLICE-00: Prisma client, BullMQ-compatible Redis connection factory (`maxRetriesPerRequest: null`), validated configuration, worker entrypoint (`src/worker.ts`), logger. Producers (SLICE-03 Admin notice, 04, 05, 07, 11, 12) call the write contract inside their transactions; consumers register processors with this slice's worker bootstrap. The retrofit in §4.11 additionally requires SLICE-01 and SLICE-02 to be implemented (endpoints T4, U4, S4, S7 exist) and the audit contract `appendAuditEvent(tx, …)` plus the 8 administrative `AuditEventType` values (migration owned by SLICE-06; if absent, create only the append function and the enum migration for those values, and report it). The rest of this slice does not depend on SLICE-01/02.

## 4. Capability Behavior

### 4.1 Write contract and catalog
`enqueueOutbox(tx, { eventType, aggregateType, aggregateId, payload, availableAt? })` inserts one `OutboxEvent` row (`status PENDING`, both attempt counters `0`) using the **caller's transaction handle**; it never commits, never opens a transaction, never touches Redis. This slice owns the catalog module (repo-wide contract in `AGENTS.md` §8): `ALERT_TRIAGE_REQUESTED` → `ai-triage`; `SLA_EVALUATION_REQUESTED` → `sla-escalation`; `NOTIFICATION_REQUESTED` → `notifications`; `POSTMORTEM_GENERATION_REQUESTED` → `postmortem`; `INVESTIGATION_REQUESTED` → `investigation`. Payloads carry ids and the minimum facts plus the originating `requestId`; never secrets, prompts or payload bodies. Unknown event types and invalid payloads are rejected by the contract.

### 4.2 Lifecycle
Statuses: `PENDING`, `PROCESSING`, `SUCCESS`, `DEAD_LETTER`. **`FAILED` is retired for the outbox** (not used by any outbox code path; the shared `LifecycleStates` enum keeps it for other models, see §5). Retryable failures stay `PENDING` with a future `availableAt`.

| Status | Meaning |
|---|---|
| `PENDING` | Waiting to be published (`availableAt ≤ now`). With a non-expired `leaseExpiresAt` it is **claimed** by a relay that is publishing it. |
| `PROCESSING` | Published to BullMQ (`publishedAt` set); the job is not yet completed (for example a notification enqueued but not yet sent). `leaseExpiresAt` is the deadline by which it must have progressed. |
| `SUCCESS` | The worker completed the job (`processedAt` set). |
| `DEAD_LETTER` | Terminal failure (non-retryable, or execution attempts exhausted). Durable failure record; kept until an operator re-drives it. |

### 4.3 Relay (publication stage)
1. **Claim:** in a short transaction, `SELECT … FOR UPDATE SKIP LOCKED` a batch of `PENDING` rows with `availableAt ≤ now` and (`leaseExpiresAt` is null or expired); set `leaseExpiresAt = now + claimLease`; commit. Several relays may run; each row is claimed by exactly one at a time.
2. **Publish outside the transaction:** add the job to the event's queue with `jobId` = the outbox event id and the execution retry options of §4.4.
3. **On success:** conditionally update the row (`WHERE id AND status = PENDING`) to `PROCESSING`, `publishedAt = now`, `publishAttemptCount + 1`, `leaseExpiresAt = now + processingWindow`.
4. **On publish failure:**
   - *Retryable* (Redis/BullMQ unavailable, transient errors): `publishAttemptCount + 1`, record `errorClass`/`lastError`, keep `PENDING`, clear the lease, set `availableAt = now + capped exponential backoff`. **Publication is retried without a maximum**, so a Redis outage never dead-letters work.
   - *Non-retryable* (unsupported event type, invalid payload): go directly to `DEAD_LETTER` (§4.5).
5. **Relay crash / uncertain enqueue:** a claimed `PENDING` row whose lease expired is reclaimed and republished. Publication is **at-least-once**, never exactly-once; a job may be published twice (BullMQ `jobId` de-duplication helps only while the job exists); consumers are idempotent.
6. **Stale-work recovery:** a periodic pass finds `PROCESSING` rows with `leaseExpiresAt < now` (the job never progressed — worker/Redis lost) and returns them to `PENDING` (`availableAt = now`, lease cleared) so they are republished safely. A `PROCESSING` row is never ignored forever.

### 4.4 Worker execution stage
Every processor runs inside a common wrapper:
- **Success:** conditionally update the row to `SUCCESS` (`processedAt = now`, lease cleared). The consumer's own business effect and its once-only key remain the correctness guarantee; if the process dies after the effect but before this update, the row stays `PROCESSING`, is republished, and the idempotent consumer is a no-op that then marks `SUCCESS`.
- **Failure:** increment `executionAttemptCount`; classify:
  - **Retryable** — temporary network failure; temporary service failure; rate limiting (retry after an appropriate delay, honoring a provider-supplied delay when available); transient database failure; temporary Redis/provider outage; worker interruption (BullMQ stalled-job recovery); unknown internal error (limited retry, then dead-letter for investigation). BullMQ owns execution retries: **5 attempts total** (initial run + up to 4 retries) with **exponential backoff**.
  - **Non-retryable** — invalid payload; unsupported event type; permanent business-rule violation; authentication/configuration error; resource not found; authorization failure. No retry: straight to `DEAD_LETTER`.
- **Retry ownership by stage:** the relay retries publication; BullMQ retries execution. They are coordinated through the outbox row and consumer idempotency.
- Consumers throw typed errors; this slice maps them to retryable/non-retryable.

### 4.5 Dead letter (durable failure record)
On a non-retryable error or exhausted attempts: update the outbox row to `DEAD_LETTER` with `errorClass`, sanitized `lastError`, both attempt counters and timestamps (the durable failure record in PostgreSQL), then add a job describing it (outbox event id, event type, source queue, error class) to the single shared **`dead-letter`** queue. The database write comes first; a failed DLQ publish never loses the record.

### 4.6 Re-drive CLI
An operator script/CLI (no HTTP endpoint) takes an outbox event id, validates the row (exists, is `DEAD_LETTER`, event type supported, payload valid), and requeues it: `status PENDING`, `availableAt = now`, lease cleared, `executionAttemptCount = 0`. The operator and time are written to the structured log. It reuses the same business keys, so processing stays idempotent.

### 4.7 Retention
A periodic job in the worker process **deletes `SUCCESS` rows** older than the configured retention window. `DEAD_LETTER` rows are never deleted by retention; they remain until re-driven. The window must exceed the recovery/investigation window.

### 4.8 Redis / queue loss and recovery
Redis is never the source of truth; the worker runs as a separate process (`dist/worker.js`). No critical work exists only in Redis: `PENDING` rows are republished, expired `PROCESSING` rows are republished, and BullMQ jobs are rebuildable execution messages. Delayed SLA timers lost with Redis are reconstructed by SLICE-07 from durable deadlines and its reconciliation scanner. Ephemeral state: cache entries, rate-limit counters (reset after loss), temporary AI computation cache. Re-constructable: BullMQ job metadata, delayed SLA timers, worker locks/coordination (lease expiry + retry). Durable: notification delivery status, audit and business events.

### 4.9 Configuration (single module, no hard-coded defaults)
All tunable values are read from one configuration module and **must be supplied by configuration** (startup fails if missing): relay poll interval and batch size; claim lease duration; processing window (`PROCESSING` lease); publication backoff base and cap; execution backoff base and cap; execution attempts (**5** per the design); stale-recovery pass interval; retention window; retention job interval; worker concurrency and per-queue rate limits.

### 4.10 Observability
Structured logs for every relay and worker step: queue, job id, outbox event id, event type, attempt numbers, outcome, duration, retryable flag, `requestId` from the payload; dead-letter and re-drive events at appropriate levels. No payload bodies or secrets.

### 4.11 Retrofit: administrative audit events in the implemented SLICE-01 and SLICE-02 code
SLICE-01 (identity) and SLICE-02 (services/policies) are implemented and pushed (repository HEAD `94f92f1`) and are **not modified as specifications**; this slice makes the code changes they now need. Only one thing needs code: **administrative audit events** on four existing update endpoints. Nothing else changes — Argon2 with default configuration is already used (`src/modules/identity/auth/password.ts`), no inter-responder timing exists, and no request/response shape, status code, error code or other behavior changes.

**Ordering.** The implementation order is 00 → 01 → 02 → **08** → 06, so SLICE-06 (the audit store) does not exist yet. This slice creates **only the minimal audit pieces** below; SLICE-06 later verifies and extends them (reads, timeline, comment events) and must not recreate them.

**Minimal audit pieces to create**
- **Migration:** add eight values to the existing `AuditEventType` enum — `USER_UPDATED`, `USER_DEACTIVATED`, `TEAM_UPDATED`, `TEAM_DEACTIVATED`, `SERVICE_UPDATED`, `SERVICE_DEACTIVATED`, `ESCALATION_POLICY_UPDATED`, `ALERT_SOURCE_UPDATED`. The 22 existing values are untouched. Review the SQL: PostgreSQL does not allow using a new enum value inside the transaction that adds it. It must apply from an empty database and over existing rows. `ALERT_SOURCE_UPDATED` is added now but written later (SLICE-03's seed).
- **Function:** `appendAuditEvent(tx, { incidentId: string | null, eventType, actorId: string | null, metadata })` in `src/infra/audit/`. It lives in infra so identity and appService can call it without a new module-boundary rule or an identity ↔ incident dependency (the lint rules let every module use `infra`). It inserts one `AuditEvent` row (`actor = actorId`, `incidentId`, `metadata`) on the **caller's transaction handle** (reuse `TransactionClient` from `src/infra/db/prisma.ts`); it never opens or commits a transaction and has no update/delete path. No timeline mapping, reads or whitelist here (SLICE-06).

**Event rules.** Updates and deactivations only. One event per request, written inside the transaction each endpoint already uses. Actor = the authenticated Admin (`AuthContext.userId`) — pass it from the controller into the service function (the update functions currently take only the target id and body). `incidentId = null`. `metadata = { <entity>Id, changedFields: string[] }`: the entity id and the **names** of fields that actually changed — never values, never passwords/hashes/tokens/secrets (a password change shows only the name `password`). A request that deactivates **and** changes other fields writes only the `*_DEACTIVATED` event; reactivation is a `*_UPDATED`. **No event for a no-op request**, for creates (T1, U1, S1, S5), reads, logins or logouts; do not change how no-op requests are written today, only skip the event. The event commits atomically with the change; a rolled-back request leaves no event.

| Endpoint | Where | Event | `changedFields` |
|---|---|---|---|
| T4 `PATCH /identity/teams/:teamId` | `identity/teams/team.service.ts` `updateTeam`, after `writeTeam` | `TEAM_DEACTIVATED` when `deactivating`, else `TEAM_UPDATED` | `name`/`status` when they differ from the stored values |
| U4 `PATCH /identity/users/:userId` | `identity/users/user.service.ts` `updateUser`, after `writeUser` | `USER_DEACTIVATED` when `plan.data.status === 'DEACTIVATED'`, else `USER_UPDATED` | keys of `plan.data` (`name`, `role`, `status`, `teamId`, `leadId`) plus `password` when sent |
| S4 `PATCH /services/:serviceId` | `appService/services/service.service.ts` `updateService`, after `writeService` (only when `changes` is non-empty) | `SERVICE_DEACTIVATED` when `changes.status === 'DEACTIVATED'`, else `SERVICE_UPDATED` | keys of `changes` (includes `escalationPolicyId` when swapped) |
| S7 `PATCH …/escalation-policies/:escalationPolicyId` | `appService/escalation-policies/policy.service.ts` `updatePolicyUsers`, after `updatePolicy` (the early no-op return stays) | `ESCALATION_POLICY_UPDATED` (a policy has no `status`) | changed levels by API name (`level1`, `level2`, `level3`, `fallbackAdmin`) |

Team deactivation side effects (detaching users, revoking sessions) produce no per-user events; only `TEAM_DEACTIVATED` is written. Existing locks, lock order, rules, precedence and error codes stay as implemented. These events never appear in the incident timeline and the API exposes no endpoint that reads them.

**Tests.** Extend the existing integration specs (`teams.int-spec.ts`, `users.int-spec.ts`, `services.int-spec.ts`, which also covers policies) and the migrations integration test: per endpoint assert event type, `incidentId = null`, actor = the calling Admin, metadata = id + field names only, exactly one event per effective request; none for no-ops, creates, S5, reads or failed (`4xx`/`409`) requests; a fault injected after the write leaves neither change nor event; existing response/status/error assertions pass untouched; the migration applies from empty and over existing migrations.

## 5. Domain & Data Context
`OutboxEvent` after this slice: `id` uuid(v7), `eventType` string, `aggregateType` string, `aggregateId` uuid, `payload` Json, `status` (`PENDING|PROCESSING|SUCCESS|DEAD_LETTER`, default `PENDING`), **`publishAttemptCount`** int default 0 and **`executionAttemptCount`** int default 0 (replacing `attemptCount`), `availableAt` default now, **`publishedAt?`**, `processedAt?`, **`leaseExpiresAt?`**, **`errorClass?`**, **`lastError?`**, `createdAt`.
**Migration required** (the current schema types `OutboxEvent.status` with the shared enum `LifecycleStates { PENDING, FAILED, SUCCESS }`, which `AITriage.failureStatus` and `Notification.deliveryStatus` also use, and has a single `attemptCount`). Do **not** alter `LifecycleStates`. Create a dedicated enum `OutboxStatus { PENDING, PROCESSING, SUCCESS, DEAD_LETTER }` and move `OutboxEvent.status` to it (default `PENDING`; map any existing rows `PENDING→PENDING`, `SUCCESS→SUCCESS`, `FAILED→DEAD_LETTER`); replace `attemptCount` with the two counters; add the four columns; add indexes for the relay claim query (`status`, `availableAt`, `leaseExpiresAt`) and for retention (`status`, `processedAt`) — review before applying. The migration must apply from an empty database and over existing rows.

## 6. API Contract
None. No endpoint exists for outbox, queues, DLQ or notifications.

## 7. Authorization & Security
No HTTP surface. Redis must run with `noeviction` and AOF persistence (compose). Payloads and DLQ jobs contain ids only; `lastError` is sanitized (no secrets, tokens, payload bodies, prompts, stack traces). Least privilege for worker credentials.

## 8. Consistency & Concurrency
A producer's change and its outbox row commit atomically (the shared transaction is the guarantee). The relay claims with row locks and `SKIP LOCKED`, publishes outside the transaction, then updates with **conditional** statements (`WHERE id AND status AND lease matches`) so a stale relay cannot overwrite a row that was reclaimed. Publication and the database update are not atomic across PostgreSQL/Redis by design: duplicates are tolerated and consumers are idempotent. Worker `SUCCESS` updates are conditional on `status = PROCESSING`.

## 9. Async / Events / Workers
Topology: relay → queues `ai-triage`, `sla-escalation`, `notifications`, `postmortem`, `investigation` → processors registered by their slices; failures route to `dead-letter`. At-least-once; separate retry ownership per stage; limits from §4.9.

## 10. Failure & Recovery
Redis down: publication fails retryably, rows stay `PENDING` with backoff, API commits are unaffected, publication resumes when Redis returns. Redis wiped: `PROCESSING` rows time out and are republished; ephemeral state resets. Relay crash: claimed rows are reclaimed after the lease. Worker crash mid-job: BullMQ stalled-job recovery and the stale-`PROCESSING` pass. Poison payload: non-retryable → `DEAD_LETTER`. Producer rollback leaves no outbox row.

## 11. Implementation Surface
`src/infra/jobs` (queues, relay, stale-recovery pass, retention job, retry policy, classification, worker wrapper, DLQ publisher), outbox write function and catalog module (importable by producers), `src/workers` registration, re-drive CLI and its `package.json` script, configuration module, migration, compose Redis settings; and, for §4.11, `src/infra/audit/` (the minimal `appendAuditEvent`), the `AuditEventType` migration, and the T4/U4 (identity) and S4/S7 (AppService) controller/service code. Tests: unit (backoff schedule, classification, payload validation), integration (PostgreSQL + Redis).

## 12. Verification Requirements
- A rolled-back producer transaction leaves no outbox row; a committed one leaves exactly one, in `PENDING` with zero counters.
- Relay: claims and publishes once; two relays in parallel never double-claim; success → `PROCESSING` + `publishedAt` + lease; crash after claim → lease expiry → reclaimed; crash after publish before update → duplicate publication, single business effect (fake consumer + key).
- Publish failure with Redis down: stays `PENDING`, backoff, counter increments, **no maximum**, no dead-letter; recovers when Redis returns. Non-retryable publish error → `DEAD_LETTER`.
- Worker: success → `SUCCESS`; retryable errors retried up to 5 attempts with exponential backoff, then `DEAD_LETTER` with error class/last error/counters and a `dead-letter` job; non-retryable → immediate `DEAD_LETTER`; unknown error limited retry then dead-letter.
- Stale `PROCESSING` rows (Redis wiped, worker lost) are returned to `PENDING` and republished; consumer idempotent.
- Re-drive CLI validates and requeues a `DEAD_LETTER` row (counter reset, logged) and rejects non-`DEAD_LETTER`/invalid rows.
- Retention deletes `SUCCESS` rows past the window and never `DEAD_LETTER` rows.
- Retrofit (§4.11): the `AuditEventType` migration and `src/infra/audit` function exist; T4/U4/S4/S7 each write exactly one correct administrative event per effective change (deactivation vs other update; one event when both), atomically (rollback leaves none), actor = Admin, `incidentId = null`, metadata with ids and field names only; none for no-op requests, creates, reads, failed requests; existing SLICE-01/02 tests and response contracts unchanged.
- Missing configuration values fail startup; migration applies from empty and over existing rows; logs contain no secrets or payload bodies.

## 13. Completion Criteria
- Write contract, catalog, lifecycle (`PENDING/PROCESSING/SUCCESS/DEAD_LETTER`), relay, stale recovery, worker wrapper, DLQ, re-drive CLI and retention work as specified.
- The §4.11 audit retrofit is in place for T4, U4, S4 and S7 (with the minimal audit function and enum migration) without changing any other SLICE-01/02 behavior.
- Outbox migration applies cleanly (the shared `LifecycleStates` enum is untouched); Redis outage never loses or dead-letters work; recovery drains pending/stale rows; tests pass; typecheck/lint/format clean on touched files.
