// The lifecycle of a run's workspace directory, and of the process tree that
// writes into it.
//
// WHY THESE BELONG TOGETHER
//   A run's disk footprint ends only when BOTH end. Removing the directory while a
//   process it spawned still holds a file open reclaims nothing on POSIX - the bytes
//   stay allocated to the unlinked inode until the last descriptor closes - and
//   killing the process without removing the directory leaves the bytes behind under
//   a name nobody will ever look at again. So one module owns "make the run's disk
//   footprint end when the run ends": create the workspace, kill the whole tree that
//   writes into it, remove it, and collect any that an earlier crash orphaned.
//
// THE MEASURED DEFECT THIS CLOSES
//   The worker built its workspace with `tempfile.TemporaryDirectory`, whose cleanup
//   runs in a context-manager `__exit__`. The wall-clock bound kills the worker with
//   SIGKILL, which cannot be caught, so `__exit__` never ran and the directory
//   survived with its waveform inside it. Measured on this machine with real
//   `iverilog`/`vvp`, one hung waveform-dumping run at a 5s cap left a 230 MB
//   directory behind - and, because the SIGKILL reached only the worker and not the
//   `vvp` it had spawned, the orphan kept writing after the kill and reached 1.6 GB
//   before it was stopped by hand. An eval campaign of such runs filled a 228 GB disk.
//
//   Cleanup therefore cannot live on a path the kill skips. The side that OWNS the
//   SIGKILL owns the lifecycle: TypeScript creates the directory, hands it to the
//   worker through the environment, and removes it in a `finally` that runs whether
//   the child exited normally, threw, or was killed.

import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';
import { lstat, mkdtemp, readdir, realpath, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The environment variable the worker reads its workspace root from.
 *
 * A cross-language constant, like the seam schema: `tool_runner_worker.__main__`
 * reads this exact name, and its already-supported "configured root" branch
 * deliberately does not use a self-cleaning temporary directory, because the side
 * that configured the root is the side that must remove it.
 */
export const TOOL_RUNNER_WORKSPACE_ENV = 'TOOL_RUNNER_WORKSPACE';

/**
 * Filename prefix of every workspace directory this project creates.
 *
 * It is the OWNERSHIP MARKER the reaper below bounds itself by, and it matches the
 * prefix the worker's own fallback path uses, so directories orphaned by either side
 * are recognizable as ours.
 */
export const WORKSPACE_DIR_PREFIX = 'tool-runner-ws-';

/**
 * Names the reaper will consider: the prefix plus a random suffix.
 *
 * Anchored and restricted to the character set both random-name generators draw
 * from (Node's `mkdtemp` uses six alphanumerics, Python's `tempfile` eight
 * lowercase-alphanumerics-or-underscore), so a directory a human named
 * `tool-runner-ws-keep-this` is not a candidate. Deletion is bounded by the shape of
 * the names we generate, not merely by a prefix match.
 */
const WORKSPACE_DIR_NAME = /^tool-runner-ws-[A-Za-z0-9_]{6,}$/;

/**
 * How long a workspace must have been untouched before the reaper will remove it.
 *
 * The reaper's PRIMARY guard is liveness, not age: it reads the newest modification
 * time anywhere in the tree, and a live run touches its files constantly (a hung
 * waveform dump writes tens of megabytes per second), so a running job's workspace
 * is refused however long ago it was created. Age is the secondary guard, set far
 * above every wall-clock cap configured in this repo (the longest is 60s) so the two
 * guards would have to fail together to matter.
 *
 * If they ever did, the cost is bounded in the safe direction: a run whose workspace
 * vanished under it loses its files and classifies `error`. It cannot turn into a
 * `pass`.
 */
export const STALE_WORKSPACE_MIN_AGE_MS = 6 * 60 * 60 * 1_000;

/**
 * Most filesystem entries the reaper will examine while dating one candidate.
 *
 * A workspace holds a handful of files, so this is never reached in practice. A tree
 * large enough to exhaust it is not recognizably one of ours, and an undated
 * candidate is REFUSED rather than removed - the reaper never deletes what it could
 * not finish inspecting.
 */
const REAP_ENTRY_BUDGET = 10_000;

/**
 * The sanitized note reported when a workspace could not be removed.
 *
 * A fixed string, deliberately: the underlying failure carries a path and an errno,
 * and neither may reach an operator-facing note. The run's own verdict was already
 * measured by the time cleanup runs, so this is never an error - it is a note.
 */
export const WORKSPACE_CLEANUP_FAILED_NOTE =
  'tool-runner workspace could not be removed after the run';

/** Receives sanitized workspace notes; a run is never failed by one. */
export type WorkspaceNoteSink = (note: string) => void;

/** A child running in its own process group, with a kill that reaches the group. */
export interface ProcessGroupChild {
  /** The spawned process. */
  readonly child: ChildProcess;
  /**
   * SIGKILL the child AND every process it spawned.
   *
   * Safe to call more than once and after the child has exited: a signal to a group
   * that no longer exists is ignored rather than raised.
   *
   * Declared as a bound CLOSURE rather than a method, because that is what it is and
   * what every caller needs: it is handed to a `setTimeout` callback, so it is
   * separated from this object by design. A method declaration would claim it needs a
   * receiver, which is both untrue - it closes over the child instead - and would make
   * the destructure at each call site an `unbound-method` error for a hazard that does
   * not exist here.
   */
  readonly killTree: () => void;
}

/**
 * Spawn a child in its OWN process group, with no shell and an explicit argv.
 *
 * WHY THE GROUP MATTERS. A SIGKILL to the worker alone leaves the `vvp` it spawned
 * running, and that orphan keeps writing the waveform - measured continuing to
 * 1.6 GB after its parent was killed - while also holding the file open, so removing
 * the directory would not even reclaim the bytes. Killing the group ends the writer
 * and closes the descriptor, which is what makes the removal effective.
 *
 * The group is created here rather than by the caller so `killTree` cannot be
 * pointed at a process that shares OUR group, where the negated-pid signal would
 * kill this process instead. That invariant is the reason this function exists.
 */
export function spawnInOwnProcessGroup(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv,
): ProcessGroupChild {
  const child = spawn(command, [...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env,
    // POSIX: the child becomes a session/group leader, so its pid doubles as the
    // process-group id every descendant inherits.
    detached: true,
  });
  return { child, killTree: () => killGroup(child) };
}

/**
 * SIGKILL a process group led by `child`, falling back to the child alone.
 *
 * The pid guard is a safety interlock, not a formality: `process.kill(-pid)` signals
 * a whole group, so an unspawned child (`pid === undefined`) or a nonsensical pid
 * must never reach it. A platform that refuses group signals, or a group that has
 * already exited, lands in the fallback.
 */
function killGroup(child: ChildProcess): void {
  const pid = child.pid;
  if (pid !== undefined && pid > 1) {
    try {
      process.kill(-pid, 'SIGKILL');
      return;
    } catch {
      // Group already gone, or group signals unsupported here.
    }
  }
  try {
    child.kill('SIGKILL');
  } catch {
    // Nothing left to kill; the caller already treats the run as killed.
  }
}

/**
 * Create a fresh, private workspace directory for one run.
 *
 * `mkdtemp` gives an unpredictable name and owner-only permissions, and returns a
 * directory that did not exist a moment ago, so one run can never be handed
 * another's workspace (one tenancy boundary per run).
 */
export function createWorkspaceRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), WORKSPACE_DIR_PREFIX));
}

