# IMS Capability Slices — Index, Cross-Slice Review & Human Design Gate

**Version:** 0.2 · **Status:** DESIGN / PRE-IMPLEMENTATION  
**Purpose:** single design gate for capability-slice boundaries and unresolved cross-slice decisions.

## Authority

Canonical project documents remain authoritative:

- `PRD.md`
- `Architecture.md`
- `Domain_Model.md`
- `DB_Schema.md`

`API.md` is now the **finalized API reference** and its resolved decisions are ingested here where they answer an Index decision.

### Decision-source rule

- **Canonical docs** define product/domain/architecture intent.
- **Final `API.md`** defines the finalized API-facing decisions already made through the eight API-question rounds.
- This Index records what is **resolved**, what remains **open**, and where the human must make the next decision.
- Do **not** ask the user again for a decision already explicitly answered in the eight API-question documents.
- Do **not** infer an answer merely because an API detail looks compatible with a question.
- If only part of an old question was answered, split it: ingest the answered part and leave only the unanswered part below.
- New questions discovered later must be added under **Remaining Open Questions** with a new `IDX-nn` ID. Do not reopen a resolved API decision unless a canonical conflict requires it.

---

# 1. Capability Inventory

| ID  | Capability                                      | Purpose                                       | Main Entities                       | MVP? |
| --- | ----------------------------------------------- | --------------------------------------------- | ----------------------------------- | ---- |
| 01  | Identity, Authentication & Team Isolation       | authentication, authorization, team fence     | User, Team, UserSession             | Yes  |
| 02  | Service Catalog, SLA Config & Escalation Policy | service, SLA and responder configuration      | AppService, EscalationPolicy        | Yes  |
| 03  | Alert Source Trust Gate                         | source authentication, replay, rate/size gate | AlertSource                         | Yes  |
| 04  | Alert Ingestion, Dedup & Incident Creation      | normalize, identify, dedup, create incident   | Alert, Incident                     | Yes  |
| 05  | Incident Lifecycle & Assignment                 | acknowledge, severity, assignment, resolve    | Incident                            | Yes  |
| 06  | Incident Visibility, Comments & Timeline        | reads, comments, audit/timeline               | Comment, AuditEvent                 | Yes  |
| 07  | SLA Monitoring & Escalation                     | SLA evaluation and escalation                 | SLA/Incident/Policy                 | Yes  |
| 08  | Outbox, Queue & Worker Reliability              | outbox, BullMQ, retry, DLQ                    | OutboxEvent                         | Yes  |
| 09  | Notification Delivery                           | async notification delivery                   | Notification                        | Yes  |
| 10  | AI Alert Triage                                 | advisory AI triage                            | AI triage result                    | Yes  |
| 11  | Postmortem, Review & Closure                    | postmortem and atomic closure                 | Postmortem, Incident                | Yes  |
| 12  | AI Investigation & Evaluation Harness           | evidence-grounded investigation/evaluation    | Investigation, Evidence, Evaluation | Yes  |

---

# 2. Decisions Ingested from Final API

The following are **closed** because the answer is explicitly represented in the finalized `API.md` and/or its eight resolved API-question rounds.

## 2.1 Identity / authentication

### API-01 — Authentication mechanism

**Resolved.**

- User APIs use JWT access tokens.
- Access-token lifetime: **15 minutes**.
- Refresh token lifetime: **7 days**.
- Refresh token is delivered only through the `ims_refresh_cookie`.
- Access token is delivered in the `Authorization` response header.
- `sessionId` participates in the session model.
- Login, refresh, logout and logout-all are explicit API operations.
- Changes to user role, team, password or status revoke all sessions in the same transaction.
- Protected-request authorization trusts the JWT until expiry; database state is reflected after refresh/re-login/session revocation.

**Remaining from old question:** password-hashing algorithm itself is not specified by the finalized API.

### API-02 — Cross-team access

**Resolved.**

Cross-team resource access uses:

`403 TEAM_ACCESS_DENIED`

The API does not use a read-404/write-403 split.

### API-03 — Admin team scope

**Resolved.**

- Admin may administer any team for identity/service/policy administration.
- Incident data is limited to the Admin's own team.
- Incident-scoped endpoints use the caller's `teamId`.
- A user with `teamId = null` receives `403 INVALID_ACTION` on incident-scoped endpoints.

