# Incident Management System (IMS)

**Status:** Revised Draft

**Scope:** MVP

**Audience:** Internal engineering / portfolio project

**Created on:** 17th Sept\'2026

**Last updated on:** 19th Sept 2026

---

## 1. Problem

Production systems generate operational alerts from monitoring systems. Different alert sources can provide different fields, severity values, alert identifiers, and delivery formats. IMS must convert supported alerts into a common format before applying its incident workflow.

Engineering teams need a shared way to receive authenticated alerts, record incidents, coordinate response, track service impact, and preserve what happened.

Without a consistent workflow, incident details and decisions can become scattered across alerts, chat, and individual notes. This creates manual work during incident response and makes it harder to identify recurring problems and improve the system over time.

When an incident resembles a previous failure, engineers also need a practical way to find relevant prior incidents, reviewed postmortems, runbooks, and investigation evidence without manually searching across separate records.

The MVP provides a focused incident lifecycle from authenticated alert ingestion through acknowledgement, mitigation, resolution, postmortem review, and closure.

---

## 2. Target Users

1. **Engineer:** Responds to assigned incidents, acknowledges incidents, confirms or updates severity, records comments, and resolves incidents.
2. **Team Lead:** Oversees incidents for the team, can acknowledge or manage incidents when required, manually assigns/reassigns responders, handles severity selection when AI is unavailable, and acts as the escalation fallback.
3. **Admin:** Manages users, teams, services, and escalation policies.

---

## 3. Goals

1. Maintain one authoritative, queryable incident record and lifecycle.
2. Ingest alerts from supported external alert sources through authenticated requests.
3. Convert alerts from different sources into a common internal format.
4. Deduplicate repeated alert deliveries without creating duplicate unresolved incidents.
5. Create and persist an incident before performing asynchronous AI triage so AI availability does not block incident ingestion.
6. Make ownership, severity, status, and incident history visible.
7. Ensure concurrent lifecycle operations preserve valid incident state and business rules.
8. Process asynchronous jobs and external actions safely across alert ingestion, queue processing, notifications, and postmortem generation.
9. Track two SLA types:
   - **Response SLA:** time allowed for an incident to be acknowledged.
   - **Resolution SLA:** time allowed for an incident to be resolved.
10. Generate an SLA warning at 80% of the applicable SLA window and escalate overdue incidents through the configured escalation policy.
11. Notify the assigned engineer and Team Lead about relevant incident events.
12. Preserve an append-only incident timeline and audit trail.
13. Add AI-assisted alert triage that:
    - classifies alert category,
    - suggests severity,
    - provides confidence,
    - provides supporting evidence.

14. Keep AI output advisory and require human confirmation for operational severity decisions.
15. Generate a structured AI postmortem draft after an incident is resolved, followed by human review before closure.
16. Preserve enough incident, alert, audit, notification, SLA, and AI information to support debugging, review, and post-incident learning.
17. Support external alert sources through a common internal alert format without changing the main incident workflow.
18. Preserve source-specific alert information and the original alert payload.
19. Map source-provided severity to the IMS P0-P3 severity model when a recognized source severity is available.
20. Provide an AI-assisted incident investigation capability that retrieves relevant recorded IMS knowledge and presents an evidence-grounded investigation brief to authorized users.
21. Evaluate AI investigation and retrieval behavior with a repeatable test set so changes can be checked for regressions.

---

## 4. Non-goals

- Replacing a full monitoring or alerting platform.
- Full on-call rotation scheduling.
- Real-time notifications using SSE/WebSockets.
- Multi-channel notification systems and fallback chains.
- Alert suppression or advanced alert-noise reduction logic.
- Dependency graphs and dependency-aware alert suppression.
- ChatOps commands that modify incidents.
- A public status page.
- Automated remediation.
- Autonomous severity changes.
- Supporting every external monitoring or alerting platform in the MVP.
- Building the monitoring or alert evaluation system itself.
- Multi-team membership for users.
- Multi-engineer collaborative incident handling within the same incident.
- Complex enterprise integrations.

---

## 5. User Stories

### Engineer

- As an Engineer, I can view incidents associated with my team so that I can understand incidents requiring my team's attention.
- As an Engineer, I can acknowledge an incident so that the system records who has taken responsibility for responding.
- As an Engineer, I can confirm or update the incident severity after reviewing the alert and incident context.
- As an Engineer, I can add comments to an incident so that investigation decisions and actions are preserved.
- As an Engineer, I can resolve an incident by providing a resolution summary and confirming that the affected service is working again.
- As an Engineer, I can review the incident timeline and escalation history so that I understand what happened before I became involved.
- As an Engineer, I can review and update the AI-generated postmortem draft before the incident is closed.
- As an Engineer, I can request an AI-assisted investigation brief so that relevant historical incidents, reviewed postmortems, runbooks, and other recorded IMS evidence can help guide investigation.
- As an Engineer, I can see the evidence used by an AI investigation brief so that I can distinguish recorded information from AI-generated suggestions.

### Team Lead

- As a Team Lead, I can view all incidents associated with my team.
- As a Team Lead, I can manually select or update severity when AI triage is unavailable.
- As a Team Lead, I can assign an incident to a responder.
- As a Team Lead, I can reassign an incident when ownership needs to change.
- As a Team Lead, I can unassign an incident when there is no suitable current assignee.
- As a Team Lead, I can acknowledge or otherwise manage an incident when required by the escalation process.
- As a Team Lead, I can review escalation and SLA status for incidents handled by my team.

### Admin

- As an Admin, I can create and manage users.
- As an Admin, I can create and manage teams.
- As an Admin, I can create and manage services.
- As an Admin, I can configure the escalation policy for a service.
- As an Admin, I can act as the final escalation fallback when an incident remains unacknowledged after the configured escalation chain.

### Alert Source

- As an authenticated alert source, I can submit an alert so that IMS can create or associate an incident.

### Engineering Team

- As an engineering team, I want alerts from supported external sources to automatically create or update incidents so that operational issues enter IMS without manual entry.
- As an engineering team, I want alerts from different sources to be converted into one common format so that the same incident workflow can be used for every supported source.

---

## 6. Functional Requirements

