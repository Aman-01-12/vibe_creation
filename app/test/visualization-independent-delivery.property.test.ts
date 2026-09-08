// Property 23: waveform and schematic are delivered independently, with an
// explicit unavailable status (task 15.5).
//
// This is the universal complement to the worked examples in
// `app/web/visualizations/delivery.test.ts` (which this file does not duplicate).
// It states the independence contract over the delivery composition
// (`deliverVisualizations`) and its two per-channel functions (`deliverWaveform`,
// `deliverSchematic`) across every combination of source states for both channels
// (Design: Error Handling "Visualization degradation", Property 23; Req 9.7, 9.10,
// 9.11):
//
//   - Each channel is a PURE FUNCTION OF ONLY ITS OWN SOURCE. The waveform channel
//     is determined solely by the waveform source and the schematic channel solely
//     by the schematic source, so one being pending, ready, or unavailable never
//     blocks or changes the other (Req 9.10). There is no verdict input to either
//     function, so neither channel can block on the pass/fail verdict either.
//   - A channel that cannot be produced (upstream tool failure/unsupported/timeout,
//     or a source artifact that fails to render) carries an EXPLICIT `unavailable`
//     status with a SANITIZED, constant reason - it is never silently omitted and
//     never leaks a host, path, stack frame, or secret (Req 9.11).
//
// INDEPENDENT oracle: every case carries the expected channel outcome derived from
// ONLY its own source at generation time, never by calling the delivery function
// under test, so the test cannot tautologically agree with a buggy implementation.
// The VCD validity and the schematic size band are fixed by construction, so the
// expected phase is known without re-running the transform under test.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  newUlid,
  treatmentForTier,
  type ArtifactKind,
  type ArtifactRef,
  type LabeledArtifact,
  type TrustTier,
} from '@app/core';
import {
  deliverSchematic,
  deliverVisualizations,
  deliverWaveform,
  RESPONSIVE_SCHEMATIC_MAX_BYTES,
  VISUALIZATION_UNAVAILABLE_REASONS,
  type SchematicArtifactRef,
  type SchematicRendering,
  type SchematicSource,
  type SchematicVisualization,
  type VisualizationUnavailableCause,
  type WaveformSource,
  type WaveformVisualization,
} from '@app/web';
import { propertyParameters, propertyTag } from '@app/test';

const PROPERTY = propertyTag(
  23,
  'Waveform and schematic are delivered independently, with explicit unavailable status',
);

// --- Independent expectations (derived from a single source, never from output) --

type ExpectedWaveform =
  | { readonly phase: 'pending' }
  | { readonly phase: 'available'; readonly tier: TrustTier }
  | { readonly phase: 'unavailable'; readonly cause: VisualizationUnavailableCause };

type ExpectedSchematic =
  | { readonly phase: 'pending' }
  | {
      readonly phase: 'available';
      readonly tier: TrustTier;
      readonly rendering: SchematicRendering;
      readonly drillDownEnabled: boolean;
    }
  | { readonly phase: 'unavailable'; readonly cause: VisualizationUnavailableCause };

interface WaveformCase {
  readonly source: WaveformSource;
  readonly expected: ExpectedWaveform;
}

interface SchematicCase {
  readonly source: SchematicSource;
  readonly expected: ExpectedSchematic;
}

// --- Source-label generator --------------------------------------------------

/** A labeled source artifact over any tier; the channel inherits its tier. */
function labeledArtifactArbitrary(kind: ArtifactKind): fc.Arbitrary<LabeledArtifact> {
  return fc
    .tuple(
      fc.integer({ min: 0, max: 1000 }),
      fc.constantFrom<TrustTier>('Verified', 'Unverified', 'Not_Applicable'),
    )
    .map(([version, tier]) => {
      const artifactRef: ArtifactRef = { kind, id: newUlid(), version };
      if (tier === 'Verified') {
        return { artifactRef, tier, oracleSpanRef: newUlid() };
      }
      return { artifactRef, tier };
    });
}

