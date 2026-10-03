# SLICE-10 — `AI Alert Triage (Advisory)`

> **Authority:** Canonical documents remain authoritative; this is a derived implementation view.
> **Evidence tags:** `[C]` CANONICAL · `[D]` DERIVED · `[P]` PROPOSED · `[UDR-nn]` USER DECISION REQUIRED (see `00-INDEX`) · `[UNK]` UNKNOWN · `[N/A]` NOT APPLICABLE.
> **Sources:** `PRD` (Revised Draft, 19 Sep 2026) · `ARCH` (unversioned) · `DM` (unversioned) · `DBS` (unversioned, "proposed MVP Schema").

## 0. Slice Metadata

| Field | Value |
|---|---|
| Slice ID | `SLICE-10` |
| Capability | Asynchronous AI triage: alert category, suggested severity, confidence, evidence — advisory only |
| Version | `0.1` (DRAFT) |
| Status | `PLANNED` (DESIGN / PRE-IMPLEMENTATION) |
| MVP | `YES` |
| Created / Last Updated | `2026-10-01` / `2026-10-01` |
| Primary Owner / Module | `AI` (ARCH: "Triage, investigation, evidence, postmortem generation/provenance") |

### Canonical Sources
- `PRD.md` — FR-007, FR-008, FR-009; BR-011, BR-012, BR-023; RD-001, RD-002, RD-003, RD-033; §10 LLM provider; §12.11; §14 (AI triage); UC-001 (AI failure flow); AC-004, AC-005, AC-006; OQ-006, OQ-007
- `Domain_Model.md` — AI module rows (AI_Investigation etc.; no triage entity)
- `Architecture.md` — ADR-005, ADR-009, ADR-012, ADR-013, ADR-014; Incident flow
- `DB_Schema.md` — `AuditEvent` (`AI_TRIAGE_COMPLETED`); **no triage table**
- `API_Contracts.md` — NOT AVAILABLE · `DESIGN_CHECKS.md` — NOT PROVIDED

### Related Slices
- `SLICE-04` triggers (outbox) · `SLICE-05` human severity decision (suggestion consumed there) · `SLICE-08` queue/retry · `SLICE-06` audit/timeline · `SLICE-11`, `SLICE-12` share AI provider abstraction and redaction policy

---

# 1. Capability Overview
## 1.1 Problem
Engineers triage faster with a classification and severity suggestion, but AI latency/unavailability must never block incident persistence or progress. [C: ADR-012, BR-012]
## 1.2 Purpose
After an incident is persisted, classify the alert, suggest P0–P3 with confidence and supporting evidence, store it as an advisory suggestion, and expose it to humans who decide severity. [C: FR-007/008, BR-023]
## 1.3 Behavior
A worker calls the LLM provider (through the provider abstraction), validates the structured output, stores the suggestion, and records an event. Failure leaves the incident untouched; Team Lead can pick severity manually.
## 1.4 End-to-End Summary
```text
Outbox event "triage requested" (committed with the incident)
   ↓
Worker: load incident + alert; apply redaction policy
   ↓
LLM call via provider abstraction (worker only)
   ↓
Validate structured output (category, severity, confidence, evidence)
   ↓
Persist advisory suggestion + AI_TRIAGE_COMPLETED event   |   failure → record + retry; incident unchanged
```

---

# 2. Scope
## 2.1 In Scope
Triage job processing; prompt/input construction from recorded alert/incident data; output validation; advisory storage; failure recording and retry; provider abstraction use; redaction before external call.
## 2.2 Out of Scope
Changing `Incident.severity` (human action in 05) [C BR-023]; autonomous severity changes [C PRD §4]; investigation briefs (12); postmortem (11); backup LLM provider [C RD-033].
## 2.3 MVP Scope
One LLM provider behind an abstraction [C ADR-013, RD-033].
## 2.4 Future Scope
Richer triage, auto-routing only with separate governance [C PRD §16].

