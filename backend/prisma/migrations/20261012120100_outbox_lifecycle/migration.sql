-- Outbox lifecycle (SLICE-08). Hand-written so existing rows are converted, not dropped.
-- The shared "LifecycleStates" enum is deliberately left untouched (AITriage and Notification use it).

-- CreateEnum
CREATE TYPE "OutboxStatus" AS ENUM ('PENDING', 'PROCESSING', 'SUCCESS', 'DEAD_LETTER');

-- Move OutboxEvent.status to the dedicated enum: PENDING->PENDING, SUCCESS->SUCCESS, FAILED->DEAD_LETTER.
ALTER TABLE "OutboxEvent" ALTER COLUMN "status" DROP DEFAULT;
ALTER TABLE "OutboxEvent"
  ALTER COLUMN "status" TYPE "OutboxStatus"
  USING (CASE "status"::text WHEN 'FAILED' THEN 'DEAD_LETTER' ELSE "status"::text END)::"OutboxStatus";
ALTER TABLE "OutboxEvent" ALTER COLUMN "status" SET DEFAULT 'PENDING';

-- Replace the single attempt counter with the two stage counters. Existing attempts were attempts
-- to process an event, so they carry over as execution attempts.
ALTER TABLE "OutboxEvent"
  ADD COLUMN "publishAttemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "executionAttemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "publishedAt" TIMESTAMP(3),
  ADD COLUMN "leaseExpiresAt" TIMESTAMP(3),
  ADD COLUMN "errorClass" TEXT,
  ADD COLUMN "lastError" TEXT;
UPDATE "OutboxEvent" SET "executionAttemptCount" = "attemptCount";
ALTER TABLE "OutboxEvent" DROP COLUMN "attemptCount";

-- CreateIndex: relay claim query and retention deletion
CREATE INDEX "idx_outbox_claim" ON "OutboxEvent"("status", "availableAt", "leaseExpiresAt");
CREATE INDEX "idx_outbox_retention" ON "OutboxEvent"("status", "processedAt");
