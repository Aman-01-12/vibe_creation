// @app/test - shared property-based test generators and integration fixtures.
//
// Consumer layer: it may import any inner layer, and nothing imports it. Task 1.3
// establishes the property-based testing harness here: the shared fast-check
// generators for the prework edge cases (`./generators`) and the property-test
// tag convention plus the 100+ iteration default (`./property`). Later property
// tests import these from `@app/test` instead of re-rolling their own.

import { CORE_LAYER } from '@app/core';

export * from './generators/index.js';
export * from './model-router-fixtures.js';
export * from './property.js';

/** Layer identifier, proving the shared test package resolves inner layers. */
export const TEST_LAYER = `${CORE_LAYER}:test` as const;
