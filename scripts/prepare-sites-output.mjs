import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

const projectDirectory = process.cwd();
const exportDirectory = path.join(projectDirectory, 'out');
const distributionDirectory = path.join(projectDirectory, 'dist');
const serverDirectory = path.join(distributionDirectory, 'server');
const staticDirectory = path.join(distributionDirectory, 'static');
const workerEntry = path.join(projectDirectory, 'worker', 'feather-worker.js');

await rm(distributionDirectory, { recursive: true, force: true });
await mkdir(serverDirectory, { recursive: true });
await cp(exportDirectory, staticDirectory, { recursive: true });
await cp(workerEntry, path.join(serverDirectory, 'index.js'));

const workerConfiguration = {
  topLevelName: 'zera-review',
  name: 'zera-review',
  compatibility_date: '2026-05-15',
  compatibility_flags: ['nodejs_compat'],
  main: 'index.js',
  no_bundle: true,
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
