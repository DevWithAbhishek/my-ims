# IMS Capability Slices — Index, Cross-Slice Review & Human Design Gate

**Version:** 0.1 DRAFT · **Date:** 2026-10-01 · **Status:** DESIGN / PRE-IMPLEMENTATION   
**Derived from:** `PRD.md` (Revised Draft, 19 Sep 2026), `Architecture.md`, `Domain_Model.md`, `DB_Schema.md` ("proposed MVP Schema"). `API_Contracts.md`, `DESIGN_CHECKS.md`, `AGENTS.md`, `PROJECT_STATE.md` were **not provided**.    
**Authority:** canonical documents stay authoritative. Slices are derived views. Nothing here was invented silently: every statement is tagged `[C]` canonical, `[D]` derived, `[P]` proposed, `[UDR-nn]` user decision required, `[UNK]` unknown, `[N/A]`.    

Only PRD carries a date/revision label; Architecture, Domain_Model and DB_Schema are unversioned (cited as `unv.`).    

---

# A. Capability Inventory

| ID | Capability | Purpose | Main Entities | Main Modules | MVP? | File |
|---|---|---|---|---|---|---|
| SLICE-01 | Identity, Authentication & Team Isolation | who is calling, which team fence | User, Team | Identity | Yes | `SLICE-01-identity-access.md` |
| SLICE-02 | Service Catalog, SLA Config & Escalation Policy | per-service severity default, SLA minutes, responders | AppService, EscalationPolicy | AppService | Yes | `SLICE-02-service-catalog-sla-escalation-policy.md` |
| SLICE-03 | Alert Source Trust Gate | authenticate source, replay protection, size + rate limit | AlertSource | Alerts | Yes | `SLICE-03-alert-source-trust-gate.md` |
| SLICE-04 | Alert Ingestion, Dedup & Incident Creation | normalize, identify, dedup, atomic Alert+Incident+Outbox | Alert, Incident(create), OutboxEvent | Alerts (+Incident repo) | Yes | `SLICE-04-alert-ingestion-incident-creation.md` |
| SLICE-05 | Incident Lifecycle & Assignment | ack / severity / resolve / assign, lock-based transitions | Incident | Incident | Yes | `SLICE-05-incident-lifecycle-assignment.md` |
| SLICE-06 | Incident Visibility, Comments & Timeline | team-scoped reads, comments, append-only audit contract | Comment, AuditEvent | Incident | Yes | `SLICE-06-incident-visibility-comments-timeline.md` |
| SLICE-07 | SLA Monitoring & Escalation | evaluate SLAs, 80% warning, breach escalation chain | Incident (read), AppService, EscalationPolicy | SLA/escalation worker | Yes | `SLICE-07-sla-monitoring-escalation.md` |
| SLICE-08 | Outbox, Queue & Worker Reliability | outbox relay, BullMQ, retry/backoff/DLQ | OutboxEvent | cross-cutting | Yes | `SLICE-08-outbox-queue-worker-reliability.md` |
| SLICE-09 | Notification Delivery | async idempotent email, attempts, DLQ | Notification | Notifications | Yes | `SLICE-09-notifications.md` |
| SLICE-10 | AI Alert Triage (advisory) | category / severity suggestion / confidence / evidence | (triage result — no table) | AI | Yes | `SLICE-10-ai-alert-triage.md` |
| SLICE-11 | Postmortem, Review & Closure | AI draft, human review, `RESOLVED→CLOSED` | Postmortem, Incident | AI + Incident kernel | Yes | `SLICE-11-postmortem-review-closure.md` |
| SLICE-12 | AI Investigation & Evaluation Harness | evidence-grounded brief, evaluation set | Investigation, Evidence, Evaluation | AI | Yes | `SLICE-12-ai-investigation-evaluation.md` |

**Why 12.** The evidence supports 12 coherent capabilities. Each has a distinct trigger, owner, and failure semantics. I did not force 10.

---

# B. Boundary Analysis

