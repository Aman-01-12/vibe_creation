// Property 10: Oracle results are reproducible (task 3.6).
//
// SCOPE - LOGIC-LEVEL REPRODUCIBILITY ONLY (read before extending this file):
//   This property covers the deterministic INTERPRETATION half of Req 2.8 /
//   15.10: that the Simulator adapter turns a given run capture into a
//   `SimulationVerdict` as a pure, referentially transparent function, so the
//   same inputs always yield an identical verdict, checks, waveform ref, and exit
//   code. The Simulator here is MOCKED: a deterministic `FakeSandboxRuntime`
//   returns the same `RawRunCapture` for a job, standing in for a real run.
//
//   Real-oracle determinism - the SAME design + testbench compiled and simulated
//   TWICE through the real `iverilog` + `vvp` sandbox producing an identical
//   verdict - is deliberately NOT asserted here. It is covered by the real
//   Icarus oracle-path integration test (task 3.8) and the Eval_Harness fixed-seed
//   pass@k reproducibility check (task 19.4, Req 15.10). Property 10 is therefore
//   split: this file pins the interpretation logic (mock-driven), and 3.8 / 19.4
//   pin the real-tool determinism, so the property is non-vacuous end to end
//   rather than a mock-only assertion.
//
// WHAT THIS FILE ASSERTS, over many generated captures/results:
//   1. `interpretSandboxResult` is pure and idempotent: the same `SandboxResult`
//      (and a distinct-but-equal deep clone of it) always maps to a deep-equal
//      `SimulationVerdict`, and the input is never mutated.
//   2. A `Simulator` backed by a deterministic fake runtime yields identical
//      `SimulationVerdict`s across two `simulate` invocations for the same
//      (rtl, testbench, limits) - the adapter/interpretation path carries no
//      hidden nondeterminism (no clock, randomness, or retained state).
//   3. Two independent `Simulator` instances driven by distinct-but-equal-valued
//      captures agree, so the verdict is a function of the capture VALUE alone,
//      not of object identity or per-instance state.
//
// Generators mirror the contract-valid patterns from the sibling Property 8 test
// (`sandbox-capture-all-or-error.property.test.ts`) - shared shape, no import of a
// test file - and additionally emit per-check `CHECK <name> PASS|FAIL` signalling
// lines so the parsed `checks` field is exercised, keeping determinism over
// `checks` non-vacuous. Everything is imported through `@app/tools` and
// `@app/test`, never a deep path.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  FakeSandboxRuntime,
  IcarusSimulatorAdapter,
  SandboxToolRunner,
  interpretSandboxResult,
  type ArtifactBlobRef,
  type DeniedOperation,
  type RawRunCapture,
  type ResourceLimits,
  type ResourceUsage,
  type SandboxResult,
  type SourceFile,
} from '@app/tools';
import { propertyParameters, propertyTag } from '@app/test';

const PROPERTY = propertyTag(10, 'Oracle results are reproducible');

// -- Shared contract-valid building blocks ---------------------------------

/** A lowercase-hex SHA-256 exactly 64 chars long, matching the seam schema pattern. */
const sha256Arbitrary: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...'0123456789abcdef'.split('')), { minLength: 64, maxLength: 64 })
  .map((chars) => chars.join(''));

/** A schema-valid artifact blob reference (non-empty name, non-negative size). */
function artifactBlobRefArbitrary(): fc.Arbitrary<ArtifactBlobRef> {
  return fc.record({
    name: fc.string({ minLength: 1, maxLength: 16 }),
    sizeBytes: fc.nat({ max: 1_048_576 }),
    sha256: sha256Arbitrary,
  });
}

/**
 * A captured-artifacts map keyed only by known artifact names, so the `vcd`
 * waveform the adapter looks for is independently present or absent across runs.
 */
function artifactsArbitrary(): fc.Arbitrary<Readonly<Record<string, ArtifactBlobRef>>> {
  return fc.dictionary(
    fc.constantFrom('vcd', 'netlistJson', 'coverage'),
    artifactBlobRefArbitrary(),
    { maxKeys: 3 },
  );
}

