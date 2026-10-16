// Unit tests for the Formal_Oracle adapter's ORCHESTRATION, with no toolchain present.
//
// Scope, deliberately narrow: this file asserts the four things task 6.1 itself delivers and
// nothing a later task owns. (1) The pre-pass runs FIRST, over the candidate DESIGN ALONE, and a
// refusal reports its own cause with NO Property_Wrapper built and NO Proof_Condition evaluated
// (Req 1.18, 14.11, 14.18). (2) A derived contract renders the wrapper, submits it as the `-top`
// beside the UNEDITED design, and runs at the ladder's first rung. (3) The ladder escalates on
// `antecedent-unreached` and on NOTHING else - specifically not on an induction failure
// (Req 4.7, 4.13). (4) The Property_Time_Budget bounds each job's `wallMs` and a spent budget is
// `proof-timeout`, never `proved` and never `refuted` (Req 7.1, 7.2, 7.3, 7.4).
//
// The generated-input forms of the ladder rule (Property 8), containment (Properties 13, 24, 9),
// and the structural claims belong to tasks 6.6, 6.7, and 6.8; the real-toolchain falsifiability
// assertions belong to tasks 6.2 through 6.13. Nothing here stands in for those.
//
// Task 8.7 adds a FIFTH group at the end of the file, for the one thing that task delivers: the
// set-level `proveSet` and the three RUN-level facts the `FormalOutcome` carries back, with the
// per-property `prove` asserted to agree with it over a one-element set (Req 14.27, 14.39).
//
// Task 6.8 adds the groups after that: the BEHAVIOURAL halves of the structural claims, which need
// this file's fixtures. Their source-reading and type-level halves, and the map of where each of
// the eight claims lives, are in `structural-claims.test.ts`.

import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ModuleInterface } from '@app/core';
import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  assembleFormalJob,
  assembleFormalPrepassJob,
  CLOCKED_DEPTH_LADDER,
  COMBINATIONAL_DEPTH,
  DEFAULT_PROPERTY_TIME_BUDGET_MS,
  proofDepthsFor,
  PROPERTY_WRAPPER_FILE_NAME,
  PROPERTY_WRAPPER_MODULE_NAME,
  YosysSmtBmcFormalOracle,
  type CounterexampleCapture,
  type FormalArtifactReader,
  type FormalOraclePort,
  type FormalOutcome,
  type FormalProveRequest,
  type FormalProveSetRequest,
  type FormalResourceCaps,
} from './adapter.js';
import type { PropertyResult } from './conditions.js';
import { refusedWithoutProof } from './interpret.js';
import {
  BoundedArtifactRetention,
  classifyCapture,
  createWorkspaceRoot,
  FakeSandboxRuntime,
  MAX_RETAINED_ARTIFACT_BYTES,
  removeWorkspaceRoot,
  SandboxToolRunner,
  type ArtifactBlobRef,
  type RawRunCapture,
  type ResourceUsage,
  type SandboxJob,
  type SandboxResult,
  type SourceFile,
  type ToolRunner,
} from '../sandbox/index.js';
import {
  validateExpression,
  type FormalProperty,
  type ValidatedExpression,
} from '../verilog/property.js';

const CAPS: FormalResourceCaps = { cpu: 1, memMb: 512, procs: 64, diskMb: 64 };

const RESOURCE_USAGE: ResourceUsage = { wallMs: 5, maxMemMb: 8, cpuMs: 4 };

const DESIGN: SourceFile = {
  path: 'counter_12.v',
  contents: 'module counter_12(input clk, input rst_n, output reg [3:0] out); endmodule',
};

const DESIGN_INTERFACE: ModuleInterface = {
  moduleName: 'counter_12',
  ports: [{ name: 'out', direction: 'output', width: 4 }],
  clocking: { clockName: 'clk', resetName: 'rst_n', resetActiveLow: true },
  validityOutputName: null,
};

/** A combinational interface, for the depth rule's other arm. */
const COMBINATIONAL_INTERFACE: ModuleInterface = {
  moduleName: 'adder_8bit',
  ports: [{ name: 'sum', direction: 'output', width: 8 }],
  clocking: { clockName: null, resetName: null, resetActiveLow: false },
  validityOutputName: null,
};

/** Build a validated expression, failing the test loudly if the dialect refuses it. */
function expression(text: string): ValidatedExpression {
  const validated = validateExpression(text);
  if (!validated.ok) {
    throw new Error(`fixture expression is outside the accepted dialect: ${text}`);
  }
  return validated.value;
}

/** A clocked property WITH an antecedent, so a Cover_Check applies to it. */
const CLOCKED_PROPERTY: FormalProperty = {
  kind: 'clocked',
  id: 'p1',
  criterionRef: 'AC-1',
  clock: expression('clk'),
  antecedent: expression('out == 11'),
  consequent: expression('out <= 11'),
};

/** A SECOND clocked property, so a Property_Set is more than one element. */
const SECOND_PROPERTY: FormalProperty = {
  kind: 'clocked',
  id: 'p2',
  criterionRef: 'AC-2',
  clock: expression('clk'),
  antecedent: expression('out == 11'),
  consequent: expression('out != 13'),
};

const PREPASS_ARTIFACT: ArtifactBlobRef = {
  name: 'formal-prepass-report.json',
  sizeBytes: 128,
  sha256: 'a'.repeat(64),
};

const REPORT_ARTIFACT: ArtifactBlobRef = {
  name: 'formal-report.json',
  sizeBytes: 256,
  sha256: 'b'.repeat(64),
};

/** The pre-pass document for a DERIVED reset on a posedge design with a free initial state. */
const DERIVED_PREPASS = JSON.stringify({
  reset: { derived: true, resetName: 'rst_n', resetActiveLow: true, resetKind: 'async' },
  clockPolarity: 'posedge',
  initialStatePredicate: 'true',
});

/**
 * The pre-pass document for a SYNC reset over a FREE initial state.
 *
 * The ONE combination the `if (!$initstate)` assertion gate is emitted for, which is what makes
 * `assertionGateEmitted` a fact worth recording rather than a constant.
 */
const SYNC_DERIVED_PREPASS = JSON.stringify({
  reset: { derived: true, resetName: 'rst_n', resetActiveLow: true, resetKind: 'sync' },
  clockPolarity: 'posedge',
  initialStatePredicate: 'true',
});

/** The pre-pass document for a REFUSED reset derivation: several nets, or none. */
const REFUSED_PREPASS = JSON.stringify({
  reset: { derived: false },
  clockPolarity: 'posedge',
  initialStatePredicate: 'true',
});

/** One check's reported facts, as the worker writes them. */
interface CheckFixture {
  readonly exitCode: number | null;
  readonly status: string | null;
  readonly elapsedMs: number;
  readonly reachedStep?: number;
  readonly coverAnswered?: boolean;
  readonly inductionSuccessful?: boolean;
}

const PASSED: CheckFixture = { exitCode: 0, status: 'PASSED', elapsedMs: 1 };

/** A `formal-report.json` text with a non-zero assertion count and the four checks. */
function reportText(cover: CheckFixture, induct: CheckFixture): string {
  return JSON.stringify({
    lowering: { exitCode: 0, stderrTail: '' },
    assertionCount: 2,
    checks: { presat: PASSED, base: PASSED, cover, induct },
  });
}

/** A cover that ANSWERED and was NOT reached: the one escalating outcome. */
const COVER_UNREACHED: CheckFixture = {
  exitCode: 0,
  status: 'FAILED',
  elapsedMs: 1,
  coverAnswered: true,
};

/** A cover reached at step 13, which is `counter_12`'s measured honest first-reachable step. */
const COVER_REACHED: CheckFixture = {
  exitCode: 0,
  status: 'PASSED',
  elapsedMs: 1,
  reachedStep: 13,
  coverAnswered: true,
};

/** Temporal induction reported successful: the fifth condition satisfied. */
const INDUCT_SUCCESSFUL: CheckFixture = { ...PASSED, inductionSuccessful: true };

/** Temporal induction reported FAILED over a passing base case: the engine-incomplete case. */
const INDUCT_FAILED: CheckFixture = { exitCode: 1, status: 'FAILED', elapsedMs: 1 };