## B.1 Hard couplings and decisions

| Coupling | Evidence | Decision |
|---|---|---|
| Alert + Incident(create) + Outbox in one tx | ADR-011, RD-043 | **KEEP TOGETHER** in SLICE-04. The `∅→OPEN` transition is owned by 04, not 05. |
| Lifecycle ↔ Assignment | resolve requires the assigned responder; both write the same locked Incident row | **KEEP TOGETHER** in SLICE-05 |
| Transition + audit + outbox atomic | ADR-010, BR-009, NFR-007 | Enforced by 05's *transition kernel*; audit (06) and outbox (08) supply **narrow in-transaction functions**. SEPARATE slices, single transaction. |
| Postmortem review ↔ `RESOLVED→CLOSED` | BR-014, UC-010, ADR-010 | Generation + review + closure **KEEP TOGETHER** in SLICE-11 (shared postmortem state machine and gate). Who *owns* the CLOSED transition vs SLICE-05 → **NEEDS USER DECISION (UDR-15)**; proposed: 11 owns it by calling 05's kernel. |
| Escalation ↔ assignment | UC-006 lists "assignment event"; BR-056 "No invalid responder is assigned"; but BR-041 "notifies", RD-013 "notifies" | **NEEDS USER DECISION (UDR-02)**. Default in 07: notify-only; if escalation assigns, it must use 05's kernel. |
| Source auth ↔ ingestion | gate runs before the tx, different failure semantics (reject vs persist) | **SEPARATE** (03 / 04). Re-evaluate only if replay tracking needs DB atomicity with dedup (UDR-10). |
| AI triage ↔ ingestion | RD-001, BR-012 | **SEPARATE**; linked only by an outbox row |
| Triage ↔ Investigation | different trigger/authorization/data | **SEPARATE** (10 / 12), shared AI provider + redaction code |
| Evaluation harness ↔ Investigation | shares retrieval/validation, non-production | **KEEP TOGETHER** in 12; split only if it grows (UDR-23) |

## B.2 Coupling checks per capability (summary)

| Slice | Transactional | Synchronous | Shared invariants | Side-effect ownership |
|---|---|---|---|---|
| 01 | No | Yes (guard on every request) | No (rule owned here, enforced everywhere) | none |
| 02 | No | Yes (read by 04) | No | none |
| 03 | No (pre-tx) | Yes (in-request with 04) | No | rate-limit counters (Redis) |
| 04 | **Yes** (Alert+Incident+Outbox) | Yes (02, 03) | **Yes** (≤1 unresolved incident per identity) | owns initial outbox + `ALERT_*`/`INCIDENT_CREATED` audit [D] |
| 05 | **Yes** (state+audit+outbox) | Yes (01) | **Yes** (single winner; resolve-by-assignee) | owns transition audit + notification/postmortem outbox rows |
| 06 | Contract only | In-tx function | Split: producers own atomicity; 06 owns shape/append-only | owns audit store, `COMMENT_ADDED` |
| 07 | Per evaluation | Reads 02/05 | Possibly with 05 (UDR-02) | owns `SLA_WARNING`/`ESCALATED_*` + notify outbox |
| 08 | Contract only | No | Split with producers | owns relay/queue/DLQ |
| 09 | No | No | Split (outbox atomicity vs consumption) | owns Notification + email send |
| 10 | No | No | "AI advisory" (05 owns severity, 10 owns suggestion) | owns LLM call + triage result |
| 11 | **Yes** (review+CLOSED+audit+outbox) | closure sync | **Yes** with 05 (UDR-15) | owns postmortem LLM call, closure audit |
| 12 | No (own tx) | request authz sync | team isolation (rule from 01) | owns LLM/retrieval + investigation audit |

---

# D. Cross-Slice Architecture Matrices

## D.1 Cross-Slice Invariant Matrix

