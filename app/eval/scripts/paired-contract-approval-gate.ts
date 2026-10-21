// timing-contract-inference, task 15.1: gate every model-invoking step of the Paired_Contract
// Experiment behind a founder-recorded approval file (Req 8.9).
//
// WHAT "MODEL-INVOKING" MEANS HERE, AND WHAT IT DOES NOT
//   Requirement 8.9 holds the Paid_Re_Run - any step that invokes a model and spends tokens -
//   until the founder records approval IN THE SPEC FOLDER. Replaying the 32 already-generated
//   Reference_Models from disk (task 15.5) constructs no model router and spends zero tokens,
//   so it is explicitly OUTSIDE this gate's hold, per the glossary's own `Paid_Re_Run` entry and
//   per 15.5's own stated check ("MUST assert a zero token charge"). This module gates ONLY the
//   step that would invoke a model; it is not wired into the free replay at all.
//
// WHY A FILE ON DISK, NOT A FLAG OR AN ENVIRONMENT VARIABLE
//   Req 8.9's own words are "the founder records approval in the spec folder" - a durable,
//   reviewable artifact in version control, the same shape `design-questions.md`'s resolutions
//   already take for a founder decision. A flag or an environment variable leaves no record of
//   WHO approved and WHEN, and could be set once and forgotten across many later re-runs.
//
// THE GATE NAMES ITS CAUSE AND NEVER GUESSES CONSENT
//   Absence of the file, an unreadable file, and a present-but-untrusted file (anyone other
//   than the founder could place a file in this folder) all refuse with the SAME named cause:
//   `no-recorded-approval`. There is no partial-trust reading of "the file exists, so it must be
//   fine" - the cause is checked for PRESENCE only, because the content's trustworthiness is a
//   human judgment this gate cannot verify and must not simulate.

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** This module's directory, for the both-layouts path rule (dist runs one level deeper). */
const HERE = dirname(fileURLToPath(import.meta.url));

/** The repository root, named from this module's own location in either layout. */
const REPOSITORY_ROOT = resolve(HERE, HERE.includes(`${'dist'}/`) ? '../../../..' : '../../..');

/** The approval file's fixed path, in the spec folder Req 8.9 names (relative to the repo root). */
export const PAID_RE_RUN_APPROVAL_PATH =
  '.kiro/specs/timing-contract-inference/paid-re-run-approval.md';

/** Why a model-invoking step was refused. A closed, single-member vocabulary: the ONLY way a
 *  model-invoking step of the re-measurement may proceed is a present approval file. */
export type PaidReRunRefusalCause = 'no-recorded-approval';

/** The gate's outcome: approved (the file exists and is readable), or refused with its cause. */
export type PaidReRunGateOutcome =
  { readonly approved: true } | { readonly approved: false; readonly cause: PaidReRunRefusalCause };

/**
 * Refuse a model-invoking step of the Paired_Contract_Experiment until the founder's approval
 * file exists in the spec folder (Req 8.9).
 *
 * Checked for PRESENCE only: this function reads no content from the file and makes no claim
 * about who wrote it or whether its text constitutes a real approval. That judgment is the
 * founder's; this gate only verifies the recorded artifact is there at all.
 *
 * `approvalPath` is a parameter so a unit test can point at a fixture without touching the
 * real spec folder; a real call omits it and reads the one path Req 8.9 names.
 */
export async function checkPaidReRunApproval(
  approvalPath: string = PAID_RE_RUN_APPROVAL_PATH,
): Promise<PaidReRunGateOutcome> {
  try {
    await readFile(resolve(REPOSITORY_ROOT, approvalPath), 'utf8');
    return { approved: true };
  } catch {
    return { approved: false, cause: 'no-recorded-approval' };
  }
}

/**
 * Refuse unless the gate approves, naming the cause in the thrown error.
 *
 * A model-invoking step calls this before constructing a model router or spending a single
 * token; `checkPaidReRunApproval` alone returns the typed outcome for a caller that wants to
 * branch instead of throw (the unit test does exactly that).
 */
export async function requirePaidReRunApproval(approvalPath?: string): Promise<void> {
  const outcome = await checkPaidReRunApproval(approvalPath);
  if (!outcome.approved) {
    throw new Error(
      `Paid_Re_Run refused (${outcome.cause}): no approval file recorded at ` +
        `${approvalPath ?? PAID_RE_RUN_APPROVAL_PATH}. Per Requirement 8.9, the founder must ` +
        'record approval in the spec folder before any step of the re-measurement invokes a model.',
    );
  }
}
