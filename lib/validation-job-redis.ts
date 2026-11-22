import {
  JOB_RETENTION_SECONDS,
  type JobSnapshot,
  type JobStore,
} from './validation-jobs.ts';

const WRITE_IF_CURRENT = `
local version = redis.call('HGET', KEYS[1], 'version') or ''
if version ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'version', ARGV[2], 'job', ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[4])
return 1
`;

export function createRedisJobStore(
  url: string,
  token: string,
  namespace = 'zera:validation:v1',
  fetchImpl = fetch,
): JobStore {
  const key = (owner: string) => namespace + ':' + owner;

  async function command(args: (string | number)[]) {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        authorization: 'Bearer ' + token,
        'content-type': 'application/json',
      },
      body: JSON.stringify(args),
      cache: 'no-store',
      signal: AbortSignal.timeout(4_000),
    });
    if (!response.ok) throw new Error('Validation job storage is unavailable.');
    const payload = await response.json();
    if (!payload || typeof payload !== 'object' || !('result' in payload)) {
      throw new Error('Validation job storage returned an invalid response.');
    }
    return payload.result as unknown;
  }

  return {
    async read(owner) {
      const result = await command(['HMGET', key(owner), 'version', 'job']);
      if (!Array.isArray(result) || result.length !== 2) {
        throw new Error('Validation job storage returned an invalid record.');
      }
      const [version, job] = result;
      if (version === null && job === null) return null;
      if (typeof version !== 'string' || typeof job !== 'string') {
        throw new Error(
          'Validation job storage returned an incomplete record.',
        );
      }
      return { version, job: JSON.parse(job) } as JobSnapshot;
    },
    async write(owner, expectedVersion, job) {
      const version = crypto.randomUUID();
      const result = await command([
        'EVAL',
        WRITE_IF_CURRENT,
        1,
        key(owner),
        expectedVersion ?? '',
        version,
        JSON.stringify(job),
        JOB_RETENTION_SECONDS,
      ]);
      if (result === 1) return version;
      if (result === 0) return null;
      throw new Error('Validation job storage did not confirm the write.');
    },
  };
}
