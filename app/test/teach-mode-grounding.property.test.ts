// Property 25: Teach-mode grounds each claim by its type (task 16.5).
//
// Canonical statement (design.md Property 25; Req 11.2, 11.3, 11.6, 11.7, 11.8, 11.9):
//   For any explanation, each design-specific claim references verified tool output
//   from the session and each general domain fact references a citation, both
//   grounding types may appear together in one explanation, and any claim lacking
//   its appropriate grounding is labeled `Unverified` or is not taught.
//
// WHAT THIS PINS DOWN. Teach_Mode's pure grounding core (teach-claims.ts) is total
// and I/O-free, so the property states directly over `assembleExplanation` (which
// composes `groundClaim`, `presentVerifiedResult`, and `coachFailingCase`). The
// expectation for every claim, the Verified presentation, and the failing-case
// coaching is DERIVED INDEPENDENTLY here from the session's ground truth - never by
// consulting the code under test - so the test is a genuine oracle for the rule:
//
//   - a `design` claim is taught iff its tool-output reference RESOLVES against an
//     artifact that actually exists in the session (the named oracle verdict + its
//     span, a recorded Trace span, or a signal present in the session waveform);
//   - a `general` fact is taught iff it carries a citation the session actually
//     retrieved (matched on source url + title);
//   - a claim with nothing to teach (an empty/blank statement) is omitted; every
//     other ungrounded claim is labeled `Unverified` and never presented as correct
//     (Req 11.3, 11.6, 11.9);
//   - a `Verified` result is presented with its non-omittable simulation-vs-silicon
//     limit iff the module is labeled `Verified` and a passing oracle verdict backs
//     it (Req 11.5); a non-pass verification is coached (Req 11.4, 11.8).
//
// Generators produce claims of BOTH types, some with valid grounding and some
// without, over sessions with verified / non-pass / absent results, so the mixed
// case (Req 11.8) and every ungrounded branch are exercised across 100+ runs.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  isOk,
  makeVerificationResult,
  notApplicable,
  unverified,
  verified,
  type ArtifactRef,
  type Citation,
  type FailingCase,
  type LabeledArtifact,
  type Spec,
  type TrustTier,
  type Ulid,
  type Verdict,
  type VerificationResult,
} from '@app/core';
import {
  SIMULATION_VS_SILICON_LIMIT,
  assembleExplanation,
  coachFailingCase,
  presentVerifiedResult,
  type ClaimDecision,
  type ProposedClaim,
  type TeachSession,
  type ToolOutputRef,
  type WaveformReadingSource,
} from '@app/agent';
import { propertyParameters, propertyTag, timingContractFor } from '@app/test';

const PROPERTY = propertyTag(25, 'Teach-mode grounds each claim by its type');

// -- ULID helpers -----------------------------------------------------------

/** Crockford base32, the ULID alphabet. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const ULID_LENGTH = 26;

/** A deterministic, valid 26-character ULID string built from fast-check. */
const ulidArbitrary: fc.Arbitrary<Ulid> = fc
  .array(fc.constantFrom(...CROCKFORD.split('')), {
    minLength: ULID_LENGTH,
    maxLength: ULID_LENGTH,
  })
  .map((chars) => chars.join(''));

// -- Fixed, valid Spec (the pure grounding logic does not read its fields) --

/** A minimal approved single-module Spec that anchors the explanation. */
function anchorSpec(): Spec {
  return {
    timingContract: timingContractFor({
      validityOutputName: null,
      moduleName: 'counter',
      ports: [
        { name: 'clk', direction: 'input', width: 1 },
        { name: 'rst', direction: 'input', width: 1 },
        { name: 'count', direction: 'output', width: 4 },
      ],
      clocking: { clockName: 'clk', resetName: 'rst', resetActiveLow: false },
    }),
    id: 'SPEC00000000000000000000AA',
    projectId: 'PROJ00000000000000000000AA',
    goal: 'A 4-bit synchronous up-counter that clears to zero on reset.',
    constraints: [],
    moduleInterface: {
      validityOutputName: null,
      moduleName: 'counter',
      ports: [
        { name: 'clk', direction: 'input', width: 1 },
        { name: 'rst', direction: 'input', width: 1 },
        { name: 'count', direction: 'output', width: 4 },
      ],
      clocking: { clockName: 'clk', resetName: 'rst', resetActiveLow: false },
    },
    acceptanceCriteria: [
      {
        id: 'CRIT00000000000000000000AA',
        text: 'reset clears the output to zero',
        measurable: true,
        method: 'simulation',
      },
    ],
    architecture: 'Single always block incrementing count on the clock edge.',
    approved: true,
    version: 1,
  };
}