---

# 3. Requirement Traceability
| ID | Type | Source | Version | Requirement | Class |
|---|---|---|---|---|---|
| FR-007 | Functional | PRD §6 | PRD-RD | "AI triage runs asynchronously after incident persistence and does not block incident creation." | C |
| FR-008 | Functional | PRD §6 | PRD-RD | "AI triage classifies the alert category, suggests P0-P3 severity, provides confidence, and provides supporting evidence." | C |
| FR-009 | Functional | PRD §6 | PRD-RD | "If AI triage is unavailable, the incident continues through the normal workflow and a Team Lead can select severity manually." | C |
| BR-011 | Business | PRD §7 | PRD-RD | "AI output is advisory and must not be represented as verified fact." (failure: "Invalid or unverified output is not accepted as verified data") | C |
| BR-012 | Business | PRD §7 | PRD-RD | "AI availability must not determine whether an authenticated alert is persisted as an incident." | C |
| BR-023 | Business | PRD §7 | PRD-RD | "AI suggested severity does not automatically replace the current incident severity." (failure: "Suggestion remains advisory until accepted by an authorized user") | C |
| RD-001/002/003 | Decision | PRD §17 | PRD-RD | "AI triage runs asynchronously after incident persistence." · "AI failure does not block incident creation or incident progression." · "If AI is unavailable, a Team Lead can manually select severity." | C |
| RD-033 | Decision | PRD §17 | PRD-RD | "No backup LLM provider is required for the MVP." — "Human fallback is sufficient when AI is unavailable." | C |
| §14 AI triage | Failure | PRD §14 | PRD-RD | "Incident remains persisted and continues without an AI suggestion; Team Lead can select severity manually; AI triage can be retried." | C |
| §12.11 | Security | PRD §12 | PRD-RD | "Define which incident data may be sent to the LLM provider. Redact sensitive information before external AI processing where required." | C |
| UC-001 (AI failure) | Use case | PRD §19 | PRD-RD | "Incident remains persisted; AI triage failure is recorded; human severity selection remains available" | C |
| AC-004 | Acceptance | PRD §20 | PRD-RD | "A newly accepted alert is persisted before asynchronous AI triage is attempted." | C |
| AC-005 | Acceptance | PRD §20 | PRD-RD | "If AI triage is unavailable, the incident remains OPEN and a Team Lead can manually select severity." | C |
| AC-006 | Acceptance | PRD §20 | PRD-RD | "AI triage output is validated and stored as an advisory suggestion containing category, severity, confidence, and evidence." | C |
| ADR-012 | Decision | ARCH | unv. | "Persist incident, then enqueue AI job." — "AI availability or latency must not block incident persistence or the core incident lifecycle." | C |
| ADR-013 | Decision | ARCH | unv. | "Use an AI provider abstraction to create providers as per need and availability." | C |
| ADR-005 | Decision | ARCH | unv. | Redis caching exists "by avoiding LLM calls for same outputs" | C (policy UNK) |
| OQ-006 / OQ-007 | Open Q | PRD §18 | PRD-RD | "What exact data fields are allowed to leave the system for LLM processing?" · "What exact AI confidence/evidence response format should be enforced?" | UNK |

> PRD §10 and RD-033 conflict mildly with nothing; note ARCH "Synchronous Request Flow … Alert module --AI Module--> Incident module" contradicts FR-007/ADR-012 (SD-03). This slice follows async.

---

# 4. Business Rules
## BR-011 / BR-023 — Advisory only
- **Canonical Rules:** see §3.
- **Interpretation:** stored suggestion has a distinct identity from `Incident.severity`; labeled as AI-generated; never copied to the incident by this slice. "Accepted by an authorized user" = a human performs severity confirm/update in 05 (the suggestion is input to their choice) [D; UC-004 "reviews the source severity, AI suggestion, or incident context"].
- **Engineering Consequence:** this slice has **no write path** to `Incident` columns; outputs failing validation are not stored as valid suggestions. **Invalid:** auto-updating severity; presenting AI output as verified. **Class:** C.

