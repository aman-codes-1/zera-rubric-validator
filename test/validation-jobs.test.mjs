import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as defer } from 'node:timers/promises';
import { test } from 'node:test';

import { validateRubric } from '../lib/rubric-validation.ts';
import { createValidationJobHandler } from '../lib/validation-job-api.ts';
import { createValidationJobClient } from '../lib/validation-job-client.ts';
import { createRedisJobStore } from '../lib/validation-job-redis.ts';
import { createSqliteJobStore } from '../lib/validation-job-sqlite.ts';
import { createOpenAIReviewProvider } from '../worker/feather-worker.js';

const URL_ROOT = 'https://validator.test';
const INITIAL_TIME = Date.UTC(2026, 0, 1);

function batch() {
  return {
    application: 'quickbooks',
    batch: 'Batch C',
    rubrics: Array.from({ length: 10 }, (_, index) => ({
      criterion: 'Invoice: Verify the invoice total.',
      score: 10,
      tags: [index < 3 ? 'bug' : 'feature request'],
      forms: {
        page_or_workflow: 'Invoice details',
        reproduction_steps: index < 3 ? '1. Open the invoice.' : 'N/A',
        expected_behavior: 'The invoice displays the updated total.',
        actual_behavior: 'The invoice displays the original total.',
      },
    })),
  };
}

function completeReview(input, findings = []) {
  const docs = {
    title: 'Invoice guidance',
    url: 'https://quickbooks.intuit.com/learn-support/invoices',
  };
  return {
    applicationBrief: 'QuickBooks invoice documentation.',
    applicationsReviewed: [
      {
        id: 'quickbooks',
        name: 'QuickBooks',
        role: 'selected',
        officialDomains: ['quickbooks.intuit.com'],
        documentationSources: [docs],
      },
    ],
    sources: [docs],
    rubricReviews: input.rubrics.map((rubric, index) => ({
      index,
      criterionSection: 'Invoice',
      documentationStatus: index < 3 ? 'not_applicable' : 'supported',
      documentationSummary:
        index < 3 ? 'Grammar only.' : 'An invoice displays a total.',
      findings: index === 3 ? findings : [],
      correctedRubric: rubric,
    })),
  };
}

function backgroundResponse(id, status, result) {
  return Response.json({
    id,
    status,
    ...(result ? { output_text: JSON.stringify(result) } : {}),
  });
}

function fakeProvider(overrides = {}) {
  return {
    configured: true,
    async start() {
      return { responseId: 'resp_review' };
    },
    async poll(input) {
      return { result: completeReview(input) };
    },
    async cancel() {},
    ...overrides,
  };
}

function database(t) {
  const directory = mkdtempSync(join(tmpdir(), 'zera-jobs-'));
  const filename = join(directory, 'jobs.sqlite');
  const openStores = new Set();
  t.after(() => {
    for (const db of openStores) db.close();
    rmSync(directory, { recursive: true, force: true });
  });
  let time = INITIAL_TIME;
  const now = () => time;
  return {
    now,
    move(ms) {
      time += ms;
    },
    open() {
      const store = createSqliteJobStore(filename, now);
      openStores.add(store);
      return store;
    },
    close(store) {
      openStores.delete(store);
      store.close();
    },
  };
}

function browser(handler) {
  let handle = handler;
  let cookie = '';
  return {
    replace(next) {
      handle = next;
    },
    get owner() {
      return cookie.split('=')[1];
    },
    async fetch(path, init = {}) {
      const headers = new Headers(init.headers);
      if (cookie) headers.set('cookie', cookie);
      const response = await handle(
        new Request(new URL(path, URL_ROOT), { ...init, headers }),
      );
      const setCookie = response.headers.get('set-cookie');
      if (setCookie) cookie = setCookie.split(';')[0];
      return response;
    },
    async send(method = 'GET', { id, body, headers } = {}) {
      const response = await this.fetch(
        '/api/validate' + (id ? '?jobId=' + id : ''),
        {
          method,
          headers:
            body === undefined
              ? headers
              : { 'content-type': 'application/json', ...headers },
          body: body === undefined ? undefined : JSON.stringify(body),
        },
      );
      return {
        status: response.status,
        headers: response.headers,
        ...(await response.json()),
      };
    },
    async submit(
      input = batch(),
      jobId = crypto.randomUUID(),
      previousJobId = null,
    ) {
      return this.send('POST', { body: { jobId, previousJobId, input } });
    },
  };
}

