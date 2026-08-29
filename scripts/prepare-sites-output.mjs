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

const workerSource = `export default {
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(request);
    if (response.status !== 404 || request.method !== 'GET') return response;

    const url = new URL(request.url);
    const finalSegment = url.pathname.split('/').filter(Boolean).at(-1) ?? '';
    if (finalSegment.includes('.')) return response;

    url.pathname = url.pathname.endsWith('/')
      ? url.pathname + 'index.html'
      : url.pathname + '/index.html';
    const routeResponse = await env.ASSETS.fetch(new Request(url, request));
    if (routeResponse.status !== 404) return routeResponse;

    url.pathname = '/index.html';
    return env.ASSETS.fetch(new Request(url, request));
  },
};
`;

const workerConfiguration = {
  topLevelName: 'rhea-review',
  name: 'rhea-review',
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

await writeFile(path.join(serverDirectory, 'index.js'), workerSource);
await writeFile(
  path.join(serverDirectory, 'wrangler.json'),
  `${JSON.stringify(workerConfiguration, null, 2)}\n`,
);
