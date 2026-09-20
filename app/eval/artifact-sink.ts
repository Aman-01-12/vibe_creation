// The per-sample ARTIFACT seam: the evidence that makes a verdict disagreement
// diagnosable instead of invisible.
//
// WHY THIS EXISTS - A MEASURED GAP, NOT A HYPOTHETICAL ONE
//   The first real smoke sweep produced three verdicts. On two of the three problems our
//   own spec-derived testbench rejected a candidate that RTLLM's INDEPENDENT golden
//   testbench passed (over-strict 2, missed bugs 0). The persisted record can say only
//   that those samples ended `unverified` after 6 iterations, stopped by
//   `max-iterations`. It cannot say which of our checks the design failed, what the
//   simulator printed, or what the model actually wrote - and those are the only things
//   that identify the defect. Tuning prompts or ranking models on numbers derived from a
//   testbench nobody can inspect would encode OUR testbench's defect as the model's
//   capability.
//
// WHY A PORT RATHER THAN A WRITE
//   The harness measures; it does not own a filesystem, and it stays unit-testable with
//   no disk. So it derives the artifacts and hands them to this sink. The production
//   adapter lives in the sweep, which already owns the run directory (see
//   `./sweep/artifact-store-node.ts`).
//
// OPTIONAL, AND ADDITIVE ONLY
//   No sink means behaviour is EXACTLY as before: nothing is derived and nothing is
//   written. Capture runs only after a sample is fully measured, and the harness catches
//   any throw from the sink, so no artifact write can move a measured number or end a
//   campaign that has hours invested in it. Observability must never be able to fail the
//   thing it observes.
//
// BOUNDED, BECAUSE THIS LANDS ON DISK FOR HUNDREDS OF SESSIONS
//   Every captured text is capped by a named constant in `ARTIFACT_CAPS`. A source keeps
//   its HEAD (the module header and port list are what identify a candidate); a simulator
//   stream keeps its TAIL (the error is at the end of the run). Whether a value was cut is
//   carried ON the value, so the writer can label the file and a reader can never mistake
//   a truncated artifact for a complete one.
//
// WHAT MAY NEVER BE CAPTURED
//   Model output and tool output ONLY - the same values the loop already returned, plus
//   the harness's own measured sample. No credential, no bearer token, no endpoint, no
//   host, no path, no environment variable, and no provider payload: nothing here reads
//   from an error, a request, or the environment, so there is no door for one to enter by.
//
// THE OUTCOME IS NARROWED, NOT TRUSTED
//   It crosses the `EvalLoopRunner` port, so every field is read defensively: a runner
//   that returns `verified` without a module version yields an ABSENT artifact, never a
//   crash. Pure: no clock, no I/O, no randomness.

import type { BudgetStopReason, Verdict } from '@app/core';
import { describeRepairHint, NO_REPAIR } from '@app/agent';
import type { RepairHint, RepairProvenance, VerificationOutcome } from '@app/agent';
import type { RunFailureCause } from '@app/tools';

import type { RecordedGoldenVerdict } from './golden-judge.js';
import type { InstrumentControlResult, RecordedInstrumentVerdict } from './instrument-control.js';
import type { MutationProbeReport } from './mutation-control.js';
import type { SampleOutcomeStatus, SampleResult } from './report.js';

/**
 * The caps every captured value is bounded by.
 *
 * Each is generous for a real design and finite. The worst case for one sample is the sum
 * of these, so a full campaign's artifact footprint is bounded by construction rather
 * than by hoping a model stays terse.
 */
export const ARTIFACT_CAPS = Object.freeze({
  /** Longest captured source (candidate RTL or testbench), in characters; HEAD kept. */
  maxSourceChars: 65_536,
  /** Longest captured simulator stream, in characters; TAIL kept. */
  maxDiagnosticsChars: 32_768,
  /** Most per-check verdicts captured from one simulation. */
  maxChecks: 256,
  /** Longest captured check name, in characters. */
  maxCheckNameChars: 200,
  /** Longest captured failing-case text field, in characters. */
  maxFailingCaseFieldChars: 1_024,
  /** Longest captured rejected-testbench draft, in characters; HEAD kept. */
  maxRejectedDraftChars: 65_536,
  /** Most missing required-check names captured from one setup failure. */
  maxMissingCheckNames: 256,
  /** Longest captured Testbench_Repair hint text, in characters. */
  maxRepairHintChars: 4_096,
});

