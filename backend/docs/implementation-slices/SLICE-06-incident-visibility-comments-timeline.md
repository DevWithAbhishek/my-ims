# SLICE-06 — `Incident Visibility: Query, Comments & Timeline`

> **Authority:** Canonical documents remain authoritative; this is a derived implementation view.
> **Evidence tags:** `[C]` CANONICAL · `[D]` DERIVED · `[P]` PROPOSED · `[UDR-nn]` USER DECISION REQUIRED (see `00-INDEX`) · `[UNK]` UNKNOWN · `[N/A]` NOT APPLICABLE.
> **Sources:** `PRD` (Revised Draft, 19 Sep 2026) · `ARCH` (unversioned) · `DM` (unversioned) · `DBS` (unversioned, "proposed MVP Schema").

## 0. Slice Metadata

| Field | Value |
|---|---|
| Slice ID | `SLICE-06` |
| Capability | Incident Visibility: team-scoped read models, comments, append-only timeline/audit contract |
| Version | `0.1` (DRAFT) |
| Status | `PLANNED` (DESIGN / PRE-IMPLEMENTATION) |
| MVP | `YES` |
| Created / Last Updated | `2026-10-01` / `2026-10-01` |
| Primary Owner / Module | `Incident` (ARCH: owns "comments, audit") |

### Canonical Sources
- `PRD.md` — FR-010 (timeline), FR-016, FR-018; BR-004, BR-009 (event production); RD-032; UC-002; AC-008, AC-017, AC-041; NFR-006; §5 stories; §9 Incident Comment, Incident Event/Audit Event; §11; §12.10
- `Domain_Model.md` — Incident→Comment, Comment→User, Incident→AuditLog, AuditLog→User
- `Architecture.md` — Module Responsibilities (Incident)
- `DB_Schema.md` — `Comment`, `AuditEvent`, `Incident` (read), indexes
- `API_Contracts.md` — NOT AVAILABLE · `DESIGN_CHECKS.md` — NOT PROVIDED

### Related Slices
- `SLICE-05` and every producer slice write audit events through this slice's contract; `SLICE-04/07/09/10/11/12` produce event types shown on the timeline; `SLICE-01` team scoping

---

# 1. Capability Overview
## 1.1 Problem
People need to see current incident state and "what happened" in order, and add commentary; the record must be append-only. [C: PRD Goals 6, 12; RD-032]
## 1.2 Purpose
Own (a) team-scoped incident reads, (b) incident comments, (c) the append-only `AuditEvent` structure and event vocabulary, and (d) the timeline read model. [D: ARCH assigns comments + audit to the Incident module]
## 1.3 Behavior
Team members list/view incidents (state, assignment, severity, timeline, alert info — UC-002), add comments, read the chronological timeline.
## 1.4 End-to-End Summary
```text
Read: authz+team scope → load incident (+ alert info, comments, events) → return
Write comment: authz → insert Comment [+ COMMENT_ADDED event] → return
Producers (other slices): appendAuditEvent(tx, …) inside their own transaction
```

---

# 2. Scope
## 2.1 In Scope
Incident list/detail reads; comment create (and read); timeline read; the `appendAuditEvent` contract; append-only enforcement; event-type vocabulary governance (UDR-05).
## 2.2 Out of Scope
State changes (05); producing events other than `COMMENT_ADDED` (each producer slice); notification, SLA computation.
## 2.3 MVP Scope
Reads + comments + timeline as above. Full-text search / dashboards not required [D].
## 2.4 Future Scope
Real-time updates (non-goal in MVP, PRD §4/§16).

---

