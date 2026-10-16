# SLICE-05 — Incident Lifecycle & Assignment

## 1. Purpose

Drive an incident through `OPEN → ACKNOWLEDGED → MITIGATING → RESOLVED` and manage assignment, with lock-based, atomic transitions (state change + audit events + outbox events in one transaction). Owns the transition kernel that other slices reuse, and the `PATCH /incidents/:incidentId` action dispatcher.

## 2. Scope

### In Scope

Actions I3 acknowledge, I4 confirm severity, I5 change severity, I6 assign/reassign, I7 unassign, I8 resolve; the shared transition kernel; the action dispatcher (exactly-one-row matching); `IncidentResponse` assembly for these actions.

### Out of Scope

Incident creation (SLICE-04); listing/detail/timeline/comments (SLICE-06; the comment action I10 is handled by SLICE-06 through the same dispatcher); closing (`RESOLVED → CLOSED` happens only atomically with postmortem approve/manual create, SLICE-11); SLA/escalation evaluation (SLICE-07); notification delivery (SLICE-09); there is **no close action** and no reopen.

## 3. Dependencies

- SLICE-01: guard and helpers (role, own-team, `teamId = null → 403 INVALID_ACTION`).
- SLICE-02: escalation policy read (chain membership = `level1`, `level2`, `level3`, `fallbackAdmin` of the incident's service policy).
- SLICE-04: incidents exist; alerts carry `activeIdentityKey` (cleared here on resolve).
- In-transaction contracts: `appendAuditEvent(tx, …)` (SLICE-06) and `enqueueOutbox(tx, …)` (SLICE-08). If absent, create only the minimal function with that semantics in its owning location and report it. **Notification producer contract (SLICE-09):** `enqueueNotification(tx, { eventType, occurrenceId, incidentId?, serviceId?, teamId?, alertSourceId?, subjectUserId? })` — resolves recipients at enqueue time, inserts the `Notification` and writes its `NOTIFICATION_REQUESTED { notificationId }` outbox event in the caller's transaction. SLICE-09 must be implemented first; if it is absent, stop and report (do not recreate its recipient rules here). It also writes `SLA_EVALUATION_REQUESTED { incidentId }` through `enqueueOutbox` where stated below.
- Dispatcher: this slice and SLICE-06 share one route, `PATCH /incidents/:incidentId`. Whichever slice is implemented first creates the dispatcher skeleton (route, strict body parsing, exactly-one-row matching, shared gates); the other adds its rows.

## 4. Capability Behavior

### 4.1 Request model (`UpdateIncidentDto`, Zod-strict, every field optional)

`status` (`ACKNOWLEDGED|MITIGATING|RESOLVED|OPEN`), `severity` (`P0..P3`), `currentAssignee` (uuid | `null`), `resolutionSummary` (trimmed 1–10,000), `serviceConfirmedWorking` (boolean), `comment` (`{ title? ≤200, body trimmed 1–10,000 }`). **A request must match exactly one row**; a body matching none or several → `422 VALIDATION_FAILED`. One action per request. Unknown field → `400 BAD_REQUEST`. Body/path validation runs before state checks.

| ID  | Action           | Body                                                                                  | Caller                                                       | Required state                       | Result state         |
| --- | ---------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------------ | -------------------- |
| I3  | acknowledge      | `{ "status": "ACKNOWLEDGED" }`                                                        | all roles                                                    | `OPEN`                               | `ACKNOWLEDGED`       |
| I4  | confirm severity | `{ "status": "MITIGATING", "severity": "P1" }`                                        | chain members                                                | `ACKNOWLEDGED`                       | `MITIGATING`         |
| I5  | change severity  | `{ "severity": "P1" }`                                                                | chain members; in `OPEN` only `TEAM_LEAD`/`ADMIN`            | `OPEN`, `ACKNOWLEDGED`, `MITIGATING` | unchanged            |
| I6  | assign           | `{ "currentAssignee": "<uuid>" }`                                                     | `TEAM_LEAD`, `ADMIN`                                         | `OPEN`, `ACKNOWLEDGED`, `MITIGATING` | unchanged            |
| I7  | unassign         | `{ "currentAssignee": null, "status": "OPEN" }`                                       | `TEAM_LEAD`, `ADMIN`                                         | `OPEN`, `ACKNOWLEDGED`, `MITIGATING` | `OPEN`               |
| I8  | resolve          | `{ "status": "RESOLVED", "resolutionSummary": "…", "serviceConfirmedWorking": true }` | `TEAM_LEAD`/`ADMIN` any; `ENGINEER` only as current assignee | `MITIGATING`                         | `RESOLVED`           |
| I10 | comment          | `{ "comment": {…} }`                                                                  | all roles                                                    | any except `CLOSED`                  | unchanged (SLICE-06) |

Response: `200 OK`, `data: IncidentResponse` for I3–I8. All checks run in the order Gate 0 auth → Gate 1 role → Gate 2 team / chain → body validation → Gate 3 state (under lock).

### 4.2 Transition kernel (used by every action and by SLICE-11's closure)

One transaction: (1) load the incident and apply team gate; (2) `SELECT … FOR UPDATE` on the incident row with a bounded lock timeout; (3) **re-check the required state under the lock** and any role-by-state rule; (4) apply the change; (5) append the audit event(s) in order (each stored with a slightly later `createdAt` than the previous); (6) write the outbox event(s) and call `enqueueNotification` for each notifying audit event written (`occurrenceId` = that audit event's id); (7) commit; (8) respond. First committed request wins; the loser gets `409 INVALID_STATE_TRANSITION` with `details: [{ currentStatus, requiredStatus }]` (a single status where one is required; the allowed set for multi-state actions). Lock timeout / serialization failure → `409 CONCURRENCY_CONFLICT` (state may be unchanged; retryable with backoff). Lifecycle commands are idempotent by state guard: a retry gets `409` and creates no second audit event, outbox event or notification. No external call occurs inside the transaction.

### 4.3 Actions

**I3 acknowledge.** Sets `status = ACKNOWLEDGED`, `acknowledgedBy` = caller, `acknowledgedAt` = now. If `currentAssignee` is `null`, the caller also becomes `currentAssignee` (auto-assign): events in order `ASSIGNED { from: null, to: caller, auto: true }`, then `ACKNOWLEDGED { acknowledgedBy: caller, autoAssigned: true }`. If already assigned (to the caller or someone else) the assignee is unchanged and only `ACKNOWLEDGED { acknowledgedBy: caller, autoAssigned: false }` is written. Any role of the incident's team may acknowledge an incident assigned to someone else. Async: one notification per audit event written (`ASSIGNED` when auto-assigned, then `ACKNOWLEDGED`; type `ALERT`; recipients per SLICE-09); the response-SLA clock stops (computed at read time).

**I4 confirm severity.** Caller must be a chain member (`403 FORBIDDEN` otherwise). Sets `severity`, `severityConfirmedBy`, `severityConfirmedAt`, `status = MITIGATING`. Event `SEVERITY_CONFIRMED { from, to, statusFrom: "ACKNOWLEDGED", statusTo: "MITIGATING" }` is written even when `from = to` (a confirmation). The AI suggestion is never applied by the API; "accepting" it means calling this with the suggested value. Async: `SEVERITY_CONFIRMED` notification (`ALERT`) and outbox event `SLA_EVALUATION_REQUESTED { incidentId }` (so SLICE-07 re-evaluates against the new severity's thresholds without resetting the clock).

**I5 change severity.** Same value as current → `200`, no change, **no audit event**. Otherwise sets `severity`; status unchanged; event `SEVERITY_CONFIRMED { from, to, statusFrom, statusTo }` with `statusFrom = statusTo` = current status. `ENGINEER` on an `OPEN` incident → `403 FORBIDDEN_ROLE`; non-chain caller → `403 FORBIDDEN`; `RESOLVED`/`CLOSED` → `409 INVALID_STATE_TRANSITION`. Async (only when the severity actually changed): `SEVERITY_CONFIRMED` notification (`ALERT`) and `SLA_EVALUATION_REQUESTED { incidentId }`.

**I6 assign.** `currentAssignee` must be an `ACTIVE` user **of the incident's team** with role `ENGINEER` or `TEAM_LEAD`, else `403 ASSIGNEE_NOT_ELIGIBLE` (also for a non-existent user; the response never reveals whether the user exists in another team). Status unchanged; `acknowledgedBy` is never touched. Previous assignee `null` → `ASSIGNED { from: null, to: B, auto: false }`; previous assignee A → `REASSIGNED { from: A, to: B }`. Assigning the current assignee again → `200`, no event. Async: one notification for the event written (`ASSIGNED` or `REASSIGNED`, type `ALERT`; recipients per SLICE-09). `ENGINEER` caller → `403 FORBIDDEN_ROLE`.

**I7 unassign.** Sets `currentAssignee = null`, `status = OPEN`, `acknowledgedBy = null`, `acknowledgedAt = null`. Events in order: `REASSIGNED { from: A, to: null }` (only if there was an assignee), then `OPEN { statusFrom }` (only if the incident was not already `OPEN`). Already unassigned and `OPEN` → `200`, nothing written. Async: one notification per audit event written (`REASSIGNED`, then `OPEN`; type `ALERT`) and, when the incident actually returned to `OPEN`, `SLA_EVALUATION_REQUESTED { incidentId }` (the response SLA is running again).

**I8 resolve.** Requires `serviceConfirmedWorking = true` (else `400 BAD_REQUEST`) and `resolutionSummary` (missing/invalid → `422`). `ENGINEER` who is not the current assignee → `403 NOT_CURRENT_ASSIGNEE`. Sets `resolvedBy`, `resolvedAt`, `resolutionSummary`, `status = RESOLVED`; event `RESOLVED { resolutionSummary, serviceConfirmedWorking }`. **In the same transaction:** insert the `Postmortem` row (`generationStatus = GENERATING`, `reviewStatus = PENDING`; content fields, `mttrMinutes`, `riskLevel` null) and clear `activeIdentityKey` on **every** alert of the incident. Outbox: `POSTMORTEM_GENERATION_REQUESTED { postmortemId, incidentId }`, plus the `RESOLVED` notification (`ALERT`). A retry cannot create a second postmortem row or job (`Postmortem.incidentId` is unique; state guard). The resolution-SLA clock stops. If generation later fails permanently the Team Lead and resolver are notified (SLICE-11); the incident stays `RESOLVED`.

### 4.4 State machine (enforced here)

Allowed: `OPEN→ACKNOWLEDGED→MITIGATING→RESOLVED`; `RESOLVED→CLOSED` only via SLICE-11. Never allowed: `OPEN→MITIGATING`, `ACKNOWLEDGED→RESOLVED`, `RESOLVED→MITIGATING` (no reopen), anything from `CLOSED`. Severity and assignment changes are allowed in `OPEN|ACKNOWLEDGED|MITIGATING` only. The acknowledging actor and the assignee are stored separately and may differ.

## 5. Domain & Data Context

`Incident`: `status` (`OPEN|ACKNOWLEDGED|MITIGATING|RESOLVED|CLOSED`), `severity` (`P0..P3`), `acknowledgedTimestamp`, `severityConfirmTimestamp`, `resolvedTimestamp`, `closedTimestamp`, `resolutionSummary`, FKs→User: `currentAssigneeId`, `acknowledgedById`, `severityConfirmedById`, `resolvedById`, `closedById`; `affectedServiceId` + `teamId`; `createdAt`, `updatedAt`. API names: `acknowledgedAt`, `severityConfirmedAt`, `resolvedAt`, `closedAt`. `Postmortem` (insert only here): `generationStatus` (`GENERATING|DRAFT|FAILED`), `reviewStatus` (`PENDING|REJECTED|REVIEWED`), `incidentId` **unique**. `Alert.activeIdentityKey` (cleared on resolve). `AuditEvent` and `OutboxEvent` rows via the contracts. Invariants: at most one current assignee; every successful transition has its audit event atomically; CLOSED is terminal; severity/assignment never changed by AI.

**`IncidentResponse`**: `id`, `title`, `description`, `status`, `severity`, `service: { id, name }`, `teamId`, `currentAssignee`, `acknowledgedBy`, `severityConfirmedBy`, `resolvedBy`, `closedBy` (each `{ id, name } | null`), `resolutionSummary | null`, `createdAt`, `acknowledgedAt|null`, `severityConfirmedAt|null`, `resolvedAt|null`, `closedAt|null`, `sla: SlaStatus`. `SlaStatus` (computed at read time, never stored): `{ applicableSeverity, response, resolution }` where each is `{ thresholdMinutes, deadlineAt, state: ON_TRACK|WARNING|BREACHED|MET, metAt|null }`; deadline = `createdAt + threshold` for the incident's **current** severity (the clock never resets on severity change); `WARNING` at ≥ 80 % elapsed; `MET` once acknowledged/resolved; a breach never changes incident state. (The same builder is used by SLICE-06.)

## 6. API Contract

`PATCH /incidents/:incidentId` — Bearer; headers `Authorization`, `Content-Type: application/json`; path `incidentId` uuid (malformed → `422`); no query; no `Idempotency-Key`. Errors common to all actions: `401 UNAUTHENTICATED`, `403 FORBIDDEN_ROLE`, `403 FORBIDDEN` (outside the chain, I4/I5), `403 TEAM_ACCESS_DENIED`, `403 INVALID_ACTION` (`teamId = null`), `404 INCIDENT_NOT_FOUND`, `409 INVALID_STATE_TRANSITION`, `409 CONCURRENCY_CONFLICT`, `422 VALIDATION_FAILED`, `400 BAD_REQUEST`, `500`, `503`. Action-specific: `403 ASSIGNEE_NOT_ELIGIBLE` (I6), `403 NOT_CURRENT_ASSIGNEE` (I8). Unknown incident id → `404`; another team's incident → `403 TEAM_ACCESS_DENIED`.

## 7. Authorization & Security

Team isolation via the caller's `teamId` claim only. Engineers cannot assign/unassign/reassign (`FORBIDDEN_ROLE`). Chain = the four users of the incident's service policy; `ADMIN` outside the chain cannot do I4/I5. Assignee eligibility never leaks cross-team existence. No secrets or tokens in audit metadata or logs.

## 8. Consistency & Concurrency

Row lock + state re-check under lock + atomic change/audit/outbox (§4.2). Concurrent acknowledges: exactly one succeeds, the other `409 INVALID_STATE_TRANSITION`; acknowledgement actor recorded separately from the assignee. Resolve vs unassign races resolve by lock order with state re-check. Failed transaction leaves no partial change (AC: rollback test).

## 9. Async / Events / Workers

Audit events written: `ASSIGNED`, `REASSIGNED`, `OPEN`, `ACKNOWLEDGED`, `SEVERITY_CONFIRMED`, `RESOLVED` (formats above). Notifications: one `Notification` per audit event written (type `ALERT`), created through `enqueueNotification` in the same transaction. Outbox events written in the transaction: `POSTMORTEM_GENERATION_REQUESTED` (I8); `SLA_EVALUATION_REQUESTED` for I4, I5 (when the severity changed) and I7 (when the incident returned to `OPEN`); I3 and I8 need none (the SLA evaluation re-checks state under lock). Consumers are idempotent; nothing external runs here.

## 10. Failure & Recovery

Any failure rolls back state, audit and outbox together. Postmortem insert failure rolls back the resolve. `503 DEPENDENCY_UNAVAILABLE` if the database is down. Redis/queue outage does not affect commits (outbox relay catches up).

## 11. Implementation Surface

Application: Incident module — dispatcher, kernel (lock/recheck/audit/outbox), action handlers, response mapper (`IncidentResponse`, `SlaStatus` builder), repository (row lock via raw SQL, updates, alert-key clearing, postmortem insert). Database: no schema change. Tests: unit (state/role matrix, DTO row matching, SLA state calculation), integration (PostgreSQL), concurrency tests.

## 12. Verification Requirements

- Exact-one-row matching: every valid body; ambiguous/empty/extra bodies → `422`/`400`.
- Per action: success shape, events and their order, field changes, notification rows (one per notifying audit event, correct recipients/type), postmortem and `SLA_EVALUATION_REQUESTED` outbox rows where specified; no-op cases (I5 same value, I6 same assignee, I7 already open/unassigned) write nothing.
- Role/chain/state matrix incl. Engineer on `OPEN` I5, Admin outside chain, non-assignee Engineer resolve, `ASSIGNEE_NOT_ELIGIBLE` for wrong team/inactive/ADMIN/nonexistent, `teamId = null`, cross-team.
- Illegal transitions (`OPEN→MITIGATING`, `ACK→RESOLVED`, from `RESOLVED`/`CLOSED`) → `409` with `details`.
- Concurrent acknowledge (N parallel) → one `200`, rest `409`; no duplicate audit/outbox rows; parallel resolve likewise; retry of any command → `409`, no extra events.
- Resolve atomicity: Postmortem row (`GENERATING`/`PENDING`) inserted, active keys cleared, `RESOLVED` event, outbox rows — and fault injection proves all-or-nothing.
- Lock timeout path → `409 CONCURRENCY_CONFLICT`.

## 13. Completion Criteria

- I3–I8 behave exactly as specified with the listed events, errors, and statuses; the dispatcher enforces exactly-one-row matching.
- The kernel is reusable (callable with a different transition by SLICE-11); every transition is atomic with its audit and outbox.
- Concurrency/idempotency/atomicity tests pass; no external call inside transactions; typecheck/lint/format clean on touched files; existing behavior intact.
