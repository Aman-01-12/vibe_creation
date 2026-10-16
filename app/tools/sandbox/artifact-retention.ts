// Bounded, content-addressed retention of a run's registered artifact BYTES, so a caller that
// needs a report's TEXT can get it without the seam carrying bytes (Req 11.2, 11.10).
//
// THE GAP THIS CLOSES, AND WHY IT IS HERE RATHER THAN ON THE SEAM
//   `SandboxResult.artifacts` is a `Record<string, ArtifactBlobRef>` - a name, a size, and a
//   SHA-256, and NO bytes. That is the model the seam documents ("their bytes live in the blob
//   store, fetched by ref, never inline contents", `../synth/adapter.ts`), and nothing consumed
//   artifact bytes until the Formal_Oracle, whose whole verdict is a JSON report the worker wrote
//   into the workspace. So the report's text had no channel at all: `_hash_artifact` returns three
//   fields, `parseArtifacts` in `./runtime-local-worker.ts` parses exactly those three, and the
//   runtime removes the workspace in a `finally`, so the file is gone before any caller resumes.
//
//   This module is the resolve-by-ref side of that model for the local worker runtime, and it is
//   deliberately NOT a widening of the seam. `contract.ts`, `contract-schema.ts`, the byte-mirror
//   `contract.schema.json`, the worker, and the Python gate are all untouched: a `SandboxResult`
//   still carries refs only, and a caller that wants bytes asks a store that was given them.
//
// CONTENT-ADDRESSED, WHICH IS WHAT MAKES A LOOKUP A LOOKUP
//   Blobs are keyed by the `sha256` the ref ALREADY carries, and the digest is RECOMPUTED over the
//   bytes before an entry is admitted. So `readText(ref)` is a pure lookup rather than a second
//   source of truth about which file is which, identical bytes are stored once, and a key means
//   what it says instead of meaning "whatever was at that path when we looked".
//
// THIS HOLDS UNTRUSTED TOOL OUTPUT IN MEMORY, SO EVERY BOUND IS LOAD-BEARING
//   The bytes are written inside a sandbox workspace by a separate process, over input this
//   project did not author, so their SIZE, their PATH, and their CONTENT are all attacker-influenced
//   in the threat model this layer exists for. Four bounds, each closing one of those:
//     1. A PER-ARTIFACT byte cap, checked against the real file before it is read whole.
//     2. A TOTAL byte cap with eviction, so a long-lived store behind a long-lived runtime cannot
//        grow without limit - which is the memory-leak shape an unbounded cache of untrusted
//        output always has.
//     3. PATH CONFINEMENT plus a regular-file check, so a ref naming `../../etc/passwd`, an
//        absolute path, or a symlink out of the workspace reads nothing.
//     4. ONLY what the run REGISTERED as an artifact is read. The workspace is never walked, so a
//        file the worker wrote and did not register is not retained and cannot be asked for.
//
// `null` IS THE FAIL-SAFE ANSWER AND MUST STAY ONE
//   Every refusal above returns `null` from `readText`, and so does an absent blob. For the one
//   caller this exists for, `null` flows into `report === null` and `readFormalPrepassReport('')`,
//   both of which already mean "we have no evidence" and both of which yield `could-not-verify`.
//   So a retention failure costs a verdict we were entitled to and can never manufacture one we
//   were not. Nothing here truncates: a truncated JSON report is not a report, and repairing one
//   would be inventing evidence, which is the same rule `MAX_REPORT_CHARS` follows.
//
// Not pure - it reads files - but TOTAL: `retain` never throws and never rejects, on any input.
// It runs after a run's verdict has already been measured, so failing that run because its
// scratch bytes could not be kept would trade a diagnostic for a wrong answer.

import { createHash } from 'node:crypto';
import { lstat, readFile } from 'node:fs/promises';
import { isAbsolute, resolve, sep } from 'node:path';

import type { ArtifactBlobRef } from './contract.js';

