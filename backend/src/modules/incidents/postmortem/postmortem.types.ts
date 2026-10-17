import type { Severity, UserSummary } from '../incidents.types.js';

export type PostmortemGenerationStatus = 'GENERATING' | 'DRAFT' | 'FAILED';
export type PostmortemReviewStatus = 'PENDING' | 'REJECTED' | 'REVIEWED';
export type PostmortemFailureReason = 'AI_UNAVAILABLE' | 'OUTPUT_INVALID' | 'INSUFFICIENT_CONTEXT';

/** Every text field of a postmortem, by API name (`contributingFactors` is the column `factors`). */
export const POSTMORTEM_TEXT_FIELDS = [
  'summary',
  'impact',
  'detection',
  'timeline',
  'rootCause',
  'contributingFactors',
  'resolution',
  'correctiveActions',
  'preventiveActions',
] as const;

/** The editable content of a postmortem (P2): the text fields, `unknowns` and `riskLevel`. */
export const POSTMORTEM_CONTENT_FIELDS = [
  ...POSTMORTEM_TEXT_FIELDS,
  'unknowns',
  'riskLevel',
] as const;

export type PostmortemTextField = (typeof POSTMORTEM_TEXT_FIELDS)[number];

/** The content fields a P2 request may carry; absent keys stay untouched. */
export type PostmortemContentUpdate = Partial<
  Record<PostmortemTextField, string> & { unknowns: string | null; riskLevel: Severity }
>;

/** The postmortem row as read under `FOR UPDATE`. */
export type LockedPostmortem = {
  id: string;
  generationStatus: PostmortemGenerationStatus;
  reviewStatus: PostmortemReviewStatus;
};

/** `PostmortemResponse`. `prompt` and `inputData` are never part of it. */
export type PostmortemResponse = {
  id: string;
  incidentId: string;
  generationStatus: PostmortemGenerationStatus;
  reviewStatus: PostmortemReviewStatus;
  aiGenerated: boolean;
  summary: string | null;
  impact: string | null;
  detection: string | null;
  timeline: string | null;
  rootCause: string | null;
  contributingFactors: string | null;
  resolution: string | null;
  correctiveActions: string | null;
  preventiveActions: string | null;
  unknowns: string | null;
  mttrMinutes: number | null;
  riskLevel: Severity | null;
  provenance: { model: string | null; modelVersion: string | null; generatedAt: string | null };
  review: { reviewedBy: UserSummary; reviewedAt: string } | null;
  failureReason: PostmortemFailureReason | null;
};
