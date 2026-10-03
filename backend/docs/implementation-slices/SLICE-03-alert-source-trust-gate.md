# SLICE-03 — `Alert Source Authentication, Replay Protection & Rate Limiting`

> **Authority:** Canonical documents remain authoritative; this is a derived implementation view.
> **Evidence tags:** `[C]` CANONICAL · `[D]` DERIVED · `[P]` PROPOSED · `[UDR-nn]` USER DECISION REQUIRED (see `00-INDEX`) · `[UNK]` UNKNOWN · `[N/A]` NOT APPLICABLE.
> **Sources:** `PRD` (Revised Draft, 19 Sep 2026) · `ARCH` (unversioned) · `DM` (unversioned) · `DBS` (unversioned, "proposed MVP Schema").

## 0. Slice Metadata

| Field | Value |
|---|---|
| Slice ID | `SLICE-03` |
| Capability | Alert Source Authentication, Replay Protection & Rate Limiting |
| Version | `0.1` (DRAFT) |
| Status | `PLANNED` (DESIGN / PRE-IMPLEMENTATION) |
| MVP | `YES` (PRD §15) |
| Created / Last Updated | `2026-10-01` / `2026-10-01` |
| Primary Owner / Module | `Alerts` (ARCH: owns "AlertSource") |

### Canonical Sources
- `PRD.md` — FR-001, FR-002, FR-035; RD-007, RD-025; AC-001, AC-002, AC-035; §10; §12.4, 12.5, 12.8, 12.9; §15; UC-001 (preconditions); NFR-004
- `Domain_Model.md` — Alert_Source → Alert 0..N; "Every alert has one source."
- `Architecture.md` — Sync flow ("Source Authentication" before Alerts); ADR-005 (Redis: rate limiting); Concerns (Security Boundaries)
- `DB_Schema.md` — `AlertSource`, `idx_alertSource_type`
- `API_Contracts.md` — NOT AVAILABLE · `DESIGN_CHECKS.md` — NOT PROVIDED

### Related Slices
- `SLICE-04` — consumes the verified source context; owns the ingestion transaction
- `SLICE-08` — shares Redis dependency (failure behavior: UDR-21)

---

# 1. Capability Overview

## 1.1 Problem
Only genuine, fresh, non-abusive requests from configured alert sources may reach incident creation. [C: PRD §12.4–12.5, §12.9]

## 1.2 Purpose
Act as the trust gate in front of ingestion: authenticate the source, reject replayed/stale requests, enforce size limits, and rate-limit per authenticated source — all before any DB write. [C: ARCH sync flow; PRD §12.8]

## 1.3 Behavior
Invalid authentication, replay, oversize, or over-limit requests are rejected and create no incident (AC-001, AC-002, AC-035). Valid requests pass a verified source context onward.

## 1.4 End-to-End Summary
```text
HTTP request
   ↓
Identify configured source (how: UNK)
   ↓
Authenticate (signature / timestamp / event-ID, as supported by the source)
   ↓
Replay check
   ↓
Payload size limit + per-source rate limit
   ↓
Verified source context → SLICE-04   |   Reject (no incident created)
```

---

# 2. Scope

## 2.1 In Scope
- `AlertSource` registry (type, configuration, status) [C: PRD §9, DBS]
- Source authentication per configured method; replay/staleness rejection; payload size limit; per-source rate limit [C]

## 2.2 Out of Scope
- Payload validation/normalization, identity, dedup, persistence → `SLICE-04`
- User authentication → `SLICE-01`
- Additional source adapters beyond one representative source [C: PRD §15 Out of Scope / "One representative external alert source"]

## 2.3 MVP Scope
One representative source through the common contract [C: PRD §15]. (PRD RD-005 says "multiple external alert sources" — conflicting wording, SD-05 / UDR-10.)

## 2.4 Future Scope
Additional source adapters without changing the incident workflow [C: PRD §15/§16].

---

# 3. Requirement Traceability