// --- VCD generators (validity fixed by construction) -------------------------

/** Distinct single-character VCD symbols, one per generated signal. */
const VCD_SYMBOLS = ['!', '"', '#', '$', '%', '&'] as const;

/** Build a syntactically valid VCD with `signalCount` scalar signals. */
function buildValidVcd(signalCount: number): string {
  const header: string[] = [];
  const body: string[] = ['#0'];
  for (let index = 0; index < signalCount; index += 1) {
    const symbol = VCD_SYMBOLS[index] ?? '!';
    header.push(`$var wire 1 ${symbol} sig${index} $end`);
    body.push(`0${symbol}`);
  }
  return [...header, '$enddefinitions $end', ...body].join('\n');
}

/** A VCD that always transforms successfully (at least one declared signal). */
const validVcdArbitrary: fc.Arbitrary<string> = fc
  .integer({ min: 1, max: VCD_SYMBOLS.length })
  .map(buildValidVcd);

/**
 * A VCD that always fails to transform: empty input, or garbage that declares no
 * `$var` signal. Excluding the literal `$var` guarantees no signal is ever parsed,
 * so the transform yields an error and the channel degrades to `render-failed`.
 */
const invalidVcdArbitrary: fc.Arbitrary<string> = fc.oneof(
  fc.constant(''),
  fc.string({ unit: 'grapheme' }).filter((text) => !text.includes('$var')),
);

// --- Schematic SVG-size generator (band fixed by construction) ---------------

/** An SVG size at or under the responsiveness threshold: drawn in full. */
const smallSvgSize = fc.integer({ min: 0, max: RESPONSIVE_SCHEMATIC_MAX_BYTES });
/** An SVG size above the threshold: rendered top-level-first with drill-down. */
const largeSvgSize = fc.integer({
  min: RESPONSIVE_SCHEMATIC_MAX_BYTES + 1,
  max: RESPONSIVE_SCHEMATIC_MAX_BYTES * 8,
});

/** A rendered-SVG reference of the given size (identity fields are irrelevant here). */
function svgRefOfSize(sizeBytes: number): SchematicArtifactRef {
  return { name: 'schematic.svg', sizeBytes, sha256: 'a'.repeat(64) };
}

// --- Waveform case arms ------------------------------------------------------

const pendingWaveformCase: WaveformCase = {
  source: { state: 'pending' },
  expected: { phase: 'pending' },
};

const unavailableWaveformCase: WaveformCase = {
  source: { state: 'unavailable' },
  expected: { phase: 'unavailable', cause: 'source-unavailable' },
};

/** A ready waveform whose VCD transforms: delivered, inheriting the source tier. */
function readyWaveformCase(): fc.Arbitrary<WaveformCase> {
  return fc
    .tuple(validVcdArbitrary, labeledArtifactArbitrary('waveform'))
    .map(([vcd, sourceLabel]) => ({
      source: { state: 'ready', vcd, sourceLabel },
      expected: { phase: 'available', tier: sourceLabel.tier },
    }));
}

/** A ready waveform whose VCD cannot transform: explicit `render-failed`. */
function unrenderableWaveformCase(): fc.Arbitrary<WaveformCase> {
  return fc
    .tuple(invalidVcdArbitrary, labeledArtifactArbitrary('waveform'))
    .map(([vcd, sourceLabel]) => ({
      source: { state: 'ready', vcd, sourceLabel },
      expected: { phase: 'unavailable', cause: 'render-failed' },
    }));
}

/** Every waveform source state, each carrying its independently-derived outcome. */
const waveformCaseArbitrary: fc.Arbitrary<WaveformCase> = fc.oneof(
  fc.constant(pendingWaveformCase),
  fc.constant(unavailableWaveformCase),
  readyWaveformCase(),
  unrenderableWaveformCase(),
);

// --- Schematic case arms -----------------------------------------------------

const pendingSchematicCase: SchematicCase = {
  source: { state: 'pending' },
  expected: { phase: 'pending' },
};

