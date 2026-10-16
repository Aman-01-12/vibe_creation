// reference-model-consensus-gate, Property 26: The relocated mutation operator set is
// unchanged (task 4.2, C12).
//
// THE ORACLE
//   Task 4.1 moved the pure mutation vocabulary out of `@app/eval/mutation-control.ts` into
//   `@app/tools/mutation/operators.ts`, with `@app/eval` re-exporting every name by binding. A
//   move that silently reordered, dropped, or renamed an operator - or that re-implemented a
//   function instead of re-exporting it - would be invisible to a test that reads the moved
//   vocabulary and compares it against itself. So every comparison below is against a value
//   RECORDED before the move: a literal operator array, and a literal canonicalized string, each
//   committed here rather than derived from the module under test.
//
// WHY THE RE-EXPORT IS PINNED BY IDENTITY, NOT BY SHAPE
//   A `toEqual` on `MUTATION_OPERATORS` would pass over a re-implementation that rebuilt an
//   identical frozen array, and the same is true of a function that happened to compute the same
//   answer. The claim this task exists to prevent is exactly that: a second implementation
//   drifting from the first. So every RUNTIME export task 4.1 relocated is compared by `===`
//   between the binding reached through `@app/tools` directly and the binding reached through
//   `@app/eval`'s re-export, which is the only comparison a re-implementation cannot pass.
//   `MutantIdentity`, `Mutant`, `MutationOperatorId`, `MutationSite`, and `MutationProbeReport`
//   are types with no runtime value, so they carry no binding to compare and are excluded.
//   `canonicalMutationConfig` and `DEFAULT_MUTATION_CONFIG` were never relocated - they stay in
//   `@app/eval`, which is why the canonicalization clause below exists at all: it is the only way
//   to show the move did not perturb what an UNMOVED function reads off the vocabulary that did.
//
// Validates: Requirements 12.4

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  allSurvivors as allSurvivorsViaEval,
  canonicalMutationConfig,
  DEFAULT_MUTATION_CONFIG,
  identityOf as identityOfViaEval,
  killRateOf as killRateOfViaEval,
  MAX_SITE_TEXT_CHARS as MAX_SITE_TEXT_CHARS_VIA_EVAL,
  mutantIdOf as mutantIdOfViaEval,
  mutantRunLimits as mutantRunLimitsViaEval,
  MUTATION_OPERATORS as MUTATION_OPERATORS_VIA_EVAL,
  reportedFailureKills as reportedFailureKillsViaEval,
  type MutationConfig,
  type MutationOperatorId,
} from '@app/eval';
import {
  allSurvivors,
  identityOf,
  killRateOf,
  MAX_SITE_TEXT_CHARS,
  mutantIdOf,
  mutantRunLimits,
  MUTATION_OPERATORS,
  reportedFailureKills,
} from '@app/tools';

const PROPERTY =
  'reference-model-consensus-gate, Property 26: The relocated mutation operator set is unchanged';

/**
 * The operator order `@app/eval/mutation-control.ts` exported BEFORE task 4.1's relocation to
 * `@app/tools/mutation/operators.ts`. Recorded here as a literal rather than read off either
 * module, so a relocation that reordered, dropped, or added an operator fails this comparison
 * instead of comparing the vocabulary against itself.
 */
const BASELINE_OPERATORS: readonly MutationOperatorId[] = [
  'ARITH_PLUS_TO_MINUS',
  'ARITH_MINUS_TO_PLUS',
  'BITWISE_AND_TO_OR',
  'BITWISE_OR_TO_AND',
  'RELATIONAL_LT_TO_LE',
  'EQUALITY_TO_INEQUALITY',
  'SHIFT_DIRECTION_SWAPPED',
  'CONDITION_NEGATED',
  'RESET_BRANCH_DISABLED',
  'CONST_ZERO_TO_ONE',
  'CONST_INCREMENTED',
  'INDEX_OFF_BY_ONE',
];

/**
 * Two `canonicalMutationConfig` outputs recorded the same way the operator list above is: a
 * literal string, not a formula restated from the implementation. `canonicalMutationConfig`
 * itself was never relocated, so a mismatch here can only mean the relocated `MUTATION_OPERATORS`
 * it reads - the one thing that could have changed out from under it - changed order or content.
 * The second case is a shuffled, truncated subset rather than the full default list, so the
 * assertion also shows the canonical form re-sorts into `MUTATION_OPERATORS` order and is not a
 * pass-through of whatever order the caller supplied.
 */
const BASELINE_CANONICAL_CONFIGS: ReadonlyArray<readonly [MutationConfig, string]> = [
  [
    DEFAULT_MUTATION_CONFIG,
    '{"maxMutantsPerProblem":24,"operators":["ARITH_PLUS_TO_MINUS","ARITH_MINUS_TO_PLUS",' +
      '"BITWISE_AND_TO_OR","BITWISE_OR_TO_AND","RELATIONAL_LT_TO_LE","EQUALITY_TO_INEQUALITY",' +
      '"SHIFT_DIRECTION_SWAPPED","CONDITION_NEGATED","RESET_BRANCH_DISABLED","CONST_ZERO_TO_ONE",' +
      '"CONST_INCREMENTED","INDEX_OFF_BY_ONE"]}',
  ],
  [
    { maxMutantsPerProblem: 5, operators: ['INDEX_OFF_BY_ONE', 'ARITH_PLUS_TO_MINUS'] },
    '{"maxMutantsPerProblem":5,"operators":["ARITH_PLUS_TO_MINUS","INDEX_OFF_BY_ONE"]}',
  ],
];

