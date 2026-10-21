// formal-gate-first-light, Component 4: the runnable check over `PROPERTY_FIXTURE`.
//
// Needs no toolchain. The port-membership group reads the pinned corpus, which is the only
// thing here that can be absent on a fresh clone.

import { describe, expect, it } from 'vitest';

import type { ModuleInterface } from '@app/core';
import {
  FileSystemCorpusCheckout,
  importRtllmCorpus,
  RTLLM_CHECKOUT_PATH,
  RTLLM_PINNED_COMMIT,
} from '@app/eval';
import { CORPUS_TIMING_STAND_IN } from './real-oracle-harness.js';
import { MAX_WARM_UP_DEPTH } from '@app/tools';

import {
  combinationalProperty,
  COUNTER_12_ID,
  LIFO_BUFFER_ID,
  PROPERTY_FIXTURE,
  SCALING_ANCHOR_IDS,
  type FixtureProperty,
} from './formal-fixtures.js';

/** Every expression one entry carries, which is the whole text that reaches the renderer. */
function expressionsOf(entry: FixtureProperty): readonly string[] {
  const property = entry.property;
  if (property.kind === 'combinational') {
    return [property.consequent];
  }
  return [
    property.clock,
    property.consequent,
    ...(property.antecedent === null ? [] : [property.antecedent]),
  ];
}

/** A Verilog sized or unsized based literal, whose base letter and digits are not identifiers. */
const BASED_LITERAL_RE = /\d*'[sS]?[bBoOdDhH][0-9a-fA-FxXzZ?_]+/g;

/** A `$`-prefixed system function call, which names no design signal. */
const SYSTEM_FUNCTION_RE = /\$[A-Za-z_][A-Za-z0-9_$]*/g;

const IDENTIFIER_RE = /[A-Za-z_][A-Za-z0-9_$]*/g;

/** The signal names one expression references, with literals and system functions removed. */
function signalNamesIn(expression: string): readonly string[] {
  const bare = expression.replaceAll(BASED_LITERAL_RE, ' ').replaceAll(SYSTEM_FUNCTION_RE, ' ');
  return [...bare.matchAll(IDENTIFIER_RE)].map((match) => match[0]);
}

/**
 * Every `$past` depth one expression asks for. `$past(x)` is depth 1, SystemVerilog's default.
 *
 * `NaN` for a nested, parenthesised, or non-decimal depth, so a shape this reader cannot parse
 * fails the check instead of reading as a small depth.
 */
function pastDepthsIn(expression: string): readonly number[] {
  const calls = [...expression.matchAll(/\$past\s*\(([^()]*)\)/g)];
  if (calls.length !== [...expression.matchAll(/\$past\b/g)].length) {
    return [Number.NaN];
  }
  return calls.map((call) => {
    const argument = (call[1] ?? '').split(',')[1];
    if (argument === undefined) {
      return 1;
    }
    const decimal = /^\s*(\d+)\s*$/.exec(argument);
    return decimal === null ? Number.NaN : Number(decimal[1]);
  });
}

/**
 * The names a Property_Wrapper over one design may legitimately use: its own ports, plus the
 * clock and reset the wrapper flattens in. Anything else is an implicitly declared net.
 */
function wrapperVocabulary(moduleInterface: ModuleInterface): ReadonlySet<string> {
  const { clockName, resetName } = moduleInterface.clocking;
  return new Set([
    ...moduleInterface.ports.map((port) => port.name),
    ...[clockName, resetName].filter((name): name is string => name !== null),
  ]);
}

