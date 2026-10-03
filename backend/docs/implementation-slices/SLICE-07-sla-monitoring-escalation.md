# SLICE-07 — `SLA Monitoring & Escalation`

> **Authority:** Canonical documents remain authoritative; this is a derived implementation view.
> **Evidence tags:** `[C]` CANONICAL · `[D]` DERIVED · `[P]` PROPOSED · `[UDR-nn]` USER DECISION REQUIRED (see `00-INDEX`) · `[UNK]` UNKNOWN · `[N/A]` NOT APPLICABLE.
> **Sources:** `PRD` (Revised Draft, 19 Sep 2026) · `ARCH` (unversioned) · `DM` (unversioned) · `DBS` (unversioned, "proposed MVP Schema").

## 0. Slice Metadata

| Field | Value |
|---|---|
| Slice ID | `SLICE-07` |
| Capability | SLA Monitoring (Response & Resolution), 80% Warning, Breach Escalation |
| Version | `0.1` (DRAFT) |
| Status | `PLANNED` (DESIGN / PRE-IMPLEMENTATION) |
| MVP | `YES` |
| Created / Last Updated | `2026-10-01` / `2026-10-01` |
| Primary Owner / Module | SLA/escalation worker (ARCH async flow); module ownership not stated — closest: `Incident`/`AppService` [UNK] |

### Canonical Sources
- `PRD.md` — FR-019–023; BR-041, BR-047–059; RD-008–013; UC-006, UC-007; AC-018–024, AC-039; OQ-001–003; §5 Team Lead story; Goals 9–10
- `Domain_Model.md` — Escalation_Policy; Incident timestamps
- `Architecture.md` — Async flow (SLA/escalation worker), ADR-014, ADR-015
- `DB_Schema.md` — `AppService` SLA columns, `EscalationPolicy`, `Incident` timestamps, `AuditEvent` (`SLA_WARNING`, `ESCALATED_L1–L4`)
- `API_Contracts.md` — NOT AVAILABLE · `DESIGN_CHECKS.md` — NOT PROVIDED

### Related Slices
- `SLICE-02` config (read) · `SLICE-05` incident state/severity/ack (read; possible assignee writes UDR-02) · `SLICE-06` audit · `SLICE-08` outbox/queue · `SLICE-09` notifications · `SLICE-04` provides `createdAt` clock start

---

# 1. Capability Overview
## 1.1 Problem
Unacknowledged or unresolved incidents must be noticed in time and routed to the next responder. [C: PRD Goals 9–10]
## 1.2 Purpose
Evaluate Response and Resolution SLAs against the *current* severity, emit a warning at 80%, and escalate unacknowledged incidents through the configured chain — safely under duplicate/concurrent worker execution. [C]
## 1.3 Behavior
Worker evaluates; records warning once; on response-SLA breach escalates to the next responder (notify), continuing until acknowledged or final fallback; resolution-SLA breach does not change state (BR-059).
## 1.4 End-to-End Summary
```text
Trigger (scheduling mechanism UNK)
   ↓
Load incident + service SLA + policy; lock/re-check state
   ↓
elapsed = now − incident.createdAt ; threshold = SLA[currentSeverity]
   ↓
≥80% → SLA_WARNING (once)   ·   ≥100% (response, still OPEN) → escalate next level (once per level)
   ↓
Audit + outbox (notify) in one tx   →   schedule next evaluation
```

---

# 2. Scope
## 2.1 In Scope
SLA elapsed-time evaluation; 80% warning; response-breach escalation chain incl. final Team Lead/Admin fallback; resolution-breach event (no state change); idempotent once-only recording; escalation outcomes observable. [C]
## 2.2 Out of Scope
Acknowledge/assign operations (05); notification delivery (09); on-call schedules [C PRD §4]; business-hour pauses [C RD-010].
## 2.3 MVP Scope
Continuous elapsed time; per-service SLA values; fixed chain per DBS (UDR-03).
## 2.4 Future Scope
On-call rotation; richer escalation (PRD §16).

---

