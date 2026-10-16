// The Node-backed artifact sink: one directory per sample under the run's output
// directory.
//
// A DIAGNOSTIC WRITE MAY NEVER COST A SAMPLE
//   Every failure mode here - a full disk, a read-only mount, a path the OS refuses - is
//   caught and reported as one sanitized note. The sample's oracle verdict was already
//   measured and recorded by the time this runs, so losing its evidence loses only the
//   evidence. A campaign with hours invested in it must not end because a file could not
//   be written, which is why nothing in this module throws.
//
// RESUME IS SAFE BY CONSTRUCTION
//   A sample already recorded for this config is SKIPPED by the runner, so its artifacts
//   are never touched by a re-run. A sample that IS re-run writes to the same deterministic
//   path with a TRUNCATING write - or, for the trace, a rename that replaces it whole - so
//   nothing accumulates and nothing interleaves: there is no append here, and therefore no
//   way to duplicate or half-extend an existing artifact. `outcome.json` is the authority
//   for WHICH files belong to a capture, so a file left over from an interrupted earlier
//   attempt is identifiable rather than silently believed.
//
// A COUNTEREXAMPLE IS WRITTEN WHOLE OR NOT AT ALL (Req 12.16)
//   The capture hands over a `refuted` sample's trace WHOLE, read where its own refuting run
//   ended, beside the reference it must hash to - this layer resolves nothing, because the
//   retention store the bytes sat in holds 1 MiB in total and every run on a shared runtime
//   keeps filling it, so a reader that waited until the sample was measured could lose the
//   race. `counterexample.vcd` is written only when those bytes are provably the whole trace:
//   within `MAX_COUNTEREXAMPLE_TRACE_BYTES`, and hashing to the carried SHA-256. The bytes
//   crossed the `EvalArtifactSink` port, so they are untrusted here, and the digest makes
//   wholeness a fact rather than the capture's claim - a truncated or substituted answer is
//   refused rather than written as a cut trace. The file is staged and renamed into place, so
//   the final name never holds a partial trace even when the write itself fails.
//
// EVERY WAY A REFUTED SAMPLE CAN LACK ITS TRACE LEAVES A NOTE (Req 12.25)
//   A refuted sample whose bytes cannot be written whole gets NO file and exactly ONE
//   sanitized note, so an absent `counterexample.vcd` beside a recorded reference reads as
//   "the trace existed and these bytes are gone", which is a different and honest fact from
//   "never produced". The note names the oracle's own reason where it has one (`over-cap`,
//   `unresolved`, `read-failed`), the loop's marker where the recorded locator is not a usable
//   reference (`malformed-reference`), and this layer's own refusal where the bytes are not the
//   ones the reference names - five reasons, all of them reported, none of them silent.
//
// NO PATH REACHES THE OPERATOR
//   The note names the sample by its already-sanitized path segments, never the absolute
//   path or the errno - the same discipline as `./results-log-node.ts`.

import { createHash } from 'node:crypto';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  MAX_COUNTEREXAMPLE_TRACE_BYTES,
  type CapturedCounterexample,
  type CapturedCounterexampleAbsence,
  type EvalArtifactDescriptor,
  type EvalArtifactSink,
  type EvalSampleArtifacts,
} from '../artifact-sink.js';
import {
  ARTIFACT_FILENAMES,
  artifactSampleSegments,
  counterexampleTracePlan,
  encodeArtifactDocument,
  planArtifactFiles,
  type ArtifactFilePlan,
} from './artifact-layout.js';

/** The injected collaborators the store needs; no globals and no environment. */
export interface FileSystemArtifactStoreDeps {
  /** The run's output directory; every artifact is written strictly inside it. */
  readonly outputDir: string;
  /**
   * Sanitized note sink for a write that failed.
   *
   * Wired to the sweep's progress sink, so an operator watching a multi-hour run learns
   * that evidence is being lost WHILE it happens rather than by noticing empty
   * directories afterwards.
   */
  readonly onNote: (note: string) => void;
}