/**
 * The largest single artifact whose bytes are retained, in BYTES.
 *
 * Twice `MAX_REPORT_CHARS` (65_536), which is the size bound the one consumer of these bytes
 * applies to a document before it will parse it at all - so a file that cannot pass THAT bound is
 * not worth holding. The two bounds are in different units on purpose: the consumer counts UTF-16
 * code units and this counts UTF-8 bytes, and a code unit costs up to three bytes, so 2x admits
 * every honest report with room to spare. An honest report is ASCII JSON apart from the worker's
 * own `stderrTail`, which the worker bounds at 4096 characters, making the widest honest document
 * roughly 4.3 KiB - thirty times smaller than this cap.
 *
 * The one document this refuses that the consumer WOULD have accepted is a 64 KiB report written
 * almost entirely in multibyte characters, which no honest report is. That refusal is `null`,
 * which is the fail-safe answer; admitting in the other direction would let a tool's output decide
 * how much memory this process holds.
 */
export const MAX_RETAINED_ARTIFACT_BYTES = 131_072;

/**
 * The total bytes retained across all blobs, in BYTES. Eviction keeps the store at or under it.
 *
 * Eight times the per-artifact cap. The floor it has to clear is what ONE caller can have in
 * flight: a formal proof reads one pre-pass report and then one proof report per ladder rung, each
 * immediately after the run that wrote it, so two documents is the real high-water mark and
 * 256 KiB would be the smallest correct total. 1 MiB is four times that, which is what keeps the
 * eviction rule from ever discarding a document a live run is about to read, while still being a
 * FIXED ceiling that no amount of untrusted output can grow.
 *
 * `MAX_RETAINED_ARTIFACT_BYTES <= MAX_RETAINED_TOTAL_BYTES` is an invariant `#insert` relies on -
 * it is why evicting everything always makes room - and it is pinned by a test rather than left as
 * an arithmetic coincidence between two constants.
 */
export const MAX_RETAINED_TOTAL_BYTES = 1_048_576;

/**
 * Where a runtime hands over the bytes of the artifacts one run registered.
 *
 * A PORT rather than a concrete class, so `LocalWorkerRuntime` names no store and a runtime given
 * none simply retains nothing - which is the same `null` every other refusal produces.
 */
export interface ArtifactRetentionSink {
  /**
   * Retain what can be retained of the artifacts one run registered, before its workspace goes.
   *
   * Never throws and never rejects. An artifact that cannot be retained is simply absent later.
   */
  retain(
    workspaceRoot: string,
    artifacts: Readonly<Record<string, ArtifactBlobRef>>,
  ): Promise<void>;
}

/** One retained blob: its decoded text, and the byte count it is charged against the total. */
interface RetainedBlob {
  readonly text: string;
  readonly bytes: number;
}

/**
 * The absolute path of one registered artifact, or `null` where a bound refuses it.
 *
 * `name` is a workspace-relative path the WORKER chose (`str(path.relative_to(workspace_root))`),
 * which makes it untrusted input naming a filesystem location - the shape that has to be confined
 * rather than trusted. An empty name, an absolute name, and anything that resolves outside the
 * workspace are all refused; `resolve` collapses `..` first, so `a/../../x` is caught by the same
 * check as a bare `../x`.
 */
function confinedArtifactPath(workspaceRoot: string, name: string): string | null {
  if (name.length === 0 || isAbsolute(name)) {
    return null;
  }
  const root = resolve(workspaceRoot);
  const target = resolve(root, name);
  return target.startsWith(`${root}${sep}`) ? target : null;
}

/**
 * The bytes of one file, or `null` where it is too large, is not a regular file, or cannot be read.
 *
 * The size is checked from `lstat` BEFORE the read, so an oversized artifact costs one stat rather
 * than its own size in memory, and re-checked after, so the answer does not rest on a stat alone.
 * `lstat` rather than `stat`: a symlink must be refused, not followed - one inside the workspace
 * can point anywhere, and following it would read a file the run never produced.
 */
async function readRetainableBytes(path: string): Promise<Buffer | null> {
  try {
    const entry = await lstat(path);
    if (!entry.isFile() || entry.size > MAX_RETAINED_ARTIFACT_BYTES) {
      return null;
    }
    const bytes = await readFile(path);
    return bytes.byteLength > MAX_RETAINED_ARTIFACT_BYTES ? null : bytes;
  } catch {
    // Vanished, unreadable, or a name the OS refuses. Not a silent catch: the failure has exactly
    // one honest reading - we do not have these bytes - and that reading is the return value.
    return null;
  }
}

