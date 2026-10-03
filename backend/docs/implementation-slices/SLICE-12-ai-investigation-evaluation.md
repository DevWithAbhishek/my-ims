# SLICE-12 — `AI-Assisted Investigation & Evaluation Harness`

> **Authority:** Canonical documents remain authoritative; this is a derived implementation view.
> **Evidence tags:** `[C]` CANONICAL · `[D]` DERIVED · `[P]` PROPOSED · `[UDR-nn]` USER DECISION REQUIRED (see `00-INDEX`) · `[UNK]` UNKNOWN · `[N/A]` NOT APPLICABLE.
> **Sources:** `PRD` (Revised Draft, 19 Sep 2026) · `ARCH` (unversioned) · `DM` (unversioned) · `DBS` (unversioned, "proposed MVP Schema").

## 0. Slice Metadata

| Field | Value |
|---|---|
| Slice ID | `SLICE-12` |
| Capability | On-demand, evidence-grounded AI investigation brief + repeatable evaluation set (non-production) |
| Version | `0.1` (DRAFT) |
| Status | `PLANNED` (DESIGN / PRE-IMPLEMENTATION) |
| MVP | `YES` (PRD §15 lists AI investigation and the evaluation set) |
| Created / Last Updated | `2026-10-01` / `2026-10-01` |
| Primary Owner / Module | `AI` (ARCH: "investigation, evidence") |

### Canonical Sources
- `PRD.md` — FR-040–FR-046; BR-073–BR-080; RD-035–RD-042; UC-011; AC-049–AC-054; NFR-010, NFR-011; Goals 20–21; §5 Engineer stories; §9 AI Investigation, Investigation Evidence, AI Evaluation Case; §14 (AI investigation/retrieval); OQ-009–OQ-012
- `Domain_Model.md` — AI_Investigation, Investigation_Evidence rows; "AI evaluation fixtures/test cases → development/testing artifact → not a production domain entity → no production API"
- `Architecture.md` — ADR-012, ADR-013, ADR-014; Failure/retry boundary
- `DB_Schema.md` — `Investigation`, `Evidence`, `Evaluation`, `AuditEvent` (`AI_INVESTIGATION_COMPLETED`)
- `API_Contracts.md` — NOT AVAILABLE · `DESIGN_CHECKS.md` — NOT PROVIDED

### Related Slices
- `SLICE-06` (timeline/comments as knowledge; audit) · `SLICE-11` (reviewed postmortems as knowledge) · `SLICE-04/05` (historical incidents) · `SLICE-08` (queue) · `SLICE-10` (provider abstraction/redaction) · `SLICE-01` (team authorization)

---

# 1. Capability Overview
## 1.1 Problem
During an incident, engineers need relevant prior incidents, reviewed postmortems, and runbooks without searching manually, and must be able to tell recorded fact from AI suggestion. [C: PRD §1, Goal 20]
## 1.2 Purpose
Retrieve authorized recorded IMS knowledge, produce an evidence-grounded brief with explicit evidence references, store it idempotently, never alter the incident, and keep a repeatable evaluation set outside production. [C: FR-040–046]
## 1.3 Behavior
An authorized user requests a brief for an incident; the system retrieves permitted evidence, generates a structured brief (summary of evidence, possible investigation areas, suggested steps), validates evidence references, and stores the result. Failures leave the incident usable.
## 1.4 End-to-End Summary
```text
Request {incidentId, user, request reference}
   ↓
Authorize (role + team) ; idempotency check
   ↓
Create Investigation (pending) [+ outbox job]
   ↓ async worker
Retrieve permitted knowledge (team-filtered) → evidence candidates
   ↓
Generate brief via LLM (redaction) → validate evidence refs / fact-vs-suggestion labels
   ↓
Store result + Evidence + AI_INVESTIGATION_COMPLETED   |   failure/no-evidence → recorded; incident unchanged
```

---

