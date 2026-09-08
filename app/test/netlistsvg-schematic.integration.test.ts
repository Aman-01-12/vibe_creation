// netlistsvg schematic-path integration test (task 15.8).
//
// This test exercises the gate/schematic generator END TO END against the REAL
// Yosys + netlistsvg toolchain: it feeds a small, fully synthesizable Verilog
// module through the Synth adapter's real Yosys `write_json` -> netlistsvg path
// and asserts a well-formed `SvgArtifact` is produced (Design: Testing Strategy
// (Integration tests); Req 9.2). A schematic is a `Verified`-only artifact in the
// hero loop, so the representative module stands in for a real verified netlist;
// the adapter never assigns trust, it only renders.
//
// The real-tool harness (capability probe, the "real oracle, local runtime"
// `LocalWorkerRuntime`, and the adapter builders) lives in `./real-oracle-harness`
// so the probe + skip mechanism and the worker runtime are defined once and shared
// with the Icarus oracle-path test (task 3.8) and the Verification_Loop test
// (task 14.2). When `yosys`/`netlistsvg`/the worker Python are absent the
// real-tool suite SKIPS via `describe.skipIf(!SYNTH_PROBE.available)` (surfacing
// the reason), so a toolchain-less CI never fails spuriously and no false
// confidence is created.
//
// The adapter's fail-safe path (Req 9.11) is asserted separately and ALWAYS runs:
// when the schematic tool is absent, fails, or draws nothing, `netlistSvg` returns
// an explicit `UnavailableStatus` with a sanitized reason rather than throwing or
// silently omitting. That portion needs no real tool, keeping the test non-vacuous
// in every environment.

import { describe, expect, it } from 'vitest';

import {
  FakeSandboxRuntime,
  SandboxToolRunner,
  SYNTH_UNAVAILABLE_REASONS,
  YosysNetlistSvgAdapter,
  type ArtifactBlobRef,
  type RawRunCapture,
  type ResourceLimits,
  type ResourceUsage,
  type SourceFile,
  type SvgArtifact,
  type UnavailableStatus,
} from '@app/tools';

import { SCHEMATIC_RTL, SYNTH_PROBE, realSynthAdapter } from './real-oracle-harness.js';

if (!SYNTH_PROBE.available) {
  // A single, clear note that the real schematic path was NOT exercised here: the
  // Yosys `write_json` -> netlistsvg adapter is wired and logic-tested, but
  // unvalidated against the real toolchain in this environment.
  console.warn(
    `[netlistsvg-schematic.integration] Real schematic path NOT exercised: ${SYNTH_PROBE.reason}. ` +
      'yosys/netlistsvg (and the worker Python) are unavailable, so the SvgArtifact ' +
      'assertion is SKIPPED in this environment; the fail-safe assertion still runs.',
  );
}

// -- Harness ----------------------------------------------------------------

/** Generous real-run caps: local process startup plus a real yosys + netlistsvg run. */
const REAL_LIMITS: ResourceLimits = { cpu: 1, memMb: 512, procs: 128, diskMb: 128, wallMs: 30_000 };

/** The representative synthesizable module, written as the sole workspace source. */
const SCHEMATIC_SOURCE: SourceFile = { path: 'gate_demo.v', contents: SCHEMATIC_RTL };

/** Per-run timeout for a single real synthesize-and-render (ms). */
const RUN_TIMEOUT = 60_000;

/** Zeroed usage for the scripted fail-safe captures (no real run occurred). */
const ZERO_USAGE: ResourceUsage = { wallMs: 0, maxMemMb: 0, cpuMs: 0 };

/** A fully captured netlist JSON reference, present whenever synthesis got that far. */
const NETLIST_ARTIFACT: ArtifactBlobRef = {
  name: 'netlist.json',
  sizeBytes: 512,
  sha256: 'a'.repeat(64),
};

/** Lowercase-hex SHA-256 shape a well-formed blob reference must carry. */
const SHA256_HEX = /^[0-9a-f]{64}$/;

/**
 * Assert an artifact blob reference is well-formed: a non-empty logical name, a
 * non-negative size, and a lowercase-hex SHA-256 digest.
 */
function assertWellFormedBlob(ref: ArtifactBlobRef): void {
  expect(ref.name.length).toBeGreaterThan(0);
  expect(ref.sizeBytes).toBeGreaterThanOrEqual(0);
  expect(ref.sha256).toMatch(SHA256_HEX);
}

/**
 * A scripted raw capture for the fail-safe scenarios, defaulting to a clean run
 * that produced a netlist JSON. Override fields to model each failure mode.
 */
function capture(overrides: Partial<RawRunCapture> = {}): RawRunCapture {
  return {
    timedOut: false,
    infraFailure: false,
    exitCode: 0,
    stdout: '',
    stderr: '',
    stdoutTruncated: false,
    stderrTruncated: false,
    diskLimitExceeded: false,
    artifacts: { netlistJson: NETLIST_ARTIFACT },
    deniedOperations: [],
    resourceUsage: ZERO_USAGE,
    ...overrides,
  };
}