### API-04 — Team-lead / leadId integrity

**Resolved by API.**

- `leadId` must reference an `ACTIVE TEAM_LEAD` of the same team.
- `leadId` is not allowed for an Admin.
- Engineer → Team Lead clears `leadId`.
- Team changes clear `leadId`.
- The API explicitly defines the relevant role/team/status validation.

### API-05 — User deactivation effects

**Resolved by API.**

- Deactivation revokes all sessions.
- Existing incident assignments are not automatically changed.
- Escalation policies are not automatically edited.
- A policy referencing a deactivated responder can fail at runtime.
- Login/refresh of a deactivated user returns `403 ACCOUNT_DEACTIVATED`.

---

## 2.2 Service / escalation policy

### API-06 — Escalation policy shape

**Partially resolved.**

Resolved:

- Exactly **one escalation policy per service**.
- Policy is created inline with service creation.
- Four responder positions exist:
  - `level1`
  - `level2`
  - `level3`
  - `fallbackAdmin`
- Policy is never deleted/replaced through the API.
- A second creation attempt returns `409 POLICIES_MAX_LIMIT_REACHED`.
- Policy changes are blocked while the service has unresolved incidents.

**Still open:** any separate inter-responder timing/delay semantics not specified by `API.md`.

### API-07 — Policy responder validity

**Resolved.**

- `level1`, `level2`: ACTIVE ENGINEER of the service's team.
- `level3`: ACTIVE TEAM_LEAD of the service's team.
- `fallbackAdmin`: ACTIVE ADMIN.
- Invalid references return `403 INVALID_ACTION`.

### API-08 — SLA configuration validity/change semantics

**Resolved where API-defined.**

- SLA values are positive integers.
- For every severity: `resolution >= response`.
- Validation is performed on the merged stored + submitted values.
- Changing SLA configuration while unresolved incidents exist returns `409 SERVICE_HAS_OPEN_INCIDENTS`.
- Severity changes use the latest severity's configured thresholds.
- The SLA clock is not reset by a severity change.
- SLA status is computed from `incident.createdAt + current severity threshold`.

**Still open:** worker scheduling/catch-up/once-only persistence details belong to the remaining SLA/worker design gate below.

---

## 2.3 Alert source / ingestion

### API-09 — Representative source

**Resolved for the API boundary.**

- MVP webhook source is a seeded `AlertSource`.
- The webhook uses a common alert wire format for the implemented `GENERIC` source.
- Real source-specific adapters can be added later.
- There is **no AlertSource CRUD API** in the finalized API.
- Sources are seeded/out-of-band configured.

### API-10 — Source authentication and replay

**Resolved.**

- HMAC-SHA256.
- Signature covers `"<X-Timestamp>.<raw body>"`.
- Timestamp tolerance: ±300 seconds.
- Replay signatures are stored in Redis.
- Replay detection returns `409 REPLAY_DETECTED`.
- Exact same signed request is a replay.
- A freshly signed duplicate alert is accepted and deduplicated.
- Source is identified by `alertSourceId`.
- Signing secrets are never returned.

### API-11 — Replay vs valid duplicate

**Resolved.**

- Same signed request → `409 REPLAY_DETECTED`.
- Freshly signed request with an already-known alert identity → accepted as a duplicate.
- Alert identity uses source + source event ID, source fingerprint, or deterministic normalized fields.
- Whole-payload hashing is explicitly not used.

### API-12 — AlertSource administration

**Resolved at API scope.**

There is no AlertSource CRUD endpoint. Sources are seeded/out-of-band configuration.

### API-13 — Rate limiting when Redis is down

**Not resolved by API.**

The API defines rate limits and `503 DEPENDENCY_UNAVAILABLE`, but does not settle the precise fail-open/fail-closed behavior of the rate limiter when Redis is unavailable.

---

## 2.4 Alert ingestion / incident creation

### API-14 — Alert recurrence after resolution

**Resolved.**

- Identity uniqueness applies only while the matching incident is unresolved.
- Duplicate against an unresolved incident → duplicate.
- After `RESOLVED` or `CLOSED`, the same identity creates a **new incident**.
- Concurrent creation is resolved by the database uniqueness mechanism.

