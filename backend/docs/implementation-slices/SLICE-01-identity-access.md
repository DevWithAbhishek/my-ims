# SLICE-01 — `Identity, Authentication & Team Isolation`

> **Authority:** Canonical documents remain authoritative; this is a derived implementation view.   
> **Evidence tags:** `[C]` CANONICAL · `[D]` DERIVED (reasoning shown) · `[P]` PROPOSED · `[UDR-nn]` USER DECISION REQUIRED (see `00-INDEX`) · `[UNK]` UNKNOWN · `[N/A]` NOT APPLICABLE.   
> **Source abbreviations:** `PRD` = PRD.md (Revised Draft, 19 Sep 2026) · `ARCH` = Architecture.md (unversioned) · `DM` = Domain_Model.md (unversioned) · `DBS` = DB_Schema.md (unversioned, "proposed MVP Schema").   

## 0. Slice Metadata

| Field | Value |
|---|---|
| Slice ID | `SLICE-01` |
| Capability | Identity, Authentication & Team Isolation |
| Version | `0.1` (DRAFT) |
| Status | `PLANNED` (DESIGN / PRE-IMPLEMENTATION) |
| MVP | `YES` (PRD §15 "Authentication", "Role-based authorization", "Team-level isolation", "User, team, and service management") |
| Created / Last Updated | `2026-10-01` / `2026-10-01` |
| Primary Owner / Module | `Identity` (ARCH Module Responsibilities) |

### Canonical Sources
- `PRD.md` — FR-036; BR-003, BR-004, BR-005; RD-019, RD-034; §2; §5 (Admin stories); §11; §12.1, 12.2, 12.3, 12.6, 12.12; AC-008, AC-036, AC-037; NFR-002
- `Domain_Model.md` — User, Team rows of the constraints table; relationships User→Team, Team→User
- `Architecture.md` — Module Responsibilities (Identity); Concerns → "Security Boundaries"; ADR-001
- `DB_Schema.md` — `Team`, `User`; `idx_user_email`, `idx_user_teamId_leadId`
- `API_Contracts.md` — NOT AVAILABLE (`PRELIMINARY — API CONTRACT NOT YET FROZEN`)
- `DESIGN_CHECKS.md` — NOT PROVIDED

### Related Slices
- `SLICE-02` — Admin configuration sibling (services/policies reference users)
- `SLICE-05/06/07/09/11/12` — consume the verified request context (role, team) produced here
- `SLICE-03` — alert-source authentication is a *different* mechanism and is NOT owned here [D: ARCH says "Auth module owns identity"; PRD §12.4 treats source auth separately]

---

# 1. Capability Overview

## 1.1 Problem
Every protected operation must know who the caller is, what role they hold, and which team bounds their access. [C: PRD §12.1–12.3; ARCH "every other modules trust a verified request context"]

## 1.2 Purpose
Be the single place that authenticates users, owns users/teams/roles, and produces a verified request context so no other module re-implements identity or team isolation. [C: ARCH Security Boundaries]

## 1.3 User/System Behavior
- Users authenticate; protected APIs reject unauthenticated callers. [C: PRD §12.1]
- Admin creates/manages users and teams. [C: PRD §5, §11]
- Every request carries `{userId, role, teamId}` downstream. [D from ARCH "verified request context"; field set is [P]]

## 1.4 End-to-End Summary
```text
Credentials / token
   ↓
Authenticate (verify credential, user ACTIVE)
   ↓
Build verified request context {userId, role, teamId}
   ↓
Other slices: role check + team-scope check
   ↓
Allow / 401 / 403 (or 404 — UDR-20)
```

---

# 2. Scope

## 2.1 In Scope
- User authentication and secure password storage [C: §12.12, `passwordHash`]
- User, Team CRUD by Admin; role (`ENGINEER`/`TEAM_LEAD`/`ADMIN`), status (`ACTIVE`/`DEACTIVATED`), team-lead link (`leadId`) [C: DBS]
- Request-context contract and reusable authorization primitives (role guard, team-scope guard) [D]

## 2.2 Out of Scope
- Alert-source authentication → `SLICE-03`
- Incident-level authorization *decisions* (e.g., who may resolve) → each owning slice applies them using this slice's primitives [D]
- Multi-team membership [C: PRD §4]; SSO / enterprise integrations [C: PRD §4 "Complex enterprise integrations"]

## 2.3 MVP Scope
Login, request context, Admin user/team management, role + team guards.