/** Drive the Synth adapter over a real `SandboxToolRunner` backed by a scripted fake. */
function synthesizeWith(rawCapture: RawRunCapture): Promise<SvgArtifact | UnavailableStatus> {
  const runner = new SandboxToolRunner(new FakeSandboxRuntime(rawCapture));
  return new YosysNetlistSvgAdapter(runner).netlistSvg([SCHEMATIC_SOURCE], REAL_LIMITS);
}

/** Narrow an outcome to `UnavailableStatus`, failing the test if it is available. */
function expectUnavailable(outcome: SvgArtifact | UnavailableStatus): UnavailableStatus {
  expect(outcome.status).toBe('unavailable');
  if (outcome.status !== 'unavailable') {
    throw new Error('expected an unavailable status');
  }
  return outcome;
}

// -- Tests ------------------------------------------------------------------

describe('netlistsvg real-tool capability probe', () => {
  it('documents whether the real schematic path was exercised in this environment', () => {
    // Always runs; asserts the probe is well-formed and, on skip, that the note
    // above has already recorded the real path was not exercised.
    expect(typeof SYNTH_PROBE.available).toBe('boolean');
    expect(SYNTH_PROBE.reason.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!SYNTH_PROBE.available)(
  'Yosys write_json -> netlistsvg real path (yosys + netlistsvg, local runtime; Req 9.2)',
  () => {
    it(
      'produces a well-formed SvgArtifact from a real synthesized netlist',
      async () => {
        const outcome = await realSynthAdapter(SYNTH_PROBE.pythonBin).netlistSvg(
          [SCHEMATIC_SOURCE],
          REAL_LIMITS,
        );

        expect(outcome.status).toBe('available');
        if (outcome.status !== 'available') return;

        // The rendered schematic SVG and the Yosys netlist it was drawn from are
        // both real, non-empty artifacts with valid blob references.
        assertWellFormedBlob(outcome.svg);
        assertWellFormedBlob(outcome.netlistJson);
        expect(outcome.svg.sizeBytes).toBeGreaterThan(0);
        expect(outcome.netlistJson.sizeBytes).toBeGreaterThan(0);
      },
      RUN_TIMEOUT,
    );
  },
);

describe('Synth adapter fail-safe path (tool absent/fails -> sanitized unavailable; Req 9.11)', () => {
  // These run in every environment (no real tool needed): they drive the adapter
  // over a real SandboxToolRunner whose runtime is scripted to model each failure
  // mode, and assert the fail-safe contract - an explicit, sanitized unavailable
  // status, never a throw and never a silent omission.

  it('degrades to a sanitized unavailable when the run times out', async () => {
    const outcome = expectUnavailable(
      await synthesizeWith(capture({ timedOut: true, artifacts: {} })),
    );
    expect(outcome.cause).toBe('synthesis-error');
    expect(outcome.reason).toBe(SYNTH_UNAVAILABLE_REASONS['synthesis-error']);
  });

  it('degrades to a sanitized unavailable on an infrastructure failure', async () => {
    const outcome = expectUnavailable(
      await synthesizeWith(capture({ infraFailure: true, exitCode: null, artifacts: {} })),
    );
    expect(outcome.cause).toBe('synthesis-error');
  });

  it('degrades to a sanitized unavailable when the required netlist JSON is missing', async () => {
    // A missing required output forces the sandbox to classify the run `error`.
    const outcome = expectUnavailable(await synthesizeWith(capture({ artifacts: {} })));
    expect(outcome.cause).toBe('synthesis-error');
  });

  it('degrades to a sanitized unavailable when the toolchain exits non-zero', async () => {
    const outcome = expectUnavailable(await synthesizeWith(capture({ exitCode: 2 })));
    expect(outcome.cause).toBe('synthesis-failed');
    expect(outcome.reason).toBe(SYNTH_UNAVAILABLE_REASONS['synthesis-failed']);
  });

  it('degrades to no-schematic when a clean run drew no diagram', async () => {
    // netlistsvg can decline to draw while the run still exits cleanly.
    const outcome = expectUnavailable(await synthesizeWith(capture()));
    expect(outcome.cause).toBe('no-schematic');
    expect(outcome.reason).toBe(SYNTH_UNAVAILABLE_REASONS['no-schematic']);
  });

  it('never leaks paths, URLs, or stack-trace shapes in any unavailable reason', async () => {
    const outcome = expectUnavailable(
      await synthesizeWith(capture({ timedOut: true, artifacts: {} })),
    );
    expect(outcome.reason).not.toMatch(/\//);
    expect(outcome.reason).not.toMatch(/https?:/i);
    expect(outcome.reason).not.toMatch(/\bat\s+\w+.*:\d+/);
  });
});
