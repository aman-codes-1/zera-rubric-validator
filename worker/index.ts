import {
  createConfiguredValidationHandler,
  validationStorageUnavailable,
  type ValidationEnvironment,
} from '../lib/validation-job-api.ts';
import { createRedisJobStore } from '../lib/validation-job-redis.ts';

interface WorkerEnvironment extends ValidationEnvironment {
  UPSTASH_REDIS_REST_URL?: string;
  UPSTASH_REDIS_REST_TOKEN?: string;
  ASSETS: { fetch(request: Request): Promise<Response> };
}

async function serveAssets(request: Request, env: WorkerEnvironment) {
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
}

const worker = {
  async fetch(request: Request, env: WorkerEnvironment) {
    const url = new URL(request.url);
    if (url.pathname === '/api/validate' || url.pathname === '/api/validate/') {
      if (!env.UPSTASH_REDIS_REST_URL || !env.UPSTASH_REDIS_REST_TOKEN) {
        return validationStorageUnavailable();
      }
      const store = createRedisJobStore(
        env.UPSTASH_REDIS_REST_URL,
        env.UPSTASH_REDIS_REST_TOKEN,
        'zera:validation:v1:cloudflare',
      );
      return createConfiguredValidationHandler(store, env)(request);
    }
    return serveAssets(request, env);
  },
};

export default worker;