# 3. Requirement Traceability
| ID | Type | Source | Version | Requirement | Class |
|---|---|---|---|---|---|
| FR-019 | Functional | PRD §6 | PRD-RD | "The system calculates a response SLA from incident `created_at` until acknowledgement." | C |
| FR-020 | Functional | PRD §6 | PRD-RD | "The system calculates a resolution SLA from incident `created_at` until resolution." | C |
| FR-021 | Functional | PRD §6 | PRD-RD | "A worker evaluates SLA progress and creates a warning when the applicable SLA reaches 80% of its window." | C |
| FR-022 | Functional | PRD §6 | PRD-RD | "If an incident remains unacknowledged when its response SLA expires, the worker escalates it to the next configured responder in the escalation policy." | C |
| FR-023 | Functional | PRD §6 | PRD-RD | "If severity changes, subsequent SLA evaluation uses the SLA associated with the latest severity. The worker evaluates whether the current incident has crossed the applicable warning or breach threshold." | C |
| BR-041, 047–059 | Business | PRD §7 | PRD-RD | full text in §4 | C |
| RD-008 | Decision | PRD §17 | PRD-RD | "The MVP uses two SLAs: Response SLA and Resolution SLA." | C |
| RD-009/010 | Decision | PRD §17 | PRD-RD | "Both SLA clocks start from incident `created_at`." · "SLA clocks use continuous elapsed time in IST in the MVP." — "There are no business-hour pauses in the MVP." | C |
| RD-011/012 | Decision | PRD §17 | PRD-RD | "…use the latest severity's configured SLA threshold." · "SLA warning is evaluated at 80%…" — "The warning is recorded once for the applicable threshold." | C |
| RD-013 | Decision | PRD §17 | PRD-RD | "If an assigned responder does not acknowledge before the response SLA breach, the worker notifies to the next configured responder." | C |
| UC-006 | Use case | PRD §19 | PRD-RD | Preconditions "Incident is not ACKNOWLEDGED, RESOLVED, or CLOSED"; flow "Evaluate current SLA → verify incident still requires acknowledgement → select next responder → notify responder and Team Lead"; final fallback "escalate to the Team Lead/Admin fallback"; duplicate flow "no duplicate notification action"; resulting state "Incident remains OPEN until acknowledged"; side effects "ESCALATED event; assignment event; notification" | C |
| UC-007 | Use case | PRD §19 | PRD-RD | warning flow; "Repeated evaluation does not create duplicate warning actions"; "No lifecycle state change"; side effects "SLA_WARNING event; notification" | C |
| AC-018 | Acceptance | PRD §20 | PRD-RD | "Response SLA elapsed time is calculated from incident `created_at` until acknowledgement." | C |
| AC-019 | Acceptance | PRD §20 | PRD-RD | "Resolution SLA elapsed time is calculated from incident `created_at` until resolution." | C |
| AC-020 | Acceptance | PRD §20 | PRD-RD | "SLA warning is generated when the applicable SLA reaches 80% of its current configured window." | C |
| AC-021 | Acceptance | PRD §20 | PRD-RD | "A severity change causes subsequent SLA evaluation to use the latest severity configuration." | C |
| AC-022 | Acceptance | PRD §20 | PRD-RD | "An unacknowledged incident is escalated to the next configured responder when the response SLA is breached." | C |
| AC-023 | Acceptance | PRD §20 | PRD-RD | "Escalation continues through the configured chain and reaches the Team Lead/Admin fallback after the final responder." | C |
| AC-024 | Acceptance | PRD §20 | PRD-RD | "Repeated escalation-worker execution does not produce duplicate assignment or escalation actions." | C |
| AC-039 | Acceptance | PRD §20 | PRD-RD | "Incident timestamps and SLA calculations follow the MVP's defined IST-based continuous elapsed-time policy." | C |
| ADR-015 | Decision | ARCH | unv. | "Use separate Response and Resolution SLA thresholds. Both SLA clocks start at incident.created_at. The latest incident severity determines the applicable SLA threshold during evaluation; severity changes do not reset the original clock. SLA warning occurs at 80% of the applicable window, and breach triggers the defined escalation behavior." | C |
| OQ-001/002/003 | Open Q | PRD §18 | PRD-RD | SLA durations; identical vs per-service; delay between responders | UNK |

> PRD §7 cites AC-019/AC-020/AC-021 for BR-047/048/052 differently from PRD §20 numbering (SD-01); §20 text is used here.