/**
 * A `SandboxResult` registering one artifact under the key the worker registers it under.
 *
 * `null` registers none, which is what a pre-pass or a lowering that produced no report leaves.
 */
function sandboxResult(
  registered: readonly [key: string, artifact: ArtifactBlobRef] | null,
  overrides: Partial<SandboxResult> = {},
): SandboxResult {
  return {
    verdict: 'pass',
    timedOut: false,
    exitCode: 0,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    diskLimitExceeded: false,
    artifacts: registered === null ? {} : { [registered[0]]: registered[1] },
    deniedOperations: [],
    resourceUsage: RESOURCE_USAGE,
    ...overrides,
  };
}

/** The pre-pass's registered report, as the worker registers it. */
const PREPASS_REGISTERED: readonly [string, ArtifactBlobRef] = [
  'formalPrepassReport',
  PREPASS_ARTIFACT,
];

/** The formal run's registered report. The counterexample trace is opportunistic and absent here. */
const REPORT_REGISTERED: readonly [string, ArtifactBlobRef] = ['formalReport', REPORT_ARTIFACT];

/** A `ToolRunner` that records every submitted job and answers from a fixed script. */
class ScriptedToolRunner implements ToolRunner {
  readonly jobs: SandboxJob[] = [];
  readonly #script: readonly SandboxResult[];

  constructor(script: readonly SandboxResult[]) {
    this.#script = script;
  }

  run(job: SandboxJob): Promise<SandboxResult> {
    this.jobs.push(job);
    const scripted = this.#script[this.jobs.length - 1];
    if (scripted === undefined) {
      throw new Error(`no scripted result for submitted job ${this.jobs.length}`);
    }
    return Promise.resolve(scripted);
  }
}

/** A `FormalArtifactReader` answering from a fixed map of artifact name to text. */
function artifactReader(texts: Readonly<Record<string, string>>): FormalArtifactReader {
  return { readText: (artifact) => Promise.resolve(texts[artifact.name] ?? null) };
}

/** A clock frozen at zero, so a budget is never charged unless a test says otherwise. */
const FROZEN_CLOCK = (): number => 0;

/** The adapter under test, with both ports scripted and the clock injected. */
function oracle(
  runner: ToolRunner,
  reader: FormalArtifactReader,
  now: () => number = FROZEN_CLOCK,
): YosysSmtBmcFormalOracle {
  return new YosysSmtBmcFormalOracle({ toolRunner: runner, artifacts: reader, caps: CAPS, now });
}

/** The default request: one design, one clocked property, the default-shaped budget. */
function request(budgetMs = DEFAULT_PROPERTY_TIME_BUDGET_MS): FormalProveRequest {
  return {
    designSource: DESIGN,
    designInterface: DESIGN_INTERFACE,
    property: CLOCKED_PROPERTY,
    budgetMs,
  };
}

/** The same design, carrying a whole Property_Set under the same per-property budget. */
function setRequest(
  properties: readonly FormalProperty[],
  budgetMs = DEFAULT_PROPERTY_TIME_BUDGET_MS,
): FormalProveSetRequest {
  return { designSource: DESIGN, designInterface: DESIGN_INTERFACE, properties, budgetMs };
}

/** The reported cause, or `null` for a verdict that carries none. */
function causeOf(result: PropertyResult): string | null {
  return result.verdict === 'could-not-verify' ? result.cause : null;
}

/** The sanitized diagnostic a refusal surfaced, or `null` for a verdict that carries none. */
function diagnosticOf(result: PropertyResult): string | null {
  return result.verdict === 'could-not-verify' ? result.diagnostic : null;
}

describe('the depth ladder rule', () => {
  it('is deterministic and reads BOTH the design and the property (Req 4.5)', () => {
    expect(proofDepthsFor(DESIGN_INTERFACE, CLOCKED_PROPERTY)).toEqual(CLOCKED_DEPTH_LADDER);
    expect(proofDepthsFor(DESIGN_INTERFACE, CLOCKED_PROPERTY)).toEqual(
      proofDepthsFor(DESIGN_INTERFACE, CLOCKED_PROPERTY),
    );
  });

  it('takes depth 1 only where BOTH halves say there is no state to step through', () => {
    const combinational: FormalProperty = {
      kind: 'combinational',
      id: 'p2',
      criterionRef: 'AC-2',
      consequent: expression('sum <= 255'),
    };
    expect(proofDepthsFor(COMBINATIONAL_INTERFACE, combinational)).toEqual([COMBINATIONAL_DEPTH]);
    // A combinational PROPERTY over a CLOCKED design still takes the clocked ladder: depth 1 over
    // a design full of flops is an under-depth proof, which is the false-`proved` direction.
    expect(proofDepthsFor(DESIGN_INTERFACE, combinational)).toEqual(CLOCKED_DEPTH_LADDER);
  });
});

describe('job assembly', () => {
  it('submits the design ALONE under its own module name for the pre-pass (Req 14.11)', () => {
    const job = assembleFormalPrepassJob(DESIGN, DESIGN_INTERFACE, { ...CAPS, wallMs: 1000 });
    expect(job.kind).toBe('formalPrepass');
    expect(job.workspaceFiles).toEqual([DESIGN]);
    expect(job.formalPrepass?.topModule).toBe(DESIGN_INTERFACE.moduleName);
    expect(job.requiredOutputs).toEqual(['formalPrepassReport']);
    expect(job.formal).toBeUndefined();
  });

  it('names the wrapper as `-top` and requires the report but NOT the trace (Req 3.6, 12.19)', () => {
    const wrapper: SourceFile = {
      path: PROPERTY_WRAPPER_FILE_NAME,
      contents: 'module w; endmodule',
    };
    const job = assembleFormalJob(DESIGN, wrapper, 20, { ...CAPS, wallMs: 1000 });
    expect(job.kind).toBe('formal');
    expect(job.formal).toEqual({ topModule: PROPERTY_WRAPPER_MODULE_NAME, depth: 20 });
    expect(job.requiredOutputs).toEqual(['formalReport']);
    expect(job.requiredOutputs).not.toContain('vcd');
    // The design reaches the workspace EQUAL IN VALUE to what we were given (Req 3.5).
    expect(job.workspaceFiles[0]).toEqual(DESIGN);
    expect(job.formalPrepass).toBeUndefined();
  });
});

describe('the pre-pass runs first, and a refusal builds no wrapper', () => {
  it('reports `reset-contract-unresolved` after ONE job and evaluates no condition (Req 1.18)', async () => {
    const runner = new ScriptedToolRunner([sandboxResult(PREPASS_REGISTERED)]);
    const reader = artifactReader({ [PREPASS_ARTIFACT.name]: REFUSED_PREPASS });

    const result = await oracle(runner, reader).prove(request());

    // ONE job, and it is the pre-pass: nothing was rendered and no proof was attempted.
    expect(runner.jobs.map((job) => job.kind)).toEqual(['formalPrepass']);
    expect(causeOf(result)).toBe('reset-contract-unresolved');
    expect(result.depth).toBe(0);
    expect(result.verdict === 'could-not-verify' && result.conditions).toEqual({
      assertionCount: 0,
      presat: 'not-run',
      cover: { reached: false },
      base: 'not-run',
      induction: 'not-run',
    });
  });

  it('reports `toolchain-unavailable` when no pre-pass report was registered (Req 14.26)', async () => {
    const runner = new ScriptedToolRunner([sandboxResult(null, { verdict: 'error' })]);

    const result = await oracle(runner, artifactReader({})).prove(request());

    expect(runner.jobs).toHaveLength(1);
    expect(causeOf(result)).toBe('toolchain-unavailable');
  });
});

