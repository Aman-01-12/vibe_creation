// formal-property-oracle, Properties 13, 24, and 9: the design reaches the workspace unedited and
// the wrapper is the top; every formal invocation is contained; a timeout is neither a pass nor a
// fail (task 6.7).
//
// WHAT IS CLAIMED, AND OVER WHAT
//   Every assertion is about the REAL `YosysSmtBmcFormalOracle`, over the `SandboxJob`s it actually
//   SUBMITTED - the `formalPrepass` job AND every `formal` rung of every property's ladder - and over
//   the outcome it actually RETURNED. Nothing here assembles a job. The adapter is driven through
//   `CapturingToolRunner`, which records each job at the injected `ToolRunner` port and then hands it
//   to the REAL `SandboxToolRunner` over a scripted `FakeSandboxRuntime`, which records the
//   `ContainerSpec` the real Tool_Runner built for it. So the results the adapter reads are classified
//   by the real capture-all-or-error rule (a wall-clock kill is `error` because `classifyCapture` says
//   so, not because this file does), and the network and secret assertions are over the spec the
//   runtime PORT was handed rather than a recomputation of it. `adapter.test.ts` pins these rules on
//   fixed examples; this file is their generated form and re-asserts none of its fixtures.
//
// PROPERTY 13 - VALUE EQUALITY, NOT BYTE IDENTITY, AND THE TOP CHECKED TWO WAYS (Req 3.5, 3.6)
//   The submitted design file is asserted EQUAL IN VALUE to the source given, because that is what
//   Req 3.5 states and what the implemented guard does: the `SourceFile` is passed through untouched.
//   The adapter is handed a COPY, so the equality can only hold by value. That is a DIFFERENT claim
//   from the seam's byte-identity invariant (tasks 1.1, 1.2, 16.1), which is about `contract-schema.ts`
//   and `contract.schema.json` mirroring each other; there byte identity is the real invariant and
//   nothing here weakens it. The design text carries what an editing adapter would plausibly disturb -
//   CRLF and lone-CR line ends, a BOM, trailing whitespace, no final newline, arbitrary graphemes - so
//   a trim, a line-end normalization, or an appended newline fails here.
//   "The wrapper is the top" is checked TWO ways, over task 12.4's `propertyWrapperSources`: each
//   `formal` job's `topModule` is the one module its OWN wrapper file declares, read off that text
//   rather than off the adapter's constant; and the wrapper texts submitted, in order, split into one
//   non-empty run per property repeating exactly `propertyWrapperSources[i]`, so a wrapper returned at
//   the wrong index, a second render, or a missing entry fails, escalated rungs included.
//
// PROPERTY 24 - CONTAINMENT, ON THE PRE-PASS AS WELL AS EVERY RUNG (Req 11.1-11.4, 11.6, 11.9, 14.25)
//   Over every submitted job of BOTH kinds: it went through the injected port and passed the real
//   Tool_Runner's seam validation (every job reached the runtime with a spec); its limits carry
//   exactly the four caps the adapter was injected with, plus a positive integer `wallMs` no larger
//   than the Property_Time_Budget; and the spec the runtime received carries the literal
//   `network: 'none'` and `mountSecrets: false` and is, limits aside, the frozen isolation policy for
//   every kind alike. Every artifact the adapter read is one a run handed back (Req 11.2).
//   The SANITIZED-DIAGNOSTIC rule is part of the claim, on both kinds alike: hosts, a credential
//   inside a URL, absolute paths, a Python traceback, and terminal control codes are planted on the
//   pre-pass's stderr and on every rung's stderr and lowering tail, and asserted ABSENT from every
//   surfaced diagnostic by the exact planted token, with the bound held - Req 11.6 as Property 25
//   operationalizes it.
//   THE SECRET CLAUSE (task 20.4; Req 11.6, 11.20). A credential-shaped token is now something the
//   sanitizer recognizes: `sanitizeDiagnostic` runs the Secret_Pattern_Set, whose single owner is
//   `SECRET_PATTERN_SOURCES` in `@app/core`. So a token drawn from the SHARED generator
//   (`generators/secrets.ts`, never a second one) is planted beside the other payloads, and two
//   things are asserted of every surfaced diagnostic: the exact planted token is absent, and NO
//   pattern of the owner's set matches anywhere in it. The second half reads the owner, so this file
//   restates no pattern. The no-secret-MOUNTED half still holds at the source (Req 11.4) and is still
//   asserted below; the sanitizer no longer leans on it alone.
//   The secret-named HOST `runner@sk-AAAAAAAAAAAAAAAAAAAA.internal.example.test` is planted too, and
//   must surface as `<host>`: it is the input that fixes the pass's position AFTER the host and path
//   redactions, and it is asserted to survive as `<host>` rather than only to leak nothing, so a
//   sanitizer that ate the whole line could not pass it.
//   NOTHING UNVALIDATED reaches a job. Text the Property_Validator refuses cannot become a
//   `FormalProperty` field at all, because `validateExpression` is the brand's only constructor, so
//   each candidate text carries a sentinel and no submitted job may carry a refused one - while an
//   ADMITTED candidate's sentinel is seen arriving, which is what makes the absence mean something.
//   Two more untrusted channels ride the same check: `id` and `criterionRef`, plain strings the adapter
//   does receive, and a design module name the seam refuses, which `#submit` stops before any wrapper
//   could splice it (the case the adapter's own comment cites Req 11.9 for).
//
//   WHY THE PRE-PASS HALF IS REGRESSION PROTECTION, NOT THE CLOSING OF A LIVE EXPOSURE (Req 14.25).
//   Over the `formalPrepass` job the obligation is already met STRUCTURALLY. The caps cannot be
//   omitted: `FormalResourceCaps` is `Omit<ResourceLimits, 'wallMs'>` over a `ResourceLimits` whose
//   five fields are all REQUIRED, so a caps value missing one is a compile error, and the adapter's
//   `#limits` supplies `wallMs` from the remaining budget on every job, the pre-pass included. The
//   network and the secrets are not per-job facts at all: `SANDBOX_ISOLATION` in
//   `app/tools/sandbox/isolation.ts` is ONE frozen `as const` policy carrying `network: 'none'` and
//   `mountSecrets: false`, `buildContainerSpec` and `buildRunscArgs` apply it to every job, and
//   `isolation.ts` reads no job kind anywhere, so no kind can be less contained than another. What the
//   pre-pass assertions add is a failing test the day someone writes a per-kind branch.
//   THE LIMIT OF THAT ARGUMENT, so it is not read wider than it is: it covers the caps, the network,
//   and the secrets, and it does NOT claim the pre-pass has been EXERCISED under the gVisor `runsc`
//   runtime. `sandbox-containment.integration.test.ts` drives the `simulate` kind only, no
//   `formalPrepass` job has run under `runsc`, and nothing in this file launches a container either:
//   the spec asserted here is the input `RunscSandboxRuntime` builds its argv from, and that mapping is
//   pinned by `sandbox-config.smoke.test.ts`. The residual is covered by the same kind-blind isolation
//   policy rather than by a run. That the adapter has no SECOND execution channel - no process,
//   socket, or file of its own - is structural and is task 6.8's import assertion; this file asserts
//   the dynamic half.
//
// PROPERTY 9 - A BUDGET GENUINELY SPENT, ON A CLOCK THE TEST OWNS (Req 7.1, 7.2, 7.3, 7.4)
//   No real wait and no `sleep()`: the adapter's injected `now` reads `ManualClock`, which moves only
//   when a scripted run says time passed. The budget is spent at every point a window can run out:
//   the pre-pass KILLED at its cap, the pre-pass completing exactly ON the budget, a rung KILLED at its
//   cap (the first, or a later one after real escalations), and an escalating rung completing exactly
//   on the budget so the next rung is never entered. The run that spends is scripted with what would
//   otherwise DECIDE the property - a proving report, or a refuting one with its counterexample
//   registered - and a killed run sometimes leaves that report behind, so a verdict read off a run the
//   sandbox killed fails here. Every case is a CONTROLLED PAIR: the identical script with the spending
//   run taking a fraction of its cap must decide the property exactly as scripted, so the spent budget
//   is the only thing between the run and a decided verdict. The clock must also end EXACTLY on the
//   budget: spent to the millisecond, which is what makes the timeout genuine, and never past it,
//   which is the sandbox enforcing the budget through `wallMs` rather than a second timer (Req 7.1).
//   THE COVER STEP IS DERIVED FROM THE DEPTH THE JOB SUBMITTED (Req 11.19; `reportArtifacts`). The
//   fixtures pin `reachedStep: 13` and a combinational property's only rung is depth 1, so the
//   control's proving report claimed a cover reached twelve steps past the depth it ran at. The
//   interpreter refuses that (`toolchain-unavailable`), the control read it, and the pair failed on
//   the control rather than on the timeout. The step is now capped at `depth - 1`: a clocked rung at
//   depth 20 or more is untouched, and only the reports the real tool cannot write are narrowed away
//   (`chipAgent/_inbox/gotcha-the-req-11-19-cover-step-guard-breaks-three-free-generator-cover-doubles.md`).
//
// RUN COUNTS are sized to the rarest required shape of each property, measured rather than guessed;
// the arithmetic sits beside each constant
// (`chipAgent/_inbox/verification-recipe-every-row-coverage-needs-numruns-scaled-to-the-table.md`).
//
// The tag strings are literals, not `propertyTag(...)`, whose `FEATURE_TAG` is hardcoded to a
// different spec's property numbering
// (`chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`).
//
// **Validates: Requirements 3.5, 3.6, 7.1, 7.2, 7.3, 7.4, 11.1, 11.2, 11.3, 11.4, 11.6, 11.9, 11.19, 11.20**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { SECRET_PATTERN_SOURCES, type ModuleInterface } from '@app/core';
import {
  COUNTEREXAMPLE_ARTIFACT_KEY,
  coveredAntecedent,
  DEFAULT_PROPERTY_TIME_BUDGET_MS,
  FakeSandboxRuntime,
  MAX_DIAGNOSTIC_CHARS,
  proofDepthsFor,
  SANDBOX_ISOLATION,
  SANDBOX_WORKER_IMAGE,
  SandboxToolRunner,
  validateExpression,
  YosysSmtBmcFormalOracle,
  type ArtifactBlobRef,
  type ContainerSpec,
  type FormalArtifactReader,
  type FormalCheckReport,
  type FormalChecksReport,
  type FormalPrepassDocument,
  type FormalProperty,
  type FormalReport,
  type FormalResourceCaps,
  type PropertyResult,
  type RawRunCapture,
  type RequiredOutput,
  type ResetContract,
  type SandboxJob,
  type SandboxResult,
  type SourceFile,
  type ToolRunner,
} from '@app/tools';

