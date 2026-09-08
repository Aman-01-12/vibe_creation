// Eval_Harness integration test (task 19.4; Req 15.1, 15.2, 15.6, 15.10).
//
// This drives the fixed VerilogEval/RTLLM subset through the WHOLE
// Verification_Loop inside the Tool_Runner sandbox, under the SAME student-session
// caps a real student gets, and asserts what the eval gate depends on:
//
//   - pass@k, iterations-to-pass, and per-session cost are reported per problem,
//     with each pass/fail decided by the Simulator oracle, never model output
//     (Req 15.1, 15.2, 15.3);
//   - every sample runs under the student-session budget caps and the run stays
//     within the pennies-per-session cost envelope (Req 15.6);
//   - two runs of the same subset and reproducibility config produce byte-identical
//     reports: identical pass@k, iterations, and cost (Req 15.10 / Property 10).
//
// WHAT THIS EXERCISES END TO END
//   A production-style `EvalLoopRunner` adapter (`EvalVerificationLoopRunner`,
//   below) is the composition the harness drives. For each sample it constructs a
//   real `VerificationLoop` wired to the real generation gate, the real oracle
//   Trust_Labeler, and a fresh Action_Recorder, then calls `verify`. The loop opens
//   the gate, runs generation and the independent (RTL-isolated) testbench, and
//   iterates generate -> simulate -> repair under one Session_Budget until the
//   oracle passes or the budget is exhausted. The harness measures the oracle-
//   decided outcome and the budget it consumed.
//
// SEED THREADING (the reproducibility mechanism, Req 15.10)
//   In production the per-sample seed and fixed temperature reach the model
//   provider through the Model_Router, so the same seed draws the same candidate.
//   No real provider is available here, so the adapter models that exactly: the
//   seed deterministically selects the candidate the "model" would have produced
//   at temperature 0. This is the same substitution the settled real-oracle harness
//   makes for the toolchain - only the non-deterministic vendor edge is stood in
//   for; everything downstream (the loop, the oracle, the metrics) is real. The
//   test independently re-derives the expected outcomes from the PUBLIC `sampleSeed`
//   plus the documented candidate policy, so the assertions pin down that the seed
//   truly threads through generation and that the oracle decides each verdict.
//
// REAL ORACLE vs FAKE ORACLE (mirrors the 3.8 / 14.2 / 15.8 precedent)
//   The real Icarus toolchain (`iverilog` + `vvp`) is absent in most environments,
//   so the real-oracle suite is gated behind the shared `PROBE` and SKIPS cleanly
//   via `describe.skipIf(!PROBE.available)`, surfacing `PROBE.reason` on skip. The
//   SAME reproducibility / pass@k / cost assertions are ALSO driven through a
//   deterministic `FakeSandboxRuntime`-backed Simulator so the test is non-vacuous
//   (never a no-op) in a toolchain-less environment. The fake never fabricates a
//   verdict independent of the artifact: it derives pass/fail from the candidate
//   RTL it is handed, exactly as the real oracle would, standing in only for the
//   iverilog/vvp toolchain and gVisor isolation. Only the Simulator differs between
//   the two suites; the loop, gate, labeler, recorder, budget, harness, and every
//   assertion are identical.

import { describe, expect, it } from 'vitest';

import {
  newUlid,
  ok,
  oracleTrustLabeler,
  unverified,
  type ArtifactRef,
  type Result,
  type Spec,
  type Testbench,
  type Ulid,
} from '@app/core';
import {
  FakeSandboxRuntime,
  IcarusSimulatorAdapter,
  SandboxToolRunner,
  type RawRunCapture,
  type ResourceLimits,
  type SandboxJob,
  type SimulatorAdapter,
  type SourceFile,
} from '@app/tools';
import {
  GenerationGate,
  InMemoryTracePersistence,
  TraceActionRecorder,
  VerificationLoop,
  intentArtifactLabel,
  type CandidateEval,
  type CandidateFailure,
  type CandidateGenerator,
  type GeneratedCandidate,
  type GenerateTestbenchRequest,
  type GenerationAdmissionRequest,
  type GenerationInput,
  type IndependentTestbenchGenerator,
  type IntentSession,
  type SessionBudgetHandle,
  type SpecApprovalReceipt,
  type SpecApprovalSink,
  type SpecApprovalSinkError,
  type TestbenchGenerationOutcome,
  type VerificationOutcome,
} from '@app/agent';
import {
  FIXED_EVAL_SUBSET,
  createEvalHarness,
  makeReproducibilityConfig,
  sampleSeed,
  type EvalLoopRunner,
  type EvalProblem,
  type EvalRunReport,
  type EvalSampleRequest,
  type ReproducibilityConfig,
  type StudentSessionCaps,
} from '@app/eval';

