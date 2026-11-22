import { createRedisJobStore } from './validation-job-redis.ts';
import { createSqliteJobStore } from './validation-job-sqlite.ts';
import type { JobQueueStore } from './validation-jobs.ts';

export function openValidationJobStore(
  env: Readonly<Record<string, string | undefined>>,
): (JobQueueStore & { close?(): void }) | null {
  const url = env.UPSTASH_REDIS_REST_URL;
  const token = env.UPSTASH_REDIS_REST_TOKEN;
  if (url && token) {
    return createRedisJobStore(
      url,
      token,
      env.VALIDATION_JOB_NAMESPACE ||
        'zera:validation:v1:' + (env.VERCEL_ENV || 'shared'),
    );
  }
  if (url || token || env.VERCEL === '1') return null;

  return createSqliteJobStore(
    env.VALIDATION_JOB_DB_PATH || '.validation-jobs/jobs.sqlite',
  );
}
