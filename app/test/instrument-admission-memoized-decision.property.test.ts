// instrument-precheck-and-attribution, Property 15: The control runs at most
// once, and refuses only on `invalid` (task 6.5).
//
// `MemoizingInstrumentAdmission` (`app/eval/instrument-admission.ts`) wraps an
// injected `InstrumentControl` and is consulted by the Verification_Loop at
// most once per run (Req 4.1) - but the Eval_Harness may still read
// `recorded()` afterward regardless of whether the loop actually called
// `admit`, so the control itself must never run a second time no matter how
// many `admit`/`recorded` calls land on one instance (Req 4.12).
//
// This property drives an arbitrary SEQUENCE of `admit` calls (varying
// testbench text per call, so the request shape is not pinned to one string)
// against a spy `InstrumentControl` whose returned verdict is itself generated
// - `valid`, every `invalid` defect code, every `unchecked` reason, a `null`
// (no reference design), or a throw - and asserts, for every generated case:
//
//   1. the wrapped control's `check` is invoked AT MOST ONCE, however many
//      times `admit` is called (Req 4.12);
//   2. every `admit` call resolves to the SAME decision (memoization holds,
//      not just call-count suppression);
//   3. `recorded()` after the fact is the exact result the decision was taken
//      from - `null` only when the control was never run - so the Eval_Harness
//      reads the identical evidence the loop's decision rested on (Req 4.13);
//   4. the decision is `inadmissible` if and only if the underlying verdict's
//      validity was `invalid` - `valid`, `unchecked`, a `null` result, and a
//      thrown `check` all land on `admissible`/`undecided` and never on
//      `inadmissible` (Req 4.11).
//
// Validates: Requirements 4.1, 4.11, 4.12, 4.13

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  MemoizingInstrumentAdmission,
  invalidInstrument,
  uncheckedInstrument,
  VALID_INSTRUMENT,
  type InstrumentControl,
  type InstrumentControlRequest,
  type InstrumentControlResult,
  type InstrumentDefectCode,
  type InstrumentUncheckedReason,
  type RecordedInstrumentVerdict,
} from '@app/eval';
import type { ResourceLimits } from '@app/tools';
import { propertyParameters } from '@app/test';

const PROPERTY =
  'instrument-precheck-and-attribution, Property 15: The control runs at most once, and ' +
  'refuses only on invalid';

const LIMITS: ResourceLimits = { cpu: 1, memMb: 256, procs: 64, diskMb: 64, wallMs: 5000 };
const PARTIAL_REQUEST = {
  problemId: 'rtllm/arithmetic/adder_8bit',
  limits: LIMITS,
  requiredCheckNames: [],
};

// -- Generators ---------------------------------------------------------------

const DEFECT_CODES: readonly InstrumentDefectCode[] = [
  'TESTBENCH_FAILED_REFERENCE',
  'TESTBENCH_REFERENCE_UNBUILDABLE',
  'CONTROL_RUN_ERRORED',
  'TESTBENCH_SURVIVED_MUTANTS',
];

const UNCHECKED_REASONS: readonly InstrumentUncheckedReason[] = [
  'control-absent',
  'no-testbench',
  'no-reference',
  'testbench-unsubmittable',
  'control-unavailable',
  'no-mutants-generated',
  'no-valid-mutants',
  'no-golden-killed-mutants',
  'mutation-probe-unavailable',
  'control-resource-exhausted',
];

/** Every verdict `RecordedInstrumentVerdict` can take, generated rather than pinned. */
const recordedVerdictArbitrary: fc.Arbitrary<RecordedInstrumentVerdict> = fc.oneof(
  fc.constant(VALID_INSTRUMENT),
  fc.constantFrom(...DEFECT_CODES).map(invalidInstrument),
  fc.constantFrom(...UNCHECKED_REASONS).map(uncheckedInstrument),
);