import {
  arbDesignInterface,
  arbFormalProperty,
  arbFormalReport,
  arbPropertyText,
  arbResetContract,
} from './formal-arbitraries.js';
import { withCoverStepBelowDepth } from './formal-cover-depth.js';
import { secretShapedTokenArbitrary } from './generators/secrets.js';
import { propertyParameters } from './property.js';

// **Feature: formal-property-oracle, Property 13: The design reaches the workspace unedited, and
// the wrapper is the top**
const PROPERTY_13 =
  'formal-property-oracle, Property 13: The design reaches the workspace unedited, and the wrapper is the top';

// **Feature: formal-property-oracle, Property 24: Every formal invocation is contained**
const PROPERTY_24 = 'formal-property-oracle, Property 24: Every formal invocation is contained';

// **Feature: formal-property-oracle, Property 9: A timeout is neither a pass nor a fail**
const PROPERTY_9 = 'formal-property-oracle, Property 9: A timeout is neither a pass nor a fail';

/** Headroom for a few-hundred-run async property on a shared runner; nothing depends on it. */
const SLOW_PROPERTY_TIMEOUT_MS = 30_000;

/** The caps Properties 13 and 9 run under. Property 24 GENERATES its own, so none is hardcoded. */
const DEFAULT_CAPS: FormalResourceCaps = Object.freeze({
  cpu: 1,
  memMb: 512,
  procs: 64,
  diskMb: 64,
});

/** The ceiling on a generated Property_Time_Budget: four times the 150s default. */
const MAX_GENERATED_BUDGET_MS = 600_000;

/** The keys every submitted `limits` must carry: the four caps and the wall clock, and no other. */
const LIMIT_KEYS: readonly string[] = Object.freeze(['cpu', 'diskMb', 'memMb', 'procs', 'wallMs']);

/** The artifact keys the worker registers the two reports under: the jobs' own required outputs. */
const PREPASS_REPORT_KEY = 'formalPrepassReport' satisfies RequiredOutput;
const FORMAL_REPORT_KEY = 'formalReport' satisfies RequiredOutput;

/** A counterexample trace's text. Registered beside a refutation; no assertion reads its bytes. */
const TRACE_TEXT = '$date today $end\n$var wire 1 ! out $end\n#0\n0!\n';

/** The width of a lowercase hex SHA-256, which the seam's `ArtifactBlobRef` pattern requires. */
const SHA256_HEX_CHARS = 64;

/**
 * The isolation half of every `ContainerSpec`: the frozen policy plus the pinned image.
 *
 * Read off the policy constant on purpose, so a field added to the spec or a field built per job
 * fails the strict comparison. It cannot catch the policy itself being weakened, which is why the
 * two facts Req 11.4 names are ALSO asserted against literals beside it.
 */
const EXPECTED_ISOLATION = Object.freeze({ image: SANDBOX_WORKER_IMAGE, ...SANDBOX_ISOLATION });

// ---------------------------------------------------------------------------
// The capturing double: the real Tool_Runner over a scripted runtime, on a clock the test owns
// ---------------------------------------------------------------------------

/** A clock the test owns. It moves only when a scripted run says time passed, so nothing waits. */
class ManualClock {
  #nowMs = 0;

  /** The adapter's injected `now`. An arrow property, so it is passed bare without unbinding. */
  readonly now = (): number => this.#nowMs;

  advance(ms: number): void {
    this.#nowMs += ms;
  }
}

/** What the scripted sandbox does with one job: how long it takes, and what it leaves behind. */
interface ScriptedRun {
  /** Milliseconds the run takes on the manual clock. */
  readonly elapsedMs: number;
  /** Whether the run was KILLED at its wall-clock cap. */
  readonly timedOut: boolean;
  readonly exitCode: number | null;
  /** `null` is what a wall-clock kill leaves behind: no stream at all. */
  readonly stderr: string | null;
  /** The text of each artifact the run registered, by the key the worker registers it under. */
  readonly registered: Readonly<Record<string, string>>;
}

/** Decides one submitted job's scripted run. Called once per job, in submission order. */
type RunScript = (job: SandboxJob) => ScriptedRun;

/**
 * The capturing `ToolRunner` double, which is also the run's `FormalArtifactReader`.
 *
 * It RECORDS each job exactly as the adapter submitted it, then delegates to the REAL
 * `SandboxToolRunner`, whose scripted runtime RECORDS the `ContainerSpec` built for that job. The
 * scripted capture goes through the real `classifyCapture` and the real result validation, so the
 * `SandboxResult` the adapter reads is one the production seam could actually hand it.
 *
 * As the reader it resolves only refs a run of this double registered, and records every read, so
 * a read of anything the Tool_Runner did not hand back is visible rather than silently `null`.
 */
class CapturingToolRunner implements ToolRunner, FormalArtifactReader {
  readonly jobs: SandboxJob[] = [];
  readonly specs: ContainerSpec[] = [];
  readonly reads: ArtifactBlobRef[] = [];
  readonly #texts = new Map<string, string>();
  readonly #inner: SandboxToolRunner;

  constructor(script: RunScript, clock: ManualClock) {
    this.#inner = new SandboxToolRunner(
      new FakeSandboxRuntime((job, spec) => {
        this.specs.push(spec);
        const run = script(job);
        clock.advance(run.elapsedMs);
        return this.#captureOf(run);
      }),
    );
  }

  run(job: SandboxJob): Promise<SandboxResult> {
    this.jobs.push(job);
    return this.#inner.run(job);
  }

  readText(artifact: ArtifactBlobRef): Promise<string | null> {
    this.reads.push(artifact);
    return Promise.resolve(this.#texts.get(artifact.sha256) ?? null);
  }

  /** Whether `artifact` is a ref some run of this double registered and handed back. */
  issued(artifact: ArtifactBlobRef): boolean {
    return this.#texts.has(artifact.sha256);
  }

  #captureOf(run: ScriptedRun): RawRunCapture {
    const artifacts: Record<string, ArtifactBlobRef> = {};
    for (const [key, text] of Object.entries(run.registered)) {
      // Unique per registration and inside the seam's 64-hex pattern. Nothing reads these bytes by
      // content, so a real digest would add a dependency and no assertion.
      const sha256 = (this.#texts.size + 1).toString(16).padStart(SHA256_HEX_CHARS, '0');
      this.#texts.set(sha256, text);
      artifacts[key] = { name: key, sizeBytes: text.length, sha256 };
    }
    return {
      timedOut: run.timedOut,
      infraFailure: false,
      exitCode: run.exitCode,
      stdout: run.timedOut ? null : '',
      stderr: run.stderr,
      stdoutTruncated: false,
      stderrTruncated: false,
      diskLimitExceeded: false,
      artifacts,
      deniedOperations: [],
      resourceUsage: { wallMs: run.elapsedMs, maxMemMb: 1, cpuMs: run.elapsedMs },
    };
  }
}

/** The adapter under test, wired to one capturing double and one manual clock. */
interface Harness {
  readonly clock: ManualClock;
  readonly runner: CapturingToolRunner;
  readonly oracle: YosysSmtBmcFormalOracle;
}

function harness(script: RunScript, caps: FormalResourceCaps = DEFAULT_CAPS): Harness {
  const clock = new ManualClock();
  const runner = new CapturingToolRunner(script, clock);
  const oracle = new YosysSmtBmcFormalOracle({
    toolRunner: runner,
    artifacts: runner,
    caps,
    now: clock.now,
  });
  return { clock, runner, oracle };
}

// ---------------------------------------------------------------------------
// The documents a scripted run registers
// ---------------------------------------------------------------------------

const PASSED_CHECK: FormalCheckReport = Object.freeze({
  exitCode: 0,
  status: 'PASSED',
  elapsedMs: 1,
});
const FAILED_CHECK: FormalCheckReport = Object.freeze({
  exitCode: 1,
  status: 'FAILED',
  elapsedMs: 1,
});

/** A cover reached at step 13, `counter_12`'s measured honest first-reachable step. */
const REACHED_COVER: FormalCheckReport = Object.freeze({
  ...PASSED_CHECK,
  reachedStep: 13,
  coverAnswered: true,
});

/** A cover that ANSWERED and was not reached: the one outcome a deeper rung could change. */
const UNREACHED_COVER: FormalCheckReport = Object.freeze({
  ...FAILED_CHECK,
  exitCode: 0,
  coverAnswered: true,
});