# 3. Requirement Traceability
| ID | Type | Source | Version | Requirement | Class |
|---|---|---|---|---|---|
| FR-016 | Functional | PRD §6 | PRD-RD | "Authorized users can add comments to an incident. Comments become part of the incident timeline." | C |
| FR-018 | Functional | PRD §6 | PRD-RD | "The system records defined lifecycle, SLA, assignment, notification, comment, alert-source, AI, and postmortem events in chronological order." | C |
| FR-010 | Functional | PRD §6 | PRD-RD | incident record incl. "timeline" (see 04/05) | C |
| BR-004 | Business | PRD §7 | PRD-RD | "Users can access incidents only within their authorized team." | C |
| BR-009 | Business | PRD §7 | PRD-RD | "Every successful lifecycle transition produces an audit/timeline event." (producers; this slice stores them) | C |
| RD-032 | Decision | PRD §17 | PRD-RD | "Audit history is an append-only incident event/timeline, not a full event-sourced system." | C |
| §12.10 | Security | PRD §12 | PRD-RD | "Record security-relevant and incident lifecycle actions in an append-only audit/timeline structure." | C |
| UC-002 | Use case | PRD §19 | PRD-RD | "Authorize user → retrieve incident → return current incident state, assignment, severity, timeline, and relevant alert information"; failure "Unauthorized access → reject with 403"; no state change | C |
| AC-008 | Acceptance | PRD §20 | PRD-RD | "An unauthorized user cannot view or modify another team's incident and receives 403." | C |
| AC-017 | Acceptance | PRD §20 | PRD-RD | "An incident comment is stored with its author and timestamp and appears in the incident timeline." | C |
| AC-041 / NFR-006 | Perf | PRD §13/§20 | PRD-RD | "p95 latency below 300ms for read endpoints serving current incident status under the defined synthetic workload." | C |
| §11 | Authz | PRD §11 | PRD-RD | View own team's incidents, Add incident comments, View audit/timeline: Engineer/Team Lead/Admin all "Yes" | C |
| §5 stories | Stories | PRD §5 | PRD-RD | Engineer: view team incidents; "review the incident timeline and escalation history"; Team Lead: "review escalation and SLA status for incidents handled by my team" | C |
| §9 Comment / Audit | Data | PRD §9 | PRD-RD | Comment: ID, Incident ID, Author ID, content, created; Audit: Event ID, Incident ID, type, actor where applicable, metadata, created; supported event types list (see §7) | C |
| DM | Domain | DM | unv. | Incident→Comment 0..N; Comment→User 1; Incident→AuditLog 0..N; AuditLog→User 0..1 | C |

---

# 4. Business Rules
## Append-only audit (RD-032 / §12.10)
- **Canonical Rule:** "Audit history is an append-only incident event/timeline" (RD-032).
- **Interpretation:** only INSERTs on `AuditEvent`; no UPDATE/DELETE path in code. DBS has no DB-level protection (no trigger/revoke) [D → P: restrict DB role / trigger].
- **Engineering Consequence:** repository exposes only `append` + reads. **Invalid:** any update/delete of audit rows. **Class:** C (rule) / UNK (DB enforcement).

## BR-004 — Team-scoped read access
- **Canonical Rule:** "Users can access incidents only within their authorized team." → every list/detail/timeline/comment query includes the caller's team predicate. **Invalid:** cross-team read. 403 vs 404: [UDR-20]. **Class:** C.

## BR-009 (consumer view)
- The timeline can only show events that producers commit atomically with their state changes; this slice defines the append contract (`appendAuditEvent(tx, …)`) producers must call in-transaction. [D]

## Comment rules (FR-016)
- Comments are authored by the authenticated user, immutable (no edit/delete requirement exists) [D], and appear on the timeline. Allowed on which incident states (e.g., `CLOSED`)? [UNK]. Whether a `COMMENT_ADDED` audit event is written with the comment, in the same transaction [P], and whether the timeline merges `Comment` rows or reads `COMMENT_ADDED` events only [UDR-05].

---

