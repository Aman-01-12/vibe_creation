// The REPLAY_POSITIVE_CONTROL: the gate that lets the adjudicator accuse (criterion 4.14).
//
// WHY THIS FILE EXISTS AT ALL
//   `adjudicate` may return `not-realizable`, which is an accusation that the Reset_Contract
//   derivation is defective. An instrument allowed to make that accusation has to first show it
//   can recognise a counterexample that is REAL. This file is that demonstration, and it is a
//   test rather than a reviewer's judgement so the accusing direction cannot be restored by
//   someone deciding the harness looks correct.
//
// THE CONTROL
//   `adder-pipe-64bit-carry-never-set` claims the carry out of a 64-bit add is never set, which
//   is false by construction: all-ones plus all-ones carries. So the oracle's refutation is
//   genuine and a sound adjudication must call its counterexample realizable. If this file
//   reddens, the `not-realizable` return in `formal-false-refutation.ts` must go back to
//   abstaining with `replay-harness-unvalidated` until it is green again.
//
// THREE DEFECTS THIS CONTROL CAUGHT, none of which any unit test saw
//   1. A single-step reader against a 39-step path. A counterexample is a path.
//   2. `Number.parseInt` rounding a 65-bit result: the trace's 2^64 read back as
//      18446744073709552000, so the replay drove a value the solver never chose.
//   3. smtbmc emits a step per HALF cycle, so a replay driving one edge per step advanced the
//      design twice as fast as the trace.
//   Every one of them produced a confident `not-realizable`, which is a false finding against
//   the prepass. That is why the control gates the accusation.

import { describe, expect, it } from 'vitest';

import { FileSystemCorpusCheckout, importRtllmCorpus, RTLLM_CHECKOUT_PATH } from '@app/eval';

import {
  adjudicate,
  samplingPhaseSteps,
  traceSteps,
  type CandidateFalseRefutation,
} from './formal-false-refutation.js';
import { PROPERTY_FIXTURE } from './formal-fixtures.js';
import {
  FORMAL_PROBE,
  PROBE,
  realFormalAdapter,
  realOracleAdapter,
} from './real-oracle-harness.js';

/** The control's design and the deliberately false property over it. */
const CONTROL_DESIGN_ID = 'rtllm/arithmetic/adder_pipe_64bit';
const CONTROL_CRITERION = '2.5';

/** Both real tools are needed: the oracle to refute, and iverilog to replay. */
const READY = FORMAL_PROBE.available && PROBE.available;

/** Proving the control is measured at about seven seconds; the replay adds a little. */
const CONTROL_TIMEOUT_MS = 120_000;

const CORPUS = READY
  ? await importRtllmCorpus(new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH))
  : null;

describe.skipIf(!READY || CORPUS === null || CORPUS.problems.length === 0)(
  'the Replay_Positive_Control gates the accusing direction (criterion 4.14)',
  () => {
    it(
      'adjudicates a counterexample that is genuine by construction as REALIZABLE',
      async () => {
        const corpus = CORPUS;
        if (corpus === null) {
          throw new Error('the corpus is required for this control');
        }
        const reference = corpus.references.get(CONTROL_DESIGN_ID);
        const problem = corpus.problems.find((candidate) => candidate.id === CONTROL_DESIGN_ID);
        const entry = PROPERTY_FIXTURE.find(
          (candidate) =>
            candidate.designId === CONTROL_DESIGN_ID &&
            candidate.criterionRef === CONTROL_CRITERION,
        );
        if (reference === undefined || problem === undefined || entry === undefined) {
          throw new Error('the control entry must be present in the fixture and the corpus');
        }
        // Non-vacuity: the control is only a control because its author expects a refutation.
        expect(entry.expectedVerdict).toBe('refuted');

        const real = realFormalAdapter(FORMAL_PROBE.pythonBin);
        const result = await real.oracle.prove({
          designSource: reference.rtl,
          designInterface: problem.spec.moduleInterface,
          property: entry.property,
          budgetMs: CONTROL_TIMEOUT_MS,
        });

        // The oracle must actually refute it, or there is no counterexample to adjudicate.
        expect(result.verdict).toBe('refuted');
        if (result.verdict !== 'refuted') {
          return;
        }
        const trace = await real.artifacts.readText(result.counterexample);
        expect(trace).not.toBeNull();

        // The two reductions the replay depends on, asserted so a regression in either names
        // itself rather than showing up only as a failed adjudication.
        const steps = traceSteps(trace ?? '');
        expect(steps.length).toBeGreaterThan(1);
        const cycles = samplingPhaseSteps(steps, problem.spec.moduleInterface.clocking.clockName);
        // One step per half cycle, so the sampling phase is about half the steps.
        expect(cycles.length).toBeLessThan(steps.length);
        expect(cycles.length).toBeGreaterThan(0);

        const candidate: CandidateFalseRefutation = {
          propertyId: entry.property.id,
          designId: CONTROL_DESIGN_ID,
          design: reference.rtl,
          designInterface: problem.spec.moduleInterface,
          expectedVerdict: entry.expectedVerdict,
          actualVerdict: result.verdict,
          counterexample: trace ?? '',
          resetContract: null,
        };

        const adjudication = await adjudicate(candidate, realOracleAdapter());

        // THE GATE. A harness that cannot confirm this must not be allowed to accuse the
        // Reset_Contract derivation of anything.
        expect(adjudication.kind).toBe('realizable');
      },
      CONTROL_TIMEOUT_MS,
    );
  },
);

if (!READY) {
  console.warn(
    `[formal-false-refutation] The Replay_Positive_Control did NOT run: formal=${FORMAL_PROBE.reason}, sim=${PROBE.reason}. ` +
      'The accusing direction is therefore ungated in this environment.',
  );
}