describe('a frontend rejection in the pre-pass is the DESIGN`s, and everything else is ours', () => {
  // The pre-pass reaches `read_verilog` and `prep` BEFORE the Lowering_Sequence does (Req 14.11), so
  // a design Yosys refuses fails here and writes no report. These cases pin the discriminator in
  // BOTH directions, because the discriminator is the only thing keeping our own instrument's
  // failures off the candidate design (Req 8.10, 8.11, 8.12, 8.13).
  //
  // Every fixture carries `verdict: 'error'` and registers NO report, which is what the seam
  // actually produces for this class: `formalPrepassReport` is a required output of the
  // `formalPrepass` job, so its absence forces the whole invocation to `error`.

  /** MEASURED, Yosys 0.66 over `verified_float_multi.v`: on STDERR, with a relative filename. */
  const FLOAT_MULTI_STDERR = 'design.v:17: ERROR: Found non-synthesizable event list!';

  /** MEASURED, over `verified_synchronizer.v`: on STDERR, and naming NO FILE AT ALL. */
  const SYNCHRONIZER_STDERR = 'ERROR: Multiple edge sensitive events found for this signal!';

  /** One pre-pass invocation that registered no report, with its raw facts as the worker reports. */
  function prepassRun(overrides: Partial<SandboxResult>): SandboxResult {
    return sandboxResult(null, { verdict: 'error', ...overrides });
  }

  /** Drive `prove` over a single scripted pre-pass run, with no report readable anywhere. */
  async function proveOverPrepass(
    run: SandboxResult,
  ): Promise<{ result: PropertyResult; jobs: readonly SandboxJob[] }> {
    const runner = new ScriptedToolRunner([run]);
    const result = await oracle(runner, artifactReader({})).prove(request());
    return { result, jobs: runner.jobs };
  }

  it('attributes a non-zero exit carrying a Yosys `ERROR:` to the design (Req 8.10, 8.12)', async () => {
    const { result, jobs } = await proveOverPrepass(
      prepassRun({ exitCode: 1, stderr: FLOAT_MULTI_STDERR }),
    );

    expect(causeOf(result)).toBe('frontend-rejected');
    // The diagnostic is surfaced, sanitized by `./interpret.js` and by nothing here.
    expect(diagnosticOf(result)).toContain('Found non-synthesizable event list!');
    // ONE job, and no wrapper was rendered: there is nothing to render a contract from.
    expect(jobs.map((job) => job.kind)).toEqual(['formalPrepass']);
    expect(result.depth).toBe(0);
  });

  it('attributes a diagnostic naming NO submitted file at all (Req 8.13)', async () => {
    // THE LOAD-BEARING CASE. `verified_synchronizer`'s measured diagnostic carries no filename, so
    // reusing `./interpret.js`'s `attributeLoweringFailure` here would return `property-build-failed`
    // and blame a Property_Wrapper that does not exist yet. Attribution is by the JOB'S CONTENTS:
    // this job holds the candidate design alone, so the error is the design's by construction.
    const { result } = await proveOverPrepass(
      prepassRun({ exitCode: 1, stderr: SYNCHRONIZER_STDERR }),
    );

    expect(causeOf(result)).toBe('frontend-rejected');
    expect(causeOf(result)).not.toBe('property-build-failed');
    expect(diagnosticOf(result)).toContain('Multiple edge sensitive events found');
  });

  it('attributes an `ERROR:` printed on STDOUT, because both streams are scanned', async () => {
    const { result } = await proveOverPrepass(
      prepassRun({ exitCode: 1, stdout: FLOAT_MULTI_STDERR }),
    );

    expect(causeOf(result)).toBe('frontend-rejected');
  });

  it('reports `toolchain-unavailable` for a non-zero exit with NO `ERROR:` anywhere (Req 8.11)', async () => {
    // The discriminator's negative direction, and the whole content of Req 8.11. A `write_smt2`
    // failure, a crash, and an absent binary all exit non-zero and every one of them is OURS.
    const { result } = await proveOverPrepass(
      prepassRun({
        exitCode: 127,
        stderr: 'yosys: command not found',
        stdout: 'Warning: no problems found',
      }),
    );

    expect(causeOf(result)).toBe('toolchain-unavailable');
    expect(causeOf(result)).not.toBe('frontend-rejected');
  });

  it('never attributes a `null` exit code, even carrying an `ERROR:` line (Req 8.11)', async () => {
    // `SandboxResult.exitCode` is `null` on a wall-clock kill, and `null !== 0` is `true`, so a
    // discriminator written as `exitCode !== 0` would attribute a killed run to the design on its
    // partial output. A run we killed tells us nothing about the design.
    const { result } = await proveOverPrepass(
      prepassRun({ exitCode: null, stderr: FLOAT_MULTI_STDERR }),
    );

    expect(causeOf(result)).toBe('toolchain-unavailable');
    expect(causeOf(result)).not.toBe('frontend-rejected');
  });

  it('reports `proof-timeout` for a KILLED pre-pass ahead of any attribution (Req 7.2)', async () => {
    // `timedOut` is checked BEFORE the frontend predicate, so this fixture carries a non-zero exit
    // AND an `ERROR:` line: both would satisfy the attribution, and the kill still wins. That is
    // what makes this an ordering assertion rather than a restatement of the case above.
    const { result } = await proveOverPrepass(
      prepassRun({ timedOut: true, exitCode: 1, stderr: FLOAT_MULTI_STDERR }),
    );

    expect(causeOf(result)).toBe('proof-timeout');
    expect(causeOf(result)).not.toBe('frontend-rejected');
  });

  it('reports `toolchain-unavailable` for a SUCCEEDED pre-pass whose report fails schema validation', async () => {
    // The existing behaviour, unregressed: exit 0 and no `ERROR:`, so the frontend branch does not
    // fire and the refusal comes from the report parse exactly as it did before (Req 14.26).
    const runner = new ScriptedToolRunner([sandboxResult(PREPASS_REGISTERED)]);
    const reader = artifactReader({
      [PREPASS_ARTIFACT.name]: JSON.stringify({ clockPolarity: 'sometimes' }),
    });

    const result = await oracle(runner, reader).prove(request());

    expect(runner.jobs.map((job) => job.kind)).toEqual(['formalPrepass']);
    expect(causeOf(result)).toBe('toolchain-unavailable');
  });
});

describe('the proof attempt', () => {
  it('submits the rendered wrapper at the ladder first rung, bounded by the budget', async () => {
    const runner = new ScriptedToolRunner([
      sandboxResult(PREPASS_REGISTERED),
      sandboxResult(REPORT_REGISTERED),
    ]);
    const reader = artifactReader({
      [PREPASS_ARTIFACT.name]: DERIVED_PREPASS,
      [REPORT_ARTIFACT.name]: reportText(COVER_REACHED, INDUCT_SUCCESSFUL),
    });

    const result = await oracle(runner, reader).prove(request(40_000));

    expect(runner.jobs.map((job) => job.kind)).toEqual(['formalPrepass', 'formal']);
    const proof = runner.jobs[1];
    expect(proof?.formal?.depth).toBe(CLOCKED_DEPTH_LADDER[0]);
    // The wrapper is a second workspace file carrying the derived reset assume, and the design's
    // own file is untouched.
    expect(proof?.workspaceFiles[0]).toEqual(DESIGN);
    expect(proof?.workspaceFiles[1]?.path).toBe(PROPERTY_WRAPPER_FILE_NAME);
    expect(proof?.workspaceFiles[1]?.contents).toContain(
      `module ${PROPERTY_WRAPPER_MODULE_NAME} (`,
    );
    expect(proof?.workspaceFiles[1]?.contents).toContain('assume property');
    // Every job's `wallMs` is the remaining budget, so the sandbox is the only thing timing it.
    for (const job of runner.jobs) {
      expect(job.limits).toEqual({ ...CAPS, wallMs: 40_000 });
    }
    expect(result.verdict).toBe('proved');
  });
});

