// @app/agent - Orchestrator, roles, Model_Router, and Action_Recorder.
//
// Inward dependencies: may import @app/core, @app/knowledge, and @app/tools. It
// must never import @app/api or @app/web.

import { CORE_LAYER } from '@app/core';
import { KNOWLEDGE_LAYER } from '@app/knowledge';
import { TOOLS_LAYER } from '@app/tools';

export * from './orchestrator/index.js';
export * from './roles/index.js';
export * from './model-router/index.js';
export * from './action-recorder/index.js';
export * from './consensus/index.js';

/**
 * Layer identifier, proving inward resolution of every inner layer this package
 * depends on through the scaffold.
 */
export const AGENT_LAYER = `${CORE_LAYER}+${KNOWLEDGE_LAYER}+${TOOLS_LAYER}:agent` as const;
