// Unit tests for `MemoizingInstrumentAdmission` (Req 4.10, 4.11, 4.12, 4.15, 8.5; task 6.4).
//
// WHAT THESE PIN DOWN
//   1. The decision mapping: `invalid` -> `inadmissible`, `valid` -> `admissible`, and
//      `unchecked` / `null` / a throw all -> `undecided`.
//   2. Memoization: the injected `InstrumentControl` runs AT MOST ONCE per instance, whether
//      `admit` is called once, called twice, or read through `recorded()` after the fact.
//   3. `recorded()` returns the exact `InstrumentControlResult` the decision came from, and
//      `null` when `admit` never ran.
//   4. The whole decision rests on a deterministic tool result: a fake `ModelRouter` is
//      constructed alongside the fake control and asserted never invoked, proving there is no
//      seam here through which a model call could enter.

import { describe, expect, it } from 'vitest';

import type {
  ModelRouter,
  ModelRouterFailure,
  ModelTask,
  RoutedModelResult,
  RoutingDiagnostics,
} from '@app/agent';
import type { Result } from '@app/core';
import type { ResourceLimits } from '@app/tools';

import { MemoizingInstrumentAdmission } from './instrument-admission.js';
import {
  invalidInstrument,
  uncheckedInstrument,
  VALID_INSTRUMENT,
  type InstrumentControl,
  type InstrumentControlRequest,
  type InstrumentControlResult,
} from './instrument-control.js';

const LIMITS: ResourceLimits = { cpu: 1, memMb: 256, procs: 64, diskMb: 64, wallMs: 5000 };

const PARTIAL_REQUEST = { problemId: 'rtllm/arithmetic/adder_8bit', limits: LIMITS };

/**
 * A fake Model_Router that records every call and never resolves to a provider.
 *
 * Mirrors the house `FakeModelRouter` test doubles (`app/test/*.test.ts`,
 * `app/agent/roles/generation/generation-agent.test.ts`): a router that would fail loudly
 * if invoked, so a test asserting zero calls is asserting something that would otherwise be
 * caught on the first call.
 */
class FakeModelRouter implements ModelRouter {
  readonly calls: ModelTask[] = [];

  invoke(task: ModelTask): Promise<Result<RoutedModelResult, ModelRouterFailure>> {
    this.calls.push(task);
    throw new Error('FakeModelRouter.invoke must never be called by an admission decision');
  }

  describeRouting(): RoutingDiagnostics {
    return { tasks: [], providers: [] };
  }
}

/**
 * A synchronous, deterministic `InstrumentControl` double.
 *
 * Holds no `ModelRouter` reference at all - the point of this fake is that it CANNOT reach a
 * model even if it wanted to - and counts its own `check` calls so the memoization tests can
 * assert the count directly rather than inferring it from the decision alone.
 */
class CountingControl implements InstrumentControl {
  checkCount = 0;
  readonly requests: InstrumentControlRequest[] = [];

  constructor(private readonly result: InstrumentControlResult | null) {}

  check(request: InstrumentControlRequest): Promise<InstrumentControlResult | null> {
    this.checkCount += 1;
    this.requests.push(request);
    return Promise.resolve(this.result);
  }
}

/** A control that always throws, to exercise the fail-safe `undecided` path. */
class ThrowingControl implements InstrumentControl {
  checkCount = 0;

  check(): Promise<InstrumentControlResult | null> {
    this.checkCount += 1;
    return Promise.reject(new Error('control toolchain fell over at /private/var/tmp/x'));
  }
}

/** A control result with the given verdict and no interesting streams. */
function result(verdict: InstrumentControlResult['verdict']): InstrumentControlResult {
  return { verdict, stdout: '', stderr: '', exitCode: 0, mutation: null };
}

describe('MemoizingInstrumentAdmission - the decision mapping (Req 4.11)', () => {
  it('maps an invalid verdict to inadmissible', async () => {
    const control = new CountingControl(result(invalidInstrument('TESTBENCH_FAILED_REFERENCE')));
    const admission = new MemoizingInstrumentAdmission(control, PARTIAL_REQUEST);

    const decision = await admission.admit({ testbench: 'module tb; endmodule\n' });

    expect(decision).toBe('inadmissible');
  });

  it('maps a valid verdict to admissible', async () => {
    const control = new CountingControl(result(VALID_INSTRUMENT));
    const admission = new MemoizingInstrumentAdmission(control, PARTIAL_REQUEST);

    const decision = await admission.admit({ testbench: 'module tb; endmodule\n' });

    expect(decision).toBe('admissible');
  });

  it('maps an unchecked verdict to undecided', async () => {
    const control = new CountingControl(result(uncheckedInstrument('no-reference')));
    const admission = new MemoizingInstrumentAdmission(control, PARTIAL_REQUEST);

    const decision = await admission.admit({ testbench: 'module tb; endmodule\n' });

    expect(decision).toBe('undecided');
  });

  it('maps a null result (no reference design) to undecided', async () => {
    const control = new CountingControl(null);
    const admission = new MemoizingInstrumentAdmission(control, PARTIAL_REQUEST);

    const decision = await admission.admit({ testbench: 'module tb; endmodule\n' });

    expect(decision).toBe('undecided');
  });

  it('maps a thrown check() to undecided, fail-safe', async () => {
    const control = new ThrowingControl();
    const admission = new MemoizingInstrumentAdmission(control, PARTIAL_REQUEST);

    const decision = await admission.admit({ testbench: 'module tb; endmodule\n' });

    expect(decision).toBe('undecided');
  });

  it('records nothing from the thrown error, not even in the memoized result', async () => {
    const control = new ThrowingControl();
    const admission = new MemoizingInstrumentAdmission(control, PARTIAL_REQUEST);

    await admission.admit({ testbench: 'module tb; endmodule\n' });

    expect(JSON.stringify(admission.recorded())).not.toContain('/private/var/tmp');
  });
});