# 2. Scope
## 2.1 In Scope
Investigation request/lifecycle; retrieval limited by team authorization; evidence references; brief validation and storage; idempotent requests; failure/no-result handling; evaluation set + runner (verification activity).
## 2.2 Out of Scope
Changing incident state/severity/assignment/resolution [C BR-073]; autonomous actions, remediation [C PRD §4]; advanced retrieval/ranking [C PRD §16]; triage (10); postmortems (11).
## 2.3 MVP Scope
Retrieval over initial knowledge types: historical incidents, reviewed postmortems, runbooks, other configured IMS records [C RD-036] — exact set undefined (OQ-009).
## 2.4 Future Scope
Richer retrieval/ranking; more knowledge sources; broader evaluation [C PRD §16].

---

# 3. Requirement Traceability
| ID | Type | Source | Version | Requirement | Class |
|---|---|---|---|---|---|
| FR-040 | Functional | PRD §6 | PRD-RD | "An authorized user can request an AI-generated investigation brief for an incident using relevant recorded IMS knowledge." | C |
| FR-041 | Functional | PRD §6 | PRD-RD | "The investigation capability retrieves relevant recorded IMS information, including historical incidents, reviewed postmortems, runbooks, and other configured IMS knowledge sources." | C |
| FR-042 | Functional | PRD §6 | PRD-RD | "An AI investigation brief identifies the recorded sources used to support its statements or suggestions." | C |
| FR-043 | Functional | PRD §6 | PRD-RD | "An investigation brief summarizes relevant evidence, identifies possible areas of investigation, and provides suggested investigation steps without representing suggestions as confirmed facts." | C |
| FR-044 | Functional | PRD §6 | PRD-RD | "If retrieval or AI generation is unavailable, the incident remains fully usable and the user can continue manual investigation." | C |
| FR-045 | Functional | PRD §6 | PRD-RD | "Repeated execution of the same investigation request must not create conflicting or unintended duplicate investigation records." | C |
| FR-046 | Functional | PRD §6 | PRD-RD | "A small repeatable evaluation fixture/test suite is maintained outside the production domain model and API." | C |
| BR-073 | Business | PRD §7 | PRD-RD | "AI-assisted investigation is advisory and does not change incident state, severity, assignment, or resolution automatically." | C |
| BR-074 | Business | PRD §7 | PRD-RD | "Investigation retrieval is limited to knowledge the requesting user is authorized to access." (Enforcement: "Team authorization and source filtering"; failure: "Unauthorized evidence is excluded") | C |
| BR-075 | Business | PRD §7 | PRD-RD | "Investigation briefs must identify the recorded evidence used to support their content." (failure: "Output without valid evidence references is not accepted as a completed investigation result") | C |
| BR-076 | Business | PRD §7 | PRD-RD | "Recorded facts and AI-generated suggestions must remain distinguishable in the investigation result." | C |
| BR-077 | Business | PRD §7 | PRD-RD | "AI investigation failure does not block incident viewing, investigation, lifecycle transitions, or closure." | C |
| BR-078 | Business | PRD §7 | PRD-RD | "Repeated investigation execution must be safe and must not create conflicting results for the same request." | C |
| BR-079 | Business | PRD §7 | PRD-RD | "The evaluation set must contain known expected relevant evidence for its test cases." | C |
| BR-080 | Business | PRD §7 | PRD-RD | "AI investigation evaluation is a verification activity and does not itself change production incident data." | C |
| RD-036/037/039/040/041 | Decision | PRD §17 | PRD-RD | "Initial MVP sources are historical incidents, reviewed postmortems, runbooks, and other configured IMS records." · "Users can inspect which recorded sources support the result." · "Evidence from unauthorized teams must not be retrieved or exposed." · "Recorded evidence is not rewritten as an AI-confirmed fact." · "The same request must not create conflicting or unintended duplicate business records." | C |
| UC-011 | Use case | PRD §19 | PRD-RD | Main flow "Authorize user → retrieve permitted IMS knowledge → identify relevant evidence → generate structured investigation brief → validate evidence references → store result → record investigation event"; no-result flow "record that no relevant evidence was found → optionally generate a limited AI response stating the limitation"; failure "Record failure → incident remains unchanged → manual investigation remains available → retry when appropriate"; duplicate "Repeated request with the same idempotency/reference does not create conflicting investigation records" | C |
| AC-049 | Acceptance | PRD §20 | PRD-RD | "An authorized user can request an AI-assisted investigation brief for an incident without changing the incident lifecycle state." | C |
| AC-050 | Acceptance | PRD §20 | PRD-RD | "A completed AI investigation brief identifies the recorded evidence used and distinguishes evidence from AI-generated suggestions." | C |
| AC-051 | Acceptance | PRD §20 | PRD-RD | "An AI investigation request cannot retrieve or expose incident knowledge belonging to another unauthorized team." | C |
| AC-052 | Acceptance | PRD §20 | PRD-RD | "If AI or retrieval is unavailable, the incident remains usable and manual investigation can continue." | C |
| AC-053 | Acceptance | PRD §20 | PRD-RD | "Repeated execution of the same investigation request does not create conflicting or unintended duplicate investigation records." | C |
| AC-054 | Acceptance | PRD §20 | PRD-RD | "The AI evaluation set can be executed repeatedly and reports retrieval relevance and evidence/output validity without modifying production incident data." | C |
| NFR-010 / NFR-011 | NFR | PRD §13 | PRD-RD | "AI investigation results must provide traceable evidence references and remain distinguishable from recorded facts." · "AI investigation retrieval and output checks must be repeatable against a maintained evaluation set." | C |
| §9 AI Investigation / Evidence / Evaluation Case | Data | PRD §9 | PRD-RD | Investigation: ID, Incident ID, Requesting user, Status, Result, Generation timestamp, Model/version, Input/reference, Idempotency/request reference. Evidence: ID, **Investigation ID**, Source type, Source record reference, Relevance/reference info, Created. Evaluation Case: ID, Input incident/reference, Expected relevant evidence, Expected output constraints, Evaluation result, Run timestamp | C |
| DM | Domain | DM | unv. | AI_Investigation lifecycle "REQUESTED -> RUNNING -> COMPLETED -> FAILED"; "Every AI Investigation has at least one Investigation_Evidence record."; Incident→AI_Investigation 0..N; AI_Evaluation_Case "independent… not a production domain entity… no production API" | C |
| OQ-009–OQ-012 | Open Q | PRD §18 | PRD-RD | knowledge-set record types; retention; initial evaluation cases; exclusions/redaction | UNK |