| Invariant | Owning Slice | Other Slices Involved | Transaction Boundary | Evidence |
|---|---|---|---|---|
| ≤1 unresolved incident per alert identity | 04 | 05 (state), 03 (replay differs) | Alert+Incident+Outbox tx; unique partial indexes | DM, ADR-011, BR-035/037, AC-003 |
| Every accepted alert belongs to exactly one incident | 04 | — | same tx (DB column nullable → app-enforced) | DM; DBS `incidentId` nullable |
| Original payload preserved separately | 04 | — | same insert | BR-018/038, AC-038 |
| Source alert state separate from incident state | 04 | 05 | alert-side write only | BR-024/039, AC-047 |
| Valid transition graph, single winner on concurrent ack | 05 | 07, 11 (race partners) | locked tx | ADR-010, BR-045, AC-011 |
| Every successful transition has an atomic audit event | 05 (producer) / 06 (store) | 04, 07, 11 | producer's tx | BR-009, NFR-007, AC-012 |
| Ack actor ≠ assignee (stored separately) | 05 | 07 (if escalation assigns) | same row, separate columns | BR-007/046, RD-014 |
| Single current assignee | 05 | 07 | row lock | BR-008, DM |
| CLOSED requires reviewed postmortem or manual path | 11 (proposed) | 05 | review + CLOSED + audit tx | BR-014/072, AC-015 |
| CLOSED is terminal | 05 | 11 | kernel rejects all | BR-015, AC-034 |
| Team isolation on every incident operation | 01 (rule) | all | n/a | BR-004, NFR-002, AC-008 |
| Required events have an atomic outbox record | producers (04/05/07/11/12) | 08 | producer's tx | ADR-009, DM |
| Duplicate job ⇒ no duplicate business effect | each consumer (07/09/10/11/12) | 08 | per consumer unique key | ADR-014, BR-010, FR-031 |
| Notification idempotent | 09 | 08 | UNIQUE(idempotencyKey) (nullable!) | BR-064, AC-028 |
| One postmortem per incident | 11 | — | UNIQUE(incidentId) **missing in DBS** | DM, FR-033, AC-032 |
| AI never changes incident state/severity | 10, 12 | 05 | no write path | BR-023/073 |
| Investigation retrieval limited to requester's team | 12 | 01 | filter in query | BR-074, AC-051 |
| AI/Redis/provider outage never blocks persistence | 04, 05 | 08, 10 | commit precedes external calls | BR-012, FR-007 |

## D.2 Cross-Slice Dependency Matrix

| From | To | Dependency | Sync/Async | Hard/Soft | Reason |
|---|---|---|---|---|---|
| 03 | 04 | verified source context | Sync | Hard (flow) | gate precedes ingestion |
| 04 | 02 | service, team, default severity | Sync | Soft | initial severity (BR-021) |
| 04 | 06 | `appendAuditEvent(tx)` | Sync in-tx | Medium | creation audit |
| 04 | 08 | `enqueueOutbox(tx)` | Sync in-tx | Medium | ADR-011 |
| 04 | 10 | triage job | Async | Loose | RD-001 |
| 05 | 01 | guards | Sync | Soft | BR-005 |
| 05 | 06, 08 | audit + outbox in-tx | Sync in-tx | Medium | ADR-010 |
| 05 | 09 | notification events | Async | Loose | §8 side effects |
| 05 | 11 | postmortem job on RESOLVED | Async | Loose | §8 |
| 07 | 02, 05 | config + state read | Sync | Soft/Hard on state race | ADR-015, UC-006 |
| 07 | 09 | notify | Async | Loose | UC-006/007 |
| 09 | 08 | queue/retry/DLQ | Runtime | Medium | ADR-008 |
| 10, 11, 12 | 08 | queue/retry | Runtime | Medium | ADR-012/014 |
| 11 | 05 | CLOSED via kernel | Sync | Hard | UDR-15 |
| 11 | 06 | comments/timeline input | Sync read | Soft | UC-009 |
| 12 | 11 | REVIEWED postmortems | Read | Soft | FR-041 |
| 12 | 01 | team authorization | Sync | Soft | BR-074 |
| all | 01 | request context | Sync | Soft | ARCH |