import { PROBE, realOracleAdapter } from './real-oracle-harness.js';

if (!PROBE.available) {
  console.warn(
    `[eval-harness.integration] Real-oracle eval NOT exercised: ${PROBE.reason}. ` +
      'The fixed subset is still driven through the whole Verification_Loop with the fake ' +
      'Simulator in this environment, so pass@k, iterations-to-pass, cost, and reproducibility ' +
      'are asserted non-vacuously; the real iverilog + vvp eval run is SKIPPED.',
  );
}

// -- Student-session caps, sandbox limits, and reproducibility config --------
//
// These are the SAME caps a real student session runs under (Req 15.6). They are
// generous on tokens/wall-clock/cost but bound iterations so a never-passing sample
// terminates promptly; the cost envelope below is the pennies-per-session ceiling
// every sample must respect (Req 15.6, 17.3).

/** The student-session budget caps threaded unchanged into every eval sample. */
const CAPS: StudentSessionCaps = {
  maxIterations: 12,
  maxTokens: 1_000_000,
  maxWallClockMs: 1_000_000_000,
  maxCostCents: 1_000_000,
};

/** Sandbox resource limits, generous enough for a real local iverilog + vvp run. */
const LIMITS: ResourceLimits = { cpu: 1, memMb: 512, procs: 128, diskMb: 128, wallMs: 30_000 };

/** The pennies-per-session cost envelope every eval session must stay within. */
const COST_ENVELOPE_CENTS = 25;

/** Cents charged per modeled model call (generation, revision, or testbench). */
const MODEL_CALL_CENTS = 1;

/** Per-session cost of an immediate first-try pass: one generation + one testbench. */
const IMMEDIATE_PASS_CENTS = 2 * MODEL_CALL_CENTS;

/** Per-session cost of a pass after one repair: generation + testbench + one revision. */
const REPAIR_PASS_CENTS = 3 * MODEL_CALL_CENTS;

/** Per-test timeout covering many real compile-and-simulate runs across the subset (ms). */
const REAL_TIMEOUT = 600_000;

/** Build the fixed reproducibility config (seed, temperature, sampleCount), or throw. */
function reproducibilityConfig(): ReproducibilityConfig {
  const built = makeReproducibilityConfig({ seed: 20_240_115, temperature: 0, sampleCount: 6 });
  if (!built.ok) {
    throw new Error(`invalid reproducibility config: ${built.error.message}`);
  }
  return built.value;
}

// -- Per-problem real fixtures (RTL variants + spec-derived testbench) -------
//
// Each fixed-subset problem gets a correct RTL, a buggy RTL, and an independent,
// spec-derived testbench that emits the machine-readable `CHECK <name> PASS|FAIL`
// signalling the Simulator adapter parses plus a VCD waveform (a required output),
// so a completed run classifies functionally rather than as a missing-artifact
// error. The correct RTL passes every check; the buggy RTL violates at least one,
// so the oracle verdict is `fail`. The testbenches instantiate the DUT by the
// approved Spec's module name, so the whole subset runs through the real oracle
// unchanged when the toolchain is present.

/** One problem's real RTL variants and its independent, spec-derived testbench. */
interface ProblemFixture {
  /** The approved Spec's module name; also the RTL/testbench workspace file stem. */
  readonly moduleName: string;
  /** Synthesizable RTL that passes every spec-derived check. */
  readonly correctRtl: string;
  /** RTL with a deliberate defect that fails at least one spec-derived check. */
  readonly buggyRtl: string;
  /** The independent testbench source (emits `CHECK <name> PASS|FAIL` and a VCD). */
  readonly testbench: string;
  /** The spec-derived check names the testbench emits, in emission order. */
  readonly checkNames: readonly string[];
}

