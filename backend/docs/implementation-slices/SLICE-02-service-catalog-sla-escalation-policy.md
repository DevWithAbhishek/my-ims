# SLICE-02 — `Service Catalog, SLA Configuration & Escalation Policy`

> **Authority:** Canonical documents remain authoritative; this is a derived implementation view.
> **Evidence tags:** `[C]` CANONICAL · `[D]` DERIVED · `[P]` PROPOSED · `[UDR-nn]` USER DECISION REQUIRED (see `00-INDEX`) · `[UNK]` UNKNOWN · `[N/A]` NOT APPLICABLE.
> **Sources:** `PRD` (Revised Draft, 19 Sep 2026) · `ARCH` (unversioned) · `DM` (unversioned) · `DBS` (unversioned, "proposed MVP Schema").

## 0. Slice Metadata

| Field | Value |
|---|---|
| Slice ID | `SLICE-02` |
| Capability | Service Catalog, SLA Configuration & Escalation Policy |
| Version | `0.1` (DRAFT) |
| Status | `PLANNED` (DESIGN / PRE-IMPLEMENTATION) |
| MVP | `YES` (PRD §15 "User, team, and service management", "Escalation policy configuration") |
| Created / Last Updated | `2026-10-01` / `2026-10-01` |
| Primary Owner / Module | `AppService` (ARCH) |

### Canonical Sources
- `PRD.md` — BR-002, BR-031; RD-018, RD-020; §5 Admin stories; §9 Service, Escalation Policy; §11; OQ-001, OQ-002, OQ-003; ADR-015 (via ARCH)
- `Domain_Model.md` — Service, Escalation_Policy rows; "UNIQUE(service_id, escalation_policy.severity)"; Team→Service, Service→Escalation Policy
- `Architecture.md` — Module Responsibilities (AppService); ADR-015 SLA time model
- `DB_Schema.md` — `AppService`, `EscalationPolicy`
- `API_Contracts.md` — NOT AVAILABLE · `DESIGN_CHECKS.md` — NOT PROVIDED

### Related Slices
- `SLICE-01` — users referenced by policies; Admin authorization
- `SLICE-04` — reads default severity, team, SLA config at incident creation
- `SLICE-07` — reads SLA thresholds and escalation policy at evaluation time

---

# 1. Capability Overview

## 1.1 Problem
Incident handling needs per-service severity defaults, SLA thresholds per severity, and an ordered escalation chain; without configuration, SLA and escalation have nothing to evaluate. [C: PRD §9, BR-031]

## 1.2 Purpose
Own service identity and the configuration that downstream slices *read*: default severity, P0–P3 response/resolution SLA minutes, escalation responders. [C: ARCH "AppService owns Services, SLA configuration, escalation policy"]

## 1.3 User/System Behavior
Admin creates and manages services and their escalation policy (PRD §5, §11). Other slices read the configuration; none mutate it. [D]

## 1.4 End-to-End Summary
```text
Admin input (service, SLA values, policy responders)
   ↓
Validate (team exists, severity enum, SLA values, responders valid)
   ↓
Persist EscalationPolicy + AppService
   ↓
Configuration available to SLICE-04 / SLICE-07 (read-only)
```

---

# 2. Scope

## 2.1 In Scope
- Service CRUD with `teamId`, `defaultSeverity`, 8 SLA integers (P0–P3 × response/resolution) [C: DBS]
- Escalation policy CRUD [C: PRD §5]
- Read contracts for configuration [D]

## 2.2 Out of Scope
- SLA evaluation, warning, escalation execution → `SLICE-07`
- On-call rotation scheduling [C: PRD §4 non-goal]
- Source-severity mapping config (belongs to alert-source configuration → `SLICE-03/04`, UDR-18)

## 2.3 MVP Scope
Admin-managed services and policies as modeled in DBS (subject to UDR-03).

## 2.4 Future Scope
On-call schedules; richer policies (PRD §16).

---

# 3. Requirement Traceability

