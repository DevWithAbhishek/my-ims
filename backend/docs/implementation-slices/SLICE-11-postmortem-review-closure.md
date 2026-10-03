# SLICE-11 — `Postmortem Generation, Review & Incident Closure`

> **Authority:** Canonical documents remain authoritative; this is a derived implementation view.
> **Evidence tags:** `[C]` CANONICAL · `[D]` DERIVED · `[P]` PROPOSED · `[UDR-nn]` USER DECISION REQUIRED (see `00-INDEX`) · `[UNK]` UNKNOWN · `[N/A]` NOT APPLICABLE.
> **Sources:** `PRD` (Revised Draft, 19 Sep 2026) · `ARCH` (unversioned) · `DM` (unversioned) · `DBS` (unversioned, "proposed MVP Schema").

## 0. Slice Metadata

| Field | Value |
|---|---|
| Slice ID | `SLICE-11` |
| Capability | AI postmortem draft generation, human review/edit, and `RESOLVED → CLOSED` |
| Version | `0.1` (DRAFT) |
| Status | `PLANNED` (DESIGN / PRE-IMPLEMENTATION) |
| MVP | `YES` |
| Created / Last Updated | `2026-10-01` / `2026-10-01` |
| Primary Owner / Module | `AI` (generation/provenance) + closure through `Incident` module's kernel [P; ownership split UDR-15] |

### Canonical Sources
- `PRD.md` — FR-026–029, FR-033; BR-013, BR-014, BR-015, BR-065–BR-072; RD-028–RD-031; §8 (RESOLVED→CLOSED); §9 Postmortem; §14 (LLM postmortem); UC-009, UC-010; AC-015, AC-029–AC-034; OQ-008
- `Domain_Model.md` — Postmortem row (`GENERATING → DRAFT → REVIEWED`; "Postmortem approval is required before Incident → CLOSED"); "Every Incident has at most one Postmortem"
- `Architecture.md` — "Incident -> RESOLVED -> Postmortem Job -> AI -> Draft -> Human Review -> CLOSED"; ADR-009, 010, 012, 013, 014
- `DB_Schema.md` — `Postmortem`, `Incident` (closure fields), `AuditEvent`, `OutboxEvent`
- `API_Contracts.md` — NOT AVAILABLE · `DESIGN_CHECKS.md` — NOT PROVIDED

### Related Slices
- `SLICE-05` (resolve trigger; transition kernel) · `SLICE-06` (comments/timeline as input; audit) · `SLICE-08` (queue/retry) · `SLICE-09` (closure notification) · `SLICE-10` (shared AI infra) · `SLICE-12` (reviewed postmortems become knowledge)

---

# 1. Capability Overview
## 1.1 Problem
Learnings must be captured after resolution without blocking resolution, and an incident must not close until a human has reviewed the written account. [C: Goals 15–16, BR-014]
## 1.2 Purpose
After `RESOLVED`, generate a structured AI draft from recorded data with provenance; let humans review/update/approve; closing the incident only after review (or a defined manual path). [C: UC-009, UC-010]
## 1.3 Behavior
Resolve (05) enqueues a job; the worker produces a draft; Engineer/Team Lead/Admin edits and approves; approval closes the incident atomically. Generation failure leaves the incident `RESOLVED`; retry possible.
## 1.4 End-to-End Summary
```text
RESOLVED committed (05) + outbox "postmortem requested"
   ↓
Worker: load recorded context (incident, timeline, comments, resolution) → redact → LLM → validate fixed structure
   ↓
Store draft + AI provenance + POSTMORTEM_GENERATED
   ↓ (human)
Review/edit → approve
   ↓
BEGIN: postmortem REVIEWED + Incident CLOSED + POSTMORTEM_REVIEWED + CLOSED events + outbox  COMMIT
```

---