| ID | Type | Source | Version | Requirement | Class |
|---|---|---|---|---|---|
| FR-001 | Functional | PRD §6 | PRD-RD | "The system exposes authenticated ingestion endpoints for supported external alert sources." | C |
| FR-002 | Functional | PRD §6 | PRD-RD | "Alert requests use the authentication and replay checks supported by the source, including signature, timestamp, and event ID validation where applicable." | C |
| FR-035 | Functional | PRD §6 | PRD-RD | "Alert ingestion is rate-limited per authenticated source." | C |
| RD-007 | Decision | PRD §17 | PRD-RD | "Inbound alert rate limiting is applied per authenticated source." — "Each configured source has its own limit." | C |
| RD-025 | Decision | PRD §17 | PRD-RD | "Alert authentication and replay protection use the checks supported by each source." — "Signature, timestamp, and event ID checks are used where applicable." | C |
| AC-001 | Acceptance | PRD §20 | PRD-RD | "An unauthenticated or invalidly authenticated alert request is rejected and does not create an incident." | C |
| AC-002 | Acceptance | PRD §20 | PRD-RD | "A replayed or stale alert request is rejected according to the configured source authentication and replay rules." | C |
| AC-035 | Acceptance | PRD §20 | PRD-RD | "Inbound alert rate limiting is enforced per authenticated source." | C |
| §12.4 | Security | PRD §12 | PRD-RD | "Validate the authentication method configured for each supported source. Verify signatures where the source provides signed requests. Validate timestamps where timestamp checks are supported. Validate event IDs or equivalent source identifiers where available." | C |
| §12.5 | Security | PRD §12 | PRD-RD | "Reject stale or invalidly authenticated requests. Prevent reuse of previously processed event IDs or equivalent identifiers where applicable." | C |
| §12.8 | Security | PRD §12 | PRD-RD | "Reject alert/API payloads exceeding configured limits." | C |
| §12.9 | Security | PRD §12 | PRD-RD | "Apply inbound alert rate limiting per authenticated source." | C |
| NFR-004 | Performance | PRD §13 | PRD-RD | "An accepted alert should result in a persisted alert/incident within 5 seconds, excluding asynchronous AI processing and external provider latency." | C |
| ADR-005 | Decision | ARCH | unv. | Redis used for "caching, rate limiting and backing data store for workers." | C |
| DM-AlertSource | Domain | DM | unv. | "Every alert has one source." | C |

BR-016…BR-025 and BR-032…BR-039 belong to `SLICE-04`.

---

# 4. Business Rules
This slice has **no dedicated BR-xxx IDs**; its rules are FR-002, FR-035, §12.4/12.5/12.8/12.9, and RD-007/RD-025. [D]

## Rule (FR-002 / RD-025) — Per-source authentication and replay checks
- **Canonical Rule:** see §3 (FR-002, RD-025, §12.4, §12.5).
- **Operational Interpretation:** each source type defines which of {signature, timestamp, event-ID} applies; the gate runs exactly those. [D]
- **Engineering Consequence:** a strategy/adapter per `sourceType`; unsupported checks are skipped, not faked. Stale-timestamp tolerance, algorithm, secret storage: [UDR-10].
- **Invalid Conditions:** bad signature; stale timestamp; reused event ID; deactivated source (`status=DEACTIVATED` [D from DBS]).
- **Class:** C (rule) / UNK (parameters).

## Rule (FR-035 / RD-007) — Per-source rate limit
- **Operational Interpretation:** counter keyed by `alertSourceId`; each source has its own limit [C: RD-007] — where the limit is configured [UNK; likely `AlertSource.configuration` — P].
- **Engineering Consequence:** limit evaluated *after* authentication (limit is per *authenticated* source) [D]; Redis-backed [C ADR-005]. Redis outage behavior: [UDR-21].
- **Invalid Conditions:** over-limit → rejection (status code [UNK]); no incident.

## Tension to record — replay rejection vs. valid duplicate delivery
AC-002 rejects "replayed" requests; AC-003/§14 say "valid duplicate delivery is safely deduplicated". A legitimate source retry carrying the same event ID can be either. [D] Resolution (reject-at-gate vs accept-and-dedup) is [UDR-10].

---

# 5. Functional Behavior

