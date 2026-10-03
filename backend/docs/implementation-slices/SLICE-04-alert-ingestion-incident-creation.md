# SLICE-04 — `Alert Ingestion, Deduplication & Incident Creation`

> **Authority:** Canonical documents remain authoritative; this is a derived implementation view.
> **Evidence tags:** `[C]` CANONICAL · `[D]` DERIVED · `[P]` PROPOSED · `[UDR-nn]` USER DECISION REQUIRED (see `00-INDEX`) · `[UNK]` UNKNOWN · `[N/A]` NOT APPLICABLE.
> **Sources:** `PRD` (Revised Draft, 19 Sep 2026) · `ARCH` (unversioned) · `DM` (unversioned) · `DBS` (unversioned, "proposed MVP Schema").

## 0. Slice Metadata

| Field | Value |
|---|---|
| Slice ID | `SLICE-04` |
| Capability | Alert Ingestion, Deduplication & Incident Creation |
| Version | `0.1` (DRAFT) |
| Status | `PLANNED` (DESIGN / PRE-IMPLEMENTATION) |
| MVP | `YES` |
| Created / Last Updated | `2026-10-01` / `2026-10-01` |
| Primary Owner / Module | `Alerts` (orchestrates the transaction); writes `Incident` rows via the Incident module's repository (ADR-011) |

### Canonical Sources
- `PRD.md` — FR-003, 004, 005, 006, 010 (creation part), 030, 037, 038, 039; BR-001, BR-012, BR-016–BR-025, BR-032–BR-039; RD-004, 006, 022, 026, 027, 043; UC-001; AC-003, 004, 007, 038, 043–048; NFR-001, 004, 008
- `Domain_Model.md` — Alert, Alert_Source, Incident rows; "Every accepted alert belongs to exactly one incident"; "At most one unresolved Incident exists for an alert identity/fingerprint"
- `Architecture.md` — Sync flow; ADR-009, ADR-011, ADR-012; Alert flow
- `DB_Schema.md` — `Alert` (+ unique partial indexes), `Incident` (creation), `OutboxEvent`, `AuditEvent`
- `API_Contracts.md` — NOT AVAILABLE · `DESIGN_CHECKS.md` — NOT PROVIDED

### Related Slices
- `SLICE-03` (gate in), `SLICE-02` (service/severity config), `SLICE-05` (owns incident after creation), `SLICE-06` (audit contract), `SLICE-08` (outbox relay), `SLICE-10` (AI triage consumer)

---

# 1. Capability Overview

## 1.1 Problem
Alerts arrive in source-specific shapes, may be repeated or concurrent, and must become exactly one unresolved incident per alert identity without depending on AI availability. [C: PRD §1, Goals 3–5]

## 1.2 Purpose
Normalize, identify, deduplicate, and atomically persist Alert + Incident + Outbox event; preserve the original payload; record source alert status without touching incident state. [C: ADR-011, RD-043, BR-018, BR-024]

## 1.3 Behavior
New alert → one new `OPEN` incident. Duplicate delivery → no second unresolved incident. Multiple alerts per request → each processed independently. Source "resolved" → recorded, incident unchanged.

## 1.4 End-to-End Summary
```text
Verified source context (SLICE-03)
   ↓
Validate payload → Normalize (common format, FR-037)
   ↓
Resolve affected service (UDR-18) → Determine identity (event ID or deterministic fingerprint)
   ↓
Deduplicate (lookup + DB unique index)
   ↓
Determine initial severity (mapped source severity, else service default)
   ↓
BEGIN  Alert + Incident(OPEN) + Outbox [+ audit events: derived]  COMMIT
   ↓
HTTP success (per-alert result — UDR-19)
   ↓ (async, after commit) AI triage / notification jobs via outbox
```

---

# 2. Scope

## 2.1 In Scope
Normalization to common alert format; identity; deduplication; initial severity; creation of Alert+Incident+Outbox in one transaction; preservation of original payload; source alert status recording; multi-alert requests. [C]

## 2.2 Out of Scope
Source auth/replay/rate limit (03); lifecycle transitions after OPEN (05); AI triage (10); notification delivery (09); outbox relay (08); alert suppression/noise reduction [C: PRD §4].

## 2.3 MVP Scope
One representative source via the common contract [C: PRD §15].

## 2.4 Future Scope
More adapters; suppression/correlation [C: PRD §16].

---

# 3. Requirement Traceability

