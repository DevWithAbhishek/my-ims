# IMS API Reference

**Base path:** `/api/v1` — every path below is relative to it.
**Source hierarchy:** your decisions (rounds 1–7) > `DB_Schema.md` (incl. the extensions listed in §13) > `API_Contract.md` (inference only: endpoint content, DTO shapes, traceability tags and limits "as per API_CONTRACT"). Traceability tags are not re-verified against `PRD.md`.
**Layout rule:** every field is always present; `N/A` is the only spelling for "not applicable". Every open item has been closed; the final decisions are recorded in §14.

---

## 1. Conventions (defined once, referenced everywhere)

### 1.1 Modules and path groups

| Group | Prefix | Endpoints |
|---|---|---|
| Auth | `/auth` | A1–A4 |
| Identity | `/identity` | T1–T4, U1–U4 |
| Services | `/services` | S1–S7 |
| Alert ingestion | `/webhooks/alerts` | W1 |
| Incidents | `/incidents` | I1–I12 (I3–I8, I10 are actions on one `PATCH`), P1–P5, N1–N3 |

No `DELETE` exists anywhere. Users, teams and services are deactivated through `status`. No `204` is ever returned.

### 1.2 Authentication

| | User APIs | Webhook (W1) |
|---|---|---|
| Credential | JWT access token, **15 min** | `X-Signature` HMAC + `X-Timestamp` |
| Where | `Authorization: Bearer <accessToken>` | headers (§7, W1) |
| Obtained by | `POST /auth/login`, renewed by `POST /auth/refresh` | out-of-band source configuration; sources are seeded, no CRUD API |
| Identity | claims below | `alertSourceId` from the path |

**Access-token claims:** `userId`, `email`, `role`, `teamId` (uuid, `null` when the user has no team), `sessionId`, `exp`.

**Refresh token:** 7 days, delivered only as a cookie, never in a body.

| Cookie attribute | Value |
|---|---|
| Name | `ims_refresh_cookie` |
| `HttpOnly`, `Secure`, `SameSite` | yes, yes, `Lax` |
| `Path` | `/api/v1/auth` |
| `Max-Age` | `604800` |
| Payload | contains `sessionId` |

**Token delivery (login and refresh):** the access token is returned in the response header `Authorization: Bearer <accessToken>`; the refresh token in the `Set-Cookie` header; the body carries only `{ tokenType, expiresIn }`.

**Guard behaviour:** the guard trusts the JWT until `exp`. It does **not** read the database on protected requests. Role, team and status therefore take effect for access tokens at the next refresh. To limit this, the server revokes **all sessions of a user in the same transaction** when an Admin changes that user's `role`, `teamId`, `password` or `status`, and when a team deactivation nulls the user's `teamId`.

**Consequence:** `ACCOUNT_DEACTIVATED` is returned only by login and refresh, never by protected endpoints.

**Session store:** a `UserSession` record per login (`refreshTokenHash`, `lastRefreshHash`, `ip`, `userAgent`, `lastIp`, `lastSeen`, `revoked`) — schema extension, §13.

### 1.3 Authorization — gates in this order

```text
Gate 0  Authentication      401  UNAUTHENTICATED
Gate 1  Role                403  FORBIDDEN_ROLE
Gate 2  Team isolation      403  TEAM_ACCESS_DENIED     (resource of another team)
        Chain membership    403  FORBIDDEN              (outside the escalation chain)
Gate 3  State / business    409  INVALID_STATE_TRANSITION | POSTMORTEM_STATE_INVALID | …  or  403 INVALID_ACTION
```

- **Roles:** `ENGINEER`, `TEAM_LEAD`, `ADMIN`.
- **Team scope is never a client parameter** for incidents. The team is the caller's `teamId` claim.
- **Admin:** may administer any team (identity, services, policies). Incident data is limited to the Admin's own team (OD-03).
- **User with `teamId = null`** (including an Admin): every incident-scoped endpoint returns `403 INVALID_ACTION` ("update `teamId` first").
- **Escalation chain** = the four users of the incident's service policy: `level1`, `level2`, `level3`, `fallbackAdmin`.
- **"Unresolved incident"** = status `OPEN`, `ACKNOWLEDGED` or `MITIGATING`.
- **Check order:** gates run in the order above; path, query and body validation (`422`/`400`) runs **before** state checks (Gate 3).

### 1.4 Headers

| Header | Direction | Required | Notes |
|---|---|---|---|
| `Authorization: Bearer <jwt>` | request | all user APIs except A1, A2 | response header on A1, A2 carries the new token |
| `Content-Type: application/json` | request | when a body is sent | missing/other: `400 BAD_REQUEST` (webhook: §W1) |
| `X-Request-Id` | request + response | request optional; response always | accepted if ≤128 chars of `[A-Za-z0-9-_]`, else replaced; echoed in `error.requestId` |
| `Idempotency-Key` | request | **N1 only** | 8–128 chars `[A-Za-z0-9_-]`; not accepted elsewhere |
| `X-Signature`, `X-Timestamp` | request | W1 only | §W1 |
| `Set-Cookie` | response | A1, A2 (set), A2–A4 (clear) | §1.2 |
| `Retry-After` | response | on `429` and `503` | seconds |

### 1.5 Envelope

```json
{ "data": { } }                                         // single resource / command result
{ "data": [ ], "pagination": { } }                      // collection
{ "error": { "code": "INVALID_STATE_TRANSITION", "message": "…", "details": [ ], "requestId": "…" } }
```

- `error.code` and HTTP status are stable; `error.message` is not (never parse it).
- `error.details` is always an array (empty when not applicable). Shape per code: §1.8.
- Never present in any body: stack traces, SQL messages, secrets, `passwordHash`, signing secrets, prompts, raw model input. A `500` returns only `INTERNAL_ERROR` and `requestId`.
- Absent optional values in responses are `null`, never omitted. Request DTOs are Zod-strict: unknown fields are rejected (`400 BAD_REQUEST`).

### 1.6 Naming, types, time

JSON fields `camelCase`. Enum values `UPPER_SNAKE`. IDs are UUID strings. Timestamps are ISO 8601 UTC with `Z`. The eight flat SLA fields of a service keep their DB names (`P0ResponseSlaMinutes` …) — this is the one deliberate exception to camelCase.
Request DTOs are the Zod schemas named in each endpoint; response types are the TypeScript types named in §3.

### 1.7 HTTP status semantics

| Status | Meaning here |
|---|---|
| 200 | read, command, update, idempotent replay, webhook batch (≥1 alert not rejected) |
| 201 | new stored resource: `POST` team, user, service, comment (I10); P5 |
| 202 | **N1 first request only** (work continues in a worker) |
| 400 | `BAD_REQUEST`, `IDEMPOTENCY_KEY_REQUIRED`, webhook all-rejected / >100 items / missing `Content-Type` |
| 401 | not authenticated |
| 403 | role, team, chain, ineligible reference, invalid action |
| 404 | the id does not exist |
| 409 | request valid but conflicts with current state, uniqueness, replay, key reuse |
| 413 | webhook body too large |
| 422 | `VALIDATION_FAILED`, `INVALID_CURSOR` |
| 429 | rate limit (`Retry-After`) |
| 500 / 503 | bug / required dependency down (`Retry-After` on 503) |

### 1.8 Error catalogue (final)

`details` shapes: `VALIDATION_FAILED` → `[{ field, issue }]` (webhook envelope adds `index`); `INVALID_STATE_TRANSITION` → `[{ currentStatus, requiredStatus }]`; `POSTMORTEM_STATE_INVALID` → `[{ generationStatus, reviewStatus }]`; every `404` → `[{ resource }]`; all others `[]`.

