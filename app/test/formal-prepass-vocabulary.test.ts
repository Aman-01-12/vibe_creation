// formal-property-oracle, task 16.13: the pre-pass's closed vocabularies, and its named single cases.
//
// WHY THESE ARE UNIT TESTS AND NOT PROPERTIES
//   A closed vocabulary's claim is "exactly these members and no others", which is a statement about a
//   FIXED, SMALL, ENUMERATED set. A property over the union would draw its values FROM that union and
//   so could only ever confirm that the generator and the type agree - it would test the generator. So
//   each member gets ONE assertion naming it, and the closedness gets one more.
//   Each membership assertion goes through a TYPED constant rather than a bare string, so a RENAMED
//   member is a COMPILE ERROR here and not merely a failing assertion - which is the difference between
//   a test that catches the rename and a test that reports a puzzle.
//
// WHY `SandboxJobKind` IS SEALED WITH A TOTAL RECORD AND `clockPolarity` WITH AN ARRAY
//   `ClockPolarity` is declared as `(typeof CLOCK_POLARITIES)[number]`, so the exported array IS the
//   vocabulary and a count over it is the closedness claim. `SandboxJobKind` is declared as a bare
//   string union with no runtime array, so the seal here is a `Readonly<Record<SandboxJobKind, true>>`:
//   a member MISSING fails to compile, and a key that is not a member is an excess-property error. The
//   count then reads off an explicit `as const` key tuple rather than `Object.values`, which on a
//   fixed-key record falls to the `values(o: {}): any[]` overload and trips
//   `@typescript-eslint/no-unsafe-member-access`
//   (`chipAgent/_inbox/verification-recipe-assert-a-fixed-order-with-a-single-failure-probe-not-a-copy-of-the-cause-map.md`).
//
// THE NAMED SINGLE CASES, AND WHY EACH IS NOT REDUNDANT WITH PROPERTY 34
//   - AN EMPTY FLIP-FLOP CELL SET yields `clockPolarity: 'none'`, NO `clock-contract-unsupported`, and
//     NO `reset-contract-unresolved` either: it is ADMITTED as a contract requiring no reset
//     (Req 14.40). Property 34's posedge clause is VACUOUSLY satisfied on an empty cell set - "every
//     cell presents a posedge polarity" is true of no cells - so it cannot distinguish the supported
//     no-clocked-state class from a refusal, and design.md quantifies Property 34's first and refusal
//     clauses over NON-EMPTY cell sets for that reason. That class is 15 of 50 corpus references, so it
//     is not an edge case; refusing it refused the whole combinational class.
//   - A CELL SET RETAINING NO RESET ENTRY **WHERE THE DESIGN HOLDS CLOCKED STATE** yields
//     `could-not-verify` / `reset-contract-unresolved`. This is NOT the `LIFObuffer` shape: that
//     design's reset is enable-gated and DERIVES, carrying the enable the pre-pass named (criterion
//     4.15 of `formal-gate-first-light`, which AMENDS Req 14.19). What reaches this case is a design
//     whose reset net `opt_dff -sat` merged into an internal one, and it is in NO integration test:
//     test 13's refusal direction names `asyn_fifo` only, which refuses by a DIFFERENT clause of
//     the same rule - two reset ports rather than none. The clocked-state condition is the WHOLE
//     difference between this case and the one above, and the two are asserted over documents differing
//     in `clockPolarity` and in nothing else, which is the positive control for Req 14.42.
//   - A FAILED, ABSENT, OR SCHEMA-INVALID report, and an OUT-OF-VOCABULARY `clockPolarity`, both yield
//     `could-not-verify` / `toolchain-unavailable`, and NO default to `posedge` exists anywhere in the
//     parse. That default would be in the FALSE-REFUTATION direction the whole Clock_Contract rule
//     exists to close: a negedge or mixed-edge design read as posedge is lowered by a chain that
//     advances every `$dff` one step together, which MEASURABLY refutes a property that is true of the
//     real hardware - `Status: FAILED` at step 2 on a minimal mixed-edge reproducer that iverilog
//     reports 0 mismatches on over 40 randomised cycles
//     (`chipAgent/_inbox/gotcha-mixed-edge-clocking-collapses-in-write-smt2-and-falsely-refutes.md`).
//   - NO Reset_Contract INPUT COMES FROM `ClockingContract.resetActiveLow`, and the pre-pass is the
//     single owner of the derived polarity, the free-initial-state fact, and the Clock_Contract. The
//     honest CEILING on that last one is stated at the test itself.
//
//   The CELL-LEVEL halves of these cases - that an empty cell set produces the `none` finding, and that
//   a cell set with no reset entry produces the refused finding - are asserted in
//   `app/tools/sandbox/worker/tests/test_formal_prepass.py` (task 16.4), because the worker is the only
//   side that holds the netlist and Req 14.24 and 14.38 make it the only decider. What this file asserts
//   is what the TypeScript side does with each of those findings, which is where the CAUSE is decided.
//
// **Validates: Requirements 11.10, 14.10, 14.11, 14.19, 14.24, 14.26, 14.34, 14.36, 14.37, 14.38,
// 14.40, 14.42**

