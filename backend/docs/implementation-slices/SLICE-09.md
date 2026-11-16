# SLICE-09 — Notifications

## 1. Purpose
Own the notification model end to end: the **producer contract** that every other slice calls inside its own transaction (`enqueueNotification`), recipient resolution at enqueue time, the durable `Notification` record, and the worker that delivers it by email with recorded attempts, retries and a terminal failure state — without ever blocking a business action. This slice also retrofits the already-implemented administrative update endpoints (T4, S4, S7) so they produce notifications.

## 2. Scope
### In Scope
- `enqueueNotification(tx, …)` contract (recipient resolution, idempotency key, `Notification` insert, `NOTIFICATION_REQUESTED` outbox write) exported from a `notifications` module.
- The notification event catalog: event type → notification type → recipient rule.
- The `notifications` queue consumer, email provider abstraction, message templates, `NOTIFIED` audit event.
- Schema migration for `Notification` (new delivery-status enum, `eventType` column).
- Module-boundary lint rule so every module may call the notifications public interface.
- **Retrofit** of T4, S4, S7 (§4.9).
### Out of Scope
Deciding *when* a business event happens (producers call the contract); outbox relay/queue infrastructure and retry/DLQ mechanics (SLICE-08); the producer call sites in slices 03, 04, 05, 07, 10, 11, 12 (each slice owns its own call); in-app/push notifications; any HTTP endpoint (none exists for notifications); notifications for `USER_UPDATED` / `USER_DEACTIVATED` (none).

## 3. Dependencies
SLICE-08 (`enqueueOutbox`, the `notifications` queue, retry/DLQ policy, configuration module; `appendAuditEvent` and the audit enum values created there), SLICE-01/02 (existing identity and service/policy code, for the retrofit). This slice does **not** depend on SLICE-04/05: it reads incident, service, policy and user rows by id with its own queries.
**Implementation order consequence:** SLICE-03, 04, 05, 07, 10, 11 and 12 call `enqueueNotification`, so this slice must be implemented **before** them (recommended order: … → 08 → 06 → 09 → 03 → 04 → 05 → 07 → 10 → 11 → 12).
**Not specified by the design:** which email provider to use. Implement the `EmailProvider` interface plus a fake for tests; for the real adapter use the provider named in the repository's architecture/configuration, and if none is named stop per `AGENTS.md` §13.

## 4. Capability Behavior

### 4.1 Producer contract
`enqueueNotification(tx, input)` is called **inside the producer's transaction** (never opens or commits one, never calls Redis/email):

```
input = {
  eventType,            // notification event type (catalog below)
  occurrenceId,         // what makes this occurrence unique (see key rule)
  incidentId?, serviceId?, teamId?, alertSourceId?,
  subjectUserId?        // the specific user some rules name (assignee, investigation requester)
}
returns { notificationId: string | null, created: boolean }
```

Steps: (1) resolve the recipients **now** (§4.3) using `tx`; (2) derive the idempotency key; (3) insert the `Notification` (`REQUESTED`, `notificationType`, `eventType`, `recipients`, `incidentId`) — on a unique-key conflict do nothing and return `created = false` (the occurrence was already recorded); (4) when created and at least one recipient exists, write `NOTIFICATION_REQUESTED { notificationId, requestId }` through `enqueueOutbox`. If no active recipient resolves, the row is inserted as `FAILED` (`providerResponse` reason `NO_RECIPIENTS`), no outbox event is written, and it is logged. The notification and its outbox event commit atomically with the producer's change; a rolled-back producer leaves neither.

