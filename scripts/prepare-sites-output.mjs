import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const projectDirectory = process.cwd();
const exportDirectory = path.join(projectDirectory, 'out');
const distributionDirectory = path.join(projectDirectory, 'dist');
const serverDirectory = path.join(distributionDirectory, 'server');
const staticDirectory = path.join(distributionDirectory, 'static');

await rm(distributionDirectory, { recursive: true, force: true });
await mkdir(serverDirectory, { recursive: true });
await cp(exportDirectory, staticDirectory, { recursive: true });
await cp(
  path.join(projectDirectory, 'worker'),
  path.join(serverDirectory, 'worker'),
  {
    recursive: true,
  },
);
await mkdir(path.join(serverDirectory, 'lib'), { recursive: true });
for (const file of [
  'applications.mjs',
  'rubric-validation.ts',
  'validation-job-api.ts',
  'validation-job-redis.ts',
  'validation-jobs.ts',
]) {
  await cp(
    path.join(projectDirectory, 'lib', file),
    path.join(serverDirectory, 'lib', file),
  );
}

const workerConfiguration = {
  topLevelName: 'zera-rubric-validator',
  name: 'zera-rubric-validator',
  compatibility_date: '2026-05-15',
  compatibility_flags: ['nodejs_compat'],
  main: 'worker/index.ts',
  assets: {
    directory: '../static',
    binding: 'ASSETS',
  },
  observability: {
    enabled: true,
  },
};

await writeFile(
  path.join(serverDirectory, 'wrangler.json'),
  `${JSON.stringify(workerConfiguration, null, 2)}\n`,
);
