import { openValidationJobStore } from '../lib/validation-job-store-node.ts';
import { createOpenAIReviewProvider } from '../worker/feather-worker.js';
import { runValidationWorker } from '../worker/validation-runner.ts';

const provider = createOpenAIReviewProvider(process.env);
if (!provider.configured)
  throw new Error('Set OPENAI_API_KEY for the validation worker.');

const store = openValidationJobStore(process.env);
if (!store)
  throw new Error('Configure shared job storage for the validation worker.');

const shutdown = new AbortController();
process.once('SIGTERM', () => shutdown.abort());
process.once('SIGINT', () => shutdown.abort());

console.log('Validation worker is ready.');
try {
  await runValidationWorker(store, provider, shutdown.signal);
} finally {
  store.close?.();
}