describe('PROPERTY_FIXTURE membership', () => {
  it('holds an entry expecting proved and an entry expecting refuted', () => {
    const verdicts = PROPERTY_FIXTURE.map((entry) => entry.expectedVerdict);
    expect(verdicts).toContain('proved');
    expect(verdicts).toContain('refuted');
  });

  it('covers all three Scaling_Anchors', () => {
    const covered = new Set(PROPERTY_FIXTURE.map((entry) => entry.designId));
    expect(SCALING_ANCHOR_IDS.filter((id) => !covered.has(id))).toEqual([]);
  });

  it('holds a LIFObuffer entry expecting proved, which is the false-refutation probe', () => {
    const probes = PROPERTY_FIXTURE.filter(
      (entry) => entry.designId === LIFO_BUFFER_ID && entry.expectedVerdict === 'proved',
    );
    expect(probes.length).toBeGreaterThan(0);
  });

  it('holds a criterion 4.8 LIFObuffer entry expecting proved that asks for no $past', () => {
    // No `$past` means no Warm_Up_Gate, so the verdict reads the Reset_Contract and nothing else.
    const resetDependent = PROPERTY_FIXTURE.filter(
      (entry) => entry.designId === LIFO_BUFFER_ID && entry.criterionRef === '4.8',
    ).map((entry) => ({
      expectedVerdict: entry.expectedVerdict,
      pastDepths: expressionsOf(entry).flatMap((expression) => pastDepthsIn(expression)),
    }));
    expect(resetDependent).toContainEqual({ expectedVerdict: 'proved', pastDepths: [] });
  });

  it('holds an unconditional criterion 13.21 LIFObuffer entry expecting refuted', () => {
    // The enable-gated pair's witness half. Unconditional (so no cover) and expecting `refuted`
    // under EITHER reset assume: a widened assume that proves it has excluded a reachable path,
    // which is the false-proof direction FL-25's change moves in (Req 13.21).
    const witness = PROPERTY_FIXTURE.filter(
      (entry) => entry.designId === LIFO_BUFFER_ID && entry.criterionRef === '13.21',
    ).map((entry) => ({
      expectedVerdict: entry.expectedVerdict,
      antecedent: entry.property.kind === 'clocked' ? entry.property.antecedent : 'not-clocked',
      clock: entry.property.kind === 'clocked' ? entry.property.clock : 'not-clocked',
    }));

    expect(witness).toEqual([{ expectedVerdict: 'refuted', antecedent: null, clock: 'Clk' }]);
  });

  it('states both multiplier entries over the 17-edge reset window, with measured verdicts', () => {
    // 17 is the measured operand-to-completion distance, one step inside the ceiling (Req 3.12).
    const multipliers = PROPERTY_FIXTURE.filter((entry) =>
      entry.designId.startsWith('rtllm/arithmetic/multi'),
    ).map((entry) => ({
      expectedVerdict: entry.expectedVerdict,
      deepestPast: Math.max(
        ...expressionsOf(entry).flatMap((expression) => pastDepthsIn(expression)),
      ),
    }));
    // Both state the same 17-edge window, and their expected verdicts DIFFER because one was
    // measured. `multi_booth_8bit` proves at 195 s under the uncapped ceiling. `multi_16bit`
    // is refuted, and the adjudicator reproduced its 39-step counterexample on the unmodified
    // design, so that refutation is on its merits rather than a False_Refutation (criterion 4.7).
    expect(multipliers).toEqual([
      { expectedVerdict: 'proved', deepestPast: 17 },
      { expectedVerdict: 'refuted', deepestPast: 17 },
    ]);
  });

  it('holds the ceiling-deep boundary pair, both spelled from the shipped ceiling', () => {
    // The pair measures the Warm_Up_Ceiling's exact edge, so each half must ask for the ceiling
    // itself and not a literal beside it: a depth that stopped tracking MAX_WARM_UP_DEPTH would
    // measure a boundary the renderer does not have (Req 13.9, 13.10).
    const pair = PROPERTY_FIXTURE.filter((entry) => entry.designId === COUNTER_12_ID).map(
      (entry) => ({
        criterionRef: entry.criterionRef,
        expectedVerdict: entry.expectedVerdict,
        depths: [...new Set(expressionsOf(entry).flatMap(pastDepthsIn))],
      }),
    );

    expect(pair).toEqual([
      { criterionRef: '13.9', expectedVerdict: 'proved', depths: [MAX_WARM_UP_DEPTH] },
      { criterionRef: '13.10', expectedVerdict: 'refuted', depths: [MAX_WARM_UP_DEPTH] },
    ]);
  });

  it('gives the boundary pair a cover on the proved half and none on the refuted half', () => {
    // The refuted half is unconditional (Req 13.11), so it has no antecedent and therefore no
    // Cover_Check. That asymmetry is the measurement's: a gate that evaluates nothing at the
    // first rung shows up on the proved half as an unreached cover, and on the refuted half only
    // as a base case that passes vacuously.
    const byCriterion = new Map(
      PROPERTY_FIXTURE.filter((entry) => entry.designId === COUNTER_12_ID).map((entry) => [
        entry.criterionRef,
        entry.property,
      ]),
    );
    const proved = byCriterion.get('13.9');
    const refuted = byCriterion.get('13.10');

    expect(proved?.kind === 'clocked' ? proved.antecedent !== null : null).toBe(true);
    expect(refuted?.kind === 'clocked' ? refuted.antecedent : 'not-clocked').toBeNull();
  });

  it('attributes every entry to a criterion', () => {
    expect(PROPERTY_FIXTURE.filter((entry) => entry.criterionRef.trim().length === 0)).toEqual([]);
  });

  it('asks for no $past deeper than the renderer will gate', () => {
    // The Property_Validator now refuses a deeper `$past` when the fixture loads (task 4.14), so
    // what is left for this check is the nested and parenthesised shapes its own reader flags.
    const tooDeep = PROPERTY_FIXTURE.flatMap((entry) =>
      expressionsOf(entry)
        .flatMap((expression) => pastDepthsIn(expression))
        .filter((depth) => !Number.isSafeInteger(depth) || depth > MAX_WARM_UP_DEPTH)
        .map((depth) => `${entry.property.id}: $past depth ${String(depth)}`),
    );
    expect(tooDeep).toEqual([]);
  });

  it('fails the load for a combinational $stable entry, naming its construct', () => {
    // The shape the renderer cannot emit is refused where the entry is built (Req 13.18), so it
    // cannot reach a measurement as a wrapper carrying no assertion.
    expect(() => combinationalProperty('combinational-stable', '$stable(out)')).toThrow(
      '$stable in combinational',
    );
  });
});

