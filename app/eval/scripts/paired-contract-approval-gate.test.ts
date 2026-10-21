// Unit test for the Paid_Re_Run approval gate (timing-contract-inference task 15.1; Req 8.9).

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  checkPaidReRunApproval,
  PAID_RE_RUN_APPROVAL_PATH,
  requirePaidReRunApproval,
} from './paired-contract-approval-gate.js';

describe('checkPaidReRunApproval', () => {
  it('refuses with the named cause when no approval file exists at the real spec-folder path', async () => {
    const outcome = await checkPaidReRunApproval();

    expect(outcome.approved).toBe(false);
    if (outcome.approved) return;
    expect(outcome.cause).toBe('no-recorded-approval');
  });

  it('names the exact path Req 8.9 requires, inside the spec folder', () => {
    expect(PAID_RE_RUN_APPROVAL_PATH).toBe(
      '.kiro/specs/timing-contract-inference/paid-re-run-approval.md',
    );
  });

  describe('against a fixture directory', () => {
    let fixtureDir: string;

    beforeEach(async () => {
      fixtureDir = await mkdtemp(join(tmpdir(), 'paid-re-run-approval-'));
    });

    afterEach(async () => {
      await rm(fixtureDir, { recursive: true, force: true });
    });

    it('refuses with the named cause when the fixture path is absent', async () => {
      const outcome = await checkPaidReRunApproval(join(fixtureDir, 'absent-approval.md'));

      expect(outcome).toEqual({ approved: false, cause: 'no-recorded-approval' });
    });

    it('approves once a file exists at the fixture path, read for presence only', async () => {
      const approvalPath = join(fixtureDir, 'approval.md');
      await writeFile(approvalPath, 'Approved by the founder.\n', 'utf8');

      const outcome = await checkPaidReRunApproval(approvalPath);

      expect(outcome).toEqual({ approved: true });
    });
  });
});

describe('requirePaidReRunApproval', () => {
  it('throws naming the cause and the requirement when no approval file exists', async () => {
    await expect(requirePaidReRunApproval()).rejects.toThrow(/no-recorded-approval/);
    await expect(requirePaidReRunApproval()).rejects.toThrow(/Requirement 8\.9/);
  });

  it('resolves once the founder-recorded approval file is present', async () => {
    const fixtureDir = await mkdtemp(join(tmpdir(), 'paid-re-run-approval-resolve-'));
    try {
      const approvalPath = resolve(fixtureDir, 'approval.md');
      await writeFile(approvalPath, 'Approved.\n', 'utf8');

      await expect(requirePaidReRunApproval(approvalPath)).resolves.toBeUndefined();
    } finally {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });
});