---

# 4. Business Rules
## BR-047 / BR-048 / BR-049 / BR-050 — SLA clocks
- **Canonical Rules:** BR-047 "Response SLA is measured from incident `created_at` until acknowledgement." · BR-048 "Resolution SLA is measured from incident `created_at` until resolution." · BR-049 "SLA clocks use continuous elapsed time." · BR-050 "SLA calculations use IST timestamps in the MVP." (failure: "Invalid timestamp is rejected")
- **Interpretation:** elapsed = `now − created_at` (no pauses); response clock stops at `acknowledgedTimestamp`, resolution at `resolvedTimestamp`. **Derived note:** with continuous elapsed time the arithmetic is timezone-independent for `timestamptz` instants; "IST" matters for presentation/serialization only [D → UDR-13]. **Class:** C / D.

## BR-051 / BR-053 — Threshold by current severity
- **Canonical Rules:** BR-051 "The applicable SLA threshold is determined by the incident's current severity and the service's configured SLA policy." · BR-053 "When severity changes, SLA evaluation uses the latest severity's configured threshold."
- **Consequence:** read `Incident.severity` and `AppService.P{n}…SlaMinutes` at each evaluation; the clock origin never resets (ADR-015). **Class:** C.

## BR-052 / BR-054 — 80% warning; retroactive crossing
- **Canonical Rules:** BR-052 "The 80% warning threshold is measured from incident `created_at`." (failure: "Warning is not created before the threshold") · BR-054 "If a severity change causes an already elapsed threshold to be crossed, the next SLA evaluation may create the applicable warning or breach event immediately." (failure: "Event is recorded once")
- **Consequence:** a severity downgrade to a shorter SLA can fire warning+breach in one evaluation; each event still once. Which SLA(s) get warnings (response and/or resolution) and the `SLA_WARNING` distinction: [UDR-13]. **Class:** C.

## BR-041 / BR-055 / BR-056 / BR-057 / BR-058 — Escalation
- **Canonical Rules:** BR-041 "The escalation worker notifies the next configured responder when the current incident remains unacknowledged beyond the applicable response SLA." (failure: "Escalation is recorded as failed if no valid responder exists") · BR-055 "Escalation is performed by a worker according to the configured escalation policy." · BR-056 "The next responder in the configured escalation policy is selected when the response SLA is breached without acknowledgement." (failure: "No invalid responder is assigned") · BR-057 "Escalation continues until the incident is acknowledged or the configured final fallback is reached." · BR-058 "If the final configured responder is reached without acknowledgement, the Team Lead/Admin fallback is notified."
- **Consequence:** chain position tracked durably (not in memory); each level once; skip/flag invalid responders; final fallback recorded. **Whether escalation changes `currentAssignee` ("assignment event", "No invalid responder is assigned") or only notifies** [UDR-02]. DBS mapping: `level1/level2` engineers, `level3` Team Lead, `fallbackAdmin` Admin ↔ `ESCALATED_L1–L4` [D]. Delay between levels: [UDR-03/OQ-003]. **Class:** C/UDR.

## BR-059 — Resolution breach does not change state
- **Canonical Rule:** "Resolution SLA breach does not automatically change incident state." **Consequence:** record event (+notify per UDR-14) only; no audit event type for breach exists [UDR-05]. **Class:** C.

## BR-010 (applied) — Idempotent processing
- "Repeated asynchronous processing must not create duplicate business actions." → once-only warning/escalation per (incident, SLA kind, threshold/level). **Class:** C; mechanism UNK.

---