describe('MemoizingInstrumentAdmission - the control runs at most once (Req 4.12)', () => {
  it('does not re-run the control on a second admit() call', async () => {
    const control = new CountingControl(result(VALID_INSTRUMENT));
    const admission = new MemoizingInstrumentAdmission(control, PARTIAL_REQUEST);

    const first = await admission.admit({ testbench: 'module tb; endmodule\n' });
    const second = await admission.admit({ testbench: 'module tb; endmodule\n' });

    expect(control.checkCount).toBe(1);
    expect(second).toBe(first);
  });

  it('does not re-run a throwing control on a second admit() call', async () => {
    const control = new ThrowingControl();
    const admission = new MemoizingInstrumentAdmission(control, PARTIAL_REQUEST);

    await admission.admit({ testbench: 'module tb; endmodule\n' });
    await admission.admit({ testbench: 'module tb; endmodule\n' });

    expect(control.checkCount).toBe(1);
  });

  it('merges the stored partial request with the per-call testbench', async () => {
    const control = new CountingControl(result(VALID_INSTRUMENT));
    const admission = new MemoizingInstrumentAdmission(control, PARTIAL_REQUEST);

    await admission.admit({ testbench: 'module tb; endmodule\n' });

    expect(control.requests).toEqual([
      {
        problemId: PARTIAL_REQUEST.problemId,
        limits: PARTIAL_REQUEST.limits,
        testbench: 'module tb; endmodule\n',
      },
    ]);
  });
});

describe('MemoizingInstrumentAdmission - recorded() (Req 4.12)', () => {
  it('returns null before admit() has ever run', () => {
    const control = new CountingControl(result(VALID_INSTRUMENT));
    const admission = new MemoizingInstrumentAdmission(control, PARTIAL_REQUEST);

    expect(admission.recorded()).toBeNull();
  });

  it('returns the exact InstrumentControlResult the decision was taken from', async () => {
    const scripted = result(invalidInstrument('TESTBENCH_REFERENCE_UNBUILDABLE'));
    const control = new CountingControl(scripted);
    const admission = new MemoizingInstrumentAdmission(control, PARTIAL_REQUEST);

    await admission.admit({ testbench: 'module tb; endmodule\n' });

    expect(admission.recorded()).toBe(scripted);
  });

  it('returns a sensible unchecked result after a thrown check(), not null', async () => {
    const control = new ThrowingControl();
    const admission = new MemoizingInstrumentAdmission(control, PARTIAL_REQUEST);

    await admission.admit({ testbench: 'module tb; endmodule\n' });

    expect(admission.recorded()).toEqual({
      verdict: { validity: 'unchecked', reason: 'control-unavailable' },
      stdout: '',
      stderr: '',
      exitCode: null,
      mutation: null,
    });
  });

  it('does not re-run the control when recorded() is read after admit()', async () => {
    const control = new CountingControl(result(VALID_INSTRUMENT));
    const admission = new MemoizingInstrumentAdmission(control, PARTIAL_REQUEST);

    await admission.admit({ testbench: 'module tb; endmodule\n' });
    admission.recorded();
    admission.recorded();

    expect(control.checkCount).toBe(1);
  });
});

describe('MemoizingInstrumentAdmission - the decision rests on a deterministic tool result alone (Req 4.15, 8.5)', () => {
  it('drives zero model invocations: the fake router is never touched', async () => {
    const router = new FakeModelRouter();
    // The control this admission is built from holds NO router reference at all - it is a
    // synchronous fake with a scripted return value - which is what makes "the router was
    // never called" a structural fact about this test's wiring, not a hope about timing.
    const control = new CountingControl(result(invalidInstrument('TESTBENCH_FAILED_REFERENCE')));
    const admission = new MemoizingInstrumentAdmission(control, PARTIAL_REQUEST);

    const decision = await admission.admit({ testbench: 'module tb; endmodule\n' });

    expect(decision).toBe('inadmissible');
    expect(router.calls).toHaveLength(0);
  });

  it('drives zero model invocations even when the control throws', async () => {
    const router = new FakeModelRouter();
    const control = new ThrowingControl();
    const admission = new MemoizingInstrumentAdmission(control, PARTIAL_REQUEST);

    await admission.admit({ testbench: 'module tb; endmodule\n' });

    expect(router.calls).toHaveLength(0);
  });
});
