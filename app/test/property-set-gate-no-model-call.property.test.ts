// Feature: formal-gate-first-light, Property 19: The gate makes no model call of its own, and
// scores the set the sample was authored from.
//
// WHAT IS UNDER TEST, AND WHY IT IS THE REAL GATE
//   The claim is about the PRODUCTION `RtllmPropertySetGate`, so that is what runs here, over
//   fakes on its two tool ports alone. A stand-in gate would prove nothing about Req 6.7: the
//   whole content of "no model call of its own" is that this gate reads a Property_Set off its
//   request instead of authoring one, and only the real adapter can be wrong about that.
//
// WHY IDENTITY AND NOT EQUALITY
//   The defect this property exists to catch is a SECOND authoring call that happens to produce
//   an equal set. A deep comparison passes against exactly that, and the recorded
//   `propertySetAdmitted` would then describe an artifact the Verification_Loop never saw. So
//   every assertion below is reference equality, and the negative control at the bottom
//   measures the gap: a second authoring call yields a set that is `toEqual` the first and is
//   not the same object.
//
// WHY CALLER ORDERS AND COUNTS ARE GENERATED
//   The memo has to hold under INTERLEAVING, not just in the harness's fixed gate-then-loop
//   order. An "await, then set a flag" memo authors twice when two callers overlap, and no
//   sequential order can see it, so the dispatch mode is generated alongside the order.
//
// WHY THE ADMISSION OUTCOME EXCLUDES THE FALLING-BACK ONES
//   `AdmissionStampingPropertySource` empties `properties` for an outcome that falls back, which
//   is criterion 6.3 and Property 30's claim, not this one. Holding a REFUSED set's properties
//   identical would contradict that rule, so the generator draws from the outcomes that do not
//   fall back, read from the predicate rather than named by hand.
//
// Validates: Requirements 6.7

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  PROPERTY_SET_ADMISSION_OUTCOMES,
  type FormalPropertySet,
  type PropertySetSource,
  type SessionBudgetHandle,
} from '@app/agent';
import {
  makePort,
  type ModuleInterface,
  type Port,
  type PortDirection,
  type Spec,
} from '@app/core';
import {
  AdmissionStampingPropertySource,
  DEFAULT_MUTATION_CONFIG,
  MemoizingPropertySetSource,
  propertySetAdmissionFallsBack,
  RtllmMutationCalibrator,
  RtllmPropertySetGate,
  type GoldenScore,
  type GoldenTestbench,
  type GoldenTestbenchScorer,
  type MutationConfig,
  type ReferenceDesign,
} from '@app/eval';
import {
  admitProved,
  validateExpression,
  type FormalOraclePort,
  type FormalOutcome,
  type FormalProperty,
  type FormalProveSetRequest,
  type ProofConditions,
  type PropertyResult,
  type ResourceLimits,
} from '@app/tools';

import { propertyParameters } from './property.js';

const PROPERTY =
  'formal-gate-first-light, Property 19: The gate makes no model call of its own, and scores the set the sample was authored from';

const PROBLEM_ID = 'rtllm/control/counter';
const MODULE_NAME = 'counter';
const LIMITS: ResourceLimits = { cpu: 1, memMb: 256, procs: 64, diskMb: 64, wallMs: 5_000 };
const MUTANT_WALL_MS = 500;

const REFERENCE_RTL = `module counter (input clk, input rst_n, output reg [7:0] q);
  always @(posedge clk or negedge rst_n)
    if (!rst_n)
      q <= 8'd0;
    else
      q <= q + 1;
endmodule
`;

/** An opaque Spec token: every source in this chain forwards the Spec and never reads it. */
const SPEC = {} as Spec;

/** A budget handle nothing in this file charges; the authoring cost is Property 10's claim. */
const BUDGET: SessionBudgetHandle = {
  sessionId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
  canAfford: () => true,
  charge: () => null,
  stopReason: () => null,
};

/**
 * The admission outcomes a set survives intact, read from the predicate.
 *
 * A fifth vocabulary member, or an existing one flipped to fall back, moves this list with no
 * edit here - the same reason `property-set-refused.property.test.ts` computes its expectation
 * from `propertySetAdmissionFallsBack` instead of comparing against `'refused'`.
 */