| ID | Type | Source | Version | Requirement | Class |
|---|---|---|---|---|---|
| BR-002 | Business | PRD §7 | PRD-RD | "Every service belongs to exactly one team in the MVP." | C |
| BR-031 | Business | PRD §7 Severity | PRD-RD | "Exact SLA values for P0-P3 are configurable per service." (failure: "Invalid configuration is rejected") | C |
| BR-021 | Business | PRD §7 | PRD-RD | "If no recognized source severity is available, the configured service default severity is used." (failure: "Incident cannot be created without a valid default") — consumed by `SLICE-04` | C |
| RD-018 | Decision | PRD §17 | PRD-RD | "Severity levels are P0, P1, P2, and P3." — "Each service defines its SLA values for these levels." | C |
| RD-020 | Decision | PRD §17 | PRD-RD | "Each service belongs to exactly one team in the MVP." — "Services cannot be shared across teams." | C |
| §9 Service | Data | PRD §9 | PRD-RD | "Service ID; Service name; Team ID; Initial severity default; SLA configuration for P0-P3; Escalation policy reference; Created/updated timestamps" | C |
| §9 Escalation Policy | Data | PRD §9 | PRD-RD | "Policy ID; Service ID; Ordered responder list; Escalation timing configuration; Final Team Lead/Admin fallback; Created/updated timestamps" | C |
| §11 | Authz | PRD §11 | PRD-RD | "Manage services — Admin only; Manage escalation policies — Admin only" | C |
| DM-Service | Domain | DM | unv. | "Every Service belongs to exactly one Team." | C |
| DM-Policy | Domain | DM | unv. | "Every service has atleast one policy." · "UNIQUE(service_id, escalation_policy.severity)" · Service→Escalation Policy "1..4" | C |
| OQ-001/002/003 | Open Q | PRD §18 | PRD-RD | SLA durations per P0–P3; identical vs per-service; escalation delay between responders | UNK |

---

# 4. Business Rules

## BR-002 — Service belongs to one team
**Source:** PRD §7 · **Class:** C
- **Canonical Rule:** "Every service belongs to exactly one team in the MVP." (Enforcement: Database relationship; failure: "Invalid service relationship is rejected")
- **Operational Interpretation:** `AppService.teamId` NOT NULL FK. [D]
- **Engineering Consequence:** a service cannot be moved implicitly; changing `teamId` of a service with open incidents is [UNK] — the composite FK `Incident(affectedServiceId, teamId) → AppService(id, teamId)` would block updating a service's team while incidents exist [D from DBS].
- **Invalid Conditions:** service without team; service in two teams.
- **Related:** BR-001 (`SLICE-04`).

## BR-031 — SLA values configurable per service
**Source:** PRD §7 · **Class:** C
- **Canonical Rule:** "Exact SLA values for P0-P3 are configurable per service."
- **Operational Interpretation:** each service has its own response/resolution minutes for P0–P3 (8 NOT NULL ints). [D: DBS]
- **Engineering Consequence:** SLICE-07 must read thresholds from the service, never constants. Validation (positive integers; resolution ≥ response?) is [UNK] — "Invalid configuration is rejected" gives no definition [P: positive ints; ordering rule needs UDR-13]. PRD OQ-002 still asks "identical or per service" although BR-031/DBS already say per service (SD-06).
- **Invalid Conditions:** missing/non-positive values [P].

## Domain invariant — Every service has at least one policy
**Source:** DM · **Class:** C
- `AppService.escalationPolicyId NOT NULL` enforces *exactly one* referenced policy, not "1..4 per severity" [D]. **Shape conflict:** [UDR-03].

---

# 5. Functional Behavior

**5.1 Create/update service** — Trigger: Admin. Input: name, teamId, defaultSeverity (P0–P3, default `P1` in DBS), 8 SLA values, escalationPolicyId. Preconditions: ADMIN; team exists; policy exists. Processing: validate → write. State change: `AppService` row. Failure: invalid severity/value → 400; unknown team/policy → rejected.

**5.2 Create/update escalation policy** — Input: level1, level2 (engineers), level3 (team lead), fallbackAdmin (admin) [C: DBS comments]. Preconditions: ADMIN; referenced users exist. Role-correctness (level1/2 ENGINEER, level3 TEAM_LEAD, fallbackAdmin ADMIN), same-team membership, ACTIVE status: **not enforced by DBS** [UNK/UDR-03]. Timing configuration: absent from DBS [UDR-03/13].

**5.3 Read configuration (internal)** — Provide `defaultSeverity`, SLA thresholds by severity, `teamId`, policy responders to `SLICE-04`/`07`. No mutation.

**5.4 Change impact on in-flight work** — Editing SLA/policy while incidents are open affects subsequent evaluations (since evaluation reads current config, RD-011 spirit) [D]; whether config changes are versioned/snapshotted [UNK → UDR-13].