## 2.4 Future Scope
Multi-team membership, workspace abstraction [C: PRD §16].

---

# 3. Requirement Traceability

| ID | Type | Canonical Source | Version | Requirement | Class |
|---|---|---|---|---|---|
| FR-036 | Functional | PRD §6 | PRD-RD | "Incident and administrative operations are restricted according to role and team membership." | C |
| NFR-002 | Non-functional | PRD §13 | PRD-RD | "Authentication, authorization, and team-level access control apply to 100% of protected incident operations." | C |
| AC-008 | Acceptance | PRD §20 | PRD-RD | "An unauthorized user cannot view or modify another team's incident and receives 403." | C |
| AC-036 | Acceptance | PRD §20 | PRD-RD | "Protected APIs validate authentication, authorization, and input data at the server boundary." | C |
| AC-037 | Acceptance | PRD §20 | PRD-RD | "Secrets are not exposed through source code, logs, or API responses." | C |
| BR-003, BR-004, BR-005 | Business | PRD §7 | PRD-RD | full text in §4 | C |
| RD-019 | Decision | PRD §17 | PRD-RD | "Each user belongs to exactly one team in the MVP." — "Team is the authorization boundary." | C |
| RD-034 | Decision | PRD §17 | PRD-RD | "The MVP uses one Team as the authorization boundary." — "There is no separate multi-tenant workspace abstraction." | C |
| §11 | Authorization Matrix | PRD §11 | PRD-RD | Admin-only: "Manage responders/users", "Manage teams". All three roles: view own team's incidents. Closing line: "Authorization must additionally enforce team isolation." | C |
| §12.1 | Security | PRD §12 | PRD-RD | "Authenticated users are required for protected API operations." | C |
| §12.12 | Security | PRD §12 | PRD-RD | "Use secure password storage and appropriate session/token handling. Do not expose authentication secrets through logs or API responses." | C |
| DM-User | Domain | DM | unv. | "Every user has exactly one role per team and belongs to only one team." | C |
| DM-Team | Domain | DM | unv. | "Every engineer has exactly one lead." | C |

**Gap [UNK]:** the PRD has no FR for login/logout/session handling; authentication appears only in §12, §15 and AC-036. Login behavior here is [D] from those.

---

# 4. Business Rules

## BR-003 — One team per user
**Source:** PRD §7 Core · **Version:** PRD-RD · **Class:** C
- **Canonical Rule:** "Every user belongs to exactly one team in the MVP." (Enforcement: Database relationship; failure: "User cannot belong to multiple teams")
- **Operational Interpretation:** `User.teamId` is a single NOT NULL FK. [D from DBS]
- **Engineering Consequence:** No join table; changing team = update of `teamId` (semantics of moving a user with open assignments: [UNK]).
- **Invalid Conditions:** user without team; second team association.
- **Related:** BR-004, RD-019.

## BR-004 — Team-scoped access
**Source:** PRD §7 Core · **Class:** C
- **Canonical Rule:** "Users can access incidents only within their authorized team." (Enforcement: "Server-side authorization and team filtering"; failure: "403/404")
- **Operational Interpretation:** every incident-related query/command is filtered or checked by the caller's `teamId`. [D]
- **Engineering Consequence:** one shared team-scope guard used by all slices; no slice trusts client-provided team IDs. [D from ARCH]
- **Invalid Conditions:** any read/write of another team's incident. **Response code: 403 vs 404 is ambiguous in PRD (`403/404`; AC-008 says 403)** [UDR-20].
- **Related:** BR-005, AC-008.

## BR-005 — Authorized changes only
**Source:** PRD §7 Core · **Class:** C
- **Canonical Rule:** "Only authorized users can change incident status, assignment, severity, or postmortem content." (Enforcement: server-side; failure: 403)
- **Operational Interpretation:** role + team checks before any mutating operation; this slice provides the guard, other slices decide which roles are allowed per §11. [D]
- **Engineering Consequence:** authorization is server-side only; UI hiding is irrelevant.
- **Invalid Conditions:** mutating call by unauthenticated, wrong-role, or cross-team user.
- **Related:** BR-006, BR-042, BR-043 (`SLICE-05`).

---

# 5. Functional Behavior