# 2. Scope
## 2.1 In Scope
Postmortem job processing; fixed-structure output validation; provenance storage; retry/failure handling; human review/edit; the `RESOLVED→CLOSED` operation and its preconditions; closure audit/notification.
## 2.2 Out of Scope
The resolve operation (05); AI triage (10); investigation (12); reopening [C RD-031]; analytics/reporting over postmortems [UNK].
## 2.3 MVP Scope
Fixed postmortem structure [C RD-028]; human review required [C].
## 2.4 Future Scope
Pattern analysis, richer postmortem templates [UNK/D from DBS purpose text].

---

# 3. Requirement Traceability
| ID | Type | Source | Version | Requirement | Class |
|---|---|---|---|---|---|
| FR-026 | Functional | PRD §6 | PRD-RD | "After an incident reaches RESOLVED, an asynchronous worker generates a structured AI postmortem draft from recorded incident data." | C |
| FR-027 | Functional | PRD §6 | PRD-RD | "Failure of postmortem generation does not reopen or invalidate a RESOLVED incident. Generation can be retried." | C |
| FR-028 | Functional | PRD §6 | PRD-RD | "An authorized Engineer, Team Lead, or Admin reviews and updates the postmortem draft before the incident is CLOSED." | C |
| FR-029 | Functional | PRD §6 | PRD-RD | "The system records the model, model version, generation timestamp, prompt/version, input data/reference information, and human review metadata for AI-generated postmortems." | C |
| FR-033 | Functional | PRD §6 | PRD-RD | "Repeated execution of postmortem jobs must not create duplicate postmortem records or conflicting postmortem state." | C |
| BR-013 | Business | PRD §7 | PRD-RD | "An incident can remain RESOLVED even if postmortem generation fails." | C |
| BR-014 | Business | PRD §7 | PRD-RD | "A RESOLVED incident can move to CLOSED only after the postmortem has been reviewed or the defined manual review path is completed." (failure: 409) | C |
| BR-015 | Business | PRD §7 | PRD-RD | "A CLOSED incident is terminal in the MVP." | C |
| BR-065 | Business | PRD §7 | PRD-RD | "Postmortem generation begins only after the incident reaches RESOLVED." | C |
| BR-066 | Business | PRD §7 | PRD-RD | "Postmortem generation is asynchronous." | C |
| BR-067 | Business | PRD §7 | PRD-RD | "AI-generated content remains a draft until human review." (failure: "Unreviewed draft cannot close incident") | C |
| BR-068 | Business | PRD §7 | PRD-RD | "The postmortem must be based on recorded incident information." (failure: "Missing required context is recorded as a generation failure") | C |
| BR-069 | Business | PRD §7 | PRD-RD | "The postmortem must distinguish recorded facts from unknowns or AI-generated inferences." | C |
| BR-070 | Business | PRD §7 | PRD-RD | "AI generation failure does not move an incident out of RESOLVED." | C |
| BR-071 | Business | PRD §7 | PRD-RD | "A postmortem can be retried after generation failure." (failure: "Retry stops after configured limit and enters failure state") | C |
| BR-072 | Business | PRD §7 | PRD-RD | "An incident cannot be CLOSED until the postmortem is reviewed or the defined manual review path is completed." (failure: 409) | C |
| RD-028 | Decision | PRD §17 | PRD-RD | "Postmortem structure is fixed for the MVP." — "Human review is required before closure." | C |
| RD-030 / RD-031 | Decision | PRD §17 | PRD-RD | "Incident closure occurs after postmortem human review/approval or the defined manual review path." — "CLOSED remains the terminal state." · "Closed incidents cannot be reopened in the MVP." | C |
| §8 transition | State machine | PRD §8 | PRD-RD | "RESOLVED → CLOSED — Yes — Authorized Engineer / Team Lead / Admin — Postmortem reviewed or manual review path completed — Audit/timeline event; notification" | C |
| §9 Postmortem | Data | PRD §9 | PRD-RD | Fields: ID, Incident ID, Summary, Impact, Detection, Timeline, Root cause, Contributing factors, Resolution, Corrective actions, Preventive actions, Unknowns, MTTR, Risk level, Generation status, Model, Model version, Prompt/version, Input data/reference information, Generation timestamp, Human reviewer, Review timestamp, Approval status | C |
| UC-009 / UC-010 | Use cases | PRD §19 | PRD-RD | UC-009 flow "Load recorded incident context → call LLM → validate structured response → store draft and AI provenance → record POSTMORTEM_GENERATED"; UC-010 flow "Review draft → update content if necessary → approve → transition incident to CLOSED → record reviewer and review timestamp → record POSTMORTEM_REVIEWED and CLOSED events" | C |
| AC-015 | Acceptance | PRD §20 | PRD-RD | "An incident cannot be CLOSED without required postmortem review/approval or the defined manual review path." | C |
| AC-029 / AC-030 | Acceptance | PRD §20 | PRD-RD | "An incident can reach RESOLVED even when AI postmortem generation is unavailable." · "Failed postmortem generation is retryable and does not reopen the RESOLVED incident." | C |
| AC-031 / AC-032 | Acceptance | PRD §20 | PRD-RD | "A generated postmortem contains the required fixed structure and AI provenance metadata." · "Repeated postmortem-job execution does not create duplicate or conflicting postmortem records." | C |
| AC-033 / AC-034 | Acceptance | PRD §20 | PRD-RD | "A reviewed postmortem records the human reviewer and review timestamp." · "A CLOSED incident is terminal and cannot undergo further lifecycle transitions." | C |
| DM-Postmortem | Domain | DM | unv. | Lifecycle "GENERATING -> DRAFT -> REVIEWED"; invariant "Postmortem approval is required before Incident → CLOSED."; "Every Incident has at most one Postmortem."; Postmortem → human_reviewer 0..1 | C |
| OQ-008 | Open Q | PRD §18 | PRD-RD | "What manual path should be available if postmortem generation repeatedly fails?" | UNK |