/** Temporal induction reported successful: the fifth condition satisfied. */
const INDUCTION_PROVED: FormalCheckReport = Object.freeze({
  ...PASSED_CHECK,
  inductionSuccessful: true,
});

/** A completed lowering with a non-zero count, carrying the given three checks. */
function formalReport(checks: Omit<FormalChecksReport, 'presat'>): FormalReport {
  return {
    lowering: { exitCode: 0, stderrTail: '' },
    assertionCount: 2,
    checks: { presat: PASSED_CHECK, ...checks },
  };
}

/** All five conditions hold, so this report decides `proved` for any property. */
const PROVING_REPORT = formalReport({
  base: PASSED_CHECK,
  cover: REACHED_COVER,
  induct: INDUCTION_PROVED,
});

/** The base case FAILED with every earlier condition held: `refuted`, once a trace is registered. */
const REFUTING_REPORT = formalReport({
  base: FAILED_CHECK,
  cover: REACHED_COVER,
  induct: FAILED_CHECK,
});

/** An unreached antecedent: escalates a property that HAS one, and proves one that does not. */
const ESCALATING_REPORT = formalReport({
  base: PASSED_CHECK,
  cover: UNREACHED_COVER,
  induct: INDUCTION_PROVED,
});

/** The Proof_Depth a submitted `formal` job searches to. A pre-pass has none, and fails loudly. */
function depthOf(job: SandboxJob): number {
  const depth = job.formal?.depth;
  if (depth === undefined) {
    throw new Error(`a formal report was scripted for a ${job.kind} job, which carries no depth`);
  }
  return depth;
}

/**
 * The artifacts a `formal` run registers for one report, plus its trace where it refutes.
 *
 * THE COVER STEP IS DERIVED FROM THE JOB'S OWN DEPTH, and this is the one place it is. The fixtures
 * above pin `reachedStep: 13`, `counter_12`'s measured first-reachable step, and a COMBINATIONAL
 * property's ladder has a single rung at depth 1. A report claiming a cover reached at step 13 by a
 * run that searched to depth 1 is one the real tool cannot write, and `interpretFormalReport` refuses
 * it (Req 11.19) - so Property 9's "decides once the budget is not spent" control read
 * `toolchain-unavailable`, not `proved`. The step is capped at `depth - 1` (`withCoverStepBelowDepth`)
 * and a clocked rung at depth 20 or more keeps step 13 untouched, so the population narrows by
 * exactly the reports the tool cannot write and no other.
 */
function reportArtifacts(
  report: FormalReport,
  job: SandboxJob,
  withTrace = false,
): Record<string, string> {
  const registered: Record<string, string> = {
    [FORMAL_REPORT_KEY]: JSON.stringify(withCoverStepBelowDepth(report, depthOf(job))),
  };
  if (withTrace) {
    registered[COUNTEREXAMPLE_ARTIFACT_KEY] = TRACE_TEXT;
  }
  return registered;
}

/** The two verdicts a run can DECIDE, which a spent budget must never let through. */
type DecisiveVerdict = 'proved' | 'refuted';

const DECISIVE_VERDICTS: readonly DecisiveVerdict[] = Object.freeze(['proved', 'refuted']);

/** The artifacts the run deciding a property registers, for the verdict it is scripted to reach. */
function decisiveArtifacts(decisive: DecisiveVerdict, job: SandboxJob): Record<string, string> {
  return decisive === 'proved'
    ? reportArtifacts(PROVING_REPORT, job)
    : reportArtifacts(REFUTING_REPORT, job, true);
}

/** A balanced, non-`true` initial-state predicate: the design's step 0 is PINNED, not free. */
const PINNED_INITIAL_STATE = '(= ((|m_n q| state)) #b1)';

/**
 * The pre-pass document that derives `contract`, as the worker would write it.
 *
 * A refused contract is written as the ADMITTED no-clocked-state arm - `clockPolarity: 'none'` -
 * because that is the one refused reset a wrapper is still rendered under (Req 14.40); every other
 * refusal builds no wrapper at all and belongs to Property 24's pre-pass answers instead.
 */
function prepassDocumentFor(contract: ResetContract): FormalPrepassDocument {
  if (!contract.derived) {
    return { reset: { derived: false }, clockPolarity: 'none', initialStatePredicate: null };
  }
  return {
    reset: {
      derived: true,
      resetName: contract.resetName,
      resetActiveLow: contract.resetActiveLow,
      resetKind: contract.resetKind,
    },
    clockPolarity: 'posedge',
    initialStatePredicate: contract.initialStateFree ? 'true' : PINNED_INITIAL_STATE,
  };
}

/** The pre-pass report registration for one document. */
function prepassArtifacts(document: FormalPrepassDocument): Record<string, string> {
  return { [PREPASS_REPORT_KEY]: JSON.stringify(document) };
}

/** A run that ran to completion inside its cap, exiting 0 unless told otherwise. */
function completed(
  elapsedMs: number,
  registered: Readonly<Record<string, string>>,
  stderr = '',
  exitCode: number | null = 0,
): ScriptedRun {
  return { elapsedMs, timedOut: false, exitCode, stderr, registered };
}

/**
 * A run the sandbox KILLED at its cap: it took exactly the job's `wallMs`, as a kill timer does.
 *
 * `leftBehind` is what was registered before the kill, which is usually nothing. It is a parameter
 * because a killed run that left a complete-looking report behind is representable at the seam,
 * and is precisely the run a verdict must never be read off.
 */
function killedAtCap(
  job: SandboxJob,
  leftBehind: Readonly<Record<string, string>> = {},
  stderr: string | null = null,
): ScriptedRun {
  return {
    elapsedMs: job.limits.wallMs,
    timedOut: true,
    exitCode: null,
    stderr,
    registered: leftBehind,
  };
}

/** Milliseconds a run that must NOT spend the budget takes: a share of its cap, leaving >= 1ms. */
function partialOf(job: SandboxJob, share: number): number {
  return Math.floor(share * (job.limits.wallMs - 1));
}

/** A share of a run's cap, in thousandths, so no float edge case (`-0`, a sub-normal) can arise. */
function arbShare(): fc.Arbitrary<number> {
  return fc.integer({ min: 0, max: 1_000 }).map((thousandths) => thousandths / 1_000);
}

/** The reported cause, or `null` for a verdict that carries none. */
function causeOf(result: PropertyResult): string | null {
  return result.verdict === 'could-not-verify' ? result.cause : null;
}

/** The surfaced diagnostic, or `null` for a verdict that carries none. */
function diagnosticOf(result: PropertyResult): string | null {
  return result.verdict === 'could-not-verify' ? result.diagnostic : null;
}

// ---------------------------------------------------------------------------
// Local generators (`formal-arbitraries.ts` is reused, never edited, this wave)
// ---------------------------------------------------------------------------

/** Workspace-relative design names. None is the wrapper's own filename. */
const DESIGN_PATHS: readonly string[] = Object.freeze([
  'design.v',
  'counter_12.v',
  'candidate_rtl.sv',
  'rtl/dut_top.sv',
]);

/** Real-shaped design texts, each carrying bytes a normalizing pass would change. */
const DESIGN_TEXTS: readonly string[] = Object.freeze([
  'module counter_12(input clk, input rst_n, output reg [3:0] out);\r\n' +
    '  always @(posedge clk) out <= out + 1;\r\nendmodule\r\n',
  '`timescale 1ns/1ps\n// keep this comment\nmodule adder_8bit(input [7:0] a, b, output [8:0] sum);' +
    '  \n\tassign sum = a + b;\nendmodule',
  '\uFEFFmodule JC_counter(input clk, input rst_n, output reg [63:0] Q); /* trailing */ endmodule   ',
]);

/**
 * A candidate design source, generated with the bytes an editing adapter would plausibly disturb.
 *
 * Line ends are `\n`, `\r\n`, or a lone `\r`; a BOM leads a share of them; the tail is nothing, a
 * newline, trailing whitespace, or a blank line; the lines themselves are arbitrary graphemes
 * (`unit: 'grapheme'`, the fast-check v4 replacement for `fullUnicodeString`). Nothing parses the
 * design here, so no case is shaped to suit a reader.
 */
function arbDesignSource(): fc.Arbitrary<SourceFile> {
  const laidOut = fc
    .tuple(
      fc.array(fc.string({ unit: 'grapheme', maxLength: 40 }), { maxLength: 6 }),
      fc.constantFrom('\n', '\r\n', '\r'),
      fc.constantFrom('', '\uFEFF'),
      fc.constantFrom('', '\n', ' \t', '\n\n'),
    )
    .map(([lines, lineEnd, bom, tail]) => `${bom}${lines.join(lineEnd)}${tail}`);
  return (
    fc
      .record<SourceFile>({
        path: fc.constantFrom(...DESIGN_PATHS),
        contents: fc.oneof(laidOut, fc.constantFrom(...DESIGN_TEXTS)),
      })
      // `fc.record` builds NULL-PROTOTYPE objects, and `toStrictEqual` tells those apart from the
      // plain object the adapter submits, so the generated value is made plain before it is compared.
      .map(({ path, contents }): SourceFile => ({ path, contents }))
  );
}

/** Whether a design text carries a byte a trim or a line-end normalization would change. */
function isNormalizationSensitive(text: string): boolean {
  return /\r|\uFEFF|\s$/u.test(text);
}

/** How a scripted `formal` rung answers. `generated` is any schema-valid report at all. */
type FormalAnswer =
  | { readonly kind: 'proved' | 'refuted' | 'escalating' | 'no-report' | 'killed' }
  | { readonly kind: 'generated'; readonly report: FormalReport };