**Idempotency key** = `<eventType>:<entityId>:<occurrenceId>` where `entityId` is the incident id (or team / service / alert-source id when there is no incident). `occurrenceId` is the **audit event id** for audit-backed events (so a second `ASSIGNED` or a later `TEAM_UPDATED` is a new notification, not suppressed), the **milestone name** for SLICE-07 events (`RESPONSE_WARNING`, `RESOLUTION_WARNING`, `RESPONSE_BREACH`, `RESOLUTION_BREACH`, `ESCALATION_LEVEL_n`, `ESCALATION_FAILURE_n` — a deterministic identity, which is what gives SLICE-07 its database-enforced once-only guarantee), the **outbox event id of the failed generation request** for `POSTMORTEM_GENERATION_FAILED`, and the **block-window identity** (chosen by SLICE-03 for `ALERT_SOURCE_BLOCKED`, by SLICE-12 for `INVESTIGATION_REQUEST_BLOCKED`). To get the audit event id, `appendAuditEvent` returns the created event's id.

### 4.2 Event catalog (`eventType` → notification type)
| Type | Event types |
|---|---|
| `INFO` | `AI_TRIAGE_COMPLETED`, `POSTMORTEM_GENERATED`, `POSTMORTEM_REVIEWED`, `AI_INVESTIGATION_COMPLETED`, `TEAM_UPDATED`, `TEAM_DEACTIVATED`, `SERVICE_UPDATED`, `SERVICE_DEACTIVATED` |
| `WARNING` | `SLA_WARNING`, `ESCALATED_L1`, `ESCALATED_L2`, `ESCALATED_L3`, `ESCALATED_L4`, `POSTMORTEM_GENERATION_FAILED` |
| `ALERT` | `INCIDENT_CREATED`, `ASSIGNED`, `REASSIGNED`, `OPEN`, `ACKNOWLEDGED`, `SEVERITY_CONFIRMED`, `SOURCE_ALERT_RESOLVED`, `RESOLVED`, `CLOSED`, `ESCALATION_POLICY_UPDATED`, `RESPONSE_BREACH`, `RESOLUTION_BREACH`, `ESCALATION_FAILED`, `ALERT_SOURCE_BLOCKED`, `INVESTIGATION_REQUEST_BLOCKED` |

The first 20 audit-backed types follow the design's event list; the last six non-audit events (`RESPONSE_BREACH`, `RESOLUTION_BREACH`, `ESCALATION_FAILED`, `ALERT_SOURCE_BLOCKED`, `INVESTIGATION_REQUEST_BLOCKED`, `POSTMORTEM_GENERATION_FAILED`) have the types shown. One notification is produced per notifying event (an acknowledge that auto-assigns produces an `ASSIGNED` and an `ACKNOWLEDGED` notification). Comments, duplicates (`ALERT_DUPLICATE`), `ALERT_RECEIVED`, `COMMENT_ADDED`, `NOTIFIED`, and `USER_*` events produce none.

### 4.3 Recipient resolution (at enqueue time; ACTIVE users only; de-duplicated)
Definitions: **team members** = active users whose `teamId` is the incident's/service's team; **level3** = the service escalation policy's `level3`; **fallbackAdmin** = that policy's `fallbackAdmin`.
| Event types | Recipients |
|---|---|
| `INCIDENT_CREATED`, `ACKNOWLEDGED`, `SEVERITY_CONFIRMED`, `SLA_WARNING`, `ESCALATED_L1`–`L4`, `SOURCE_ALERT_RESOLVED`, `RESOLVED`, `CLOSED`, `REASSIGNED`, `OPEN`, `RESPONSE_BREACH`, `RESOLUTION_BREACH`, `ESCALATION_FAILED` | team members ∪ fallbackAdmin |
| `ASSIGNED` | `subjectUserId` (the assignee) ∪ level3 ∪ fallbackAdmin |
| `AI_TRIAGE_COMPLETED` | level3 ∪ fallbackAdmin |
| `POSTMORTEM_GENERATED`, `POSTMORTEM_REVIEWED` | the incident's `resolvedBy` ∪ level3 ∪ fallbackAdmin |
| `AI_INVESTIGATION_COMPLETED` | `subjectUserId` (the requester) ∪ level3 ∪ fallbackAdmin |
| `POSTMORTEM_GENERATION_FAILED` | the incident's `resolvedBy` ∪ level3 |
| `TEAM_UPDATED`, `TEAM_DEACTIVATED` | team members of `teamId` (**no** fallback admin) |
| `SERVICE_UPDATED`, `SERVICE_DEACTIVATED`, `ESCALATION_POLICY_UPDATED` | team members of the service's team ∪ that service's fallbackAdmin |
| `ALERT_SOURCE_BLOCKED`, `INVESTIGATION_REQUEST_BLOCKED` | all active Admins |
For team deactivation the recipients are resolved before the team's users are detached. The recipient list is stored on the `Notification` row; email addresses are looked up at send time and never stored.

