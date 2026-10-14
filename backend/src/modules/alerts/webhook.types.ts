/** The alert source a request was verified against; `configuration` is read by SLICE-04. */
export type VerifiedAlertSource = {
  id: string;
  name: string;
  sourceType: string;
  configuration: Record<string, unknown>;
};

/** What the trust gate hands to ingestion (SLICE-04) once steps 1–6 passed. */
export type VerifiedAlertContext = {
  alertSource: VerifiedAlertSource;
  /** Alert elements in request order, at most 100; validated per alert by ingestion. */
  items: unknown[];
  /** Indices of `items` the source's rate limit has no capacity for (reported as `RATE_LIMITED`). */
  rateLimitedIndices: number[];
  /** For log correlation and the payload of outbox events written by ingestion. */
  requestId: string;
};

/**
 * The seam SLICE-04 fills: processes a verified request and returns the success response body
 * (sent with status 200).
 */
export type IngestHandler = (context: VerifiedAlertContext) => Promise<unknown>;
