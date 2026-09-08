// The Node-backed calibration cache: one JSON file per problem, OUTSIDE any run directory.
//
// WHY IT DOES NOT LIVE UNDER THE RUN'S `outputDir`
//   A calibration is a property of (reference RTL, golden testbench, mutation config, mutant wall
//   cap) and of nothing else - not the model, not the arm, not the sample, not the campaign.
//   Filing it under one run's output directory would make every new campaign recompute it, which
//   is the opposite of why it is cached. So it lives in a repo-level cache directory keyed by the
//   corpus commit, the mutation config hash, and the mutant wall cap, and a second campaign
//   against the same corpus pays nothing for it.
//
// THE KEY IS IN THE PATH *AND* IN THE DOCUMENT
//   The path keeps two different keys from ever addressing the same file; the in-document key
//   is what `decodeCalibrationCache` verifies before trusting a hit. Belt and braces on
//   purpose: the file is on disk between runs, so it can be moved, copied, or hand-edited, and
//   a wrongly accepted cache would silently shrink the detectable set and flatter our
//   testbench. Path-only keying would trust the filename.
//
// IT IS A CACHE, SO EVERY FAILURE IS A MISS
//   Nothing here throws for a missing, unreadable, or unwritable file. A miss costs a
//   recalibration - deterministic, no model calls - and the calibrator reports it as a note.
//   Losing the cache can never change a verdict, only the wall clock.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  renderCalibrationCacheKey,
  type MutationCalibrationCacheKey,
  type MutationCalibrationCachePort,
} from '../corpus/mutation-calibration.js';
import { safePathSegment } from './artifact-layout.js';

/** The repo-level cache directory, relative to the repository root. */
export const EVAL_CACHE_DIRNAME = '.eval-cache';

/** The calibration cache's subdirectory inside `EVAL_CACHE_DIRNAME`. */
export const CALIBRATION_CACHE_DIRNAME = 'mutation-calibration';

/** The injected collaborators the cache needs; no globals and no environment. */
export interface FileSystemCalibrationCacheDeps {
  /** The repository root the cache directory hangs off. */
  readonly repositoryRoot: string;
  /** The key this cache instance reads and writes under. */
  readonly cacheKey: MutationCalibrationCacheKey;
}

/**
 * The directory one cache key's documents live in.
 *
 * Every component is reduced by `safePathSegment`, so a corpus commit, a config hash, or the
 * rendered wall cap - all derived values rather than operator input, but none of which this module
 * gets to assume - cannot contribute a path separator or a parent reference.
 */
export function calibrationCacheDirectory(deps: FileSystemCalibrationCacheDeps): string {
  return join(
    deps.repositoryRoot,
    EVAL_CACHE_DIRNAME,
    CALIBRATION_CACHE_DIRNAME,
    ...renderCalibrationCacheKey(deps.cacheKey).split('/').map(safePathSegment),
  );
}

/** A `MutationCalibrationCachePort` over one directory of per-problem JSON documents. */
export class FileSystemCalibrationCache implements MutationCalibrationCachePort {
  readonly #directory: string;

  constructor(deps: FileSystemCalibrationCacheDeps) {
    this.#directory = calibrationCacheDirectory(deps);
  }

  async read(problemId: string): Promise<string | null> {
    try {
      return await readFile(this.#pathFor(problemId), 'utf8');
    } catch {
      // Missing and unreadable are the same thing to the caller: recalibrate.
      return null;
    }
  }

  async write(problemId: string, text: string): Promise<void> {
    const path = this.#pathFor(problemId);
    await mkdir(dirname(path), { recursive: true });
    // TRUNCATING, never appending: a recalibration replaces its own document in place, so a
    // stale verdict cannot survive beside a fresh one.
    await writeFile(path, text, 'utf8');
  }

  /** The document path for one problem; the id is charset-reduced to a single segment. */
  #pathFor(problemId: string): string {
    return join(this.#directory, `${safePathSegment(problemId)}.json`);
  }
}