| ID     | Requirement                        | Description                                                                                                                                                                                                                                                                                                                                   |
| ------ | ---------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| FR-001 | Authenticated alert ingestion      | The system exposes authenticated ingestion endpoints for supported external alert sources.                                                                                                                                                                                                                                                    |
| FR-002 | Webhook replay protection          | Alert requests use the authentication and replay checks supported by the source, including signature, timestamp, and event ID validation where applicable.                                                                                                                                                                                    |
| FR-003 | Alert source identity              | The system identifies an external alert using the source and a stable source-provided alert identifier when available.                                                                                                                                                                                                                        |
| FR-004 | Alert deduplication                | Repeated delivery of the same alert is associated with an existing unresolved incident when one exists rather than creating another unresolved incident.                                                                                                                                                                                      |
| FR-005 | Initial severity                   | Every new incident has an initial severity. A recognized source severity is mapped to P0-P3; otherwise the service default severity is used.                                                                                                                                                                                                  |
| FR-006 | Incident persistence               | After authentication, validation, identity checks, and deduplication, the system persists the alert and incident before asynchronous AI triage begins.                                                                                                                                                                                        |
| FR-007 | Asynchronous AI triage             | AI triage runs asynchronously after incident persistence and does not block incident creation.                                                                                                                                                                                                                                                |
| FR-008 | AI triage output                   | AI triage classifies the alert category, suggests P0-P3 severity, provides confidence, and provides supporting evidence.                                                                                                                                                                                                                      |
| FR-009 | AI fallback                        | If AI triage is unavailable, the incident continues through the normal workflow and a Team Lead can select severity manually.                                                                                                                                                                                                                 |
| FR-010 | Incident record                    | Each incident has a unique ID, title, description, affected service, team, severity, status, assignment information, timestamps, alert reference, and timeline.                                                                                                                                                                               |
| FR-011 | Incident assignment                | A Engineer acknowledges a incident post notification. A Team Lead can assign an incident to a configured responder, in case no engineer acknowledges it within SLA window. The escalation worker can notify the next configured responder according to the escalation policy.                                                                 |
| FR-012 | Incident reassignment              | A Team Lead can reassign an incident. Engineers cannot assign or reassign incidents.                                                                                                                                                                                                                                                          |
| FR-013 | Incident unassignment              | A Team Lead can remove the current assignee from an incident.                                                                                                                                                                                                                                                                                 |
| FR-014 | Incident acknowledgement           | An authorized Engineer or Team Lead can acknowledge an OPEN incident. The first successful acknowledgement is recorded with the authenticated user. The person acknowledging may differ from the current assignee.                                                                                                                            |
| FR-015 | Severity confirmation/update       | An authorized Engineer or Team Lead can confirm or update severity after reviewing the incident. A Team Lead can manually select severity when AI triage is unavailable.                                                                                                                                                                      |
| FR-016 | Incident comments                  | Authorized users can add comments to an incident. Comments become part of the incident timeline.                                                                                                                                                                                                                                              |
| FR-017 | Incident resolution                | An authorized assigned responder can resolve an incident by providing a resolution summary and confirming that the affected service is working again.                                                                                                                                                                                         |
| FR-018 | Incident timeline                  | The system records defined lifecycle, SLA, assignment, notification, comment, alert-source, AI, and postmortem events in chronological order.                                                                                                                                                                                                 |
| FR-019 | Response SLA                       | The system calculates a response SLA from incident `created_at` until acknowledgement.                                                                                                                                                                                                                                                        |
| FR-020 | Resolution SLA                     | The system calculates a resolution SLA from incident `created_at` until resolution.                                                                                                                                                                                                                                                           |
| FR-021 | SLA warning                        | A worker evaluates SLA progress and creates a warning when the applicable SLA reaches 80% of its window.                                                                                                                                                                                                                                      |
| FR-022 | SLA escalation                     | If an incident remains unacknowledged when its response SLA expires, the worker escalates it to the next configured responder in the escalation policy.                                                                                                                                                                                       |
| FR-023 | Severity-sensitive SLA             | If severity changes, subsequent SLA evaluation uses the SLA associated with the latest severity. The worker evaluates whether the current incident has crossed the applicable warning or breach threshold.                                                                                                                                    |
| FR-024 | Notifications                      | The system sends relevant incident notifications to the assigned engineer and Team Lead.                                                                                                                                                                                                                                                      |
| FR-025 | Notification reliability           | Notification processing is asynchronous, retryable, and safe to repeat.                                                                                                                                                                                                                                                                       |
| FR-026 | Postmortem generation              | After an incident reaches RESOLVED, an asynchronous worker generates a structured AI postmortem draft from recorded incident data.                                                                                                                                                                                                            |
| FR-027 | Postmortem failure handling        | Failure of postmortem generation does not reopen or invalidate a RESOLVED incident. Generation can be retried.                                                                                                                                                                                                                                |
| FR-028 | Postmortem review                  | An authorized Engineer, Team Lead, or Admin reviews and updates the postmortem draft before the incident is CLOSED.                                                                                                                                                                                                                           |
| FR-029 | AI provenance                      | The system records the model, model version, generation timestamp, prompt/version, input data/reference information, and human review metadata for AI-generated postmortems.                                                                                                                                                                  |
| FR-030 | Idempotent alert processing        | Repeated processing of the same alert must not create duplicate unresolved incidents or duplicate business actions.                                                                                                                                                                                                                           |
| FR-031 | Idempotent queue processing        | Repeated execution of the same asynchronous job must not create duplicate business actions.                                                                                                                                                                                                                                                   |
| FR-032 | Idempotent notifications           | Repeated execution of notification jobs must not create unintended duplicate notification actions.                                                                                                                                                                                                                                            |
| FR-033 | Idempotent postmortem generation   | Repeated execution of postmortem jobs must not create duplicate postmortem records or conflicting postmortem state.                                                                                                                                                                                                                           |
| FR-034 | Operational observability          | The system records structured logs, correlation IDs, job failures, retry information, and escalation outcomes.                                                                                                                                                                                                                                |
| FR-035 | Inbound rate limiting              | Alert ingestion is rate-limited per authenticated source.                                                                                                                                                                                                                                                                                     |
| FR-036 | Authorization                      | Incident and administrative operations are restricted according to role and team membership.                                                                                                                                                                                                                                                  |
| FR-037 | Alert normalization                | Alerts from supported sources are converted into a common internal format containing, where available, source, source event ID, source fingerprint, alert name, service, environment, source severity, summary, description, labels or attributes, annotations or additional details, start time, end time, source URL, and original payload. |
| FR-038 | Multiple alerts per request        | A single request may contain multiple alerts. The system processes each alert separately for validation, identity, deduplication, storage, and incident association.                                                                                                                                                                          |
| FR-039 | Source alert status                | The system records the source alert status, including firing or resolved when provided by the source. A source alert becoming resolved does not automatically change the IMS incident to RESOLVED.                                                                                                                                            |
| FR-040 | AI-assisted incident investigation | An authorized user can request an AI-generated investigation brief for an incident using relevant recorded IMS knowledge.                                                                                                                                                                                                                     |
| FR-041 | Investigation evidence retrieval   | The investigation capability retrieves relevant recorded IMS information, including historical incidents, reviewed postmortems, runbooks, and other configured IMS knowledge sources.                                                                                                                                                         |
| FR-042 | Evidence references                | An AI investigation brief identifies the recorded sources used to support its statements or suggestions.                                                                                                                                                                                                                                      |
| FR-043 | Investigation output               | An investigation brief summarizes relevant evidence, identifies possible areas of investigation, and provides suggested investigation steps without representing suggestions as confirmed facts.                                                                                                                                              |
| FR-044 | Investigation fallback             | If retrieval or AI generation is unavailable, the incident remains fully usable and the user can continue manual investigation.                                                                                                                                                                                                               |
| FR-045 | Investigation idempotency          | Repeated execution of the same investigation request must not create conflicting or unintended duplicate investigation records.                                                                                                                                                                                                               |
| FR-046 | AI investigation evaluation        | A small repeatable evaluation fixture/test suite is maintained outside the production domain model and API.                                                                                                                                                                                                                                   |

---

## 7. Business Rules

### Core Business Rules

| ID     | Rule                                                                                                                               | Applies to           | Enforcement                                      | Failure behavior                                              | Verification   |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ------------------------------------------------ | ------------------------------------------------------------- | -------------- |
| BR-001 | Every incident belongs to exactly one team and one service.                                                                        | Incident             | Database relationships and service validation    | Incident cannot be created without valid team and service     | AC-007         |
| BR-002 | Every service belongs to exactly one team in the MVP.                                                                              | Service              | Database relationship                            | Invalid service relationship is rejected                      | AC-007         |
| BR-003 | Every user belongs to exactly one team in the MVP.                                                                                 | User                 | Database relationship                            | User cannot belong to multiple teams                          | AC-007         |
| BR-004 | Users can access incidents only within their authorized team.                                                                      | All incident data    | Server-side authorization and team filtering     | 403/404                                                       | AC-008         |
| BR-005 | Only authorized users can change incident status, assignment, severity, or postmortem content.                                     | Incident             | Server-side authorization                        | 403                                                           | AC-009         |
| BR-006 | Only a Team Lead or Admin can assign, reassign, or unassign an incident.                                                           | Assignment           | Role check                                       | 403                                                           | AC-010         |
| BR-007 | The person who acknowledges an incident may differ from the current assignee.                                                      | Acknowledgement      | Separate acknowledgement and assignment records  | Invalid data is rejected                                      | AC-011         |
| BR-008 | Multiple engineers cannot collaboratively work on the same incident in the MVP.                                                    | Incident             | Single current assignee                          | Additional collaborative assignment is not supported          | AC-010         |
| BR-009 | Every successful lifecycle transition produces an audit/timeline event.                                                            | Incident             | Same transaction as state change                 | Transition cannot commit without its audit event              | AC-012         |
| BR-010 | Repeated asynchronous processing must not create duplicate business actions.                                                       | Jobs                 | Idempotency checks and database constraints      | Duplicate execution is safely ignored or rejected             | AC-024         |
| BR-011 | AI output is advisory and must not be represented as verified fact.                                                                | AI triage/postmortem | AI result validation and UI/data labels          | Invalid or unverified output is not accepted as verified data | AC-006, AC-032 |
| BR-012 | AI availability must not determine whether an authenticated alert is persisted as an incident.                                     | Alert/Incident       | Incident persistence occurs before AI processing | Incident remains available when AI is unavailable             | AC-005         |
| BR-013 | An incident can remain RESOLVED even if postmortem generation fails.                                                               | Incident/Postmortem  | Separate postmortem job state                    | Incident remains RESOLVED                                     | AC-030         |
| BR-014 | A RESOLVED incident can move to CLOSED only after the postmortem has been reviewed or the defined manual review path is completed. | Incident/Postmortem  | State transition checks                          | 409                                                           | AC-015         |
| BR-015 | A CLOSED incident is terminal in the MVP.                                                                                          | Incident             | State machine                                    | Further lifecycle changes are rejected                        | AC-034         |

### Alert Source Rules