# 5. Functional Behavior
**5.1 Schedule evaluation** — Trigger: after incident creation (and on severity change?) — **mechanism undefined**: delayed per-incident jobs vs periodic scanner vs outbox-triggered [UDR-13]. [P: do not choose here.]
**5.2 Evaluate SLA warning** — Input: incidentId. Preconditions: incident not RESOLVED/CLOSED; relevant SLA active (response: while unacknowledged; resolution: until resolved) [C UC-007, D]. Processing: tx → lock/re-read incident → compute elapsed vs `0.8 × window(current severity)` → if crossed and not yet recorded → append `SLA_WARNING` (+ metadata distinguishing kind [P]) + outbox notification → commit. No state change.
**5.3 Escalate on response breach** — Preconditions: `status=OPEN` (still unacknowledged; UC-006 says "not ACKNOWLEDGED, RESOLVED, or CLOSED"; MITIGATING implied, D). Processing: tx → lock/re-check → determine next level not yet attempted → validate responder (active, valid) → record `ESCALATED_Ln` + notify responder and Team Lead (UC-006) [+ assign? UDR-02] → commit → schedule next level after delay (UDR-03). If no valid responder: record failure [C BR-041] (event type missing, UDR-05).
**5.4 Final fallback** — after last configured responder, notify Team Lead/Admin fallback; record; stop [C BR-057/058].
**5.5 Resolution breach** — record breach event; no state change [C BR-059].
**5.6 Stop conditions** — acknowledged/resolved/closed ⇒ no further escalation.
**5.7 Read SLA/escalation status (Team Lead story)** — computed view of elapsed/thresholds/escalation history [C §5; shape UNK].

---

# 6. Acceptance Criteria
- **AC-018 / AC-019** — elapsed computed from `createdAt` to ack/resolution; *Verify:* unit tests with fixed clocks.
- **AC-020** — warning at 80% of the *current* window; none earlier. *Verify:* clock-controlled test.
- **AC-021** — change severity ⇒ next evaluation uses new thresholds (including immediate retroactive firing, BR-054, once). *Verify:* severity change test.
- **AC-022 / AC-023** — breach ⇒ next responder; chain ends at Team Lead/Admin fallback. *Verify:* multi-step simulated-time test.
- **AC-024** — duplicate worker execution ⇒ no duplicate escalation/assignment. *Verify:* run job twice/concurrently; assert single audit/outbox set per level.
- **AC-039** — time policy. *Verify:* tests across timezone/DST-free IST conversion.
- **Race (UC-006 "verify incident still requires acknowledgement")** — *Verify:* ack arrives mid-evaluation ⇒ no escalation after commit.

---

# 7. Domain Model
## 7.1 Entities
| Entity | Role |
|---|---|
| Incident | severity, status, `createdAt`, `acknowledgedTimestamp`, `resolvedTimestamp` |
| AppService | SLA minutes per severity |
| EscalationPolicy | responders |
| AuditEvent | `SLA_WARNING`, `ESCALATED_L1–L4` (once-only evidence) |
| Notification (via 09) | outcome of notify |
## 7.2 Relationships — Incident→Service→Policy; Incident→AuditEvent.
## 7.3 Invariants
| Invariant | Enforcement |
|---|---|
| Warning recorded once per threshold | **Unclear** — no unique constraint (index non-unique) [UDR-13] |
| Each escalation level once | **Unclear** |
| Escalation never alters lifecycle state | Application [C BR-059, UC-006] |
| Only valid responders targeted | Application (no DB check) |
## 7.4 State Machine — SLA/escalation tracking state is **not modeled** in DM/DBS [UNK]. Incident transitions are **not** owned here (`[N/A]`). Escalation level progression `L1→L2→L3→L4(fallback)` [D from DBS levels/events].

---

# 8. Architectural Context
## 8.1 Relevant Architecture — ARCH async flow: Outbox → BullMQ → workers (AI triage, notifications, **SLA/escalation**, postmortem). "SLA/Escalation → notify escalation target."
## 8.2 Components
| Component | Responsibility |
|---|---|
| SLA worker / processor | evaluate, record, enqueue |
| Escalation service | choose next responder, record outcome |
| Repositories | read incident/service/policy; write audit/outbox via contracts |
| Queue | scheduling mechanism [UDR-13] |
## 8.3 Constraints — external calls only inside workers [C]; idempotent consumers (ADR-014); config read through 02's interface.
## 8.4 ADRs — **ADR-015** (clocks, thresholds, 80%); **ADR-014** (at-least-once ⇒ idempotent); **ADR-009** (outbox for notify).

---

