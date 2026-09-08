// Fetching the pinned RTLLM checkout: idempotent, verified by commit hash, and
// loud on any mismatch.
//
// The corpus is not vendored (see `pinned-source.ts`), so it has to arrive from
// somewhere. That "somewhere" is a git clone of a fixed URL pinned to a fixed
// commit, and the ONLY thing that makes the result trustworthy is the final
// `rev-parse HEAD` check: a commit hash is content-addressed, so a checkout that
// reports the pinned hash is the pinned tree, whatever happened on the way there.
// If the hash does not match, this module fails loudly rather than importing a
// corpus of unknown provenance - a silently-moved corpus would invalidate every
// historical pass@k number without anyone noticing.
//
// IDEMPOTENT
//   An existing checkout already at the pinned commit is left untouched and
//   reported as `already-pinned`, so re-running the step costs one `rev-parse`. An
//   existing checkout at a DIFFERENT commit is moved to the pinned one; a
//   non-repository directory is refused rather than overwritten.
//
// INJECTED, NEVER GLOBAL
//   Git invocation goes through the `GitCommandPort` seam and the target path is
//   supplied by the caller, so this module never spawns a process itself, never
//   reads the environment, and never picks a location. That keeps the whole
//   decision tree unit-testable with a fake git and no network.

import { RTLLM_PINNED_COMMIT, RTLLM_REPOSITORY_URL } from './pinned-source.js';

