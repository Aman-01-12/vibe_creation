// Property 22: visualizations inherit the trust tier of their source artifact
// (task 15.4).
//
// This is the universal complement to the worked examples in
// `app/web/visualizations/waveform-viewer.test.ts` and
// `app/web/visualizations/schematic-view.test.ts` (which this file does not
// duplicate). It states, over an arbitrary source artifact drawn across ALL three
// trust tiers and over both visualization channels, the three guarantees the
// design binds to Property 22 (Design: Property 22; Req 9.3, 9.4, 9.12):
//
//   - Tier equals the source's tier (Req 9.4, 9.12): a delivered waveform or
//     schematic carries the EXACT Trust_Tier of the source artifact it was derived
//     from - the label is inherited, never re-derived or invented.
//   - Treatment equals the source tier's treatment (Req 9.4): the visual treatment
//     is the single core `treatmentForTier` mapping of the source's tier, derived
//     here INDEPENDENTLY of the delivery path so the assertion cannot tautologically
//     agree with a buggy implementation.
//   - Verified is never claimed for a lesser or absent source (Req 9.3, 9.4): the
//     `verified-treatment` is produced if and only if the source artifact is itself
//     `Verified`; an `Unverified`/`Not_Applicable` source, or an absent source
//     (pending/unavailable channel), never earns the Verified treatment.
//
// The delivered channels are also asserted to be derived from an ACTUAL artifact -
// the waveform from the transformed VCD, the schematic from the rendered SVG ref -
// mirroring the "derived from an actual simulator or netlist artifact" clause.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  isOk,
  isVerifiedTreatment,
  notApplicable,
  treatmentForArtifact,
  treatmentForTier,
  unverified,
  verified,
  type ArtifactKind,
  type ArtifactRef,
  type LabeledArtifact,
  type Ulid,
} from '@app/core';
import {
  deliverSchematic,
  deliverWaveform,
  type SchematicArtifactRef,
  type SchematicSource,
  type SchematicVisualization,
  type WaveformSource,
  type WaveformVisualization,
} from '@app/web';
import { propertyParameters, propertyTag } from '@app/test';

const PROPERTY = propertyTag(22, 'Visualizations inherit the trust tier of their source artifact');

// --- ULID / artifact generators (mirrors the sibling Property 24 generators) --

/** Crockford base32 (excludes I, L, O, U): the ULID alphabet. */
const CROCKFORD: readonly string[] = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'.split('');

/**
 * The artifact kinds a visualization is derived from: a waveform inherits from a
 * module version or verification result, a schematic from the verified netlist
 * (a module version). Tier inheritance is independent of kind, so all are mixed.
 */
const SOURCE_KINDS = [
  'module-version',
  'verification-result',
] as const satisfies readonly ArtifactKind[];

/** An arbitrary string of length `[min, max]` drawn from an explicit alphabet. */
function fromChars(chars: readonly string[], min: number, max: number): fc.Arbitrary<string> {
  const [first, ...rest] = chars;
  if (first === undefined) {
    throw new Error('fromChars requires a non-empty character set');
  }
  return fc
    .array(fc.constantFrom(first, ...rest), { minLength: min, maxLength: max })
    .map((c) => c.join(''));
}

/**
 * A syntactically valid ULID. The leading character is constrained to `0`-`7` so
 * the encoded 48-bit timestamp never overflows, matching the core ULID validity.
 */
function ulidArbitrary(): fc.Arbitrary<Ulid> {
  return fc
    .tuple(fc.constantFrom('0', '1', '2', '3', '4', '5', '6', '7'), fromChars(CROCKFORD, 25, 25))
    .map(([head, rest]) => `${head}${rest}`);
}

/** A source artifact reference over any source kind, at any positive version. */
function sourceRefArbitrary(): fc.Arbitrary<ArtifactRef> {
  return fc.record({
    kind: fc.constantFrom(...SOURCE_KINDS),
    id: ulidArbitrary(),
    version: fc.integer({ min: 1, max: 100_000 }),
  });
}

/**
 * A labeled source artifact drawn across ALL three trust tiers.
 *
 * The `Verified` arm is built through the real core constructor (which requires a
 * valid oracle span ref), so this generator only ever yields labels the domain
 * itself accepts; a malformed span would be a generator bug and is thrown, not
 * silently downgraded.
 */
function labeledSourceArbitrary(): fc.Arbitrary<LabeledArtifact> {
  const verifiedArm = fc.tuple(sourceRefArbitrary(), ulidArbitrary()).map(([ref, spanRef]) => {
    const label = verified(ref, spanRef);
    if (!isOk(label)) {
      throw new Error('generator invariant: a valid ULID span ref must yield a Verified label');
    }
    return label.value;
  });
  return fc.oneof(
    verifiedArm,
    sourceRefArbitrary().map(unverified),
    sourceRefArbitrary().map(notApplicable),
  );
}

