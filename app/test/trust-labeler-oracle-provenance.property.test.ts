// Property 1: Verified iff a recorded passing oracle verdict exists, with
// provenance (task 8.4).
//
// This is the universal property complement to the worked examples in
// `trust-labeler.test.ts`. Over generated artifact references and recorded
// oracle-evidence sets (in BOTH accepted forms - a raw `OracleVerdictSpan` and a
// full `OracleEvidence` built through `makeVerificationResult`), it pins the
// guarantees `labelArtifact` must never break
// (Design: "Deriving Verified solely from a recorded oracle verdict plus
// provenance", Property 1; Req 4.7, 6.5, 6.6, 8.2, 8.3, 8.5, 8.6, 8.9, 13.8,
// 13.9, 14.1, 14.2, 14.3, 14.4, 14.7, 14.8, 14.9, 14.12):
//
//   1. Verified IFF: an artifact is `Verified` if and only if it is not an
//      input/pedagogy kind AND the earliest exact-version passing oracle verdict
//      recorded for it carries usable provenance; and when `Verified`, the label
//      is bound to that passing span's id. The biconditional is asserted over a
//      space that spans passing verdicts at the current version, passing verdicts
//      at a stale version, fail/error verdicts, evidence for other artifacts, and
//      empty evidence.
//   2. Not_Applicable is assigned to exactly the input/pedagogy kinds (intent,
//      spec, testbench, explanation), regardless of any evidence present.
//   3. No provenance-free Verified: every `Verified` result carries a valid ULID
//      `oracleSpanRef`, and the labeler fails closed to `Unverified` when the
//      matched passing span id is not a usable ULID.
//   4. Determinism and purity: the same inputs always produce an equal label, and
//      the injectable `oracleTrustLabeler` behaves identically to `labelArtifact`.
//
// The expected outcome is computed from the generation plan (the match mode,
// verdict, evidence form, and provenance validity chosen per item), which is an
// independent derivation of the spec's biconditional rather than a re-run of the
// labeler's internals.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  isOk,
  isUlid,
  labelArtifact,
  makeVerificationResult,
  oracleTrustLabeler,
  type ArtifactKind,
  type ArtifactRef,
  type LabelingEvidence,
  type Verdict,
} from '@app/core';
import { propertyParameters, propertyTag } from '@app/test';

const PROPERTY = propertyTag(
  1,
  'Verified iff a recorded passing oracle verdict exists, with provenance',
);

// -- Domain constants -------------------------------------------------------

/** Crockford base32, the ULID alphabet (see ulidx `isValid`). */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID_LENGTH = 26;

/** Every artifact kind that can be labeled or referenced. */
const ALL_KINDS: readonly ArtifactKind[] = [
  'intent',
  'spec',
  'testbench',
  'module-version',
  'verification-result',
  'waveform',
  'schematic',
  'explanation',
];

/** The input/pedagogy kinds that are always `Not_Applicable` (Req 14.4). */
const PEDAGOGY_KINDS: ReadonlySet<ArtifactKind> = new Set<ArtifactKind>([
  'intent',
  'spec',
  'testbench',
  'explanation',
]);

/** Every verdict a recorded oracle span may carry. */
const ALL_VERDICTS: readonly Verdict[] = ['pass', 'fail', 'error'];

/**
 * Fixed, valid ULID literals for the `VerificationResult` fields that never
 * affect labeling (they are not part of the artifact-matching key or the bound
 * provenance). Only `oracleSpanId` - the bound provenance - is generated.
 */
const RESULT_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
const RESULT_MODULE_ID = '01ARZ3NDEKTSV4RRFFQ69G5FB0';
const RESULT_TESTBENCH_ID = '01ARZ3NDEKTSV4RRFFQ69G5FB1';