void test('persists review and repair stages across restarts and keeps validation and documentation evidence', async (t) => {
  const db = database(t);
  let store = db.open();
  const input = batch();
  input.rubrics[0].score = 2;
  input.rubrics[0].forms.reproduction_steps = '2. Open the invoice.';
  input.rubrics[1].forms.actual_behavior =
    'The Workday invoice displays the original total.';
  const original = input.rubrics[3].forms.expected_behavior;
  const replacement = 'The invoice details display the revised amount due.';
  const review = completeReview(input, [
    {
      kind: 'documentation',
      severity: 'warning',
      field: 'expected_behavior',
      message: 'Name the amount shown in the invoice details.',
      suggestion: 'Use the documented amount due.',
      lineNumber: null,
      excerpt: '',
      correctedText: original,
    },
  ]);
  const calls = [];
  const provider = createOpenAIReviewProvider(
    { OPENAI_API_KEY: 'test-key' },
    async (url, init) => {
      calls.push({ url, ...init });
      const path = new URL(url).pathname;
      if (init.method === 'GET') {
        if (path.endsWith('resp_review'))
          return backgroundResponse('resp_review', 'completed', review);
        return backgroundResponse('resp_repair', 'completed', {
          corrections: [
            {
              index: 3,
              field: 'expected_behavior',
              correctedText: replacement,
            },
            {
              index: 0,
              field: 'criterion',
              correctedText: 'An unsolicited rewrite.',
            },
          ],
        });
      }
      const body = JSON.parse(init.body);
      if (body.text.format.name === 'rubric_validation') {
        assert.equal(body.background, true);
        assert.equal(body.store, true);
        assert.equal(body.metadata.application_scope, 'quickbooks,workday');
        assert.deepEqual(body.tools, [{ type: 'web_search' }]);
        return backgroundResponse('resp_review', 'queued');
      }
      assert.equal(body.text.format.name, 'rubric_correction_repair');
      assert.deepEqual(body.tools, [{ type: 'web_search' }]);
      assert.match(body.input, /Use the documented amount due/);
      return backgroundResponse('resp_repair', 'in_progress');
    },
  );

  const tab = browser(createValidationJobHandler(store, provider, db.now));
  const boot = await tab.send();
  assert.equal(boot.job, null);
  assert.match(
    boot.headers.get('set-cookie'),
    /HttpOnly; SameSite=Strict; Secure/,
  );

  const { status, job } = await tab.submit(input);
  const id = job.id;
  assert.equal(status, 202);
  assert.equal(job.status, 'queued');
  assert.equal(calls.length, 0);
  const started = await tab.send('PATCH', { id });
  assert.equal(started.job.status, 'running');
  assert.equal(started.job.phase, 'review');
  assert.equal(Object.hasOwn(started.job, 'responseId'), false);

  db.close(store);
  store = db.open();
  tab.replace(createValidationJobHandler(store, provider, db.now));
  const recovered = await tab.send();
  assert.equal(recovered.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(recovered.job.input, input);
  assert.equal(recovered.job.id, id);

  const stranger = browser(createValidationJobHandler(store, provider, db.now));
  assert.equal((await stranger.send()).job, null);
  assert.equal((await stranger.send('PATCH', { id })).status, 404);
  assert.equal((await stranger.send('DELETE', { id })).status, 404);

  db.move(2_000);
  const repairQueued = await tab.send('PATCH', { id });
  assert.equal(repairQueued.job.phase, 'repair');
  assert.equal(Object.hasOwn(repairQueued.job, 'result'), false);
  await tab.send('PATCH', { id });
  db.close(store);
  store = db.open();
  tab.replace(createValidationJobHandler(store, provider, db.now));
  assert.equal((await tab.send()).job.phase, 'repair');

  db.move(2_000);
  const completed = (await tab.send('PATCH', { id })).job;
  assert.equal(completed.status, 'completed');
  assert.equal(completed.warning, undefined);
  assert.deepEqual(
    completed.result.applicationsReviewed.map(({ id }) => id),
    ['quickbooks', 'workday'],
  );
  assert.match(completed.result.sources[0].url, /quickbooks/);
  assert.equal(
    completed.result.rubricReviews[3].findings[0].correctedText,
    replacement,
  );
  assert.equal(
    completed.result.rubricReviews[3].correctedRubric.forms.expected_behavior,
    replacement,
  );
  assert.equal(
    completed.result.rubricReviews[0].correctedRubric.criterion,
    input.rubrics[0].criterion,
  );
  assert.deepEqual(
    validateRubric(completed.input.rubrics[0]).map(
      ({ field, correctedText }) => [field, correctedText],
    ),
    [
      ['score', '10'],
      ['reproduction_steps', '1. Open the invoice.'],
    ],
  );
  assert.deepEqual((await tab.send()).job, completed);
  assert.deepEqual((await tab.send('DELETE', { id })).job, completed);
  assert.equal(calls.filter((call) => call.method === 'POST').length, 2);
  assert.match(calls[1].url, /include%5B%5D=web_search_call.action.sources/);
});

void test('concurrent submissions and retries converge on a single job and dispatch once', async (t) => {
  const db = database(t);
  const first = db.open();
  const other = db.open();
  let starts = 0;
  const providerStarted = Promise.withResolvers();
  const providerResult = Promise.withResolvers();
  const provider = fakeProvider({
    start() {
      starts++;
      providerStarted.resolve();
      return providerResult.promise;
    },
  });
  const tab = browser(createValidationJobHandler(first, provider, db.now));
  await tab.send();
  const same = batch();
  const different = batch();
  different.application = 'workday';
  const responses = await Promise.all(
    Array.from({ length: 16 }, (_, index) => {
      tab.replace(
        createValidationJobHandler(
          index % 2 === 0 ? first : other,
          provider,
          db.now,
        ),
      );
      return tab.submit(same);
    }),
  );
  const id = responses[0].job.id;
  assert.ok(
    responses.every((reply) => reply.status === 202 && reply.job.id === id),
  );
  assert.deepEqual((await tab.submit(same, id)).job, responses[0].job);
  assert.equal((await tab.submit(different)).status, 409);
  assert.equal((await tab.submit(different, id)).status, 409);
  assert.equal(starts, 0);

  const worker = tab.send('PATCH', { id });
  await providerStarted.promise;
  const polls = await Promise.all(
    Array.from({ length: 8 }, () => tab.send('PATCH', { id })),
  );
  assert.ok(polls.every((reply) => reply.job.status === 'running'));
  assert.equal(starts, 1);
  providerResult.resolve({ responseId: 'resp_review' });
  await worker;

  await tab.send('DELETE', { id });
  const nextId = (await tab.submit(different, crypto.randomUUID(), id)).job.id;
  assert.notEqual(nextId, id);
  const stale = await tab.submit(same, id);
  assert.equal(stale.status, 409);
  assert.equal(stale.job.id, nextId);
});

void test('cancels queued jobs and a provider response that arrives after cancellation', async (t) => {
  const db = database(t);
  const start = Promise.withResolvers();
  const result = Promise.withResolvers();
  const cancelled = [];
  const provider = fakeProvider({
    start() {
      start.resolve();
      return result.promise;
    },
    async cancel(id) {
      cancelled.push(id);
    },
  });
  const tab = browser(createValidationJobHandler(db.open(), provider, db.now));
  await tab.send();
  const queued = (await tab.submit()).job.id;
  assert.equal(
    (await tab.send('DELETE', { id: queued })).job.status,
    'cancelled',
  );
  assert.equal(
    (await tab.send('PATCH', { id: queued })).job.status,
    'cancelled',
  );

  const id = (await tab.submit(batch(), crypto.randomUUID(), queued)).job.id;
  const advancing = tab.send('PATCH', { id });
  await start.promise;
  assert.equal((await tab.send('DELETE', { id })).job.status, 'cancelled');
  assert.equal((await tab.send('DELETE', { id })).job.status, 'cancelled');
  result.resolve({ responseId: 'resp_late' });

  assert.equal((await advancing).job.status, 'cancelled');
  assert.equal((await tab.send()).job.status, 'cancelled');
  assert.deepEqual(cancelled, ['resp_late']);
});

void test('an in-flight completion cannot replace cancellation even when the provider rejects cancellation', async (t) => {
  const db = database(t);
  const pollStarted = Promise.withResolvers();
  const result = Promise.withResolvers();
  const attempts = [];
  const provider = fakeProvider({
    poll() {
      pollStarted.resolve();
      return result.promise;
    },
    async cancel(id) {
      attempts.push(id);
      throw new Error('provider unreachable');
    },
  });
  const tab = browser(createValidationJobHandler(db.open(), provider, db.now));
  await tab.send();
  const { id, input } = (await tab.submit()).job;
  await tab.send('PATCH', { id });
  db.move(2_000);
  const advancing = tab.send('PATCH', { id });
  await pollStarted.promise;

  const cancelled = await tab.send('DELETE', { id });
  assert.equal(cancelled.job.status, 'cancelled');
  result.resolve({ result: completeReview(input) });
  assert.equal((await advancing).job.status, 'cancelled');
  assert.equal(Object.hasOwn((await tab.send()).job, 'result'), false);
  assert.deepEqual(attempts, ['resp_review']);
});

void test('bounds retrieval retries across process recovery and fails closed on malformed review results', async (t) => {
  const db = database(t);
  const store = db.open();
  const errors = [];
  const transient = Object.assign(new Error('provider details'), {
    retryable: true,
  });
  const provider = fakeProvider({
    async poll() {
      errors.push(db.now());
      throw transient;
    },
  });
  const tab = browser(createValidationJobHandler(store, provider, db.now));
  await tab.send();
  const { id } = (await tab.submit()).job;
  await tab.send('PATCH', { id });
  db.move(2_000);
  for (const interval of [4_000, 8_000, 16_000]) {
    const response = await tab.send('PATCH', { id });
    assert.equal(response.job.status, 'running');
    assert.equal(response.job.pollAfterMs, interval);
    const calls = errors.length;
    tab.replace(createValidationJobHandler(store, provider, db.now));
    await tab.send('PATCH', { id });
    assert.equal(errors.length, calls);
    db.move(interval);
  }
  const failed = (await tab.send('PATCH', { id })).job;
  assert.equal(errors.length, 4);
  assert.equal(failed.status, 'failed');
  assert.doesNotMatch(failed.error, /provider details/);
  assert.equal(Object.hasOwn(failed, 'result'), false);

  const corrupt = fakeProvider({
    async start(input) {
      const review = completeReview(input);
      review.rubricReviews[0].index = 1;
      return { result: review };
    },
  });
  tab.replace(createValidationJobHandler(store, corrupt, db.now));
  const newJob = (await tab.submit(batch(), crypto.randomUUID(), id)).job;
  const incomplete = (await tab.send('PATCH', { id: newJob.id })).job;
  assert.equal(incomplete.status, 'failed');
  assert.match(incomplete.error, /incomplete/);
  assert.equal(Object.hasOwn(incomplete, 'result'), false);
});

void test('recovers a stranded polling lease but never repeats an unconfirmed provider creation', async (t) => {
  const db = database(t);
  const store = db.open();
  let starts = 0;
  const provider = fakeProvider({
    async start() {
      starts++;
      return { responseId: 'resp_review' };
    },
  });
  const tab = browser(createValidationJobHandler(store, provider, db.now));
  await tab.send();
  const { id } = (await tab.submit()).job;
  const queued = await store.read(tab.owner);
  await store.write(tab.owner, queued.version, {
    ...queued.job,
    status: 'running',
    leaseUntil: db.now() + 25_000,
  });

  assert.equal((await tab.send('PATCH', { id })).job.status, 'running');
  db.move(25_000);
  const abandoned = (await tab.send('PATCH', { id })).job;
  assert.equal(abandoned.status, 'failed');
  assert.match(abandoned.error, /started reliably/);
  assert.equal(starts, 0);

  const recovered = (await tab.submit(batch(), crypto.randomUUID(), id)).job;
  await tab.send('PATCH', { id: recovered.id });
  const polling = await store.read(tab.owner);
  await store.write(tab.owner, polling.version, {
    ...polling.job,
    leaseUntil: db.now() + 25_000,
  });
  db.move(25_000);
  assert.equal(
    (await tab.send('PATCH', { id: recovered.id })).job.status,
    'completed',
  );
  assert.equal(starts, 1);
});

void test('times out an abandoned job and best-effort cancels its provider response', async (t) => {
  const db = database(t);
  const cancelled = [];
  const tab = browser(
    createValidationJobHandler(
      db.open(),
      fakeProvider({
        async cancel(id) {
          cancelled.push(id);
        },
      }),
      db.now,
    ),
  );
  await tab.send();
  const { id } = (await tab.submit()).job;
  await tab.send('PATCH', { id });
  db.move(30 * 60_000);

  const job = (await tab.send('PATCH', { id })).job;
  assert.equal(job.status, 'failed');
  assert.match(job.error, /timed out/);
  assert.deepEqual(cancelled, ['resp_review']);
  db.move(24 * 60 * 60_000);
  assert.equal((await tab.send()).job, null);
  assert.equal(
    (await tab.submit(batch(), crypto.randomUUID(), id)).status,
    409,
  );
});

void test('keeps a valid review when correction repair fails and bounds unresolved repairs', async (t) => {
  const db = database(t);
  const store = db.open();
  let attempts = 0;
  let throwRepair = false;
  const provider = fakeProvider({
    async start(input, phase) {
      if (phase === 'review') return { result: completeReview(input) };

      attempts++;
      if (throwRepair) throw new Error('repair failed');
      return { result: { corrections: [] } };
    },
  });
  const tab = browser(createValidationJobHandler(store, provider, db.now));
  await tab.send();
  const input = batch();
  input.rubrics[0].criterion = 'Missing a section prefix.';
  const { id } = (await tab.submit(input)).job;
  assert.equal((await tab.send('PATCH', { id })).job.phase, 'repair');
  assert.equal((await tab.send('PATCH', { id })).job.status, 'running');
  assert.equal((await tab.send('PATCH', { id })).job.status, 'running');
  const completed = (await tab.send('PATCH', { id })).job;
  assert.equal(completed.status, 'completed');
  assert.match(completed.warning, /corrections/);
  assert.equal(attempts, 3);
  assert.match(
    validateRubric(completed.input.rubrics[0])[0].message,
    /Section/,
  );

  throwRepair = true;
  const next = (await tab.submit(input, crypto.randomUUID(), id)).job;
  assert.equal((await tab.send('PATCH', { id: next.id })).job.phase, 'repair');
  const failedRepair = (await tab.send('PATCH', { id: next.id })).job;
  assert.equal(failedRepair.status, 'completed');
  assert.match(failedRepair.warning, /corrections/);
});

void test('validates requests and does not invoke OpenAI when storage or configuration is unavailable', async (t) => {
  const db = database(t);
  const store = db.open();
  const missingKey = browser(
    createValidationJobHandler(
      store,
      fakeProvider({ configured: false }),
      db.now,
    ),
  );
  await missingKey.send();
  assert.equal((await missingKey.submit()).status, 503);
  assert.equal((await missingKey.send()).job, null);

  let starts = 0;
  const cancelled = [];
  let writeOutcome = 'fail';
  const flakyStore = {
    read: (owner) => store.read(owner),
    async write(...args) {
      if (writeOutcome === 'fail') throw new Error('unavailable');
      const version = await store.write(...args);
      if (
        (writeOutcome === 'lose-ack' && args[2].responseId) ||
        (writeOutcome === 'lose-cancel-ack' && args[2].status === 'cancelled')
      ) {
        writeOutcome = 'ok';
        throw new Error('commit acknowledgement lost');
      }
      return version;
    },
  };
  const tab = browser(
    createValidationJobHandler(
      flakyStore,
      fakeProvider({
        async start() {
          starts++;
          return { responseId: 'resp_review' };
        },
        async cancel(id) {
          cancelled.push(id);
        },
      }),
      db.now,
    ),
  );
  assert.equal((await tab.submit()).status, 401);
  await tab.send();

  const invalid = batch();
  invalid.rubrics.pop();
  assert.equal((await tab.submit(invalid)).status, 400);
  assert.equal((await tab.send('POST', { body: null })).status, 400);
  assert.equal(
    (await tab.send('POST', { body: { text: 'x'.repeat(260_000 + 3_000) } }))
      .status,
    413,
  );
  assert.equal(
    (await tab.send('GET', { headers: { 'sec-fetch-site': 'cross-site' } }))
      .status,
    403,
  );
  assert.equal((await tab.send('PATCH', { id: 'resp_review' })).status, 400);
  assert.equal((await tab.submit()).status, 503);
  assert.equal(starts, 0);

  writeOutcome = 'ok';
  const { id } = (await tab.submit()).job;
  writeOutcome = 'lose-ack';
  assert.equal((await tab.send('PATCH', { id })).job.status, 'running');
  assert.equal((await store.read(tab.owner)).job.responseId, 'resp_review');
  db.move(2_000);
  assert.equal((await tab.send('PATCH', { id })).job.status, 'completed');
  assert.equal(starts, 1);
  assert.deepEqual(cancelled, []);

  const active = (await tab.submit(batch(), crypto.randomUUID(), id)).job;
  await tab.send('PATCH', { id: active.id });
  writeOutcome = 'lose-cancel-ack';
  assert.equal(
    (await tab.send('DELETE', { id: active.id })).job.status,
    'cancelled',
  );
  assert.deepEqual(cancelled, ['resp_review']);
});

void test('provider handles an HTTP error, non-JSON reply and incomplete background response', async () => {
  const input = batch();
  const responses = [
    new Response('gateway error', { status: 502 }),
    new Response('<html>routing error</html>'),
    backgroundResponse('resp_failed', 'incomplete'),
  ];
  const provider = createOpenAIReviewProvider(
    { OPENAI_API_KEY: 'test-key' },
    async () => responses.shift(),
  );
  await assert.rejects(provider.start(input, 'review', []), {
    retryable: true,
  });
  await assert.rejects(provider.poll(input, 'review', 'resp_failed'), {
    retryable: true,
  });
  await assert.rejects(provider.poll(input, 'review', 'resp_failed'), {
    retryable: false,
  });
});

async function until(predicate) {
  for (let step = 0; step < 150; step++) {
    if (predicate()) return;
    await defer(2);
  }
  assert.fail('Expected client state was not observed.');
}

void test('browser reload replays a persisted submission after a lost response and restores the report', async (t) => {
  const db = database(t);
  const store = db.open();
  let starts = 0;
  const tab = browser(
    createValidationJobHandler(
      store,
      fakeProvider({
        async start(input) {
          starts++;
          return { result: completeReview(input) };
        },
      }),
      db.now,
    ),
  );
  const data = new Map();
  const storage = {
    getItem: (key) => data.get(key),
    setItem: (key, value) => data.set(key, value),
    removeItem: (key) => data.delete(key),
  };

  let state;
  let committedId;
  const first = createValidationJobClient(
    (next) => {
      state = next;
    },
    storage,
    async (url, init) => {
      if (init.method !== 'POST') return tab.fetch(url, init);
      const response = await tab.fetch(url, init);
      committedId = (await response.json()).job.id;
      throw new Error('browser lost response');
    },
  );
  first.connect();
  await until(() => state?.ready);
  assert.equal(first.submit(batch()), true);
  assert.equal(first.submit(batch()), false);
  await until(() => committedId && state.reconnecting);
  first.disconnect();

  const second = createValidationJobClient(
    (next) => {
      state = next;
    },
    storage,
    (url, init) => tab.fetch(url, init),
  );
  t.after(() => second.disconnect());
  second.connect();
  await until(() => state.job?.status === 'completed');
  assert.equal(state.job.id, committedId);
  assert.deepEqual(state.job.input, batch());
  assert.equal(starts, 1);
  assert.equal(
    [...data.keys()].filter((key) => key.endsWith('pending')).length,
    0,
  );

  assert.equal(second.dismiss(), true);
  second.disconnect();
  let resumed;
  const third = createValidationJobClient(
    (next) => {
      resumed = next;
    },
    storage,
    (url, init) => tab.fetch(url, init),
  );
  t.after(() => third.disconnect());
  third.connect();
  await until(() => resumed?.ready);
  assert.equal(resumed.job, null);
});

void test('Redis REST adapter sends atomic conditional writes and surfaces storage errors', async () => {
  const calls = [];
  const results = [
    { result: 1 },
    { result: ['version', '{"id":"example"}'] },
    { result: 0 },
    { error: 'unexpected' },
  ];
  const store = createRedisJobStore(
    'https://redis.test',
    'test-token',
    'job-tests',
    async (url, init) => {
      calls.push({ url, ...init, command: JSON.parse(init.body) });
      return Response.json(results.shift());
    },
  );

  const version = await store.write('owner', null, { id: 'example' });
  assert.equal(typeof version, 'string');
  assert.deepEqual(await store.read('owner'), {
    version: 'version',
    job: { id: 'example' },
  });
  assert.equal(await store.write('owner', 'stale', { id: 'other' }), null);
  await assert.rejects(store.read('owner'), /invalid response/);
  const [evalCommand, script, ...params] = calls[0].command;
  assert.equal(evalCommand, 'EVAL');
  assert.match(script, /HGET[\s\S]*HSET[\s\S]*EXPIRE/);
  assert.deepEqual(params, [
    1,
    'job-tests:owner',
    '',
    version,
    '{"id":"example"}',
    86_400,
  ]);
  assert.deepEqual(calls[1].command, [
    'HMGET',
    'job-tests:owner',
    'version',
    'job',
  ]);
});