---

# 4. Business Rules
## BR-014 / BR-072 / BR-067 — Closure gate
- **Canonical Rule:** closure only after "the postmortem has been reviewed or the defined manual review path is completed."
- **Interpretation:** `CLOSED` transition checks postmortem `REVIEWED` (or manual path). **The manual path is undefined** (OQ-008) [UDR-06]. DM/PRD say "approval", DBS has `reviewStatus ∈ {PENDING, REJECTED, REVIEWED}` — meaning of `REJECTED` and what a rejected draft allows (regenerate? edit? block?) is undefined [UDR-07].
- **Engineering Consequence:** review approval and closure are checked/committed together under the incident lock (409 on violation). **Invalid:** closing with no postmortem, with `PENDING`/`REJECTED`, or not RESOLVED. **Class:** C/UDR.

## BR-013 / BR-070 / FR-027 / BR-071 — Failure does not affect RESOLVED; retryable
- **Interpretation:** postmortem failure state lives in postmortem/job state, never on `Incident.status`. Retry bounded; after limit "enters failure state" [C]. **Gap:** DBS `Postmortem` has all narrative fields `NOT NULL` and no generation-status column ⇒ a `GENERATING` placeholder row or `FAILED` row cannot be stored [D, UDR-07]. **Class:** C/UDR.

## BR-065 / BR-066 — Only after RESOLVED; async
- Job is created by 05's resolve tx; worker re-verifies `status=RESOLVED` before generating [D]. **Class:** C.

## BR-068 / BR-069 / BR-067 — Recorded facts; facts vs unknowns/inferences; draft until reviewed
- **Consequence:** input restricted to recorded data (incident, timeline, comments, resolution summary [C UC-009]); missing context ⇒ recorded generation failure; output validated against fixed structure; `unknowns` field and fact/inference distinction preserved [C §9]. How facts vs inferences are marked inside text fields [UNK, UDR-07]. **Class:** C/UNK.

