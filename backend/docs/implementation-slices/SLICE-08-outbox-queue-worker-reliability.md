# SLICE-08 — `Transactional Outbox, Queue & Worker Reliability`

> **Authority:** Canonical documents remain authoritative; this is a derived implementation view.
> **Evidence tags:** `[C]` CANONICAL · `[D]` DERIVED · `[P]` PROPOSED · `[UDR-nn]` USER DECISION REQUIRED (see `00-INDEX`) · `[UNK]` UNKNOWN · `[N/A]` NOT APPLICABLE.
> **Sources:** `PRD` (Revised Draft, 19 Sep 2026) · `ARCH` (unversioned) · `DM` (unversioned) · `DBS` (unversioned, "proposed MVP Schema").

## 0. Slice Metadata

| Field | Value |
|---|---|
| Slice ID | `SLICE-08` |
| Capability | Outbox relay, BullMQ queues, retry/backoff/DLQ, idempotent-consumer foundation |
| Version | `0.1` (DRAFT) |
| Status | `PLANNED` (DESIGN / PRE-IMPLEMENTATION) |
| MVP | `YES` (PRD §15 "Safe repeated asynchronous job processing", "Retry with exponential backoff and DLQ") |
| Created / Last Updated | `2026-10-01` / `2026-10-01` |
| Primary Owner / Module | Cross-cutting async infrastructure; ARCH names no owning module [UNK] |

### Canonical Sources
- `PRD.md` — FR-025, FR-031, FR-034; BR-010, BR-062; RD-023, RD-024; NFR-001, NFR-003, NFR-008, NFR-009; §14 Failure Expectations + Retry Policy; §15; AC-026, AC-027, AC-042
- `Domain_Model.md` — "Required notification events have an atomic outbox record"
- `Architecture.md` — Async flow; Flows (Asynchronous, Failure/retry boundary); ADR-005, ADR-006, ADR-008, ADR-009, ADR-014; Deployment model; DB Connection Strategy
- `DB_Schema.md` — `OutboxEvent`
- `API_Contracts.md` — NOT AVAILABLE · `DESIGN_CHECKS.md` — NOT PROVIDED

### Related Slices
- Producers (insert outbox rows in their tx): `SLICE-04`, `05`, `07`, `11`, `12` · Consumers/workers: `07`, `09`, `10`, `11`, `12`

---

# 1. Capability Overview
## 1.1 Problem
A state change and the async work it implies must never diverge, yet queues cannot join a database transaction. [C: ADR-009 context]
## 1.2 Purpose
Own the durable DB→queue handoff (outbox table + relay), the BullMQ/Redis queue infrastructure, bounded retry with exponential backoff, DLQ/failure state, and the shared pattern that makes consumers idempotent under at-least-once delivery. [C: ADR-009, 006, 014, PRD §14]
## 1.3 Behavior
Producers insert an `OutboxEvent` in their transaction. A relay later publishes pending rows to BullMQ; workers process jobs, retry retryable failures with backoff, and park exhausted jobs in a DLQ/failure state, all observably.
## 1.4 End-to-End Summary
```text
Producer tx commits (state + audit + OutboxEvent PENDING)
   ↓
Relay claims PENDING rows (availableAt ≤ now)        [mechanism UNK]
   ↓
Publish job to BullMQ (Redis)
   ↓
Worker dequeues → idempotent business effect → writes result via owning module's repository
   ↓
Mark outbox processed  |  failure → retry w/ exponential backoff → DLQ / failure state
```

---

# 2. Scope
## 2.1 In Scope
`OutboxEvent` lifecycle; relay/publisher; queue + worker infrastructure; retry classification (retryable vs non-retryable); DLQ/failure representation; worker-side idempotency guidance; job-failure/retry observability.
## 2.2 Out of Scope
Business logic of each worker (07, 09, 10, 11, 12); the decision *what* events exist (catalog, UDR-12); LLM/email providers.
## 2.3 MVP Scope
One Redis, one queue technology (BullMQ), single deployable + multi-worker process [C ARCH Deployment model].
## 2.4 Future Scope
Independent worker scaling; other queue tech (ADR-006 alternatives).

---