---

# 6. Acceptance Criteria

## AC-007 — Valid team and service (shared with SLICE-04)
Canonical: "An incident cannot be created without a valid team and service."
**Given:** a service config exists · **When:** incident creation references it · **Then:** DB composite FK guarantees service/team consistency. **Verification:** FK integration test.

## AC-021 (as cited by BR-031) — Invalid SLA config rejected
PRD §7 BR-031 cites AC-021, but §20 AC-021 is about severity-change evaluation (SD-01). **Verification:** [UNK — no canonical AC for config validation]; proposed test: reject non-positive/missing SLA values [P].

## No other canonical AC targets configuration management → coverage gap.

---

# 7. Domain Model

## 7.1 Entities / Concepts
| Entity | Role in This Slice |
|---|---|
| Team | Owner of services (from SLICE-01) |
| Service (`AppService`) | Unit of ownership; carries severity default and SLA config |
| Escalation_Policy | Ordered responders + fallback |

## 7.2 Relationships
Team→Service 0..N; Service→Policy: DM says 1..4 (with UNIQUE(service_id, severity)); DBS says one `escalationPolicyId` per service; PRD §9 says policy has a Service ID — three differing shapes [UDR-03].

## 7.3 Invariants
| Invariant | Enforcement |
|---|---|
| Service has exactly one team | DB |
| `defaultSeverity` ∈ P0–P3 | DB CHECK |
| SLA values NOT NULL | DB |
| Policy has four non-null responder FKs | DB |
| Responder roles/teams valid | **Unclear** |
| `UNIQUE(service_id, severity)` (DM) | **Not present in DBS** |

## 7.4 State Machine — `[N/A]` (no lifecycle states)

---

# 8. Architectural Context

## 8.1 Relevant Architecture
ARCH: AppService owns "Services, SLA configuration, escalation policy". ADR-015: separate Response/Resolution thresholds; latest severity selects threshold; warning at 80%.

## 8.2 Components Involved
| Component | Responsibility |
|---|---|
| Controller | Admin endpoints |
| Service | Validation (severity, SLA values, responders) |
| Repository | `AppService`, `EscalationPolicy` (Prisma) |

## 8.3 Architectural Constraints
Other modules access config through this module's read interface, not table access (ADR-001 convention). [D]

## 8.4 Relevant ADRs
- **ADR-015** — thresholds are *service-configured per severity*; this slice stores them. Clocks/evaluation live in `SLICE-07`.

---

# 9. Dependency Model

## 9.1 Upstream
| Slice | Type | Requires |
|---|---|---|
| 01 | FK/READ | Team, User existence; Admin authorization |

## 9.2 Downstream
| Slice | Relationship | Provides |
|---|---|---|
| 04 | READ | service existence, team, `defaultSeverity` |
| 07 | READ | SLA minutes, escalation responders |
| 05 | READ [UDR-02] | possible assignee eligibility |

## 9.3 Dependency Contract
**Allowed:** read-only config query interface. **Forbidden:** other modules writing `AppService`/`EscalationPolicy`.

---

# 10. Slice Coupling Analysis

## 10.1 Transactional Coupling — **NO** [D]. Service+policy creation order only (policy first, since service FK requires it).
## 10.2 Synchronous Coupling — **YES (read-only)** from 04 at ingest time (within the 5-second budget, NFR-004) [D].
## 10.3 Shared Invariants — **NO**. Composite FK links Incident↔Service↔Team but is owned by DB, created by `SLICE-04`.

## 10.4 Coupling Summary
| Related Slice | Coupling | Strength | Boundary Decision |
|---|---|---|---|
| 04 | Sync read | Soft | SEPARATE |
| 07 | Read | Soft | SEPARATE |
| 01 | FK | Soft | SEPARATE |

### Boundary Decision
Configuration is read-mostly with no shared transaction → separate slice; policy shape is the only unresolved issue (UDR-03).

---

# 11. Data Model

## 11.1 Tables
| Table | Purpose |
|---|---|
| `AppService` | service identity, severity default, SLA thresholds, team, policy ref |
| `EscalationPolicy` | `level1`, `level2`, `level3`, `fallbackAdmin` user refs |

