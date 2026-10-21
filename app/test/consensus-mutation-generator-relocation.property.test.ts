// reference-model-consensus-gate, round 3: The relocated mutant generator and MutationConfig
// are unchanged (design-answers-round3.md, DQ-8/DQ-9 preamble).
//
// THE ORACLE
//   This fix moved `generateMutants`, `MAX_MUTATED_SOURCE_CHARS`, and `MutationConfig` out of
//   `@app/eval/corpus/verilog-mutation.ts` and `@app/eval/mutation-control.ts` into
//   `@app/tools/mutation/generator.ts` and `@app/tools/mutation/operators.ts`, with `@app/eval`
//   re-exporting every one by binding - the same move task 4.1 made for the rest of the
//   mutation vocabulary, and the same discipline
//   `consensus-mutation-relocation.property.test.ts` already pins for that move. This file is
//   that same pin, scoped to the names THIS move relocated.
//
// WHY PINNED BY IDENTITY AND BY A RECORDED BASELINE, NOT BY SELF-COMPARISON
//   A `toEqual` on a generated mutant set would pass over a re-implementation that happened to
//   produce the same mutants, and comparing a re-exported binding against itself would pass
//   over a re-implementation entirely. So the generated mutant set is compared against a
//   literal recorded BEFORE this move (the same `COUNTER` fixture
//   `verilog-mutation.test.ts` already uses, so the baseline is independently checkable
//   against that file's own passing suite), and the re-exported function/const are compared by
//   `===` between the binding reached through `@app/eval` and the one reached through
//   `@app/tools`.
//
// Validates: the design-answers-round3.md fix's own "no behaviour change" requirement for the
// relocation half of the fix (the new mutant-execution logic is tested separately in
// `app/agent/consensus/mutant-matrix-executor.test.ts`).

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import {
  DEFAULT_MUTATION_CONFIG as DEFAULT_MUTATION_CONFIG_VIA_EVAL,
  generateMutants as generateMutantsViaEval,
  MAX_MUTATED_SOURCE_CHARS as MAX_MUTATED_SOURCE_CHARS_VIA_EVAL,
} from '@app/eval';
import { generateMutants, MAX_MUTATED_SOURCE_CHARS } from '@app/tools';

/** The same sequential-counter fixture `app/eval/corpus/verilog-mutation.test.ts` pins against. */
const COUNTER = `\`timescale 1ns/1ps
module counter (input clk, input rst_n, output reg [7:0] q);
  always @(posedge clk or negedge rst_n)
    if (!rst_n)
      q <= 8'd0;
    else if (q < 8'd200)
      q <= q + 1;
    else
      q <= 8'd0;
endmodule
`;

/**
 * The mutant ids `generateMutants(COUNTER, DEFAULT_MUTATION_CONFIG)` produced BEFORE this
 * move, recorded as a literal rather than read off either module under test. Order matters:
 * the round-robin selection is a deterministic function of source and config, so a relocation
 * that reordered site selection would change this list's order even if the set were unchanged.
 */
const BASELINE_MUTANT_IDS = [
  'ARITH_PLUS_TO_MINUS@7:14',
  'RELATIONAL_LT_TO_LE@6:16',
  'CONDITION_NEGATED@4:8',
  'RESET_BRANCH_DISABLED@4:8',
  'CONST_ZERO_TO_ONE@5:15',
  'CONST_INCREMENTED@6:21',
  'INDEX_OFF_BY_ONE@2:53',
  'CONDITION_NEGATED@6:13',
  'CONST_ZERO_TO_ONE@9:15',
  'CONST_INCREMENTED@7:16',
  'INDEX_OFF_BY_ONE@2:55',
] as const;

describe('generateMutants, relocated to @app/tools/mutation/generator.ts: unchanged behaviour', () => {
  it('yields the recorded baseline mutant set for the COUNTER fixture, in order', () => {
    const mutants = generateMutantsViaEval(COUNTER, DEFAULT_MUTATION_CONFIG_VIA_EVAL);
    expect(mutants.map((mutant) => mutant.mutantId)).toEqual(BASELINE_MUTANT_IDS.slice());
    // Non-vacuous: the baseline fires 7 of the 12 operator classes on this fixture, not an
    // empty or single-entry stand-in any mutation would satisfy.
    expect(new Set(mutants.map((mutant) => mutant.operator)).size).toBe(7);
  });
});

/**
 * Every runtime export this move relocated: `[name, binding via @app/eval, binding via
 * @app/tools]`. `MutationConfig` is a type with no runtime value and is excluded for the same
 * reason the sibling pin excludes `MutationOperatorId` and friends.
 */