# 9. Dependency Model
## 9.1 Upstream
| Slice | Type | Requires |
|---|---|---|
| 05 | READ (+lock) | incident state; possible assignee writes via kernel (UDR-02) |
| 02 | READ | SLA minutes, policy |
| 06 | IN-TX | audit append |
| 08 | IN-TX/SCHEMA | outbox + queue |
| 04 | EVENT/DATA | clock origin / scheduling trigger |
## 9.2 Downstream
| Slice | Relationship | Provides |
|---|---|---|
| 09 | EVENT | warning/escalation notifications |
| 06 | DATA | events |
## 9.3 Contract
**Allowed:** read incident/config; use 05's kernel if assignment is needed; append audit; insert outbox. **Forbidden:** direct updates to `Incident.status`/`currentAssignee`; in-memory-only escalation state.

---

# 10. Slice Coupling Analysis
## 10.1 Transactional — **YES (per evaluation)**: re-check incident state + record event + outbox atomically [D]. Local, no cross-slice commit beyond audit/outbox contracts.
## 10.2 Synchronous — Reads of 02/05 (acceptable).
## 10.3 Shared Invariants — **Potentially YES with 05**: "first ack wins / escalate only while OPEN" and "≤1 current assignee" if escalation assigns [UDR-02].
## 10.4 Summary
| Related Slice | Coupling | Strength | Boundary Decision |
|---|---|---|---|
| 05 | race on state; maybe assignee writes | Hard if assigning | NEEDS USER DECISION (UDR-02); default SEPARATE with escalation notify-only |
| 02 | config read | Soft | SEPARATE |
| 09 | event | Loose | SEPARATE |
| 08 | outbox/queue | Medium | SEPARATE |
### Boundary Decision
SLA/escalation is a time-driven process with its own scheduling and once-only guarantees; it stays separate from the user-driven kernel, provided it re-checks state under the same lock.

---

# 11. Data Model
## 11.1 Tables — reads: `Incident`, `AppService`, `EscalationPolicy`; writes: `AuditEvent`, `OutboxEvent` (via contracts). No SLA-state table in DBS [UNK].
## 11.2 Fields used — `Incident.createdAt/severity/status/acknowledgedTimestamp/resolvedTimestamp/currentAssignee`; `AppService.P0..P3 Response/Resolution SlaMinutes`; `EscalationPolicy.level1..fallbackAdmin`.
## 11.3 Constraints — none enforce once-only recording; index `idx_auditEvent_incident_type_actor(incidentId, eventType, actor)` supports lookups of prior events [D].
## 11.4 DB Invariants — none specific.
## 11.5 Migration Requirements — [UDR-13]: options include unique partial index on audit events, dedicated SLA/escalation-state table, or deterministic job IDs/idempotency keys in outbox; none canonical. Possible columns for current escalation level.

---

# 12. Transaction & Consistency Model
## 12.1 Boundary
```text
BEGIN
  lock/re-read Incident (state, severity, ack)
  compute thresholds; check "already recorded?"
  INSERT AuditEvent (SLA_WARNING | ESCALATED_Ln | breach)
  [if UDR-02 says so: assignee change via kernel]
  INSERT OutboxEvent (notification)
COMMIT
```
[D, per ADR-009/010/014 pattern; not explicitly stated for SLA]
## 12.2 Atomic — event + notify handoff.
## 12.3 Locking — same incident row lock as 05 [D]; "recorded already" check must be race-safe [UDR-13].
## 12.4 Guarantees — no silent loss (BR-047/048 "SLA status is not silently lost"); once-only events.
## 12.5 Failure — rollback ⇒ job retried; retry must not duplicate.

---

# 13. Idempotency & Concurrency
## 13.1 Idempotency — **Identity:** (incidentId, SLA kind, threshold) for warnings; (incidentId, escalation level) for escalations [P]. **Duplicate job:** no second event/notification [C AC-024, UC-007]. **Replay:** same. **Side-effect protection:** notification idempotency key derived from that identity [P; 09 owns key use].
## 13.2 Concurrency
| Race | Protection | Expected | Test |
|---|---|---|---|
| two workers same incident | lock + once-only check | one event | parallel run |
| ack vs escalation | lock + state re-check | no escalation after ack commits | race test |
| severity change vs evaluation | read current severity under lock | consistent threshold | race test |
| policy edit during chain | [UNK] | [UDR-13] | — |

---

