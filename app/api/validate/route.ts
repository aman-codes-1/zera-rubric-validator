import {
  createConfiguredValidationHandler,
  validationStorageUnavailable,
} from '@/lib/validation-job-api';
import { createRedisJobStore } from '@/lib/validation-job-redis';
import { createSqliteJobStore } from '@/lib/validation-job-sqlite';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

let handle: ReturnType<typeof createConfiguredValidationHandler> | undefined;

async function validation(request: Request) {
  if (!handle) {
    const url = process.env.UPSTASH_REDIS_REST_URL;
    const token = process.env.UPSTASH_REDIS_REST_TOKEN;
    if ((!url || !token) && (url || token || process.env.VERCEL === '1')) {
      return validationStorageUnavailable();
    }

    try {
      const store =
        url && token
          ? createRedisJobStore(
              url,
              token,
              'zera:validation:v1:' + (process.env.VERCEL_ENV || 'shared'),
            )
          : createSqliteJobStore(
              process.env.VALIDATION_JOB_DB_PATH ||
                '.validation-jobs/jobs.sqlite',
            );

      handle = createConfiguredValidationHandler(store, {
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        OPENAI_MODEL: process.env.OPENAI_MODEL,
      });
    } catch {
      return validationStorageUnavailable(true);
    }
  }
  return handle(request);
}

export {
  validation as GET,
  validation as POST,
  validation as PATCH,
  validation as DELETE,
};