| ID     | Rule                                                                                                                         | Applies to     | Enforcement                                  | Failure behavior                                                              | Verification   |
| ------ | ---------------------------------------------------------------------------------------------------------------------------- | -------------- | -------------------------------------------- | ----------------------------------------------------------------------------- | -------------- |
| BR-016 | Alerts from supported sources must be converted into the common IMS alert format before incident processing.                 | Alert          | Source-specific validation and normalization | Invalid alert is rejected                                                     | AC-043, AC-044 |
| BR-017 | When a source provides a stable alert identifier or fingerprint, IMS uses it with the source to identify the external alert. | Alert          | Source identity rules                        | Alert without a usable identity follows the configured fallback identity rule | AC-003         |
| BR-018 | The full source payload must be preserved separately from the common alert data.                                             | Alert          | Alert persistence                            | Accepted alert is not considered complete without its original payload        | AC-038         |
| BR-019 | Every incident must have an initial severity when it is created.                                                             | Incident       | Service validation before persistence        | Incident creation fails if no initial severity can be determined              | AC-045, AC-046 |
| BR-020 | A recognized source severity is mapped to P0-P3 using the configured source mapping.                                         | Alert/Incident | Source severity mapping                      | Unknown source severity uses service default                                  | AC-045         |
| BR-021 | If no recognized source severity is available, the configured service default severity is used.                              | Incident       | Service configuration                        | Incident cannot be created without a valid default                            | AC-046         |
| BR-022 | Source severity and current incident severity are stored as separate concepts.                                               | Alert/Incident | Data model                                   | Source information is not overwritten by later human or AI decisions          | AC-045, AC-006 |
| BR-023 | AI suggested severity does not automatically replace the current incident severity.                                          | Incident/AI    | Application rule                             | Suggestion remains advisory until accepted by an authorized user              | AC-006         |
| BR-024 | A source alert changing from firing to resolved does not automatically move the IMS incident to RESOLVED.                    | Alert/Incident | Separate source status and incident state    | Incident lifecycle remains unchanged                                          | AC-048         |
| BR-025 | A single incoming request may contain multiple alerts, and each alert must be processed independently.                       | Alert          | Ingestion service                            | Invalid alert does not silently change another alert's data                   | AC-047         |

### Severity

| ID     | Rule                                                     | Applies to       | Enforcement                              | Failure behavior                  | Verification |
| ------ | -------------------------------------------------------- | ---------------- | ---------------------------------------- | --------------------------------- | ------------ |
| BR-026 | The MVP uses four severity levels: P0, P1, P2, and P3.   | Incident         | Database enum and application validation | Invalid severity is rejected      | AC-006       |
| BR-027 | P0 represents immediate and major service impact.        | Incident         | Product definition                       | N/A                               | AC-006       |
| BR-028 | P1 represents significant service impact.                | Incident         | Product definition                       | N/A                               | AC-006       |
| BR-029 | P2 represents limited or contained service impact.       | Incident         | Product definition                       | N/A                               | AC-006       |
| BR-030 | P3 represents minor service impact.                      | Incident         | Product definition                       | N/A                               | AC-006       |
| BR-031 | Exact SLA values for P0-P3 are configurable per service. | Service/Incident | Service configuration                    | Invalid configuration is rejected | AC-021       |

### Alert Identity and Deduplication

| ID     | Rule                                                                                                                                                                   | Applies to     | Enforcement                            | Failure behavior                                               | Verification |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | -------------------------------------- | -------------------------------------------------------------- | ------------ |
| BR-032 | An external alert identity uses source plus a stable provider alert identifier when one is available.                                                                  | Alert          | Source-specific identity handling      | Invalid identity is rejected                                   | AC-003       |
| BR-033 | If a source does not provide a usable stable identifier, IMS generates a deterministic identity from the source and the alert fields that define the alert's identity. | Alert          | Normalization and identity service     | Alert is rejected if a stable identity cannot be formed        | AC-003       |
| BR-034 | The entire raw payload must not be used as the only basis for alert identity because some fields can change between deliveries.                                        | Alert          | Identity service                       | Identity remains stable when non-identity fields change        | AC-003       |
| BR-035 | Alerts with the same external alert identity are treated as duplicates for incident deduplication.                                                                     | Alert/Incident | Application and database checks        | No second unresolved incident is created                       | AC-003       |
| BR-036 | The alert identity must be stored with the alert record.                                                                                                               | Alert          | Database                               | Alert record is incomplete without identity                    | AC-003       |
| BR-037 | Deduplication must be enforced at the application and database levels where appropriate.                                                                               | Alert/Incident | Service logic and database constraints | Concurrent duplicate processing is safely resolved             | AC-003       |
| BR-038 | The original source payload is stored independently of normalized alert fields.                                                                                        | Alert          | Database                               | Original payload remains available for review                  | AC-038       |
| BR-039 | Source alert state is stored separately from IMS incident state.                                                                                                       | Alert/Incident | Data model                             | Source resolution does not change incident state automatically | AC-048       |

### Assignment and Acknowledgement

| ID     | Rule                                                                                                                                              | Applies to      | Enforcement                                | Failure behavior                                              | Verification |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------- | ------------------------------------------ | ------------------------------------------------------------- | ------------ |
| BR-040 | The current assignee is the responder selected by a Team Lead or engineer who acknowledged the incident.                                          | Assignment      | Service authorization and escalation rules | Invalid assignment is rejected                                | AC-010       |
| BR-041 | The escalation worker notifies the next configured responder when the current incident remains unacknowledged beyond the applicable response SLA. | Escalation      | Worker and service configuration           | Escalation is recorded as failed if no valid responder exists | AC-022       |
| BR-042 | An Engineer cannot assign or reassign an incident.                                                                                                | Assignment      | Role authorization                         | 403                                                           | AC-009       |
| BR-043 | A Team Lead can assign, reassign, or unassign an incident.                                                                                        | Assignment      | Role authorization                         | 403 for unauthorized users                                    | AC-010       |
| BR-044 | Any authorized Engineer or Team Lead may acknowledge an OPEN incident.                                                                            | Acknowledgement | Role and state checks                      | 403/409                                                       | AC-011       |
| BR-045 | The first successful acknowledgement wins when multiple authorized users attempt acknowledgement concurrently.                                    | Acknowledgement | Transaction and concurrency control        | Losing request receives a conflict response                   | AC-011       |
| BR-046 | The user who acknowledges is recorded separately from the current assignee.                                                                       | Acknowledgement | Separate fields                            | Data is rejected if actors cannot be identified               | AC-011       |

### SLA Rules

| ID     | Rule                                                                                                                                                           | Applies to | Enforcement             | Failure behavior                                 | Verification   |
| ------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ----------------------- | ------------------------------------------------ | -------------- |
| BR-047 | Response SLA is measured from incident `created_at` until acknowledgement.                                                                                     | SLA        | SLA worker/service      | SLA status is not silently lost                  | AC-019         |
| BR-048 | Resolution SLA is measured from incident `created_at` until resolution.                                                                                        | SLA        | SLA worker/service      | SLA status is not silently lost                  | AC-020         |
| BR-049 | SLA clocks use continuous elapsed time.                                                                                                                        | SLA        | Time calculation        | N/A                                              | AC-039         |
| BR-050 | SLA calculations use IST timestamps in the MVP.                                                                                                                | SLA        | Application time policy | Invalid timestamp is rejected                    | AC-039         |
| BR-051 | The applicable SLA threshold is determined by the incident's current severity and the service's configured SLA policy.                                         | SLA        | SLA service             | Invalid configuration is rejected                | AC-021         |
| BR-052 | The 80% warning threshold is measured from incident `created_at`.                                                                                              | SLA        | SLA worker              | Warning is not created before the threshold      | AC-021         |
| BR-053 | When severity changes, SLA evaluation uses the latest severity's configured threshold.                                                                         | SLA        | SLA worker              | Current severity is used for the next evaluation | AC-021         |
| BR-054 | If a severity change causes an already elapsed threshold to be crossed, the next SLA evaluation may create the applicable warning or breach event immediately. | SLA        | SLA worker              | Event is recorded once                           | AC-021, AC-022 |

### Escalation Rules

| ID     | Rule                                                                                                                          | Applies to   | Enforcement       | Failure behavior                               | Verification |
| ------ | ----------------------------------------------------------------------------------------------------------------------------- | ------------ | ----------------- | ---------------------------------------------- | ------------ |
| BR-055 | Escalation is performed by a worker according to the configured escalation policy.                                            | Escalation   | Worker            | Failure is recorded and retried when retryable | AC-022       |
| BR-056 | The next responder in the configured escalation policy is selected when the response SLA is breached without acknowledgement. | Escalation   | Worker and policy | No invalid responder is assigned               | AC-022       |
| BR-057 | Escalation continues until the incident is acknowledged or the configured final fallback is reached.                          | Escalation   | Worker            | Final fallback is recorded                     | AC-023       |
| BR-058 | If the final configured responder is reached without acknowledgement, the Team Lead/Admin fallback is notified.               | Escalation   | Worker            | Failure is observable                          | AC-023       |
| BR-059 | Resolution SLA breach does not automatically change incident state.                                                           | Incident/SLA | SLA worker        | Incident state remains unchanged               | AC-021       |

### Notification Rules

| ID     | Rule                                                                             | Applies to   | Enforcement                         | Failure behavior                            | Verification   |
| ------ | -------------------------------------------------------------------------------- | ------------ | ----------------------------------- | ------------------------------------------- | -------------- |
| BR-060 | Relevant incident notifications are sent to the assigned engineer and Team Lead. | Notification | Notification service                | Delivery failure is retried                 | AC-025         |
| BR-061 | Notification delivery is asynchronous.                                           | Notification | Queue/worker                        | Business action is not blocked              | AC-026         |
| BR-062 | Notification jobs are retryable.                                                 | Notification | Worker retry policy                 | Exhausted jobs enter failure state          | AC-026, AC-027 |
| BR-063 | Notification attempts and outcomes are recorded.                                 | Notification | Notification record                 | Delivery history remains available          | AC-026         |
| BR-064 | Repeated notification job execution must be safely handled.                      | Notification | Idempotency key and database checks | No unintended duplicate notification action | AC-028         |

