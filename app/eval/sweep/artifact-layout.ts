// The on-disk LAYOUT of one sample's artifacts: where each file goes, what it contains,
// and how a truncated one is labeled.
//
// Kept pure and separate from `./artifact-store-node.ts` (the same split as
// `results-log.ts` / `results-log-node.ts`) so the path safety and the rendering are
// unit-tested with no disk at all, and so exactly one module in the sweep touches
// `node:fs` for artifacts.
//
// THE LAYOUT, UNDER THE RUN'S OWN OUTPUT DIRECTORY
//   artifacts/<arm>/<problem>/sample-<index>/
//     candidate.v            the final candidate RTL the model produced
//     testbench.v            OUR spec-derived testbench, the thing under suspicion
//     simulator-stdout.txt   the oracle run's stdout (TAIL kept when long)
//     simulator-stderr.txt   the oracle run's stderr (TAIL kept when long)
//     control-stdout.txt     the POSITIVE CONTROL's stdout: our testbench versus the
//                            benchmark's own reference design (TAIL kept when long)
//     control-stderr.txt     the control run's stderr, which is where a compile failure
//                            against the reference shows up
//     outcome.json           the machine-readable index: verdicts, checks, truncation
//   Keyed by arm first because a bake-off is read arm by arm, then by problem so one
//   design's samples sit together, then by sample index. A file that is ABSENT was never
//   produced (a `blocked` or `setup-failed` sample has no RTL and no testbench); absence
//   is the record, and `outcome.json` names exactly which files exist.
//
//   The control's files sit deliberately BESIDE `testbench.v`: when the instrument is
//   invalid, the evidence for that finding and the testbench that caused it are in the same
//   directory, so diagnosing it needs no cross-reference to a run log.
//
// A PROBLEM ID IS UNTRUSTED AS A PATH
//   Ids contain `/` (`rtllm/arithmetic/multi_pipe_8bit`), so they cannot be used as path
//   components as they stand. `safePathSegment` reduces one to a SINGLE segment over a
//   conservative charset, which removes traversal, absolute paths, null bytes, and shell
//   metacharacters from consideration rather than escaping them at each use - the same
//   reasoning as `SWEEP_NAME_PATTERN` in `./config.ts`. A segment can therefore never
//   escape the run directory.
//
// TRUNCATION IS LABELED IN THE FILE ITSELF
//   A cut Verilog source looks exactly like a model that stopped mid-module, and a cut log
//   looks like a run that ended early. So a truncated artifact carries a banner as its
//   first line, and `outcome.json` repeats the fact per file for a machine reader.
//
// Pure: no clock, no I/O, no randomness.

import type { BudgetStopReason } from '@app/core';

import type {
  CapturedFailingCase,
  CapturedSimulation,
  CapturedText,
  EvalArtifactDescriptor,
  EvalSampleArtifacts,
} from '../artifact-sink.js';
import type { RecordedGoldenVerdict } from '../golden-judge.js';
import type { RecordedInstrumentVerdict } from '../instrument-control.js';
import type { MutationProbeReport } from '../mutation-control.js';
import type { SampleOutcomeStatus } from '../report.js';

/** The artifacts directory inside a run's output directory. */
export const ARTIFACTS_DIRNAME = 'artifacts';