const INTACT_OUTCOMES = PROPERTY_SET_ADMISSION_OUTCOMES.filter(
  (outcome) => !propertySetAdmissionFallsBack(outcome),
);

/** A port, built through the factory that owns the positive-width invariant. */
function port(name: string, direction: PortDirection, width: number): Port {
  const built = makePort({ name, direction, width });
  if (!built.ok) {
    throw new Error(`invalid fixture port "${name}": ${built.error.message}`);
  }
  return built.value;
}

/** The reference's declared interface, which every mutant still declares. */
const MODULE_INTERFACE: ModuleInterface = {
  validityOutputName: null,
  moduleName: MODULE_NAME,
  ports: [port('clk', 'input', 1), port('rst_n', 'input', 1), port('q', 'output', 8)],
  clocking: { clockName: 'clk', resetName: 'rst_n', resetActiveLow: true },
};

const PROVED_CONDITIONS: ProofConditions = {
  assertionCount: 2,
  presat: 'satisfiable',
  cover: { reached: 'not-applicable' },
  base: 'passed',
  induction: 'successful',
};

/**
 * One proved result the fake oracle answers every submission with.
 *
 * Built through `admitProved` because `ProvedEvidence`'s assertion count is branded and that is
 * its sole constructor, so a fixture cannot spell a proof the five-condition gate refused. What
 * the oracle answers is not what this property reads; it is here so the gate reaches a
 * population at all.
 */
const PROVED_RESULT: PropertyResult = (() => {
  const evidence = admitProved(PROVED_CONDITIONS);
  if (typeof evidence === 'string') {
    throw new Error(`fixture conditions were refused by the gate: ${evidence}`);
  }
  return { verdict: 'proved', evidence, depth: 20, elapsedMs: 10, criterionRef: 'AC-1' };
})();

/** One real validated property; the fakes never read its content. */
function combinationalProperty(id: string): FormalProperty {
  const consequent = validateExpression('q');
  if (!consequent.ok) {
    throw new Error('the pinned consequent must be inside the accepted dialect');
  }
  return { kind: 'combinational', id, criterionRef: '6.7', consequent: consequent.value };
}

/**
 * A FRESH authored set, as a model-driven author produces one.
 *
 * Fresh per call is what makes the identity assertions bite: two authoring calls would hand back
 * two deeply equal objects, so an identity assertion fails exactly where a `toEqual` one would
 * not. The properties are real `FormalProperty` values rather than cast tokens, so no shape the
 * loop could never receive stands in for one it can.
 */
function authoredSet(propertyCount: number): FormalPropertySet {
  return {
    properties: Array.from({ length: propertyCount }, (_unused, index) =>
      combinationalProperty(`p${String(index)}`),
    ),
    unexpressedCriteria: [],
    // What the `PropertyAgent` stamps on the product path, which the gate's outcome overwrites.
    propertySetAdmitted: 'not-gated',
  };
}

/**
 * The Property_Author stand-in, counting its own calls.
 *
 * The call count IS the model-call count: this is the only collaborator in the composition that
 * would reach a model, so "the gate makes no model call of its own" is measurable as "running
 * the gate does not move this counter".
 */
class CountingAuthor implements PropertySetSource {
  readonly #build: () => FormalPropertySet;
  readonly #ticks: number;
  #calls = 0;

  constructor(build: () => FormalPropertySet, ticks: number) {
    this.#build = build;
    this.#ticks = ticks;
  }

  /** How many times this author was entered. */
  get calls(): number {
    return this.#calls;
  }

  /**
   * A freshly built set, after `ticks` microtasks.
   *
   * The delay is what lets two concurrent callers overlap INSIDE one authoring call, which is
   * the interleaving a memo that awaits before memoizing gets wrong.
   */
  async propertySetFor(): Promise<FormalPropertySet> {
    this.#calls += 1;
    for (let tick = 0; tick < this.#ticks; tick += 1) {
      await Promise.resolve();
    }
    return this.#build();
  }
}

function reference(): ReferenceDesign {
  return {
    problemId: PROBLEM_ID,
    rtl: { path: 'dut_reference.v', contents: REFERENCE_RTL },
    topModuleRenamedFrom: 'verified_counter',
  };
}

function goldenTestbench(): GoldenTestbench {
  return {
    problemId: PROBLEM_ID,
    moduleName: MODULE_NAME,
    testbench: { path: 'testbench.v', contents: 'module tb; endmodule\n' },
    dataFiles: [],
    overriddenParameters: [],
  };
}