### Postmortem Rules

| ID     | Rule                                                                                                                         | Applies to          | Enforcement                               | Failure behavior                                                                             | Verification   |
| ------ | ---------------------------------------------------------------------------------------------------------------------------- | ------------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------- | -------------- |
| BR-065 | Postmortem generation begins only after the incident reaches RESOLVED.                                                       | Postmortem          | Worker trigger                            | No draft is generated early                                                                  | AC-029         |
| BR-066 | Postmortem generation is asynchronous.                                                                                       | Postmortem          | Queue/worker                              | Incident lifecycle is not blocked                                                            | AC-029         |
| BR-067 | AI-generated content remains a draft until human review.                                                                     | Postmortem          | Review status                             | Unreviewed draft cannot close incident                                                       | AC-015         |
| BR-068 | The postmortem must be based on recorded incident information.                                                               | Postmortem          | Worker input validation                   | Missing required context is recorded as a generation failure                                 | AC-031         |
| BR-069 | The postmortem must distinguish recorded facts from unknowns or AI-generated inferences.                                     | Postmortem          | Fixed structure and output validation     | Unsupported claims are not presented as confirmed facts                                      | AC-031         |
| BR-070 | AI generation failure does not move an incident out of RESOLVED.                                                             | Postmortem          | Separate job state                        | Incident remains RESOLVED                                                                    | AC-030         |
| BR-071 | A postmortem can be retried after generation failure.                                                                        | Postmortem          | Retry policy                              | Retry stops after configured limit and enters failure state                                  | AC-030         |
| BR-072 | An incident cannot be CLOSED until the postmortem is reviewed or the defined manual review path is completed.                | Incident/Postmortem | State transition check                    | 409                                                                                          | AC-015         |
| BR-073 | AI-assisted investigation is advisory and does not change incident state, severity, assignment, or resolution automatically. | AI Investigation    | Application rule                          | Investigation produces information only                                                      | AC-049, AC-050 |
| BR-074 | Investigation retrieval is limited to knowledge the requesting user is authorized to access.                                 | AI Investigation    | Team authorization and source filtering   | Unauthorized evidence is excluded                                                            | AC-051         |
| BR-075 | Investigation briefs must identify the recorded evidence used to support their content.                                      | AI Investigation    | Output validation and evidence references | Output without valid evidence references is not accepted as a completed investigation result | AC-050         |
| BR-076 | Recorded facts and AI-generated suggestions must remain distinguishable in the investigation result.                         | AI Investigation    | Structured output and labels              | Unsupported claims are not presented as recorded facts                                       | AC-050         |
| BR-077 | AI investigation failure does not block incident viewing, investigation, lifecycle transitions, or closure.                  | AI Investigation    | Separate asynchronous/optional workflow   | Manual workflow remains available                                                            | AC-052         |
| BR-078 | Repeated investigation execution must be safe and must not create conflicting results for the same request.                  | AI Investigation    | Idempotency and stored request identity   | Duplicate execution is safely ignored or represented as the same request                     | AC-053         |
| BR-079 | The evaluation set must contain known expected relevant evidence for its test cases.                                         | AI Evaluation       | Evaluation data and test process          | Evaluation case is invalid if expected evidence is missing                                   | AC-054         |
| BR-080 | AI investigation evaluation is a verification activity and does not itself change production incident data.                  | AI Evaluation       | Separate evaluation workflow/data         | Evaluation failures are reported without changing incidents                                  | AC-054         |

---

## 8. State Machines & Transitions

### Incident Lifecycle

```text
OPEN
  ↓
ACKNOWLEDGED
  ↓
MITIGATING
  ↓
RESOLVED
  ↓
CLOSED
```

### State Definitions

| State        | Meaning                                                                                                   |
| ------------ | --------------------------------------------------------------------------------------------------------- |
| OPEN         | Incident has been created and has not yet been acknowledged.                                              |
| ACKNOWLEDGED | An authorized responder has acknowledged the incident.                                                    |
| MITIGATING   | The acknowledged responder has confirmed or updated severity and is actively working on mitigation.       |
| RESOLVED     | The responder has provided a resolution summary and confirmed that the affected service is working again. |
| CLOSED       | The postmortem has been reviewed and the incident lifecycle is complete.                                  |

### Allowed Transitions

| Transition                | Allowed | Actor                                   | Preconditions / Rules                                   | Side Effects                                       |
| ------------------------- | ------- | --------------------------------------- | ------------------------------------------------------- | -------------------------------------------------- |
| OPEN → ACKNOWLEDGED       | Yes     | Engineer / Team Lead                    | Incident is OPEN; user is authorized                    | Audit/timeline event; notification                 |
| ACKNOWLEDGED → MITIGATING | Yes     | Engineer / Team Lead                    | User is authorized; severity is confirmed or updated    | Audit/timeline event; notification                 |
| MITIGATING → RESOLVED     | Yes     | Assigned Engineer                       | Resolution summary provided; service confirmed working  | Audit/timeline event; notification; postmortem job |
| RESOLVED → CLOSED         | Yes     | Authorized Engineer / Team Lead / Admin | Postmortem reviewed or manual review path completed     | Audit/timeline event; notification                 |
| CLOSED → \*               | No      | —                                       | Terminal state                                          | None                                               |
| RESOLVED → MITIGATING     | No      | —                                       | Closed-loop lifecycle does not support reopening in MVP | None                                               |
| OPEN → MITIGATING         | No      | —                                       | Acknowledgement is required first                       | None                                               |
| ACKNOWLEDGED → RESOLVED   | No      | —                                       | Mitigation state is required first                      | None                                               |

### Assignment Rules

Assignment is independent of acknowledgement:

```text
OPEN
 ↓
assigned to EngineerA
 ↓
EngineerA does not acknowledge
 ↓
Response SLA breach
 ↓
assign EngineerB
 ↓
EngineerB acknowledges
```

The acknowledgement actor and assignee are stored independently.

### Alert Source State

```text
FIRING → RESOLVED
```

The source alert state is separate from the IMS incident lifecycle.

---

## 9. Data That Must Exist

### User

- User ID
- Name
- Email
- Password/session authentication data as applicable
- Role
- Team ID
- Active/inactive status
- Created/updated timestamps

### Team

- Team ID
- Team name
- Created/updated timestamps

### Service

- Service ID
- Service name
- Team ID
- Initial severity default
- SLA configuration for P0-P3
- Escalation policy reference
- Created/updated timestamps

### Escalation Policy

- Policy ID
- Service ID
- Ordered responder list
- Escalation timing configuration
- Final Team Lead/Admin fallback
- Created/updated timestamps

### Alert Source

- Alert source ID
- Source type
- Name
- Configuration
- Enabled status
- Created/updated timestamps

### Alert

- Alert ID
- Alert source ID
- Source event ID, when available
- Source fingerprint or generated alert identity
- Alert name
- Service
- Environment
- Source severity, when provided
- Initial severity
- Summary
- Description
- Labels or attributes
- Annotations or additional details
- Source status
- Started timestamp
- Ended timestamp
- Source URL, when provided
- Original payload
- Created/updated timestamps

### Incident

- Incident ID
- Title
- Description
- Affected service
- Team
- Severity
- Status
- Current assignee
- Acknowledged by
- Resolved by
- Created timestamp
- Acknowledged timestamp
- Resolved timestamp
- Closed timestamp
- Alert reference
- Resolution summary

### Incident Comment

- Comment ID
- Incident ID
- Author ID
- Comment content
- Created timestamp

### Incident Event / Audit Event

- Event ID
- Incident ID
- Event type
- Actor/user ID where applicable
- Event metadata
- Created timestamp

Supported event types:

```text
INCIDENT_CREATED
ALERT_RECEIVED
ALERT_DUPLICATE
AI_TRIAGE_COMPLETED
ASSIGNED
ACKNOWLEDGED
SEVERITY_CHANGED
COMMENT_ADDED
SLA_WARNING
ESCALATED
NOTIFICATION_SENT
SOURCE_ALERT_RESOLVED
RESOLVED
POSTMORTEM_GENERATED
POSTMORTEM_REVIEWED
AI_INVESTIGATION_COMPLETED
CLOSED
```

### Notification

- Notification ID
- Incident ID
- Recipient
- Notification type
- Delivery status
- Attempt count
- Last attempt timestamp
- Provider response/error information
- Idempotency key/reference

### Postmortem

- Postmortem ID
- Incident ID
- Summary
- Impact
- Detection
- Timeline
- Root cause
- Contributing factors
- Resolution
- Corrective actions
- Preventive actions
- Unknowns
- MTTR
- Risk level
- Generation status
- Model
- Model version
- Prompt/version
- Input data/reference information
- Generation timestamp
- Human reviewer
- Review timestamp
- Approval status

### AI Investigation

- Investigation ID
- Incident ID
- Requesting user
- Status
- Investigation result
- Generation timestamp
- Model and model version, when AI generation occurs
- Input/reference information
- Idempotency/request reference

### Investigation Evidence

- Evidence ID
- Investigation ID
- Source type
- Source record reference
- Relevance/reference information
- Created timestamp

### AI Evaluation Case