/** Which end of an over-long text was kept. */
export type CapturedEnd = 'head' | 'tail';

/**
 * One captured text, with its truncation stated rather than implied.
 *
 * `text` is what a reader will see; `originalChars` is how long the real value was. A
 * consumer that writes this to a file MUST surface `truncated`, because a silently cut
 * Verilog source looks exactly like a model that stopped mid-module.
 */
export interface CapturedText {
  /** The retained text: the HEAD or the TAIL, per `keptEnd`. */
  readonly text: string;
  /** Whether the original exceeded its cap and was cut. */
  readonly truncated: boolean;
  /** Length of the original text in characters, before any truncation. */
  readonly originalChars: number;
  /** Which end was kept, so a writer can label the artifact correctly. */
  readonly keptEnd: CapturedEnd;
}

/** One per-check verdict the simulation reported. */
export interface CapturedCheckVerdict {
  readonly name: string;
  readonly passed: boolean;
}

/**
 * The oracle run's evidence, minus the stream text.
 *
 * This is the field that answers the question the smoke sweep could not: WHICH
 * spec-derived check rejected a design the independent judge accepted.
 */
export interface CapturedSimulation {
  /** The verdict the run reported, or `null` when the outcome carried none. */
  readonly verdict: Verdict | null;
  /** Per-check verdicts in emission order, capped at `ARTIFACT_CAPS.maxChecks`. */
  readonly checks: readonly CapturedCheckVerdict[];
  /** Whether `checks` was cut at the cap. */
  readonly checksTruncated: boolean;
  /** The simulator process exit code, or `null` when it did not run to an exit. */
  readonly exitCode: number | null;
  /** The simulator's standard output, TAIL-kept, or `null` when it printed nothing. */
  readonly stdout: CapturedText | null;
  /** The simulator's standard error, TAIL-kept, or `null` when it printed nothing. */
  readonly stderr: CapturedText | null;
}

/**
 * The concrete case the loop localized, or absent.
 *
 * `checkName` identifies the case, so an outcome that carries no check name carries no
 * failing case at all. The remaining fields are explicitly nullable rather than blank,
 * so "the runner did not supply this" never reads as "the testbench expected nothing".
 */
export interface CapturedFailingCase {
  readonly checkName: string;
  readonly description: string | null;
  readonly expected: string | null;
  readonly observed: string | null;
  /** Simulation time of the failure in nanoseconds, or `null` if not localized. */
  readonly atSimTimeNs: number | null;
}

/**
 * Everything captured for one sample.
 *
 * The verdict fields are COPIED from the sample the harness already measured, so an
 * artifact can never disagree with the record it sits beside. The evidence fields are
 * derived from the terminal outcome and are `null` when that outcome genuinely carried
 * none: `blocked` and `setup-failed` produce no RTL, no testbench, and no simulation, and
 * saying so explicitly is the point.
 */