describe('escalation happens on one cause and on no other', () => {
  it('climbs every rung on `antecedent-unreached` and reports it at the top (Req 4.7)', async () => {
    const runner = new ScriptedToolRunner([
      sandboxResult(PREPASS_REGISTERED),
      sandboxResult(REPORT_REGISTERED),
      sandboxResult(REPORT_REGISTERED),
      sandboxResult(REPORT_REGISTERED),
    ]);
    const reader = artifactReader({
      [PREPASS_ARTIFACT.name]: DERIVED_PREPASS,
      [REPORT_ARTIFACT.name]: reportText(COVER_UNREACHED, INDUCT_SUCCESSFUL),
    });

    const result = await oracle(runner, reader).prove(request());

    expect(
      runner.jobs.filter((job) => job.kind === 'formal').map((job) => job.formal?.depth),
    ).toEqual([...CLOCKED_DEPTH_LADDER]);
    expect(causeOf(result)).toBe('antecedent-unreached');
    expect(result.depth).toBe(CLOCKED_DEPTH_LADDER.at(-1));
  });

  it('does NOT escalate on an induction failure over a passing base case (Req 4.13)', async () => {
    const runner = new ScriptedToolRunner([
      sandboxResult(PREPASS_REGISTERED),
      sandboxResult(REPORT_REGISTERED),
    ]);
    const reader = artifactReader({
      [PREPASS_ARTIFACT.name]: DERIVED_PREPASS,
      [REPORT_ARTIFACT.name]: reportText(COVER_REACHED, INDUCT_FAILED),
    });

    const result = await oracle(runner, reader).prove(request());

    expect(runner.jobs.filter((job) => job.kind === 'formal')).toHaveLength(1);
    expect(causeOf(result)).toBe('induction-engine-incomplete');
  });
});

describe('the Property_Time_Budget', () => {
  it('reports `proof-timeout` with no job submitted when it is already spent (Req 7.2)', async () => {
    const runner = new ScriptedToolRunner([]);

    const result = await oracle(runner, artifactReader({})).prove(request(0));

    expect(runner.jobs).toHaveLength(0);
    expect(causeOf(result)).toBe('proof-timeout');
    expect(result.verdict).not.toBe('proved');
    expect(result.verdict).not.toBe('refuted');
  });

  it('is charged against the measured clock, so a rung that overran ends the ladder', async () => {
    const runner = new ScriptedToolRunner([
      sandboxResult(PREPASS_REGISTERED),
      sandboxResult(REPORT_REGISTERED),
    ]);
    const reader = artifactReader({
      [PREPASS_ARTIFACT.name]: DERIVED_PREPASS,
      [REPORT_ARTIFACT.name]: reportText(COVER_UNREACHED, INDUCT_SUCCESSFUL),
    });
    // The clock advances 100ms on every read, so the 500ms budget is exhausted once the first
    // proof attempt has been charged. The first rung escalated, and the second is still never
    // entered - which is the whole point: the budget bounds the ladder, not the other way round.
    let ticks = 0;
    const now = (): number => {
      ticks += 100;
      return ticks;
    };

    const result = await oracle(runner, reader, now).prove(request(500));

    expect(runner.jobs.filter((job) => job.kind === 'formal')).toHaveLength(1);
    expect(causeOf(result)).toBe('proof-timeout');
    // The deepest depth attempted is carried, rather than being reset to zero.
    expect(result.depth).toBe(CLOCKED_DEPTH_LADDER[0]);
  });
});

describe('a retention failure cannot produce a `proved`', () => {
  // The join between the `FormalArtifactReader` port and the store that implements it. Task 6.1
  // named `null` the fail-safe answer; these two cases are what makes that a measured fact rather
  // than a claim in a comment, and they are written as a CONTROLLED PAIR: identical scripted runs
  // over identical bytes, differing in ONE thing - whether the report's bytes were retained before
  // the workspace went away. If `null` could ever reach a `proved`, the pair separates.
  //
  // The real `BoundedArtifactRetention` over a real workspace rather than a `null`-returning
  // double, because the claim is about the thing that will actually be wired in.

  /** A report that satisfies all five conditions: the only shape that could yield `proved`. */
  const PROVED_REPORT = reportText(COVER_REACHED, INDUCT_SUCCESSFUL);

  /** The ref the worker would register for a file of this content at this name. */
  function refFor(name: string, contents: string): ArtifactBlobRef {
    return {
      name,
      sizeBytes: Buffer.byteLength(contents, 'utf8'),
      sha256: createHash('sha256').update(contents, 'utf8').digest('hex'),
    };
  }

  /**
   * Run one proof over a real workspace holding both documents, retaining the report or not.
   *
   * The retention call stands in for the runtime's own step, which runs after the worker finishes
   * and before the workspace is removed. `retainReportBytes` is the ONE variable of the pair: both
   * runs submit the same two jobs, register the same two refs, and read the same two files.
   */
  async function proveWithRetention(retainReportBytes: boolean): Promise<PropertyResult> {
    const workspaceRoot = await createWorkspaceRoot();
    try {
      await writeFile(join(workspaceRoot, 'formal-prepass-report.json'), DERIVED_PREPASS, 'utf8');
      await writeFile(join(workspaceRoot, 'formal-report.json'), PROVED_REPORT, 'utf8');
      const prepassRef = refFor('formal-prepass-report.json', DERIVED_PREPASS);
      const reportRef = refFor('formal-report.json', PROVED_REPORT);

      const retention = new BoundedArtifactRetention();
      await retention.retain(
        workspaceRoot,
        retainReportBytes
          ? { formalPrepassReport: prepassRef, formalReport: reportRef }
          : { formalPrepassReport: prepassRef },
      );
      const runner = new ScriptedToolRunner([
        sandboxResult(['formalPrepassReport', prepassRef]),
        sandboxResult(['formalReport', reportRef]),
      ]);
      return await oracle(runner, retention).prove(request());
    } finally {
      await removeWorkspaceRoot(workspaceRoot);
    }
  }

  it('reports `could-not-verify` when the report bytes were NOT retained', async () => {
    const result = await proveWithRetention(false);

    expect(result.verdict).toBe('could-not-verify');
    expect(result.verdict).not.toBe('proved');
    expect(result.verdict).not.toBe('refuted');
    // Through the owner of "we have no evidence", which is the same line an absent artifact and an
    // unparseable one already travel (Req 11.8, 11.13).
    expect(causeOf(result)).toBe('toolchain-unavailable');
  });

  it('reports `proved` for the SAME run once those bytes are retained', async () => {
    // The positive control. Without it the refusal above would pass for a fixture that could never
    // have proved anything, and the pair would measure nothing.
    const result = await proveWithRetention(true);

    expect(result.verdict).toBe('proved');
  });
});
describe('`proveSet` returns the run-level Formal_Outcome (task 8.7; Req 14.27, 14.39)', () => {
  it('derives the contract ONCE for the set and reports it beside one result per property', async () => {
    const runner = new ScriptedToolRunner([
      sandboxResult(PREPASS_REGISTERED),
      sandboxResult(REPORT_REGISTERED),
      sandboxResult(REPORT_REGISTERED),
    ]);
    const reader = artifactReader({
      [PREPASS_ARTIFACT.name]: SYNC_DERIVED_PREPASS,
      [REPORT_ARTIFACT.name]: reportText(COVER_REACHED, INDUCT_SUCCESSFUL),
    });

    const outcome = await oracle(runner, reader).proveSet(
      setRequest([CLOCKED_PROPERTY, SECOND_PROPERTY]),
    );

    // ONE pre-pass for TWO properties. The per-property port holds no cache, so before this method
    // existed the identical contract was derived and discarded once per property.
    expect(runner.jobs.map((job) => job.kind)).toEqual(['formalPrepass', 'formal', 'formal']);
    // One result per SUBMITTED property, in submission order (Req 1.11).
    expect(outcome.results.map((result) => result.criterionRef)).toEqual(['AC-1', 'AC-2']);
    expect(outcome.results.map((result) => result.verdict)).toEqual(['proved', 'proved']);
    // The three run-level facts, read off the pre-pass rather than left at a no-reading value.
    expect(outcome.resetContract).toEqual({
      derived: true,
      resetName: 'rst_n',
      resetActiveLow: true,
      resetKind: 'sync',
      initialStateFree: true,
    });
    expect(outcome.clockPolarity).toBe('posedge');
    // The RECORDED gate fact agrees with the EMITTED text, which is the whole reason the renderer
    // owns the rule: a record that disagrees with the wrapper explains the wrong run.
    expect(outcome.assertionGateEmitted).toBe(true);
    const formalJobs = runner.jobs.filter((submitted) => submitted.kind === 'formal');
    for (const job of formalJobs) {
      expect(job.workspaceFiles[1]?.contents).toContain('if (!$initstate)');
    }
    // The wrapper sources handed back ARE the submitted text, one per property in submission
    // order - so no second render can disagree with what the solver ran on (Req 12.23). The two
    // properties render differently, so a constant or a swapped pairing fails here.
    expect(outcome.propertyWrapperSources).toEqual(
      formalJobs.map((job) => job.workspaceFiles[1]?.contents),
    );
    expect(new Set(outcome.propertyWrapperSources).size).toBe(2);
  });

  it('reports the gate UNEMITTED under an ASYNC contract, so the fact is not a constant', async () => {
    // The control for the assertion above. An async reset's assume pins step 0 in the same step, so
    // no gate is emitted and the recorded fact must follow the wrapper rather than the contract's
    // mere presence.
    const runner = new ScriptedToolRunner([
      sandboxResult(PREPASS_REGISTERED),
      sandboxResult(REPORT_REGISTERED),
    ]);
    const reader = artifactReader({
      [PREPASS_ARTIFACT.name]: DERIVED_PREPASS,
      [REPORT_ARTIFACT.name]: reportText(COVER_REACHED, INDUCT_SUCCESSFUL),
    });

    const outcome = await oracle(runner, reader).proveSet(setRequest([CLOCKED_PROPERTY]));

    expect(outcome.assertionGateEmitted).toBe(false);
    expect(runner.jobs[1]?.workspaceFiles[1]?.contents).not.toContain('if (!$initstate)');
    // The assume is still emitted: it and the gate are not substitutes (Req 14.6).
    expect(runner.jobs[1]?.workspaceFiles[1]?.contents).toContain('assume property');
  });

  it('records a pre-pass REFUSAL as the refused arm and the polarity it read (Req 14.20)', async () => {
    const runner = new ScriptedToolRunner([sandboxResult(PREPASS_REGISTERED)]);
    const reader = artifactReader({ [PREPASS_ARTIFACT.name]: REFUSED_PREPASS });
    // 100ms per clock read, so the one pre-pass's elapsed time is measurable rather than zero.
    let ticks = 0;
    const now = (): number => {
      ticks += 100;
      return ticks;
    };

    const outcome = await oracle(runner, reader, now).proveSet(
      setRequest([CLOCKED_PROPERTY, SECOND_PROPERTY]),
    );

    expect(runner.jobs.map((job) => job.kind)).toEqual(['formalPrepass']);
    expect(outcome.results.map(causeOf)).toEqual([
      'reset-contract-unresolved',
      'reset-contract-unresolved',
    ]);
    // NOT `null`: the pre-pass RAN and REFUSED, which is a reading rather than its absence, and
    // collapsing the two is what left criteria 14.27 and 14.39 unsatisfiable.
    expect(outcome.resetContract).toEqual({ derived: false });
    expect(outcome.clockPolarity).toBe('posedge');
    // No Property_Wrapper was built, so no gate was emitted into one - and no source is recorded,
    // one `null` per property so the index pairing with `results` still holds.
    expect(outcome.assertionGateEmitted).toBe(false);
    expect(outcome.propertyWrapperSources).toEqual([null, null]);
    // The ONE pre-pass's elapsed time is recorded ONCE. Two copies of it would charge the
    // Session_Budget twice for one invocation, because the loop charges each result's own time.
    expect(outcome.results.map((result) => result.elapsedMs)).toEqual([200, 0]);
  });

  it('records NEITHER reading where no pre-pass report could be read (Req 14.26)', async () => {
    const runner = new ScriptedToolRunner([sandboxResult(null, { verdict: 'error' })]);

    const outcome = await oracle(runner, artifactReader({})).proveSet(
      setRequest([CLOCKED_PROPERTY]),
    );

    expect(outcome.results.map(causeOf)).toEqual(['toolchain-unavailable']);
    // `null` on BOTH, and this is the one case it is for: nothing was established, so there is no
    // refused derivation to report either.
    expect(outcome.resetContract).toBeNull();
    expect(outcome.clockPolarity).toBeNull();
    // And no wrapper was rendered for the one property, which is a `null` entry, not no entry.
    expect(outcome.propertyWrapperSources).toEqual([null]);
  });

  it('takes no reading for an EMPTY set, and submits no job to take one with', async () => {
    const runner = new ScriptedToolRunner([]);

    const outcome = await oracle(runner, artifactReader({})).proveSet(setRequest([]));

    expect(runner.jobs).toHaveLength(0);
    expect(outcome).toEqual({
      results: [],
      propertyWrapperSources: [],
      counterexampleCaptures: [],
      resetContract: null,
      assertionGateEmitted: false,
      clockPolarity: null,
    });
  });

  it('agrees with `prove` over a one-element set, in the jobs submitted and the verdict', async () => {
    // The drift check. `prove` IS `proveSet` over a one-element set, so the two cannot disagree -
    // and a verdict that depends on which method a caller reached for is what that shape forbids.
    const script: readonly SandboxResult[] = [
      sandboxResult(PREPASS_REGISTERED),
      sandboxResult(REPORT_REGISTERED),
    ];
    const texts = {
      [PREPASS_ARTIFACT.name]: SYNC_DERIVED_PREPASS,
      [REPORT_ARTIFACT.name]: reportText(COVER_REACHED, INDUCT_SUCCESSFUL),
    };
    const perProperty = new ScriptedToolRunner([...script]);
    const perSet = new ScriptedToolRunner([...script]);

    const single = await oracle(perProperty, artifactReader(texts)).prove(request());
    const outcome = await oracle(perSet, artifactReader(texts)).proveSet(
      setRequest([CLOCKED_PROPERTY]),
    );

    expect(outcome.results).toEqual([single]);
    expect(perSet.jobs).toEqual(perProperty.jobs);
  });
});

