// @app/knowledge - Knowledge_Retriever and OKF traversal.
//
// Inward dependency: may import @app/core only. The `retrieve` tool and web-fetch
// adapter are implemented in task 10; the curated bundle lives under okf-bundle/.

import { CORE_LAYER } from '@app/core';

/** Layer identifier, proving inward resolution of @app/core through the scaffold. */
export const KNOWLEDGE_LAYER = `${CORE_LAYER}:knowledge` as const;
