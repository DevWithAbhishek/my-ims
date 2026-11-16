# SLICE-07 — SLA Monitoring & Escalation

## 1. Purpose
A worker evaluates Response and Resolution SLAs, records an 80 % warning, records breaches, and escalates an unacknowledged incident through the service's escalation chain when its response SLA is breached. SLA breaches never change incident state.

## 2. Scope
### In Scope
SLA/escalation worker; hybrid scheduling (delayed BullMQ jobs + periodic PostgreSQL scanner); warning, breach and escalation handling; `SLA_WARNING` and `ESCALATED_L1…L4` audit events; notification outbox events for each milestone per the matrix in §4; once-only recording with unique idempotency keys; recovery after downtime.
### Out of Scope
The read-time `SlaStatus` shown in API responses (computed by SLICE-05/06 from configuration and timestamps — no endpoint exists for SLA, outbox or notifications); assignment changes (escalation **notifies only**; it never assigns); notification delivery (SLICE-09); outbox relay/queue infrastructure (SLICE-08); SLA and escalation-policy configuration (SLICE-02); any inter-responder delay (none exists in the MVP).

## 3. Dependencies
SLICE-02 (service SLA minutes per severity; policy users), SLICE-05 (incident state/severity/ack fields; the transition kernel's row-lock protocol), SLICE-06 (`appendAuditEvent`), SLICE-08 (outbox write contract, BullMQ queues/workers, retry/DLQ policy), SLICE-09 (the `enqueueNotification` producer contract, which must exist first, and notification delivery). Required existing behavior: incident `status`, `severity`, `createdAt`, `acknowledgedTimestamp`, `resolvedTimestamp`; policy `level1`, `level2`, `level3`, `fallbackAdmin`.

## 4. Capability Behavior

**Time model.** Both SLA clocks start at incident `createdAt`; elapsed time is continuous (no business-hour pauses); timestamps are stored/serialized in UTC. The applicable threshold is the service's configured minutes for the incident's **current** severity (`P0…P3` × Response/Resolution); a severity change never resets the clock and the next evaluation uses the latest severity. Response SLA runs until acknowledgement; Resolution SLA runs until resolution.

**Scheduling model (hybrid).**
- **Primary:** delayed BullMQ jobs scheduled for the precise threshold times (80 % warning, breach, escalation steps).
- **Safety net:** a periodic PostgreSQL scanner that finds incidents whose thresholds have been crossed without the milestone being recorded and processes them.
- **Purpose:** recovery with precision after downtime (worker down, Redis lost, delayed jobs lost). The scanner must not replace the delayed jobs, and the delayed jobs must not be the only mechanism.
- The design does not specify scanner frequency, job delay values or configuration names; do not invent them (stop per `AGENTS.md` §13 if they are required and not provided by the project owner).
- Both mechanisms call the same evaluation function; duplicate triggering is safe because of the once-only rule below.

**Escalation timing.** There is **no separate or configurable delay between escalation levels** in the MVP. Escalation levels follow the escalation policy order; nothing in this slice introduces an inter-responder delay.

**Once-only recording.** Every milestone is recorded at most once per incident under a unique idempotency identity, enforced at the **application layer and the database layer** (a database-level unique key, not read-then-insert):

| SLA action | Idempotency identity |
|---|---|
| 80 % response warning | `incidentId + RESPONSE_WARNING` |
| 80 % resolution warning | `incidentId + RESOLUTION_WARNING` |
| Response breach | `incidentId + RESPONSE_BREACH` |
| Resolution breach | `incidentId + RESOLUTION_BREACH` |
| Escalation level 1 | `incidentId + ESCALATION_LEVEL_1` |
| Escalation level 2 | `incidentId + ESCALATION_LEVEL_2` |
| Escalation level 3 | `incidentId + ESCALATION_LEVEL_3` |
| Escalation level 4 | `incidentId + ESCALATION_LEVEL_4` |
| Escalation failure | `incidentId + ESCALATION_FAILURE + level` |

**Where the keys live.** Every milestone in the matrix creates a notification, so the database-level unique key is `Notification.idempotencyKey` (SLICE-09's contract builds it as `<eventType>:<incidentId>:<milestone>`, for example `SLA_WARNING:<incidentId>:RESPONSE_WARNING`, `ESCALATED_L2:<incidentId>:ESCALATION_LEVEL_2`, `ESCALATION_FAILED:<incidentId>:ESCALATION_FAILURE_2`). No new table or migration is needed. Evaluation order inside the transaction: call `enqueueNotification` **first**; if it returns `created = false` the milestone was already recorded, so write nothing else (no audit event) and stop; otherwise append the audit event where the matrix says Yes.

**Milestone audit/notification matrix (exact).**

| SLA milestone | Audit | Notification |
|---|---|---|
| 80 % response warning | Yes — `SLA_WARNING { kind: RESPONSE }` | Yes |
| 80 % resolution warning | Yes — `SLA_WARNING { kind: RESOLUTION }` | Yes |
| Response breach | No | Yes |
| Resolution breach | No | Yes |
| Escalation L1 | Yes — `ESCALATED_L1` | Yes |
| Escalation L2 | Yes — `ESCALATED_L2` | Yes |
| Escalation L3 | Yes — `ESCALATED_L3` | Yes |
| Escalation L4 | Yes — `ESCALATED_L4` | Yes |
| Escalation failure | No | Yes |

Notification event types and types: `SLA_WARNING` (`WARNING`), `RESPONSE_BREACH` and `RESOLUTION_BREACH` (`ALERT`), `ESCALATED_L1`–`L4` (`WARNING`), `ESCALATION_FAILED` (`ALERT`); recipients for all of them follow SLICE-09 (team members ∪ the policy's fallbackAdmin).

No other audit or notification events are created by this slice. A breach is visible through the computed `SlaStatus` (`BREACHED`) and through its notification; it is never an audit event and never changes incident state.

**Warning.** When the applicable SLA reaches **80 %** of its window (measured from `createdAt`), record the warning once (identity above), append `SLA_WARNING` and enqueue the notification. No lifecycle state change. Preconditions: incident not `RESOLVED`/`CLOSED`; the relevant SLA still running (response: unacknowledged; resolution: unresolved). A severity change may make an already-elapsed threshold crossed; the next evaluation records it once.

**Breach.** When a response or resolution SLA window is exceeded (not yet met), record the breach once (identity above) and enqueue its notification; no audit event, no incident state change.

**Escalation (response breach).** The escalation order follows the policy: `ESCALATED_L1 → level1`, `L2 → level2`, `L3 → level3`, `L4 → fallbackAdmin`. For a level being escalated: lock and re-read the incident, re-verify it is still `OPEN` (an acknowledgement that committed first wins: no escalation), validate the responder (still `ACTIVE` and still the required role/team for that level). If valid: record the level once, append `ESCALATED_Ln { notifiedUser }`, and call `enqueueNotification` for `ESCALATED_Ln` (type `WARNING`; recipients per SLICE-09: team members ∪ fallbackAdmin). Escalation continues until the incident is acknowledged/resolved/closed or the final fallback (`fallbackAdmin`) has been handled; the final fallback is recorded. The incident stays `OPEN` until acknowledged; escalation never assigns it.

**Invalid or deactivated responder.** If the responder for a level is invalid or deactivated, the failure event is **`ESCALATION_FAILED`**: record it once for that level (identity `incidentId + ESCALATION_FAILURE + level`), enqueue its notification, and write **no** audit event. The level is considered **finished**; the **next level is attempted immediately** (the fallback Admin is attempted if it is the next level in the chain). If the failed level was the last level, there is no next level. No other incident state changes: status, assignment, severity and acknowledgement are untouched; only escalation/notification state is affected. No retry count is applied to a failed level.

**Stop conditions.** Acknowledged, resolved or closed incidents get no further escalation, and no further warning/breach for the stopped SLA. An unassign returns the incident to `OPEN`, so the response SLA is again unacknowledged against the original deadline; milestones already recorded are not repeated.

## 5. Domain & Data Context
`Incident` (read): `status`, `severity`, `createdAt`, `acknowledgedTimestamp`, `resolvedTimestamp`, `teamId`, `affectedServiceId`. `AppService` (read): the eight SLA minute columns, `status`. `EscalationPolicy` (read): `level1Id`, `level2Id`, `level3Id`, `fallbackAdminId` → `User` (`status`, `role`, `teamId`); the policy has no timing fields. `AuditEvent` (write): `SLA_WARNING`, `ESCALATED_L1…L4`, with `actor = null`. `OutboxEvent` (write): notification events for every milestone in the matrix. The once-only identities above are enforced by the unique `Notification.idempotencyKey` (database) plus the application-level `created` check.

## 6. API Contract
None. No endpoint exists for SLA, escalation, outbox or notifications. Results are visible through the timeline (`SLA_WARNING { kind }`, `ESCALATED_L1…L4 { notifiedUser: { id, name } }`) and the computed `sla` / `slaState` fields of incident reads.

## 7. Authorization & Security
Worker only; no HTTP surface. The worker acts as system (`actor = null`). Notification recipients are computed server-side from the policy; never from external input. Do not log secrets or email addresses beyond ids.

## 8. Consistency & Concurrency
Each evaluation is one transaction: lock the incident row (same lock protocol as the transition kernel) → re-read status/severity/ack → compute thresholds → record the milestone under its unique idempotency key (race-safe, database-enforced) → append audit where the matrix says Yes → enqueue the notification outbox event → commit. Two workers (or a delayed job and the scanner) on the same milestone produce one record; ack vs escalation resolves by lock + state re-check (no escalation after an acknowledgement commits); a severity change vs evaluation reads current severity under the lock; at-least-once delivery means duplicate jobs are no-ops.

## 9. Async / Events / Workers
Queue/worker: the SLA/escalation queue (SLICE-08) with delayed BullMQ jobs as the primary trigger and the periodic PostgreSQL scanner as the safety net, both running in the worker process. Produces audit `SLA_WARNING`, `ESCALATED_L1…L4` and notification outbox events for each milestone in the matrix, including breaches and `ESCALATION_FAILED`. Transient infrastructure errors follow the SLICE-08 retry/DLQ policy (exponential backoff, bounded attempts, failure state on exhaustion); an invalid responder is not an infrastructure error and is handled by the `ESCALATION_FAILED` flow above. Idempotent consumers.

## 10. Failure & Recovery
Worker/Redis down: SLA status is not silently lost — delayed jobs that were lost or never ran are recovered by the PostgreSQL scanner, which evaluates overdue thresholds and records each milestone once and escalation resumes from the next unrecorded level. Duplicate job/scan → no duplicate record, audit event or notification. Invalid/deactivated responder → `ESCALATION_FAILED`, level finished, next level attempted immediately. Database failure rolls back the evaluation; the job or scan is retried safely.

## 11. Implementation Surface
Worker (`src/workers`), AppService/Incident module public read interfaces, an SLA/escalation service with a pure threshold calculator (injected clock), delayed-job scheduling and the periodic scanner through SLICE-08's queue/worker infrastructure, and the calls to SLICE-09's `enqueueNotification` (the once-only enforcement is its unique key; no new table). Tests: unit (clock-controlled thresholds, severity change, 80 % boundary, level progression and failure skipping), integration (PostgreSQL + Redis).

## 12. Verification Requirements
- Elapsed/threshold math with a fixed clock; warning not before 80 %; each milestone recorded once; severity change moves the threshold without resetting the clock.
- Matrix exactness: each milestone writes audit/notification exactly as in the matrix (e.g. breaches and `ESCALATION_FAILED` write notification but no audit event; warnings and L1–L4 write both).
- Response breach on an `OPEN` incident escalates L1→L2→L3→L4 in policy order with no inter-level delay configuration, each with `ESCALATED_Ln` and an `ESCALATED_Ln` notification (recipients per SLICE-09); fallback recorded; stops at ack/resolve/close; incident stays `OPEN` and unassigned.
- Invalid/deactivated responder at a level → `ESCALATION_FAILED` recorded once, notification enqueued, no audit event, next level (or fallback Admin) attempted immediately, no other incident field changed; failure at the last level ends the chain.
- Unique idempotency keys: two workers, duplicate job, delayed job plus scanner for the same milestone → one record, one audit event (where applicable), one notification; the database rejects a second insert of the same identity.
- Race tests: acknowledge committing mid-evaluation → no escalation after commit.
- Downtime recovery: delayed jobs lost (Redis flushed/worker stopped past thresholds), the scanner records overdue milestones once.
- Resolution breach changes no state and writes no audit event.

## 13. Completion Criteria
- Scheduling is hybrid (delayed BullMQ jobs primary, PostgreSQL scanner safety net) with no invented timing values.
- Warnings, breaches, escalations and failures follow the matrix exactly and are recorded once, with unique idempotency keys enforced at application and database layers.
- Escalation never assigns, never changes incident status, has no inter-level delay, and handles invalid responders via `ESCALATION_FAILED` with immediate next-level attempt.
- Races/duplicates are safe; downtime recovery works; tests pass; typecheck/lint/format clean on touched files.