**5.1 Authenticate user** — Trigger: user submits credentials. Input: identifier + secret [UNK: email is UNIQUE per DBS, so email is the likely identifier — D]. Preconditions: user exists, `status=ACTIVE` [D: DBS status; effect of DEACTIVATED on login not stated → UNK]. Processing: verify password hash → issue credential [UDR-09]. State change: none (session state, if any: UNK). Output: credential artifact [UDR-09]. Failure: generic invalid-credentials failure; never reveal which part failed [P].

**5.2 Build verified request context** — Trigger: any protected request. Processing: validate credential → load `{userId, role, teamId, status}` → attach to request. Failure: 401 for missing/invalid credential [D: AC-036]. Deactivated user mid-session: [UNK].

**5.3 Admin manages users** — Trigger: Admin action. Input: name, email, password, role, teamId, leadId, status. Preconditions: caller is ADMIN. Processing: validate → hash password → insert/update. State change: `User` row create/update; `ACTIVE ↔ DEACTIVATED`. Failure: duplicate email (UNIQUE), invalid role, unknown team/lead → rejected. Open: lead must be same team / `TEAM_LEAD` role? [UNK]; "every engineer has exactly one lead" is not DB-enforced (`leadId` nullable) [D].

**5.4 Admin manages teams** — Input: team name. Failure: validation. Team deletion with users/services [UNK].

**5.5 Authorization primitives** — `requireRole(...)`, `assertSameTeam(resource.teamId)`. [P: names]. Behavior per PRD §11 matrix; cross-team result per UDR-20.

---

# 6. Acceptance Criteria

## AC-008 — Cross-team isolation
Canonical: "An unauthorized user cannot view or modify another team's incident and receives 403."
**Given:** user of team A, incident of team B · **When:** view or modify · **Then:** 403 and no data returned/changed.
**Verification:** authorization integration tests across all incident endpoints (shared helper). Note PRD BR-004 allows "403/404" [UDR-20].

## AC-036 — Boundary validation
Canonical: "Protected APIs validate authentication, authorization, and input data at the server boundary."
**Verification:** unauthenticated / wrong-role / invalid-input tests per endpoint.

## AC-037 — Secrets not exposed
Canonical: "Secrets are not exposed through source code, logs, or API responses."
**Verification:** response-shape tests (no `passwordHash`); log-capture test during login/failed login; repo secret scan.

---

# 7. Domain Model

## 7.1 Entities / Concepts
| Entity | Role in This Slice |
|---|---|
| User | Actor identity; role; team; status; lead link; `passwordHash` |
| Team | Authorization boundary; membership |

## 7.2 Relationships
User→Team 1 (many-to-one: Team→User 1..N); User→User (`leadId`, self-reference) [C: DM, DBS]. Team→Service 0..N is owned by `SLICE-02`.

## 7.3 Invariants
| Invariant | Enforcement |
|---|---|
| User belongs to exactly one team | DB (`teamId NOT NULL`, FK) |
| Role ∈ {ENGINEER, TEAM_LEAD, ADMIN}; status ∈ {ACTIVE, DEACTIVATED} | DB CHECK |
| Email unique | DB UNIQUE |
| Every engineer has exactly one lead | **Unclear** — `leadId` is nullable; no CHECK/trigger [D] |
| Lead is in the same team / has TEAM_LEAD role | **Unclear** [UNK] |

## 7.4 State Machine
`User.status`: `ACTIVE ↔ DEACTIVATED` [C: DBS CHECK; transitions/rules UNK]. Owned by this slice. No incident transitions are owned here.

---

# 8. Architectural Context

## 8.1 Relevant Architecture
**Source:** ARCH Module Responsibilities — Identity owns "Authentication, users, teams, roles, membership". "Auth module owns identity; every other modules trust a verified request context." Request flow: Module → Controller → Service → Repository → PostgreSQL → Response.

## 8.2 Components Involved
| Component | Responsibility in Slice |
|---|---|
| Controller | Login, user/team admin endpoints |
| Auth guard / middleware | Verify credential, attach context [P] |
| Service | Password hashing, validation, role/team rules |
| Repository | `User`, `Team` via Prisma [C: ARCH DB access] |

## 8.3 Architectural Constraints
- Single DB; modules own tables logically (ARCH Data ownership). Other modules must not write `User`/`Team`.
- Credentials/secrets not in source (PRD §12.6).

## 8.4 Relevant ADRs
- **ADR-001** modular monolith — module boundary discipline by convention; Identity is the only writer of identity data.

---

# 9. Dependency Model

## 9.1 Upstream Dependencies
| Slice | Type | Requires |
|---|---|---|
| — | — | None (foundation slice) |

