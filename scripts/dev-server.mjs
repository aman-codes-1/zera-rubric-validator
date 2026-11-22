import { createServer } from 'node:http';

import next from 'next';

import { PRODUCT_NAME } from '../lib/constants.mjs';

const devHost = process.env.DEV_HOST || 'localhost';
const devPort = Number(process.env.DEV_PORT || 3000);
const nextApp = next({ dev: true, hostname: devHost, port: devPort });
const handleNextRequest = nextApp.getRequestHandler();

await nextApp.prepare();

createServer(handleNextRequest).listen(devPort, devHost, () => {
  console.log(
    `${PRODUCT_NAME} development server ready at http://${devHost}:${devPort}`,
  );
});