// -- Verification-result generation -----------------------------------------

/** The three verification states a session may be in (plus absence, handled separately). */
type VerdictKind = Verdict;

/** A failing case, or `null` when the run localized none (as an `error` may). */
const failingCaseArbitrary: fc.Arbitrary<FailingCase | null> = fc.option(
  fc.record({
    checkName: fc.string({ unit: 'grapheme', minLength: 1 }),
    description: fc.string({ unit: 'grapheme' }),
    expected: fc.string({ unit: 'grapheme' }),
    observed: fc.string({ unit: 'grapheme' }),
    atSimTimeNs: fc.option(fc.nat(), { nil: null }),
  }),
  { nil: null },
);

/** Build a recorded `VerificationResult` of the given verdict, or throw on setup error. */
function buildVerification(
  verdict: VerdictKind,
  ids: {
    readonly id: Ulid;
    readonly moduleVersionId: Ulid;
    readonly testbenchId: Ulid;
    readonly oracleSpanId: Ulid;
  },
  failingCase: FailingCase | null,
  iterations: number,
  costCents: number,
): VerificationResult {
  const passed = verdict === 'pass';
  const built = makeVerificationResult({
    id: ids.id,
    moduleVersionId: ids.moduleVersionId,
    testbenchId: ids.testbenchId,
    verdict,
    allChecksPassed: passed,
    // A pass never carries a failing case; a non-pass may (Req 8.10 integrity holds).
    ...(passed || failingCase === null ? {} : { failingCase }),
    iterations,
    costCents,
    oracleSpanId: ids.oracleSpanId,
  });
  if (!isOk(built)) {
    throw new Error(`test setup: could not build a ${verdict} VerificationResult`);
  }
  return built.value;
}

/** A session verification (`pass`/`fail`/`error`) or `null` when no run exists yet. */
const verificationArbitrary: fc.Arbitrary<VerificationResult | null> = fc.option(
  fc
    .record({
      verdict: fc.constantFrom<VerdictKind>('pass', 'fail', 'error'),
      id: ulidArbitrary,
      moduleVersionId: ulidArbitrary,
      testbenchId: ulidArbitrary,
      oracleSpanId: ulidArbitrary,
      failingCase: failingCaseArbitrary,
      iterations: fc.integer({ min: 0, max: 8 }),
      costCents: fc.integer({ min: 0, max: 500 }),
    })
    .map(({ verdict, failingCase, iterations, costCents, ...ids }) =>
      buildVerification(verdict, ids, failingCase, iterations, costCents),
    ),
  { nil: null },
);

// -- Module trust label -----------------------------------------------------

/** Build the module's current trust label of the requested tier. */
function buildModuleLabel(tier: TrustTier, ref: ArtifactRef, oracleSpanRef: Ulid): LabeledArtifact {
  if (tier === 'Unverified') {
    return unverified(ref);
  }
  if (tier === 'Not_Applicable') {
    return notApplicable(ref);
  }
  const label = verified(ref, oracleSpanRef);
  if (!isOk(label)) {
    throw new Error('test setup: could not build a Verified module label');
  }
  return label.value;
}

const moduleLabelArbitrary: fc.Arbitrary<LabeledArtifact> = fc
  .record({
    tier: fc.constantFrom<TrustTier>('Verified', 'Unverified', 'Not_Applicable'),
    id: ulidArbitrary,
    version: fc.integer({ min: 1, max: 5 }),
    oracleSpanRef: ulidArbitrary,
  })
  .map(({ tier, id, version, oracleSpanRef }) =>
    buildModuleLabel(tier, { kind: 'module-version', id, version }, oracleSpanRef),
  );

// -- Waveform, trace spans, citations ---------------------------------------

