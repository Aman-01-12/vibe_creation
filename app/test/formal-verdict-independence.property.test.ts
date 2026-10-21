// formal-property-oracle, Property 18: Verdicts are per property and independent (task 8.6).
//
// WHAT IS CLAIMED, AND OVER WHAT
//   Every assertion is about the REAL `YosysSmtBmcFormalOracle.proveSet`, over generated
//   Property_Sets of one to four properties, a generated pre-pass answer, and a generated script of
//   tool answers per property. The adapter reaches the toolchain only through its injected
//   `ToolRunner`, which here is the REAL `SandboxToolRunner` over a scripted `FakeSandboxRuntime`, so
//   every result the adapter reads was classified and validated by the production seam.
//
//   1. ONE RESULT PER SUBMITTED PROPERTY, IN SUBMISSION ORDER (Req 1.11, 1.14). `results` and
//      `propertyWrapperSources` hold exactly one entry per submitted property, and result `i` names
//      property `i`'s criterion. Each generated property is relabelled with an id and a criterion
//      unique to its position, so a reordered, dropped, or duplicated result cannot pass by sharing a
//      label. Asserted on every pre-pass arm - derived, reset-refused, clock-refused, unreadable, and
//      a frontend rejection - because a refusal of the shared design is still reported per property.
//
//   2. NO CROSS-INFLUENCE, AS A CONTROLLED COMPARISON (Req 1.11, 1.14). Each case runs TWICE,
//      identical except that ONE property's scripted reports are replaced. Every OTHER property's
//      `PropertyResult` must be equal field for field, and so must every wrapper source and the three
//      run-level facts, which design.md's Property 18 makes functions of the candidate DESIGN alone.
//      That is criterion 1.14's sentence made executable: whatever the replaced property now reports,
//      a `could-not-verify` included, it decides nothing for the others.
//
// HOW A JOB IS TIED TO ITS PROPERTY WITHOUT RE-DERIVING ANYTHING
//   The double answers each `formal` job from the script of the property whose Property_Wrapper the
//   job carries, and counts rungs PER PROPERTY. Keying by submission ordinal would make the HARNESS
//   cross-influence the properties: replacing one script can change how many rungs that ladder
//   climbs, which would move every later property onto another property's answers. The
//   wrapper-to-property map is read off the `propertyWrapperSources` a DISCOVERY run of the same case
//   returned, and is never re-rendered here. That index pairing is pinned by
//   `formal-containment.property.test.ts` (Property 13: every rung of property `i` submits exactly
//   `propertyWrapperSources[i]`), and this file leans on it: a mispairing would answer one property's
//   jobs from another's script, which surfaces below as cross-influence. A set whose properties
//   render byte-identical wrappers cannot be told apart by any content-keyed double, so its order
//   clause is asserted and its comparison is skipped and counted.
//
//   TIME IS A CHANNEL, SO IT IS MODELLED. Every scripted run advances a `ManualClock` by its own
//   duration, a killed run takes its job's whole `wallMs`, and the budget is the production default.
//   One property's ladder fits its own window but several do not fit ONE window, so an adapter that
//   charged the set's elapsed time to each property would time a later property out exactly when an
//   earlier one's replacement ran longer. The clock models a SEQUENTIAL sandbox, which is how the
//   adapter submits.
//
//   ARTIFACT REFS ARE CONTENT-ADDRESSED - a real SHA-256 of the registered text - so a ref depends on
//   what was registered and never on how many registrations came first. A counter would let the
//   double itself carry one property's job count into another property's counterexample ref.
//
// WHAT THIS LEANS ON AND DOES NOT RE-ASSERT
//   - `app/tools/formal/adapter.test.ts`, '`proveSet` returns the run-level Formal_Outcome': ONE
//     pre-pass per set, a refusal reported once per property with `null` wrapper sources, the empty
//     set, and `prove` agreeing with `proveSet` over one element, each on a fixed example.
//   - `formal-containment.property.test.ts`, Property 13: the index pairing of the wrapper sources.
//   - `app/tools/formal/structural-claims.test.ts`, claim 1: the adapter runs nothing except through
//     the injected `ToolRunner`, which is what makes a scripted runner a complete stand-in.
//   The ladder's own rules are Property 8's and the budget's are Property 9's. Here they only have to
//   be the SAME rules for every property, whatever its neighbours reported.
//
// FALSIFIED, out of tree, against one-line mutants of the BUILT adapter
// (`chipAgent/_inbox/verification-recipe-falsify-a-test-against-a-one-line-mutant-of-the-built-dist-without-touching-shared-source.md`):
// charging each property the SET's elapsed time failed the comparison (an untouched property was
// `proof-timeout` beside one script and `toolchain-unavailable` beside its replacement, because only
// its neighbour's time had changed); `unshift` for `push` on the results failed the
// order clause; `unshift` on the wrapper sources failed the comparison through the attribution; and
// rendering every property's wrapper from the first property failed ONLY the `compared` guard,
// because every multi-property set then read as indistinguishable. The unmutated copy passed.
//
// RUN COUNTS are sized to the rarest required row; the arithmetic sits beside the constant
// (`chipAgent/_inbox/verification-recipe-every-row-coverage-needs-numruns-scaled-to-the-table.md`).
//
// The tag string is a literal, not `propertyTag(...)`, whose `FEATURE_TAG` is hardcoded to a
// different spec (`chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`).
//
// **Validates: Requirements 1.11, 1.14**