## FR-033 / DM — One postmortem per incident
- **Consequence:** idempotent generation ⇒ DB uniqueness on `incidentId` [D]. **DBS has no `UNIQUE(incidentId)`** — only non-unique indexes [D → UDR-07]. **Class:** C (invariant) / gap (enforcement).

## FR-029 — Provenance
- Record model, modelVersion, generation timestamp, prompt/version, input data/reference, human review metadata. DBS columns: `model`, `modelVersion`, `prompt`, `inputData`, `createdAt`, `reviewedBy`, `reviewedAt`; "prompt/version" has one column (`prompt`) [D]. **Class:** C.

## BR-015 — Terminal CLOSED
- After closure no postmortem edits? [UNK]. **Class:** C.

---

# 5. Functional Behavior
**5.1 Generate postmortem draft** — Trigger: queue job (outbox from resolve tx). Input: incidentId. Preconditions: `status=RESOLVED`; no existing postmortem for the incident (or retry state). Processing: load recorded context → redact → LLM → validate fixed structure + provenance → tx: insert/finish postmortem draft + `POSTMORTEM_GENERATED` → commit. State: postmortem `GENERATING → DRAFT` (DM). Failure: record failure, retry bounded, incident stays RESOLVED [C].
**5.2 Retry generation** — automatic backoff within limit [C BR-071; parameters UDR-22]; manual retry after exhaustion [UNK, C "Generation can be retried"].
**5.3 View/edit draft** — Engineer/Team Lead/Admin of the incident's team update fields [C FR-028, §11]; edit history/versioning [UNK]; editing allowed while `REJECTED`? [UDR-07].
**5.4 Approve & close** — Input: incidentId, reviewer (authenticated), final content. Preconditions: incident `RESOLVED`, postmortem `DRAFT/PENDING` (or manual path), reviewer authorized & same team. Processing (one tx): lock incident → verify state → set postmortem `REVIEWED`, `reviewedBy`, `reviewedAt` → set Incident `CLOSED`, `closedBy`, `closedTimestamp` → audit `POSTMORTEM_REVIEWED` + `CLOSED` → outbox notification → commit [C UC-010; atomicity D from ADR-010/BR-009]. State: `RESOLVED→CLOSED`.
**5.5 Manual review path** — [UDR-06]: what the user does when no draft can be generated (e.g., author postmortem manually, or waive).
**5.6 Reject draft** — `REJECTED` semantics [UDR-07].

---

# 6. Acceptance Criteria
- **AC-029** — resolve succeeds with LLM down. *Verify:* shared with 05.
- **AC-030** — LLM failure ⇒ failure recorded, retryable, incident still RESOLVED. *Verify:* provider failure test; assert status.
- **AC-031** — generated draft has all fixed sections + provenance. *Verify:* schema/field presence tests with fixture output.
- **AC-032** — duplicate/concurrent job ⇒ one postmortem. *Verify:* parallel job test; count rows.
- **AC-015 / BR-014/072** — close without reviewed postmortem ⇒ 409, no state change. *Verify:* state×review matrix test.
- **AC-033** — reviewer + timestamp recorded. *Verify:* approve then inspect.
- **AC-034** — after CLOSED, all lifecycle operations rejected. *Verify:* shared with 05 state-machine tests.
- **Atomic closure** — *Verify:* fail audit/outbox insert in approve tx ⇒ postmortem remains unreviewed and incident not CLOSED.

---