/**
 * The `outcome.json` schema version, bumped only when a field's meaning changes.
 *
 * v1 -> v2: `instrumentVerdict` was added, and with it the fact that a sample's `passed`
 * only speaks about the model when the instrument is `valid`. A v1 document carries no such
 * field, so reading one as if its instrument had been validated would misattribute our own
 * testbench defect to the model.
 *
 * v2 -> v3: `mutation` was added, and with it the fact that `instrumentVerdict: valid` now
 * means BOTH controls passed - the reference is accepted AND the mutants die. A v2 document's
 * `valid` was decided by the positive control alone, so reading one as if it met the current
 * standard would report a testbench that passes everything as a sound instrument.
 *
 * v3 -> v4: the mutant DENOMINATOR changed. `mutation` used to be measured over only the
 * mutants RTLLM's golden testbench kills, which excused our testbench for the bugs that judge
 * is blind to; it is now measured over every mutant that COMPILES, and it names its survivors
 * in two buckets instead of one. A v3 document's kill rate is a fraction of a different, smaller
 * population, so the two cannot be read side by side.
 *
 * v4 -> v5: the GATE changed. `instrumentVerdict: valid` used to require a 95% kill rate over
 * every valid mutant - a bar whose denominator contains mutants no testbench can kill, which
 * marked a measurably good testbench INVALID at 4/6 on `multi_pipe_8bit`. It now requires ZERO
 * coverage-gap survivors: every valid mutant the independent golden testbench killed must die.
 * The kill rate is still recorded here, as a quality signal rather than as the gate, so a v4
 * document's `valid` and a v5 document's `valid` are claims about different populations.
 *
 * v5 -> v6: the GATE SET GREW. A mutant the independent golden testbench never TERMINATED on used
 * to classify `non-compiling`, which removed it from the valid set and therefore from the gated
 * set - so our testbench was never required to catch a defect that demonstrably changes
 * observable behaviour (the reference plus its own golden testbench completes in ~200ms; the
 * mutant does not terminate). It is now a golden KILL, so a v6 `valid` requires strictly more
 * than a v5 `valid` did, and the `mutation` block gained `goldenTimeoutCount` and
 * `goldenErroredCount` while `nonCompilingCount` narrowed to genuine build failures.
 */
export const ARTIFACT_DOCUMENT_SCHEMA_VERSION = 6;

/** The filenames one sample's directory may hold. */
export const ARTIFACT_FILENAMES = Object.freeze({
  candidateRtl: 'candidate.v',
  testbench: 'testbench.v',
  simulatorStdout: 'simulator-stdout.txt',
  simulatorStderr: 'simulator-stderr.txt',
  controlStdout: 'control-stdout.txt',
  controlStderr: 'control-stderr.txt',
  outcome: 'outcome.json',
});

/**
 * Longest path segment produced from an id or an arm name.
 *
 * Well under every filesystem's per-component limit, with room for the nesting above it.
 */
const MAX_SEGMENT_CHARS = 96;

/** Highest sample index that gets its own named directory; above it, one shared name. */
const MAX_SAMPLE_INDEX = 1_000_000;

/** Everything outside this conservative set collapses to a single underscore. */
const UNSAFE_SEGMENT_CHARACTERS = /[^A-Za-z0-9._-]+/g;

/** A segment made only of dots, which is how `.` and `..` would survive the charset. */
const DOTS_ONLY = /^\.+$/;

/** The segment used when a name reduces to nothing usable. */
const UNNAMED_SEGMENT = 'unnamed';

/** The segment used when a sample index is not a usable one. */
const UNKNOWN_SAMPLE_SEGMENT = 'sample-unknown';

/**
 * Reduce an arbitrary name to ONE safe path segment.
 *
 * Confinement is structural, not filtered: the result contains only
 * `[A-Za-z0-9._-]`, so it holds no path separator and cannot be a parent reference. A
 * name that reduces to nothing, or to dots alone, becomes `unnamed` - so `..`, `/`, and
 * `` (empty) all land inside the run directory rather than above it.
 */
export function safePathSegment(raw: string): string {
  const collapsed = raw.replace(UNSAFE_SEGMENT_CHARACTERS, '_').slice(0, MAX_SEGMENT_CHARS);
  return collapsed.length === 0 || DOTS_ONLY.test(collapsed) ? UNNAMED_SEGMENT : collapsed;
}

/** The directory name for one sample index; validated, because it reaches a path. */
function sampleSegment(sampleIndex: number): string {
  const usable =
    Number.isInteger(sampleIndex) && sampleIndex >= 0 && sampleIndex <= MAX_SAMPLE_INDEX;
  return usable ? `sample-${sampleIndex}` : UNKNOWN_SAMPLE_SEGMENT;
}

/**
 * The path segments, relative to the run's output directory, for one sample's artifacts.
 *
 * Returned as segments rather than a joined path so the caller joins them against its own
 * root and every component is provably separator-free before it becomes a path.
 */