# 14. API Surface — Preliminary
`PRELIMINARY — API CONTRACT NOT YET FROZEN`
| Candidate operation | Actor / Authz | Input | Domain action | Output | Failures | Idempotency / concurrency | Confidence · Missing |
|---|---|---|---|---|---|---|---|
| Get SLA & escalation status for incident | ENG/TL/ADMIN own team [C story: Team Lead reviews; Engineer reviews timeline & escalation history] | incidentId | read/compute | elapsed, thresholds, warning/breach flags, escalation history | 401/403(404)/404 | read | Medium · whether separate endpoint or part of incident detail/timeline |
| (no mutation endpoints) | — | — | worker-only | — | — | — | High |
Pagination `[N/A]`. Async: all evaluation is worker-driven.

---

# 15. Events, Queues & Side Effects
## 15.1 Events Produced
| Event | Producer | Payload | Consumer |
|---|---|---|---|
| Audit `SLA_WARNING`; `ESCALATED` / `ESCALATED_L1–L4` (UDR-05) | SLA worker | incident, kind/level [P] | 06 |
| Outbox notification events | SLA worker | recipients/type | 09 via 08 |
| Breach events (no type exists) | worker | — | UDR-05 |
## 15.2 Consumed — scheduling/trigger events from 04/05 [UDR-13].
## 15.3 Queue Jobs — SLA/escalation queue [C ARCH]; names/delays/retry [UDR-13, 22].
## 15.4 Delivery — at-least-once; idempotent [C ADR-014].
## 15.5 External Side Effects — none directly (email via 09).

---

# 16. Security & Authorization
Workers act as system actors (no user); audit `actor` null/system [D]. Only same-team responders may be targeted [D from BR-004 spirit; UNK]. Status read endpoint obeys team isolation (403/404 UDR-20). Notifications must not leak cross-team info. No secrets.

---

# 17. Failure Modes
| Failure | Detection | Expected | State Impact | Retry? | Evidence |
|---|---|---|---|---|---|
| Duplicate job | once-only check | no duplicate event | none | n/a | AC-024 |
| Ack during evaluation | lock re-check | skip escalation | none | n/a | UC-006 |
| No valid responder | policy validation | record failed escalation; observable | none | per retry class | BR-041 |
| Worker crash | queue retry | re-run safely | none | yes | ADR-014 |
| Redis/queue down | scheduler failure | **UNK** [UDR-21] | SLA evaluation delayed | — | — |
| Policy missing/invalid | validation | fail visibly [P] | none | — | — |
## Critical Failure Scenario
**What fails:** worker down for minutes. **Must remain true:** SLA status not silently lost (BR-047/048); on recovery, overdue thresholds are evaluated and recorded once (BR-054 spirit). **Recovery:** scheduler must be catch-up capable [P → UDR-13].

---

# 18. Observability
Logs: evaluation outcomes, escalation outcomes (required: FR-034, NFR-003), job failures/retries. Metrics: warnings, escalations by level, evaluation lag, breach counts. Audit events: `SLA_WARNING` (Yes, in tx), `ESCALATED_Ln` (Yes), breach/failure events (UDR-05). Correlation IDs propagated from the originating outbox event [P].

---

# 19. Testing Strategy
- **Unit:** threshold math (80%, 100%), severity switch, escalation level progression, clock fixed/injected.
- **Integration:** once-only recording; lock re-check; outbox/audit atomicity.
- **API:** `BLOCKED — API CONTRACT NOT YET FROZEN`.
- **Authorization:** status read cross-team.
- **Concurrency:** ack∥escalation; two workers; severity∥evaluation.
- **Idempotency:** same job twice; replay after restart.
- **Failure injection:** crash between event insert and commit; worker down then catch-up.
- **Regression:** SLA values from 02 respected; no lifecycle state change by this slice.

---

# 20. Test ↔ Requirement Traceability
| Requirement | AC | Test(s) | Status |
|---|---|---|---|
| BR-047/FR-019 | AC-018 | response clock test | NOT RUN |
| BR-048/FR-020 | AC-019 | resolution clock test | NOT RUN |
| BR-052/FR-021 | AC-020 | warning test | NOT RUN |
| BR-053/054/FR-023 | AC-021 | severity-change test | NOT RUN |
| BR-041/055/056, FR-022 | AC-022 | escalation test | NOT RUN |
| BR-057/058 | AC-023 | chain/fallback test | NOT RUN |
| BR-010, FR-031 | AC-024 | duplicate-job test | NOT RUN |
| BR-049/050 | AC-039 | time-policy test | NOT RUN |
| BR-059 | (none) | resolution-breach-no-state-change test | NOT RUN |
### Coverage Gaps
- No AC for resolution breach, no-valid-responder, catch-up after outage.

