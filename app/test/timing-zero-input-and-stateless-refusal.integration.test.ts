// The zero-input and input-and-state-independent cases, against the REAL derivation
// (timing-contract-inference task 14.2; Req 1.9, 1.15).
//
// WHAT "ZERO-INPUT" MEANS HERE
//   A zero-input design is one whose Declared_Data_Input set is empty: every input port is
//   either the clock or the reset (`moduleInterface.clocking`), so no port can ever satisfy
//   clause 3 (`combinational`) of `classifyPortTiming`. Every one of its declared output ports
//   can land only on clause 4 (`registered`, state-dependent) or clause 5 (`refused` under
//   `input-and-state-independent`, driven but stateless) - never on `combinational`. The ten
//   designs are COMPUTED from the real imported `ModuleInterface`s rather than named by a fixed
//   list, because the requirements text's own claim ("all ten zero-input designs are clocked and
//   state-dependent", `requirements.md`'s Introduction) is itself a measured count this suite
//   can verify directly, rather than a list this suite would have to keep in sync by hand.
//
// WHY THE SECOND ASSERTION IS A STRUCTURAL SCAN, NOT A COUNT OVER `combinational` VALUES
//   Clause 5 in `app/tools/formal/timing.ts` is `return err('input-and-state-independent')` -
//   there is no code path from that clause to `ok('combinational')`. Scanning the corpus for a
//   `combinational` value and asserting none of them came from clause 5 would be unfalsifiable
//   (nothing could ever disprove it from the OUTSIDE, since a `PortTiming` value carries no
//   record of which clause produced it). So this suite instead scans every REFUSAL the real
//   corpus-wide run produces and asserts the clause-5 cause, where it appears, never attaches to
//   a port that also appears with `combinational` elsewhere - the only externally observable
//   form of "this clause never classifies combinational" - plus a direct unit-level check that
//   clause 5 literally cannot return `ok`, closing the gap a corpus-only measurement would leave
//   if no real design happened to hit clause 5 at all.
//
// GATING
//   Two capabilities are needed and each is probed, never assumed, mirroring
//   `rtllm-corpus-stage0.integration.test.ts`: the real toolchain (`STRUCTURAL_PROBE`) and the
//   pinned RTLLM checkout. When either is missing the suite SKIPS with a reason.

import { describe, expect, it } from 'vitest';

import type { ModuleInterface, PortTiming } from '@app/core';
import {
  FileSystemCorpusCheckout,
  FixedTimingDerivation,
  importRtllmCorpus,
  localTimingDerivation,
  RTLLM_CHECKOUT_PATH,
  type RtllmCorpus,
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
  console.warn(
    `[timing-zero-input-and-stateless-refusal] NOT exercised: ${SKIP_REASON}. The zero-input ` +
      'and input-and-state-independent claims were not measured against the real toolchain here.',
  );
}

/** Timeout for the whole real import sweep. */
const SWEEP_TIMEOUT_MS = 600_000;

/** The Declared_Data_Input set: every input port minus the clock and the reset (Req 1.2, 1.3). */
function declaredDataInputCount(moduleInterface: ModuleInterface): number {
  const { clockName, resetName } = moduleInterface.clocking;
  return moduleInterface.ports.filter(
    (port) => port.direction === 'input' && port.name !== clockName && port.name !== resetName,
  ).length;
}

/** The `<design>` segment of a `rtllm/<category>/<design>` problem id. */
function designNameOf(problemId: string): string {
  return problemId.slice(problemId.lastIndexOf('/') + 1);
}