# 3. Requirement Traceability
| ID | Type | Source | Version | Requirement | Class |
|---|---|---|---|---|---|
| FR-025 | Functional | PRD §6 | PRD-RD | "Notification processing is asynchronous, retryable, and safe to repeat." | C |
| FR-031 | Functional | PRD §6 | PRD-RD | "Repeated execution of the same asynchronous job must not create duplicate business actions." | C |
| FR-034 | Functional | PRD §6 | PRD-RD | "The system records structured logs, correlation IDs, job failures, retry information, and escalation outcomes." | C |
| BR-010 | Business | PRD §7 | PRD-RD | "Repeated asynchronous processing must not create duplicate business actions." (Enforcement: "Idempotency checks and database constraints"; failure: "Duplicate execution is safely ignored or rejected") | C |
| BR-062 | Business | PRD §7 | PRD-RD | "Notification jobs are retryable." (failure: "Exhausted jobs enter failure state") | C |
| RD-023 | Decision | PRD §17 | PRD-RD | "Idempotency is required at alert ingestion, queue processing, notification processing, and postmortem generation boundaries." | C |
| RD-024 | Decision | PRD §17 | PRD-RD | "Retry behavior uses exponential backoff with bounded attempts and DLQ/failure handling." — "Detailed retry implementation belongs in engineering design." | C |
| NFR-001 | NFR | PRD §13 | PRD-RD | "No accepted incident state change should be silently lost." | C |
| NFR-009 | NFR | PRD §13 | PRD-RD | "Retryable asynchronous failures must use bounded retry behavior and ultimately be represented in a dead-letter/failure state when retries are exhausted." | C |
| PRD §14 Retry Policy | Failure | PRD §14 | PRD-RD | "Exponential backoff. Bounded retry attempts. DLQ/failure state after retry exhaustion. Retryable and non-retryable failure classification. Observable retry/failure metadata. Safe repeated job processing." | C |
| AC-026 / AC-027 | Acceptance | PRD §20 | PRD-RD | "Failed notification attempts are recorded and retried with exponential backoff." · "Exhausted notification retries are represented in a DLQ/failure state and remain observable." | C |
| AC-042 | Acceptance | PRD §20 | PRD-RD | "Structured logs, correlation IDs, retry information, job failures, and escalation outcomes are available for operational debugging." | C |
| ADR-009 | Decision | ARCH | unv. | "Persist the business state change and an outbox event in the same PostgreSQL transaction." Trade-offs: "duplicate delivery remains possible, consumers must be idempotent." | C |
| ADR-014 | Decision | ARCH | unv. | "Use at-least-once job delivery/processing semantics. Workers and business operations must be idempotent so that retries or duplicate delivery do not create duplicate business effects." | C |
| ADR-006 / 005 | Decision | ARCH | unv. | BullMQ with Redis; Redis for cache, rate limiting, worker store; "Redis failure must be handled separately for cache, rate limiting and queue processing." | C |
| ADR-008 | Decision | ARCH | unv. | "Async notification retries with exponential backoff and DLQ after retry exhaustion." — "On failure limit, they need to be manually retried using DLQ." | C (notification-specific; generalization UDR-22) |
| §14 DB row | Failure | PRD §14 | PRD-RD | "Failed transaction rolls back the associated state change and audit event." | C |

---

# 4. Business Rules
## Outbox rule (ADR-009 / DM)
- **Canonical Rule:** "Persist the business state change and an outbox event in the same PostgreSQL transaction." (DM: "Required notification events have an atomic outbox record.")
- **Interpretation:** every producer inserts outbox rows inside the same tx; no producer calls `queue.add` directly after commit. **Tension:** ARCH "Asynchronous flow: Service commits a state change -> publishes a job" can be read as direct publish; ADR-009 mandates outbox [D, SD-04 → UDR-22].
- **Consequence:** row exists iff the business change committed. **Invalid:** publishing before commit; state change committed with no outbox row for a required event. **Class:** C.

## At-least-once + idempotent consumers (ADR-014, BR-010, FR-031)
- **Interpretation:** duplicates *will* happen (relay re-publish after crash, BullMQ retry, redelivery); each consumer must make its business effect idempotent by identity + DB constraint. **Consequence:** every job carries a stable identity (e.g., outbox event id) [P]; consumers record effect with unique keys. **Invalid:** a retry producing a second notification/escalation/postmortem/investigation. **Class:** C.

