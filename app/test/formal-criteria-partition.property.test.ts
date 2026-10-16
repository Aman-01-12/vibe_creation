// formal-property-oracle, Property 17: The expressed and unexpressed criteria partition the Spec's
// criteria (task 9.2).
//
// WHAT IS CLAIMED, OVER WHAT
//   Over generated approved Specs, each paired with a model reply generated to try to break the
//   partition, the `FormalPropertySet` the REAL Property_Author returns satisfies four halves:
//     1. every emitted Formal_Property names a criterion of THIS Spec (Req 6.14, 6.15);
//     2. no criterion is on both sides, so the expressed and unexpressed sets do not overlap;
//     3. the two sides together name exactly the Spec's criteria, nothing extra, nothing missing;
//     4. every criterion is named exactly once, so none is lost and none doubled within a side,
//        which is Req 6.17's "one Formal_Property per acceptance criterion".
//   The four halves alone also hold for an author that reports EVERY criterion unexpressed, and
//   for an author that retries from a later draft, so they are not the whole claim. Each
//   criterion's OUTCOME is also compared against the outcome its FIRST draft decides, read from
//   the generator's own PLAN of the reply - never from the author's output, and never by
//   re-running its partition: the side, the expressions an expressed criterion carries, and the
//   reason and the validator's own rejection an unexpressed one carries. No later draft is ever
//   read, so no weaker property stands in for a criterion the author could not express
//   (Req 6.17). And no criterion carries more than one property, asserted directly.
//
// THE REAL AUTHOR, A SCRIPTED ROUTER
//   Every case drives `PropertyAgent#propertySetFor`, the entry point the Verification_Loop
//   calls, which delegates to `derivePropertySet`. The only double is the Model_Router, which
//   hands back the generated reply as provider text, so the untrusted-output boundary, the
//   Property_Validator, and the partition all run as they do in production. The Spec generator,
//   the ULID generator, and the router double are LOCAL, because the equivalents in
//   `testbench-rtl-isolation.property.test.ts` are module-private; the interface comes from
//   `arbDesignInterface()`, whose clock names are drawn from a dialect-safe pool.
//
// WHAT THE AUTHOR MUST DO WITH EACH REPLY SHAPE, AND WHERE THAT IS STATED
//   - A criterion the reply omits (the none and subset shapes) is unexpressed: the property's
//     own "cover every criterion" leaves it no other side, and Req 6.17 says so.
//   - A criterion whose first draft is expressible is expressed, by exactly one property built
//     from THAT draft's expressions (Req 6.17). In the every shape, the full case, that is every
//     criterion.
//   - A criterion whose first draft is inexpressible is unexpressed, and no property is emitted
//     for it (Req 6.17, "rather than emitting a weaker property in its place"), whatever its later
//     drafts say. A draft is inexpressible when the validator refuses its consequent or its
//     antecedent, which is reported `dialect-refused` and carries the validator's own rejection,
//     or when it is clocked on an interface that declares no clock, which is reported
//     `no-clock-declared`, because the dialect's clocked form needs one (Req 6.1).
//   - A draft naming an id the Spec does not have - a fresh id, or a near miss of a real one - is
//     never emitted (Req 6.14, 6.15), and moves no real criterion off the side its own drafts
//     decide: dropping the whole reply over it would leave expressible criteria unexpressed,
//     which Req 6.17 forbids.
//   - More than one draft for one criterion still yields at most one property (Req 6.17).
//
// THE FIRST-DRAFT RULE, NOW PINNED (TASK 22.2)
//   An inexpressible FIRST draft followed by an expressible one was left UNPINNED by task 9.2,
//   because Req 6.17 then read both ways on it. Execution question E10 decided it and Req 6.17
//   now says it: the author considers ONLY the first draft the model emitted for a criterion,
//   and reports the criterion unexpressed where that draft is rejected, rather than trying the
//   next, because a later draft is exactly the weaker fallback Requirement 10 exists to catch
//   (`property-agent.ts`, rule 2). This file pins it, in the direction a partition check cannot
//   see: a retrying author leaves every half of `expectPartition` holding, since the retried
//   criterion still lands on exactly one side, and only the per-criterion outcome check against
//   the first draft sees that it landed on the WRONG one. The same check pins the other half of
//   the rule, that an accepted first draft's expressions and never a later draft's are what land
//   on the property.
//
//   For that to be observable the generator must control emission order, and it does: the
//   parser returns drafts in the model's own order (`model-output.ts`), so `DRAFT_ORDERS` lists
//   every sequence of two or three outcomes for one criterion, accepted or rejected, and the
//   drafts of one criterion are written in exactly that order. Their content is pairwise
//   different, since a later draft that surfaced in place of the first could not be told from it
//   otherwise.
//
// THE CHANNEL THIS FILE DELIBERATELY DOES NOT GENERATE
//   The first-draft rule has a second channel: a criterion whose FIRST entry is MALFORMED, so the
//   boundary drops it, while a LATER entry for the same criterion is readable, which makes the
//   later entry "the first draft the author sees". Req 6.17 is worded over the Property_Validator's
//   rejection, so no requirement decides that case, and this file must not pin either reading of
//   it (`chipAgent/_inbox/gotcha-the-first-draft-rule-has-a-second-channel-a-malformed-first-entry-promotes-a-later-readable-draft.md`).
//   Every entry generated here is READABLE, so a first draft can fail only through the
//   validator's rejection or the clockless-interface rejection, and `expectEveryEntryReadable`
//   asserts it on every case, so a generator change that slipped a malformed entry in would fail
//   loudly rather than quietly pin an undecided question.
//
// NON-VACUITY AND RUN COUNT
//   The six reply shapes and the twelve draft orders are CLOSED lists, so each is EXHAUSTED with
//   its own `fc.assert` at the shared 100 runs rather than sampled
//   (`chipAgent/_inbox/gotcha-a-closed-union-non-vacuity-row-should-be-exhausted-not-sampled.md`),
//   and a tally per order fails the run if an order drew nothing. Within a shape or an order the
//   reply is random, and `COVERAGE_ROWS` names every case the claim needs drawn, including the
//   empty and the full replies, each duplicate ordering, both refusal positions, both kinds of
//   foreign id, and the weaker-fallback shape under each of its three ways to fail: a refused
//   consequent, a refused antecedent, and a clocked draft on an unclocked interface. Those three
//   depend on the Spec's clocking, so they are sampled, and sized by the row's own count.
//   Every row is read from the PLAN, so it counts what the author was given rather than what it
//   did, and the run fails if any row was never drawn.
//   Measured over two 1,800-run passes (the 18 asserts), the rarest row overall was a near miss
//   of a real criterion id, drawn 60 times in each; the rarest weaker-fallback row was a refused
//   antecedent first, drawn 88 and 115 times. Taking the count as the expectation, a pass that
//   never draws the rarest has a probability of about e^-60, and e^-88 for the rarest
//   weaker-fallback row.
//
// FALSIFIED WITHOUT EDITING THE AUTHOR
//   `expectPartition` and the task 9.2 side check were each fed deliberately broken sets in a
//   scratch test inside this file - a dropped criterion, a criterion on both sides, a property
//   naming a foreign id, a criterion doubled within one side, every criterion moved to
//   unexpressed, and a weakened consequent - and every one went red, naming its half. The
//   all-unexpressed set PASSED `expectPartition` and only the side check caught it, which is why
//   both exist. The scratch test was then removed, and no shared source file was touched
//   (`chipAgent/_inbox/gotcha-a-scratch-script-exit-trap-does-not-run-when-the-agent-tool-kills-the-shell.md`).
//
//   Task 22.2 keeps its falsification IN the file, as the second test, so it cannot rot:
//   `brokenAuthoredSet` is a local wrapper that submits each draft to the REAL author as a reply
//   of its own and keeps the first the author expresses, which is a retrying author. The
//   assertion that the first draft decides must throw for it in every weaker-fallback order,
//   naming the retry, while the real author passes the same assertion. A second broken author
//   that lets a LATER expressible draft surface must throw in every order with two accepted
//   drafts, which is the direction the task 9.2 check (an emitted property is SOME expressible
//   draft the model wrote) could not see. In a scratch copy, since removed, the assertion also
//   went red for a rejection re-spelled rather than carried through, a rejection dropped, a wrong
//   reason, a property doubled on one criterion, and a malformed entry in the generated reply.
//
// The tag is a literal, not `propertyTag(...)`, whose `FEATURE_TAG` is hardcoded to a different
// spec's property numbering
// (`chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`).
//
// **Validates: Requirements 6.14, 6.15, 6.17**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  InMemorySessionBudgetHandle,
  InMemoryTracePersistence,
  PropertyAgent,
  TraceActionRecorder,
  parsePropertyDrafts,
  type FormalPropertySet,
  type ModelRequest,
  type ModelRouter,
  type ModelRouterFailure,
  type ModelTask,
  type PropertyDraftKind,
  type PropertySetOutcome,
  type RoutedModelResult,
  type RoutingDiagnostics,
  type SessionBudgetHandle,
  type UnexpressedCriterion,
  type UnexpressedReason,
} from '@app/agent';
import {
  makeSessionBudget,
  newUlid,
  type AcceptanceCriterion,
  type AcceptanceMethod,
  type Result,
  type Spec,
  type Ulid,
} from '@app/core';
import {
  MEASURED_REJECTED_FORMS,
  validateExpression,
  type FormalProperty,
  type PropertyRejection,
} from '@app/tools';

