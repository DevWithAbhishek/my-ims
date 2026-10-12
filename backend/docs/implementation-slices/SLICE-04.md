# SLICE-04 — Alert Ingestion, Deduplication & Incident Creation

## 1. Purpose
For each alert delivered through the webhook (after the trust gate), normalize it, determine its identity, deduplicate, and persist Alert + Incident + audit events + outbox events atomically. Owns the `∅ → OPEN` incident transition and the per-alert result reporting of `POST /webhooks/alerts/:alertSourceId`.

## 2. Scope
### In Scope
Per-alert processing (step 7 of the webhook pipeline), `CommonAlertInputDto` validation and normalization, identity and active-identity-key deduplication, source-resolved deliveries, initial severity, incident creation, response assembly (`AlertIngestResponse`), the migration for alert lookup indexes, `GET /incidents/:incidentId/alerts/:alertId` (I12).
### Out of Scope
Signature/replay/rate-limit/envelope checks (SLICE-03); incident lifecycle transitions and clearing of active keys on resolve (SLICE-05); AI triage execution (SLICE-10); notification delivery (SLICE-09); real source-specific adapters (only the `GENERIC` common format exists); any API to edit the source-severity mapping (there is no AlertSource CRUD; the mapping is seeded in `AlertSource.configuration` by SLICE-03).

## 3. Dependencies
From SLICE-03: verified context `{ alertSource (including `configuration`), items[], rateLimitedIndices }`. From SLICE-02: service config read (`status`, `teamId`, `defaultSeverity`). From SLICE-01: guard/team helpers (I12 only). In-transaction contracts: **audit append** `appendAuditEvent(tx, { incidentId, eventType, actorId | null, metadata })` (store/shape owned by SLICE-06) and **outbox write** `enqueueOutbox(tx, { eventType, aggregateType, aggregateId, payload, availableAt? })` (owned by SLICE-08). If either does not exist yet, create only the minimal function with that signature in its owning location and report it. Outbox event types come from the repo-wide catalog (`AGENTS.md` §8; routing by SLICE-08).

## 4. Capability Behavior
**Per-alert independence.** Each alert in the batch is validated, identified, deduplicated and persisted in **its own transaction**; one alert's rejection never affects its siblings. Process alerts in request order (so two same-identity alerts in one batch resolve deterministically: first creates, second is a duplicate).

**Normalization (`CommonAlertInputDto`, the `GENERIC` wire format).**

| Field | Type | Req. | Validation |
|---|---|---|---|
| `sourceEventId` | string | no | 1–200 |
| `sourceFingerprint` | string | no | 1–200 |
| `name` | string | no | ≤200 |
| `serviceId` | uuid | yes | must exist and be `ACTIVE` |
| `environment` | string | yes | ≤100 |
| `sourceSeverity` | string | no | ≤50 |
| `summary` | string | no | ≤500 |
| `description` | string | no | ≤10,000 |
| `labels` | string[] | no | ≤50 items, each ≤200, `key=value` form |
| `additionalDetails` | string | no | ≤10,000 |
| `status` | `FIRING\|RESOLVED` | no | default `FIRING` |
| `startedAt` | datetime | yes | ISO 8601 |
| `endedAt` | datetime | no | ≥ `startedAt` |
| `sourceUrl` | string | no | valid URL, ≤2,000 |

Each alert's own JSON element is stored verbatim as `originalPayload` (never a re-serialization of the normalized form). An item failing validation → `REJECTED`, code `ALERT_INVALID`.

**Identity** (precedence): `sourceEventId`; else `sourceFingerprint`; else a deterministic fingerprint of `serviceId + name + environment + sorted labels` (stored in `sourceFingerprint`) — never a hash of the whole payload. If none of the first two is present and the derived fingerprint cannot be formed (neither `name` nor any `labels` present), the item is `REJECTED` with `IDENTITY_UNRESOLVABLE`.