const unavailableSchematicCase: SchematicCase = {
  source: { state: 'unavailable' },
  expected: { phase: 'unavailable', cause: 'source-unavailable' },
};

/** A ready schematic: delivered, inheriting tier, with the drill-down decided by size. */
function readySchematicCase(): fc.Arbitrary<SchematicCase> {
  return fc
    .tuple(fc.oneof(smallSvgSize, largeSvgSize), labeledArtifactArbitrary('schematic'))
    .map(([sizeBytes, sourceLabel]) => {
      const rendering: SchematicRendering =
        sizeBytes > RESPONSIVE_SCHEMATIC_MAX_BYTES ? 'top-level' : 'full';
      return {
        source: { state: 'ready', svgRef: svgRefOfSize(sizeBytes), sourceLabel },
        expected: {
          phase: 'available',
          tier: sourceLabel.tier,
          rendering,
          drillDownEnabled: rendering === 'top-level',
        },
      };
    });
}

/** Every schematic source state, each carrying its independently-derived outcome. */
const schematicCaseArbitrary: fc.Arbitrary<SchematicCase> = fc.oneof(
  fc.constant(pendingSchematicCase),
  fc.constant(unavailableSchematicCase),
  readySchematicCase(),
);

/** Bare source generators for the "the other channel does not matter" checks. */
const waveformSourceArbitrary: fc.Arbitrary<WaveformSource> = waveformCaseArbitrary.map(
  (aCase) => aCase.source,
);
const schematicSourceArbitrary: fc.Arbitrary<SchematicSource> = schematicCaseArbitrary.map(
  (aCase) => aCase.source,
);

// --- Sanitized-reason oracle -------------------------------------------------