/** VerilogEval adder8: {cout, sum} = a + b + cin; the bug drops the carry-in. */
const ADDER8_FIXTURE: ProblemFixture = {
  moduleName: 'adder8',
  correctRtl: `module adder8 (
  input  wire [7:0] a,
  input  wire [7:0] b,
  input  wire       cin,
  output wire [7:0] sum,
  output wire       cout
);
  assign {cout, sum} = a + b + cin;
endmodule
`,
  buggyRtl: `module adder8 (
  input  wire [7:0] a,
  input  wire [7:0] b,
  input  wire       cin,
  output wire [7:0] sum,
  output wire       cout
);
  assign {cout, sum} = a + b; // BUG: ignores the carry-in
endmodule
`,
  testbench: `\`timescale 1ns/1ps
module adder8_tb;
  reg  [7:0] a;
  reg  [7:0] b;
  reg        cin;
  wire [7:0] sum;
  wire       cout;
  integer i;
  integer sum_errors;
  integer cout_errors;
  reg  [8:0] expected;

  adder8 dut (.a(a), .b(b), .cin(cin), .sum(sum), .cout(cout));

  initial begin
    $dumpfile("dump.vcd");
    $dumpvars(0, adder8_tb);
    sum_errors  = 0;
    cout_errors = 0;
    for (i = 0; i < 64; i = i + 1) begin
      a   = $random;
      b   = $random;
      cin = $random;
      #1;
      expected = a + b + cin;
      if (sum  !== expected[7:0]) sum_errors  = sum_errors + 1;
      if (cout !== expected[8])   cout_errors = cout_errors + 1;
    end
    if (sum_errors == 0)  $display("CHECK sum_matches PASS");  else $display("CHECK sum_matches FAIL");
    if (cout_errors == 0) $display("CHECK cout_matches PASS"); else $display("CHECK cout_matches FAIL");
    $finish;
  end
endmodule
`,
  checkNames: ['sum_matches', 'cout_matches'],
};

/** RTLLM counter4: synchronous up counter with enable; the bug ignores enable. */
const COUNTER4_FIXTURE: ProblemFixture = {
  moduleName: 'counter4',
  correctRtl: `module counter4 (
  input  wire       clk,
  input  wire       rst_n,
  input  wire       en,
  output reg  [3:0] count
);
  always @(posedge clk) begin
    if (!rst_n)
      count <= 4'd0;
    else if (en)
      count <= count + 4'd1;
  end
endmodule
`,
  buggyRtl: `module counter4 (
  input  wire       clk,
  input  wire       rst_n,
  input  wire       en,
  output reg  [3:0] count
);
  always @(posedge clk) begin
    if (!rst_n)
      count <= 4'd0;
    else
      count <= count + 4'd1; // BUG: increments regardless of enable
  end
endmodule
`,
  testbench: `\`timescale 1ns/1ps
module counter4_tb;
  reg        clk;
  reg        rst_n;
  reg        en;
  wire [3:0] count;

  counter4 dut (.clk(clk), .rst_n(rst_n), .en(en), .count(count));

  initial clk = 1'b0;
  always #5 clk = ~clk;

  initial begin
    $dumpfile("dump.vcd");
    $dumpvars(0, counter4_tb);

    rst_n = 1'b0;
    en    = 1'b1;
    @(posedge clk);
    @(negedge clk);
    if (count === 4'd0) $display("CHECK reset_clears PASS"); else $display("CHECK reset_clears FAIL");

    rst_n = 1'b1;
    en    = 1'b1;
    @(posedge clk); // 0 -> 1
    @(posedge clk); // 1 -> 2
    @(negedge clk);
    if (count === 4'd2) $display("CHECK counts_when_enabled PASS"); else $display("CHECK counts_when_enabled FAIL");

    en = 1'b0;
    @(posedge clk); // enable low: must hold at 2
    @(negedge clk);
    if (count === 4'd2) $display("CHECK holds_when_disabled PASS"); else $display("CHECK holds_when_disabled FAIL");

    $finish;
  end
endmodule
`,
  checkNames: ['reset_clears', 'counts_when_enabled', 'holds_when_disabled'],
};

