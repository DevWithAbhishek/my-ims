# SLICE-06 — Incident Visibility, Comments & Timeline

## 1. Purpose
Give team members team-scoped read access to incidents (feed and detail), let them add comments, and expose the append-only audit history as the incident timeline. Owns the audit store and the in-transaction audit-append contract that every producing slice calls.

## 2. Scope
### In Scope
I1 incident list, I2 incident detail, I10 comment action, I11 timeline, P1 is **not** here; the audit-event store (including coverage of security-relevant administrative actions, §4), `appendAuditEvent` contract, timeline item mapping/whitelisting, `IncidentListItem`/`IncidentDetailResponse` assembly (including `aiTriage` read).
### Out of Scope
Lifecycle/assignment actions (SLICE-05), alert detail I12 (SLICE-04), postmortem endpoints (SLICE-11), investigations (SLICE-12), AI triage production (SLICE-10), any endpoint that writes audit events directly (none exists).

## 3. Dependencies
SLICE-01 guard/helpers. SLICE-02 service SLA config (to compute `SlaStatus`). Shares route `PATCH /incidents/:incidentId` with SLICE-05: whichever slice is implemented first creates the dispatcher skeleton (route, strict body parsing, exactly-one-row matching, shared gates); the other adds its rows. This slice contributes the `comment` row. Reads `AITriage` (written by SLICE-10) via the latest accepted alert.

## 4. Capability Behavior

**Team scope.** Every endpoint applies the caller's `teamId` claim: another team's incident → `403 TEAM_ACCESS_DENIED`; unknown id → `404 INCIDENT_NOT_FOUND`; `teamId = null` → `403 INVALID_ACTION`; malformed id → `422 VALIDATION_FAILED`. All roles may read.

**I1 incident feed.** The caller's own team only (no `teamId` parameter exists). Filters: `status` (comma list of statuses), `severity` (comma list), `serviceId` (a service outside the caller's team returns an empty list, not `403`), `assigneeId`. Cursor pagination; default order `severity` asc with `id` tie-breaker in the same direction as `sort`. Cursor is opaque base64url of the last row's sort value + `id`, **not signed** (team scope re-applied each request), bound to the `orderBy`/`sort` it was issued under; reusing it with changed filters is undefined behavior (not detected). Undecodable or wrong-shape cursor → `422 INVALID_CURSOR`. Ordering by a mutable column can skip/repeat rows while paging; `createdAt` is stable. `orderBy=teamId` has no effect (always the caller's team).

**I2 detail.** Everything a responder needs: `IncidentResponse` plus `alerts: AlertSummary[]` and `aiTriage`. `aiTriage` is derived from the **latest accepted alert's** `AITriage` record: no record or `failureStatus = PENDING` → `PENDING`; `SUCCESS` → `COMPLETED`; `FAILED` → `UNAVAILABLE`. Fields: `category`, `suggestedSeverity`, `confidence` (0–1), `evidence: { type, reference, excerpt }[]` (the stored structured evidence only), `reasoningSummary` (stored `reasoning`), `model`, `modelVersion`, `generatedAt`. Always present; while `PENDING` or `UNAVAILABLE` all values `null` and `evidence: []`. The internal triage `summary` and raw model output are never exposed. The suggestion is advisory and never changes state.

**I10 comment** (via the dispatcher; row `{ "comment": { "title"?, "body" } }`, `title` ≤200, `body` trimmed 1–10,000). All roles of the incident's team; allowed in any incident status **except `CLOSED`** (`409 INVALID_STATE_TRANSITION`). The author is the caller (never sent). One transaction: insert `Comment` + audit `COMMENT_ADDED { comment }`. `201 Created`, `data: CommentResponse`. No idempotency (a retry creates a second comment); no notification. Errors: the common PATCH errors (`401`, `403 FORBIDDEN_ROLE` n/a, `403 TEAM_ACCESS_DENIED`, `403 INVALID_ACTION`, `404`, `409`, `422`, `400`, `500`, `503`).