- Evaluation case ID
- Input incident/reference
- Expected relevant evidence
- Expected output constraints
- Evaluation result
- Evaluation run timestamp

---

## 10. External Integrations

| System         | Why this project needs it                      | MVP behavior                                                      |
| -------------- | ---------------------------------------------- | ----------------------------------------------------------------- |
| Alert source   | Sends operational alerts to IMS                | Authenticated ingestion and conversion to the common alert format |
| Email provider | Delivers incident notifications                | Asynchronous, retryable, and safe to repeat                       |
| LLM provider   | Provides AI alert triage and postmortem drafts | Advisory AI; failure does not block the incident lifecycle        |

The MVP supports multiple external alert sources through the same common ingestion process. Source-specific details are handled by the integration layer and do not change the main incident workflow.

---

## 11. Authorization Matrix

| Action                     | Engineer | Team Lead | Admin |
| -------------------------- | -------- | --------- | ----- |
| View own team's incidents  | Yes      | Yes       | Yes   |
| Acknowledge incidents      | Yes      | Yes       | Yes   |
| Confirm/update severity    | Yes      | Yes       | Yes   |
| Add incident comments      | Yes      | Yes       | Yes   |
| Resolve assigned incidents | Yes      | Yes       | Yes   |
| Assign incidents           | No       | Yes       | Yes   |
| Reassign incidents         | No       | Yes       | Yes   |
| Unassign incidents         | No       | Yes       | Yes   |
| Manage responders/users    | No       | No        | Yes   |
| Manage teams               | No       | No        | Yes   |
| Manage services            | No       | No        | Yes   |
| Manage escalation policies | No       | No        | Yes   |
| Review/approve postmortem  | Yes      | Yes       | Yes   |
| View audit/timeline        | Yes      | Yes       | Yes   |

Authorization must additionally enforce team isolation.

---

## 12. Security Requirements

The MVP must address:

1. **Authentication**
   - Authenticated users are required for protected API operations.
   - Alert sources must authenticate alert requests.

2. **Authorization**
   - Role-based access control applies to protected operations.
   - Authorization is checked server-side.

3. **Team/workspace isolation**
   - Users can access only incidents and resources belonging to their authorized team.
   - A user belongs to exactly one team in the MVP.

4. **Alert source authentication**
   - Validate the authentication method configured for each supported source.
   - Verify signatures where the source provides signed requests.
   - Validate timestamps where timestamp checks are supported.
   - Validate event IDs or equivalent source identifiers where available.

5. **Replay protection**
   - Reject stale or invalidly authenticated requests.
   - Prevent reuse of previously processed event IDs or equivalent identifiers where applicable.

6. **Secrets management**
   - Provider credentials, signing secrets, JWT/session secrets, and LLM credentials must not be stored in source code.

7. **Input validation**
   - Validate all API and alert payloads at the application boundary.

8. **Payload size limits**
   - Reject alert/API payloads exceeding configured limits.

9. **Rate limiting**
   - Apply inbound alert rate limiting per authenticated source.

10. **Audit trail**
    - Record security-relevant and incident lifecycle actions in an append-only audit/timeline structure.

11. **AI data handling/redaction**
    - Define which incident data may be sent to the LLM provider.
    - Redact sensitive information before external AI processing where required.

12. **Secure password/session/token handling**
    - Use secure password storage and appropriate session/token handling.
    - Do not expose authentication secrets through logs or API responses.

13. **Least privilege**
    - Services, workers, database users, and external credentials receive only the permissions required for their responsibilities.

---

## 13. Non-functional Requirements

| ID      | Category                 | Proposed target                                                                                                                                                     |
| ------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NFR-001 | Reliability              | No accepted incident state change should be silently lost.                                                                                                          |
| NFR-002 | Security                 | Authentication, authorization, and team-level access control apply to 100% of protected incident operations.                                                        |
| NFR-003 | Observability            | Record structured logs, request correlation IDs, job failures, retry information, and escalation outcomes for incident processing.                                  |
| NFR-004 | Performance              | An accepted alert should result in a persisted alert/incident within 5 seconds, excluding asynchronous AI processing and external provider latency.                 |
| NFR-005 | Performance              | p95 latency below 500ms for authenticated incident state-transition API requests under a synthetic workload of 200 requests/sec, excluding external provider calls. |
| NFR-006 | Performance              | p95 latency below 300ms for read endpoints serving current incident status under the defined synthetic workload.                                                    |
| NFR-007 | Consistency              | Lifecycle state changes and their successful audit events must be committed atomically.                                                                             |
| NFR-008 | Idempotency              | Duplicate alert, queue, notification, and postmortem processing must not create unintended duplicate business actions.                                              |
| NFR-009 | Recovery                 | Retryable asynchronous failures must use bounded retry behavior and ultimately be represented in a dead-letter/failure state when retries are exhausted.            |
| NFR-010 | AI investigation quality | AI investigation results must provide traceable evidence references and remain distinguishable from recorded facts.                                                 |
| NFR-011 | AI evaluation            | AI investigation retrieval and output checks must be repeatable against a maintained evaluation set.                                                                |

---

## 14. Failure Expectations

| Dependency / Component     | Expected behavior on failure                                                                                                         |
| -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| AI triage                  | Incident remains persisted and continues without an AI suggestion; Team Lead can select severity manually; AI triage can be retried. |
| LLM postmortem generation  | Incident remains RESOLVED; generation is retryable; failure is observable.                                                           |
| AI investigation/retrieval | Investigation failure is observable; no incident lifecycle or severity change occurs; manual investigation remains available.        |
| Email provider             | Notification job retries with backoff; exhausted failures move to a failure state and remain observable.                             |
| Queue/worker               | Jobs are safely retried; repeated execution must be handled safely.                                                                  |
| Database                   | Failed transaction rolls back the associated state change and audit event.                                                           |
| Alert source               | Invalid authentication, replay checks, or payload validation causes rejection; valid duplicate delivery is safely deduplicated.      |

### Retry Policy

Retry implementation details are part of the engineering design, but the MVP requires:

- Exponential backoff.
- Bounded retry attempts.
- DLQ/failure state after retry exhaustion.
- Retryable and non-retryable failure classification.
- Observable retry/failure metadata.
- Safe repeated job processing.

---

## 15. MVP Scope

### In Scope

- Authentication.
- Role-based authorization.
- Team-level isolation.
- User, team, and service management.
- Escalation policy configuration.
- Authenticated alert ingestion.
- Alert source authentication and replay protection.
- Per-source inbound rate limiting.
- Alert normalization and identity.
- Alert deduplication.
- Original alert payload preservation.
- Initial severity from source severity or service default.
- Incident creation.
- Incident assignment, reassignment, and unassignment.
- Incident acknowledgement.
- Severity confirmation/update.
- Incident comments.
- Incident timeline/audit history.
- Response SLA tracking.
- Resolution SLA tracking.
- 80% SLA warning.
- SLA-based escalation.
- Notifications to assigned engineer and Team Lead.
- Safe repeated asynchronous job processing.
- AI-assisted alert triage.
- AI-assisted incident investigation using relevant recorded IMS knowledge and evidence references.
- AI-generated postmortem draft.
- A small repeatable AI evaluation set covering investigation retrieval relevance and evidence/output validity.
- Human postmortem review.
- Basic operational logs, metrics, and failure handling.
- Retry with exponential backoff and DLQ.
- One representative external alert source through the common alert ingestion and normalization contract.
- The common source contract is designed so additional source adapters can be added later without changing the incident workflow.

### Out of Scope / Deferred

- On-call schedule rotation.
- Real-time notifications using sockets.
- Multi-channel notification.
- Alert suppression/noise reduction.
- Dependency graphs.
- ChatOps.
- Public status page.
- Automated remediation.
- Autonomous severity changes.
- Multi-team user membership.
- Multiple engineers collaborating on the same incident.
- Additional external alert-source integrations.

---

## 16. Future Scope

Potential future extensions include:

- On-call schedule rotation and availability management.
- Multi-team user membership and broader organizational boundaries.
- Multiple-engineer collaborative incident handling.
- Advanced alert suppression, correlation, and noise reduction.
- Dependency-aware incident correlation.
- ChatOps integration.
- Real-time notifications.
- Multi-channel notification and fallback chains.
- Public status page.
- Additional external monitoring and alert-source integrations/adapters.
- Advanced AI-assisted investigation with richer retrieval, ranking, and domain-specific knowledge sources.
- Automated remediation with explicit human approval and safety controls.
- Autonomous actions only after separate product, security, reliability, and governance requirements are defined.
- More comprehensive AI evaluation, monitoring, and regression analysis.

---

## 17. Resolved Decisions