## BR-012 / FR-006 — AI never gates persistence
- Triage is only triggered by an outbox row created in 04's transaction; no LLM call in ingestion. **Class:** C.

## Output validation (AC-006, BR-011)
- **Canonical:** output must contain category, severity (P0–P3), confidence, evidence. **Not defined:** category taxonomy, confidence scale (0–1? %?), evidence format, rejection behavior beyond "not accepted as verified data" [UDR-04/OQ-007]. **Class:** C/UNK.

## Data minimization (§12.11)
- Which alert/incident fields may be sent, and what is redacted, is **undefined** [UDR-16/OQ-006]. Alert payloads are untrusted external text → prompt-injection risk [D]; treat model output as untrusted input too [D].

## Failure + retry (PRD §14, UC-001)
- Failure is recorded; triage "can be retried" (manual vs automatic, limits) [UDR-22, UDR-04]. **Class:** C/UNK.

---

# 5. Functional Behavior
**5.1 Run triage** — Trigger: queue job from outbox event (type catalog UDR-12). Input: incidentId. Preconditions: incident exists; (is it still OPEN? Should triage run for later states? UNK). Processing: load incident + primary alert (+ service context [P]) → apply redaction → call provider → parse/validate → in a tx: store suggestion + append `AI_TRIAGE_COMPLETED` (+ provenance model/version [P; FR-029 requires it for postmortems only]) → commit. Output: advisory suggestion. State change: none on Incident.
**5.2 Handle failure** — provider error/timeout/invalid output → record failure (storage + event type UDR-04/05) → classify retryable → retry per policy → on exhaustion leave "no suggestion"; incident continues [C].
**5.3 Retry on demand** — "AI triage can be retried" [C §14]; trigger (user action vs automatic) UNK [UDR-04].
**5.4 Expose suggestion** — returned with incident detail for human review; must be visibly labeled AI-generated [C BR-011; presentation is API/UI concern].
**5.5 Idempotency** — repeated job ⇒ at most one stored result per (incident, triage run) [P; key UDR-04].

---

# 6. Acceptance Criteria
- **AC-004** — *Given* valid alert · *Then* Alert+Incident committed before any AI call. *Verify:* order/trace test with provider mock recording call time vs commit (shared with 04).
- **AC-005** — *Given* provider unavailable · *Then* incident stays OPEN; Team Lead can set severity (05). *Verify:* provider-down integration test + manual severity flow.
- **AC-006** — *Given* provider returns valid structured output · *Then* stored as advisory with category, severity, confidence, evidence; invalid output rejected. *Verify:* valid/invalid fixtures; assert `Incident.severity` unchanged.
- **BR-023** — *Verify:* after triage completes, `Incident.severity` equals initial severity.
- **Duplicate job** — *Verify:* two executions ⇒ one stored result/event.

---

# 7. Domain Model
## 7.1 Entities
| Entity | Role |
|---|---|
| Incident / Alert | input context (read-only here) |
| Triage suggestion | **no canonical entity** — category, severity, confidence, evidence [UDR-04] |
| AuditEvent | `AI_TRIAGE_COMPLETED` |
## 7.2 Relationships — suggestion → Incident (1 per run; cardinality UNK).
## 7.3 Invariants
| Invariant | Enforcement |
|---|---|
| Suggestion never modifies `Incident.severity` | Application [C BR-023] |
| Suggested severity ∈ P0–P3 | Validation (and DB CHECK if stored) |
| Output validated before storage | Application |
## 7.4 State Machine — triage run states not defined (DM lists lifecycle only for AI_Investigation) [UNK]. Incident transitions: none owned.

---