---

# 4. Business Rules
## BR-073 — Advisory only
- **Interpretation:** this slice has no write path to Incident lifecycle columns; it writes only investigation/evidence records and an audit event. **Invalid:** any change to status/severity/assignment/resolution from an investigation. **Class:** C.

## BR-074 / RD-039 / AC-051 — Authorization-limited retrieval
- **Canonical Rule:** retrieval "limited to knowledge the requesting user is authorized to access" (Enforcement: "Team authorization and source filtering").
- **Interpretation:** the retrieval query itself carries the requester's `teamId` filter (filter *before* ranking/LLM, not after) [D]; knowledge from other teams must never reach the prompt or the stored result. **Gap:** the knowledge sources (incidents, postmortems) are team-scoped via incident→team, but "runbooks" have **no entity** in DM/DBS, so their ownership/team scope is undefined [UDR-08]. Because the worker runs as a system actor, the *requesting user's* team must be persisted with the request and enforced by the worker [D]. **Class:** C/UDR.

## BR-075 / BR-076 / RD-037 / RD-040 / FR-042 / FR-043 — Evidence-grounded, fact vs suggestion
- **Interpretation:** output is structured: (a) evidence-backed statements (each referencing ≥1 stored Evidence record), (b) AI suggestions (explicitly labeled, never as fact). **Validation:** references must resolve to retrieved, authorized records; otherwise result is "not accepted as completed" [C BR-075]. Output schema [UNK → UDR-08]. DBS `Evidence.evidenceType ∈ {FACT, INFERENCE, UNKNOWN}` exists but is not in PRD §9 [D]. **Class:** C.

## DM invariant — at least one evidence record per investigation
- "Every AI Investigation has at least one Investigation_Evidence record." conflicts with UC-011 "No-result flow: no sufficiently relevant evidence is found" (zero evidence) [D, SD-08 → UDR-08]. Resolution options (e.g., an `UNKNOWN`-type evidence record stating "none found") are unchosen.