import { describe, expect, it } from 'vitest';

import {
  CLOCK_POLARITIES,
  COULD_NOT_VERIFY_CAUSES,
  deriveFormalPrepassReport,
  formalPrepassReportSchema,
  FREE_INITIAL_STATE_PREDICATE,
  MAX_PREPASS_REPORT_CHARS,
  parseFormalPrepassReport,
  readFormalPrepassReport,
  readFreeInitialState,
  type ClockPolarity,
  type CouldNotVerifyCause,
  type FormalPrepassDocument,
  type SandboxJobKind,
} from '@app/tools';

/** The four-member `clockPolarity` count (Req 14.36). */
const POLARITY_COUNT = 4;

/** The four-member `SandboxJobKind` count, which task 16.1 widened from three. */
const JOB_KIND_COUNT = 4;

/** The cause an unreadable report, predicate, or polarity value must produce (Req 14.26, 14.37). */
const UNREADABLE_REFUSAL: CouldNotVerifyCause = 'toolchain-unavailable';

/** The cause a refused reset derivation must produce (Req 14.18, 14.19, 14.20). */
const RESET_REFUSAL: CouldNotVerifyCause = 'reset-contract-unresolved';

/** The cause a non-posedge clock must produce, and the one these cases must NOT produce. */
const CLOCK_REFUSAL: CouldNotVerifyCause = 'clock-contract-unsupported';

/**
 * Every `SandboxJobKind`, as a TOTAL map. A fifth kind fails to compile here rather than arriving as
 * prose, and a key that is not a kind is an excess-property error.
 */
const JOB_KINDS: Readonly<Record<SandboxJobKind, true>> = Object.freeze({
  simulate: true,
  synthesize: true,
  formal: true,
  formalPrepass: true,
});

/**
 * The same four kinds as an explicit key tuple, so the COUNT is readable without `Object.values`.
 *
 * `satisfies` rather than a bare annotation: it checks that every entry is a real kind while leaving
 * the tuple's length visible to the type system. Completeness is the total map's job above; this is
 * only the count.
 */
const JOB_KIND_NAMES = [
  'simulate',
  'synthesize',
  'formal',
  'formalPrepass',
] as const satisfies readonly SandboxJobKind[];

/** A document carrying one clock finding, a refused reset, and a readable predicate. */
function documentWithPolarity(
  clockPolarity: ClockPolarity,
  resetDerived: boolean,
): FormalPrepassDocument {
  return {
    reset: resetDerived
      ? { derived: true, resetName: 'rst', resetActiveLow: false, resetKind: 'sync' }
      : { derived: false },
    clockPolarity,
    initialStatePredicate: FREE_INITIAL_STATE_PREDICATE,
  };
}