## Retry policy (RD-024, NFR-009, PRD §14)
- **Canonical:** exponential backoff, bounded attempts, DLQ/failure state, retryable/non-retryable classification, observable metadata. **Not defined:** attempt counts, base delay, jitter, classification table, DLQ tooling [UDR-22]. **Class:** C (shape) / UNK (parameters).

## Failure isolation (ARCH Failure/retry boundary)
- **Canonical:** "All external calls (email provider, LLM provider) happen only inside the worker, never inline in an HTTP request." → relay and workers are the only places for provider calls. **Class:** C.

---

# 5. Functional Behavior
**5.1 Outbox write (producer contract)** — `enqueueOutbox(tx, {eventType, aggregateType, aggregateId, payload, availableAt?})`; must run on the producer's transaction handle. Event catalog [UDR-12].
**5.2 Relay/publish** — Trigger: periodic/notify [UNK]. Processing: claim `PENDING` rows with `availableAt ≤ now`, publish to the proper queue, mark processed (`processedAt`) or bump `attemptCount`/`availableAt` on publish failure. Concurrency among relays: [P: `FOR UPDATE SKIP LOCKED`; not canonical]. State values: `status` is free text default `'PENDING'`, no CHECK [D, UDR-22].
**5.3 Worker execution** — dequeue → classify → run idempotent handler → success ack; failure → backoff retry up to max; exhausted → DLQ/failure state + observable record.
**5.4 DLQ handling** — exhausted jobs retained and inspectable; manual re-drive [C ADR-008, notification]; tooling/endpoint [UNK].
**5.5 Queue/worker topology** — queues named for AI triage, notifications, SLA/escalation, postmortem (+ investigation) [C ARCH async flow; investigation implied by BR-077/ADR-012 style, D]; concurrency/limits [UNK].

---

# 6. Acceptance Criteria
- **AC-026 / AC-027** (generic part) — *Given* handler failure · *Then* retried with exponential backoff, then DLQ/failure state, observable. *Verify:* failing handler stub with injected clock; assert attempt timeline and final DLQ record.
- **AC-042** — logs include correlation id, attempt, failure. *Verify:* log-capture test.
- **NFR-001 / ADR-009** — *Given* producer tx rollback · *Then* no outbox row; *Given* commit then relay crash · *Then* row still PENDING and later published. *Verify:* failure injection at each step.
- **FR-031 / BR-010 / AC-024 / AC-028 / AC-032 / AC-053** — duplicate delivery ⇒ one business effect (per consumer slice). *Verify:* deliver same job twice/concurrently.
- No canonical AC exists for outbox relay behavior itself → coverage gap.

---

# 7. Domain Model
## 7.1 Entities
| Entity | Role |
|---|---|
| OutboxEvent | Durable handoff record (aggregate type/id, payload, status, attempts, availability, processed time) |
| Job (BullMQ) | Redis-resident work item (not a domain entity) |
## 7.2 Relationships — `aggregateId` is a bare uuid (no FK) [D]; ties to Incident/other aggregates logically.
## 7.3 Invariants
| Invariant | Enforcement |
|---|---|
| Outbox row ⇔ committed business change | Transaction |
| `status` domain | **Unclear** (no CHECK) |
| One outbox event published at most once *effect* | Consumer idempotency |
## 7.4 State Machine (outbox row) — `PENDING → processed(processedAt set)`; failure states and names [UDR-22]; owned here.

---

# 8. Architectural Context
## 8.1 Relevant Architecture — Async flow: `Outbox → BullMQ → Workers (AI triage, notifications, SLA/escalation, postmortem)`. Overall flow diagram: "COMMIT → BullMQ". "Workers dequeue from Redis → call external provider → writes result back through owning module's repository."
## 8.2 Components
| Component | Responsibility |
|---|---|
| Outbox writer | in-tx insert helper |
| Relay/publisher | claim + publish + mark |
| Queue (BullMQ/Redis) | durable job store, delayed jobs, retries |
| Workers | per-queue processors |
| DLQ | failed-job store |
## 8.3 Constraints — API & workers use the Supabase transaction pooler (port 6543): no session-level features (advisory locks, LISTEN/NOTIFY) [C ARCH DB strategy → D: constrains relay design]; app Pool 5–10/instance [C]; modules own tables logically — workers write via the owning module's repository [C].
## 8.4 ADRs — **ADR-009**, **ADR-014** (core); **ADR-006**, **ADR-005** (Redis dependency); **ADR-008** (notification retry/DLQ); **ADR-001** (single deployable with worker processes).