**Active identity key & dedup.** While an alert's incident is unresolved (`OPEN`, `ACKNOWLEDGED`, `MITIGATING`) the alert carries `activeIdentityKey`, a deterministic function of its identity (namespace the kind so an event id can never collide with a fingerprint). `(alertSourceId, activeIdentityKey)` is unique in the database. A `FIRING` delivery whose identity matches an alert with an active key is a `DUPLICATE`: no second alert row, no second incident; audit `ALERT_DUPLICATE { alertSourceId }` is written on the existing incident. SLICE-05 clears the key on every alert of the incident when it becomes `RESOLVED`, so a later `FIRING` delivery of the same identity creates a **new** incident. The database unique key — not read-then-insert — resolves concurrent deliveries: a unique-violation loser (its transaction rolled back) is re-handled as `DUPLICATE` in a new transaction.

**Source-resolved deliveries** (`status = RESOLVED`): never create an incident. Look up the **most recent** alert with the same identity by `sourceEventId` / `sourceFingerprint` (including a derived fingerprint) — not by the active key, which may already be cleared. If found: set `sourceStatus = RESOLVED` and `endedTimestamp` (from `endedAt` when provided) on it, write audit `SOURCE_ALERT_RESOLVED { alertId }` on its incident, outcome `SOURCE_RESOLVED_RECORDED`; the incident status and the active key are unchanged. Re-delivery for an alert already recorded as resolved yields the same outcome and no extra audit event. If none exists → `REJECTED`, code `ALERT_INVALID`.

**Rejections before persistence.** Unknown `serviceId` → `UNKNOWN_SERVICE`; service `DEACTIVATED` → `SERVICE_DEACTIVATED`; items beyond rate-limit capacity (from SLICE-03) → `RATE_LIMITED`. Nothing is stored for rejected items.

**Initial severity (source severity → P0–P3).** The mapping is stored **per source** in `AlertSource.configuration.severityMapping` (an object from source-severity string to `P0..P3`), seeded by SLICE-03 with `critical → P0`, `high → P1`, `warning → P2`, `info → P3`. The alert's `sourceSeverity` is normalized (case-insensitive; matching is otherwise exact) and looked up in that source's mapping. If the value is unrecognized, **or `sourceSeverity` is absent**, the incident falls back to the service's `defaultSeverity`. The result is the alert's `initialSeverity` and the new incident's `severity`. The raw `sourceSeverity` string is stored unchanged and separate from the incident severity. An unrecognized or absent value is not an error and does not reject the alert. A source whose configuration contains no mapping behaves as if every value were unrecognized.