# 8. Architectural Context
## 8.1 Relevant Architecture — Async flow: `Outbox → BullMQ → Workers (AI triage…)`; "Failure/retry boundary: All external calls (… LLM provider) happen only inside the worker." ADR-013 abstraction. ADR-005: Redis caching to avoid repeat LLM calls.
## 8.2 Components
| Component | Responsibility |
|---|---|
| Triage worker | orchestrate |
| AI provider interface | `generate(...)` abstraction [P name] |
| Redactor | policy application |
| Output validator | schema/enum checks |
| Repository | store suggestion, append audit |
## 8.3 Constraints — worker-only provider calls; free-tier dependency limits [C ADR-013 rationale]; results written via AI module's repository [C].
## 8.4 ADRs — **ADR-012**, **ADR-013**, **ADR-009/014** (trigger + idempotency), **ADR-005** (cache).

---

# 9. Dependency Model
## 9.1 Upstream
| Slice | Type | Requires |
|---|---|---|
| 04 | EVENT | triage-requested outbox event; persisted incident/alert |
| 08 | RUNTIME | queue, retry |
| 06 | IN-TX | audit append |
| (infra) | EXTERNAL | LLM provider |
## 9.2 Downstream
| Slice | Relationship | Provides |
|---|---|---|
| 05 (human decision) / read APIs | READ | advisory suggestion |
| 06 | DATA | `AI_TRIAGE_COMPLETED` |
## 9.3 Contract
**Allowed:** read incident/alert; write own suggestion + audit. **Forbidden:** writing `Incident` columns; blocking 04; inline LLM calls in HTTP.

---

# 10. Slice Coupling Analysis
## 10.1 Transactional — **NO** (post-commit consumer; own small tx) [D].
## 10.2 Synchronous — **NO**.
## 10.3 Shared Invariants — "AI is advisory" jointly relies on 05 (human sets severity) and 10 (does not write) → ownership: 05 owns severity; 10 owns suggestion [D].
## 10.4 Summary
| Related Slice | Coupling | Strength | Boundary Decision |
|---|---|---|---|
| 04 | event | Loose | SEPARATE |
| 05 | read by humans | Loose | SEPARATE |
| 11, 12 | shared AI infra | Soft | SEPARATE (share provider abstraction/redaction as common code owned by `AI` module) |
### Boundary Decision
Triage is advisory and async with different failure semantics; merging with 12 would conflate "per-incident automatic suggestion" with "on-demand evidence-grounded brief", which have different triggers, authorization, and data.

---

# 11. Data Model
## 11.1 Tables — **no canonical table** for triage output. DBS has: `AuditEvent` (event type exists with free `metadata jsonb`). `Investigation`/`Evidence` are for investigation (12) and do not fit triage (SD-08).
## 11.2 Fields needed (from FR-008) — category, suggested severity, confidence, evidence, provenance (model/version), status/failure info [D].
## 11.3 Constraints — [UNK].
## 11.4 DB Invariants — [UNK].
## 11.5 Migration Requirements — **UDR-04**: options: (a) new `TriageSuggestion` table; (b) store inside `AuditEvent.metadata` (weak: audit is append-only timeline, not a result store); (c) reuse `Investigation` (semantic mismatch). Not chosen here.

---

# 12. Transaction & Consistency Model
## 12.1 Boundary
```text
Worker: [external LLM call]  → BEGIN
   INSERT suggestion (storage per UDR-04)
   INSERT AuditEvent (AI_TRIAGE_COMPLETED)      -- [D: BR-009 spirit; not a lifecycle transition]
COMMIT
```
## 12.2 Atomic — suggestion + event [P/D].
## 12.3 Locking — none needed beyond idempotency uniqueness [UDR-04].
## 12.4 Guarantees — no suggestion without event (if adopted); incident untouched.
## 12.5 Failure — rollback; job retry.

---

