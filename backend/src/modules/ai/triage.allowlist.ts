/**
 * The data allow-list of alert triage (SLICE-10 §4.1): the only fields of an `Alert` that may be
 * sent to the provider. Nothing else: no payload, no identifiers, no credentials, no incident or
 * service data. No further redaction inside these fields is specified.
 */
export const TRIAGE_ALLOWED_FIELDS = [
  'summary',
  'description',
  'labels',
  'additionalDetails',
] as const;

export type TriageAllowedFields = {
  summary: string | null;
  description: string | null;
  labels: string[];
  additionalDetails: string | null;
};

/** Copies exactly the allow-listed fields, whatever else the source object carries. */
export function projectAllowedFields(alert: TriageAllowedFields): TriageAllowedFields {
  return {
    summary: alert.summary,
    description: alert.description,
    labels: [...alert.labels],
    additionalDetails: alert.additionalDetails,
  };
}
