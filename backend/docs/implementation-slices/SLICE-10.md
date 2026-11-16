# SLICE-10 — AI Alert Triage (Advisory)

## 1. Purpose
After an incident is persisted, asynchronously ask an LLM to classify the alert, suggest a severity, give a confidence and supporting evidence, and store it as an advisory suggestion responders can read. AI never blocks persistence and never changes incident state, severity or assignment.

## 2. Scope
### In Scope
The `ai-triage` queue consumer for `ALERT_TRIAGE_REQUESTED`; use of the shared AI-provider abstraction; the data allow-list; output validation; `AITriage` persistence (success and failure states); on success the `AI_TRIAGE_COMPLETED` audit event and its notification.
### Out of Scope
Exposing the suggestion (the `aiTriage` object in `GET /incidents/:incidentId`, SLICE-06); applying a suggestion (a user calls the severity-confirm action, SLICE-05); postmortem and investigation AI (SLICE-11, 12); any triage endpoint (none exists, including no manual retry endpoint).

## 3. Dependencies
SLICE-08 (queue, retry/DLQ policy, configuration), SLICE-06/08 (`appendAuditEvent`, which returns the event id), SLICE-09 (`enqueueNotification`; must exist first), SLICE-04 (alert and incident exist; the outbox event is written at creation). AI provider abstraction (ADR-013): one interface shared by slices 10, 11, 12; no vendor SDK in business code. If the abstraction does not exist yet, create only the minimal interface (single `generate` call returning text + model + model version) plus a fake, and report it.

## 4. Capability Behavior
Job `ALERT_TRIAGE_REQUESTED { alertId, incidentId, requestId }`:
1. **Data allow-list (the whole boundary).** Only these fields of the `Alert` row may be sent to the provider: `summary`, `description`, `labels`, `additionalDetails`. Nothing else (no payload, no identifiers, no credentials, no incident or service data). No further redaction inside the allowed fields is specified.
2. Upsert the `AITriage` row for `alertId` with `failureStatus = PENDING` (the unique `alertId` makes duplicates safe). Already `SUCCESS` → no-op.
3. Call the provider through the abstraction **inside the worker, never inside a database transaction**.
4. Validate the output strictly: `category` (non-empty string), `suggestedSeverity` (`P0..P3`), `confidence` (number 0–1), `evidence` (array of `{ type, reference, excerpt }` of bounded non-empty strings), plus an internal `summary` and `reasoning`. Output that fails validation is never stored as a valid suggestion; the raw output may be kept in `rawOutput` for diagnosis and is never exposed.
5. **Success:** in one transaction update the row (`suggestedSeverity`, `category`, `summary`, `reasoning`, `confidence`, `evidence`, `rawOutput`, `model`, `modelVersion`, `failureStatus = SUCCESS`), append audit `AI_TRIAGE_COMPLETED { createdAt }` (actor `null`; `createdAt` = the instant the result is stored = the API's `generatedAt`), and call `enqueueNotification` for `AI_TRIAGE_COMPLETED` (type `INFO`; recipients per SLICE-09: the policy's level3 and fallbackAdmin; `occurrenceId` = that audit event's id).
6. **Failure:** classify retryable (provider unavailable, timeout, rate limit, transient database/Redis, and invalid model output, since a retry can succeed) vs non-retryable (invalid job payload, alert not found, configuration/authentication error); retry under the SLICE-08 policy (exponential backoff, 5 attempts, dead-letter on exhaustion); on exhaustion or a non-retryable error set `failureStatus = FAILED` and write **no** timeline event or notification. The incident stays fully usable; a Team Lead can set the severity manually.
7. The suggestion is advisory: this slice has no write path to `Incident`. Triage runs regardless of the incident's current status.

API-visible derivation (SLICE-06): no row or `PENDING` → `aiTriage.status = PENDING`; `SUCCESS` → `COMPLETED`; `FAILED` → `UNAVAILABLE`. Only `category`, `suggestedSeverity`, `confidence`, `evidence`, `reasoning` (as `reasoningSummary`), `model`, `modelVersion`, `generatedAt` are exposed; the internal `summary` and `rawOutput` never.

## 5. Domain & Data Context
`AITriage`: `id`, `alertId` **unique** FK→Alert (one triage per alert), `suggestedSeverity?`, `category?`, `summary?`, `reasoning?`, `confidence float?`, `rawOutput Json?`, `failureStatus` (`PENDING|FAILED|SUCCESS`, default `PENDING`, the existing `LifecycleStates` enum), `evidence Json?`, `model?`, `modelVersion?`, timestamps. Provenance stored: `model`, `modelVersion` and `rawOutput` (the table has no prompt/input columns; none are added). Invariants: AI output is advisory; stored evidence is the validated structured form.

## 6. API Contract
None owned (read exposure is SLICE-06's `aiTriage` object: always present; while `PENDING`/`UNAVAILABLE` all values `null` and `evidence: []`).

## 7. Authorization & Security
Worker only. Only the four allow-listed fields leave the system; provider credentials come from configuration; prompts and raw model output never appear in API responses or logs.

## 8. Consistency & Concurrency
`alertId` unique + status check make duplicate jobs no-ops. The success update, audit event and notification commit together. Parallel jobs for one alert: one wins by row lock / status check.

## 9. Async / Events / Workers
Consumes `ALERT_TRIAGE_REQUESTED` on `ai-triage` under the SLICE-08 reliability policy; provider rate limits/quota are retryable. Produces audit `AI_TRIAGE_COMPLETED` and an `AI_TRIAGE_COMPLETED` notification on success only.

## 10. Failure & Recovery
LLM down for days: every incident is still persisted, assignable and resolvable; triage ends `FAILED` after bounded retries; dead-lettered jobs can be re-driven with the SLICE-08 CLI. Invalid output counts as a failure. A storage failure rolls back and retries.

## 11. Implementation Surface
AI module: triage processor, provider interface + fake (shared), output validator (Zod), allow-list projection, repository. Database: no schema change. Tests: unit (validator accept/reject, allow-list projection, status derivation), integration (PostgreSQL + fake provider + queue).

## 12. Verification Requirements
- Success stores validated fields, `SUCCESS`, model/version, the audit event and one `INFO` notification (recipients level3 + fallbackAdmin) in one commit; the incident row is untouched.
- Invalid output (bad severity, confidence out of range, malformed evidence) → not stored as valid; retry then `FAILED` with no timeline event and no notification.
- Duplicate/parallel jobs → single record, single audit event, single notification.
- Provider outage/timeout/429 → retried with backoff; incident creation and management still work throughout (ingestion test with the provider down).
- The fake provider receives only `summary`, `description`, `labels`, `additionalDetails`.
- `AITriage` never changes `Incident.severity` or status.

## 13. Completion Criteria
- Triage runs asynchronously after commit and stores a validated advisory suggestion or a failure state.
- Idempotent; success is atomic with its audit event and notification; no state change to incidents; no external call in transactions.
- Tests pass; typecheck/lint/format clean on touched files.
