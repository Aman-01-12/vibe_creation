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
  // NOT PINNED TO EITHER ARM, DELIBERATELY. An earlier version of this test asserted the real
  // spec-folder path is ABSENT, which coupled it to transient state: the moment the founder
  // recorded approval (Req 8.9), the test failed while the gate was working exactly as designed.
  // Both arms of the real behaviour are pinned deterministically against fixtures below; what
  // the real path is checked for here is only that it resolves and answers in the declared shape.
  it('answers for the real spec-folder path in the declared shape, whichever arm holds', async () => {
    const outcome = await checkPaidReRunApproval();

    expect(typeof outcome.approved).toBe('boolean');
    if (!outcome.approved) {
      expect(outcome.cause).toBe('no-recorded-approval');
    }
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
  it('throws naming the cause and the requirement when the approval file is absent', async () => {
    // A guaranteed-absent fixture path rather than the real one, for the reason the
    // `checkPaidReRunApproval` block above gives: the real path's state is not a constant.
    const absent = join(tmpdir(), 'paid-re-run-approval-absent', 'nothing-here.md');

    await expect(requirePaidReRunApproval(absent)).rejects.toThrow(/no-recorded-approval/);
    await expect(requirePaidReRunApproval(absent)).rejects.toThrow(/Requirement 8\.9/);
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
