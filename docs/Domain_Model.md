# Domain Model

```
User -> Team | 1
Team -> User | 1..N

Team -> Service | 0..N
Service -> Escalation Policy | 1..4

Alert_Source -> Alert | 0..N
Alert -> Incident | 0..1
Alert -> Service | 1

Incident -> Alert | 0..N
Incident -> Team | 1
Incident -> Service | 1
Incident -> current_assignee | 0..1
Incident -> acknowledged_by | 0..1
Incident -> resolved_by | 0..1

Incident -> Comment | 0..N
Comment -> User | 1
Comment -> Incident | 1

Incident -> Notification | 0..N
Incident -> Postmortem | 0..1

Incident -> AuditLog | 0..N
AuditLog -> User | 0..1

Postmortem -> human_reviewer | 0..1
Incident -> AI_Investigation | 0..N

AI_Investigation -> Investigation_Evidence | 0..N
AI_Investigation -> investigating_user | 0..1

AI_Evaluation_Case | independent

```

---

| Relationship                               | Cardinality            |
| ------------------------------------------ | ---------------------- |
| User -> Team                               | One-to-one             |
| Team -> User                               | One-to-many            |
| Team -> Service                            | One-to-many            |
| Service -> Escalation_Policy               | One-to-many            |
| Alert_Source -> Alert                      | One-to-many            |
| Alert -> Incident                          | Many-to-one            |
| Incident -> Team                           | One-to-one             |
| Incident -> Comment                        | One-to-many            |
| Comment -> User                            | One-to-one             |
| Incident -> Notification                   | One-to-many            |
| Incident -> Postmortem                     | One-to-one             |
| Incident -> AI_Investigation               | One-to-many            |
| Incident -> AuditLog                       | One-to-many            |
| AuditLog -> User                           | Many-to-one / optional |
| AI_Investigation -> Investigation_Evidence | One-to-many            |

---

## Required constraints for schema design

| Entity                 | Owns                                                      | Lifecycle                                                | Key Invariant                                                             | Owning Module |
| ---------------------- | --------------------------------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------- | ------------- |
| User                   | Identity, role                                            | -                                                        | Every user has exactly one role per team and belongs to only one team.    | Identity         |
| Team                   | Membership                                                | -                                                        | Every engineer has exactly one lead.                                      | Identity         |
| Service                | severity default                                          | -                                                        | Every Service belongs to exactly one Team.                                | AppService    |
| Escalation_Policy      | Escalation tree, Timing config                            | -                                                        | Every service has atleast one policy.                                     | AppService    |
| Alert                  | payload, service affected                                 | FIRING -> RESOLVED                                       | Every accepted alert belongs to exactly one incident.                     | Alerts        |
| Alert_Source           | Source                                                    | -                                                        | Every alert has one source.                                               | Alerts        |
| Incident               | Status, Severity                                          | OPEN -> ACKNOWLEDGED -> MITIGATING -> RESOLVED -> CLOSED | At most one unresolved Incident exists for an alert identity/fingerprint. | Incident      |
| Comment                | Remarks                                                   | -                                                        | -                                                                         | Incident      |
| Incident               | timestamps                                                | -                                                        | Every successful Incident transition has an atomic AuditLog event.        | Incident      |
| Notification           | receiver                                                  | -                                                        | Required notification events have an atomic outbox record.                | Notifications |
| Postmortem             | root cause, fix, learnings, model                         | GENERATING -> DRAFT -> REVIEWED              | Postmortem approval is required before Incident → CLOSED..                | AI            |
| AI_Investigation       | investigation request, execution state, analysis metadata | REQUESTED -> RUNNING -> COMPLETED -> FAILED              | -                                                                         | AI            |
| Investigation_Evidence | facts, data                                               | -                                                        | Every AI Investigation has at least one Investigation_Evidence record.    | AI            |


- UNIQUE(service_id, escalation_policy.severity)
- Every Incident belongs to exactly one Team and Service.
- Every Incident has at most one current assignee.
- Every Incident has at most one Postmortem.
- acknowledged_by and current_assignee may refer to different users.


- AI evaluation fixtures/test cases
    → development/testing artifact
    → not a production domain entity
    → no production API

---

---
