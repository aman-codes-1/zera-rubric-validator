import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  JOB_RETENTION_SECONDS,
  JOB_TIMEOUT_MS,
  scheduledAt,
  type JobQueueStore,
  type JobSnapshot,
} from './validation-jobs.ts';

export function createSqliteJobStore(
  filename: string,
  now = Date.now,
): JobQueueStore & { close(): void } {
  mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  try {
    db.exec(`
      PRAGMA busy_timeout = 3000;
      PRAGMA journal_mode = WAL;
      BEGIN IMMEDIATE;
      CREATE TABLE IF NOT EXISTS validation_jobs (
        owner TEXT PRIMARY KEY,
        version TEXT NOT NULL,
        job TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        due_at INTEGER
      );
      CREATE INDEX IF NOT EXISTS validation_job_expiry ON validation_jobs (expires_at);
    `);

    const hasDueAt = db
      .prepare('PRAGMA table_info(validation_jobs)')
      .all()
      .some((column) => column.name === 'due_at');
    if (!hasDueAt) {
      db.exec(`
        ALTER TABLE validation_jobs ADD COLUMN due_at INTEGER;
        UPDATE validation_jobs
        SET due_at = max(
          json_extract(job, '$.createdAt'),
          json_extract(job, '$.leaseUntil'),
          min(json_extract(job, '$.nextPollAt'), json_extract(job, '$.createdAt') + ${JOB_TIMEOUT_MS})
        )
        WHERE json_extract(job, '$.status') IN ('queued', 'running');
      `);
    }
    db.exec(`
      CREATE INDEX IF NOT EXISTS validation_job_due ON validation_jobs (due_at) WHERE due_at IS NOT NULL;
      COMMIT;
    `);
  } catch (error) {
    db.close();
    throw error;
  }

  const read = db.prepare(
    'SELECT version, job FROM validation_jobs WHERE owner = ? AND expires_at > ?',
  );
  const due = db.prepare(`
    SELECT owner FROM validation_jobs
    WHERE due_at <= ? AND expires_at > ?
    ORDER BY due_at, owner
    LIMIT ?
  `);
  const prune = db.prepare('DELETE FROM validation_jobs WHERE expires_at <= ?');
  const insert = db.prepare(`
    INSERT INTO validation_jobs (owner, version, job, expires_at, due_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (owner) DO NOTHING
  `);
  const update = db.prepare(`
    UPDATE validation_jobs SET version = ?, job = ?, expires_at = ?, due_at = ?
    WHERE owner = ? AND version = ? AND expires_at > ?
  `);

  return {
    async read(owner) {
      const row = read.get(owner, now()) as
        | { version: string; job: string }
        | undefined;
      return row
        ? ({ version: row.version, job: JSON.parse(row.job) } as JobSnapshot)
        : null;
    },
    async due(before, limit) {
      return (due.all(before, now(), limit) as { owner: string }[]).map(
        ({ owner }) => owner,
      );
    },
    async write(owner, expectedVersion, job) {
      const time = now();
      const values = [
        crypto.randomUUID(),
        JSON.stringify(job),
        time + JOB_RETENTION_SECONDS * 1000,
        scheduledAt(job),
      ] as const;
      if (expectedVersion === null) {
        prune.run(time);
        return insert.run(owner, ...values).changes === 1 ? values[0] : null;
      }
      return update.run(...values, owner, expectedVersion, time).changes === 1
        ? values[0]
        : null;
    },
    close() {
      db.close();
    },
  };
}