| ID | Type | Source | Version | Requirement | Class |
|---|---|---|---|---|---|
| FR-003 | Functional | PRD §6 | PRD-RD | "The system identifies an external alert using the source and a stable source-provided alert identifier when available." | C |
| FR-004 | Functional | PRD §6 | PRD-RD | "Repeated delivery of the same alert is associated with an existing unresolved incident when one exists rather than creating another unresolved incident." | C |
| FR-005 | Functional | PRD §6 | PRD-RD | "Every new incident has an initial severity. A recognized source severity is mapped to P0-P3; otherwise the service default severity is used." | C |
| FR-006 | Functional | PRD §6 | PRD-RD | "After authentication, validation, identity checks, and deduplication, the system persists the alert and incident before asynchronous AI triage begins." | C |
| FR-010 | Functional | PRD §6 | PRD-RD | "Each incident has a unique ID, title, description, affected service, team, severity, status, assignment information, timestamps, alert reference, and timeline." (creation part here) | C |
| FR-030 | Functional | PRD §6 | PRD-RD | "Repeated processing of the same alert must not create duplicate unresolved incidents or duplicate business actions." | C |
| FR-037 | Functional | PRD §6 | PRD-RD | "Alerts from supported sources are converted into a common internal format containing, where available, source, source event ID, source fingerprint, alert name, service, environment, source severity, summary, description, labels or attributes, annotations or additional details, start time, end time, source URL, and original payload." | C |
| FR-038 | Functional | PRD §6 | PRD-RD | "A single request may contain multiple alerts. The system processes each alert separately for validation, identity, deduplication, storage, and incident association." | C |
| FR-039 | Functional | PRD §6 | PRD-RD | "The system records the source alert status, including firing or resolved when provided by the source. A source alert becoming resolved does not automatically change the IMS incident to RESOLVED." | C |
| BR-001, 012, 016–025, 032–039 | Business | PRD §7 | PRD-RD | full text in §4 | C |
| RD-043 | Decision | PRD §17 | PRD-RD | "The alert ingestion and incident creation is a local atomic transaction." — "The accepted Alert + Incident + required initial Outbox event are persisted in one PostgreSQL transaction inside the Alert repository/workflow." | C |
| AC-003 | Acceptance | PRD §20 | PRD-RD | "A valid duplicate alert with the same external alert identity does not create a second unresolved incident." | C |
| AC-004 | Acceptance | PRD §20 | PRD-RD | "A newly accepted alert is persisted before asynchronous AI triage is attempted." | C |
| AC-007 | Acceptance | PRD §20 | PRD-RD | "An incident cannot be created without a valid team and service." | C |
| AC-038 | Acceptance | PRD §20 | PRD-RD | "Original alert payloads are retained and associated with the corresponding alert/incident." | C |
| AC-043 | Acceptance | PRD §20 | PRD-RD | "An alert from a supported external source is converted into the common IMS alert format before incident processing." | C |
| AC-044 | Acceptance | PRD §20 | PRD-RD | "An alert source that sends multiple alerts in one request has each valid alert processed independently without losing valid alerts." | C |
| AC-045 | Acceptance | PRD §20 | PRD-RD | "A recognized source severity is mapped to the configured IMS P0-P3 severity." | C |
| AC-046 | Acceptance | PRD §20 | PRD-RD | "An alert without a recognized source severity receives the configured default severity for its service." | C |
| AC-047 | Acceptance | PRD §20 | PRD-RD | "A source alert changing from firing to resolved records the source resolution without automatically moving the IMS incident to RESOLVED." | C |
| AC-048 | Acceptance | PRD §20 | PRD-RD | "The original source payload remains available after normalization and incident creation." | C |
| NFR-001/004/008 | NFR | PRD §13 | PRD-RD | "No accepted incident state change should be silently lost." · accepted alert persisted "within 5 seconds, excluding asynchronous AI processing and external provider latency" · "Duplicate alert, queue, notification, and postmortem processing must not create unintended duplicate business actions." | C |
| ADR-011 | Decision | ARCH | unv. | "Use the alert source plus a stable source-provided event identifier when available. Otherwise derive a deterministic fingerprint from identity-defining normalized fields. Enforce uniqueness at the database boundary." + consistency boundary text (§8.4) | C |
| DM-Alert | Domain | DM | unv. | "Every accepted alert belongs to exactly one incident." · "At most one unresolved Incident exists for an alert identity/fingerprint." · "Every Incident belongs to exactly one Team and Service." | C |

> Note: PRD §7 verification column cites AC IDs that do not always match PRD §20 (e.g., BR-024→AC-048, BR-025→AC-047). This slice uses PRD §20 text as authoritative (SD-01).

---

# 4. Business Rules

