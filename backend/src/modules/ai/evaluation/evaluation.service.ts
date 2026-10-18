import { z } from 'zod';
import type { Prisma } from '../../../generated/prisma/client.js';
import { getPrisma } from '../../../infra/db/prisma.js';
import type { AiProvider } from '../ai-provider.js';
import { EVALUATION_INSTRUCTIONS } from './evaluation.prompt.js';
import { parseEvaluationOutput } from './evaluation.output.js';

/** Why an evaluation stored nothing; the message never carries provider text. */
export class EvaluationError extends Error {
  constructor(
    readonly kind: 'INVALID_SERVICE_ID' | 'SERVICE_NOT_FOUND' | 'NO_EVIDENCE' | 'OUTPUT_REJECTED',
    message: string,
  ) {
    super(message);
    this.name = 'EvaluationError';
  }
}

/** The guardrails applied, stored as the row's `constraints`. */
export const EVALUATION_CONSTRAINTS = [
  "Only each evidence record's id, relevanceInfo and evidenceType are sent to the provider",
  'The output must be a structured JSON object',
  'Every pattern is labelled FACTUAL, INFERENCE or UNKNOWN',
  'Every pattern cites existing evidence ids, which are its origin',
  'Unsupported output is rejected and nothing is stored',
] as const;

export type EvaluationDeps = { provider: AiProvider };

/**
 * The operator evaluation of a service (SLICE-12 §4.6): reads the `Evidence` of the service's
 * investigations, sends only `id`, `relevanceInfo` and `evidenceType`, validates the output and
 * stores one `Evaluation` row. `input` holds the service id and the data sent; `evidence` the
 * ids used; `constraints` the guardrails; each as JSON text, as the columns are strings.
 */
export async function runEvaluation(
  serviceIdArgument: string,
  deps: EvaluationDeps,
): Promise<{ evaluationId: string; patternCount: number }> {
  const parsed = z.uuid().safeParse(serviceIdArgument);
  if (!parsed.success)
    throw new EvaluationError('INVALID_SERVICE_ID', 'The service id is not a UUID');
  const serviceId = parsed.data;
  const db = getPrisma();

  const service = await db.appService.findUnique({
    where: { id: serviceId },
    select: { id: true },
  });
  if (service === null) throw new EvaluationError('SERVICE_NOT_FOUND', 'Service not found');

  const rows = await db.evidence.findMany({
    where: { investigation: { incident: { affectedServiceId: serviceId } } },
    select: { id: true, relevanceInfo: true, evidenceType: true },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  });
  if (rows.length === 0) {
    throw new EvaluationError('NO_EVIDENCE', 'The service has no evidence to evaluate');
  }
  const sent = rows.map((row) => ({
    id: row.id,
    relevanceInfo: row.relevanceInfo,
    evidenceType: row.evidenceType,
  }));

  const generated = await deps.provider.generate({
    instructions: EVALUATION_INSTRUCTIONS,
    input: { evidence: sent.map((record) => JSON.stringify(record)) },
  });

  const output = parseEvaluationOutput(generated.text, new Set(sent.map((record) => record.id)));
  if (!output.ok) {
    throw new EvaluationError(
      'OUTPUT_REJECTED',
      `The model output was rejected (fields: ${output.fields.join(', ')}); nothing was stored`,
    );
  }

  const stored = await db.evaluation.create({
    data: {
      input: JSON.stringify({ serviceId, evidence: sent }),
      evidence: JSON.stringify(sent.map((record) => record.id)),
      constraints: JSON.stringify(EVALUATION_CONSTRAINTS),
      result: output.value as Prisma.InputJsonObject,
    },
    select: { id: true },
  });
  return { evaluationId: stored.id, patternCount: output.value.patterns.length };
}
