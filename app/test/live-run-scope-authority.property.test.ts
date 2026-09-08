// Property 24 for the Live_Run enabled/deferred switch: live-run is exactly
// enabled or deferred and never the verdict (task 15.7).
//
// This is the universal complement to the worked examples in
// `app/web/live-run/live-run.test.ts` (which this file does not duplicate). Over
// arbitrary slice configurations and arbitrary backend visualization sources it
// pins the four guarantees the design binds to Property 24:
//
//   - Exactly one mode (Req 9.8): `decideLiveRun` yields a value whose `mode` is
//     `enabled` XOR `deferred` - never both, never neither - and the `runLive`
//     capability is present if and only if the mode is `enabled`.
//   - Deferred never compiles to WASM (Req 9.9): the deferred arm carries no
//     compile port, so the injected, invocation-counting port is never reached;
//     the backend Waveform and Schematic_View are still delivered on both arms.
//   - Enabled compiles lazily and at most once (Req 9.6): the injected port's
//     `compile` is not called until the first `runLive`, and is invoked at most
//     once across any number of repeated or concurrent `runLive` calls. The
//     expected compile count is derived independently from the run count.
//   - Never the verdict (Req 9.6, 9.8): every produced `LiveRunPreview` carries
//     the closed literal `authority` of `preview-only` and exposes no field that
//     could be read as a `Verdict` or `TrustTier`.
//
// The Verilator-to-WASM toolchain is not installed here, so a fake
// `WasmCompilePort` that counts its invocations drives the lazy/cache assertions,
// exactly as the sibling unit test does.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  err,
  notApplicable,
  ok,
  unverified,
  type ArtifactKind,
  type ArtifactRef,
  type LabeledArtifact,
  type Result,
  type Ulid,
} from '@app/core';
import {
  decideLiveRun,
  liveRunError,
  LIVE_RUN_AUTHORITY,
  type CompiledLiveModule,
  type EnabledLiveRun,
  type LiveRunCompileRequest,
  type LiveRunConfig,
  type LiveRunError,
  type LiveRunPreview,
  type LiveRunStimulus,
  type SchematicArtifactRef,
  type SchematicSource,
  type WaveformSource,
  type WasmCompilePort,
} from '@app/web';
import { propertyParameters, propertyTag } from '@app/test';

const PROPERTY = propertyTag(24, 'Live-run is exactly enabled or deferred and never the verdict');

// --- ULID / artifact generators (mirrors the sibling Property 3 generators) --

/** Crockford base32 (no I, L, O, U): the ULID alphabet. */
const CROCKFORD: readonly string[] = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'.split('');

/** The artifact kinds a visualization source label can be derived from. */
const ARTIFACT_KINDS = [
  'module-version',
  'verification-result',
  'waveform',
  'schematic',
] as const satisfies readonly ArtifactKind[];

/** An arbitrary string of length `[min, max]` drawn from an explicit alphabet. */
function fromChars(chars: readonly string[], min: number, max: number): fc.Arbitrary<string> {
  const [first, ...rest] = chars;
  if (first === undefined) {
    throw new Error('fromChars requires a non-empty character set');
  }
  return fc
    .array(fc.constantFrom(first, ...rest), { minLength: min, maxLength: max })
    .map((picked) => picked.join(''));
}

/**
 * A syntactically valid ULID. The leading character is constrained to `0`-`7`
 * so the encoded timestamp never overflows the 48-bit ULID time field.
 */
function ulidArbitrary(): fc.Arbitrary<Ulid> {
  return fc
    .tuple(fc.constantFrom('0', '1', '2', '3', '4', '5', '6', '7'), fromChars(CROCKFORD, 25, 25))
    .map(([head, rest]) => `${head}${rest}`);
}

/** An artifact reference over any source kind, at any positive version. */
function artifactRefArbitrary(): fc.Arbitrary<ArtifactRef> {
  return fc.record({
    kind: fc.constantFrom(...ARTIFACT_KINDS),
    id: ulidArbitrary(),
    version: fc.integer({ min: 1, max: 100_000 }),
  });
}

/** A labeled source artifact (Unverified or Not_Applicable) for a visualization. */
function labeledArtifactArbitrary(): fc.Arbitrary<LabeledArtifact> {
  return fc.oneof(
    artifactRefArbitrary().map(unverified),
    artifactRefArbitrary().map(notApplicable),
  );
}

// --- Backend visualization source generators ---------------------------------

/** A syntactically valid single-signal VCD the transform can parse successfully. */
const VALID_VCD = ['$var wire 1 ! clk $end', '$enddefinitions $end', '#0', '0!', '#5', '1!'].join(
  '\n',
);

