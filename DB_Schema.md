# Database Schema

## Tables Overview

|       Table      | Purpose                                                                           |
| ---------------- | --------------------------------------------------------------------------------- |
| user             | All actors: Engineer / Team Lead / Admin, with a self-referential team-lead link. |
| team             | Associated services and team identity                                             |
| appService       | service identity, severity based timers.                                          |
| escalationPolicy | escalation tree of service                                                        |
| alertSource      | source type, configuration, status.                                               |
| alert            | affected service, fingerprint, payload.                                           |
| incident         | for service resolution, assignment to right team.                                 |
| comment          | details / suggestions / remarks of assignees.                                     |
| auditLog         | events, state transitions, incident timeline.                                     |
| notification     | notify users, timestamps, timeline.                                               |
| postmortem       | pattern recognition, service setup optimization, lessons for future.              |
| investigation    | help summary of possible causes and fixes from past experience                    |
| evidence         | facts and real data of affected service over time.                                |
| evaluation       | analysis of resolution, comments, postmortem and pattern over time.               |

---

## Schema.sql = proposed MVP Schema

```sql
    CREATE TABLE Team (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,

        createdAt timestamptz NOT NULL DEFAULT now(),
        updatedAt timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE User (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        email text NOT NULL UNIQUE,
        passwordHash text NOT NULL,

        role text NOT NULL DEFAULT 'ENGINEER' CHECK (role IN ('ENGINEER', 'TEAM_LEAD', 'ADMIN')),
        status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DEACTIVATED')),

        teamId uuid NOT NULL REFERENCES Team(id),
        leadId uuid REFERENCES User(id),

        createdAt timestamptz NOT NULL DEFAULT now(),
        updatedAt timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX idx_user_email ON User(email);
    CREATE INDEX idx_user_teamId_leadId ON User(teamId, leadId);

    CREATE TABLE EscalationPolicy (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

        level1 uuid NOT NULL REFERENCES User(id), -- Engineer 1
        level2 uuid NOT NULL REFERENCES User(id), -- Engineer 2
        level3 uuid NOT NULL REFERENCES User(id), -- Team Lead
        fallbackAdmin uuid NOT NULL REFERENCES User(id), -- Admin

        createdAt timestamptz NOT NULL DEFAULT now(),
        updatedAt timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE AppService (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        name text NOT NULL,
        defaultSeverity text NOT NULL DEFAULT 'P1' CHECK (defaultSeverity IN ('P0', 'P1', 'P2', 'P3')),

        P0ResponseSlaMinutes int NOT NULL,
        P0ResolutionSlaMinutes int NOT NULL,

        P1ResponseSlaMinutes int NOT NULL,
        P1ResolutionSlaMinutes int NOT NULL,

        P2ResponseSlaMinutes int NOT NULL,
        P2ResolutionSlaMinutes int NOT NULL,

        P3ResponseSlaMinutes int NOT NULL,
        P3ResolutionSlaMinutes int NOT NULL,

        teamId uuid NOT NULL REFERENCES Team(id),
        escalationPolicyId uuid NOT NULL REFERENCES EscalationPolicy(id),

        createdAt timestamptz NOT NULL DEFAULT now(),
        updatedAt timestamptz NOT NULL DEFAULT now(),

        UNIQUE(id, teamId)
    );

    CREATE TABLE AlertSource (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

        name text NOT NULL,
        sourceType text NOT NULL,
        configuration jsonb NOT NULL,
        status text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DEACTIVATED')),

        createdAt timestamptz NOT NULL DEFAULT now(),
        updatedAt timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX idx_alertSource_type ON AlertSource(sourceType, status);

    CREATE TABLE Alert (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

        sourceEventId text,
        sourceFingerprint text,
        name text,
        environment text NOT NULL,
        sourceSeverity text,
        initialSeverity text CHECK (initialSeverity IN ('P0', 'P1', 'P2', 'P3')),
        summary text,
        description text,
        labels text[],
        additionalDetails text,
        startedTimestamp timestamptz NOT NULL,
        endedTimestamp timestamptz,
        sourceUrl text,
        originalPayload jsonb NOT NULL,

        alertSourceId uuid NOT NULL REFERENCES AlertSource(id),
        affectedServiceId uuid NOT NULL REFERENCES AppService(id),
        incidentId uuid REFERENCES Incident(id),

        createdAt timestamptz NOT NULL DEFAULT now(),
        updatedAt timestamptz NOT NULL DEFAULT now()
    );

    CREATE UNIQUE INDEX idx_alert_source_event ON Alert(alertSourceId, sourceEventId) WHERE sourceEventId IS NOT NULL;
    CREATE UNIQUE INDEX idx_alert_source_fingerprint ON Alert(alertSourceId, sourceFingerprint) WHERE sourceFingerprint IS NOT NULL;
    CREATE INDEX idx_alert_url ON Alert(sourceUrl);

    CREATE TABLE Incident (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

        title text NOT NULL,
        description text NOT NULL,
        status text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ACKNOWLEDGED', 'MITIGATING', 'RESOLVED', 'CLOSED')),
        severity text NOT NULL CHECK (severity IN ('P0', 'P1', 'P2', 'P3')),

        currentAssignee uuid REFERENCES User(id),
        acknowledgedBy uuid REFERENCES User(id),
        severityConfirmedBy uuid REFERENCES User(id),
        resolvedBy uuid REFERENCES User(id),
        closedBy uuid REFERENCES User(id),

        acknowledgedTimestamp timestamptz,
        severityConfirmTimestamp timestamptz,
        resolvedTimestamp timestamptz,
        closedTimestamp timestamptz,
        resolutionSummary text,

        affectedServiceId uuid NOT NULL REFERENCES AppService(id),
        teamId uuid NOT NULL REFERENCES Team(id),

        createdAt timestamptz NOT NULL DEFAULT now(),
        updatedAt timestamptz NOT NULL DEFAULT now(),

        FOREIGN KEY (affectedServiceId, teamId) REFERENCES AppService(id, teamId)
    );

    CREATE INDEX idx_incident_severity ON Incident(severity, affectedServiceId);
    CREATE INDEX idx_incident_status ON Incident(status, currentAssignee);


    CREATE TABLE Comment (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        title text,
        description text NOT NULL,

        incidentId uuid NOT NULL REFERENCES Incident(id),
        authorId uuid NOT NULL REFERENCES User(id),

        createdAt timestamptz NOT NULL DEFAULT now()
    );

    CREATE INDEX idx_comment_incident_author ON Comment(incidentId, authorId);

    CREATE TABLE OutboxEvent (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

        eventType text NOT NULL,
        aggregateType text NOT NULL,
        aggregateId uuid NOT NULL,
        payload jsonb NOT NULL,
        status text NOT NULL DEFAULT 'PENDING',
        attemptCount int NOT NULL DEFAULT 0,
        availableAt timestamptz NOT NULL DEFAULT now(),
        processedAt timestamptz,

        createdAt timestamptz NOT NULL DEFAULT now()
    );

    CREATE TABLE AuditEvent(
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        metadata jsonb,

        eventType text NOT NULL CHECK (eventType in ('ALERT_RECEIVED', 'ALERT_DUPLICATE', 'AI_TRIAGE_COMPLETED', 'ASSIGNED', 'INCIDENT_CREATED', 'ACKNOWLEDGED', 'SEVERITY_CONFIRMED', 'COMMENT_ADDED', 'SLA_WARNING', 'ESCALATED_L1',  'ESCALATED_L2',  'ESCALATED_L3',  'ESCALATED_L4', 'SOURCE_ALERT_RESOLVED',  'RESOLVED', 'NOTIFIED', 'POSTMORTEM_GENERATED', 'POSTMORTEM_APPROVED','AI_INVESTIGATION_COMPLETED', 'CLOSED')),

        actor uuid,
        incidentId uuid REFERENCES Incident(id),

        createdAt timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_auditEvent_incident_type_actor ON AuditEvent(incidentId, eventType, actor);

    CREATE TABLE Postmortem (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        summary text NOT NULL,
        impact text NOT NULL,
        detection text NOT NULL,
        timeline text NOT NULL,
        rootCause text NOT NULL,
        factors text NOT NULL,
        resolution  text NOT NULL,
        correctiveActions text NOT NULL,
        preventiveActions text NOT NULL,
        unknowns text,
        MTTR int NOT NULL,
        riskLevel text NOT NULL CHECK (riskLevel IN ('P0','P1','P2','P3')),
        model text,
        modelVersion text,
        prompt text,
        inputData text,
        reviewStatus text NOT NULL DEFAULT 'PENDING' CHECK (reviewStatus IN ('PENDING', 'REJECTED', 'REVIEWED')),
        reviewedAt timestamptz,

        reviewedBy uuid REFERENCES User(id),
        incidentId uuid NOT NULL REFERENCES Incident(id),

        createdAt timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_postmortem_riskLevel_incident_reviewer ON Postmortem(riskLevel, incidentId, reviewedBy);
    CREATE INDEX idx_postmortem_mttr_incident_riskLevel ON Postmortem(MTTR, riskLevel, incidentId);

    CREATE TABLE Notification (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        deliveryStatus text NOT NULL DEFAULT 'PENDING' CHECK (deliveryStatus IN ('PENDING', 'SUCCESS', 'FAILED')),
        notificationType text NOT NULL CHECK(notificationType IN ('INFO', 'WARNING', 'ALERT')),
        attemptCount int,
        lastAttemptTimestamp timestamptz,
        providerResponse jsonb,
        idempotencyKey text UNIQUE,

        recipients uuid[],
        incidentId uuid REFERENCES Incident(id),

        createdAt timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_notification_incident_status ON Notification(incidentId, deliveryStatus);

    CREATE TABLE Investigation (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING', 'DONE')),
        result text NOT NULL,
        model text,
        modelVersion text,
        input jsonb NOT NULL,
        idempotencyKey text UNIQUE,

        requestedBy uuid NOT NULL REFERENCES User(id),
        incidentId uuid NOT NULL REFERENCES Incident(id),

        createdAt timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_investigation_incident_requestedBy ON Investigation(incidentId, requestedBy);
    CREATE INDEX idx_investigation_incident_status ON Investigation(incidentId, status);

    CREATE TABLE Evidence (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        sourceType text,
        sourceReference text,
        relevanceInfo text,
        evidenceType text NOT NULL CHECK (evidenceType IN ('FACT','INFERENCE','UNKNOWN')),

        incidentId uuid NOT NULL REFERENCES Incident(id),

        createdAt timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_evidence_incident_type ON Evidence(incidentId, sourceType);

    CREATE TABLE Evaluation (
        id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        input text NOT NULL,
        evidence text NOT NULL,
        constraints text NOT NULL,
        result jsonb NOT NULL,

        incidentId uuid NOT NULL REFERENCES Incident(id),

        createdAt timestamptz NOT NULL DEFAULT now()
    );
    CREATE INDEX idx_evaluation_incident ON Evaluation(incidentId);

```