/** The lowercase-hex SHA-256 of some bytes, in the same form an `ArtifactBlobRef` carries. */
function sha256Of(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * A bounded, content-addressed, in-memory store of registered artifact text.
 *
 * Satisfies `ArtifactRetentionSink` for the runtime that fills it and, structurally, the
 * resolve-by-ref port its reader needs - one object on both sides of the composition root, so
 * there is no second place where a ref could be mapped to different bytes.
 *
 * Instance-scoped, deliberately: a module-level singleton would outlive every caller and make the
 * total cap the only thing standing between the process and a permanent megabyte. A composition
 * root that wants retention creates one and holds it exactly as long as it holds the runtime.
 */
export class BoundedArtifactRetention implements ArtifactRetentionSink {
  /** SHA-256 to blob, in insertion order - which is the eviction order `#insert` uses. */
  readonly #blobs = new Map<string, RetainedBlob>();

  /** The sum of `bytes` over `#blobs`, maintained on every insert and every eviction. */
  #totalBytes = 0;

  /** Retain every registered artifact that clears the bounds. Total: never throws. */
  async retain(
    workspaceRoot: string,
    artifacts: Readonly<Record<string, ArtifactBlobRef>>,
  ): Promise<void> {
    for (const artifact of Object.values(artifacts)) {
      await this.#retainOne(workspaceRoot, artifact);
    }
  }

  /**
   * The text retained for one artifact ref, or `null` when these bytes are not held.
   *
   * Keyed on the ref's `sha256` alone, so the answer does not depend on a workspace that no longer
   * exists, on a name a later run reused, or on any state outside this store. `null` covers every
   * refusal and every absence alike, because to the caller they are one fact: no evidence.
   *
   * Async because resolving a ref to bytes is an async operation in general - a real blob store is
   * a fetch - and the caller's port is written for that. Here it is an in-memory lookup.
   */
  readText(artifact: ArtifactBlobRef): Promise<string | null> {
    return Promise.resolve(this.#blobs.get(artifact.sha256)?.text ?? null);
  }

  /** Bytes currently retained. Exposed so a bound can be ASSERTED rather than assumed. */
  get retainedBytes(): number {
    return this.#totalBytes;
  }

  /**
   * Retain one artifact, or leave it absent.
   *
   * The digest is RECOMPUTED and compared before the blob is admitted. That is what makes the key
   * honest: without it a run could register a ref whose hash names one document while the file on
   * disk holds another, and `readText(ref)` would hand back bytes the ref does not describe. A
   * mismatch is treated as "we do not have these bytes", which is the fail-safe reading.
   */
  async #retainOne(workspaceRoot: string, artifact: ArtifactBlobRef): Promise<void> {
    const known = this.#blobs.get(artifact.sha256);
    if (known !== undefined) {
      // Same content, already held: no second read, and refreshed to the newest position so a
      // blob a live run just produced is not the next one evicted.
      this.#blobs.delete(artifact.sha256);
      this.#blobs.set(artifact.sha256, known);
      return;
    }
    const path = confinedArtifactPath(workspaceRoot, artifact.name);
    if (path === null) {
      return;
    }
    const bytes = await readRetainableBytes(path);
    if (bytes === null || sha256Of(bytes) !== artifact.sha256) {
      return;
    }
    this.#insert(artifact.sha256, bytes);
  }

  /**
   * Insert one blob, evicting oldest-first until it fits under the total cap.
   *
   * Oldest-first by LAST WRITE, so the entry a just-finished run produced is the last thing
   * evicted and the document that run is about to read is always still here. The loop always
   * terminates and always makes room: each pass removes one entry, and
   * `MAX_RETAINED_ARTIFACT_BYTES <= MAX_RETAINED_TOTAL_BYTES` means an empty store fits anything
   * this far - so there is no branch for "still does not fit", because there is no such state.
   *
   * ponytail: eviction is by last WRITE, not by last read - a `readText` does not refresh a
   * blob's position. For the access pattern this exists for (write, then read once, immediately)
   * the two orders are identical, and the upgrade to a true LRU is one `delete`/`set` inside
   * `readText` if a caller ever holds a ref across many later runs.
   */
  #insert(sha256: string, bytes: Buffer): void {
    const size = bytes.byteLength;
    for (const [oldest, blob] of this.#blobs) {
      if (this.#totalBytes + size <= MAX_RETAINED_TOTAL_BYTES) {
        break;
      }
      this.#blobs.delete(oldest);
      this.#totalBytes -= blob.bytes;
    }
    this.#blobs.set(sha256, { text: bytes.toString('utf8'), bytes: size });
    this.#totalBytes += size;
  }
}