| HTTP | Code | When | Retry? |
|---|---|---|---|
| 400 | `BAD_REQUEST` | unknown body field; malformed JSON or wrong `Content-Type` (non-webhook); resolve with `serviceConfirmedWorking ≠ true`; webhook: more than 100 items or missing `Content-Type` | No |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` | missing / ill-formed `Idempotency-Key` on N1 | No |
| 422 | `VALIDATION_FAILED` | missing/invalid field, bad type/range, malformed path id, invalid query value, `limit` over max, body matching no/multiple action rows; webhook: malformed JSON, missing or empty `alerts` | No |
| 422 | `INVALID_CURSOR` | undecodable or wrong-shape cursor | No — restart without cursor |
| 401 | `UNAUTHENTICATED` | missing / invalid / expired access token | After refresh or re-login |
| 401 | `INVALID_CREDENTIALS` | wrong email or password (one response, similar timing) | No |
| 401 | `INVALID_REFRESH_TOKEN` | refresh cookie present but invalid, expired, revoked, or **reused** (reuse revokes all sessions) | No |
| 401 | `INVALID_REQUEST` | refresh cookie not found | No |
| 401 | `SOURCE_AUTH_FAILED` | unknown / deactivated source, malformed `alertSourceId`, bad signature (one code) | No |
| 401 | `REQUEST_STALE` | `X-Timestamp` outside ±300 s | Yes, re-sign |
| 403 | `FORBIDDEN_ROLE` | role not allowed | No |
| 403 | `FORBIDDEN` | caller outside the escalation chain, and any other denial not covered below | No |
| 403 | `TEAM_ACCESS_DENIED` | resource belongs to another team | No |
| 403 | `NOT_CURRENT_ASSIGNEE` | resolve by a non-assignee Engineer | No |
| 403 | `ACCOUNT_DEACTIVATED` | login or refresh by a `DEACTIVATED` user | No |
| 403 | `ASSIGNEE_NOT_ELIGIBLE` | assignee not active / not in team / wrong role | No |
| 403 | `INVALID_ACTION` | invalid team/user reference on admin writes; user with `teamId = null` on incident endpoints; leadId for an Admin; wrong incident/postmortem state for P2–P5 where stated; service `teamId` change when any incident exists; team deactivation with services attached; policy attached to another service | No |
| 404 | `TEAM_NOT_FOUND`, `USER_NOT_FOUND`, `SERVICE_NOT_FOUND`, `INCIDENT_NOT_FOUND`, `ALERT_NOT_FOUND`, `POSTMORTEM_NOT_FOUND`, `INVESTIGATION_NOT_FOUND`, `ESCALATION_POLICY_NOT_FOUND` | the id does not exist, or a sub-resource does not belong to its parent | No |
| 409 | `EMAIL_ALREADY_EXISTS`, `DUPLICATE_TEAM`, `SERVICE_ALREADY_EXISTS` | uniqueness violated (email, team name, service name) | No |
| 409 | `INVALID_STATE_TRANSITION` | incident not in the required state (includes the race loser) | No — re-read |
| 409 | `POSTMORTEM_STATE_INVALID` | postmortem not in the required `generationStatus`/`reviewStatus` (P2, P3) | No |
| 409 | `CONCURRENCY_CONFLICT` | lock timeout / serialization failure; state may be unchanged | Yes, backoff |
| 409 | `REPLAY_DETECTED` | webhook signed request already processed | No — new signature |
| 409 | `IDEMPOTENCY_KEY_REUSED` | N1 key already used for another incident or user | No — new key |
| 409 | `CONFLICT_STILL_HAS_ENGINEERS` | demoting, deactivating, or changing the team of a Team Lead who still has engineers | No |
| 409 | `USER_ASSIGNED_CURRENTLY` | user is `acknowledgedBy` on an unresolved incident (deactivate, role change, team change) | No |
| 409 | `TEAM_WITH_OPEN_INCIDENT` | deactivating a team that has unresolved incidents | No |
| 409 | `SERVICE_HAS_OPEN_INCIDENTS` | deactivation, SLA, or `escalationPolicyId` change on a service with unresolved incidents | No |
| 409 | `POLICIES_MAX_LIMIT_REACHED` | creating a second escalation policy for a service (limit 1) | No |
| 409 | `POLICY_IN_USE` | updating a policy whose service has unresolved incidents | No |
| 413 | `PAYLOAD_TOO_LARGE` | webhook body > 1 MB | No |
| 429 | `RATE_LIMITED` | §1.10; sends `Retry-After` | Yes, after `Retry-After` |
| 503 | `DEPENDENCY_UNAVAILABLE` | database / Redis / queue handoff down; sends `Retry-After` | Yes |
| 500 | `INTERNAL_ERROR` | bug; body has only `requestId` | Re-read state before retrying a command |

Webhook item-level codes (inside `results[].error.code`, never an HTTP status): `ALERT_INVALID`, `UNKNOWN_SERVICE`, `IDENTITY_UNRESOLVABLE`, `SERVICE_DEACTIVATED`, and `RATE_LIMITED` (alerts of a batch beyond the remaining rate-limit capacity).

### 1.9 Pagination

**Offset lists** — response `pagination: { limit, offset, hasMore }`. No `total`, no `page`. Empty list → `200` with `[]`.
**Cursor list (I1 only)** — response `pagination: { nextCursor, hasMore }`; `nextCursor` is `null` when `hasMore` is `false`. The cursor is opaque (base64url of the last row's sort value + `id`), **not signed** (team scope is re-applied every request), and bound to the `orderBy`/`sort` it was issued under. Reusing a cursor with changed filters is undefined behaviour, not detected. Undecodable cursor → `422 INVALID_CURSOR`.
**Common rules:** `sort` is `asc` or `desc`. The tie-breaker is always `id`, in the same direction as `sort`. `limit` over max → `422 VALIDATION_FAILED`.
**Caveat (I1):** ordering by a mutable column (`status`, `severity`, `title`, `affectedServiceId`) means a row can move while someone is paging, so rows can be skipped or repeated. Ordering by `createdAt` is stable. `teamId` is always the caller's team, so ordering by it has no effect.

| List | Style | Default / max `limit` | Allowed `orderBy` | Default order |
|---|---|---|---|---|
| T2 teams | offset | 10 / 50 | `name`, `createdAt` | `name` asc |
| U2 users of a team | offset | 10 / 50 | `name`, `createdAt` | `name` asc |
| S2 services | offset | 10 / 50 | `name`, `createdAt` | `name` asc |
| I1 incidents | cursor | 10 / 50 | `createdAt`, `severity`, `status`, `title`, `affectedServiceId`, `teamId` | `severity` asc |
| I11 timeline | offset | 10 / 50 | `createdAt` | `createdAt` asc |
| N2 investigations | offset | 10 / 50 | `createdAt` | `createdAt` asc |

### 1.10 Rate limits

Violation of a limit returns `429 RATE_LIMITED` with `Retry-After`. Each next violation escalates the block through the ladder. Ladder memory and the duration of the final "block" are implementation-defined (N/A). A block ends automatically when its window passes.

| Scope | Limit | Key | Ladder after violation | Final stage |
|---|---|---|---|---|
| A1 login | 10 req/min | IP + email | 10 min → 20 min → 60 min → 4 h | block IP |
| A2 refresh | 10 req/min | IP + email + `sessionId` | same as login | block IP |
| W1 webhook | 15 **alerts**/min | source | 5 min → 20 min → 45 min → 2 h | block source **and notify all active Admins** |
| N1 investigation | 3 req/min | user | 10 min → 20 min → 60 min → 4 h → 8 h | notify all active Admins |

A successful login or refresh resets that key's counter. "Notify Admin" runs through the BullMQ notification worker; the content is user info + number of attempts + latest action; it is **not** written to any incident timeline.

### 1.11 Consistency, idempotency, async

- **Incident commands (PATCH I3–I8, I10; P3–P5):** the incident (and postmortem) row is locked, the state is re-checked under the lock, the change + audit events + outbox events are written in **one transaction**, and the response is sent only after commit. First committed request wins; the loser gets `409 INVALID_STATE_TRANSITION` / `POSTMORTEM_STATE_INVALID`. `CONCURRENCY_CONFLICT` is the retryable lock-timeout case.
- **Idempotency by mechanism:** webhook = alert identity + DB unique key; N1 = `Idempotency-Key`; lifecycle commands = state guard (a retry gets `409` and creates no second audit event, outbox event or notification); assign/unassign/severity-same-value = natural no-op; admin `PATCH` = natural; comment = none (a retry creates a second comment); login = none.
- **Event order:** the audit events of one command appear in the order written. Each event is stored with a slightly later `createdAt` than the previous one.
- **Async work** (AI triage, notifications, SLA/escalation, postmortem generation, investigation) happens in workers after commit via outbox → BullMQ. No LLM or email call is made inside an HTTP request or a DB transaction.

---

## 2. Endpoint index (31 operations)

Roles: **E** Engineer, **TL** Team Lead, **A** Admin. "Chain" = escalation-chain members (§1.3).

| ID | Method + path | Purpose | Who | Success | Style |
|---|---|---|---|---|---|
| A1 | `POST /auth/login` | credentials → tokens | public | 200 | sync |
| A2 | `POST /auth/refresh` | rotate tokens | refresh cookie | 200 | sync |
| A3 | `POST /auth/logout` | revoke current session | Bearer | 200 | sync |
| A4 | `POST /auth/logout-all` | revoke all sessions of caller | Bearer | 200 | sync |
| T1 | `POST /identity/teams` | create team | A | 201 | sync |
| T2 | `GET /identity/teams` | list teams | A | 200 | offset |
| T3 | `GET /identity/teams/:teamId` | get team | A; E/TL own team | 200 | sync |
| T4 | `PATCH /identity/teams/:teamId` | rename / (de)activate | A | 200 | sync |
| U1 | `POST /identity/users` | create user | A | 201 | sync |
| U2 | `GET /identity/teams/:teamId/users` | users of a team | A; TL own team | 200 | offset |
| U3 | `GET /identity/users/:userId` | get user | A; TL own team | 200 | sync |
| U4 | `PATCH /identity/users/:userId` | update / deactivate user | A | 200 | sync |
| S1 | `POST /services` | create service + its policy | A | 201 | sync |
| S2 | `GET /services` | list services | A any team; E/TL/own team | 200 | offset |
| S3 | `GET /services/:serviceId` | get service | A; E/TL own team | 200 | sync |
| S4 | `PATCH /services/:serviceId` | update service / SLA | A | 200 | sync |
| S5 | `POST /services/:serviceId/escalation-policies` | create policy (always `409`, §6) | A | — | sync |
| S6 | `GET /services/:serviceId/escalation-policies/:escalationPolicyId` | get policy | A; TL own team | 200 | sync |
| S7 | `PATCH /services/:serviceId/escalation-policies/:escalationPolicyId` | update policy | A | 200 | sync |
| W1 | `POST /webhooks/alerts/:alertSourceId` | deliver alerts | source (HMAC) | 200 / 400 | sync persist |
| I1 | `GET /incidents` | team incident feed | E, TL, A | 200 | cursor |
| I2 | `GET /incidents/:incidentId` | incident detail | E, TL, A | 200 | sync |
| I3–I8, I10 | `PATCH /incidents/:incidentId` | one action per request (§8.3) | per action | 200 (comment 201) | sync |
| I11 | `GET /incidents/:incidentId/timeline` | audit history | E, TL, A | 200 | offset |
| I12 | `GET /incidents/:incidentId/alerts/:alertId` | alert + original payload | E, TL, A | 200 | sync |
| P1 | `GET /incidents/:incidentId/postmortem` | read postmortem | E, TL, A | 200 | sync |
| P2–P4 | `PATCH /incidents/:incidentId/postmortem` | edit / approve / retry (§9.2) | per action | 200 | sync |
| P5 | `POST /incidents/:incidentId/postmortem` | manual create after failed generation | chain | 201 | sync |
| N1 | `POST /incidents/:incidentId/investigations` | request AI brief | E, TL, A | 202 / 200 | async |
| N2 | `GET /incidents/:incidentId/investigations` | list briefs | E, TL, A | 200 | offset |
| N3 | `GET /incidents/:incidentId/investigations/:investigationId` | one brief + evidence | E, TL, A | 200 | sync |

**Action IDs inside the two `PATCH` endpoints:** I3 acknowledge, I4 confirm severity, I5 change severity, I6 assign, I7 unassign, I8 resolve, I10 comment; P2 edit, P3 approve, P4 retry. **I9 (close) does not exist:** an incident becomes `CLOSED` only atomically with P3 or P5.
There is no `PUT …/severity`, no `DELETE`, no manual incident creation, no alert-source CRUD, and no endpoint for notifications, SLA, outbox or AI evaluation.

---

## 3. Shared types

Request DTOs are Zod-strict (named at each endpoint). The types below are the response types (`module.types.ts`).

### 3.1 References and computed

**`UserSummary`** = `{ id: uuid, name: string }` — **`ServiceSummary`** = `{ id: uuid, name: string }`.

**`SlaStatus`** — computed at read time, never stored. `createdAt + threshold` for the incident's **current** severity (clock is never reset by a severity change).

| Field | Type | Notes |
|---|---|---|
| `applicableSeverity` | `P0..P3` | current severity |
| `response` / `resolution` | `{ thresholdMinutes: int, deadlineAt: datetime, state: "ON_TRACK"\|"WARNING"\|"BREACHED"\|"MET", metAt: datetime\|null }` | `WARNING` ≥ 80 % elapsed; `MET` once acknowledged / resolved; a breach never changes incident state |

`SlaState` = the `state` enum above.

### 3.2 Incident types

**`IncidentListItem`** — `id`, `title`, `status` (`OPEN|ACKNOWLEDGED|MITIGATING|RESOLVED|CLOSED`), `severity` (`P0..P3`), `service: ServiceSummary`, `currentAssignee: UserSummary|null`, `createdAt`, `slaState: { response: SlaState, resolution: SlaState }`.

**`IncidentResponse`**

| Field | Type |
|---|---|
| `id`, `title`, `description` | uuid, string, string |
| `status`, `severity` | enums above |
| `service` | `ServiceSummary` |
| `teamId` | uuid |
| `currentAssignee`, `acknowledgedBy`, `severityConfirmedBy`, `resolvedBy`, `closedBy` | `UserSummary \| null` |
| `resolutionSummary` | string \| null |
| `createdAt` | datetime |
| `acknowledgedAt`, `severityConfirmedAt`, `resolvedAt`, `closedAt` | datetime \| null |
| `sla` | `SlaStatus` |

**`IncidentDetailResponse`** = `IncidentResponse` + `alerts: AlertSummary[]` + `aiTriage: AiTriage`.

**`AlertSummary`** — `id`, `name`, `environment`, `sourceSeverity`, `initialSeverity`, `sourceStatus` (`FIRING|RESOLVED`, schema extension), `startedAt`, `endedAt`, `sourceUrl`, `alertSource: { id, name }`. `originalPayload` is excluded.

**`AlertDetailResponse`** = `AlertSummary` + `sourceEventId`, `sourceFingerprint`, `summary`, `description`, `labels: string[]`, `additionalDetails`, `originalPayload` (verbatim stored JSON). Nullable fields are `null` when absent.

**`AiTriage`** (read-only, advisory, never changes state) — `status` (`PENDING|COMPLETED|UNAVAILABLE`), `category: string|null`, `suggestedSeverity: P0..P3|null`, `confidence: number 0–1|null`, `evidence: { type, reference, excerpt }[]`, `reasoningSummary: string|null`, `model`, `modelVersion`, `generatedAt` (string/datetime or `null`). Always present; while pending: all values `null`, `evidence: []`.

**`CommentResponse`** — `id`, `title: string|null`, `body: string`, `author: UserSummary`, `createdAt`.

### 3.3 Timeline

**`TimelineItem`** — `id`, `eventType`, `actor: UserSummary|null` (`null` = system/worker), `details: object` (whitelist below), `createdAt`. Raw `metadata` is never exposed. `eventType` enum (final): `ALERT_RECEIVED`, `ALERT_DUPLICATE`, `AI_TRIAGE_COMPLETED`, `ASSIGNED`, `REASSIGNED`, `INCIDENT_CREATED`, `ACKNOWLEDGED`, `SEVERITY_CONFIRMED`, `COMMENT_ADDED`, `SLA_WARNING` (pre-breach), `ESCALATED_L1`, `ESCALATED_L2`, `ESCALATED_L3`, `ESCALATED_L4` (breach), `SOURCE_ALERT_RESOLVED`, `RESOLVED`, `NOTIFIED`, `POSTMORTEM_GENERATED`, `POSTMORTEM_REVIEWED`, `AI_INVESTIGATION_COMPLETED`, `CLOSED`, `OPEN`.

| eventType | `details` | Types |
|---|---|---|
| `ALERT_RECEIVED` | `{ alertId }` | uuid |
| `ALERT_DUPLICATE` | `{ alertSourceId }` | uuid |
| `AI_TRIAGE_COMPLETED` | `{ createdAt }` | datetime |
| `INCIDENT_CREATED` | `{ incidentId }` | uuid |
| `ASSIGNED` | `{ from, to, auto }` | `UserSummary\|null` each, boolean (`true` only for the auto-assign on acknowledge) |
| `REASSIGNED` | `{ from, to }` | `UserSummary\|null` each |
| `OPEN` | `{ statusFrom }` | incident status |
| `ACKNOWLEDGED` | `{ acknowledgedBy, autoAssigned }` | uuid, boolean (`true` only for the auto-assign on acknowledge) |
| `SEVERITY_CONFIRMED` | `{ from, to, statusFrom, statusTo }` | severity, severity, status, status |
| `COMMENT_ADDED` | `{ comment }` | `CommentResponse` |
| `SLA_WARNING` | `{ kind }` | `RESPONSE\|RESOLUTION` |
| `ESCALATED_L1`…`L4` | `{ notifiedUser }` | `UserSummary` |
| `SOURCE_ALERT_RESOLVED` | `{ alertId }` | uuid |
| `RESOLVED` | `{ resolutionSummary, serviceConfirmedWorking }` | string, boolean |
| `NOTIFIED` | `{ recipients }` | `UserSummary[]` |
| `POSTMORTEM_GENERATED` | `{ postmortemId }` | uuid |
| `POSTMORTEM_REVIEWED` | `{ postmortemId, reviewedBy }` | uuid, `UserSummary` |
| `AI_INVESTIGATION_COMPLETED` | `{ investigationId }` | uuid |
| `CLOSED` | `{ closedAt }` | datetime |

### 3.4 Postmortem

**`PostmortemResponse`**

| Field | Type | Notes |
|---|---|---|
| `id`, `incidentId` | uuid | |
| `generationStatus` | `GENERATING \| DRAFT \| FAILED` | schema extension |
| `reviewStatus` | `PENDING \| REJECTED \| REVIEWED` | `REJECTED` can never be set (no reject endpoint) |
| `aiGenerated` | boolean | `false` for a manually created postmortem (its `model`, `modelVersion`, `prompt` and `inputData` are stored `NULL`) |
| `summary`, `impact`, `detection`, `timeline`, `rootCause`, `contributingFactors`, `resolution`, `correctiveActions`, `preventiveActions`, `unknowns` | string \| null | `null` while `GENERATING` / `FAILED` |
| `mttrMinutes` | int \| null | `ceil((incident.resolvedAt − incident.createdAt) in minutes)` |
| `riskLevel` | `P0..P3 \| null` | |
| `provenance` | `{ model, modelVersion, generatedAt, promptVersion }` | strings/datetime or `null`; `prompt` and `inputData` are never exposed |
| `review` | `{ reviewedBy: UserSummary, reviewedAt: datetime } \| null` | set only on approve and manual create |
| `failureReason` | `AI_UNAVAILABLE \| OUTPUT_INVALID \| INSUFFICIENT_CONTEXT \| null` | schema extension; no provider text |

### 3.5 Investigation

**`InvestigationResponse`** — `id`, `incidentId`, `status` (`REQUESTED|RUNNING|COMPLETED|FAILED`), `requestedBy: UserSummary`, `createdAt`, `completedAt: datetime|null`, `brief: InvestigationBrief|null` (non-null only when `COMPLETED`), `evidence: EvidenceItem[]`, `failureReason: AI_UNAVAILABLE|RETRIEVAL_FAILED|OUTPUT_INVALID|null`, `provenance: { model, modelVersion }`.
**`InvestigationBrief`** — `summary: string`, `findings: { text, evidenceIds: uuid[] }[]` (facts only, each cites ≥1 evidence id), `possibleAreas: { text, evidenceIds: uuid[] }[]` (inferences), `suggestedSteps: { text }[]`, `limitations: string|null`.
**`EvidenceItem`** — `id`, `evidenceType` (`FACT|INFERENCE|UNKNOWN`), `sourceType: string`, `sourceReference: string`, `relevance: string|null`.
Never exposed: prompt, retrieved context, chain-of-thought, `input`, `idempotencyKey`.

### 3.6 Admin types

| Type | Fields |
|---|---|
| `TeamResponse` | `id`, `name`, `status` (`ACTIVE\|DEACTIVATED`), `createdAt`, `updatedAt` |
| `UserResponse` | `id`, `name`, `email`, `role` (`ENGINEER\|TEAM_LEAD\|ADMIN`), `status`, `teamId: uuid\|null`, `leadId: uuid\|null`, `createdAt`, `updatedAt` |
| `UserListItem` | `id`, `name`, `email`, `role`, `status`, `teamId`, `leadId`, `createdAt`, `updatedAt` |
| `ServiceResponse` | `id`, `name`, `defaultSeverity`, `status`, `P0ResponseSlaMinutes`, `P0ResolutionSlaMinutes`, `P1…`, `P2…`, `P3…` (8 ints), `teamId`, `escalationPolicyId`, `createdAt`, `updatedAt` |
| `EscalationPolicyResponse` | `id`, `level1`, `level2`, `level3`, `fallbackAdmin` (uuids), `createdAt`, `updatedAt` |

---

## 4. Auth (`/auth`)

Common to A1–A4: request/response envelope per §1.5; rate limits per §1.10; `500`/`503` per §1.8. Traceability for the group: PRD §12.1, §12.12, FR-036, AC-036, AC-037 (per API_Contract).

### A1 · `POST /auth/login`

| Item | Definition |
|---|---|
| Purpose | Exchange email + password for tokens. The only way a human obtains credentials. |
| Authentication / Authorization | Not required / N/A |
| Headers | `Content-Type: application/json` |
| Path / Query params | N/A / N/A |
| Request — `LoginRequestDto` | `email: string` (valid email, ≤72, lower-cased before lookup); `password: string` (8–24) |
| Response | `200 OK`. Headers: `Authorization: Bearer <accessToken>` and `Set-Cookie: ims_refresh_cookie=…` (§1.2). Body: `{ "data": { "tokenType": "Bearer", "expiresIn": 900 } }` |
| Errors | `422 VALIDATION_FAILED`; `400 BAD_REQUEST`; `401 INVALID_CREDENTIALS` (unknown email or wrong password: same response, similar timing); `403 ACCOUNT_DEACTIVATED` (password correct, user `DEACTIVATED`); `429 RATE_LIMITED` |
| Pagination | N/A |
| Idempotency | N/A — each login creates a new session |
| Consistency | Inserts one `UserSession` row in one transaction |
| Side effects | Session created (refresh hash stored, never the raw token); rate-limit counter reset on success (Redis) |
| Traceability | FR-036, AC-036 |

### A2 · `POST /auth/refresh`

| Item | Definition |
|---|---|
| Purpose | Rotate both tokens using the refresh cookie. |
| Authentication / Authorization | Valid refresh cookie / N/A |
| Headers | `Cookie: ims_refresh_cookie=<token>` |
| Path / Query params | N/A / N/A |
| Request | none (body ignored) |
| Response | `200 OK`, same headers and body as A1. New `Authorization` header and new cookie; the old refresh token is replaced (rotation) |
| Errors | `401 INVALID_REQUEST` (cookie absent); `401 INVALID_REFRESH_TOKEN` (invalid, expired, revoked, or **reused** — reuse is detected by matching the presented token against `lastRefreshHash` and **revokes all sessions of the user**); `403 ACCOUNT_DEACTIVATED`; `429 RATE_LIMITED` |
| Pagination | N/A |
| Idempotency | N/A — a second use of the same token is treated as reuse |
| Consistency | Session row updated in one transaction (`lastRefreshHash` ← old `refreshTokenHash`, new `refreshTokenHash`, `lastSeen`, `lastIp`) |
| Side effects | Rate-limit counter reset on success |
| Traceability | PD-02 (as modified) |

### A3 · `POST /auth/logout`

| Item | Definition |
|---|---|
| Purpose | Revoke the caller's current session and clear the cookie. |
| Authentication / Authorization | `Bearer` access token only (session found from the token's `sessionId`) / any role |
| Headers | `Authorization: Bearer <accessToken>` |
| Path / Query params | N/A / N/A |
| Request | none |
| Response | `200 OK`; clears `ims_refresh_cookie`. Body `{ "data": { "message": "Logged out successfully" } }` (message text informational) |
| Errors | `401 UNAUTHENTICATED` (missing or expired access token); `500` |
| Pagination | N/A |
| Idempotency | Repeating with a valid token whose session is already revoked returns the same `200` |
| Consistency | One update of the session row (`revoked = true`) |
| Side effects | Session revoked; access token stays valid until `exp` |
| Traceability | N/A |

### A4 · `POST /auth/logout-all`

Same as A3 except: revokes **every** session of the caller where `revoked = false`, and clears the cookie. Response `200 OK`, body `{ "data": { "message": "Logged out successfully" } }`.

---

## 5. Identity (`/identity`)

Common to T1–T4 and U1–U4: write operations require role `ADMIN` (`403 FORBIDDEN_ROLE` otherwise). Idempotency N/A, side effects N/A unless stated. Requests are Zod-strict; `At least one field` means an empty body is `422 VALIDATION_FAILED`. Traceability: PRD §2, §5 Admin stories, §11 matrix, BR-002, BR-003, RD-019, RD-020, AC-007 (per API_Contract).

### T1 · `POST /identity/teams`

| Item | Definition |
|---|---|
| Purpose | Create a team. |
| Auth / Authorization | Bearer / `ADMIN` |
| Request — `AddTeamDto` | `name: string` (1–50) |
| Response | `201 Created`, `data: TeamResponse` (`status = ACTIVE`) |
| Errors | `422 VALIDATION_FAILED`; `400 BAD_REQUEST`; `401 UNAUTHENTICATED`; `403 FORBIDDEN_ROLE`; `409 DUPLICATE_TEAM` (name unique) |
| Consistency | Single transaction |

### T2 · `GET /identity/teams`

| Item | Definition |
|---|---|
| Purpose | List teams. |
| Auth / Authorization | Bearer / `ADMIN` only |
| Query — `GetTeamsDto` | `limit?` (default 10, max 50), `offset?` (default 0), `orderBy?` (`name`\|`createdAt`, default `name`), `sort?` (`asc`\|`desc`, default `asc`) |
| Response | `200 OK`, `data: TeamResponse[]`, `pagination { limit, offset, hasMore }`; empty list → `[]` |
| Errors | `422 VALIDATION_FAILED`; `401`; `403 FORBIDDEN_ROLE` |
| Pagination | offset, §1.9 |

### T3 · `GET /identity/teams/:teamId`

| Item | Definition |
|---|---|
| Purpose | Get a team by id. |
| Auth / Authorization | Bearer / `ADMIN` any team; `ENGINEER`, `TEAM_LEAD` only their **own** team |
| Path | `teamId: uuid` |
| Response | `200 OK`, `data: TeamResponse` |
| Errors | `422 VALIDATION_FAILED` (malformed id); `401`; `403 TEAM_ACCESS_DENIED` (other team); `404 TEAM_NOT_FOUND` |

### T4 · `PATCH /identity/teams/:teamId`

| Item | Definition |
|---|---|
| Purpose | Rename a team or (de)activate it. |
| Auth / Authorization | Bearer / `ADMIN` |
| Request — `UpdateTeamDto` | `name?: string` (1–50), `status?: "ACTIVE"\|"DEACTIVATED"`; at least one field |
| Response | `200 OK`, `data: TeamResponse` |
| Errors | `422`; `400`; `401`; `403 FORBIDDEN_ROLE`; `404 TEAM_NOT_FOUND`; `409 DUPLICATE_TEAM`; `409 TEAM_WITH_OPEN_INCIDENT` (deactivating while the team has unresolved incidents); `403 INVALID_ACTION` (deactivating while services are still attached; services must be reassigned first). If both blockers apply: `409 TEAM_WITH_OPEN_INCIDENT` |
| Consistency | One transaction |
| Side effects | On deactivation: every user of the team gets `teamId = null` and **all their sessions are revoked** (their previous team association is kept so that reactivation restores it). On reactivation (`status: ACTIVE`): former users get their `teamId` back. |

### U1 · `POST /identity/users`

| Item | Definition |
|---|---|
| Purpose | Create a user. `ADMIN` users are never created here (seed script only). |
| Auth / Authorization | Bearer / `ADMIN` |
| Request — `CreateUserDto` | `name: string` (1–50); `email: string` (valid, ≤72, stored lower-case); `password: string` (8–24, hashed, never returned); `role?: "ENGINEER"\|"TEAM_LEAD"` (default `ENGINEER`); `teamId?: uuid` (optional; may be set later); `leadId?: uuid` (optional) |
| Validation | `teamId` must exist, else `403 INVALID_ACTION`. `leadId` must reference an `ACTIVE` `TEAM_LEAD` of the same team, else `403 INVALID_ACTION`. A `leadId` supplied while the user's `teamId` is `null` → `403 INVALID_ACTION` |
| Response | `201 Created`, `data: UserResponse` (`status = ACTIVE`) |
| Errors | `422`; `400`; `401`; `403 FORBIDDEN_ROLE`; `403 INVALID_ACTION`; `409 EMAIL_ALREADY_EXISTS` |
| Consistency | Single transaction |

### U2 · `GET /identity/teams/:teamId/users`

| Item | Definition |
|---|---|
| Purpose | List the users of one team. |
| Auth / Authorization | Bearer / `ADMIN` any team; `TEAM_LEAD` own team only (another team → `403 TEAM_ACCESS_DENIED`); `ENGINEER` → `403 FORBIDDEN_ROLE` |
| Path | `teamId: uuid` |
| Query — `GetAllUsersDto` | `limit?`, `offset?`, `role?: ENGINEER\|TEAM_LEAD`, `status?: ACTIVE\|DEACTIVATED`, `orderBy?: name\|createdAt` (default `name`), `sort?` (default `asc`) |
| Response | `200 OK`, `data: UserListItem[]`, offset `pagination` |
| Errors | `422`; `401`; `403 FORBIDDEN_ROLE`; `403 TEAM_ACCESS_DENIED`; `404 TEAM_NOT_FOUND` |

### U3 · `GET /identity/users/:userId`

| Item | Definition |
|---|---|
| Purpose | Get one user. |
| Auth / Authorization | Bearer / `ADMIN` any; `TEAM_LEAD` users of own team only (other team → `403 TEAM_ACCESS_DENIED`); `ENGINEER` → `403 FORBIDDEN_ROLE` |
| Path | `userId: uuid` |
| Response | `200 OK`, `data: UserResponse` |
| Errors | `422`; `401`; `403 FORBIDDEN_ROLE`; `403 TEAM_ACCESS_DENIED`; `404 USER_NOT_FOUND` |

### U4 · `PATCH /identity/users/:userId`

| Item | Definition |
|---|---|
| Purpose | Update a user or deactivate the account. `email` is immutable. |
| Auth / Authorization | Bearer / `ADMIN` |
| Request — `UpdateUserDto` | `name?` (1–50); `password?` (8–24); `role?: "ENGINEER"\|"TEAM_LEAD"`; `status?: "ACTIVE"\|"DEACTIVATED"`; `teamId?: uuid`; `leadId?: uuid`; at least one field |
| Rules | **teamId:** may be set when currently `null`; may be changed afterwards only if the user is not `acknowledgedBy` on any unresolved incident (else `409 USER_ASSIGNED_CURRENTLY`); a team change sets `leadId = null`. **leadId:** must reference an `ACTIVE` `TEAM_LEAD` of the same team, else `403 INVALID_ACTION`; never allowed for an `ADMIN` user (`403 INVALID_ACTION`). **role:** `ENGINEER → TEAM_LEAD` sets `leadId = null`; `TEAM_LEAD → ENGINEER` with engineers still reporting to them → `409 CONFLICT_STILL_HAS_ENGINEERS`; any role change on a user who is `acknowledgedBy` on an unresolved incident → `409 USER_ASSIGNED_CURRENTLY`. **status:** deactivating such a user → `409 USER_ASSIGNED_CURRENTLY`; deactivating (or moving to another team) a Team Lead who still has engineers → `409 CONFLICT_STILL_HAS_ENGINEERS`. If both `409`s apply, `USER_ASSIGNED_CURRENTLY` is returned; a `leadId` supplied while the resulting `teamId` is `null` → `403 INVALID_ACTION` |
| Response | `200 OK`, `data: UserResponse` |
| Errors | `422`; `400`; `401`; `403 FORBIDDEN_ROLE`; `403 INVALID_ACTION`; `404 USER_NOT_FOUND`; `409 USER_ASSIGNED_CURRENTLY`; `409 CONFLICT_STILL_HAS_ENGINEERS` |
| Consistency | One transaction, including session revocation |
| Side effects | A change of `role`, `teamId`, `password` or `status` **revokes all sessions of that user** in the same transaction. Deactivation does not touch incidents already assigned and does not edit escalation policies (a policy pointing at a deactivated user fails at runtime). |

---

## 6. Services (`/services`)

Common to S1–S7: write operations require `ADMIN`; Requests are Zod-strict; idempotency N/A; traceability PRD §2, §5, §11, BR-031, AC-007 (per API_Contract).
**Escalation policy rule:** exactly one policy per service, never shared. It is created inline by S1 and can only be updated (S7) — never deleted or replaced.
**Policy user validation** (S1, S7): `level1`, `level2` = `ACTIVE` `ENGINEER` of the service's team; `level3` = `ACTIVE` `TEAM_LEAD` of the service's team; `fallbackAdmin` = `ACTIVE` `ADMIN`. Violation → `403 INVALID_ACTION`.

### S1 · `POST /services`

| Item | Definition |
|---|---|
| Purpose | Create a service and its escalation policy together. |
| Auth / Authorization | Bearer / `ADMIN` |
| Request — `CreateServiceDto` | `name` (1–50); `defaultSeverity?: P0..P3` (default `P1`); `P0ResponseSlaMinutes`, `P0ResolutionSlaMinutes`, `P1ResponseSlaMinutes`, `P1ResolutionSlaMinutes`, `P2ResponseSlaMinutes`, `P2ResolutionSlaMinutes`, `P3ResponseSlaMinutes`, `P3ResolutionSlaMinutes` (positive ints; per severity `Resolution ≥ Response`); `teamId: uuid` (must exist, else `403 INVALID_ACTION`); `escalationPolicy: { level1: uuid, level2: uuid, level3: uuid, fallbackAdmin: uuid }` |
| Response | `201 Created`, `data: ServiceResponse` (`status = ACTIVE`) |
| Errors | `422`; `400`; `401`; `403 FORBIDDEN_ROLE`; `403 INVALID_ACTION`; `409 SERVICE_ALREADY_EXISTS` |
| Consistency | Policy and service inserted in one transaction |

### S2 · `GET /services`

| Item | Definition |
|---|---|
| Purpose | List services. |
| Auth / Authorization | Bearer / `ADMIN` any team (optional `teamId` filter); `TEAM_LEAD`, `ENGINEER` own team only |
| Query — `GetAllServicesDto` | `limit?`, `offset?`, `teamId?: uuid`, `orderBy?: name\|createdAt` (default `name`), `sort?` (default `asc`) |
| Response | `200 OK`, `data: ServiceResponse[]`, offset `pagination` |
| Errors | `422`; `401`; `403 TEAM_ACCESS_DENIED` (non-admin supplying another team's `teamId`) |

### S3 · `GET /services/:serviceId`

| Item | Definition |
|---|---|
| Purpose | Get one service. |
| Auth / Authorization | Bearer / `ADMIN` any; others own team only |
| Path | `serviceId: uuid` |
| Response | `200 OK`, `data: ServiceResponse` |
| Errors | `422`; `401`; `403 TEAM_ACCESS_DENIED`; `404 SERVICE_NOT_FOUND` |

### S4 · `PATCH /services/:serviceId`

| Item | Definition |
|---|---|
| Purpose | Update a service, its SLA, team, policy link, or status. |
| Auth / Authorization | Bearer / `ADMIN` |
| Request — `UpdateServiceDto` | `name?`, `defaultSeverity?`, `status?: ACTIVE\|DEACTIVATED`, the eight SLA fields (each optional), `teamId?: uuid`, `escalationPolicyId?: uuid`; at least one field |
| Rules | SLA ordering (`Resolution ≥ Response` per severity) is checked on the **merged** (stored + sent) values. Any of: deactivation, SLA change, `escalationPolicyId` change while the service has unresolved incidents → `409 SERVICE_HAS_OPEN_INCIDENTS`. `teamId` change while **any** incident exists → `403 INVALID_ACTION` (wins over `SERVICE_HAS_OPEN_INCIDENTS`). `escalationPolicyId`: not a uuid → `422`; unknown → `404 ESCALATION_POLICY_NOT_FOUND`; attached to another service → `403 INVALID_ACTION`. The previous policy stays, unattached; policies are never deleted. Reactivation (`status: ACTIVE`) is allowed. |
| Response | `200 OK`, `data: ServiceResponse` |
| Errors | `422`; `400`; `401`; `403 FORBIDDEN_ROLE`; `403 INVALID_ACTION`; `404 SERVICE_NOT_FOUND`; `404 ESCALATION_POLICY_NOT_FOUND`; `409 SERVICE_ALREADY_EXISTS`; `409 SERVICE_HAS_OPEN_INCIDENTS` |
| Side effects | A `DEACTIVATED` service rejects webhook alerts with item code `SERVICE_DEACTIVATED` (W1). |

### S5 · `POST /services/:serviceId/escalation-policies`

| Item | Definition |
|---|---|
| Purpose | Create an escalation policy for a service. Every service already has its single policy (created by S1), so this endpoint can only report the limit. |
| Auth / Authorization | Bearer / `ADMIN` |
| Path | `serviceId: uuid` |
| Request — `CreateEscPolicyDto` | `level1: uuid`, `level2: uuid`, `level3: uuid`, `fallbackAdmin: uuid` |
| Response | **No success response is reachable.** Any valid, authorised request on an existing service returns `409 POLICIES_MAX_LIMIT_REACHED` (limit 1) |
| Errors | `422`; `400`; `401`; `403 FORBIDDEN_ROLE`; `404 SERVICE_NOT_FOUND`; `409 POLICIES_MAX_LIMIT_REACHED` |
| Consistency / Side effects | N/A |

### S6 · `GET /services/:serviceId/escalation-policies/:escalationPolicyId`

| Item | Definition |
|---|---|
| Purpose | Get the service's escalation policy. |
| Auth / Authorization | Bearer / `ADMIN` any; `TEAM_LEAD` own team only (`403 TEAM_ACCESS_DENIED`); `ENGINEER` → `403 FORBIDDEN_ROLE` |
| Path | `serviceId: uuid`, `escalationPolicyId: uuid` |
| Response | `200 OK`, `data: EscalationPolicyResponse` |
| Errors | `422`; `401`; `403`; `404 SERVICE_NOT_FOUND`; `404 ESCALATION_POLICY_NOT_FOUND` (also when the policy does not belong to `:serviceId`) |

### S7 · `PATCH /services/:serviceId/escalation-policies/:escalationPolicyId`

| Item | Definition |
|---|---|
| Purpose | Change the policy users. |
| Auth / Authorization | Bearer / `ADMIN` |
| Request — `UpdateEscPolicyDto` | `level1?`, `level2?`, `level3?`, `fallbackAdmin?` (uuids); at least one field. Policy user validation as above |
| Response | `200 OK`, `data: EscalationPolicyResponse` |
| Errors | `422`; `400`; `401`; `403 FORBIDDEN_ROLE`; `403 INVALID_ACTION`; `404 SERVICE_NOT_FOUND`; `404 ESCALATION_POLICY_NOT_FOUND`; `409 POLICY_IN_USE` (any change while the service has unresolved incidents) |
| Idempotency | natural (same patch → same result) |

---

## 7. Alert ingestion

### W1 · `POST /webhooks/alerts/:alertSourceId`

| Item | Definition |
|---|---|
| Purpose | The only entry point for external alerts. Authenticate → validate → normalize → identify → deduplicate → persist Alert + Incident + audit + outbox per alert → respond. |
| Authentication | **Source authentication**, no JWT. `alertSourceId` selects the source; the signature proves the caller holds its secret. |
| Authorization | Role: N/A. Team: the incident's team comes from the alert's service (alert → service → team); the caller cannot choose it. |
| Headers | `Content-Type: application/json` (required); `X-Signature: sha256=<hex>` = HMAC-SHA256 of `"<X-Timestamp>.<raw body>"` with the source secret (computed over the **raw** bytes); `X-Timestamp: <unix seconds>` (±300 s); `X-Request-Id` optional |
| Path | `alertSourceId: uuid` of an `ACTIVE` seeded `AlertSource`. A malformed value → `401 SOURCE_AUTH_FAILED` |
| Query | N/A |
| Request — `AlertIngestDto` | `alerts: CommonAlertInputDto[]` (1–100). Body ≤ 1 MB |

**`CommonAlertInputDto`** (the `GENERIC` source's wire format is this common format; real source formats are later adapters):

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

Each alert needs a usable identity: `sourceEventId`, or `sourceFingerprint`, or enough fields to derive a fingerprint. Otherwise the item is rejected `IDENTITY_UNRESOLVABLE`. Each alert's own JSON element is stored verbatim as `originalPayload`.

**Request-level processing order** (first failing step decides the response):

| # | Check | Failure |
|---|---|---|
| 1 | body ≤ 1 MB | `413 PAYLOAD_TOO_LARGE` |
| 2 | source exists, `ACTIVE`, signature valid (one code for all three, and for a malformed `alertSourceId`) | `401 SOURCE_AUTH_FAILED` |
| 3 | `X-Timestamp` within ±300 s | `401 REQUEST_STALE` |
| 4 | signature not already seen within the ±300 s window (stored in Redis) | `409 REPLAY_DETECTED` |
| 5 | source not rate-limited (§1.10, counted per alert) | `429 RATE_LIMITED` + `Retry-After`; if some capacity remains, the first N alerts are processed and the rest are rejected with item-level code `RATE_LIMITED` |
| 6 | envelope: `Content-Type` present and ≤100 items | `400 BAD_REQUEST`; malformed JSON, missing or empty `alerts` → `422 VALIDATION_FAILED` |
| 7 | per alert, independently, in its own transaction | per-item result |

**Identity and deduplication.** identity = `alertSourceId` + `sourceEventId`, or + `sourceFingerprint`, or + a deterministic fingerprint of `serviceId + name + environment + sorted labels`. Never a hash of the whole payload. Uniqueness applies only while the matching incident is unresolved (`OPEN`, `ACKNOWLEDGED`, `MITIGATING`): a delivery whose identity matches an unresolved incident is a `DUPLICATE`; after `RESOLVED` or `CLOSED` the same identity (event id or fingerprint) creates a **new** incident. The DB unique key, not read-then-insert, resolves concurrent deliveries (the loser is handled as `DUPLICATE`).
**Replay vs duplicate:** the exact same signed request re-sent → `409 REPLAY_DETECTED`; a new, freshly signed request carrying a known alert → `200` with `DUPLICATE`.
**Initial severity:** the `GENERIC` source has no configured `sourceSeverity` mapping yet (the mapping must be configurable); until configured, every alert's `initialSeverity` is the service's `defaultSeverity`.

**Response** — `AlertIngestResponse`: `data: { results: AlertIngestResult[] }`, same order as the input.

| Field | Type |
|---|---|
| `results[].index` | int |
| `results[].outcome` | `INCIDENT_CREATED \| DUPLICATE \| SOURCE_RESOLVED_RECORDED \| REJECTED` |
| `results[].alertId`, `results[].incidentId` | uuid \| null |
| `results[].error` | `{ code, message } \| null` (only when `REJECTED`) |

| Outcome | Meaning / persistence |
|---|---|
| `INCIDENT_CREATED` | new Alert + new `OPEN` incident + audit `INCIDENT_CREATED`, `ALERT_RECEIVED` + outbox, in one transaction |
| `DUPLICATE` | audit `ALERT_DUPLICATE` on the existing incident; no second incident |
| `SOURCE_RESOLVED_RECORDED` | delivery says the source alert is `RESOLVED`: source status and end time recorded, audit `SOURCE_ALERT_RESOLVED`; **incident status unchanged** |
| `REJECTED` | nothing stored for that alert; siblings unaffected. Codes `ALERT_INVALID`, `UNKNOWN_SERVICE`, `IDENTITY_UNRESOLVABLE`, `SERVICE_DEACTIVATED` |

**Status:** `200 OK` when the request is authentic and well-formed and **at least one** alert was not rejected. `400` with the **same `{ data: { results } }` body** when **every** alert was rejected (the sender should not retry as-is).

| Item | Definition |
|---|---|
| Errors (request level) | `413 PAYLOAD_TOO_LARGE`; `401 SOURCE_AUTH_FAILED`; `401 REQUEST_STALE`; `409 REPLAY_DETECTED`; `429 RATE_LIMITED`; `400 BAD_REQUEST`; `422 VALIDATION_FAILED`; `503 DEPENDENCY_UNAVAILABLE` (sender should retry); `500 INTERNAL_ERROR` |
| Pagination | N/A |
| Idempotency | The alert identity is the idempotency mechanism (no `Idempotency-Key`). Same alert again → `200 DUPLICATE`, same `incidentId`. |
| Consistency | Per alert, one transaction creates Alert + Incident + audit + outbox. Success is never reported for an alert before commit. Alerts in a batch are separate transactions. |
| Side effects | Sync: Alert, Incident (`OPEN`, initial severity), audit events, outbox. Async after commit: AI triage, notifications, SLA/escalation. Never inline: LLM call, email. |
| Traceability | FR-001–006, FR-030, FR-035, FR-037–039; BR-016–025, BR-032–039; ADR-009, ADR-011; AC-001–004, AC-035, AC-038, AC-043–048; UC-001 |

---

## 8. Incidents

### 8.1 Rules shared by all incident endpoints

- **Team gate:** every endpoint below applies Gate 2. An incident of another team → `403 TEAM_ACCESS_DENIED`; unknown id → `404 INCIDENT_NOT_FOUND`; a caller whose token has `teamId = null` → `403 INVALID_ACTION`.
- **Malformed `:incidentId`** → `422 VALIDATION_FAILED`.
- **Common errors** for every PATCH action (§8.3) unless overridden: `401 UNAUTHENTICATED`; `403 FORBIDDEN_ROLE`; `403 FORBIDDEN`; `403 TEAM_ACCESS_DENIED`; `403 INVALID_ACTION`; `404 INCIDENT_NOT_FOUND`; `409 INVALID_STATE_TRANSITION`; `409 CONCURRENCY_CONFLICT`; `422 VALIDATION_FAILED`; `400 BAD_REQUEST`; `500`; `503`.
- **No `Idempotency-Key`** on any incident endpoint except N1.

### I1 · `GET /incidents`

| Item | Definition |
|---|---|
| Purpose | The caller's team live incident feed. |
| Auth / Authorization | Bearer / all roles; results are always the caller's own team; no `teamId` parameter exists |
| Query — `GetIncidentsDto` | `limit?` (10 / 50); `cursor?` (opaque); `status?` (comma list of statuses); `severity?` (comma list); `serviceId?: uuid` (a service outside the caller's team returns an empty list, not `403`); `assigneeId?: uuid`; `orderBy?` (`createdAt`\|`severity`\|`status`\|`title`\|`affectedServiceId`\|`teamId`, default `severity`); `sort?` (default `asc`) |
| Response | `200 OK`, `data: IncidentListItem[]`, `pagination { nextCursor, hasMore }` |
| Errors | `422 VALIDATION_FAILED`; `422 INVALID_CURSOR`; `401`; `403 INVALID_ACTION` |
| Pagination | cursor, bound to `orderBy`/`sort`, §1.9 (mutable-column caveat applies) |
| Idempotency / Consistency / Side effects | N/A / plain read / N/A |
| Traceability | FR-010, BR-004, NFR-006, AC-008, AC-041 |

### I2 · `GET /incidents/:incidentId`

| Item | Definition |
|---|---|
| Purpose | Everything a responder needs on one screen. |
| Auth / Authorization | Bearer / all roles + team gate |
| Response | `200 OK`, `data: IncidentDetailResponse` |
| Errors | `422`; `401`; `403 TEAM_ACCESS_DENIED`; `403 INVALID_ACTION`; `404 INCIDENT_NOT_FOUND` |
| Pagination / Idempotency / Consistency / Side effects | N/A |
| Traceability | FR-008, FR-010, FR-018, BR-004, UC-002, AC-008, AC-041 |

### 8.3 `PATCH /incidents/:incidentId` — I3–I8, I10

**Request schema `UpdateIncidentDto`** (Zod-strict; every field optional):

| Field | Type | Validation |
|---|---|---|
| `status` | `"ACKNOWLEDGED" \| "MITIGATING" \| "RESOLVED" \| "OPEN"` | |
| `severity` | `P0 \| P1 \| P2 \| P3` | |
| `currentAssignee` | uuid \| `null` | |
| `resolutionSummary` | string | trimmed 1–10,000 |
| `serviceConfirmedWorking` | boolean | must be `true` for resolve, else `400 BAD_REQUEST` |
| `comment` | `{ title?: string (≤200), body: string (trimmed 1–10,000) }` | |

**A request must match exactly one row.** A body that matches no row, or more than one, returns `422 VALIDATION_FAILED`. One action per request.

| ID | Action | Body | Caller | Required incident state | Result |
|---|---|---|---|---|---|
| I3 | acknowledge | `{ "status": "ACKNOWLEDGED" }` | all roles | `OPEN` | `ACKNOWLEDGED` |
| I4 | confirm severity | `{ "status": "MITIGATING", "severity": "P1" }` | chain members | `ACKNOWLEDGED` | `MITIGATING` |
| I5 | change severity | `{ "severity": "P1" }` | chain members; in `OPEN` only `TEAM_LEAD`/`ADMIN` | `OPEN`, `ACKNOWLEDGED`, `MITIGATING` | status unchanged |
| I6 | assign | `{ "currentAssignee": "<uuid>" }` | `TEAM_LEAD`, `ADMIN` | `OPEN`, `ACKNOWLEDGED`, `MITIGATING` | status unchanged |
| I7 | unassign | `{ "currentAssignee": null, "status": "OPEN" }` | `TEAM_LEAD`, `ADMIN` | `OPEN`, `ACKNOWLEDGED`, `MITIGATING` | `OPEN` |
| I8 | resolve | `{ "status": "RESOLVED", "resolutionSummary": "…", "serviceConfirmedWorking": true }` | `TEAM_LEAD`/`ADMIN` any; `ENGINEER` only as current assignee | `MITIGATING` | `RESOLVED` |
| I10 | comment | `{ "comment": { "title": "…", "body": "…" } }` | all roles | any except `CLOSED` | status unchanged |

**Response:** `200 OK`, `data: IncidentResponse` for I3–I8. I10: `201 Created`, `data: CommentResponse`.
**Common to all rows:** headers `Authorization`, `Content-Type`; path `incidentId: uuid`; query N/A; pagination N/A; consistency = row lock, state re-checked under the lock, change + audit + outbox in one transaction, response after commit (§1.11); first committed wins.
**Wrong role** → `403 FORBIDDEN_ROLE`; **outside the chain** (I4, I5) → `403 FORBIDDEN`; **wrong state** → `409 INVALID_STATE_TRANSITION` with `details [{ currentStatus, requiredStatus }]`. Checks run in the order of §1.3; body validation runs before state checks.

**I3 acknowledge**
- Sets `status = ACKNOWLEDGED`, `acknowledgedBy` = caller, `acknowledgedAt` = now.
- If `currentAssignee` is `null`, the caller also becomes `currentAssignee` (auto-assign). Events in order: `ASSIGNED { from: null, to: caller, auto: true }`, then `ACKNOWLEDGED { acknowledgedBy: caller, autoAssigned: true }`.
- If the incident is already assigned (to the caller or to someone else) the assignee is **unchanged** and only `ACKNOWLEDGED { acknowledgedBy: caller, autoAssigned: false }` is written. Any role of the team may acknowledge an incident assigned to someone else.
- Idempotency: state-guarded; a retry gets `409` and creates no second event. Side effects (async): notification to the assignee and Team Lead; the SLA **response** clock stops.
- Traceability: FR-014, BR-007, BR-040, BR-044–046, UC-003, AC-011, AC-012, AC-016.

**I4 confirm severity**
- Sets `severity`, `severityConfirmedBy`, `severityConfirmedAt`, `status = MITIGATING`. Event `SEVERITY_CONFIRMED { from, to, statusFrom: "ACKNOWLEDGED", statusTo: "MITIGATING" }` is written even when `from = to` (a confirmation).
- The AI suggestion is never applied by the API; "accepting" it means calling this with the suggested value.
- Side effects (async): notification; SLA evaluation switches to the new severity's thresholds without resetting the clock.
- Traceability: FR-015, BR-005, BR-019–023, BR-051–054, UC-004, AC-006, AC-013.

**I5 change severity**
- Same value as current → `200`, no change, **no audit event** (natural idempotence).
- Otherwise sets `severity`; status unchanged. Event `SEVERITY_CONFIRMED { from, to, statusFrom, statusTo }` with `statusFrom = statusTo` = the current status.
- `ENGINEER` on an `OPEN` incident → `403 FORBIDDEN_ROLE`. `RESOLVED`/`CLOSED` → `409 INVALID_STATE_TRANSITION`.
- Side effects (async): SLA evaluation uses the new severity; notification.
- Traceability: FR-009, FR-015, BR-023, BR-051–054, UC-004, AC-005, AC-006, AC-021.

**I6 assign**
- `currentAssignee` must be an `ACTIVE` user of the incident's team with role `ENGINEER` or `TEAM_LEAD`, else `403 ASSIGNEE_NOT_ELIGIBLE` (the detail never reveals whether the user exists in another team). Status is unchanged; `acknowledgedBy` is never touched.
- Events: previous assignee `null` → `ASSIGNED { from: null, to: B, auto: false }`; previous assignee A → `REASSIGNED { from: A, to: B }`. Assigning the current assignee again → `200`, no event.
- Side effects (async): notification to the new assignee and Team Lead.
- Traceability: FR-011–013, BR-006, BR-040, BR-042, BR-043, UC-005, AC-009, AC-010.

**I7 unassign**
- Sets `currentAssignee = null`, `status = OPEN`, `acknowledgedBy = null`, `acknowledgedAt = null`.
- Events in order: `REASSIGNED { from: A, to: null }`, then `OPEN { statusFrom }` — the `OPEN` event is **not** written when the incident was already `OPEN`. An incident that is already unassigned and `OPEN` → `200`, nothing written.
- Side effects: as I6 (async notification).

**I8 resolve**
- Sets `resolvedBy`, `resolvedAt`, `resolutionSummary`, `status = RESOLVED`. Event `RESOLVED { resolutionSummary, serviceConfirmedWorking }`.
- Errors: `403 NOT_CURRENT_ASSIGNEE` (Engineer who is not the assignee); `400 BAD_REQUEST` (`serviceConfirmedWorking ≠ true`); `422` (summary missing).
- Idempotency: state-guarded; a retry cannot create a second postmortem job.
- Side effects (async): postmortem generation job, notification; resolution SLA stops. If generation permanently fails, the Team Lead and the resolver are notified so they can create the postmortem manually (P5). The incident stays `RESOLVED`.
- Traceability: FR-017, FR-026, FR-027, BR-005, BR-009, BR-013, BR-015, BR-059, BR-065, BR-070, UC-008, AC-012, AC-029, AC-030.

**I10 comment**
- Author is the caller (never sent). One transaction: insert `Comment` + event `COMMENT_ADDED { comment }`.
- Idempotency: none; a retry creates a second comment. Side effects: none (no notification specified).
- Traceability: FR-016, FR-018, AC-017.

**Closing an incident:** there is no close action. `CLOSED` is reached only atomically by P3 (approve) or P5 (manual create), §9.

### I11 · `GET /incidents/:incidentId/timeline`

| Item | Definition |
|---|---|
| Purpose | Append-only history of the incident. Read-only for every role; no endpoint writes audit events. |
| Auth / Authorization | Bearer / all roles + team gate |
| Query — `GetTimelineDto` | `limit?` (10 / 50), `offset?` (0), `orderBy?: createdAt`, `sort?` (default `asc`) |
| Response | `200 OK`, `data: TimelineItem[]`, `pagination { limit, offset, hasMore }` |
| Errors | `422`; `401`; `403 TEAM_ACCESS_DENIED`; `403 INVALID_ACTION`; `404 INCIDENT_NOT_FOUND` |
| Pagination | offset, §1.9 |
| Traceability | FR-018, FR-034, BR-009, RD-032, AC-012, AC-017 |

### I12 · `GET /incidents/:incidentId/alerts/:alertId`

| Item | Definition |
|---|---|
| Purpose | One alert including its original payload (separate from I2: size and secrets). |
| Auth / Authorization | Bearer / all roles + team gate |
| Path | `incidentId: uuid`, `alertId: uuid` |
| Response | `200 OK`, `data: AlertDetailResponse` |
| Errors | `422`; `401`; `403 TEAM_ACCESS_DENIED`; `403 INVALID_ACTION`; `404 INCIDENT_NOT_FOUND`; `404 ALERT_NOT_FOUND` (also when the alert belongs to another incident) |
| Traceability | BR-018, BR-038, FR-037, AC-038, AC-048 |

---

## 9. Postmortem

The postmortem is a 0..1 sub-resource of an incident. A worker generates it after `RESOLVED`; humans edit it, approve it, or (when generation fails) create it manually. Approving or manually creating it **atomically closes the incident**.

### P1 · `GET /incidents/:incidentId/postmortem`

| Item | Definition |
|---|---|
| Purpose | Read the postmortem, its generation status and review state. |
| Auth / Authorization | Bearer / all roles + team gate |
| Response | `200 OK`, `data: PostmortemResponse` for an incident that is `RESOLVED` or `CLOSED`. While no content exists yet: `generationStatus: GENERATING` and content fields `null`. |
| Errors | `422`; `401`; `403 TEAM_ACCESS_DENIED`; `403 INVALID_ACTION`; `404 INCIDENT_NOT_FOUND`; `404 POSTMORTEM_NOT_FOUND` (incident not yet `RESOLVED`) |
| Idempotency / Consistency / Side effects | N/A |
| Traceability | FR-026–029, BR-065–072, UC-009, UC-010, AC-029–033 |

### 9.2 `PATCH /incidents/:incidentId/postmortem` — P2, P3, P4

**Request schema `UpdatePostmortemDto`** (Zod-strict, all optional): the content fields `summary`, `impact`, `detection`, `timeline`, `rootCause`, `contributingFactors`, `resolution`, `correctiveActions`, `preventiveActions` (each string 1–20,000), `unknowns` (string 1–20,000 or `null`), `riskLevel` (`P0..P3`); plus `reviewStatus?: "REVIEWED"` and `generationStatus?: "GENERATING"`. **A request must match exactly one row**, else `422 VALIDATION_FAILED`. `mttrMinutes`, `provenance`, `review` and any other field are not editable.

| ID | Action | Body | Caller | Required state | State error |
|---|---|---|---|---|---|
| P2 | edit | one or more content fields only | all roles | incident `RESOLVED`; `generationStatus = DRAFT` and `reviewStatus = PENDING` | not `RESOLVED` → `403 INVALID_ACTION`; wrong postmortem state → `409 POSTMORTEM_STATE_INVALID` |
| P3 | approve | `{ "reviewStatus": "REVIEWED" }` | **chain members only** (`403 FORBIDDEN`) | incident `RESOLVED`; `generationStatus = DRAFT` and `reviewStatus = PENDING` | not `RESOLVED` → `403 INVALID_ACTION`; wrong postmortem state → `409 POSTMORTEM_STATE_INVALID` |
| P4 | retry generation | `{ "generationStatus": "GENERATING" }` | all roles | incident `RESOLVED`; `generationStatus = FAILED` | otherwise `403 INVALID_ACTION` |

**Response:** `200 OK`, `data: PostmortemResponse` for all three (P4 returns `generationStatus: GENERATING`; it is `200`, not `202`).
**Common:** headers `Authorization`, `Content-Type`; path `incidentId: uuid`; query N/A; pagination N/A. Errors in addition to the table: `422`; `400 BAD_REQUEST`; `401`; `403 TEAM_ACCESS_DENIED`; `404 INCIDENT_NOT_FOUND`; `404 POSTMORTEM_NOT_FOUND`; `409 CONCURRENCY_CONFLICT`.

**P2 edit** — updates only the sent content fields; `reviewStatus`, `reviewedBy` and `reviewedAt` are **not** changed. Idempotency: natural. Concurrent editors: last write wins. Consistency: single-row update. Side effects: none; no timeline event. Traceability: FR-028, BR-005, BR-067, AC-033.

**P3 approve** — in one transaction (postmortem and incident both locked): postmortem `reviewStatus = REVIEWED`, `reviewedBy` = caller, `reviewedAt` = now; incident `status = CLOSED`, `closedBy` = caller, `closedAt` = now. Events in order: `POSTMORTEM_REVIEWED { postmortemId, reviewedBy }`, then `CLOSED { closedAt }`. Idempotency: state-guarded (a second call → `409 POSTMORTEM_STATE_INVALID`, no second event). Side effects (async): notification. Traceability: FR-028, FR-029, BR-014, BR-015, BR-067, BR-072, UC-010, AC-015, AC-033.

**P4 retry** — flips `generationStatus` to `GENERATING` and writes an outbox event in one transaction; the worker runs later; the incident stays `RESOLVED`. Idempotency: state-guarded. Client polls P1. Traceability: FR-027, BR-013, BR-070, BR-071, NFR-009, AC-030.

### P5 · `POST /incidents/:incidentId/postmortem`

| Item | Definition |
|---|---|
| Purpose | Create the postmortem manually when AI generation has failed, and close the incident. |
| Auth / Authorization | Bearer / **chain members only**; others `403 FORBIDDEN`; team gate |
| Path | `incidentId: uuid` |
| Request — `CreatePostmortemDto` | required: `summary`, `impact`, `detection`, `timeline`, `rootCause`, `contributingFactors`, `resolution`, `correctiveActions`, `preventiveActions` (strings 1–20,000), `riskLevel` (`P0..P3`); optional: `unknowns` (string or `null`) |
| Required state | incident `RESOLVED` **and** `generationStatus = FAILED`; otherwise `403 INVALID_ACTION` |
| Response | `201 Created`, `data: PostmortemResponse` with `generationStatus: DRAFT`, `reviewStatus: REVIEWED`, `review { reviewedBy: caller, reviewedAt: now }`, `aiGenerated: false`, `provenance { model: null, modelVersion: null, generatedAt: null, promptVersion: null }`, `mttrMinutes` as defined in §3.4 |
| Errors | `422`; `400`; `401`; `403 FORBIDDEN`; `403 TEAM_ACCESS_DENIED`; `403 INVALID_ACTION`; `404 INCIDENT_NOT_FOUND`; `409 CONCURRENCY_CONFLICT` |
| Pagination / Idempotency | N/A / state-guarded (after success the incident is `CLOSED`, so a retry gets `403 INVALID_ACTION`) |
| Consistency | One transaction: postmortem content stored, incident → `CLOSED` (`closedBy` = caller, `closedAt` = now) |
| Side effects | Events in order: `POSTMORTEM_REVIEWED { postmortemId, reviewedBy }`, then `CLOSED { closedAt }`. Async: notification. No approve step follows; P2/P3 are no longer possible because the incident is `CLOSED`. |
| Traceability | FR-027, BR-013, BR-015, BR-070, OQ-008 (as decided) |

---

## 10. AI investigation

An investigation is an advisory, asynchronous brief. It never changes incident state, severity, assignment or resolution.

### N1 · `POST /incidents/:incidentId/investigations`

| Item | Definition |
|---|---|
| Purpose | Request an evidence-grounded AI brief. Optional; never blocks the incident. |
| Auth / Authorization | Bearer / all roles + team gate; allowed in **any** incident status |
| Headers | `Authorization`; `Idempotency-Key: <8–128 chars [A-Za-z0-9_-]>` (**required**) |
| Path / Query | `incidentId: uuid` / N/A |
| Request | none (no body, no free-text field) |
| Response | **First time the key is seen:** `202 Accepted`, `data: InvestigationResponse` (`status: REQUESTED`, `brief: null`, `evidence: []`). **Same key, same incident, same user:** `200 OK` with the **existing** resource in its current state. |
| Errors | `400 IDEMPOTENCY_KEY_REQUIRED`; `422`; `401`; `403 TEAM_ACCESS_DENIED`; `403 INVALID_ACTION`; `404 INCIDENT_NOT_FOUND`; `409 IDEMPOTENCY_KEY_REUSED` (key already used for another incident or by another user); `429 RATE_LIMITED`; `503 DEPENDENCY_UNAVAILABLE`; `500`. An unavailable LLM is **not** a request error: the investigation later becomes `FAILED`. |
| Pagination | N/A |
| Idempotency | **Required.** The key is globally unique. Repeat → `200` + existing resource, no second row, no second LLM call. A `FAILED` investigation is terminal: send a new request with a **new** key. |
| Consistency | One transaction: `Investigation` (`REQUESTED`) with the key + outbox event; unique constraint resolves simultaneous identical requests. |
| Side effects | Async: retrieval (team-authorized sources only) → LLM → evidence validation → store → audit `AI_INVESTIGATION_COMPLETED` on success. |
| Traceability | FR-040–045, BR-073–078, RD-035–041, ADR-012–014, UC-011, AC-049–053 |

### N2 · `GET /incidents/:incidentId/investigations`

| Item | Definition |
|---|---|
| Purpose | List the investigations requested for this incident. |
| Auth / Authorization | Bearer / all roles + team gate |
| Query — `GetInvestigationsDto` | `limit?` (10 / 50), `offset?` (0), `orderBy?: createdAt`, `sort?` (default `asc`) |
| Response | `200 OK`, `data: InvestigationResponse[]` — **full DTO** with `brief: null` and `evidence: []` in list items; offset `pagination` |
| Errors | `422`; `401`; `403 TEAM_ACCESS_DENIED`; `403 INVALID_ACTION`; `404 INCIDENT_NOT_FOUND` |
| Traceability | FR-042, FR-043, NFR-010, AC-050 |

### N3 · `GET /incidents/:incidentId/investigations/:investigationId`

| Item | Definition |
|---|---|
| Purpose | Read one brief with its evidence. |
| Auth / Authorization | Bearer / all roles + team gate |
| Path | `incidentId: uuid`, `investigationId: uuid` |
| Response | `200 OK`, `data: InvestigationResponse` (`brief` and `evidence` populated when `COMPLETED`) |
| Errors | `422`; `401`; `403 TEAM_ACCESS_DENIED`; `403 INVALID_ACTION`; `404 INCIDENT_NOT_FOUND`; `404 INVESTIGATION_NOT_FOUND` (also when it belongs to another incident) |

---

## 11. Final consistency checks

| Check | Result |
|---|---|
| Unique method + path | 31 operations; the two `PATCH` endpoints and `POST …/postmortem` are distinguished by body (§8.3, §9.2) or by method; `GET /identity/teams/:teamId/users` and `GET /identity/users/:userId` no longer collide |
| Defined once | auth, headers, envelope, errors, pagination, rate limits (§1); shared DTOs (§3) |
| Every endpoint block has | purpose, authentication, authorization, path/query/headers, request, response, errors, pagination, idempotency, consistency, side effects, traceability (`N/A` where not applicable; shared items inherited from §1, §8.1) |
| Removed from the contract | `DELETE` endpoints, `PUT …/severity`, `POST …/acknowledge`, `…/confirm-severity`, `…/resolve`, `…/close`, `…/comments` as separate routes, `POST …/postmortem/approve`, `…/retry`, `PUT …/escalation-policy`, `GET /auth/me`-style endpoints, `POSTMORTEM_NOT_REVIEWED` (unreachable: close is atomic with approve) |
| Error semantics | one status per code (`INVALID_ACTION` is always `403`) |
| Async | only N1 returns `202`; P4 returns `200` |

---

## 12. Decisions that differ from `API_Contract.md`

Base path `/api/v1`; JWT 15 min + 7-day refresh cookie, no body tokens; logout endpoints; `422` for validation; per-resource error codes; password 8–24, email ≤72, names 1–50; flat SLA fields and one inline escalation policy per service; team/service `status`; unique team and service names; offset `limit` default 10; `orderBy`/`sort` on lists; timeline and investigations use offset pagination; one `PATCH` per resource for incident and postmortem actions; atomic close on approve; manual postmortem path; `ASSIGNED`/`REASSIGNED`/`OPEN` events; rate-limit ladders; user `teamId`/`leadId` updatable; webhook per-alert rate limiting.

---

## 13. Schema extensions required (documented at requirement level)

`DB_Schema.md` does not yet hold these; the API is written to the requirement, not to today's schema.

1. `UserSession` table: `userId`, `refreshTokenHash`, `lastRefreshHash`, `ip`, `userAgent`, `lastIp`, `lastSeen`, `revoked`, timestamps.
2. Alert identity uniqueness limited to alerts whose incident is unresolved (so recurrence after `RESOLVED`/`CLOSED` creates a new incident); `Alert.sourceStatus` (`FIRING|RESOLVED`).
3. `Postmortem`: `generationStatus`, `failureReason`, `promptVersion`, `aiGenerated`; `reviewStatus` usable as in §9.
4. `Investigation`: status vocabulary `REQUESTED|RUNNING|COMPLETED|FAILED`, `completedAt`, `failureReason`, evidence linked to the investigation; idempotency key globally unique.
5. AI triage storage (`aiTriage` block).
6. `EscalationPolicy`/`AppService`: one policy per service, never shared; `AppService.escalationPolicyId` stays `NOT NULL` (policy created in the same transaction).
7. A way to remember a deactivated team's former users so reactivation restores `teamId`.
8. `Incident` foreign key `(affectedServiceId, teamId)`: service `teamId` is therefore changeable only while the service has no incidents.

---

## 14. Closed decisions (formerly open items)

| Where | Decision |
|---|---|
| P3 | approve returns `200`, `PostmortemResponse` |
| A3, A4 | `200`, body `{ "data": { "message": "Logged out successfully" } }` |
| P5 | `201`; manual postmortem has `model`, `modelVersion`, `prompt`, `inputData` = `NULL`, so `aiGenerated = false` |
| W1 | batch items beyond the remaining rate-limit capacity: item-level code `RATE_LIMITED` |
| U4 | when both apply, `USER_ASSIGNED_CURRENTLY` wins over `CONFLICT_STILL_HAS_ENGINEERS` |
| all | body/path/query validation runs before state checks |
| U1, U4 | `leadId` supplied while the user's `teamId` is `null` → `403 INVALID_ACTION` |
| A2 | refresh for a deactivated user → `403 ACCOUNT_DEACTIVATED` |

No open items remain.