/**
 * The artifact store for one run.
 *
 * `sinkFor` binds an arm name and returns the `EvalArtifactSink` the harness drives for
 * that arm's samples. The arm is bound here because this is the layer that honestly knows
 * it: the harness measures one sample and is never told which arm it belongs to.
 *
 * Construction performs no I/O, so building the store for every arm before the first
 * dispatch cannot fail a run; directories are created lazily on first write.
 */
export class FileSystemArtifactStore {
  readonly #outputDir: string;
  readonly #onNote: (note: string) => void;

  constructor(deps: FileSystemArtifactStoreDeps) {
    this.#outputDir = deps.outputDir;
    this.#onNote = deps.onNote;
  }

  /** The sink writing one arm's sample artifacts. */
  sinkFor(armName: string): EvalArtifactSink {
    return new ArmArtifactSink(this.#outputDir, armName, this.#onNote);
  }
}

/** The per-arm sink; holds no per-sample state, so one instance serves an arm's samples. */
class ArmArtifactSink implements EvalArtifactSink {
  readonly #outputDir: string;
  readonly #armName: string;
  readonly #onNote: (note: string) => void;

  constructor(outputDir: string, armName: string, onNote: (note: string) => void) {
    this.#outputDir = outputDir;
    this.#armName = armName;
    this.#onNote = onNote;
  }

