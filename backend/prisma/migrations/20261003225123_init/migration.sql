-- CreateEnum
CREATE TYPE "currentStatus" AS ENUM ('ACTIVE', 'DEACTIVATED');

-- CreateEnum
CREATE TYPE "Role" AS ENUM ('ENGINEER', 'TEAM_LEAD', 'ADMIN');

-- CreateEnum
CREATE TYPE "IncidentSeverity" AS ENUM ('P0', 'P1', 'P2', 'P3');

-- CreateEnum
CREATE TYPE "IncidentStates" AS ENUM ('OPEN', 'ACKNOWLEDGED', 'MITIGATING', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "LifecycleStates" AS ENUM ('PENDING', 'FAILED', 'SUCCESS');

-- CreateEnum
CREATE TYPE "AuditEventType" AS ENUM ('ALERT_RECEIVED', 'ALERT_DUPLICATE', 'AI_TRIAGE_COMPLETED', 'ASSIGNED', 'INCIDENT_CREATED', 'ACKNOWLEDGED', 'SEVERITY_CONFIRMED', 'COMMENT_ADDED', 'SLA_WARNING', 'ESCALATED_L1', 'ESCALATED_L2', 'ESCALATED_L3', 'ESCALATED_L4', 'SOURCE_ALERT_RESOLVED', 'RESOLVED', 'NOTIFIED', 'POSTMORTEM_GENERATED', 'POSTMORTEM_REVIEWED', 'AI_INVESTIGATION_COMPLETED', 'CLOSED', 'REASSIGNED', 'OPEN');

-- CreateEnum
CREATE TYPE "PostmortemReviewStatus" AS ENUM ('PENDING', 'REJECTED', 'REVIEWED');

-- CreateEnum
CREATE TYPE "NotificationType" AS ENUM ('INFO', 'WARNING', 'ALERT');

-- CreateEnum
CREATE TYPE "InvestigationStatus" AS ENUM ('REQUESTED', 'RUNNING', 'COMPLETED', 'FAILED');

-- CreateEnum
CREATE TYPE "EvidenceType" AS ENUM ('FACT', 'INFERENCE', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "PostmortemGenerationStatus" AS ENUM ('GENERATING', 'DRAFT', 'FAILED');

-- CreateEnum
CREATE TYPE "AlertSourceStatus" AS ENUM ('FIRING', 'RESOLVED');

-- CreateTable
CREATE TABLE "Team" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "status" "currentStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Team_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "role" "Role" NOT NULL DEFAULT 'ENGINEER',
    "status" "currentStatus" NOT NULL DEFAULT 'ACTIVE',
    "teamId" UUID,
    "leadId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserSession" (
    "id" UUID NOT NULL,
    "refreshTokenHash" TEXT NOT NULL,
    "lastRefreshHash" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "lastIp" TEXT,
    "lastSeen" TIMESTAMP(3),
    "revoked" BOOLEAN NOT NULL DEFAULT false,
    "expiresIn" TIMESTAMP(3) NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "UserSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EscalationPolicy" (
    "id" UUID NOT NULL,
    "level1Id" UUID NOT NULL,
    "level2Id" UUID NOT NULL,
    "level3Id" UUID NOT NULL,
    "fallbackAdminId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EscalationPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AppService" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "defaultSeverity" "IncidentSeverity" NOT NULL DEFAULT 'P1',
    "status" "currentStatus" NOT NULL DEFAULT 'ACTIVE',
    "P0ResponseSlaMinutes" INTEGER NOT NULL,
    "P0ResolutionSlaMinutes" INTEGER NOT NULL,
    "P1ResponseSlaMinutes" INTEGER NOT NULL,
    "P1ResolutionSlaMinutes" INTEGER NOT NULL,
    "P2ResponseSlaMinutes" INTEGER NOT NULL,
    "P2ResolutionSlaMinutes" INTEGER NOT NULL,
    "P3ResponseSlaMinutes" INTEGER NOT NULL,
    "P3ResolutionSlaMinutes" INTEGER NOT NULL,
    "teamId" UUID NOT NULL,
    "escalationPolicyId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AppService_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AlertSource" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "sourceType" TEXT NOT NULL,
    "configuration" JSONB NOT NULL,
    "status" "currentStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AlertSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" UUID NOT NULL,
    "sourceEventId" TEXT,
    "sourceFingerprint" TEXT,
    "name" TEXT,
    "environment" TEXT NOT NULL,
    "sourceSeverity" TEXT,
    "initialSeverity" "IncidentSeverity",
    "summary" TEXT,
    "description" TEXT,
    "labels" TEXT[],
    "additionalDetails" TEXT,
    "startedTimestamp" TIMESTAMP(3) NOT NULL,
    "endedTimestamp" TIMESTAMP(3),
    "sourceUrl" TEXT,
    "originalPayload" JSONB NOT NULL,
    "activeIdentityKey" TEXT,
    "sourceStatus" "AlertSourceStatus" NOT NULL DEFAULT 'FIRING',
    "alertSourceId" UUID NOT NULL,
    "affectedServiceId" UUID NOT NULL,
    "incidentId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AITriage" (
    "id" UUID NOT NULL,
    "alertId" UUID NOT NULL,
    "suggestedSeverity" "IncidentSeverity",
    "category" TEXT,
    "summary" TEXT,
    "reasoning" TEXT,
    "confidence" DOUBLE PRECISION,
    "rawOutput" JSONB,
    "failureStatus" "LifecycleStates" NOT NULL DEFAULT 'PENDING',
    "evidence" JSONB,
    "model" TEXT,
    "modelVersion" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AITriage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Incident" (
    "id" UUID NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL,
    "status" "IncidentStates" NOT NULL DEFAULT 'OPEN',
    "severity" "IncidentSeverity" NOT NULL,
    "acknowledgedTimestamp" TIMESTAMP(3),
    "severityConfirmTimestamp" TIMESTAMP(3),
    "resolvedTimestamp" TIMESTAMP(3),
    "closedTimestamp" TIMESTAMP(3),
    "resolutionSummary" TEXT,
    "currentAssigneeId" UUID,
    "acknowledgedById" UUID,
    "severityConfirmedById" UUID,
    "resolvedById" UUID,
    "closedById" UUID,
    "affectedServiceId" UUID NOT NULL,
    "teamId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Incident_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Comment" (
    "id" UUID NOT NULL,
    "title" TEXT,
    "description" TEXT NOT NULL,
    "incidentId" UUID NOT NULL,
    "authorId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Comment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboxEvent" (
    "id" UUID NOT NULL,
    "eventType" TEXT NOT NULL,
    "aggregateType" TEXT NOT NULL,
    "aggregateId" UUID NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "LifecycleStates" NOT NULL DEFAULT 'PENDING',
    "attemptCount" INTEGER NOT NULL DEFAULT 0,
    "availableAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboxEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditEvent" (
    "id" UUID NOT NULL,
    "metadata" JSONB,
    "eventType" "AuditEventType" NOT NULL,
    "actor" UUID,
    "incidentId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Postmortem" (
    "id" UUID NOT NULL,
    "summary" TEXT,
    "impact" TEXT,
    "detection" TEXT,
    "timeline" TEXT,
    "rootCause" TEXT,
    "factors" TEXT,
    "resolution" TEXT,
    "correctiveActions" TEXT,
    "preventiveActions" TEXT,
    "unknowns" TEXT,
    "MTTR" INTEGER,
    "riskLevel" "IncidentSeverity",
    "model" TEXT,
    "modelVersion" TEXT,
    "prompt" TEXT,
    "inputData" TEXT,
    "generationStatus" "PostmortemGenerationStatus" NOT NULL DEFAULT 'GENERATING',
    "reviewStatus" "PostmortemReviewStatus" NOT NULL DEFAULT 'PENDING',
    "reviewedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "generatedAt" TIMESTAMP(3),
    "reviewedById" UUID,
    "incidentId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Postmortem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Notification" (
    "id" UUID NOT NULL,
    "deliveryStatus" "LifecycleStates" NOT NULL DEFAULT 'PENDING',
    "notificationType" "NotificationType" NOT NULL,
    "attemptCount" INTEGER,
    "lastAttemptTimestamp" TIMESTAMP(3),
    "providerResponse" JSONB,
    "idempotencyKey" TEXT NOT NULL,
    "recipients" UUID[],
    "incidentId" UUID,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Notification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Investigation" (
    "id" UUID NOT NULL,
    "status" "InvestigationStatus" NOT NULL DEFAULT 'REQUESTED',
    "result" JSONB,
    "model" TEXT,
    "modelVersion" TEXT,
    "input" JSONB NOT NULL,
    "idempotencyKey" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3),
    "failureReason" TEXT,
    "requestedById" UUID NOT NULL,
    "incidentId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Investigation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Evidence" (
    "id" UUID NOT NULL,
    "sourceType" TEXT,
    "sourceReference" TEXT,
    "relevanceInfo" TEXT,
    "evidenceType" "EvidenceType" NOT NULL,
    "investigationId" UUID NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "incidentId" UUID,

    CONSTRAINT "Evidence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Evaluation" (
    "id" UUID NOT NULL,
    "input" TEXT NOT NULL,
    "evidence" TEXT NOT NULL,
    "constraints" TEXT NOT NULL,
    "result" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Evaluation_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Team_name_key" ON "Team"("name");

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "idx_user_email" ON "User"("email");

-- CreateIndex
CREATE INDEX "idx_user_teamId_leadId" ON "User"("teamId", "leadId");

-- CreateIndex
CREATE UNIQUE INDEX "AppService_name_key" ON "AppService"("name");

-- CreateIndex
CREATE UNIQUE INDEX "AppService_escalationPolicyId_key" ON "AppService"("escalationPolicyId");

-- CreateIndex
CREATE UNIQUE INDEX "AppService_id_teamId_key" ON "AppService"("id", "teamId");

-- CreateIndex
CREATE INDEX "idx_alert_sourceType_status" ON "AlertSource"("sourceType", "status");

-- CreateIndex
CREATE INDEX "idx_alert_sourceUrl" ON "Alert"("sourceUrl");

-- CreateIndex
CREATE UNIQUE INDEX "Alert_alertSourceId_activeIdentityKey_key" ON "Alert"("alertSourceId", "activeIdentityKey");

-- CreateIndex
CREATE UNIQUE INDEX "AITriage_alertId_key" ON "AITriage"("alertId");

-- CreateIndex
CREATE INDEX "AITriage_alertId_idx" ON "AITriage"("alertId");

-- CreateIndex
CREATE INDEX "idx_comment_incident_author" ON "Comment"("incidentId", "authorId");

-- CreateIndex
CREATE INDEX "idx_auditEvent_incident_type_actor" ON "AuditEvent"("incidentId", "eventType", "actor");

-- CreateIndex
CREATE UNIQUE INDEX "Postmortem_incidentId_key" ON "Postmortem"("incidentId");

-- CreateIndex
CREATE INDEX "idx_postmortem_riskLevel_incident_reviewer" ON "Postmortem"("riskLevel", "incidentId", "reviewedById");

-- CreateIndex
CREATE INDEX "idx_postmortem_mttr_riskLevel_incident" ON "Postmortem"("MTTR", "riskLevel", "incidentId");

-- CreateIndex
CREATE UNIQUE INDEX "Notification_idempotencyKey_key" ON "Notification"("idempotencyKey");

-- CreateIndex
CREATE INDEX "idx_notification_incident_status" ON "Notification"("incidentId", "deliveryStatus");

-- CreateIndex
CREATE UNIQUE INDEX "Investigation_idempotencyKey_key" ON "Investigation"("idempotencyKey");

-- CreateIndex
CREATE INDEX "idx_investigation_incident_requestedBy" ON "Investigation"("incidentId", "requestedById");

-- CreateIndex
CREATE INDEX "idx_investigation_incident_status" ON "Investigation"("incidentId", "status");

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserSession" ADD CONSTRAINT "UserSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EscalationPolicy" ADD CONSTRAINT "EscalationPolicy_level1Id_fkey" FOREIGN KEY ("level1Id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EscalationPolicy" ADD CONSTRAINT "EscalationPolicy_level2Id_fkey" FOREIGN KEY ("level2Id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EscalationPolicy" ADD CONSTRAINT "EscalationPolicy_level3Id_fkey" FOREIGN KEY ("level3Id") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EscalationPolicy" ADD CONSTRAINT "EscalationPolicy_fallbackAdminId_fkey" FOREIGN KEY ("fallbackAdminId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppService" ADD CONSTRAINT "AppService_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AppService" ADD CONSTRAINT "AppService_escalationPolicyId_fkey" FOREIGN KEY ("escalationPolicyId") REFERENCES "EscalationPolicy"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_alertSourceId_fkey" FOREIGN KEY ("alertSourceId") REFERENCES "AlertSource"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_affectedServiceId_fkey" FOREIGN KEY ("affectedServiceId") REFERENCES "AppService"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AITriage" ADD CONSTRAINT "AITriage_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "Alert"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_currentAssigneeId_fkey" FOREIGN KEY ("currentAssigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_acknowledgedById_fkey" FOREIGN KEY ("acknowledgedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_severityConfirmedById_fkey" FOREIGN KEY ("severityConfirmedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_resolvedById_fkey" FOREIGN KEY ("resolvedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_closedById_fkey" FOREIGN KEY ("closedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_affectedServiceId_teamId_fkey" FOREIGN KEY ("affectedServiceId", "teamId") REFERENCES "AppService"("id", "teamId") ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE "Incident" ADD CONSTRAINT "Incident_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "Team"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Comment" ADD CONSTRAINT "Comment_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditEvent" ADD CONSTRAINT "AuditEvent_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Postmortem" ADD CONSTRAINT "Postmortem_reviewedById_fkey" FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Postmortem" ADD CONSTRAINT "Postmortem_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Notification" ADD CONSTRAINT "Notification_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Investigation" ADD CONSTRAINT "Investigation_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Investigation" ADD CONSTRAINT "Investigation_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_investigationId_fkey" FOREIGN KEY ("investigationId") REFERENCES "Investigation"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Evidence" ADD CONSTRAINT "Evidence_incidentId_fkey" FOREIGN KEY ("incidentId") REFERENCES "Incident"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Partial Indexes on Alert
CREATE UNIQUE INDEX "uq_alert_source_event_id"
ON "Alert" ("alertSourceId", "sourceEventId")
WHERE "sourceEventId" IS NOT NULL;

CREATE UNIQUE INDEX "uq_alert_source_fingerprint"
ON "Alert" ("alertSourceId", "sourceFingerprint")
WHERE "sourceFingerprint" IS NOT NULL;