/** A judge that kills every mutant, so the gate's population is non-empty and valid. */
const KILLING_SCORER: GoldenTestbenchScorer = {
  score: (): Promise<GoldenScore> =>
    Promise.resolve({
      problemId: PROBLEM_ID,
      verdict: { kind: 'failed', failureCount: 1, banners: [] },
      timedOut: false,
      diskLimitExceeded: false,
      exitCode: 0,
      diagnostics: '',
    }),
};

/** One mutant per run: this property reads the submission, not the population's size. */
const MUTATION_CONFIG: MutationConfig = {
  maxMutantsPerProblem: 1,
  operators: DEFAULT_MUTATION_CONFIG.operators,
};

/** The REAL calibrator over the fake judge, one instance per run so runs stay independent. */
function calibrator(): RtllmMutationCalibrator {
  return new RtllmMutationCalibrator({
    scorer: KILLING_SCORER,
    golden: new Map([[PROBLEM_ID, goldenTestbench()]]),
    references: new Map([[PROBLEM_ID, reference()]]),
    config: MUTATION_CONFIG,
    mutantWallMs: MUTANT_WALL_MS,
    cacheKey: {
      corpusCommit: 'commit1',
      mutationConfigHash: 'hash1',
      mutantWallMs: MUTANT_WALL_MS,
    },
  });
}

/** An oracle that records each submission BY REFERENCE, which is what the identity claim reads. */
function recordingOracle(submissions: FormalProveSetRequest[]): FormalOraclePort {
  return {
    prove: () =>
      Promise.reject(new Error('the gate must submit the whole set, never one property')),
    proveSet: (request: FormalProveSetRequest): Promise<FormalOutcome> => {
      submissions.push(request);
      const results = request.properties.length === 0 ? [] : [PROVED_RESULT];
      return Promise.resolve({
        results,
        propertyWrapperSources: results.map(() => null),
        counterexampleCaptures: results.map(() => null),
        resetContract: null,
        assertionGateEmitted: true,
        clockPolarity: null,
      });
    },
  };
}

/** Which side of the composition a generated caller stands for. */
type CallerKind = 'gate' | 'loop';

/** Whether the generated callers run one after another or overlap. */
type Dispatch = 'sequential' | 'concurrent';

/** One sample's composition, assembled exactly as the Eval_Harness assembles it. */
interface Composition {
  readonly author: CountingAuthor;
  readonly memo: MemoizingPropertySetSource;
  readonly loopSource: PropertySetSource;
  readonly gate: RtllmPropertySetGate;
  readonly submissions: readonly FormalProveSetRequest[];
}

/** What one generated run draws. */
interface Draw {
  readonly order: readonly CallerKind[];
  readonly dispatch: Dispatch;
  readonly propertyCount: number;
  readonly ticks: number;
  readonly outcome: (typeof INTACT_OUTCOMES)[number];
}

function compose(draw: Draw): Composition {
  const author = new CountingAuthor(() => authoredSet(draw.propertyCount), draw.ticks);
  const memo = new MemoizingPropertySetSource(author);
  const submissions: FormalProveSetRequest[] = [];
  return {
    author,
    memo,
    loopSource: new AdmissionStampingPropertySource(memo, draw.outcome),
    gate: new RtllmPropertySetGate({
      calibrator: calibrator(),
      oracle: recordingOracle(submissions),
      interfaces: new Map([[PROBLEM_ID, MODULE_INTERFACE]]),
    }),
    submissions,
  };
}

/** What one caller asked for, and the set it was served. */
interface Served {
  readonly kind: CallerKind;
  readonly set: FormalPropertySet;
}

/**
 * Serve one caller, in the order the production side takes.
 *
 * The gate caller is the harness: author through the memo, then hand THAT object to the gate.
 * The loop caller reaches the stamping decorator, which is the port the Verification_Loop holds.
 */
async function serve(kind: CallerKind, parts: Composition): Promise<Served> {
  if (kind === 'loop') {
    return { kind, set: await parts.loopSource.propertySetFor(SPEC, BUDGET) };
  }
  const set = await parts.memo.propertySetFor(SPEC, BUDGET);
  await parts.gate.calibrate({ problemId: PROBLEM_ID, limits: LIMITS, propertySet: set });
  return { kind, set };
}