/** A short, non-empty signal name for a waveform reading. */
const signalArbitrary: fc.Arbitrary<string> = fc
  .array(fc.constantFrom(...'abcdefghijklmnop_0123'.split('')), { minLength: 1, maxLength: 8 })
  .map((chars) => chars.join(''));

/** A session waveform reading source, or `null` when none exists. */
const waveformArbitrary: fc.Arbitrary<WaveformReadingSource | null> = fc.option(
  fc.record({
    waveformArtifactId: ulidArbitrary,
    signals: fc.uniqueArray(signalArbitrary, { minLength: 0, maxLength: 5 }),
  }),
  { nil: null },
);

/** An available citation whose source url is unique to the session (scheme `okf`). */
const availableCitationArbitrary: fc.Arbitrary<Citation> = fc
  .record({
    claim: fc.string({ unit: 'grapheme' }),
    id: ulidArbitrary,
    sourceTitle: fc.string({ unit: 'grapheme', minLength: 1 }),
  })
  .map(({ claim, id, sourceTitle }) => ({
    claim,
    sourceUrl: `okf://${id}`,
    sourceTitle,
    presentation: 'cited' as const,
  }));

/** A fabricated citation the session never retrieved (scheme `bad`, fresh id). */
const fabricatedCitationArbitrary: fc.Arbitrary<Citation> = fc
  .record({
    claim: fc.string({ unit: 'grapheme' }),
    id: ulidArbitrary,
    sourceTitle: fc.string({ unit: 'grapheme', minLength: 1 }),
  })
  .map(({ claim, id, sourceTitle }) => ({
    claim,
    sourceUrl: `bad://${id}`,
    sourceTitle,
    presentation: 'cited' as const,
  }));

// -- Statement generation (blank vs meaningful) -----------------------------

/** A statement that is non-empty after trimming (guaranteed to teach something). */
const meaningfulStatement: fc.Arbitrary<string> = fc
  .string({ unit: 'grapheme' })
  .map((suffix) => `claim ${suffix}`);

/** A blank statement, which Teach_Mode must omit (nothing to teach). */
const blankStatement: fc.Arbitrary<string> = fc.constantFrom('', '   ', '\n', '\t  ', '  \n\t ');

/** Mostly-meaningful statements, with a minority of blanks to exercise omission. */
const statementArbitrary: fc.Arbitrary<string> = fc.oneof(
  { weight: 4, arbitrary: meaningfulStatement },
  { weight: 1, arbitrary: blankStatement },
);

// -- Claim generation, dependent on the session ground truth ----------------

/** The concrete session pieces a claim's grounding may (validly) reference. */
interface SessionGround {
  readonly verification: VerificationResult | null;
  readonly waveform: WaveformReadingSource | null;
  readonly traceSpanIds: readonly Ulid[];
  readonly availableCitations: readonly Citation[];
}

/** Tool-output references: a mix of resolving (real) and non-resolving (fabricated). */
function toolOutputRefArbitrary(ground: SessionGround): fc.Arbitrary<ToolOutputRef | null> {
  const options: fc.Arbitrary<ToolOutputRef | null>[] = [
    fc.constant(null),
    // Fabricated oracle-verdict: fresh ids, so it cannot resolve.
    fc
      .record({ verificationResultId: ulidArbitrary, oracleSpanId: ulidArbitrary })
      .map((r) => ({ kind: 'oracle-verdict', ...r })),
    // Fabricated trace-span.
    ulidArbitrary.map((spanId) => ({ kind: 'trace-span', spanId })),
    // Fabricated waveform-reading.
    fc
      .record({ waveformArtifactId: ulidArbitrary, signal: signalArbitrary, atSimTimeNs: fc.nat() })
      .map((r) => ({ kind: 'waveform-reading', ...r })),
  ];
  // A resolving oracle-verdict, only when the session actually has a verdict.
  if (ground.verification !== null) {
    const v = ground.verification;
    options.push(
      fc.constant({
        kind: 'oracle-verdict',
        verificationResultId: v.id,
        oracleSpanId: v.oracleSpanId,
      }),
    );
  }
  // A resolving trace-span, only when the session has recorded spans.
  if (ground.traceSpanIds.length > 0) {
    options.push(
      fc.constantFrom(...ground.traceSpanIds).map((spanId) => ({ kind: 'trace-span', spanId })),
    );
  }
  // A resolving waveform-reading, only when the waveform carries signals.
  if (ground.waveform !== null && ground.waveform.signals.length > 0) {
    const w = ground.waveform;
    options.push(
      fc
        .record({ signal: fc.constantFrom(...w.signals), atSimTimeNs: fc.nat() })
        .map(({ signal, atSimTimeNs }) => ({
          kind: 'waveform-reading',
          waveformArtifactId: w.waveformArtifactId,
          signal,
          atSimTimeNs,
        })),
    );
  }
  return fc.oneof(...options);
}

