// @app/web - Editor and Display_Layer (React/TS), the outermost layer.
//
// Inward dependency: may import @app/api (and deeper), and always talks to the
// backend through the API_Gateway (never a provider directly). The M0 Editor
// skeleton (task 6.2) lives under ./editor; the Display_Layer and visualizations
// arrive in tasks 15-16.

import { API_LAYER } from '@app/api';

export * from './editor/index.js';
export * from './display/index.js';
export * from './visualizations/index.js';
export * from './live-run/index.js';

/** Layer identifier, proving inward resolution of @app/api through the scaffold. */
export const WEB_LAYER = `${API_LAYER}:web` as const;
