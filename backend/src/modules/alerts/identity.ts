import { createHash } from 'node:crypto';
import type { NormalizedAlert } from './alert-input.js';

export type AlertIdentity = {
  /** Which stored column an identity lookup uses. */
  kind: 'EVENT_ID' | 'FINGERPRINT';
  /** The event id or the (supplied or derived) fingerprint. */
  value: string;
  /** Namespaced by kind, so an event id can never collide with a fingerprint. */
  activeIdentityKey: string;
  /** What is stored in `Alert.sourceFingerprint`: the supplied one, or the derived one. */
  sourceFingerprint: string | null;
};

/**
 * Deterministic fingerprint of `serviceId + name + environment + sorted labels` only, so any other
 * field (summary, severity, timestamps, payload noise) can change without changing identity.
 */
export function deriveFingerprint(
  alert: Pick<NormalizedAlert, 'serviceId' | 'name' | 'environment' | 'labels'>,
): string {
  const canonical = JSON.stringify([
    alert.serviceId,
    alert.name,
    alert.environment,
    [...alert.labels].sort(),
  ]);
  return createHash('sha256').update(canonical).digest('hex');
}

/**
 * Precedence: `sourceEventId`, else `sourceFingerprint`, else a derived fingerprint. `null` when
 * neither is supplied and the derived one cannot be formed (no `name` and no `labels`).
 */
export function resolveIdentity(alert: NormalizedAlert): AlertIdentity | null {
  if (alert.sourceEventId !== null) {
    return {
      kind: 'EVENT_ID',
      value: alert.sourceEventId,
      activeIdentityKey: `event:${alert.sourceEventId}`,
      sourceFingerprint: alert.sourceFingerprint,
    };
  }
  if (alert.sourceFingerprint !== null) {
    return fingerprintIdentity(alert.sourceFingerprint);
  }
  if (alert.name === null && alert.labels.length === 0) return null;
  return fingerprintIdentity(deriveFingerprint(alert));
}

function fingerprintIdentity(fingerprint: string): AlertIdentity {
  return {
    kind: 'FINGERPRINT',
    value: fingerprint,
    activeIdentityKey: `fingerprint:${fingerprint}`,
    sourceFingerprint: fingerprint,
  };
}