/**
 * Remove a workspace directory and everything under it.
 *
 * Returns `null` on success, or the sanitized note when the directory could not be
 * removed. It NEVER throws and never rejects: by the time this runs the invocation's
 * verdict has already been measured, and failing a measured run because its
 * scratch directory outlived it would trade a disk leak for a wrong answer.
 *
 * Symlinks inside the workspace are unlinked, not followed (`fs.rm` recursion uses
 * `lstat`), so generated code cannot turn cleanup into a delete of something outside
 * the workspace.
 */
export async function removeWorkspaceRoot(root: string): Promise<string | null> {
  try {
    await rm(root, { recursive: true, force: true });
    return null;
  } catch {
    return WORKSPACE_CLEANUP_FAILED_NOTE;
  }
}

/** Where and how aggressively to reap; every field is injected for testability. */
export interface WorkspaceReapOptions {
  /**
   * Directory to scan. Defaults to the OS temp directory and MUST resolve inside
   * it - a root anywhere else is refused outright.
   */
  readonly root?: string;
  /** How long a candidate must have been untouched. Defaults to the constant above. */
  readonly minAgeMs?: number;
  /** The current time in epoch milliseconds. Defaults to `Date.now()`. */
  readonly now?: number;
}

/** What one reap pass did, as counts (never names, never paths). */
export interface WorkspaceReapOutcome {
  /** Stale workspace directories removed. */
  readonly removed: number;
  /** Candidates left alone because something in the tree was touched recently. */
  readonly keptFresh: number;
  /**
   * Candidates a bound refused, or that could not be removed.
   *
   * Refusal reasons are deliberately not split out: every one of them means "left
   * alone", and no caller behaves differently for one over another.
   */
  readonly refused: number;
}