import { arbDesignInterface } from './formal-arbitraries.js';
import { timingContractFor } from './generators/timing-contract.js';
import { routedModelIdFor } from './model-router-fixtures.js';
import { propertyParameters } from './property.js';

// **Feature: formal-property-oracle, Property 17: The expressed and unexpressed criteria partition
// the Spec's criteria**
const PROPERTY =
  "formal-property-oracle, Property 17: The expressed and unexpressed criteria partition the Spec's criteria";

/** The fixed wall clock the author records its span timing against. */
const FIXED_NOW_MS = 1_700_000_000_000;

/** The most criteria one generated Spec carries. */
const MAX_CRITERIA = 5;

/**
 * The timeout for a test that exhausts every reply shape and every draft order, 18 `fc.assert`s of
 * 100 cases each. That is about 2 s on an idle machine and was measured past Vitest's 5 s default
 * while other work loaded the machine, so the default is the flake and this is the fix.
 */
const SLOW_PROPERTY_TIMEOUT_MS = 30_000;

// -- Draft text, each pool's verdict confirmed by the validator before it is used ----------------

/**
 * Expressions the Property_Validator accepts in either property form.
 *
 * None is temporal, so a combinational draft built from them is a plain boolean claim rather than
 * a sampled-value function asked of a form that has no clock.
 */
const COMBINATIONAL_EXPRESSIONS: readonly string[] = Object.freeze([
  "1'b1",
  'a == b',
  '!a || b',
  "sum <= 8'd200",
  "(sel & en) != 2'd3",
]);

/** Expressions the validator accepts in a clocked property, sampled-value functions included. */
const CLOCKED_EXPRESSIONS: readonly string[] = Object.freeze([
  ...COMBINATIONAL_EXPRESSIONS,
  'q == $past(d)',
  '!$rose(en) || valid',
  '$stable(cnt) || load',
  '!$past(rst_n) || q == $past(q)',
]);

/**
 * Expressions the validator refuses: every measured rejected form, read from the table rather than
 * re-spelled, plus the hierarchical path that is a measured silent false proof.
 */
const REFUSED_EXPRESSIONS: readonly string[] = Object.freeze([
  ...MEASURED_REJECTED_FORMS.map((form) => `a ${form.construct} b`),
  "dut.cnt <= 4'd8",
]);

// -- The reply plan -------------------------------------------------------------------------------

/** What decides a draft, fixed by which pool its text came from and by the Spec's clocking. */
type DraftVerdict = 'expressible' | 'refused-consequent' | 'refused-antecedent' | 'no-clock';

/** Whose id a draft names: a criterion of the Spec, or one of the two kinds of foreign id. */
type IdOrigin = 'criterion' | 'fresh-id' | 'near-miss-id';

/** One property the scripted model writes, with what the generator knows about it. */
interface DraftPlan {
  readonly criterionId: string;
  readonly kind: PropertyDraftKind;
  readonly antecedent: string | null;
  readonly consequent: string;
  readonly verdict: DraftVerdict;
  readonly idOrigin: IdOrigin;
}

/** A foreign id, and which kind of foreign id it is. */
interface ForeignId {
  readonly id: string;
  readonly origin: Exclude<IdOrigin, 'criterion'>;
}

/** Whether the author can express a draft; the only verdict that admits a property. */
function isExpressible(draft: DraftPlan): boolean {
  return draft.verdict === 'expressible';
}

/** Whether the Spec's interface declares a clock a clocked property could take. */
function declaresClock(spec: Spec): boolean {
  return spec.moduleInterface.clocking.clockName !== null;
}