/** Span-id samples that are guaranteed NOT valid ULIDs (fail-closed inputs). */
const INVALID_SPAN_IDS: readonly string[] = [
  '', // empty
  'not-a-ulid', // wrong length and illegal characters
  'ILOU-excluded-letters-here', // uses the excluded I/L/O/U letters
  '01ARZ3NDEKTSV4RRFFQ69G5FA', // 25 chars: one short of a ULID
];

function isPedagogyKind(kind: ArtifactKind): boolean {
  return PEDAGOGY_KINDS.has(kind);
}

// -- ULID + reference helpers -----------------------------------------------

/** A deterministic, valid 26-character ULID string built from fast-check. */
const validUlidArbitrary: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...CROCKFORD.split('')), {
    minLength: ULID_LENGTH,
    maxLength: ULID_LENGTH,
  })
  .map((chars) => chars.join(''));

/** A valid ULID that is guaranteed to differ from `base` (mutates one char). */
function differentUlid(base: string): string {
  const lastIndex = base.length - 1;
  const current = CROCKFORD.indexOf(base.charAt(lastIndex));
  const replacement = CROCKFORD.charAt((current + 1) % CROCKFORD.length);
  return `${base.slice(0, lastIndex)}${replacement}`;
}

/** A kind guaranteed to differ from `kind`, chosen by a wrap-around offset. */
function differentKind(kind: ArtifactKind, offset: number): ArtifactKind {
  const index = ALL_KINDS.indexOf(kind);
  const shifted = (index + offset) % ALL_KINDS.length;
  return ALL_KINDS[shifted] as ArtifactKind;
}

// -- Evidence plan ----------------------------------------------------------

/** How a piece of evidence relates to the target artifact reference. */
type MatchMode = 'exact' | 'staleVersion' | 'otherId' | 'otherKind';

/**
 * A single generated evidence item, described independently of the labeler.
 *
 * `versionDelta`/`kindOffset` guarantee a real mismatch for the non-exact modes;
 * `spanUlid`/`invalidSpanId` supply the provenance for the raw-span form, and
 * `resultUlid` the provenance for the full-result form.
 */
interface EvidencePlan {
  readonly matchMode: MatchMode;
  readonly verdict: Verdict;
  readonly form: 'span' | 'result';
  readonly spanValid: boolean;
  readonly versionDelta: number;
  readonly kindOffset: number;
  readonly spanUlid: string;
  readonly invalidSpanId: string;
  readonly resultUlid: string;
}

const evidencePlanArbitrary: fc.Arbitrary<EvidencePlan> = fc.record({
  matchMode: fc.constantFrom<MatchMode>('exact', 'staleVersion', 'otherId', 'otherKind'),
  verdict: fc.constantFrom(...ALL_VERDICTS),
  form: fc.constantFrom<'span' | 'result'>('span', 'result'),
  spanValid: fc.boolean(),
  versionDelta: fc.integer({ min: 1, max: 5 }),
  kindOffset: fc.integer({ min: 1, max: ALL_KINDS.length - 1 }),
  spanUlid: validUlidArbitrary,
  invalidSpanId: fc.constantFrom(...INVALID_SPAN_IDS),
  resultUlid: validUlidArbitrary,
});

const artifactRefArbitrary: fc.Arbitrary<ArtifactRef> = fc.record({
  kind: fc.constantFrom(...ALL_KINDS),
  id: validUlidArbitrary,
  version: fc.integer({ min: 1, max: 5 }),
});

// -- Building evidence + expected outcome from a plan -----------------------

/** Resolve the artifact reference a plan's evidence is recorded against. */
function resolveRef(target: ArtifactRef, plan: EvidencePlan): ArtifactRef {
  switch (plan.matchMode) {
    case 'exact':
      return { kind: target.kind, id: target.id, version: target.version };
    case 'staleVersion':
      return { kind: target.kind, id: target.id, version: target.version + plan.versionDelta };
    case 'otherId':
      return { kind: target.kind, id: differentUlid(target.id), version: target.version };
    case 'otherKind':
      return {
        kind: differentKind(target.kind, plan.kindOffset),
        id: target.id,
        version: target.version,
      };
    default: {
      const exhaustive: never = plan.matchMode;
      return exhaustive;
    }
  }
}