# 7. Domain Model
## 7.1 Entities
| Entity | Role |
|---|---|
| Postmortem | Structured account + provenance + review |
| Incident | subject; `CLOSED` transition target |
| Comment / AuditEvent | generation inputs (read) |
## 7.2 Relationships — Incident→Postmortem 0..1; Postmortem→User (reviewer) 0..1.
## 7.3 Invariants
| Invariant | Enforcement |
|---|---|
| ≤1 postmortem per incident | **Not DB-enforced in DBS** [UDR-07] |
| Close requires reviewed postmortem/manual path | Application under lock (409) |
| AI draft not verified until human review | `reviewStatus` + application |
| `riskLevel`, `MTTR` required | DB NOT NULL (computation/units UNK) |
| Provenance recorded | Application |
## 7.4 State Machine
Postmortem: `GENERATING → DRAFT → REVIEWED` [C DM]; DBS: `reviewStatus PENDING/REJECTED/REVIEWED`, no generation status [SD-07]. Failure state needed [UDR-07].
### Owned Transitions
Postmortem state transitions; `RESOLVED→CLOSED` [P: via 05's kernel, UDR-15].
### Owned Elsewhere
`MITIGATING→RESOLVED` — `SLICE-05`.

---

# 8. Architectural Context
## 8.1 Relevant Architecture — "Incident -> RESOLVED -> Postmortem Job -> AI -> Draft -> Human Review -> CLOSED." Async flow includes "postmortem" worker. Incident flow: "finally calls for postmortem draft generation. All state transition commit async notification."
## 8.2 Components
| Component | Responsibility |
|---|---|
| Postmortem worker | generation |
| AI provider interface | LLM calls |
| Redactor/validator | input/output controls |
| Postmortem service | review/edit/approve |
| Incident transition kernel (05) | CLOSED transition |
| Repository | `Postmortem` |
## 8.3 Constraints — LLM calls only in worker; closure under same locking discipline as other transitions [C ADR-010]; modules write own tables [C].
## 8.4 ADRs — **ADR-010** (CLOSED transition + audit + outbox atomic), **ADR-009/014** (job trigger, idempotency), **ADR-012/013** (AI async/abstraction).

---

# 9. Dependency Model
## 9.1 Upstream
| Slice | Type | Requires |
|---|---|---|
| 05 | EVENT + KERNEL | RESOLVED event/job; transition kernel for CLOSED |
| 06 | READ + IN-TX | timeline/comments; audit append |
| 08 | RUNTIME | queue, retry |
| 10 | SHARED CODE | provider abstraction, redaction |
| 01 | SYNC | authz |
## 9.2 Downstream
| Slice | Relationship | Provides |
|---|---|---|
| 12 | READ | `REVIEWED` postmortems as investigation knowledge [C RD-036] |
| 09 | EVENT | closure notification |
## 9.3 Contract
**Allowed:** read incident data via interfaces; invoke kernel for CLOSED. **Forbidden:** writing `Incident.status` directly; generating before RESOLVED; closing without the gate.

---

# 10. Slice Coupling Analysis
## 10.1 Transactional — **YES (hard)**: postmortem review + incident CLOSED + audit + outbox must commit together [D from UC-010/ADR-010].
## 10.2 Synchronous — closure is user-driven sync; generation async.
## 10.3 Shared Invariants — **YES with 05**: "CLOSED only after review" couples postmortem state with the incident state machine. Options: (a) 11 owns RESOLVED→CLOSED by calling 05's kernel; (b) 05 owns it and calls 11's check. **Proposed (a)**; marked UDR-15.
## 10.4 Summary
| Related Slice | Coupling | Strength | Boundary Decision |
|---|---|---|---|
| Generation ↔ Review/Closure (inside) | gate + same tx | Hard | KEEP TOGETHER |
| 05 | CLOSED transition | Hard | NEEDS USER DECISION (UDR-15) |
| 10 | shared AI infra | Soft | SEPARATE |
| 12 | read of reviewed postmortems | Soft | SEPARATE |
### Boundary Decision
Generation and review share the postmortem state machine and the closure gate; splitting them would leave ownership of "REVIEWED ⇒ may close" ambiguous.

---

# 11. Data Model
## 11.1 Tables — `Postmortem`; `Incident` (closure columns); `AuditEvent`; `OutboxEvent`.
## 11.2 Fields
| Field | Purpose | Required? |
|---|---|---|
| `summary, impact, detection, timeline, rootCause, factors, resolution, correctiveActions, preventiveActions` | fixed structure (§9) | **NOT NULL** |
| `unknowns` | distinguish unknowns (BR-069) | No |
| `MTTR int`, `riskLevel` | metrics | **NOT NULL** (units/derivation UNK) |
| `model, modelVersion, prompt, inputData` | provenance | No |
| `reviewStatus` (PENDING/REJECTED/REVIEWED), `reviewedAt`, `reviewedBy` | review | status Yes |
| `incidentId` | link | Yes (no UNIQUE) |
| `Incident.closedBy`, `closedTimestamp` | closure | No |
## 11.3 Constraints — CHECKs; FKs; indexes (non-unique).
## 11.4 DB Invariants — enum domains only.
## 11.5 Migration Requirements — [UDR-07]: `UNIQUE(incidentId)`; generation status/failure columns; relax NOT NULL for in-progress/failed rows (or separate job table); `generatedAt` explicit; `prompt` version field; manual-path representation (UDR-06).

---

# 12. Transaction & Consistency Model
## 12.1 Boundary
```text
Generation:   [LLM call outside tx] → BEGIN; store draft + provenance; INSERT AuditEvent(POSTMORTEM_GENERATED); COMMIT
Approve+Close: BEGIN
                 lock Incident row; verify RESOLVED
                 verify postmortem reviewable; UPDATE Postmortem (REVIEWED, reviewedBy, reviewedAt)
                 UPDATE Incident (CLOSED, closedBy, closedTimestamp)
                 INSERT AuditEvent (POSTMORTEM_REVIEWED), (CLOSED)
                 INSERT OutboxEvent (notification)
               COMMIT
```
[Generation tx: D. Close tx: C ADR-010 + UC-010; exact composition D.]
## 12.2 Atomic — as above.
## 12.3 Locking — incident row lock (same as 05); unique postmortem per incident [UDR-07].
## 12.4 Guarantees — no CLOSED without reviewed postmortem/manual path; no duplicate postmortem.
## 12.5 Failure — rollback; user retries; generation retried.

---

# 13. Idempotency & Concurrency
## 13.1 Idempotency — **Identity:** `incidentId` (one postmortem). **Duplicate job:** no second record [C FR-033]. **Replay:** same; retry after FAILED state reuses/updates [UDR-07]. **Side-effect protection:** unique constraint; LLM call may repeat (cost) but result stored once.
## 13.2 Concurrency
| Race | Protection | Expected | Test |
|---|---|---|---|
| two generation jobs | UNIQUE(incidentId) + claim | one draft | parallel jobs |
| approve ∥ edit | row lock / version check [UNK] | consistent final content | race test |
| approve ∥ approve | incident lock | one CLOSED | parallel approve |
| generation completes after manual path used | [UNK] | UDR-06 | — |

---

# 14. API Surface — Preliminary
`PRELIMINARY — API CONTRACT NOT YET FROZEN`
| Candidate operation | Actor / Authz | Input | Domain action / transition | Output | Failures | Idempotency / concurrency | Confidence · Missing |
|---|---|---|---|---|---|---|---|
| Get postmortem | ENG/TL/ADMIN own team | incidentId | read | postmortem (+status, provenance) | 403/404 | read | High · absent/generating/failed representation |
| Update draft | same [C FR-028, §11] | incidentId, fields | edit | postmortem | 400/403/404/409 | version/ETag? [UNK] | High · edit rules, rejected state |
| Approve & close | same | incidentId | postmortem REVIEWED + RESOLVED→CLOSED | incident + postmortem | 403/404/409 | locked; repeat ⇒ conflict | High · one vs two endpoints, manual path |
| Retry generation | TL/ADMIN? [UNK] | incidentId | enqueue | accepted | 403/404/409 | idempotent | Low · exists? who? |
| Manual-path completion | UNKNOWN | — | — | — | — | — | Low · UDR-06 |
Pagination: `[N/A]`. Async: generation.

---

# 15. Events, Queues & Side Effects
## 15.1 Events Produced
| Event | Producer | Payload | Consumer |
|---|---|---|---|
| Audit `POSTMORTEM_GENERATED`, `POSTMORTEM_REVIEWED`, `CLOSED` | 11 | ids, reviewer | 06 |
| Outbox: closure notification | approve tx | incident, actor | 09 |
| Generation failure event | — | no type exists | UDR-05 |
## 15.2 Events Consumed — "postmortem requested" outbox event from 05's resolve tx [C §8 side effects].
## 15.3 Queue Jobs — postmortem queue; bounded retry; failure state [C BR-071]; params UDR-22.
## 15.4 Delivery — at-least-once; idempotent.
## 15.5 External Side Effects — LLM provider call.

---

# 16. Security & Authorization
Authorization (PRD §11): "Review/approve postmortem" — Engineer/Team Lead/Admin; team isolation applies [C]. Closure transition actors: "Authorized Engineer / Team Lead / Admin" [C §8]. Postmortem inputs include user comments and alert text → prompt-injection risk [D]; redaction before LLM [C §12.11; policy UDR-16]. AI-generated text must be labeled until reviewed [C BR-011/067]. Never log: prompts with content at INFO, LLM keys.

---

# 17. Failure Modes
| Failure | Detection | Expected | State Impact | Retry? | Evidence |
|---|---|---|---|---|---|
| LLM unavailable/invalid output | worker | record failure; retry bounded | incident RESOLVED | yes → failure state | BR-070/071 |
| Missing required context | validation | generation failure recorded | RESOLVED | UNK | BR-068 |
| Duplicate job | UNIQUE | no-op | none | n/a | FR-033 |
| Close without review | gate | 409 | none | no | BR-014 |
| Close tx failure | exception | rollback | none | user | ADR-010 |
| Retries exhausted | limit | failure state; manual path needed | RESOLVED | manual | OQ-008 |
## Critical Failure Scenario
**What fails:** generation permanently fails. **Must remain true:** incident stays RESOLVED and *can* eventually be closed via the defined manual path. **Recovery:** manual review path [UDR-06 — currently undefined; without it the incident could be stuck RESOLVED].

---

# 18. Observability
Logs: generation start/finish/failure, attempt, validation outcome; closure outcome; correlation id (FR-034). Metrics [P]: generation success/failure, time-to-draft, time RESOLVED→CLOSED, stuck-RESOLVED count. Audit: `POSTMORTEM_GENERATED` (Yes with draft store — D), `POSTMORTEM_REVIEWED` + `CLOSED` (Yes, same tx — C UC-010/BR-009).

---

# 19. Testing Strategy
- **Unit:** structure validation; provenance builder; closure gate matrix.
- **Integration:** one-per-incident; close atomicity; audit/outbox.
- **API:** `BLOCKED — API CONTRACT NOT YET FROZEN`.
- **Authorization:** cross-team edit/approve denied; unauthenticated.
- **Concurrency:** duplicate jobs; double approve; edit vs approve.
- **Idempotency:** job replay; retry after failure.
- **Failure injection:** LLM down; invalid output; fail audit in close tx.
- **Regression:** RESOLVED unaffected by AI failure; CLOSED terminal.

---

# 20. Test ↔ Requirement Traceability
| Requirement | AC | Test(s) | Status |
|---|---|---|---|
| FR-026, BR-065/066 | AC-029 | trigger/async tests | NOT RUN |
| FR-027, BR-070/071 | AC-030 | failure/retry tests | NOT RUN |
| FR-029, BR-069 | AC-031 | structure/provenance tests | NOT RUN |
| FR-033 | AC-032 | duplicate job test | NOT RUN |
| BR-014/072/067 | AC-015 | closure gate tests | NOT RUN |
| FR-028 | AC-033 | review metadata test | NOT RUN |
| BR-015 | AC-034 | terminal state tests | NOT RUN |
### Coverage Gaps
- No AC for manual review path, REJECTED semantics, edit concurrency, atomicity of approve+close.

---

# 21. Implementation Plan
## 21.1 Sequence
1. Decide UDR-06, 07, 15 (+05, 16, 22). 2. Schema alignment. 3. Generation worker + validator. 4. Retry/failure state. 5. Review/edit service. 6. Approve+close via kernel. 7. Concurrency/failure tests.
## 21.2 Files
### CREATE
```text
src/ai/postmortem/** · src/postmortem/** (review/closure) · test/postmortem/**
```
### MODIFY — `prisma/schema.prisma` (Postmortem); incident kernel usage.
### REVIEW ONLY — PRD §7 Postmortem Rules, UC-009/010; ADR-010.
## 21.3 Allowed — Postmortem/AI modules; kernel invocation. ## 21.4 Forbidden — direct `Incident.status` writes; inline LLM; skipping the gate. ## 21.5 Must exist — 05, 06, 08, 10 (provider abstraction).

---

# 22. AI Agent Context
## 22.1 Read First
1. `AGENTS.md` 2. This slice 3. `PROJECT_STATE.md` 4. `TEST_STATUS.md` 5. `SESSION_CHECKPOINT.md` 6. PRD §7 Postmortem Rules, §8, UC-009/010 7. DM Postmortem 8. DBS `Postmortem`
## 22.2 Relevant Canonical Context
| Topic | Source | Location |
|---|---|---|
| Requirement | PRD | FR-026–029/033, BR-013/014/065–072 |
| Domain | DM | Postmortem row |
| Architecture | ARCH | ADR-010, 012, 013, 014 |
| Database | DBS | `Postmortem`, `Incident` |
| API | — | not frozen |
## 22.3 Agent Objective
Implement postmortem generation, review, and gated closure with atomic approve+close; stop at UDR-06/07/15.

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
- Why failure state lives outside the incident lifecycle (BR-013).
- Closure gate under row lock; atomic approve+close.
- Idempotent generation via uniqueness.
- Provenance and human-in-the-loop for AI content.
## 23.2 SHOULD UNDERSTAND — structured-output validation; manual fallback design.
## 23.3 CAN DEFER — postmortem analytics.
## 23.4 Mental Model
The incident is "done" operationally at RESOLVED; CLOSED means "we also wrote down what we learned and a human vouched for it". AI drafts; a person signs.
## 23.5 First-Principles Questions
1. Why not block RESOLVED on the postmortem? 2. What breaks if closure isn't atomic with review? 3. Why one postmortem per incident? 4. Why record provenance? 5. What if the LLM never works?
## 23.6 Interview Questions
### Design
1. Design AI-drafted postmortems with human approval gating closure.
### Debugging
1. Incidents stuck in RESOLVED — causes?
### Failure Handling
1. LLM fails repeatedly — what is the user's path?
### Architecture
1. Which module should own the CLOSED transition and why?

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
- [ ] Close without reviewed postmortem rejected (409) and state unchanged
- [ ] Approve+close atomic under failure injection
- [ ] Manual path (UDR-06) exists so incidents cannot get stuck
- [ ] UDR-06, 07, 15 decided

---

# 25. Current Implementation Status

**Status:** `PLANNED` — DESIGN / PRE-IMPLEMENTATION (no implementation claimed)

### Completed
- None.

### In Progress
- None.

### Remaining
- Entire slice (blocked on UDR-06, UDR-07, UDR-15)

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
Pattern analysis, templates, postmortem search (DBS purpose text).
## Extension Points
Output schema versioning; review workflow.
## Known Limitations
No generation-status/failure storage in DBS; manual path undefined.
## Deliberately Not Generalized
Fixed structure; single reviewer.
## Potential Breaking Changes
Changing closure ownership (UDR-15) or postmortem schema.

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
- [ ] Manual review path implemented and tested.

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