# 5. Functional Behavior
**5.1 List incidents** — Trigger: user. Input: filters/pagination [UNK]. Processing: authz → query by caller's `teamId` → return summaries. Output: incident summaries. (Filtering/pagination requirements are not stated in the PRD [UNK].)
**5.2 View incident** — Input: incidentId. Processing: load incident; verify team; include assignment, severity, status, timeline, relevant alert info [C UC-002]. No state change. Failure: unauthorized → 403 (UC-002) / 404 (BR-004) [UDR-20]. Exposure of `originalPayload` to users [UNK].
**5.3 Add comment** — Input: incidentId, description (+ optional title [C DBS]). Preconditions: authenticated; same team; role any [C §11]. Processing: insert `Comment(incidentId, authorId=caller)`; [P] insert `COMMENT_ADDED` in same tx. Output: comment. Failure: empty description → 400; unauthorized.
**5.4 View timeline** — chronological events (+ comments per UDR-05) for the incident; team scoped. 
**5.5 Append audit event (internal contract)** — `appendAuditEvent(tx, {incidentId, eventType, actor?, metadata?})`: validates `eventType` against the vocabulary; participates in the caller's transaction. [D from BR-009/ADR-010]

---

# 6. Acceptance Criteria
- **AC-017** — *Given* an authorized user · *When* adding a comment · *Then* stored with author + timestamp and visible in timeline. *Verify:* integration test comparing timeline contents.
- **AC-008** — cross-team list/view/comment/timeline all denied. *Verify:* authorization matrix tests.
- **AC-041 / NFR-006** — read latency under load [verify after implementation; needs team-scoped indexes, see §11].
- **Append-only (RD-032)** — *Verify:* attempt UPDATE/DELETE via application layer is impossible; DB-level test if protection is added [P].
- **FR-018 ordering** — events returned in chronological order; ties broken deterministically [P]. *Verify:* ordering test with identical timestamps.

---

# 7. Domain Model
## 7.1 Entities
| Entity | Role |
|---|---|
| Comment | Remark by a user on an incident |
| AuditEvent (Incident Event) | Append-only timeline entry |
| Incident (read) | Subject |
## 7.2 Relationships — Incident→Comment 0..N; Comment→User 1 (author); Incident→AuditEvent 0..N; AuditEvent→User 0..1 (`actor`, **no FK** in DBS).
## 7.3 Invariants
| Invariant | Enforcement |
|---|---|
| Comment has incident + author | DB NOT NULL FKs |
| Audit `eventType` ∈ fixed list | DB CHECK |
| Audit rows never mutated | **Unclear/application** |
| Audit `actor` references a user | **Not enforced** (no FK) |
| Audit rows from non-incident contexts (identity/config) | `incidentId` nullable but event types don't cover them [UDR-05] |
## 7.4 State Machine — `[N/A]` (no states). **Event vocabulary mismatch** [C vs C]:
- PRD §9: `INCIDENT_CREATED, ALERT_RECEIVED, ALERT_DUPLICATE, AI_TRIAGE_COMPLETED, ASSIGNED, ACKNOWLEDGED, SEVERITY_CHANGED, COMMENT_ADDED, SLA_WARNING, ESCALATED, NOTIFICATION_SENT, SOURCE_ALERT_RESOLVED, RESOLVED, POSTMORTEM_GENERATED, POSTMORTEM_REVIEWED, AI_INVESTIGATION_COMPLETED, CLOSED`.
- DBS CHECK: `ALERT_RECEIVED, ALERT_DUPLICATE, AI_TRIAGE_COMPLETED, ASSIGNED, INCIDENT_CREATED, ACKNOWLEDGED, SEVERITY_CONFIRMED, COMMENT_ADDED, SLA_WARNING, ESCALATED_L1…L4, SOURCE_ALERT_RESOLVED, RESOLVED, NOTIFIED, POSTMORTEM_GENERATED, POSTMORTEM_REVIEWED, AI_INVESTIGATION_COMPLETED, CLOSED`.
- Differences: `SEVERITY_CHANGED`↔`SEVERITY_CONFIRMED`; `ESCALATED`↔`ESCALATED_L1–L4`; `NOTIFICATION_SENT`↔`NOTIFIED`. Missing in both: unassign/reassign, SLA breach, escalation failure, AI/notification/postmortem/investigation *failure*, "no relevant evidence" [UDR-05].

