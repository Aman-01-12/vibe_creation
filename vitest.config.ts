// Root Vitest configuration (task 1.3).
//
// One test project spanning the whole workspace: all layers share the settled
// Node/TypeScript runtime, so a single config runs every `*.test.ts` across
// `app/**`. `npm test` invokes `vitest run` against this config, satisfying the
// CI contract (the TypeScript job runs `npm test`). Property tests use fast-check
// and default to the 100+ iteration count from `@app/test`'s `propertyParameters`.

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['app/**/*.{test,spec}.ts'],
    exclude: ['**/dist/**', '**/node_modules/**'],
    // Zero-test tolerance for the CI gate (task 1.2): most layers gain their
    // tests in later tasks, so `vitest run` must succeed on a tree with no
    // matching test files rather than exit 1 on "No test files found". This
    // mirrors the Python worker gate, which treats pytest's exit code 5 (no
    // tests collected) as a pass. It does not mask real failures: any collected
    // test that fails still fails the run.
    passWithNoTests: true,
    // Vitest's out-of-box per-test timeout is 5000ms, calibrated for ordinary
    // unit tests. It was never chosen for this suite, where 212 property files
    // each run 100+ fast-check iterations per test (see `propertyParameters`
    // above), so the default sat in the middle of the heaviest tests' natural
    // variance rather than above it.
    //
    // Measured on the fast tier (439 files, 3733 tests, 8 cores): the heaviest
    // test, rendered-stimulus-mixer's all-data bundle draw, ran 4563ms on one
    // full-tier run and 6170ms on another - straddling the 5000ms default, which
    // is what made it fail only under contention. Six more tests exceed 1000ms.
    // 20s is ~3.2x the slowest run observed. A genuine hang still fails the gate,
    // 15s later.
    testTimeout: 20_000,
  },
});