export function artifactSampleSegments(
  armName: string,
  problemId: string,
  sampleIndex: number,
): readonly string[] {
  return [
    ARTIFACTS_DIRNAME,
    safePathSegment(armName),
    safePathSegment(problemId),
    sampleSegment(sampleIndex),
  ];
}

/** One file to write for one sample, with its truncation state carried alongside. */
export interface ArtifactFilePlan {
  readonly filename: string;
  /** The exact bytes to write, banner included when the value was truncated. */
  readonly contents: string;
  readonly truncated: boolean;
  /** Length of the original value in characters, before any truncation. */
  readonly originalChars: number;
}

/**
 * The files one sample's artifacts produce, in write order.
 *
 * Only artifacts that EXIST are planned: a sample the loop never got RTL out of yields no
 * `candidate.v` at all, rather than an empty file that would read as "the model produced
 * nothing" when the truth is "generation never ran".
 */
export function planArtifactFiles(artifacts: EvalSampleArtifacts): readonly ArtifactFilePlan[] {
  const simulation = artifacts.simulation;
  const planned = [
    sourcePlan(ARTIFACT_FILENAMES.candidateRtl, artifacts.candidateRtl),
    sourcePlan(ARTIFACT_FILENAMES.testbench, artifacts.testbenchSource),
    diagnosticsPlan(ARTIFACT_FILENAMES.simulatorStdout, simulation?.stdout ?? null),
    diagnosticsPlan(ARTIFACT_FILENAMES.simulatorStderr, simulation?.stderr ?? null),
    diagnosticsPlan(ARTIFACT_FILENAMES.controlStdout, artifacts.controlStdout),
    diagnosticsPlan(ARTIFACT_FILENAMES.controlStderr, artifacts.controlStderr),
  ];
  return planned.filter((plan): plan is ArtifactFilePlan => plan !== null);
}

/** A Verilog source file, banner-commented when truncated so it stays valid Verilog. */
function sourcePlan(filename: string, captured: CapturedText | null): ArtifactFilePlan | null {
  return captured === null ? null : filePlan(filename, captured, '// ');
}

/** A plain-text diagnostics file, banner-prefixed when truncated. */
function diagnosticsPlan(filename: string, captured: CapturedText | null): ArtifactFilePlan | null {
  return captured === null ? null : filePlan(filename, captured, '');
}

/** One planned file: the captured text, preceded by a truncation banner when it was cut. */
function filePlan(
  filename: string,
  captured: CapturedText,
  bannerPrefix: string,
): ArtifactFilePlan {
  const contents = captured.truncated
    ? `${bannerPrefix}${truncationBanner(captured)}\n${captured.text}`
    : captured.text;
  return {
    filename,
    contents,
    truncated: captured.truncated,
    originalChars: captured.originalChars,
  };
}

/** The one-line warning that a reader is not looking at the whole value. */
function truncationBanner(captured: CapturedText): string {
  const end = captured.keptEnd === 'head' ? 'first' : 'last';
  return (
    `TRUNCATED: the captured value was ${captured.originalChars} characters; ` +
    `only the ${end} ${captured.text.length} are below.`
  );
}

/** The oracle evidence `outcome.json` carries; the stream text lives in sibling files. */
export type CapturedSimulationSummary = Omit<CapturedSimulation, 'stdout' | 'stderr'>;

/** One written file, as `outcome.json` describes it. */
export interface ArtifactFileNote {
  readonly truncated: boolean;
  readonly originalChars: number;
}

/**
 * The machine-readable index written beside one sample's artifacts.
 *
 * The verdict fields are the SAME values the results record carries, copied so a reader
 * holding only this directory can interpret it without the results log. The simulator
 * streams are deliberately not repeated here - they are the sibling files - so the index
 * stays small enough to grep across a whole campaign.
 */