---

# 9. Dependency Model
## 9.1 Upstream
| Slice | Type | Requires |
|---|---|---|
| — | INFRA | Postgres, Redis |
## 9.2 Downstream
| Slice | Relationship | Provides |
|---|---|---|
| 04, 05, 07, 11, 12 | IN-TX CALL | `enqueueOutbox` |
| 07, 09, 10, 11, 12 | RUNTIME | queues/workers, retry, DLQ |
## 9.3 Contract
**Allowed:** outbox writer; handler registration; retry/DLQ helpers. **Forbidden:** producers publishing straight to BullMQ; handlers calling providers inline in HTTP; handlers mutating other modules' tables directly.

---

# 10. Slice Coupling Analysis
## 10.1 Transactional — **YES (contractual)** with every producer: outbox insert must share their tx. Boundary: SEPARATE slice, narrow in-tx function.
## 10.2 Synchronous — No (relay is async).
## 10.3 Shared Invariants — "State change ⇒ outbox event" is guaranteed by producer's tx; "outbox ⇒ eventually published" by this slice. Ownership split explicit [D].
## 10.4 Summary
| Related Slice | Coupling | Strength | Boundary Decision |
|---|---|---|---|
| 04, 05, 07, 11, 12 | in-tx insert | Medium | SEPARATE (contract) |
| 07, 09, 10, 11, 12 | queue runtime | Loose | SEPARATE |
### Boundary Decision
Infrastructure with a single narrow contract; embedding it in each producer would duplicate retry/DLQ logic and blur ownership of "who retries".

---

# 11. Data Model
## 11.1 Tables — `OutboxEvent`.
## 11.2 Fields
| Field | Purpose | Required? |
|---|---|---|
| `eventType`, `aggregateType`, `aggregateId` | routing/identity | Yes |
| `payload jsonb` | job data | Yes |
| `status` text default 'PENDING' | relay state | Yes (no CHECK) |
| `attemptCount int` | publish attempts | Yes (default 0) |
| `availableAt` | delayed availability/backoff | Yes (default now()) |
| `processedAt` | published time | No |
## 11.3 Constraints — PK only; no index in DBS.
## 11.4 DB Invariants — none beyond NOT NULLs.
## 11.5 Migration Requirements [P/UDR-22] — partial index on `(availableAt) WHERE status='PENDING'`; CHECK on status; unique event identity for dedupe (e.g., per aggregate+type+discriminator) so producers can't double-insert; retention/cleanup of processed rows; failed-publish state.

---

# 12. Transaction & Consistency Model
## 12.1 Boundary
```text
Producer tx:   BEGIN … INSERT OutboxEvent … COMMIT              [C]
Relay:         claim rows → publish → UPDATE status/processedAt  [P: separate short tx]
Worker:        handler effect + idempotency record in one tx     [D]
```
## 12.2 Atomic — producer: state+audit+outbox [C ADR-010/009]; relay: not atomic with Redis (publish then mark → duplicates possible [C ADR-009]).
## 12.3 Locking — relay concurrency control [P: row locks with skip-locked; pooler-safe since row locks are transactional].
## 12.4 Guarantees — no lost handoff (NFR-001); duplicates possible (ADR-009).
## 12.5 Failure — publish fails ⇒ row stays PENDING with bumped `availableAt`; Redis down ⇒ rows accumulate [UDR-21].

---