---

# 21. Implementation Plan
## 21.1 Sequence
1. Decide UDR-02, 03, 05, 13. 2. Pure SLA calculator (unit-tested). 3. Evaluation job with lock + once-only recording. 4. Escalation chain. 5. Scheduling. 6. Status read.
## 21.2 Files
### CREATE
```text
src/sla/** · src/escalation/** · test/sla/** · test/escalation/**
```
### MODIFY — worker registration; outbox event catalog (if approved).
### REVIEW ONLY — ADR-014/015; PRD UC-006/007.
## 21.3 Allowed — SLA/escalation worker code. ## 21.4 Forbidden — changing incident status; creating assignments outside 05's kernel; schema edits unapproved. ## 21.5 Must exist — 02, 05, 06, 08, 09 (for notify).

---

# 22. AI Agent Context
## 22.1 Read First
1. `AGENTS.md` 2. This slice 3. `PROJECT_STATE.md` 4. `TEST_STATUS.md` 5. `SESSION_CHECKPOINT.md` 6. PRD §7 SLA/Escalation rules, UC-006/007 7. ARCH ADR-014/015 8. DBS `AppService`, `EscalationPolicy`
## 22.2 Relevant Canonical Context
| Topic | Source | Location |
|---|---|---|
| Requirement | PRD | FR-019–023, BR-041/047–059 |
| Domain | DM | Escalation_Policy |
| Architecture | ARCH | ADR-015, ADR-014 |
| Database | DBS | SLA columns, policy, AuditEvent |
| API | — | not frozen |
## 22.3 Agent Objective
Implement SLA evaluation and escalation as idempotent, state-rechecking worker logic; do not decide scheduling, once-only storage, or whether escalation assigns (UDR-02/13).

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
- SLA clock origin, severity-dependent thresholds, 80% math, retroactive crossing.
- Once-only guarantees under at-least-once delivery.
- Why the worker must re-check state under lock (ack race).
## 23.2 SHOULD UNDERSTAND — delayed jobs vs polling; catch-up after outage.
## 23.3 CAN DEFER — business-hour calendars.
## 23.4 Mental Model
A watchdog that repeatedly asks the database "is this incident still waiting, and for how long?" and records each milestone exactly once — it never changes the incident's lifecycle itself.
## 23.5 First-Principles Questions
1. Why start the clock at `createdAt` for both SLAs? 2. What breaks if the worker trusts stale state? 3. Why can't a duplicate job send two escalations? 4. Why does escalation notify rather than change lifecycle state? 5. What are alternatives to delayed jobs?
## 23.6 Interview Questions
### Design
1. Design SLA escalation that survives worker restarts.
### Debugging
1. Two escalations went to the same person — why?
### Failure Handling
1. Worker was down for an hour — what happens on restart?
### Architecture
1. Where should SLA state live: DB, queue, or both?

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
- [ ] Same job run twice/concurrently yields one event + one notification handoff
- [ ] Ack-vs-escalation race test green
- [ ] UDR-02, 03, 05, 13 decided

---

# 25. Current Implementation Status

**Status:** `PLANNED` — DESIGN / PRE-IMPLEMENTATION (no implementation claimed)

### Completed
- None.

### In Progress
- None.

### Remaining
- Entire slice (blocked on UDR-02, UDR-03, UDR-05, UDR-13)

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
On-call rotation; business-hour SLAs (explicitly deferred, RD-010).
## Extension Points
Scheduler abstraction; escalation strategy.
## Known Limitations
No SLA state model; no timing config in DBS.
## Deliberately Not Generalized
Two SLAs; fixed levels.
## Potential Breaking Changes
Policy shape change (UDR-03); event vocabulary change (UDR-05).

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
- [ ] Catch-up after worker downtime verified.

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