## BR-077 / FR-044 — Failure isolation
- Failure is recorded and observable; incident and manual investigation unaffected; retry when appropriate. **Class:** C.

## BR-078 / FR-045 / RD-041 — Idempotent requests
- Identity = "idempotency/request reference" [C UC-011, §9]. `Investigation.idempotencyKey UNIQUE` is global in DBS (not scoped per user/incident) [D]; key origin (client-supplied vs server-derived) and scope [UDR-08]. **Class:** C/UDR.

## BR-079 / BR-080 / FR-046 — Evaluation set
- Fixtures include expected relevant evidence; running them modifies no production incident data; maintained outside the production domain model/API. **Conflict:** DBS has an `Evaluation` table with `incidentId NOT NULL` FK to `Incident`, i.e., production-coupled, contradicting DM and BR-080 [UDR-23, SD-11]. **Class:** C/UDR.

---

# 5. Functional Behavior
**5.1 Request investigation** — Trigger: user. Input: incidentId, request reference. Preconditions: authenticated; role allowed (Engineer/Team Lead/Admin [C UC-011]); incident in caller's team. Processing: tx → look up/insert `Investigation` by idempotency key (`pending`) [+ outbox job] → commit → return accepted/id [sync vs async response shape UDR-08]. State: `REQUESTED` [DM]; DBS `PENDING`. Failure: unauthorized 403/404; duplicate key ⇒ return the same investigation [C UC-011].
**5.2 Execute investigation (worker)** — mark `RUNNING` (DM; DBS lacks it) → retrieve team-authorized knowledge → select relevant evidence → (no evidence ⇒ no-result flow 5.4) → redact → LLM → validate refs/labels → tx: store result, insert Evidence records, status `COMPLETED`/`DONE`, append `AI_INVESTIGATION_COMPLETED` → commit.
**5.3 Failure** — retrieval/LLM/validation failure ⇒ record `FAILED` (DM; DBS has no FAILED and `result NOT NULL`), retry per policy, incident unchanged [C].
**5.4 No-result** — record that no relevant evidence was found; optionally a limited response stating the limitation [C UC-011]; whether this is `COMPLETED` or a distinct outcome [UDR-08].
**5.5 Read investigation** — return result + evidence references so users can inspect sources [C RD-037]; evidence content shown to the user must itself be team-authorized [D].
**5.6 Run evaluation (dev/test)** — iterate fixtures (input incident/reference, expected evidence, output constraints) → run retrieval/generation against a test dataset → report retrieval relevance and evidence/output validity; no production writes [C AC-054, BR-080]. Metrics definition (precision/recall/@k) [UNK → UDR-23].

---

# 6. Acceptance Criteria
- **AC-049** — request ⇒ brief produced; `Incident` unchanged. *Verify:* snapshot incident row before/after.
- **AC-050** — completed brief lists evidence and separates evidence from suggestions. *Verify:* schema + reference-resolution tests with fixtures.
- **AC-051** — two teams' data; request from team A never retrieves/exposes B's. *Verify:* seeded cross-team corpus; assert evidence set, prompt contents (via provider mock), and response.
- **AC-052** — LLM/retrieval down ⇒ incident views/transitions work; failure recorded. *Verify:* provider-down workflow test.
- **AC-053** — same request reference twice/concurrently ⇒ one investigation. *Verify:* parallel request test; row count.
- **AC-054** — evaluation runs repeatedly, reports relevance and validity, production tables untouched. *Verify:* run twice; compare reports; assert zero writes to production tables (DB audit / row counts).
- **BR-075 negative** — brief with a dangling/foreign evidence reference ⇒ not stored as completed. *Verify:* invalid output fixtures.

---