### API-15 — Alert → service / source permission

**Resolved at API level.**

- Incoming alert carries `serviceId`.
- Service must exist and be ACTIVE.
- Incident team is derived from `service.teamId`.
- Webhook caller cannot choose an arbitrary team.
- Source itself is not assigned a team in the API contract.

### API-16 — Source severity mapping

**Partially resolved.**

The finalized API defines:

- `sourceSeverity` as source-provided text.
- `initialSeverity` as the resulting P0–P3 incident severity.
- AI triage is advisory and does not autonomously change severity.
- Severity can subsequently be changed through the incident lifecycle.

**Still open:** the exact persistent configuration/algorithm for source-severity → P0–P3 mapping.

### API-17 — Incident title/description derivation

**Resolved sufficiently for API input.**

The normalized alert contains `name`, `summary`, and `description`, and the resulting incident exposes title/description.

**Still open only if implementation needs a more exact field-precedence rule than the API currently states.**

### API-18 — Multi-alert request semantics

**Resolved.**

- Batch contains 1–100 alerts.
- Each alert is processed independently.
- Each alert has its own transaction.
- Partial success returns per-alert results.
- If all alerts are rejected, HTTP `400` is returned with the same results body.
- Rate-limited batch items use item-level `RATE_LIMITED`.

---

## 2.5 Incident lifecycle

### API-19 — Assignment model

**Resolved.**

- Assignment/reassignment/unassignment is synchronous incident lifecycle work.
- Team Leads and Admins may assign/reassign/unassign.
- Engineers cannot assign.
- Assignment is not implicitly performed merely because an incident is acknowledged.
- Escalation semantics are reflected in the finalized incident/SLA API and do not introduce an independent assignment API.

### API-20 — Incident lifecycle authorization

**Resolved.**

The finalized API defines:

- acknowledgement by allowed roles;
- severity confirmation/change rules;
- assignment by Team Lead/Admin;
- resolve-by-assignee restriction for Engineer;
- escalation-chain authorization;
- explicit state guards;
- row locking and re-check under the lock.

### API-21 — Cross-slice concurrency semantics

**Resolved.**

- Incident commands lock the incident row.
- State is re-checked under the lock.
- First committed request wins.
- Race losers receive the relevant `409`.
- State change + audit + outbox are committed atomically.

### API-22 — RESOLVED → CLOSED ownership/path

**Resolved.**

Closure occurs atomically with postmortem approval:

- postmortem is reviewed;
- incident becomes CLOSED;
- audit events are written in order;
- outbox event is written in the same transaction.

There is no separate close endpoint.

---

## 2.6 Audit / timeline

### API-23 — Canonical incident event vocabulary

**Resolved for the API timeline.**

The finalized API defines the event vocabulary, including:

`ALERT_RECEIVED`, `ALERT_DUPLICATE`, `AI_TRIAGE_COMPLETED`, `ASSIGNED`, `REASSIGNED`, `INCIDENT_CREATED`, `ACKNOWLEDGED`, `SEVERITY_CONFIRMED`, `COMMENT_ADDED`, `SLA_WARNING`, `ESCALATED_L1..L4`, `SOURCE_ALERT_RESOLVED`, `RESOLVED`, `NOTIFIED`, `POSTMORTEM_GENERATED`, `POSTMORTEM_REVIEWED`, `AI_INVESTIGATION_COMPLETED`, `CLOSED`, `OPEN`.

**Still open:** whether/how security-relevant non-incident administrative actions are represented in the audit store.

---

## 2.7 AI triage / postmortem / investigation

### API-24 — AI triage output contract

**Resolved at API level.**

`AiTriage` contains:

- `PENDING | COMPLETED | UNAVAILABLE`
- category
- suggested severity
- confidence 0–1
- evidence
- reasoning summary
- model
- model version
- generated timestamp

It is advisory and never directly changes incident state.

**Still open:** exact persistent storage implementation for the triage result if required beyond the API representation.

### API-25 — Postmortem failure/manual path

**Resolved.**

- AI postmortem generation is asynchronous.
- Failure does not reopen or invalidate RESOLVED.
- Failed generation is retryable.
- A manual postmortem path exists.
- Manual postmortem can be created after generation failure.
- Approval closes the incident atomically.

