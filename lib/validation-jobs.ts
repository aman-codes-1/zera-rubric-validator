import {
  collectCorrectionTargets,
  isCompleteReview,
  MAX_CORRECTION_REPAIR_ATTEMPTS,
  mergeCorrectionPatches,
  readCorrectionPatches,
  type AiResponse,
  type ValidationInput,
} from './rubric-validation.ts';

export const JOB_RETENTION_SECONDS = 24 * 60 * 60;
const JOB_TIMEOUT_MS = 30 * 60_000;
const LEASE_MS = 25_000;
const POLL_INTERVAL_MS = 2_000;
const MAX_POLL_FAILURES = 4;
const CONTENTION_RETRIES = 8;

type Phase = 'review' | 'repair';
type Targets = ReturnType<typeof collectCorrectionTargets>;
type ProviderResponse =
  | { responseId: string; result?: never }
  | { result: unknown; responseId?: never };

export type ReviewProvider = {
  configured: boolean;
  start(
    input: ValidationInput,
    phase: Phase,
    targets: Targets,
  ): Promise<ProviderResponse>;
  poll(
    input: ValidationInput,
    phase: Phase,
    responseId: string,
  ): Promise<ProviderResponse>;
  cancel(responseId: string): Promise<void>;
};

type JobIdentity = {
  id: string;
  input: ValidationInput;
  createdAt: number;
};

type ActiveJob = JobIdentity & {
  status: 'queued' | 'running';
  phase: Phase;
  review: AiResponse | null;
  targets: Targets;
  repairAttempts: number;
  responseId: string | null;
  leaseUntil: number;
  nextPollAt: number;
  pollFailures: number;
};

type TerminalJob = JobIdentity &
  (
    | { status: 'completed'; result: AiResponse; warning?: string }
    | { status: 'failed'; error: string }
    | { status: 'cancelled' }
  );

export type StoredJob = ActiveJob | TerminalJob;
export type JobSnapshot = { version: string; job: StoredJob };

export type JobStore = {
  read(owner: string): Promise<JobSnapshot | null>;
  write(
    owner: string,
    expectedVersion: string | null,
    job: StoredJob,
  ): Promise<string | null>;
};

export type PublicJob =
  | TerminalJob
  | (JobIdentity & {
      status: ActiveJob['status'];
      phase: Phase;
      pollAfterMs: number;
    });

const REPAIR_WARNING =
  'Some suggested corrections could not be generated. Review the remaining findings before submitting.';

function active(job: StoredJob): job is ActiveJob {
  return job.status === 'queued' || job.status === 'running';
}

function identity(job: StoredJob): JobIdentity {
  return { id: job.id, input: job.input, createdAt: job.createdAt };
}

function failure(job: ActiveJob, error: string): TerminalJob {
  if (job.phase === 'repair' && job.review) {
    return {
      ...identity(job),
      status: 'completed',
      result: job.review,
      warning: REPAIR_WARNING,
    };
  }
  return { ...identity(job), status: 'failed', error };
}

function continueWithReview(job: ActiveJob, review: AiResponse): StoredJob {
  const targets = collectCorrectionTargets(
    job.input.rubrics,
    review.rubricReviews,
  );
  if (!targets.length || job.repairAttempts >= MAX_CORRECTION_REPAIR_ATTEMPTS) {
    return {
      ...identity(job),
      status: 'completed',
      result: review,
      ...(targets.length ? { warning: REPAIR_WARNING } : {}),
    };
  }
  return {
    ...job,
    phase: 'repair',
    review,
    targets,
    repairAttempts: job.repairAttempts + 1,
    responseId: null,
    leaseUntil: 0,
    nextPollAt: 0,
    pollFailures: 0,
  };
}

function completedStep(job: ActiveJob, result: unknown): StoredJob {
  if (job.phase === 'review') {
    if (!isCompleteReview(result, job.input.rubrics.length)) {
      return failure(
        job,
        'The AI review returned incomplete results. Validation was not completed.',
      );
    }
    return continueWithReview(job, result);
  }

  const patches = readCorrectionPatches(result);
  if (!job.review || !patches) {
    return failure(job, 'The AI could not repair the corrections.');
  }
  return continueWithReview(
    job,
    mergeCorrectionPatches(job.review, job.targets, patches),
  );
}