export interface EvalSampleArtifacts {
  readonly outcomeStatus: SampleOutcomeStatus;
  /** The loop's own oracle verdict, as recorded; never re-derived here. */
  readonly passed: boolean;
  readonly iterations: number;
  readonly stopReason: BudgetStopReason | null;
  /** The sanitized note explaining a no-verdict sample, or `null`. */
  readonly failureNote: string | null;
  /** The final candidate RTL, or `null` when the outcome produced none. */
  readonly candidateRtl: CapturedText | null;
  /** OUR generated testbench, or `null` when the outcome produced none. */
  readonly testbenchSource: CapturedText | null;
  /** The oracle run's evidence, or `null` when no simulation ever ran. */
  readonly simulation: CapturedSimulation | null;
  readonly failingCase: CapturedFailingCase | null;
  /**
   * Why the run's own verdict is `error`, or `null`.
   *
   * `null` whenever the outcome carries no `SimulationVerdict` to read it from - which
   * includes `instrument-refused`: that outcome is reached BEFORE any oracle verdict, so
   * there is no run to attribute (Req 5.4). Read from `simulation.failureCause` for
   * `verified` and `unverified`, the same value `simulation` above already exposes, made
   * visible under its own name rather than requiring a caller to reach into `simulation`.
   */
  readonly runFailureCause: RunFailureCause | null;
  /**
   * Submitted files a build diagnostic named, or `[]` when the outcome carries none.
   *
   * A TRUSTED list of workspace paths (membership-only; see
   * `app/tools/simulator/failure-attribution.ts`'s Property 3), so unlike the other
   * captured text fields it needs no cap of its own: it is already bounded by the number
   * of files one run submits (at most the RTL and the testbench). Read from
   * `outcome.attributedFiles` for `instrument-refused` and from
   * `simulation.attributedFiles` for `verified`/`unverified`.
   */
  readonly attributedFiles: readonly string[];
  /**
   * The testbench draft Loop_Setup rejected for incomplete coverage, or `null`.
   *
   * HEAD-kept, like `testbenchSource`: the module header and port list are what identify
   * a draft. Present only for a `setup-failed` outcome whose `cause` was a coverage gap,
   * and stored under a field distinct from `testbenchSource` so a reader can never mistake
   * a refused draft for the instrument a verdict was decided by (Req 6.5).
   */
  readonly rejectedTestbenchDraft: CapturedText | null;
  /** Whether `missingCheckNames` was cut at `ARTIFACT_CAPS.maxMissingCheckNames`. */
  readonly missingCheckNamesTruncated: boolean;
  /**
   * The required check names the rejected draft omitted, or `[]` when the outcome
   * carries none.
   *
   * Each name capped at `ARTIFACT_CAPS.maxCheckNameChars`; the list itself capped at
   * `ARTIFACT_CAPS.maxMissingCheckNames`, with the cut recorded on
   * `missingCheckNamesTruncated` rather than silently dropped.
   */
  readonly missingCheckNames: readonly string[];
  /** The INDEPENDENT judge's verdict and its failure count, or `null` when unjudged. */
  readonly goldenVerdict: RecordedGoldenVerdict | null;
  /**
   * The POSITIVE CONTROL's verdict on this sample's testbench, as recorded.
   *
   * Never `null`: a sample the control could not speak for is `unchecked`, which is a
   * statement, whereas an absent field would be a silence a reader would have to guess at.
   */
  readonly instrumentVerdict: RecordedInstrumentVerdict;
  /**
   * The control run's own toolchain output, TAIL-kept, or `null` when it produced none.
   *
   * This is where the compiler and simulator text for an INVALID instrument lives. It is
   * kept out of the report and the results record on purpose: tool diagnostics name sandbox
   * workspace paths, and a file under the run directory is the established home for that
   * (the same split as `simulation.stdout` / `stderr`). The evidence therefore sits beside
   * the very testbench that caused it.
   */
  readonly controlStdout: CapturedText | null;
  readonly controlStderr: CapturedText | null;
  /** The control run's exit code, or `null` when it did not run to an exit. */
  readonly controlExitCode: number | null;
  /**
   * What the NEGATIVE control measured, SURVIVORS INCLUDED, or `null` when it measured nothing.
   *
   * This is where the per-sample survivor detail lives, and the reason it lives here rather
   * than in the results record: a survivor carries a line, a column, and a short excerpt of
   * RTLLM's reference source, which is exactly the kind of value the record keeps out and the
   * artifacts already hold. The record persists the operator ids alone, so a campaign can
   * still tally its most-survived operators without them.
   */
  readonly mutation: MutationProbeReport | null;
  /** Whether a Testbench_Repair was attempted/accepted for this sample, copied verbatim. */
  readonly repairProvenance: RepairProvenance;
  /**
   * The testbench source a Testbench_Repair replaced, or `null`.
   *
   * HEAD-kept, like `testbenchSource`, and stored under a field distinct from
   * `testbenchSource` so a reader can never mistake the PRE-repair draft for the
   * instrument a verdict was actually decided by (Req 4.6, 4.7) - the same distinct-
   * field discipline `rejectedTestbenchDraft` already applies to a Loop_Setup
   * rejection.
   *
   * Present only when `repairProvenance.accepted` is `true`: an accepted repair is
   * the only case where a genuinely different pre-repair source exists to contrast
   * against `testbenchSource`. An attempted-but-declined repair's outcome still
   * carries its ORIGINAL, unrepaired testbench as `testbenchSource`, so there is
   * nothing separate left to capture here.
   */
  readonly rejectedPreRepairTestbench: CapturedText | null;
  /**
   * The Repair_Hint handed to the model for this sample's Testbench_Repair attempt,
   * rendered as prose, or `null`.
   *
   * Present whenever `repairProvenance.attempted` is `true`, regardless of whether
   * the attempt was ultimately accepted: a hint was constructed and shown to the
   * model either way, and that is the fact this field records. Rendered through the
   * SAME `describeRepairHint` the model's own prompt is assembled from
   * (`app/agent/roles/testbench/prompt.ts`), so this can never drift from what the
   * model actually saw, and structurally never carries the reference's observed
   * value, a diff, or its source (Req 2.4-2.6) - the same guarantee `RepairHint`
   * already enforces at the model seam. Bounded by `ARTIFACT_CAPS.maxRepairHintChars`.
   */
  readonly repairHint: string | null;
}