/** A built evidence item paired with the facts needed to predict the label. */
interface BuiltEvidence {
  readonly evidence: LabelingEvidence;
  /** The span id the labeler would bind if this item justifies `Verified`. */
  readonly boundSpanId: string;
  /** Whether the bound provenance is a usable ULID. */
  readonly provenanceUsable: boolean;
  /** Whether this item is a passing verdict for the target's exact version. */
  readonly passingExactMatch: boolean;
}

/** Build the raw-span form of an evidence item and its predicted facts. */
function buildSpanEvidence(
  ref: ArtifactRef,
  plan: EvidencePlan,
  isExactMatch: boolean,
): BuiltEvidence {
  const spanId = plan.spanValid ? plan.spanUlid : plan.invalidSpanId;
  return {
    evidence: { spanId, artifactRef: ref, verdict: plan.verdict },
    boundSpanId: spanId,
    provenanceUsable: plan.spanValid,
    passingExactMatch: isExactMatch && plan.verdict === 'pass',
  };
}

/**
 * Build the full-result form of an evidence item and its predicted facts.
 *
 * A `pass` result is constructed with `allChecksPassed: true` and a valid ULID
 * `oracleSpanId`, exactly as `makeVerificationResult` demands; a non-pass result
 * carries `allChecksPassed: false`. The full-result form can therefore never
 * smuggle in unusable provenance for a passing verdict.
 */
function buildResultEvidence(
  ref: ArtifactRef,
  plan: EvidencePlan,
  isExactMatch: boolean,
): BuiltEvidence {
  const built = makeVerificationResult({
    id: RESULT_ID,
    moduleVersionId: RESULT_MODULE_ID,
    testbenchId: RESULT_TESTBENCH_ID,
    verdict: plan.verdict,
    allChecksPassed: plan.verdict === 'pass',
    iterations: 1,
    costCents: 0,
    oracleSpanId: plan.resultUlid,
  });
  if (!isOk(built)) {
    throw new Error(`test setup: could not build a ${plan.verdict} VerificationResult`);
  }
  return {
    evidence: { artifactRef: ref, result: built.value },
    boundSpanId: plan.resultUlid,
    provenanceUsable: true,
    passingExactMatch: isExactMatch && plan.verdict === 'pass',
  };
}

function buildEvidence(target: ArtifactRef, plan: EvidencePlan): BuiltEvidence {
  const ref = resolveRef(target, plan);
  const isExactMatch = plan.matchMode === 'exact';
  return plan.form === 'span'
    ? buildSpanEvidence(ref, plan, isExactMatch)
    : buildResultEvidence(ref, plan, isExactMatch);
}

/** The label predicted by the spec's biconditional, from generation metadata. */
interface ExpectedLabel {
  readonly tier: 'Verified' | 'Unverified' | 'Not_Applicable';
  readonly oracleSpanRef?: string;
}

/**
 * Predict the label for `target` given the ordered built evidence.
 *
 * Mirrors the design's rule: pedagogy kinds are `Not_Applicable`; otherwise the
 * EARLIEST passing exact-version match decides, yielding `Verified` (bound to its
 * span) only when that match carries usable provenance, and `Unverified`
 * otherwise or when no such match exists.
 */
function predictLabel(target: ArtifactRef, built: readonly BuiltEvidence[]): ExpectedLabel {
  if (isPedagogyKind(target.kind)) {
    return { tier: 'Not_Applicable' };
  }
  const justifying = built.find((item) => item.passingExactMatch);
  if (justifying === undefined) {
    return { tier: 'Unverified' };
  }
  return justifying.provenanceUsable
    ? { tier: 'Verified', oracleSpanRef: justifying.boundSpanId }
    : { tier: 'Unverified' };
}