/** One `InstrumentControlResult`, or `null` for "no reference design". */
const controlOutcomeArbitrary: fc.Arbitrary<InstrumentControlResult | null> = fc.oneof(
  { weight: 1, arbitrary: fc.constant(null) },
  {
    weight: 4,
    arbitrary: recordedVerdictArbitrary.map((verdict): InstrumentControlResult => ({
      verdict,
      stdout: '',
      stderr: '',
      exitCode: 0,
      mutation: null,
      positiveRun: null,
    })),
  },
);

/** How the wrapped control resolves for one generated case: a value, or a throw. */
type ScriptedOutcome =
  | { readonly kind: 'resolve'; readonly value: InstrumentControlResult | null }
  | { readonly kind: 'throw' };

const scriptedOutcomeArbitrary: fc.Arbitrary<ScriptedOutcome> = fc.oneof(
  {
    weight: 4,
    arbitrary: controlOutcomeArbitrary.map((value) => ({ kind: 'resolve', value }) as const),
  },
  { weight: 1, arbitrary: fc.constant({ kind: 'throw' } as const) },
);

/** Testbench source text varied per `admit` call, so the request shape is never pinned. */
const testbenchArbitrary: fc.Arbitrary<string> = fc
  .string({ minLength: 0, maxLength: 40 })
  .map((body) => `module tb; // ${body}\nendmodule\n`);

/** How many times `admit` is called on one instance, and with what per-call testbench. */
const admitSequenceArbitrary: fc.Arbitrary<readonly string[]> = fc.array(testbenchArbitrary, {
  minLength: 1,
  maxLength: 5,
});

/**
 * A spy `InstrumentControl` that counts invocations and resolves/throws exactly the scripted
 * outcome on every call - so a second invocation (the defect this property forbids) is
 * directly observable as `checkCount > 1`, never merely inferred from the decision.
 */
class SpyControl implements InstrumentControl {
  checkCount = 0;
  readonly requests: InstrumentControlRequest[] = [];

  constructor(private readonly scripted: ScriptedOutcome) {}

  check(request: InstrumentControlRequest): Promise<InstrumentControlResult | null> {
    this.checkCount += 1;
    this.requests.push(request);
    if (this.scripted.kind === 'throw') {
      return Promise.reject(new Error('control toolchain fell over'));
    }
    return Promise.resolve(this.scripted.value);
  }
}

// -- Property 15 ----------------------------------------------------------------

describe(PROPERTY, () => {
  it('runs the control at most once, keeps every decision identical, and refuses only on invalid', async () => {
    await fc.assert(
      fc.asyncProperty(
        scriptedOutcomeArbitrary,
        admitSequenceArbitrary,
        async (scripted, testbenches) => {
          const control = new SpyControl(scripted);
          const admission = new MemoizingInstrumentAdmission(control, PARTIAL_REQUEST);

          const decisions = [];
          for (const testbench of testbenches) {
            decisions.push(await admission.admit({ testbench }));
          }

          // (1) At most one underlying control invocation, however many admit() calls landed.
          expect(control.checkCount).toBeLessThanOrEqual(1);

          // (2) Memoization, not just call suppression: every call resolved to the SAME decision.
          for (const decision of decisions) {
            expect(decision).toBe(decisions[0]);
          }

          // (3) recorded() is the exact result the decision was taken from.
          const recorded = admission.recorded();
          if (scripted.kind === 'throw') {
            // Fail-safe: a throw never leaves recorded() null, and never leaks the throw's detail.
            expect(recorded).not.toBeNull();
            expect(JSON.stringify(recorded)).not.toMatch(/toolchain fell over/);
          } else if (scripted.value === null) {
            expect(recorded).toBeNull();
          } else {
            expect(recorded).toBe(scripted.value);
          }

          // (4) inadmissible IFF the underlying verdict's validity was invalid.
          const wasInvalid =
            scripted.kind === 'resolve' &&
            scripted.value !== null &&
            scripted.value.verdict.validity === 'invalid';
          expect(decisions[0] === 'inadmissible').toBe(wasInvalid);
        },
      ),
      propertyParameters(),
    );
  });
});