/**
 * One report text whose reset is DERIVED and whose enabling signal is `resetEnable`.
 *
 * `undefined` OMITS the key, which is the no-enable document the worker writes for a reset carried
 * by a cell with no enable. Every other field is the ADMITTING shape, so a refusal of the text is
 * attributable to the enable's own shape (criterion 4.15 of `formal-gate-first-light`).
 *
 * Built as `unknown` and serialized rather than typed as a `FormalPrepassDocument`, because the
 * shapes under test are exactly the ones that type forbids.
 */
function documentTextWithEnable(resetEnable: unknown): string {
  const reset: Record<string, unknown> = {
    derived: true,
    resetName: 'rst',
    resetActiveLow: false,
    resetKind: 'sync',
  };
  if (resetEnable !== undefined) {
    reset['resetEnable'] = resetEnable;
  }
  return JSON.stringify({
    reset,
    clockPolarity: 'posedge',
    initialStatePredicate: FREE_INITIAL_STATE_PREDICATE,
  });
}

/** The cause one document refuses with, or `null` where it yields a contract. */
function refusalOf(document: FormalPrepassDocument): CouldNotVerifyCause | null {
  const derived = deriveFormalPrepassReport(document);
  return derived.ok ? null : derived.error;
}

describe('formal-property-oracle: the clockPolarity vocabulary is closed at four members', () => {
  it('names the 31-of-50 class the whole chain was measured on', () => {
    const polarity: ClockPolarity = 'posedge';
    expect(CLOCK_POLARITIES).toContain(polarity);
    expect(refusalOf(documentWithPolarity(polarity, true))).toBeNull();
  });

  it('names the negedge-only class, which is measured EMPTY and refuses anyway', () => {
    // Kept as its own member rather than folded into `mixed` (Req 14.32): separating them records WHICH
    // class a refusal came from, which is the only way the measured-empty negedge-only class stops being
    // an assumption about the corpus and becomes an observation a report can contradict. The refusal
    // condition is the WIDER one - any non-posedge polarity - and that choice is FAIL-SAFE REASONING
    // rather than measurement, because no reference separates the two conditions.
    const polarity: ClockPolarity = 'negedge';
    expect(CLOCK_POLARITIES).toContain(polarity);
    expect(refusalOf(documentWithPolarity(polarity, true))).toBe(CLOCK_REFUSAL);
  });

  it('names the mixed-edge class, the two measured frequency dividers', () => {
    // `freq_divbyfrac` and `freq_divbyodd`. An ODD divider works PRECISELY because its negedge domain
    // is offset half a cycle from its posedge domain, so these are the designs least able to survive
    // `write_smt2` advancing every `$dff` one step together.
    const polarity: ClockPolarity = 'mixed';
    expect(CLOCK_POLARITIES).toContain(polarity);
    expect(refusalOf(documentWithPolarity(polarity, true))).toBe(CLOCK_REFUSAL);
  });

  it('names the no-clocked-state class, which is SUPPORTED and not a refusal', () => {
    // Req 14.34, and the reason the field is four values rather than a boolean: 15 of 50 references hold
    // no clocked state, and a design with no `$dff` has no clock for `write_smt2` to mis-advance. This
    // must not collapse into `posedge` and must not read as a refusal.
    const polarity: ClockPolarity = 'none';
    expect(CLOCK_POLARITIES).toContain(polarity);
    expect(refusalOf(documentWithPolarity(polarity, true))).toBeNull();
  });

  it('holds exactly four distinct members and nothing else', () => {
    expect(CLOCK_POLARITIES).toHaveLength(POLARITY_COUNT);
    expect(new Set(CLOCK_POLARITIES).size).toBe(POLARITY_COUNT);
  });

  it('spells the schema enum FROM the vocabulary, so there is no second list to drift', () => {
    // The schema is exported for exactly this assertion: a test that re-spelled the `enum` by hand would
    // assert only that its own copy equals itself. Reading it off the exported object instead pins that
    // the closed TYPE and the closed WIRE CONTRACT have ONE owner.
    const properties = formalPrepassReportSchema['properties'] as Record<string, unknown>;
    const clockPolarity = properties['clockPolarity'] as Record<string, unknown>;
    expect(clockPolarity['enum']).toEqual([...CLOCK_POLARITIES]);
  });
});

