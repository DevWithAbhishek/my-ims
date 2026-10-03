# SLICE-09 — `Notification Delivery`

> **Authority:** Canonical documents remain authoritative; this is a derived implementation view.
> **Evidence tags:** `[C]` CANONICAL · `[D]` DERIVED · `[P]` PROPOSED · `[UDR-nn]` USER DECISION REQUIRED (see `00-INDEX`) · `[UNK]` UNKNOWN · `[N/A]` NOT APPLICABLE.
> **Sources:** `PRD` (Revised Draft, 19 Sep 2026) · `ARCH` (unversioned) · `DM` (unversioned) · `DBS` (unversioned, "proposed MVP Schema").

## 0. Slice Metadata

| Field | Value |
|---|---|
| Slice ID | `SLICE-09` |
| Capability | Asynchronous, retryable, idempotent email notification to assigned engineer and Team Lead |
| Version | `0.1` (DRAFT) |
| Status | `PLANNED` (DESIGN / PRE-IMPLEMENTATION) |
| MVP | `YES` |
| Created / Last Updated | `2026-10-01` / `2026-10-01` |
| Primary Owner / Module | `Notifications` (ARCH: "Notification records and delivery") |

### Canonical Sources
- `PRD.md` — FR-024, FR-025, FR-032; BR-060–BR-064; RD-017; §9 Notification; §10 Email provider; §14; AC-025–AC-028; OQ-005
- `Domain_Model.md` — Incident→Notification 0..N; Notification row ("Required notification events have an atomic outbox record")
- `Architecture.md` — Notification Flow; ADR-008, ADR-009, ADR-014; Failure/retry boundary
- `DB_Schema.md` — `Notification`, `idx_notification_incident_status`, `OutboxEvent`
- `API_Contracts.md` — NOT AVAILABLE · `DESIGN_CHECKS.md` — NOT PROVIDED

### Related Slices
- `SLICE-05`, `07`, `04`, `11` produce notification-triggering events · `SLICE-08` queue/retry/DLQ · `SLICE-06` audit (`NOTIFIED`) · `SLICE-01` recipient lookup

---

# 1. Capability Overview
## 1.1 Problem
Stakeholders learn an incident needs attention first through notifications; delivery must not block incident work and must not spam. [C: ADR-008 context]
## 1.2 Purpose
Own `Notification` records and email delivery: consume notification events, resolve recipients, send via the email provider from a worker, record attempts/outcomes, retry with backoff, park exhausted ones. [C: ARCH Module Responsibilities]
## 1.3 Behavior
After a transition/assignment/SLA/escalation event commits, a notification job eventually emails the assigned engineer and Team Lead; failures retry; repeated execution never sends unintended duplicates.
## 1.4 End-to-End Summary
```text
Outbox event (from producer tx)
   ↓ relay → queue
Worker: resolve recipients → get/create Notification (idempotencyKey)
   ↓
Send via email provider (worker only)
   ↓
Record attempt (count, time, providerResponse) → SUCCESS | retry (backoff) | FAILED/DLQ
   ↓
Audit NOTIFIED / NOTIFICATION_SENT (UDR-05)
```

---

# 2. Scope
## 2.1 In Scope
Notification record lifecycle; recipient resolution; email send; attempt tracking; retry/backoff/DLQ behavior for notification jobs; idempotency; delivery audit.
## 2.2 Out of Scope
Deciding *which* domain events notify (producers + catalog UDR-14); other channels, real-time push, status page, ChatOps [C: PRD §4]; in-app notification feed [UNK].
## 2.3 MVP Scope
Email only, to assigned engineer + Team Lead [C RD-017].
## 2.4 Future Scope
Multi-channel + fallback chains; real-time [C PRD §16].

---