## BR-016 — Common format before incident processing
- **Canonical Rule:** "Alerts from supported sources must be converted into the common IMS alert format before incident processing." (failure: "Invalid alert is rejected")
- **Interpretation:** normalization is a mandatory pure step before identity/dedup. [D] **Consequence:** source-specific adapter isolated from incident workflow (PRD §10). **Invalid:** payload failing source validation. **Class:** C.

## BR-017 / BR-032 — Identity uses source + stable provider identifier
- **Canonical Rule (BR-032):** "An external alert identity uses source plus a stable provider alert identifier when one is available." (BR-017 failure: "Alert without a usable identity follows the configured fallback identity rule")
- **Interpretation:** identity = (`alertSourceId`, `sourceEventId` or `sourceFingerprint`). **Open:** when both exist which governs? [UDR-01]. **Class:** C/UDR.

## BR-033 — Deterministic fallback identity
- **Canonical Rule:** "If a source does not provide a usable stable identifier, IMS generates a deterministic identity from the source and the alert fields that define the alert's identity." (failure: "Alert is rejected if a stable identity cannot be formed")
- **Consequence:** which fields are identity-defining per source: [UNK]. **Class:** C/UNK.

## BR-034 — Raw payload not sole identity basis
- **Canonical Rule:** "The entire raw payload must not be used as the only basis for alert identity because some fields can change between deliveries." **Consequence:** fingerprint must exclude volatile fields (timestamps, counters) [D]. **Class:** C.

## BR-035 / BR-037 / BR-036 — Duplicates; enforcement; stored identity
- **Canonical Rules:** BR-035 "Alerts with the same external alert identity are treated as duplicates for incident deduplication." · BR-036 "The alert identity must be stored with the alert record." · BR-037 "Deduplication must be enforced at the application and database levels where appropriate." (failure: "Concurrent duplicate processing is safely resolved")
- **Interpretation:** app lookup + DB unique index (`idx_alert_source_event`, `idx_alert_source_fingerprint`). **Engineering Consequence:** the DB unique violation under race must be caught and treated as "duplicate", not 500 [D]. **Invalid:** second Alert row / second unresolved incident for same identity. **Class:** C. **Conflict:** the DB indexes forbid *any* second row with the same identity, even after the incident is resolved, while FR-004 speaks only of "unresolved" incidents [UDR-01].

## BR-018 / BR-038 — Original payload preserved separately
- **Canonical Rules:** BR-018 "The full source payload must be preserved separately from the common alert data." · BR-038 "The original source payload is stored independently of normalized alert fields." (failure: "Accepted alert is not considered complete without its original payload")
- **Consequence:** `originalPayload jsonb NOT NULL` written in the same insert. **Class:** C.

## BR-019 / BR-020 / BR-021 / BR-022 — Initial severity
- **Canonical Rules:** BR-019 "Every incident must have an initial severity when it is created." · BR-020 "A recognized source severity is mapped to P0-P3 using the configured source mapping." (failure: "Unknown source severity uses service default") · BR-021 "If no recognized source severity is available, the configured service default severity is used." · BR-022 "Source severity and current incident severity are stored as separate concepts."
- **Consequence:** `Alert.sourceSeverity` (raw) ≠ `Alert.initialSeverity` ≠ `Incident.severity` (current, later changed by `SLICE-05`). Mapping config location/format [UDR-18/OQ-004]. **Invalid:** creating an incident when neither mapping nor valid default exists → creation fails (BR-019 failure). **Class:** C.

## BR-024 / BR-039 — Source status separate from incident state
- **Canonical Rules:** BR-024 "A source alert changing from firing to resolved does not automatically move the IMS incident to RESOLVED." · BR-039 "Source alert state is stored separately from IMS incident state."
- **Consequence:** a resolved-status delivery updates Alert-side data and records `SOURCE_ALERT_RESOLVED`; never touches `Incident.status`. **Gap:** `Alert` has no source-status column in DBS [UDR-11]. **Class:** C.

## BR-025 — Multiple alerts processed independently
- **Canonical Rule:** "A single incoming request may contain multiple alerts, and each alert must be processed independently." (failure: "Invalid alert does not silently change another alert's data")
- **Consequence:** per-alert validation/identity/transaction [D from ADR-011 wording "newly accepted, non-duplicate alert … one PostgreSQL transaction"]; partial-success response [UDR-19]. **Class:** C.

## BR-012 — AI availability must not gate persistence
- **Canonical Rule:** "AI availability must not determine whether an authenticated alert is persisted as an incident." **Consequence:** no LLM call before commit; only an outbox row. **Class:** C.