export interface ArtifactDocument {
  readonly schemaVersion: number;
  readonly problemId: string;
  readonly sampleIndex: number;
  readonly seed: number;
  readonly outcomeStatus: SampleOutcomeStatus;
  readonly passed: boolean;
  readonly iterations: number;
  readonly stopReason: BudgetStopReason | null;
  readonly failureNote: string | null;
  /** The INDEPENDENT judge's verdict; disagreement with `passed` is the whole point. */
  readonly goldenVerdict: RecordedGoldenVerdict | null;
  /**
   * The POSITIVE CONTROL's verdict on the `testbench.v` in this directory.
   *
   * `invalid` says the benchmark's own reference design does not pass that testbench, so
   * `passed` above is not a statement about the model and this sample was excluded from
   * pass@k. The control's own toolchain output is in the sibling `control-*.txt` files.
   */
  readonly instrumentVerdict: RecordedInstrumentVerdict;
  /** The control run's exit code, or `null` when no control ran or it did not exit. */
  readonly controlExitCode: number | null;
  /**
   * What the NEGATIVE control measured, or `null` when it measured nothing.
   *
   * `mutation.coverageGapSurvivors` is the actionable output of this whole directory: each
   * entry names an operator plus the line and column in RTLLM's reference design where a defect
   * was injected that the independent golden testbench CATCHES and the `testbench.v` beside
   * this file does NOT. That is a coverage gap in our Testbench_Agent, stated concretely enough
   * to fix.
   *
   * `mutation.candidateEquivalentSurvivors` is the second, weaker list: neither testbench
   * killed those, so they MAY be equivalent to the original. They are recorded rather than
   * discarded because simulation cannot decide equivalence, and this directory is where a human
   * has the site excerpt needed to decide it by reading.
   */
  readonly mutation: MutationProbeReport | null;
  readonly simulation: CapturedSimulationSummary | null;
  readonly failingCase: CapturedFailingCase | null;
  /** Files written for this sample; a filename ABSENT here was never produced. */
  readonly files: Readonly<Record<string, ArtifactFileNote>>;
}

/** The oracle evidence without the stream text (pure). */
function simulationSummary(simulation: CapturedSimulation): CapturedSimulationSummary {
  return {
    verdict: simulation.verdict,
    checks: simulation.checks,
    checksTruncated: simulation.checksTruncated,
    exitCode: simulation.exitCode,
  };
}

/** The per-file notes, keyed by filename (pure). */
function fileNotes(files: readonly ArtifactFilePlan[]): Readonly<Record<string, ArtifactFileNote>> {
  const notes: Record<string, ArtifactFileNote> = {};
  for (const file of files) {
    notes[file.filename] = { truncated: file.truncated, originalChars: file.originalChars };
  }
  return notes;
}

/** Assemble one sample's `outcome.json` document (pure). */
export function artifactDocument(
  descriptor: EvalArtifactDescriptor,
  artifacts: EvalSampleArtifacts,
  files: readonly ArtifactFilePlan[],
): ArtifactDocument {
  return {
    schemaVersion: ARTIFACT_DOCUMENT_SCHEMA_VERSION,
    problemId: descriptor.problemId,
    sampleIndex: descriptor.sampleIndex,
    seed: descriptor.seed,
    outcomeStatus: artifacts.outcomeStatus,
    passed: artifacts.passed,
    iterations: artifacts.iterations,
    stopReason: artifacts.stopReason,
    failureNote: artifacts.failureNote,
    goldenVerdict: artifacts.goldenVerdict,
    instrumentVerdict: artifacts.instrumentVerdict,
    controlExitCode: artifacts.controlExitCode,
    mutation: artifacts.mutation,
    simulation: artifacts.simulation === null ? null : simulationSummary(artifacts.simulation),
    failingCase: artifacts.failingCase,
    files: fileNotes(files),
  };
}

/** One sample's `outcome.json` text, pretty-printed so a human can read it (pure). */
export function encodeArtifactDocument(
  descriptor: EvalArtifactDescriptor,
  artifacts: EvalSampleArtifacts,
  files: readonly ArtifactFilePlan[],
): string {
  return `${JSON.stringify(artifactDocument(descriptor, artifacts, files), null, 2)}\n`;
}