# 7. Domain Model
## 7.1 Entities
| Entity | Role |
|---|---|
| AI_Investigation (`Investigation`) | Request + execution state + result + provenance |
| Investigation_Evidence (`Evidence`) | Referenced recorded sources |
| Incident, Postmortem, Comment, AuditEvent, (runbooks?) | Knowledge sources (read) |
| AI_Evaluation_Case | Test fixture (non-production) |
## 7.2 Relationships — Incident→AI_Investigation 0..N; Investigation→Evidence 0..N (DM) but DM invariant ≥1; Investigation→requesting user 0..1 (DM) vs DBS `requestedBy NOT NULL`; **DBS `Evidence` links to `incidentId`, not to `Investigation`** [SD-08].
## 7.3 Invariants
| Invariant | Enforcement |
|---|---|
| Requester's team = incident's team | Application |
| Evidence only from authorized sources | Application |
| `idempotencyKey` unique | DB UNIQUE (nullable, global) |
| ≥1 evidence per investigation | **Unclear / conflicts with no-result flow** |
| `status` domain | DBS: PENDING/DONE; DM: REQUESTED/RUNNING/COMPLETED/FAILED — **unresolved** |
| Result present when completed | DBS `result NOT NULL` ⇒ pending rows need placeholder [D] |
## 7.4 State Machine
```text
REQUESTED → RUNNING → COMPLETED
                  ↘ FAILED
```
(DM) · DBS: `PENDING → DONE`. Owned here. Incident transitions: none.

---

# 8. Architectural Context
## 8.1 Relevant Architecture — ARCH lists AI module ownership of "investigation, evidence" and the rule that LLM calls happen only in workers. ARCH diagram shows "Investigation / Postmortem" under AI. **ARCH defines no retrieval infrastructure** (no vector store, embedding provider, or search index) [D → UDR-08]. ADR-013 provider abstraction; ADR-005 Redis caching of LLM outputs.
## 8.2 Components
| Component | Responsibility |
|---|---|
| Controller/Service | request, authz, idempotent create |
| Retrieval component | team-filtered knowledge search [mechanism UNK] |
| Worker | orchestrate generation/validation/store |
| AI provider interface | LLM (and embeddings if used) |
| Evaluation runner | test-time only |
## 8.3 Constraints — worker-only external calls; modules write own tables; read other modules' data through their interfaces [D ADR-001]; evaluation outside production domain/API [C].
## 8.4 ADRs — **ADR-012** (async/advisory), **ADR-013**, **ADR-014** (idempotent), **ADR-009** (if request+job created via outbox).

---

# 9. Dependency Model
## 9.1 Upstream
| Slice | Type | Requires |
|---|---|---|
| 01 | SYNC | authz, team |
| 04/05 | READ | historical incidents/alerts |
| 06 | READ | comments, timeline |
| 11 | READ | **REVIEWED** postmortems only [C FR-041 "reviewed postmortems"] |
| 08 | RUNTIME | queue |
| 10 | SHARED CODE | provider abstraction, redaction |
## 9.2 Downstream — 06 (`AI_INVESTIGATION_COMPLETED`); users via read API.
## 9.3 Contract
**Allowed:** read-only query interfaces of knowledge owners; write own tables + audit. **Forbidden:** writing other modules' tables; reading unreviewed postmortems as evidence [D]; bypassing team filter.

---

# 10. Slice Coupling Analysis
## 10.1 Transactional — **NO** hard coupling; own tx for request creation and result storage [D]. Request + outbox job insert atomic [D from ADR-009].
## 10.2 Synchronous — Request-time authz sync; generation async.
## 10.3 Shared Invariants — "Advisory only" (no lifecycle change) enforced by absence of write path; "team isolation" shared with 01 → rule owned by 01, enforced here at retrieval.
## 10.4 Summary
| Related Slice | Coupling | Strength | Boundary Decision |
|---|---|---|---|
| 10 | shared AI infra | Soft | SEPARATE |
| 11 | read reviewed postmortems | Soft | SEPARATE |
| 06 | read | Soft | SEPARATE |
| 08 | runtime | Medium | SEPARATE |
| Evaluation harness (inside) | shares retrieval/validation code | Medium | KEEP TOGETHER (non-production); could split if it grows — NEEDS USER DECISION (UDR-23) |
### Boundary Decision
Investigation request/result and its evidence validation are one capability; the evaluation harness verifies the same retrieval/validation logic and carries no production API.

---