**Creation (outcome `INCIDENT_CREATED`).** One transaction: insert `Incident` (`status OPEN`, `severity` = initial severity, `teamId` = the service's team, `affectedServiceId`, `title`, `description`), insert `Alert` (all normalized fields, `originalPayload`, `activeIdentityKey`, `sourceStatus FIRING`, `incidentId`, `initialSeverity`), append audit `INCIDENT_CREATED { incidentId }` then `ALERT_RECEIVED { alertId }` (actor `null`), and write the two **mandatory** outbox events in the same transaction: `ALERT_TRIAGE_REQUESTED { alertId, incidentId }` (queue `ai-triage`) and `SLA_EVALUATION_REQUESTED { incidentId }` (queue `sla-escalation`), each with the originating `requestId` in the payload. No incident-created notification exists: ingestion writes no `NOTIFICATION_REQUESTED`. Success is never reported before commit; no LLM/email call and no direct queue publish occurs here. **Incident title/description.** `Incident.title` = the alert's `name`; if `name` is absent, `title` = the alert's `summary`; if both are absent the alert is `REJECTED` with `ALERT_INVALID` and nothing is stored. `Incident.description` = the alert's `description` and `summary` joined by a blank line (`\n\n`), skipping any part that is absent (if both are absent, `description` is an empty string; the column is non-null, not non-empty). This rule applies only when an incident would be created: it is evaluated after identity and deduplication, so a `DUPLICATE` or a source-`RESOLVED` delivery is never rejected for a missing `name`/`summary`.

**NFR.** An accepted alert is persisted within 5 s (excluding async work).

## 5. Domain & Data Context
`Alert`: `id`, `sourceEventId?`, `sourceFingerprint?`, `name?`, `environment` (req.), `sourceSeverity?`, `initialSeverity?` (`P0..P3`), `summary?`, `description?`, `labels String[]`, `additionalDetails?`, `startedTimestamp` (req.), `endedTimestamp?`, `sourceUrl?`, `originalPayload Json` (req.), `activeIdentityKey?`, `sourceStatus` (`FIRING|RESOLVED`, default `FIRING`), `alertSourceId` FK (req.), `affectedServiceId` FK→AppService (req.), `incidentId?` FK→Incident (nullable in the DB; the application guarantees every **accepted** alert has exactly one incident), timestamps. Constraints/indexes: unique `(alertSourceId, activeIdentityKey)` (nullable key; NULLs do not collide), index `sourceUrl`. **Migration required** (not yet present): non-unique lookup indexes on `(alertSourceId, sourceEventId)` and `(alertSourceId, sourceFingerprint)`.
`Incident` (creation fields): `id`, `title`, `description` (non-null), `status` default `OPEN`, `severity` (non-null), `affectedServiceId` + `teamId` (composite FK to `AppService(id, teamId)`), timestamps; assignee/ack/resolve/close columns remain `NULL`.
Invariants: at most one unresolved incident per `(alertSourceId, identity)`; an incident belongs to exactly one team and service; original payload preserved separately from normalized fields; source alert state is separate from incident state; AI never blocks persistence.

## 6. API Contract
**W1 `POST /webhooks/alerts/:alertSourceId`** — request-level behavior in SLICE-03. Response (`AlertIngestResponse`): `{ "data": { "results": AlertIngestResult[] } }`, same order as input.
`AlertIngestResult { index: int, outcome: "INCIDENT_CREATED" | "DUPLICATE" | "SOURCE_RESOLVED_RECORDED" | "REJECTED", alertId: uuid|null, incidentId: uuid|null, error: { code, message } | null }` (`error` only when `REJECTED`; for `DUPLICATE` and `SOURCE_RESOLVED_RECORDED` the ids are those of the existing alert and its incident; for `REJECTED` both are `null`). Item error codes: `ALERT_INVALID`, `UNKNOWN_SERVICE`, `IDENTITY_UNRESOLVABLE`, `SERVICE_DEACTIVATED`, `RATE_LIMITED` (item-level only, never an HTTP status here).
Status: `200 OK` when the request is authentic and well-formed and **at least one** alert was not rejected; `400` with the **same `{ data: { results } }` body** when **every** alert was rejected. Idempotency: alert identity (no `Idempotency-Key`); same alert again → `200` with `DUPLICATE` and the same `incidentId`. Infrastructure failure on any item → `503 DEPENDENCY_UNAVAILABLE` with `Retry-After` (already-committed items become `DUPLICATE` when the sender retries) or `500 INTERNAL_ERROR`.

**I12 `GET /incidents/:incidentId/alerts/:alertId`** — Bearer, all roles, team gate. `200 AlertDetailResponse`. Errors: `422` (malformed ids), `401`, `403 TEAM_ACCESS_DENIED`, `403 INVALID_ACTION` (`teamId = null`), `404 INCIDENT_NOT_FOUND`, `404 ALERT_NOT_FOUND` (also when the alert belongs to another incident).
`AlertDetailResponse` = `AlertSummary` + `sourceEventId`, `sourceFingerprint`, `summary`, `description`, `labels: string[]`, `additionalDetails`, `originalPayload` (verbatim stored JSON). `AlertSummary` = `{ id, name, environment, sourceSeverity, initialSeverity, sourceStatus, startedAt, endedAt, sourceUrl, alertSource: { id, name } }` (`originalPayload` excluded). Absent nullable fields are `null`. API names map to schema names (`startedAt ↔ startedTimestamp`, `endedAt ↔ endedTimestamp`).

## 7. Authorization & Security
Webhook: source authentication only (SLICE-03); the incident's team is derived alert → service → team and cannot be chosen by the caller. I12: Gate order per `AGENTS.md` §6. Signing secrets are never present in stored payloads, logs or audit metadata (the secret is not part of an alert body); do not log full alert payloads.

## 8. Consistency & Concurrency
Per alert, one transaction creates Alert + Incident + audit + outbox; any failure rolls back all of them (no incident without its outbox row). The partial guarantee is the DB unique `(alertSourceId, activeIdentityKey)`. Two simultaneous deliveries of the same identity produce exactly one incident and one `DUPLICATE`. A unique violation aborts the PostgreSQL transaction; re-handle the loser in a new transaction (or a savepoint).

## 9. Async / Events / Workers
Produces only outbox rows (no queue publish), and only on incident creation: `ALERT_TRIAGE_REQUESTED` and `SLA_EVALUATION_REQUESTED` (both mandatory, same transaction as the Alert and Incident). `ALERT_DUPLICATE` and source-resolved handling write audit events only. Consumers are idempotent (SLICE-08 relay, SLICE-07/10 workers). Audit events written here: `INCIDENT_CREATED`, `ALERT_RECEIVED`, `ALERT_DUPLICATE`, `SOURCE_ALERT_RESOLVED`.

## 10. Failure & Recovery
AI, Redis queue, or email outage never prevents persistence (commit precedes all external calls; the relay publishes later). Database failure rolls back the item and surfaces as `503/500` at request level. Invalid items are reported per item; the request still succeeds if any item was accepted.

## 11. Implementation Surface
Application: Alerts module (ingestion service, normalizer, identity/fingerprint service, repository with the transactional create/dedup/resolve paths), Incident repository's create function (Incident module public interface), controller for I12. Database: migration adding the two lookup indexes. Tests: unit (normalization, fingerprint determinism and stability under non-identity field changes, key namespace), integration (PostgreSQL).

## 12. Verification Requirements
- Valid alert → `INCIDENT_CREATED`, incident `OPEN` with default severity, correct team/service, `originalPayload` byte-for-byte equal to the delivered element, both audit events in order, both outbox rows present, all in one commit.
- Severity mapping read from the source's `configuration.severityMapping`: `critical`→`P0`, `high`→`P1`, `warning`→`P2`, `info`→`P3`; case-insensitive (`"Critical"` → `P0`); a custom mapping on another source is honored; an unrecognized or absent `sourceSeverity`, or a source with no mapping, yields the service `defaultSeverity`; the raw `sourceSeverity` is stored unchanged.
- Created incident: `title` = `name`; `title` = `summary` when `name` is absent; both absent → `REJECTED` `ALERT_INVALID`, nothing stored; `description` = `description` + blank line + `summary`, absent parts skipped; a `DUPLICATE`/source-resolved delivery without `name`/`summary` is not rejected.
- Outbox on creation: exactly `ALERT_TRIAGE_REQUESTED` and `SLA_EVALUATION_REQUESTED` rows (with `requestId`) in the same commit; no `NOTIFICATION_REQUESTED`; none for duplicates.
- Duplicate (event-id and fingerprint and derived-fingerprint paths) → `DUPLICATE`, no new rows besides audit `ALERT_DUPLICATE`; fingerprint stable when non-identity fields change.
- Concurrent identical deliveries → one incident; loser reported `DUPLICATE`.
- After the incident is resolved (key cleared) a new `FIRING` delivery creates a new incident.
- `RESOLVED` delivery: recorded on latest alert, incident status/key unchanged, no incident created; no prior alert → `ALERT_INVALID`.
- Mixed batch: independent outcomes in order; all-rejected batch → `400` with the same body shape; rate-limited tail items → `RATE_LIMITED`.
- Unknown/deactivated service, bad fields, unresolvable identity rejections store nothing.
- Fault injection: failure after Alert insert but before commit leaves no Alert/Incident/outbox.
- I12 authorization matrix, cross-team, wrong-incident alert, `originalPayload` only in I12.

## 13. Completion Criteria
- Ingestion behaves per §4 for all four outcomes and all rejection codes; the response status and body follow §6.
- Initial severity follows the per-source `severityMapping` (case-insensitive) with service-default fallback; incident `title` and `description` are derived as specified; creation writes exactly the two mandatory outbox events and no notification.
- The create transaction is atomic; DB unique key enforces dedup; migration with lookup indexes applies cleanly.
- I12 works with the stated errors; no async/external call occurs inside request or transaction.
- Tests above pass; typecheck/lint/format clean on touched files; existing behavior intact.