## 9.2 Downstream Consumers
| Slice | Relationship | Provides |
|---|---|---|
| 02, 05, 06, 07, 09, 11, 12 | READ / guard | Request context; role/team guards; user lookup (responders, leads) |
| 09 | READ | Recipient resolution via `leadId` [D] |

## 9.3 Dependency Contract
**Allowed:** request-context object; role/team guard functions; user lookup by ID/team/lead (read-only).
**Forbidden:** other modules reading `passwordHash`; other modules mutating `User`/`Team`; trusting client-supplied `teamId`.

---

# 10. Slice Coupling Analysis

## 10.1 Transactional Coupling — **NO**
No operation here must share a transaction with another slice's writes. [D]

## 10.2 Synchronous Coupling — **YES (acceptable, read-only)**
Every protected request synchronously depends on the context; this is a dependency, not shared state. [D]

## 10.3 Shared Invariants — **NO**
Team isolation is enforced by each slice, but the *rule* is owned here (BR-004). [D]

## 10.4 Coupling Summary
| Related Slice | Coupling | Strength | Boundary Decision |
|---|---|---|---|
| All protected slices | Sync (guard) | Soft | SEPARATE |
| 02 | FK (policy → User) | Soft | SEPARATE |
| 09 | READ (leads) | Soft | SEPARATE |

### Boundary Decision
Identity is a leaf dependency with no write coupling → stands alone.

---

# 11. Data Model

## 11.1 Tables / Models
| Table | Purpose |
|---|---|
| `Team` | Team identity |
| `User` | Actor, role, team, lead link, credentials |

## 11.2 Relevant Fields
| Field | Type | Purpose | Required? |
|---|---|---|---|
| `User.email` | text UNIQUE | Login identity [D] | Yes |
| `User.passwordHash` | text | Credential | Yes |
| `User.role` | text CHECK | RBAC | Yes (default ENGINEER) |
| `User.status` | text CHECK | Active/Deactivated | Yes (default ACTIVE) |
| `User.teamId` | uuid FK→Team | Team boundary | Yes |
| `User.leadId` | uuid FK→User | Team-lead link | No |
| `Team.name` | text | Identity | Yes |

## 11.3 Constraints
`UNIQUE(email)`; `CHECK(role…)`; `CHECK(status…)`; `FK teamId→Team`; `FK leadId→User`; indexes `idx_user_email`, `idx_user_teamId_leadId`.

## 11.4 Database Invariants
One team per user; unique email; valid role/status.

## 11.5 Migration Requirements
- DDL uses table name `User` — reserved word in PostgreSQL; must be quoted/mapped when migrating [D: DBS script]. 
- `Team` has no lead column; "lead" is modeled on `User.leadId` only [C: DBS].

---

# 12. Transaction & Consistency Model

## 12.1 Transaction Boundary
Single-row writes; no multi-entity transaction required [D].
```text
BEGIN
  INSERT/UPDATE User|Team
COMMIT
```
## 12.2 Atomic Operations
User create; user update. Audit of admin actions: PRD §12.10 requires security-relevant actions in an audit trail, but `AuditEvent` is incident-oriented with a fixed event-type CHECK containing no identity events [UDR-05].
## 12.3 Isolation / Locking
UNIQUE(email) is the concurrency guard. [D]
## 12.4 Consistency Guarantees
Unique email; one team per user.
## 12.5 Transaction Failure
Rollback; no partial user. [D]

---

# 13. Idempotency & Concurrency

## 13.1 Idempotency
**Identity:** email (natural key). **Duplicate request:** second create → unique violation → conflict [D]. **Replay:** [UNK]. **Side-effect protection:** none needed.

## 13.2 Concurrency
**Race:** two Admins create same email. **Protection:** UNIQUE(email). **Expected result:** one succeeds, one conflict. **Required test:** parallel-create integration test.

---

# 14. API Surface — Preliminary

`PRELIMINARY — API CONTRACT NOT YET FROZEN`