import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ModuleInterface } from '@app/core';
import {
  COUNTEREXAMPLE_ARTIFACT_KEY,
  DEFAULT_PROPERTY_TIME_BUDGET_MS,
  FakeSandboxRuntime,
  FORMAL_VERDICTS,
  PROPERTY_WRAPPER_FILE_NAME,
  SandboxToolRunner,
  YosysSmtBmcFormalOracle,
  type ArtifactBlobRef,
  type FormalArtifactReader,
  type FormalCheckReport,
  type FormalChecksReport,
  type FormalOutcome,
  type FormalPrepassDocument,
  type FormalProperty,
  type FormalReport,
  type FormalResourceCaps,
  type FormalVerdict,
  type PropertyResult,
  type RawRunCapture,
  type RequiredOutput,
  type ResetContract,
  type SandboxJob,
  type SourceFile,
} from '@app/tools';

import {
  arbDesignInterface,
  arbFormalProperty,
  arbFormalReport,
  arbResetContract,
} from './formal-arbitraries.js';
import { propertyParameters } from './property.js';

// **Feature: formal-property-oracle, Property 18: Verdicts are per property and independent**
const PROPERTY_18 =
  'formal-property-oracle, Property 18: Verdicts are per property and independent';

/** Headroom for a few-hundred-case async property on a shared runner; nothing depends on it. */
const SLOW_PROPERTY_TIMEOUT_MS = 60_000;

/** The four caps every job carries. Containment is Property 24's; any valid set serves here. */
const CAPS: FormalResourceCaps = Object.freeze({ cpu: 1, memMb: 512, procs: 64, diskMb: 64 });

/** The production Property_Time_Budget, so "one ladder fits, several do not" is the real shape. */
const BUDGET_MS = DEFAULT_PROPERTY_TIME_BUDGET_MS;

/** The largest generated Property_Set. */
const MAX_SET_SIZE = 4;

/**
 * Draws for the replaced position. `slot % size` is UNIFORM because 12 is a multiple of every
 * size from 1 to `MAX_SET_SIZE`.
 */
const PERTURB_SLOTS = 12;

/** The longest scripted pre-pass, in milliseconds. */
const MAX_PREPASS_MS = 20_000;

/**
 * The longest scripted rung that runs to completion, in milliseconds.
 *
 * Sized against the 150s budget: one rung never spends a window on its own, three can, and two
 * properties' ladders together routinely exceed one window - the shape that exposes a shared one.
 */
const MAX_RUNG_MS = 60_000;

/** At most this many scripted answers per property; a ladder past the last one repeats it. */
const MAX_SCRIPTED_RUNGS = 3;

/** The artifact keys the worker registers the two reports under: the jobs' own required outputs. */
const PREPASS_REPORT_KEY = 'formalPrepassReport' satisfies RequiredOutput;
const FORMAL_REPORT_KEY = 'formalReport' satisfies RequiredOutput;

/** The candidate design. Nothing reads its text, and its path is not the wrapper's. */
const DESIGN: SourceFile = Object.freeze({
  path: 'design.v',
  contents: 'module design(input clk, input rst_n, output reg [3:0] out); endmodule\n',
});

/** A counterexample trace's text, registered beside a refutation. No assertion reads its bytes. */
const TRACE_TEXT = '$date today $end\n$var wire 1 ! out $end\n#0\n0!\n';

/** A balanced, non-`true` initial-state predicate: the design's step 0 is PINNED, not free. */
const PINNED_INITIAL_STATE = '(= ((|m_n q| state)) #b1)';

/** MEASURED Yosys 0.66 frontend error over `verified_float_multi.v`, as the pre-pass meets it. */
const FRONTEND_STDERR = 'design.v:17: ERROR: Found non-synthesizable event list!';

/** A pre-pass report the parse must refuse: truncated JSON. */
const UNREADABLE_PREPASS_TEXT = '{"reset": ';

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

/** All five conditions hold: `proved` for any property. */
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