// -- Task 6.8: the behavioural halves of the structural claims ------------------------------------

/** A raw worker capture for one completed run: exit 0, empty streams, and what it registered. */
function rawCapture(artifacts: Readonly<Record<string, ArtifactBlobRef>>): RawRunCapture {
  return {
    timedOut: false,
    infraFailure: false,
    exitCode: 0,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    diskLimitExceeded: false,
    artifacts,
    deniedOperations: [],
    resourceUsage: RESOURCE_USAGE,
  };
}

/** A `ToolRunner` relaying every job to another, keeping each job and the result it got back. */
class RelayingToolRunner implements ToolRunner {
  readonly jobs: SandboxJob[] = [];
  readonly results: SandboxResult[] = [];
  readonly #inner: ToolRunner;

  constructor(inner: ToolRunner) {
    this.#inner = inner;
  }

  async run(job: SandboxJob): Promise<SandboxResult> {
    this.jobs.push(job);
    const result = await this.#inner.run(job);
    this.results.push(result);
    return result;
  }
}

/** A `ToolRunner` answering every job of one kind alike: one answer per pre-pass, one per proof. */
function byKind(prepass: SandboxResult, proof: SandboxResult): ToolRunner {
  return { run: (job) => Promise.resolve(job.kind === 'formalPrepass' ? prepass : proof) };
}

/** A `formal-report.json` text carrying exactly `checks`, over a non-zero assertion count. */
function reportWithChecks(checks: Readonly<Record<string, CheckFixture>>): string {
  return JSON.stringify({ lowering: { exitCode: 0, stderrTail: '' }, assertionCount: 2, checks });
}

/** The four checks of a report satisfying all five conditions: the one shape `proved` comes from. */
const PROVING_CHECKS: Readonly<Record<string, CheckFixture>> = {
  presat: PASSED,
  base: PASSED,
  cover: COVER_REACHED,
  induct: INDUCT_SUCCESSFUL,
};