---

# 8. Architectural Context
## 8.1 Relevant Architecture — ARCH: Incident module owns "comments, audit". Request flow Controller→Service→Repository→PostgreSQL. 
## 8.2 Components
| Component | Responsibility |
|---|---|
| Controller | read/comment endpoints |
| Query service / repository | team-scoped reads; raw SQL for complex reads [C ARCH] |
| Audit repository | `append` only |
## 8.3 Constraints — read endpoints must meet NFR-006 (300 ms p95); no AI/external calls on read path [D].
## 8.4 ADRs — **ADR-010** (audit in same tx — contract requirement); **ADR-001** (other modules may not write `AuditEvent` directly; only via the contract) [D].

---

# 9. Dependency Model
## 9.1 Upstream
| Slice | Type | Requires |
|---|---|---|
| 01 | SYNC | context/guards |
| 04/05/07/09/10/11/12 | DATA | events they append |
## 9.2 Downstream
| Slice | Relationship | Provides |
|---|---|---|
| 04, 05, 07, 09, 10, 11, 12 | IN-TX CALL | `appendAuditEvent(tx, …)` |
| 11, 12 | READ | comments + timeline as postmortem/investigation input [C UC-009 inputs] |
## 9.3 Contract
**Allowed:** `appendAuditEvent`, comment/timeline read functions. **Forbidden:** direct writes to `AuditEvent`/`Comment` from other modules; updating/deleting audit rows.

---

# 10. Slice Coupling Analysis
## 10.1 Transactional — **YES (contractual)** — producers need the audit insert inside their tx. Narrow function ⇒ SEPARATE slice, KEEP contract.
## 10.2 Synchronous — Yes (in-tx call).
## 10.3 Shared Invariants — "Transition ⇒ audit event" is *enforced by the producer's transaction* and *stored here*: ownership split explicit: **producer owns atomicity; this slice owns shape/append-only/vocabulary** [D].
## 10.4 Summary
| Related Slice | Coupling | Strength | Boundary Decision |
|---|---|---|---|
| 05, 04, 07, 11 | in-tx append | Medium | SEPARATE (contract) |
| 11, 12 | read | Soft | SEPARATE |
### Boundary Decision
Reads/comments/audit-store have no domain transitions; their only hard coupling is a one-function in-transaction contract.

---

# 11. Data Model
## 11.1 Tables — `Comment`, `AuditEvent`; `Incident`, `Alert` (read).
## 11.2 Fields
| Field | Purpose | Required? |
|---|---|---|
| `Comment.title`, `description` | comment content | description Yes |
| `Comment.incidentId`, `authorId`, `createdAt` | links/time | Yes |
| `AuditEvent.eventType`, `actor`, `incidentId`, `metadata jsonb`, `createdAt` | timeline | eventType Yes |
## 11.3 Constraints — CHECK(eventType); FK incidentId; index `idx_auditEvent_incident_type_actor(incidentId, eventType, actor)`; `idx_comment_incident_author(incidentId, authorId)`.
## 11.4 DB Invariants — event-type domain; FK integrity.
## 11.5 Migration Requirements [D/P]
- No index with `teamId` on `Incident` (existing: `(status, currentAssignee)`, `(severity, affectedServiceId)`) — team-scoped listing needs one for NFR-006.
- Timeline ordering by `createdAt` needs `(incidentId, createdAt)` rather than the existing `(incidentId, eventType, actor)` index.
- Append-only protection (trigger/role) [P]; vocabulary reconciliation [UDR-05].

---

# 12. Transaction & Consistency Model
## 12.1 Boundary
Comment: `BEGIN; INSERT Comment; [P] INSERT AuditEvent(COMMENT_ADDED); COMMIT`. Reads: no transaction requirement [D].
## 12.2 Atomic — comment + its event [P; BR-009 covers lifecycle transitions only, so this is not canonical].
## 12.3 Isolation — default [UNK]. ## 12.4 Guarantees — if comment visible, its event visible (if P adopted).
## 12.5 Failure — rollback.