## BR-001 — Incident belongs to exactly one team and one service
- **Canonical Rule:** "Every incident belongs to exactly one team and one service." (Enforcement: "Database relationships and service validation")
- **Consequence:** `Incident.teamId` is derived from the service's team (composite FK). **Class:** C.

---

# 5. Functional Behavior

**5.1 Ingest one alert (new)** — Trigger: verified request. Input: raw alert (one of N). Preconditions: source verified (03). Processing: (1) validate; (2) normalize → FR-037 fields; (3) resolve `affectedServiceId` [UDR-18]; (4) compute identity; (5) look up existing Alert by identity; (6) determine initial severity; (7) transaction: insert Alert (+`originalPayload`) → insert Incident (`OPEN`, `teamId` from service, `severity`=initial, `title`/`description` derived [UNK UDR-18]) → set `Alert.incidentId` → insert Outbox event(s) → insert audit events (`ALERT_RECEIVED`, `INCIDENT_CREATED`) [D from BR-009/DM invariant "Every successful Incident transition has an atomic AuditLog event"]; (8) commit; (9) respond. State change: ∅ → `OPEN`. Output: per-alert accepted result [UDR-19]. Failure: invalid → rejected, nothing written (BR-016).

**5.2 Duplicate delivery** — Identity found (or unique violation on insert) → no new Incident; record `ALERT_DUPLICATE` [C: event type exists] → success. Whether the duplicate is stored as a row or only as an audit event: DBS unique indexes forbid a second `Alert` row → **audit event only** [D]; UC-001 says "record/associate the duplicate alert" [UDR-01].

**5.3 Recurrence after incident resolved/closed** — [UNK: PRD/DBS conflict] [UDR-01].

**5.4 Source status update (firing→resolved)** — Identity found with source status RESOLVED → update the Alert's source-side data, record `SOURCE_ALERT_RESOLVED`; Incident untouched [C BR-024, AC-047]. Storage column [UDR-11].

**5.5 Multi-alert request** — Loop 5.1/5.2/5.4 independently; one alert's failure must not discard another's [C AC-044]. Response shape [UDR-19].

---

# 6. Acceptance Criteria

## AC-003 — Duplicate does not create a second unresolved incident
**Given:** alert X already produced incident I · **When:** X delivered again (sequentially or concurrently) · **Then:** exactly one Alert row and one Incident; response is success. **Verification:** sequential + 20-way concurrent test; assert row counts.
## AC-004 — Persist before AI
**Given:** AI provider down · **When:** valid alert arrives · **Then:** Alert+Incident committed; AI only via outbox job. **Verification:** integration test with provider mock failing; assert commit and no inline LLM call.
## AC-007 — Valid team/service
**Verification:** unknown service → rejected; composite FK prevents team/service mismatch.
## AC-038 / AC-048 — Payload retained
**Verification:** persisted `originalPayload` equals received JSON after normalization.
## AC-043 / AC-044 — Normalization; multi-alert
**Verification:** adapter golden tests; request with [valid, invalid, valid] → two incidents, one rejection recorded.
## AC-045 / AC-046 — Severity mapping/default
**Verification:** mapped value → expected P-level; unrecognized/missing → service default.
## AC-047 — Source resolution recorded, incident unchanged
**Verification:** deliver FIRING then RESOLVED; assert Incident.status still `OPEN` and `SOURCE_ALERT_RESOLVED` recorded.

---

# 7. Domain Model

## 7.1 Entities
| Entity | Role |
|---|---|
| Alert | Normalized + raw alert; identity; source-side status/timestamps |
| Incident | Created here as `OPEN`; thereafter owned by `SLICE-05` |
| Alert_Source | Provides source context/config (03) |
| Service/Team | Resolve team + default severity (02) |
| OutboxEvent | Atomic handoff record |
| AuditEvent | `ALERT_RECEIVED`, `ALERT_DUPLICATE`, `INCIDENT_CREATED`, `SOURCE_ALERT_RESOLVED` |

## 7.2 Relationships
AlertSource→Alert 0..N; Alert→Incident 0..1 (DM diagram) vs "exactly one" (DM invariant) vs `incidentId` nullable (DBS) — application-enforced [D, SD-09]; Incident→Alert 0..N; Alert→Service 1.

## 7.3 Invariants
| Invariant | Enforcement |
|---|---|
| Unique (source, eventId) / (source, fingerprint) | DB partial unique indexes |
| Incident team = service team | DB composite FK |
| Alert has `originalPayload` | DB NOT NULL |
| Every accepted alert has an incident | **Application/transaction** (column nullable) |
| ≤1 unresolved incident per identity | Transaction + unique index (resolved-state semantics UDR-01) |