| Candidate operation | Actor / Authz | Input concepts | Domain action | Output concept | Expected failures | Idempotency / concurrency | Confidence · Missing decisions |
|---|---|---|---|---|---|---|---|
| Login (`POST /auth/...`) | anonymous | identifier, secret | authenticate | credential artifact | invalid creds, deactivated | none; brute-force limits [UNK] | Medium · UDR-09 (token vs session, refresh, lockout) |
| Current user | any authenticated | — | read context | user profile (no secrets) | 401 | read | Low · need? |
| Create/update/deactivate user | ADMIN only [C §11] | name, email, password, role, teamId, leadId, status | user write | user (no `passwordHash`) | 400/401/403/409 | UNIQUE(email) | High (capability), Low (shape) · lead rules, deactivation effects |
| Create/update team | ADMIN only [C §11] | name | team write | team | 400/401/403 | — | High/Low · delete rules |
| List users/teams | ADMIN (scope: own team? all?) [UNK] | filters | read | page | 401/403 | pagination [UNK] | Low · Admin cross-team visibility |

**Cross-cutting API decisions needed:** auth scheme, error envelope, 403 vs 404 (UDR-20), pagination convention, correlation-ID header.

---

# 15. Events, Queues & Side Effects

## 15.1 Events Produced — none [D]
## 15.2 Events Consumed — none [D]
## 15.3 Queue Jobs — `[N/A]`
## 15.4 Delivery Semantics — `[N/A]`
## 15.5 External Side Effects — none [D] (no email verification/reset requirements in PRD)

---

# 16. Security & Authorization

## 16.1 Authentication
Required for all protected operations [C §12.1]. Mechanism [UDR-09].

## 16.2 Authorization
| Actor | Allowed Operations |
|---|---|
| ENGINEER, TEAM_LEAD | No identity administration [C §11] |
| ADMIN | Manage users, teams (and services/policies in `SLICE-02`) [C §11] |

## 16.3 Resource / Tenant / Team Isolation
Team is the boundary [C RD-019/034]. Whether ADMIN is cross-team for administration is [UNK] (Admin has a `teamId` too: DBS `teamId NOT NULL`).

## 16.4 Input Security
Validate all inputs at boundary [C §12.7]; password policy [UNK]; login rate limiting [UNK] (FR-035 covers alert sources only).

## 16.5 Sensitive Data
Never log: passwords, `passwordHash`, tokens, JWT/session secrets [C §12.6, §12.12, AC-037]. Store securely: password hash (algorithm [UNK]).

---

# 17. Failure Modes

| Failure | Detection | Expected Behavior | Recovery |
|---|---|---|---|
| Missing/invalid credential | Guard | 401, no data | Re-login |
| Wrong role | Role guard | 403 [C BR-005] | — |
| Cross-team access | Team guard | 403 (or 404, UDR-20) [C AC-008] | — |
| Duplicate email | UNIQUE violation | Conflict | Choose other email |
| DB failure | Exception | Rollback; 5xx | Retry |

## Critical Failure Scenario
**What fails:** guard missing on one endpoint. **What must remain true:** NFR-002 — 100% of protected incident operations enforce auth + team. **Recovery:** central guard + endpoint-coverage test that fails when a route lacks a guard [P].

---

# 18. Observability

## 18.1 Logs
Login success/failure (no secrets), user created/updated/deactivated, authorization denials (userId, route, reason).
## 18.2 Request / Correlation IDs
Generated/accepted at the edge and propagated [C: NFR-003, FR-034]; mechanism [UNK].
## 18.3 Metrics
| Metric | Purpose |
|---|---|
| `auth_failures_total` | detect brute force |
| `authz_denials_total` | detect isolation probing |
## 18.4 Audit Events
| Event | When Recorded | Transactional? |
|---|---|---|
| (identity/security events) | — | **UNK — no matching `AuditEvent.eventType`** [UDR-05] |
## 18.5 Error Tracking
[UNK]

---

# 19. Testing Strategy

## 19.1 Unit Tests
Password hash/verify; role guard matrix (§11); team guard.
## 19.2 Integration Tests
User CRUD constraints (email unique, role/status CHECK, FK); deactivated user rejected.
## 19.3 API Tests
`BLOCKED — API CONTRACT NOT YET FROZEN`
## 19.4 Authorization Tests
Unauthenticated; same-team engineer; wrong role (non-admin admin ops); cross-team user.
## 19.5 Concurrency Tests
Parallel create with same email → exactly one row.
## 19.6 Idempotency Tests
`[N/A]` beyond uniqueness.
## 19.7 Failure Injection
DB failure during user create → no partial row.
## 19.8 Regression Tests
Endpoint-coverage test: every protected route has auth + team guard.

---

# 20. Test ↔ Requirement Traceability