/** A citation reference: null, a resolving (retrieved) one, or a fabricated one. */
function citationRefArbitrary(ground: SessionGround): fc.Arbitrary<Citation | null> {
  const options: fc.Arbitrary<Citation | null>[] = [fc.constant(null), fabricatedCitationArbitrary];
  if (ground.availableCitations.length > 0) {
    options.push(fc.constantFrom(...ground.availableCitations));
  }
  return fc.oneof(...options);
}

/** One proposed claim (design or general), grounding drawn from the session ground. */
function claimArbitrary(ground: SessionGround): fc.Arbitrary<ProposedClaim> {
  const designClaim: fc.Arbitrary<ProposedClaim> = fc
    .record({ statement: statementArbitrary, grounding: toolOutputRefArbitrary(ground) })
    .map(({ statement, grounding }) => ({ kind: 'design', statement, grounding }));
  const generalFact: fc.Arbitrary<ProposedClaim> = fc
    .record({ statement: statementArbitrary, citation: citationRefArbitrary(ground) })
    .map(({ statement, citation }) => ({ kind: 'general', statement, citation }));
  return fc.oneof(designClaim, generalFact);
}

// -- The full session + proposed-claims scenario ----------------------------

interface Scenario {
  readonly session: TeachSession;
  readonly proposed: readonly ProposedClaim[];
  readonly explanationId: Ulid;
}

const scenarioArbitrary: fc.Arbitrary<Scenario> = fc
  .record({
    sessionId: ulidArbitrary,
    explanationId: ulidArbitrary,
    moduleLabel: moduleLabelArbitrary,
    verification: verificationArbitrary,
    waveform: waveformArbitrary,
    traceSpanIds: fc.uniqueArray(ulidArbitrary, { minLength: 0, maxLength: 4 }),
    availableCitations: fc.array(availableCitationArbitrary, { minLength: 0, maxLength: 4 }),
  })
  .chain((base) => {
    const ground: SessionGround = {
      verification: base.verification,
      waveform: base.waveform,
      traceSpanIds: base.traceSpanIds,
      availableCitations: base.availableCitations,
    };
    const session: TeachSession = {
      sessionId: base.sessionId,
      spec: anchorSpec(),
      moduleLabel: base.moduleLabel,
      verification: base.verification,
      waveform: base.waveform,
      traceSpanIds: base.traceSpanIds,
      availableCitations: base.availableCitations,
    };
    return fc
      .array(claimArbitrary(ground), { minLength: 0, maxLength: 8 })
      .map((proposed) => ({ session, proposed, explanationId: base.explanationId }));
  });

// -- Independent expectation oracle (never consults the code under test) -----

/** Independently: does a design claim's tool-output reference resolve in the session? */
function designGroundingResolves(ref: ToolOutputRef | null, session: TeachSession): boolean {
  if (ref === null) {
    return false;
  }
  switch (ref.kind) {
    case 'oracle-verdict':
      return (
        session.verification !== null &&
        ref.verificationResultId === session.verification.id &&
        ref.oracleSpanId === session.verification.oracleSpanId
      );
    case 'trace-span':
      return session.traceSpanIds.includes(ref.spanId);
    case 'waveform-reading':
      return (
        session.waveform !== null &&
        ref.waveformArtifactId === session.waveform.waveformArtifactId &&
        session.waveform.signals.includes(ref.signal)
      );
    default: {
      const unreachable: never = ref;
      return unreachable;
    }
  }
}