# 13. Idempotency & Concurrency
## 13.1 Idempotency — **Identity:** (incidentId, triage purpose[, attempt/run id]) [P]. **Duplicate job:** no second result [C FR-031, ADR-014]. **Replay:** same. **Side-effect protection:** unique key at storage; optional LLM-output cache [C ADR-005 mentions; policy UNK].
## 13.2 Concurrency — **Race:** two workers same incident ⇒ unique key; loser no-op. **Race:** human sets severity while triage runs ⇒ independent (suggestion remains advisory; stale suggestion display is acceptable [D]). **Required test:** parallel job execution.

---

# 14. API Surface — Preliminary
`PRELIMINARY — API CONTRACT NOT YET FROZEN`
| Candidate operation | Actor / Authz | Input | Domain action | Output | Failures | Idempotency / concurrency | Confidence · Missing |
|---|---|---|---|---|---|---|---|
| Read triage suggestion (likely embedded in incident detail) | ENG/TL/ADMIN own team | incidentId | read | category, suggested severity, confidence, evidence, provenance, AI label | 403/404 | read | Medium · embed vs endpoint |
| Retry triage (on demand) | TL? [UNK] | incidentId | enqueue | accepted | 403/404/409 | key | Low · whether exists (§14 says "can be retried") |
No ingestion-time API. Async only.

---

# 15. Events, Queues & Side Effects
## 15.1 Events Produced — audit `AI_TRIAGE_COMPLETED`; failure event type does not exist [UDR-05].
## 15.2 Events Consumed — "triage requested" outbox event (initial outbox set from 04) [C ADR-011/UC-001 "publish asynchronous AI triage job"].
## 15.3 Queue Jobs — AI triage queue; retry [UDR-22].
## 15.4 Delivery — at-least-once; idempotent.
## 15.5 External Side Effects — LLM provider call (worker only); data sent per redaction policy (UDR-16).

---

# 16. Security & Authorization
System actor; no user authorization on the job. Suggestion reads follow team isolation [C BR-004]. **Input security:** alert text may contain adversarial instructions → constrain prompt, validate output schema strictly, never execute output [D]. **Data leaving the system:** policy [UDR-16]. Never log: LLM API key; full prompts at INFO [P]. Secrets not in source [C §12.6].

---

# 17. Failure Modes
| Failure | Detection | Expected | State Impact | Retry? | Evidence |
|---|---|---|---|---|---|
| LLM unavailable/timeout/rate-limited | provider error | record failure; retry per policy; incident unaffected | none | yes (bounded) | §14, FR-009 |
| Invalid/unparseable output | validator | reject; not stored as valid suggestion; retry? UNK | none | UNK | BR-011 |
| Free-tier quota exhausted | provider error class | like unavailable [D] | none | later | ADR-013 |
| Duplicate job | unique key | no-op | none | n/a | FR-031 |
| Storage failure | DB | rollback; retry | none | yes | — |
## Critical Failure Scenario
**What fails:** LLM down for days. **Must remain true:** every incident is persisted, assignable, resolvable; Team Lead can set severity (AC-005). **Recovery:** retries/backfill later [UNK].

---

# 18. Observability
Logs: triage start/finish/failure with incidentId, provider, latency, validation result, correlation id (no prompt/body). Metrics [P]: success/fail rate, latency, validation rejections, cache hit. Audit: `AI_TRIAGE_COMPLETED` (Yes with storage — D). Error tracking: failure visible (PRD §14 "observable").

---

# 19. Testing Strategy
- **Unit:** output validation; redaction; prompt builder; confidence scale.
- **Integration:** worker with provider stub; storage + audit atomicity; incident untouched.
- **API:** `BLOCKED — API CONTRACT NOT YET FROZEN`.
- **Authorization:** suggestion visible only to the incident's team.
- **Concurrency:** parallel jobs.
- **Idempotency:** duplicate job; replay.
- **Failure injection:** provider down/slow/garbage output; DB failure.
- **Regression:** `Incident.severity` unchanged by triage; ingestion unaffected when AI down.

---