**5.1 Authenticate source request** — Trigger: inbound request. Input: headers/body per source type. Preconditions: source exists and `ACTIVE` [D]. Processing: locate source [UNK how: path/header/credential] → verify per-source method → on success produce `{alertSourceId, sourceType, configuration}`. State change: none. Failure: reject, no DB writes [C AC-001].

**5.2 Replay protection** — Check timestamp window and event-ID reuse where the source supports them. Store of seen IDs: [UDR-10: Redis vs DB]. Failure: reject [C AC-002].

**5.3 Payload size limit** — reject oversize before parsing the full body [C §12.8; limit value UNK].

**5.4 Per-source rate limit** — increment/check per source in Redis; reject when exceeded [C AC-035].

**5.5 AlertSource management** — create/configure/deactivate sources. **Actor is not defined**: PRD Admin stories list users, teams, services, policies only [UDR-10].

---

# 6. Acceptance Criteria

## AC-001 — Invalid auth rejected
**Given:** missing/invalid credentials or signature · **When:** alert request received · **Then:** rejected; no Alert/Incident/Outbox rows. **Verification:** integration test asserting zero rows.
## AC-002 — Replay/stale rejected
**Given:** a previously accepted request or stale timestamp · **When:** resent · **Then:** rejected per source rules. **Verification:** replay test with captured signed request.
## AC-035 — Rate limit per source
**Given:** source A exceeds its limit · **When:** more requests · **Then:** A throttled; source B unaffected. **Verification:** two-source load test.

---

# 7. Domain Model

## 7.1 Entities
| Entity | Role |
|---|---|
| Alert_Source (`AlertSource`) | Registry entry: name, `sourceType`, `configuration` jsonb, status |

## 7.2 Relationships — AlertSource→Alert 0..N [C DM].
## 7.3 Invariants
| Invariant | Enforcement |
|---|---|
| Source status ∈ {ACTIVE, DEACTIVATED} | DB CHECK |
| Only ACTIVE, authenticated sources reach ingestion | Application [D] |
| Secrets not stored in source code | Process [C §12.6]; whether secrets live in `configuration` jsonb or env/secret manager: [UDR-10] |

## 7.4 State Machine — `AlertSource.status`: `ACTIVE ↔ DEACTIVATED` [C DBS]; transition ownership: this slice.

---

# 8. Architectural Context

## 8.1 Relevant Architecture
Sync flow: "Alert Source → API → Source Authentication → Alerts (Validate, Normalize, Identify, Deduplicate)". Redis for rate limiting [C ADR-005].

## 8.2 Components
| Component | Responsibility |
|---|---|
| Controller / guard | Run gate before ingestion handler |
| Source auth strategies | Per `sourceType` verification [P] |
| Rate limiter | Redis counter [C] |
| Repository | `AlertSource` |

## 8.3 Constraints
No external calls inline except Redis; all gate checks must fit NFR-004's 5 s budget [D].

## 8.4 ADRs
- **ADR-005** Redis for rate limiting — adds an availability dependency; failure handling "must be handled separately for cache, rate limiting and queue processing" [C] → [UDR-21].

---

# 9. Dependency Model
## 9.1 Upstream — Redis (infra); `AlertSource` config.
## 9.2 Downstream
| Slice | Relationship | Provides |
|---|---|---|
| 04 | SYNC | verified source context |
## 9.3 Contract
**Allowed:** `VerifiedSource` context object. **Forbidden:** SLICE-04 re-implementing signature checks; this slice touching Alert/Incident tables.

---

# 10. Slice Coupling Analysis
## 10.1 Transactional — **NO** (no DB writes before the ingestion transaction) [D].
## 10.2 Synchronous — **YES (hard, in-request)** with 04; acceptable because the interface is a single verified-context object [D].
## 10.3 Shared Invariants — **NO** (replay vs dedup are *different* invariants: request freshness vs alert identity) [D].
## 10.4 Summary
| Related Slice | Coupling | Strength | Boundary Decision |
|---|---|---|---|
| 04 | Sync | Hard (flow) / Soft (data) | SEPARATE |
| 08 | Redis infra | Soft | SEPARATE |
### Boundary Decision
Different failure semantics (reject vs persist), different dependencies (Redis, secrets), and no shared transaction → separate. If replay tracking turns out to need DB-level atomicity with dedup (UDR-10), re-evaluate merging into 04.