# 11. Data Model
## 11.1 Tables — `Investigation`, `Evidence`, `Evaluation` (conflicting), `AuditEvent`.
## 11.2 Fields
| Field | Purpose | Required? |
|---|---|---|
| `Investigation.status` (PENDING/DONE) | state | Yes |
| `result text` | brief | **NOT NULL** |
| `model`, `modelVersion` | provenance | No |
| `input jsonb` | request/reference info | Yes |
| `idempotencyKey` UNIQUE | dedupe | No |
| `requestedBy`, `incidentId` | links | Yes |
| `Evidence.sourceType`, `sourceReference`, `relevanceInfo` | reference | No |
| `Evidence.evidenceType` FACT/INFERENCE/UNKNOWN | fact/suggestion distinction | Yes |
| `Evidence.incidentId` | link (to incident, not investigation) | Yes |
| `Evaluation.input/evidence/constraints/result`, `incidentId` | fixture/result | Yes |
## 11.3 Constraints — CHECKs; UNIQUE(idempotencyKey); indexes on `(incidentId, requestedBy)`, `(incidentId, status)`, `(incidentId, sourceType)`.
## 11.4 DB Invariants — enum domains; key uniqueness only.
## 11.5 Migration Requirements — [UDR-08/23]: `Evidence.investigationId` FK; status values incl. FAILED/RUNNING; relax `result NOT NULL` or separate result column semantics; scoped idempotency (e.g., `UNIQUE(incidentId, requestedBy, key)`); runbook/knowledge-source representation; retention (OQ-010); `Evaluation` placement (test-only store vs production table).

---

# 12. Transaction & Consistency Model
## 12.1 Boundary
```text
Request:   BEGIN; upsert-by-key Investigation(pending); [INSERT OutboxEvent]; COMMIT
Complete:  [retrieval + LLM outside tx]
           BEGIN; UPDATE Investigation(result, status); INSERT Evidence…; INSERT AuditEvent(AI_INVESTIGATION_COMPLETED); COMMIT
```
[D]
## 12.2 Atomic — result + evidence + event.
## 12.3 Locking — UNIQUE key; row claim for worker (`RUNNING`) [P].
## 12.4 Guarantees — completed investigation has valid evidence refs (BR-075); incident untouched.
## 12.5 Failure — rollback; mark FAILED in separate tx [P]; retry.

---

# 13. Idempotency & Concurrency
## 13.1 Idempotency — **Identity:** request reference / `idempotencyKey` [C UC-011]. **Duplicate request:** returns/represents the same investigation [C BR-078]. **Replay (worker):** completed ⇒ no-op; running ⇒ skip/resume [UNK]. **Side-effect protection:** unique key; LLM call may repeat but stored once.
## 13.2 Concurrency — **Race:** two identical requests ⇒ UNIQUE; loser reads winner. **Race:** same incident, different keys ⇒ two investigations are allowed (0..N) [C DM]. **Race:** knowledge changes during retrieval ⇒ acceptable snapshot [D]. **Required tests:** parallel duplicate request; cross-team race (user moved/deactivated mid-job — UNK).

---

# 14. API Surface — Preliminary
`PRELIMINARY — API CONTRACT NOT YET FROZEN`
| Candidate operation | Actor / Authz | Input | Domain action | Output | Failures | Idempotency / concurrency | Confidence · Missing |
|---|---|---|---|---|---|---|---|
| Request investigation (`POST …/incidents/{id}/investigations`) | ENG/TL/ADMIN own team [C UC-011] | incidentId, request reference | create investigation (+ async job) | investigation id/status (accepted vs result) | 400/401/403(404)/409 | idempotency key (header vs body UNK) | High (exists) · sync vs async response, key origin, polling vs push (SSE/WebSocket out of scope) |
| Get investigation(s) for incident | same | incidentId / id | read | brief, status, evidence refs, provenance, labels | 403/404 | read | High · list vs single; retention (OQ-010) |
| Retry failed investigation | same? [UNK] | id | requeue | status | 403/404/409 | idempotent | Low · "retry when appropriate" mechanism |
| (no evaluation API) | — | — | — | — | — | — | High: PRD says no production API for evaluation |
Pagination/filtering for lists [UNK]. Timing: async (LLM in worker).