/** The captured outcome of one git invocation. */
export interface GitCommandResult {
  /** Process exit code, or `null` when git could not be launched at all. */
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * The git seam: runs one git command with an explicit argument vector.
 *
 * Implementations MUST NOT use a shell, so nothing in `args` can be reinterpreted
 * as a shell command. `cwd` is `null` for commands that do not need a repository
 * (the clone itself).
 */
export interface GitCommandPort {
  run(args: readonly string[], cwd: string | null): Promise<GitCommandResult>;
}

/** What the filesystem looks like at the target path before fetching. */
export type CheckoutPresence = 'absent' | 'git-repository' | 'non-repository';

/**
 * Inspects the target path. Kept as its own seam because "is there a git repo
 * here" is a filesystem question, not a git-invocation one, and the fetch's
 * decision tree must be testable without touching a disk.
 */
export interface CheckoutProbePort {
  inspect(path: string): Promise<CheckoutPresence>;
}

/** Why a fetch could not produce a checkout at the pinned commit. */
export type CorpusFetchErrorCode =
  /** The target path exists but is not a git repository; refused rather than overwritten. */
  | 'TARGET_NOT_A_REPOSITORY'
  /** `git clone` failed (network, auth, disk). */
  | 'CLONE_FAILED'
  /** `git fetch` of the pinned commit failed. */
  | 'FETCH_FAILED'
  /** `git checkout` of the pinned commit failed. */
  | 'CHECKOUT_FAILED'
  /** `git rev-parse HEAD` could not be read. */
  | 'HEAD_UNREADABLE'
  /** HEAD is readable but is NOT the pinned commit: the corpus is not what we pinned. */
  | 'PINNED_COMMIT_MISMATCH';

/** A sanitized fetch failure: a code, a message, and the observed commit if known. */
export interface CorpusFetchError {
  readonly code: CorpusFetchErrorCode;
  /** Operator-facing explanation; carries no credential and no command output. */
  readonly message: string;
  /** The commit HEAD actually pointed at, when that could be read. */
  readonly observedCommit: string | null;
}

/** How the checkout came to be at the pinned commit. */
export type CorpusFetchAction = 'already-pinned' | 'cloned' | 'repinned';

/** A verified checkout: the path, the confirmed commit, and how it got there. */
export interface CorpusFetchOutcome {
  readonly path: string;
  /** Always equal to `RTLLM_PINNED_COMMIT`; verified, not assumed. */
  readonly commit: string;
  readonly action: CorpusFetchAction;
}

/** The collaborators and target for one fetch; no globals, no defaults hidden here. */
export interface CorpusFetchRequest {
  /** Absolute path the checkout lives at (gitignored working location). */
  readonly targetPath: string;
  readonly git: GitCommandPort;
  readonly probe: CheckoutProbePort;
}

/** A git result is usable only on a zero exit code. */
function succeeded(result: GitCommandResult): boolean {
  return result.exitCode === 0;
}

/** Build a sanitized error, omitting any observed commit. */
function fetchError(code: CorpusFetchErrorCode, message: string): CorpusFetchError {
  return { code, message, observedCommit: null };
}

/** Read `HEAD` as a commit hash, or `null` when it cannot be read. */
async function readHead(git: GitCommandPort, path: string): Promise<string | null> {
  const result = await git.run(['rev-parse', 'HEAD'], path);
  if (!succeeded(result)) {
    return null;
  }
  const commit = result.stdout.trim();
  return commit.length > 0 ? commit : null;
}

/**
 * Verify the checkout sits on the pinned commit.
 *
 * This is the single integrity gate for the whole corpus, so it is a hard equality
 * check on the full hash - never a prefix match, never a "close enough" tag lookup.
 */
async function verifyPinned(
  git: GitCommandPort,
  path: string,
  action: CorpusFetchAction,
): Promise<CorpusFetchOutcome | CorpusFetchError> {
  const head = await readHead(git, path);
  if (head === null) {
    return fetchError('HEAD_UNREADABLE', 'Could not read HEAD of the RTLLM checkout.');
  }
  if (head !== RTLLM_PINNED_COMMIT) {
    return {
      code: 'PINNED_COMMIT_MISMATCH',
      message: `The RTLLM checkout is not at the pinned commit ${RTLLM_PINNED_COMMIT}.`,
      observedCommit: head,
    };
  }
  return { path, commit: head, action };
}

/** Clone the pinned repository into an absent target path. */
async function cloneInto(
  git: GitCommandPort,
  targetPath: string,
): Promise<CorpusFetchError | null> {
  const cloned = await git.run(['clone', '--no-checkout', RTLLM_REPOSITORY_URL, targetPath], null);
  if (!succeeded(cloned)) {
    return fetchError('CLONE_FAILED', 'Cloning the RTLLM benchmark repository failed.');
  }
  return null;
}

/**
 * Move an existing repository onto the pinned commit, fetching it first.
 *
 * The fetch is unconditional because the pinned commit may simply not be present
 * in a shallow or stale clone; a fetch failure is reported rather than swallowed so
 * a subsequent checkout failure is never blamed on the wrong cause.
 */
async function repinTo(git: GitCommandPort, targetPath: string): Promise<CorpusFetchError | null> {
  const fetched = await git.run(
    ['fetch', '--quiet', RTLLM_REPOSITORY_URL, RTLLM_PINNED_COMMIT],
    targetPath,
  );
  if (!succeeded(fetched)) {
    return fetchError('FETCH_FAILED', 'Fetching the pinned RTLLM commit failed.');
  }
  const checkedOut = await git.run(['checkout', '--quiet', RTLLM_PINNED_COMMIT], targetPath);
  if (!succeeded(checkedOut)) {
    return fetchError('CHECKOUT_FAILED', 'Checking out the pinned RTLLM commit failed.');
  }
  return null;
}

/**
 * Ensure a verified RTLLM checkout at the pinned commit exists at `targetPath`.
 *
 * Idempotent: an existing checkout already at the pinned commit is reported
 * `already-pinned` after one `rev-parse`. Never overwrites a non-repository
 * directory. Always ends with the commit-hash verification, so a returned outcome
 * is a guarantee about the tree, not a hope.
 */
export async function fetchPinnedRtllmCheckout(
  request: CorpusFetchRequest,
): Promise<CorpusFetchOutcome | CorpusFetchError> {
  const { targetPath, git, probe } = request;
  const presence = await probe.inspect(targetPath);
  if (presence === 'non-repository') {
    return fetchError(
      'TARGET_NOT_A_REPOSITORY',
      'The RTLLM corpus path exists but is not a git repository; refusing to overwrite it.',
    );
  }
  if (presence === 'git-repository') {
    const head = await readHead(git, targetPath);
    if (head === RTLLM_PINNED_COMMIT) {
      return { path: targetPath, commit: head, action: 'already-pinned' };
    }
    const repinFailure = await repinTo(git, targetPath);
    return repinFailure ?? (await verifyPinned(git, targetPath, 'repinned'));
  }
  const cloneFailure = await cloneInto(git, targetPath);
  if (cloneFailure !== null) {
    return cloneFailure;
  }
  const repinFailure = await repinTo(git, targetPath);
  return repinFailure ?? (await verifyPinned(git, targetPath, 'cloned'));
}

/** Discriminate a fetch result without re-deriving the union shape at each call site. */
export function isCorpusFetchError(
  result: CorpusFetchOutcome | CorpusFetchError,
): result is CorpusFetchError {
  return 'code' in result;
}