const RELOCATED_RUNTIME_EXPORTS: ReadonlyArray<readonly [string, unknown, unknown]> = [
  ['generateMutants', generateMutantsViaEval, generateMutants],
  ['MAX_MUTATED_SOURCE_CHARS', MAX_MUTATED_SOURCE_CHARS_VIA_EVAL, MAX_MUTATED_SOURCE_CHARS],
];

describe('the re-export is pinned by identity, not by shape', () => {
  it.each(RELOCATED_RUNTIME_EXPORTS)(
    '%s reached through @app/eval is the exact same binding reached through @app/tools',
    (_name, viaEval, viaTools) => {
      expect(viaEval).toBe(viaTools);
    },
  );
});

// -- The relocated module's import boundary (Req 17.2) ------------------------------------------

/** Every line-leading runtime `import`, which `verbatimModuleSyntax` erasure makes exhaustive. */
function runtimeImportsOf(source: string): readonly string[] {
  return [...source.matchAll(/^import(?!\s+type\b)[^;]*?['"]([^'"]+)['"]/gm)].map(
    (match) => match[1] ?? '',
  );
}

const GENERATOR_SOURCE = readFileSync(
  new URL('../tools/mutation/generator.ts', import.meta.url),
  'utf8',
);

describe('app/tools/mutation/generator.ts imports nothing from @app/eval or @app/agent (Req 17.2)', () => {
  it('loads only sibling @app/tools modules at runtime', () => {
    const imports = runtimeImportsOf(GENERATOR_SOURCE);
    expect(imports.length).toBeGreaterThan(0);
    for (const specifier of imports) {
      expect(specifier.startsWith('@app/eval')).toBe(false);
      expect(specifier.startsWith('@app/agent')).toBe(false);
    }
  });

  it('reports a runtime import of either forbidden package, so the check above is a measurement', () => {
    expect(
      runtimeImportsOf(`${GENERATOR_SOURCE}\nimport { judgeCoverageGaps } from '@app/eval';\n`),
    ).toContain('@app/eval');
    expect(
      runtimeImportsOf(`${GENERATOR_SOURCE}\nimport { PropertyAgent } from '@app/agent';\n`),
    ).toContain('@app/agent');
  });
});

// -- The three mutant wall-clock constants, relocated alongside mutantRunLimits -------------
//
// `DEFAULT_MUTANT_WALL_MS`, `MIN_MUTANT_WALL_MS`, and `MAX_MUTANT_WALL_MS` moved from
// `@app/eval/mutation-control.ts` into `@app/tools/mutation/operators.ts` in this same fix,
// alongside `mutantRunLimits` (already there since task 4.1), because
// `app/agent/consensus/mutant-matrix-executor.ts` needs a wall-clock default for its own
// in-Session mutant runs and `@app/agent` cannot reach `@app/eval`.

import {
  DEFAULT_MUTANT_WALL_MS as DEFAULT_MUTANT_WALL_MS_VIA_EVAL,
  MAX_MUTANT_WALL_MS as MAX_MUTANT_WALL_MS_VIA_EVAL,
  MIN_MUTANT_WALL_MS as MIN_MUTANT_WALL_MS_VIA_EVAL,
} from '@app/eval';
import { DEFAULT_MUTANT_WALL_MS, MAX_MUTANT_WALL_MS, MIN_MUTANT_WALL_MS } from '@app/tools';

const RELOCATED_WALL_MS_EXPORTS: ReadonlyArray<readonly [string, unknown, unknown]> = [
  ['DEFAULT_MUTANT_WALL_MS', DEFAULT_MUTANT_WALL_MS_VIA_EVAL, DEFAULT_MUTANT_WALL_MS],
  ['MIN_MUTANT_WALL_MS', MIN_MUTANT_WALL_MS_VIA_EVAL, MIN_MUTANT_WALL_MS],
  ['MAX_MUTANT_WALL_MS', MAX_MUTANT_WALL_MS_VIA_EVAL, MAX_MUTANT_WALL_MS],
];

describe('the mutant wall-ms constants are the same values on both sides of the re-export', () => {
  it.each(RELOCATED_WALL_MS_EXPORTS)(
    '%s via @app/eval equals %s via @app/tools',
    (_name, viaEval, viaTools) => {
      expect(viaEval).toBe(viaTools);
    },
  );

  it('keeps the measured relationship: 500 < 5000 < 60000', () => {
    expect(MIN_MUTANT_WALL_MS).toBe(500);
    expect(DEFAULT_MUTANT_WALL_MS).toBe(5_000);
    expect(MAX_MUTANT_WALL_MS).toBe(60_000);
  });
});