describe('the trace is opportunistic and both reports are required (task 6.8; Req 12.18, 12.19)', () => {
  // 'job assembly' above pins the two ASSEMBLERS, and `test_formal_lowering.py` pins the worker's
  // own registration. Added here: the jobs the adapter actually SUBMITS, and what the real seam's
  // capture-all-or-error classification makes of each, which is where the asymmetry bites.

  it('requires its own report on EVERY submitted job, and the trace on none', async () => {
    const runner = new ScriptedToolRunner([
      sandboxResult(PREPASS_REGISTERED),
      ...Array.from({ length: 6 }, () => sandboxResult(REPORT_REGISTERED)),
    ]);
    const reader = artifactReader({
      [PREPASS_ARTIFACT.name]: DERIVED_PREPASS,
      [REPORT_ARTIFACT.name]: reportText(COVER_UNREACHED, INDUCT_SUCCESSFUL),
    });

    await oracle(runner, reader).proveSet(setRequest([CLOCKED_PROPERTY, SECOND_PROPERTY]));

    // One pre-pass, then every rung of BOTH properties' ladders, because each cover came back
    // unreached: seven submitted jobs, each requiring its own report and nothing else.
    expect(runner.jobs.map((job) => [job.kind, job.requiredOutputs])).toEqual([
      ['formalPrepass', ['formalPrepassReport']],
      ...Array.from({ length: 6 }, () => ['formal', ['formalReport']]),
    ]);
  });

  it('classifies a proof that wrote no trace `pass` at the real seam, which a required trace would not', async () => {
    const proofCapture = rawCapture({ formalReport: REPORT_ARTIFACT });
    const relay = new RelayingToolRunner(
      new SandboxToolRunner(
        new FakeSandboxRuntime((job) =>
          job.kind === 'formalPrepass'
            ? rawCapture({ formalPrepassReport: PREPASS_ARTIFACT })
            : proofCapture,
        ),
      ),
    );
    const reader = artifactReader({
      [PREPASS_ARTIFACT.name]: DERIVED_PREPASS,
      [REPORT_ARTIFACT.name]: reportText(COVER_REACHED, INDUCT_SUCCESSFUL),
    });

    const result = await oracle(relay, reader).prove(request());

    // The proof registered its report and no trace, and the seam classified it on its own merits.
    expect(relay.results.map((relayed) => relayed.verdict)).toEqual(['pass', 'pass']);
    expect(result.verdict).toBe('proved');
    // WHY THE TRACE MUST STAY OPPORTUNISTIC: the same capture against the same job, with the trace
    // made required, is the whole invocation `error` - and so would every proof be.
    const [, proofJob] = relay.jobs;
    if (proofJob === undefined) {
      throw new Error('the proof attempt was never submitted');
    }
    const requiringTheTrace: SandboxJob = {
      ...proofJob,
      requiredOutputs: [...proofJob.requiredOutputs, 'vcd'],
    };
    expect(classifyCapture(requiringTheTrace, proofCapture).verdict).toBe('error');
  });

  it('classifies a pre-pass that registered no report `error` at the same seam', async () => {
    // The other side of the asymmetry: the pre-pass's whole output IS its report, so a run that
    // produced none must be refused by the seam rather than handed back as an empty success.
    const relay = new RelayingToolRunner(
      new SandboxToolRunner(new FakeSandboxRuntime(rawCapture({}))),
    );

    const result = await oracle(relay, artifactReader({})).prove(request());

    expect(relay.results.map((relayed) => relayed.verdict)).toEqual(['error']);
    expect(causeOf(result)).toBe('toolchain-unavailable');
  });
});

describe('a fifth check and an uninvocable solver end the run on our instrument (task 6.8; Req 14.8, 11.15)', () => {
  /** One proof attempt over a report carrying exactly `checks`, keeping every submitted job. */
  async function proveOver(
    checks: Readonly<Record<string, CheckFixture>>,
    proofRun: SandboxResult = sandboxResult(REPORT_REGISTERED),
  ): Promise<{ result: PropertyResult; jobs: readonly SandboxJob[] }> {
    const runner = new ScriptedToolRunner([sandboxResult(PREPASS_REGISTERED), proofRun]);
    const reader = artifactReader({
      [PREPASS_ARTIFACT.name]: DERIVED_PREPASS,
      [REPORT_ARTIFACT.name]: reportWithChecks(checks),
    });
    const result = await oracle(runner, reader).prove(request());
    return { result, jobs: runner.jobs };
  }

  it('refuses a report carrying a FIFTH, step-0 check rather than reading it (Req 14.8)', async () => {
    // A CONTROLLED PAIR: the same four proving checks, without and with a fifth. The worker runs no
    // step-0 check (`test_every_outcome_path_issues_the_same_four_main_checks_and_no_step_0_check`);
    // this is what the gate does if one ever arrives. The schema closes `checks`, so the whole
    // document is refused and the fifth check is never read as evidence in either direction.
    const fourChecks = await proveOver(PROVING_CHECKS);
    const fiveChecks = await proveOver({ ...PROVING_CHECKS, step0: PASSED });

    expect(fourChecks.result.verdict).toBe('proved');
    expect(causeOf(fiveChecks.result)).toBe('toolchain-unavailable');
  });

  it('ends a present-but-not-invocable run after ONE formal job, re-running nothing (Req 11.15)', async () => {
    // The report the worker writes for the unshimmed bitwuzla 0.9.x path, pinned on that side by
    // `test_a_present_but_not_invocable_solver_is_never_rerun_under_z3`: every check exited 1 having
    // printed no `Status:` line, so none was audited and none carries a status.
    const notInvocable: CheckFixture = { exitCode: 1, status: null, elapsedMs: 1 };

    const { result, jobs } = await proveOver(
      {
        presat: notInvocable,
        base: notInvocable,
        cover: { ...notInvocable, coverAnswered: false },
        induct: { ...notInvocable, inductionSuccessful: false },
      },
      sandboxResult(REPORT_REGISTERED, { verdict: 'fail', exitCode: 1 }),
    );

    expect(causeOf(result)).toBe('toolchain-unavailable');
    // ONE proof attempt and no second: not an escalation, and not a re-run under another solver,
    // which this side cannot ask for - the payload is these two fields, the seam refuses a third
    // (`sandbox.test.ts`), and no formal module names a solver (`structural-claims.test.ts`).
    expect(jobs.map((job) => job.kind)).toEqual(['formalPrepass', 'formal']);
    expect(jobs[1]?.formal).toEqual({
      topModule: PROPERTY_WRAPPER_MODULE_NAME,
      depth: CLOCKED_DEPTH_LADDER[0],
    });
  });
});