describe('formal-property-oracle: the SandboxJobKind vocabulary is closed at four members', () => {
  it('names the simulate kind, which the formal path did not replace', () => {
    const kind: SandboxJobKind = 'simulate';
    expect(JOB_KIND_NAMES).toContain(kind);
    expect(JOB_KINDS[kind]).toBe(true);
  });

  it('names the synthesize kind, which is STILL undispatched in the worker', () => {
    // Recorded rather than glossed: task 16.2 added a FOURTH kind and did not fix the second, so this
    // member exists in the contract while the worker answers it with the honest unsupported-kind
    // fallback (`chipAgent/_inbox/gotcha-worker-synthesize-kind-unimplemented.md`).
    const kind: SandboxJobKind = 'synthesize';
    expect(JOB_KIND_NAMES).toContain(kind);
    expect(JOB_KINDS[kind]).toBe(true);
  });

  it('names the formal kind, whose counterexample trace is NOT a required output', () => {
    const kind: SandboxJobKind = 'formal';
    expect(JOB_KIND_NAMES).toContain(kind);
    expect(JOB_KINDS[kind]).toBe(true);
  });

  it('names the formalPrepass kind, which cannot be a step inside the formal job', () => {
    // Req 14.11: the pre-pass must complete BEFORE the Property_Wrapper is rendered, and the wrapper is
    // what needs its answers - so it is a separate job kind rather than a pass inside the formal one.
    const kind: SandboxJobKind = 'formalPrepass';
    expect(JOB_KIND_NAMES).toContain(kind);
    expect(JOB_KINDS[kind]).toBe(true);
  });

  it('holds exactly four distinct members and nothing else', () => {
    expect(JOB_KIND_NAMES).toHaveLength(JOB_KIND_COUNT);
    expect(new Set(JOB_KIND_NAMES).size).toBe(JOB_KIND_COUNT);
  });
});