const CORPUS = await importRtllmCorpus(
  new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH),
  CORPUS_TIMING_STAND_IN,
);

describe.skipIf(CORPUS.problems.length === 0)(
  'PROPERTY_FIXTURE names only signals the Property_Wrapper declares',
  () => {
    it('resolves every designId in the pinned corpus', () => {
      const known = new Set(CORPUS.problems.map((problem) => problem.id));
      expect(PROPERTY_FIXTURE.filter((entry) => !known.has(entry.designId))).toEqual([]);
    });

    it('references no name outside the design interface, which is a silent false proof', () => {
      // Both measured traps land here: `dut.cnt` contributes `dut`, and a bare internal net
      // contributes its own name. Neither is in the vocabulary.
      const foreign = PROPERTY_FIXTURE.flatMap((entry) => {
        const problem = CORPUS.problems.find((candidate) => candidate.id === entry.designId);
        if (problem === undefined) {
          return [`${entry.property.id}: ${entry.designId} is not in the corpus`];
        }
        const vocabulary = wrapperVocabulary(problem.spec.moduleInterface);
        return expressionsOf(entry)
          .flatMap((expression) => signalNamesIn(expression))
          .filter((name) => !vocabulary.has(name))
          .map((name) => `${entry.property.id}: ${name}`);
      });
      expect(foreign).toEqual([]);
    });
  },
);

if (CORPUS.problems.length === 0) {
  console.warn(
    `[formal-fixtures] The port-membership check was NOT exercised: no RTLLM checkout at the ` +
      `pinned commit ${RTLLM_PINNED_COMMIT}; run \`npm run corpus:fetch\`.`,
  );
}