/** The answers whose outcome is fixed by the report alone: no kill, no arbitrary document. */
function arbScriptedFormalAnswer(): fc.Arbitrary<FormalAnswer> {
  return fc
    .constantFrom('proved', 'refuted', 'escalating', 'no-report')
    .map((kind): FormalAnswer => ({ kind }));
}

/**
 * Every answer, including a kill and an arbitrary report from the shared generator.
 *
 * `escalating` carries the weight because it is the only answer that submits a SECOND rung, and the
 * containment rule has to meet later rungs and not only first ones. MEASURED over 400 cases with
 * three equal arms - the four scripted answers, a kill, a generated report - a ladder climbed past
 * its first rung on 8 of them, about 2% and a one-in-three-thousand chance of meeting none; at
 * these weights it measured 17 to 25 of 400. So the weight was raised rather than the claim narrowed.
 */
function arbAnyFormalAnswer(): fc.Arbitrary<FormalAnswer> {
  return fc.oneof(
    { weight: 4, arbitrary: fc.constant<FormalAnswer>({ kind: 'escalating' }) },
    { weight: 1, arbitrary: fc.constant<FormalAnswer>({ kind: 'proved' }) },
    { weight: 1, arbitrary: fc.constant<FormalAnswer>({ kind: 'refuted' }) },
    { weight: 1, arbitrary: fc.constant<FormalAnswer>({ kind: 'no-report' }) },
    { weight: 1, arbitrary: fc.constant<FormalAnswer>({ kind: 'killed' }) },
    {
      weight: 2,
      arbitrary: arbFormalReport().map((report): FormalAnswer => ({ kind: 'generated', report })),
    },
  );
}

/**
 * The scripted run for one `formal` rung.
 *
 * `stderr` is planted on the run's own stream AND, for a `generated` report, on its lowering tail,
 * because those are the two places a rung's diagnostic can come from.
 */
function formalRunFor(
  answer: FormalAnswer,
  job: SandboxJob,
  stderr: string,
  elapsedMs: number,
): ScriptedRun {
  switch (answer.kind) {
    case 'proved':
      return completed(elapsedMs, reportArtifacts(PROVING_REPORT, job), stderr);
    case 'refuted':
      return completed(elapsedMs, reportArtifacts(REFUTING_REPORT, job, true), stderr);
    case 'escalating':
      return completed(elapsedMs, reportArtifacts(ESCALATING_REPORT, job), stderr);
    case 'generated': {
      const report = {
        ...answer.report,
        lowering: { ...answer.report.lowering, stderrTail: stderr },
      };
      return completed(elapsedMs, reportArtifacts(report, job), stderr);
    }
    case 'no-report':
      return completed(elapsedMs, {}, stderr, 1);
    case 'killed':
      return killedAtCap(job);
    default: {
      // Exhaustiveness: a new answer must be scripted explicitly.
      const unreachable: never = answer;
      return unreachable;
    }
  }
}

// ---------------------------------------------------------------------------
// Property 13
// ---------------------------------------------------------------------------

/** One generated Property_Set over one design, under a pre-pass that DERIVES a contract. */
interface PairingCase {
  readonly design: SourceFile;
  readonly designInterface: ModuleInterface;
  readonly properties: readonly FormalProperty[];
  readonly contract: ResetContract;
  /** The answer for each `formal` rung, by submission ordinal, cycling. */
  readonly formalAnswers: readonly FormalAnswer[];
}

function arbPairingCase(): fc.Arbitrary<PairingCase> {
  return fc.record<PairingCase>({
    design: arbDesignSource(),
    designInterface: arbDesignInterface(),
    properties: fc.array(arbFormalProperty(), { minLength: 1, maxLength: 3 }),
    contract: arbResetContract(),
    formalAnswers: fc.array(arbScriptedFormalAnswer(), { minLength: 1, maxLength: 6 }),
  });
}

/**
 * The pre-pass derives the case's contract, and each rung answers as scripted, taking no time.
 *
 * The clock never moves, so every property's window stays open and every property is attempted at
 * least once: the block partition below may then demand a NON-EMPTY run per property.
 */
function pairingScript(c: PairingCase): RunScript {
  let formalOrdinal = 0;
  return (job) => {
    if (job.kind === 'formalPrepass') {
      return completed(0, prepassArtifacts(prepassDocumentFor(c.contract)));
    }
    const answer = c.formalAnswers[formalOrdinal % c.formalAnswers.length] ?? { kind: 'proved' };
    formalOrdinal += 1;
    return formalRunFor(answer, job, '', 0);
  };
}

/**
 * Every module a source declares, read off its own text.
 *
 * A fresh, non-global-state scan per call (`matchAll` clones its regex), so nothing is shared across
 * loops (`chipAgent/_inbox/gotcha-shared-global-regex-lastindex-infinite-loop.md`). `\b` keeps
 * `endmodule` from reading as a declaration, and the design's instantiation inside a wrapper is not
 * preceded by `module`, so it is not one either.
 */
function declaredModules(source: string): readonly string[] {
  return [...source.matchAll(/\bmodule\s+([A-Za-z_][A-Za-z0-9_$]*)/g)].map(
    (match) => match[1] ?? '',
  );
}

/** The one workspace file of a `formal` job that is not the design: its Property_Wrapper. */
function wrapperTextOf(job: SandboxJob, designPath: string): string {
  const others = job.workspaceFiles.filter((file) => file.path !== designPath);
  expect(others).toHaveLength(1);
  return others[0]?.contents ?? '';
}

/**
 * Whether `submitted`, in order, splits into ONE NON-EMPTY RUN PER SOURCE, run `i` repeating
 * `sources[i]` exactly.
 *
 * That is the shape "the wrapper returned at index `i` is the one submitted for property `i`" takes
 * once a property may climb several rungs: every rung of one ladder submits the same wrapper, and
 * the ladders run one after another in submission order. Checked as reachability over cut points
 * rather than greedily, because two properties may legitimately render the SAME wrapper, and a
 * greedy match would then swallow the second property's run into the first's.
 */
function splitsIntoOneRunPerSource(
  submitted: readonly string[],
  sources: readonly (string | null)[],
): boolean {
  let cuts: ReadonlySet<number> = new Set([0]);
  for (const source of sources) {
    const next = new Set<number>();
    for (const start of cuts) {
      for (let end = start; end < submitted.length && submitted[end] === source; end += 1) {
        next.add(end + 1);
      }
    }
    cuts = next;
  }
  return cuts.has(submitted.length);
}

/**
 * NUM_RUNS - sized to the rarest required shape, an ESCALATED ladder: a property carrying an
 * antecedent (clocked 2/3 x antecedent 1/2 = 1/3) whose first rung answers `escalating` (1/4), so
 * 1/12 per property and at least 8.3% per run. MEASURED over four 200-run samples at 9% to 17%, so
 * the miss probability is at most `(11/12)^200` ~ 3e-8. Two properties rendering DIFFERENT wrappers,
 * the shape a mispairing needs, measured at 61% to 67%.
 */
const PAIRING_NUM_RUNS = 200;