/** An optional clocked-pool antecedent: `null` is an unconditional clocked property. */
function optionalAntecedent(): fc.Arbitrary<string | null> {
  return fc.option(fc.constantFrom(...CLOCKED_EXPRESSIONS), { nil: null });
}

/** A draft the author can express: accepted text, clocked only where the interface has a clock. */
function expressibleDraft(
  criterionId: string,
  hasClock: boolean,
  idOrigin: IdOrigin,
): fc.Arbitrary<DraftPlan> {
  const combinational = fc
    .constantFrom(...COMBINATIONAL_EXPRESSIONS)
    .map((consequent): DraftPlan => ({
      criterionId,
      kind: 'combinational',
      antecedent: null,
      consequent,
      verdict: 'expressible',
      idOrigin,
    }));
  if (!hasClock) {
    return combinational;
  }
  const clocked = fc
    .tuple(optionalAntecedent(), fc.constantFrom(...CLOCKED_EXPRESSIONS))
    .map(([antecedent, consequent]): DraftPlan => ({
      criterionId,
      kind: 'clocked',
      antecedent,
      consequent,
      verdict: 'expressible',
      idOrigin,
    }));
  return fc.oneof(clocked, combinational);
}

/**
 * A draft carrying exactly one expression the validator refuses, so its verdict names what decides
 * it. The antecedent is refused only on a clocked interface, where the author reaches it.
 */
function refusedDraft(criterionId: string, hasClock: boolean): fc.Arbitrary<DraftPlan> {
  const refused = fc.constantFrom(...REFUSED_EXPRESSIONS);
  const accepted = fc.constantFrom(...CLOCKED_EXPRESSIONS);
  const draft = (
    kind: PropertyDraftKind,
    antecedent: string | null,
    consequent: string,
    verdict: DraftVerdict,
  ): DraftPlan => ({ criterionId, kind, antecedent, consequent, verdict, idOrigin: 'criterion' });
  const combinational = refused.map((text) =>
    draft('combinational', null, text, 'refused-consequent'),
  );
  if (!hasClock) {
    return combinational;
  }
  return fc.oneof(
    combinational,
    fc
      .tuple(optionalAntecedent(), refused)
      .map(([antecedent, text]) => draft('clocked', antecedent, text, 'refused-consequent')),
    fc
      .tuple(refused, accepted)
      .map(([text, consequent]) => draft('clocked', text, consequent, 'refused-antecedent')),
  );
}

/** A clocked draft of accepted text, for an interface that declares no clock to clock it on. */
function unclockedDraft(criterionId: string): fc.Arbitrary<DraftPlan> {
  return fc
    .tuple(optionalAntecedent(), fc.constantFrom(...CLOCKED_EXPRESSIONS))
    .map(([antecedent, consequent]): DraftPlan => ({
      criterionId,
      kind: 'clocked',
      antecedent,
      consequent,
      verdict: 'no-clock',
      idOrigin: 'criterion',
    }));
}

/**
 * A draft the author cannot express, every way it can fail: the validator refuses an expression,
 * or the draft is clocked on an interface that declares no clock.
 */
function inexpressibleDraft(criterionId: string, hasClock: boolean): fc.Arbitrary<DraftPlan> {
  return hasClock
    ? refusedDraft(criterionId, true)
    : fc.oneof(refusedDraft(criterionId, false), unclockedDraft(criterionId));
}

/** Any draft for one criterion, expressible half the time, so each duplicate ordering is common. */
function anyDraft(criterionId: string, hasClock: boolean): fc.Arbitrary<DraftPlan> {
  return fc.oneof(
    expressibleDraft(criterionId, hasClock, 'criterion'),
    inexpressibleDraft(criterionId, hasClock),
  );
}

// -- Controlled draft orders ----------------------------------------------------------------------

/** How a draft comes out: the author can express it, or it cannot. */
type DraftOutcome = 'accepted' | 'rejected';

/** The outcomes of one criterion's drafts, in the order the model emits them. */
type DraftOrder = readonly DraftOutcome[];

/** The fewest and the most drafts one criterion gets in a controlled order. */
const ORDERED_DRAFT_COUNTS: readonly number[] = Object.freeze([2, 3]);

/** Every sequence of `length` outcomes, so the list of orders is complete by construction. */
function sequencesOf(length: number): DraftOrder[] {
  if (length === 0) {
    return [[]];
  }
  return sequencesOf(length - 1).flatMap((prefix): DraftOrder[] => [
    [...prefix, 'accepted'],
    [...prefix, 'rejected'],
  ]);
}

/**
 * Every order of two or three drafts for one criterion, a CLOSED list exhausted one `fc.assert`
 * each. It holds the four shapes the first-draft rule is about: rejected then accepted (the weaker
 * fallback), accepted then rejected, both accepted, and both rejected, each with a third draft too.
 */
const DRAFT_ORDERS: readonly DraftOrder[] = Object.freeze(
  ORDERED_DRAFT_COUNTS.flatMap((count) => sequencesOf(count)),
);

/** The order as a label, for a failure message and a tally key. */
function orderLabel(order: DraftOrder): string {
  return order.join(' then ');
}

/** Whether the first draft fails and a later one is accepted: the weaker-fallback shape. */
function isWeakerFallbackOrder(order: DraftOrder): boolean {
  return order[0] === 'rejected' && order.includes('accepted');
}

/** Whether the first draft is accepted and a later one is accepted too. */
function isSecondAcceptedOrder(order: DraftOrder): boolean {
  return order[0] === 'accepted' && order.slice(1).includes('accepted');
}

/** A key that is equal for two drafts exactly when they say the same thing. */
function contentKey(draft: DraftPlan): string {
  return JSON.stringify([draft.kind, draft.antecedent, draft.consequent]);
}

/**
 * One criterion's drafts in exactly the order `order` names. Their content is pairwise different,
 * because a later draft that surfaced in place of the first could not be told from it otherwise.
 *
 * Every draft is READABLE by the boundary (`shapeDraft`): see the header on why no malformed entry
 * is generated.
 */
function draftsInOrder(
  criterionId: string,
  hasClock: boolean,
  order: DraftOrder,
): fc.Arbitrary<DraftPlan[]> {
  return fc
    .tuple(
      ...order.map((outcome) =>
        outcome === 'accepted'
          ? expressibleDraft(criterionId, hasClock, 'criterion')
          : inexpressibleDraft(criterionId, hasClock),
      ),
    )
    .filter((drafts) => new Set(drafts.map(contentKey)).size === drafts.length);
}

