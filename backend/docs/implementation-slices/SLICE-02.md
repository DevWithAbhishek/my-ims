# SLICE-02 — Service Catalog, SLA Configuration & Escalation Policy

## 1. Purpose
Let Admins define the services a team owns, each with a default severity, per-severity Response/Resolution SLA minutes, and exactly one escalation policy (four responders). Provide the configuration read-contract that ingestion (SLICE-04) and SLA/escalation (SLICE-07) consume.

## 2. Scope
### In Scope
Endpoints S1–S7; validation of SLA values and policy users; conflict rules against open incidents; the configuration read-contract for other modules.
### Out of Scope
Alert sources, incidents, SLA evaluation and escalation execution (SLICE-07), any DELETE (none exists), multiple policies per service, per-severity policies, and any inter-responder escalation timing or delay (none exists in the MVP).

## 3. Dependencies
From SLICE-01: authentication guard, role/team helpers (`requireRoles`, own-team check, `teamId = null → 403 INVALID_ACTION`). Reads `User` (role/status/team of policy users), `Team` (status), and `Incident` (existence of any incident / unresolved incidents for a service) — tables already exist.

**Contract provided to other slices (module `index.ts`):** read a service by id → `{ id, name, status, teamId, defaultSeverity, SLA minutes for P0–P3 (response/resolution), escalationPolicyId }`; read a policy by service → `{ level1, level2, level3, fallbackAdmin }` user ids.

## 4. Capability Behavior
- **One policy per service, never shared.** The policy is created inline by S1 and can only be *updated* (S7) — never deleted or replaced. S5 exists only to report the limit.
- **No inter-responder timing in the MVP.** An escalation policy consists only of its four responders (`level1`, `level2`, `level3`, `fallbackAdmin`). There is no configurable or separate delay between escalation levels, and no timing field on the policy or the service. SLA values (below) are the only time configuration this slice holds; SLA evaluation and escalation execution belong to SLICE-07.
- **Policy users** (S1, S7): `level1` and `level2` must be `ACTIVE` `ENGINEER`s of the service's team; `level3` an `ACTIVE` `TEAM_LEAD` of the service's team; `fallbackAdmin` an `ACTIVE` `ADMIN`. Violation → `403 INVALID_ACTION`. (Deactivating a user later does not edit policies; a policy pointing at a deactivated user fails at runtime in SLICE-07.)
- **SLA values:** eight positive integers (minutes): `P0…P3` × `ResponseSlaMinutes`/`ResolutionSlaMinutes`; for each severity `Resolution ≥ Response`. On PATCH the rule is checked on the **merged** (stored + sent) values.
- **Deactivation:** services are never deleted; `status` `DEACTIVATED` rejects webhook alerts for that service (item code `SERVICE_DEACTIVATED`, SLICE-04). Reactivation (`status: ACTIVE`) is allowed.
- A service's team and policy relationships are protected while incidents exist (see S4).

## 5. Domain & Data Context
`AppService`: `id`, `name` (unique), `defaultSeverity` (`P0..P3`, default `P1`), `status` (`ACTIVE|DEACTIVATED`, default `ACTIVE`), eight non-null ints `P0ResponseSlaMinutes`, `P0ResolutionSlaMinutes`, … `P3…`, `teamId` FK→Team (non-null), `escalationPolicyId` non-null **unique** FK→EscalationPolicy, timestamps; unique `(id, teamId)` (target of the Incident composite FK `(affectedServiceId, teamId)` with `onUpdate: Restrict`).
`EscalationPolicy`: `id`, `level1Id`, `level2Id`, `level3Id`, `fallbackAdminId` (all non-null FKs→User), timestamps. It has no timing/delay fields.
Invariants: every service belongs to exactly one team; has exactly one policy; a policy belongs to at most one service; service names unique; an incident's service/team pair always matches (enforced by the composite FK, which is why `teamId` cannot change once an incident exists).

## 6. API Contract
Envelope/pagination/error format per `AGENTS.md` §6; all bodies Zod-strict; writes require `ADMIN` (`403 FORBIDDEN_ROLE`). Non-Admin with `teamId = null` → `403 INVALID_ACTION` on S2, S3, S6. Every endpoint may also return `401 UNAUTHENTICATED`, `500`, `503`.

**S1 `POST /services`** — `ADMIN`. Body: `name` (1–50), `defaultSeverity?` (`P0..P3`, default `P1`), the eight SLA fields (positive ints, `Resolution ≥ Response` per severity), `teamId` (uuid; must exist and not be `DEACTIVATED`, else `403 INVALID_ACTION`), `escalationPolicy: { level1, level2, level3, fallbackAdmin }` (uuids). `201 ServiceResponse` (`status ACTIVE`). Errors: `422`, `400`, `403 FORBIDDEN_ROLE`, `403 INVALID_ACTION`, `409 SERVICE_ALREADY_EXISTS`. Policy and service are inserted in one transaction.

