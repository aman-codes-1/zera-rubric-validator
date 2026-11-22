import { setTimeout as delay } from 'node:timers/promises';
import {
  createValidationJobs,
  type JobQueueStore,
  type ReviewProvider,
} from '../lib/validation-jobs.ts';

const CONCURRENT_JOBS = 4;
const IDLE_DELAY_MS = 1_000;
const MAX_IDLE_DELAY_MS = 10_000;
const MAX_ERROR_DELAY_MS = 15_000;

export function createValidationRunner(
  store: JobQueueStore,
  provider: ReviewProvider,
  now = Date.now,
) {
  const jobs = createValidationJobs(store, provider, now);
  let prepared = false;

  return async function tick() {
    if (!prepared) {
      await store.prepare?.();
      prepared = true;
    }
    const owners = await store.due(now(), CONCURRENT_JOBS);
    const results = await Promise.allSettled(
      owners.map(async (owner) => {
        if (!(await jobs.advance(owner))) await store.pruneMissing?.(owner);
      }),
    );
    const failure = results.find((result) => result.status === 'rejected');
    if (failure)
      throw new Error('Could not advance a validation job.', {
        cause: failure.reason,
      });
    return owners.length;
  };
}

export async function runValidationWorker(
  store: JobQueueStore,
  provider: ReviewProvider,
  signal: AbortSignal,
  reportError = (error: unknown) =>
    console.error(
      'Validation worker will retry:',
      error instanceof Error ? error.message : 'queue error',
    ),
) {
  const tick = createValidationRunner(store, provider);
  let idleDelay = IDLE_DELAY_MS;
  let failures = 0;

  while (!signal.aborted) {
    let wait: number;
    try {
      const count = await tick();
      failures = 0;
      wait = count ? 0 : idleDelay;
      idleDelay = count
        ? IDLE_DELAY_MS
        : Math.min(idleDelay * 2, MAX_IDLE_DELAY_MS);
    } catch (error) {
      if (!failures) reportError(error);
      wait = Math.min(
        IDLE_DELAY_MS * 2 ** Math.min(failures++, 4),
        MAX_ERROR_DELAY_MS,
      );
    }

    if (wait && !signal.aborted) {
      try {
        await delay(wait, undefined, { signal });
      } catch (error) {
        if (!signal.aborted) throw error;
      }
    }
  }
}