/** Merge per-criterion draft lists in a random order that keeps each list's own order. */
function interleaved(lists: readonly (readonly DraftPlan[])[]): fc.Arbitrary<DraftPlan[]> {
  const slots = lists.flatMap((list, index) => list.map(() => index));
  return fc
    .shuffledSubarray(slots, { minLength: slots.length, maxLength: slots.length })
    .map((slotOrder) => {
      const queues = lists.map((list) => [...list]);
      return slotOrder.flatMap((index) => queues[index]?.splice(0, 1) ?? []);
    });
}

// -- Ids and Specs --------------------------------------------------------------------------------

/** Crockford base32, the ULID alphabet (no I, L, O, U). */
const CROCKFORD_CHARS = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'.split('');
/** The valid first characters of a 48-bit ULID timestamp. */
const ULID_HEAD_CHARS = '01234567'.split('');

/** A syntactically valid, shrinkable 26-character ULID. */
function ulidArbitrary(): fc.Arbitrary<Ulid> {
  return fc
    .tuple(
      fc.constantFrom(...ULID_HEAD_CHARS),
      fc.array(fc.constantFrom(...CROCKFORD_CHARS), { minLength: 25, maxLength: 25 }),
    )
    .map(([head, rest]) => `${head}${rest.join('')}`);
}

/**
 * A near miss of a real criterion id - one character short, or its last character changed - which
 * only an exact match refuses.
 */
function nearMissIdArbitrary(realIds: readonly string[]): fc.Arbitrary<ForeignId> {
  return fc
    .tuple(fc.constantFrom(...realIds), fc.boolean(), fc.constantFrom(...CROCKFORD_CHARS))
    .map(([id, truncate, last]): ForeignId => ({
      id: truncate ? id.slice(0, -1) : `${id.slice(0, -1)}${last}`,
      origin: 'near-miss-id',
    }));
}

/** An id the Spec does not have: a fresh ULID, or a near miss of one of its own criterion ids. */
function foreignIdArbitrary(spec: Spec): fc.Arbitrary<ForeignId> {
  const realIds = spec.acceptanceCriteria.map((criterion) => criterion.id);
  const own = new Set(realIds);
  const fresh = ulidArbitrary().map((id): ForeignId => ({ id, origin: 'fresh-id' }));
  const candidates = realIds.length === 0 ? fresh : fc.oneof(fresh, nearMissIdArbitrary(realIds));
  return candidates.filter(({ id }) => !own.has(id));
}

/** A draft naming a foreign id. Its text is EXPRESSIBLE, so only the id can keep it out. */
function foreignDraft(spec: Spec): fc.Arbitrary<DraftPlan> {
  return foreignIdArbitrary(spec).chain(({ id, origin }) =>
    expressibleDraft(id, declaresClock(spec), origin),
  );
}

/**
 * Every `AcceptanceMethod`, from a TOTAL map, so a fourth method is a compile error here rather
 * than a value the generator silently never produces.
 */
const ACCEPTANCE_METHOD_MEMBERS: Readonly<Record<AcceptanceMethod, true>> = {
  simulation: true,
  formal: true,
  'manual-inspection': true,
};
const ACCEPTANCE_METHODS = Object.keys(ACCEPTANCE_METHOD_MEMBERS) as AcceptanceMethod[];

/** Free text for the Spec's prose fields, none of which the partition reads. */
const PHRASES: readonly string[] = Object.freeze([
  'q follows d on every clock edge',
  'the sum never exceeds two hundred',
  'valid rises one cycle after load',
  'cnt holds while en is low',
  'sel picks a or b',
]);

/**
 * One acceptance criterion, its method and measurability varied, so an author that partitioned
 * only some kinds of criterion would lose the rest.
 */
function criterionArbitrary(): fc.Arbitrary<AcceptanceCriterion> {
  return fc.record({
    id: ulidArbitrary(),
    text: fc.constantFrom(...PHRASES),
    measurable: fc.boolean(),
    method: fc.constantFrom(...ACCEPTANCE_METHODS),
  });
}

/** An approved Spec carrying `minCriteria` to `MAX_CRITERIA` criteria with distinct ids. */
function specArbitrary(minCriteria: number): fc.Arbitrary<Spec> {
  return fc
    .record({
      id: ulidArbitrary(),
      projectId: ulidArbitrary(),
      goal: fc.constantFrom(...PHRASES),
      constraints: fc.array(fc.constantFrom(...PHRASES), { maxLength: 2 }),
      moduleInterface: arbDesignInterface(),
      acceptanceCriteria: fc.uniqueArray(criterionArbitrary(), {
        selector: (criterion) => criterion.id,
        minLength: minCriteria,
        maxLength: MAX_CRITERIA,
      }),
      architecture: fc.constantFrom(...PHRASES),
      approved: fc.constant(true),
      version: fc.integer({ min: 1, max: 12 }),
    })
    .map((fields) => ({ ...fields, timingContract: timingContractFor(fields.moduleInterface) }));
}

// -- Reply shapes ---------------------------------------------------------------------------------

/** The reply shapes the partition must hold under, a closed list exhausted one `fc.assert` each. */
const REPLY_SHAPES = Object.freeze([
  'none',
  'every',
  'subset',
  'duplicate',
  'foreign-id',
  'refused',
] as const);

/** One of {@link REPLY_SHAPES}. */
type ReplyShape = (typeof REPLY_SHAPES)[number];

/** Each shape's fewest criteria, so a shape never degenerates into a different one. */
const MIN_CRITERIA: Readonly<Record<ReplyShape, number>> = {
  none: 0,
  every: 1,
  subset: 2,
  duplicate: 1,
  'foreign-id': 0,
  refused: 1,
};

/** Concatenate each criterion's drafts in criterion order; the case shuffles them afterwards. */
function draftsPer(
  criteria: readonly AcceptanceCriterion[],
  draftsFor: (criterion: AcceptanceCriterion, index: number) => fc.Arbitrary<DraftPlan[]>,
): fc.Arbitrary<DraftPlan[]> {
  return fc.tuple(...criteria.map(draftsFor)).map((lists) => lists.flat());
}

/** Exactly one expressible draft for each of `criteria`, and none for any other criterion. */
function oneExpressibleEach(
  spec: Spec,
  criteria: readonly AcceptanceCriterion[],
): fc.Arbitrary<DraftPlan[]> {
  return draftsPer(criteria, (criterion) =>
    expressibleDraft(criterion.id, declaresClock(spec), 'criterion').map((draft) => [draft]),
  );
}

