# SLICE-11 — Postmortem Generation, Review & Closure

## 1. Purpose
Produce an AI-drafted postmortem after an incident is resolved, let humans edit, approve it (which **atomically closes the incident**), retry a failed generation, or write the postmortem manually when generation fails. A postmortem is a 0..1 sub-resource of an incident; approval or manual creation is the only way an incident becomes `CLOSED`.

## 2. Scope
### In Scope
P1 read, P2 edit, P3 approve, P4 retry generation, P5 manual create (all under `/incidents/:incidentId/postmortem`); the `PATCH` dispatcher (exactly-one-row matching); the `postmortem` queue consumer for `POSTMORTEM_GENERATION_REQUESTED`; audit events `POSTMORTEM_GENERATED`, `POSTMORTEM_REVIEWED`, `CLOSED`; the postmortem notifications; `PostmortemResponse` assembly.
### Out of Scope
Inserting the `GENERATING` postmortem row and writing the first generation request (done in the I8 resolve transaction, SLICE-05); other lifecycle actions; AI triage/investigation; any reject endpoint (`REJECTED` can never be set); delete endpoints (none).

## 3. Dependencies
SLICE-05 (the transition kernel: incident row lock, state re-check, audit + outbox + notification in one transaction; the I8 transaction that creates the postmortem row), SLICE-06/08 (`appendAuditEvent`), SLICE-08 (queue, retry/DLQ, `enqueueOutbox`), SLICE-09 (`enqueueNotification`, must exist first), SLICE-01 (guard, chain-membership and team helpers), SLICE-10 (the shared AI-provider abstraction; create only the minimal interface + fake if absent and report it). The route `PATCH /incidents/:incidentId/postmortem` is owned here.

## 4. Capability Behavior

### 4.1 Postmortem lifecycle
`generationStatus`: `GENERATING → DRAFT` (success) or `GENERATING → FAILED` (terminal generation failure); `FAILED → GENERATING` (P4). `reviewStatus`: `PENDING → REVIEWED` (P3 or P5); `REJECTED` exists in the schema but is never set. The row is inserted in the I8 transaction (`GENERATING`, `PENDING`, content fields `null`); `Postmortem.incidentId` is unique, so a second row can never exist. The incident stays `RESOLVED` throughout generation and failure.