---

# 15. Events, Queues & Side Effects
## 15.1 Events Produced — audit `AI_INVESTIGATION_COMPLETED` (on success only [C UC-011]); failure/no-result events [UDR-05].
## 15.2 Events Consumed — outbox "investigation requested" [D, type UDR-12].
## 15.3 Queue Jobs — investigation queue; retry [UDR-22].
## 15.4 Delivery — at-least-once; idempotent [C ADR-014 / FR-045].
## 15.5 External Side Effects — LLM (and embedding, if chosen) calls in the worker; data sent per redaction policy (OQ-006/012 → UDR-16).

---

# 16. Security & Authorization
Authorization (UC-011): Engineer/Team Lead/Admin, same team. **Team-filtered retrieval** at query time [C BR-074]. Worker acts with the persisted requester team. **Sensitive data:** knowledge may include alert payloads/comments/postmortems with sensitive text → redaction before LLM [C §12.11; OQ-012]. **Prompt injection:** retrieved records (incl. comments, runbooks, payloads) are untrusted instructions-in-data; validate output schema and evidence references [D]. **Data exposure:** evidence display must re-check authorization [D]. Never log prompts/evidence bodies at INFO [P].

---

# 17. Failure Modes
| Failure | Detection | Expected | State Impact | Retry? | Evidence |
|---|---|---|---|---|---|
| Retrieval unavailable | error | record failure; incident usable | none | yes | FR-044, AC-052 |
| LLM unavailable/invalid output | worker/validator | record failure; not accepted as completed | none | bounded | BR-075/077 |
| Dangling/unauthorized evidence ref | validator | reject result | none | maybe | BR-075, BR-074 |
| No relevant evidence | retrieval | no-result outcome | none | n/a | UC-011 |
| Duplicate request/job | UNIQUE | same investigation | none | n/a | AC-053 |
| Cross-team leakage | tests/guards | must not occur | — | — | AC-051 |
| Evaluation run writes prod data | audit | must not occur | — | — | BR-080 |
## Critical Failure Scenario
**What fails:** retrieval filter bug lets team B evidence into team A's prompt. **Must remain true:** no cross-team exposure (AC-051). **Recovery:** filter-in-query design + cross-team seeded tests as regression gate.

---

# 18. Observability
Logs: request, retrieval counts (not contents), generation outcome, validation result, correlation id. Metrics [P]: success/failure/no-result, latency, evidence count, validation rejects; evaluation scores (offline). Audit: `AI_INVESTIGATION_COMPLETED` (Yes with result tx — D). Evaluation reports stored as test artifacts [P].

---

# 19. Testing Strategy
- **Unit:** output validator (fact/suggestion labels, ref resolution); retrieval filter builder; no-result handling.
- **Integration:** request idempotency; result+evidence+audit atomicity; incident untouched; `Evaluation` isolation.
- **API:** `BLOCKED — API CONTRACT NOT YET FROZEN`.
- **Authorization:** unauthenticated; same-team any role; cross-team requester; cross-team evidence exclusion (AC-051).
- **Concurrency:** duplicate requests; worker duplicates.
- **Idempotency:** same key twice; replay of completed.
- **Failure injection:** LLM/retrieval down; invalid refs; DB failure at store.
- **Regression:** evaluation suite on every retrieval/prompt/model change [C NFR-011].

---

# 20. Test ↔ Requirement Traceability
| Requirement | AC | Test(s) | Status |
|---|---|---|---|
| FR-040, BR-073 | AC-049 | lifecycle-unchanged test | NOT RUN |
| FR-042/043, BR-075/076, NFR-010 | AC-050 | evidence/label validation | NOT RUN |
| BR-074, RD-039 | AC-051 | cross-team corpus test | NOT RUN |
| FR-044, BR-077 | AC-052 | AI-down tests | NOT RUN |
| FR-045, BR-078 | AC-053 | duplicate-request tests | NOT RUN |
| FR-046, BR-079/080, NFR-011 | AC-054 | evaluation runner tests | NOT RUN |
### Coverage Gaps
- No AC for no-result flow, retention, failed-investigation retry, runbook scoping.

