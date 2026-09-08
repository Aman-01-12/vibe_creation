// Unit tests for the Live_Run enabled/deferred switch (task 15.6).
//
// These anchor the invariants the universal Property 24 (task 15.7) states over:
//   - exactly one mode, with the deferred arm carrying no compile capability;
//   - deferred never compiles to WASM yet still delivers the backend visualizations
//     (Req 9.7, 9.9);
//   - enabled compiles lazily on first panel use and caches, so the injected port's
//     `compile` runs at most once (Req 9.6);
//   - a Live_Run result is `preview-only` and never the correctness verdict
//     (Req 9.6, 9.8).
//
// The Verilator-to-WASM toolchain is not installed here, so a fake `WasmCompilePort`
// that counts its invocations drives the lazy/cache assertions.

import { describe, expect, it } from 'vitest';

import { err, ok, newUlid, type LabeledArtifact, type Result } from '@app/core';

import {
  decideLiveRun,
  LIVE_RUN_AUTHORITY,
  LIVE_RUN_ERROR_REASONS,
  liveRunError,
  type CompiledLiveModule,
  type EnabledLiveRun,
  type LiveRunCompileRequest,
  type LiveRunError,
  type LiveRunPreview,
  type LiveRunStimulus,
  type WasmCompilePort,
} from './live-run.js';

const REQUEST: LiveRunCompileRequest = {
  rtl: 'module m(input a, output y); endmodule',
  topModule: 'm',
};
const STIMULUS: LiveRunStimulus = { cycles: 2, inputs: { a: 1 } };
const CLOCK_VCD = ['$var wire 1 ! clk $end', '$enddefinitions $end', '#0', '0!', '#5', '1!'].join(
  '\n',
);

function verifiedLabel(): LabeledArtifact {
  return {
    artifactRef: { kind: 'module-version', id: newUlid(), version: 1 },
    tier: 'Verified',
    oracleSpanRef: newUlid(),
  };
}

/** A compiled module whose run always yields a `preview-only` result. */
function fakeCompiledModule(): CompiledLiveModule {
  return {
    run(stimulus: LiveRunStimulus): Result<LiveRunPreview, LiveRunError> {
      return ok({
        authority: LIVE_RUN_AUTHORITY,
        signals: [{ name: 'y', values: Array(stimulus.cycles).fill(1) }],
      });
    },
  };
}

/** A fake compile port that counts how many times `compile` is invoked. */
function fakeCompilePort(
  outcome: Result<CompiledLiveModule, LiveRunError> = ok(fakeCompiledModule()),
): { port: WasmCompilePort; calls: () => number } {
  let calls = 0;
  return {
    port: {
      compile(): Promise<Result<CompiledLiveModule, LiveRunError>> {
        calls += 1;
        return Promise.resolve(outcome);
      },
    },
    calls: () => calls,
  };
}

describe('decideLiveRun - exactly one mode (Req 9.8)', () => {
  it('returns the deferred arm with no runLive capability', () => {
    const live = decideLiveRun({ mode: 'deferred' });

    expect(live.mode).toBe('deferred');
    expect('runLive' in live).toBe(false);
  });

  it('returns the enabled arm with a runLive capability', () => {
    const { port } = fakeCompilePort();

    const live = decideLiveRun({ mode: 'enabled', compilePort: port, request: REQUEST });

    expect(live.mode).toBe('enabled');
    expect(typeof (live as EnabledLiveRun).runLive).toBe('function');
  });
});

describe('deferred Live_Run - never compiles, still delivers backend visualizations (Req 9.7, 9.9)', () => {
  it('delivers the backend waveform and schematic without any WASM path', () => {
    const live = decideLiveRun({ mode: 'deferred' });

    const delivery = live.deliverBackendVisualizations(
      { state: 'ready', vcd: CLOCK_VCD, sourceLabel: verifiedLabel() },
      { state: 'unavailable' },
    );

    expect(delivery.waveform.phase).toBe('available');
    expect(delivery.schematic.phase).toBe('unavailable');
  });
});

describe('enabled Live_Run - lazy compile-once and cache (Req 9.6)', () => {
  it('does not compile until the first panel use', () => {
    const { port, calls } = fakeCompilePort();

    decideLiveRun({ mode: 'enabled', compilePort: port, request: REQUEST });

    expect(calls()).toBe(0);
  });

  it('compiles at most once across repeated runLive calls', async () => {
    const { port, calls } = fakeCompilePort();
    const live = decideLiveRun({
      mode: 'enabled',
      compilePort: port,
      request: REQUEST,
    }) as EnabledLiveRun;

    await live.runLive(STIMULUS);
    await live.runLive(STIMULUS);
    await live.runLive(STIMULUS);

    expect(calls()).toBe(1);
  });

  it('shares a single in-flight compile across concurrent first calls', async () => {
    const { port, calls } = fakeCompilePort();
    const live = decideLiveRun({
      mode: 'enabled',
      compilePort: port,
      request: REQUEST,
    }) as EnabledLiveRun;

    await Promise.all([live.runLive(STIMULUS), live.runLive(STIMULUS), live.runLive(STIMULUS)]);

    expect(calls()).toBe(1);
  });

  it('still delivers the backend visualizations independently of the live panel', () => {
    const { port } = fakeCompilePort();
    const live = decideLiveRun({ mode: 'enabled', compilePort: port, request: REQUEST });

    const delivery = live.deliverBackendVisualizations(
      { state: 'ready', vcd: CLOCK_VCD, sourceLabel: verifiedLabel() },
      { state: 'pending' },
    );

    expect(delivery.waveform.phase).toBe('available');
    expect(delivery.schematic.phase).toBe('pending');
  });
});

describe('enabled Live_Run - result is a preview, never the verdict (Req 9.6, 9.8)', () => {
  it('returns a preview-only result on success', async () => {
    const { port } = fakeCompilePort();
    const live = decideLiveRun({
      mode: 'enabled',
      compilePort: port,
      request: REQUEST,
    }) as EnabledLiveRun;

    const result = await live.runLive(STIMULUS);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.authority).toBe(LIVE_RUN_AUTHORITY);
      expect(result.value.authority).not.toBe('verdict');
    }
  });
});

describe('enabled Live_Run - sanitized, fail-safe errors', () => {
  it('surfaces a sanitized compile error and does not recompile on retry', async () => {
    const { port, calls } = fakeCompilePort(err(liveRunError('compile-failed')));
    const live = decideLiveRun({
      mode: 'enabled',
      compilePort: port,
      request: REQUEST,
    }) as EnabledLiveRun;

    const first = await live.runLive(STIMULUS);
    const second = await live.runLive(STIMULUS);

    expect(first.ok).toBe(false);
    expect(second.ok).toBe(false);
    if (!first.ok) {
      expect(first.error.code).toBe('compile-failed');
      expect(first.error.reason).toBe(LIVE_RUN_ERROR_REASONS['compile-failed']);
    }
    expect(calls()).toBe(1);
  });

  it('surfaces a sanitized run error from the compiled module', async () => {
    const failingModule: CompiledLiveModule = {
      run(): Result<LiveRunPreview, LiveRunError> {
        return err(liveRunError('run-failed'));
      },
    };
    const { port } = fakeCompilePort(ok(failingModule));
    const live = decideLiveRun({
      mode: 'enabled',
      compilePort: port,
      request: REQUEST,
    }) as EnabledLiveRun;

    const result = await live.runLive(STIMULUS);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('run-failed');
      expect(result.error.reason).toBe(LIVE_RUN_ERROR_REASONS['run-failed']);
    }
  });
});