## 11.2 Relevant Fields
| Field | Type | Purpose | Required? |
|---|---|---|---|
| `AppService.defaultSeverity` | text CHECK | BR-021 fallback | Yes (default P1) |
| `AppService.P{0..3}ResponseSlaMinutes`, `…ResolutionSlaMinutes` | int ×8 | ADR-015 thresholds | Yes |
| `AppService.teamId` | uuid FK | BR-002 | Yes |
| `AppService.escalationPolicyId` | uuid FK | policy | Yes |
| `EscalationPolicy.level1/2/3/fallbackAdmin` | uuid FK→User ×4 | chain | Yes |

## 11.3 Constraints
`UNIQUE(id, teamId)` on `AppService` (supports Incident composite FK); CHECK on `defaultSeverity`; FKs.

## 11.4 Database Invariants
Service↔team consistency for incidents; non-null SLA/policy.

## 11.5 Migration Requirements
- Policy has no `serviceId`, `severity`, timing columns although PRD §9/DM require/imply them [UDR-03].
- No CHECK for positive SLA minutes [P].

---

# 12. Transaction & Consistency Model

## 12.1 Boundary
```text
BEGIN
  INSERT EscalationPolicy
  INSERT AppService (references policy)
COMMIT
```
[D: FK order]. 
## 12.2 Atomic Operations — policy+service creation together [P].
## 12.3 Isolation / Locking — none specified [UNK].
## 12.4 Guarantees — FK integrity.
## 12.5 Failure — rollback.

---

# 13. Idempotency & Concurrency

## 13.1 Idempotency — no natural key defined for service (name uniqueness not specified) [UNK]; create is non-idempotent by default [D].
## 13.2 Concurrency — **Race:** Admin edits SLA/policy while `SLICE-07` evaluates. **Protection:** none specified [UNK → UDR-13]. **Required test:** evaluation reads a consistent config snapshot within one evaluation.

---

# 14. API Surface — Preliminary

`PRELIMINARY — API CONTRACT NOT YET FROZEN`

| Candidate operation | Actor / Authz | Input concepts | Domain action | Output | Failures | Idempotency / concurrency | Confidence · Missing |
|---|---|---|---|---|---|---|---|
| Create/update/list/get service | ADMIN [C §11]; read by team members [UNK] | name, team, default severity, SLA values, policy | service write | service | 400/401/403/404/409 | optimistic update? [UNK] | High/Low · name uniqueness, delete rules |
| Create/update/get escalation policy | ADMIN [C §11] | responders (shape per UDR-03), timing | policy write | policy | 400/403/404 | — | High/Low · UDR-03 |
| Read config (internal) | internal | serviceId | read | thresholds/policy | not found | read | High · — |

Pagination/filtering: [UNK]. Async: none.

---

# 15. Events, Queues & Side Effects
No events produced/consumed [D]; audit of admin config changes [UNK/UDR-05]. Queue/external: `[N/A]`.

---

# 16. Security & Authorization

## 16.1 Authentication — required [C]
## 16.2 Authorization
| Actor | Allowed |
|---|---|
| ADMIN | manage services, policies [C §11] |
| ENGINEER/TEAM_LEAD | no management [C §11]; read access [UNK] |
## 16.3 Team Isolation — services belong to one team; whether Admin manages across teams [UNK].
## 16.4 Input Security — validate severity enum, SLA integers, referenced IDs [C §12.7].
## 16.5 Sensitive Data — none beyond standard.

---

# 17. Failure Modes

| Failure | Detection | Expected | Recovery |
|---|---|---|---|
| Invalid SLA/severity | validation/CHECK | reject [C BR-031] | fix input |
| Unknown team/policy/user | FK | reject | — |
| Policy references deactivated/wrong-role user | **not detected** [UNK] | escalation later fails ("recorded as failed if no valid responder exists", BR-041) | Admin fixes policy |
| Service update blocked by composite FK | FK violation | reject | — |

## Critical Failure Scenario
**What fails:** misconfigured policy. **What must remain true:** escalation never assigns/notifies an invalid responder (BR-056). **Recovery:** validate at write time [P] and at use time in `SLICE-07`.

---

# 18. Observability
- Logs: config create/update with actor. Correlation ID propagated [C NFR-003].
- Metrics: none required [UNK].
- Audit events: none defined for config changes [UDR-05].

---

