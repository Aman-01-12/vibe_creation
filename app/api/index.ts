// @app/api - API_Gateway and Project_Store.
//
// Inward dependency: may import @app/agent (and deeper inner layers). It must never
// import @app/web. The API_Gateway trust boundary (authN behind the managed-auth
// adapter, Zod boundary validation, per-user + global rate limiting, prompt-
// injection filtering, the single sanitized error-mapper, the safe-by-default
// per-object authorization stub, and the tRPC procedures the Editor calls over
// SSE/HTTP2) lands in task 5; persistence in task 12.

import { AGENT_LAYER } from '@app/agent';

export * from './gateway/index.js';
export * from './trpc/index.js';
export * from './project-store/index.js';

/** Layer identifier, proving inward resolution of @app/agent through the scaffold. */
export const API_LAYER = `${AGENT_LAYER}:api` as const;
