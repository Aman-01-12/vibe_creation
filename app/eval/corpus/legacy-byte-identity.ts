// The Legacy_Byte_Identity_Check's shared render logic (stimulus-transaction-structure, C7).
//
// WHY THIS IS ITS OWN MODULE, SEPARATE FROM THE CLI AND THE COMPARISON TEST
//   `CONSENSUS_HARNESS_VERSION` 3's text cannot be re-rendered once the Stimulus_Function
//   renderer gains its new emission sites (task 4.1), so the version-3 golden corpus is
//   captured and committed FIRST, by `legacy-golden-capture-cli.ts`. The byte comparison
//   (`legacy-byte-identity-comparison.integration.test.ts`) runs AFTER that renderer edit and
//   must build the exact same render request over the exact same real imported
//   Declared_Interface, or a text difference it reports could be this module's own drift rather
//   than the renderer's. So the request-construction logic lives here, once, imported by both the
//   capture CLI and that comparison test - never restated at either call site.
//
// `data`, NOT A MIX OF `data` AND `enable`
//   Criterion 5.6 only requires a Total_Role_Declaration naming every input port with a
//   member of the Legacy_Role_Set (`{data, enable}`); it does not require a particular mix.
//   `data` alone is every other `renderConsensusHarness` caller in this test suite's own
//   `allDataRoles` helper, picked for the same reason here: one deterministic declaration,
//   reproduced unchanged by the future comparison.
//
// WHY THE TIMING_CONTRACT IS A FIXED STAND-IN, NOT THE REAL DERIVATION
//   `app/test/real-oracle-harness.ts` documents the general rule that a suite feeding
//   `timingContract` INTO the Consensus_Harness - which this module does - should build its
//   own real Timing_Derivation rather than reuse the corpus-wide stand-in, because the
//   fabricated value would otherwise reach what that suite measures. This module does not
//   measure anything about Port_Timing: it captures and later re-renders harness TEXT, and
//   criterion 5.1's byte-identity claim holds regardless of which TimingContract value was
//   used, as long as the SAME value is used both times. A fixed `FixedTimingDerivation`
//   needs no Yosys, which keeps this check's only external dependency the fetched corpus
//   checkout - matching C7's own stated reason for its integration-tier placement ("it reads
//   the imported corpus"), not a real-toolchain dependency.

import type { ModuleInterface } from '@app/core';
import {
  renderConsensusHarness,
  SAMPLE_BUDGET,
  type ConsensusHarnessRequest,
  type RoleDeclaration,
} from '@app/tools';

import type { EvalProblem } from '../problem.js';

/**
 * Fixed per-render identity: reproducibility, not realism, is what this check needs. Neither
 * may be random or sized per design, because the byte comparison
 * (`legacy-byte-identity-comparison.integration.test.ts`) must build the identical request over
 * the identical design to stay a comparison rather than a new draw.
 */
export const LEGACY_GOLDEN_NONCE = 'legacygold';
export const LEGACY_GOLDEN_WATCHDOG_BUDGET_NS = 2_000_000;

/**
 * A Total_Role_Declaration naming every input port of `moduleInterface` `data`, a member of
 * the Legacy_Role_Set (Req 5.6).
 */
export function legacyRoleDeclarationFor(moduleInterface: ModuleInterface): RoleDeclaration {
  return moduleInterface.ports
    .filter((port) => port.direction === 'input')
    .map((port) => ({ portName: port.name, role: 'data' as const }));
}

/**
 * The golden file name for one corpus problem id, e.g. `rtllm/arithmetic/accu` becomes
 * `rtllm__arithmetic__accu.v`. `/` becomes `__` so the mapping is deterministic,
 * collision-free, and reversible, and flat enough to commit as ordinary files rather than a
 * nested directory tree that mirrors the corpus's own category folders.
 */
export function legacyGoldenFileName(problemId: string): string {
  return `${problemId.replaceAll('/', '__')}.v`;
}

/**
 * Build the `ConsensusHarnessRequest` the Legacy_Byte_Identity_Check renders `problem` with:
 * `problem.spec`'s own real imported `moduleInterface` and `timingContract`, never a
 * constructed fixture interface or a test double (Req 5.6).
 */
export function legacyGoldenRequestFor(problem: EvalProblem): ConsensusHarnessRequest {
  return {
    moduleInterface: problem.spec.moduleInterface,
    timingContract: problem.spec.timingContract,
    nonce: LEGACY_GOLDEN_NONCE,
    watchdogBudgetNs: LEGACY_GOLDEN_WATCHDOG_BUDGET_NS,
    sampleBudget: SAMPLE_BUDGET,
    roles: legacyRoleDeclarationFor(problem.spec.moduleInterface),
  };
}

/** One design's captured golden text, keyed by the problem id it was rendered from. */
export interface LegacyGoldenDesign {
  readonly problemId: string;
  readonly fileName: string;
  readonly contents: string;
}

/**
 * Render `problem`'s golden text through the same `renderConsensusHarness` a Session invokes.
 *
 * Throws rather than returning a `Result`: every scored corpus design's real
 * `ModuleInterface` paired with the all-`data` Legacy_Role_Set declaration above is always a
 * valid request (every identifier was already accepted by a real Verilog compiler when the
 * design was parsed, and `legacyRoleDeclarationFor` is total by construction), so a refusal
 * here is a defect in this module or in the corpus, not an outcome a caller should branch on.
 */
export function renderLegacyGoldenDesign(problem: EvalProblem): LegacyGoldenDesign {
  const rendered = renderConsensusHarness(legacyGoldenRequestFor(problem));
  if (!rendered.ok) {
    throw new Error(
      `${problem.id}: the Legacy_Role_Set request this capture built was refused ` +
        `(${rendered.error.code}): ${rendered.error.message}`,
    );
  }
  return {
    problemId: problem.id,
    fileName: legacyGoldenFileName(problem.id),
    contents: rendered.value.contents,
  };
}

/** Render every problem in `problems`, in the given order. */
export function renderLegacyGoldenCorpus(
  problems: readonly EvalProblem[],
): readonly LegacyGoldenDesign[] {
  return problems.map(renderLegacyGoldenDesign);
}