/** A random criterion gets `forced`; every other criterion gets up to `othersMax` of any kind. */
function withForcedCriterion(
  spec: Spec,
  forced: (criterionId: string) => fc.Arbitrary<DraftPlan[]>,
  othersMax: number,
): fc.Arbitrary<DraftPlan[]> {
  const hasClock = declaresClock(spec);
  return fc
    .nat({ max: spec.acceptanceCriteria.length - 1 })
    .chain((chosen) =>
      draftsPer(spec.acceptanceCriteria, (criterion, index) =>
        index === chosen
          ? forced(criterion.id)
          : fc.array(anyDraft(criterion.id, hasClock), { maxLength: othersMax }),
      ),
    );
}

/** Each shape's reply for a given Spec, before it is shuffled. */
const PLAN_FOR: Readonly<Record<ReplyShape, (spec: Spec) => fc.Arbitrary<DraftPlan[]>>> = {
  none: () => fc.constant<DraftPlan[]>([]),
  every: (spec) => oneExpressibleEach(spec, spec.acceptanceCriteria),
  subset: (spec) =>
    fc
      .subarray([...spec.acceptanceCriteria], {
        minLength: 1,
        maxLength: spec.acceptanceCriteria.length - 1,
      })
      .chain((chosen) => oneExpressibleEach(spec, chosen)),
  duplicate: (spec) =>
    withForcedCriterion(
      spec,
      (criterionId) =>
        fc.array(anyDraft(criterionId, declaresClock(spec)), { minLength: 2, maxLength: 3 }),
      2,
    ),
  'foreign-id': (spec) =>
    fc
      .tuple(
        draftsPer(spec.acceptanceCriteria, (criterion) =>
          fc.array(anyDraft(criterion.id, declaresClock(spec)), { maxLength: 1 }),
        ),
        fc.array(foreignDraft(spec), { minLength: 1, maxLength: 3 }),
      )
      .map(([own, foreign]) => [...own, ...foreign]),
  refused: (spec) =>
    withForcedCriterion(
      spec,
      (criterionId) =>
        fc.array(refusedDraft(criterionId, declaresClock(spec)), { minLength: 1, maxLength: 2 }),
      1,
    ),
};

/** One generated case: the shape it was drawn under, the Spec, and the reply in reply order. */
interface PlannedCase {
  readonly shape: ReplyShape | 'ordered-drafts';
  readonly spec: Spec;
  readonly plan: readonly DraftPlan[];
}

/** A case of `shape`, its drafts shuffled so which draft comes first is generated, not fixed. */
function caseArbitrary(shape: ReplyShape): fc.Arbitrary<PlannedCase> {
  return specArbitrary(MIN_CRITERIA[shape]).chain((spec) =>
    PLAN_FOR[shape](spec)
      .chain((drafts) =>
        fc.shuffledSubarray(drafts, { minLength: drafts.length, maxLength: drafts.length }),
      )
      .map((plan) => ({ shape, spec, plan })),
  );
}

/**
 * A case where ONE random criterion's drafts are written in exactly `order`, and the other
 * criteria's drafts are interleaved among them. The shuffle `caseArbitrary` applies would scramble
 * the order under test, so the merge here keeps each criterion's own order.
 */
function orderedCaseArbitrary(order: DraftOrder): fc.Arbitrary<PlannedCase> {
  return specArbitrary(1).chain((spec) => {
    const hasClock = declaresClock(spec);
    return fc
      .nat({ max: spec.acceptanceCriteria.length - 1 })
      .chain((chosen) =>
        fc.tuple(
          ...spec.acceptanceCriteria.map((criterion, index) =>
            index === chosen
              ? draftsInOrder(criterion.id, hasClock, order)
              : fc.array(anyDraft(criterion.id, hasClock), { maxLength: 2 }),
          ),
        ),
      )
      .chain(interleaved)
      .map((plan): PlannedCase => ({ shape: 'ordered-drafts', spec, plan }));
  });
}

/** The entries the scripted model writes: exactly the planned drafts, in plan order. */
function entriesOf(plan: readonly DraftPlan[]): readonly Omit<DraftPlan, 'verdict' | 'idOrigin'>[] {
  return plan.map(({ criterionId, kind, antecedent, consequent }) => ({
    criterionId,
    kind,
    antecedent,
    consequent,
  }));
}

/** The scripted model's reply: exactly the planned drafts, in plan order, as provider text. */
function replyText(plan: readonly DraftPlan[]): string {
  return JSON.stringify({ properties: entriesOf(plan) });
}

// -- The author under test, behind one scripted seam ----------------------------------------------

/** A Model_Router double returning one scripted reply, charged to the caller's budget. */
class ScriptedModelRouter implements ModelRouter {
  constructor(private readonly outputText: string) {}

  invoke(
    task: ModelTask,
    request: ModelRequest,
    budget: SessionBudgetHandle,
  ): Promise<Result<RoutedModelResult, ModelRouterFailure>> {
    // The request is model input, which the partition does not depend on.
    void request;
    budget.charge({ tokens: 1, costCents: 0, wallClockMs: 1 });
    return Promise.resolve({
      ok: true,
      value: {
        task,
        provider: 'deepseek',
        modelId: routedModelIdFor('deepseek'),
        outputText: this.outputText,
        tokensUsed: 16,
        costCents: 1,
        attempts: 1,
        fellBack: false,
      },
    });
  }

  describeRouting(): RoutingDiagnostics {
    return { tasks: [], providers: [] };
  }
}

/** A generous budget, so the scripted reply and not the budget decides the derivation. */
function generousBudget(): SessionBudgetHandle {
  const built = makeSessionBudget({
    sessionId: newUlid(),
    maxIterations: 1000,
    maxTokens: 1_000_000,
    maxWallClockMs: 1_000_000,
    maxCostCents: 1_000_000,
    consumedIterations: 0,
    consumedTokens: 0,
    consumedMs: 0,
    consumedCostCents: 0,
  });
  if (!built.ok) {
    throw new Error('test budget must be valid');
  }
  return new InMemorySessionBudgetHandle(built.value);
}

/** The REAL Property_Author's set for `spec`, through the entry point the loop calls. */
function authoredSetFor(spec: Spec, reply: string): Promise<PropertySetOutcome> {
  const author = new PropertyAgent({
    router: new ScriptedModelRouter(reply),
    recorder: new TraceActionRecorder(new InMemoryTracePersistence()),
    now: () => FIXED_NOW_MS,
  });
  return author.propertySetFor(spec, generousBudget());
}

// -- The claim ------------------------------------------------------------------------------------

/**
 * Assert Property 17's four halves over one returned set, given the Spec's criterion ids.
 *
 * Each half is its own assertion, so a failure names the half that broke. This helper and the next
 * are the whole claim, which is why they were the ones falsified (see the header).
 */