describe('formal-property-oracle: the pre-pass names its single cases rather than guessing', () => {
  it('reads an EMPTY flip-flop cell set as no clocked state, and ADMITS it rather than refusing', () => {
    // The shape the worker writes for a design holding no `$dff`: the clock finding is `none` and no
    // reset entry survived, because there was no cell to read one off. NEITHER cause applies. The
    // absence of a reset net is the EXPECTED finding for a design with no flip-flop cell, so it is
    // reported as a derived contract REQUIRING NO RESET (Req 14.40) - not as the clock's refusal, which
    // Property 34's posedge clause is vacuously blind to, and not as the reset's either, which is what
    // criterion 14.18 said before it was narrowed to the clocked class. Refusing here would refuse the
    // whole combinational class, 15 of 50 corpus references.
    expect(deriveFormalPrepassReport(documentWithPolarity('none', false))).toEqual({
      ok: true,
      value: { reset: { derived: false }, clockPolarity: 'none' },
    });
    expect(refusalOf(documentWithPolarity('none', false))).toBeNull();
    // NO PREDICATE IS READ ON THIS ARM, so an unreadable one cannot turn a SUPPORTED design into
    // `toolchain-unavailable`: `initialStateFree` lives on the derived member alone and nothing
    // consumes it here. Both unreadable shapes are checked, absent and unbalanced.
    for (const predicate of [null, '(and (= a #b0)']) {
      const unreadable: FormalPrepassDocument = {
        ...documentWithPolarity('none', false),
        initialStatePredicate: predicate,
      };
      expect({ predicate, refusal: refusalOf(unreadable) }).toEqual({ predicate, refusal: null });
    }
    // And where a no-clocked-state design DOES present a derived reset, it is admitted rather than
    // refused, so the supported class cannot reach the gate as a refusal by any route.
    const admitted = deriveFormalPrepassReport(documentWithPolarity('none', true));
    expect(admitted).toEqual({
      ok: true,
      value: {
        reset: {
          derived: true,
          resetName: 'rst',
          resetActiveLow: false,
          resetKind: 'sync',
          initialStateFree: true,
        },
        clockPolarity: 'none',
      },
    });
  });

  it('refuses a cell set retaining NO reset entry WHERE THE DESIGN HOLDS CLOCKED STATE', () => {
    // NOT the `LIFObuffer` shape: that design's enable-gated reset derives, carrying the enable
    // (criterion 4.15 of `formal-gate-first-light`, which AMENDS Req 14.19). A refusal is a
    // first-class OUTCOME carrying `reset-contract-unresolved` and never an unrecognized error
    // (Req 14.20).
    //
    // WHAT MAKES THIS A REFUSAL AND THE TEST ABOVE AN ADMISSION IS THE CLOCKED-STATE CONDITION, AND
    // NOTHING ELSE. Criterion 14.18 as AMENDED refuses "no net at all" only WHERE the candidate design
    // holds clocked state; criterion 14.40 admits the same reset finding as a contract requiring no
    // reset where it does not. So the two tests do not contradict each other: this design HAS flip-flop
    // cells, all presenting posedge, and therefore a reset net it could not resolve - which is a
    // derivation that failed. The design above has no cell to have carried one, which is a derivation
    // with nothing to do. The refusal is not lost in that correction, it MOVED here.
    expect(refusalOf(documentWithPolarity('posedge', false))).toBe(RESET_REFUSAL);
    expect(COULD_NOT_VERIFY_CAUSES).toContain(RESET_REFUSAL);

    // THE POSITIVE CONTROL FOR Req 14.42: the two documents differ in `clockPolarity` AND IN NOTHING
    // ELSE, so the guard is PROVED to be keyed on that field. Without this, the pair of outcomes above
    // would be consistent with a guard keyed on the predicate, on the reset name, or on a Spec field -
    // and `ModuleInterface.clocking` would answer the same question from MODEL-GENERATED text, which
    // criteria 14.9 and 14.10 forbid deriving the contract from.
    const refusing = documentWithPolarity('posedge', false);
    const admitting: FormalPrepassDocument = { ...refusing, clockPolarity: 'none' };
    expect(Object.entries(refusing).filter(([key]) => key !== 'clockPolarity')).toEqual(
      Object.entries(admitting).filter(([key]) => key !== 'clockPolarity'),
    );
    expect({ refusing: refusalOf(refusing), admitting: refusalOf(admitting) }).toEqual({
      refusing: RESET_REFUSAL,
      admitting: null,
    });

    // THE WHOLE CROSS, so the guard is pinned in every direction the vocabulary allows rather than at the
    // one pair above. A TOTAL map over `ClockPolarity`, so a fifth member fails to compile here instead
    // of arriving as an untested row.
    //
    // ONE MUTATION IS NOT OBSERVABLE THROUGH THIS FUNCTION AND THE REASON IS WORTH RECORDING. Keying the
    // admission on `clockPolarity !== 'posedge'` instead of `=== 'none'` passes the entire suite,
    // because it is an EQUIVALENT mutant rather than an uncaught defect: the Clock_Contract refusal runs
    // FIRST (Req 14.33), so `negedge` and `mixed` never reach the reset branch at all and the two
    // spellings cannot differ on any input. What holds that equivalence in place is the ORDER, and the
    // order is asserted - here by the negedge and mixed rows below, and generatively by Property 34's
    // both-refuse clause, which draws a non-posedge polarity against a REFUSED reset on about a quarter
    // of its cases and requires the cause to be the clock's. Drift in BOTH at once is what this table
    // catches: a widened guard is observable the moment the clock check stops pre-empting it.
    const refusalByPolarity: Readonly<Record<ClockPolarity, CouldNotVerifyCause | null>> = {
      posedge: RESET_REFUSAL,
      negedge: CLOCK_REFUSAL,
      mixed: CLOCK_REFUSAL,
      none: null,
    };
    for (const polarity of CLOCK_POLARITIES) {
      const observed = refusalOf(documentWithPolarity(polarity, false));
      expect({ polarity, observed }).toEqual({ polarity, observed: refusalByPolarity[polarity] });
    }

    // NO GUESS IS REPRESENTABLE. The refused arm of the reset union is CLOSED at its discriminant, so a
    // worker that guessed at the enabling signal and shipped the guess alongside `derived: false` fails
    // the parse rather than having its guess ignored - which is the difference between a rule and a
    // convention.
    const guessing = JSON.stringify({
      reset: { derived: false, resetName: 'Rst', resetActiveLow: true },
      clockPolarity: 'posedge',
      initialStatePredicate: FREE_INITIAL_STATE_PREDICATE,
    });
    expect(parseFormalPrepassReport(guessing).ok).toBe(false);
    expect(readFormalPrepassReport(guessing)).toEqual({ ok: false, error: UNREADABLE_REFUSAL });
  });

  it('refuses an unreadable enabling-signal shape rather than defaulting it to a level', () => {
    // Criterion 4.15 of `formal-gate-first-light`, which AMENDS Req 14.19: the pre-pass now DERIVES
    // the enable a conditional reset fires under, so the shape that enable arrives in is a trust
    // boundary of its own. The worker report is a tool's output over untrusted input, and the field
    // carries a net NAME and a LEVEL, so the decoder must refuse anything it does not recognize
    // rather than fill in the half it can read.
    //
    // THE POSITIVE CONTROL FIRST, so every refusal below is attributable to the enable shape and not
    // to a skeleton malformed in some other way. The same document with a WELL-FORMED enable yields
    // a contract, and the enable reaches it unchanged.
    expect(
      readFormalPrepassReport(documentTextWithEnable({ name: 'EN', activeLow: false })),
    ).toEqual({
      ok: true,
      value: {
        reset: {
          derived: true,
          resetName: 'rst',
          resetActiveLow: false,
          resetKind: 'sync',
          initialStateFree: true,
          resetEnable: { name: 'EN', activeLow: false },
        },
        clockPolarity: 'posedge',
      },
    });

    // THE ABSENT KEY IS THE OTHER HALF OF THE CONTROL, and it is the shape that must NOT become a
    // defaulted enable: a reset carried by a cell with no enable omits the field, and the contract
    // derived from it has no such key - not a key holding a level nobody read. An `activeLow: false`
    // default here would make the renderer pin a net the design does not gate the reset on.
    const unenabled = readFormalPrepassReport(documentTextWithEnable(undefined));
    expect(unenabled.ok && unenabled.value.reset.derived).toBe(true);
    expect(
      unenabled.ok && unenabled.value.reset.derived && 'resetEnable' in unenabled.value.reset,
    ).toBe(false);

    // Each shape is one way a worker, or a tool whose output it passed through, could present an
    // enable this layer cannot use. `'EN'` is the net name without its level; the two half-objects
    // are an enable missing one of its two facts; `activeLow: '0'` is the RAW `EN_POLARITY` string,
    // which is the sharp one because JavaScript reads the non-empty string `'0'` as TRUTHY, so a
    // coercing reader would record an enable asserted LOW as asserted HIGH - the level at which the
    // reset does not fire; the extra key is a document we do not recognize; and `null` is what a
    // writer emits for a finding it could not make, which is the absent KEY's job here.
    const unreadable: readonly unknown[] = [
      'EN',
      { name: 'EN' },
      { activeLow: false },
      { name: 'EN', activeLow: '0' },
      { name: 'EN', activeLow: 1 },
      { name: 'EN', activeLow: false, polarity: 1 },
      { name: ['EN'], activeLow: false },
      {},
      null,
    ];
    for (const value of unreadable) {
      const text = documentTextWithEnable(value);
      const parsed = parseFormalPrepassReport(text);
      expect({ value, ok: parsed.ok, reason: parsed.ok ? null : parsed.error.reason }).toEqual({
        value,
        ok: false,
        reason: 'schema-violation',
      });
      // And it reaches the gate as an INSTRUMENT FAULT rather than as a fact about the design
      // (Req 14.26): a report we cannot read is not a Reset_Contract we may use.
      expect({ value, read: readFormalPrepassReport(text) }).toEqual({
        value,
        read: { ok: false, error: UNREADABLE_REFUSAL },
      });
    }
  });

  it('refuses an absent, malformed, oversized, or schema-invalid report under one cause', () => {
    // Req 14.26: a pre-pass that cannot be READ is not a Reset_Contract that may be USED, whichever way
    // it was unreadable. An absent report reaches this layer as empty text, because the adapter reads the
    // file and hands over what it found.
    const unreadable: readonly string[] = [
      '',
      '   ',
      '{',
      'null',
      '[]',
      '{"reset":{"derived":false}}',
      `{"reset":{"derived":false},"clockPolarity":"posedge","initialStatePredicate":"${'x'.repeat(MAX_PREPASS_REPORT_CHARS)}"}`,
    ];
    for (const text of unreadable) {
      expect({ length: text.length, parsed: parseFormalPrepassReport(text).ok }).toEqual({
        length: text.length,
        parsed: false,
      });
      expect(readFormalPrepassReport(text)).toEqual({ ok: false, error: UNREADABLE_REFUSAL });
    }
  });

  it('refuses every out-of-vocabulary clockPolarity and defaults NONE of them to posedge', () => {
    // Req 14.37. The four values below are the ones a plausible drift produces: a case variant, a
    // trailing space, a synonym from another tool's vocabulary, and the empty string. Each must REFUSE,
    // and - the load-bearing half - none may arrive as a report carrying `posedge`, which is the
    // false-refutation direction.
    for (const value of ['POSEDGE', 'posedge ', 'rising', '', 'both']) {
      const text = JSON.stringify({
        reset: { derived: true, resetName: 'rst', resetActiveLow: false, resetKind: 'sync' },
        clockPolarity: value,
        initialStatePredicate: FREE_INITIAL_STATE_PREDICATE,
      });
      const read = readFormalPrepassReport(text);
      expect({ value, read }).toEqual({ value, read: { ok: false, error: UNREADABLE_REFUSAL } });
    }
  });

  it('takes no input but the document, so no Spec field reaches the Reset_Contract', () => {
    // Req 14.9, 14.10, 14.24, 14.38. `ClockingContract.resetActiveLow` originates in a MODEL-GENERATED
    // Spec, and a wrong polarity produces a FAILING base case over a PASSING induction check - byte for
    // byte the false-proof signature of the `bad_init` case - so a model's misreading of the reset would
    // arrive as a REFUTATION of the student's own design. The runtime half of "it is not read" is that
    // there is no channel for it: each of the three decision functions takes exactly ONE parameter, and
    // an extra argument reaches nothing.
    expect(deriveFormalPrepassReport).toHaveLength(1);
    expect(readFormalPrepassReport).toHaveLength(1);
    expect(readFreeInitialState).toHaveLength(1);

    // An extra argument is ASSIGNABLE rather than cast, so this is a real call shape: a function of one
    // parameter satisfies a variadic type. The contradicting `resetActiveLow` below is what a Spec would
    // have carried, and the answer is the DOCUMENT's value regardless.
    const variadic: (
      document: FormalPrepassDocument,
      ...extra: readonly unknown[]
    ) => ReturnType<typeof deriveFormalPrepassReport> = deriveFormalPrepassReport;
    const document = documentWithPolarity('posedge', true);
    expect(variadic(document, { clocking: { resetActiveLow: true } })).toEqual(
      deriveFormalPrepassReport(document),
    );

    // THE CEILING, STATED RATHER THAN IMPLIED. `ResetContract` carries no brand, unlike
    // `ProvedEvidence`'s `NonZeroAssertionCount`, so "the pre-pass is the SINGLE owner of the derived
    // polarity" is enforced by the module boundary and by there being no second producer in the package
    // - not by the type system. What is checkable here is that the derived polarity in the report is the
    // one the document carried, with nothing between the two: no normalization, no cross-check against a
    // Spec, and no default.
    const derived = deriveFormalPrepassReport(document);
    expect(derived.ok && derived.value.reset.derived && derived.value.reset.resetActiveLow).toBe(
      document.reset.derived && document.reset.resetActiveLow,
    );
  });
});