### API-26 — Investigation request model

**Resolved at API level.**

- Investigation is asynchronous.
- First request returns `202`.
- `Idempotency-Key` is required.
- Key is globally unique.
- Same key + same incident + same user returns the existing investigation.
- Failed investigation is terminal; retry uses a new key.
- Status: `REQUESTED | RUNNING | COMPLETED | FAILED`.
- Evidence is linked to the investigation.
- Investigation never changes incident state/severity/assignment.

**Still open:** knowledge-source/retrieval definition, retention, and evaluation-harness semantics.

---

# 3. Remaining Open Questions

Only questions that were **not actually resolved by the eight API-question rounds/final API** belong here.

These are the questions to answer manually. Do not re-answer anything from Section 2.

## OPEN-01 — Password hashing algorithm

**Owner:** Slice 01  
**Source:** old UDR-09 / final API leaves hashing algorithm unspecified.

**Question:**  
Which password-hashing algorithm and parameters are required for the MVP?

**Answer:**
Argon2 password-hashing algorithm used. No parameters needed, use default configs.

>

---

## OPEN-02 — Inter-responder escalation timing

**Owner:** Slice 02 / Slice 07

**Question:**  
Is there a separate delay between escalation levels, and if so, where is that timing configured and how does it interact with response-SLA breach timing?

**Answer:**
No, not in MVP.

>

---

## OPEN-03 — Source-severity → P0–P3 mapping

**Owner:** Slice 04

**Question:**  
Where is source-severity mapping configured, what mappings exist, and what happens for an unrecognized source severity?

**Answer:**

- Map below config to existing ones.
  "critical" → P0
  "high" → P1
  "warning" → P2
  "info" → P3

- If unrecognized, we fallback to default severity of a service.

>

---

## OPEN-04 — Exact incident title/description derivation

**Owner:** Slice 04

**Question:**  
What is the exact precedence/derivation rule when `name`, `summary`, and `description` from the normalized alert are combined into `Incident.title` and `Incident.description`?

**Answer:**

- Incident.title = `name`
- Incident.description = `description` + `summary`

>

---

## OPEN-05 — Audit coverage for non-incident administrative actions

**Owner:** Slice 06

**Question:**  
Which security-relevant administrative actions must create audit records?

Examples to decide explicitly:

- user create/update/deactivate;
- team create/update/deactivate;
- service create/update/deactivate;
- escalation-policy create/update;
- AlertSource configuration changes, if any are recorded outside seed/configuration.

**Answer:**

- User / Team / Service / Escalation policy : Update / deactivate
- AlertSource: Update (config change)

>

---

## OPEN-06 — SLA evaluation scheduling and catch-up

**Owner:** Slice 07

**Question:**  
What is the authoritative SLA scheduling mechanism?

Choose/define:

- delayed per-incident jobs;
- periodic scanner;
- outbox-triggered scheduling;
- hybrid.

Also define how overdue SLA work is recovered after worker/Redis downtime.

**Answer:**

- We will use a hybrid approach:
  Primary:
  delayed BullMQ jobs

Safety net:
periodic PostgreSQL scanner

- This approach helps recovery with precision.

>

---

## OPEN-07 — Once-only SLA milestone recording

**Owner:** Slice 07

**Question:**  
How is once-only processing guaranteed for:

- 80% response warning;
- 80% resolution warning;
- response breach;
- resolution breach;
- each escalation level;
- escalation failure?

**Answer:**

- Use a unique idempotency key.
- Enforced at application layer + DB layer.

- Consider below setup:

| SLA action             | Possible idempotency identity             |
| ---------------------- | ----------------------------------------- |
| 80% response warning   | `incidentId + RESPONSE_WARNING`           |
| 80% resolution warning | `incidentId + RESOLUTION_WARNING`         |
| Response breach        | `incidentId + RESPONSE_BREACH`            |
| Resolution breach      | `incidentId + RESOLUTION_BREACH`          |
| Escalation level 1     | `incidentId + ESCALATION_LEVEL_1`         |
| Escalation level 2     | `incidentId + ESCALATION_LEVEL_2`         |
| Escalation failure     | `incidentId + ESCALATION_FAILURE + level` |

>

---

