import { createServer } from 'node:http';

import next from 'next';

import { openValidationJobStore } from '../lib/validation-job-store-node.ts';
import { createOpenAIReviewProvider } from '../worker/feather-worker.js';
import { runValidationWorker } from '../worker/validation-runner.ts';
import { PRODUCT_NAME } from '../lib/constants.mjs';

const devHost = process.env.DEV_HOST || 'localhost';
const devPort = Number(process.env.DEV_PORT || 3000);
const nextApp = next({ dev: true, hostname: devHost, port: devPort });
const handleNextRequest = nextApp.getRequestHandler();

await nextApp.prepare();

const server = createServer(handleNextRequest);
const provider = createOpenAIReviewProvider(process.env);
if (provider.configured) {
  try {
    const store = openValidationJobStore(process.env);
    if (store) {
      const shutdown = new AbortController();
      server.once('close', () => shutdown.abort());
      void runValidationWorker(store, provider, shutdown.signal)
        .finally(() => store.close?.())
        .catch(() => {
          console.error(
            'The development validation worker stopped unexpectedly.',
          );
        });
    }
  } catch {
    console.error(
      'The development validation worker could not open job storage.',
    );
  }
}

server.listen(devPort, devHost, () => {
  console.log(
    `${PRODUCT_NAME} development server ready at http://${devHost}:${devPort}`,
  );
});
