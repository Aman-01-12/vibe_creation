// Property 8: Capture-all-or-error (task 3.3).
//
// This is the universal complement to the concrete example checks in
// `app/tools/sandbox/sandbox.test.ts`. It asserts, over many generated
// SandboxJob + RawRunCapture pairs, the capture-all-or-error rule the Tool_Runner
// must never break (Design: Property 8; Req 2.4, 2.5, 2.9):
//
//   1. If the run timed out, was KILLED for exceeding its workspace disk cap, the
//      runtime failed (infraFailure), OR any required output is missing, the whole
//      SandboxResult verdict is `error` - never a partial or functional result.
//   2. Otherwise (all required outputs present, no timeout, no disk-cap kill, no
//      infra failure) the verdict reflects the run: `fail` when the exit code is any
//      other than 0 (including a null exit code), and for a clean exit `pass` only
//      when the captured stdout was COMPLETE - a clean exit on stdout the
//      Tool_Runner had to truncate is `error`, because a bounded prefix cannot
//      establish that nothing failed in the bytes that were dropped.
//   3. `missingRequiredOutputs` is exactly the required outputs not present in the
//      capture, and is empty if and only if every required output was captured.
//   4. The returned SandboxResult always validates against the language-neutral
//      seam contract.
//
// The classification functions are imported through `@app/tools` (which
// re-exports `classifyCapture`, `missingRequiredOutputs`, and
// `validateSandboxResult` from the sandbox package), never from a deep path.
//
// Generators note: the shared `capture-state.ts` fixtures model a primitive,
// structural snapshot (`CaptureState`) that is deliberately decoupled from the
// seam types. The seam here needs the richer `RawRunCapture` shape (separate
// `vcd`/`netlistJson` artifact presence, distinct `timedOut`/`infraFailure`
// signals, and schema-valid artifact/usage records), so this file builds local
// arbitraries that produce contract-valid captures rather than adapting the
// structural fixture.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  classifyCapture,
  missingRequiredOutputs,
  validateSandboxResult,
  type ArtifactBlobRef,
  type DeniedOperation,
  type RawRunCapture,
  type RequiredOutput,
  type ResourceLimits,
  type ResourceUsage,
  type SandboxJob,
  type SourceFile,
} from '@app/tools';
import { propertyParameters, propertyTag } from '@app/test';

const PROPERTY = propertyTag(8, 'Capture-all-or-error');

/** Every required-output kind, so generated jobs draw from the full input space. */
const REQUIRED_OUTPUTS: readonly RequiredOutput[] = [
  'stdout',
  'stderr',
  'exitCode',
  'vcd',
  'netlistJson',
  'formalReport',
  'formalPrepassReport',
  'lintReport',
];

/**
 * The artifact-backed required outputs; their presence is tracked in the map.
 *
 * Every member of the union that the map carries belongs here, not only the ones
 * that existed when this test was written: a new member left out of the generator
 * makes the property VACUOUS for it while the suite stays green.
 */
const ARTIFACT_OUTPUTS: readonly RequiredOutput[] = [
  'vcd',
  'netlistJson',
  'formalReport',
  'formalPrepassReport',
  'lintReport',
];

// -- Independent oracle -----------------------------------------------------

/**
 * Whether a required output is present in the capture, computed independently
 * from the requirement text (stream/exit-code null-checks, artifact key
 * presence). This is the test's own characterization of "captured"; the property
 * asserts the runner's classification agrees with it.
 */
function outputPresent(output: RequiredOutput, capture: RawRunCapture): boolean {
  switch (output) {
    case 'stdout':
      return capture.stdout !== null;
    case 'stderr':
      return capture.stderr !== null;
    case 'exitCode':
      return capture.exitCode !== null;
    case 'vcd':
    case 'netlistJson':
    case 'formalReport':
    case 'formalPrepassReport':
    case 'lintReport':
      return Object.prototype.hasOwnProperty.call(capture.artifacts, output);
    default: {
      const unreachable: never = output;
      return unreachable;
    }
  }
}

/** The required outputs the capture did not produce, in the required-list order. */
function expectedMissing(job: SandboxJob, capture: RawRunCapture): RequiredOutput[] {
  return job.requiredOutputs.filter((output) => !outputPresent(output, capture));
}