function expectPartition(criterionIds: readonly string[], set: FormalPropertySet): void {
  const own = new Set(criterionIds);
  const expressed = set.properties.map((property) => property.criterionRef);
  const unexpressed = set.unexpressedCriteria;
  expect(
    expressed.filter((id) => !own.has(id)),
    'an emitted property names no criterion of this Spec',
  ).toEqual([]);
  expect(
    expressed.filter((id) => unexpressed.includes(id)),
    'a criterion is on both sides',
  ).toEqual([]);
  expect(
    [...new Set([...expressed, ...unexpressed])].sort(),
    "the two sides do not name exactly the Spec's criteria",
  ).toEqual([...own].sort());
  expect([...expressed, ...unexpressed].sort(), 'a criterion is not named exactly once').toEqual(
    [...criterionIds].sort(),
  );
}

/**
 * Assert no criterion carries more than one Formal_Property (Req 6.17), directly rather than as a
 * consequence of the four halves.
 */
function expectAtMostOnePropertyPerCriterion(set: FormalPropertySet): void {
  const references = set.properties.map((property) => property.criterionRef);
  expect(
    references.filter((id, index) => references.indexOf(id) !== index),
    'a criterion carries more than one Formal_Property',
  ).toEqual([]);
}

/** The drafts naming `criterionId`, in reply order. */
function draftsNaming(plan: readonly DraftPlan[], criterionId: string): readonly DraftPlan[] {
  return plan.filter((draft) => draft.criterionId === criterionId);
}

/** Whether a criterion's FIRST draft is inexpressible and a LATER one is expressible. */
function isWeakerFallback(drafts: readonly DraftPlan[]): boolean {
  const [first, ...later] = drafts;
  return first !== undefined && !isExpressible(first) && later.some(isExpressible);
}

/** The fields a property is compared on: its form, its clock, and its expressions. */
interface PropertyContent {
  readonly kind: PropertyDraftKind;
  readonly clock: string | null;
  readonly antecedent: string | null;
  readonly consequent: string;
}

/** What the author emitted, in the shape a draft is compared in. */
function emittedContent(property: FormalProperty): PropertyContent {
  return property.kind === 'clocked'
    ? {
        kind: 'clocked',
        clock: property.clock,
        antecedent: property.antecedent,
        consequent: property.consequent,
      }
    : { kind: 'combinational', clock: null, antecedent: null, consequent: property.consequent };
}

/** What the model wrote, with the clock a clocked property takes from the Spec's interface. */
function writtenContent(draft: DraftPlan, clockName: string | null): PropertyContent {
  return {
    kind: draft.kind,
    clock: draft.kind === 'clocked' ? clockName : null,
    antecedent: draft.antecedent,
    consequent: draft.consequent,
  };
}

/** Why the author left a criterion unexpressed, and the validator's refusal where it gave one. */
interface UnexpressedOutcome {
  readonly reason: UnexpressedReason;
  readonly rejection: PropertyRejection | null;
}

/**
 * What one criterion came out as: the properties naming it and the unexpressed entries naming it.
 * The author's claim is exactly one of the two, holding one entry, which is why both are listed.
 */
interface CriterionOutcome {
  readonly properties: readonly PropertyContent[];
  readonly unexpressed: readonly UnexpressedOutcome[];
}

/** An outcome of no property and one unexpressed entry. */
function unexpressedAs(
  reason: UnexpressedReason,
  rejection: PropertyRejection | null,
): CriterionOutcome {
  return { properties: [], unexpressed: [{ reason, rejection }] };
}

/**
 * The refusal the Property_Validator gives a refused draft, read by calling the validator on the
 * text the generator wrote. The author's own refusal is compared against this value, so the
 * validator's rejection is checked to be carried through rather than re-spelled.
 */
function validatorRefusalOf(draft: DraftPlan): PropertyRejection | null {
  const offending = draft.verdict === 'refused-antecedent' ? draft.antecedent : draft.consequent;
  const verdict = offending === null ? null : validateExpression(offending);
  return verdict === null || verdict.ok ? null : verdict.error;
}

/**
 * What the author must make of a criterion: whatever its FIRST draft decides, and nothing else
 * (Req 6.17). A later draft is never read, which is the whole rule.
 */
function requiredOutcomeOf(
  drafts: readonly DraftPlan[],
  clockName: string | null,
): CriterionOutcome {
  const [first] = drafts;
  if (first === undefined) {
    return unexpressedAs('no-property-emitted', null);
  }
  switch (first.verdict) {
    case 'expressible':
      return { properties: [writtenContent(first, clockName)], unexpressed: [] };
    case 'no-clock':
      return unexpressedAs('no-clock-declared', null);
    case 'refused-consequent':
    case 'refused-antecedent':
      return unexpressedAs('dialect-refused', validatorRefusalOf(first));
  }
}

/** What the author actually made of a criterion, in the shape {@link requiredOutcomeOf} gives. */
function actualOutcomeOf(set: PropertySetOutcome, criterionId: string): CriterionOutcome {
  return {
    properties: set.properties
      .filter((property) => property.criterionRef === criterionId)
      .map((property) => emittedContent(property)),
    unexpressed: set.unexpressed
      .filter((entry) => entry.criterionId === criterionId)
      .map(({ reason, rejection }) => ({ reason, rejection: rejection ?? null })),
  };
}

/** One criterion with the drafts written for it and the outcome required against the outcome got. */
interface OutcomeRow {
  readonly drafts: readonly DraftPlan[];
  readonly required: CriterionOutcome;
  readonly actual: CriterionOutcome;
}

/** Each of the Spec's criteria, with what its drafts require of the author and what it did. */
function outcomeRows(
  spec: Spec,
  plan: readonly DraftPlan[],
  set: PropertySetOutcome,
): OutcomeRow[] {
  const { clockName } = spec.moduleInterface.clocking;
  return spec.acceptanceCriteria.map(({ id }) => {
    const drafts = draftsNaming(plan, id);
    return {
      drafts,
      required: requiredOutcomeOf(drafts, clockName),
      actual: actualOutcomeOf(set, id),
    };
  });
}

/**
 * Assert every criterion comes out as its FIRST draft decides (Req 6.17): expressed with that
 * draft's own expressions, or unexpressed with the reason and the validator's own rejection of it.
 *
 * The weaker-fallback rows are asserted first and on their own, because they are the direction a
 * partition check cannot see: a retrying author leaves every half of {@link expectPartition}
 * holding and still swaps a criterion's rejected first draft for a later, weaker one.
 */