/** VerilogEval mux2: y = sel ? b : a; the bug swaps the two data inputs. */
const MUX2_FIXTURE: ProblemFixture = {
  moduleName: 'mux2',
  correctRtl: `module mux2 (
  input  wire [7:0] a,
  input  wire [7:0] b,
  input  wire       sel,
  output wire [7:0] y
);
  assign y = sel ? b : a;
endmodule
`,
  buggyRtl: `module mux2 (
  input  wire [7:0] a,
  input  wire [7:0] b,
  input  wire       sel,
  output wire [7:0] y
);
  assign y = sel ? a : b; // BUG: selects the wrong input
endmodule
`,
  testbench: `\`timescale 1ns/1ps
module mux2_tb;
  reg  [7:0] a;
  reg  [7:0] b;
  reg        sel;
  wire [7:0] y;
  integer i;
  integer a_errors;
  integer b_errors;

  mux2 dut (.a(a), .b(b), .sel(sel), .y(y));

  initial begin
    $dumpfile("dump.vcd");
    $dumpvars(0, mux2_tb);
    a_errors = 0;
    b_errors = 0;
    sel = 1'b0;
    for (i = 0; i < 32; i = i + 1) begin
      a = $random;
      b = $random;
      #1;
      if (y !== a) a_errors = a_errors + 1;
    end
    sel = 1'b1;
    for (i = 0; i < 32; i = i + 1) begin
      a = $random;
      b = $random;
      #1;
      if (y !== b) b_errors = b_errors + 1;
    end
    if (a_errors == 0) $display("CHECK selects_a PASS"); else $display("CHECK selects_a FAIL");
    if (b_errors == 0) $display("CHECK selects_b PASS"); else $display("CHECK selects_b FAIL");
    $finish;
  end
endmodule
`,
  checkNames: ['selects_a', 'selects_b'],
};

/** The fixtures keyed by the approved Spec module name (the RTL workspace file stem). */
const FIXTURES_BY_MODULE: ReadonlyMap<string, ProblemFixture> = new Map([
  [ADDER8_FIXTURE.moduleName, ADDER8_FIXTURE],
  [COUNTER4_FIXTURE.moduleName, COUNTER4_FIXTURE],
  [MUX2_FIXTURE.moduleName, MUX2_FIXTURE],
]);

/** The fixture for a subset problem, resolved by its Spec module name. */
function fixtureFor(problem: EvalProblem): ProblemFixture {
  const fixture = FIXTURES_BY_MODULE.get(problem.spec.moduleInterface.moduleName);
  if (fixture === undefined) {
    throw new Error(`no eval fixture for problem "${problem.id}"`);
  }
  return fixture;
}

// -- Seeded candidate policy (models a temperature-0 provider seeded per sample) --
//
// The per-sample seed selects, deterministically, the candidate a temperature-0
// model would have produced. Three trajectories are represented so pass@k,
// iterations-to-pass, and the never-passing (budget-bounded) path are all
// exercised across the subset:
//   - immediate-pass: the first candidate is correct; the oracle passes at
//     iteration 1.
//   - repair-pass:     the first candidate is buggy; the repair is correct; the
//     oracle passes at iteration 2.
//   - never-pass:      every candidate is buggy; the loop repairs until the
//     student iteration cap terminates it, and the module stays Unverified.
// The trajectory is a pure function of the seed, so re-running the same config
// reproduces every outcome exactly (Req 15.10).

/** Which end-to-end trajectory a sample's seed selects. */
type SampleTrajectory = 'immediate-pass' | 'repair-pass' | 'never-pass';

/** The three trajectories, indexed by the seed's residue modulo three. */
const TRAJECTORIES: readonly SampleTrajectory[] = ['immediate-pass', 'repair-pass', 'never-pass'];

/** The deterministic trajectory a seed selects (the seeded "model" decision). */
function trajectoryForSeed(seed: number): SampleTrajectory {
  const trajectory = TRAJECTORIES[seed % TRAJECTORIES.length];
  if (trajectory === undefined) {
    // Unreachable: `seed % 3` is always 0, 1, or 2 for the non-negative seeds
    // `sampleSeed` produces, so the table always has an entry.
    throw new Error('trajectory index out of range');
  }
  return trajectory;
}

/** Build a `GeneratedCandidate` carrying the given RTL and a fresh module-version ref. */
function candidateOf(spec: Spec, moduleName: string, rtl: string): GeneratedCandidate {
  const id = newUlid();
  const artifactRef: ArtifactRef = { kind: 'module-version', id, version: 1 };
  return {
    rtl,
    parsedInterface: { moduleName, ports: [] },
    interfaceMatch: {
      matches: true,
      moduleNameMatches: true,
      expectedModuleName: moduleName,
      actualModuleName: moduleName,
      missingPorts: [],
      extraPorts: [],
      mismatchedPorts: [],
    },
    moduleVersion: {
      id,
      projectId: spec.projectId,
      specVersion: spec.version,
      rtl,
      createdAt: new Date(0).toISOString(),
    },
    label: unverified(artifactRef),
  };
}