---

# 13. Idempotency & Concurrency
## 13.1 Idempotency — comment creation has no idempotency key [UNK]; double-submit creates two comments [D].
## 13.2 Concurrency — concurrent comments allowed; ordering by timestamp (+ tiebreaker [P]). Race between comment and `CLOSED` (if comments blocked after close, UNK).

---

# 14. API Surface — Preliminary
`PRELIMINARY — API CONTRACT NOT YET FROZEN`
| Candidate operation | Actor / Authz | Input | Domain action | Output | Failures | Idempotency / concurrency | Confidence · Missing |
|---|---|---|---|---|---|---|---|
| List incidents | ENG/TL/ADMIN own team [C §11] | filters (status? severity? assignee?) [UNK], pagination [UNK] | read | summaries | 401/403 | read | High (exists) · filters, sort, page style |
| Get incident detail | same | incidentId | read | state, assignment, severity, timeline, alert info [C UC-002] | 401/403(404)/404 | read | High · payload exposure, embedded vs separate timeline |
| Add comment | same [C §11] | incidentId, title?, description | insert | comment | 400/401/403/404 | double-submit [UNK] | High · allowed states |
| List comments | same | incidentId | read | comments | same | read | Medium |
| Get timeline | same [C §11 "View audit/timeline"] | incidentId | read | ordered events | same | read | High · merge with comments, event shape |
Pagination/filtering is explicitly undefined in the PRD → decision before API freeze. NFR-006 p95 < 300 ms for status reads.

---

# 15. Events, Queues & Side Effects
Produces `COMMENT_ADDED` [C event type]; no queue jobs; no notification requirement for comments in PRD (not listed in transition side effects) [D/UNK UDR-14]. External: none.

---

# 16. Security & Authorization
## 16.1 Authentication — required. ## 16.2 Authorization — Engineer/Team Lead/Admin may view and comment [C §11]. ## 16.3 Isolation — team predicate on every query [C BR-004]; 403 vs 404 [UDR-20]. ## 16.4 Input — comment length/format [P]; output encoding for stored text [P]. ## 16.5 Sensitive — comment bodies and `metadata` may contain sensitive text; never log bodies at INFO [P]; `originalPayload` exposure [UNK].

---

# 17. Failure Modes
| Failure | Detection | Expected | Recovery |
|---|---|---|---|
| Cross-team access | team guard | 403/404 [C AC-008] | — |
| Unknown incident | lookup | 404 | — |
| Invalid event type | CHECK / contract validation | reject append → caller tx rolls back [D] | fix producer |
| DB failure | exception | 5xx | retry |
| Slow reads | latency metric | NFR-006 breach | add indexes (11.5) |
## Critical Failure Scenario
**What fails:** a producer inserts an unknown event type. **Must remain true:** the producer's state change does not commit without a valid event (BR-009). **Recovery:** contract validation + CHECK.

---

# 18. Observability
Logs: comment created (ids only), read latency, authz denials. Metrics: read p95 (NFR-006), timeline size. Audit: `COMMENT_ADDED` [Transactional: Yes — P]. Correlation ID on all requests [C NFR-003].

---

# 19. Testing Strategy
- **Unit:** vocabulary validation; ordering; DTO shaping.
- **Integration:** team-scoped queries; comment+event atomicity; index usage (EXPLAIN) [P].
- **API:** `BLOCKED — API CONTRACT NOT YET FROZEN`.
- **Authorization:** unauthenticated; same team any role; cross-team user.
- **Concurrency:** parallel comments ordering.
- **Idempotency:** `[N/A]` (double-submit behavior documented).
- **Failure injection:** event insert failure rolls back comment (if P). 
- **Regression:** timeline shows events from every producer slice with correct order.

---