**I11 timeline.** Append-only history, read-only for every role; no endpoint writes audit events. Offset pagination, `orderBy=createdAt`, `sort` default `asc`, tie-breaker `id`.

**Audit append contract (provided to all slices).** `appendAuditEvent(tx, { incidentId | null, eventType, actorId | null, metadata })` — lives in `src/infra/audit/` (created by SLICE-08) and must run on the caller's transaction handle; the store is append-only (no update/delete code paths). Events written by one command appear in the order written; each gets a slightly later `createdAt` than the previous one in the same transaction. The event type must be one of the schema enum values. `metadata` holds what is needed to build the public `details`; raw metadata is never exposed.

**Administrative audit events (non-incident actions).** The audit store also records security-relevant administrative actions. Eight event types are added to `AuditEventType`. Because SLICE-08 runs before this slice, **SLICE-08 already created** the enum migration and the minimal `appendAuditEvent` (in `src/infra/audit/`); this slice verifies and extends them (it must not recreate them) and owns the store's reads and timeline:

| Event type | Written when | Written by |
|---|---|---|
| `USER_UPDATED` | a User is updated (U4) without being deactivated | SLICE-08 (retrofit of SLICE-01 endpoint) |
| `USER_DEACTIVATED` | U4 sets a User's `status` to `DEACTIVATED` | SLICE-08 (retrofit of SLICE-01 endpoint) |
| `TEAM_UPDATED` | a Team is updated (T4) without being deactivated | SLICE-08 (retrofit of SLICE-01 endpoint) |
| `TEAM_DEACTIVATED` | T4 sets a Team's `status` to `DEACTIVATED` | SLICE-08 (retrofit of SLICE-01 endpoint) |
| `SERVICE_UPDATED` | a Service is updated (S4) without being deactivated | SLICE-08 (retrofit of SLICE-02 endpoint) |
| `SERVICE_DEACTIVATED` | S4 sets a Service's `status` to `DEACTIVATED` | SLICE-08 (retrofit of SLICE-02 endpoint) |
| `ESCALATION_POLICY_UPDATED` | an Escalation Policy is updated (S7) | SLICE-08 (retrofit of SLICE-02 endpoint) |
| `ALERT_SOURCE_UPDATED` | an existing AlertSource's configuration is changed **out-of-band through the seed script** (there is no AlertSource endpoint) | SLICE-03 |

Rules: **updates and deactivations only** — no events for creates, reads, logins or any other action. An Escalation Policy has no `status`, so only update applies to it. Each event is written through `appendAuditEvent` in the **same transaction** as the change; `incidentId = null`; `actor` is the acting Admin (the seed script writes `ALERT_SOURCE_UPDATED` with a `null` actor). `metadata` lists the entity id and the names of the changed fields only — never values, and never passwords, hashes, tokens or signing secrets. These events are not incident-scoped, so they never appear in the incident timeline (I11 is per incident) and the API exposes no endpoint that reads them. The audit writes in the existing SLICE-01 and SLICE-02 endpoints (T4, U4, S4, S7) are added by SLICE-08 as a retrofit (SLICE-01 and SLICE-02 are not modified); the seed-script write belongs to SLICE-03. The enum migration and the minimal `appendAuditEvent` were created by SLICE-08; this slice owns the store's reads and timeline and verifies the append contract.

**Timeline whitelist.** `TimelineItem = { id, eventType, actor: UserSummary|null (null = system/worker), details: object, createdAt }`. `details` per event type:

| eventType | `details` |
|---|---|
| `ALERT_RECEIVED` | `{ alertId }` |
| `ALERT_DUPLICATE` | `{ alertSourceId }` |
| `AI_TRIAGE_COMPLETED` | `{ createdAt }` |
| `INCIDENT_CREATED` | `{ incidentId }` |
| `ASSIGNED` | `{ from, to, auto }` (`UserSummary\|null` each, boolean) |
| `REASSIGNED` | `{ from, to }` (`UserSummary\|null` each) |
| `OPEN` | `{ statusFrom }` |
| `ACKNOWLEDGED` | `{ acknowledgedBy: uuid, autoAssigned: boolean }` |
| `SEVERITY_CONFIRMED` | `{ from, to, statusFrom, statusTo }` |
| `COMMENT_ADDED` | `{ comment: CommentResponse }` |
| `SLA_WARNING` | `{ kind: "RESPONSE"\|"RESOLUTION" }` |
| `ESCALATED_L1`…`ESCALATED_L4` | `{ notifiedUser: UserSummary }` |
| `SOURCE_ALERT_RESOLVED` | `{ alertId }` |
| `RESOLVED` | `{ resolutionSummary, serviceConfirmedWorking }` |
| `NOTIFIED` | `{ recipients: UserSummary[] }` |
| `POSTMORTEM_GENERATED` | `{ postmortemId }` |
| `POSTMORTEM_REVIEWED` | `{ postmortemId, reviewedBy: UserSummary }` |
| `AI_INVESTIGATION_COMPLETED` | `{ investigationId }` |
| `CLOSED` | `{ closedAt }` |

`UserSummary = { id, name }` is resolved at read time from stored ids. The API timeline `eventType` vocabulary is the 22 incident event values above. The schema `AuditEventType` enum also contains the 8 administrative values; they are never returned by the API.

## 5. Domain & Data Context
`Comment`: `id`, `title?`, `description` (API `body`), `incidentId` FK, `authorId` FK→User, timestamps; index `(incidentId, authorId)`.
`AuditEvent`: `id`, `eventType` (enum), `actor uuid?` (no FK; `null` = system), `metadata Json?`, `incidentId uuid?` FK (nullable, so administrative events need no incident), `createdAt`; index `(incidentId, eventType, actor)`. `AuditEventType` currently has the 22 incident values; this slice adds `USER_UPDATED`, `USER_DEACTIVATED`, `TEAM_UPDATED`, `TEAM_DEACTIVATED`, `SERVICE_UPDATED`, `SERVICE_DEACTIVATED`, `ESCALATION_POLICY_UPDATED`, `ALERT_SOURCE_UPDATED` (migration).
`AITriage` (read): `alertId` unique, `suggestedSeverity?`, `category?`, `reasoning?`, `confidence?`, `evidence Json?`, `failureStatus` (`PENDING|FAILED|SUCCESS`), `model?`, `modelVersion?`, `createdAt`.
`Alert` (read): `id`, `createdAt` to pick the latest accepted alert. `Incident`+`AppService` (read for team scope and SLA).
`IncidentListItem = { id, title, status, severity, service: { id, name }, currentAssignee: UserSummary|null, createdAt, slaState: { response, resolution } }` (each `ON_TRACK|WARNING|BREACHED|MET`). `IncidentDetailResponse = IncidentResponse (see SLICE-05 shape: ids, status, severity, service, teamId, actors, timestamps, resolutionSummary, sla) + alerts + aiTriage`. `CommentResponse = { id, title|null, body, author: UserSummary, createdAt }`. `SlaStatus` is computed at read time (deadline = `createdAt + threshold(current severity)`; `WARNING` ≥ 80 %; `MET` once acknowledged/resolved), never stored.
Invariants: team isolation on every read; append-only audit; every comment has its author and timestamp and appears in the timeline.