/**
 * Which sample a set of artifacts belongs to.
 *
 * Deliberately WITHOUT an arm name or model signature: the harness measures one sample of
 * one arm and is never told which arm it is - the sweep builds the arm's loop runner and
 * would have to invent a field here for the harness to echo back. Instead the sweep BINDS
 * the arm when it constructs the sink, which is the one layer that honestly knows it.
 */
export interface EvalArtifactDescriptor {
  readonly problemId: string;
  readonly sampleIndex: number;
  /** The deterministic seed this sample was drawn with. */
  readonly seed: number;
}

/**
 * The optional sink each measured sample's artifacts are persisted through.
 *
 * Implementations MUST treat a write failure as their own problem: the harness catches a
 * throw and continues, but an adapter that can report a sanitized note should do so
 * rather than staying silent. Implementations must never mutate the artifacts, and must
 * never write anything the artifacts do not carry.
 */
export interface EvalArtifactSink {
  write(descriptor: EvalArtifactDescriptor, artifacts: EvalSampleArtifacts): Promise<void>;
}

/**
 * The terminal outcome the capture reads.
 *
 * The harness's own fail-safe `runner-error` classification is part of the union because a
 * runner that threw is a sample worth having a (near-empty) artifact for: it is the case
 * where knowing that NOTHING was produced is itself the finding.
 */
export type CapturedOutcome = VerificationOutcome | { readonly status: 'runner-error' };

/** What the capture needs: the terminal outcome and the verdict already measured from it. */
export interface ArtifactCaptureInput {
  readonly outcome: CapturedOutcome;
  /** The sample the harness measured and will record; its verdict fields are copied. */
  readonly measured: SampleResult;
  /**
   * The POSITIVE CONTROL's full result, or `null` when no control ran.
   *
   * Passed separately from `measured` because it carries raw tool streams, which a
   * `SampleResult` is persisted as a report and may never hold. The control's VERDICT is
   * read from `measured` regardless, so an artifact can never disagree with the record.
   */
  readonly control: InstrumentControlResult | null;
  /**
   * The Repair_Hint this sample's Testbench_Repair attempt was built from, or `null`
   * / omitted when `measured.repairProvenance.attempted` is `false`.
   *
   * Neither `CapturedOutcome` nor `SampleResult` carries the hint VALUE - only
   * `measured.repairProvenance`'s `{ attempted, accepted }` pair - so the harness
   * supplies it directly from whichever trigger point actually built it (Req 4.7).
   */
  readonly repairHint?: RepairHint | null;
  /**
   * The testbench source a Testbench_Repair replaced, or `null` / omitted when no
   * repair was accepted for this sample.
   *
   * Like `repairHint`, this is not reachable from `outcome` or `measured`: by the
   * time the outcome the harness holds reflects a repair, its own testbench source
   * IS the revised one (see `./harness.ts`'s `withRevisedTestbench`), so the PRE-
   * repair source has to be supplied separately, from before that replacement.
   */
  readonly preRepairTestbenchSource?: string | null;
}

/** The verdicts a simulation may report; a closed set, validated on read. */
const VERDICTS: readonly Verdict[] = ['pass', 'fail', 'error'];

/** The run failure causes `SimulationVerdict` may report; a closed set, validated on read. */
const RUN_FAILURE_CAUSES: readonly RunFailureCause[] = [
  'none',
  'build-failed',
  'timed-out',
  'disk-capped',
  'output-incomplete',
  'tool-failed',
];

/**
 * Derive one sample's artifacts (pure, total).
 *
 * Never throws for a malformed outcome: an unreadable field becomes an absent artifact,
 * because a diagnostic derivation must not be able to fail a measured sample.
 */