# 13. Idempotency & Concurrency
## 13.1 Idempotency — **Identity:** outbox event id → job id [P]. **Duplicate publish:** BullMQ jobId dedupe may collapse duplicates *while the job exists* [D, behavior to verify]; not sufficient alone. **Replay:** consumer's own idempotency (per slice). **Side-effect protection:** DB unique keys at the effect (notification idempotencyKey, postmortem per incident, escalation level…).
## 13.2 Concurrency
| Race | Protection | Expected | Test |
|---|---|---|---|
| two relays claim same row | row lock/skip-locked [P] | one claims | parallel relay test |
| relay crash after publish before mark | re-publish | duplicate job, single effect | kill-after-publish test |
| worker crash mid-handler | queue retry | re-run safe | kill test |

---

# 14. API Surface — Preliminary
`PRELIMINARY — API CONTRACT NOT YET FROZEN`
| Candidate operation | Actor / Authz | Input | Domain action | Output | Failures | Idempotency | Confidence · Missing |
|---|---|---|---|---|---|---|---|
| (none required externally) | — | — | — | — | — | — | High that no *user* API is mandated |
| Inspect/re-drive DLQ (ops) | ADMIN? | job id | requeue | status | 403/404 | idempotent re-drive | Low · ADR-008 says "manually retried using DLQ" — interface (CLI vs API) UNK [UDR-22] |
| Health/metrics | ops | — | read | — | — | — | Low · [UNK] |

---

# 15. Events, Queues & Side Effects
## 15.1 Events Produced — none own; routes others'.
## 15.2 Events Consumed — outbox rows.
## 15.3 Queue Jobs
| Job | Queue | Worker | Retry |
|---|---|---|---|
| AI triage | [UNK name] | 10 | [UDR-22] |
| Notification | " | 09 | exponential backoff + DLQ [C ADR-008] |
| SLA/escalation | " | 07 | [UDR-22] |
| Postmortem generation | " | 11 | bounded; failure state [C BR-071] |
| Investigation | " | 12 | [UDR-22] |
## 15.4 Delivery Semantics — at-least-once; idempotent consumers; bounded retry; DLQ [C].
## 15.5 External Side Effects — none directly.

---

# 16. Security & Authorization
Workers/DB users get least privilege [C §12.13]. Payloads in outbox/queue must not carry secrets; keep IDs, not content [P]. Redis access authenticated/TLS [P]. No user authorization surface except DLQ tooling [UNK].

---

# 17. Failure Modes
| Failure | Detection | Expected | State Impact | Retry? | Evidence |
|---|---|---|---|---|---|
| Producer tx rollback | DB | no outbox row | none | caller | PRD §14 |
| Redis down at relay | publish error | rows stay PENDING | delayed async work | yes | ADR-005 (UDR-21) |
| Relay crash post-publish | restart | re-publish | dup job | n/a | ADR-009 |
| Handler failure retryable | classify | backoff retry | none | yes | RD-024 |
| Non-retryable failure | classify | straight to failure state | none | no | PRD §14 |
| Retries exhausted | attempt count | DLQ/failure state; observable | none | manual | NFR-009 |
| Poison payload | repeated failure | DLQ | none | manual | [D] |
## Critical Failure Scenario
**What fails:** Redis lost entirely. **Must remain true:** no committed state change loses its handoff (PostgreSQL remains source of truth, ADR-005). **Recovery:** relay re-publishes PENDING rows once Redis returns [D]; jobs only in Redis (delayed SLA jobs, if used) would be lost → UDR-13/21.

---

# 18. Observability
Logs: relay claim/publish/mark, job start/finish/fail with attempt + correlation id [C FR-034]. Metrics [P]: outbox backlog age/size, publish failures, queue depth, retries, DLQ size. Audit: none (infrastructure). Correlation ID stored in outbox payload to propagate into worker logs [P].

---

# 19. Testing Strategy
- **Unit:** retry classification; backoff schedule; payload validation.
- **Integration:** in-tx outbox insert/rollback; relay claim/mark; Redis integration.
- **API:** `BLOCKED — API CONTRACT NOT YET FROZEN` (only if DLQ API chosen).
- **Authorization:** DLQ re-drive restricted [if exposed].
- **Concurrency:** two relays; two workers on same job.
- **Idempotency:** duplicate publish; duplicate delivery to a stub consumer.
- **Failure injection:** kill relay mid-batch; Redis down; handler throws N times; DB down during mark.
- **Regression:** each consumer's idempotency test re-run when infra changes.

