// ESLint flat config for the app/ monorepo.
//
// Two concerns live here, kept deliberately separate:
//
//   1. Import-boundary enforcement (task 1.1). Dependencies flow inward only:
//        web -> api -> agent -> {knowledge, tools} -> core
//      This is the authoritative always-on boundary gate. TypeScript project
//      references only catch an inner-to-outer import on a clean build; this
//      lint rule rejects it at author time, incrementally, with an actionable
//      message. Run via `npm run lint` / `npm run lint:boundaries`
//      (`eslint app --max-warnings=0`).
//
//   2. General TypeScript correctness rules (task 1.2). typescript-eslint's
//      type-checked recommended set runs against every app/ TS file, and
//      eslint-config-prettier is applied last so formatting is owned solely by
//      Prettier and never fights ESLint.
//
// The general rules are additive; the boundary rule below is preserved exactly
// as authored in task 1.1.

import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import prettier from 'eslint-config-prettier';

/** All workspace layers, innermost first. */
const LAYERS = ['core', 'knowledge', 'tools', 'agent', 'api', 'web', 'eval', 'test'];

/**
 * The @app/* packages each layer is permitted to import (excluding itself).
 * Everything not listed here is forbidden for that layer.
 */
const ALLOWED_INNER = {
  core: [],
  knowledge: ['core'],
  tools: ['core'],
  agent: ['core', 'knowledge', 'tools'],
  api: ['core', 'knowledge', 'tools', 'agent'],
  web: ['core', 'knowledge', 'tools', 'agent', 'api'],
  eval: ['core', 'knowledge', 'tools', 'agent', 'api'],
  test: ['core', 'knowledge', 'tools', 'agent', 'api'],
};

const pkgName = (layer) => `@app/${layer}`;

/** The @app/* package specifiers a given layer must not import. */
function forbiddenPackagesFor(layer) {
  const allowed = new Set([layer, ...ALLOWED_INNER[layer]]);
  return LAYERS.filter((other) => !allowed.has(other)).map(pkgName);
}

/** Build the per-layer boundary config object, or null when nothing is forbidden. */
function boundaryConfigFor(layer) {
  const forbidden = forbiddenPackagesFor(layer);
  if (forbidden.length === 0) {
    return null;
  }

  return {
    files: [`app/${layer}/**/*.{ts,tsx}`],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: forbidden.map((name) => ({
            group: [name, `${name}/*`],
            message: `Import boundary violation: app/${layer} may not depend on ${name}. Dependencies flow inward only (web -> api -> agent -> {knowledge, tools} -> core).`,
          })),
        },
      ],
    },
  };
}

const boundaryConfigs = LAYERS.map(boundaryConfigFor).filter((config) => config !== null);

export default [
  // Never lint build output, dependencies, or the Python worker (linted by ruff).
  {
    ignores: ['**/dist/**', '**/node_modules/**', 'app/tools/sandbox/worker/**'],
  },

  // Base JavaScript recommended rules (covers this config file and any plain JS).
  js.configs.recommended,

  // General type-checked TypeScript rules, scoped to the app/ layers. The
  // type-checked set needs type information, wired via the TypeScript project
  // service below.
  ...tseslint.configs.recommendedTypeChecked.map((config) => ({
    ...config,
    files: ['app/**/*.{ts,tsx}'],
  })),
  {
    files: ['app/**/*.{ts,tsx}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },

  // Import-boundary enforcement (task 1.1), applied after the general rules so a
  // boundary violation is always an error regardless of the recommended set.
  ...boundaryConfigs,

  // Disable every ESLint rule that would conflict with Prettier formatting.
  // MUST remain last so it wins over anything above.
  prettier,
];