/** Independently: did the session actually retrieve this citation? */
function citationRetrieved(citation: Citation | null, session: TeachSession): boolean {
  if (citation === null) {
    return false;
  }
  return session.availableCitations.some(
    (available) =>
      available.sourceUrl === citation.sourceUrl && available.sourceTitle === citation.sourceTitle,
  );
}

type ExpectedDisposition = 'taught' | 'unverified' | 'omitted';

/** The disposition the property demands for one proposed claim (Req 11.2, 11.6, 11.9). */
function expectedDisposition(claim: ProposedClaim, session: TeachSession): ExpectedDisposition {
  if (claim.statement.trim().length === 0) {
    return 'omitted';
  }
  if (claim.kind === 'design') {
    return designGroundingResolves(claim.grounding, session) ? 'taught' : 'unverified';
  }
  return citationRetrieved(claim.citation, session) ? 'taught' : 'unverified';
}

/** Independently: should a `Verified` result be presented for this session (Req 11.5)? */
function expectVerifiedPresented(session: TeachSession): boolean {
  return (
    session.moduleLabel.tier === 'Verified' &&
    session.verification !== null &&
    session.verification.verdict === 'pass'
  );
}

/** Independently: should the failing case be coached for this session (Req 11.4)? */
function expectCoaching(session: TeachSession): boolean {
  return session.verification !== null && session.verification.verdict !== 'pass';
}

// -- Per-claim structural assertions ----------------------------------------

/** Assert one grounded/ungrounded/omitted decision matches its independent expectation. */
function assertClaimDecision(
  claim: ProposedClaim,
  decision: ClaimDecision,
  session: TeachSession,
): void {
  const expected = expectedDisposition(claim, session);
  expect(decision.disposition).toBe(expected);
  // The claim kind is always preserved.
  expect(decision.kind).toBe(claim.kind);

  if (decision.disposition === 'taught') {
    // A taught claim carries the grounding appropriate to its type, and nothing else.
    if (decision.kind === 'design') {
      expect(designGroundingResolves(decision.grounding, session)).toBe(true);
    } else {
      expect(citationRetrieved(decision.citation, session)).toBe(true);
    }
    return;
  }
  if (decision.disposition === 'unverified') {
    // Ungrounded claims are labeled Unverified and never presented as correct.
    expect(decision.label.tier).toBe('Unverified');
    return;
  }
  // Omitted only ever happens for a blank statement (nothing to teach).
  expect(claim.statement.trim().length).toBe(0);
}

// -- Property 25.A: each claim is grounded by its type ----------------------

describe(`${PROPERTY} (each claim taught iff grounded by its own type)`, () => {
  it('teaches a claim only when its type-appropriate grounding resolves in the session', () => {
    fc.assert(
      fc.property(scenarioArbitrary, ({ session, proposed, explanationId }) => {
        const explanation = assembleExplanation(session, proposed, explanationId);

        // Order and count are preserved: one decision per proposed claim, index-aligned.
        expect(explanation.claims).toHaveLength(proposed.length);

        proposed.forEach((claim, index) => {
          const decision = explanation.claims[index];
          expect(decision).toBeDefined();
          if (decision === undefined) {
            return;
          }
          assertClaimDecision(claim, decision, session);
        });

        // No design claim is ever grounded by a citation and no general fact by tool
        // output: a `taught` decision structurally carries only its own grounding
        // (Req 11.7), which the discriminated union guarantees and we re-check here.
        for (const decision of explanation.claims) {
          if (decision.disposition === 'taught' && decision.kind === 'design') {
            expect('grounding' in decision).toBe(true);
          }
          if (decision.disposition === 'taught' && decision.kind === 'general') {
            expect('citation' in decision).toBe(true);
          }
        }
      }),
      propertyParameters(),
    );
  });

  it('never presents an ungrounded, non-blank claim as correct (labels it Unverified)', () => {
    fc.assert(
      fc.property(scenarioArbitrary, ({ session, proposed, explanationId }) => {
        const explanation = assembleExplanation(session, proposed, explanationId);
        proposed.forEach((claim, index) => {
          const decision = explanation.claims[index];
          if (decision === undefined) {
            return;
          }
          const grounded =
            claim.kind === 'design'
              ? designGroundingResolves(claim.grounding, session)
              : citationRetrieved(claim.citation, session);
          if (!grounded && claim.statement.trim().length > 0) {
            expect(decision.disposition).toBe('unverified');
            expect(decision.disposition).not.toBe('taught');
          }
        });
      }),
      propertyParameters(),
    );
  });

  it('allows both grounding types to appear together in one explanation (Req 11.8)', () => {
    fc.assert(
      fc.property(scenarioArbitrary, ({ session, proposed, explanationId }) => {
        const explanation = assembleExplanation(session, proposed, explanationId);
        // Whenever the proposal contains a taught design claim and a taught general
        // fact, both survive grounding side by side - neither type is dropped for the
        // other. The counts of taught claims match the independent expectation exactly.
        const expectedTaughtDesign = proposed.filter(
          (c) => c.kind === 'design' && expectedDisposition(c, session) === 'taught',
        ).length;
        const expectedTaughtGeneral = proposed.filter(
          (c) => c.kind === 'general' && expectedDisposition(c, session) === 'taught',
        ).length;
        const taughtDesign = explanation.claims.filter(
          (d) => d.disposition === 'taught' && d.kind === 'design',
        ).length;
        const taughtGeneral = explanation.claims.filter(
          (d) => d.disposition === 'taught' && d.kind === 'general',
        ).length;
        expect(taughtDesign).toBe(expectedTaughtDesign);
        expect(taughtGeneral).toBe(expectedTaughtGeneral);
      }),
      propertyParameters(),
    );
  });
});

