import type { NormalizedAlert } from './alert-input.js';

export type IncidentText = { title: string; description: string };

/**
 * `title` = the alert's `name`, else its `summary`; `description` = `description` and `summary`
 * joined by a blank line, absent (or empty) parts skipped (so it can be empty). `null` when the alert has
 * neither `name` nor `summary` and therefore cannot open an incident.
 */
export function deriveIncidentText(
  alert: Pick<NormalizedAlert, 'name' | 'summary' | 'description'>,
): IncidentText | null {
  const title = alert.name ?? alert.summary;
  if (title === null) return null;
  const description = [alert.description, alert.summary]
    .filter((part): part is string => part !== null && part !== '')
    .join('\n\n');
  return { title, description };
}
