// The real, Node-backed implementations of the fetch seams, plus the one place
// that decides WHERE the corpus checkout lands.
//
// Kept separate from `fetch.ts` so the fetch decision tree stays testable with a
// fake git and no filesystem, and so the only module that touches `child_process`
// and `node:fs` is this thin one.
//
// The checkout path is a build-time working location, NOT a product data path: it
// is `.eval-corpus/rtllm` at the repository root and is gitignored, because the
// corpus is fetched and verified rather than vendored.

import { spawn } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type {
  CheckoutPresence,
  CheckoutProbePort,
  GitCommandPort,
  GitCommandResult,
} from './fetch.js';

/** This module's directory, resolved from its module URL. */
const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * The repository root, resolved from this module's own location in either layout.
 *
 * This module is authored at `app/eval/corpus/` and compiles to
 * `app/eval/dist/corpus/`, so the distance to the repository root differs by one
 * level between the source tree (which vitest loads) and the build output (which the
 * CLI runs from). The parent directory name distinguishes them exactly - `eval`
 * versus `dist` - so the level count is decided on evidence rather than guessed, and
 * both layouts resolve to the same directory. `process.cwd()` is deliberately not
 * used: the fetch must land in the same place whether it is invoked from the
 * repository root, from a test, or from a script elsewhere.
 */
function repositoryRoot(): string {
  const levelsUp = basename(dirname(HERE)) === 'dist' ? 4 : 3;
  return resolve(HERE, ...new Array<string>(levelsUp).fill('..'));
}

/** The gitignored working directory the corpus checkout lands in. */
export const EVAL_CORPUS_ROOT = join(repositoryRoot(), '.eval-corpus');

/** The absolute path of the pinned RTLLM checkout. */
export const RTLLM_CHECKOUT_PATH = join(EVAL_CORPUS_ROOT, 'rtllm');

/** How long a single git invocation may run before it is killed (ms). */
const GIT_TIMEOUT_MS = 300_000;

/** A `GitCommandPort` backed by `git` on PATH, invoked without a shell. */
export class NodeGitCommandPort implements GitCommandPort {
  run(args: readonly string[], cwd: string | null): Promise<GitCommandResult> {
    return new Promise<GitCommandResult>((resolvePromise) => {
      // Array args and no shell: nothing in `args` can be reinterpreted as a
      // shell command. `GIT_TERMINAL_PROMPT=0` keeps a credential prompt from
      // hanging the fetch forever on a private or moved repository.
      const child = spawn('git', [...args], {
        ...(cwd === null ? {} : { cwd }),
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
      let stdout = '';
      let stderr = '';
      let launched = true;
      const killTimer = setTimeout(() => {
        child.kill('SIGKILL');
      }, GIT_TIMEOUT_MS);

      child.stdout.on('data', (chunk: Buffer) => {
        stdout += chunk.toString('utf8');
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString('utf8');
      });
      child.on('error', () => {
        launched = false;
      });
      child.on('close', (code) => {
        clearTimeout(killTimer);
        resolvePromise({ exitCode: launched ? code : null, stdout, stderr });
      });
    });
  }
}

/** Whether a path exists on disk. */
async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    // `access` rejects for "missing" and for "not permitted" alike; both mean this
    // process cannot treat the path as an existing checkout, and the reason carries
    // nothing the caller can act on differently, so it is classified rather than
    // propagated.
    return false;
  }
}

/** Whether a path is a directory. */
async function isDirectory(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isDirectory();
  } catch {
    // Same reasoning as `exists`: an unreadable path is not a usable directory.
    return false;
  }
}

/** A `CheckoutProbePort` backed by the real filesystem. */
export class NodeCheckoutProbePort implements CheckoutProbePort {
  async inspect(path: string): Promise<CheckoutPresence> {
    if (!(await exists(path))) {
      return 'absent';
    }
    if (!(await isDirectory(path))) {
      return 'non-repository';
    }
    return (await exists(join(path, '.git'))) ? 'git-repository' : 'non-repository';
  }
}