## D.3 Entity Ownership Matrix

| Entity | Owning Slice | Read By | Modified By |
|---|---|---|---|
| User, Team | 01 | 02, 05, 07, 09, 12 | 01 |
| AppService, EscalationPolicy | 02 | 04, 07 | 02 |
| AlertSource | 03 | 04 | 03 |
| Alert | 04 | 06, 10, 11, 12 | 04 |
| Incident (create) | 04 | all | 04 |
| Incident (status, severity, assignee, ack/resolve fields) | 05 | all | **05 kernel only** (11 for CLOSED via kernel — UDR-15) |
| Comment | 06 | 11, 12 | 06 |
| AuditEvent | 06 (store/contract) | all | every producer via `appendAuditEvent` |
| OutboxEvent | 08 | 08 | producers insert via contract; 08 updates status |
| Notification | 09 | 06 | 09 |
| Triage result | 10 (storage UNK) | 05/read APIs | 10 |
| Postmortem | 11 | 12 | 11 |
| Investigation, Evidence | 12 | read APIs | 12 |
| Evaluation | 12 (test-only? UDR-23) | — | evaluation runner |

## D.4 State Transition Ownership Matrix

| Transition | Owning Slice | Trigger | Transaction | Evidence |
|---|---|---|---|---|
| `∅ → OPEN` (incident) | 04 | accepted alert | Alert+Incident+Outbox | ADR-011, RD-043 |
| `OPEN → ACKNOWLEDGED` | 05 | user | locked tx + audit + outbox | UC-003, BR-044/045 |
| `ACKNOWLEDGED → MITIGATING` | 05 | user (severity confirm/update) | locked tx | UC-004 |
| `MITIGATING → RESOLVED` | 05 | assigned engineer | locked tx + postmortem outbox | UC-008, FR-017 |
| `RESOLVED → CLOSED` | **11 (proposed)** / 05 (UDR-15) | reviewer approval | review+CLOSED+audit+outbox | UC-010, BR-014 |
| assign / reassign / unassign (no lifecycle change) | 05 | Team Lead/Admin | locked tx | UC-005 |
| escalation level progression | 07 | SLA breach | event + notify tx | UC-006 |
| Alert source `FIRING → RESOLVED` | 04 | source delivery | alert-side write | FR-039, BR-024 |
| Notification `PENDING → SUCCESS/FAILED` | 09 | worker | worker tx | BR-062/063 |
| Postmortem `GENERATING → DRAFT → REVIEWED` | 11 | worker / human | per step | DM |
| Investigation `REQUESTED → RUNNING → COMPLETED/FAILED` | 12 | request / worker | per step | DM (DBS differs) |
| Outbox row `PENDING → processed` | 08 | relay | relay tx | ADR-009 |
| AlertSource / User `ACTIVE ↔ DEACTIVATED` | 03 / 01 | Admin | single row | DBS |

---

# Source Discrepancy Register (SD)

Conflicts or defects **inside** the canonical documents. I did not resolve them silently.