// --- Backend visualization source generators ---------------------------------

/** A syntactically valid single-signal VCD the transform can parse successfully. */
const VALID_VCD = ['$var wire 1 ! clk $end', '$enddefinitions $end', '#0', '0!', '#5', '1!'].join(
  '\n',
);

/** A rendered-SVG reference of any size (spanning the drill-down threshold). */
function svgRefArbitrary(): fc.Arbitrary<SchematicArtifactRef> {
  return fc.record({
    name: fc.string({ unit: 'grapheme' }),
    sizeBytes: fc.integer({ min: 0, max: 1_048_576 }),
    sha256: fromChars('0123456789abcdef'.split(''), 64, 64),
  });
}

// --- Independent expectation helpers -----------------------------------------

/**
 * Assert a delivered channel inherited exactly the source tier and treatment.
 *
 * The expected treatment is computed INDEPENDENTLY from the source tier via the
 * core mapping, and the Verified-treatment exclusivity is asserted against the
 * source tier directly (not against the treatment under test).
 */
function expectInheritedTrust(
  channel: WaveformVisualization | SchematicVisualization,
  source: LabeledArtifact,
): void {
  expect(channel.phase).toBe('available');
  if (channel.phase !== 'available') {
    return;
  }
  // Req 9.4, 9.12 - the tier is the source's tier, inherited verbatim.
  expect(channel.tier).toBe(source.tier);
  // Req 9.4 - the treatment is the source tier's treatment, derived independently.
  expect(channel.treatment).toBe(treatmentForTier(source.tier));
  expect(channel.treatment).toBe(treatmentForArtifact(source));
  // Req 9.3, 9.4 - the Verified treatment is earned iff the source is Verified.
  expect(isVerifiedTreatment(channel.treatment)).toBe(source.tier === 'Verified');
}

/**
 * Assert a channel that is not delivered carries no trust at all.
 *
 * An absent source (pending or upstream-unavailable) yields a channel with no
 * `treatment` field, so it can never present the Verified treatment (Req 9.3).
 */
function expectNoVerifiedTreatment(channel: WaveformVisualization | SchematicVisualization): void {
  expect(channel.phase).not.toBe('available');
  expect('treatment' in channel).toBe(false);
}

// --- Property 22 -------------------------------------------------------------

describe(PROPERTY, () => {
  // Feature: hdl-creation-loop, Property 22: Visualizations inherit the trust tier of their source artifact
  it('delivers a waveform that inherits its source artifact tier and treatment', () => {
    fc.assert(
      fc.property(labeledSourceArbitrary(), (source) => {
        const channel = deliverWaveform({ state: 'ready', vcd: VALID_VCD, sourceLabel: source });

        expectInheritedTrust(channel, source);
        // Derived from an actual simulator artifact: the transformed VCD is carried.
        if (channel.phase === 'available') {
          expect(channel.wave.signal[0]?.name).toBe('clk');
        }
      }),
      propertyParameters(),
    );
  });

  it('delivers a schematic that inherits its source netlist tier and treatment', () => {
    fc.assert(
      fc.property(labeledSourceArbitrary(), svgRefArbitrary(), (source, svgRef) => {
        const channel = deliverSchematic({ state: 'ready', svgRef, sourceLabel: source });

        expectInheritedTrust(channel, source);
        // Derived from an actual netlist artifact: the rendered SVG ref is carried.
        if (channel.phase === 'available') {
          expect(channel.svgRef).toEqual(svgRef);
        }
      }),
      propertyParameters(),
    );
  });

  it('never gives the Verified treatment to a visualization from an absent source', () => {
    const absentWaveform = fc.constantFrom<WaveformSource>(
      { state: 'pending' },
      { state: 'unavailable' },
    );
    const absentSchematic = fc.constantFrom<SchematicSource>(
      { state: 'pending' },
      { state: 'unavailable' },
    );

    fc.assert(
      fc.property(absentWaveform, absentSchematic, (waveformSource, schematicSource) => {
        expectNoVerifiedTreatment(deliverWaveform(waveformSource));
        expectNoVerifiedTreatment(deliverSchematic(schematicSource));
      }),
      propertyParameters(),
    );
  });
});

// Referenced so the exact Property 22 tag is asserted, not merely written in a
// comment: `Feature: hdl-creation-loop, Property 22: Visualizations inherit the trust tier of their source artifact`.
describe('Property 22 tag', () => {
  it('uses the canonical feature tag', () => {
    expect(PROPERTY).toBe(
      'Feature: hdl-creation-loop, Property 22: Visualizations inherit the trust tier of their source artifact',
    );
  });
});