# 3. Requirement Traceability
| ID | Type | Source | Version | Requirement | Class |
|---|---|---|---|---|---|
| FR-024 | Functional | PRD §6 | PRD-RD | "The system sends relevant incident notifications to the assigned engineer and Team Lead." | C |
| FR-025 | Functional | PRD §6 | PRD-RD | "Notification processing is asynchronous, retryable, and safe to repeat." | C |
| FR-032 | Functional | PRD §6 | PRD-RD | "Repeated execution of notification jobs must not create unintended duplicate notification actions." | C |
| BR-060 | Business | PRD §7 | PRD-RD | "Relevant incident notifications are sent to the assigned engineer and Team Lead." (failure: "Delivery failure is retried") | C |
| BR-061 | Business | PRD §7 | PRD-RD | "Notification delivery is asynchronous." (failure: "Business action is not blocked") | C |
| BR-062 | Business | PRD §7 | PRD-RD | "Notification jobs are retryable." (failure: "Exhausted jobs enter failure state") | C |
| BR-063 | Business | PRD §7 | PRD-RD | "Notification attempts and outcomes are recorded." (failure: "Delivery history remains available") | C |
| BR-064 | Business | PRD §7 | PRD-RD | "Repeated notification job execution must be safely handled." (Enforcement: "Idempotency key and database checks"; failure: "No unintended duplicate notification action") | C |
| RD-017 | Decision | PRD §17 | PRD-RD | "Notifications are sent to the assigned engineer and Team Lead." — "Exact notification events remain configurable." | C |
| AC-025 | Acceptance | PRD §20 | PRD-RD | "Notifications are sent to the assigned engineer and Team Lead for defined notification events." | C |
| AC-026 | Acceptance | PRD §20 | PRD-RD | "Failed notification attempts are recorded and retried with exponential backoff." | C |
| AC-027 | Acceptance | PRD §20 | PRD-RD | "Exhausted notification retries are represented in a DLQ/failure state and remain observable." | C |
| AC-028 | Acceptance | PRD §20 | PRD-RD | "Repeated notification-job execution does not create unintended duplicate notification actions." | C |
| §9 Notification | Data | PRD §9 | PRD-RD | "Notification ID; Incident ID; Recipient; Notification type; Delivery status; Attempt count; Last attempt timestamp; Provider response/error information; Idempotency key/reference" | C |
| §10 | Integration | PRD §10 | PRD-RD | Email provider: "Asynchronous, retryable, and safe to repeat" | C |
| ADR-008 | Decision | ARCH | unv. | "Async notification retries with exponential backoff and DLQ after retry exhaustion." — "On failure limit, they need to be manually retried using DLQ." | C |
| OQ-005 | Open Q | PRD §18 | PRD-RD | "What exact notification events should trigger email to the assigned engineer and Team Lead?" | UNK |
| DM-Notification | Domain | DM | unv. | "Required notification events have an atomic outbox record." | C |

---

# 4. Business Rules
## BR-060 — Recipients: assigned engineer and Team Lead
- **Canonical Rule:** "Relevant incident notifications are sent to the assigned engineer and Team Lead."
- **Interpretation:** recipients = `Incident.currentAssignee` + the Team Lead [D: which lead — assignee's `leadId`, or the team's TEAM_LEAD users, or escalation-policy `level3`? UNK]. If no assignee (OPEN, unassigned): recipients? UNK. Escalation notifications go to "responder and Team Lead" (UC-006) / "next configured responder" (BR-041) → recipient set varies by event [UDR-14].
- **Consequence:** recipient resolution is event-specific and performed in the worker [P: at send time vs at enqueue time → UDR-14].
- **Invalid:** sending to users outside the incident's team [D from BR-004]; deactivated recipients [UNK]. **Class:** C/UDR.

## BR-061 / ARCH failure boundary — Async only
- **Rule:** delivery is async; no email call in the request path. **Consequence:** producers only insert outbox rows. **Class:** C.

## BR-062 / BR-063 — Retry and recording
- **Rules:** jobs retryable; exhausted → failure state; attempts/outcomes recorded. **Consequence:** `attemptCount`, `lastAttemptTimestamp`, `providerResponse`, `deliveryStatus` updated per attempt. Parameters UDR-22. **Class:** C.