/** Wrap a candidate as a produced `CandidateEval` with a clean interface. */
function evalOf(candidate: GeneratedCandidate): Result<CandidateEval, CandidateFailure> {
  return ok({ candidate, interfaceDiagnostics: '' });
}

/**
 * A generation port whose output is a pure function of the sample seed (a seeded,
 * temperature-0 model stand-in). It charges the shared Session_Budget on every
 * call, exactly as the Model_Router would, so per-session cost accrues honestly.
 */
class SeededCandidateGenerator implements CandidateGenerator {
  readonly #spec: Spec;
  readonly #fixture: ProblemFixture;
  readonly #trajectory: SampleTrajectory;

  constructor(seed: number, spec: Spec, fixture: ProblemFixture) {
    this.#spec = spec;
    this.#fixture = fixture;
    this.#trajectory = trajectoryForSeed(seed);
  }

  generateCandidate(
    _input: GenerationInput,
    budget: SessionBudgetHandle,
  ): Promise<Result<CandidateEval, CandidateFailure>> {
    budget.charge({ tokens: 8, costCents: MODEL_CALL_CENTS, wallClockMs: 1 });
    const rtl =
      this.#trajectory === 'immediate-pass' ? this.#fixture.correctRtl : this.#fixture.buggyRtl;
    return Promise.resolve(evalOf(candidateOf(this.#spec, this.#fixture.moduleName, rtl)));
  }

  reviseFromErrors(
    _input: GenerationInput,
    _previousRtl: string,
    _diagnostics: string,
    budget: SessionBudgetHandle,
  ): Promise<Result<CandidateEval, CandidateFailure>> {
    budget.charge({ tokens: 8, costCents: MODEL_CALL_CENTS, wallClockMs: 1 });
    const rtl =
      this.#trajectory === 'repair-pass' ? this.#fixture.correctRtl : this.#fixture.buggyRtl;
    return Promise.resolve(evalOf(candidateOf(this.#spec, this.#fixture.moduleName, rtl)));
  }
}

/**
 * The independent, RTL-isolated testbench port: it returns the problem's
 * spec-derived testbench and charges one budget step, as the Testbench_Agent would.
 * The source is derived solely from the Spec (never from any candidate RTL).
 */
class SpecDerivedTestbenchGenerator implements IndependentTestbenchGenerator {
  readonly #spec: Spec;
  readonly #fixture: ProblemFixture;

  constructor(spec: Spec, fixture: ProblemFixture) {
    this.#spec = spec;
    this.#fixture = fixture;
  }

  generateTestbench(
    _request: GenerateTestbenchRequest,
    budget: SessionBudgetHandle,
  ): Promise<TestbenchGenerationOutcome> {
    budget.charge({ tokens: 8, costCents: MODEL_CALL_CENTS, wallClockMs: 1 });
    const testbench: Testbench = {
      id: newUlid(),
      specId: this.#spec.id,
      specVersion: this.#spec.version,
      source: this.#fixture.testbench,
      sourceAttribution: 'spec',
      coversCriteria: this.#spec.acceptanceCriteria.map((criterion) => criterion.id),
    };
    return Promise.resolve({ status: 'generated', testbench, checks: [] });
  }
}

// -- Generation-gate collaborators (real gate, admitting inputs) -------------

/** A persistence sink that accepts the approved Spec and reports a written checkpoint. */
const ACCEPTING_APPROVAL_SINK: SpecApprovalSink = {
  persistApprovedSpec(): Promise<Result<SpecApprovalReceipt, SpecApprovalSinkError>> {
    return Promise.resolve(ok({ checkpointWritten: true }));
  },
};

/**
 * The generation-runner port the gate requires. The Verification_Loop opens the
 * context and drives generation itself, so this entry point is never reached; it
 * throws loudly if it ever is, rather than silently returning a bogus outcome.
 */
const UNREACHABLE_RUNNER = {
  runGeneration(): Promise<never> {
    throw new Error('GenerationRunner.runGeneration must not be called by the Verification_Loop');
  },
};

/** A confirmed, in-scope intent session that admits generation for the given Spec. */
function confirmedIntent(sessionId: Ulid, summary: string): IntentSession {
  return {
    sessionId,
    artifact: intentArtifactLabel(newUlid(), 1),
    restatement: { summary, constraints: [], assumptions: [] },
    scope: 'single-module',
    clarificationRounds: 0,
    outcome: { kind: 'ready-for-confirmation' },
    confirmation: 'confirmed',
  };
}

// -- Fake Simulator (non-vacuous path; verdict derived from the candidate) ---
//
// The fake stands in for the iverilog + vvp toolchain and gVisor isolation only:
// it derives the verdict from the candidate RTL it is handed, never from a scripted
// sequence. A candidate that exactly matches the fixture's correct RTL emits every
// check PASS; any other candidate (the buggy variant) emits the first check FAIL so
// the oracle verdict is `fail`, mirroring what the real testbench would report.

/** A synthetic non-null VCD artifact so the run's capture is complete (never `error`). */
const FAKE_VCD = { name: 'dump.vcd', sizeBytes: 8, sha256: 'a'.repeat(64) } as const;

/** The RTL workspace file of a simulate job (the `<module>.v`, not the `<module>_tb.v`). */
function rtlFileOf(job: SandboxJob): SourceFile | undefined {
  return job.workspaceFiles.find(
    (file) => file.path.endsWith('.v') && !file.path.endsWith('_tb.v'),
  );
}

/** The fixture whose correct RTL a job's testbench file corresponds to, by module stem. */
function fixtureForJob(job: SandboxJob): ProblemFixture | undefined {
  const testbenchFile = job.workspaceFiles.find((file) => file.path.endsWith('_tb.v'));
  if (testbenchFile === undefined) {
    return undefined;
  }
  const moduleName = testbenchFile.path.slice(0, -'_tb.v'.length);
  return FIXTURES_BY_MODULE.get(moduleName);
}

/** The `CHECK` signalling stdout a run produces for a passing or failing candidate. */
function checkSignalling(fixture: ProblemFixture, passed: boolean): string {
  const lines = fixture.checkNames.map((name, index) => {
    const verdict = passed || index > 0 ? 'PASS' : 'FAIL';
    return `CHECK ${name} ${verdict}`;
  });
  return `${lines.join('\n')}\n`;
}

/** Derive a raw capture from the candidate RTL in the job (the fake oracle decision). */
function fakeCapture(job: SandboxJob): RawRunCapture {
  const fixture = fixtureForJob(job);
  const rtlFile = rtlFileOf(job);
  if (fixture === undefined || rtlFile === undefined) {
    // No recognizable candidate: report an infrastructure failure rather than a
    // fabricated functional verdict, so the oracle stays the sole authority.
    return {
      timedOut: false,
      infraFailure: true,
      exitCode: null,
      stdout: null,
      stderr: null,
      stdoutTruncated: false,
      stderrTruncated: false,
      diskLimitExceeded: false,
      artifacts: {},
      deniedOperations: [],
      resourceUsage: { wallMs: 0, maxMemMb: 0, cpuMs: 0 },
    };
  }
  const passed = rtlFile.contents === fixture.correctRtl;
  return {
    timedOut: false,
    infraFailure: false,
    exitCode: 0,
    stdout: checkSignalling(fixture, passed),
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    diskLimitExceeded: false,
    artifacts: { vcd: FAKE_VCD },
    deniedOperations: [],
    resourceUsage: { wallMs: 5, maxMemMb: 8, cpuMs: 4 },
  };
}

/** The fake Simulator: the real adapter over a runtime that derives the fake capture. */
function fakeSimulator(): SimulatorAdapter {
  return new IcarusSimulatorAdapter(new SandboxToolRunner(new FakeSandboxRuntime(fakeCapture)));
}

// -- The production-style EvalLoopRunner adapter -----------------------------

/**
 * The production-style adapter the harness drives: for each sample it constructs a
 * seeded `VerificationLoop` (real generation gate, oracle Trust_Labeler, and
 * Action_Recorder), threads the harness's metered student-caps budget and sandbox
 * limits, and returns the oracle-decided `VerificationOutcome`. Only the injected
 * `SimulatorAdapter` (real or fake) varies; everything else is the real loop.
 */
class EvalVerificationLoopRunner implements EvalLoopRunner {
  readonly #simulator: SimulatorAdapter;

  constructor(simulator: SimulatorAdapter) {
    this.#simulator = simulator;
  }

  runSample(request: EvalSampleRequest): Promise<VerificationOutcome> {
    const { problem, seed, budget, limits } = request;
    const fixture = fixtureFor(problem);
    const sessionId = newUlid();
    const recorder = new TraceActionRecorder(new InMemoryTracePersistence());
    const gate = new GenerationGate<never>({
      runner: UNREACHABLE_RUNNER,
      approvalSink: ACCEPTING_APPROVAL_SINK,
      recorder,
      now: () => 0,
    });
    const loop = new VerificationLoop({
      gate,
      generator: new SeededCandidateGenerator(seed, problem.spec, fixture),
      testbench: new SpecDerivedTestbenchGenerator(problem.spec, fixture),
      simulator: this.#simulator,
      recorder,
      trustLabeler: oracleTrustLabeler,
      now: () => 0,
    });
    const admission: GenerationAdmissionRequest = {
      intent: confirmedIntent(sessionId, problem.intentSummary),
      spec: problem.spec,
    };
    return loop.verify(admission, budget, limits);
  }
}

// -- Expected outcomes, re-derived from the public seed + candidate policy ----

/** The outcomes the subset should produce for one problem under a config. */
interface ExpectedProblem {
  readonly passCount: number;
  readonly sampleCount: number;
  readonly iterationsToPass: number | null;
}

/** The loop iterations a passing trajectory takes (immediate pass 1, repaired 2). */
function iterationsForTrajectory(trajectory: SampleTrajectory): number | null {
  if (trajectory === 'immediate-pass') {
    return 1;
  }
  if (trajectory === 'repair-pass') {
    return 2;
  }
  return null;
}

/**
 * Derive the expected pass count and iterations-to-pass for a problem straight from
 * the PUBLIC `sampleSeed` and the documented seeded-candidate policy, independent of
 * the harness. Matching these proves the seed threads through generation and the
 * oracle decides each verdict (Req 15.2, 15.3, 15.10).
 */
function expectedForProblem(problem: EvalProblem, config: ReproducibilityConfig): ExpectedProblem {
  const trajectories: SampleTrajectory[] = [];
  for (let sampleIndex = 0; sampleIndex < config.sampleCount; sampleIndex += 1) {
    trajectories.push(trajectoryForSeed(sampleSeed(config, problem.id, sampleIndex)));
  }
  const passCount = trajectories.filter((trajectory) => trajectory !== 'never-pass').length;
  const firstPassing = trajectories.find((trajectory) => trajectory !== 'never-pass');
  return {
    passCount,
    sampleCount: config.sampleCount,
    iterationsToPass: firstPassing === undefined ? null : iterationsForTrajectory(firstPassing),
  };
}

// -- Harness assembly + shared assertions ------------------------------------

/** Assemble the Eval_Harness over an adapter driving the given Simulator, or throw. */
function makeHarness(simulator: SimulatorAdapter, config: ReproducibilityConfig) {
  const built = createEvalHarness({
    loopRunner: new EvalVerificationLoopRunner(simulator),
    caps: CAPS,
    limits: LIMITS,
    config,
    costEnvelopeCents: COST_ENVELOPE_CENTS,
    ks: [1, config.sampleCount],
  });
  if (!built.ok) {
    throw new Error(`createEvalHarness rejected the config: ${built.error.code}`);
  }
  return built.value;
}

/** Run the fixed subset through the harness over the given Simulator. */
function runSubset(
  simulator: SimulatorAdapter,
  config: ReproducibilityConfig,
): Promise<EvalRunReport> {
  return makeHarness(simulator, config).run(FIXED_EVAL_SUBSET);
}

/** Assert one sample matches its seed-selected trajectory: oracle verdict, iterations, cost. */
function assertSampleMatchesTrajectory(
  seed: number,
  sample: EvalRunReport['problems'][number]['samples'][number],
): void {
  const trajectory = trajectoryForSeed(seed);
  // The Simulator oracle decides pass/fail, never the model (Req 15.3).
  expect(sample.passed).toBe(trajectory !== 'never-pass');
  if (trajectory === 'immediate-pass') {
    expect(sample.outcomeStatus).toBe('verified');
    expect(sample.iterations).toBe(1);
    expect(sample.costCents).toBe(IMMEDIATE_PASS_CENTS);
  } else if (trajectory === 'repair-pass') {
    expect(sample.outcomeStatus).toBe('verified');
    expect(sample.iterations).toBe(2);
    expect(sample.costCents).toBe(REPAIR_PASS_CENTS);
  } else {
    // never-pass: the loop is terminated by the student iteration cap (Req 15.6).
    expect(sample.outcomeStatus).toBe('unverified');
    expect(sample.stopReason).toBe('max-iterations');
  }
  // Every session stays within the pennies-per-session envelope (Req 15.6, 17.3).
  expect(sample.costCents).toBeLessThanOrEqual(COST_ENVELOPE_CENTS);
}

/**
 * Drive the whole fixed subset through the loop with the given Simulator and assert
 * pass@k, iterations-to-pass, oracle-decided verdicts, student-cap termination, and
 * the per-session cost envelope (Req 15.1, 15.2, 15.3, 15.6).
 */
async function assertSubsetEval(simulator: SimulatorAdapter): Promise<void> {
  const config = reproducibilityConfig();
  const report = await runSubset(simulator, config);

  // Non-vacuous: the subset actually exercises both a passing and a failing oracle
  // verdict, so pass@k is a real signal rather than a constant.
  const allSamples = report.problems.flatMap((problem) => problem.samples);
  expect(allSamples).toHaveLength(FIXED_EVAL_SUBSET.length * config.sampleCount);
  expect(allSamples.some((sample) => sample.passed)).toBe(true);
  expect(allSamples.some((sample) => !sample.passed)).toBe(true);

  for (const problem of FIXED_EVAL_SUBSET) {
    const result = report.problems.find((entry) => entry.problemId === problem.id);
    if (result === undefined) {
      throw new Error(`missing problem result for "${problem.id}"`);
    }
    const expected = expectedForProblem(problem, config);
    expect(result.sampleCount).toBe(expected.sampleCount);
    expect(result.passCount).toBe(expected.passCount);
    expect(result.iterationsToPass).toBe(expected.iterationsToPass);
    expect(result.passAtK[1]).toBeCloseTo(expected.passCount / expected.sampleCount, 12);
    expect(result.passAtK[config.sampleCount]).toBe(expected.passCount > 0 ? 1 : 0);

    for (const sample of result.samples) {
      assertSampleMatchesTrajectory(sample.seed, sample);
    }
  }

  // The reported per-session cost envelope holds across the whole subset (Req 15.6).
  expect(report.costEnvelope.withinEnvelope).toBe(true);
  expect(report.costEnvelope.maxObservedCents).toBeLessThanOrEqual(COST_ENVELOPE_CENTS);
  expect(report.costEnvelope.violations).toHaveLength(0);
}

/**
 * Assert reproducibility (Req 15.10 / Property 10): two runs of the same subset and
 * config produce byte-identical reports, so pass@k, iterations, and cost never flap.
 */
async function assertReproducible(makeSimulator: () => SimulatorAdapter): Promise<void> {
  const config = reproducibilityConfig();
  const first = await runSubset(makeSimulator(), config);
  const second = await runSubset(makeSimulator(), config);
  expect(first).toEqual(second);
}

// -- Capability probe (always runs) ------------------------------------------

describe('Eval_Harness integration - real-oracle capability probe', () => {
  it('documents whether the real oracle path was exercised in this environment', () => {
    expect(typeof PROBE.available).toBe('boolean');
    expect(PROBE.reason.length).toBeGreaterThan(0);
  });
});

// -- Fake-Simulator suite (always runs; keeps the eval test non-vacuous) -----

describe('Eval_Harness integration - fake Simulator (non-vacuous; Req 15.1, 15.2, 15.6, 15.10)', () => {
  it('reports reproducible pass@k, iterations-to-pass, and cost under student-session caps', async () => {
    await assertSubsetEval(fakeSimulator());
  });

  it('produces byte-identical reports across two runs of the same subset and config', async () => {
    await assertReproducible(fakeSimulator);
  });
});

// -- Real-oracle suite (skips cleanly when iverilog/vvp are absent) ----------

describe.skipIf(!PROBE.available)(
  'Eval_Harness integration - real oracle (iverilog + vvp; Req 15.1, 15.2, 15.6, 15.10)',
  () => {
    it(
      'reports reproducible pass@k, iterations-to-pass, and cost under student-session caps',
      async () => {
        await assertSubsetEval(realOracleAdapter());
      },
      REAL_TIMEOUT,
    );

    it(
      'produces byte-identical reports across two runs of the same subset and config',
      async () => {
        await assertReproducible(realOracleAdapter);
      },
      REAL_TIMEOUT,
    );
  },
);
