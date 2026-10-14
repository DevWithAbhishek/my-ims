export type Severity = 'P0' | 'P1' | 'P2' | 'P3';

const SEVERITIES: readonly string[] = ['P0', 'P1', 'P2', 'P3'];

function isSeverity(value: unknown): value is Severity {
  return typeof value === 'string' && SEVERITIES.includes(value);
}

/**
 * The source's own mapping (`configuration.severityMapping`: source severity → `P0..P3`), keyed by
 * the lower-cased source severity. Entries that do not map to a severity are ignored.
 */
function readMapping(configuration: Record<string, unknown>): Map<string, Severity> {
  const mapping = new Map<string, Severity>();
  const raw = configuration.severityMapping;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return mapping;
  for (const [key, value] of Object.entries(raw)) {
    const normalized = key.toLowerCase();
    if (isSeverity(value) && !mapping.has(normalized)) mapping.set(normalized, value);
  }
  return mapping;
}

/**
 * Initial severity: the source's mapping applied to `sourceSeverity` (case-insensitive, otherwise
 * exact); an unrecognized or absent value, or a source without a mapping, uses the service default.
 */
export function resolveInitialSeverity(
  configuration: Record<string, unknown>,
  sourceSeverity: string | null,
  defaultSeverity: Severity,
): Severity {
  if (sourceSeverity === null) return defaultSeverity;
  return readMapping(configuration).get(sourceSeverity.toLowerCase()) ?? defaultSeverity;
}