| ID     | Decision                                                                                                                            | Detail                                                                                                                                          |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| RD-001 | AI triage runs asynchronously after incident persistence.                                                                           | AI availability does not block alert ingestion or incident creation.                                                                            |
| RD-002 | AI failure does not block incident creation or incident progression.                                                                | A human can continue the workflow when AI is unavailable.                                                                                       |
| RD-003 | If AI is unavailable, a Team Lead can manually select severity.                                                                     | The incident still has an initial severity at creation.                                                                                         |
| RD-004 | The MVP uses a common alert format for supported external sources.                                                                  | Source-specific alert data is converted before common incident processing.                                                                      |
| RD-005 | The MVP supports multiple external alert sources.                                                                                   | Source-specific details remain outside the main incident workflow.                                                                              |
| RD-006 | Alert identity uses source + stable provider identifier when available.                                                             | If no usable provider identifier exists, IMS generates a deterministic identity from identity-defining alert fields.                            |
| RD-007 | Inbound alert rate limiting is applied per authenticated source.                                                                    | Each configured source has its own limit.                                                                                                       |
| RD-008 | The MVP uses two SLAs: Response SLA and Resolution SLA.                                                                             | Response ends at acknowledgement; Resolution ends at resolution.                                                                                |
| RD-009 | Both SLA clocks start from incident `created_at`.                                                                                   | SLA time is measured from the original incident creation time.                                                                                  |
| RD-010 | SLA clocks use continuous elapsed time in IST in the MVP.                                                                           | There are no business-hour pauses in the MVP.                                                                                                   |
| RD-011 | Severity changes cause SLA evaluation to use the latest severity's configured SLA threshold.                                        | The worker uses the current severity at each evaluation.                                                                                        |
| RD-012 | SLA warning is evaluated at 80% of the applicable SLA window from incident `created_at`.                                            | The warning is recorded once for the applicable threshold.                                                                                      |
| RD-013 | If an assigned responder does not acknowledge before the response SLA breach, the worker notifies to the next configured responder. | Escalation follows the service policy.                                                                                                          |
| RD-014 | The acknowledgement actor may differ from the current assignee.                                                                     | Assignment and acknowledgement are stored separately.                                                                                           |
| RD-015 | Team Leads and Admins can assign/reassign/unassign incidents; Engineers cannot.                                                     | Assignment authority is role-based.                                                                                                             |
| RD-016 | Multiple engineers cannot collaboratively work on one incident in the MVP.                                                          | One current assignee is supported.                                                                                                              |
| RD-017 | Notifications are sent to the assigned engineer and Team Lead.                                                                      | Exact notification events remain configurable.                                                                                                  |
| RD-018 | Severity levels are P0, P1, P2, and P3.                                                                                             | Each service defines its SLA values for these levels.                                                                                           |
| RD-019 | Each user belongs to exactly one team in the MVP.                                                                                   | Team is the authorization boundary.                                                                                                             |
| RD-020 | Each service belongs to exactly one team in the MVP.                                                                                | Services cannot be shared across teams.                                                                                                         |
| RD-021 | Incident ownership and acknowledgement are represented separately.                                                                  | The assignee and acknowledgement actor can be different users.                                                                                  |
| RD-022 | The original alert payload is preserved.                                                                                            | It is stored separately from normalized alert fields.                                                                                           |
| RD-023 | Idempotency is required at alert ingestion, queue processing, notification processing, and postmortem generation boundaries.        | Repeated processing must not create unintended duplicate business actions.                                                                      |
| RD-024 | Retry behavior uses exponential backoff with bounded attempts and DLQ/failure handling.                                             | Detailed retry implementation belongs in engineering design.                                                                                    |
| RD-025 | Alert authentication and replay protection use the checks supported by each source.                                                 | Signature, timestamp, and event ID checks are used where applicable.                                                                            |
| RD-026 | A source severity is mapped to P0-P3 when recognized; otherwise the service default severity is used.                               | The mapping is configurable.                                                                                                                    |
| RD-027 | A source alert becoming resolved does not automatically resolve the IMS incident.                                                   | Source status and incident state remain separate.                                                                                               |
| RD-028 | Postmortem structure is fixed for the MVP.                                                                                          | Human review is required before closure.                                                                                                        |
| RD-029 | Postmortem generation failure does not reopen a RESOLVED incident.                                                                  | Generation can be retried.                                                                                                                      |
| RD-030 | Incident closure occurs after postmortem human review/approval or the defined manual review path.                                   | CLOSED remains the terminal state.                                                                                                              |
| RD-031 | The terminal incident state is CLOSED.                                                                                              | Closed incidents cannot be reopened in the MVP.                                                                                                 |
| RD-032 | Audit history is an append-only incident event/timeline, not a full event-sourced system.                                           | The timeline records important incident actions and events.                                                                                     |
| RD-033 | No backup LLM provider is required for the MVP.                                                                                     | Human fallback is sufficient when AI is unavailable.                                                                                            |
| RD-034 | The MVP uses one Team as the authorization boundary.                                                                                | There is no separate multi-tenant workspace abstraction.                                                                                        |
| RD-035 | AI-assisted incident investigation is advisory.                                                                                     | It does not automatically change incident state, severity, assignment, or resolution.                                                           |
| RD-036 | Investigation uses recorded IMS knowledge as its evidence base.                                                                     | Initial MVP sources are historical incidents, reviewed postmortems, runbooks, and other configured IMS records.                                 |
| RD-037 | Investigation results must expose evidence references.                                                                              | Users can inspect which recorded sources support the result.                                                                                    |
| RD-038 | AI investigation remains available as an optional workflow after incident creation.                                                 | AI failure does not block incident processing or manual investigation.                                                                          |
| RD-039 | Investigation access follows the requesting user's team authorization.                                                              | Evidence from unauthorized teams must not be retrieved or exposed.                                                                              |
| RD-040 | AI investigation output distinguishes facts from suggestions.                                                                       | Recorded evidence is not rewritten as an AI-confirmed fact.                                                                                     |
| RD-041 | Repeated investigation requests are idempotent.                                                                                     | The same request must not create conflicting or unintended duplicate business records.                                                          |
| RD-042 | The MVP includes a small repeatable AI evaluation set.                                                                              | It is used to check retrieval relevance and evidence/output validity after changes.                                                             |
| RD-043 | The alert ingestion and incident creation is a local atomic transaction.                                                            | The accepted Alert + Incident + required initial Outbox event are persisted in one PostgreSQL transaction inside the Alert repository/workflow. |

---

## 18. Open Questions

| ID     | Question                                                                                               | Why it matters                                         |
| ------ | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------ |
| OQ-001 | What exact SLA durations should be configured for P0-P3 for each service?                              | Determines response and resolution deadlines.          |
| OQ-002 | Should SLA configuration be identical across services or configurable per service?                     | Affects service configuration and data model.          |
| OQ-003 | What exact escalation delay should apply between responders?                                           | Determines worker scheduling behavior.                 |
| OQ-004 | What exact source-severity mappings should be configured for each supported source?                    | Determines initial P0-P3 severity.                     |
| OQ-005 | What exact notification events should trigger email to the assigned engineer and Team Lead?            | Prevents unnecessary notification noise.               |
| OQ-006 | What exact data fields are allowed to leave the system for LLM processing?                             | Determines AI redaction and privacy implementation.    |
| OQ-007 | What exact AI confidence/evidence response format should be enforced?                                  | Determines validation and storage of AI triage output. |
| OQ-008 | What manual path should be available if postmortem generation repeatedly fails?                        | Ensures an incident can still be closed safely.        |
| OQ-009 | Which exact IMS record types should be included in the initial investigation knowledge set?            | Defines the first retrieval boundary.                  |
| OQ-010 | What retention policy should apply to AI investigation results and evidence references?                | Determines storage and review behavior.                |
| OQ-011 | What exact evaluation cases and expected evidence should be included in the initial AI evaluation set? | Determines how investigation quality is checked.       |
| OQ-012 | What exact data must be excluded or redacted before AI investigation processing?                       | Determines privacy and external AI handling.           |

---

## 19. Use Cases and Workflows

### UC-001: Alert is ingested and incident is created

| Field                  | Description                                                                                                                                                                              |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Actor                  | Authenticated alert source / ingestion worker                                                                                                                                            |
| Trigger                | An external alert source sends an alert request                                                                                                                                          |
| Preconditions          | The source is configured and the request passes authentication and replay checks                                                                                                         |
| Inputs                 | Alert payload, source, source event ID, and source fingerprint when available                                                                                                            |
| Business rules invoked | BR-016 through BR-025 and BR-032 through BR-039                                                                                                                                          |
| Main success flow      | Authenticate → validate → normalize alert → determine identity → deduplicate → determine initial severity → persist alert/incident → publish asynchronous AI triage job → return success |
| Duplicate flow         | Existing unresolved incident with the same external alert identity is found → record/associate the duplicate alert → return success without creating another unresolved incident         |
| AI failure flow        | Incident remains persisted; AI triage failure is recorded; human severity selection remains available                                                                                    |
| Resulting state        | New incident → OPEN                                                                                                                                                                      |
| Side effects           | Incident event; asynchronous AI triage job; notification job as applicable                                                                                                               |
| Acceptance criteria    | AC-001 through AC-006, AC-043 through AC-048                                                                                                                                             |

### UC-002: Team member views an OPEN incident

| Field                  | Description                                                                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Actor                  | Engineer / Team Lead                                                                                                               |
| Trigger                | User opens incident view                                                                                                           |
| Preconditions          | User is authenticated and authorized for the incident's team                                                                       |
| Inputs                 | `incident_id`, `authenticated_user_id`                                                                                             |
| Business rules invoked | BR-004, BR-005                                                                                                                     |
| Main success flow      | Authorize user → retrieve incident → return current incident state, assignment, severity, timeline, and relevant alert information |
| Failure flow           | Unauthorized access → reject with 403                                                                                              |
| Resulting state        | No state change                                                                                                                    |
| Side effects           | None                                                                                                                               |
| Acceptance criteria    | AC-008                                                                                                                             |