## OPEN-08 — SLA milestone audit/notification coverage

**Owner:** Slice 07 / Slice 09

**Question:**  
Exactly which SLA milestones create audit/timeline events and exactly which create notifications?

**Answer:**

| SLA milestone          | Audit event?      | Notification? |
| ---------------------- | ----------------- | ------------- |
| 80% response warning   | Yes (SLA_WARNING) | Yes           |
| 80% resolution warning | Yes (SLA_WARNING) | Yes           |
| Response breach        | No                | Yes           |
| Resolution breach      | No                | Yes           |
| Escalation L1          | Yes               | Yes           |
| Escalation L2          | Yes               | Yes           |
| Escalation L3          | Yes               | Yes           |
| Escalation L4          | Yes               | Yes           |
| Escalation failure     | No                | Yes           |

>

---

## OPEN-09 — Escalation chain progression after invalid/deactivated responder

**Owner:** Slice 07

**Question:**  
When a configured responder is invalid/deactivated at execution time, what exact behavior occurs?

Define:

- failure event;
- whether the level is considered consumed;
- whether the next level is attempted immediately;
- whether fallback is attempted;
- whether the incident remains otherwise unchanged.

**Answer:**

- Failure event - ESCALATION_FAILED.
- Is that escalation level finished? - Yes
- Do we immediately try the next level? - Yes
- Do we try the fallback Admin? - Yes, if it's next in chain.
- Does anything else about the incident change?- only escalation/notification state is affected.

>

---

## OPEN-10 — Outbox event catalog

**Owner:** Slice 08

**Question:**  
What is the canonical outbox event catalog, including:

- event type;
- payload;
- producer;
- consumer;
- routing;
- idempotency identity;
- whether the event is mandatory or optional?

**Answer:**
<COME BACK AGAIN>

>

---

## OPEN-11 — Outbox relay/status/retention model

**Owner:** Slice 08

**Question:**  
Define:

- how pending outbox rows are claimed;
- transaction/locking mechanism;
- status values;
- retry ownership;
- processed-row retention/deletion;
- behavior after a relay crash.

**Answer:**

>

---

## OPEN-12 — Retry classification and DLQ

**Owner:** Slice 08

**Question:**  
Define the common worker policy:

- maximum attempts;
- backoff;
- retryable errors;
- non-retryable errors;
- terminal failure state;
- DLQ representation;
- inspect/re-drive mechanism.

**Answer:**

>

---

## OPEN-13 — Redis / queue loss and recovery

**Owner:** Slice 08

**Question:**  
If Redis/BullMQ becomes unavailable or is wiped:

- what work is recoverable from PostgreSQL/outbox;
- what work is lost;
- how delayed SLA jobs are reconstructed;
- how notifications/AI/postmortem/investigation jobs are recovered;
- whether any Redis-only state is intentionally ephemeral.

**Answer:**

>

---

## OPEN-14 — Notification event catalog

**Owner:** Slice 09

**Question:**  
Exactly which domain events generate notifications, and what notification severity/type does each use?

**Answer:**

>

---

## OPEN-15 — Notification recipient resolution

**Owner:** Slice 09

**Question:**  
For every notification event, define the exact recipient rule:

- current assignee;
- assignee's lead;
- service policy `level3`;
- fallback Admin;
- all active Team Leads;
- behavior when no assignee exists;
- resolve recipient at enqueue time or send time.

**Answer:**

>

---

## OPEN-16 — Notification record/idempotency model

**Owner:** Slice 09

**Question:**  
Define:

- one Notification row per recipient vs recipient collection;
- idempotency-key derivation;
- producer vs worker creation;
- retrying vs FAILED representation;
- duplicate notification prevention.

**Answer:**

>

---

## OPEN-17 — LLM data boundary / redaction

**Owner:** Slices 10, 11, 12

**Question:**  
What IMS data may be sent to the LLM, what must be redacted/excluded, and what provenance must be stored?

**Answer:**

>

---

## OPEN-18 — AI triage persistence

**Owner:** Slice 10

**Question:**  
Where is the triage result persisted so that the API's `aiTriage` representation survives process restart and can be audited?

Define:

- persistence structure;
- lifecycle/status;
- retry;
- failure representation;
- relation to Incident/Alert.