/** Induction FAILED over a passing base case: `induction-engine-incomplete`, never escalated. */
const ENGINE_INCOMPLETE_REPORT = formalReport({
  base: PASSED_CHECK,
  cover: REACHED_COVER,
  induct: FAILED_CHECK,
});

/** A derived contract under which a clock-refused document is otherwise well formed. */
const ASYNC_RESET: ResetContract = Object.freeze({
  derived: true,
  resetName: 'rst_n',
  resetActiveLow: true,
  resetKind: 'async',
  initialStateFree: true,
});

/**
 * The pre-pass document that derives `contract`, as the worker would write it.
 *
 * A refused contract is written as the ADMITTED no-clocked-state arm - `clockPolarity: 'none'` -
 * because that is the one refused reset a wrapper is still rendered under (Req 14.40).
 */
function prepassDocumentFor(contract: ResetContract): FormalPrepassDocument {
  if (!contract.derived) {
    return {
      reset: { derived: false },
      clockPolarity: 'none',
      initialStatePredicate: null,
      timing: { derived: true, ports: [] },
    };
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
    // Required on the wire; these properties are about the reset and the wrapper, not timing.
    timing: { derived: true, ports: [] },
  };
}

/** The pre-pass report registration for one document. */
function prepassArtifacts(document: FormalPrepassDocument): Record<string, string> {
  return { [PREPASS_REPORT_KEY]: JSON.stringify(document) };
}

/** The artifacts a `formal` run registers for one report, plus its trace where it has one. */
function reportArtifacts(report: FormalReport, withTrace = false): Record<string, string> {
  const registered: Record<string, string> = { [FORMAL_REPORT_KEY]: JSON.stringify(report) };
  if (withTrace) {
    registered[COUNTEREXAMPLE_ARTIFACT_KEY] = TRACE_TEXT;
  }
  return registered;
}

// ---------------------------------------------------------------------------
// What a scripted run does, and the generated scripts
// ---------------------------------------------------------------------------

/** What the scripted sandbox does with one job: how long it takes, and what it leaves behind. */
interface ScriptedRun {
  readonly elapsedMs: number;
  /** Whether the run was KILLED at its wall-clock cap. */
  readonly timedOut: boolean;
  readonly exitCode: number | null;
  /** `null` is what a wall-clock kill leaves behind: no stream at all. */
  readonly stderr: string | null;
  /** The text of each artifact the run registered, by the key the worker registers it under. */
  readonly registered: Readonly<Record<string, string>>;
}

/** A run that ran to completion inside its cap. */
function completed(
  elapsedMs: number,
  registered: Readonly<Record<string, string>>,
  exitCode = 0,
  stderr = '',
): ScriptedRun {
  return { elapsedMs, timedOut: false, exitCode, stderr, registered };
}

/** The scripted answers whose report is fixed above. `killed` takes its job's whole cap. */
type FixedRungKind =
  'proved' | 'refuted' | 'escalating' | 'engine-incomplete' | 'no-report' | 'killed';

/** How one scripted `formal` rung answers. `generated` is any schema-valid report at all. */
type RungAnswer =
  | { readonly kind: FixedRungKind; readonly elapsedMs: number }
  | {
      readonly kind: 'generated';
      readonly report: FormalReport;
      readonly withTrace: boolean;
      readonly elapsedMs: number;
    };

/** One property's script: rung `r` of its ladder answers `rungs[min(r, last)]`. */
interface PropertyScript {
  readonly rungs: readonly RungAnswer[];
}

/** The scripted run for one `formal` rung. */
function rungRunFor(answer: RungAnswer, job: SandboxJob): ScriptedRun {
  switch (answer.kind) {
    case 'proved':
      return completed(answer.elapsedMs, reportArtifacts(PROVING_REPORT));
    case 'refuted':
      return completed(answer.elapsedMs, reportArtifacts(REFUTING_REPORT, true));
    case 'escalating':
      return completed(answer.elapsedMs, reportArtifacts(ESCALATING_REPORT));
    case 'engine-incomplete':
      return completed(answer.elapsedMs, reportArtifacts(ENGINE_INCOMPLETE_REPORT));
    case 'no-report':
      return completed(answer.elapsedMs, {}, 1);
    case 'killed':
      return {
        elapsedMs: job.limits.wallMs,
        timedOut: true,
        exitCode: null,
        stderr: null,
        registered: {},
      };
    case 'generated':
      return completed(answer.elapsedMs, reportArtifacts(answer.report, answer.withTrace));
    default: {
      // Exhaustiveness: a new answer must be scripted explicitly.
      const unreachable: never = answer;
      return unreachable;
    }
  }
}

/**
 * One rung's answer.
 *
 * `escalating` carries extra weight because it is the answer that makes a ladder climb, and a
 * replaced script that changes how many rungs a ladder climbs is the row a submission-ordinal
 * coupling or a shared time window needs in order to show.
 */
