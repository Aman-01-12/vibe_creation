// reference-model-rendered-stimulus, task 2.10, Property 5: Every single bit position of the
// rendered Stimulus_Function is free of near-periodicity over the whole Sample_Budget (C4, C5).
//
// WHY THIS PROPERTY EXISTS, STATED PLAINLY
//   A free probe rendered the stimulus from a three-shift xorshift (`h ^= h<<13; h ^= h>>7;
//   h ^= h<<17;`). Its bit 0 alternates `0101...` because neither left shift can reach bit 0 and
//   the right shift by 7 only folds `step[7]` back in: `bit0(h) == step[0] ^ step[7]`. That bit
//   measured 50.0% ones with a longest identical run of 1, so a toggle-coverage or per-bit-
//   activity metric calls it fully covered - only a sequence check sees the defect
//   (`chipAgent/_inbox/gotcha-a-three-shift-xorshifts-low-bit-alternates-0101-so-a-one-bit-port-is-starved-and-toggle-coverage-reports-it-fully-covered.md`).
//   No activity-style or toggle-style check is added anywhere in this file for that reason.
//
// WHY THIS IS AN OFFLINE, NO-SIMULATOR EVALUATION
//   `ece_stimulus` is a pure function of `step` (Req 2.2), so this file evaluates the
//   Stimulus_Mixer directly in BigInt over `[0, SAMPLE_BUDGET)`, translating the exact statement
//   sequence `renderStimulusMixer()` renders in `app/tools/simulator/consensus-harness.ts`
//   (C4) into TypeScript arithmetic, masked to 64 bits at every step the way the `reg [63:0] h`
//   register is. This is a numeric calibration property, not a syntactic one (unlike task 2.8's
//   layout property): it reads no rendered Verilog text, and it reads neither a Candidate_Design
//   nor a mutant nor a simulator adapter, which is criterion 2.17.
//
// THE TWO STATISTICS, AND WHY THEY ARE DETERMINISTIC
//   For every bit position no `enable`-role port owns, over the whole Sample_Budget:
//     1. each of the 16 four-bit windows formed by 4 consecutive steps' bit values occurs at
//        least 32 times (the floor the design states, a 4x margin under ~128's uniform
//        expectation over ~2045 sliding windows);
//     2. the longest run of identical consecutive bit values is at most 31.
//   Both are pure functions of a deterministic mixer's output, so neither can flake.
//
// CALIBRATION, MEASURED BY THIS FILE'S OWN FALSIFICATION SUB-TEST
//   Substituting the measured three-shift xorshift for bit 0 over 2048 steps gives 7 occurrences
//   of the `1001` window (task text's own figure) and a window-occurrence FLOOR of 0 across the
//   16 windows (most windows, including `1001`, occur far below 32) - that is the failure this
//   test's own threshold must catch. splitmix64's bit 0 occurrence floor is 112 over the same
//   run, comfortably above 32. These numbers were measured by running this file's own helpers
//   before writing the assertions, per the task's own caution about getting a shift direction or
//   mask wrong silently.
//
// NON-VACUITY OBLIGATIONS (named by the task, each constructed and asserted present)
//   - a ONE-BIT input port, as its own fixture and as a width the arbitrary is asserted to have
//     produced: the exact defect class, since a 33-bit bundle can hide one bad bit among 32 good
//     ones under any aggregate check.
//   - the xorshift substitution, required to FAIL the property's own statistics, so the two
//     thresholds are validated rather than unvalidated numbers.
//   - the FULL Sample_Budget, never a shortened one: at 64 steps the window floor of 32 is
//     unreachable and the test would have to be weakened to pass.
//   - an input bundle wider than 64 bits, so a dropped high lane cannot pass.
//
// Built as a hand-rolled local arbitrary rather than `arbModuleInterface()`
// (`./interface-header-arbitraries.js`): that generator caps width at 64 (one lane) and has no
// way to force a one-bit port or an `enable`-role entry into the draw, both of which this
// property's non-vacuity obligations require by construction rather than by filtering.
//
// **Validates: Requirements 2.12, 2.15, 2.16, 2.17**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { SAMPLE_BUDGET, type InputRole } from '@app/tools';

import { propertyParameters } from './property.js';

const PROPERTY =
  'reference-model-rendered-stimulus, Property 5: Every single bit position is free of near-periodicity over the whole budget';

// ---------------------------------------------------------------------------
// The Stimulus_Mixer, translated to BigInt from `renderStimulusMixer()` in
// `app/tools/simulator/consensus-harness.ts` (C4) statement for statement.
// ---------------------------------------------------------------------------