---

# 20. Test ↔ Requirement Traceability
| Requirement | AC | Test(s) | Status |
|---|---|---|---|
| ADR-009 / NFR-001 | (none canonical) | outbox atomicity & recovery | NOT RUN |
| RD-024 / NFR-009 | AC-026, AC-027 | backoff + DLQ | NOT RUN |
| BR-010 / FR-031 | AC-024/028/032/053 | duplicate delivery | NOT RUN |
| FR-034 | AC-042 | log fields | NOT RUN |
### Coverage Gaps
- No AC for relay/outbox; no AC for non-notification DLQ; no AC for Redis-outage behavior.

---

# 21. Implementation Plan
## 21.1 Sequence
1. Decide UDR-12, 21, 22. 2. Outbox model/helper (needed early by 04/05). 3. Queue/worker bootstrap. 4. Relay. 5. Retry/DLQ wrapper. 6. Observability hooks. 7. Failure-injection suite.
## 21.2 Files
### CREATE
```text
src/outbox/** · src/queue/** · src/workers/** (bootstrap only) · test/outbox/**
```
### MODIFY — `prisma/schema.prisma` (OutboxEvent); app/worker entrypoints.
### REVIEW ONLY — ARCH ADR-006/009/014; PRD §14.
## 21.3 Allowed — outbox/queue infra. ## 21.4 Forbidden — business logic in relay; direct provider calls in HTTP path; queue publish bypassing outbox. ## 21.5 Must exist — Postgres, Redis, config.

---

# 22. AI Agent Context
## 22.1 Read First
1. `AGENTS.md` 2. This slice 3. `PROJECT_STATE.md` 4. `TEST_STATUS.md` 5. `SESSION_CHECKPOINT.md` 6. ARCH ADR-009/014/006 7. DBS `OutboxEvent`
## 22.2 Relevant Canonical Context
| Topic | Source | Location |
|---|---|---|
| Requirement | PRD | §14, FR-025/031/034, NFR-009 |
| Domain | DM | Notification outbox invariant |
| Architecture | ARCH | Async flow, ADR-005/006/008/009/014 |
| Database | DBS | `OutboxEvent` |
| API | — | not frozen |
## 22.3 Agent Objective
Deliver the in-tx outbox contract first, then relay, queues, retry/DLQ, observability; do not choose retry numbers or relay mechanism without UDR-22.

## 22.4 Agent Constraints

- Preserve established architecture (modular monolith, ADR-001; module boundaries per Architecture.md).
- Do not redesign unrelated areas. Do not introduce unapproved dependencies.
- Section 14 is PRELIMINARY — do not treat any endpoint, field name, or status code as frozen.
- Preserve transaction boundaries and security boundaries stated as [C]/[D]; never resolve a `[UDR-nn]` item silently — stop and ask the human.
- Add required tests. Report assumptions and limitations. Never claim tests ran without execution evidence.

## 22.5 Agent Output Requirements

The agent must report: files created; files modified; important decisions; assumptions; tests generated; tests actually run (with output evidence); known failures; known limitations; next step.

---

# 23. Learning Objectives
## 23.1 MUST UNDERSTAND
- Dual-write problem and why outbox solves it.
- At-least-once delivery ⇒ idempotent consumers (and where duplicates originate).
- Exponential backoff, retryable vs non-retryable, DLQ.
## 23.2 SHOULD UNDERSTAND
- Relay claiming (`SKIP LOCKED`) and pooler constraints; BullMQ delayed jobs/job IDs.
## 23.3 CAN DEFER — queue sharding, worker autoscaling.
## 23.4 Mental Model
The outbox is a postbox inside the database: you write the letter in the same moment you change the world; a courier (relay) delivers it later, possibly twice, so every recipient must tolerate repeats.
## 23.5 First-Principles Questions
1. Why not publish to the queue inside the request? 2. Why not exactly-once? 3. What breaks if relay marks processed before publishing? 4. Why is Postgres the source of truth over Redis? 5. What does DLQ buy you?
## 23.6 Interview Questions
### Design
1. Explain the transactional outbox and its failure windows.
### Debugging
1. A notification went out twice — trace the cause.
### Failure Handling
1. Redis was wiped — what is lost and what recovers?
### Architecture
1. Outbox + BullMQ vs only BullMQ — trade-offs?