### 4.4 Delivery worker (`NOTIFICATION_REQUESTED { notificationId }`)
1. Load the row. `COMPLETED` → no-op.
2. Claim with a conditional update `REQUESTED → RUNNING` (also re-claimable from `RUNNING` when its `lastAttemptTimestamp` is older than the processing window from the SLICE-08 configuration, i.e. a crashed attempt); set `lastAttemptTimestamp`.
3. Send **one** email to all recipients through `EmailProvider` (pass the idempotency key when the provider supports it). Rendering uses one template table keyed by `eventType`.
4. Success: in one transaction set `COMPLETED`, `attemptCount + 1`, sanitized `providerResponse`, and — for incident-scoped notifications — append audit `NOTIFIED { recipients: UserSummary[] }` (actor `null`). Admin/team/service/source notifications write no `NOTIFIED`.
5. Failure: `attemptCount + 1`, `lastAttemptTimestamp`, sanitized `providerResponse`; a **retryable** error sets the row back to `REQUESTED` and rethrows to the SLICE-08 retry policy (5 attempts, exponential backoff); a **non-retryable** error or exhausted attempts sets `FAILED` and the outbox row ends `DEAD_LETTER` (SLICE-08). Failures write no audit event. Notification failure never changes incident state.
6. At-least-once: a crash after the provider send can duplicate an email; this is documented and accepted.

### 4.5 Statuses
`REQUESTED` (record exists, delivery pending or awaiting retry) → `RUNNING` → `COMPLETED` | `FAILED`.

### 4.6 Migration (changes the current schema)
`Notification.deliveryStatus` currently uses the shared `LifecycleStates` enum (also used by `AITriage.failureStatus` and `OutboxEvent`). Do **not** alter it. Create `NotificationDeliveryStatus { REQUESTED, RUNNING, COMPLETED, FAILED }`, move the column to it (default `REQUESTED`; existing rows `PENDING→REQUESTED`, `SUCCESS→COMPLETED`, `FAILED→FAILED`), and add `eventType` (string, required). Keep the unique `idempotencyKey`, `recipients uuid[]`, `attemptCount`, `lastAttemptTimestamp`, `providerResponse`, `incidentId?`. Review the SQL; it must apply from an empty database and over existing rows.

### 4.7 Module boundary
Add the module `notifications` and a lint rule letting **every module** import it only through its `index.ts` (like `identity`). The notifications module itself depends only on `shared` and `infra` and reads other tables with its own repository queries; it never imports another module.

### 4.8 Admin notice (SLICE-03)
`ALERT_SOURCE_BLOCKED` is produced by SLICE-03's webhook gate through `enqueueNotification` (no incident; recipients all active Admins).

### 4.9 Retrofit of the implemented SLICE-01/SLICE-02 endpoints
SLICE-01/02 are not modified as specifications. After the audit event added in SLICE-08 §4.11, and in the same transaction, call `enqueueNotification` with `occurrenceId` = the audit event's id:
| Endpoint | `eventType` | Context ids |
|---|---|---|
| T4 team update | `TEAM_UPDATED` or `TEAM_DEACTIVATED` (same rule as the audit event) | `teamId` |
| S4 service update | `SERVICE_UPDATED` or `SERVICE_DEACTIVATED` | `serviceId` |
| S7 policy update | `ESCALATION_POLICY_UPDATED` | `serviceId` |
No notification for U4/users, creates, reads, no-op requests (no audit event ⇒ none), or failed requests. For T4 the call (and the audit append) must come **before** `detachUsersFromTeam`, so recipients are the team's members at the time of the change. No response, status code or error behavior changes.