const MASK64 = (1n << 64n) - 1n;
const SPLITMIX_GAMMA = 0x9e3779b97f4a7c15n;
const SPLITMIX_MIX1 = 0xbf58476d1ce4e5b9n;
const SPLITMIX_MIX2 = 0x94d049bb133111ebn;

/**
 * `ece_mix(lane, step)`: the splitmix64 finalizer applied to `{lane, step}`, masked to 64 bits
 * after every statement the way `reg [63:0] h` is in the rendered Verilog.
 */
function stimulusMixer(lane: number, step: number): bigint {
  let h = ((BigInt(lane) << 32n) | BigInt(step)) & MASK64;
  h = (h + SPLITMIX_GAMMA) & MASK64;
  h = (h ^ (h >> 30n)) & MASK64;
  h = (h * SPLITMIX_MIX1) & MASK64;
  h = (h ^ (h >> 27n)) & MASK64;
  h = (h * SPLITMIX_MIX2) & MASK64;
  h = (h ^ (h >> 31n)) & MASK64;
  return h;
}

/**
 * The measured three-shift xorshift the free probe substituted (`h ^= h<<13; h ^= h>>7;
 * h ^= h<<17;`), masked to 64 bits at every step like `stimulusMixer`. `lane` is unused: the
 * probe's expression never took one, and this is only ever evaluated at lane 0 in the
 * falsification sub-test below.
 */
function xorshiftMixer(_lane: number, step: number): bigint {
  let h = BigInt(step) & MASK64;
  h = (h ^ ((h << 13n) & MASK64)) & MASK64;
  h = (h ^ (h >> 7n)) & MASK64;
  h = (h ^ ((h << 17n) & MASK64)) & MASK64;
  return h;
}

type Mixer = (lane: number, step: number) => bigint;

// ---------------------------------------------------------------------------
// The two statistics
// ---------------------------------------------------------------------------

/** One bit position's value at every step of `[0, SAMPLE_BUDGET)`, from a given lane's mixer output. */
function bitSequence(
  mixer: Mixer,
  lane: number,
  bit: number,
  sampleBudget: number,
): readonly number[] {
  const bitIndex = BigInt(bit);
  const values: number[] = [];
  for (let step = 0; step < sampleBudget; step += 1) {
    values.push(Number((mixer(lane, step) >> bitIndex) & 1n));
  }
  return values;
}

/** The occurrence count of each of the 16 four-bit windows, indexed `0b<b0><b1><b2><b3>`. */
function fourBitWindowCounts(bits: readonly number[]): readonly number[] {
  const counts = new Array<number>(16).fill(0);
  for (let i = 0; i + 4 <= bits.length; i += 1) {
    const window = (bits[i]! << 3) | (bits[i + 1]! << 2) | (bits[i + 2]! << 1) | bits[i + 3]!;
    counts[window] = (counts[window] ?? 0) + 1;
  }
  return counts;
}

/** The longest run of identical consecutive values in `bits`. */
function longestRun(bits: readonly number[]): number {
  let longest = 1;
  let current = 1;
  for (let i = 1; i < bits.length; i += 1) {
    current = bits[i] === bits[i - 1] ? current + 1 : 1;
    longest = Math.max(longest, current);
  }
  return longest;
}

/** The floor every one of the 16 four-bit windows must occur at least as often as (Req 2.15). */
const WINDOW_OCCURRENCE_FLOOR = 32;

/** The longest identical run any one bit position may show over the budget (Req 2.15). */
const LONGEST_RUN_CEILING = 31;

/** Both near-periodicity statistics for one bit position's sequence, and whether each passes. */
function nearPeriodicityStats(bits: readonly number[]): {
  readonly minWindowCount: number;
  readonly longestRun: number;
  readonly windowsPass: boolean;
  readonly runPasses: boolean;
} {
  const counts = fourBitWindowCounts(bits);
  const minWindowCount = Math.min(...counts);
  const run = longestRun(bits);
  return {
    minWindowCount,
    longestRun: run,
    windowsPass: minWindowCount >= WINDOW_OCCURRENCE_FLOOR,
    runPasses: run <= LONGEST_RUN_CEILING,
  };
}

// ---------------------------------------------------------------------------
// A hand-rolled bundle shape: widths and an enable-role placement, no Verilog, no port names.
// ---------------------------------------------------------------------------

/** One input port's width and whether the renderer would overwrite its bits as `enable`. */
interface BundlePort {
  readonly width: number;
  readonly role: InputRole;
}

/** A bundle of ports in declared order, the lane count that follows, and each port's own slice. */
interface Bundle {
  readonly ports: readonly BundlePort[];
  readonly bundleWidth: number;
}