# 20. Test ↔ Requirement Traceability
| Requirement | AC | Test(s) | Status |
|---|---|---|---|
| FR-006/007, BR-012 | AC-004 | persist-before-AI | NOT RUN |
| FR-009 | AC-005 | AI-down workflow | NOT RUN |
| FR-008, BR-011 | AC-006 | validation/storage | NOT RUN |
| BR-023 | AC-006 | severity-unchanged | NOT RUN |
| FR-031 | (none specific) | duplicate job | NOT RUN |
### Coverage Gaps
- No AC for redaction (§12.11), retry limits, invalid-output handling, retry-on-demand.

---

# 21. Implementation Plan
## 21.1 Sequence
1. Decide UDR-04, 05, 16, 22. 2. Provider interface + fake. 3. Validator + redactor. 4. Storage + audit. 5. Worker. 6. Failure/idempotency tests.
## 21.2 Files
### CREATE
```text
src/ai/provider/** · src/ai/triage/** · test/ai/triage/**
```
### MODIFY — schema (per UDR-04); worker registration.
### REVIEW ONLY — ARCH ADR-012/013; PRD §12.11.
## 21.3 Allowed — AI module. ## 21.4 Forbidden — writing Incident severity; inline LLM calls; hard-coding a vendor outside the adapter. ## 21.5 Must exist — 04, 06, 08.

---

# 22. AI Agent Context
## 22.1 Read First
1. `AGENTS.md` 2. This slice 3. `PROJECT_STATE.md` 4. `TEST_STATUS.md` 5. `SESSION_CHECKPOINT.md` 6. PRD FR-007–009, BR-011/012/023, §12.11 7. ARCH ADR-012/013
## 22.2 Relevant Canonical Context
| Topic | Source | Location |
|---|---|---|
| Requirement | PRD | FR-007/008/009, BR-011/012/023, UC-001 |
| Domain | DM | AI module |
| Architecture | ARCH | ADR-012, ADR-013 |
| Database | DBS | `AuditEvent` only |
| API | — | not frozen |
## 22.3 Agent Objective
Implement the async triage worker behind a provider abstraction with strict validation and advisory-only storage; stop at UDR-04/16.

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
- Why AI is async + advisory (availability vs correctness).
- Treating LLM input *and* output as untrusted.
- Provider abstraction and failure classes (rate limit, timeout, invalid output).
## 23.2 SHOULD UNDERSTAND — caching LLM results; confidence semantics.
## 23.3 CAN DEFER — prompt optimization, evaluation metrics for triage.
## 23.4 Mental Model
A junior analyst who whispers a suggestion into the engineer's ear after the incident is already on the board; if the analyst is absent, work continues.
## 23.5 First-Principles Questions
1. Why persist before AI? 2. What breaks if AI can set severity? 3. Why validate output? 4. Why abstract the provider? 5. Why is redaction needed?
## 23.6 Interview Questions
### Design
1. Where do you put an LLM call in an incident pipeline and why?
### Debugging
1. Triage suggestions stopped appearing — what do you check?
### Failure Handling
1. LLM returns malformed JSON — then what?
### Architecture
1. How would you swap LLM providers without touching incident logic?

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
- [ ] Incident severity never changed by this slice (assertion in tests)
- [ ] Persistence unaffected with provider down
- [ ] UDR-04, 16 decided

---

# 25. Current Implementation Status

**Status:** `PLANNED` — DESIGN / PRE-IMPLEMENTATION (no implementation claimed)

### Completed
- None.

### In Progress
- None.

### Remaining
- Entire slice (blocked on UDR-04, UDR-16)

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
Richer classification; governed automation (PRD §16).
## Extension Points
Provider adapters; output schema versioning.
## Known Limitations
No storage model; no category taxonomy.
## Deliberately Not Generalized
Single provider.
## Potential Breaking Changes
Changing output schema affects 05/UI display.

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
- [ ] Redaction policy implemented and tested.

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
