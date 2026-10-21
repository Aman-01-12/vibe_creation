// `alu`'s undriven-output-port refusal, against the REAL derivation (timing-contract-inference
// task 14.1; Req 1.16, 2.3, 3.5).
//
// WHAT THIS PINS
//   DQ-01 (`.kiro/specs/timing-contract-inference/design-questions.md`) measured that
//   `verified_alu` declares `carry`, `negative`, `overflow` and never assigns any of them, so
//   `classifyPortTiming` refuses the whole design with cause `undriven-output-port` naming those
//   three ports. This suite reproduces that measurement against the real toolchain rather than
//   trusting the design doc's own recorded finding, and pins the production import's quarantine
//   of `alu` through the same real call. `r`, `zero`, and `flag` are cleanly driven in isolation
//   but are collateral damage of the whole-design refusal (DQ-08); this suite does not assert
//   anything about them, since task 12.8's ratchet test already covers that distinct fact.
//
// WHY A NEVER-REFUSING IMPORT RECOVERS alu's REFERENCE RTL AND MODULE INTERFACE
//   `alu` is excluded from `importRtllmCorpus`'s `problems` under the REAL derivation (that is
//   the fact under test), so its `ModuleInterface` cannot be read off a production import. The
//   same device task 12.7's `deriveTimingCrossCheckMeasurement` uses is reused here: import once
//   with a never-refusing `FixedTimingDerivation` stand-in to recover every design's reference
//   RTL and `ModuleInterface` regardless of its real timing outcome, then call the REAL
//   `localTimingDerivation()` directly over `alu`'s own recovered request.
//
// WHY THE REFUSAL'S `cause` IS `undriven-output-port`, NOT `input-and-state-independent`
//   `accumulate()` in `app/tools/formal/timing.ts` folds every undetermined port under the
//   LOWEST-numbered cause in `REFUSAL_CAUSE_PRECEDENCE`. All three of `alu`'s undetermined
//   ports hit clause 2 (`undriven`) before ever reaching clause 5, so every port in the fold
//   carries the same cause and the dominant cause is unambiguously `undriven-output-port`.
//
// GATING
//   Two capabilities are needed and each is probed, never assumed, mirroring
//   `rtllm-corpus-stage0.integration.test.ts`: the real toolchain (`STRUCTURAL_PROBE`) and the
//   pinned RTLLM checkout. When either is missing the suite SKIPS with a reason.

import { describe, expect, it } from 'vitest';

import {
  FileSystemCorpusCheckout,
  FixedTimingDerivation,
  importRtllmCorpus,
  localTimingDerivation,
  RTLLM_CHECKOUT_PATH,
} from '@app/eval';

import { STRUCTURAL_PROBE } from './real-oracle-harness.js';

/** The `alu` problem id, exactly as the corpus names it. */
const ALU_PROBLEM_ID = 'rtllm/miscellaneous/alu';

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
    `[timing-undriven-refusal-alu] NOT exercised: ${SKIP_REASON}. alu's undriven-output-port ` +
      'refusal was not reproduced against the real toolchain in this environment.',
  );
}

/** Timeout for the whole-checkout import plus one design's real pre-pass elaboration. */
const DESIGN_TIMEOUT_MS = 120_000;

describe('alu undriven-refusal capability probe', () => {
  it('documents whether the real derivation was run in this environment', () => {
    expect(typeof RUNNABLE).toBe('boolean');
    expect(SKIP_REASON.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!RUNNABLE)(
  'the real derivation refuses alu with undriven-output-port (Req 1.16, 2.3, 3.5)',
  () => {
    it(
      'names exactly carry, negative, and overflow under the undriven-output-port cause',
      async () => {
        const checkout = new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH);
        // Never refuses, so alu's own reference RTL and ModuleInterface are recovered even
        // though the REAL derivation (called separately below) excludes alu from `problems`.
        const recovery = await importRtllmCorpus(checkout, new FixedTimingDerivation('registered'));
        const problem = recovery.problems.find((candidate) => candidate.id === ALU_PROBLEM_ID);
        const reference = recovery.references.get(ALU_PROBLEM_ID);
        if (problem === undefined || reference === undefined) {
          throw new Error(`${ALU_PROBLEM_ID} is not present in the imported checkout`);
        }

        const derivation = localTimingDerivation();
        const derived = await derivation.derive({
          rtl: reference.rtl,
          moduleInterface: problem.spec.moduleInterface,
        });

        expect(derived.ok).toBe(false);
        if (derived.ok) return;
        expect(derived.error.cause).toBe('undriven-output-port');
        expect(new Set(derived.error.ports)).toEqual(new Set(['carry', 'negative', 'overflow']));
      },
      DESIGN_TIMEOUT_MS,
    );

    it(
      'leaves alu out of the imported problem set, quarantined under TIMING_UNDERIVABLE',
      async () => {
        const checkout = new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH);
        const derivation = localTimingDerivation();
        const corpus = await importRtllmCorpus(checkout, derivation);

        const imported = corpus.problems.find((problem) => problem.id === ALU_PROBLEM_ID);
        expect(imported).toBeUndefined();

        const quarantined = corpus.quarantined.find(
          (record) => record.problemId === ALU_PROBLEM_ID,
        );
        expect(quarantined?.code).toBe('TIMING_UNDERIVABLE');
        expect(quarantined?.detail).toContain('undriven-output-port');
      },
      DESIGN_TIMEOUT_MS,
    );
  },
);

describe('undriven-output-port is a distinct cause from input-and-state-independent', () => {
  it('is a separate TimingRefusalCause member, never conflated with the stateless-refusal cause', async () => {
    const { classifyPortTiming } = await import('@app/tools');

    // A design with one undriven port and one driven-but-stateless port: each fact lands on
    // its own clause, and the refusal must carry the LOWER-numbered (clause 2) cause, proving
    // the two causes are ranked and distinguished rather than merged into one bucket.
    const moduleInterface = {
      moduleName: 'two_refusal_causes',
      ports: [
        { name: 'clk', direction: 'input' as const, width: 1 },
        { name: 'a', direction: 'input' as const, width: 1 },
        { name: 'undriven_out', direction: 'output' as const, width: 1 },
        { name: 'stateless_out', direction: 'output' as const, width: 1 },
      ],
      clocking: { clockName: 'clk', resetName: null, resetActiveLow: false },
      validityOutputName: null,
    };
    const finding = {
      derived: true as const,
      ports: [
        { port: 'undriven_out', sources: [], reachesState: false, undriven: true },
        { port: 'stateless_out', sources: [], reachesState: false, undriven: false },
      ],
    };

    const result = classifyPortTiming(moduleInterface, finding);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Clause 2 (undriven) outranks clause 5 (input-and-state-independent); the dominant cause
    // is the undriven one even though both ports are folded into the one refusal.
    expect(result.error.cause).toBe('undriven-output-port');
    expect(result.error.cause).not.toBe('input-and-state-independent');
    expect(new Set(result.error.ports)).toEqual(new Set(['undriven_out', 'stateless_out']));
  });
});
