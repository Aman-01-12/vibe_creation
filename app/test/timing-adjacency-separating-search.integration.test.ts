// The cone-vs-adjacency separating-set search, against the REAL derivation
// (timing-contract-inference task 13.2; Req 1.10, 6.13, 6.14, 6.15).
//
// WHAT THIS ESTABLISHES
//   Requirement 1.10 chooses cone reachability over flip-flop-output adjacency as the deciding
//   test, on the semantic ground that the Consensus_Harness compares a `registered` port against
//   an all-zero-input expectation (a reachability question), NOT on a measured disagreement
//   between the two rules. DQ-05 corrected an earlier, wrong claim that `traffic_light` separates
//   them; it does not. This suite runs BOTH classifiers over every declared output port of every
//   design in the Derivation_Population and records whichever outcome actually holds:
//     - a NON-EMPTY separating set, with each separating port checked against the manifest
//       (the cone rule must be the one that agrees, per the task text), or
//     - an EMPTY separating set, in which case Requirement 1.10's discrimination is recorded as
//       UNWITNESSED ON THIS CORPUS rather than silently read as "passed".
//   Neither outcome is assumed: this suite reproduces `app/eval/scripts/timing-adjacency-
//   separating-search.ts`'s real measurement rather than trusting its committed artifact alone.
//
// WHY A SCRIPT RATHER THAN THE PRODUCTION DERIVATION PORT
//   `FormalPrepassTimingDerivation.derive` folds the pre-pass finding through `classifyPortTiming`
//   immediately and never returns the raw `PrepassTimingFinding` a second classifier would need.
//   `runAdjacencySeparatingSearch` (task 13.2's own script) recovers that raw finding once per
//   design and runs BOTH classifiers over the identical facts, which is what this suite reuses
//   rather than duplicating.
//
// GATING
//   Two capabilities are needed and each is probed, never assumed, mirroring
//   `rtllm-corpus-stage0.integration.test.ts`: the real toolchain (`STRUCTURAL_PROBE`) and the
//   pinned RTLLM checkout. When either is missing the suite SKIPS with a reason.

import { describe, expect, it } from 'vitest';

import { FileSystemCorpusCheckout, RTLLM_CHECKOUT_PATH } from '@app/eval';

import { runAdjacencySeparatingSearch } from '../eval/scripts/timing-adjacency-separating-search.js';
import { STRUCTURAL_PROBE } from './real-oracle-harness.js';

// -- Corpus availability probe (mirrors rtllm-corpus-stage0.integration.test.ts) --------

/** Whether the pinned checkout is present, and why not when it is absent. */
interface CorpusProbe {
  readonly available: boolean;
  readonly reason: string;
}

async function probeCorpus(): Promise<CorpusProbe> {
  const checkout = new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH);
  const categories = await checkout.listDirectories([]);
  if (categories.length === 0) {
    return {
      available: false,
      reason: 'no RTLLM checkout at the pinned commit; run `npm run corpus:fetch`',
    };
  }
  return { available: true, reason: 'the pinned RTLLM checkout is present' };
}

const CORPUS = await probeCorpus();

const SKIP_REASON = !STRUCTURAL_PROBE.available ? STRUCTURAL_PROBE.reason : CORPUS.reason;
const RUNNABLE = STRUCTURAL_PROBE.available && CORPUS.available;

if (!RUNNABLE) {
  console.warn(
    `[timing-adjacency-separating-search] NOT exercised: ${SKIP_REASON}. Requirement 1.10's ` +
      'discrimination claim was not measured against the real toolchain in this environment.',
  );
}

/** Timeout for the whole search: up to ~48 real designs, one pre-pass elaboration each. */
const SWEEP_TIMEOUT_MS = 600_000;

describe('adjacency separating-set search capability probe', () => {
  it('documents whether the real search was run in this environment', () => {
    expect(typeof RUNNABLE).toBe('boolean');
    expect(SKIP_REASON.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!RUNNABLE)(
  'the cone rule and the adjacency rule, searched over the Derivation_Population (Req 1.10, 6.13, 6.14, 6.15)',
  () => {
    it(
      'records the discrimination as UNWITNESSED when the separating set is empty, or names ' +
        'every separating port with the cone rule agreeing with the manifest otherwise',
      async () => {
        const report = await runAdjacencySeparatingSearch();

        // Non-vacuous: the search must actually have walked the Derivation_Population (48
        // designs), not silently measured zero and reported an empty set for free.
        expect(report.designsSearched).toBeGreaterThan(0);

        if (report.adjacencySeparating.length === 0) {
          // The EMPTY-set path: Requirement 1.10's discrimination is UNWITNESSED on this
          // corpus, matching design.md's own stated expectation (no Moore-decode-behind-a-
          // flop shape has been measured in the Derivation_Population).
          expect(report.unwitnessed).toBe(true);
          return;
        }

        // The NON-EMPTY-set path: every separating port's cone result must be the one that
        // agrees with the manifest (the task's own stated rule), for every port that has a
        // manifest entry to check against at all.
        expect(report.unwitnessed).toBe(false);
        const checkedAgainstManifest = report.adjacencySeparating.filter(
          (separating) => separating.coneAgreesWithManifest !== null,
        );
        const coneWrong = checkedAgainstManifest.filter(
          (separating) => separating.coneAgreesWithManifest === false,
        );
        if (coneWrong.length > 0) {
          throw new Error(
            `${String(coneWrong.length)} separating port(s) where the cone rule disagrees ` +
              `with the manifest instead of the adjacency rule:\n` +
              coneWrong
                .map(
                  (separating) =>
                    `  ${separating.design}/${separating.port}: cone=${separating.coneResult}, ` +
                    `adjacency=${separating.adjacencyResult}`,
                )
                .join('\n'),
          );
        }
        expect(coneWrong).toEqual([]);
      },
      SWEEP_TIMEOUT_MS,
    );
  },
);