## 5. Domain & Data Context
`Notification` after migration: `id`, `deliveryStatus` (`NotificationDeliveryStatus`), `notificationType` (`INFO|WARNING|ALERT`), `eventType` string, `attemptCount?`, `lastAttemptTimestamp?`, `providerResponse Json?`, `idempotencyKey` unique, `recipients uuid[]`, `incidentId?`, `createdAt`; index `(incidentId, deliveryStatus)`. Invariants: one row per notifying occurrence (key-enforced in the database); durable before delivery; attempts and outcomes recorded; failure never blocks a business action.

## 6. API Contract
None. No notification endpoint exists.

## 7. Authorization & Security
Worker/contract only. Recipients are computed server-side from stored data, never from request input. Email addresses and provider credentials are never logged or stored in `providerResponse`; credentials come from configuration.

## 8. Consistency & Concurrency
Producer-side: the `Notification` insert and its outbox event share the producer's transaction; the unique `idempotencyKey` decides duplicate occurrences race-safely (SLICE-07 relies on this for once-only milestones). Worker-side: conditional claim + `COMPLETED` guard; the `COMPLETED` update and `NOTIFIED` audit event commit together.

## 9. Async / Events / Workers
Consumes `NOTIFICATION_REQUESTED` on the `notifications` queue under the SLICE-08 reliability policy. Produces audit `NOTIFIED`. External effect: the email provider only (abstraction; faked in tests).

## 10. Failure & Recovery
Provider outage: attempts recorded, backoff retries, then `FAILED`; business operations unaffected. DB failure on the record update: retry (a duplicate email is possible and accepted). Redis outage: the outbox accumulates and drains later. No recipients: `FAILED` row, logged, no email.

## 11. Implementation Surface
`src/modules/notifications` (contract, catalog constants, recipient resolver, key derivation, repository, worker processor, `EmailProvider` + fake, templates), `appendAuditEvent` returning the event id (change in `src/infra/audit`), migration, lint boundary rule, worker registration, and the §4.9 changes in the identity/appService services. Tests: unit (key derivation, catalog, recipient rules), integration (PostgreSQL + fake provider + queue).

## 12. Verification Requirements
- Every catalog row: correct `notificationType`, recipients exactly per §4.3 (active only, de-duplicated; `TEAM_*` without the fallback admin; `ASSIGNED` = assignee + level3 + fallback; etc.), recipients resolved at enqueue time (a later change to users does not alter a stored row; team deactivation uses pre-detach members).
- Contract: row + outbox event commit with the producer; rollback leaves neither; same occurrence twice → `created = false`, one row; two different `ASSIGNED` occurrences → two rows; no recipients → `FAILED` row, no outbox event.
- Worker: `REQUESTED→RUNNING→COMPLETED` with attempts recorded and `NOTIFIED` (incident-scoped only); provider failure → back to `REQUESTED` and retried, exhaustion → `FAILED` + `DEAD_LETTER`; parallel/duplicate jobs → one send; crashed `RUNNING` row re-claimed after the window; `COMPLETED` → no-op; no secrets/emails in logs.
- Migration applies from empty and over existing rows; `LifecycleStates` untouched; `AITriage` and outbox unaffected.
- Retrofit: T4/S4/S7 each create exactly one notification per effective change (type and recipients per catalog), none for no-ops/failed requests/U4, atomically with the change; existing SLICE-01/02 tests unchanged and passing.
- Boundary lint: any module can import `notifications` through `index.ts`; deep imports are rejected.

## 13. Completion Criteria
- The contract, catalog, recipient rules, worker, migration, module boundary rule and retrofit work as specified; producers in later slices can call `enqueueNotification` unchanged.
- Idempotency, atomicity, retry/DLQ behavior verified; no business action blocked by a notification failure.
- Tests pass; typecheck/lint/format clean on touched files.