/** `packedPortSlices`, restated locally over `BundlePort.width` alone (no name, no Verilog). */
function sliceOf(
  ports: readonly BundlePort[],
  index: number,
): { readonly high: number; readonly low: number } {
  const low = ports.slice(0, index).reduce((sum, port) => sum + port.width, 0);
  const high = low + ports[index]!.width - 1;
  return { high, low };
}

/** Every bit position of `bundle` that no `enable`-role port owns, each as its own lane/bit pair. */
function nonEnableBitPositions(
  bundle: Bundle,
): readonly { readonly lane: number; readonly bit: number }[] {
  const owned = new Set<number>();
  bundle.ports.forEach((port, index) => {
    if (port.role !== 'enable') {
      return;
    }
    const { high, low } = sliceOf(bundle.ports, index);
    for (let position = low; position <= high; position += 1) {
      owned.add(position);
    }
  });
  const positions: { readonly lane: number; readonly bit: number }[] = [];
  for (let position = 0; position < bundle.bundleWidth; position += 1) {
    if (owned.has(position)) {
      continue;
    }
    const lane = Math.floor(position / 64);
    positions.push({ lane, bit: position % 64 });
  }
  return positions;
}

function bundleOf(ports: readonly BundlePort[]): Bundle {
  return { ports, bundleWidth: ports.reduce((sum, port) => sum + port.width, 0) };
}

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

/** One port's width (1-40) and role, independent coins so `enable` is drawn at a real frequency. */
function bundlePortArbitrary(): fc.Arbitrary<BundlePort> {
  return fc.record({
    width: fc.integer({ min: 1, max: 40 }),
    role: fc.constantFrom<InputRole>('data', 'enable'),
  });
}

/** 1 to 6 ports, every one `data`, so no enable overwrite ever narrows the checked population. */
function allDataBundleArbitrary(): fc.Arbitrary<Bundle> {
  return fc
    .array(fc.integer({ min: 1, max: 40 }), { minLength: 1, maxLength: 6 })
    .map((widths) => bundleOf(widths.map((width) => ({ width, role: 'data' as const }))));
}

/** 1 to 6 ports of mixed role, for the enable-exclusion half of the property. */
function mixedRoleBundleArbitrary(): fc.Arbitrary<Bundle> {
  return fc
    .array(bundlePortArbitrary(), { minLength: 1, maxLength: 6 })
    .map((ports) => bundleOf(ports));
}

/** Constructed draw: the exact defect class - a one-bit port alone, the whole bundle. */
const ONE_BIT_PORT_BUNDLE: Bundle = bundleOf([{ width: 1, role: 'data' }]);

/** Constructed draw: a bundle wider than 64 bits, so a second lane's bits are evaluated too. */
const WIDE_BUNDLE: Bundle = bundleOf([
  { width: 40, role: 'data' },
  { width: 40, role: 'data' },
]);

// ---------------------------------------------------------------------------
// Property 5: splitmix64 is free of near-periodicity on every non-enable bit
// ---------------------------------------------------------------------------