| ID | Discrepancy | Affected slices |
|---|---|---|
| SD-01 | PRD §7 "Verification" columns cite AC IDs that do not match PRD §20 text (e.g., BR-024→AC-048, BR-025→AC-047, BR-047/048→AC-019/020, BR-031→AC-021). Slices use §20 text as authoritative. | 01, 02, 04, 07 |
| SD-02 | DBS DDL creates `Alert` (FK→`Incident`) before `Incident`; `User` is a reserved word in PostgreSQL; table/column casing is unquoted camelCase. | 01, 04 |
| SD-03 | ARCH "Synchronous Request Flow" shows "Alert module --AI Module--> Incident module", contradicting FR-007 / ADR-012 (AI async). Slices follow async. | 04, 10 |
| SD-04 | ARCH Flows says services "publish a job" after commit; ADR-009 mandates the transactional outbox. | 08, 09 |
| SD-05 | PRD RD-005 says "multiple external alert sources"; PRD §15 says "One representative external alert source". | 03, 04 |
| SD-06 | PRD OQ-002 asks whether SLA is identical or per-service; BR-031/RD-018/DBS already say per-service. | 02 |
| SD-07 | Postmortem state: DM `GENERATING→DRAFT→REVIEWED`; DBS `reviewStatus PENDING/REJECTED/REVIEWED`; PRD §9 "Generation status" + "Approval status". | 11 |
| SD-08 | Investigation/Evidence: PRD §9 `Evidence.Investigation ID`; DBS `Evidence.incidentId`. DM states REQUESTED/RUNNING/COMPLETED/FAILED; DBS PENDING/DONE (no FAILED). `result NOT NULL` blocks pending rows. DM "≥1 evidence" conflicts with UC-011 no-result flow. | 10, 12 |
| SD-09 | Alert→Incident cardinality: DM diagram `0..1`, DM invariant "exactly one", DBS `incidentId` nullable. | 04 |
| SD-10 | Notification `recipients uuid[]` (DBS) vs single "Recipient" (PRD §9); `idempotencyKey` nullable UNIQUE; `attemptCount` nullable. | 09 |
| SD-11 | DBS `Evaluation` table has `incidentId NOT NULL` FK (production-coupled) vs DM/BR-080/FR-046 "outside the production domain model and API". | 12 |
| SD-12 | PRD §11 matrix grants Admin acknowledge/resolve; §8 transition table lists only Engineer/Team Lead (ack) and Assigned Engineer (resolve). | 05 |
| SD-13 | DM Escalation: "1..4 policies per service" + `UNIQUE(service_id, severity)`; DBS one `escalationPolicyId` per service with fixed `level1..fallbackAdmin` and no severity/timing; PRD §9 policy has "Service ID", "Ordered responder list", "timing". | 02, 07 |
| SD-14 | FR-011 text is garbled ("A Engineer acknowledges a incident post notification…"); meaning of "post notification" unclear. | 05 |
| SD-15 | Audit event vocabulary differs between PRD §9 and DBS CHECK (`SEVERITY_CHANGED`/`SEVERITY_CONFIRMED`, `ESCALATED`/`ESCALATED_L1–L4`, `NOTIFICATION_SENT`/`NOTIFIED`); both lack unassign/reassign, SLA breach, escalation failure, AI/notification/postmortem/investigation failure. `AuditEvent.actor` has no FK. | 06 + all producers |
| SD-16 | PRD §9 Alert has "Source status" (firing/resolved); DBS `Alert` has no such column. PRD §9 Incident lacks `severityConfirmedBy/Timestamp`, `closedBy` that DBS adds. | 04, 05 |
| SD-17 | PRD "Created on: 17th Sept 2026 / Last updated: 19th Sept 2026"; Architecture/DM/DBS carry no version. Slice "canonical version" fields cite `PRD-RD` / `unv.`. | all |

---

# E. API Contract Readiness Review

> **Not a design.** No endpoint, field, or status code below is proposed as final. This is input to the API-contract phase.

## E.1 Capabilities that need external API operations

| Slice | External operations needed | Actors |
|---|---|---|
| 01 | login; current user; user CRUD; team CRUD | anonymous, any user, Admin |
| 02 | service CRUD; policy CRUD | Admin (read: team members UNK) |
| 03 | alert ingestion (shared w/ 04); alert-source management (**actor UNKNOWN**) | alert source; ? |
| 04 | alert ingestion (single/multi-alert) | alert source |
| 05 | acknowledge; confirm/update severity; resolve; assign; reassign; unassign | Engineer/Team Lead(/Admin) |
| 06 | list/get incidents; add/list comments; get timeline | all roles, own team |
| 07 | SLA & escalation status (read) | all roles, own team |
| 08 | DLQ inspect/re-drive (ops, optional) | Admin? |
| 09 | notification history (optional); retry (optional) | UNK |
| 10 | read suggestion; retry triage (optional) | all roles / Team Lead? |
| 11 | get/update postmortem; approve & close; retry generation (optional) | Engineer/Team Lead/Admin |
| 12 | request investigation; get investigation(s); retry (optional) | Engineer/Team Lead/Admin |

