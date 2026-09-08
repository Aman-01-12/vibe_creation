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
//   path with a TRUNCATING write, so nothing accumulates and nothing interleaves: there is
//   no append here, and therefore no way to duplicate or half-extend an existing artifact.
//   `outcome.json` is the authority for WHICH files belong to a capture, so a file left over
//   from an interrupted earlier attempt is identifiable rather than silently believed.
//
// NO PATH REACHES THE OPERATOR
//   The note names the sample by its already-sanitized path segments, never the absolute
//   path or the errno - the same discipline as `./results-log-node.ts`.

import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  EvalArtifactDescriptor,
  EvalArtifactSink,
  EvalSampleArtifacts,
} from '../artifact-sink.js';
import {
  ARTIFACT_FILENAMES,
  artifactSampleSegments,
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
    try {
      const files = planArtifactFiles(artifacts);
      const index = encodeArtifactDocument(descriptor, artifacts, files);
      await writeSampleDirectory(join(this.#outputDir, ...segments), files, index);
    } catch {
      // The errno detail names the path and the mount and carries nothing an operator
      // cannot see from the config, so it is classified rather than surfaced. The segments
      // are already charset-restricted, so the note is safe to print verbatim.
      this.#onNote(
        `artifacts for ${segments.join('/')} could not be written; the sample's verdict stands`,
      );
    }
  }
}

/**
 * Create one sample's directory and write its files, then its index.
 *
 * The index is written LAST so a directory holding `outcome.json` is a COMPLETE capture: a
 * crash partway through leaves sibling files with no index, which reads as interrupted
 * rather than as a sample that produced nothing.
 */
async function writeSampleDirectory(
  dir: string,
  files: readonly ArtifactFilePlan[],
  index: string,
): Promise<void> {
  await mkdir(dir, { recursive: true });
  for (const file of files) {
    // Sequential and TRUNCATING: a re-run of the same sample overwrites its own artifacts
    // in place, so nothing accumulates and nothing is half-extended.
    await writeFile(join(dir, file.filename), file.contents, 'utf8');
  }
  await writeFile(join(dir, ARTIFACT_FILENAMES.outcome), index, 'utf8');
}
