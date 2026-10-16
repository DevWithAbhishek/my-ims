-- Notification delivery lifecycle (SLICE-09). Hand-written so existing rows are converted, not dropped.
-- The shared "LifecycleStates" enum is deliberately left untouched (AITriage still uses it).

-- CreateEnum
CREATE TYPE "NotificationDeliveryStatus" AS ENUM ('REQUESTED', 'RUNNING', 'COMPLETED', 'FAILED');

-- Move Notification.deliveryStatus to the dedicated enum: PENDING->REQUESTED, SUCCESS->COMPLETED,
-- FAILED->FAILED.
ALTER TABLE "Notification" ALTER COLUMN "deliveryStatus" DROP DEFAULT;
ALTER TABLE "Notification"
  ALTER COLUMN "deliveryStatus" TYPE "NotificationDeliveryStatus"
  USING (
    CASE "deliveryStatus"::text
      WHEN 'PENDING' THEN 'REQUESTED'
      WHEN 'SUCCESS' THEN 'COMPLETED'
      ELSE 'FAILED'
    END
  )::"NotificationDeliveryStatus";
ALTER TABLE "Notification" ALTER COLUMN "deliveryStatus" SET DEFAULT 'REQUESTED';

-- Add the event type. Rows written by the SLICE-05 stand-in did not store it, but their
-- idempotency key is "<eventType>:<auditEventId>" and no event type contains a colon, so the
-- event type is the key's first segment.
ALTER TABLE "Notification" ADD COLUMN "eventType" TEXT;
UPDATE "Notification" SET "eventType" = split_part("idempotencyKey", ':', 1);
ALTER TABLE "Notification" ALTER COLUMN "eventType" SET NOT NULL;