**Answer:**

>

---

## OPEN-19 — Investigation knowledge sources and retrieval

**Owner:** Slice 12

**Question:**  
Which records are eligible as investigation evidence, how are they retrieved, where do runbooks live, and whether only reviewed postmortems are eligible?

**Answer:**

>

---

## OPEN-20 — Investigation retention

**Owner:** Slice 12

**Question:**  
How long are investigation results and evidence retained?

**Answer:**

>

---

## OPEN-21 — Evaluation harness

**Owner:** Slice 12

**Question:**  
Define:

- whether evaluation fixtures live only in the repository or also in the database;
- what is evaluated;
- retrieval relevance definition;
- evidence validity definition;
- output validity definition;
- evaluation execution/reporting format.

**Answer:**

>

---

# 4. New Questions Discovered During Manual Review

Use this section for questions that were **not present in the old Index and were not answered by the API rounds**.

Do not duplicate an existing question. If a new question is actually a sub-question of an existing `OPEN-*`, add it there instead.

## IDX-01 — [TITLE]

**Owner:**  
**Affected slices:**  
**Why it matters:**  
**Evidence/source:**

**Question:**

>

**Answer:**

>

**Status:** OPEN

---

# 5. Decision Record Format

When answering an open question, use exactly this structure:

```markdown
## OPEN-XX — <title>

**Decision:** <one unambiguous decision>

**Rules:**

1. <rule>
2. <rule>
3. <rule>

**Exceptions:**

- <exception or N/A>

**Affected slices:** <slice IDs>

**Implementation consequence:** <only if the decision creates one>

**Status:** RESOLVED
```

If the answer intentionally leaves something implementation-defined:

```markdown
**Implementation-defined:** <what remains flexible>

**Invariant that must still hold:** <non-negotiable requirement>
```

Do not use vague answers such as:

- "handle appropriately"
- "as needed"
- "standard approach"
- "reasonable"
- "TBD"

unless the exact implementation-defined boundary is explicitly stated.

---

# 6. Slice Readiness

A slice can move to **READY FOR SLICE SPEC** only when:

- all questions owned by that slice are `RESOLVED`, or explicitly marked `N/A`;
- no unresolved dependency from another slice blocks it;
- no canonical source conflict affecting its boundary remains unowned;
- its transaction boundary is understood;
- its synchronous dependencies are understood;
- shared invariants are owned by exactly one slice;
- the finalized API decisions relevant to the slice are already reflected.

| Slice | Status  | Blocking Questions  |
| ----- | ------- | ------------------- |
| 01    | CLOSED  | OPEN-01             |
| 02    | CLOSED  | OPEN-02             |
| 03    | PARTIAL | OPEN-13             |
| 04    | CLOSED  | OPEN-03, OPEN-04    |
| 05    | READY\* | —                   |
| 06    | CLOSED  | OPEN-05             |
| 07    | CLOSED  | OPEN-06–09          |
| 08    | OPEN    | OPEN-10–13          |
| 09    | OPEN    | OPEN-14–16          |
| 10    | OPEN    | OPEN-17–18          |
| 11    | OPEN    | OPEN-17             |
| 12    | OPEN    | OPEN-17, OPEN-19–21 |

`*` Recheck against canonical design conflicts before freezing the slice.

---

# 7. Boundary Review

The existing slice boundaries remain the working boundaries unless one of the remaining decisions proves a hard coupling.

A boundary must be reconsidered only if the unresolved decision shows that two capabilities:

- must share the same transaction;
- must perform inseparable synchronous internal operations;
- jointly enforce an invariant that cannot be owned by one slice;
- or require shared mutable state that makes the separation misleading.

Do **not** merge slices merely because they communicate.

---

# 8. Resolution Workflow

Use this sequence:

```text
1. Resolve remaining OPEN questions for one slice
        ↓
2. Update this Index
        ↓
3. Freeze that slice's boundary/decisions
        ↓
4. Generate the permanent capability-slice specification
        ↓
5. Implement the slice
        ↓
6. Verify against canonical docs + API.md + slice spec
        ↓
7. Move to the next slice
```

### Important

The API-question rounds are **closed history**.

Do not ask the user to answer those questions again.

This Index is now the place for the **remaining non-API design decisions only**.