function expectOutcomesFollowFirstDrafts(
  spec: Spec,
  plan: readonly DraftPlan[],
  set: PropertySetOutcome,
): void {
  const rows = outcomeRows(spec, plan, set);
  const fallbackRows = rows.filter((row) => isWeakerFallback(row.drafts));
  expect(
    fallbackRows.map((row) => row.actual),
    'a criterion whose first draft was rejected was retried from a later draft',
  ).toEqual(fallbackRows.map((row) => row.required));
  expect(
    rows.map((row) => row.actual),
    'a criterion did not come out as its FIRST draft decides',
  ).toEqual(rows.map((row) => row.required));
  expect(
    set.unexpressed.map((entry) => entry.criterionId),
    'the unexpressed reasons and the unexpressed criteria name different criteria',
  ).toEqual(set.unexpressedCriteria);
}

// -- Broken authors, to falsify the assertion above without touching the real one -----------------

/**
 * Submit `candidates` to the REAL author, one reply of a single draft each, and stop at the first
 * that expresses `criterionId`. The real author does the validating, so the result is a real
 * outcome for whichever draft was kept; with no candidates it is the empty reply's outcome.
 */
async function firstExpressedAttempt(
  spec: Spec,
  criterionId: string,
  candidates: readonly DraftPlan[],
): Promise<PropertySetOutcome> {
  let attempt = await authoredSetFor(spec, replyText([]));
  for (const draft of candidates) {
    // Sequential on purpose: a retry tries the next draft only after the last one failed.
    attempt = await authoredSetFor(spec, replyText([draft]));
    if (attempt.properties.some((property) => property.criterionRef === criterionId)) {
      break;
    }
  }
  return attempt;
}

/**
 * A deliberately broken author: for each criterion it tries the drafts `candidatesOf` picks, in
 * that order, and keeps what the first that the real author can express gives it.
 *
 * `(drafts) => drafts` is a RETRYING author, the one the first-draft rule exists to refuse.
 * Property ids are left as the single-draft replies gave them, since no assertion reads them.
 */
async function brokenAuthoredSet(
  spec: Spec,
  plan: readonly DraftPlan[],
  candidatesOf: (drafts: readonly DraftPlan[]) => readonly DraftPlan[],
): Promise<PropertySetOutcome> {
  const properties: FormalProperty[] = [];
  const unexpressed: UnexpressedCriterion[] = [];
  for (const { id } of spec.acceptanceCriteria) {
    const kept = await firstExpressedAttempt(spec, id, candidatesOf(draftsNaming(plan, id)));
    properties.push(...kept.properties.filter((property) => property.criterionRef === id));
    unexpressed.push(...kept.unexpressed.filter((entry) => entry.criterionId === id));
  }
  return {
    properties,
    unexpressed,
    unexpressedCriteria: unexpressed.map((entry) => entry.criterionId),
    propertySetAdmitted: 'not-gated',
  };
}

/** The author that retries: every draft in reply order, until one is expressed. */
const RETRYING_AUTHOR = (drafts: readonly DraftPlan[]): readonly DraftPlan[] => drafts;

/** The author that lets a later draft surface: only the LAST expressible draft is tried. */
const LAST_EXPRESSIBLE_AUTHOR = (drafts: readonly DraftPlan[]): readonly DraftPlan[] =>
  drafts.filter(isExpressible).slice(-1);

// -- Non-vacuity ----------------------------------------------------------------------------------

/** Every case the claim needs drawn at least once, read from the plan rather than the outcome. */
const COVERAGE_ROWS = Object.freeze([
  'an empty reply over a Spec that has criteria',
  'an expressible first draft for every criterion',
  'drafts for a strict, non-empty subset of the criteria',
  'two expressible drafts for one criterion',
  'two expressible drafts of different content for one criterion',
  'an expressible first draft, then an inexpressible one',
  'an inexpressible first draft, then an expressible one',
  'a validator-refused consequent first, then an expressible draft',
  'a validator-refused antecedent first, then an expressible draft',
  'a clockless-interface rejection first, then an expressible draft',
  'two inexpressible drafts, then an expressible one',
  'two or more drafts for one criterion, none expressible',
  'a fresh id the Spec does not have',
  'a near miss of a real criterion id',
  'a refused consequent leaving its criterion unexpressed',
  'a refused antecedent leaving its criterion unexpressed',
  'a clocked draft on an unclocked interface leaving its criterion unexpressed',
] as const);

/** One of {@link COVERAGE_ROWS}. */
type CoverageRow = (typeof COVERAGE_ROWS)[number];

/** One case as the coverage predicates read it. */
interface CaseView {
  readonly plan: readonly DraftPlan[];
  /** Each criterion's drafts, in reply order. */
  readonly perCriterion: readonly (readonly DraftPlan[])[];
}

/** Whether some criterion's drafts are all inexpressible and its first carries `verdict`. */
function decidedUnexpressedBy(view: CaseView, verdict: DraftVerdict): boolean {
  return view.perCriterion.some(
    (drafts) => drafts[0]?.verdict === verdict && !drafts.some(isExpressible),
  );
}

/** Whether some criterion's first draft carries `verdict` and a LATER draft is expressible. */
function firstDecidedThenExpressible(view: CaseView, verdict: DraftVerdict): boolean {
  return view.perCriterion.some(
    ([first, ...later]) => first?.verdict === verdict && later.some(isExpressible),
  );
}