# 19. Testing Strategy
- **Unit:** SLA validation; severity enum.
- **Integration:** FK/CHECK/NOT NULL; composite-FK interplay with Incident.
- **API:** `BLOCKED — API CONTRACT NOT YET FROZEN`.
- **Authorization:** non-admin cannot manage; cross-team Admin behavior [UNK].
- **Concurrency:** config edit during evaluation (after UDR-13).
- **Idempotency:** `[N/A]`. **Failure injection:** rollback of policy+service creation. **Regression:** `SLICE-04`/`07` still read correct thresholds after changes.

---

# 20. Test ↔ Requirement Traceability

| Requirement | Acceptance Criteria | Test(s) | Status |
|---|---|---|---|
| BR-002 | AC-007 | FK test | NOT RUN |
| BR-031 | (none canonical — gap) | SLA validation tests | NOT RUN |
| BR-021 support | AC-046 (`SLICE-04`) | default severity read test | NOT RUN |
| §11 | AC-036 | admin-only tests | NOT RUN |

### Coverage Gaps
- No canonical AC for configuration validation or policy integrity.

---

# 21. Implementation Plan

## 21.1 Sequence
1. Resolve UDR-03 (policy shape). 2. Prisma models. 3. Validation service. 4. Admin endpoints. 5. Read interface for 04/07. 
## 21.2 Expected Files
### CREATE
```text
src/app-service/** · test/app-service/**
```
### MODIFY
```text
prisma/schema.prisma (AppService, EscalationPolicy)
```
### REVIEW ONLY
```text
DB_Schema.md · Domain_Model.md
```
## 21.3 Allowed — AppService module.
## 21.4 Forbidden — Identity tables; Incident tables; SLA evaluation logic.
## 21.5 Must already exist — SLICE-01 (Team, User, Admin guard).

---

# 22. AI Agent Context

## 22.1 Read First
1. `AGENTS.md` 2. This slice 3. `PROJECT_STATE.md` 4. `TEST_STATUS.md` 5. `SESSION_CHECKPOINT.md` 6. DBS `AppService`, `EscalationPolicy` 7. DM Service/Escalation rows

## 22.2 Relevant Canonical Context
| Topic | Source | Location |
|---|---|---|
| Requirement | PRD | BR-002, BR-031, §9, §11, OQ-001–003 |
| Domain | DM | Service, Escalation_Policy; UNIQUE(service_id, severity) |
| Architecture | ARCH | AppService; ADR-015 |
| Database | DBS | `AppService`, `EscalationPolicy` |
| API | — | not frozen |

## 22.3 Agent Objective
Implement Admin-managed services/policies and a read-only configuration interface, stopping on UDR-03 before finalizing the policy schema.

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
- How per-service SLA config feeds ADR-015's threshold selection.
- Why Incident has a composite FK to `(service, team)`.
## 23.2 SHOULD UNDERSTAND
- Trade-off: normalized policy rows vs fixed `level1..fallback` columns (UDR-03).
## 23.3 CAN DEFER
- Policy versioning.
## 23.4 Mental Model
This slice is the "settings page" of the system: pure data that other slices interpret. Its main risk is shape mismatch, not logic.
## 23.5 First-Principles Questions
1. Why store SLA per service, not globally? 2. What breaks if a policy points at a deactivated user? 3. Why does the service→team FK matter to incident integrity? 4. Why did DBS choose fixed levels over a list? 5. What would timing config need to look like for the worker?
## 23.6 Interview Questions
### Design
1. Model escalation policies: fixed columns vs ordered rows — trade-offs?
### Debugging
1. Escalation went to the wrong person — what config/validation failed?
### Failure Handling
1. What should happen if config changes mid-incident?
### Architecture
1. Why must other modules read config through an interface?

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
- [ ] UDR-03 decided and DBS/DM/PRD aligned
- [ ] SLA validation rules documented
- [ ] Responder role/team validation decided and tested

---

# 25. Current Implementation Status

**Status:** `PLANNED` — DESIGN / PRE-IMPLEMENTATION (no implementation claimed)

### Completed
- None.

### In Progress
- None.

### Remaining
- Entire slice (blocked on UDR-03)

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
On-call rotation (PRD §16); policy per severity (DM hints).
## Extension Points
Policy shape behind a repository interface.
## Known Limitations
Fixed 4-level chain (DBS); no timing config in DBS.
## Deliberately Not Generalized
No config versioning.
## Potential Breaking Changes
Policy shape change affects `SLICE-07`.

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
- [ ] Policy shape (UDR-03) reconciled across PRD/DM/DBS.

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