---

# 21. Implementation Plan
## 21.1 Sequence
1. Decide UDR-08, 16, 23 (+05, 22). 2. Schema alignment. 3. Retrieval interface + team filter. 4. Request + idempotency. 5. Worker + validator. 6. Failure/no-result paths. 7. Evaluation fixtures + runner. 8. Cross-team and idempotency suites.
## 21.2 Files
### CREATE
```text
src/ai/investigation/** · src/ai/retrieval/** · test/ai/investigation/** · test/evaluation/** (fixtures + runner)
```
### MODIFY — `prisma/schema.prisma` (Investigation, Evidence); worker registration.
### REVIEW ONLY — PRD BR-073–080, UC-011; DM AI rows.
## 21.3 Allowed — AI module; test-only evaluation code. ## 21.4 Forbidden — writing Incident columns; unfiltered retrieval; production API for evaluation; choosing retrieval tech without UDR-08. ## 21.5 Must exist — 01, 06, 08, 10; reviewed-postmortem source (11).

---

# 22. AI Agent Context
## 22.1 Read First
1. `AGENTS.md` 2. This slice 3. `PROJECT_STATE.md` 4. `TEST_STATUS.md` 5. `SESSION_CHECKPOINT.md` 6. PRD BR-073–080, UC-011, AC-049–054 7. DM AI rows 8. DBS `Investigation`, `Evidence`, `Evaluation`
## 22.2 Relevant Canonical Context
| Topic | Source | Location |
|---|---|---|
| Requirement | PRD | FR-040–046, BR-073–080, RD-035–042 |
| Domain | DM | AI_Investigation, Investigation_Evidence, evaluation note |
| Architecture | ARCH | ADR-012, 013, 014 |
| Database | DBS | `Investigation`, `Evidence`, `Evaluation` |
| API | — | not frozen |
## 22.3 Agent Objective
Implement authorized, idempotent, evidence-grounded investigation with strict validation and a test-only evaluation runner; stop at UDR-08/23 for schema and retrieval decisions.

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
- Authorization as a retrieval-time filter (not post-hoc).
- Grounding: evidence references, fact vs suggestion, validating model output.
- Idempotent request identity; async job lifecycle.
- Why evaluation is separate from production data.
## 23.2 SHOULD UNDERSTAND — retrieval approaches (keyword vs embeddings), precision/recall@k, prompt injection via retrieved text.
## 23.3 CAN DEFER — ranking optimization, reranking.
## 23.4 Mental Model
A research assistant who may only open your team's files, must footnote every claim, labels guesses as guesses, and can never touch the incident itself.
## 23.5 First-Principles Questions
1. Why filter before ranking? 2. What breaks if evidence refs aren't validated? 3. Why is the request idempotent? 4. Why a repeatable evaluation set? 5. Why advisory-only?
## 23.6 Interview Questions
### Design
1. Design tenant-safe RAG over incident history.
### Debugging
1. A brief cites an incident the user can't access — how did it happen?
### Failure Handling
1. Retrieval finds nothing — what should the system return?
### Architecture
1. How would you evaluate retrieval changes safely?

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
- [ ] Cross-team seeded corpus never leaks into prompt/result
- [ ] Output with unresolved evidence refs is rejected
- [ ] Evaluation run performs zero production writes
- [ ] UDR-08, 23 decided

---

# 25. Current Implementation Status

**Status:** `PLANNED` — DESIGN / PRE-IMPLEMENTATION (no implementation claimed)

### Completed
- None.

### In Progress
- None.

### Remaining
- Entire slice (blocked on UDR-08, UDR-23)

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
Better retrieval/ranking; more sources; broader evaluation (PRD §16).
## Extension Points
Knowledge-source adapters; retriever interface.
## Known Limitations
No retrieval stack in ARCH; runbook entity missing; schema misaligned.
## Deliberately Not Generalized
Advisory only; small evaluation set.
## Potential Breaking Changes
Changing result schema/evidence model; changing knowledge-source set.

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
- [ ] Evaluation suite repeatable and runnable by CI/locally.

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