## E.2 Per-dimension summary

| Dimension | Status |
|---|---|
| Authorization rules | PRD §11 matrix is the only source: Engineer/Team Lead/Admin; "Authorization must additionally enforce team isolation." Gaps: Admin cross-team scope, Admin on ack/resolve (SD-12), read access to config, alert-source management actor. |
| Input concepts | Mostly clear for lifecycle ops (incidentId, severity, resolutionSummary + confirmation, responderId). Unclear: alert payload shape per source, identity-defining fields (BR-033), service mapping (UDR-18), postmortem edit payload, investigation request reference. |
| Output concepts | Incident detail per UC-002; timeline entries; suggestions; postmortem; investigation brief + evidence refs. Shapes UNKNOWN. |
| State transitions | See D.4. Open: re-update of severity in `MITIGATING`, unassign-then-resolve, closure ownership. |
| Failure conditions | PRD gives 403 (authorization), 409 (lost ack race, close-without-review, invalid transition), "403/404" (BR-004), "Invalid ... is rejected" (400-class). No error-code taxonomy or envelope. |
| Idempotency | Alert: natural identity. Lifecycle ops: state-guarded (repeat ⇒ conflict). Investigation: request reference / key (global UNIQUE, nullable). Notification: key. Postmortem: per incident (missing UNIQUE). Request-level keys for lifecycle ops: UNKNOWN. |
| Concurrency semantics | Server-side row lock (ADR-010); first ack wins ⇒ conflict. Client concurrency tokens (ETag/version): UNKNOWN. Postmortem edit vs approve: UNKNOWN. |
| Pagination / filtering | **Not specified anywhere** (incident list, comments, timeline, investigations, notifications). NFR-006: p95 < 300 ms for current-status reads. |
| Asynchronous operations | Ingestion sync (≤5 s, NFR-004). Triage, notifications, SLA/escalation, postmortem generation, investigation: async. Request/response timing for investigation (202 + poll? — SSE/WebSocket are non-goals) UNKNOWN. |
| Ambiguous API shapes | Ingestion with multiple alerts and partial success; endpoint per source vs shared; one "transition" endpoint vs one per action; postmortem approve+close as one vs two operations; investigation sync vs async; suggestion embedded vs separate. |
| Decisions needed before freeze | UDR-09 (auth scheme), 19 (multi-alert response), 20 (403 vs 404), 02, 05, 10, 15, 17, 18, plus pagination/filter convention, error envelope, correlation-ID header, idempotency-key convention. |

## E.3 Candidate operation table

| Slice | Candidate operation | Transition | Confidence |
|---|---|---|---|
| 01 | Login; User/Team CRUD | — | Med / High (capability) |
| 02 | Service/Policy CRUD | — | High / Low (shape, UDR-03) |
| 03/04 | Ingest alerts | `∅→OPEN`, dup, source-resolved | High / Low (envelope) |
| 05 | Acknowledge | OPEN→ACK | High |
| 05 | Confirm/update severity | ACK→MITIGATING | High |
| 05 | Resolve | MITIGATING→RESOLVED | High |
| 05 | Assign / reassign / unassign | none | High |
| 06 | List/get incident; comments; timeline | none | High / Low (filters) |
| 07 | SLA/escalation status | none | Medium |
| 10 | Read triage suggestion | none | Medium |
| 11 | Get/update postmortem; approve & close | postmortem + RESOLVED→CLOSED | High / Medium |
| 12 | Request/get investigation | none (async job) | High / Low (timing) |

---

# F. HUMAN DESIGN REVIEW

I did **not** choose any of these for you. They are numbered `UDR-nn` and referenced from the slices.

