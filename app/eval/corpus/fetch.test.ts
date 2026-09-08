// Unit tests for the pinned corpus fetch, driven through a FAKE git port.
//
// No network and no filesystem: the point of injecting `GitCommandPort` and
// `CheckoutProbePort` is that the whole decision tree - idempotence, re-pinning, and
// above all the commit VERIFICATION - is testable offline.
//
// The verification is the security- and integrity-critical assertion here. A commit
// hash is content-addressed, so a checkout that reports the pinned hash IS the pinned
// tree; a checkout that reports anything else must fail loudly, because importing a
// corpus of unknown provenance would silently invalidate every pass@k number measured
// against it.

import { describe, expect, it } from 'vitest';

import {
  fetchPinnedRtllmCheckout,
  isCorpusFetchError,
  type CheckoutPresence,
  type CheckoutProbePort,
  type GitCommandPort,
  type GitCommandResult,
} from './fetch.js';
import { RTLLM_PINNED_COMMIT } from './pinned-source.js';

const TARGET = '/tmp/eval-corpus/rtllm';

/** A different, valid-looking commit: the "not what we pinned" case. */
const OTHER_COMMIT = '0000000000000000000000000000000000000000';

/** A scripted git port recording the argument vectors it was handed. */
class FakeGit implements GitCommandPort {
  readonly calls: string[][] = [];
  readonly #script: (args: readonly string[]) => GitCommandResult;

  constructor(script: (args: readonly string[]) => GitCommandResult) {
    this.#script = script;
  }

