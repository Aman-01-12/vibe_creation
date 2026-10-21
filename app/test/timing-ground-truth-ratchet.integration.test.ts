// The manifest ratchet, against the REAL derivation (timing-contract-inference task 12.8).
//
// WHAT THIS ESTABLISHES
//   `compareDerivedTiming` (task 1.5) is a pure comparator over supplied data, so its own unit
//   tests (`timing-cross-check.test.ts`) can only prove it classifies correctly - never that the
//   committed `TIMING_GROUND_TRUTH` manifest still agrees with what the real toolchain derives.
//   This suite closes that gap: it runs the real `localTimingDerivation()` over every reference
//   design in the pinned RTLLM checkout and feeds the result straight into the same comparator
//   the unit tests pin, asserting the ratchet holds in BOTH directions (Req 6.2, 6.12) - a port
//   the manifest expects to agree must derive that value, and a port the manifest records
//   `refused` must actually be refused.
//
// WHY THE REAL RUN, NOT A STAND-IN
//   `deriveTimingCrossCheckMeasurement` (task 12.7's own script) is reused rather than
//   duplicated, so there is one owner of "import the checkout, then derive each design's real
//   per-port timing". The alternative - writing a second derivation loop here - would risk the
//   two drifting the way `eval-harness-integration-needs-test-to-eval-boundary` warns against:
//   two paths answering one question can disagree silently.
//
// GATING
//   Two capabilities are needed and each is probed, never assumed, mirroring
//   `rtllm-corpus-stage0.integration.test.ts`: the real toolchain (`STRUCTURAL_PROBE`: yosys +
//   iverilog + vvp + worker Python - the pre-pass itself needs only yosys, but the shared probe
//   is reused rather than adding a fourth probe shape for one suite) and the pinned RTLLM
//   checkout (fetched, not vendored, so it is absent on a fresh clone). When either is missing
//   the suite SKIPS with a reason.

import { describe, expect, it } from 'vitest';

import {
  compareDerivedTiming,
  deriveTimingCrossCheckMeasurement,
  FileSystemCorpusCheckout,
  RTLLM_CHECKOUT_PATH,
  type TimingPortComparison,
} from '@app/eval';

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
  // A single, explicit note that the ratchet was NOT exercised here, so the committed
  // manifest's agreement with the real toolchain is a recorded claim rather than a
  // reproduced measurement in this environment.
  console.warn(
    `[timing-ground-truth-ratchet] Manifest ratchet NOT exercised: ${SKIP_REASON}. The ` +
      'TIMING_GROUND_TRUTH manifest was not reproduced against real yosys in this environment.',
  );
}

/** Timeout for the whole real derivation (roughly 48 designs, one pre-pass elaboration each). */
const SWEEP_TIMEOUT_MS = 600_000;

/** One readable line per failing row, naming every field a reviewer needs without the manifest. */
function describeFailure(row: TimingPortComparison): string {
  return (
    `${row.design}/${row.port}: ${row.outcome} (derived=${String(row.derived)}, ` +
    `groundTruth=${String(row.groundTruth)}, expected=${String(row.expected)})`
  );
}

describe('manifest ratchet capability probe', () => {
  it('documents whether the real derivation was run in this environment', () => {
    // Always runs; on skip the note above has already recorded why.
    expect(typeof RUNNABLE).toBe('boolean');
    expect(SKIP_REASON.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!RUNNABLE)(
  'the real derivation reproduces TIMING_GROUND_TRUTH in both directions (Req 6.2, 6.12)',
  () => {
    it(
      'leaves the ratchet holding: no manifest entry disagrees, and no refused port is classified',
      async () => {
        const { results } = await deriveTimingCrossCheckMeasurement();
        const { failures } = compareDerivedTiming(results);

        if (failures.length > 0) {
          throw new Error(
            `${String(failures.length)} manifest ratchet failure(s):\n` +
              failures.map(describeFailure).join('\n'),
          );
        }
        expect(failures).toEqual([]);
      },
      SWEEP_TIMEOUT_MS,
    );
  },
);
