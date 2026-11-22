import {
  createConfiguredValidationHandler,
  validationStorageUnavailable,
} from '@/lib/validation-job-api';
import { openValidationJobStore } from '@/lib/validation-job-store-node';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

let handle: ReturnType<typeof createConfiguredValidationHandler> | undefined;

async function validation(request: Request) {
  if (!handle) {
    try {
      const store = openValidationJobStore(process.env);
      if (!store) return validationStorageUnavailable();
      handle = createConfiguredValidationHandler(store, {
        OPENAI_API_KEY: process.env.OPENAI_API_KEY,
        OPENAI_MODEL: process.env.OPENAI_MODEL,
      });
    } catch {
      return validationStorageUnavailable(true);
    }
  }
  return handle(request);
}

export { validation as GET, validation as POST, validation as DELETE };
