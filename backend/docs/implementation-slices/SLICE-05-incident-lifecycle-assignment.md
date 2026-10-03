# SLICE-05 — `Incident Lifecycle & Assignment`

> **Authority:** Canonical documents remain authoritative; this is a derived implementation view.
> **Evidence tags:** `[C]` CANONICAL · `[D]` DERIVED · `[P]` PROPOSED · `[UDR-nn]` USER DECISION REQUIRED (see `00-INDEX`) · `[UNK]` UNKNOWN · `[N/A]` NOT APPLICABLE.
> **Sources:** `PRD` (Revised Draft, 19 Sep 2026) · `ARCH` (unversioned) · `DM` (unversioned) · `DBS` (unversioned, "proposed MVP Schema").

## 0. Slice Metadata

| Field | Value |
|---|---|
| Slice ID | `SLICE-05` |
| Capability | Incident Lifecycle (acknowledge, confirm severity, resolve) & Assignment (assign, reassign, unassign) |
| Version | `0.1` (DRAFT) |
| Status | `PLANNED` (DESIGN / PRE-IMPLEMENTATION) |
| MVP | `YES` |
| Created / Last Updated | `2026-10-01` / `2026-10-01` |
| Primary Owner / Module | `Incident` (ARCH: "Incident lifecycle, severity, assignment, acknowledgement, resolution, comments, audit") |

### Canonical Sources
- `PRD.md` — FR-010–015, FR-017; BR-005–009, BR-015, BR-023, BR-026–030, BR-040, BR-042–046; RD-014–016, 021, 031; §8; §11; UC-003, 004, 005, 008; AC-009–016, AC-034; NFR-005, NFR-007
- `Domain_Model.md` — Incident rows; "Every Incident has at most one current assignee"; "acknowledged_by and current_assignee may refer to different users"; "Every successful Incident transition has an atomic AuditLog event"
- `Architecture.md` — ADR-009, ADR-010, ADR-014; Incident flow; DB Connection Strategy
- `DB_Schema.md` — `Incident`, `AuditEvent`, `OutboxEvent`
- `API_Contracts.md` — NOT AVAILABLE · `DESIGN_CHECKS.md` — NOT PROVIDED

### Related Slices
- `SLICE-04` creates the incident (`∅→OPEN`); `SLICE-11` owns `RESOLVED→CLOSED` [P, UDR-15]; `SLICE-06` audit/timeline contract; `SLICE-07` escalation (assignment interplay, UDR-02); `SLICE-08` outbox; `SLICE-09` notifications; `SLICE-10` AI severity suggestion (advisory)

---

# 1. Capability Overview

## 1.1 Problem
Several people can act on one incident at once; state must stay valid, ownership clear, and every change recorded and handed off reliably. [C: PRD Goals 6–7, 12]

## 1.2 Purpose
Own the incident state machine (`OPEN→ACKNOWLEDGED→MITIGATING→RESOLVED`), the acknowledgement/assignment model, and the concurrency-safe transition mechanism (lock + validate + audit + outbox in one transaction). [C: ADR-010]

## 1.3 Behavior
Authorized users acknowledge, confirm/update severity, and resolve; Team Leads/Admins assign, reassign, unassign. Concurrent attempts yield one winner and a conflict for the loser.

## 1.4 End-to-End Summary
```text
Authenticated request {incidentId, user, action}
   ↓
Authorize (role + team)
   ↓
BEGIN; lock incident row; validate state/preconditions
   ↓
Apply change (status / severity / ack fields / assignee)
   ↓
Insert AuditEvent + OutboxEvent (same tx)
   ↓
COMMIT → response → (async) notifications / postmortem job
```

---

# 2. Scope

## 2.1 In Scope
Transitions `OPEN→ACKNOWLEDGED`, `ACKNOWLEDGED→MITIGATING` (severity confirm/update), `MITIGATING→RESOLVED`; assign/reassign/unassign; rejection of illegal transitions; the shared "locked transition" mechanism used by this slice. [C]

## 2.2 Out of Scope
Creation (04); `RESOLVED→CLOSED` and postmortem (11) [P]; comments/timeline reads (06); SLA/escalation execution (07); AI suggestion generation (10); notification delivery (09).

## 2.3 MVP Scope
Single current assignee; no reopening [C: BR-008, BR-015, AC-014].

## 2.4 Future Scope
Collaborative handling; on-call rotation; reopening [C: PRD §16 / not in MVP].

---

# 3. Requirement Traceability