## 6. API Contract
**I1 `GET /incidents`** — all roles. Query `limit` (default 10, max 50), `cursor`, `status`, `severity`, `serviceId` (uuid), `assigneeId` (uuid), `orderBy` (`createdAt|severity|status|title|affectedServiceId|teamId`, default `severity`), `sort` (`asc|desc`, default `asc`). `200 IncidentListItem[]` + `pagination { nextCursor, hasMore }` (`nextCursor` is `null` when `hasMore` is false). Errors: `422 VALIDATION_FAILED`, `422 INVALID_CURSOR`, `401`, `403 INVALID_ACTION`. NFR: p95 < 300 ms.
**I2 `GET /incidents/:incidentId`** — `200 IncidentDetailResponse`. Errors: `422`, `401`, `403 TEAM_ACCESS_DENIED`, `403 INVALID_ACTION`, `404 INCIDENT_NOT_FOUND`.
**I10** — `PATCH /incidents/:incidentId` with the comment row → `201 CommentResponse`.
**I11 `GET /incidents/:incidentId/timeline`** — all roles. Query `limit` (10/50), `offset` (0), `orderBy=createdAt`, `sort`. `200 TimelineItem[]` + `pagination { limit, offset, hasMore }`. Errors: `422`, `401`, `403 TEAM_ACCESS_DENIED`, `403 INVALID_ACTION`, `404 INCIDENT_NOT_FOUND`.

## 7. Authorization & Security
Gate order per `AGENTS.md` §6. All three roles may read/comment on own-team incidents. Never expose `originalPayload` here, raw `metadata`, internal triage `summary`, raw model output, prompts, or secrets. Do not log comment bodies beyond ids.

## 8. Consistency & Concurrency
I10: comment + audit event in one transaction. The audit-append function never opens its own transaction (the producer owns atomicity). Reads are plain reads; no locks. Cursor stability caveat above is documented behavior.

## 9. Async / Events / Workers
No outbox event for comments (none specified). Produces audit events only: `COMMENT_ADDED` here; the store receives all others from their producers, including the 8 administrative events listed in §4 (the T4/U4/S4/S7 writes are added by SLICE-08; the seed write by SLICE-03).

## 10. Failure & Recovery
Comment/audit write failure rolls back both. Read endpoints return `503 DEPENDENCY_UNAVAILABLE` only for database outage.

## 11. Implementation Surface
Application: Incident module — read services and repositories (list with cursor encoding, detail with alerts + triage), timeline mapper/whitelist, comment handler, audit store reads. The append function already exists in `src/infra/audit/` (created by SLICE-08; extend it only if needed and keep it importable by every module). Database: the 8 administrative `AuditEventType` values already exist from SLICE-08's migration (verify; do not add them again); consider indexes for `(teamId, …)` list ordering and `(incidentId, createdAt, id)` timeline ordering via migration if profiling requires. Tests: unit (cursor encode/decode, whitelist mapper, `SlaStatus` builder, `aiTriage` status derivation), integration.

## 12. Verification Requirements
- I1: team scoping (never other team's rows), each filter, comma lists, cursor round-trip across pages, ordering with tie-breaker, `INVALID_CURSOR`, `limit` over max → `422`, foreign `serviceId` → empty, `teamId = null` → `403`.
- I2: full shape; `aiTriage` for no record / `PENDING` / `SUCCESS` / `FAILED` and "latest accepted alert" selection; no internal fields leaked.
- I10: author = caller, `201` shape, event in timeline, `CLOSED` → `409`, body validation (`422`), one-row matching, rollback atomicity.
- I11: ordering, offset pagination, every `eventType`'s `details` mapping, system actor `null`, raw metadata never exposed.
- Authorization matrix for all roles, cross-team `403`, unknown `404`, malformed id `422`.
- Administrative events: the 8 enum values exist (from SLICE-08's migration); `appendAuditEvent` accepts `incidentId = null` and persists each of them with the acting Admin (or `null` actor for the seed), with `metadata` limited to the entity id and changed field names (no values, no secrets); no events exist for creates, reads or logins; none appear in I11.
- Audit append: order within a command, atomic rollback with the producer, no update/delete path exists.

## 13. Completion Criteria
- I1, I2, I10, I11 behave as specified including pagination, derivation of `aiTriage`, and whitelisted timeline details.
- The audit-append contract exists, is transactional with its caller, and is used by comments.
- The audit store records the 8 administrative event types exactly as specified (updates/deactivations only, same transaction as the change, never exposed by the API); the enum values and the append function created by SLICE-08 are verified, not duplicated.
- Tests pass; typecheck/lint/format clean on touched files; no behavior outside the slice changed.