describe(PROPERTY, () => {
  it('every non-enable bit position occurs at the window floor and under the run ceiling, at the full budget', () => {
    let sawOneBitPort = false;
    let sawWideBundle = false;

    fc.assert(
      fc.property(
        fc.oneof(
          { weight: 6, arbitrary: mixedRoleBundleArbitrary() },
          { weight: 1, arbitrary: fc.constant(ONE_BIT_PORT_BUNDLE) },
          { weight: 1, arbitrary: fc.constant(WIDE_BUNDLE) },
        ),
        (bundle) => {
          if (bundle.ports.length === 1 && bundle.ports[0]!.width === 1) {
            sawOneBitPort = true;
          }
          if (bundle.bundleWidth > 64) {
            sawWideBundle = true;
          }

          for (const { lane, bit } of nonEnableBitPositions(bundle)) {
            const bits = bitSequence(stimulusMixer, lane, bit, SAMPLE_BUDGET);
            const stats = nearPeriodicityStats(bits);
            const context = `lane ${String(lane)} bit ${String(bit)}`;
            expect(
              stats.windowsPass,
              `${context}: window floor ${String(stats.minWindowCount)} < ${String(WINDOW_OCCURRENCE_FLOOR)}`,
            ).toBe(true);
            expect(
              stats.runPasses,
              `${context}: longest run ${String(stats.longestRun)} > ${String(LONGEST_RUN_CEILING)}`,
            ).toBe(true);
          }
        },
      ),
      propertyParameters({ numRuns: 100 }),
    );

    // NON-VACUITY: the one-bit port (the exact defect class) and a wider-than-64-bit bundle (so a
    // dropped high lane cannot pass unnoticed) must both have been exercised, not left to chance.
    expect({ sawOneBitPort, sawWideBundle }).toEqual({ sawOneBitPort: true, sawWideBundle: true });
  });

  // Explicit 20s timeout, well above the ~2.4s this takes in isolation: a full-bundle draw
  // evaluates every bit position's whole SAMPLE_BUDGET sequence (up to 129 positions x 2048
  // steps per fast-check run), which is CPU-bound enough that vitest's 5s default times out
  // under full-suite worker contention even though the computation itself is not hanging.
  it('a port carrying every bit as data is itself exercised (no enable ever narrows the population to nothing)', () => {
    fc.assert(
      fc.property(allDataBundleArbitrary(), (bundle) => {
        const positions = nonEnableBitPositions(bundle);
        expect(positions.length).toBe(bundle.bundleWidth);
        for (const { lane, bit } of positions) {
          const bits = bitSequence(stimulusMixer, lane, bit, SAMPLE_BUDGET);
          const stats = nearPeriodicityStats(bits);
          expect(stats.windowsPass).toBe(true);
          expect(stats.runPasses).toBe(true);
        }
      }),
      propertyParameters(),
    );
  }, 20_000);

  // Constructed draws are a closed, frozen pair, exhausted directly rather than left to the
  // weighted `fc.oneof` above: chipAgent/_inbox/gotcha-a-closed-union-non-vacuity-row-should-be-exhausted-not-sampled.md
  // and its sibling on this exact file shape, gotcha-interface-header-roundtrip-constructed-draws-sampled-not-exhausted-flaked.md,
  // both record that a weighted sample over a closed list can miss a member across a whole run.
  it('exhausts the one-bit-port and wider-than-64-bit constructed draws directly', () => {
    for (const bundle of [ONE_BIT_PORT_BUNDLE, WIDE_BUNDLE]) {
      for (const { lane, bit } of nonEnableBitPositions(bundle)) {
        const bits = bitSequence(stimulusMixer, lane, bit, SAMPLE_BUDGET);
        const stats = nearPeriodicityStats(bits);
        expect(
          stats.windowsPass,
          `bundleWidth ${String(bundle.bundleWidth)} lane ${String(lane)} bit ${String(bit)}`,
        ).toBe(true);
        expect(
          stats.runPasses,
          `bundleWidth ${String(bundle.bundleWidth)} lane ${String(lane)} bit ${String(bit)}`,
        ).toBe(true);
      }
    }
  });

  // NON-VACUITY: the full Sample_Budget, never a shortened one - at 64 steps the window floor of
  // 32 is structurally unreachable (64 steps yields only ~61 sliding windows across 16 buckets),
  // so this pins the budget this file evaluates at is the real one, not a convenient stand-in.
  it('evaluates at the real SAMPLE_BUDGET, which is large enough for the window floor to be reachable', () => {
    expect(SAMPLE_BUDGET).toBeGreaterThanOrEqual(16 * WINDOW_OCCURRENCE_FLOOR);
  });
});

// ---------------------------------------------------------------------------
// Falsification: the measured three-shift xorshift must FAIL this file's own statistics
// ---------------------------------------------------------------------------

describe(`${PROPERTY} - falsification`, () => {
  it('the measured three-shift xorshift fails the window-occurrence floor on bit 0, calibrating the thresholds', () => {
    const bits = bitSequence(xorshiftMixer, 0, 0, SAMPLE_BUDGET);
    const windowCounts = fourBitWindowCounts(bits);
    const occurrencesOf1001 = windowCounts[0b1001];

    // Calibration figure stated by the task: 7 occurrences of `1001` over 2048 steps. Verified
    // independently against real Icarus before this assertion was written (a scratch testbench
    // evaluating the identical statement sequence), so a wrong shift direction or mask here would
    // have shown up as a mismatch against that run rather than being asserted on trust.
    expect(occurrencesOf1001).toBe(7);

    const stats = nearPeriodicityStats(bits);
    // The falsification: the window-occurrence check must be the one that fails, proving the
    // floor actually discriminates rather than passing everything.
    expect(stats.minWindowCount).toBeLessThan(WINDOW_OCCURRENCE_FLOOR);
    expect(stats.windowsPass).toBe(false);
  });

  it('splitmix64 clears the same floor by a wide margin on the same bit, so the threshold is not merely unreachable', () => {
    const bits = bitSequence(stimulusMixer, 0, 0, SAMPLE_BUDGET);
    const stats = nearPeriodicityStats(bits);
    expect(stats.windowsPass).toBe(true);
    expect(stats.runPasses).toBe(true);
    // splitmix64's own floor is well clear of 32, the margin the design calls generous.
    expect(stats.minWindowCount).toBeGreaterThan(WINDOW_OCCURRENCE_FLOOR);
  });
});