/** A schema-valid resource-usage record (all non-negative). */
function resourceUsageArbitrary(): fc.Arbitrary<ResourceUsage> {
  return fc.record({
    wallMs: fc.double({ min: 0, max: 60_000, noNaN: true }),
    maxMemMb: fc.double({ min: 0, max: 4096, noNaN: true }),
    cpuMs: fc.double({ min: 0, max: 60_000, noNaN: true }),
  });
}

/** A recorded out-of-sandbox denial; `path` is present or omitted, never `undefined`. */
function deniedOperationArbitrary(): fc.Arbitrary<DeniedOperation> {
  const kind = fc.constantFrom('filesystem', 'network', 'process') as fc.Arbitrary<
    DeniedOperation['kind']
  >;
  return fc.oneof(
    fc.record({ kind, detail: fc.string({ maxLength: 32 }) }),
    fc.record({ kind, detail: fc.string({ maxLength: 32 }), path: fc.string({ maxLength: 32 }) }),
  );
}

/** Valid, positive per-invocation resource limits (matches the seam schema). */
function limitsArbitrary(): fc.Arbitrary<ResourceLimits> {
  return fc.record({
    cpu: fc.double({ min: 0.1, max: 8, noNaN: true }),
    memMb: fc.integer({ min: 1, max: 4096 }),
    procs: fc.integer({ min: 1, max: 256 }),
    diskMb: fc.integer({ min: 1, max: 1024 }),
    wallMs: fc.integer({ min: 1, max: 60_000 }),
  });
}

/** A workspace source file with a non-empty relative path. */
function sourceFileArbitrary(): fc.Arbitrary<SourceFile> {
  return fc.record({
    path: fc.string({ minLength: 1, maxLength: 24 }),
    contents: fc.string({ maxLength: 64 }),
  });
}

// -- Per-check signalling in stdout ----------------------------------------

/** A whitespace-free check-name token (`\S+`), traceable to a spec criterion. */
const checkTokenArbitrary: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...'abcdefghijklmnopqrstuvwxyz0123456789_'.split('')), {
    minLength: 1,
    maxLength: 12,
  })
  .map((chars) => chars.join(''));

/** One `CHECK <name> PASS|FAIL` signalling line the adapter parses into a check. */
const checkLineArbitrary: fc.Arbitrary<string> = fc
  .record({ name: checkTokenArbitrary, passed: fc.boolean() })
  .map(({ name, passed }) => `CHECK ${name} ${passed ? 'PASS' : 'FAIL'}`);

/** A non-signal diagnostic line (newlines stripped so it stays a single line). */
const noiseLineArbitrary: fc.Arbitrary<string> = fc
  .string({ maxLength: 32 })
  .map((line) => line.replace(/\n/g, ' '));

/**
 * Standard output mixing per-check signalling lines with diagnostics, so the
 * adapter's parsed `checks` field is populated on non-error runs and determinism
 * over `checks` (not just the verdict) is genuinely exercised.
 */
const stdoutArbitrary: fc.Arbitrary<string> = fc
  .array(
    fc.oneof(
      { arbitrary: checkLineArbitrary, weight: 3 },
      { arbitrary: noiseLineArbitrary, weight: 1 },
    ),
    { maxLength: 6 },
  )
  .map((lines) => lines.join('\n'));

// -- Top-level generators ---------------------------------------------------

/**
 * An arbitrary `SandboxResult` spanning every verdict and both the empty and
 * populated check-signalling cases. This is the direct input to
 * `interpretSandboxResult`, which reads only verdict, `vcd` artifact, streams,
 * exit code, and usage, so no field it consumes is left unexercised.
 */
function sandboxResultArbitrary(): fc.Arbitrary<SandboxResult> {
  return fc.record({
    verdict: fc.constantFrom('pass', 'fail', 'error'),
    exitCode: fc.option(fc.integer(), { nil: null }),
    stdout: stdoutArbitrary,
    stderr: fc.string({ maxLength: 32 }),
    artifacts: artifactsArbitrary(),
    deniedOperations: fc.array(deniedOperationArbitrary(), { maxLength: 3 }),
    resourceUsage: resourceUsageArbitrary(),
  });
}