export function captureSampleArtifacts(input: ArtifactCaptureInput): EvalSampleArtifacts {
  const { outcome, measured, control, repairHint = null, preRepairTestbenchSource = null } = input;
  // Defensively read, like every other field on `measured`/`outcome` here: `measured` is
  // typed as a `SampleResult`, whose `repairProvenance` is required, but this derivation
  // must still degrade to the unrepaired baseline rather than throw for a caller that
  // hands in a malformed value (Req 6.6's "never throws" contract, extended to this field).
  const repairProvenance = measured.repairProvenance ?? NO_REPAIR;
  return {
    outcomeStatus: measured.outcomeStatus,
    passed: measured.passed,
    iterations: measured.iterations,
    stopReason: measured.stopReason,
    failureNote: measured.failureNote,
    goldenVerdict: measured.goldenVerdict,
    instrumentVerdict: measured.instrumentVerdict,
    repairProvenance,
    // Req 4.6, 4.7: present only for an ACCEPTED repair - the only case with a
    // genuinely distinct pre-repair source to contrast against `testbenchSource`.
    rejectedPreRepairTestbench: repairProvenance.accepted
      ? captureText(preRepairTestbenchSource, ARTIFACT_CAPS.maxSourceChars, 'head')
      : null,
    // Req 4.7: present whenever a repair was ATTEMPTED, accepted or not - a hint was
    // built and shown to the model either way.
    repairHint: repairProvenance.attempted
      ? captureRepairHint(repairHint, ARTIFACT_CAPS.maxRepairHintChars)
      : null,
    candidateRtl: captureText(candidateRtlOf(outcome), ARTIFACT_CAPS.maxSourceChars, 'head'),
    testbenchSource: captureText(testbenchSourceOf(outcome), ARTIFACT_CAPS.maxSourceChars, 'head'),
    simulation: captureSimulation(outcome),
    failingCase: captureFailingCase(outcome),
    runFailureCause: runFailureCauseOf(outcome),
    attributedFiles: attributedFilesOf(outcome),
    rejectedTestbenchDraft: captureText(
      rejectedTestbenchOf(outcome),
      ARTIFACT_CAPS.maxRejectedDraftChars,
      'head',
    ),
    ...captureMissingCheckNames(outcome),
    controlStdout: captureControlStream(control, 'stdout'),
    controlStderr: captureControlStream(control, 'stderr'),
    controlExitCode: control === null ? null : control.exitCode,
    // Copied from the control's own result rather than re-derived: the survivors are already
    // bounded at construction (see `MAX_SITE_TEXT_CHARS`) and the mutant cap bounds how many
    // there can be, so the artifact footprint stays bounded without a second cap here.
    mutation: control?.mutation ?? null,
  };
}

/**
 * One of the control run's streams, TAIL-kept and capped, or `null`.
 *
 * The TAIL is kept for the same reason the oracle's streams are: a compile error and a
 * failing check both land at the end of the run.
 */
function captureControlStream(
  control: InstrumentControlResult | null,
  stream: 'stdout' | 'stderr',
): CapturedText | null {
  if (control === null) {
    return null;
  }
  return captureText(control[stream], ARTIFACT_CAPS.maxDiagnosticsChars, 'tail');
}

/**
 * The candidate RTL a terminal outcome carried, or `null` when it carried none.
 *
 * A verified outcome carries the committed `ModuleVersion`; an unverified one carries the
 * last candidate. `blocked`, `setup-failed`, and `runner-error` never produced RTL, so
 * there is nothing to capture and nothing for an independent judge to score - which is why
 * both the judge path and the capture path read it through this one function.
 */
export function candidateRtlOf(outcome: CapturedOutcome): string | null {
  if (outcome.status === 'verified') {
    return nonEmptyStringAt(outcome.moduleVersion, 'rtl');
  }
  if (outcome.status === 'unverified' || outcome.status === 'instrument-refused') {
    return nonEmptyStringAt(outcome.candidate, 'rtl');
  }
  return null;
}

/**
 * OUR generated testbench source, or `null` when the outcome carried none.
 *
 * Exported for the same reason `candidateRtlOf` is: the POSITIVE CONTROL needs exactly the
 * testbench the artifact capture records, so both read it through this one function and a
 * status added to the outcome union cannot be handled differently by the two paths.
 */