export function createValidationJobs(
  store: JobStore,
  provider: ReviewProvider,
  now = Date.now,
) {
  async function cancelUpstream(responseId: string | null) {
    if (!responseId) return;
    try {
      await provider.cancel(responseId);
    } catch {
      // The stored terminal state still prevents the result from being published.
    }
  }

  function project(job: StoredJob | null): PublicJob | null {
    if (!job || !active(job)) return job;
    return {
      ...identity(job),
      status: job.status,
      phase: job.phase,
      pollAfterMs: Math.max(
        0,
        job.nextPollAt - now(),
        Math.min(job.leaseUntil - now(), POLL_INTERVAL_MS),
      ),
    };
  }

  async function latest(owner: string, id?: string) {
    const job = (await store.read(owner))?.job ?? null;
    return project(id && job?.id !== id ? null : job);
  }

  async function submit(
    owner: string,
    id: string,
    previousJobId: string | null,
    input: ValidationInput,
  ) {
    for (let attempt = 0; attempt < CONTENTION_RETRIES; attempt++) {
      const current = await store.read(owner);
      const job = current?.job;
      if (
        job?.id === id ||
        (job && (active(job) || job.id !== previousJobId))
      ) {
        const sameInput = JSON.stringify(job.input) === JSON.stringify(input);
        return { job: project(job), conflict: !sameInput };
      }
      if (!job && previousJobId !== null) return { job: null, conflict: true };

      const next: ActiveJob = {
        id,
        input,
        createdAt: now(),
        status: 'queued',
        phase: 'review',
        review: null,
        targets: [],
        repairAttempts: 0,
        responseId: null,
        leaseUntil: 0,
        nextPollAt: 0,
        pollFailures: 0,
      };
      if (await store.write(owner, current?.version ?? null, next)) {
        return { job: project(next), conflict: false };
      }
    }
    throw new Error('Could not acquire validation job storage.');
  }

  async function cancel(owner: string, id: string) {
    for (let attempt = 0; attempt < CONTENTION_RETRIES; attempt++) {
      const current = await store.read(owner);
      if (!current || current.job.id !== id) return null;
      const job = current.job;
      if (!active(job)) return project(job);

      const next: TerminalJob = { ...identity(job), status: 'cancelled' };
      const saved = await store
        .write(owner, current.version, next)
        .catch(async (error: unknown) => {
          const latestJob = (await store.read(owner))?.job;
          if (latestJob?.id === id && latestJob.status === 'cancelled')
            return true;
          throw error;
        });
      if (saved) {
        await cancelUpstream(job.responseId);
        return project(next);
      }
    }
    throw new Error('Could not cancel the validation job.');
  }

  async function advance(owner: string, id: string) {
    const current = await store.read(owner);
    if (!current || current.job.id !== id) return null;
    const job = current.job;
    if (!active(job)) return project(job);

    const time = now();
    if (job.leaseUntil > time) return project(job);
    const expired = time - job.createdAt >= JOB_TIMEOUT_MS;
    // A worker can die after submitting to OpenAI but before storing the ID.
    // Reissuing that creation could run the same review twice.
    const abandonedStart = job.leaseUntil > 0 && !job.responseId;
    if (expired || abandonedStart || !provider.configured) {
      const next = failure(
        job,
        expired
          ? 'The AI review timed out. Validation was not completed.'
          : abandonedStart
            ? 'The AI review could not be started reliably. Submit the batch again.'
            : 'OpenAI review is unavailable. Validation was not completed.',
      );
      if (!(await store.write(owner, current.version, next)))
        return latest(owner, id);
      await cancelUpstream(job.responseId);
      return project(next);
    }

    if (job.nextPollAt > time) return project(job);

    const claim: ActiveJob = {
      ...job,
      status: 'running',
      leaseUntil: time + LEASE_MS,
    };
    const claimedVersion = await store.write(owner, current.version, claim);
    if (!claimedVersion) return latest(owner, id);

    let next: StoredJob;
    let startedResponseId: string | null = null;
    let cancelResponseId: string | null = null;
    try {
      const response = job.responseId
        ? await provider.poll(job.input, job.phase, job.responseId)
        : await provider.start(job.input, job.phase, job.targets);
      if (response.responseId) {
        if (!job.responseId) startedResponseId = response.responseId;
        next = {
          ...claim,
          responseId: response.responseId,
          leaseUntil: 0,
          nextPollAt: now() + POLL_INTERVAL_MS,
          pollFailures: 0,
        };
      } else {
        next = completedStep({ ...claim, leaseUntil: 0 }, response.result);
      }
    } catch (error) {
      const retryable =
        error instanceof Error &&
        'retryable' in error &&
        error.retryable === true;
      const pollFailures = job.pollFailures + 1;
      if (job.responseId && retryable && pollFailures < MAX_POLL_FAILURES) {
        next = {
          ...claim,
          leaseUntil: 0,
          nextPollAt: now() + POLL_INTERVAL_MS * 2 ** pollFailures,
          pollFailures,
        };
      } else {
        if (retryable) cancelResponseId = job.responseId;
        next = failure(
          job,
          job.responseId
            ? 'The AI review could not be completed. Submit the batch again.'
            : 'The AI review could not be started. Submit the batch again.',
        );
      }
    }

    if (now() - job.createdAt >= JOB_TIMEOUT_MS) {
      cancelResponseId = startedResponseId ?? job.responseId;
      startedResponseId = null;
      next = failure(
        job,
        'The AI review timed out. Validation was not completed.',
      );
    }

    // Retry a store transport failure with the original version. An
    // acknowledged or ambiguous successful write cannot be applied twice.
    const committed = await store
      .write(owner, claimedVersion, next)
      .catch(() => store.write(owner, claimedVersion, next));
    if (committed) {
      await cancelUpstream(cancelResponseId);
      return project(next);
    }

    const winner = await store.read(owner);
    const adoptedResponse =
      winner?.job.id === id &&
      active(winner.job) &&
      winner.job.responseId === startedResponseId;
    if (!adoptedResponse) await cancelUpstream(startedResponseId);
    await cancelUpstream(cancelResponseId);
    return project(winner?.job.id === id ? winner.job : null);
  }

  return { latest, submit, advance, cancel };
}
