import { isObject, prepareValidationInput } from './rubric-validation.ts';
import { createOpenAIReviewProvider } from '../worker/feather-worker.js';
import {
  createValidationJobs,
  type JobStore,
  type ReviewProvider,
} from './validation-jobs.ts';

const OWNER_COOKIE = 'zera_validation_session';
const OWNER_AGE_SECONDS = 30 * 24 * 60 * 60;
const MAX_BODY_BYTES = 256 * 1024;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export type ValidationEnvironment = {
  OPENAI_API_KEY?: string;
  OPENAI_MODEL?: string;
};

function json(value: unknown, status = 200, cookie?: string) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'private, no-store',
      vary: 'Cookie',
      ...(cookie ? { 'set-cookie': cookie } : {}),
    },
  });
}

function uuid(value: unknown): value is string {
  return typeof value === 'string' && UUID.test(value);
}

class PayloadTooLarge extends Error {}

async function readBody(request: Request): Promise<unknown> {
  if (Number(request.headers.get('content-length')) > MAX_BODY_BYTES)
    throw new PayloadTooLarge();
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing request body.');

  const decoder = new TextDecoder('utf-8', { fatal: true });
  let size = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_BODY_BYTES) {
        void reader.cancel().catch(() => {});
        throw new PayloadTooLarge();
      }
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    reader.releaseLock();
  }
}

export function createValidationJobHandler(
  store: JobStore,
  provider: ReviewProvider,
  now = Date.now,
) {
  const jobs = createValidationJobs(store, provider, now);

  return async function handle(request: Request) {
    const url = new URL(request.url);
    const owner = request.headers
      .get('cookie')
      ?.split(/;\s*/)
      .find((cookie) => cookie.startsWith(OWNER_COOKIE + '='))
      ?.slice(OWNER_COOKIE.length + 1);

    const fetchSite = request.headers.get('sec-fetch-site');
    if (fetchSite === 'cross-site' || fetchSite === 'same-site') {
      return json({ error: 'Use the validator from its own site.' }, 403);
    }

    try {
      if (request.method === 'GET') {
        if (uuid(owner)) return json({ job: await jobs.latest(owner) });

        const secure = url.protocol === 'https:' ? '; Secure' : '';
        const cookie = `${OWNER_COOKIE}=${crypto.randomUUID()}; Max-Age=${OWNER_AGE_SECONDS}; Path=/api/validate; HttpOnly; SameSite=Strict${secure}`;
        return json({ job: null }, 200, cookie);
      }

      if (!uuid(owner))
        return json(
          {
            error:
              'Could not establish a validation session. Refresh and try again.',
          },
          401,
        );

      if (request.method === 'POST') {
        if (
          request.headers.get('content-type')?.split(';')[0].trim() !==
          'application/json'
        ) {
          return json({ error: 'Use an application/json request body.' }, 415);
        }
        if (!provider.configured) {
          return json(
            {
              error:
                'OpenAI review is not configured. Validation was not completed.',
              retryable: false,
            },
            503,
          );
        }
        let data;
        try {
          data = await readBody(request);
        } catch (error) {
          return error instanceof PayloadTooLarge
            ? json({ error: 'This batch is too large to validate.' }, 413)
            : json({ error: 'Request body must be valid JSON.' }, 400);
        }
        if (
          !isObject(data) ||
          !uuid(data.jobId) ||
          !(data.previousJobId === null || uuid(data.previousJobId))
        ) {
          return json(
            {
              error:
                'A valid submission ID and previous job reference are required.',
            },
            400,
          );
        }

        let input;
        try {
          input = prepareValidationInput(data.input);
        } catch (error) {
          return json(
            {
              error:
                error instanceof Error
                  ? error.message
                  : 'Invalid validation batch.',
            },
            400,
          );
        }

        const { job, conflict } = await jobs.submit(
          owner,
          data.jobId,
          data.previousJobId,
          input,
        );
        if (conflict) {
          return json(
            {
              job,
              error:
                'The validation changed in another tab. Check the current job before submitting again.',
            },
            409,
          );
        }
        return json(
          { job },
          job?.status === 'queued' || job?.status === 'running' ? 202 : 200,
        );
      }

      const id = url.searchParams.get('jobId');
      if (!uuid(id))
        return json({ error: 'A valid validation job ID is required.' }, 400);

      if (request.method === 'PATCH' || request.method === 'DELETE') {
        const job =
          request.method === 'PATCH'
            ? await jobs.advance(owner, id)
            : await jobs.cancel(owner, id);
        return job
          ? json({ job })
          : json(
              {
                job: null,
                error: 'This validation job is no longer available.',
              },
              404,
            );
      }

      return json({ error: 'Method not allowed.' }, 405);
    } catch {
      return json(
        {
          error:
            'Validation job storage is temporarily unavailable. Please try again.',
        },
        503,
      );
    }
  };
}

export function createConfiguredValidationHandler(
  store: JobStore,
  env: ValidationEnvironment,
) {
  return createValidationJobHandler(store, createOpenAIReviewProvider(env));
}

export function validationStorageUnavailable(retryable = false) {
  return json(
    {
      error: retryable
        ? 'Validation job storage is temporarily unavailable.'
        : 'Validation job storage is not configured.',
      retryable,
    },
    503,
  );
}