| ID | Type | Source | Version | Requirement | Class |
|---|---|---|---|---|---|
| FR-011 | Functional | PRD §6 | PRD-RD | "A Engineer acknowledges a incident post notification. A Team Lead can assign an incident to a configured responder, in case no engineer acknowledges it within SLA window. The escalation worker can notify the next configured responder according to the escalation policy." | C (text garbled in source, SD-14) |
| FR-012 | Functional | PRD §6 | PRD-RD | "A Team Lead can reassign an incident. Engineers cannot assign or reassign incidents." | C |
| FR-013 | Functional | PRD §6 | PRD-RD | "A Team Lead can remove the current assignee from an incident." | C |
| FR-014 | Functional | PRD §6 | PRD-RD | "An authorized Engineer or Team Lead can acknowledge an OPEN incident. The first successful acknowledgement is recorded with the authenticated user. The person acknowledging may differ from the current assignee." | C |
| FR-015 | Functional | PRD §6 | PRD-RD | "An authorized Engineer or Team Lead can confirm or update severity after reviewing the incident. A Team Lead can manually select severity when AI triage is unavailable." | C |
| FR-017 | Functional | PRD §6 | PRD-RD | "An authorized assigned responder can resolve an incident by providing a resolution summary and confirming that the affected service is working again." | C |
| FR-010 | Functional | PRD §6 | PRD-RD | Incident record fields (creation in 04; maintenance here) | C |
| BR-005–009, 015, 023, 026, 040, 042–046 | Business | PRD §7 | PRD-RD | full text in §4 | C |
| RD-014 | Decision | PRD §17 | PRD-RD | "The acknowledgement actor may differ from the current assignee." — "Assignment and acknowledgement are stored separately." | C |
| RD-015 | Decision | PRD §17 | PRD-RD | "Team Leads and Admins can assign/reassign/unassign incidents; Engineers cannot." | C |
| RD-016 | Decision | PRD §17 | PRD-RD | "Multiple engineers cannot collaboratively work on one incident in the MVP." | C |
| RD-031 | Decision | PRD §17 | PRD-RD | "The terminal incident state is CLOSED." — "Closed incidents cannot be reopened in the MVP." | C |
| §8 Allowed Transitions | State machine | PRD §8 | PRD-RD | OPEN→ACKNOWLEDGED (Engineer/Team Lead; "Incident is OPEN; user is authorized"); ACKNOWLEDGED→MITIGATING ("severity is confirmed or updated"); MITIGATING→RESOLVED (Assigned Engineer; "Resolution summary provided; service confirmed working"); RESOLVED→CLOSED (11). Disallowed: CLOSED→*, RESOLVED→MITIGATING, OPEN→MITIGATING, ACKNOWLEDGED→RESOLVED | C |
| AC-009 | Acceptance | PRD §20 | PRD-RD | "An Engineer cannot assign, reassign, or unassign an incident." | C |
| AC-010 | Acceptance | PRD §20 | PRD-RD | "A Team Lead can assign, reassign, or unassign an incident belonging to the Team Lead's team." | C |
| AC-011 | Acceptance | PRD §20 | PRD-RD | "Two concurrent acknowledgement attempts on the same OPEN incident result in one successful acknowledgement and one safely rejected/conflicting attempt, and the acknowledgement actor is recorded separately from the assignee." | C |
| AC-012 | Acceptance | PRD §20 | PRD-RD | "A successful incident state change and its corresponding audit/timeline event are committed atomically." | C |
| AC-013 | Acceptance | PRD §20 | PRD-RD | "An incident cannot transition directly from OPEN to MITIGATING." | C |
| AC-014 | Acceptance | PRD §20 | PRD-RD | "An incident cannot transition from RESOLVED back to MITIGATING in the MVP." | C |
| AC-016 | Acceptance | PRD §20 | PRD-RD | "A failed transaction rolls back the incident state change and does not leave a partially committed lifecycle transition." | C |
| AC-034 | Acceptance | PRD §20 | PRD-RD | "A CLOSED incident is terminal and cannot undergo further lifecycle transitions." | C |
| NFR-005 / NFR-007 | NFR | PRD §13 | PRD-RD | "p95 latency below 500ms for authenticated incident state-transition API requests under a synthetic workload of 200 requests/sec, excluding external provider calls." · "Lifecycle state changes and their successful audit events must be committed atomically." | C |
| ADR-010 | Decision | ARCH | unv. | "DB-enforced concurrency using locking and transactions. A successful incident state transition, its audit event, and its required outbox event are committed atomically." | C |
| DM-Incident | Domain | DM | unv. | invariants quoted above | C |

---

# 4. Business Rules

