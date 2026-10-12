# SLICE-03 — Alert Source Trust Gate

## 1. Purpose
Authenticate and protect the single entry point for external alerts, `POST /webhooks/alerts/:alertSourceId`, before any alert is processed: size limit, source signature, timestamp freshness, replay protection, per-source rate limiting, and request-envelope validation. Hand verified, bounded input to ingestion (SLICE-04). Seed the `AlertSource` rows, including the per-source configuration that SLICE-04 reads.

## 2. Scope
### In Scope
The webhook request pipeline steps 1–6 (below), raw-body capture, HMAC verification, replay store, rate limiting with block ladder and the Admin notification at the final stage, fail-closed behavior when Redis is unavailable, and the seed script for `AlertSource` rows (secret + severity mapping).
### Out of Scope
Per-alert processing, normalization, identity, dedup, severity mapping logic and persistence (SLICE-04). Alert-source CRUD/management APIs (none exist; sources are seeded/out-of-band). Delivery of the Admin notification (SLICE-09).

## 3. Dependencies
From SLICE-00: Redis client, error envelope. From SLICE-08: the in-transaction outbox write contract `enqueueOutbox(tx, …)` and the outbox event catalog (`NOTIFICATION_REQUESTED`, routed to the `notifications` queue). If the function does not yet exist, create only the minimal function with that signature in its owning location and report it.

**Provided to SLICE-04:** a verified context `{ alertSource (including its `configuration`), items: unknown[] (≤100, in request order), rateLimitedIndices }`.

## 4. Capability Behavior
**Authentication model.** No JWT. `alertSourceId` (path) selects an `AlertSource`; the caller proves it holds the source secret by signing the request.

**Required headers.** `Content-Type: application/json`; `X-Signature: sha256=<hex>`; `X-Timestamp: <unix seconds>`; `X-Request-Id` optional. `X-Signature` = HMAC-SHA256 of the string `"<X-Timestamp>.<raw body>"` using the source secret, computed over the **raw request bytes** (capture the raw body; do not re-serialize). The secret is read from `AlertSource.configuration.signingSecret` and is never returned, logged, audited, or placed in an error message. Use constant-time comparison; for an unknown source still perform a dummy HMAC so timing is similar.

**Request-level processing order (first failing step decides the response):**
1. Body ≤ 1 MB → else `413 PAYLOAD_TOO_LARGE`.
2. Source exists, is `ACTIVE`, and signature is valid — **one code for all three and for a malformed `alertSourceId`** → `401 SOURCE_AUTH_FAILED`. A missing or unparseable `X-Signature`/`X-Timestamp` cannot produce a valid signature and is the same `401 SOURCE_AUTH_FAILED`.
3. `X-Timestamp` within ±300 s of server time → else `401 REQUEST_STALE` (retryable after re-signing).
4. Signature not already seen inside the acceptance window → else `409 REPLAY_DETECTED`. Store the seen signature in Redis (atomic set-if-absent) keyed by source + signature with a TTL that covers the whole acceptance window (timestamps are accepted up to 300 s in the past and 300 s in the future, so the TTL must be at least 600 s).
5. Source not rate-limited: **15 alerts/min per source**, counted per alert (not per request) → `429 RATE_LIMITED` with `Retry-After`. If some capacity remains, the first N alerts of the request are processed and the rest are marked for item-level rejection with code `RATE_LIMITED` (reported by SLICE-04 in `results[]`). The count is the number of elements of `alerts` when it is an array; if the body is unparseable or `alerts` is not an array there is nothing to count and step 6 decides.
6. Envelope: `Content-Type` present and ≤ 100 alerts → else `400 BAD_REQUEST`; malformed JSON, missing or empty `alerts` → `422 VALIDATION_FAILED`.
7. Per-alert processing → SLICE-04.

**Redis unavailable → fail closed.** Steps 4 and 5 depend on Redis. If Redis is unavailable when a step needs it, the request is **not** processed and the response is `503 DEPENDENCY_UNAVAILABLE` with `Retry-After` (the sender should retry). The replay check and the rate limiter are never skipped. Errors decided by steps that do not need Redis (1–3) are returned as specified.

**Rate-limit ladder.** Each violation escalates the block: 5 min → 20 min → 45 min → 2 h → block the source **and notify all active Admins**. While blocked, requests get `429 RATE_LIMITED` with the remaining `Retry-After`. A block ends automatically when its window passes. Ladder memory and the duration of the final block are implementation-defined.

**Admin notice (final stage).** In its own small transaction, write one outbox event via `enqueueOutbox`: `eventType = NOTIFICATION_REQUESTED` (queue `notifications`), `aggregateType = ALERT_SOURCE`, `aggregateId = alertSourceId`, payload `{ kind: "ALERT_SOURCE_BLOCKED", alertSourceId, attemptCount, requestId }` — ids and the minimum facts only. `ALERT_SOURCE_BLOCKED` is the notification kind defined by this slice; SLICE-09 adopts it. Recipients (all active Admins) are resolved at delivery by SLICE-09. The notice carries source info, the number of attempts and the latest action (the block); it is **not** written to any incident timeline. Derive a deterministic idempotency identity so repeated violations inside the same block do not produce duplicate notices.