describe('no predicate over the design routes it out of the formal gate (task 6.8; Req 7.15, 7.16)', () => {
  // The structural half - the loop's route and the adapter's reads off the design - is in
  // `structural-claims.test.ts`. This is the behavioural half: designs that differ in name, file,
  // ports, and arithmetic class, answered identically by the toolchain, take ONE route, and every
  // one of them ATTEMPTS the proof. The clocking is held fixed, because Req 4.5 makes the depth
  // rule read it, and that rule picks a depth and never a way out of the gate.

  /** A design under test: its source, and the interface its Spec declares. */
  interface RoutedDesign {
    readonly source: SourceFile;
    readonly designInterface: ModuleInterface;
  }

  /** What one design did: every submitted job's kind and depth, then the answer it got. */
  interface Route {
    readonly jobs: readonly (readonly [string, number | null])[];
    readonly verdict: string;
    readonly cause: string | null;
  }

  /** One toolchain answer, given to every design alike, and the route it must produce. */
  interface ToolchainAnswer {
    readonly name: string;
    readonly proofRun: SandboxResult;
    readonly report: string | null;
    readonly route: Route;
  }

  const DESIGNS: readonly RoutedDesign[] = [
    { source: DESIGN, designInterface: DESIGN_INTERFACE },
    {
      // Named after the corpus multiplier that TIMED OUT past 900s, and carrying its arithmetic.
      source: {
        path: 'multi_16bit.v',
        contents:
          'module multi_16bit(input clk, input rst_n, input [15:0] a, input [15:0] b,\n' +
          '  output reg [31:0] out);\n  always @(posedge clk) out <= a * b;\nendmodule\n',
      },
      designInterface: {
        moduleName: 'multi_16bit',
        ports: [
          { name: 'a', direction: 'input', width: 16 },
          { name: 'b', direction: 'input', width: 16 },
          { name: 'out', direction: 'output', width: 32 },
        ],
        clocking: DESIGN_INTERFACE.clocking,
        validityOutputName: null,
      },
    },
    {
      // A name no corpus holds, which is what a student's design is.
      source: {
        path: 'my_first_design.v',
        contents:
          'module my_first_design(input clk, input rst_n, input en, output reg [3:0] out);\n' +
          "  always @(posedge clk) if (en) out <= out + 4'd1;\nendmodule\n",
      },
      designInterface: {
        moduleName: 'my_first_design',
        ports: [
          { name: 'en', direction: 'input', width: 1 },
          { name: 'out', direction: 'output', width: 4 },
        ],
        clocking: DESIGN_INTERFACE.clocking,
        validityOutputName: null,
      },
    },
  ];

  const FIRST_RUNG = CLOCKED_DEPTH_LADDER[0] ?? null;

  const ANSWERS: readonly ToolchainAnswer[] = [
    {
      name: 'a proof',
      proofRun: sandboxResult(REPORT_REGISTERED),
      report: reportText(COVER_REACHED, INDUCT_SUCCESSFUL),
      route: {
        jobs: [
          ['formalPrepass', null],
          ['formal', FIRST_RUNG],
        ],
        verdict: 'proved',
        cause: null,
      },
    },
    {
      // Req 7.16's one route out for the multiplier class: the budget, spent inside the sandbox.
      name: 'a run the budget killed',
      proofRun: sandboxResult(null, { verdict: 'error', timedOut: true, exitCode: null }),
      report: null,
      route: {
        jobs: [
          ['formalPrepass', null],
          ['formal', FIRST_RUNG],
        ],
        verdict: 'could-not-verify',
        cause: 'proof-timeout',
      },
    },
    {
      name: 'an unreached antecedent',
      proofRun: sandboxResult(REPORT_REGISTERED),
      report: reportText(COVER_UNREACHED, INDUCT_SUCCESSFUL),
      route: {
        jobs: [
          ['formalPrepass', null],
          ...CLOCKED_DEPTH_LADDER.map((depth) => ['formal', depth] as const),
        ],
        verdict: 'could-not-verify',
        cause: 'antecedent-unreached',
      },
    },
  ];

  /** The route one design takes when the toolchain gives `answer`. */
  async function routeOf(design: RoutedDesign, answer: ToolchainAnswer): Promise<Route> {
    const relay = new RelayingToolRunner(
      byKind(sandboxResult(PREPASS_REGISTERED), answer.proofRun),
    );
    const reader = artifactReader(
      answer.report === null
        ? { [PREPASS_ARTIFACT.name]: DERIVED_PREPASS }
        : { [PREPASS_ARTIFACT.name]: DERIVED_PREPASS, [REPORT_ARTIFACT.name]: answer.report },
    );
    const result = await oracle(relay, reader).prove({
      designSource: design.source,
      designInterface: design.designInterface,
      property: CLOCKED_PROPERTY,
      budgetMs: DEFAULT_PROPERTY_TIME_BUDGET_MS,
    });
    return {
      jobs: relay.jobs.map((job) => [job.kind, job.formal?.depth ?? null] as const),
      verdict: result.verdict,
      cause: causeOf(result),
    };
  }

  it.each(ANSWERS)(
    'routes every design alike on $name, and attempts the proof for each',
    async (answer) => {
      const routes = await Promise.all(DESIGNS.map((design) => routeOf(design, answer)));

      expect(routes).toEqual(DESIGNS.map(() => answer.route));
    },
  );
});

