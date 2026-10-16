// Unit tests for the production `PropertySetGate`.
//
// WHAT THESE PIN DOWN
//   1. `null` means THE GATE COULD NOT RUN, and it is not widened. A problem with no reference
//      design returns `null` (the harness records `'not-gated'`); a problem whose mutants are
//      all invalid returns an EMPTY POPULATION, which `admitPropertySet` reports as
//      `'no-gate-set'`. Collapsing the two would lose the one distinction the four-member
//      admission vocabulary exists for.
//   2. Every record carries a mutant IDENTITY and no Verilog (Req 6.8). `Mutant extends
//      MutantIdentity`, so an adapter that handed the full mutant through would type-check and
//      put the mutated reference RTL on a refusal. The assertion is on the KEY SET and on the
//      serialized refusal, because a type pin cannot see what rides on the object.
//   3. The fold matches the Verification_Loop's own precedence - a refutation decides, else a
//      refusal, else a proof - and agrees with `formalCalibrationOf`, which owns the
//      verdict-to-calibration mapping one layer up.
//   4. An EMPTY Property_Set submits nothing, so every mutant is excluded with a named cause
//      rather than quietly proved.
//
// Driven through fakes on the two tool ports only: the REAL mutation generator, the REAL
// calibrator, and the REAL admission rule. No toolchain, no disk, no model.
import { describe, expect, it } from 'vitest';

import type { ModuleInterface, Port, PortDirection } from '@app/core';
import { makePort } from '@app/core';
import {
  admitProved,
  type ArtifactBlobRef,
  type FormalOraclePort,
  type FormalOutcome,
  type FormalProperty,
  type FormalProveSetRequest,
  type FormalVerdict,
  type ProofConditions,
  type PropertyResult,
  type ResourceLimits,
  type SourceFile,
  type ValidatedExpression,
  validateExpression,
} from '@app/tools';

import type { GoldenTestbench, ReferenceDesign } from './corpus/corpus-types.js';
import type { GoldenScore, GoldenTestbenchScorer } from './corpus/golden-scorer.js';
import { RtllmMutationCalibrator } from './corpus/mutation-calibration.js';
import { generateMutants } from './corpus/verilog-mutation.js';
import {
  DEFAULT_MUTATION_CONFIG,
  type MutantCalibration,
  type MutationConfig,
} from './mutation-control.js';
import {
  admitPropertySet,
  formalCalibrationOf,
  type CalibratedFormalMutant,
  type PropertySetGateRequest,
} from './property-set-admission.js';
import { RtllmPropertySetGate } from './property-set-gate-rtllm.js';

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

/** A validated expression, failing the test loudly if the dialect refuses it. */
function expression(text: string): ValidatedExpression {
  const validated = validateExpression(text);
  if (!validated.ok) {
    throw new Error(`fixture expression is outside the accepted dialect: ${text}`);
  }
  return validated.value;
}

/** The one property every scored set below holds; the fakes never read it. */
const PROPERTY: FormalProperty = {
  kind: 'clocked',
  id: 'p1',
  criterionRef: 'AC-1',
  clock: expression('clk'),
  antecedent: null,
  consequent: expression('q <= 255'),
};

const PROVED_CONDITIONS: ProofConditions = {
  assertionCount: 2,
  presat: 'satisfiable',
  cover: { reached: 'not-applicable' },
  base: 'passed',
  induction: 'successful',
};

const COUNTEREXAMPLE: ArtifactBlobRef = {
  name: 'counterexample.vcd',
  sizeBytes: 24,
  sha256: 'c'.repeat(64),
};

/**
 * One `PropertyResult` of the given verdict, with `proved` built through `admitProved`.
 *
 * `ProvedEvidence`'s assertion count is BRANDED and `admitProved` is its sole constructor, so a
 * fixture cannot spell a proof the five-condition gate did not admit.
 */
function propertyResult(verdict: FormalVerdict): PropertyResult {
  if (verdict === 'refuted') {
    return {
      verdict,
      counterexample: COUNTEREXAMPLE,
      conditions: { ...PROVED_CONDITIONS, base: 'failed' },
      depth: 20,
      elapsedMs: 10,
      criterionRef: PROPERTY.criterionRef,
    };
  }
  if (verdict === 'could-not-verify') {
    return {
      verdict,
      cause: 'induction-inconclusive',
      conditions: { ...PROVED_CONDITIONS, induction: 'inconclusive' },
      depth: 20,
      elapsedMs: 10,
      criterionRef: PROPERTY.criterionRef,
      diagnostic: null,
      crossCheckDisagreed: false,
    };
  }
  const evidence = admitProved(PROVED_CONDITIONS);
  if (typeof evidence === 'string') {
    throw new Error(`fixture conditions were refused by the gate: ${evidence}`);
  }
  return { verdict, evidence, depth: 20, elapsedMs: 10, criterionRef: PROPERTY.criterionRef };
}

/** What the fakes answer for one mutant: the judge's evidence and the oracle's verdict. */
interface MutantScript {
  readonly golden: MutantCalibration;
  readonly formal: FormalVerdict;
}

