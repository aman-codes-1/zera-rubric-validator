import { createServer } from 'node:http';

import next from 'next';

import { PRODUCT_NAME } from '../lib/constants.mjs';
import { handleValidationRequest } from '../worker/feather-worker.js';

const devHost = process.env.DEV_HOST || 'localhost';
const devPort = Number(process.env.DEV_PORT || 3000);
const nextApp = next({ dev: true, hostname: devHost, port: devPort });
const handleNextRequest = nextApp.getRequestHandler();

await nextApp.prepare();

createServer(async (request, response) => {
  const requestUrl = new URL(
    request.url || '/',
    `http://${request.headers.host || `${devHost}:${devPort}`}`,
  );

  if (
    (request.method === 'POST' || request.method === 'GET') &&
    (requestUrl.pathname === '/api/validate' ||
      requestUrl.pathname === '/api/validate/')
  ) {
    try {
      const bodyChunks = [];
      if (request.method === 'POST') {
        for await (const chunk of request) bodyChunks.push(chunk);
      }

      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (Array.isArray(value)) {
          for (const item of value) headers.append(name, item);
        } else if (value !== undefined) {
          headers.set(name, value);
        }
      }

      const apiResponse = await handleValidationRequest(
        new Request(requestUrl, {
          method: request.method,
          headers,
          ...(request.method === 'POST'
            ? { body: Buffer.concat(bodyChunks) }
            : {}),
        }),
        {
          OPENAI_API_KEY: process.env.OPENAI_API_KEY,
          OPENAI_MODEL: process.env.OPENAI_MODEL,
        },
      );

      response.statusCode = apiResponse.status;
      for (const [name, value] of apiResponse.headers)
        response.setHeader(name, value);
      response.end(Buffer.from(await apiResponse.arrayBuffer()));
      return;
    } catch {
      response.statusCode = 500;
      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(
        JSON.stringify({
          error:
            'AI documentation review is temporarily unavailable. Please try again.',
        }),
      );
      return;
    }
  }

  await handleNextRequest(request, response);
}).listen(devPort, devHost, () => {
  console.log(`${PRODUCT_NAME} development server ready at http://${devHost}:${devPort}`);
});
