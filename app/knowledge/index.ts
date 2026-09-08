// @app/knowledge - Knowledge_Retriever and OKF traversal.
//
// Inward dependency: may import @app/core only. The `retrieve` tool, OKF bundle
// readers, the knowledge-layer sanitizer, and the web-fetch adapter port live
// under retriever/ (task 10.2); the curated bundle lives under okf-bundle/.

import { CORE_LAYER } from '@app/core';

/** Layer identifier, proving inward resolution of @app/core through the scaffold. */
export const KNOWLEDGE_LAYER = `${CORE_LAYER}:knowledge` as const;

// The Knowledge_Retriever public surface.
export * from './retriever/index.js';