## BR-009 — Every lifecycle transition produces an audit/timeline event
- **Canonical Rule:** "Every successful lifecycle transition produces an audit/timeline event." (Enforcement: "Same transaction as state change"; failure: "Transition cannot commit without its audit event")
- **Interpretation:** audit insert and state update share one transaction. **Consequence:** no code path updates `Incident.status` outside the locked-transition function [D]. **Invalid:** state change without event; event without state change. **Related:** NFR-007, AC-012, ADR-010. **Class:** C.

## BR-044 — Who may acknowledge
- **Canonical Rule:** "Any authorized Engineer or Team Lead may acknowledge an OPEN incident." (failure: "403/409")
- **Note:** authorization matrix also lists Admin "Yes" for Acknowledge; transition table lists "Engineer / Team Lead" (SD-12) [UDR-17]. **Class:** C/UDR.

## BR-045 — First acknowledgement wins
- **Canonical Rule:** "The first successful acknowledgement wins when multiple authorized users attempt acknowledgement concurrently." (Enforcement: "Transaction and concurrency control"; failure: "Losing request receives a conflict response")
- **Consequence:** row lock (or equivalent) then state re-check inside the transaction; loser → conflict (409 per BR-014's convention; exact code in API contract). **Invalid:** two successful acks; overwritten `acknowledgedBy`. **Class:** C.

## BR-007 / BR-046 / RD-021 — Ack actor separate from assignee
- **Canonical Rules:** BR-007 "The person who acknowledges an incident may differ from the current assignee." · BR-046 "The user who acknowledges is recorded separately from the current assignee."
- **Consequence:** `acknowledgedBy` and `currentAssignee` are independent columns; ack does **not** imply assignment [D]. BR-040 wording ("…or engineer who acknowledged the incident") is ambiguous on whether ack ever sets the assignee [UDR-02]. **Class:** C/UDR.

## BR-040 / BR-042 / BR-043 / BR-006 — Assignment authority
- **Canonical Rules:** BR-040 "The current assignee is the responder selected by a Team Lead or engineer who acknowledged the incident." · BR-042 "An Engineer cannot assign or reassign an incident." · BR-043 "A Team Lead can assign, reassign, or unassign an incident." · BR-006 "Only a Team Lead or Admin can assign, reassign, or unassign an incident."
- **Consequence:** role guard on every assignment operation (403 otherwise); assignee must be a valid responder — definition of "configured responder"/eligibility [UDR-02]. **Class:** C.

## BR-008 — Single collaborator
- **Canonical Rule:** "Multiple engineers cannot collaboratively work on the same incident in the MVP." (Enforcement: "Single current assignee")
- **Consequence:** `currentAssignee` is a single nullable FK. **Class:** C.

## BR-005 — Only authorized users change state/assignment/severity/postmortem
- **Canonical Rule:** "Only authorized users can change incident status, assignment, severity, or postmortem content." (failure: 403) — guard from `SLICE-01`. **Class:** C.

## BR-015 — CLOSED is terminal
- **Canonical Rule:** "A CLOSED incident is terminal in the MVP." (failure: "Further lifecycle changes are rejected")
- **Consequence:** every transition/assignment/severity function rejects `CLOSED`; whether *assignment* counts as a "lifecycle change" [UNK]. **Class:** C.

## BR-023 / BR-026 — Severity
- **Canonical Rules:** BR-023 "AI suggested severity does not automatically replace the current incident severity." · BR-026 "The MVP uses four severity levels: P0, P1, P2, and P3."
- **Consequence:** only a human action changes `Incident.severity`; value validated against enum. **Class:** C.

## Transition rules (PRD §8)
OPEN→ACKNOWLEDGED; ACKNOWLEDGED→MITIGATING requires "severity is confirmed or updated"; MITIGATING→RESOLVED requires "Resolution summary provided; service confirmed working". Disallowed: OPEN→MITIGATING, ACKNOWLEDGED→RESOLVED, RESOLVED→MITIGATING, CLOSED→*. **Class:** C.

---

# 5. Functional Behavior

**5.1 Acknowledge** — Trigger: user acts. Input: incidentId, authenticated user. Preconditions: incident in caller's team; role allowed (UDR-17); `status=OPEN`. Processing: tx → lock row → verify OPEN → set `acknowledgedBy`, `acknowledgedTimestamp`, `status=ACKNOWLEDGED` → audit `ACKNOWLEDGED` + outbox (notification) → commit. State: `OPEN→ACKNOWLEDGED`. Output: updated incident. Failure: not OPEN/lost race → conflict; unauthorized → 403/404 (UDR-20). Does ack set `currentAssignee` if null? [UDR-02].

**5.2 Confirm/update severity (→ MITIGATING)** — Input: incidentId, severity (P0–P3). Preconditions: `status=ACKNOWLEDGED` (UC-004). Processing: lock → validate enum → set `severity`, `severityConfirmedBy`, `severityConfirmTimestamp`, `status=MITIGATING` → audit (`SEVERITY_CONFIRMED` per DBS vs `SEVERITY_CHANGED` per PRD, UDR-05) + outbox → commit. State: `ACKNOWLEDGED→MITIGATING`. Open: later severity updates while `MITIGATING` (FR-015 "update") have no canonical transition rule [UDR-17]; DBS stores one confirmer/timestamp only. SLA re-evaluation: `SLICE-07` reads current severity at each evaluation [D from RD-011]; push/reschedule need [UDR-13]. AI-unavailable path = same operation by Team Lead [C UC-004, FR-015].

**5.3 Resolve** — Input: incidentId, resolution summary, confirmation flag ("service working again"). Preconditions: `status=MITIGATING`; caller is the assigned responder [C FR-017/UC-008; Admin/Team Lead non-assignee: UDR-17]. Processing: lock → verify state & assignee → set `resolutionSummary`, `resolvedBy`, `resolvedTimestamp`, `status=RESOLVED` → audit `RESOLVED` + outbox (notification; **postmortem job** [C §8 side effects]) → commit. State: `MITIGATING→RESOLVED`. Failure: missing summary/confirmation, wrong state → reject, no change (UC-008). The confirmation flag has no DB column [D: validated input only; storage UNK].

**5.4 Assign / reassign** — Actor: TEAM_LEAD/ADMIN. Input: incidentId, responderId. Preconditions: same team; responder valid/eligible (UDR-02); incident not `CLOSED` [D]. Processing: lock → set `currentAssignee` → audit `ASSIGNED` (reassign vs assign distinguished in metadata [UDR-05]) + outbox notification → commit. State: lifecycle unchanged. 

**5.5 Unassign** — Actor: TEAM_LEAD/ADMIN. Set `currentAssignee=NULL`; audit event type for unassign does not exist in DBS [UDR-05]. Interaction with resolve: unassigned incident has no "assigned responder" [D].

**5.6 Reject illegal transitions** — any request violating §8 table → conflict without state change [C AC-013/014/034].

**5.7 Initial/automatic assignment** — Architecture: "enqueues a worker for assignment"; PRD Assignment Rules example shows "assigned to EngineerA" before ack; BR-040 mentions engineer who acknowledged. Who sets `currentAssignee` initially/automatically is **undefined** [UDR-02].

---

# 6. Acceptance Criteria

Canonical text for each AC is in §3. Given/When/Then and verification:

- **AC-011** — *Given* OPEN incident, users U1/U2 · *When* concurrent acknowledge · *Then* exactly one success, one conflict; `acknowledgedBy` = winner; `currentAssignee` untouched. *Verify:* parallel integration test (e.g., 20 callers), assert one audit `ACKNOWLEDGED`.
- **AC-012 / BR-009** — *Given* any transition · *When* it commits · *Then* audit row exists, same tx. *Verify:* failure-injection (audit insert fails ⇒ no status change).
- **AC-013** — OPEN→MITIGATING rejected. **AC-014** — RESOLVED→MITIGATING rejected. **AC-034** — any change on CLOSED rejected. *Verify:* table-driven state-machine unit + integration tests over all (state × action) pairs.
- **AC-016** — *Given* DB failure mid-transition · *Then* no partial change. *Verify:* inject failure after status update before commit.
- **AC-009 / AC-010** — Engineer assign ⇒ 403; Team Lead of same team assign/reassign/unassign ⇒ success; other team's lead ⇒ 403/404.
- **AC-015** (closure) → `SLICE-11`. **AC-029/030** (resolve independent of AI) → verified here for the resolve path: resolving succeeds with AI/postmortem unavailable (BR-013).
- **NFR-005/AC-040** — latency test excluded here until implementation exists [N/A now].

---

# 7. Domain Model

## 7.1 Entities
| Entity | Role |
|---|---|
| Incident | State, severity, assignee, ack/resolve actors & timestamps |
| User | actors, assignee candidates |
| AuditEvent / OutboxEvent | written atomically per change |

## 7.2 Relationships
Incident→current_assignee 0..1; →acknowledged_by 0..1; →resolved_by 0..1 [C DM]. DBS adds `severityConfirmedBy`, `closedBy` (not in PRD §9).

## 7.3 Invariants
| Invariant | Enforcement |
|---|---|
| status ∈ {OPEN, ACKNOWLEDGED, MITIGATING, RESOLVED, CLOSED} | DB CHECK |
| severity ∈ P0–P3 | DB CHECK |
| ≤1 current assignee | DB (single column) |
| Valid transition graph | **Application** under lock (DB has no transition constraint) — ADR-010 says "prevented at application + DB layers"; the DB layer = lock/transaction, not a trigger [D] |
| ack ≠ assignee coupling | none (independent columns) |
| Transition ⇒ audit event | **Transaction-enforced** |
| Assignee belongs to incident's team / is ACTIVE | **Unclear** (no constraint) |

## 7.4 State Machine
```text
OPEN → ACKNOWLEDGED → MITIGATING → RESOLVED → CLOSED
```
### Owned Transitions
`OPEN→ACKNOWLEDGED`, `ACKNOWLEDGED→MITIGATING`, `MITIGATING→RESOLVED`; assignment changes (non-state).
### Transitions Owned Elsewhere
`∅→OPEN` — `SLICE-04`; `RESOLVED→CLOSED` — `SLICE-11` [P, UDR-15].

---

# 8. Architectural Context
## 8.1 Relevant Architecture
ARCH Incident flow: create → AI triage → "enqueues a worker for assignment" → "acknowledged by associated team member, severity confirmation, resolution and finally calls for postmortem draft generation. All state transition commit async notification to required stakeholders."
## 8.2 Components
| Component | Responsibility |
|---|---|
| Controller | one operation per action |
| Incident service | authorize, run locked transition |
| Transition kernel | lock → validate → apply → audit → outbox [P name] |
| Repository | `Incident`; raw SQL for locking where needed [C ARCH: Prisma + raw SQL] |
## 8.3 Constraints
Row-level locking in PostgreSQL transaction [C ADR-003/010]; transaction-pooler compatible (no session locks) [C ARCH DB strategy]; keep lock hold-time short (ADR-010 trade-off, NFR-005); no external calls inside the tx [C ARCH failure boundary].
## 8.4 ADRs
- **ADR-010** — core. Exact mechanism (`SELECT … FOR UPDATE` vs conditional `UPDATE … WHERE status=…`) is [P]; docs say "locking and transactions".
- **ADR-009** — outbox in same tx. **ADR-014** — consumers idempotent.

---

# 9. Dependency Model
## 9.1 Upstream
| Slice | Type | Requires |
|---|---|---|
| 01 | SYNC | context + role/team guards |
| 04 | DATA | incident exists as OPEN |
| 06 | IN-TX | audit append contract |
| 08 | IN-TX/SCHEMA | outbox insert contract |
| 02 | READ | responder eligibility (UDR-02) |
## 9.2 Downstream
| Slice | Relationship | Provides |
|---|---|---|
| 09 | EVENT | notification triggers per transition/assignment |
| 11 | EVENT | postmortem job trigger on RESOLVED |
| 07 | READ/EVENT | status/severity/ack state for SLA & escalation |
| 06 | DATA | audit events |
## 9.3 Contract
**Allowed:** the transition kernel is the only writer of `status`, `acknowledged*`, `resolved*`, `currentAssignee`, `severity`. **Forbidden:** other slices updating these columns directly (07 included unless UDR-02 says otherwise; 11 uses the kernel for `CLOSED`).

---

# 10. Slice Coupling Analysis
## 10.1 Transactional — **YES (hard)** with audit (06) and outbox (08) per transition [C ADR-010] — kept via narrow in-transaction contracts, not by merging slices.
## 10.2 Synchronous — **YES** with 01 (authz).
## 10.3 Shared Invariants — **YES**: "only the assigned responder resolves" couples lifecycle and assignment → merged in one slice; "Close requires reviewed postmortem" couples with 11 → [UDR-15].
## 10.4 Summary
| Related Slice | Coupling | Strength | Boundary Decision |
|---|---|---|---|
| Lifecycle ↔ Assignment (inside) | row lock + resolve precondition | Hard | KEEP TOGETHER |
| 06 audit | in-tx contract | Medium | SEPARATE |
| 08 outbox | in-tx contract | Medium | SEPARATE |
| 11 | CLOSED transition + postmortem state | Hard | NEEDS USER DECISION (proposed: 11 owns `RESOLVED→CLOSED`) |
| 07 | assignee writes / ack race | Hard if escalation assigns | NEEDS USER DECISION (UDR-02) |
| 10 | advisory suggestion | Loose | SEPARATE |
### Boundary Decision
Lifecycle and assignment share the Incident row lock and the resolve-by-assignee invariant; splitting them would make ownership of `currentAssignee`-dependent transitions ambiguous.

---

# 11. Data Model
## 11.1 Tables — `Incident` (modify), `AuditEvent`, `OutboxEvent` (insert).
## 11.2 Relevant Fields
| Field | Purpose | Required? |
|---|---|---|
| `status`, `severity` | state, severity | Yes |
| `currentAssignee` | assignee | No |
| `acknowledgedBy`, `acknowledgedTimestamp` | ack actor/time | No |
| `severityConfirmedBy`, `severityConfirmTimestamp` | severity confirmation (DBS addition) | No |
| `resolvedBy`, `resolvedTimestamp`, `resolutionSummary` | resolution | No |
| `closedBy`, `closedTimestamp` | closure (11) | No |
| `updatedAt` | maintained by app/ORM [UNK trigger] | Yes |
## 11.3 Constraints — CHECK(status), CHECK(severity); FKs to `User`; composite FK to service/team; indexes `idx_incident_status(status, currentAssignee)`, `idx_incident_severity(severity, affectedServiceId)`.
## 11.4 DB Invariants — valid status/severity values only. **No** constraint ensures e.g. `acknowledgedBy IS NOT NULL` when status ≥ ACKNOWLEDGED [D].
## 11.5 Migration Requirements — consider CHECKs tying status to required fields [P]; version/optimistic column not present [D].

---

# 12. Transaction & Consistency Model
## 12.1 Boundary
```text
BEGIN
  lock Incident row (row-level lock) / re-read status
  validate transition + actor preconditions
  UPDATE Incident (status/severity/ack|resolve fields | currentAssignee)
  INSERT AuditEvent
  INSERT OutboxEvent (notification; postmortem job on RESOLVED)
COMMIT
```
[C ADR-010: state + audit + required outbox atomic; D: lock form]
## 12.2 Atomic — all four steps above.
## 12.3 Isolation/Locking — row-level lock [D]; isolation level [UNK]; alternatives [P].
## 12.4 Guarantees — no state change without audit/outbox (NFR-001/007); valid graph; single winner for concurrent same-source-state transitions.
## 12.5 Failure — rollback; caller sees failure; no partial state (AC-016).

---

# 13. Idempotency & Concurrency
## 13.1 Idempotency — transitions are state-guarded, not key-guarded: a repeated request fails the precondition (conflict) rather than no-op [D]; request-level idempotency keys not specified [UNK]. Outbox consumers must be idempotent (ADR-014).
## 13.2 Concurrency
| Race | Protection | Expected | Required test |
|---|---|---|---|
| ack ∥ ack | lock + state check | 1 success, 1 conflict (BR-045) | parallel ack |
| ack ∥ assign | lock; independent columns | both succeed in some order | parallel test |
| resolve ∥ reassign | lock | resolve checks assignee under lock | parallel test |
| severity ∥ severity | lock | serialized; last-valid wins [UNK semantics] | parallel test |
| ack ∥ escalation (07) | lock + state re-check | escalation sees incident no longer OPEN [C UC-006 "verify incident still requires acknowledgement"] | cross-slice race test |
| close ∥ edit (11) | lock | one wins | cross-slice test |

---

# 14. API Surface — Preliminary
`PRELIMINARY — API CONTRACT NOT YET FROZEN`

| Candidate operation | Actor / Authz | Input | Transition | Output | Failures | Idempotency / concurrency | Confidence · Missing |
|---|---|---|---|---|---|---|---|
| Acknowledge incident | ENGINEER/TEAM_LEAD (+ADMIN? UDR-17), same team | incidentId | OPEN→ACKNOWLEDGED | incident | 401/403(404)/409/404 | first wins | High · status codes, Admin |
| Confirm/update severity | same | incidentId, severity | ACKNOWLEDGED→MITIGATING | incident | 400/403/409 | locked | High · re-update in MITIGATING (UDR-17) |
| Resolve incident | assigned responder | incidentId, resolutionSummary, confirmation | MITIGATING→RESOLVED | incident | 400/403/409 | locked; triggers postmortem job async | High · who may resolve |
| Assign / reassign | TEAM_LEAD/ADMIN [C] | incidentId, responderId | assignee change | incident | 400/403/404/409 | locked | High · eligibility (UDR-02) |
| Unassign | TEAM_LEAD/ADMIN [C] | incidentId | assignee=NULL | incident | 403/404/409 | locked | High |
Whether these are separate endpoints or one "transition" endpoint: [UNK]. Concurrency semantics for clients (ETag/version vs server lock): [UNK]. Pagination `[N/A]`. Timing: sync; side effects async; NFR-005 p95 < 500 ms.

---

# 15. Events, Queues & Side Effects
## 15.1 Events Produced
| Event | Producer | Payload | Consumer |
|---|---|---|---|
| Audit: `ACKNOWLEDGED`, severity event, `RESOLVED`, `ASSIGNED` | transition kernel | metadata [UNK] | 06 |
| Outbox: notification events per transition/assignment [C §8 "Side Effects"; catalog UDR-14] | kernel | incidentId, actor, type | 09 via 08 |
| Outbox: postmortem generation job (on RESOLVED) [C §8, ADR-010] | resolve tx | incidentId | 11 via 08 |
## 15.2 Consumed — none.
## 15.3 Queue Jobs — enqueued by relay (08), not here.
## 15.4 Delivery — at-least-once; consumers idempotent [C ADR-009/014].
## 15.5 External Side Effects — none inline.

---

# 16. Security & Authorization
## 16.1 Authentication — required [C].
## 16.2 Authorization (PRD §11)
| Actor | Allowed |
|---|---|
| ENGINEER | acknowledge, confirm severity, resolve (assigned), comment; **not** assign/reassign/unassign |
| TEAM_LEAD | all of Engineer + assign/reassign/unassign |
| ADMIN | matrix says Yes to ack/sev/resolve/assign; transition table omits Admin — [UDR-17] |
## 16.3 Team Isolation — all operations restricted to caller's team [C BR-004]; cross-team result 403 vs 404 [UDR-20].
## 16.4 Input Security — severity enum, summary non-empty/length [P], UUID validation.
## 16.5 Sensitive Data — no secrets; resolution summary may contain sensitive text (not logged at INFO [P]).

---

# 17. Failure Modes
| Failure | Detection | Expected | State Impact | Retry? | Evidence |
|---|---|---|---|---|---|
| Lost ack race | state check under lock | conflict | none | no | BR-045 |
| Illegal transition | state check | conflict | none | no | AC-013/014/034 |
| Unauthorized | guard | 403/404 | none | no | BR-005, AC-008 |
| Invalid severity/summary | validation | 400 | none | fix input | BR-026 |
| Audit/outbox insert fails | tx error | rollback; failure | none | client retry | AC-012/016 |
| DB down | exception | 5xx | none | yes | PRD §14 |
| Assignee deactivated/other team | **not detected** [UNK] | — | — | — | UDR-02 |
## Critical Failure Scenario
**What fails:** crash between status update and audit insert. **Must remain true:** both or neither. **Recovery:** transaction rollback.

---

# 18. Observability
- Logs: every transition attempt with outcome, actor, incident, correlation ID [C FR-034]; conflicts logged at INFO.
- Metrics: transition latency (p95 target NFR-005), conflicts, rollbacks, lock wait time [P].
- Audit events:
| Event | When | Transactional? |
|---|---|---|
| `ACKNOWLEDGED` | ack | Yes [C] |
| `SEVERITY_CONFIRMED` (DBS) / `SEVERITY_CHANGED` (PRD) | severity set | Yes [C]; name UDR-05 |
| `RESOLVED` | resolve | Yes [C] |
| `ASSIGNED` | assign/reassign (unassign: UDR-05) | Yes [D] |

---

# 19. Testing Strategy
- **Unit:** state-machine table (all 5×N pairs); role matrix; severity validation; resolve preconditions.
- **Integration:** transaction atomicity; audit+outbox written with change; composite FK unaffected.
- **API:** `BLOCKED — API CONTRACT NOT YET FROZEN`.
- **Authorization:** unauthenticated; same-team engineer assign ⇒ 403; cross-team lead ⇒ 403/404; non-assignee resolve (per UDR-17).
- **Concurrency:** ack∥ack; resolve∥reassign; ack∥escalation worker; N≥20 callers.
- **Idempotency:** repeat ack ⇒ conflict, no duplicate audit/outbox.
- **Failure injection:** fail audit insert; fail outbox insert; kill after update before commit.
- **Regression:** any change to kernel re-runs all transition/concurrency tests; resolve with AI/postmortem down (BR-013).

---

# 20. Test ↔ Requirement Traceability
| Requirement | AC | Test(s) | Status |
|---|---|---|---|
| BR-045, FR-014 | AC-011 | parallel ack test | NOT RUN |
| BR-009, NFR-007 | AC-012 | audit-atomicity failure test | NOT RUN |
| §8 table | AC-013, AC-014, AC-034 | state-machine tests | NOT RUN |
| ADR-010 | AC-016 | rollback test | NOT RUN |
| BR-006/042/043 | AC-009, AC-010 | role tests | NOT RUN |
| FR-017 | (UC-008) | resolve tests | NOT RUN |
| BR-013 | AC-029 | resolve-with-AI-down test | NOT RUN |
### Coverage Gaps
- No AC for severity re-update in MITIGATING, assignee eligibility, or unassign-then-resolve.

---

# 21. Implementation Plan
## 21.1 Sequence
1. Decide UDR-02, 05, 17. 2. Transition kernel + unit tests (pure state machine first). 3. Ack. 4. Severity confirm. 5. Resolve. 6. Assign/reassign/unassign. 7. Concurrency + failure-injection suites.
## 21.2 Files
### CREATE
```text
src/incident/lifecycle/** · src/incident/assignment/** · test/incident/**
```
### MODIFY
```text
prisma/schema.prisma (Incident) · audit/outbox writer usage
```
### REVIEW ONLY
```text
ARCH ADR-009/010 · PRD §8 · DBS Incident
```
## 21.3 Allowed — Incident module.
## 21.4 Forbidden — Alerts module logic; AI calls; direct `status` updates outside the kernel; schema changes beyond approved UDRs.
## 21.5 Must exist — 01, 04 (incident rows), 06 audit writer, 08 outbox table.

---

# 22. AI Agent Context
## 22.1 Read First
1. `AGENTS.md` 2. This slice 3. `PROJECT_STATE.md` 4. `TEST_STATUS.md` 5. `SESSION_CHECKPOINT.md` 6. PRD §8, §11, UC-003/004/005/008 7. ARCH ADR-010 8. DBS `Incident`
## 22.2 Relevant Canonical Context
| Topic | Source | Location |
|---|---|---|
| Requirement | PRD | FR-011–017, BR-005–009/040–046, §8 |
| Domain | DM | Incident invariants |
| Architecture | ARCH | ADR-009, ADR-010 |
| Database | DBS | `Incident`, `AuditEvent`, `OutboxEvent` |
| API | — | not frozen |
## 22.3 Agent Objective
Implement the incident transition kernel and the five operations (ack, severity, resolve, assign family) with lock-based concurrency safety and atomic audit+outbox; stop at UDR-02/05/17.

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
- Why a state machine in `if` statements is not concurrency-safe (read-then-write race) — ADR-010.
- Row lock vs optimistic check vs conditional update; lock scope and hold time.
- Ack ≠ assignment; why separate columns.
- Atomic state + audit + outbox.
## 23.2 SHOULD UNDERSTAND
- Pooler implications for transactions/locking.
- 409 semantics for "lost race".
## 23.3 CAN DEFER
- Lock-timeout tuning.
## 23.4 Mental Model
One incident = one row = one door with a single key at a time. Whoever holds the key reads the state, moves it at most one legal step, writes the diary entry and the "tell others" slip, then hands the key back.
## 23.5 First-Principles Questions
1. Why lock instead of check-then-update? 2. What exactly must be in the same transaction? 3. What breaks if audit is written afterwards? 4. Why allow ack by someone who isn't the assignee? 5. What alternatives exist to row locks?
## 23.6 Interview Questions
### Design
1. Design a concurrency-safe incident state machine on PostgreSQL.
### Debugging
1. An incident shows `ACKNOWLEDGED` with no audit event — how?
### Failure Handling
1. Process dies after UPDATE, before COMMIT?
### Architecture
1. Why is outbox insertion part of the transition transaction?

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
- [ ] Parallel-ack test: exactly one success, one conflict, one audit row
- [ ] Every (state × action) pair tested against §8 table
- [ ] Audit/outbox failure injection leaves state unchanged
- [ ] UDR-02, 05, 17 decided and recorded

---

# 25. Current Implementation Status

**Status:** `PLANNED` — DESIGN / PRE-IMPLEMENTATION (no implementation claimed)

### Completed
- None.

### In Progress
- None.

### Remaining
- Entire slice (blocked on UDR-02, UDR-05, UDR-17)

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
Reopen; collaborative handling; on-call rotation (PRD §16).
## Extension Points
Transition table as data; assignment eligibility strategy.
## Known Limitations
No DB-level transition constraint; assignee integrity unchecked.
## Deliberately Not Generalized
Single assignee; single severity confirmation record.
## Potential Breaking Changes
Changing who owns `RESOLVED→CLOSED`; adding statuses.

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
- [ ] Concurrency suite (ack, resolve/reassign, escalation race) green and repeatable.

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