// -- Property 25.B: Verified presentation and its mandatory limit -----------

describe(`${PROPERTY} (Verified result carries the simulation-vs-silicon limit)`, () => {
  it('presents a Verified result with the limit iff the module is Verified and passed', () => {
    fc.assert(
      fc.property(scenarioArbitrary, ({ session, proposed, explanationId }) => {
        const explanation = assembleExplanation(session, proposed, explanationId);
        const expectPresented = expectVerifiedPresented(session);

        expect(explanation.verifiedResult !== null).toBe(expectPresented);
        // The explanation delegates to the pure presenter; the two must agree.
        expect(explanation.verifiedResult).toEqual(presentVerifiedResult(session));

        if (explanation.verifiedResult !== null) {
          // The limit statement is present and is exactly the canonical text (Req 11.5).
          expect(explanation.verifiedResult.simulationVsSiliconLimit).toBe(
            SIMULATION_VS_SILICON_LIMIT,
          );
          expect(explanation.verifiedResult.verdict).toBe('pass');
          // The presentation is grounded in the actual passing oracle verdict.
          expect(explanation.verifiedResult.grounding.kind).toBe('oracle-verdict');
          if (
            explanation.verifiedResult.grounding.kind === 'oracle-verdict' &&
            session.verification !== null
          ) {
            expect(explanation.verifiedResult.grounding.verificationResultId).toBe(
              session.verification.id,
            );
            expect(explanation.verifiedResult.grounding.oracleSpanId).toBe(
              session.verification.oracleSpanId,
            );
          }
        }
      }),
      propertyParameters(),
    );
  });
});

// -- Property 25.C: failing-case coaching on a non-pass ---------------------

describe(`${PROPERTY} (a non-pass verification is coached, not hidden)`, () => {
  it('coaches the failing case iff a recorded verification did not pass', () => {
    fc.assert(
      fc.property(scenarioArbitrary, ({ session, proposed, explanationId }) => {
        const explanation = assembleExplanation(session, proposed, explanationId);
        const expectCoached = expectCoaching(session);

        expect(explanation.coaching !== null).toBe(expectCoached);
        expect(explanation.coaching).toEqual(coachFailingCase(session));

        if (explanation.coaching !== null && session.verification !== null) {
          // Coaching reports the real non-pass verdict, grounded in its oracle span.
          expect(explanation.coaching.verdict).toBe(session.verification.verdict);
          expect(explanation.coaching.verdict).not.toBe('pass');
          expect(explanation.coaching.grounding.kind).toBe('oracle-verdict');
          expect(explanation.coaching.guidance.length).toBeGreaterThan(0);
        }
      }),
      propertyParameters(),
    );
  });
});