/**
 * Remove workspace directories orphaned by an earlier crash.
 *
 * The `finally` in the runtime handles the normal case, including a wall-clock kill
 * of the worker. It cannot handle the case where the PARENT is killed - which is how
 * the 228 GB disk actually filled - so this collects what that leaves behind.
 *
 * EVERY BOUND, and why each one is here:
 *   1. Only inside the OS temp directory. A `root` that resolves anywhere else is
 *      refused outright, so no configuration mistake can point this at a home
 *      directory or a project tree.
 *   2. Only DIRECT children of that root; the scan never descends looking for more
 *      candidates.
 *   3. Only names matching the shape this project generates, so a directory somebody
 *      named by hand is not a candidate.
 *   4. Only real directories. A symlink named like a workspace is refused, and its
 *      target is never touched.
 *   5. Only candidates that still resolve inside the root once resolved.
 *   6. Only candidates whose whole tree has been untouched for `minAgeMs`, so a
 *      LIVE run's workspace is refused: it is being written to.
 *   7. Only candidates it could fully inspect; an undated tree is refused.
 * It never throws: a reap failure is a leak left for the next pass, not a run
 * failure.
 */
export async function reapStaleWorkspaceRoots(
  options: WorkspaceReapOptions = {},
): Promise<WorkspaceReapOutcome> {
  const scanRoot = await confinedScanRoot(options.root ?? tmpdir());
  if (scanRoot === null) {
    return { removed: 0, keptFresh: 0, refused: 0 };
  }
  const cutoff = (options.now ?? Date.now()) - (options.minAgeMs ?? STALE_WORKSPACE_MIN_AGE_MS);

  let removed = 0;
  let keptFresh = 0;
  let refused = 0;
  for (const name of await candidateNames(scanRoot)) {
    const candidate = await confinedCandidate(scanRoot, name);
    if (candidate === null) {
      refused += 1;
      continue;
    }
    const activity = await activitySince(candidate, cutoff);
    if (activity === 'active') {
      keptFresh += 1;
    } else if (activity === 'unknown' || (await removeWorkspaceRoot(candidate)) !== null) {
      refused += 1;
    } else {
      removed += 1;
    }
  }
  return { removed, keptFresh, refused };
}

/**
 * Resolve the scan root, or `null` when it is not inside the OS temp directory.
 *
 * Both sides are real-path resolved before comparison, because a temp directory is
 * itself reached through a symlink on some platforms (`/var` -> `/private/var` on
 * macOS), and comparing an unresolved path against a resolved one would reject every
 * legitimate root.
 */
async function confinedScanRoot(candidateRoot: string): Promise<string | null> {
  try {
    const [resolved, tempRoot] = await Promise.all([realpath(candidateRoot), realpath(tmpdir())]);
    return resolved === tempRoot || resolved.startsWith(`${tempRoot}/`) ? resolved : null;
  } catch {
    return null;
  }
}

/** The direct entries of the scan root whose names have the shape we generate. */
async function candidateNames(scanRoot: string): Promise<string[]> {
  try {
    const entries = await readdir(scanRoot, { withFileTypes: true });
    return entries
      .filter((entry) => WORKSPACE_DIR_NAME.test(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/**
 * The absolute path of one candidate, or `null` when a bound refuses it.
 *
 * Refuses anything that is not a real directory (so a symlink pointing out of the
 * temp root is left alone, along with its target) and anything that does not still
 * resolve inside the scan root.
 */
async function confinedCandidate(scanRoot: string, name: string): Promise<string | null> {
  const candidate = join(scanRoot, name);
  try {
    // `lstat`, not `stat`: a symlink to a directory must be refused, not followed.
    const entry = await lstat(candidate);
    if (!entry.isDirectory()) {
      return null;
    }
  } catch {
    return null;
  }
  try {
    const resolved = await realpath(candidate);
    return resolved.startsWith(`${scanRoot}/`) ? resolved : null;
  } catch {
    return null;
  }
}

/**
 * Whether anything in a candidate's tree was modified after `cutoff`.
 *
 * `active` means a live (or recently finished) run and is returned as soon as one
 * recent entry is found, so the common case is cheap. `unknown` means the tree could
 * not be fully inspected within `REAP_ENTRY_BUDGET`, which is treated as a refusal
 * by the caller.
 */
async function activitySince(
  candidate: string,
  cutoff: number,
): Promise<'active' | 'idle' | 'unknown'> {
  const pending: string[] = [candidate];
  let examined = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current === undefined) {
      break;
    }
    examined += 1;
    if (examined > REAP_ENTRY_BUDGET) {
      return 'unknown';
    }
    let entries;
    try {
      const info = await stat(current);
      if (info.mtimeMs > cutoff) {
        return 'active';
      }
      if (!info.isDirectory()) {
        continue;
      }
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      // Vanished or unreadable mid-walk. It cannot be dated, so it cannot be dated
      // as idle; refusing beats deleting a tree we could not read.
      return 'unknown';
    }
    for (const entry of entries) {
      // Symlinks are never followed: `stat` above would report the TARGET's time,
      // and a link inside a workspace can point anywhere.
      if (!entry.isSymbolicLink()) {
        pending.push(join(current, entry.name));
      }
    }
  }
  return 'idle';
}