describe(PROPERTY_13, () => {
  it(
    'submits the design EQUAL IN VALUE on every job and names the RETURNED wrapper as the top',
    async () => {
      let total = 0;
      let multiProperty = 0;
      let distinctWrappers = 0;
      let escalated = 0;
      let normalizationSensitive = 0;
      await fc.assert(
        fc.asyncProperty(arbPairingCase(), async (c: PairingCase) => {
          total += 1;
          const { runner, oracle } = harness(pairingScript(c));

          const outcome = await oracle.proveSet({
            // A COPY, so equality with `c.design` below can only hold by value (Req 3.5).
            designSource: { ...c.design },
            designInterface: c.designInterface,
            properties: c.properties,
            budgetMs: DEFAULT_PROPERTY_TIME_BUDGET_MS,
          });

          // THE DESIGN REACHES EVERY WORKSPACE UNEDITED - the pre-pass's and every rung's: present
          // exactly once under its own path, and equal in value to what was given (Req 3.5).
          for (const job of runner.jobs) {
            expect(job.workspaceFiles.filter((file) => file.path === c.design.path)).toStrictEqual([
              c.design,
            ]);
          }
          // THE WRAPPER IS THE TOP, first way: each rung's `topModule` is the one module its OWN
          // wrapper file declares, read off the submitted text (Req 3.6).
          const formalJobs = runner.jobs.filter((job) => job.kind === 'formal');
          const submittedWrappers = formalJobs.map((job) => wrapperTextOf(job, c.design.path));
          formalJobs.forEach((job, index) => {
            expect(declaredModules(submittedWrappers[index] ?? '')).toEqual([
              job.formal?.topModule,
            ]);
          });
          // Second way: the wrapper returned at index `i` is the one every rung of property `i`
          // submitted, one non-empty run per property in submission order (task 12.4).
          expect(outcome.propertyWrapperSources).toHaveLength(c.properties.length);
          expect(splitsIntoOneRunPerSource(submittedWrappers, outcome.propertyWrapperSources)).toBe(
            true,
          );

          multiProperty += c.properties.length > 1 ? 1 : 0;
          distinctWrappers += new Set(outcome.propertyWrapperSources).size > 1 ? 1 : 0;
          escalated += formalJobs.length > c.properties.length ? 1 : 0;
          normalizationSensitive += isNormalizationSensitive(c.design.contents) ? 1 : 0;
        }),
        propertyParameters({ numRuns: PAIRING_NUM_RUNS }),
      );
      // Non-vacuity: a set the pairing could get wrong, two wrappers a mispairing would swap, a ladder
      // that climbed past its first rung, and a design text a normalizing pass would have changed.
      expect(total).toBe(PAIRING_NUM_RUNS);
      expect(multiProperty).toBeGreaterThan(0);
      expect(distinctWrappers).toBeGreaterThan(0);
      expect(escalated).toBeGreaterThan(0);
      expect(normalizationSensitive).toBeGreaterThan(0);
    },
    SLOW_PROPERTY_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Property 24
// ---------------------------------------------------------------------------

/**
 * One untrusted payload a tool diagnostic can carry, with the tokens asserted ABSENT once surfaced.
 *
 * `leaks` is the planted token itself rather than a restatement of a redaction pattern, so this
 * cannot pass by agreeing with a broken regex. The shapes are the ones Property 11's test plants,
 * plus a CREDENTIAL inside a URL's authority, which is how a secret realistically reaches tool output.
 */
interface AdversarialPayload {
  readonly text: string;
  readonly leaks: readonly string[];
  /**
   * Text that must SURVIVE sanitization wherever the payload's diagnostic arrives, for a payload
   * whose point is WHAT replaces the leak: a redaction that leaves nothing behind cannot tell a
   * correct redaction from one that ate the whole line.
   */
  readonly surfaces?: readonly string[];
  /** The secret shape a generated payload carries, for the non-vacuity counters. */
  readonly secretShape?: string;
}

const ADVERSARIAL_PAYLOADS: readonly AdversarialPayload[] = Object.freeze([
  {
    text: 'fetch https://deploy:s3cr3t-t0ken@artifacts.internal.example.test/jobs/42 failed',
    leaks: ['s3cr3t-t0ken', 'internal.example.test', 'https://'],
  },
  {
    text: 'reported by runner@build-07.internal.example.test',
    leaks: ['runner@', 'internal.example.test'],
  },
  {
    // A HOST whose first label is itself secret-shaped (`sk-` and twenty characters), which is the
    // input that decides where the Secret_Pattern_Set pass may sit. Run ahead of the host patterns,
    // the pass turns it into `runner@<secret>.internal.example.test`; `<` is not in the host
    // character class, so the host pattern then matches nothing and the HOST SURVIVES. Run after
    // them it surfaces as `<host>`
    // (`chipAgent/_inbox/decision-the-secret-pass-runs-after-the-host-and-path-redactions-because-secret-first-leaks-a-host.md`).
    text: 'reported by runner@sk-AAAAAAAAAAAAAAAAAAAA.internal.example.test',
    leaks: ['runner@', 'internal.example.test', 'sk-AAAAAAAAAAAAAAAAAAAA'],
    surfaces: ['reported by <host>'],
  },
  {
    text: 'while reading /home/ci-runner/.config/formal/workspace-8f21/top.sv',
    leaks: ['/home/ci-runner', 'workspace-8f21'],
  },
  {
    text: 'Traceback (most recent call last):\n  File "/opt/yosys/share/smtio.py", line 229, in <module>',
    leaks: ['Traceback (most recent call last)', 'smtio.py', '/opt/yosys'],
  },
  {
    // An ANSI colour escape, a NUL, and a carriage return: terminal control a reader never typed.
    text: 'cell \u001b[31m$check$1\u001b[0m\u0000 unmapped\r',
    leaks: ['\u001b', '\u0000', '\r'],
  },
]);

/** The marker a PRE-PASS diagnostic ends on, so a surfaced one is attributable to its job kind. */
const PREPASS_MARKER = 'zq_prepass_diagnostic_zq';

/** The marker a RUNG's diagnostic ends on. */
const FORMAL_MARKER = 'zq_formal_diagnostic_zq';

/** A line-broken filler, as a real Yosys diagnostic is, pushing a tail past the bound. */
const OVERFLOW_LINE = 'Warning: unmapped cell $check$1 in the lowered model';

/** Enough filler lines that the text exceeds `MAX_DIAGNOSTIC_CHARS` whatever else it carries. */
const OVERFLOW_LINES = Math.ceil(MAX_DIAGNOSTIC_CHARS / OVERFLOW_LINE.length) + 1;

/** The adversarial content one case plants on every stream and tail it scripts. */
interface PlantedDiagnostic {
  readonly payloads: readonly AdversarialPayload[];
  /** Whether filler ahead of the payloads pushes the text past `MAX_DIAGNOSTIC_CHARS`. */
  readonly overLength: boolean;
}

/** The literal prefixes that name a secret shape; a token with none of them is the JWT triple. */
const SECRET_SHAPE_PREFIXES: readonly string[] = Object.freeze([
  'sk-',
  'AKIA',
  'ghp_',
  'Bearer ',
  'api_',
]);

/** The shape a generated secret-shaped token has, read off its own prefix. */
function secretShapeOf(token: string): string {
  return SECRET_SHAPE_PREFIXES.find((prefix) => token.startsWith(prefix)) ?? 'jwt';
}

/** Every shape the shared generator draws, so the sample is asserted to have met each. */
const SECRET_SHAPES: readonly string[] = Object.freeze([...SECRET_SHAPE_PREFIXES, 'jwt']);

/** The single owner's patterns compiled flag-free; this file restates none of them. */
const SECRET_PATTERN_RES: readonly RegExp[] = SECRET_PATTERN_SOURCES.map(
  (source) => new RegExp(source),
);

/**
 * A credential a tool could echo, from the SHARED secret generator, embedded in a diagnostic line.
 *
 * `leaks` is the generated token itself, so the assertion is over the exact text planted and cannot
 * pass by agreeing with a broken pattern. The generator is `secretShapedTokenArbitrary` and no
 * second one: its `AKIA` body is drawn from the base32 alphabet the pattern requires, which is the
 * mistake a hand-written generator makes (a body containing 0, 1, 8 or 9 is not an access key and
 * would be reported as a "leak" the pattern never claimed to catch).
 */
function arbSecretPayload(): fc.Arbitrary<AdversarialPayload> {
  return secretShapedTokenArbitrary().map((token) => ({
    text: `credential rejected: ${token} (not retried)`,
    leaks: [token],
    secretShape: secretShapeOf(token),
  }));
}

function arbPlantedDiagnostic(): fc.Arbitrary<PlantedDiagnostic> {
  return fc.record<PlantedDiagnostic>({
    payloads: fc
      .tuple(
        // Spread to a mutable copy: `fc.subarray`'s parameter is `T[]`, not `readonly T[]`.
        fc.subarray([...ADVERSARIAL_PAYLOADS], { minLength: 1 }),
        fc.option(arbSecretPayload(), { nil: null }),
      )
      .map(([fixed, secret]) => (secret === null ? fixed : [...fixed, secret])),
    overLength: fc.boolean(),
  });
}

/**
 * The text planted on one stream: optional filler, the payloads, and a closing line naming the job.
 *
 * The filler goes FIRST, because the surfaced text is the TAIL: the payloads then stay inside the
 * window the bound keeps, so their absence is redaction at work rather than truncation. The closing
 * line is the attribution marker, and it is the pre-pass's frontend `ERROR:` line where the case
 * scripts a frontend rejection, because that line is what the adapter attributes by.
 */
function plantedText(planted: PlantedDiagnostic, closingLine: string): string {
  const filler = planted.overLength
    ? Array.from({ length: OVERFLOW_LINES }, () => OVERFLOW_LINE)
    : [];
  return [...filler, ...planted.payloads.map((payload) => payload.text), closingLine].join('\n');
}

/** How a scripted pre-pass answers: a derived contract, two refusals, or one of four failures. */
type PrepassAnswer =
  | { readonly kind: 'derived'; readonly contract: ResetContract }
  | { readonly kind: 'refused' }
  | { readonly kind: 'clock-unsupported'; readonly clockPolarity: 'negedge' | 'mixed' }
  | { readonly kind: 'unreadable'; readonly text: string }
  | { readonly kind: 'killed' | 'frontend' | 'crash' };

/** Report texts the pre-pass parse must refuse: not JSON, schema-invalid, and empty. */
const UNREADABLE_PREPASS_TEXTS: readonly string[] = Object.freeze([
  '{"reset": ',
  JSON.stringify({ clockPolarity: 'sometimes' }),
  '',
]);

/** Every pre-pass answer. A derived contract is weighted up so rungs are submitted on most cases. */
function arbPrepassAnswer(): fc.Arbitrary<PrepassAnswer> {
  return fc.oneof(
    {
      weight: 4,
      arbitrary: arbResetContract().map((contract): PrepassAnswer => ({
        kind: 'derived',
        contract,
      })),
    },
    { weight: 1, arbitrary: fc.constant<PrepassAnswer>({ kind: 'refused' }) },
    {
      weight: 1,
      arbitrary: fc
        .constantFrom('negedge', 'mixed')
        .map((clockPolarity): PrepassAnswer => ({ kind: 'clock-unsupported', clockPolarity })),
    },
    {
      weight: 1,
      arbitrary: fc
        .constantFrom(...UNREADABLE_PREPASS_TEXTS)
        .map((text): PrepassAnswer => ({ kind: 'unreadable', text })),
    },
    { weight: 1, arbitrary: fc.constant<PrepassAnswer>({ kind: 'killed' }) },
    { weight: 1, arbitrary: fc.constant<PrepassAnswer>({ kind: 'frontend' }) },
    { weight: 1, arbitrary: fc.constant<PrepassAnswer>({ kind: 'crash' }) },
  );
}

/** A derived contract under which a `clock-unsupported` document is otherwise well formed. */
const ASYNC_RESET: ResetContract = Object.freeze({
  derived: true,
  resetName: 'rst_n',
  resetActiveLow: true,
  resetKind: 'async',
  initialStateFree: true,
});

/** The pre-pass stderr's closing line: the frontend `ERROR:` line, or a plain marker line. */
function prepassClosingLine(answer: PrepassAnswer): string {
  return answer.kind === 'frontend'
    ? `design.v:17: ERROR: Found non-synthesizable event list! ${PREPASS_MARKER}`
    : `${PREPASS_MARKER}: the pre-pass stopped`;
}

/** The scripted run for the `formalPrepass` job, carrying the planted stderr whatever it answers. */
function prepassRunFor(
  answer: PrepassAnswer,
  job: SandboxJob,
  stderr: string,
  elapsedMs: number,
): ScriptedRun {
  switch (answer.kind) {
    case 'derived':
      return completed(elapsedMs, prepassArtifacts(prepassDocumentFor(answer.contract)), stderr);
    case 'refused':
      // A refused reset on a design that DOES hold clocked state: `reset-contract-unresolved`.
      return completed(
        elapsedMs,
        prepassArtifacts({
          reset: { derived: false },
          clockPolarity: 'posedge',
          initialStatePredicate: 'true',
        }),
        stderr,
      );
    case 'clock-unsupported':
      return completed(
        elapsedMs,
        prepassArtifacts({
          ...prepassDocumentFor(ASYNC_RESET),
          clockPolarity: answer.clockPolarity,
        }),
        stderr,
      );
    case 'unreadable':
      return completed(elapsedMs, { [PREPASS_REPORT_KEY]: answer.text }, stderr);
    case 'killed':
      // A killed run with a partial stream is representable at the seam, so it is planted too.
      return killedAtCap(job, {}, stderr);
    case 'frontend':
      return completed(elapsedMs, {}, stderr, 1);
    case 'crash':
      return completed(elapsedMs, {}, stderr, 127);
    default: {
      const unreachable: never = answer;
      return unreachable;
    }
  }
}

/**
 * Module names the seam's identifier rule refuses, each carrying one sentinel.
 *
 * A statement break, a smuggled pass flag, a newline, and a plain identifier past the 128-character
 * bound. Each would reach `prep -top` on the pre-pass and the wrapper's instantiation line if
 * `#submit` let it through.
 */
const HOSTILE_MODULE_SENTINEL = 'zq_hostile_module_zq';

const HOSTILE_MODULE_NAMES: readonly string[] = Object.freeze([
  `counter_12; endmodule module ${HOSTILE_MODULE_SENTINEL}`,
  `counter_12 -flatten ${HOSTILE_MODULE_SENTINEL}`,
  `${HOSTILE_MODULE_SENTINEL}\nmodule evil`,
  `${HOSTILE_MODULE_SENTINEL}${'m'.repeat(120)}`,
]);

/** The sentinel candidate text `index` carries, unique per candidate and dialect-safe as a name. */
function candidateSentinel(index: number): string {
  return `zq_unvetted_${String(index)}_zq`;
}

/** The sentinel a hostile `id` or `criterionRef` on base property `index` carries. */
function labelSentinel(index: number): string {
  return `zq_label_${String(index)}_zq`;
}

/** One generated containment case: a request, a scripted sandbox, and what it plants. */
interface ContainmentCase {
  readonly caps: FormalResourceCaps;
  readonly budgetMs: number;
  readonly design: SourceFile;
  readonly designInterface: ModuleInterface;
  /** A module name the seam refuses, standing in for the interface's own, or `null`. */
  readonly hostileModuleName: string | null;
  readonly baseProperties: readonly FormalProperty[];
  /** Model-authored candidate texts, each offered to the Property_Validator with a sentinel. */
  readonly candidates: readonly string[];
  /** Whether the base properties' `id` and `criterionRef` carry hostile text. */
  readonly hostileLabels: boolean;
  readonly prepass: PrepassAnswer;
  readonly formalAnswers: readonly FormalAnswer[];
  /** The share of its cap each non-spending run takes, by job ordinal, cycling. */
  readonly shares: readonly number[];
  readonly planted: PlantedDiagnostic;
}

/** Caps of every legal shape the seam admits: fractional cores, and integers from 1 upward. */
function arbCaps(): fc.Arbitrary<FormalResourceCaps> {
  return (
    fc
      .record<FormalResourceCaps>({
        cpu: fc.integer({ min: 1, max: 6_400 }).map((hundredths) => hundredths / 100),
        memMb: fc.integer({ min: 1, max: 65_536 }),
        procs: fc.integer({ min: 1, max: 4_096 }),
        diskMb: fc.integer({ min: 1, max: 65_536 }),
      })
      // Plain rather than `fc.record`'s null prototype, for the strict comparison (see above).
      .map(({ cpu, memMb, procs, diskMb }): FormalResourceCaps => ({ cpu, memMb, procs, diskMb }))
  );
}

function arbContainmentCase(): fc.Arbitrary<ContainmentCase> {
  return fc.record<ContainmentCase>({
    caps: arbCaps(),
    budgetMs: fc.integer({ min: 1, max: MAX_GENERATED_BUDGET_MS }),
    design: arbDesignSource(),
    designInterface: arbDesignInterface(),
    hostileModuleName: fc.oneof(
      { weight: 7, arbitrary: fc.constant<string | null>(null) },
      { weight: 1, arbitrary: fc.constantFrom(...HOSTILE_MODULE_NAMES) },
    ),
    baseProperties: fc.array(arbFormalProperty(), { minLength: 1, maxLength: 2 }),
    candidates: fc.array(arbPropertyText(), { maxLength: 3 }),
    hostileLabels: fc.boolean(),
    prepass: arbPrepassAnswer(),
    formalAnswers: fc.array(arbAnyFormalAnswer(), { minLength: 1, maxLength: 6 }),
    shares: fc.array(arbShare(), { minLength: 1, maxLength: 4 }),
    planted: arbPlantedDiagnostic(),
  });
}

/** The request one case submits, and every text that must never reach a submitted job. */
interface ContainedRequest {
  readonly designInterface: ModuleInterface;
  readonly properties: readonly FormalProperty[];
  /** Sentinels of text that never passed a validator: none may appear in any submitted job. */
  readonly forbidden: readonly string[];
  /** Sentinels of candidate text the Property_Validator ADMITTED: the positive control. */
  readonly admitted: readonly string[];
}

/**
 * Build the Property_Set the way any caller must: every candidate text goes through
 * `validateExpression`, the ONLY constructor of the `ValidatedExpression` brand a `FormalProperty`
 * field requires, so a refused candidate cannot become a property at all and only its sentinel is
 * kept, to be looked for. The base properties are validated by construction, and on a hostile case
 * their two plain-string labels carry text no validator ever saw.
 */
function containedRequestOf(c: ContainmentCase): ContainedRequest {
  const forbidden: string[] = [];
  const admitted: string[] = [];
  const properties: FormalProperty[] = c.baseProperties.map((property, index) => {
    if (!c.hostileLabels) {
      return property;
    }
    forbidden.push(labelSentinel(index));
    return {
      ...property,
      id: `p${String(index)} */ endmodule module ${labelSentinel(index)}; /*`,
      criterionRef: `ac-${String(index)}"\n\`define ${labelSentinel(index)}`,
    };
  });
  c.candidates.forEach((candidate, index) => {
    const sentinel = candidateSentinel(index);
    const validated = validateExpression(`${candidate} && ${sentinel}`);
    if (!validated.ok) {
      forbidden.push(sentinel);
      return;
    }
    admitted.push(sentinel);
    const id = `d${String(index)}`;
    properties.push({ kind: 'combinational', id, criterionRef: id, consequent: validated.value });
  });
  if (c.hostileModuleName !== null) {
    forbidden.push(HOSTILE_MODULE_SENTINEL);
  }
  const designInterface =
    c.hostileModuleName === null
      ? c.designInterface
      : { ...c.designInterface, moduleName: c.hostileModuleName };
  return { designInterface, properties, forbidden, admitted };
}

/**
 * The pre-pass answers as the case scripts it and each rung by its ordinal, every stream planted.
 *
 * A non-spending run takes a share of its cap, so later jobs see smaller `wallMs` values and the
 * bound below is asserted over a spread of them rather than over the budget itself every time.
 */
function containmentScript(c: ContainmentCase): RunScript {
  let ordinal = 0;
  let formalOrdinal = 0;
  return (job) => {
    const elapsedMs = partialOf(job, c.shares[ordinal % c.shares.length] ?? 0);
    ordinal += 1;
    if (job.kind === 'formalPrepass') {
      const stderr = plantedText(c.planted, prepassClosingLine(c.prepass));
      return prepassRunFor(c.prepass, job, stderr, elapsedMs);
    }
    const answer = c.formalAnswers[formalOrdinal % c.formalAnswers.length] ?? { kind: 'proved' };
    formalOrdinal += 1;
    const stderr = plantedText(c.planted, `${FORMAL_MARKER}: the rung stopped`);
    return formalRunFor(answer, job, stderr, elapsedMs);
  };
}

/** The four caps of one submitted `limits`, in the shape they were injected in. */
function capsOf(job: SandboxJob): FormalResourceCaps {
  const { cpu, memMb, procs, diskMb } = job.limits;
  return { cpu, memMb, procs, diskMb };
}

/**
 * Every submitted job carries all four caps and a bounded wall clock, and the spec the REAL
 * Tool_Runner handed the runtime for it denies the network and mounts no secret (Req 11.1, 11.3,
 * 11.4, 14.25). Asserted per job, so a pre-pass that alone lost a cap or gained a network fails.
 */
function assertEveryJobContained(
  runner: CapturingToolRunner,
  caps: FormalResourceCaps,
  budgetMs: number,
): void {
  // Every job the adapter submitted reached the runtime: the real seam validation accepted it.
  expect(runner.specs).toHaveLength(runner.jobs.length);
  runner.jobs.forEach((job, index) => {
    expect(['formalPrepass', 'formal']).toContain(job.kind);
    expect(Object.keys(job.limits).sort()).toEqual(LIMIT_KEYS);
    expect(capsOf(job)).toStrictEqual(caps);
    expect(Number.isSafeInteger(job.limits.wallMs)).toBe(true);
    expect(job.limits.wallMs).toBeGreaterThanOrEqual(1);
    expect(job.limits.wallMs).toBeLessThanOrEqual(budgetMs);
    const spec = runner.specs[index];
    // The two facts Req 11.4 names, against LITERALS, so a weakened policy constant cannot pass.
    expect(spec?.network).toBe('none');
    expect(spec?.mountSecrets).toBe(false);
    // And the whole spec is the frozen policy plus THIS job's limits, for every kind alike.
    expect(spec).toStrictEqual({ ...EXPECTED_ISOLATION, limits: job.limits });
  });
  // Nothing was read that a run did not hand back (Req 11.2).
  for (const artifact of runner.reads) {
    expect(runner.issued(artifact)).toBe(true);
  }
}

/**
 * Every surfaced diagnostic is bounded and carries none of the planted tokens (Req 11.6, 14.25).
 *
 * Over EVERY result, so a pre-pass refusal's diagnostic - which every property of the set carries -
 * and a rung's are held to the one rule alike. Returns which job kinds' diagnostics were seen, by
 * their closing marker, so the non-vacuity counters know the rule met both.
 */
function assertDiagnosticsSanitized(
  results: readonly PropertyResult[],
  planted: PlantedDiagnostic,
): { readonly prepassShown: boolean; readonly formalShown: boolean } {
  let prepassShown = false;
  let formalShown = false;
  for (const result of results) {
    const shown = diagnosticOf(result) ?? '';
    const arrived = shown.includes(PREPASS_MARKER) || shown.includes(FORMAL_MARKER);
    expect(shown.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_CHARS);
    for (const payload of planted.payloads) {
      for (const leak of payload.leaks) {
        expect(shown).not.toContain(leak);
      }
      // Only where the tail provably arrived: a diagnostic that carries none of the case's text
      // (a `proved` result has none) says nothing about what replaced a leak.
      for (const surfaced of arrived ? (payload.surfaces ?? []) : []) {
        expect(shown).toContain(surfaced);
      }
    }
    // THE SECRET CLAUSE, stated over the Secret_Pattern_Set itself and not over the planted tokens
    // alone: no match of ANY pattern in the single owner's set survives in a surfaced diagnostic
    // (Req 11.6, 11.20). The patterns are flag-free, so `test` on these is not stateful.
    for (const pattern of SECRET_PATTERN_RES) {
      expect(shown).not.toMatch(pattern);
    }
    prepassShown ||= shown.includes(PREPASS_MARKER);
    formalShown ||= shown.includes(FORMAL_MARKER);
  }
  return { prepassShown, formalShown };
}

/**
 * No text that never passed a validator reaches any submitted job (Req 11.9).
 *
 * Over the WHOLE job serialized, not only its workspace files, so the `topModule` that becomes a
 * command-line argument inside the sandbox is held to the same rule as the files.
 */
function assertNothingUnvalidatedSubmitted(
  jobs: readonly SandboxJob[],
  forbidden: readonly string[],
): void {
  for (const job of jobs) {
    const submitted = JSON.stringify(job);
    for (const text of forbidden) {
      expect(submitted).not.toContain(text);
    }
  }
}

/**
 * NUM_RUNS - sized to the rarest required shape, a case whose ladder climbed past its first rung.
 * Rungs are submitted only under a derived pre-pass (4/10) with a module name the seam admits (7/8),
 * and only an antecedent-bearing base property (1/3) can escalate, so it is the thin one: MEASURED
 * over three 400-run samples at 17, 24, and 25 cases, about 4%. At 600 runs the miss probability is
 * `0.96^600` ~ 2e-11. The next rarest, an admitted candidate seen arriving, measured at 8% to 12%;
 * each non-derived pre-pass answer is 1/10 of the weight, so `0.9^600` ~ 3e-28 misses one.
 */
const CONTAINMENT_NUM_RUNS = 600;

/** Every pre-pass answer kind, so the sample is asserted to have met each one. */
const PREPASS_ANSWER_KINDS: readonly PrepassAnswer['kind'][] = Object.freeze([
  'derived',
  'refused',
  'clock-unsupported',
  'unreadable',
  'killed',
  'frontend',
  'crash',
]);

/** What one Property 24 case contributed to the non-vacuity counters. */
interface ContainmentTally {
  prepassJobs: number;
  formalJobs: number;
  escalatedRuns: number;
  prepassDiagnostics: number;
  formalDiagnostics: number;
  overLengthDiagnostics: number;
  forbiddenOffered: number;
  admittedArrived: number;
  hostileModuleRuns: number;
  reads: number;
  /** Cases whose secret-named-host payload was planted on a diagnostic that arrived. */
  hostLeakArrived: number;
  readonly prepassKinds: Set<PrepassAnswer['kind']>;
  /** The secret shapes planted on a diagnostic that arrived. */
  readonly secretShapesArrived: Set<string>;
}

function emptyTally(): ContainmentTally {
  return {
    prepassJobs: 0,
    formalJobs: 0,
    escalatedRuns: 0,
    prepassDiagnostics: 0,
    formalDiagnostics: 0,
    overLengthDiagnostics: 0,
    forbiddenOffered: 0,
    admittedArrived: 0,
    hostileModuleRuns: 0,
    reads: 0,
    hostLeakArrived: 0,
    prepassKinds: new Set(),
    secretShapesArrived: new Set(),
  };
}

/** Fold one case's observations into the tally. Counting only; nothing here asserts. */
function tallyCase(
  tally: ContainmentTally,
  c: ContainmentCase,
  observed: {
    readonly runner: CapturingToolRunner;
    readonly request: ContainedRequest;
    readonly shown: { readonly prepassShown: boolean; readonly formalShown: boolean };
  },
): void {
  const { runner, request, shown } = observed;
  const formalJobs = runner.jobs.filter((job) => job.kind === 'formal').length;
  tally.prepassJobs += runner.jobs.length - formalJobs;
  tally.formalJobs += formalJobs;
  tally.escalatedRuns += formalJobs > request.properties.length ? 1 : 0;
  tally.prepassDiagnostics += shown.prepassShown ? 1 : 0;
  tally.formalDiagnostics += shown.formalShown ? 1 : 0;
  tally.overLengthDiagnostics +=
    c.planted.overLength && (shown.prepassShown || shown.formalShown) ? 1 : 0;
  tally.forbiddenOffered += request.forbidden.length > 0 && runner.jobs.length > 0 ? 1 : 0;
  const serialized = runner.jobs.map((job) => JSON.stringify(job)).join('\n');
  tally.admittedArrived += request.admitted.some((sentinel) => serialized.includes(sentinel))
    ? 1
    : 0;
  tally.hostileModuleRuns += c.hostileModuleName === null ? 0 : 1;
  tally.reads += runner.reads.length;
  tally.prepassKinds.add(c.prepass.kind);
  if (shown.prepassShown || shown.formalShown) {
    tally.hostLeakArrived += c.planted.payloads.some((payload) => payload.surfaces !== undefined)
      ? 1
      : 0;
    for (const payload of c.planted.payloads) {
      if (payload.secretShape !== undefined) {
        tally.secretShapesArrived.add(payload.secretShape);
      }
    }
  }
}

describe(PROPERTY_24, () => {
  it(
    'submits every job - the pre-pass and every rung - capped, network-denied, secret-free, sanitized, and validated',
    async () => {
      let total = 0;
      const tally = emptyTally();
      await fc.assert(
        fc.asyncProperty(arbContainmentCase(), async (c: ContainmentCase) => {
          total += 1;
          const request = containedRequestOf(c);
          const { runner, oracle } = harness(containmentScript(c), c.caps);

          const outcome = await oracle.proveSet({
            designSource: { ...c.design },
            designInterface: request.designInterface,
            properties: request.properties,
            budgetMs: c.budgetMs,
          });

          assertEveryJobContained(runner, c.caps, c.budgetMs);
          const shown = assertDiagnosticsSanitized(outcome.results, c.planted);
          assertNothingUnvalidatedSubmitted(runner.jobs, request.forbidden);
          tallyCase(tally, c, { runner, request, shown });
        }),
        propertyParameters({ numRuns: CONTAINMENT_NUM_RUNS }),
      );
      // Non-vacuity. The containment rule met BOTH job kinds, a ladder past its first rung, every
      // pre-pass answer, a surfaced diagnostic from EACH kind (one of them over the bound), refused
      // and unvalidated text offered on runs that did submit jobs, admitted text seen arriving - so
      // the absence of refused text is not an absence of everything - a seam-refused module name,
      // and real artifact reads for the read rule to hold over.
      expect(total).toBe(CONTAINMENT_NUM_RUNS);
      expect(tally.prepassJobs).toBeGreaterThan(0);
      expect(tally.formalJobs).toBeGreaterThan(0);
      expect(tally.escalatedRuns).toBeGreaterThan(0);
      expect(tally.prepassKinds).toEqual(new Set(PREPASS_ANSWER_KINDS));
      expect(tally.prepassDiagnostics).toBeGreaterThan(0);
      expect(tally.formalDiagnostics).toBeGreaterThan(0);
      expect(tally.overLengthDiagnostics).toBeGreaterThan(0);
      expect(tally.forbiddenOffered).toBeGreaterThan(0);
      expect(tally.admittedArrived).toBeGreaterThan(0);
      expect(tally.hostileModuleRuns).toBeGreaterThan(0);
      expect(tally.reads).toBeGreaterThan(0);
      // The secret clause met EVERY shape the shared generator draws on a diagnostic that arrived,
      // and the secret-named host on one - so "no secret survives" is not "no secret was planted".
      expect(tally.secretShapesArrived).toEqual(new Set(SECRET_SHAPES));
      expect(tally.hostLeakArrived).toBeGreaterThan(0);
    },
    SLOW_PROPERTY_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Property 9
// ---------------------------------------------------------------------------

/**
 * Where a property's window runs out, and how.
 *
 * `killed` is the sandbox's wall-clock kill at the job's cap. `exhausted` is a run that COMPLETES
 * exactly on the cap, so the next window check finds nothing left: on the pre-pass that leaves no
 * time for any rung, and on a rung it is an ESCALATING rung whose successor is never entered.
 */
type SpendPoint =
  | { readonly at: 'prepass'; readonly how: 'killed' | 'exhausted' }
  | { readonly at: 'rung'; readonly rung: number; readonly how: 'killed' | 'exhausted' };

/**
 * Every point this property's budget can be spent at, given the ladder it climbs.
 *
 * Read off the two owners of the facts it needs - `proofDepthsFor` for the ladder and
 * `coveredAntecedent` for whether an unreached cover can escalate at all (Req 4.7) - rather than
 * re-derived, and used only to pick a REACHABLE point: the expectation is `proof-timeout` at every
 * one of them, so nothing here predicts a verdict.
 */
function spendPointsFor(
  designInterface: ModuleInterface,
  property: FormalProperty,
): readonly SpendPoint[] {
  const rungs = proofDepthsFor(designInterface, property).length;
  const reachable = coveredAntecedent(property) === null ? 1 : rungs;
  const points: SpendPoint[] = [
    { at: 'prepass', how: 'killed' },
    { at: 'prepass', how: 'exhausted' },
  ];
  for (let rung = 0; rung < reachable; rung += 1) {
    points.push({ at: 'rung', rung, how: 'killed' });
    if (rung + 1 < reachable) {
      points.push({ at: 'rung', rung, how: 'exhausted' });
    }
  }
  return points;
}

/** The rung that would DECIDE the property if the budget were not spent. */
function decidingRungOf(point: SpendPoint): number {
  if (point.at === 'prepass') {
    return 0;
  }
  return point.how === 'killed' ? point.rung : point.rung + 1;
}

/** One generated timeout case: a request, the verdict its deciding rung reaches, and where it runs out. */
interface TimeoutCase {
  readonly design: SourceFile;
  readonly designInterface: ModuleInterface;
  readonly property: FormalProperty;
  readonly contract: ResetContract;
  readonly budgetMs: number;
  readonly decisive: DecisiveVerdict;
  /** Whether a KILLED run left behind the report it would have registered on completing. */
  readonly killLeavesReport: boolean;
  readonly shares: readonly number[];
  readonly point: SpendPoint;
}

function arbTimeoutCase(): fc.Arbitrary<TimeoutCase> {
  return fc
    .record({
      design: arbDesignSource(),
      designInterface: arbDesignInterface(),
      property: arbFormalProperty(),
      contract: arbResetContract(),
      budgetMs: fc.integer({ min: 1, max: MAX_GENERATED_BUDGET_MS }),
      decisive: fc.constantFrom(...DECISIVE_VERDICTS),
      killLeavesReport: fc.boolean(),
      shares: fc.array(arbShare(), { minLength: 1, maxLength: 4 }),
    })
    .chain((fields) =>
      fc
        .constantFrom(...spendPointsFor(fields.designInterface, fields.property))
        .map((point): TimeoutCase => ({ ...fields, point })),
    );
}

/** The run that SPENDS what is left: killed at its cap, or completing exactly on it. */
function spendingRun(
  how: SpendPoint['how'],
  job: SandboxJob,
  registered: Readonly<Record<string, string>>,
  killLeavesReport: boolean,
): ScriptedRun {
  return how === 'killed'
    ? killedAtCap(job, killLeavesReport ? registered : {})
    : completed(job.limits.wallMs, registered);
}

/**
 * The scripted sandbox for one timeout case, spending the budget at the case's point or not at all.
 *
 * Every rung before the deciding one ESCALATES, the deciding rung reaches the case's verdict, and
 * every run that does not spend takes a share of its cap that leaves at least 1ms. With `spend`
 * false this is the CONTROL: the same jobs, the same documents, and no window ever exhausted.
 */
function timeoutScript(c: TimeoutCase, spend: boolean): RunScript {
  const decidingRung = decidingRungOf(c.point);
  let ordinal = 0;
  let rung = -1;
  return (job) => {
    const elapsedMs = partialOf(job, c.shares[ordinal % c.shares.length] ?? 0);
    ordinal += 1;
    if (job.kind === 'formalPrepass') {
      const registered = prepassArtifacts(prepassDocumentFor(c.contract));
      return spend && c.point.at === 'prepass'
        ? spendingRun(c.point.how, job, registered, c.killLeavesReport)
        : completed(elapsedMs, registered);
    }
    rung += 1;
    const registered =
      rung < decidingRung
        ? reportArtifacts(ESCALATING_REPORT, job)
        : decisiveArtifacts(c.decisive, job);
    return spend && c.point.at === 'rung' && c.point.rung === rung
      ? spendingRun(c.point.how, job, registered, c.killLeavesReport)
      : completed(elapsedMs, registered);
  };
}

/** A short label for a spend point, for the coverage counters. */
function spendLabelOf(point: SpendPoint): string {
  if (point.at === 'prepass') {
    return `prepass-${point.how}`;
  }
  return `rung-${point.how}-${point.rung === 0 ? 'first' : 'later'}`;
}

/** Every spend label the sample must contain. `rung-exhausted-later` needs a ladder of three. */
const SPEND_LABELS: readonly string[] = Object.freeze([
  'prepass-killed',
  'prepass-exhausted',
  'rung-killed-first',
  'rung-killed-later',
  'rung-exhausted-first',
  'rung-exhausted-later',
]);

/**
 * NUM_RUNS - sized to the rarest required label. Only a property with an antecedent (1/3 of draws)
 * reaches a later rung, and it has seven reachable points, so each `rung-exhausted-*` label is
 * `(1/3) * (1/7)` ~ 4.8% of runs and `rung-killed-later` ~ 9.5%. MEASURED over three 500-run
 * samples, the two `rung-exhausted-*` labels landed 19 to 29 times each, 3.8% to 5.8%. At 500 runs
 * the miss probability for a 4.8% label is `0.952^500` ~ 2e-11. Each run is a controlled PAIR, so
 * this is 1000 proofs.
 */
const TIMEOUT_NUM_RUNS = 500;

describe(PROPERTY_9, () => {
  it(
    'reports proof-timeout, never proved or refuted, wherever the budget is spent, and decides once it is not',
    async () => {
      let total = 0;
      let leftReportBehind = 0;
      const labelsObserved = new Set<string>();
      const decisiveObserved = new Set<DecisiveVerdict>();
      await fc.assert(
        fc.asyncProperty(arbTimeoutCase(), async (c: TimeoutCase) => {
          total += 1;
          const request = {
            designSource: { ...c.design },
            designInterface: c.designInterface,
            property: c.property,
            budgetMs: c.budgetMs,
          };

          const timed = harness(timeoutScript(c, true));
          const result = await timed.oracle.prove(request);

          // NEITHER A PASS NOR A FAIL: `could-not-verify` with the cause `proof-timeout`, so never
          // `proved` (Req 7.3) and never `refuted` (Req 7.4), wherever it ran out (Req 7.2).
          expect({ verdict: result.verdict, cause: causeOf(result) }).toEqual({
            verdict: 'could-not-verify',
            cause: 'proof-timeout',
          });
          // GENUINELY SPENT, and never overrun: the clock ends EXACTLY on the budget, because every
          // job's `wallMs` was the window that was left (Req 7.1).
          expect(timed.clock.now()).toBe(c.budgetMs);

          // THE CONTROL: the identical script with no window exhausted decides as scripted, so the
          // spent budget is the only thing that kept this property from a verdict.
          const control = harness(timeoutScript(c, false));
          expect((await control.oracle.prove(request)).verdict).toBe(c.decisive);

          labelsObserved.add(spendLabelOf(c.point));
          decisiveObserved.add(c.decisive);
          leftReportBehind += c.killLeavesReport && c.point.how === 'killed' ? 1 : 0;
        }),
        propertyParameters({ numRuns: TIMEOUT_NUM_RUNS }),
      );
      // Non-vacuity: every point a window can run out at, both verdicts the timeout must withhold,
      // and a killed run that left a complete-looking report behind for the adapter to NOT read.
      expect(total).toBe(TIMEOUT_NUM_RUNS);
      expect(labelsObserved).toEqual(new Set(SPEND_LABELS));
      expect(decisiveObserved).toEqual(new Set(DECISIVE_VERDICTS));
      expect(leftReportBehind).toBeGreaterThan(0);
    },
    SLOW_PROPERTY_TIMEOUT_MS,
  );
});