**S2 `GET /services`** — `ADMIN` any team (optional `teamId` filter); `TEAM_LEAD`/`ENGINEER` own team only. Query `limit` (10/50), `offset`, `teamId?`, `orderBy` (`name|createdAt`, default `name`), `sort` (default `asc`). `200 ServiceResponse[]` + `{ limit, offset, hasMore }`. Errors: `422`, `403 TEAM_ACCESS_DENIED` (non-Admin supplying another team's `teamId`), `403 INVALID_ACTION`.

**S3 `GET /services/:serviceId`** — `ADMIN` any; others own team. `200 ServiceResponse`. Errors: `422`, `403 TEAM_ACCESS_DENIED`, `403 INVALID_ACTION`, `404 SERVICE_NOT_FOUND`.

**S4 `PATCH /services/:serviceId`** — `ADMIN`. Body (≥1 field): `name?`, `defaultSeverity?`, `status?` (`ACTIVE|DEACTIVATED`), the eight SLA fields (each optional), `teamId?` (uuid), `escalationPolicyId?` (uuid). Rules:
- SLA ordering checked on merged values (`422 VALIDATION_FAILED` on violation).
- Any of: deactivation, SLA change, `escalationPolicyId` change while the service has **unresolved** incidents → `409 SERVICE_HAS_OPEN_INCIDENTS`.
- `teamId`: must reference an existing team that is not `DEACTIVATED` (else `403 INVALID_ACTION`); a change while **any** incident exists for the service → `403 INVALID_ACTION` (this wins over `SERVICE_HAS_OPEN_INCIDENTS`).
- `escalationPolicyId`: not a uuid → `422`; unknown → `404 ESCALATION_POLICY_NOT_FOUND`; attached to another service → `403 INVALID_ACTION`. The previous policy remains, unattached; policies are never deleted.
- `200 ServiceResponse`. Errors: `422`, `400`, `403 FORBIDDEN_ROLE`, `403 INVALID_ACTION`, `404 SERVICE_NOT_FOUND`, `404 ESCALATION_POLICY_NOT_FOUND`, `409 SERVICE_ALREADY_EXISTS`, `409 SERVICE_HAS_OPEN_INCIDENTS`.

**S5 `POST /services/:serviceId/escalation-policies`** — `ADMIN`. Body `{ level1, level2, level3, fallbackAdmin }` (uuids, validated for shape). No success path: any valid, authorised request on an existing service returns `409 POLICIES_MAX_LIMIT_REACHED`. Errors: `422`, `400`, `403 FORBIDDEN_ROLE`, `404 SERVICE_NOT_FOUND`, `409 POLICIES_MAX_LIMIT_REACHED`.

**S6 `GET /services/:serviceId/escalation-policies/:escalationPolicyId`** — `ADMIN` any; `TEAM_LEAD` own team (`403 TEAM_ACCESS_DENIED`); `ENGINEER` → `403 FORBIDDEN_ROLE`; non-Admin null team → `403 INVALID_ACTION`. `200 EscalationPolicyResponse`. Errors: `422`, `404 SERVICE_NOT_FOUND`, `404 ESCALATION_POLICY_NOT_FOUND` (also when the policy does not belong to `:serviceId`).

**S7 `PATCH /services/:serviceId/escalation-policies/:escalationPolicyId`** — `ADMIN`. Body (≥1 of) `level1?`, `level2?`, `level3?`, `fallbackAdmin?` (uuids); user validation as above. `200 EscalationPolicyResponse`. Errors: `422`, `400`, `403 FORBIDDEN_ROLE`, `403 INVALID_ACTION`, `404 SERVICE_NOT_FOUND`, `404 ESCALATION_POLICY_NOT_FOUND`, `409 POLICY_IN_USE` (any change while the service has unresolved incidents). Natural idempotence (same patch → same result).

**Response types.** `ServiceResponse { id, name, defaultSeverity, status, P0ResponseSlaMinutes, P0ResolutionSlaMinutes, P1…, P2…, P3… (8 ints), teamId, escalationPolicyId, createdAt, updatedAt }`. `EscalationPolicyResponse { id, level1, level2, level3, fallbackAdmin (uuids), createdAt, updatedAt }`.

## 7. Authorization & Security
Gate order per `AGENTS.md` §6; all writes `ADMIN`; team isolation for reads of non-Admins; policy reads hide nothing sensitive but are restricted as listed.

## 8. Consistency & Concurrency
S1 is one transaction. S4/S7 run the open-incident check and the update in one transaction; to avoid racing with incident creation, take a lock on the service row (the same row ingestion references) before checking, and re-check under the lock. Name uniqueness is enforced by the database (`SERVICE_ALREADY_EXISTS`). The "any incident exists / unresolved incident exists" checks query `Incident` by `affectedServiceId`.

## 9. Async / Events / Workers
None. No audit events (the incident timeline is incident-scoped).

## 10. Failure & Recovery
Any failure rolls back the whole write (service + policy together in S1). A deactivated policy user is not detected here; it is a runtime failure in SLICE-07.

## 11. Implementation Surface
Application: AppService module (controller, service, repository, Zod DTOs, public config read interface). Database: no schema change. Tests: unit (SLA merge validation, policy-user validation), integration (all endpoints, constraints, conflict rules, concurrency with incident rows inserted directly).

## 12. Verification Requirements
- Each endpoint's success shape; each documented error code incl. precedence (`INVALID_ACTION` team change over `SERVICE_HAS_OPEN_INCIDENTS`).
- SLA merge validation (PATCH one field making `Resolution < Response` fails; valid partial updates pass).
- S1, S5 and S7 accept no timing/delay field (unknown fields → `400 BAD_REQUEST`); `ServiceResponse` and `EscalationPolicyResponse` contain none.
- Policy-user validation per level (wrong role, wrong team, deactivated, ADMIN fallback).
- S1 atomicity (invalid policy user leaves no service/policy rows); unique names; `escalationPolicyId` reassign rules and orphaned previous policy retained.
- Authorization matrix per role, own/other team, `teamId = null`.
- Concurrent S4 deactivation vs incident insertion yields a consistent outcome.

## 13. Completion Criteria
- S1–S7 behave exactly as specified; S5 always returns `409 POLICIES_MAX_LIMIT_REACHED` for valid requests.
- No inter-responder escalation timing exists in the configuration contract, schema usage, DTOs or responses.
- The configuration read-contract is exported and returns the data listed in §3.
- Database enforces name/policy uniqueness; checks and updates are transactional; tests pass; typecheck/lint/format clean on touched files.