  /** Write one sample's artifacts, reporting a sanitized note if any of it fails. */
  async write(descriptor: EvalArtifactDescriptor, artifacts: EvalSampleArtifacts): Promise<void> {
    const segments = artifactSampleSegments(
      this.#armName,
      descriptor.problemId,
      descriptor.sampleIndex,
    );
    const sample = segments.join('/');
    try {
      const files = planArtifactFiles(artifacts);
      const trace = this.#counterexampleTrace(artifacts.formalCounterexampleCapture, sample);
      const index = encodeArtifactDocument(
        descriptor,
        artifacts,
        trace === null ? files : [...files, trace],
      );
      await writeSampleDirectory(join(this.#outputDir, ...segments), files, trace, index);
    } catch {
      // The errno detail names the path and the mount and carries nothing an operator
      // cannot see from the config, so it is classified rather than surfaced. The segments
      // are already charset-restricted, so the note is safe to print verbatim.
      this.#onNote(`artifacts for ${sample} could not be written; the sample's verdict stands`);
    }
  }

  /**
   * The trace's file plan, or `null` - with the reason reported as ONE note whenever a refuted
   * sample's bytes cannot be written whole (Req 12.25).
   *
   * No capture means no trace existed: the sample was not `refuted`, so it gets no file and no
   * note - which is every sample of a run with the formal gate off, and every proof.
   */
  #counterexampleTrace(
    capture: CapturedCounterexample | null,
    sample: string,
  ): ArtifactFilePlan | null {
    if (capture === null) {
      return null;
    }
    const decision = decideCounterexampleTrace(capture);
    if (decision.kind === 'write') {
      return counterexampleTracePlan(decision.trace);
    }
    this.#onNote(
      `${ARTIFACT_FILENAMES.counterexampleTrace} for ${sample} was not written: ` +
        `${TRACE_REFUSAL_NOTES[decision.refusal]}; the sample's verdict stands`,
    );
    return null;
  }
}

/**
 * Why a `refuted` sample produced no `counterexample.vcd`.
 *
 * The capture's four absences, REUSED rather than restated, plus this layer's own: bytes that
 * are not the ones the carried reference names. That one is decided here because only the
 * writer decides what reaches a disk.
 */
type TraceRefusal = CapturedCounterexampleAbsence | 'not-the-recorded-trace';

/** One carried Counterexample decided: write these bytes, or report this reason. */
type TraceDecision =
  | { readonly kind: 'write'; readonly trace: string }
  | { readonly kind: 'refused'; readonly refusal: TraceRefusal };

/**
 * What each refusal tells the operator. A total `Record`, so a new refusal is a compile error
 * here rather than an unexplained note. None names a path, a digest, or any tool's own error
 * text: the reference itself is recorded in `outcome.json` for a reader locating the trace.
 */
const TRACE_REFUSAL_NOTES: Readonly<Record<TraceRefusal, string>> = Object.freeze({
  'over-cap': `the trace exceeds its ${MAX_COUNTEREXAMPLE_TRACE_BYTES}-byte cap`,
  unresolved: 'its bytes could not be resolved',
  'read-failed': 'reading its bytes failed',
  'malformed-reference': 'no usable reference was recorded to locate it by',
  'not-the-recorded-trace': 'the bytes carried are not the whole trace its reference names',
});

/** One refusal, as a decision. */
function refused(refusal: TraceRefusal): TraceDecision {
  return { kind: 'refused', refusal };
}

/**
 * Decide one carried Counterexample: the WHOLE trace to write, or why there is none. Total.
 *
 * The bytes crossed the `EvalArtifactSink` port, so they are checked as the untrusted input
 * they are: against the trace's own cap, before they are hashed, then by SHA-256 against the
 * reference the capture carries them beside. The digest is what makes the write whole or
 * nothing - a truncated or substituted trace is different bytes, so it can never reach the disk
 * as a cut trace. An `absent` capture is already a reason, and is passed through as one.
 */
function decideCounterexampleTrace(capture: CapturedCounterexample): TraceDecision {
  if (capture.kind === 'absent') {
    return refused(capture.reason);
  }
  if (Buffer.byteLength(capture.trace, 'utf8') > MAX_COUNTEREXAMPLE_TRACE_BYTES) {
    return refused('over-cap');
  }
  const digest = createHash('sha256').update(capture.trace, 'utf8').digest('hex');
  return digest === capture.reference.sha256
    ? { kind: 'write', trace: capture.trace }
    : refused('not-the-recorded-trace');
}

/**
 * Create one sample's directory and write its files, its trace, then its index.
 *
 * The index is written LAST so a directory holding `outcome.json` is a COMPLETE capture: a
 * crash partway through leaves sibling files with no index, which reads as interrupted
 * rather than as a sample that produced nothing. A trace whose write fails therefore fails
 * the capture by the same rule, and is never listed by an index that reached the disk.
 */
async function writeSampleDirectory(
  dir: string,
  files: readonly ArtifactFilePlan[],
  trace: ArtifactFilePlan | null,
  index: string,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const file of files) {
    // Sequential and TRUNCATING: a re-run of the same sample overwrites its own artifacts
    // in place, so nothing accumulates and nothing is half-extended.
    await writeFile(join(dir, file.filename), file.contents, 'utf8');
  }
  if (trace !== null) {
    // Staged rather than truncated in place: a cut source is labeled by its banner, but no
    // banner makes a cut trace readable, so the trace lands whole or not at all.
    await writeWhole(join(dir, trace.filename), trace.contents);
  }
  await writeFile(join(dir, ARTIFACT_FILENAMES.outcome), index, 'utf8');
}

/** Suffix of the staging name a whole-or-nothing file is written under before its rename. */
const STAGING_SUFFIX = '.partial';

/**
 * Write one file WHOLE OR NOT AT ALL: to a staging name, then renamed over the final one.
 *
 * `rename` replaces the final name atomically, so it only ever holds the complete bytes -
 * never a prefix, even when the write itself fails partway. The `finally` removes the
 * staging file whatever happened: after a rename there is nothing there, and after a failure
 * it is the partial bytes. The failure still propagates, so the caller's one note reports it
 * rather than this swallowing it. A process killed between the two steps leaves only the
 * staging name, which no reader takes for a trace and the next attempt overwrites.
 */
async function writeWhole(path: string, contents: string): Promise<void> {
  const staging = `${path}${STAGING_SUFFIX}`;
  try {
    await writeFile(staging, contents, 'utf8');
    await rename(staging, path);
  } finally {
    await rm(staging, { force: true });
  }
}