---

# 11. Data Model
## 11.1 Tables — `AlertSource`.
## 11.2 Fields
| Field | Type | Purpose | Required? |
|---|---|---|---|
| `name` | text | label | Yes |
| `sourceType` | text | selects adapter/auth strategy | Yes (no CHECK) |
| `configuration` | jsonb | auth config, possibly mappings [UNK] | Yes |
| `status` | text CHECK | ACTIVE/DEACTIVATED | Yes |
## 11.3 Constraints — CHECK(status); index `idx_alertSource_type(sourceType, status)`.
## 11.4 DB Invariants — status domain only.
## 11.5 Migration — no seen-event-ID store in DBS; if DB-based, a new table is needed [UDR-10].

---

# 12. Transaction & Consistency Model
No DB transaction in this slice [D]. Replay marker write must not be lost between check and acceptance; if Redis-based, a crash after marking but before persisting would reject the source's retry — interacts with at-least-once delivery of sources [D → UDR-10].

---

# 13. Idempotency & Concurrency
## 13.1 Idempotency — event ID (where provided) is the replay identity; relation to alert identity (`SLICE-04`) [UDR-10].
## 13.2 Concurrency — **Race:** same signed request delivered concurrently. **Protection:** atomic set-if-absent on the replay store [P]. **Expected:** one proceeds. **Required test:** parallel identical requests.

---

# 14. API Surface — Preliminary
`PRELIMINARY — API CONTRACT NOT YET FROZEN`

| Candidate operation | Actor / Authz | Input | Domain action | Output | Failures | Idempotency / concurrency | Confidence · Missing |
|---|---|---|---|---|---|---|---|
| Alert ingestion endpoint(s) (`POST /…alerts…`) — shared with `SLICE-04` | alert source (authenticated per source) | raw payload + auth headers | gate then hand to 04 | per-alert result (UDR-19) | 401/403, replay rejection, 413, 429 [P codes] | replay vs dup (UDR-10) | High (exists) · endpoint-per-source vs one endpoint, source identification, status codes |
| Manage alert sources | **UNKNOWN actor** | name, type, config, status | registry write | source (secrets masked) | 400/403 | — | Low · UDR-10 |

Pagination: [N/A for ingestion]. Timing: synchronous within 5 s [C NFR-004].

---

# 15. Events, Queues & Side Effects
Events: none. Queue: none (rate limiting uses Redis counters, not queue jobs). External side effects: none. Rejections are logged, not audited per incident (no incident exists; `AuditEvent` requires incident context for timeline) [D].

---

# 16. Security & Authorization
## 16.1 Authentication — per-source method [C §12.4].
## 16.2 Authorization — an authenticated source may only submit alerts, nothing else [D].
## 16.3 Isolation — AlertSource has no `teamId` in DBS; team comes from the target service [D → SLICE-04].
## 16.4 Input Security — signature verification; timestamp validation; replay protection; size limit; rate limit [C].
## 16.5 Sensitive Data — Never log: signing secrets, tokens, raw auth headers [C §12.6, AC-037]. Store securely: source secrets (location UNK, UDR-10); mask in API responses.

---

# 17. Failure Modes
| Failure | Detection | Expected | Recovery |
|---|---|---|---|
| Bad signature/credential | verification | reject, no rows [C AC-001] | source fixes config |
| Replay/stale | timestamp/ID store | reject [C AC-002] | — |
| Oversize | size check | reject [C §12.8] | — |
| Rate exceeded | Redis counter | reject [C AC-035] | source backs off |
| Redis down | client error | **UNK** [UDR-21] (fail-open vs fail-closed) | — |
| Source deactivated | status check | reject [D] | Admin reactivates |
## Critical Failure Scenario
**What fails:** replay store unavailable. **Must remain true:** no unauthenticated alert creates an incident. **Recovery:** [UDR-21].

---

# 18. Observability
- Logs: rejection reason by source (no secrets); rate-limit hits. [C FR-034/NFR-003]
- Correlation ID per request. Metrics: `alert_rejected_total{reason,source}`, `alert_rate_limited_total{source}`.
- Audit events: none applicable (no incident) [D].

---