/** An arbitrary waveform source across all three delivery states. */
function waveformSourceArbitrary(): fc.Arbitrary<WaveformSource> {
  return fc.oneof(
    fc.constant<WaveformSource>({ state: 'pending' }),
    fc.constant<WaveformSource>({ state: 'unavailable' }),
    fc
      .record({
        vcd: fc.oneof(fc.constant(VALID_VCD), fc.string({ unit: 'grapheme' })),
        sourceLabel: labeledArtifactArbitrary(),
      })
      .map(
        ({ vcd, sourceLabel }) => ({ state: 'ready', vcd, sourceLabel }) satisfies WaveformSource,
      ),
  );
}

/** A rendered-SVG reference of any size (spanning the drill-down threshold). */
function svgRefArbitrary(): fc.Arbitrary<SchematicArtifactRef> {
  return fc.record({
    name: fc.string({ unit: 'grapheme' }),
    sizeBytes: fc.integer({ min: 0, max: 1_048_576 }),
    sha256: fromChars('0123456789abcdef'.split(''), 64, 64),
  });
}

/** An arbitrary schematic source across all three delivery states. */
function schematicSourceArbitrary(): fc.Arbitrary<SchematicSource> {
  return fc.oneof(
    fc.constant<SchematicSource>({ state: 'pending' }),
    fc.constant<SchematicSource>({ state: 'unavailable' }),
    fc
      .record({ svgRef: svgRefArbitrary(), sourceLabel: labeledArtifactArbitrary() })
      .map(
        ({ svgRef, sourceLabel }) =>
          ({ state: 'ready', svgRef, sourceLabel }) satisfies SchematicSource,
      ),
  );
}

// --- Fake, invocation-counting compile port ----------------------------------

/** A fake compile port plus a read-only view of how many times it was invoked. */
interface CountingCompilePort {
  readonly port: WasmCompilePort;
  readonly calls: () => number;
}

/**
 * Build a fake `WasmCompilePort` that counts invocations of `compile`.
 *
 * `compileOk` decides whether compilation succeeds; when it does, `runOk` decides
 * whether the compiled module's `run` yields a `preview-only` result or a
 * sanitized run failure. Every success is `preview-only`, never a verdict.
 */