### UC-003: Engineer acknowledges an incident

| Field                  | Description                                                                                                                                                                         |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Actor                  | Engineer / Team Lead                                                                                                                                                                |
| Trigger                | Authorized user attempts to acknowledge an OPEN incident                                                                                                                            |
| Preconditions          | Incident exists, is OPEN, and user is authorized                                                                                                                                    |
| Inputs                 | `incident_id`, `authenticated_user_id`                                                                                                                                              |
| Business rules invoked | BR-044, BR-045, BR-046                                                                                                                                                              |
| Main success flow      | Load incident with concurrency protection → verify OPEN state → set acknowledgement actor/timestamp → transition to ACKNOWLEDGED → persist audit/timeline event atomically → commit |
| Concurrent flow        | Two authorized users attempt acknowledgement concurrently → one succeeds; the other receives a conflict/invalid-state response without corrupting state                             |
| Resulting state        | OPEN → ACKNOWLEDGED                                                                                                                                                                 |
| Side effects           | Audit/timeline event; notification                                                                                                                                                  |
| Acceptance criteria    | AC-011                                                                                                                                                                              |

### UC-004: Engineer confirms or updates severity

| Field                  | Description                                                                                                                                                  |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Actor                  | Engineer / Team Lead                                                                                                                                         |
| Trigger                | Authorized user reviews the source severity, AI suggestion, or incident context                                                                              |
| Preconditions          | Incident is ACKNOWLEDGED                                                                                                                                     |
| Inputs                 | `incident_id`, `authenticated_user_id`, selected severity                                                                                                    |
| Business rules invoked | BR-005, BR-019 through BR-023, BR-051 through BR-054                                                                                                         |
| Main success flow      | Authorize user → validate severity → update severity → transition incident to MITIGATING → record severity change and timeline event → update SLA evaluation |
| AI-unavailable flow    | Team Lead selects severity manually                                                                                                                          |
| Failure flow           | Invalid transition or invalid severity → reject without changing incident state                                                                              |
| Resulting state        | ACKNOWLEDGED → MITIGATING                                                                                                                                    |
| Side effects           | Audit/timeline event; notification; SLA evaluation update                                                                                                    |
| Acceptance criteria    | AC-006, AC-021, AC-045, AC-046                                                                                                                               |

### UC-005: Team Lead assigns/reassigns/unassigns an incident

| Field                  | Description                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Actor                  | Team Lead / Admin                                                                                                  |
| Trigger                | Team Lead manages incident ownership                                                                               |
| Preconditions          | User is authorized for the incident's team                                                                         |
| Inputs                 | `incident_id`, `authenticated_user_id`, optional responder ID                                                      |
| Business rules invoked | BR-006, BR-040, BR-042, BR-043                                                                                     |
| Main success flow      | Authorize user → validate responder → assign/reassign/unassign → record timeline event → notify relevant recipient |
| Resulting state        | Incident lifecycle state unchanged                                                                                 |
| Side effects           | Assignment event; notification                                                                                     |
| Acceptance criteria    | AC-009, AC-010                                                                                                     |

### UC-006: Worker escalates an unacknowledged incident

| Field                  | Description                                                                                                                    |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Actor                  | SLA/escalation worker                                                                                                          |
| Trigger                | Response SLA reaches breach threshold                                                                                          |
| Preconditions          | Incident is not ACKNOWLEDGED, RESOLVED, or CLOSED                                                                              |
| Inputs                 | Incident ID, current severity, SLA configuration, escalation policy                                                            |
| Business rules invoked | BR-041, BR-055 through BR-058                                                                                                  |
| Main success flow      | Evaluate current SLA → verify incident still requires acknowledgement → select next responder → notify responder and Team Lead |
| Final fallback         | If the final configured responder has already been attempted, escalate to the Team Lead/Admin fallback                         |
| Duplicate worker flow  | Repeated job execution produces no duplicate notification action                                                               |
| Resulting state        | Incident remains OPEN until acknowledged                                                                                       |
| Side effects           | ESCALATED event; assignment event; notification                                                                                |
| Acceptance criteria    | AC-022 through AC-024                                                                                                          |

### UC-007: Worker fires SLA warning

| Field                  | Description                                                                                                           |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Actor                  | SLA worker                                                                                                            |
| Trigger                | Applicable SLA reaches 80% of its window from incident `created_at`                                                   |
| Preconditions          | Incident is not resolved/closed and the relevant SLA is active                                                        |
| Inputs                 | Incident ID, current severity, SLA configuration                                                                      |
| Business rules invoked | BR-051 through BR-054                                                                                                 |
| Main success flow      | Calculate elapsed time → determine applicable threshold → record SLA warning → notify assigned engineer and Team Lead |
| Duplicate worker flow  | Repeated evaluation does not create duplicate warning actions                                                         |
| Resulting state        | No lifecycle state change                                                                                             |
| Side effects           | SLA_WARNING event; notification                                                                                       |
| Acceptance criteria    | AC-021                                                                                                                |

### UC-008: Engineer resolves an incident

| Field                  | Description                                                                                                                                                                                                             |
| ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Actor                  | Assigned Engineer                                                                                                                                                                                                       |
| Trigger                | Engineer determines the service is working again                                                                                                                                                                        |
| Preconditions          | Incident is MITIGATING; user is the assigned Engineer                                                                                                                                                                   |
| Inputs                 | `incident_id`, `authenticated_user_id`, resolution summary                                                                                                                                                              |
| Business rules invoked | BR-005, BR-009, BR-013, BR-015, BR-067 through BR-072                                                                                                                                                                   |
| Main success flow      | Authorize assigned Engineer → validate resolution data → transition to RESOLVED → store resolution summary and resolved timestamp → commit audit/timeline event atomically → trigger asynchronous postmortem generation |
| Failure flow           | Invalid transition or missing resolution summary → reject without changing state                                                                                                                                        |
| Resulting state        | MITIGATING → RESOLVED                                                                                                                                                                                                   |
| Side effects           | RESOLVED event; notification; postmortem generation job                                                                                                                                                                 |
| Acceptance criteria    | AC-029, AC-030                                                                                                                                                                                                          |

### UC-009: Worker generates postmortem draft

| Field                  | Description                                                                                                                            |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| Actor                  | Postmortem worker                                                                                                                      |
| Trigger                | RESOLVED incident generates a postmortem job                                                                                           |
| Preconditions          | Incident is RESOLVED                                                                                                                   |
| Inputs                 | Incident ID, recorded incident data, timeline, comments, resolution data                                                               |
| Business rules invoked | BR-065 through BR-071                                                                                                                  |
| Main success flow      | Load recorded incident context → call LLM → validate structured response → store draft and AI provenance → record POSTMORTEM_GENERATED |
| Failure flow           | LLM unavailable/error → record failure → retry according to retry policy → incident remains RESOLVED                                   |
| Duplicate flow         | Repeated job execution does not create conflicting or duplicate postmortems                                                            |
| Resulting state        | Incident remains RESOLVED                                                                                                              |
| Side effects           | Postmortem draft; timeline event                                                                                                       |
| Acceptance criteria    | AC-030 through AC-032                                                                                                                  |

### UC-010: Engineer reviews postmortem and closes incident

| Field                  | Description                                                                                                                                                                |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Actor                  | Engineer / Team Lead / Admin                                                                                                                                               |
| Trigger                | Reviewer opens generated postmortem                                                                                                                                        |
| Preconditions          | Incident is RESOLVED and postmortem draft exists, or the defined manual review path is available                                                                           |
| Inputs                 | `incident_id`, `authenticated_user_id`, reviewed postmortem content                                                                                                        |
| Business rules invoked | BR-014, BR-067, BR-072                                                                                                                                                     |
| Main success flow      | Review draft → update content if necessary → approve → transition incident to CLOSED → record reviewer and review timestamp → record POSTMORTEM_REVIEWED and CLOSED events |
| Failure flow           | Invalid review/authorization → reject without closing incident                                                                                                             |
| Resulting state        | RESOLVED → CLOSED                                                                                                                                                          |
| Side effects           | POSTMORTEM_REVIEWED event; CLOSED event; notification                                                                                                                      |
| Acceptance criteria    | AC-015, AC-033, AC-034                                                                                                                                                     |

---

### UC-011: Engineer requests an AI-assisted investigation brief