function arbRungAnswer(): fc.Arbitrary<RungAnswer> {
  const elapsedMs = fc.integer({ min: 0, max: MAX_RUNG_MS });
  const fixed = (kind: FixedRungKind, weight: number) => ({
    weight,
    arbitrary: elapsedMs.map((ms): RungAnswer => ({ kind, elapsedMs: ms })),
  });
  return fc.oneof(
    fixed('escalating', 3),
    fixed('proved', 2),
    fixed('refuted', 2),
    fixed('engine-incomplete', 1),
    fixed('no-report', 1),
    fixed('killed', 1),
    {
      weight: 2,
      arbitrary: fc
        .tuple(arbFormalReport(), fc.boolean(), elapsedMs)
        .map(([report, withTrace, ms]): RungAnswer => ({
          kind: 'generated',
          report,
          withTrace,
          elapsedMs: ms,
        })),
    },
  );
}

function arbPropertyScript(): fc.Arbitrary<PropertyScript> {
  return fc
    .array(arbRungAnswer(), { minLength: 1, maxLength: MAX_SCRIPTED_RUNGS })
    .map((rungs): PropertyScript => ({ rungs }));
}

/** How the ONE shared pre-pass answers: a derived contract, two refusals, or two failures. */
type PrepassAnswer =
  | { readonly kind: 'derived'; readonly contract: ResetContract }
  | { readonly kind: 'reset-refused' | 'unreadable' | 'frontend-rejected' }
  | { readonly kind: 'clock-refused'; readonly clockPolarity: 'negedge' | 'mixed' };

/** Every pre-pass arm. A derived contract is weighted up, because it is what renders wrappers. */
function arbPrepassAnswer(): fc.Arbitrary<PrepassAnswer> {
  return fc.oneof(
    {
      weight: 8,
      arbitrary: arbResetContract().map((contract): PrepassAnswer => ({
        kind: 'derived',
        contract,
      })),
    },
    { weight: 1, arbitrary: fc.constant<PrepassAnswer>({ kind: 'reset-refused' }) },
    {
      weight: 1,
      arbitrary: fc
        .constantFrom<'negedge' | 'mixed'>('negedge', 'mixed')
        .map((clockPolarity): PrepassAnswer => ({ kind: 'clock-refused', clockPolarity })),
    },
    { weight: 1, arbitrary: fc.constant<PrepassAnswer>({ kind: 'unreadable' }) },
    { weight: 1, arbitrary: fc.constant<PrepassAnswer>({ kind: 'frontend-rejected' }) },
  );
}

/**
 * Every pre-pass arm's kind, as a TOTAL record, so an arm added to the union above is a compile
 * error here rather than an arm the non-vacuity check silently never asks about.
 */
const PREPASS_KIND_SET: Readonly<Record<PrepassAnswer['kind'], true>> = Object.freeze({
  derived: true,
  'reset-refused': true,
  'clock-refused': true,
  unreadable: true,
  'frontend-rejected': true,
});

const PREPASS_KINDS = Object.freeze(
  Object.keys(PREPASS_KIND_SET),
) as readonly PrepassAnswer['kind'][];

/** The scripted run for the one `formalPrepass` job. */
function prepassRunFor(answer: PrepassAnswer, elapsedMs: number): ScriptedRun {
  switch (answer.kind) {
    case 'derived':
      return completed(elapsedMs, prepassArtifacts(prepassDocumentFor(answer.contract)));
    case 'reset-refused':
      // A refused reset on a design that DOES hold clocked state: `reset-contract-unresolved`.
      return completed(
        elapsedMs,
        prepassArtifacts({
          reset: { derived: false },
          clockPolarity: 'posedge',
          initialStatePredicate: 'true',
          timing: { derived: true, ports: [] },
        }),
      );
    case 'clock-refused':
      return completed(
        elapsedMs,
        prepassArtifacts({
          ...prepassDocumentFor(ASYNC_RESET),
          clockPolarity: answer.clockPolarity,
        }),
      );
    case 'unreadable':
      return completed(elapsedMs, { [PREPASS_REPORT_KEY]: UNREADABLE_PREPASS_TEXT });
    case 'frontend-rejected':
      return completed(elapsedMs, {}, 1, FRONTEND_STDERR);
    default: {
      const unreachable: never = answer;
      return unreachable;
    }
  }
}

/** One generated case: a design, a labelled Property_Set, its scripts, and the one replacement. */
interface IndependenceCase {
  readonly designInterface: ModuleInterface;
  readonly properties: readonly FormalProperty[];
  /** One script per property, paired by index. */
  readonly scripts: readonly PropertyScript[];
  readonly prepass: PrepassAnswer;
  readonly prepassElapsedMs: number;
  /** The ONE position whose script the second run replaces. */
  readonly perturbedIndex: number;
  readonly replacement: PropertyScript;
}

