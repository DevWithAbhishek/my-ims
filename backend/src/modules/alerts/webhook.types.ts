/** The alert source a request was verified against; `configuration` holds the severity mapping. */
export type VerifiedAlertSource = {
  id: string;
  name: string;
  sourceType: string;
  configuration: Record<string, unknown>;
};

/** What the trust gate hands to ingestion once steps 1–6 passed. */
export type VerifiedAlertContext = {
  alertSource: VerifiedAlertSource;
  /** Alert elements in request order, at most 100; validated per alert by ingestion. */
  items: unknown[];
  /** Indices of `items` the source's rate limit has no capacity for (reported as `RATE_LIMITED`). */
  rateLimitedIndices: number[];
  /** For log correlation and the payload of outbox events written by ingestion. */
  requestId: string;
};

/** What ingestion answers: the HTTP status (200, or 400 when every alert was rejected) and body. */
export type IngestResponse = { statusCode: 200 | 400; body: unknown };

/** Processes a verified request (SLICE-04) and returns the response to send. */
export type IngestHandler = (context: VerifiedAlertContext) => Promise<IngestResponse>;