**Replay vs duplicate.** The exact same signed request re-sent → `409 REPLAY_DETECTED`; a new, freshly signed request carrying an already known alert is **not** a replay (SLICE-04 reports `DUPLICATE`).

**Seeding.** `AlertSource` rows are created by a seed script (no API). The seed sets `name`, `sourceType` (`GENERIC` for the common wire format) and `configuration`:

```json
{
  "signingSecret": "<from environment/config at seed time>",
  "severityMapping": { "critical": "P0", "high": "P1", "warning": "P2", "info": "P3" }
}
```

Secrets come from environment/config at seed time, never from source code. `severityMapping` is read by SLICE-04; this slice only seeds it (the four default values above).

## 5. Domain & Data Context
`AlertSource`: `id` uuid(v7), `name`, `sourceType` (string), `configuration` (JSON; keys `signingSecret`, `severityMapping` as above), `status` (`ACTIVE|DEACTIVATED`, default `ACTIVE`), timestamps; index `(sourceType, status)`. `Alert` rows reference `alertSourceId` (SLICE-04). Redis holds replay keys and rate-limit/ladder/block state. This Redis state is intentionally ephemeral: if Redis is wiped, replay records, rate-limit counters, ladder memory and blocks reset (counters are ephemeral by design; Redis is never the source of truth for business state).

## 6. API Contract
**`POST /webhooks/alerts/:alertSourceId`** (identifier W1). Auth: source signature (no JWT). Path `alertSourceId` uuid of an `ACTIVE` seeded source. Body ≤ 1 MB: `{ "alerts": CommonAlertInputDto[] }` with 1–100 elements (item schema in SLICE-04). Request-level errors owned by this slice: `413 PAYLOAD_TOO_LARGE`, `401 SOURCE_AUTH_FAILED`, `401 REQUEST_STALE`, `409 REPLAY_DETECTED`, `429 RATE_LIMITED` (+`Retry-After`), `400 BAD_REQUEST`, `422 VALIDATION_FAILED`, `503 DEPENDENCY_UNAVAILABLE` (+`Retry-After`; sender should retry), `500 INTERNAL_ERROR`. Success and per-item results are SLICE-04's. Errors use the standard envelope.

## 7. Authorization & Security
Team isolation is derived later (alert → service → team); the caller cannot choose it. Never reveal whether a source exists or is deactivated. Signing secrets never leave the process. Reject oversize bodies without buffering beyond the limit.

## 8. Consistency & Concurrency
Replay marking is an atomic set-if-absent so two identical simultaneous requests yield exactly one success and one `409 REPLAY_DETECTED`. Rate-limit counters use atomic Redis operations; concurrent requests must not exceed the capacity.

## 9. Async / Events / Workers
Only the final-stage Admin notice: one `NOTIFICATION_REQUESTED` outbox event as specified in §4, written inside a database transaction (never a direct queue publish, no email call here). Consumed by SLICE-09 via the outbox relay (SLICE-08).

## 10. Failure & Recovery
Redis (replay store / rate limiter) unavailable → `503 DEPENDENCY_UNAVAILABLE` with `Retry-After`, nothing processed (fail closed). Database lookup failure → `503`. No partial acceptance: steps 1–6 never persist alerts. After a Redis wipe, replay protection and rate-limit state restart empty (ephemeral by design); the 300 s timestamp window still bounds old signed requests.

## 11. Implementation Surface
Application: Alerts module — webhook controller, raw-body capture middleware (mounted before JSON parsing for this route), source repository, HMAC verifier, replay store, rate limiter, envelope validator, Admin-notice writer. Infrastructure: Redis keys. Seed script. No schema change. Tests: unit (HMAC, timestamp window, ladder math), integration (Redis + PostgreSQL).

## 12. Verification Requirements
- Valid signature accepted; wrong secret, tampered body, unknown/deactivated source, malformed id, missing headers → identical `401 SOURCE_AUTH_FAILED`.
- Timestamp ±300 s boundaries → `REQUEST_STALE`.
- Replay of the identical signed request → `409`; freshly signed same alerts → passes.
- Concurrent identical requests → exactly one passes.
- Rate limit: 15 alerts/min enforced per alert count; partial-capacity batch; ladder escalation through the final block; Admin notice written exactly once per block with `kind = ALERT_SOURCE_BLOCKED`, `eventType = NOTIFICATION_REQUESTED`, and no incident timeline event.
- 1 MB boundary (`413`), 100/101 items, empty/missing `alerts`, malformed JSON, missing `Content-Type`.
- Redis down at step 4 and at step 5 → `503` with `Retry-After`, nothing stored or processed, replay/rate checks never skipped; Redis wiped → state resets and requests proceed.
- Seed creates `configuration` with `signingSecret` (from environment) and the four-value `severityMapping`; secrets never appear in logs or responses.

## 13. Completion Criteria
- Steps 1–6 behave in the stated order with the stated codes; verified context (including `configuration`) is handed to SLICE-04.
- Redis outage fails closed; replay and rate-limit state are atomic and Redis-backed; ladder and the `ALERT_SOURCE_BLOCKED` Admin notice work.
- Seed script creates sources with `signingSecret` and `severityMapping` without committing secrets; tests pass; typecheck/lint/format clean on touched files.