## 7.4 State Machine
Incident: `∅ → OPEN` **(owned here)**. `OPEN → …` owned by `SLICE-05`. Alert source state `FIRING → RESOLVED` (DM/PRD) — owned here; persisted form [UDR-11].

---

# 8. Architectural Context

## 8.1 Relevant Architecture
ARCH sync flow: Source Authentication → Alerts (Validate, Normalize, Identify, Deduplicate) → "PostgreSQL transaction: Alert, Incident, Outbox Event" → Commit → HTTP Response. Async (after commit): Outbox → BullMQ → workers.

## 8.2 Components
| Component | Responsibility |
|---|---|
| Controller | Receive request after gate |
| Source adapter | Source-specific validate/normalize [C PRD §10] |
| Ingestion service | Orchestrate steps; own the transaction |
| Alert repository | Alert insert/lookup; participates in tx |
| Incident repository (Incident module) | `createIncident(tx, …)` |
| Outbox/Audit writers | insert within tx |

## 8.3 Constraints
One local PG transaction for Alert+Incident+Outbox [C ADR-011/RD-043]; "Alert and Incident remain separate ownership boundaries; the transaction is an explicit cross-module consistency requirement" [C ADR-011]. Workers/API use the Supabase transaction pooler (port 6543): no session-level features [C ARCH DB Connection Strategy] — interactive Prisma transactions must be compatible [D].

## 8.4 Relevant ADRs
- **ADR-011** — dedup identity + atomic Alert/Incident/Outbox. **Why here:** this is the capability.
- **ADR-009** — outbox in the same tx. **ADR-012** — AI async/advisory. **ADR-002/003** — relational integrity, row-level locking. **ADR-014** — consumers idempotent (downstream).

**Source inconsistency (SD-03):** ARCH "Synchronous Request Flow" lists "Alert module --AI Module--> Incident module"; this conflicts with FR-007/ADR-012 (AI async). This slice treats async as canonical [D].

---

# 9. Dependency Model
## 9.1 Upstream
| Slice | Type | Requires |
|---|---|---|
| 03 | SYNC | verified source context |
| 02 | SYNC READ | service, team, `defaultSeverity` |
| 06 | SYNC (in-tx) | `appendAuditEvent(tx, …)` contract |
| 08 | SCHEMA | `OutboxEvent` table/contract |
## 9.2 Downstream
| Slice | Relationship | Provides |
|---|---|---|
| 10 | EVENT | triage job trigger (via outbox) |
| 05 | DATA | Incident in `OPEN` |
| 07 | EVENT/DATA | SLA clock start = `Incident.createdAt` (scheduling trigger UDR-13) |
| 09 | EVENT | creation notification "as applicable" (UC-001) [UDR-14] |
## 9.3 Contract
**Allowed:** Incident repository's creation method; audit/outbox writer functions. **Forbidden:** Alerts module updating incident status/severity/assignment after creation; any LLM call inside the transaction.

---

# 10. Slice Coupling Analysis
## 10.1 Transactional — **YES (hard)** with the Incident creation write and Outbox insert (ADR-011/RD-043). **KEEP TOGETHER** the creation transaction here.
## 10.2 Synchronous — **YES** with 02 (config read) and 03 (gate).
## 10.3 Shared Invariants — **YES**: "≤1 unresolved incident per identity" is jointly guaranteed by Alert unique indexes and Incident creation. Ownership: **this slice** [D].
## 10.4 Summary
| Related Slice | Coupling | Strength | Boundary Decision |
|---|---|---|---|
| 05 (Incident) | Transaction at creation | Hard | KEEP creation transition here; later transitions SEPARATE |
| 03 | Sync | Hard(flow)/Soft(data) | SEPARATE |
| 02 | Sync read | Soft | SEPARATE |
| 06 | In-tx contract | Medium | SEPARATE via narrow function |
| 08/10 | Event | Loose | SEPARATE |
### Boundary Decision
The ∅→OPEN transition is owned here because the same transaction must create Alert, Incident and Outbox; splitting it would create ambiguous ownership.

---

