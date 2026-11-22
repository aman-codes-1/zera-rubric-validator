import {
  JOB_RETENTION_SECONDS,
  scheduledAt,
  type JobQueueStore,
  type JobSnapshot,
} from './validation-jobs.ts';

const WRITE_IF_CURRENT = `
local version = redis.call('HGET', KEYS[1], 'version') or ''
if version ~= ARGV[1] then return 0 end
redis.call('HSET', KEYS[1], 'version', ARGV[2], 'job', ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[4])
if ARGV[6] == '' then
  redis.call('ZREM', KEYS[2], ARGV[5])
else
  redis.call('ZADD', KEYS[2], ARGV[6], ARGV[5])
end
return 1
`;

const PRUNE_IF_MISSING = `
if redis.call('EXISTS', KEYS[1]) == 0 then
  return redis.call('ZREM', KEYS[2], ARGV[1])
end
return 0
`;

const BACKFILL_IF_CURRENT = `
if redis.call('HGET', KEYS[1], 'version') == ARGV[1] then
  return redis.call('ZADD', KEYS[2], 'NX', ARGV[2], ARGV[3])
end
return 0
`;

export function createRedisJobStore(
  url: string,
  token: string,
  namespace = 'zera:validation:v1',
  fetchImpl = fetch,
): JobQueueStore {
  const prefix = namespace + ':';
  const key = (owner: string) => prefix + owner;
  const queueKey = key('due');
  const migratedKey = key('due-backfilled');
  const ownerKey = /^[0-9a-f-]{36}$/;

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

  async function read(owner: string) {
    const result = await command(['HMGET', key(owner), 'version', 'job']);
    if (!Array.isArray(result) || result.length !== 2) {
      throw new Error('Validation job storage returned an invalid record.');
    }
    const [version, job] = result;
    if (version === null && job === null) return null;
    if (typeof version !== 'string' || typeof job !== 'string') {
      throw new Error('Validation job storage returned an incomplete record.');
    }
    return { version, job: JSON.parse(job) } as JobSnapshot;
  }

  return {
    read,
    async due(before, limit) {
      const result = await command([
        'ZRANGEBYSCORE',
        queueKey,
        '-inf',
        before,
        'LIMIT',
        0,
        limit,
      ]);
      if (
        !Array.isArray(result) ||
        result.some((owner) => typeof owner !== 'string')
      ) {
        throw new Error('Validation job storage returned an invalid queue.');
      }
      return result as string[];
    },
    async pruneMissing(owner) {
      await command(['EVAL', PRUNE_IF_MISSING, 2, key(owner), queueKey, owner]);
    },
    async prepare() {
      if (await command(['GET', migratedKey])) return;

      // Older servers stored jobs without a queue index. Backfill without
      // changing their versions or moving entries already scheduled by a worker.
      let cursor = '0';
      do {
        const page = await command([
          'SCAN',
          cursor,
          'MATCH',
          prefix + '*',
          'COUNT',
          100,
        ]);
        if (!Array.isArray(page) || !Array.isArray(page[1])) {
          throw new Error(
            'Validation job storage returned an invalid migration cursor.',
          );
        }
        cursor = String(page[0]);
        for (const entry of page[1]) {
          if (typeof entry !== 'string' || !entry.startsWith(prefix)) continue;
          const owner = entry.slice(prefix.length);
          if (!ownerKey.test(owner)) continue;

          const snapshot = await read(owner);
          if (!snapshot) continue;
          const at = scheduledAt(snapshot.job);
          if (at !== null) {
            await command([
              'EVAL',
              BACKFILL_IF_CURRENT,
              2,
              entry,
              queueKey,
              snapshot.version,
              at,
              owner,
            ]);
          }
        }
      } while (cursor !== '0');

      await command(['SET', migratedKey, '1']);
    },
    async write(owner, expectedVersion, job) {
      const version = crypto.randomUUID();
      const result = await command([
        'EVAL',
        WRITE_IF_CURRENT,
        2,
        key(owner),
        queueKey,
        expectedVersion ?? '',
        version,
        JSON.stringify(job),
        JOB_RETENTION_SECONDS,
        owner,
        scheduledAt(job) ?? '',
      ]);
      if (result === 1) return version;
      if (result === 0) return null;
      throw new Error('Validation job storage did not confirm the write.');
    },
  };
}