/** Only letters, digits, spaces, and safe sentence punctuation are permitted. */
const SAFE_REASON = /^[A-Za-z0-9 ,.'`-]+$/;

/**
 * Assert an unavailable channel carries an explicit, sanitized reason: the fixed
 * constant for its cause, with no host, path, stack frame, or secret-shaped
 * content (Req 9.11).
 */
function assertSanitizedReason(reason: string, cause: VisualizationUnavailableCause): void {
  expect(typeof reason).toBe('string');
  expect(reason.length).toBeGreaterThan(0);
  expect(reason).toBe(VISUALIZATION_UNAVAILABLE_REASONS[cause]);
  expect(SAFE_REASON.test(reason)).toBe(true);
  expect(reason).not.toMatch(/[/\\]/); // no path separators
  expect(reason.toLowerCase()).not.toContain('error'); // no raw error text
  expect(reason).not.toMatch(/0x[0-9a-f]+/i); // no addresses/handles
  expect(reason).not.toContain('@'); // no email/secret markers
  expect(reason).not.toMatch(/\d{1,3}(?:\.\d{1,3}){3}/); // no IP address
}

// --- Channel expectation checks ----------------------------------------------

/** Assert a delivered waveform channel matches the outcome derived from its source. */
function assertWaveformMatches(channel: WaveformVisualization, expected: ExpectedWaveform): void {
  expect(channel.kind).toBe('waveform');
  expect(channel.phase).toBe(expected.phase);
  if (expected.phase === 'available' && channel.phase === 'available') {
    expect(channel.tier).toBe(expected.tier);
    expect(channel.treatment).toBe(treatmentForTier(expected.tier));
    return;
  }
  if (expected.phase === 'unavailable' && channel.phase === 'unavailable') {
    expect(channel.cause).toBe(expected.cause);
    assertSanitizedReason(channel.reason, channel.cause);
  }
}

/** Assert a delivered schematic channel matches the outcome derived from its source. */
function assertSchematicMatches(
  channel: SchematicVisualization,
  expected: ExpectedSchematic,
): void {
  expect(channel.kind).toBe('schematic');
  expect(channel.phase).toBe(expected.phase);
  if (expected.phase === 'available' && channel.phase === 'available') {
    expect(channel.tier).toBe(expected.tier);
    expect(channel.treatment).toBe(treatmentForTier(expected.tier));
    expect(channel.rendering).toBe(expected.rendering);
    expect(channel.drillDownEnabled).toBe(expected.drillDownEnabled);
    return;
  }
  if (expected.phase === 'unavailable' && channel.phase === 'unavailable') {
    expect(channel.cause).toBe(expected.cause);
    assertSanitizedReason(channel.reason, channel.cause);
  }
}

// --- Property 23 -------------------------------------------------------------

describe(PROPERTY, () => {
  it('delivers each channel as a pure function of only its own source', () => {
    fc.assert(
      fc.property(waveformCaseArbitrary, schematicCaseArbitrary, (waveformCase, schematicCase) => {
        const delivery = deliverVisualizations(waveformCase.source, schematicCase.source);

        // Both channels are always present - a failed channel is delivered as an
        // explicit status, never dropped from the object (Req 9.11).
        expect(Object.hasOwn(delivery, 'waveform')).toBe(true);
        expect(Object.hasOwn(delivery, 'schematic')).toBe(true);

        // Each channel matches the outcome derived from ONLY its own source, so its
        // phase/status is independent of the other channel (Req 9.10).
        assertWaveformMatches(delivery.waveform, waveformCase.expected);
        assertSchematicMatches(delivery.schematic, schematicCase.expected);

        // The composition delivers exactly each per-channel function's result, with
        // no cross-channel coupling introduced by assembling the pair.
        expect(delivery.waveform).toEqual(deliverWaveform(waveformCase.source));
        expect(delivery.schematic).toEqual(deliverSchematic(schematicCase.source));
      }),
      propertyParameters(),
    );
  });

  it('never lets the other channel state change a channel (true independence)', () => {
    fc.assert(
      fc.property(
        waveformCaseArbitrary,
        schematicSourceArbitrary,
        schematicSourceArbitrary,
        (waveformCase, schematicA, schematicB) => {
          // Varying the schematic source across two arbitrary states leaves the
          // waveform channel byte-for-byte identical: it cannot block or change it.
          const withA = deliverVisualizations(waveformCase.source, schematicA);
          const withB = deliverVisualizations(waveformCase.source, schematicB);
          expect(withA.waveform).toEqual(withB.waveform);
        },
      ),
      propertyParameters(),
    );
  });

  it('never lets the waveform state change the schematic channel (true independence)', () => {
    fc.assert(
      fc.property(
        schematicCaseArbitrary,
        waveformSourceArbitrary,
        waveformSourceArbitrary,
        (schematicCase, waveformA, waveformB) => {
          const withA = deliverVisualizations(waveformA, schematicCase.source);
          const withB = deliverVisualizations(waveformB, schematicCase.source);
          expect(withA.schematic).toEqual(withB.schematic);
        },
      ),
      propertyParameters(),
    );
  });

  it('surfaces an explicit sanitized reason for every unavailable channel', () => {
    fc.assert(
      fc.property(waveformCaseArbitrary, schematicCaseArbitrary, (waveformCase, schematicCase) => {
        const delivery = deliverVisualizations(waveformCase.source, schematicCase.source);

        if (delivery.waveform.phase === 'unavailable') {
          assertSanitizedReason(delivery.waveform.reason, delivery.waveform.cause);
        }
        if (delivery.schematic.phase === 'unavailable') {
          assertSanitizedReason(delivery.schematic.reason, delivery.schematic.cause);
        }
      }),
      propertyParameters(),
    );
  });
});

// Referenced so the exact Property 23 tag is asserted, not merely written in a
// comment: `Feature: hdl-creation-loop, Property 23: Waveform and schematic are
// delivered independently, with explicit unavailable status`.
describe('Property 23 tag', () => {
  it('uses the canonical feature tag', () => {
    expect(PROPERTY).toBe(
      'Feature: hdl-creation-loop, Property 23: Waveform and schematic are delivered independently, with explicit unavailable status',
    );
  });
});