describe('zero-input / stateless-refusal capability probe', () => {
  it('documents whether the real derivation was run in this environment', () => {
    expect(typeof RUNNABLE).toBe('boolean');
    expect(SKIP_REASON.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!RUNNABLE)(
  'zero-input designs classify by Retained_Sequential_State alone (Req 1.9, 1.15)',
  () => {
    it(
      'finds exactly ten zero-input designs, each classified by state dependence alone - ' +
        'never by clause 3, since no declared data input exists for it to reach',
      async () => {
        const checkout = new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH);
        // Never refuses, so every zero-input design's ModuleInterface is recovered even one
        // that the REAL derivation (called per-design below) goes on to refuse outright
        // (e.g. clkgenerator, undriven-output-port) - a production-import count would drop
        // such a design from `problems` entirely, undercounting the ten this suite measures.
        const recovery = await importRtllmCorpus(checkout, new FixedTimingDerivation('registered'));
        const zeroInputProblems = recovery.problems.filter(
          (problem) => declaredDataInputCount(problem.spec.moduleInterface) === 0,
        );

        // The requirements text's own measured count (Introduction: "all ten zero-input
        // designs are clocked and state-dependent"). Asserted here so a corpus change that
        // silently adds or removes a zero-input design is caught rather than read as "fine,
        // the loop below still only iterates over whatever is there". "Clocked" there reads
        // as state-dependent, not as "declares a clock INPUT port": `clkgenerator` is one of
        // the ten and GENERATES its own clock as an output, so it declares no clock input at
        // all, yet still depends on its own retained value (Req 1.7's Moore case, with the
        // state register and the output being the same net).
        expect(zeroInputProblems).toHaveLength(10);

        const derivation = localTimingDerivation();
        const failures: string[] = [];
        for (const problem of zeroInputProblems) {
          const designName = designNameOf(problem.id);
          const moduleInterface = problem.spec.moduleInterface;
          const reference = recovery.references.get(problem.id);
          if (reference === undefined) {
            failures.push(`${designName}: reference RTL missing from the recovery import`);
            continue;
          }
          const derived = await derivation.derive({ rtl: reference.rtl, moduleInterface });
          if (derived.ok) {
            for (const entry of derived.value.entries) {
              if (entry.timing === 'combinational') {
                failures.push(
                  `${designName}/${entry.portName}: derived combinational with zero declared ` +
                    'data inputs, which clause 3 cannot reach',
                );
              }
            }
            continue;
          }
          // A refusal is an acceptable outcome here too (e.g. undriven-output-port): a
          // refusal structurally cannot smuggle a `combinational` value, so nothing to flag.
        }
        if (failures.length > 0) {
          throw new Error(`${String(failures.length)} failure(s):\n${failures.join('\n')}`);
        }
        expect(failures).toEqual([]);
      },
      SWEEP_TIMEOUT_MS,
    );

    it(
      'never attaches an input-and-state-independent refusal to a port also seen as combinational',
      async () => {
        const checkout = new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH);
        const derivation = localTimingDerivation();
        const corpus: RtllmCorpus = await importRtllmCorpus(checkout, derivation);

        // Every port the real corpus-wide run ever classified `combinational`, keyed by
        // design/port. A clause-5 refusal on the SAME pair would be a logical contradiction
        // (one derivation call returns exactly one outcome per design), so this is a sanity
        // scan: it can only ever come back empty, and an empty result over a non-empty corpus
        // is the externally observable form of "clause 5 never produced combinational".
        const combinationalPairs = new Set<string>();
        for (const problem of corpus.problems) {
          const designName = designNameOf(problem.id);
          for (const entry of problem.spec.timingContract.entries) {
            if (entry.timing === 'combinational') {
              combinationalPairs.add(`${designName}/${entry.portName}`);
            }
          }
        }
        expect(combinationalPairs.size).toBeGreaterThan(0);

        const statelessRefusalDetails = corpus.quarantined
          .filter((record) => record.code === 'TIMING_UNDERIVABLE')
          .filter((record) => record.detail.includes('input-and-state-independent'));
        for (const refusal of statelessRefusalDetails) {
          const designName = designNameOf(refusal.problemId);
          for (const pair of combinationalPairs) {
            expect(pair.startsWith(`${designName}/`)).toBe(false);
          }
        }
      },
      SWEEP_TIMEOUT_MS,
    );
  },
);

describe('clause 5 is structurally refusal-only', () => {
  it("cannot return ok('combinational') for a driven, stateless, input-independent port", async () => {
    const { classifyPortTiming } = await import('@app/tools');

    const moduleInterface: ModuleInterface = {
      moduleName: 'driven_stateless',
      ports: [
        { name: 'clk', direction: 'input', width: 1 },
        { name: 'a', direction: 'input', width: 1 },
        { name: 'const_out', direction: 'output', width: 1 },
      ],
      clocking: { clockName: 'clk', resetName: null, resetActiveLow: false },
      validityOutputName: null,
    };
    // Driven (not undriven), reaches no declared data input, and does not cross retained
    // state: the exact shape clause 5 exists for.
    const finding = {
      derived: true as const,
      ports: [{ port: 'const_out', sources: [], reachesState: false, undriven: false }],
    };

    const result = classifyPortTiming(moduleInterface, finding);

    expect(result.ok).toBe(false);
    if (result.ok) {
      const timing: PortTiming = result.value.entries[0]?.timing as PortTiming;
      expect(timing).not.toBe('combinational');
      return;
    }
    expect(result.error.cause).toBe('input-and-state-independent');
  });
});