# 11. Data Model
## 11.1 Tables — `Alert`, `Incident` (insert only), `OutboxEvent` (insert), `AuditEvent` (insert via contract).
## 11.2 Relevant Fields — FR-037 → columns
| FR-037 concept | Column | Required? |
|---|---|---|
| source | `alertSourceId` | Yes |
| source event ID | `sourceEventId` | No |
| source fingerprint / generated identity | `sourceFingerprint` | No |
| alert name | `name` | No |
| service | `affectedServiceId` | Yes |
| environment | `environment` | Yes |
| source severity | `sourceSeverity` | No |
| (initial severity) | `initialSeverity` | No (CHECK P0–P3) |
| summary / description | `summary`, `description` | No |
| labels | `labels text[]` | No |
| annotations/additional details | `additionalDetails text` | No |
| start / end time | `startedTimestamp` (Yes) / `endedTimestamp` | — |
| source URL | `sourceUrl` | No |
| original payload | `originalPayload jsonb` | Yes |
| source status (PRD §9) | **no column** | [UDR-11] |
| incident link | `incidentId` (nullable FK) | — |
Incident insert fields: `title` NOT NULL, `description` NOT NULL (derivation from alert: [UNK UDR-18]), `severity` NOT NULL, `status` default OPEN, `affectedServiceId`, `teamId`.
## 11.3 Constraints
`UNIQUE(alertSourceId, sourceEventId) WHERE sourceEventId IS NOT NULL`; `UNIQUE(alertSourceId, sourceFingerprint) WHERE sourceFingerprint IS NOT NULL`; Incident `FOREIGN KEY (affectedServiceId, teamId) → AppService(id, teamId)`; `CHECK` severity/status.
## 11.4 DB Invariants — duplicate-identity prevention; team/service consistency; payload presence.
## 11.5 Migration Requirements
- DBS DDL creates `Alert` (FK→`Incident`) *before* `Incident` — reorder or defer FK (SD-02).
- No check that an alert has *some* identity (both `sourceEventId` and `sourceFingerprint` nullable) [D: app-enforced per BR-033].
- Source status column [UDR-11]; possible index for incident-by-identity lookups [P].

---

# 12. Transaction & Consistency Model
## 12.1 Boundary
```text
BEGIN
  INSERT Alert (identity, normalized fields, originalPayload)
  INSERT Incident (OPEN, severity=initial, teamId from service)
  UPDATE Alert.incidentId
  INSERT OutboxEvent (initial: AI triage etc. — catalog UDR-12)
  INSERT AuditEvent (ALERT_RECEIVED, INCIDENT_CREATED)   -- [D]
COMMIT   → then HTTP response
```
Per alert, not per request [D].
## 12.2 Atomic Operations — all five inserts. [C for Alert+Incident+Outbox; D for audit]
## 12.3 Isolation/Locking — unique partial indexes as the arbiter; isolation level [UNK] (default READ COMMITTED assumed — P).
## 12.4 Guarantees — no Incident without Alert/Outbox; no Alert without Incident (NFR-001, RD-043).
## 12.5 Failure — any failure rolls back everything (PRD §14 "Failed transaction rolls back…"); source may retry; no partial incident.

---

# 13. Idempotency & Concurrency
## 13.1 Idempotency
**Identity:** (`alertSourceId`, `sourceEventId`) or (`alertSourceId`, `sourceFingerprint`). **Duplicate request:** success without new incident. **Replay:** handled at gate (03) vs here: UDR-10. **Side-effect protection:** outbox row only inserted inside the winning transaction → duplicates produce no extra jobs.
## 13.2 Concurrency
**Race:** N concurrent identical alerts. **Protection:** unique partial index + transaction; loser catches unique violation → duplicate path. **Expected:** exactly 1 Alert, 1 Incident, 1 initial outbox set. **Required test:** parallel ingestion test (e.g., 20 concurrent) asserting counts.
**Race 2:** FIRING and RESOLVED deliveries concurrently → ordering [UNK].

---

# 14. API Surface — Preliminary
`PRELIMINARY — API CONTRACT NOT YET FROZEN`

| Candidate operation | Actor / Authz | Input concepts | Domain action / transition | Output | Failures | Idempotency / concurrency | Timing · Confidence · Missing |
|---|---|---|---|---|---|---|---|
| Ingest alerts (`POST /…alerts…`, shared endpoint with 03) | authenticated alert source | one or many raw alerts | normalize→dedup→create (∅→OPEN) | per-alert outcome: created / duplicate / source-resolved / rejected | validation failure, identity failure, unknown service | natural identity; unique index | sync, ≤5 s (NFR-004) · High · response envelope & status for partial success (UDR-19); service mapping (UDR-18); status codes |

No user-facing endpoints. Pagination/filtering: `[N/A]`. Async: AI triage/notification after commit.

---

