-- SLICE-04: lookup indexes for alert identity.
--
-- The init migration created these two as partial UNIQUE indexes. Identity must be allowed to
-- repeat: once an incident is resolved, a later FIRING delivery of the same identity creates a
-- new alert (and incident) that carries the same sourceEventId / sourceFingerprint. Deduplication
-- of unresolved incidents is enforced by the unique (alertSourceId, activeIdentityKey) key, so
-- these two become plain (non-unique) lookup indexes used by source-resolved deliveries.
DROP INDEX "uq_alert_source_event_id";
DROP INDEX "uq_alert_source_fingerprint";

CREATE INDEX "idx_alert_sourceId_sourceEventId" ON "Alert" ("alertSourceId", "sourceEventId");
CREATE INDEX "idx_alert_sourceId_fingerprint" ON "Alert" ("alertSourceId", "sourceFingerprint");