## MUST DECIDE (boundaries, transactions, invariants, ownership, state, authorization, concurrency, idempotency, API semantics)

| ID | Decision | Why it matters | Affected | Options (not chosen) | Evidence |
|---|---|---|---|---|---|
| **UDR-01** | Alert recurrence & duplicate storage: after the incident is RESOLVED/CLOSED, is a repeated alert with the same identity a duplicate, a new incident, or a reopen? Is a duplicate stored as a row or only an audit event? | DBS unique indexes forbid *any* second row with same identity, but FR-004 only talks about *unresolved* incidents; UC-001 says "record/associate the duplicate alert". | 04, 05, 06 | (a) one Alert row per identity forever, dup = audit only; (b) relax unique to unresolved scope; (c) occurrence table | FR-004, BR-035/037, DBS indexes, UC-001 |
| **UDR-02** | Assignment model: who sets `currentAssignee` initially/automatically ("enqueues a worker for assignment")? Does ack set the assignee? Does escalation assign or only notify? What makes a user an eligible assignee (role/team/ACTIVE)? | Ownership of `currentAssignee`, ack race with escalation, Team Lead semantics | 05, 07, 02 | (a) escalation notify-only, assignment only by Team Lead/Admin; (b) escalation assigns via 05's kernel; (c) ack auto-assigns when null | BR-040/041/056, UC-006, ARCH Incident flow, FR-011 |
| **UDR-03** | Escalation policy shape and timing: DM "1..4 per service, UNIQUE(service, severity)" vs DBS fixed `level1..fallbackAdmin` vs PRD "ordered list + timing". Responder validity rules. | Determines schema and what 07 reads | 02, 07 | fixed columns; normalized ordered rows; per-severity policies | SD-13, OQ-003 |
| **UDR-07** | Postmortem schema/state: generation status + failure state storage; `REJECTED` meaning; `UNIQUE(incidentId)`; NOT NULL narrative fields vs in-progress rows | FR-033/BR-071 can't be satisfied by current DDL | 11 | add status columns; separate job table; relax NOT NULL | SD-07, DBS |
| **UDR-06** | Manual review path when generation repeatedly fails (OQ-008) | Without it incidents can stick in RESOLVED | 11, 05 | manual authoring; waiver by Team Lead/Admin | BR-014/072, OQ-008 |
| **UDR-15** | Who owns `RESOLVED → CLOSED`: 05 or 11? | Ownership of transition and the closure tx | 05, 11 | 11 owns, calls 05 kernel (proposed); 05 owns, calls 11 gate | UC-010, ADR-010 |
| **UDR-17** | Role details: Admin on ack/resolve; severity re-update while MITIGATING; resolve by non-assignee (Team Lead/Admin) | Authorization + state machine completeness | 05 | follow §11 matrix; follow §8 table; hybrid | SD-12, FR-015/017 |
| **UDR-20** | Cross-team access: 403 or 404? | API semantics + information leakage | all | 403 (AC-008); 404; 404 for reads, 403 for writes | BR-004 "403/404", AC-008, UC-002 |
| **UDR-19** | Multi-alert request response shape and status (partial success) | API semantics | 03, 04 | 207-style per-alert results; all-or-error with details | FR-038, AC-044 |
| **UDR-05** | Audit vocabulary and coverage: reconcile PRD vs DBS names; add missing event types (unassign/reassign, SLA breach, failures); audit for identity/config changes (§12.10)? | Producers' tx depends on valid event types; timeline completeness | 06 + all | single canonical list; metadata-typed events | SD-15, §12.10 |
| **UDR-12** | Outbox event catalog: event types, payloads, routing | contract between producers and workers | 04, 05, 07, 08, 09, 10, 11, 12 | one event per domain action; coarse job events | ADR-009, §8 side effects |
| **UDR-13** | SLA scheduling: delayed per-incident jobs vs periodic scanner vs outbox-triggered; once-only recording storage; behavior on severity change/config change/outage catch-up | Durability of SLA/escalation | 07, 02, 05, 08 | unique audit key; SLA state table; deterministic job IDs | FR-021–023, BR-052/054 |
| **UDR-04** | AI triage result storage (no table): new table vs audit metadata vs reuse Investigation; confidence/evidence/category format (OQ-007); retry-on-demand | AC-006 requires stored suggestion | 10 | new `TriageSuggestion`; metadata; reuse | FR-008, OQ-007 |
| **UDR-08** | Investigation model: state values, Evidence→Investigation FK, ≥1 evidence vs no-result, runbook source entity, retrieval mechanism, idempotency key scope/origin, sync/async response, retention (OQ-010) | Schema + API + retrieval design | 12 | see SD-08 | FR-041, UC-011 |
| **UDR-09** | Authentication mechanism: token vs session, lifetime/refresh, deactivated-user handling, lockout, password hashing | PRD only requires "secure password/session/token handling" | 01 + all | JWT; server session; hybrid | §12.1, §12.12 |
| **UDR-10** | Source auth specifics: signature algorithm, timestamp tolerance, replay store (Redis vs DB), replay-vs-valid-duplicate behavior, secret storage location, who manages AlertSource | Trust gate correctness | 03, 04 | see slice | FR-002, AC-002 vs AC-003 |
| **UDR-18** | Alert→service mapping, source-severity mapping config (OQ-004), incident title/description derivation, source↔team permission | Ingestion cannot create incidents without it | 04, 02, 03 | per-source config in `AlertSource.configuration`; separate mapping table | BR-020, FR-037 |
| **UDR-23** | Evaluation set storage/placement: test fixtures vs `Evaluation` table; metrics definition | BR-080/FR-046 vs DBS | 12 | repo fixtures; separate store | SD-11 |