/** A generated property relabelled with an id and a criterion unique to its position. */
function labelled(property: FormalProperty, index: number): FormalProperty {
  return { ...property, id: `p${index + 1}`, criterionRef: `AC-${index + 1}` };
}

function arbIndependenceCase(): fc.Arbitrary<IndependenceCase> {
  return (
    fc
      .record({
        designInterface: arbDesignInterface(),
        size: fc.integer({ min: 1, max: MAX_SET_SIZE }),
        // A full-size pool, cut to `size` below, so the set size is uniform rather than whatever
        // length distribution `fc.array` prefers.
        pool: fc.array(fc.tuple(arbFormalProperty(), arbPropertyScript()), {
          minLength: MAX_SET_SIZE,
          maxLength: MAX_SET_SIZE,
        }),
        prepass: arbPrepassAnswer(),
        prepassElapsedMs: fc.integer({ min: 0, max: MAX_PREPASS_MS }),
        perturbSlot: fc.integer({ min: 0, max: PERTURB_SLOTS - 1 }),
        replacement: arbPropertyScript(),
      })
      // Rebuilt as a plain object: `fc.record` builds NULL-PROTOTYPE objects
      // (`chipAgent/_inbox/gotcha-fc-record-builds-null-prototype-objects-so-tostrictequal-fails-with-no-visual-difference.md`).
      .map((drawn): IndependenceCase => {
        const entries = drawn.pool.slice(0, drawn.size);
        return {
          designInterface: drawn.designInterface,
          properties: entries.map(([property], index) => labelled(property, index)),
          scripts: entries.map(([, script]) => script),
          prepass: drawn.prepass,
          prepassElapsedMs: drawn.prepassElapsedMs,
          perturbedIndex: drawn.perturbSlot % drawn.size,
          replacement: drawn.replacement,
        };
      })
  );
}

// ---------------------------------------------------------------------------
// The scripted double: the real Tool_Runner over a scripted runtime, on a clock the test owns
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

/**
 * The run's `FormalArtifactReader`, resolving refs it issued by their SHA-256.
 *
 * CONTENT-ADDRESSED, so equal text always yields an equal ref - see the header.
 */
class ContentAddressedArtifacts implements FormalArtifactReader {
  readonly #texts = new Map<string, string>();

  register(name: string, text: string): ArtifactBlobRef {
    const sha256 = createHash('sha256').update(text, 'utf8').digest('hex');
    this.#texts.set(sha256, text);
    return { name, sizeBytes: Buffer.byteLength(text, 'utf8'), sha256 };
  }