/**
 * A contract-valid `RawRunCapture` biased toward complete, non-timeout,
 * non-infra runs so the mocked Simulator reaches the `pass`/`fail` (parsed
 * checks) branch as well as the `error` branch. Determinism must hold across all
 * of these, so the bias only broadens branch coverage; it never gates the
 * property.
 */
function simulateCaptureArbitrary(): fc.Arbitrary<RawRunCapture> {
  const mostlyFalse = fc.oneof(
    { arbitrary: fc.constant(false), weight: 4 },
    { arbitrary: fc.constant(true), weight: 1 },
  );
  return fc.record({
    timedOut: mostlyFalse,
    infraFailure: mostlyFalse,
    exitCode: fc.oneof(
      { arbitrary: fc.constant<number | null>(0), weight: 2 },
      { arbitrary: fc.integer(), weight: 2 },
      { arbitrary: fc.constant<number | null>(null), weight: 1 },
    ),
    stdout: fc.oneof(
      { arbitrary: stdoutArbitrary, weight: 4 },
      { arbitrary: fc.constant<string | null>(null), weight: 1 },
    ),
    stderr: fc.option(fc.string({ maxLength: 32 }), { nil: null }),
    artifacts: artifactsArbitrary(),
    deniedOperations: fc.array(deniedOperationArbitrary(), { maxLength: 3 }),
    resourceUsage: resourceUsageArbitrary(),
  });
}

/** One-to-two RTL source files for a simulate job. */
const rtlArbitrary: fc.Arbitrary<readonly SourceFile[]> = fc.array(sourceFileArbitrary(), {
  minLength: 1,
  maxLength: 2,
});

/** Build a mocked Simulator whose fake runtime always reports the given capture. */
function simulatorFor(capture: RawRunCapture): IcarusSimulatorAdapter {
  // A fixed capture makes the fake runtime deterministic: the same job always
  // yields the same RawRunCapture, exactly the reproducibility precondition.
  return new IcarusSimulatorAdapter(new SandboxToolRunner(new FakeSandboxRuntime(capture)));
}

// -- Properties -------------------------------------------------------------

describe(PROPERTY, () => {
  it('interpretSandboxResult is pure: equal inputs map to a deep-equal verdict, input unmutated', () => {
    fc.assert(
      fc.property(sandboxResultArbitrary(), (result) => {
        // A distinct object with identical value: referential transparency must
        // give the same verdict for it as for the original.
        const clone = structuredClone(result);

        const first = interpretSandboxResult(result);
        const again = interpretSandboxResult(result);
        const fromClone = interpretSandboxResult(clone);

        // Idempotent on the same object and referentially transparent on an equal one.
        expect(again).toEqual(first);
        expect(fromClone).toEqual(first);

        // The interpretation never mutates its input.
        expect(result).toEqual(clone);
      }),
      propertyParameters(),
    );
  });

  it('a mocked Simulator yields an identical verdict across two simulate invocations', () => {
    return fc.assert(
      fc.asyncProperty(
        rtlArbitrary,
        sourceFileArbitrary(),
        limitsArbitrary(),
        simulateCaptureArbitrary(),
        async (rtl, testbench, limits, capture) => {
          const simulator = simulatorFor(structuredClone(capture));

          const first = await simulator.simulate(rtl, testbench, limits);
          const second = await simulator.simulate(rtl, testbench, limits);

          // Verdict, checks, vcd ref, exit code, and diagnostics all match.
          expect(second).toEqual(first);
        },
      ),
      propertyParameters(),
    );
  });

  it('two independent Simulators over equal-valued captures agree (verdict depends on value only)', () => {
    return fc.assert(
      fc.asyncProperty(
        rtlArbitrary,
        sourceFileArbitrary(),
        limitsArbitrary(),
        simulateCaptureArbitrary(),
        async (rtl, testbench, limits, capture) => {
          // Distinct capture objects with identical value drive two separate
          // Simulator instances; no shared state can leak between them.
          const simulatorA = simulatorFor(structuredClone(capture));
          const simulatorB = simulatorFor(structuredClone(capture));

          const verdictA = await simulatorA.simulate(rtl, testbench, limits);
          const verdictB = await simulatorB.simulate(rtl, testbench, limits);

          expect(verdictB).toEqual(verdictA);
        },
      ),
      propertyParameters(),
    );
  });
});
