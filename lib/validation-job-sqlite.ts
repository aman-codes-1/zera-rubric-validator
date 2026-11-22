import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  JOB_RETENTION_SECONDS,
  type JobSnapshot,
  type JobStore,
} from './validation-jobs.ts';

export function createSqliteJobStore(
  filename: string,
  now = Date.now,
): JobStore & { close(): void } {
  mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(filename);
  db.exec(`
    PRAGMA busy_timeout = 3000;
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS validation_jobs (
      owner TEXT PRIMARY KEY,
      version TEXT NOT NULL,
      job TEXT NOT NULL,
      expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS validation_job_expiry ON validation_jobs (expires_at);
  `);

  const read = db.prepare(
    'SELECT version, job FROM validation_jobs WHERE owner = ? AND expires_at > ?',
  );
  const prune = db.prepare('DELETE FROM validation_jobs WHERE expires_at <= ?');
  const insert = db.prepare(`
    INSERT INTO validation_jobs (owner, version, job, expires_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (owner) DO NOTHING
  `);
  const update = db.prepare(`
    UPDATE validation_jobs SET version = ?, job = ?, expires_at = ?
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
    async write(owner, expectedVersion, job) {
      const time = now();
      const expiresAt = time + JOB_RETENTION_SECONDS * 1000;
      const version = crypto.randomUUID();
      const data = JSON.stringify(job);
      if (expectedVersion === null) {
        prune.run(time);
        return insert.run(owner, version, data, expiresAt).changes === 1
          ? version
          : null;
      }
      return update.run(version, data, expiresAt, owner, expectedVersion, time)
        .changes === 1
        ? version
        : null;
    },
    close() {
      db.close();
    },
  };
}