| Field                     | Description                                                                                                                                                                                         |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Actor                     | Engineer / Team Lead / Admin                                                                                                                                                                        |
| Trigger                   | Authorized user requests investigation assistance for an incident                                                                                                                                   |
| Preconditions             | User is authorized for the incident's team; relevant incident data is available                                                                                                                     |
| Inputs                    | `incident_id`, `authenticated_user_id`, investigation request reference                                                                                                                             |
| Business rules invoked    | BR-073 through BR-078                                                                                                                                                                               |
| Main success flow         | Authorize user → retrieve permitted IMS knowledge → identify relevant evidence → generate structured investigation brief → validate evidence references → store result → record investigation event |
| No-result flow            | No sufficiently relevant evidence is found → record that no relevant evidence was found → optionally generate a limited AI response stating the limitation                                          |
| AI/retrieval failure flow | Record failure → incident remains unchanged → manual investigation remains available → retry when appropriate                                                                                       |
| Duplicate flow            | Repeated request with the same idempotency/reference does not create conflicting investigation records                                                                                              |
| Resulting state           | Incident lifecycle state unchanged                                                                                                                                                                  |
| Side effects              | AI investigation record; evidence references; AI_INVESTIGATION_COMPLETED event when successful                                                                                                      |
| Acceptance criteria       | AC-049 through AC-054                                                                                                                                                                               |

## 20. Acceptance Criteria

| ID     | Acceptance Criterion                                                                                                                                                                                                            |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-001 | An unauthenticated or invalidly authenticated alert request is rejected and does not create an incident.                                                                                                                        |
| AC-002 | A replayed or stale alert request is rejected according to the configured source authentication and replay rules.                                                                                                               |
| AC-003 | A valid duplicate alert with the same external alert identity does not create a second unresolved incident.                                                                                                                     |
| AC-004 | A newly accepted alert is persisted before asynchronous AI triage is attempted.                                                                                                                                                 |
| AC-005 | If AI triage is unavailable, the incident remains OPEN and a Team Lead can manually select severity.                                                                                                                            |
| AC-006 | AI triage output is validated and stored as an advisory suggestion containing category, severity, confidence, and evidence.                                                                                                     |
| AC-007 | An incident cannot be created without a valid team and service.                                                                                                                                                                 |
| AC-008 | An unauthorized user cannot view or modify another team's incident and receives 403.                                                                                                                                            |
| AC-009 | An Engineer cannot assign, reassign, or unassign an incident.                                                                                                                                                                   |
| AC-010 | A Team Lead can assign, reassign, or unassign an incident belonging to the Team Lead's team.                                                                                                                                    |
| AC-011 | Two concurrent acknowledgement attempts on the same OPEN incident result in one successful acknowledgement and one safely rejected/conflicting attempt, and the acknowledgement actor is recorded separately from the assignee. |
| AC-012 | A successful incident state change and its corresponding audit/timeline event are committed atomically.                                                                                                                         |
| AC-013 | An incident cannot transition directly from OPEN to MITIGATING.                                                                                                                                                                 |
| AC-014 | An incident cannot transition from RESOLVED back to MITIGATING in the MVP.                                                                                                                                                      |
| AC-015 | An incident cannot be CLOSED without required postmortem review/approval or the defined manual review path.                                                                                                                     |
| AC-016 | A failed transaction rolls back the incident state change and does not leave a partially committed lifecycle transition.                                                                                                        |
| AC-017 | An incident comment is stored with its author and timestamp and appears in the incident timeline.                                                                                                                               |
| AC-018 | Response SLA elapsed time is calculated from incident `created_at` until acknowledgement.                                                                                                                                       |
| AC-019 | Resolution SLA elapsed time is calculated from incident `created_at` until resolution.                                                                                                                                          |
| AC-020 | SLA warning is generated when the applicable SLA reaches 80% of its current configured window.                                                                                                                                  |
| AC-021 | A severity change causes subsequent SLA evaluation to use the latest severity configuration.                                                                                                                                    |
| AC-022 | An unacknowledged incident is escalated to the next configured responder when the response SLA is breached.                                                                                                                     |
| AC-023 | Escalation continues through the configured chain and reaches the Team Lead/Admin fallback after the final responder.                                                                                                           |
| AC-024 | Repeated escalation-worker execution does not produce duplicate assignment or escalation actions.                                                                                                                               |
| AC-025 | Notifications are sent to the assigned engineer and Team Lead for defined notification events.                                                                                                                                  |
| AC-026 | Failed notification attempts are recorded and retried with exponential backoff.                                                                                                                                                 |
| AC-027 | Exhausted notification retries are represented in a DLQ/failure state and remain observable.                                                                                                                                    |
| AC-028 | Repeated notification-job execution does not create unintended duplicate notification actions.                                                                                                                                  |
| AC-029 | An incident can reach RESOLVED even when AI postmortem generation is unavailable.                                                                                                                                               |
| AC-030 | Failed postmortem generation is retryable and does not reopen the RESOLVED incident.                                                                                                                                            |
| AC-031 | A generated postmortem contains the required fixed structure and AI provenance metadata.                                                                                                                                        |
| AC-032 | Repeated postmortem-job execution does not create duplicate or conflicting postmortem records.                                                                                                                                  |
| AC-033 | A reviewed postmortem records the human reviewer and review timestamp.                                                                                                                                                          |
| AC-034 | A CLOSED incident is terminal and cannot undergo further lifecycle transitions.                                                                                                                                                 |
| AC-035 | Inbound alert rate limiting is enforced per authenticated source.                                                                                                                                                               |
| AC-036 | Protected APIs validate authentication, authorization, and input data at the server boundary.                                                                                                                                   |
| AC-037 | Secrets are not exposed through source code, logs, or API responses.                                                                                                                                                            |
| AC-038 | Original alert payloads are retained and associated with the corresponding alert/incident.                                                                                                                                      |
| AC-039 | Incident timestamps and SLA calculations follow the MVP's defined IST-based continuous elapsed-time policy.                                                                                                                     |
| AC-040 | Under the defined synthetic workload of 200 requests/sec, authenticated incident state-transition API p95 latency remains below 500ms excluding external provider calls.                                                        |
| AC-041 | Under the defined synthetic workload, current-status read endpoint p95 latency remains below 300ms.                                                                                                                             |
| AC-042 | Structured logs, correlation IDs, retry information, job failures, and escalation outcomes are available for operational debugging.                                                                                             |
| AC-043 | An alert from a supported external source is converted into the common IMS alert format before incident processing.                                                                                                             |
| AC-044 | An alert source that sends multiple alerts in one request has each valid alert processed independently without losing valid alerts.                                                                                             |
| AC-045 | A recognized source severity is mapped to the configured IMS P0-P3 severity.                                                                                                                                                    |
| AC-046 | An alert without a recognized source severity receives the configured default severity for its service.                                                                                                                         |
| AC-047 | A source alert changing from firing to resolved records the source resolution without automatically moving the IMS incident to RESOLVED.                                                                                        |
| AC-048 | The original source payload remains available after normalization and incident creation.                                                                                                                                        |
| AC-049 | An authorized user can request an AI-assisted investigation brief for an incident without changing the incident lifecycle state.                                                                                                |
| AC-050 | A completed AI investigation brief identifies the recorded evidence used and distinguishes evidence from AI-generated suggestions.                                                                                              |
| AC-051 | An AI investigation request cannot retrieve or expose incident knowledge belonging to another unauthorized team.                                                                                                                |
| AC-052 | If AI or retrieval is unavailable, the incident remains usable and manual investigation can continue.                                                                                                                           |
| AC-053 | Repeated execution of the same investigation request does not create conflicting or unintended duplicate investigation records.                                                                                                 |
| AC-054 | The AI evaluation set can be executed repeatedly and reports retrieval relevance and evidence/output validity without modifying production incident data.                                                                       |

---

## 21. MVP Success Definition

The MVP is considered complete when the end-to-end workflow is demonstrably functional and tested:

```text
                    Authenticated Alert
                            ↓
                    Replay Protection
                            ↓
                    Alert Normalization
                            ↓
                    Alert Identity / Deduplication
                            ↓
                    Determine Initial Severity
                            ↓
                    Persist Alert + Incident
                            ↓
                           OPEN
                            ↓
                     Async AI Triage
                            │
                 ┌──────────┴──────────┐
                 ↓                     ↓
          Investigation Request    Severity Suggestion
                 ↓                     / Human Fallback
        Authorized Retrieval
                 ↓
        Evidence-Grounded Brief
                 │
                 └──────────┐
                            ↓
                       Assignment
                            ↓
                     ACKNOWLEDGED
                            ↓
                       MITIGATING
                            ↓
                 SLA Monitoring / Escalation
                            ↓
                         RESOLVED
                            ↓
                    Async AI Postmortem
                            ↓
                       Human Review
                            ↓
                          CLOSED
```

The MVP must also demonstrate the AI-assisted investigation workflow:

```text
Resolved and active IMS knowledge
              ↓
       Authorized retrieval
              ↓
       Relevant evidence
              ↓
     AI investigation brief
              ↓
      Evidence references
              ↓
       Human investigation
```

The AI investigation capability is advisory and does not automatically change incident state, severity, assignment, or resolution.

The MVP must also demonstrate the important failure paths:

```text
AI unavailable
Duplicate alert
Duplicate queue job
Concurrent acknowledgement
Notification failure
Worker retry
DLQ after retry exhaustion
Postmortem generation failure
Invalid state transition
Unauthorized access
Alert replay
Rate-limit breach
Invalid alert payload
Multiple alerts in one request
AI investigation failure
Unauthorized investigation evidence access
Duplicate investigation request
Source alert resolution
```
