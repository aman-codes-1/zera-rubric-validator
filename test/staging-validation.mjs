import assert from 'node:assert/strict';
import { execFile as runFile, spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { openValidationJobStore } from '../lib/validation-job-store-node.ts';
import { batch, completeReview } from './fixtures/validation-input.mjs';

const execFile = promisify(runFile);
const root = fileURLToPath(new URL('..', import.meta.url));
const useRedis = process.argv.includes('--redis');
const scratch = await mkdtemp(join(tmpdir(), 'zera-staging-'));
const children = new Set();
const servers = new Set();
const input = batch();
input.rubrics[0].criterion = 'Original criterion without a section prefix.';
const repairedCriterion = 'Invoice: Verify the repaired criterion.';
const review = completeReview(input);
const busyRepair = Promise.withResolvers();
const busyCancellation = Promise.withResolvers();
const upstreamRequests = [];
const browserRequests = [];
let activeBatch = 'restart';
let repairPolls = 0;
let store;

const env = {
  ...process.env,
  VERCEL: '0',
  OPENAI_API_KEY: 'staging-fixture-only',
  OPENAI_MODEL: 'staging-fixture',
  UPSTASH_REDIS_REST_URL: '',
  UPSTASH_REDIS_REST_TOKEN: '',
  VALIDATION_JOB_NAMESPACE: 'zera-staging:' + crypto.randomUUID(),
  VALIDATION_JOB_DB_PATH: join(scratch, 'jobs.sqlite'),
  NEXT_TELEMETRY_DISABLED: '1',
};

function launch(label, executable, args) {
  const process = spawn(executable, args, {
    cwd: root,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const instance = { label, process, log: '', exited: false };
  const record = (chunk) => {
    instance.log = (instance.log + chunk.toString()).slice(-8_000);
  };
  process.stdout.on('data', record);
  process.stderr.on('data', record);
  instance.finished = new Promise((resolve) => {
    process.once('exit', (code, signal) => {
      instance.exited = true;
      resolve({ code, signal });
    });
    process.once('error', (error) => {
      instance.exited = true;
      record(error.message);
      resolve({ code: 1, signal: null });
    });
  });
  children.add(instance);
  return instance;
}

async function stop(instance, signal = 'SIGTERM') {
  if (!instance.exited) instance.process.kill(signal);
  const timeout = Symbol('timeout');
  const result = await Promise.race([
    instance.finished,
    delay(15_000, timeout, { ref: false }),
  ]);
  if (result !== timeout) return result;

  instance.process.kill('SIGKILL');
  await instance.finished;
  throw new Error(instance.label + ' did not stop in time.');
}

async function waitFor(description, condition, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await condition();
    if (result) return result;
    await delay(125);
  }
  throw new Error('Timed out waiting for ' + description + '.');
}

async function listen(handler) {
  const server = createServer((request, response) => {
    void Promise.resolve()
      .then(() => handler(request, response))
      .catch((error) => {
        if (!response.headersSent)
          send(response, { error: error.message }, 500);
        else response.end();
      });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  servers.add(server);
  return 'http://127.0.0.1:' + server.address().port;
}

function send(response, body, status = 200) {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

function upstreamReply(response, id, status, output) {
  send(response, {
    id,
    status,
    ...(output ? { output_text: JSON.stringify(output) } : {}),
  });
}

async function openAI(request, response) {
  const { pathname } = new URL(request.url, 'http://127.0.0.1');
  const method = request.method;
  upstreamRequests.push([method, pathname]);

  if (pathname === '/v1/responses' && method === 'POST') {
    const body = await readJson(request);
    assert.equal(body.background, true);
    if (activeBatch === 'cancel') {
      return upstreamReply(response, 'resp_cancel', 'queued');
    }
    if (body.text.format.name === 'rubric_validation') {
      return upstreamReply(response, 'resp_review', 'queued');
    }
    assert.equal(body.text.format.name, 'rubric_correction_repair');
    assert.match(body.input, /Original criterion without a section prefix/);
    return upstreamReply(response, 'resp_repair', 'queued');
  }
  if (pathname === '/v1/responses/resp_review' && method === 'GET') {
    return upstreamReply(response, 'resp_review', 'completed', review);
  }
  if (pathname === '/v1/responses/resp_repair' && method === 'GET') {
    repairPolls++;
    // Leave the repair request in flight so the worker can be killed with its lease held.
    if (repairPolls === 1) {
      busyRepair.resolve(response);
      return;
    }
    // Replay the previous stage's completed response out of order.
    if (repairPolls === 2)
      return upstreamReply(response, 'resp_review', 'completed', review);
    return upstreamReply(response, 'resp_repair', 'completed', {
      corrections: [
        { index: 0, field: 'criterion', correctedText: repairedCriterion },
      ],
    });
  }
  if (pathname === '/v1/responses/resp_cancel' && method === 'GET') {
    busyCancellation.resolve(response);
    return;
  }
  if (pathname === '/v1/responses/resp_cancel/cancel' && method === 'POST') {
    return upstreamReply(response, 'resp_cancel', 'cancelled');
  }
  send(response, { error: 'Unexpected request to the staging provider.' }, 404);
}

async function redisGateway() {
  const socket = join(scratch, 'redis.sock');
  const redis = launch('Redis', process.env.REDIS_SERVER || 'redis-server', [
    '--port',
    '0',
    '--unixsocket',
    socket,
    '--save',
    '',
    '--appendonly',
    'no',
    '--dir',
    scratch,
  ]);
  const command = async (args) => {
    const { stdout } = await execFile(
      process.env.REDIS_CLI || 'redis-cli',
      ['-s', socket, '--json', ...args.map(String)],
      { maxBuffer: 1_048_576, timeout: 3_000 },
    );
    return JSON.parse(stdout);
  };

  await waitFor('Redis to accept local connections', async () => {
    if (redis.exited) throw new Error('Redis failed to start.');
    try {
      return (await command(['PING'])) === 'PONG';
    } catch {
      return false;
    }
  });
  env.UPSTASH_REDIS_REST_TOKEN = 'staging-redis-token';
  env.UPSTASH_REDIS_REST_URL = await listen(async (request, response) => {
    assert.equal(
      request.headers.authorization,
      'Bearer ' + env.UPSTASH_REDIS_REST_TOKEN,
    );
    send(response, { result: await command(await readJson(request)) });
  });
  return command;
}

const nodeArgs = ['--import', './test/fixtures/staging-openai.mjs'];
function worker(label) {
  return launch(label, process.execPath, [
    ...nodeArgs,
    '--experimental-strip-types',
    'scripts/validation-worker.mjs',
  ]);
}

async function run() {
  const redis = useRedis ? await redisGateway() : null;
  env.ZERA_STAGING_PROVIDER = await listen(openAI);
  store = openValidationJobStore(env);
  assert.ok(store);

  // Take a loopback port for the independently launched production Next.js process.
  const portReservation = createServer();
  portReservation.listen(0, '127.0.0.1');
  await once(portReservation, 'listening');
  const { port } = portReservation.address();
  await new Promise((resolve) => portReservation.close(resolve));
  const front = 'http://127.0.0.1:' + port + '/api/validate';
  const web = launch('Next.js', process.execPath, [
    ...nodeArgs,
    'node_modules/next/dist/bin/next',
    'start',
    '--hostname',
    '127.0.0.1',
    '--port',
    String(port),
  ]);
  await waitFor('the production Next.js server', () => {
    if (web.exited)
      throw new Error('Next.js failed to start. Run npm run build first.');
    return /Ready in/.test(web.log);
  });

  let cookie;
  async function api(method = 'GET', body, query = '') {
    browserRequests.push(method);
    const headers = {
      ...(cookie ? { cookie } : {}),
      ...(body ? { 'content-type': 'application/json' } : {}),
    };
    const response = await fetch(front + query, {
      method,
      headers,
      ...(method === 'POST' ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(12_000),
    });
    if (!cookie) cookie = response.headers.get('set-cookie')?.split(';')[0];
    return { status: response.status, ...(await response.json()) };
  }

  assert.equal((await api()).job, null);
  const owner = cookie.split('=')[1];
  const jobId = crypto.randomUUID();
  const request = { jobId, previousJobId: null, input };
  const initial = await api('POST', request);
  assert.equal(initial.status, 202);
  assert.equal(
    (await api('POST', { ...request, jobId: crypto.randomUUID() })).job.id,
    jobId,
  );

  if (redis) {
    // Model an existing Redis job written by the version before the queue existed.
    assert.equal(
      await redis(['ZREM', env.VALIDATION_JOB_NAMESPACE + ':due', owner]),
      1,
    );
  }

  const clientTrafficBeforeClosing = browserRequests.length;
  const first = worker('First worker');
  const blockedRepair = await Promise.race([
    busyRepair.promise,
    first.finished.then(() => {
      throw new Error('The first worker stopped early.');
    }),
    delay(15_000, null, { ref: false }),
  ]);
  assert.ok(blockedRepair, 'The first worker must begin correction polling.');
  const beforeRestart = await store.read(owner);
  assert.equal(beforeRestart.job.responseId, 'resp_repair');
  assert.ok(beforeRestart.job.leaseUntil > Date.now());
  assert.equal((await stop(first, 'SIGKILL')).signal, 'SIGKILL');

  const replacement = worker('Replacement worker');
  const peer = worker('Concurrent worker');
  const published = await waitFor(
    'a finished report after restart',
    async () => {
      const snapshot = await store.read(owner);
      return snapshot?.job.status === 'completed' ? snapshot : null;
    },
    70_000,
  );
  assert.equal(
    browserRequests.length,
    clientTrafficBeforeClosing,
    'The client must be idle during recovery.',
  );
  assert.equal(published.job.id, jobId);
  assert.equal(
    published.job.result.rubricReviews[0].correctedRubric.criterion,
    repairedCriterion,
  );
  assert.equal(published.job.warning, undefined);
  assert.equal(repairPolls, 3);
  assert.equal(
    upstreamRequests.filter(
      ([method, path]) => method === 'POST' && path === '/v1/responses',
    ).length,
    2,
  );
  assert.deepEqual(await store.due(Date.now(), 4), []);
  assert.equal((await api()).job.status, 'completed');
  console.log(
    'Recovered the repair after SIGKILL with zero client traffic, discarded a replayed completion, and saved one report.',
  );

  activeBatch = 'cancel';
  const nextId = crypto.randomUUID();
  assert.equal(
    (await api('POST', { ...request, jobId: nextId, previousJobId: jobId }))
      .status,
    202,
  );
  const lateProviderReply = await Promise.race([
    busyCancellation.promise,
    delay(20_000, null, { ref: false }),
  ]);
  assert.ok(
    lateProviderReply,
    'The worker must be polling before cancellation.',
  );
  assert.equal(
    (await api('DELETE', undefined, '?jobId=' + nextId)).job.status,
    'cancelled',
  );
  const cancelled = await store.read(owner);
  upstreamReply(lateProviderReply, 'resp_cancel', 'completed', review);
  assert.equal((await stop(replacement)).code, 0);
  assert.equal((await stop(peer)).code, 0);
  assert.deepEqual(await store.read(owner), cancelled);
  const final = (await api()).job;
  assert.equal(final.status, 'cancelled');
  assert.equal(Object.hasOwn(final, 'result'), false);
  assert.equal(
    upstreamRequests.filter(([, path]) => path.endsWith('/cancel')).length,
    1,
  );
  console.log('Cancellation remained final after a late provider success.');
  console.log(
    'Staging exercise passed with ' +
      (useRedis ? 'Redis through a local REST gateway.' : 'SQLite.'),
  );
}

try {
  await run();
} catch (error) {
  for (const child of children) console.error(child.label + '\n' + child.log);
  throw error;
} finally {
  await Promise.allSettled(
    [...children].map((child) => stop(child, 'SIGKILL')),
  );
  for (const server of servers) {
    server.close();
    server.closeAllConnections();
  }
  store?.close?.();
  await rm(scratch, { recursive: true, force: true });
}
