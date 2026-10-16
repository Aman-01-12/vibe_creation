// Criterion 7.18: the Credential_File and its directory are excluded from version control.
//
// It asks git itself, because a line in `.gitignore` is not evidence git honours it: ordering and
// a later negation both change the answer. It creates no file and reads no credential.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { DEFAULT_CREDENTIAL_FILE } from '@app/agent';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** A path that must stay tracked, so a checker that answers "ignored" to everything is caught. */
const TRACKED_CONTROL = 'package.json';

/** One git invocation, with its exit status and its stdout as text. */
function git(args: readonly string[]): { readonly status: number | null; readonly stdout: string } {
  const run = spawnSync('git', [...args], { cwd: ROOT, encoding: 'utf8' });
  return { status: run.status, stdout: String(run.stdout ?? '') };
}

/** Whether git can answer here. A skip is the correct outcome, and it is not a pass. */
const GIT_AVAILABLE = git(['rev-parse', '--git-dir']).status === 0;

if (!GIT_AVAILABLE) {
  console.warn(
    '[credential-file-ignored] Version-control exclusion was NOT exercised: git cannot answer in this checkout.',
  );
}

/**
 * Whether git ignores one path. `check-ignore` exits 0 for ignored and 1 for not, and any other
 * status is a tool failure that must not read as "not ignored".
 */
function isIgnored(relative: string): boolean {
  const run = git(['check-ignore', '-q', '--', relative]);
  if (run.status === 0) {
    return true;
  }
  if (run.status === 1) {
    return false;
  }
  throw new Error(`git check-ignore could not answer for ${relative}`);
}

describe.skipIf(!GIT_AVAILABLE)('the Credential_File is excluded from version control', () => {
  it('ignores the default Credential_File', () => {
    expect(isIgnored(DEFAULT_CREDENTIAL_FILE)).toBe(true);
  });

  it('ignores a temporary file a refresh writes beside it', () => {
    // A refresh writes a temporary file in the same directory and moves it into place, so the
    // directory is ignored rather than the one filename.
    expect(isIgnored(`${DEFAULT_CREDENTIAL_FILE}.tmp`)).toBe(true);
  });

  it('ignores the directory the Credential_File sits in', () => {
    const directory = DEFAULT_CREDENTIAL_FILE.slice(0, DEFAULT_CREDENTIAL_FILE.indexOf('/'));

    expect(isIgnored(`${directory}/`)).toBe(true);
  });

  it('still reports a tracked path as not ignored, so the check can say no', () => {
    expect(isIgnored(TRACKED_CONTROL)).toBe(false);
  });

  it('tracks no file inside the Credential_File directory', () => {
    const directory = DEFAULT_CREDENTIAL_FILE.slice(0, DEFAULT_CREDENTIAL_FILE.indexOf('/'));
    const tracked = git(['ls-files', '--', directory]);

    expect(tracked.status).toBe(0);
    expect(tracked.stdout.trim()).toBe('');
  });
});
