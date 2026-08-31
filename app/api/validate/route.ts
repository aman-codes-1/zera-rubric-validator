import { handleValidationRequest } from '@/worker/feather-worker.js';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

function validationEnvironment() {
  return {
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    OPENAI_MODEL: process.env.OPENAI_MODEL,
  };
}

export async function POST(request: Request) {
  return handleValidationRequest(request, validationEnvironment());
}

export async function GET(request: Request) {
  return handleValidationRequest(request, validationEnvironment());
}