describe('a test double satisfies `FormalOraclePort` (task 6.8; Req 11.12)', () => {
  /**
   * The smallest double the port admits, with no toolchain behind it: a scripted verdict per
   * property, a wrapper source per result, and `prove` implemented AS `proveSet` over a one-element
   * set, which is the relation the port says every implementation owes.
   */
  class ScriptedFormalOracle implements FormalOraclePort {
    readonly #verdictFor: (property: FormalProperty) => PropertyResult;

    constructor(verdictFor: (property: FormalProperty) => PropertyResult) {
      this.#verdictFor = verdictFor;
    }

    proveSet(request: FormalProveSetRequest): Promise<FormalOutcome> {
      return Promise.resolve({
        results: request.properties.map((property) => this.#verdictFor(property)),
        propertyWrapperSources: request.properties.map(
          (property) => `module ${PROPERTY_WRAPPER_MODULE_NAME}; // ${property.id}\nendmodule\n`,
        ),
        // The double reads no artifact store, so it carries no trace for any property.
        counterexampleCaptures: request.properties.map(() => null),
        resetContract: null,
        assertionGateEmitted: false,
        clockPolarity: null,
      });
    }

    async prove(request: FormalProveRequest): Promise<PropertyResult> {
      const outcome = await this.proveSet({
        designSource: request.designSource,
        designInterface: request.designInterface,
        properties: [request.property],
        budgetMs: request.budgetMs,
      });
      return outcome.results[0] ?? this.#verdictFor(request.property);
    }
  }

  /**
   * What the port obliges EVERY implementation to, asserted against one: a result per submitted
   * property in submission order, a wrapper source paired with each by index, and `prove` agreeing
   * with `proveSet` over a one-element set.
   */
  async function expectThePortContract(port: FormalOraclePort): Promise<void> {
    const outcome = await port.proveSet(setRequest([CLOCKED_PROPERTY, SECOND_PROPERTY]));
    expect(outcome.results.map((result) => result.criterionRef)).toEqual(['AC-1', 'AC-2']);
    expect(outcome.propertyWrapperSources).toHaveLength(outcome.results.length);

    const single = await port.prove(request());
    const asASet = await port.proveSet(setRequest([CLOCKED_PROPERTY]));
    expect(asASet.results).toEqual([single]);
  }

  it('stands in for the adapter wherever the port is taken, with no toolchain present', async () => {
    // COMPILE-TIME, evaluated by `tsc -b` and not by vitest: the double IS a port, and the port
    // REQUIRES the wrapper sources task 12.4 added, so a double written against the older outcome
    // shape fails the build instead of handing the loop an outcome with no wrappers in it.
    expectTypeOf<ScriptedFormalOracle>().toExtend<FormalOraclePort>();
    expectTypeOf<Omit<FormalOutcome, 'propertyWrapperSources'>>().not.toExtend<FormalOutcome>();
    expectTypeOf<FormalOutcome['propertyWrapperSources']>().toEqualTypeOf<
      readonly (string | null)[]
    >();

    const timedOut = (property: FormalProperty): PropertyResult =>
      refusedWithoutProof('proof-timeout', property, { depth: 0, elapsedMs: 0 }, '');
    // The double meets the contract, and so does the real adapter it stands in for, so a gate test
    // run over the double exercises the interface the gate is actually wired to.
    await expectThePortContract(new ScriptedFormalOracle(timedOut));
    await expectThePortContract(
      oracle(
        byKind(sandboxResult(PREPASS_REGISTERED), sandboxResult(REPORT_REGISTERED)),
        artifactReader({
          [PREPASS_ARTIFACT.name]: DERIVED_PREPASS,
          [REPORT_ARTIFACT.name]: reportText(COVER_REACHED, INDUCT_SUCCESSFUL),
        }),
      ),
    );
  });
});

// ----------------------------------------------------------------------------------------------
// Task 24.1: the Counterexample trace, read where its OWN run ended (Req 12.16, 12.24)
// ----------------------------------------------------------------------------------------------
//
// THE LOAD-BEARING CLAIM IS THE ONE THAT CANNOT BE SEEN FROM A SINGLE CASE: the read is total, and
// no way it can fail touches the Formal_Verdict. So the fourth test below is a CONTROLLED SET -
// four reader behaviours over byte-identical runs, where the capture varies and the verdict does
// not - rather than four independent assertions, because a mutation that let a failed read refuse
// the refutation would still pass every per-case assertion written on its own.

/** The Counterexample trace text, shaped like the VCD `--dump-vcd` leaves behind. */
const TRACE = '$timescale 1ns $end\n$var wire 1 ! clk $end\n$enddefinitions $end\n#0\n0!\n';

/** The trace's registered reference. Its `sizeBytes` is the DECLARED size the adapter reads. */
const TRACE_ARTIFACT: ArtifactBlobRef = {
  name: 'counterexample.vcd',
  sizeBytes: TRACE.length,
  sha256: 'c'.repeat(64),
};

/** A Base_Check that FAILED: the one check whose failure is a refutation (Req 1.10). */
const BASE_FAILED: CheckFixture = { exitCode: 1, status: 'FAILED', elapsedMs: 1 };

/**
 * The four checks of a report that REFUTES: the three conditions ahead of the Base_Check hold, and
 * the Base_Check fails - which is the only shape `refuted` comes from.
 */
const REFUTING_CHECKS: Readonly<Record<string, CheckFixture>> = {
  presat: PASSED,
  base: BASE_FAILED,
  cover: COVER_REACHED,
  induct: INDUCT_FAILED,
};

/** A proof run that refuted: its REQUIRED report, and the trace registered opportunistically. */
function refutingRun(trace: ArtifactBlobRef): SandboxResult {
  return sandboxResult(null, { artifacts: { formalReport: REPORT_ARTIFACT, vcd: trace } });
}

/** How the injected retention port answers when asked for the trace specifically. */
type TraceAnswer = () => Promise<string | null>;

/** A reader answering both reports from fixtures and the trace from `answer`, recording each ask. */
function readerAnswering(
  answer: TraceAnswer,
  trace: ArtifactBlobRef,
  log: string[] = [],
): FormalArtifactReader {
  const texts: Readonly<Record<string, string>> = {
    [PREPASS_ARTIFACT.name]: DERIVED_PREPASS,
    [REPORT_ARTIFACT.name]: reportWithChecks(REFUTING_CHECKS),
  };
  return {
    readText: (artifact) => {
      log.push(`read:${artifact.name}`);
      return artifact.name === trace.name
        ? answer()
        : Promise.resolve(texts[artifact.name] ?? null);
    },
  };
}

/** One refuting run over `properties`, with the trace reader scripted and every ask recorded. */
function refuted(
  answer: TraceAnswer,
  options: {
    readonly trace?: ArtifactBlobRef;
    readonly properties?: readonly FormalProperty[];
  } = {},
): { readonly outcome: Promise<FormalOutcome>; readonly log: string[] } {
  const trace = options.trace ?? TRACE_ARTIFACT;
  const log: string[] = [];
  const runner: ToolRunner = {
    run: (job) => {
      log.push(`job:${job.kind}`);
      return Promise.resolve(
        job.kind === 'formalPrepass' ? sandboxResult(PREPASS_REGISTERED) : refutingRun(trace),
      );
    },
  };
  const request = setRequest(options.properties ?? [CLOCKED_PROPERTY]);
  return { outcome: oracle(runner, readerAnswering(answer, trace, log)).proveSet(request), log };
}

/** The capture a refusal produces, which always names the reference it is about. */
function refusedCapture(
  refusal: 'over-cap' | 'unresolved' | 'read-failed',
  reference: ArtifactBlobRef = TRACE_ARTIFACT,
): CounterexampleCapture {
  return { kind: 'refused', reference, refusal };
}

describe('a refuted result carries its trace, read at its OWN run (task 24.1; Req 12.16, 12.24)', () => {
  it('carries the WHOLE trace, paired BY INDEX with the result it belongs to', async () => {
    const { outcome } = refuted(() => Promise.resolve(TRACE));
    const resolved = await outcome;

    const result = resolved.results[0];
    expect(result?.verdict).toBe('refuted');
    // One entry per result, like `propertyWrapperSources`, so an index means the same thing in both.
    expect(resolved.counterexampleCaptures).toHaveLength(resolved.results.length);
    expect(resolved.counterexampleCaptures[0]).toEqual({
      kind: 'trace',
      reference: TRACE_ARTIFACT,
      trace: TRACE,
    });
    // The REFERENCE stays on the result and the BYTES do not, so a `PropertyResult` is still a
    // record whose size its field count bounds (Req 12.24).
    expect(result?.verdict === 'refuted' ? result.counterexample : null).toEqual(TRACE_ARTIFACT);
    expect(Object.keys(result ?? {})).not.toContain('trace');
  });

  it('reads the trace DURING its own run, before the next property is submitted', async () => {
    // THE WHOLE POINT OF THE TASK, and the only assertion here that a late read would fail: the
    // store is a 1 MiB FIFO every run on a shared runtime keeps filling, so a read deferred even
    // to the next property is already a race. Each trace read sits between its own proof job and
    // the following one.
    const { outcome, log } = refuted(() => Promise.resolve(TRACE), {
      properties: [CLOCKED_PROPERTY, SECOND_PROPERTY],
    });
    const resolved = await outcome;

    expect(resolved.results.map((result) => result.verdict)).toEqual(['refuted', 'refuted']);
    expect(log).toEqual([
      'job:formalPrepass',
      `read:${PREPASS_ARTIFACT.name}`,
      'job:formal',
      `read:${REPORT_ARTIFACT.name}`,
      `read:${TRACE_ARTIFACT.name}`,
      'job:formal',
      `read:${REPORT_ARTIFACT.name}`,
      `read:${TRACE_ARTIFACT.name}`,
    ]);
  });

  it('refuses a trace the store could not hold WITHOUT asking for its bytes', async () => {
    // The DECLARED size decides, and it decides FIRST, which is what makes `over-cap` reachable:
    // the store refuses the same cap, so asking would answer `null` and name the wrong reason.
    const oversized: ArtifactBlobRef = {
      ...TRACE_ARTIFACT,
      sizeBytes: MAX_RETAINED_ARTIFACT_BYTES + 1,
    };
    const { outcome, log } = refuted(
      () => Promise.reject(new Error('the reader must not be asked')),
      { trace: oversized },
    );
    const resolved = await outcome;

    expect(resolved.results[0]?.verdict).toBe('refuted');
    expect(resolved.counterexampleCaptures[0]).toEqual(refusedCapture('over-cap', oversized));
    expect(log).not.toContain(`read:${oversized.name}`);
  });

  it('is TOTAL over every reader behaviour, and NO behaviour changes the verdict', async () => {
    // A CONTROLLED SET over byte-identical runs: the capture is the only thing that moves. The
    // refutation was decided by the Base_Check and the trace is its EVIDENCE, so a read that fails
    // is a gap in our ability to hand the evidence over and never a finding about the design.
    const pastTheCap = 'x'.repeat(MAX_RETAINED_ARTIFACT_BYTES + 1);
    const cases: readonly {
      readonly name: string;
      readonly answer: TraceAnswer;
      readonly capture: CounterexampleCapture;
    }[] = [
      {
        name: 'the whole trace',
        answer: () => Promise.resolve(TRACE),
        capture: { kind: 'trace', reference: TRACE_ARTIFACT, trace: TRACE },
      },
      {
        name: 'a port that THROWS, whose error could name the store internals',
        answer: () => Promise.reject(new Error('/Users/someone/.store/blob: EACCES')),
        capture: refusedCapture('read-failed'),
      },
      {
        name: 'a reference the store no longer holds, or whose hash it refused',
        answer: () => Promise.resolve(null),
        capture: refusedCapture('unresolved'),
      },
      {
        name: 'bytes past the cap, though the reference declared fewer',
        answer: () => Promise.resolve(pastTheCap),
        capture: refusedCapture('over-cap'),
      },
    ];

    for (const scripted of cases) {
      const { outcome } = refuted(scripted.answer);
      // Never rejects, whatever the port did: a thrown adapter takes the Verification_Loop down.
      const resolved = await outcome;

      expect(resolved.results[0]?.verdict, scripted.name).toBe('refuted');
      expect(resolved.counterexampleCaptures[0], scripted.name).toEqual(scripted.capture);
    }
    // The verdict was `refuted` on all four, and the captures were four DIFFERENT values, so the
    // invariance above is asserted over a set that actually separates.
    expect(new Set(cases.map((scripted) => JSON.stringify(scripted.capture))).size).toBe(4);
  });

  it('carries `null` for a result that is not `refuted`, which is a proof`s ordinary shape', async () => {
    const outcome = await oracle(
      byKind(sandboxResult(PREPASS_REGISTERED), sandboxResult(REPORT_REGISTERED)),
      artifactReader({
        [PREPASS_ARTIFACT.name]: DERIVED_PREPASS,
        [REPORT_ARTIFACT.name]: reportWithChecks(PROVING_CHECKS),
      }),
    ).proveSet(setRequest([CLOCKED_PROPERTY]));

    expect(outcome.results[0]?.verdict).toBe('proved');
    expect(outcome.counterexampleCaptures).toEqual([null]);
  });
});