# 15. Events, Queues & Side Effects
## 15.1 Events Produced
| Event | Producer | Payload | Consumer |
|---|---|---|---|
| Initial outbox event(s) (type names [UNK], UDR-12) | Ingestion tx | incidentId (+ref ids) [P] | 10 (AI triage); 09 (notification "as applicable", UC-001); 07 (SLA start, UDR-13) |
| Audit: `ALERT_RECEIVED`, `ALERT_DUPLICATE`, `INCIDENT_CREATED`, `SOURCE_ALERT_RESOLVED` | Ingestion | metadata [UNK] | 06 (timeline) |
## 15.2 Consumed — none.
## 15.3 Queue Jobs — none enqueued here; relay (08) publishes after commit [C].
## 15.4 Delivery Semantics — at-least-once downstream; consumers idempotent [C ADR-009/014].
## 15.5 External Side Effects — none inline [C ARCH "Failure/retry boundary"].

Distinction: **state change** (Alert, Incident) vs **event** (outbox row) vs **side effect** (AI call, email — async, elsewhere).

---

# 16. Security & Authorization
## 16.1 Authentication — source auth (03).
## 16.2 Authorization — source may submit alerts only. No user role involved [D].
## 16.3 Team Isolation — incident team derived from service team [C DBS]; an alert cannot target another team's service unless the source is allowed to — source↔team/service permission model [UNK, UDR-18].
## 16.4 Input Security — validate all payloads at the boundary [C §12.7]; size limit (03); treat payload as untrusted (later LLM prompt injection — see 10).
## 16.5 Sensitive Data — originalPayload may contain secrets/PII [D]; never log raw payload at INFO [P]; redaction before LLM [UDR-16].

---

# 17. Failure Modes
| Failure | Detection | Expected | State Impact | Retry? | Evidence |
|---|---|---|---|---|---|
| Invalid payload | validation | reject that alert; others continue | none | source resends | BR-016, BR-025 |
| No identity formable | identity step | reject | none | — | BR-033 |
| Unknown/invalid service | lookup/FK | reject | none | — | BR-001, AC-007 |
| No determinable severity | severity step | creation fails | none | — | BR-019 |
| Duplicate/race | unique violation | treat as duplicate; success | none | — | BR-037 |
| DB failure mid-tx | exception | rollback; 5xx | none | source retries | PRD §14 |
| Outbox insert fails | tx error | rollback whole alert | none | source retries | ADR-009 |
| AI/Redis/queue down | n/a at commit | ingestion unaffected | none | relay retries later (08) | BR-012 |
## Critical Failure Scenario
**What fails:** crash after DB commit, before HTTP response. **Must remain true:** one incident; source's retry deduplicates. **Recovery:** idempotent identity path.

---

# 18. Observability
- Logs: accepted/duplicate/rejected per alert with source, identity hash, incidentId; correlation ID; never raw secrets [C FR-034].
- Metrics: ingest latency (NFR-004), duplicates, rejections by reason, tx rollbacks. [P names]
- Audit events:
| Event | When | Transactional? |
|---|---|---|
| `ALERT_RECEIVED` | new alert accepted | Yes [D] |
| `INCIDENT_CREATED` | incident created | Yes [D] |
| `ALERT_DUPLICATE` | duplicate delivery | [UNK — own tx? UDR-01/05] |
| `SOURCE_ALERT_RESOLVED` | source resolved | Yes [D] |

---

# 19. Testing Strategy
- **Unit:** normalizer golden files; identity/fingerprint stability (BR-034: non-identity fields changing does not change identity); severity mapping/default.
- **Integration:** single-tx atomicity; rollback leaves no rows; unique-index behavior; composite FK.
- **API:** `BLOCKED — API CONTRACT NOT YET FROZEN`.
- **Authorization:** unauthenticated (03) → no rows.
- **Concurrency:** N parallel identical alerts → 1 Alert/1 Incident/1 outbox.
- **Idempotency:** duplicate sequential; duplicate after incident progressed; FIRING→RESOLVED.
- **Failure injection:** fail Outbox insert → whole transaction rolled back; kill after commit → retry dedups; AI mock down → ingestion still succeeds.
- **Regression:** `OPEN` incident shape consumed by 05/06/07.

---

# 20. Test ↔ Requirement Traceability
| Requirement | AC | Test(s) | Status |
|---|---|---|---|
| FR-004, BR-035/037 | AC-003 | concurrent duplicate test | NOT RUN |
| FR-006, BR-012 | AC-004 | provider-down persistence test | NOT RUN |
| BR-001/002 | AC-007 | FK/service validation test | NOT RUN |
| BR-018/038 | AC-038, AC-048 | payload retention test | NOT RUN |
| BR-016, FR-037 | AC-043 | normalization golden tests | NOT RUN |
| BR-025, FR-038 | AC-044 | multi-alert test | NOT RUN |
| BR-019–022 | AC-045, AC-046 | severity tests | NOT RUN |
| BR-024/039, FR-039 | AC-047 | source-resolved test | NOT RUN |
| RD-043 | (none explicit) | atomicity/rollback test | NOT RUN |
### Coverage Gaps
- No AC for recurrence after resolution (UDR-01); none for atomic rollback of Alert+Incident+Outbox beyond AC-016 (lifecycle) — add test mapped to RD-043/ADR-011.