function countingCompilePort(compileOk: boolean, runOk: boolean): CountingCompilePort {
  let calls = 0;

  const compiledModule: CompiledLiveModule = {
    run(stimulus: LiveRunStimulus): Result<LiveRunPreview, LiveRunError> {
      if (!runOk) {
        return err(liveRunError('run-failed'));
      }
      return ok({
        authority: LIVE_RUN_AUTHORITY,
        signals: [{ name: 'y', values: Array<number>(stimulus.cycles).fill(1) }],
      });
    },
  };

  const outcome: Result<CompiledLiveModule, LiveRunError> = compileOk
    ? ok(compiledModule)
    : err(liveRunError('compile-failed'));

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

// --- Scenario generator ------------------------------------------------------

/** The deferred slice configuration (no compile port, no reachable WASM path). */
interface DeferredScenario {
  readonly kind: 'deferred';
}

/** The enabled slice configuration plus how the fake port and runs behave. */
interface EnabledScenario {
  readonly kind: 'enabled';
  readonly request: LiveRunCompileRequest;
  readonly compileOk: boolean;
  readonly runOk: boolean;
  readonly invocations: number;
  readonly concurrent: boolean;
  readonly stimulus: LiveRunStimulus;
}

type Scenario = DeferredScenario | EnabledScenario;

function requestArbitrary(): fc.Arbitrary<LiveRunCompileRequest> {
  return fc.record({
    rtl: fc.string({ unit: 'grapheme' }),
    topModule: fc.string({ unit: 'grapheme' }),
  });
}

function stimulusArbitrary(): fc.Arbitrary<LiveRunStimulus> {
  return fc.record({
    cycles: fc.integer({ min: 0, max: 8 }),
    inputs: fc.dictionary(fc.string({ unit: 'grapheme' }), fc.integer({ min: 0, max: 1 })),
  });
}

function scenarioArbitrary(): fc.Arbitrary<Scenario> {
  const deferred = fc.constant<DeferredScenario>({ kind: 'deferred' });
  const enabled = fc.record({
    kind: fc.constant('enabled' as const),
    request: requestArbitrary(),
    compileOk: fc.boolean(),
    runOk: fc.boolean(),
    invocations: fc.integer({ min: 0, max: 5 }),
    concurrent: fc.boolean(),
    stimulus: stimulusArbitrary(),
  });
  return fc.oneof(deferred, enabled);
}

// --- Independent assertions --------------------------------------------------

/** Assert both backend channels are delivered (never silently omitted), on any arm. */
function expectBackendVisualizationsDelivered(
  delivery: ReturnType<EnabledLiveRun['deliverBackendVisualizations']>,
): void {
  expect(delivery.waveform.kind).toBe('waveform');
  expect(delivery.schematic.kind).toBe('schematic');
  expect(typeof delivery.waveform.phase).toBe('string');
  expect(typeof delivery.schematic.phase).toBe('string');
}

/**
 * Assert a run result is a preview and never a verdict.
 *
 * On success the authority is exactly the closed `preview-only` literal, the shape
 * carries only `authority` and `signals` (no verdict/tier field), and on failure
 * the sanitized error is one of the two expected live-run causes.
 */
function expectPreviewNeverVerdict(result: Result<LiveRunPreview, LiveRunError>): void {
  if (result.ok) {
    expect(result.value.authority).toBe('preview-only');
    expect(result.value.authority).toBe(LIVE_RUN_AUTHORITY);
    expect(Object.keys(result.value).sort()).toEqual(['authority', 'signals']);
    return;
  }
  expect(['compile-failed', 'run-failed']).toContain(result.error.code);
}

// --- The property ------------------------------------------------------------

describe('Live_Run scope and authority (Property 24)', () => {
  // Feature: hdl-creation-loop, Property 24: Live-run is exactly enabled or deferred and never the verdict
  it('is exactly enabled xor deferred, compiles lazily-and-once when enabled, and is never the verdict', async () => {
    await fc.assert(
      fc.asyncProperty(
        scenarioArbitrary(),
        waveformSourceArbitrary(),
        schematicSourceArbitrary(),
        async (scenario, waveformSource, schematicSource) => {
          const counting =
            scenario.kind === 'enabled'
              ? countingCompilePort(scenario.compileOk, scenario.runOk)
              : countingCompilePort(true, true);

          const config: LiveRunConfig =
            scenario.kind === 'deferred'
              ? { mode: 'deferred' }
              : { mode: 'enabled', compilePort: counting.port, request: scenario.request };

          const live = decideLiveRun(config);

          // Req 9.8 - exactly one mode: enabled xor deferred, and the runLive
          // capability is present if and only if the mode is enabled (never both,
          // never neither).
          expect(live.mode === 'enabled' || live.mode === 'deferred').toBe(true);
          expect(live.mode).toBe(scenario.kind);
          expect('runLive' in live).toBe(live.mode === 'enabled');

          // Req 9.7, 9.9 - the backend visualizations are still delivered on both
          // arms, independently of the live panel.
          expectBackendVisualizationsDelivered(
            live.deliverBackendVisualizations(waveformSource, schematicSource),
          );

          if (scenario.kind === 'deferred') {
            // Req 9.9 - the deferred arm holds no compile port, so no WASM compile
            // path is reachable: the counting port is never invoked.
            expect(counting.calls()).toBe(0);
            return;
          }

          // The exactly-one-mode assertions above guarantee this; narrow the union
          // for TypeScript and fail loudly if the invariant is ever broken.
          if (live.mode !== 'enabled') {
            throw new Error('invariant: an enabled scenario must yield an enabled Live_Run');
          }

          // Req 9.6 - lazy: compilation has not been triggered before the first run.
          expect(counting.calls()).toBe(0);

          const stimulus = scenario.stimulus;
          const results = scenario.concurrent
            ? await Promise.all(
                Array.from({ length: scenario.invocations }, () => live.runLive(stimulus)),
              )
            : await runSequentially(live, stimulus, scenario.invocations);

          // Req 9.6 - compile-once: at most one compile across any number of
          // repeated or concurrent runs; expected count derived independently.
          const expectedCompileCount = scenario.invocations === 0 ? 0 : 1;
          expect(counting.calls()).toBe(expectedCompileCount);

          // Req 9.6, 9.8 - never the verdict: every result is a preview-only view.
          for (const result of results) {
            expectPreviewNeverVerdict(result);
          }
        },
      ),
      propertyParameters(),
    );
  });
});

/** Run `runLive` sequentially `count` times, collecting each result in order. */
async function runSequentially(
  live: EnabledLiveRun,
  stimulus: LiveRunStimulus,
  count: number,
): Promise<Result<LiveRunPreview, LiveRunError>[]> {
  const results: Result<LiveRunPreview, LiveRunError>[] = [];
  for (let index = 0; index < count; index += 1) {
    results.push(await live.runLive(stimulus));
  }
  return results;
}

// Referenced so the exact Property 24 tag is asserted, not merely written in a
// comment: `Feature: hdl-creation-loop, Property 24: Live-run is exactly enabled or deferred and never the verdict`.
describe('Property 24 tag', () => {
  it('uses the canonical feature tag', () => {
    expect(PROPERTY).toBe(
      'Feature: hdl-creation-loop, Property 24: Live-run is exactly enabled or deferred and never the verdict',
    );
  });
});
