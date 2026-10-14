export type AlertDetailResponse = {
  id: string;
  name: string | null;
  environment: string;
  sourceSeverity: string | null;
  initialSeverity: 'P0' | 'P1' | 'P2' | 'P3' | null;
  sourceStatus: 'FIRING' | 'RESOLVED';
  startedAt: string;
  endedAt: string | null;
  sourceUrl: string | null;
  alertSource: { id: string; name: string };
  sourceEventId: string | null;
  sourceFingerprint: string | null;
  summary: string | null;
  description: string | null;
  labels: string[];
  additionalDetails: string | null;
  /** The delivered element exactly as stored; only this endpoint exposes it. */
  originalPayload: unknown;
};