/** Whether `view` drew each row; a TOTAL record, so a new row cannot go unchecked. */
const IS_DRAWN: Readonly<Record<CoverageRow, (view: CaseView) => boolean>> = {
  'an empty reply over a Spec that has criteria': (view) =>
    view.plan.length === 0 && view.perCriterion.length > 0,
  'an expressible first draft for every criterion': (view) =>
    view.perCriterion.length > 0 &&
    view.perCriterion.every((drafts) => drafts[0]?.verdict === 'expressible'),
  'drafts for a strict, non-empty subset of the criteria': (view) => {
    const named = view.perCriterion.filter((drafts) => drafts.length > 0).length;
    return named > 0 && named < view.perCriterion.length;
  },
  'two expressible drafts for one criterion': (view) =>
    view.perCriterion.some((drafts) => drafts.filter(isExpressible).length >= 2),
  'two expressible drafts of different content for one criterion': (view) =>
    view.perCriterion.some(
      (drafts) => new Set(drafts.filter(isExpressible).map(contentKey)).size >= 2,
    ),
  'an expressible first draft, then an inexpressible one': (view) =>
    view.perCriterion.some(
      ([first, ...later]) =>
        first !== undefined && isExpressible(first) && later.some((draft) => !isExpressible(draft)),
    ),
  'an inexpressible first draft, then an expressible one': (view) =>
    view.perCriterion.some(isWeakerFallback),
  'a validator-refused consequent first, then an expressible draft': (view) =>
    firstDecidedThenExpressible(view, 'refused-consequent'),
  'a validator-refused antecedent first, then an expressible draft': (view) =>
    firstDecidedThenExpressible(view, 'refused-antecedent'),
  'a clockless-interface rejection first, then an expressible draft': (view) =>
    firstDecidedThenExpressible(view, 'no-clock'),
  'two inexpressible drafts, then an expressible one': (view) =>
    view.perCriterion.some(
      ([first, second, ...later]) =>
        first !== undefined &&
        second !== undefined &&
        !isExpressible(first) &&
        !isExpressible(second) &&
        later.some(isExpressible),
    ),
  'two or more drafts for one criterion, none expressible': (view) =>
    view.perCriterion.some((drafts) => drafts.length >= 2 && !drafts.some(isExpressible)),
  'a fresh id the Spec does not have': (view) =>
    view.plan.some((draft) => draft.idOrigin === 'fresh-id'),
  'a near miss of a real criterion id': (view) =>
    view.plan.some((draft) => draft.idOrigin === 'near-miss-id'),
  'a refused consequent leaving its criterion unexpressed': (view) =>
    decidedUnexpressedBy(view, 'refused-consequent'),
  'a refused antecedent leaving its criterion unexpressed': (view) =>
    decidedUnexpressedBy(view, 'refused-antecedent'),
  'a clocked draft on an unclocked interface leaving its criterion unexpressed': (view) =>
    decidedUnexpressedBy(view, 'no-clock'),
};

/**
 * Assert that every entry the generator wrote is READABLE by the boundary, whole and in order.
 *
 * This is what keeps the malformed-first-entry channel out of the population (see the header): a
 * dropped entry would change which draft is "the first the author sees", and no requirement
 * decides that. It also pins the emission-order guarantee the whole first-draft rule stands on.
 */
function expectEveryEntryReadable(plan: readonly DraftPlan[]): void {
  const parsed = parsePropertyDrafts(replyText(plan));
  expect(
    parsed.ok ? parsed.value : parsed.error,
    'the generated reply is not read back whole and in the order it was written',
  ).toEqual(entriesOf(plan));
}

/** Count every coverage row `view` draws into `drawn`. */
function tally(drawn: Map<CoverageRow, number>, view: CaseView): void {
  for (const row of COVERAGE_ROWS) {
    if (IS_DRAWN[row](view)) {
      drawn.set(row, (drawn.get(row) ?? 0) + 1);
    }
  }
}

/** Run the REAL author over one case and assert every half of the claim over its set. */
async function checkCase({ spec, plan }: PlannedCase): Promise<CaseView> {
  // The interface's clock is itself in the dialect, so a clocked draft is decided only by what
  // its plan says, and never by a clock name the validator happens to refuse.
  const { clockName } = spec.moduleInterface.clocking;
  expect(clockName === null || validateExpression(clockName).ok).toBe(true);
  expectEveryEntryReadable(plan);

  const set = await authoredSetFor(spec, replyText(plan));

  expectPartition(
    spec.acceptanceCriteria.map((criterion) => criterion.id),
    set,
  );
  expectAtMostOnePropertyPerCriterion(set);
  expectOutcomesFollowFirstDrafts(spec, plan, set);
  return {
    plan,
    perCriterion: spec.acceptanceCriteria.map((criterion) => draftsNaming(plan, criterion.id)),
  };
}

describe(PROPERTY, () => {
  it(
    'holds under every reply shape and every draft order, the first draft deciding',
    async () => {
      // The pools are classified by construction; the validator, the dialect's owner, confirms it.
      expect(COMBINATIONAL_EXPRESSIONS.filter((text) => !validateExpression(text).ok)).toEqual([]);
      expect(CLOCKED_EXPRESSIONS.filter((text) => !validateExpression(text).ok)).toEqual([]);
      expect(REFUSED_EXPRESSIONS.filter((text) => validateExpression(text).ok)).toEqual([]);

      const drawn = new Map<CoverageRow, number>(COVERAGE_ROWS.map((row) => [row, 0]));
      for (const shape of REPLY_SHAPES) {
        await fc.assert(
          fc.asyncProperty(caseArbitrary(shape), async (planned) => {
            tally(drawn, await checkCase(planned));
          }),
          propertyParameters(),
        );
      }
      const ordersDrawn = new Map<string, number>(
        DRAFT_ORDERS.map((order) => [orderLabel(order), 0]),
      );
      for (const order of DRAFT_ORDERS) {
        await fc.assert(
          fc.asyncProperty(orderedCaseArbitrary(order), async (planned) => {
            tally(drawn, await checkCase(planned));
            const label = orderLabel(order);
            ordersDrawn.set(label, (ordersDrawn.get(label) ?? 0) + 1);
          }),
          propertyParameters(),
        );
      }

      // Non-vacuous: every case the claim needs was drawn at least once.
      expect(COVERAGE_ROWS.filter((row) => drawn.get(row) === 0)).toEqual([]);
      expect([...ordersDrawn].filter(([, count]) => count === 0)).toEqual([]);
    },
    SLOW_PROPERTY_TIMEOUT_MS,
  );

  it(
    'fails an author that retries from a later draft, and one that lets a later draft surface',
    async () => {
      for (const order of DRAFT_ORDERS) {
        await fc.assert(
          fc.asyncProperty(orderedCaseArbitrary(order), async ({ spec, plan }) => {
            // The real author passes the very assertion the broken ones are held to.
            expectOutcomesFollowFirstDrafts(
              spec,
              plan,
              await authoredSetFor(spec, replyText(plan)),
            );

            if (isWeakerFallbackOrder(order)) {
              const retrying = await brokenAuthoredSet(spec, plan, RETRYING_AUTHOR);
              expect(() => expectOutcomesFollowFirstDrafts(spec, plan, retrying)).toThrow(
                'a criterion whose first draft was rejected was retried from a later draft',
              );
            }
            if (isSecondAcceptedOrder(order)) {
              const surfacing = await brokenAuthoredSet(spec, plan, LAST_EXPRESSIBLE_AUTHOR);
              // Either half of the assertion may be the one to fire: a surfacing author also
              // expresses the other criteria's weaker fallbacks, which the first half names.
              expect(() => expectOutcomesFollowFirstDrafts(spec, plan, surfacing)).toThrow(
                /retried from a later draft|FIRST draft decides/,
              );
            }
          }),
          propertyParameters(),
        );
      }
    },
    SLOW_PROPERTY_TIMEOUT_MS,
  );
});