# 20. Test ↔ Requirement Traceability
| Requirement | AC | Test(s) | Status |
|---|---|---|---|
| FR-016 | AC-017 | comment+timeline test | NOT RUN |
| FR-018 | — | ordering/producer-coverage test | NOT RUN |
| BR-004 | AC-008 | cross-team matrix | NOT RUN |
| RD-032 | — | append-only test | NOT RUN |
| NFR-006 | AC-041 | read load test | NOT RUN |
### Coverage Gaps
- No AC for append-only enforcement, timeline ordering, pagination.

---

# 21. Implementation Plan
## 21.1 Sequence
1. UDR-05 vocabulary. 2. `AuditEvent` writer contract (needed by 04/05 — build early). 3. Comment write. 4. Incident detail/list/timeline reads. 5. Indexes + latency check.
## 21.2 Files
### CREATE
```text
src/incident/audit/** · src/incident/comments/** · src/incident/queries/** · test/incident/visibility/**
```
### MODIFY
```text
prisma/schema.prisma (Comment, AuditEvent)
```
### REVIEW ONLY — PRD §9, §11, UC-002.
## 21.3 Allowed — Incident module read/comment/audit code. ## 21.4 Forbidden — mutating incident state; letting other modules write audit rows directly. ## 21.5 Must exist — 01; `Incident` model.

---

# 22. AI Agent Context
## 22.1 Read First
1. `AGENTS.md` 2. This slice 3. `PROJECT_STATE.md` 4. `TEST_STATUS.md` 5. `SESSION_CHECKPOINT.md` 6. PRD §9, §11, UC-002 7. DBS `Comment`, `AuditEvent`
## 22.2 Relevant Canonical Context
| Topic | Source | Location |
|---|---|---|
| Requirement | PRD | FR-016, FR-018, BR-004, UC-002 |
| Domain | DM | Comment/AuditLog rows |
| Architecture | ARCH | Incident module |
| Database | DBS | `Comment`, `AuditEvent` |
| API | — | not frozen |
## 22.3 Agent Objective
Implement the audit-append contract, comments, and team-scoped read models; do not invent event types, pagination formats, or response shapes (UDR-05).

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
- Append-only audit vs event sourcing (RD-032).
- Why audit writes must join the producer's transaction.
- Team-scoped queries and index design for tenant-filtered reads.
## 23.2 SHOULD UNDERSTAND
- Cursor vs offset pagination (for the later API decision).
## 23.3 CAN DEFER — full-text search.
## 23.4 Mental Model
The timeline is the diary every slice writes into at the same moment it changes the world; this slice only owns the diary's format and who may read it.
## 23.5 First-Principles Questions
1. Why not log audit events after commit? 2. What breaks if audit rows can be edited? 3. Why are comments not state? 4. Why must reads filter by team in SQL? 5. Why not event-source the incident?
## 23.6 Interview Questions
### Design
1. Design an append-only audit trail with tenant isolation.
### Debugging
1. A timeline is out of order — causes?
### Failure Handling
1. Audit insert fails during a state change — outcome?
### Architecture
1. Why does the audit store sit in the Incident module rather than each module?

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
- [ ] No code path updates/deletes `AuditEvent`
- [ ] Team-scoped list/detail/timeline reads covered by cross-team tests
- [ ] Event vocabulary reconciled (UDR-05)

---

# 25. Current Implementation Status

**Status:** `PLANNED` — DESIGN / PRE-IMPLEMENTATION (no implementation claimed)

### Completed
- None.

### In Progress
- None.

### Remaining
- Entire slice (audit contract needed early by 04/05; blocked on UDR-05)

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
Filtering/search; real-time timeline (PRD §16).
## Extension Points
Event-type registry; timeline projection.
## Known Limitations
No DB-level append-only guard in DBS; no pagination spec.
## Deliberately Not Generalized
No event sourcing (RD-032).
## Potential Breaking Changes
Renaming event types; changing metadata shapes consumed by 11/12.

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
- [ ] Every producer slice's events appear on the timeline in order (cross-slice test).

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