async function serveAll(draw: Draw, parts: Composition): Promise<readonly Served[]> {
  if (draw.dispatch === 'concurrent') {
    return Promise.all(draw.order.map((kind) => serve(kind, parts)));
  }
  const served: Served[] = [];
  for (const kind of draw.order) {
    served.push(await serve(kind, parts));
  }
  return served;
}

/** Caller orders holding at least one of each side, which is the composition that ships. */
function arbOrder(): fc.Arbitrary<readonly CallerKind[]> {
  return fc
    .array(fc.constantFrom<CallerKind>('gate', 'loop'), { minLength: 2, maxLength: 4 })
    .filter((order) => order.includes('gate') && order.includes('loop'));
}

function arbDraw(): fc.Arbitrary<Draw> {
  return fc.record({
    order: arbOrder(),
    dispatch: fc.constantFrom<Dispatch>('sequential', 'concurrent'),
    propertyCount: fc.integer({ min: 1, max: 3 }),
    ticks: fc.integer({ min: 0, max: 3 }),
    outcome: fc.constantFrom(...INTACT_OUTCOMES),
  });
}

describe(PROPERTY, () => {
  it('authors once across generated caller orders and counts, and the gate scores that object', async () => {
    const dispatchSeen = new Set<Dispatch>();
    const firstCallerSeen = new Set<CallerKind>();
    let overlappedCallers = 0;

    await fc.assert(
      fc.asyncProperty(arbDraw(), async (draw) => {
        const parts = compose(draw);

        const served = await serveAll(draw, parts);

        // ONE model call for one sample, however many callers asked and in whatever order. The
        // gate ran inside this, so the gate added none of its own (Req 6.7).
        expect(parts.author.calls).toBe(1);
        const authored = parts.memo.authored();
        expect(authored).not.toBeNull();

        for (const entry of served) {
          if (entry.kind === 'gate') {
            // The harness's caller holds the authored object itself.
            expect(entry.set).toBe(authored);
          } else {
            // The stamping decorator rebuilds the WRAPPER to carry the gate's outcome, so what
            // has to be identical is the array the loop will reason over.
            expect(entry.set.properties).toBe(authored?.properties);
          }
        }

        // The gate submitted the authored array itself and no copy of it. One submission per
        // gate caller, so a gate that authored a set of its own would show up here too.
        const gateCallers = draw.order.filter((kind) => kind === 'gate').length;
        expect(parts.submissions).toHaveLength(gateCallers);
        for (const submission of parts.submissions) {
          expect(submission.properties).toBe(authored?.properties);
        }

        dispatchSeen.add(draw.dispatch);
        firstCallerSeen.add(draw.order[0] ?? 'gate');
        if (draw.dispatch === 'concurrent') {
          overlappedCallers = Math.max(overlappedCallers, draw.order.length);
        }
      }),
      propertyParameters({ numRuns: 100 }),
    );

    // Non-vacuity: both dispatch modes ran, both sides led at least once, and at least one
    // concurrent run had more than one caller in flight. Without that last row the memo would
    // only ever have been asked the easy, sequential question.
    expect([...dispatchSeen].sort()).toEqual(['concurrent', 'sequential']);
    expect([...firstCallerSeen].sort()).toEqual(['gate', 'loop']);
    expect(overlappedCallers).toBeGreaterThan(1);
  });

  it('a second authoring call yields an EQUAL set that is not the same object', async () => {
    // The negative control for the assertions above: this is what the composition looks like
    // without the memo, and it is why identity is the assertion and equality is not. Every
    // `toBe` above fails against this author; every `toEqual` would pass.
    const author = new CountingAuthor(() => authoredSet(2), 1);

    const first = await author.propertySetFor();
    const second = await author.propertySetFor();

    expect(author.calls).toBe(2);
    expect(second).toEqual(first);
    expect(second).not.toBe(first);
    expect(second.properties).not.toBe(first.properties);
  });

  it('holds the outcomes that leave a set intact, which today is every one but refused', () => {
    // Documents today's answer without the property above depending on the member names, and
    // fails loudly if the vocabulary moves under it.
    expect([...INTACT_OUTCOMES].sort()).toEqual(['admitted', 'no-gate-set', 'not-gated']);
  });
});
