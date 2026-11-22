import type { PublicJob } from './validation-jobs.ts';
import type { ValidationInput } from './rubric-validation.ts';

const ENDPOINT = '/api/validate';
const PENDING_KEY = 'zera.validation.pending';
const DISMISSED_KEY = 'zera.validation.dismissed';

type Command =
  | {
      kind: 'submit';
      jobId: string;
      previousJobId: string | null;
      input: ValidationInput;
    }
  | { kind: 'cancel'; jobId: string };

export type ValidationJobState = {
  job: PublicJob | null;
  ready: boolean;
  command: Command['kind'] | null;
  reconnecting: boolean;
  error: string;
};

export const initialValidationJobState: ValidationJobState = {
  job: null,
  ready: false,
  command: null,
  reconnecting: false,
  error: '',
};

type JobResponse = {
  job?: PublicJob | null;
  retryable?: boolean;
  error?: string;
};

function pause(ms: number, signal: AbortSignal) {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(finish, ms);
    signal.addEventListener('abort', finish, { once: true });

    function finish() {
      clearTimeout(timer);
      signal.removeEventListener('abort', finish);
      resolve();
    }
  });
}

export function isActiveJob(
  job: PublicJob | null | undefined,
): job is Extract<PublicJob, { pollAfterMs: number }> {
  return job?.status === 'queued' || job?.status === 'running';
}

function getStorage() {
  try {
    return globalThis.sessionStorage;
  } catch {
    return undefined;
  }
}

export function createValidationJobClient(
  onChange: (state: ValidationJobState) => void,
  storage:
    | Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>
    | undefined = getStorage(),
  fetchImpl = fetch,
  wait = pause,
  locks = globalThis.navigator?.locks,
) {
  let state = initialValidationJobState;
  let latestJobId: string | null = null;
  let controller: AbortController | undefined;
  let command: Command | null = null;

  function read(key: string) {
    try {
      return storage?.getItem(key) ?? null;
    } catch {
      return null;
    }
  }

  function write(key: string, value: string | null) {
    try {
      if (value === null) storage?.removeItem(key);
      else storage?.setItem(key, value);
    } catch {
      // The server session can still recover submissions that reached storage.
    }
  }

  function update(patch: Partial<ValidationJobState>) {
    state = { ...state, ...patch };
    onChange(state);
  }

  function setCommand(next: Command | null) {
    command = next;
    write(PENDING_KEY, next ? JSON.stringify(next) : null);
    update({ command: next?.kind ?? null });
  }

  function show(job: PublicJob | null, error = '') {
    latestJobId = job?.id ?? null;
    const previous = state.job;
    const visible = job?.id === read(DISMISSED_KEY) ? null : job;
    update({
      job:
        visible && previous?.id === visible.id
          ? { ...visible, input: previous.input }
          : visible,
      ready: true,
      error,
    });
  }

  async function requestWithRetry(
    url: string,
    init: RequestInit,
    signal: AbortSignal,
  ) {
    let failures = 0;
    while (!signal.aborted) {
      try {
        const response = await fetchImpl(url, {
          ...init,
          cache: 'no-store',
          signal: AbortSignal.any([signal, AbortSignal.timeout(45_000)]),
        });
        const body: JobResponse = await response.json();
        const recoverable =
          body.retryable !== false &&
          (response.status === 429 || response.status >= 500);
        if (!recoverable) {
          if (signal.aborted) return null;
          update({ reconnecting: false });
          return { response, body };
        }
      } catch {
        // A lost HTTP response can follow a successful write. Retry the same command.
      }

      if (signal.aborted) return null;
      update({ reconnecting: true });
      await wait(
        Math.min(15_000, 1_000 * 2 ** Math.min(failures++, 4)),
        signal,
      );
    }
    return null;
  }

  async function initialize(signal: AbortSignal) {
    const get = () => requestWithRetry(ENDPOINT, { method: 'GET' }, signal);
    // Serialize the initial cookie exchange across tabs where Web Locks is available.
    const result = locks
      ? await locks.request('zera-validation-session', { signal }, get)
      : await get();
    if (!result || signal.aborted) return false;
    if (!result.response.ok) {
      update({
        error: result.body.error || 'Could not connect to validation.',
      });
      return false;
    }
    show(result.body.job ?? null);
    return true;
  }

  async function sendCommand(signal: AbortSignal) {
    if (!command) return true;
    const pending = command;
    const result =
      pending.kind === 'submit'
        ? await requestWithRetry(
            ENDPOINT,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(pending),
            },
            signal,
          )
        : await requestWithRetry(
            ENDPOINT + '?jobId=' + pending.jobId,
            { method: 'DELETE' },
            signal,
          );

    if (!result || signal.aborted) return false;
    if (result.response.status === 401) {
      if (!(await initialize(signal))) return false;
      // Require a new deliberate submission after the original session is lost.
      setCommand(null);
      update({
        error: 'The validation session expired. Submit the batch again.',
      });
      return false;
    }

    setCommand(null);
    if (result.response.ok || result.response.status === 409) {
      show(result.body.job ?? null, result.body.error);
      return true;
    }

    if (result.response.status === 404 && pending.kind === 'cancel') {
      return initialize(signal);
    }

    update({
      error: result.body.error || 'Could not submit the validation request.',
    });
    return false;
  }

  async function run(signal: AbortSignal, connect: boolean) {
    if (connect && !(await initialize(signal))) return;
    if (command && !(await sendCommand(signal))) return;

    for (;;) {
      const job = state.job;
      if (!job || (job.status !== 'queued' && job.status !== 'running')) return;
      if (job.pollAfterMs) await wait(Math.max(250, job.pollAfterMs), signal);
      if (signal.aborted) return;

      const result = await requestWithRetry(
        ENDPOINT + '?jobId=' + job.id,
        {
          method: 'PATCH',
        },
        signal,
      );
      if (!result || signal.aborted) return;

      if (result.response.ok) {
        show(result.body.job ?? null);
      } else if (
        result.response.status === 404 ||
        result.response.status === 401
      ) {
        if (!(await initialize(signal))) return;
        if (!state.job)
          update({ error: 'This validation job is no longer available.' });
      } else {
        update({
          error: result.body.error || 'Could not check the current validation.',
        });
        return;
      }
    }
  }

  function start(connect: boolean) {
    controller?.abort();
    controller = new AbortController();
    const signal = controller.signal;
    void run(signal, connect).catch(() => {
      if (!signal.aborted) {
        update({
          error: 'Could not resume validation. Refresh this page to reconnect.',
        });
      }
    });
  }

  return {
    connect() {
      try {
        const saved = JSON.parse(read(PENDING_KEY) || 'null') as Command | null;
        if (saved?.kind === 'submit' || saved?.kind === 'cancel') {
          command = saved;
          update({ command: saved.kind });
        }
      } catch {
        write(PENDING_KEY, null);
      }
      start(true);
    },
    submit(input: ValidationInput) {
      if (!state.ready || command || isActiveJob(state.job)) return false;
      setCommand({
        kind: 'submit',
        jobId: crypto.randomUUID(),
        previousJobId: latestJobId,
        input,
      });
      update({ job: null, error: '' });
      start(false);
      return true;
    },
    cancel() {
      const job = state.job;
      if (command || !job || !isActiveJob(job)) return;
      setCommand({ kind: 'cancel', jobId: job.id });
      start(false);
    },
    dismiss() {
      if (command || isActiveJob(state.job)) return false;
      write(DISMISSED_KEY, latestJobId);
      update({ job: null, error: '' });
      return true;
    },
    disconnect() {
      controller?.abort();
    },
  };
}