  readText(artifact: ArtifactBlobRef): Promise<string | null> {
    return Promise.resolve(this.#texts.get(artifact.sha256) ?? null);
  }
}

/** The raw worker capture for one scripted run, registering its artifacts in `store`. */
function captureOf(run: ScriptedRun, store: ContentAddressedArtifacts): RawRunCapture {
  const artifacts: Record<string, ArtifactBlobRef> = {};
  for (const [key, text] of Object.entries(run.registered)) {
    artifacts[key] = store.register(key, text);
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

/** Decides one submitted job's scripted run, given the clock at submission. */
type RunScript = (job: SandboxJob, nowMs: number) => ScriptedRun;

/** Run `proveSet` once over the case's set, every job answered by `script`, on a fresh clock. */
function proveOnce(c: IndependenceCase, script: RunScript): Promise<FormalOutcome> {
  const clock = new ManualClock();
  const artifacts = new ContentAddressedArtifacts();
  const runner = new SandboxToolRunner(
    new FakeSandboxRuntime((job) => {
      const run = script(job, clock.now());
      clock.advance(run.elapsedMs);
      return captureOf(run, artifacts);
    }),
  );
  const oracle = new YosysSmtBmcFormalOracle({
    toolRunner: runner,
    artifacts,
    caps: CAPS,
    now: clock.now,
  });
  return oracle.proveSet({
    designSource: DESIGN,
    designInterface: c.designInterface,
    properties: c.properties,
    budgetMs: BUDGET_MS,
  });
}

/**
 * The DISCOVERY run: the case's own pre-pass, and every rung proving instantly.
 *
 * It exists to read each property's wrapper off the outcome, which a wrapper renders from the
 * property and the contract alone - no report reaches it - so any script would do; this one is
 * the cheapest, one rung per property.
 */
function discoveryScript(c: IndependenceCase): RunScript {
  return (job) =>
    job.kind === 'formalPrepass'
      ? prepassRunFor(c.prepass, c.prepassElapsedMs)
      : completed(0, reportArtifacts(PROVING_REPORT));
}

/**
 * Each rendered wrapper's property position, or `null` where two properties rendered one text.
 *
 * A refused pre-pass renders none, which is an EMPTY map rather than `null`: no `formal` job will
 * be submitted, so there is nothing to attribute.
 */
function wrapperPositions(sources: readonly (string | null)[]): ReadonlyMap<string, number> | null {
  const positions = new Map<string, number>();
  let rendered = 0;
  sources.forEach((source, position) => {
    if (source !== null) {
      positions.set(source, position);
      rendered += 1;
    }
  });
  return positions.size === rendered ? positions : null;
}

/** Ties each submitted `formal` job to its property by the wrapper it carries, per ladder. */
class LadderLedger {
  readonly #positionOf: ReadonlyMap<string, number>;
  readonly #jobs: number[];
  readonly #firstJobAtMs: (number | null)[];

  constructor(positionOf: ReadonlyMap<string, number>, size: number) {
    this.#positionOf = positionOf;
    this.#jobs = Array.from({ length: size }, () => 0);
    this.#firstJobAtMs = Array.from({ length: size }, () => null);
  }

  /** The property a job belongs to and its rung on that property's OWN ladder. */
  attribute(job: SandboxJob, nowMs: number): { readonly position: number; readonly rung: number } {
    const wrapper = job.workspaceFiles.find((file) => file.path === PROPERTY_WRAPPER_FILE_NAME);
    const position = wrapper === undefined ? undefined : this.#positionOf.get(wrapper.contents);
    if (position === undefined) {
      // Loud rather than answered: a job no discovered property rendered is a broken harness, and
      // answering it anyway could hand some property an answer that was never its own.
      throw new Error('a formal job carried a wrapper the discovery run never returned');
    }
    const rung = this.#jobs[position] ?? 0;
    this.#jobs[position] = rung + 1;
    this.#firstJobAtMs[position] ??= nowMs;
    return { position, rung };
  }

  /** How many `formal` jobs the property at `position` submitted. */
  jobsFor(position: number): number {
    return this.#jobs[position] ?? 0;
  }

  /** The clock when the property at `position` submitted its first job, or `null` for none. */
  firstJobAt(position: number): number | null {
    return this.#firstJobAtMs[position] ?? null;
  }

  /** Whether any property submitted a `formal` job at all. */
  ranAnyRung(): boolean {
    return this.#jobs.some((count) => count > 0);
  }
}

/** The answer for rung `rung` of a script: its own, or its last once the ladder outlasts it. */
function answerAt(script: PropertyScript | undefined, rung: number): RungAnswer {
  const rungs = script?.rungs ?? [];
  const answer = rungs[Math.min(rung, rungs.length - 1)];
  if (answer === undefined) {
    throw new Error('a property was scripted with no answer for its ladder');
  }
  return answer;
}

/** One scripted run: its outcome, and the ledger saying which jobs were whose. */
interface ScriptedOutcome {
  readonly outcome: FormalOutcome;
  readonly ledger: LadderLedger;
}

/** Run the case with each property's ladder answered from its OWN script alone. */
async function proveScripted(
  c: IndependenceCase,
  scripts: readonly PropertyScript[],
  positionOf: ReadonlyMap<string, number>,
): Promise<ScriptedOutcome> {
  const ledger = new LadderLedger(positionOf, c.properties.length);
  const outcome = await proveOnce(c, (job, nowMs) => {
    if (job.kind === 'formalPrepass') {
      return prepassRunFor(c.prepass, c.prepassElapsedMs);
    }
    const { position, rung } = ledger.attribute(job, nowMs);
    return rungRunFor(answerAt(scripts[position], rung), job);
  });
  return { outcome, ledger };
}

// ---------------------------------------------------------------------------
// The claims
// ---------------------------------------------------------------------------

/** Clause 1: one result per submitted property, in submission order, and one wrapper entry each. */
function expectOneResultPerPropertyInOrder(
  outcome: FormalOutcome,
  properties: readonly FormalProperty[],
): void {
  expect(outcome.results.map((result) => result.criterionRef)).toStrictEqual(
    properties.map((property) => property.criterionRef),
  );
  expect(outcome.propertyWrapperSources).toHaveLength(properties.length);
}

/** The three run-level facts, which the shared pre-pass derives from the design alone. */
function runLevelFactsOf(outcome: FormalOutcome): Readonly<Record<string, unknown>> {
  return {
    resetContract: outcome.resetContract,
    assertionGateEmitted: outcome.assertionGateEmitted,
    clockPolarity: outcome.clockPolarity,
  };
}

/**
 * Clause 2, the controlled comparison: the two runs differ ONLY at `replaced`.
 *
 * Every other property's result is equal field for field, every wrapper source equals the one the
 * discovery run returned - a wrapper is a function of its property and the contract, never of a
 * report - and the run-level facts agree, because the shared pre-pass reads the design alone.
 */
function expectOnlyTheReplacedPropertyMayDiffer(
  c: IndependenceCase,
  discovered: FormalOutcome,
  baseline: FormalOutcome,
  perturbed: FormalOutcome,
): void {
  for (const outcome of [baseline, perturbed]) {
    expectOneResultPerPropertyInOrder(outcome, c.properties);
    expect(outcome.propertyWrapperSources).toStrictEqual(discovered.propertyWrapperSources);
  }
  expect(runLevelFactsOf(perturbed)).toStrictEqual(runLevelFactsOf(baseline));
  c.properties.forEach((_, position) => {
    if (position !== c.perturbedIndex) {
      expect(perturbed.results[position]).toStrictEqual(baseline.results[position]);
    }
  });
}

/** The rows one compared multi-property case contributes to the non-vacuity tally. */
interface ComparisonRows {
  /** The replacement really changed the replaced property's own result. */
  readonly targetChanged: boolean;
  /** It changed how many rungs that ladder climbed, AHEAD of a later property. */
  readonly ladderLengthChangedAhead: boolean;
  /** The replaced property flipped INTO `could-not-verify` beside a `proved` neighbour. */
  readonly flippedIntoCouldNotVerify: boolean;
  /** A property after the replaced one started only once one whole window had passed. */
  readonly laterOutlivedOneWindow: boolean;
  /** The verdicts the untouched properties held, unchanged, in this case. */
  readonly verdictsAmongOthers: readonly FormalVerdict[];
}

/** The verdict at a position, or `null` where no result exists there. */
function verdictAt(outcome: FormalOutcome, position: number): FormalVerdict | null {
  return outcome.results[position]?.verdict ?? null;
}

/** Whether some position other than `excluded` holds a `proved` result. */
function anotherProved(results: readonly PropertyResult[], excluded: number): boolean {
  return results.some((result, position) => position !== excluded && result.verdict === 'proved');
}

/**
 * Whether a property AFTER `replaced` started only once a set-wide window would already be spent.
 *
 * The row a shared window needs in order to show: each run's clock starts at 0 with the set, so a
 * later property starting at or past `BUDGET_MS` is one an adapter charging the SET's elapsed time
 * to each property would have refused before it ran.
 */
function laterPropertyOutlivedOneWindow(
  ledger: LadderLedger,
  replaced: number,
  size: number,
): boolean {
  for (let position = replaced + 1; position < size; position += 1) {
    const startedAt = ledger.firstJobAt(position);
    if (startedAt !== null && startedAt >= BUDGET_MS) {
      return true;
    }
  }
  return false;
}

/** The non-vacuity rows of one compared case, or `null` where it has no neighbour to influence. */
function comparisonRowsOf(
  c: IndependenceCase,
  baseline: ScriptedOutcome,
  perturbed: ScriptedOutcome,
): ComparisonRows | null {
  const size = c.properties.length;
  const j = c.perturbedIndex;
  if (size < 2 || !baseline.ledger.ranAnyRung()) {
    return null;
  }
  return {
    targetChanged: !isDeepStrictEqual(baseline.outcome.results[j], perturbed.outcome.results[j]),
    ladderLengthChangedAhead:
      j < size - 1 && baseline.ledger.jobsFor(j) !== perturbed.ledger.jobsFor(j),
    flippedIntoCouldNotVerify:
      verdictAt(baseline.outcome, j) !== 'could-not-verify' &&
      verdictAt(perturbed.outcome, j) === 'could-not-verify' &&
      anotherProved(baseline.outcome.results, j),
    laterOutlivedOneWindow: [baseline, perturbed].some((run) =>
      laterPropertyOutlivedOneWindow(run.ledger, j, size),
    ),
    verdictsAmongOthers: baseline.outcome.results
      .filter((_, position) => position !== j)
      .map((result) => result.verdict),
  };
}

/** What one case did: skipped for indistinguishable wrappers, or compared, with its rows. */
type CaseReport =
  | { readonly kind: 'duplicate-wrappers' }
  | { readonly kind: 'compared'; readonly rows: ComparisonRows | null };

/**
 * Assert both clauses over one case and report what it exercised.
 *
 * The order clause is asserted on the discovery run BEFORE anything can skip the case, so even a
 * set the comparison cannot attribute still has its results checked for order.
 */
async function assertIndependence(c: IndependenceCase): Promise<CaseReport> {
  const discovered = await proveOnce(c, discoveryScript(c));
  expectOneResultPerPropertyInOrder(discovered, c.properties);
  const positionOf = wrapperPositions(discovered.propertyWrapperSources);
  if (positionOf === null) {
    return { kind: 'duplicate-wrappers' };
  }
  const replaced = c.scripts.map((script, position) =>
    position === c.perturbedIndex ? c.replacement : script,
  );
  const baseline = await proveScripted(c, c.scripts, positionOf);
  const perturbed = await proveScripted(c, replaced, positionOf);
  expectOnlyTheReplacedPropertyMayDiffer(c, discovered, baseline.outcome, perturbed.outcome);
  return { kind: 'compared', rows: comparisonRowsOf(c, baseline, perturbed) };
}

/** The boolean rows of `ComparisonRows`, each counted across the run. */
const ROW_NAMES = [
  'targetChanged',
  'ladderLengthChangedAhead',
  'flippedIntoCouldNotVerify',
  'laterOutlivedOneWindow',
] as const satisfies readonly (keyof ComparisonRows)[];

/** Every count the tally keeps. */
type TallyCount = 'total' | 'duplicate-wrappers' | 'compared' | (typeof ROW_NAMES)[number];

/** The non-vacuity tally across a whole property run. */
class IndependenceTally {
  readonly #counts = new Map<TallyCount, number>();
  readonly #verdictsAmongOthers = new Set<FormalVerdict>();
  readonly #prepassKindsSeen = new Set<PrepassAnswer['kind']>();

  record(c: IndependenceCase, report: CaseReport): void {
    this.#bump('total');
    this.#prepassKindsSeen.add(c.prepass.kind);
    this.#bump(report.kind);
    if (report.kind === 'duplicate-wrappers' || report.rows === null) {
      return;
    }
    const { rows } = report;
    for (const name of ROW_NAMES) {
      if (rows[name]) {
        this.#bump(name);
      }
    }
    rows.verdictsAmongOthers.forEach((verdict) => this.#verdictsAmongOthers.add(verdict));
  }

  count(name: TallyCount): number {
    return this.#counts.get(name) ?? 0;
  }

  verdictsAmongOthers(): ReadonlySet<FormalVerdict> {
    return this.#verdictsAmongOthers;
  }

  prepassKindsSeen(): ReadonlySet<PrepassAnswer['kind']> {
    return this.#prepassKindsSeen;
  }

  #bump(name: TallyCount): void {
    this.#counts.set(name, this.count(name) + 1);
  }
}

/**
 * NUM_RUNS - sized to the two rarest required rows, which MEASURED alike over eight 300-run samples:
 * a replaced property flipping INTO `could-not-verify` beside a `proved` neighbour (criterion 1.14's
 * own sentence), at 11 to 18 of 300, and a replaced ladder changing length AHEAD of a later property
 * (only a property carrying an antecedent can climb, a third of them), also at 11 to 18 of 300. So
 * each is at least 3.6% of runs, and the chance of meeting none in 500 is at most
 * `(1 - 0.036)^500` ~ 1e-8 per row. The other rows measured higher: a later property starting past
 * one whole window at 21 to 36 of 300, and a changed result at the replaced position at 133 to 155.
 * Sets rendering duplicate wrappers measured at 0 to 3 of 300. 300 runs took about 0.2s.
 */
const INDEPENDENCE_NUM_RUNS = 500;

describe(PROPERTY_18, () => {
  it(
    'reports one result per submitted property in order, and replacing one property`s reports changes no other result',
    async () => {
      const tally = new IndependenceTally();

      await fc.assert(
        fc.asyncProperty(arbIndependenceCase(), async (c: IndependenceCase) => {
          tally.record(c, await assertIndependence(c));
        }),
        propertyParameters({ numRuns: INDEPENDENCE_NUM_RUNS }),
      );

      // Non-vacuity. Every pre-pass arm met the order clause; most cases could be compared; the
      // replacement really changed the replaced property's result; it changed how many rungs that
      // ladder climbed ahead of a later property, which is what an ordinal coupling needs; a later
      // property started after one whole window, which is what a shared window needs; the replaced
      // property flipped into `could-not-verify` beside a `proved` neighbour, which is criterion
      // 1.14's sentence; and every verdict was held unchanged on some untouched property.
      expect(tally.count('total')).toBe(INDEPENDENCE_NUM_RUNS);
      for (const kind of PREPASS_KINDS) {
        expect(tally.prepassKindsSeen()).toContain(kind);
      }
      expect(tally.count('compared')).toBeGreaterThan(tally.count('duplicate-wrappers'));
      for (const row of ROW_NAMES) {
        expect(tally.count(row), row).toBeGreaterThan(0);
      }
      for (const verdict of FORMAL_VERDICTS) {
        expect(tally.verdictsAmongOthers()).toContain(verdict);
      }
    },
    SLOW_PROPERTY_TIMEOUT_MS,
  );
});