describe(PROPERTY, () => {
  it('yields the recorded baseline operator list, element for element and in order', () => {
    expect(MUTATION_OPERATORS_VIA_EVAL).toEqual(BASELINE_OPERATORS);
    // Non-vacuous: the baseline itself is the full twelve-operator vocabulary, not an empty or
    // truncated stand-in that any list would satisfy.
    expect(BASELINE_OPERATORS).toHaveLength(12);
  });

  it('canonicalizes a MutationConfig to the string recorded before the relocation', () => {
    for (const [config, expectedCanonical] of BASELINE_CANONICAL_CONFIGS) {
      expect(canonicalMutationConfig(config)).toBe(expectedCanonical);
    }
  });
});

/**
 * Every RUNTIME export task 4.1 relocated: `[name, binding reached via @app/eval, binding
 * reached via @app/tools]`. Scoped to runtime exports only - the eight named in the task - because
 * a type has no value to compare; `expect(viaEval).toBe(viaTools)` would not even type-check for
 * `MutantIdentity`, `Mutant`, `MutationOperatorId`, `MutationSite`, or `MutationProbeReport`.
 */
const RELOCATED_RUNTIME_EXPORTS: ReadonlyArray<readonly [string, unknown, unknown]> = [
  ['MUTATION_OPERATORS', MUTATION_OPERATORS_VIA_EVAL, MUTATION_OPERATORS],
  ['mutantIdOf', mutantIdOfViaEval, mutantIdOf],
  ['identityOf', identityOfViaEval, identityOf],
  ['mutantRunLimits', mutantRunLimitsViaEval, mutantRunLimits],
  ['reportedFailureKills', reportedFailureKillsViaEval, reportedFailureKills],
  ['killRateOf', killRateOfViaEval, killRateOf],
  ['allSurvivors', allSurvivorsViaEval, allSurvivors],
  ['MAX_SITE_TEXT_CHARS', MAX_SITE_TEXT_CHARS_VIA_EVAL, MAX_SITE_TEXT_CHARS],
];

describe('the re-export is pinned by identity, not by shape (Req 12.4)', () => {
  it.each(RELOCATED_RUNTIME_EXPORTS)(
    '%s reached through @app/eval is the exact same binding reached through @app/tools',
    (_name, viaEval, viaTools) => {
      // `MAX_SITE_TEXT_CHARS` is a primitive, so `toBe` here is a value comparison by
      // necessity - a number has no reference identity - but it is still the strongest
      // equality this export admits, and every other row is a true reference comparison: two
      // frozen arrays or two functions can be deeply equal while being distinct objects, which
      // is exactly the re-implementation this pin must catch and `toEqual` would not.
      expect(viaEval).toBe(viaTools);
    },
  );
});

// -- The relocated module's import boundary (Req 17.2) ------------------------------------------

/**
 * The modules `source` loads at RUNTIME, in source order.
 *
 * Every line-leading `import` counts except `import type`, which is exactly what
 * `verbatimModuleSyntax` erases, so what remains is what Node actually loads. The same rule
 * `structural-claims.test.ts` and `testbench-rtl-isolation.property.test.ts` already pin their
 * own import-boundary checks with.
 */
function runtimeImportsOf(source: string): readonly string[] {
  return [...source.matchAll(/^import(?!\s+type\b)[^;]*?['"]([^'"]+)['"]/gm)].map(
    (match) => match[1] ?? '',
  );
}

/** The relocated module's own source, read fresh rather than from `dist`. */
const OPERATORS_SOURCE = readFileSync(
  new URL('../tools/mutation/operators.ts', import.meta.url),
  'utf8',
);

describe('app/tools/mutation/operators.ts imports nothing from @app/eval or @app/agent (Req 17.2)', () => {
  it('loads no module at runtime: its one import is `import type`, erased by verbatimModuleSyntax', () => {
    expect(runtimeImportsOf(OPERATORS_SOURCE)).toEqual([]);
  });

  it('reports a runtime import of either forbidden package, so the empty result above is a measurement', () => {
    // Positive control: the real file plus one more import line, and the scan names it. Proves
    // the empty result is not a scan that would see nothing regardless of what the file imports.
    expect(
      runtimeImportsOf(`${OPERATORS_SOURCE}\nimport { judgeCoverageGaps } from '@app/eval';\n`),
    ).toEqual(['@app/eval']);
    expect(
      runtimeImportsOf(`${OPERATORS_SOURCE}\nimport { PropertyAgent } from '@app/agent';\n`),
    ).toEqual(['@app/agent']);
  });
});