  run(args: readonly string[]): Promise<GitCommandResult> {
    this.calls.push([...args]);
    return Promise.resolve(this.#script(args));
  }
}

/** A probe reporting a fixed presence. */
class FakeProbe implements CheckoutProbePort {
  readonly #presence: CheckoutPresence;
  constructor(presence: CheckoutPresence) {
    this.#presence = presence;
  }
  inspect(): Promise<CheckoutPresence> {
    return Promise.resolve(this.#presence);
  }
}

function ok(stdout = ''): GitCommandResult {
  return { exitCode: 0, stdout, stderr: '' };
}

function failed(): GitCommandResult {
  return { exitCode: 1, stdout: '', stderr: 'git said no' };
}

/** A git script where every command succeeds and HEAD reports `head`. */
function gitReporting(head: string): FakeGit {
  return new FakeGit((args) => (args[0] === 'rev-parse' ? ok(`${head}\n`) : ok()));
}

describe('fetchPinnedRtllmCheckout - idempotence', () => {
  it('leaves an existing checkout already at the pinned commit untouched', async () => {
    const git = gitReporting(RTLLM_PINNED_COMMIT);
    const result = await fetchPinnedRtllmCheckout({
      targetPath: TARGET,
      git,
      probe: new FakeProbe('git-repository'),
    });

    expect(isCorpusFetchError(result)).toBe(false);
    if (isCorpusFetchError(result)) return;
    expect(result.action).toBe('already-pinned');
    expect(result.commit).toBe(RTLLM_PINNED_COMMIT);
    // One rev-parse and nothing else: no clone, no fetch, no checkout.
    expect(git.calls).toEqual([['rev-parse', 'HEAD']]);
  });
});

describe('fetchPinnedRtllmCheckout - obtaining the pinned tree', () => {
  it('clones then checks out the pinned commit when the path is absent', async () => {
    const git = gitReporting(RTLLM_PINNED_COMMIT);
    const result = await fetchPinnedRtllmCheckout({
      targetPath: TARGET,
      git,
      probe: new FakeProbe('absent'),
    });

    expect(isCorpusFetchError(result)).toBe(false);
    if (isCorpusFetchError(result)) return;
    expect(result.action).toBe('cloned');
    expect(git.calls.map((call) => call[0])).toEqual(['clone', 'fetch', 'checkout', 'rev-parse']);
    // The pinned commit, not a branch name, is what is checked out.
    expect(git.calls.find((call) => call[0] === 'checkout')).toContain(RTLLM_PINNED_COMMIT);
  });

  it('re-pins an existing checkout that sits on a different commit', async () => {
    let head = OTHER_COMMIT;
    const git = new FakeGit((args) => {
      if (args[0] === 'checkout') {
        head = RTLLM_PINNED_COMMIT;
        return ok();
      }
      return args[0] === 'rev-parse' ? ok(`${head}\n`) : ok();
    });

    const result = await fetchPinnedRtllmCheckout({
      targetPath: TARGET,
      git,
      probe: new FakeProbe('git-repository'),
    });

    expect(isCorpusFetchError(result)).toBe(false);
    if (isCorpusFetchError(result)) return;
    expect(result.action).toBe('repinned');
  });
});

describe('fetchPinnedRtllmCheckout - failing loudly', () => {
  it('reports a mismatch when the checkout is not at the pinned commit', async () => {
    // The integrity gate: a tree that reports a different hash is NOT our corpus.
    const result = await fetchPinnedRtllmCheckout({
      targetPath: TARGET,
      git: gitReporting(OTHER_COMMIT),
      probe: new FakeProbe('absent'),
    });

    expect(isCorpusFetchError(result)).toBe(true);
    if (!isCorpusFetchError(result)) return;
    expect(result.code).toBe('PINNED_COMMIT_MISMATCH');
    expect(result.observedCommit).toBe(OTHER_COMMIT);
    expect(result.message).toContain(RTLLM_PINNED_COMMIT);
  });

  it('refuses to overwrite a non-repository directory at the target path', async () => {
    const git = gitReporting(RTLLM_PINNED_COMMIT);
    const result = await fetchPinnedRtllmCheckout({
      targetPath: TARGET,
      git,
      probe: new FakeProbe('non-repository'),
    });

    expect(isCorpusFetchError(result)).toBe(true);
    if (!isCorpusFetchError(result)) return;
    expect(result.code).toBe('TARGET_NOT_A_REPOSITORY');
    expect(git.calls).toEqual([]);
  });

  it('reports a clone failure without attempting a checkout', async () => {
    const git = new FakeGit((args) => (args[0] === 'clone' ? failed() : ok()));
    const result = await fetchPinnedRtllmCheckout({
      targetPath: TARGET,
      git,
      probe: new FakeProbe('absent'),
    });

    expect(isCorpusFetchError(result)).toBe(true);
    if (!isCorpusFetchError(result)) return;
    expect(result.code).toBe('CLONE_FAILED');
    expect(git.calls.map((call) => call[0])).toEqual(['clone']);
  });

  it('reports a checkout failure distinctly from a fetch failure', async () => {
    const git = new FakeGit((args) =>
      args[0] === 'checkout' ? failed() : ok(`${OTHER_COMMIT}\n`),
    );
    const result = await fetchPinnedRtllmCheckout({
      targetPath: TARGET,
      git,
      probe: new FakeProbe('git-repository'),
    });

    expect(isCorpusFetchError(result)).toBe(true);
    if (!isCorpusFetchError(result)) return;
    expect(result.code).toBe('CHECKOUT_FAILED');
  });

  it('reports an unreadable HEAD rather than assuming the tree is correct', async () => {
    const git = new FakeGit((args) => (args[0] === 'rev-parse' ? failed() : ok()));
    const result = await fetchPinnedRtllmCheckout({
      targetPath: TARGET,
      git,
      probe: new FakeProbe('absent'),
    });

    expect(isCorpusFetchError(result)).toBe(true);
    if (!isCorpusFetchError(result)) return;
    expect(result.code).toBe('HEAD_UNREADABLE');
  });

  it('never passes a credential or a shell string to git', async () => {
    const git = gitReporting(RTLLM_PINNED_COMMIT);
    await fetchPinnedRtllmCheckout({
      targetPath: TARGET,
      git,
      probe: new FakeProbe('absent'),
    });

    for (const call of git.calls) {
      for (const argument of call) {
        expect(argument).not.toContain('&&');
        expect(argument).not.toContain('|');
        expect(argument).not.toContain('@');
      }
    }
  });
});