## SHOULD DECIDE

| ID | Decision | Affected | Notes |
|---|---|---|---|
| **UDR-11** | Where to store source alert status (no column in DBS) | 04 | needed for FR-039 |
| **UDR-14** | Notification event catalog (OQ-005), recipient resolution (assignee + which "Team Lead"), key derivation, type mapping, resolve at enqueue vs send time | 09, 05, 07 | |
| **UDR-16** | LLM data allowed/redacted (OQ-006, OQ-012) | 10, 11, 12 | |
| **UDR-21** | Redis outage behavior: rate limit fail-open/closed; queue; cache | 03, 08 | ADR-005 says handle separately |
| **UDR-22** | Retry parameters, retry classes, DLQ tooling, outbox relay mechanism + status values (pooler constraint) | 08 + consumers | RD-024 defers to engineering |

## CAN DEFER

- Exact SLA durations (OQ-001), escalation delay values (OQ-003) — configuration data, not code.
- Indexes for tenant-scoped reads/timeline ordering (SLICE-06 §11.5) — decide at implementation.
- Retention policy (OQ-010).
- Append-only DB guard for `AuditEvent` (trigger/role).
- Metric names/dashboards.

## Observation (not a decision)

The "Domain model" and "DB schema" disagree enough (SD-07, 08, 10, 11, 13) that **UDR-03, 04, 07, 08 should be settled before any migration is generated**; otherwise the first Prisma schema will bake in a mismatch.

---

# Suggested order to resolve decisions (practical, not canonical)

1. UDR-20, 09, 17, 02 → unblocks SLICE-01/05 and the API contract skeleton.
2. UDR-05, 12, 22 → unblocks the audit and outbox contracts every slice calls (SLICE-06/08 are on the critical path for 04/05).
3. UDR-01, 18, 19, 10, 11 → unblocks SLICE-03/04.
4. UDR-03, 13 → unblocks SLICE-07.
5. UDR-14 → SLICE-09. UDR-04, 16 → SLICE-10. UDR-06, 07, 15 → SLICE-11. UDR-08, 23 → SLICE-12.

This ordering is my suggestion; the dependency matrix in D.2 supports it.