---

# 24. Verification Checklist

## Functional
- [ ] Functional requirements satisfied
- [ ] Business rules satisfied
- [ ] Acceptance criteria pass

## Security
- [ ] Authentication verified
- [ ] Authorization verified
- [ ] Resource/tenant/team isolation verified

## Data / Consistency
- [ ] Database constraints verified
- [ ] Transaction boundary verified
- [ ] Consistency guarantees verified

## Reliability
- [ ] Idempotency verified
- [ ] Concurrency verified
- [ ] Retry behavior verified
- [ ] Failure behavior verified

## Testing
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] API tests pass (BLOCKED — API CONTRACT NOT YET FROZEN)
- [ ] Negative tests pass
- [ ] Concurrency tests pass where applicable
- [ ] Failure-injection tests pass where applicable

## Engineering
- [ ] No unrelated changes
- [ ] Documentation updated
- [ ] Important design decisions understood
- [ ] Capability can be explained without the AI agent

## Slice-specific
- [ ] Rollback leaves no outbox row; commit-then-crash leaves a publishable row
- [ ] Duplicate delivery to a consumer causes exactly one effect
- [ ] UDR-12, 21, 22 decided

---

# 25. Current Implementation Status

**Status:** `PLANNED` — DESIGN / PRE-IMPLEMENTATION (no implementation claimed)

### Completed
- None.

### In Progress
- None.

### Remaining
- Entire slice (outbox contract is on the critical path for SLICE-04/05)

### Known Defects
- None recorded (nothing implemented).

### Known Limitations
- See Section 27 and the open `[UDR-nn]` items referenced in this slice.

### Test Status
`NOT RUN`

### Last Verified
N/A

---

# 26. Change History

| Version | Date | Change | Reason | Canonical IDs Affected | Implementation Impact |
|---|---|---|---|---|---|
| `0.1` | `2026-10-01` | Initial slice (`DRAFT`) | Initial capability extraction from canonical IMS design | All IDs in §3 | None (pre-implementation) |

## Change Protocol

When a canonical requirement changes: (1) identify affected requirement IDs; (2) search all slices referencing those IDs; (3) decide whether each slice is affected; (4) update affected slice specifications; (5) update implementation/tests where required; (6) record the change here; (7) run regression verification.

---

# 27. Future Evolution

## Likely Extensions
Separate worker deployments; other queue tech.
## Extension Points
Handler registry; relay strategy.
## Known Limitations
No relay/status model in DBS; retry parameters unspecified.
## Deliberately Not Generalized
No exactly-once; no event sourcing.
## Potential Breaking Changes
Changing outbox payload schema or job identity affects all consumers.

---

# Slice Exit Criteria

The slice is implemented only when:

- [ ] Required behavior works.
- [ ] Relevant acceptance criteria pass.
- [ ] Required tests pass.
- [ ] Security/authorization is verified.
- [ ] Transaction/consistency behavior is verified.
- [ ] Concurrency/idempotency behavior is verified where applicable.
- [ ] Failure behavior is tested where applicable.
- [ ] No unresolved design contradiction remains (all `[UDR-nn]` items referenced here are decided and recorded in canonical docs).
- [ ] Requirement-to-test traceability is updated.
- [ ] Implementation status is updated.
- [ ] The developer can explain the capability, design decisions, failure modes, and tests without relying on the AI agent.
- [ ] Failure-injection suite (relay crash, Redis down, handler exhaustion) green.

---

# Slice Boundary Review

Human review status: **NOT YET REVIEWED** (boxes intentionally unchecked — see `00-INDEX` → Human Design Review).

- [ ] It represents one coherent capability.
- [ ] It does not artificially split a transactional boundary.
- [ ] It does not require another slice's internal implementation.
- [ ] Shared invariants have a clear owner.
- [ ] Dependencies are explicit.
- [ ] The slice can span multiple implementation sessions.
- [ ] It can be meaningfully tested.
- [ ] It can evolve without unnecessary changes to unrelated slices.