## BR-064 / FR-032 — Idempotent notification
- **Rule:** repeated execution safe; **Enforcement:** "Idempotency key and database checks". **Consequence:** `idempotencyKey UNIQUE` is the arbiter; key derivation (e.g., event id + recipient) [P/UDR-14]. **Residual risk:** crash after provider accepted but before recording `SUCCESS` ⇒ resend on retry — unavoidable with at-least-once unless the provider supports idempotency keys [D, UDR-14]. **Invalid:** two notifications for the same (event, recipient). **Class:** C (rule) / UNK (mechanism).

## DM invariant — outbox atomicity
- "Required notification events have an atomic outbox record." → the *producer's* tx writes the outbox row (see 05/07/04/11). Creation of the `Notification` row itself happens in the worker [P]; DM's wording ("Notifications" as owner) leaves open whether the row is created in the producer tx [UDR-14].

---

# 5. Functional Behavior
**5.1 Process notification event** — Trigger: queue job from outbox. Input: event (incidentId, event kind, actor, ids). Preconditions: incident exists. Processing: resolve recipients → derive idempotency key(s) → insert/lookup `Notification` (`PENDING`) → send email → on success set `SUCCESS`, `attemptCount`, `lastAttemptTimestamp`, `providerResponse`; on failure record attempt and rethrow for retry. State change: `PENDING → SUCCESS | FAILED`. Output: record + audit.
**5.2 Retry** — queue-level exponential backoff [C]; each attempt recorded [C BR-063].
**5.3 Exhaustion** — final failure ⇒ `deliveryStatus=FAILED` [D: the only non-success terminal value in DBS] + DLQ in queue [C ADR-008]; observable.
**5.4 Manual re-drive** — "manually retried using DLQ" [C ADR-008]; mechanism [UDR-22]; a re-drive must reuse the same `Notification`/key to stay idempotent [D].
**5.5 Audit** — `NOTIFIED`/`NOTIFICATION_SENT` event on success [C events list; name UDR-05]; whether failure is audited [UNK].
**5.6 Notification type** — `INFO/WARNING/ALERT` mapping per event [UNK → UDR-14] (e.g., SLA warning → WARNING is only a suggestion, P).

---

# 6. Acceptance Criteria
- **AC-025** — *Given* a defined notification event · *Then* assigned engineer and Team Lead receive email. *Verify:* fake email provider; assert recipients per event.
- **AC-026** — provider fails twice then succeeds ⇒ 3 recorded attempts with increasing delays. *Verify:* controllable provider stub + clock.
- **AC-027** — provider always fails ⇒ `FAILED` + DLQ; observable. *Verify:* exhaustion test.
- **AC-028** — same job executed twice/concurrently ⇒ one `Notification` and one provider send per (event, recipient). *Verify:* concurrent duplicate test; provider call count.
- **BR-061** — email provider hang/outage does not block the originating API call. *Verify:* provider down during resolve/ack API test.

---

# 7. Domain Model
## 7.1 Entities
| Entity | Role |
|---|---|
| Notification | Delivery record per incident event |
| Incident | subject |
| User | recipients |
## 7.2 Relationships — Incident→Notification 0..N [C]; `recipients uuid[]` (no FK) [DBS] vs PRD "Recipient" (single) [SD-10].
## 7.3 Invariants
| Invariant | Enforcement |
|---|---|
| `idempotencyKey` unique | DB UNIQUE |
| `deliveryStatus` ∈ {PENDING, SUCCESS, FAILED} | DB CHECK |
| `notificationType` ∈ {INFO, WARNING, ALERT} | DB CHECK |
| Recipients valid/active/same team | **Unclear** (array, no FK) |
| One notification per (event, recipient) | Application via key derivation [UNK] |
## 7.4 State Machine
```text
PENDING → SUCCESS
PENDING → FAILED   (after retries exhausted [D])
```
Owned here. No in-flight/retrying state exists in DBS; PENDING covers "retrying" [D].

---

