# SLICE-12 — AI Investigation & Evaluation

## 1. Purpose
Let a responder request an advisory, evidence-grounded AI brief about an incident (N1–N3), built from the incident itself and the service's past reviewed postmortems. Investigations never change incident state, severity, assignment or resolution. This slice also provides the operator-run evaluation of recurring patterns across a service's evidence, stored in the `Evaluation` table.

## 2. Scope
### In Scope
N1 request, N2 list, N3 read; the `investigation` queue consumer for `INVESTIGATION_REQUESTED`; retrieval of allowed records; output/evidence validation; `Investigation` and `Evidence` persistence; audit `AI_INVESTIGATION_COMPLETED` and its notification; the N1 rate limiter with its Admin notice; the periodic deletion job (14 days); the evaluation CLI and `Evaluation` rows.
### Out of Scope
Changing incidents; free-text questions (N1 has no body); runbooks (no runbook source exists in the MVP); any evaluation API endpoint (none exists); the triage and postmortem AI (SLICE-10, 11); editing or deleting investigations through the API (no DELETE exists).

## 3. Dependencies
SLICE-01 (guard, team/role helpers), SLICE-06/08 (`appendAuditEvent` returning the event id), SLICE-08 (queue, retry/DLQ, configuration module), SLICE-09 (`enqueueNotification`; must exist first, and its catalog gains `INVESTIGATION_REQUEST_BLOCKED`, below), SLICE-10 (the shared AI-provider abstraction; create only the minimal interface + fake if absent and report it), SLICE-11 (reviewed `Postmortem` rows are the retrieval source; the rows exist from SLICE-05's resolve transaction). Redis for the N1 rate limiter.

## 4. Capability Behavior

### 4.1 N1 — request an investigation
Auth: Bearer, all roles, own-team incident only, **any** incident status. `Idempotency-Key` header **required** (8–128 chars of `[A-Za-z0-9_-]`); no body, no query.
Order of checks: authentication → team gate (`403 TEAM_ACCESS_DENIED`, `403 INVALID_ACTION` when `teamId = null`, `404 INCIDENT_NOT_FOUND`) → header validation (`400 IDEMPOTENCY_KEY_REQUIRED` when absent; malformed id/key format → `422 VALIDATION_FAILED`) → rate limit → idempotency/creation.
- **Rate limit (Redis):** 3 requests/min per user, every request counted. Violation → `429 RATE_LIMITED` with `Retry-After`; each next violation escalates the block 10 min → 20 min → 60 min → 4 h → 8 h; at the **final stage notify all active Admins** (below). A block ends automatically. Redis unavailable → `503 DEPENDENCY_UNAVAILABLE` with `Retry-After` (fail closed); Redis state is ephemeral and resets after loss.
- **Creation (one transaction):** insert `Investigation` (`status REQUESTED`, `idempotencyKey`, `requestedById` = caller, `incidentId`, `input` = the retrieval parameters only, never prompts or data) and write `INVESTIGATION_REQUESTED { investigationId, incidentId, requestId }` via `enqueueOutbox`. The key is globally unique in the database; a unique violation is resolved by loading the existing row.
- **Responses:** first time → `202 Accepted`, `InvestigationResponse` (`status REQUESTED`, `brief null`, `evidence []`). Same key, same incident, same user → `200 OK` with the existing resource in its current state (no second row, no second LLM call). Key already used for another incident or by another user → `409 IDEMPOTENCY_KEY_REUSED`. A `FAILED` investigation is terminal; a new request needs a new key.
- An unavailable LLM is never a request error: the investigation later becomes `FAILED`.

### 4.2 N2 / N3 — read
N2: all roles, team gate, query `limit` (10/50), `offset` (0), `orderBy=createdAt`, `sort` (default `asc`); `200 InvestigationResponse[]` with `brief: null` and `evidence: []` in list items; offset pagination. N3: `200 InvestigationResponse` with `brief` and `evidence` populated when `COMPLETED`; `404 INVESTIGATION_NOT_FOUND` also when it belongs to another incident. Errors: `422`, `401`, `403 TEAM_ACCESS_DENIED`, `403 INVALID_ACTION`, `404 INCIDENT_NOT_FOUND`.

### 4.3 Worker (`INVESTIGATION_REQUESTED { investigationId, incidentId, requestId }`)
1. Load the investigation; anything other than `REQUESTED` (or a crashed `RUNNING`) that is already terminal → no-op. Claim `REQUESTED → RUNNING` with a conditional update.
2. **Retrieval (repository call, team-authorized sources only):** the incident's `description` and `severity`, and the **past reviewed postmortems of the same service**: `reviewStatus = REVIEWED`, other incidents of that service, most recent first by `reviewedAt`, **last 20 by default** (the limit is a retrieval parameter with default 20 held in the SLICE-08 configuration module; it is not an HTTP parameter), each limited to `summary`, `impact`, `rootCause`, `factors`, `resolution` and its `incidentId`. Only reviewed postmortems are eligible. Retrieval failure → `RETRIEVAL_FAILED`.
3. Build the candidate evidence list (the incident record and each retrieved postmortem), assigning each a generated id. **Data allow-list (the whole boundary):** exactly the fields above plus those ids; nothing else, no further redaction specified.
4. Call the provider through the abstraction inside the worker, never inside a transaction.
5. **Validate the output:** `evidence` items reference candidate ids only, each with `evidenceType` (`FACT|INFERENCE|UNKNOWN`), `sourceType`, `sourceReference` (origin required, no assumptions) and `relevance`; `brief` = `{ summary, findings: [{ text, evidenceIds[] }] (facts only, each cites ≥ 1 evidence id of type `FACT`), possibleAreas: [{ text, evidenceIds[] }] (inferences), suggestedSteps: [{ text }], limitations: string|null }`. At least one evidence record is required (the incident itself is always a source). Any violation → `OUTPUT_INVALID`.
6. **Success (one transaction):** persist the `Evidence` rows (`sourceType`, `sourceReference`, `relevanceInfo`, `evidenceType`, `investigationId`, `incidentId` = the source incident), set `result` = the brief, `status COMPLETED`, `completedAt`, `model`, `modelVersion`; append audit `AI_INVESTIGATION_COMPLETED { investigationId }` (actor `null`); call `enqueueNotification` for `AI_INVESTIGATION_COMPLETED` (`INFO`; `subjectUserId` = the requester; recipients per SLICE-09; `occurrenceId` = that audit event's id).
7. **Failure:** retryable (provider unavailable/timeout/rate limit, transient database/Redis, invalid output) under the SLICE-08 policy (5 attempts, exponential backoff); on exhaustion or a non-retryable error set `status FAILED` with `failureReason` `AI_UNAVAILABLE | RETRIEVAL_FAILED | OUTPUT_INVALID` (no provider text); no audit event, no notification. The incident is untouched.

### 4.4 Retention (periodic worker job)
A periodic job in the worker process deletes every `Investigation` **older than 14 days** (by `createdAt`, any status) together with its `Evidence` rows, in one transaction (evidence is deleted first). This supersedes the earlier "evidence retained while the service exists", because `Evidence` requires its `Investigation`. After deletion N2/N3 no longer return it and its idempotency key is free. Interval and batch size are configuration values with no hard-coded defaults.

### 4.5 N1 Admin notice
At the final rate-limit stage call `enqueueNotification` for `INVESTIGATION_REQUEST_BLOCKED` (type `ALERT`; recipients all active Admins; `occurrenceId` = a block-window identity chosen by this slice so repeats in one block do not duplicate). Content: user info, number of attempts, latest action. Not written to any incident timeline.

### 4.6 Evaluation (operator CLI, no API)
An operator script `ai:evaluate -- --service <serviceId>` (a `package.json` script) evaluates **recurring patterns across the evidence of a service's investigations**. It reads the service's existing `Evidence` rows and sends the provider only each evidence record's `id`, `relevanceInfo` and `evidenceType`. Output guardrails (validated before storing): structured result; every pattern cites existing evidence ids; each item is labelled factual / inference / unknown with its origin; anything unsupported is rejected. It stores one `Evaluation` row: `input` (the data sent), `evidence` (the evidence ids used), `constraints` (the guardrails applied), `result` (JSON); the service id is kept inside `input`. Team members request evaluations through an operator, who runs the script; **there is no API endpoint**. Retrieval relevance and output validity are judged by manual review of the stored rows; no automated metric is defined. Fixtures live in the `Evaluation` table (not only in the repository).

## 5. Domain & Data Context
`Investigation`: `id`, `status` (`REQUESTED|RUNNING|COMPLETED|FAILED`), `result Json?` (the brief), `model?`, `modelVersion?`, `input Json`, `idempotencyKey` **unique**, `completedAt?`, `failureReason?`, `requestedById` FK→User, `incidentId` FK→Incident, `createdAt`; indexes `(incidentId, requestedById)`, `(incidentId, status)`. `Evidence`: `id`, `sourceType?`, `sourceReference?`, `relevanceInfo?`, `evidenceType`, `investigationId` FK (required), `incidentId?` FK, timestamps. `Evaluation`: `id`, `input`, `evidence`, `constraints` (strings), `result Json`, timestamps; no relations. Invariants: every completed investigation has ≥ 1 evidence record; the brief's findings cite evidence of type `FACT`; advisory only. `InvestigationResponse`: `id`, `incidentId`, `status`, `requestedBy: UserSummary`, `createdAt`, `completedAt|null`, `brief|null` (only when `COMPLETED`), `evidence: EvidenceItem[]` (`{ id, evidenceType, sourceType, sourceReference, relevance|null }`), `failureReason|null`, `provenance { model, modelVersion }`. Never exposed: prompts, retrieved context, chain-of-thought, `input`, `idempotencyKey`.

## 6. API Contract
N1 `POST /incidents/:incidentId/investigations`, N2 `GET …/investigations`, N3 `GET …/investigations/:investigationId`, as in §4. N1 errors: `400 IDEMPOTENCY_KEY_REQUIRED`, `422`, `401`, `403 TEAM_ACCESS_DENIED`, `403 INVALID_ACTION`, `404 INCIDENT_NOT_FOUND`, `409 IDEMPOTENCY_KEY_REUSED`, `429 RATE_LIMITED`, `503`, `500`. N1 accepts no body and no query parameter.

## 7. Authorization & Security
Team isolation by the caller's `teamId` claim; retrieval is limited to the incident's own service. Only the allow-listed fields reach the provider; the API never exposes prompts, retrieved context, `input` or the idempotency key. Credentials come from configuration.

## 8. Consistency & Concurrency
N1 is one transaction; the unique `idempotencyKey` resolves simultaneous identical requests (one `202`, the rest `200`). Completion is a single transaction guarded by `status = RUNNING`. Duplicate jobs are no-ops.

## 9. Async / Events / Workers
Consumes `INVESTIGATION_REQUESTED` on the `investigation` queue under the SLICE-08 policy; the retention job is a periodic worker job. Produces audit `AI_INVESTIGATION_COMPLETED` and the `AI_INVESTIGATION_COMPLETED` / `INVESTIGATION_REQUEST_BLOCKED` notifications. No LLM call in an HTTP request or transaction.

## 10. Failure & Recovery
LLM or retrieval failure ends `FAILED` after bounded retries without affecting the incident; the requester sends a new request with a new key. Redis down: N1 returns `503`; queued work is republished from the outbox. Dead-lettered jobs are re-driven with the SLICE-08 CLI.

## 11. Implementation Surface
AI module (investigation controller, service, repository, retrieval, validator, worker processor, retention job, evaluation script), shared provider interface, rate-limit helper, worker registration. Database: no schema change. Tests: unit (validator, retrieval ordering/limit, key rules), integration (PostgreSQL + Redis + fake provider).

## 12. Verification Requirements
- N1: `202` then `200` replay; reused key (other incident/user) → `409`; missing key → `400`; concurrent identical requests → one row, one outbox event; rate limit 3/min with the full ladder and the Admin notice once per block; Redis down → `503`; authorization matrix (roles, cross-team, `teamId = null`, any incident status).
- Worker: success persists brief + evidence (≥ 1), audit event and `INFO` notification atomically; findings cite `FACT` evidence; invalid output/unknown ids/missing origin → `OUTPUT_INVALID`; provider/retrieval failures → retries then `FAILED` with the right reason and no event; the fake provider receives only the allow-listed fields; only reviewed postmortems of the same service, last 20 by default, most recent first, excluding the incident's own.
- N2/N3: DTO shapes, pagination, `brief`/`evidence` only when `COMPLETED`, `404` for another incident's investigation; nothing internal exposed.
- Retention: investigations (and evidence) older than 14 days are deleted atomically; younger ones remain; the key becomes reusable.
- Evaluation: the CLI stores an `Evaluation` row with the specified fields, sends only evidence `id`, `relevanceInfo`, `evidenceType`, and rejects unsupported output; no endpoint exists.

## 13. Completion Criteria
- N1–N3, the worker, retention job and evaluation CLI behave exactly as specified; investigations never change incident state.
- Idempotency, rate limiting and atomicity hold; no secrets/prompts exposed; tests pass; typecheck/lint/format clean on touched files.