/** The score the judge's port returns for a calibration: the raw evidence, never the calibration. */
interface GoldenEvidence {
  readonly kind: GoldenScore['verdict']['kind'];
  readonly timedOut: boolean;
  readonly diagnostics: string;
}

/** The raw golden evidence that makes the REAL calibrator reach each calibration. */
const GOLDEN_EVIDENCE_OF: Readonly<Record<MutantCalibration, GoldenEvidence>> = {
  'golden-killed': { kind: 'failed', timedOut: false, diagnostics: '' },
  'golden-timeout': { kind: 'error', timedOut: true, diagnostics: '' },
  'golden-survived': { kind: 'passed', timedOut: false, diagnostics: '' },
  'non-compiling': {
    kind: 'error',
    timedOut: false,
    diagnostics: `${MODULE_NAME}.v:4: syntax error`,
  },
  'golden-errored': { kind: 'error', timedOut: false, diagnostics: '' },
};

/** A golden score carrying one calibration's evidence. */
function goldenScoreOf(calibration: MutantCalibration): GoldenScore {
  const evidence = GOLDEN_EVIDENCE_OF[calibration];
  return {
    problemId: PROBLEM_ID,
    verdict: {
      kind: evidence.kind,
      failureCount: evidence.kind === 'failed' ? 1 : null,
      banners: [],
    },
    timedOut: evidence.timedOut,
    diskLimitExceeded: false,
    exitCode: 0,
    diagnostics: evidence.diagnostics,
  };
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

/** The gate under test, plus the formal submissions the fake oracle saw. */
interface GateRun {
  readonly gate: RtllmPropertySetGate;
  readonly submissions: readonly FormalProveSetRequest[];
}

/**
 * The gate over `scripts`: mutant `i` is answered by script `i`.
 *
 * Both fakes answer by the mutant's RTL TEXT rather than by call order, because the formal side
 * runs only the VALID mutants and an index would drift the moment one is filtered out.
 */
function gateFor(
  scripts: readonly MutantScript[],
  parts: {
    readonly references?: ReadonlyMap<string, ReferenceDesign>;
    readonly interfaces?: ReadonlyMap<string, ModuleInterface>;
  } = {},
): GateRun {
  const config: MutationConfig = {
    maxMutantsPerProblem: scripts.length,
    operators: DEFAULT_MUTATION_CONFIG.operators,
  };
  const mutants = generateMutants(REFERENCE_RTL, config);
  expect(mutants).toHaveLength(scripts.length);
  const scriptByRtl = new Map(
    mutants.flatMap((generated, index) => {
      const script = scripts[index];
      return script === undefined ? [] : [[generated.rtl, script] as const];
    }),
  );
  const scriptFor = (rtl: string): MutantScript => {
    const script = scriptByRtl.get(rtl);
    if (script === undefined) {
      throw new Error('a fake was handed RTL that no fixture mutant carries');
    }
    return script;
  };
  const scorer: GoldenTestbenchScorer = {
    score: (rtl: SourceFile) => Promise.resolve(goldenScoreOf(scriptFor(rtl.contents).golden)),
  };
  const submissions: FormalProveSetRequest[] = [];
  const oracle: FormalOraclePort = {
    prove: () =>
      Promise.reject(new Error('the gate must submit the whole set, never one property')),
    proveSet: (request: FormalProveSetRequest): Promise<FormalOutcome> => {
      submissions.push(request);
      const results =
        request.properties.length === 0
          ? []
          : [propertyResult(scriptFor(request.designSource.contents).formal)];
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
  return {
    submissions,
    gate: new RtllmPropertySetGate({
      oracle,
      calibrator: new RtllmMutationCalibrator({
        scorer,
        golden: new Map([[PROBLEM_ID, goldenTestbench()]]),
        references: parts.references ?? new Map([[PROBLEM_ID, reference()]]),
        config,
        mutantWallMs: MUTANT_WALL_MS,
        cacheKey: {
          corpusCommit: 'commit1',
          mutationConfigHash: 'hash1',
          mutantWallMs: MUTANT_WALL_MS,
        },
      }),
      interfaces: parts.interfaces ?? new Map([[PROBLEM_ID, MODULE_INTERFACE]]),
    }),
  };
}

/** One gate request over the controlled problem. */
function gateRequest(properties: readonly FormalProperty[] = [PROPERTY]): PropertySetGateRequest {
  return {
    problemId: PROBLEM_ID,
    limits: LIMITS,
    propertySet: { properties, unexpressedCriteria: [], propertySetAdmitted: 'not-gated' },
  };
}

/** The population, failing the test loudly where the gate reported it could not run. */
async function populationOf(run: GateRun): Promise<readonly CalibratedFormalMutant[]> {
  const population = await run.gate.calibrate(gateRequest());
  if (population === null) {
    throw new Error('the gate reported it could not run, but this fixture can');
  }
  return population;
}

describe('RtllmPropertySetGate - `null` is "could not run" and is never widened', () => {
  it('returns null for a problem with NO reference design', async () => {
    const run = gateFor([{ golden: 'golden-killed', formal: 'proved' }], {
      references: new Map(),
    });

    expect(await run.gate.calibrate(gateRequest())).toBeNull();
    // Nothing was submitted: there was no mutant to submit a Property_Set against.
    expect(run.submissions).toHaveLength(0);
  });

  it('returns null for a problem with no declared module interface', async () => {
    const run = gateFor([{ golden: 'golden-killed', formal: 'proved' }], {
      interfaces: new Map(),
    });

    expect(await run.gate.calibrate(gateRequest())).toBeNull();
    expect(run.submissions).toHaveLength(0);
  });

  it('returns an EMPTY population - not null - when no mutant compiled, which reads as no-gate-set', async () => {
    const run = gateFor([
      { golden: 'non-compiling', formal: 'proved' },
      { golden: 'non-compiling', formal: 'proved' },
    ]);

    const population = await run.gate.calibrate(gateRequest());

    expect(population).toEqual([]);
    expect(run.submissions).toHaveLength(0);
    expect(admitPropertySet(population ?? [])).toEqual({ kind: 'no-gate-set' });
  });
});

describe('RtllmPropertySetGate - identities, never mutants (Req 6.8)', () => {
  it('carries a mutant identity and NO Verilog on every record and on the refusal', async () => {
    const run = gateFor([
      { golden: 'golden-killed', formal: 'proved' },
      { golden: 'golden-killed', formal: 'refuted' },
    ]);

    const population = await populationOf(run);

    expect(population).toHaveLength(2);
    for (const record of population) {
      // The key set, not the type: `Mutant extends MutantIdentity`, so a gate that handed the
      // full mutant through would type-check and carry `rtl` here.
      expect(Object.keys(record.identity).sort()).toEqual(['mutantId', 'operator', 'site']);
    }
    const admission = admitPropertySet(population);
    expect(admission.kind).toBe('refused');
    expect(JSON.stringify(admission)).not.toContain('module');
    expect(JSON.stringify(admission)).not.toContain('posedge');
  });

  it('submits the mutated RTL to the oracle while keeping it off the population', async () => {
    const run = gateFor([{ golden: 'golden-killed', formal: 'proved' }]);

    const population = await populationOf(run);

    // The mutant's RTL reaches the oracle - the gate would measure nothing otherwise - under
    // the path derived from the TRUSTED interface, and travels no further.
    expect(run.submissions).toHaveLength(1);
    expect(run.submissions[0]?.designSource.path).toBe(`${MODULE_NAME}.v`);
    expect(run.submissions[0]?.designSource.contents).toContain('module counter');
    expect(JSON.stringify(population)).not.toContain('module counter');
  });
});

describe('RtllmPropertySetGate - what each verdict calibrates to', () => {
  it('agrees with formalCalibrationOf on every Formal_Verdict, and carries the cause', async () => {
    const run = gateFor([
      { golden: 'golden-killed', formal: 'refuted' },
      { golden: 'golden-killed', formal: 'proved' },
      { golden: 'golden-killed', formal: 'could-not-verify' },
    ]);

    const population = await populationOf(run);

    expect(population.map((record) => record.formal)).toEqual([
      formalCalibrationOf('refuted'),
      formalCalibrationOf('proved'),
      formalCalibrationOf('could-not-verify'),
    ]);
    // Req 9.5: every excluded mutant names which refusal it was.
    const excluded = population[2];
    expect(excluded?.formal === 'formal-could-not-verify' ? excluded.cause : null).toBe(
      'induction-inconclusive',
    );
  });

  it('carries the INDEPENDENT judge verdict through unchanged, so the gate set is an intersection', async () => {
    const run = gateFor([
      { golden: 'golden-killed', formal: 'proved' },
      { golden: 'golden-survived', formal: 'proved' },
      { golden: 'golden-timeout', formal: 'proved' },
    ]);

    const population = await populationOf(run);

    expect(population.map((record) => record.golden)).toEqual([
      'golden-killed',
      'golden-survived',
      'golden-timeout',
    ]);
    // Only the two judge-KILLED mutants are mutants this Property_Set is held to, so the
    // judge-passed one does not appear among the survivors.
    const admission = admitPropertySet(population);
    expect(admission.kind === 'refused' ? admission.survivors.length : null).toBe(2);
  });

  it('excludes every mutant with a named cause when the Property_Set is EMPTY', async () => {
    const run = gateFor([{ golden: 'golden-killed', formal: 'proved' }]);

    const population = await run.gate.calibrate(gateRequest([]));

    expect(population).toEqual([
      {
        identity: population?.[0]?.identity,
        golden: 'golden-killed',
        formal: 'formal-could-not-verify',
        cause: 'zero-assertions',
      },
    ]);
    // Excluded rather than proved: an empty set is never held to have missed anything.
    expect(admitPropertySet(population ?? [])).toEqual({ kind: 'no-gate-set' });
  });
});