/**
 * The verdict a fully captured, non-timeout, non-infra, NON-DISK-KILLED run must
 * receive, computed independently of the implementation.
 *
 * A non-zero exit is a functional `fail` and outranks truncation, because a
 * definite failure is the stronger fact. A clean exit passes only when nothing was
 * dropped from stdout; truncated output means the run's evidence is incomplete, and
 * incomplete evidence is `error`, never `pass`.
 *
 * PRECONDITION: `capture.diskLimitExceeded === false`. A disk-killed run has no
 * "exit to reflect" - the exit code it carries is the worker's own kill sentinel -
 * so reading it here would turn our resource decision into a functional verdict on
 * the design. Both callers below establish that precondition, one by the
 * `mustError` guard and one by construction.
 */
function expectedCompleteRunVerdict(capture: RawRunCapture): 'pass' | 'fail' | 'error' {
  if (capture.exitCode !== 0) {
    return 'fail';
  }
  return capture.stdoutTruncated ? 'error' : 'pass';
}

// -- Generators -------------------------------------------------------------

/** A lowercase-hex SHA-256 exactly 64 chars long, matching the seam schema pattern. */
const sha256Arbitrary: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...'0123456789abcdef'.split('')), { minLength: 64, maxLength: 64 })
  .map((chars) => chars.join(''));

/** A schema-valid artifact blob reference. */
function artifactBlobRefArbitrary(): fc.Arbitrary<ArtifactBlobRef> {
  return fc.record({
    name: fc.string({ minLength: 1, maxLength: 16 }),
    sizeBytes: fc.nat({ max: 1_048_576 }),
    sha256: sha256Arbitrary,
  });
}

/**
 * A captured-artifacts map keyed only by known artifact names, so every
 * artifact-backed required output is independently present or absent across runs.
 *
 * Every member of `ARTIFACT_OUTPUTS` appears here plus one name (`coverage`) that is
 * not a required output at all, so a present-but-irrelevant artifact is generated
 * too. A member left out would never be generated as PRESENT, which would leave the
 * non-error branch unreachable for jobs requiring it.
 */
