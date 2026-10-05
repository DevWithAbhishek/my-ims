export const SEVERITIES = ['P0', 'P1', 'P2', 'P3'] as const;
export type Severity = (typeof SEVERITIES)[number];

export type SlaField = `${Severity}ResponseSlaMinutes` | `${Severity}ResolutionSlaMinutes`;
export type SlaValues = Record<SlaField, number>;

export const SLA_FIELDS: readonly SlaField[] = SEVERITIES.flatMap(
  (severity) => [`${severity}ResponseSlaMinutes`, `${severity}ResolutionSlaMinutes`] as const,
);

/** PostgreSQL `integer` ceiling; larger values would fail at the database. */
export const MAX_SLA_MINUTES = 2_147_483_647;

/**
 * For each severity whose response and resolution values are both present, the resolution
 * must be at least the response. Returns one issue per violating severity (on the resolution field).
 */
export function slaOrderingIssues(values: Partial<SlaValues>): { field: string; issue: string }[] {
  const issues: { field: string; issue: string }[] = [];
  for (const severity of SEVERITIES) {
    const response = values[`${severity}ResponseSlaMinutes`];
    const resolution = values[`${severity}ResolutionSlaMinutes`];
    if (response !== undefined && resolution !== undefined && resolution < response) {
      issues.push({
        field: `${severity}ResolutionSlaMinutes`,
        issue: `Must be greater than or equal to ${severity}ResponseSlaMinutes`,
      });
    }
  }
  return issues;
}