# 8. Architectural Context
## 8.1 Relevant Architecture — "Notification Flow: Any module publishes a notification job after commit; worker sends via the email provider and records delivery status." (Note: "publishes … after commit" vs outbox-in-tx — SD-04.)
## 8.2 Components
| Component | Responsibility |
|---|---|
| Notification worker/processor | resolve, send, record |
| Recipient resolver | team/lead lookup (read `User`) |
| Email provider adapter | provider abstraction [P] |
| Repository | `Notification` |
## 8.3 Constraints — email only inside worker; transaction-pooler; providers behind an adapter [P; ADR-013 abstraction is for LLM only — D].
## 8.4 ADRs — **ADR-008** (async + backoff + DLQ), **ADR-009/014** (outbox, idempotent consumers).

---

# 9. Dependency Model
## 9.1 Upstream
| Slice | Type | Requires |
|---|---|---|
| 08 | RUNTIME | queue, retry, DLQ |
| 05, 07, 04, 11 | EVENT | notification outbox events |
| 01 | READ | users, `leadId`, status |
| 06 | IN-TX | audit append |
## 9.2 Downstream — 06 (timeline `NOTIFIED`); ops observability.
## 9.3 Contract
**Allowed:** consume documented outbox events; read-only user lookup. **Forbidden:** producers sending email; notification worker mutating Incident.

---

# 10. Slice Coupling Analysis
## 10.1 Transactional — **NO** with producers beyond the outbox insert (owned by producers). Worker tx: Notification update + audit insert [D].
## 10.2 Synchronous — NO (async only).
## 10.3 Shared Invariants — "Required notification events have an atomic outbox record" spans producers + this slice: **producer owns atomic insertion; this slice owns consumption/idempotency** [D].
## 10.4 Summary
| Related Slice | Coupling | Strength | Boundary Decision |
|---|---|---|---|
| 05/07/04/11 | event (outbox) | Loose | SEPARATE |
| 08 | runtime | Medium | SEPARATE |
| 06 | audit append | Soft | SEPARATE |
### Boundary Decision
Delivery has different failure semantics (external provider) and a separate module owner; the only coupling is the event catalog (UDR-14).

---