function artifactsArbitrary(): fc.Arbitrary<Readonly<Record<string, ArtifactBlobRef>>> {
  return fc.dictionary(
    fc.constantFrom(...ARTIFACT_OUTPUTS, 'coverage'),
    artifactBlobRefArbitrary(),
    { maxKeys: ARTIFACT_OUTPUTS.length + 1 },
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

/** Valid, positive per-invocation resource limits. */
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

/**
 * A SandboxJob with a unique subset of required outputs (possibly empty).
 *
 * `synthesize` and `lint` each now REQUIRE their own payload at the seam (SGT-Q03, SGT-Q04), so a
 * job of that kind attaches it here - otherwise this generator would build a job the contract now
 * rejects, which `gotcha-ajv-strictrequired-refuses-required-in-a-then-branch.md` names as exactly
 * the kind of site `tsc` cannot catch.
 */
function jobArbitrary(): fc.Arbitrary<SandboxJob> {
  return fc
    .record({
      kind: fc.constantFrom('simulate', 'synthesize', 'lint'),
      workspaceFiles: fc.array(sourceFileArbitrary(), { maxLength: 3 }),
      limits: limitsArbitrary(),
      requiredOutputs: fc.uniqueArray(fc.constantFrom(...REQUIRED_OUTPUTS), {
        maxLength: REQUIRED_OUTPUTS.length,
      }),
    })
    .map((base): SandboxJob => {
      if (base.kind === 'synthesize') {
        return { ...base, synthesize: { topModule: 'top', schematic: false } };
      }
      if (base.kind === 'lint') {
        return { ...base, lint: { topModule: 'top' } };
      }
      return base;
    });
}

/**
 * A fully general RawRunCapture: every field is free to be present or missing, so
 * the pair spans complete captures, partial captures, timeouts, disk-cap kills, and
 * infra failures.
 *
 * `diskLimitExceeded` is GENERATED, never pinned: this is the space the
 * error-classification property quantifies over, so pinning it would leave that
 * property unable to see the signal and would make it weaker than it was before the
 * field existed.
 */
function captureArbitrary(): fc.Arbitrary<RawRunCapture> {
  return fc.record({
    timedOut: fc.boolean(),
    infraFailure: fc.boolean(),
    exitCode: fc.option(fc.integer(), { nil: null }),
    stdout: fc.option(fc.string({ maxLength: 64 }), { nil: null }),
    stderr: fc.option(fc.string({ maxLength: 64 }), { nil: null }),
    stdoutTruncated: fc.boolean(),
    stderrTruncated: fc.boolean(),
    diskLimitExceeded: fc.boolean(),
    artifacts: artifactsArbitrary(),
    deniedOperations: fc.array(deniedOperationArbitrary(), { maxLength: 3 }),
    resourceUsage: resourceUsageArbitrary(),
  });
}

/** A job paired with a fully general capture. */
function jobAndCaptureArbitrary(): fc.Arbitrary<{ job: SandboxJob; capture: RawRunCapture }> {
  return fc.record({ job: jobArbitrary(), capture: captureArbitrary() });
}

/**
 * A capture that is complete by construction AND that ran to its own end: not timed
 * out, not killed for disk, no infra failure, every stream and exit code present,
 * and every artifact output present. Any required-output subset is therefore fully
 * captured, isolating the "reflect the run" branch. The exit code is biased toward 0
 * so both pass and fail arise.
 *
 * `diskLimitExceeded` is pinned `false` here for the same reason `timedOut` is, and
 * not to dodge the new field: this arbitrary exists to isolate the branch where the
 * verdict REFLECTS THE PROCESS EXIT, and a run the worker killed has no meaningful
 * exit to reflect (the code it carries is our own sentinel). The disk-killed half of
 * the space is covered by the fully general `captureArbitrary` above and by the
 * dedicated facet below, which builds on this same arbitrary with the flag set.
 */
function completeCaptureArbitrary(): fc.Arbitrary<RawRunCapture> {
  // One blob per artifact-backed required output, derived FROM `ARTIFACT_OUTPUTS`
  // rather than listed by hand, so a new member cannot leave this arbitrary claiming
  // a completeness it no longer has - which would fail the callers' own guard.
  const everyArtifact = fc.record(
    Object.fromEntries(ARTIFACT_OUTPUTS.map((name) => [name, artifactBlobRefArbitrary()])),
  );
  return fc.record({
    timedOut: fc.constant(false),
    infraFailure: fc.constant(false),
    exitCode: fc.oneof(fc.constant(0), fc.integer()),
    stdout: fc.string({ maxLength: 64 }),
    stderr: fc.string({ maxLength: 64 }),
    // Complete CAPTURE, not necessarily complete OUTPUT: every required output is
    // present, and truncation is generated freely so the "reflect the run" branch
    // is asserted for bounded captures too.
    stdoutTruncated: fc.boolean(),
    stderrTruncated: fc.boolean(),
    diskLimitExceeded: fc.constant(false),
    artifacts: everyArtifact,
    deniedOperations: fc.array(deniedOperationArbitrary(), { maxLength: 2 }),
    resourceUsage: resourceUsageArbitrary(),
  });
}

// -- Properties -------------------------------------------------------------

describe(PROPERTY, () => {
  it('classifies error on timeout, infra failure, or any missing required output, else reflects the exit', () => {
    fc.assert(
      fc.property(jobAndCaptureArbitrary(), ({ job, capture }) => {
        const missing = expectedMissing(job, capture);
        const mustError =
          capture.timedOut ||
          capture.diskLimitExceeded ||
          capture.infraFailure ||
          missing.length > 0;

        const result = classifyCapture(job, capture);

        if (mustError) {
          expect(result.verdict).toBe('error');
        } else {
          expect(result.verdict).toBe(expectedCompleteRunVerdict(capture));
        }
      }),
      propertyParameters(),
    );
  });

  it('reflects the process exit for a fully captured, non-timeout, non-infra run', () => {
    fc.assert(
      fc.property(jobArbitrary(), completeCaptureArbitrary(), (job, capture) => {
        // Guard the isolating precondition rather than assuming it.
        expect(missingRequiredOutputs(job.requiredOutputs, capture)).toEqual([]);

        const result = classifyCapture(job, capture);

        expect(result.verdict).toBe(expectedCompleteRunVerdict(capture));
      }),
      propertyParameters(),
    );
  });

  it('never returns pass for a run whose captured stdout was truncated', () => {
    fc.assert(
      fc.property(jobArbitrary(), completeCaptureArbitrary(), (job, baseCapture) => {
        // Every required output is present, so nothing but truncation is at issue.
        const capture: RawRunCapture = { ...baseCapture, stdoutTruncated: true };
        expect(missingRequiredOutputs(job.requiredOutputs, capture)).toEqual([]);

        // A bounded prefix cannot rule out a failure among the discarded bytes, so
        // the run did not establish correctness however clean the prefix looks.
        expect(classifyCapture(job, capture).verdict).not.toBe('pass');
      }),
      propertyParameters(),
    );
  });

  it('never returns pass for a run killed for exceeding its workspace disk cap', () => {
    fc.assert(
      fc.property(jobArbitrary(), completeCaptureArbitrary(), (job, baseCapture) => {
        // Every required output is present and nothing was truncated unless the base
        // capture says so, so the disk-cap kill is the only new fact in play.
        const capture: RawRunCapture = { ...baseCapture, diskLimitExceeded: true };
        expect(missingRequiredOutputs(job.requiredOutputs, capture)).toEqual([]);

        // The run was terminated part-way through its stimulus, so nothing it
        // produced establishes that the design is correct - and the exit code it
        // carries is the worker's own kill sentinel, not the tool's own verdict, so
        // it must not read as a functional result either.
        expect(classifyCapture(job, capture).verdict).toBe('error');
      }),
      propertyParameters(),
    );
  });

  it('carries the truncation and disk-cap flags through to the result unchanged', () => {
    fc.assert(
      fc.property(jobAndCaptureArbitrary(), ({ job, capture }) => {
        const result = classifyCapture(job, capture);

        // The seam must let a caller tell "all of the output" from "some of it",
        // so the flags are reported, never absorbed into the verdict alone.
        expect(result.stdoutTruncated).toBe(capture.stdoutTruncated);
        expect(result.stderrTruncated).toBe(capture.stderrTruncated);
        // Same discipline for the disk cap, and load-bearing for one caller in
        // particular: mutation calibration reads this flag to tell a golden run the
        // worker KILLED from a mutant that failed to build, and a disk kill leaves
        // plausible-looking residue (a real sentinel exit code, a real stderr line)
        // that would otherwise be read as the latter.
        expect(result.diskLimitExceeded).toBe(capture.diskLimitExceeded);
      }),
      propertyParameters(),
    );
  });

  it('missingRequiredOutputs returns exactly the uncaptured required outputs, empty iff all captured', () => {
    fc.assert(
      fc.property(jobAndCaptureArbitrary(), ({ job, capture }) => {
        const actual = missingRequiredOutputs(job.requiredOutputs, capture);
        const expected = expectedMissing(job, capture);

        // Exact set membership and order (the function preserves required order).
        expect(actual).toEqual(expected);

        const allCaptured = job.requiredOutputs.every((output) => outputPresent(output, capture));
        expect(actual.length === 0).toBe(allCaptured);

        // Every reported-missing output really is absent from the capture.
        for (const output of actual) {
          expect(outputPresent(output, capture)).toBe(false);
        }
      }),
      propertyParameters(),
    );
  });

  it('artifact-only requirements force error exactly when the artifact key is absent', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...ARTIFACT_OUTPUTS),
        jobArbitrary(),
        captureArbitrary(),
        (artifact, baseJob, baseCapture) => {
          // Require only the chosen artifact, and neutralize every other error cause
          // so the artifact's presence is the sole determinant of the verdict.
          const job: SandboxJob = { ...baseJob, requiredOutputs: [artifact] };
          const capture: RawRunCapture = {
            ...baseCapture,
            timedOut: false,
            diskLimitExceeded: false,
            infraFailure: false,
          };

          const present = outputPresent(artifact, capture);
          const result = classifyCapture(job, capture);

          if (present) {
            expect(result.verdict).toBe(expectedCompleteRunVerdict(capture));
          } else {
            expect(result.verdict).toBe('error');
          }
        },
      ),
      propertyParameters(),
    );
  });

  it('always returns a SandboxResult that validates against the seam contract', () => {
    fc.assert(
      fc.property(jobAndCaptureArbitrary(), ({ job, capture }) => {
        const result = classifyCapture(job, capture);

        expect(validateSandboxResult(result).ok).toBe(true);
      }),
      propertyParameters(),
    );
  });
});