// -- Scenario arbitraries ---------------------------------------------------

interface Scenario {
  readonly target: ArtifactRef;
  readonly evidence: readonly LabelingEvidence[];
  readonly expected: ExpectedLabel;
}

function buildScenario(target: ArtifactRef, plans: readonly EvidencePlan[]): Scenario {
  const built = plans.map((plan) => buildEvidence(target, plan));
  return {
    target,
    evidence: built.map((item) => item.evidence),
    expected: predictLabel(target, built),
  };
}

/** The general space: any kind, any mix of evidence (including none). */
const scenarioArbitrary: fc.Arbitrary<Scenario> = fc
  .record({
    target: artifactRefArbitrary,
    plans: fc.array(evidencePlanArbitrary, { maxLength: 6 }),
  })
  .map(({ target, plans }) => buildScenario(target, plans));

/**
 * A non-pedagogy target whose evidence includes at least one passing exact-match
 * item, so the `Verified` / fail-closed branches are exercised non-vacuously.
 */
const verifiableScenarioArbitrary: fc.Arbitrary<Scenario> = fc
  .record({
    kind: fc.constantFrom(...ALL_KINDS.filter((kind) => !isPedagogyKind(kind))),
    id: validUlidArbitrary,
    version: fc.integer({ min: 1, max: 5 }),
    leading: fc.array(evidencePlanArbitrary, { maxLength: 3 }),
    passing: evidencePlanArbitrary,
    trailing: fc.array(evidencePlanArbitrary, { maxLength: 3 }),
  })
  .map(({ kind, id, version, leading, passing, trailing }) => {
    const target: ArtifactRef = { kind, id, version };
    const exactPass: EvidencePlan = { ...passing, matchMode: 'exact', verdict: 'pass' };
    return buildScenario(target, [...leading, exactPass, ...trailing]);
  });

// -- Property 1 -------------------------------------------------------------

describe(PROPERTY, () => {
  it('labels Verified iff an exact-version passing verdict with usable provenance exists', () => {
    fc.assert(
      fc.property(scenarioArbitrary, ({ target, evidence, expected }) => {
        const labeled = labelArtifact(target, evidence);

        expect(labeled.tier).toBe(expected.tier);
        expect(labeled.artifactRef).toEqual(target);
        if (labeled.tier === 'Verified') {
          // Provenance present and bound to the justifying passing span.
          expect(labeled.oracleSpanRef).toBe(expected.oracleSpanRef);
        }
      }),
      propertyParameters(),
    );
  });

  it('assigns Not_Applicable to exactly the input/pedagogy kinds, regardless of evidence', () => {
    fc.assert(
      fc.property(scenarioArbitrary, ({ target, evidence }) => {
        const isNotApplicable = labelArtifact(target, evidence).tier === 'Not_Applicable';

        expect(isNotApplicable).toBe(isPedagogyKind(target.kind));
      }),
      propertyParameters(),
    );
  });

  it('never yields a Verified label without a valid ULID provenance reference', () => {
    fc.assert(
      fc.property(verifiableScenarioArbitrary, ({ target, evidence }) => {
        const labeled = labelArtifact(target, evidence);

        if (labeled.tier === 'Verified') {
          expect(isUlid(labeled.oracleSpanRef)).toBe(true);
        }
      }),
      propertyParameters(),
    );
  });

  it('is deterministic and matches the injectable oracleTrustLabeler', () => {
    fc.assert(
      fc.property(scenarioArbitrary, ({ target, evidence }) => {
        const first = labelArtifact(target, evidence);
        const second = labelArtifact(target, evidence);

        expect(second).toEqual(first);
        expect(oracleTrustLabeler.label(target, evidence)).toEqual(first);
      }),
      propertyParameters(),
    );
  });
});