# 11. Data Model
## 11.1 Tables — `Notification`; read `User`, `Incident`; write `AuditEvent`.
## 11.2 Fields
| Field | Purpose | Required? |
|---|---|---|
| `deliveryStatus` | PENDING/SUCCESS/FAILED | Yes |
| `notificationType` | INFO/WARNING/ALERT | Yes |
| `attemptCount`, `lastAttemptTimestamp` | attempt tracking | No (nullable, no default for count) |
| `providerResponse jsonb` | provider result/error | No |
| `idempotencyKey text UNIQUE` | dedupe | No (nullable! — NULLs don't conflict) |
| `recipients uuid[]` | targets | No |
| `incidentId` | link | No (nullable FK) |
## 11.3 Constraints — CHECKs, UNIQUE(idempotencyKey), `idx_notification_incident_status`.
## 11.4 DB Invariants — key uniqueness *only when non-NULL*; this weakens BR-064 enforcement [D].
## 11.5 Migration Requirements [P/UDR-14] — make `idempotencyKey`, `incidentId` NOT NULL for event-driven notifications; default `attemptCount=0`; no event-type/kind column (what triggered it) — needed for audit/UX; per-recipient rows vs array.

---

# 12. Transaction & Consistency Model
## 12.1 Boundary
```text
Worker, per job:
  claim/insert Notification (unique idempotencyKey)        -- tx A
  [external] send email                                    -- outside tx
  UPDATE Notification (status, attempts, providerResponse) -- tx B
  INSERT AuditEvent (NOTIFIED)                             -- same tx as B [D]
```
## 12.2 Atomic — status update + audit [D]; email send is not atomic with DB (inherent).
## 12.3 Locking — UNIQUE key on insert; row lock when updating attempts [P].
## 12.4 Guarantees — at-least-once send, at-most-one *record* per key; possible duplicate email on crash window [D].
## 12.5 Failure — exceptions rethrown to queue for backoff.

---

# 13. Idempotency & Concurrency
## 13.1 Idempotency — **Identity:** `idempotencyKey` (derivation [UDR-14]). **Duplicate request:** existing row found ⇒ if `SUCCESS` no-op; if `PENDING` continue/skip per claim [UNK]. **Replay:** same. **Side-effect protection:** DB UNIQUE + status check before send; provider-side idempotency if supported [UNK].
## 13.2 Concurrency
| Race | Protection | Expected | Test |
|---|---|---|---|
| two workers same key | UNIQUE + row claim | one sends | parallel job test |
| crash after send before record | retry | possible duplicate email (documented) | kill test |
| manual re-drive while auto retry | key + status | single effect | test |

---

# 14. API Surface — Preliminary
`PRELIMINARY — API CONTRACT NOT YET FROZEN`
| Candidate operation | Actor / Authz | Input | Domain action | Output | Failures | Idempotency / concurrency | Confidence · Missing |
|---|---|---|---|---|---|---|---|
| (none mandated for sending) | — | — | worker-only | — | — | — | High |
| View notification history for incident | ENG/TL/ADMIN own team? [UNK — PRD only lists timeline, with `NOTIFICATION_SENT` event] | incidentId | read | notification records/timeline entries | 403/404 | read | Low · is a separate endpoint needed? |
| Retry failed notification (DLQ re-drive) | ADMIN? [UNK] | notification id | requeue | status | 403/404/409 | idempotent | Low · ADR-008 says manual; interface UNK |
Async: all delivery. Pagination: [UNK].

---

# 15. Events, Queues & Side Effects
## 15.1 Events Produced — audit `NOTIFIED`/`NOTIFICATION_SENT`.
## 15.2 Events Consumed — notification outbox events (catalog UDR-14): candidates from PRD transition side-effects: acknowledge, severity confirm, resolve, close, assignment change, SLA warning, escalation, "notification job as applicable" at creation (UC-001). Comments: not listed [D].
## 15.3 Queue Jobs — notification queue; retry exponential + DLQ [C]; numbers UDR-22.
## 15.4 Delivery — at-least-once; idempotent [C].
## 15.5 External Side Effects — email via provider (the only one).

---

# 16. Security & Authorization
Auth: worker is system actor. Recipients restricted to the incident's team [D BR-004]. Email content must avoid secrets/full alert payloads [P]; no tokens in links [P]. Provider credentials from secret store [C §12.6]. Never log: provider API keys, full email bodies at INFO, `providerResponse` containing credentials [P].

---

# 17. Failure Modes
| Failure | Detection | Expected | State Impact | Retry? | Evidence |
|---|---|---|---|---|---|
| Provider error/timeout | send exception | record attempt; backoff retry | PENDING | yes | AC-026 |
| Retries exhausted | attempt limit | FAILED + DLQ; observable | FAILED | manual | AC-027 |
| Duplicate job | UNIQUE/status | no second send | none | n/a | AC-028 |
| Recipient unresolved/deactivated | resolver | [UNK] fail vs skip | — | — | UDR-14 |
| DB failure on record update | exception | retry → possible resend | — | yes | [D] |
| Redis/queue down | — | outbox accumulates | delayed | — | UDR-21 |
## Critical Failure Scenario
**What fails:** provider outage for hours. **Must remain true:** incident operations unaffected (BR-061); delivery history retained (BR-063). **Recovery:** backoff then DLQ; manual re-drive.

---

# 18. Observability
Logs: attempt, outcome, provider error class, correlation id (FR-034). Metrics [P]: sent/failed/DLQ, attempts histogram, delivery latency. Audit: `NOTIFIED`/`NOTIFICATION_SENT` [Transactional with status update — D]. Error tracking: DLQ size alarms [P].

---

# 19. Testing Strategy
- **Unit:** recipient resolution; key derivation; type mapping.
- **Integration:** UNIQUE behavior; status transitions; audit atomicity; provider stub.
- **API:** `BLOCKED — API CONTRACT NOT YET FROZEN`.
- **Authorization:** cross-team recipient exclusion.
- **Concurrency:** parallel identical jobs.
- **Idempotency:** duplicate job; replay after SUCCESS; re-drive.
- **Failure injection:** provider failures, kill after send, DB failure on update.
- **Regression:** producers' events still map to the catalog.

---

# 20. Test ↔ Requirement Traceability
| Requirement | AC | Test(s) | Status |
|---|---|---|---|
| FR-024 / BR-060 | AC-025 | recipient tests | NOT RUN |
| BR-062/063 | AC-026 | retry/recording tests | NOT RUN |
| BR-062 / NFR-009 | AC-027 | exhaustion test | NOT RUN |
| BR-064 / FR-032 | AC-028 | idempotency tests | NOT RUN |
| BR-061 | (none) | non-blocking test | NOT RUN |
### Coverage Gaps
- No AC for recipient edge cases or notification content; crash-window duplicate documented not eliminated.

---

# 21. Implementation Plan
## 21.1 Sequence
1. Decide UDR-14, 22 (+05). 2. `Notification` model. 3. Provider adapter + fake. 4. Recipient resolver. 5. Worker with idempotency. 6. Audit. 7. Retry/DLQ wiring with 08. 8. Tests.
## 21.2 Files
### CREATE
```text
src/notifications/** · test/notifications/**
```
### MODIFY — `prisma/schema.prisma` (Notification); worker registration.
### REVIEW ONLY — ARCH ADR-008; PRD §7 Notification Rules.
## 21.3 Allowed — Notifications module. ## 21.4 Forbidden — email calls elsewhere; changing Incident state; choosing event catalog unilaterally. ## 21.5 Must exist — 01, 06 writer, 08.

---

# 22. AI Agent Context
## 22.1 Read First
1. `AGENTS.md` 2. This slice 3. `PROJECT_STATE.md` 4. `TEST_STATUS.md` 5. `SESSION_CHECKPOINT.md` 6. PRD §7 Notification Rules 7. ARCH ADR-008 8. DBS `Notification`
## 22.2 Relevant Canonical Context
| Topic | Source | Location |
|---|---|---|
| Requirement | PRD | FR-024/025/032, BR-060–064 |
| Domain | DM | Notification row |
| Architecture | ARCH | Notification Flow, ADR-008 |
| Database | DBS | `Notification` |
| API | — | not frozen |
## 22.3 Agent Objective
Implement the notification worker with idempotent record creation, recorded attempts, and retry/DLQ integration; stop at UDR-14 (events/recipients/keys).

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
- Idempotency keys and why a nullable UNIQUE column is weak.
- Crash windows around external calls; why exactly-once email is impossible.
- Backoff + DLQ semantics.
## 23.2 SHOULD UNDERSTAND — provider-side idempotency; recipient resolution timing.
## 23.3 CAN DEFER — templates, digesting.
## 23.4 Mental Model
A reliable courier ledger: write the delivery slip first (unique per event+recipient), try to deliver, record the result, and never create a second slip for the same parcel.
## 23.5 First-Principles Questions
1. Why async? 2. What breaks without an idempotency key? 3. Why is a duplicate email still possible and acceptable? 4. Why DLQ rather than infinite retry? 5. Why resolve recipients in the worker?
## 23.6 Interview Questions
### Design
1. Design idempotent email notifications with retries.
### Debugging
1. Users got duplicate emails — investigate.
### Failure Handling
1. Email provider down for 2 hours?
### Architecture
1. Why are notifications a separate module from incidents?

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
- [ ] Provider outage does not affect incident API latency/behavior
- [ ] Duplicate job ⇒ one record, one provider call
- [ ] UDR-14, 22 decided

---

# 25. Current Implementation Status

**Status:** `PLANNED` — DESIGN / PRE-IMPLEMENTATION (no implementation claimed)

### Completed
- None.

### In Progress
- None.

### Remaining
- Entire slice (blocked on UDR-14, UDR-22)

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
Multi-channel, fallback chains, real-time (PRD §16).
## Extension Points
Provider adapter; per-event templates.
## Known Limitations
Nullable idempotency key; recipient array; no event-kind column.
## Deliberately Not Generalized
Email only.
## Potential Breaking Changes
Changing key derivation or event catalog.

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
- [ ] Delivery history inspectable for every failed notification.

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