### 4.2 Generation worker (`POSTMORTEM_GENERATION_REQUESTED { postmortemId, incidentId, requestId }`)
1. Load the postmortem and incident. If `generationStatus ≠ GENERATING` or the incident is not `RESOLVED` → no-op (idempotent, covers duplicates and late jobs).
2. **Data sent to the LLM (the whole boundary):** the incident's `description` and `severity`, and **all comments** of the incident (each `title` and `description`). Nothing else (no resolution summary, alert payloads, identities, credentials). If that allowed input is empty (no description and no comments) → failure `INSUFFICIENT_CONTEXT` without a provider call.
3. Call the provider through the abstraction inside the worker, never inside a transaction. Validate the structured output: `summary`, `impact`, `detection`, `timeline`, `rootCause`, `contributingFactors`, `resolution`, `correctiveActions`, `preventiveActions` (non-empty strings, ≤ 20,000), `unknowns` (string or null), `riskLevel` (`P0..P3`). Invalid output → `OUTPUT_INVALID`.
4. **Success (one transaction):** store the content fields (`contributingFactors` ↔ column `factors`), `riskLevel`, `mttrMinutes = ceil((incident.resolvedAt − incident.createdAt) in minutes)`, provenance `model`, `modelVersion`, `prompt`, `inputData`, `generatedAt = now`; `generationStatus = DRAFT`; `failureReason = null`; append audit `POSTMORTEM_GENERATED { postmortemId }` (actor `null`); call `enqueueNotification` for `POSTMORTEM_GENERATED` (`INFO`; `occurrenceId` = that audit event's id). Guard the update with `generationStatus = GENERATING`.
5. **Failure:** retryable (provider unavailable, timeout, rate limit, transient infrastructure, invalid output) → SLICE-08 retry policy (5 attempts, exponential backoff). On exhaustion or a non-retryable error, in one transaction: `generationStatus = FAILED`, `failureReason` = `AI_UNAVAILABLE` (provider/infrastructure), `OUTPUT_INVALID`, or `INSUFFICIENT_CONTEXT` (never provider text), and `enqueueNotification` for `POSTMORTEM_GENERATION_FAILED` (`WARNING`; recipients the resolver and the policy's level3; `occurrenceId` = the outbox event id of the request). The incident stays `RESOLVED`; no audit event is written.

### 4.3 P1 — read (`GET`)
All roles, team gate. `200 PostmortemResponse` for an incident that is `RESOLVED` or `CLOSED`; while generating `generationStatus = GENERATING` with null content. Errors: `422`, `401`, `403 TEAM_ACCESS_DENIED`, `403 INVALID_ACTION` (`teamId = null`), `404 INCIDENT_NOT_FOUND`, `404 POSTMORTEM_NOT_FOUND` (incident not yet `RESOLVED`).

### 4.4 `PATCH` dispatcher — P2, P3, P4 (`UpdatePostmortemDto`, Zod-strict, all optional)
Fields: content fields `summary`, `impact`, `detection`, `timeline`, `rootCause`, `contributingFactors`, `resolution`, `correctiveActions`, `preventiveActions` (strings 1–20,000), `unknowns` (string 1–20,000 or `null`), `riskLevel` (`P0..P3`); plus `reviewStatus?: "REVIEWED"` and `generationStatus?: "GENERATING"`. **A request must match exactly one row**, else `422 VALIDATION_FAILED`; unknown fields → `400 BAD_REQUEST`; `mttrMinutes`, `provenance`, `review` are not editable. Validation precedes state checks.

| ID | Action | Body | Caller | Required state | State error |
|---|---|---|---|---|---|
| P2 | edit | one or more content fields only | all roles (team gate) | incident `RESOLVED`; `generationStatus = DRAFT`, `reviewStatus = PENDING` | incident not `RESOLVED` → `403 INVALID_ACTION`; wrong postmortem state → `409 POSTMORTEM_STATE_INVALID` |
| P3 | approve | `{ "reviewStatus": "REVIEWED" }` | **chain members only** (`403 FORBIDDEN`) | same as P2 | same as P2 |
| P4 | retry | `{ "generationStatus": "GENERATING" }` | all roles | incident `RESOLVED`; `generationStatus = FAILED` | otherwise `403 INVALID_ACTION` |

Response `200 PostmortemResponse` for all three (P4 returns `GENERATING`, not `202`). Common errors: `422`, `400`, `401`, `403 TEAM_ACCESS_DENIED`, `403 INVALID_ACTION`, `404 INCIDENT_NOT_FOUND`, `404 POSTMORTEM_NOT_FOUND`, `409 CONCURRENCY_CONFLICT`.

- **P2:** updates only the sent fields; `reviewStatus`, reviewer fields untouched; single-row update; last write wins; no audit event, no notification.
- **P3 approve (one transaction):** lock the incident row and the postmortem row, re-check both states; postmortem `reviewStatus = REVIEWED`, `reviewedBy` = caller, `reviewedAt` = now; incident `CLOSED`, `closedBy` = caller, `closedAt` = now. Audit in order: `POSTMORTEM_REVIEWED { postmortemId, reviewedBy }`, then `CLOSED { closedAt }`; `enqueueNotification` for each (`POSTMORTEM_REVIEWED` `INFO`, `CLOSED` `ALERT`; `occurrenceId` = each audit event's id). A second call → `409 POSTMORTEM_STATE_INVALID` and no second event. Use SLICE-05's transition kernel for the `RESOLVED → CLOSED` change.
- **P4 retry (one transaction):** lock; `generationStatus = GENERATING`, `failureReason = null`; write `POSTMORTEM_GENERATION_REQUESTED` through `enqueueOutbox`. State-guarded idempotency. The worker runs later; the client polls P1.

### 4.5 P5 — manual create (`POST`)
Chain members only (`403 FORBIDDEN`), team gate. Body `CreatePostmortemDto` (strict): required `summary`, `impact`, `detection`, `timeline`, `rootCause`, `contributingFactors`, `resolution`, `correctiveActions`, `preventiveActions` (1–20,000) and `riskLevel` (`P0..P3`); optional `unknowns` (string or `null`). Required state: incident `RESOLVED` **and** `generationStatus = FAILED`, else `403 INVALID_ACTION`. One transaction (incident and postmortem locked): the existing `FAILED` row is **reused** and populated; `failureReason`, `model`, `modelVersion`, `prompt`, `inputData`, `generatedAt` set to `null`; `generationStatus = DRAFT`, `reviewStatus = REVIEWED`, `reviewedBy`/`reviewedAt` set; `mttrMinutes` computed; incident → `CLOSED` (`closedBy`, `closedAt`). Audit `POSTMORTEM_REVIEWED`, then `CLOSED`, with the same two notifications as P3. `201 PostmortemResponse` with `aiGenerated = false`. Errors: `422`, `400`, `401`, `403 FORBIDDEN`, `403 TEAM_ACCESS_DENIED`, `403 INVALID_ACTION`, `404 INCIDENT_NOT_FOUND`, `409 CONCURRENCY_CONFLICT`. After success the incident is `CLOSED`, so a repeat gets `403 INVALID_ACTION`.

### 4.6 Response (`PostmortemResponse`)
`id`, `incidentId`, `generationStatus`, `reviewStatus`, `aiGenerated` (derived: `true` while `GENERATING`/`FAILED` and for an AI draft with `generatedAt` set; `false` for a P5 manual postmortem), the content fields (`null` while `GENERATING`/`FAILED`), `mttrMinutes`, `riskLevel`, `provenance { model, modelVersion, generatedAt }` (`null` values for manual), `review { reviewedBy: UserSummary, reviewedAt } | null` (set only on approve/manual create), `failureReason` (non-null only while `FAILED`; cleared by P4 and P5). `prompt` and `inputData` are never exposed. API names map to columns (`contributingFactors ↔ factors`, `mttrMinutes ↔ MTTR`).

## 5. Domain & Data Context
`Postmortem`: `id`, content columns (`summary`, `impact`, `detection`, `timeline`, `rootCause`, `factors`, `resolution`, `correctiveActions`, `preventiveActions`, `unknowns`), `MTTR int?`, `riskLevel?`, `model?`, `modelVersion?`, `prompt?`, `inputData?`, `generationStatus` (`GENERATING|DRAFT|FAILED`), `reviewStatus` (`PENDING|REJECTED|REVIEWED`), `reviewedAt?`, `reviewedById?`, `failureReason?`, `generatedAt?`, `incidentId` **unique**, timestamps. Incident closure fields: `status`, `closedById`, `closedTimestamp`. State machine: `RESOLVED → CLOSED` only here; `CLOSED` is terminal.

## 6. API Contract
P1 `GET`, P2/P3/P4 `PATCH`, P5 `POST` on `/incidents/:incidentId/postmortem` as specified above. Gate order per `AGENTS.md` §6; malformed `incidentId` → `422`; `teamId = null` → `403 INVALID_ACTION`.

## 7. Authorization & Security
Team isolation by the caller's `teamId` claim. Chain members (the four users of the incident's service policy) only for P3 and P5; every role (own team) for P1, P2, P4. The LLM receives only the allow-listed data; prompts, retrieved context and raw model output are never exposed or logged; no provider text in `failureReason`.

## 8. Consistency & Concurrency
Closure (P3, P5) is one transaction with incident-row and postmortem-row locks and state re-checks; the first committed request wins, the other gets `409 POSTMORTEM_STATE_INVALID` / `403 INVALID_ACTION`, with no second event. Concurrent approve/approve → one `CLOSED`; approve vs edit → serialized by the row lock; retry vs generation → state guard. Generation completion is guarded by `generationStatus = GENERATING`. A failed transaction leaves no partial audit/outbox/notification rows.

## 9. Async / Events / Workers
Consumes `POSTMORTEM_GENERATION_REQUESTED` on `postmortem` under the SLICE-08 policy. Writes audit `POSTMORTEM_GENERATED` (worker), `POSTMORTEM_REVIEWED` and `CLOSED` (P3/P5). Notifications: `POSTMORTEM_GENERATED` (`INFO`), `POSTMORTEM_REVIEWED` (`INFO`), `CLOSED` (`ALERT`), `POSTMORTEM_GENERATION_FAILED` (`WARNING`), recipients per SLICE-09. No LLM or email call inside an HTTP request or transaction.

## 10. Failure & Recovery
LLM outage never blocks resolve (the row is already `GENERATING` and the incident `RESOLVED`); after exhaustion the postmortem is `FAILED` and the team can retry (P4) or write it manually (P5). Redis/queue outage: the outbox republishes. A late or duplicate job is a no-op.

## 11. Implementation Surface
Incident module (postmortem controller, service, repository, DTOs, mapper, dispatcher using SLICE-05's kernel), AI module (generation processor, output validator, shared provider interface), worker registration. Database: no schema change. Tests: unit (DTO row matching, state matrix, MTTR calculation, output validator, `aiGenerated`/failure derivation), integration (PostgreSQL + fake provider + queue), concurrency.

## 12. Verification Requirements
- Generation success: content, `riskLevel`, `mttrMinutes`, provenance (including `prompt`/`inputData`, not exposed), `DRAFT`, audit `POSTMORTEM_GENERATED` and the `INFO` notification in one commit; the fake provider receives only incident description/severity and comments (title, description).
- Failure paths: provider outage/timeout/invalid output → retries then `FAILED` with the right `failureReason`, `WARNING` notification, incident still `RESOLVED`, no audit event; empty allowed input → `INSUFFICIENT_CONTEXT` without a provider call; duplicate/late jobs → no-op; one postmortem row only.
- P1: all states; `POSTMORTEM_NOT_FOUND` before resolve; `aiGenerated` derivation; no `prompt`/`inputData` in any response.
- P2: edit rules and errors; no events; reviewer fields unchanged.
- P3: chain-member-only; atomic closure with both audit events in order and both notifications; second approve → `409`; failure injected in the transaction leaves the incident not `CLOSED` and the postmortem unreviewed.
- P4: only from `FAILED`; clears `failureReason`; outbox event written; others → `403 INVALID_ACTION`.
- P5: only from `FAILED`; reuses the row; clears provenance; `201`; closes the incident; repeat → `403 INVALID_ACTION`.
- Dispatcher: exactly-one-row matching, unknown fields `400`, validation before state; authorization matrix (roles, chain, cross-team, `teamId = null`); concurrent approve/approve and approve/edit.
- After `CLOSED`, SLICE-05 lifecycle operations are rejected.

## 13. Completion Criteria
- P1–P5 and the generation worker behave exactly as specified, with the listed statuses, errors, events and notifications.
- Closure is atomic and only possible via P3/P5; no duplicate postmortem; AI failure never blocks resolve or closure.
- Concurrency, idempotency and atomicity tests pass; typecheck/lint/format clean on touched files.