---

# 21. Implementation Plan
## 21.1 Sequence
1. Decide UDR-01, 11, 18, 19 (and 12 for outbox types). 2. Alert/Incident/Outbox Prisma models. 3. Common alert DTO + one adapter. 4. Identity + severity services. 5. Ingestion transaction. 6. Duplicate/source-resolved paths. 7. Multi-alert handling. 8. Concurrency/failure tests.
## 21.2 Files
### CREATE
```text
src/alerts/ingestion/** · src/alerts/adapters/<source>/** · test/alerts/**
```
### MODIFY
```text
prisma/schema.prisma (Alert, Incident, OutboxEvent) · incident repository (create method)
```
### REVIEW ONLY
```text
ARCH ADR-009/011 · DBS Alert/Incident
```
## 21.3 Allowed — Alerts module; Incident repository *creation* method only.
## 21.4 Forbidden — Incident lifecycle logic; LLM calls; schema edits beyond approved UDR outcomes.
## 21.5 Must exist — 01, 02, 03, outbox table, audit write contract (06).

---

# 22. AI Agent Context
## 22.1 Read First
1. `AGENTS.md` 2. This slice 3. `PROJECT_STATE.md` 4. `TEST_STATUS.md` 5. `SESSION_CHECKPOINT.md` 6. ARCH sync flow + ADR-009/011 7. DBS `Alert`, `Incident`, `OutboxEvent`
## 22.2 Relevant Canonical Context
| Topic | Source | Location |
|---|---|---|
| Requirement | PRD | UC-001, FR-003–006/030/037–039, BR-016–025/032–039 |
| Domain | DM | Alert, Incident rows |
| Architecture | ARCH | ADR-009, ADR-011, ADR-012 |
| Database | DBS | Alert unique indexes; Incident composite FK |
| API | — | not frozen |
## 22.3 Agent Objective
Implement the ingestion pipeline and its single transaction exactly per ADR-011/RD-043; do not decide duplicate-recurrence semantics (UDR-01) or service mapping (UDR-18) yourself.

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
- Transaction boundary: why Alert+Incident+Outbox commit together and nothing external happens before commit.
- Idempotency via DB unique index vs read-then-create (race).
- Why raw payload ≠ identity (BR-034).
- Outbox pattern and at-least-once consequences.
## 23.2 SHOULD UNDERSTAND
- Partial unique indexes (`WHERE … IS NOT NULL`).
- Handling unique-violation inside a Prisma interactive transaction (and the pooler limits).
## 23.3 CAN DEFER
- Multi-source adapter registry.
## 23.4 Mental Model
A one-way door: either the alert fully exists with its incident and handoff note, or nothing does. Repeat knocks are recognized by identity and politely ignored.
## 23.5 First-Principles Questions
1. Why not read-then-create? 2. What breaks if the outbox row is written after commit? 3. What does a duplicate mean after the incident is resolved? 4. Why must source severity and incident severity be separate? 5. Why is AI excluded from this path?
## 23.6 Interview Questions
### Design
1. Design webhook-to-incident ingestion that is duplicate-safe under concurrency.
### Debugging
1. Two incidents exist for one alert — what are the possible causes?
### Failure Handling
1. DB commits but the response is lost — what happens?
### Architecture
1. Why is a cross-module transaction acceptable here in a modular monolith?

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
- [ ] 20-way concurrent duplicate test passes (exactly one Alert + Incident + outbox set)
- [ ] Rollback test: forced outbox failure leaves zero rows
- [ ] UDR-01, 11, 18, 19 decided and recorded in canonical docs

---

# 25. Current Implementation Status

**Status:** `PLANNED` — DESIGN / PRE-IMPLEMENTATION (no implementation claimed)

### Completed
- None.

### In Progress
- None.

### Remaining
- Entire slice (blocked on UDR-01, UDR-11, UDR-18, UDR-19)

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
Additional source adapters; suppression/correlation (PRD §16).
## Extension Points
Adapter interface per `sourceType`; identity strategy per source.
## Known Limitations
Recurrence semantics undefined; no source-status column.
## Deliberately Not Generalized
Single representative source; no alert correlation.
## Potential Breaking Changes
Changing identity rules affects dedup history; changing outbox payload affects 07/09/10.

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
- [ ] ADR-011 consistency boundary verified by an automated rollback test.

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