# 19. Testing Strategy
- **Unit:** signature verify, timestamp window, rate-limit calc.
- **Integration:** zero DB rows on rejection; Redis counter behavior.
- **API:** `BLOCKED — API CONTRACT NOT YET FROZEN`.
- **Authorization:** deactivated source rejected.
- **Concurrency:** parallel replay of the same signed request.
- **Idempotency:** replay vs duplicate behavior (after UDR-10).
- **Failure injection:** Redis down (after UDR-21). **Regression:** gate before ingestion on every route.

---

# 20. Test ↔ Requirement Traceability
| Requirement | AC | Test(s) | Status |
|---|---|---|---|
| FR-001 | AC-001 | invalid-auth test | NOT RUN |
| FR-002 | AC-002 | replay/stale tests | NOT RUN |
| FR-035 | AC-035 | per-source rate-limit test | NOT RUN |
| §12.8 | — | oversize test | NOT RUN |
### Coverage Gaps
- No AC for payload size limit; no AC for deactivated source.

---

# 21. Implementation Plan
## 21.1 Sequence
1. Decide UDR-10/21. 2. `AlertSource` model. 3. One auth strategy for the representative source. 4. Replay store. 5. Rate limiter. 6. Gate wiring.
## 21.2 Files
### CREATE
```text
src/alerts/source-auth/** · test/alerts/source-auth/**
```
### MODIFY
```text
prisma/schema.prisma (AlertSource)
```
### REVIEW ONLY
```text
PRD §12 · ARCH ADR-005
```
## 21.3 Allowed — Alerts module gate code. 
## 21.4 Forbidden — Alert/Incident persistence; schema beyond `AlertSource` unless approved.
## 21.5 Must exist — Redis available; config/secret loading.

---

# 22. AI Agent Context
## 22.1 Read First
1. `AGENTS.md` 2. This slice 3. `PROJECT_STATE.md` 4. `TEST_STATUS.md` 5. `SESSION_CHECKPOINT.md` 6. PRD §12.4–12.9, FR-001/002/035 7. ARCH ADR-005
## 22.2 Relevant Canonical Context
| Topic | Source | Location |
|---|---|---|
| Requirement | PRD | FR-001/002/035, §12 |
| Domain | DM | Alert_Source |
| Architecture | ARCH | sync flow, ADR-005 |
| Database | DBS | `AlertSource` |
| API | — | not frozen |
## 22.3 Agent Objective
Build the pre-persistence trust gate for one representative source; do not choose a vendor, signature scheme, or replay store without human decision (UDR-10).

## 22.4 Agent Constraints

- Preserve established architecture (modular monolith, ADR-001; module boundaries per Architecture.md).
- Do not redesign unrelated areas. Do not introduce unapproved dependencies.
- Section 14 is PRELIMINARY — do not treat any endpoint, field name, or status code as frozen.
- Preserve transaction boundaries and security boundaries stated as [C]/[D]; never resolve a `[UDR-nn]` item silently — stop and ask the human.
- Add required tests. Report assumptions and limitations. Never claim tests ran without execution evidence.

## 22.5 Agent Output Requirements

The agent must report: files created; files modified; important decisions; assumptions; tests generated; tests actually run (with output evidence); known failures; known limitations; next step.

---

# 23. Learning Objectives
## 23.1 MUST UNDERSTAND
- HMAC signatures + timestamp window + nonce/event-ID for replay protection.
- Request replay vs alert duplicate (different invariants).
- Redis rate limiting basics (fixed vs sliding window) and fail-open/closed.
## 23.2 SHOULD UNDERSTAND
- Constant-time comparison; secret storage.
## 23.3 CAN DEFER
- Multi-source adapter registry design.
## 23.4 Mental Model
A bouncer in front of the incident factory: it never decides *what* the alert means, only *whether this request may enter*.
## 23.5 First-Principles Questions
1. Why check signature before rate limiting (and vice versa)? 2. What breaks if replay protection is dropped? 3. Why is rate limit per source, not per IP? 4. What does fail-open on Redis outage risk? 5. Why separate this from dedup?
## 23.6 Interview Questions
### Design
1. How do you protect a webhook endpoint from replay?
### Debugging
1. A source's valid retries are being rejected — why?
### Failure Handling
1. Redis is down — should alerts still be accepted?
### Architecture
1. Why is authentication outside the ingestion transaction?

