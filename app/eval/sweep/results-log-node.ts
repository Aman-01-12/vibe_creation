// The Node-backed `ResultsLogPort`: append-only JSONL on the real filesystem.
//
// Kept separate from `./results-log.ts` so the record shape, the decoding, and the
// resume decision stay pure and unit-testable with no disk, and so the only module in
// the sweep that touches `node:fs` for results is this thin one.
//
// DURABILITY IS THE WHOLE POINT
//   Each append opens the file, writes one line, and closes it. That is slower than
//   holding a stream open, and it is the right trade: a sample costs seconds to minutes
//   of paid model time, so an extra file open per sample is free by comparison, and it
//   removes the failure mode where a buffered stream loses its tail because the process
//   was killed. `appendFile` with the `a` flag is atomic enough for the single-writer
//   case this is: one sweep process owns one results file.
//
// READS ARE BOUNDED
//   The file is untrusted input on resume, so the read refuses a file larger than the
//   cap rather than pulling an unbounded amount into memory. A run that legitimately
//   exceeds it should be split, which is also better for analysis.

import { appendFile, mkdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  MAX_RESULTS_FILE_BYTES,
  RESULTS_LOG_FILENAME,
  type ResultsLogPort,
} from './results-log.js';

/** The error a results-log read or write reports; carries no path and no errno detail. */
export class ResultsLogError extends Error {
  readonly code: 'too-large' | 'unwritable';

  constructor(code: 'too-large' | 'unwritable', detail: string) {
    super(detail);
    this.name = 'ResultsLogError';
    this.code = code;
  }
}

/** The path of the results log inside a run's output directory. */
export function resultsLogPath(outputDir: string): string {
  return join(outputDir, RESULTS_LOG_FILENAME);
}

/** Ensure a directory exists, reporting a sanitized failure when it cannot be made. */
export async function ensureDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { recursive: true });
  } catch {
    // The errno detail names the path and the mount; it carries nothing the operator
    // cannot see from the config, so it is classified rather than propagated.
    throw new ResultsLogError('unwritable', 'the run output directory could not be created');
  }
}

/** A `ResultsLogPort` over one append-only file. */
export class FileResultsLog implements ResultsLogPort {
  readonly #path: string;

  constructor(path: string) {
    this.#path = path;
  }

  async appendLine(line: string): Promise<void> {
    await ensureDirectory(dirname(this.#path));
    try {
      await appendFile(this.#path, `${line}\n`, 'utf8');
    } catch {
      // A failed append means this sample's result is not durable. It is surfaced (not
      // swallowed) so the runner can record the failure and stop trusting the log,
      // but sanitized so no path or errno reaches stdout.
      throw new ResultsLogError('unwritable', 'a results record could not be appended');
    }
  }

  async readAll(): Promise<string> {
    const size = await this.#sizeBytes();
    if (size === null) {
      return '';
    }
    if (size > MAX_RESULTS_FILE_BYTES) {
      throw new ResultsLogError(
        'too-large',
        `the results log exceeds ${MAX_RESULTS_FILE_BYTES} bytes; split the campaign into smaller runs`,
      );
    }
    try {
      return await readFile(this.#path, 'utf8');
    } catch {
      // Unreadable is treated as absent: a resume then re-runs samples rather than
      // silently believing an empty history, which is the safe direction.
      return '';
    }
  }

  /** The file's size in bytes, or null when it does not exist. */
  async #sizeBytes(): Promise<number | null> {
    try {
      const info = await stat(this.#path);
      return info.isFile() ? info.size : null;
    } catch {
      // Missing and unreadable are indistinguishable here and mean the same thing to
      // the caller: there is no history to resume from.
      return null;
    }
  }
}
