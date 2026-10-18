import { getAiConfig, getConfig } from '../config/env.js';
import { disconnectPrisma } from '../infra/db/prisma.js';
import { createGeminiAiProvider, EvaluationError, runEvaluation } from '../modules/ai/index.js';

/** Usage: npm run ai:evaluate -- --service <serviceId> */
async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const flag = args.indexOf('--service');
  const serviceId = flag >= 0 ? args[flag + 1] : undefined;
  if (!serviceId || serviceId.startsWith('--') || args.length !== 2) {
    console.error('Usage: npm run ai:evaluate -- --service <serviceId>');
    return 2;
  }

  getConfig();
  const ai = getAiConfig();
  const provider = createGeminiAiProvider({
    apiKey: ai.geminiApiKey,
    model: ai.geminiModel,
    requestTimeoutMs: ai.requestTimeoutMs,
  });
  try {
    const { evaluationId, patternCount } = await runEvaluation(serviceId, { provider });
    console.log(`Evaluation ${evaluationId} stored (${patternCount} patterns).`);
    return 0;
  } catch (error) {
    if (error instanceof EvaluationError) {
      console.error(`Not stored: ${error.message}`);
      return 1;
    }
    throw error;
  } finally {
    await disconnectPrisma();
  }
}

main().then(
  (code) => process.exit(code),
  (error: unknown) => {
    console.error(error instanceof Error ? error.name : 'Evaluation failed');
    process.exit(1);
  },
);