---

# 24. Verification Checklist

## Functional
- [ ] Functional requirements satisfied
- [ ] Business rules satisfied
- [ ] Acceptance criteria pass

## Security
- [ ] Authentication verified
- [ ] Authorization verified
- [ ] Resource/tenant/team isolation verified

## Data / Consistency
- [ ] Database constraints verified
- [ ] Transaction boundary verified
- [ ] Consistency guarantees verified

## Reliability
- [ ] Idempotency verified
- [ ] Concurrency verified
- [ ] Retry behavior verified
- [ ] Failure behavior verified

## Testing
- [ ] Unit tests pass
- [ ] Integration tests pass
- [ ] API tests pass (BLOCKED — API CONTRACT NOT YET FROZEN)
- [ ] Negative tests pass
- [ ] Concurrency tests pass where applicable
- [ ] Failure-injection tests pass where applicable

## Engineering
- [ ] No unrelated changes
- [ ] Documentation updated
- [ ] Important design decisions understood
- [ ] Capability can be explained without the AI agent

## Slice-specific
- [ ] No DB rows created on any rejection path
- [ ] No secrets in logs/responses (AC-037)
- [ ] UDR-10, UDR-21 decided

---

# 25. Current Implementation Status

**Status:** `PLANNED` — DESIGN / PRE-IMPLEMENTATION (no implementation claimed)

### Completed
- None.

### In Progress
- None.

### Remaining
- Entire slice (blocked on UDR-10, UDR-21)

### Known Defects
- None recorded (nothing implemented).

### Known Limitations
- See Section 27 and the open `[UDR-nn]` items referenced in this slice.

### Test Status
`NOT RUN`

### Last Verified
N/A

---

# 26. Change History

| Version | Date | Change | Reason | Canonical IDs Affected | Implementation Impact |
|---|---|---|---|---|---|
| `0.1` | `2026-10-01` | Initial slice (`DRAFT`) | Initial capability extraction from canonical IMS design | All IDs in §3 | None (pre-implementation) |

## Change Protocol

When a canonical requirement changes: (1) identify affected requirement IDs; (2) search all slices referencing those IDs; (3) decide whether each slice is affected; (4) update affected slice specifications; (5) update implementation/tests where required; (6) record the change here; (7) run regression verification.

---

# 27. Future Evolution

## Likely Extensions
Additional source adapters (PRD §15/§16).
## Extension Points
Per-`sourceType` strategy interface.
## Known Limitations
Replay store and parameters undefined.
## Deliberately Not Generalized
Exactly one representative source in MVP.
## Potential Breaking Changes
Changing the verified-context shape consumed by `SLICE-04`.

---

# Slice Exit Criteria

The slice is implemented only when:

- [ ] Required behavior works.
- [ ] Relevant acceptance criteria pass.
- [ ] Required tests pass.
- [ ] Security/authorization is verified.
- [ ] Transaction/consistency behavior is verified.
- [ ] Concurrency/idempotency behavior is verified where applicable.
- [ ] Failure behavior is tested where applicable.
- [ ] No unresolved design contradiction remains (all `[UDR-nn]` items referenced here are decided and recorded in canonical docs).
- [ ] Requirement-to-test traceability is updated.
- [ ] Implementation status is updated.
- [ ] The developer can explain the capability, design decisions, failure modes, and tests without relying on the AI agent.
- [ ] Replay-vs-duplicate behavior (UDR-10) documented and tested.

---

# Slice Boundary Review

Human review status: **NOT YET REVIEWED** (boxes intentionally unchecked — see `00-INDEX` → Human Design Review).

- [ ] It represents one coherent capability.
- [ ] It does not artificially split a transactional boundary.
- [ ] It does not require another slice's internal implementation.
- [ ] Shared invariants have a clear owner.
- [ ] Dependencies are explicit.
- [ ] The slice can span multiple implementation sessions.
- [ ] It can be meaningfully tested.
- [ ] It can evolve without unnecessary changes to unrelated slices.
