export type AlertIngestOutcome =
  'INCIDENT_CREATED' | 'DUPLICATE' | 'SOURCE_RESOLVED_RECORDED' | 'REJECTED';

/** Item-level codes; never an HTTP status of the webhook response. */
export type AlertIngestErrorCode =
  | 'ALERT_INVALID'
  | 'UNKNOWN_SERVICE'
  | 'IDENTITY_UNRESOLVABLE'
  | 'SERVICE_DEACTIVATED'
  | 'RATE_LIMITED';

export type AlertIngestResult = {
  index: number;
  outcome: AlertIngestOutcome;
  alertId: string | null;
  incidentId: string | null;
  error: { code: AlertIngestErrorCode; message: string } | null;
};

/** The outcome of one alert, before its position in the request is attached. */
export type ItemOutcome = Omit<AlertIngestResult, 'index'>;

export type AlertIngestResponse = { data: { results: AlertIngestResult[] } };

const REJECTION_MESSAGES: Record<AlertIngestErrorCode, string> = {
  ALERT_INVALID: 'The alert is invalid',
  UNKNOWN_SERVICE: 'The service does not exist',
  IDENTITY_UNRESOLVABLE:
    'The alert has no identity: provide sourceEventId, sourceFingerprint, name or labels',
  SERVICE_DEACTIVATED: 'The service is deactivated',
  RATE_LIMITED: 'The source exceeded its rate limit; resend this alert later',
};

export function rejected(code: AlertIngestErrorCode, detail?: string): ItemOutcome {
  const base = REJECTION_MESSAGES[code];
  return {
    outcome: 'REJECTED',
    alertId: null,
    incidentId: null,
    error: { code, message: detail === undefined ? base : `${base}: ${detail}` },
  };
}
