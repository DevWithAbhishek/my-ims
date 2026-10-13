-- AlterEnum
-- PostgreSQL does not allow a newly added enum value to be used in the transaction that adds it,
-- so this migration only adds the values; nothing in it (or in the same transaction) uses them.
ALTER TYPE "AuditEventType" ADD VALUE 'USER_UPDATED';
ALTER TYPE "AuditEventType" ADD VALUE 'USER_DEACTIVATED';
ALTER TYPE "AuditEventType" ADD VALUE 'TEAM_UPDATED';
ALTER TYPE "AuditEventType" ADD VALUE 'TEAM_DEACTIVATED';
ALTER TYPE "AuditEventType" ADD VALUE 'SERVICE_UPDATED';
ALTER TYPE "AuditEventType" ADD VALUE 'SERVICE_DEACTIVATED';
ALTER TYPE "AuditEventType" ADD VALUE 'ESCALATION_POLICY_UPDATED';
ALTER TYPE "AuditEventType" ADD VALUE 'ALERT_SOURCE_UPDATED';