| Requirement | Acceptance Criteria | Test(s) | Status |
|---|---|---|---|
| BR-003 | (PRD cites AC-007; see SD-01) | FK/NOT NULL integration test | NOT RUN |
| BR-004 / FR-036 | AC-008 | cross-team matrix test | NOT RUN |
| BR-005 | AC-036 | wrong-role tests | NOT RUN |
| AC-037 | AC-037 | log/response secret scan | NOT RUN |
| §12.12 | AC-037 | hash storage test | NOT RUN |

### Coverage Gaps
- No acceptance criterion for login/session behavior or deactivation effects.

---

# 21. Implementation Plan

## 21.1 Implementation Sequence
1. Prisma models/migration for `Team`, `User` (after UDR-09 decided). 2. Password hashing + login. 3. Request-context guard. 4. Role/team guard helpers + tests. 5. Admin user/team management.

## 21.2 Expected Files
### CREATE
```text
src/identity/** (module, controller, service, repository, guards)
test/identity/**
```
### MODIFY
```text
prisma/schema.prisma (Team, User)
```
### REVIEW ONLY
```text
PRD.md §11–12 · DB_Schema.md
```
## 21.3 Allowed Changes
Identity module; shared guard utilities.
## 21.4 Forbidden Changes
Other modules' tables; schema beyond Team/User unless explicitly allowed; architecture redesign.
## 21.5 Dependencies That Must Already Exist
Project skeleton, DB connection, config/secret loading.

---

# 22. AI Agent Context

## 22.1 Read First
1. `AGENTS.md` 2. This slice 3. `PROJECT_STATE.md` 4. `TEST_STATUS.md` 5. `SESSION_CHECKPOINT.md` 6. PRD §11, §12 7. DBS `User`/`Team`

## 22.2 Relevant Canonical Context
| Topic | Source | Location |
|---|---|---|
| Requirement | PRD | FR-036, BR-003/004/005, §11, §12 |
| Domain | DM | User, Team rows |
| Architecture | ARCH | Module Responsibilities; Security Boundaries |
| Database | DBS | `Team`, `User` |
| API | — | not frozen |

## 22.3 Agent Objective
Implement authentication, the verified request context, role/team guards, and Admin user/team management exactly as supported by [C]/[D] items; stop at every `[UDR-09]`/`[UDR-20]` decision.

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
- AuthN vs AuthZ vs team-scoping (broken object-level authorization / IDOR). 
- Why the team filter belongs in the query/guard, not the client.
- Password hashing (why slow salted hashes).
## 23.2 SHOULD UNDERSTAND
- Token vs server-session trade-offs (to make UDR-09). 
- Why unknown-vs-forbidden (403 vs 404) responses leak information (UDR-20).
## 23.3 CAN DEFER
- Refresh-token rotation details; MFA.
## 23.4 Mental Model
Identity answers "who are you and which team fence are you inside?" once, at the edge. Every other slice asks the context, never the user.
## 23.5 First-Principles Questions
1. Why is team isolation enforced server-side per query rather than at login? 2. What breaks if one endpoint skips the guard? 3. Why does a `DEACTIVATED` user need handling beyond login? 4. Why one team per user in MVP, and what would multi-team change? 5. What alternatives to JWT exist and why might each fit?
## 23.6 Interview Questions
### Design
1. How do you enforce tenant isolation in a modular monolith?
### Debugging
1. A user sees another team's incident — where do you look first?
### Failure Handling
1. What happens to in-flight requests when a user is deactivated?
### Architecture
1. Why should Identity own users but not incident permissions?

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
- [ ] Every protected route covered by the endpoint-coverage test
- [ ] No response/log contains `passwordHash` or tokens
- [ ] UDR-09 and UDR-20 decided and recorded

---

# 25. Current Implementation Status

**Status:** `PLANNED` — DESIGN / PRE-IMPLEMENTATION (no implementation claimed)

### Completed
- None.

### In Progress
- None.

### Remaining
- Entire slice (blocked on UDR-09 for credential mechanism)

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
Multi-team membership; SSO; MFA (PRD §16 lists multi-team; others [P]).
## Extension Points
Guard abstraction accepting richer scopes later.
## Known Limitations
No FR for login/session; no lead-integrity enforcement.
## Deliberately Not Generalized
Single team per user; three fixed roles.
## Potential Breaking Changes
Changing `teamId` cardinality; changing the request-context shape.

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
- [ ] Every protected route enforces auth + team scope (NFR-002).

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