export function testbenchSourceOf(outcome: CapturedOutcome): string | null {
  if (
    outcome.status === 'verified' ||
    outcome.status === 'unverified' ||
    outcome.status === 'instrument-refused'
  ) {
    return nonEmptyStringAt(outcome.testbench, 'source');
  }
  return null;
}

/**
 * Why the run's own verdict is `error`, or `null` when the outcome carries no
 * `SimulationVerdict` to read it from.
 *
 * `instrument-refused` is reached before any oracle verdict (Req 5.4), so it never
 * carries a `SimulationVerdict` and reports `null` here just as `blocked` and
 * `setup-failed` already do - this is existing data on `verified`/`unverified` made
 * visible under its own name, not a new derivation.
 */
function runFailureCauseOf(outcome: CapturedOutcome): RunFailureCause | null {
  if (outcome.status !== 'verified' && outcome.status !== 'unverified') {
    return null;
  }
  return runFailureCauseAt(outcome.simulation, 'failureCause');
}

/** A property that is one of the known run failure causes, or `null` for anything else. */
function runFailureCauseAt(carrier: unknown, key: string): RunFailureCause | null {
  const value = propertyAt(carrier, key);
  return RUN_FAILURE_CAUSES.find((cause) => cause === value) ?? null;
}

/**
 * Submitted files a build diagnostic named, or `[]` when the outcome carries none.
 *
 * Reads `outcome.attributedFiles` directly for `instrument-refused` (the field the
 * refusal itself carries) and `simulation.attributedFiles` for `verified`/`unverified`.
 * Every other status produced no run to attribute.
 */
function attributedFilesOf(outcome: CapturedOutcome): readonly string[] {
  if (outcome.status === 'instrument-refused') {
    return stringArrayAt(outcome, 'attributedFiles');
  }
  if (outcome.status === 'verified' || outcome.status === 'unverified') {
    return stringArrayAt(outcome.simulation, 'attributedFiles');
  }
  return [];
}

/** The rejected testbench draft a `setup-failed` outcome carried, or `null`. */
function rejectedTestbenchOf(outcome: CapturedOutcome): string | null {
  if (outcome.status !== 'setup-failed') {
    return null;
  }
  return nonEmptyStringAt(outcome, 'rejectedTestbench');
}

/** The missing required-check names a `setup-failed` outcome carried, capped, plus the cut. */
function captureMissingCheckNames(outcome: CapturedOutcome): {
  readonly missingCheckNames: readonly string[];
  readonly missingCheckNamesTruncated: boolean;
} {
  if (outcome.status !== 'setup-failed') {
    return { missingCheckNames: [], missingCheckNamesTruncated: false };
  }
  const raw = stringArrayAt(outcome, 'missingCheckNames');
  const capped = raw
    .slice(0, ARTIFACT_CAPS.maxMissingCheckNames)
    .map((name) => name.slice(0, ARTIFACT_CAPS.maxCheckNameChars));
  return {
    missingCheckNames: capped,
    missingCheckNamesTruncated: raw.length > ARTIFACT_CAPS.maxMissingCheckNames,
  };
}

/** A property holding an array of strings, filtered to just the strings, or `[]`. */
function stringArrayAt(carrier: unknown, key: string): readonly string[] {
  const value = propertyAt(carrier, key);
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

/**
 * Render a Repair_Hint through the SAME prose renderer the model's own prompt uses,
 * capped, or `null` when there is no hint to render.
 *
 * `describeRepairHint` already carries the anti-circularity guarantee (Req 2.4-2.6):
 * it reads only the closed `RepairHint` union, which is structurally incapable of
 * holding the reference's observed value, a diff, or its source. Capping the
 * rendered text (rather than a raw field of the hint) keeps this artifact bounded
 * the same way every other captured text here is, without a second cap that could
 * drift from the model's own view of the hint.
 */
function captureRepairHint(hint: RepairHint | null, cap: number): string | null {
  if (hint === null) {
    return null;
  }
  return describeRepairHint(hint).slice(0, cap);
}

/** Cap a text, keeping the requested end, or `null` when there is nothing to capture. */
function captureText(raw: string | null, cap: number, keptEnd: CapturedEnd): CapturedText | null {
  if (raw === null || raw.length === 0) {
    return null;
  }
  if (raw.length <= cap) {
    return { text: raw, truncated: false, originalChars: raw.length, keptEnd };
  }
  const text = keptEnd === 'head' ? raw.slice(0, cap) : raw.slice(raw.length - cap);
  return { text, truncated: true, originalChars: raw.length, keptEnd };
}

/** The oracle run's captured evidence, or `null` when no simulation ran. */
function captureSimulation(outcome: CapturedOutcome): CapturedSimulation | null {
  if (outcome.status !== 'verified' && outcome.status !== 'unverified') {
    return null;
  }
  const simulation = outcome.simulation;
  if (typeof simulation !== 'object' || simulation === null) {
    return null;
  }
  const checks = captureChecks(simulation);
  return {
    verdict: verdictAt(simulation, 'verdict'),
    checks: checks.captured,
    checksTruncated: checks.truncated,
    exitCode: integerAt(simulation, 'exitCode'),
    stdout: captureText(
      nonEmptyStringAt(simulation, 'stdout'),
      ARTIFACT_CAPS.maxDiagnosticsChars,
      'tail',
    ),
    stderr: captureText(
      nonEmptyStringAt(simulation, 'stderr'),
      ARTIFACT_CAPS.maxDiagnosticsChars,
      'tail',
    ),
  };
}

/**
 * The per-check verdicts, capped, plus whether the list was cut.
 *
 * A check name comes from parsed tool output, so it is bounded here; it is escaped by
 * whatever encoder the sink writes it with (JSON for our own), so no further filtering is
 * needed to keep it from corrupting the artifact around it.
 */
function captureChecks(simulation: unknown): {
  readonly captured: readonly CapturedCheckVerdict[];
  readonly truncated: boolean;
} {
  const raw = propertyAt(simulation, 'checks');
  if (!Array.isArray(raw)) {
    return { captured: [], truncated: false };
  }
  const captured: CapturedCheckVerdict[] = [];
  for (const entry of raw.slice(0, ARTIFACT_CAPS.maxChecks)) {
    const name = nonEmptyStringAt(entry, 'name');
    const passed = propertyAt(entry, 'passed');
    if (name !== null && typeof passed === 'boolean') {
      captured.push({ name: name.slice(0, ARTIFACT_CAPS.maxCheckNameChars), passed });
    }
  }
  return { captured, truncated: raw.length > ARTIFACT_CAPS.maxChecks };
}

/** The localized failing case, or `null` when the outcome carried none. */
function captureFailingCase(outcome: CapturedOutcome): CapturedFailingCase | null {
  if (outcome.status !== 'unverified') {
    return null;
  }
  const failingCase = outcome.failingCase;
  const checkName = nonEmptyStringAt(failingCase, 'checkName');
  if (checkName === null) {
    return null;
  }
  return {
    checkName: boundedField(checkName),
    description: boundedFieldAt(failingCase, 'description'),
    expected: boundedFieldAt(failingCase, 'expected'),
    observed: boundedFieldAt(failingCase, 'observed'),
    atSimTimeNs: integerAt(failingCase, 'atSimTimeNs'),
  };
}

/** A failing-case text field, bounded, or `null` when the outcome carried none. */
function boundedFieldAt(carrier: unknown, key: string): string | null {
  const value = nonEmptyStringAt(carrier, key);
  return value === null ? null : boundedField(value);
}

/** One failing-case text field, capped. */
function boundedField(value: string): string {
  return value.slice(0, ARTIFACT_CAPS.maxFailingCaseFieldChars);
}

/** A property of an object-like carrier, or `undefined` when there is none. */
function propertyAt(carrier: unknown, key: string): unknown {
  if (typeof carrier !== 'object' || carrier === null) {
    return undefined;
  }
  return (carrier as Record<string, unknown>)[key];
}

/** A non-empty string property, or `null` for anything else. */
function nonEmptyStringAt(carrier: unknown, key: string): string | null {
  const value = propertyAt(carrier, key);
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/** A safe-integer property, or `null` for anything else. */
function integerAt(carrier: unknown, key: string): number | null {
  const value = propertyAt(carrier, key);
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

/** A property that is one of the known verdicts, or `null` for anything else. */
function verdictAt(carrier: unknown, key: string): Verdict | null {
  const value = propertyAt(carrier, key);
  return VERDICTS.find((verdict) => verdict === value) ?? null;
}
