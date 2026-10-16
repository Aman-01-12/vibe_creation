// reference-model-consensus-gate, task 5.3: the types that carry no ground truth, and the two
// absences (Req 1.6, 2.3, 2.5, 6.7, 7.6, 8.3, 9.7, 16.2, 17.1, 17.3).
//
// WHAT THIS FILE PINS
//   Four already-landed types carry no field for a reference design, a golden verdict, a model
//   assertion, or RTL source: `RunCell` and `FailingPairPeers` (run-matrix.ts), `SessionFacts`
//   (grant.ts), and `MutationStrengthRequest` (mutation-strength-gate.ts). Each is pinned with
//   `expectTypeOf<keyof T>().toEqualTypeOf<...>()`, which `tsc -b` evaluates and vitest does not,
//   rather than a comparison over a literal's `Object.keys`: an added OPTIONAL field passes a key
//   comparison on a literal (the literal is still assignable without it) but fails this pin, because
//   `keyof T` names every declared property whether or not a given literal happens to supply it.
//   That is the exact weak-pin shape this repository already replaced once, in
//   `testbench-rtl-isolation.property.test.ts`'s own comment on `TestbenchGenerationInput`.
//
// `ReferenceModelRequest` (task 10.5) AND `ConsensusHarnessRequest` (task 7.4) ARE NOT YET LANDED
//   Both are named by task 5.3's own body as later additions to this same pin block, not as
//   placeholders to stub here. Nothing below reserves a slot for either: a `describe` added by
//   whichever of 10.5 or 7.4 lands first appends its own key-set pin after the block below, and
//   the other task's later `describe` appends after that. Neither existing block is restructured
//   to make room, which is the condition task 5.3 states for leaving the file appendable.
//
// THE TWO ABSENCES
//   1. No export of `@app/agent/consensus` returns an accuracy figure (Req 16.2). Checked by
//      pinning every exported function's return type with `expectTypeOf(...).returns`, which
//      shows exactly two of them resolve to a bare `number` - `poolCorrectness` and
//      `BudgetLedger.spent` - and neither is a judged accuracy. `poolCorrectness` is the Pool_
//      Correctness SHARE of the Session's OWN Testbench_Pool (how many of this session's own
//      testbenches voted trusted), never a verdict against a golden testbench; no Independent_
//      Judge exists for a student's design, so no function here could compute one even if asked
//      to. `BudgetLedger.spent` is a token count, not a percentage at all. A source scan beside
//      the type pins keeps this closed: it reports the full set of top-level exported functions
//      whose declared return type is a bare `number`, so a THIRD one added later is visible here
//      rather than only in a reviewer's memory of this comment.
//   2. No largest-cluster accessor exists anywhere in the subsystem (Req 2.3). `agreement.ts`'s own
//      header comment already states the absence by name: "There is deliberately no
//      `largestCluster` export in this module, and no `isLargest` or `rank` field on
//      `AgreementCluster`." There is nothing to `expectTypeOf` against, because the whole point is
//      that no such symbol exists to import - importing one that is not exported is itself a
//      compile error, which would make this file fail to build the moment anyone tried to pin it
//      that way. So this is a source-text absence check instead: every non-test module of
//      `app/agent/consensus/` is scanned, with comments and strings blanked first, for any of the
//      forbidden names. A positive control inserts one of them into an in-memory copy of
//      `agreement.ts` and asserts the scan reports it, the same discipline
//      `consensus-import-boundary.test.ts` and `app/tools/formal/structural-claims.test.ts` already
//      apply to their own source scans.
//
// THE ONE CONSTANT DEFERRED
//   `CONSENSUS_POOL_SIZE` is not yet defined; task 13.1 adds it to `app/agent/consensus/session.ts`
//   at a measured value of 8. It is skipped below with a comment rather than asserted against an
//   import that does not exist yet, which would fail the build rather than pin anything.

import { readFileSync, readdirSync } from 'node:fs';

import { describe, expect, expectTypeOf, it } from 'vitest';

import {
  agreementClusters,
  strictMajority,
  type AgreementCluster,
} from '../agent/consensus/agreement.js';
import { admittedPool } from '../agent/consensus/structural-gate.js';
import {
  SESSION_TOKEN_BUDGET,
  RUN_TOKEN_BUDGET,
  makeBudgetLedger,
  type BudgetLedger,
} from '../agent/consensus/budget.js';
import {
  PEER_FLOOR,
  attributeFault,
  type FaultVerdict,
} from '../agent/consensus/fault-attributor.js';
import {
  applyFormalOverride,
  evaluateGrant,
  type FormalOverrideResult,
  type GrantEvaluation,
  type SessionFacts,
} from '../agent/consensus/grant.js';
import {
  modelFamilyOf,
  planDesignPoolFamilies,
  planTestbenchPoolFamilies,
  type FamilyPlan,
  type ModelFamily,
} from '../agent/consensus/model-family.js';
import {
  PeerCalibratedMutationStrengthGate,
  judgeMutationStrength,
  type MutationGateOutcome,
  type MutationStrengthRequest,
} from '../agent/consensus/mutation-strength-gate.js';
import { peersOf, type FailingPairPeers, type RunCell } from '../agent/consensus/run-matrix.js';
import { reduceSignature, type WaveformSignature } from '../agent/consensus/signature.js';
import {
  ATTRIBUTION_POOL_CORRECTNESS_GATE,
  attributionStatus,
  poolCorrectness,
  trustVote,
  type AttributionStatus,
  type TestbenchTrust,
} from '../agent/consensus/trust-vote.js';
import type { ConsensusHarnessRequest } from '../tools/simulator/consensus-harness.js';

// -- Shared source-scan helpers (duplicated per-file, matching
//    consensus-import-boundary.test.ts and app/tools/formal/structural-claims.test.ts) -----------

/** One token a scan must not look inside: a comment, or a string or template literal. */
const LEXICAL_TOKEN =
  /\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\[\s\S])*`/g;

/** Whether a token is a comment: the only tokens that open with a slash. */
function isComment(token: string): boolean {
  return token.startsWith('/');
}

/** `source` with every comment blanked to spaces and every newline kept, so line numbers line up. */
function codeOf(source: string): string {
  return source.replace(LEXICAL_TOKEN, (token) =>
    isComment(token) ? token.replace(/[^\n]/g, ' ') : token,
  );
}

/**
 * `source` with `inserted` placed right after `anchor`, for a positive control. Throws unless the
 * anchor occurs exactly once, so a control cannot silently insert nothing.
 */
function insertAfter(source: string, anchor: string, inserted: string): string {
  const parts = source.split(anchor);
  if (parts.length !== 2) {
    throw new Error(`a positive control's anchor must occur exactly once: ${anchor}`);
  }
  return parts.join(`${anchor}${inserted}`);
}

/** The directory holding every production module this file scans. */
const CONSENSUS_DIR = new URL('../agent/consensus/', import.meta.url);

/** The non-test modules of `app/agent/consensus/`, read off the directory rather than listed. */
const CONSENSUS_MODULES: readonly string[] = readdirSync(CONSENSUS_DIR)
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  .sort();

/** One module's source text, read fresh on every call so a positive control never touches disk. */
function sourceOf(moduleFile: string): string {
  return readFileSync(new URL(moduleFile, CONSENSUS_DIR), 'utf8');
}

// -- Pin 1: the four key sets with no field for a reference design, a golden verdict, a model
//    assertion, or RTL source (Req 1.6, 7.6, 8.3, 9.7, 17.1, 17.3) -------------------------------

describe('four landed types carry no field for a reference design, a golden verdict, a model assertion, or RTL source', () => {
  // Compile-time only: `tsc -b` evaluates every `expectTypeOf` below, vitest does not.
  it('pins RunCell to its five recorded-outcome fields (run-matrix.ts)', () => {
    expectTypeOf<keyof RunCell>().toEqualTypeOf<
      'designId' | 'testbenchId' | 'passed' | 'signature' | 'failureCause'
    >();
  });

  it('pins FailingPairPeers to its four peer counts (run-matrix.ts)', () => {
    expectTypeOf<keyof FailingPairPeers>().toEqualTypeOf<
      'peerPassCount' | 'peerDesignCount' | 'peerTestbenchPassCount' | 'peerTestbenchCount'
    >();
  });

  it('pins SessionFacts to its five recorded facts, with no Testbench_Pool family count (grant.ts)', () => {
    expectTypeOf<keyof SessionFacts>().toEqualTypeOf<
      'poolSize' | 'designPoolDistinctFamilyCount' | 'clusters' | 'testbenchTrust' | 'runMatrix'
    >();
  });

  it('pins MutationStrengthRequest to the testbench identity and the mutant run facts (mutation-strength-gate.ts)', () => {
    expectTypeOf<keyof MutationStrengthRequest>().toEqualTypeOf<'testbenchId' | 'mutantRuns'>();
  });

  // NOT YET LANDED: `ReferenceModelRequest` (task 10.5) and `ConsensusHarnessRequest` (task 7.4)
  // each append their own `expectTypeOf<keyof T>()` block below this comment, one `describe` per
  // task, in whichever order the two land. Neither of the four blocks above is edited to make
  // room for them.
});

// -- Absence 1: no export returns an accuracy figure (Req 16.2) ----------------------------------

describe('no export of @app/agent/consensus returns an accuracy figure (Req 16.2)', () => {
  it('pins every exported decision function to its own named return type, never a bare number', () => {
    // Compile-time half: `tsc -b` evaluates these, vitest does not. Every decision surface the
    // barrel exports, pinned to the type it actually returns.
    expectTypeOf(agreementClusters).returns.toEqualTypeOf<readonly AgreementCluster[]>();
    expectTypeOf(strictMajority).returns.toEqualTypeOf<AgreementCluster | null>();
    expectTypeOf(evaluateGrant).returns.toEqualTypeOf<GrantEvaluation>();
    expectTypeOf(applyFormalOverride).returns.toEqualTypeOf<FormalOverrideResult>();
    expectTypeOf(modelFamilyOf).returns.toEqualTypeOf<ModelFamily>();
    expectTypeOf(planDesignPoolFamilies).returns.toEqualTypeOf<FamilyPlan>();
    expectTypeOf(planTestbenchPoolFamilies).returns.toEqualTypeOf<FamilyPlan>();
    expectTypeOf(peersOf).returns.toEqualTypeOf<FailingPairPeers>();
    expectTypeOf(attributeFault).returns.toEqualTypeOf<FaultVerdict>();
    expectTypeOf(judgeMutationStrength).returns.toEqualTypeOf<MutationGateOutcome>();
    expectTypeOf<PeerCalibratedMutationStrengthGate['judge']>().returns.toEqualTypeOf<
      Promise<MutationGateOutcome>
    >();
    expectTypeOf(reduceSignature).returns.toEqualTypeOf<WaveformSignature | null>();
    expectTypeOf(trustVote).returns.toEqualTypeOf<readonly TestbenchTrust[]>();
    expectTypeOf(attributionStatus).returns.toEqualTypeOf<AttributionStatus>();
    expectTypeOf(makeBudgetLedger).returns.toEqualTypeOf<BudgetLedger>();
    expectTypeOf(admittedPool<string>).returns.toEqualTypeOf<readonly string[]>();

    // The TWO legitimate bare-number returns, named and justified rather than merely absent from
    // the list above: a Pool_Correctness SHARE over the Session's OWN pool (never a verdict against
    // a golden testbench, since none exists in production), and a token count.
    expectTypeOf(poolCorrectness).returns.toEqualTypeOf<number>();
    expectTypeOf<BudgetLedger['spent']>().returns.toEqualTypeOf<number>();
  });

  /**
   * Every top-level exported function in a non-test module of `app/agent/consensus/` whose
   * declared return type is the bare `number`, matched on the declaration text itself rather than
   * inferred, so a function that merely CALLS something number-returning is not swept in.
   */
  function bareNumberExportsIn(source: string): readonly string[] {
    return [...codeOf(source).matchAll(/^export function (\w+)\([^)]*\): number \{/gm)].map(
      (match) => match[1] ?? '',
    );
  }

  it('reports exactly one top-level export declared to return a bare number, so a third one is visible here', () => {
    const found = CONSENSUS_MODULES.flatMap((file) => bareNumberExportsIn(sourceOf(file)));

    // `poolCorrectness` (trust-vote.ts) is the only one; `BudgetLedger.spent` is an interface
    // method, not a top-level export, and is pinned above instead.
    expect(found).toEqual(['poolCorrectness']);

    // Positive control: a second bare-number export inserted into an in-memory copy IS reported,
    // so this scan is not one that would report a clean set over nothing scanned.
    const violating = `${sourceOf('trust-vote.ts')}\nexport function fakeAccuracy(): number {\n  return 1;\n}\n`;
    expect(bareNumberExportsIn(violating)).toEqual(['poolCorrectness', 'fakeAccuracy']);
  });
});

// -- Absence 2: no largest-cluster accessor exists anywhere in the subsystem (Req 2.3) -----------

describe('no largest-cluster accessor exists anywhere in the subsystem (Req 2.3)', () => {
  // There is no symbol to `expectTypeOf` against: `agreement.ts`'s own header comment already
  // states the absence by name, and importing a name that is not exported would fail the build
  // rather than pin anything. So this is read as source text, with comments and strings blanked
  // first (the same `codeOf` discipline `consensus-import-boundary.test.ts` and
  // `app/tools/formal/structural-claims.test.ts` already apply to their own scans) and every
  // occurrence of one of the forbidden names reported, wherever in the file it sits - a field, a
  // local, or an export.
  const FORBIDDEN_NAME = /\b(?:largestCluster|biggestCluster|isLargest|pluralityCluster|rank)\b/g;

  /** Every forbidden-name occurrence in `source`, with its code blanked of comments and strings first. */
  function forbiddenNamesIn(source: string): readonly string[] {
    return [...codeOf(source).matchAll(FORBIDDEN_NAME)].map((match) => match[0]);
  }

  it('finds none of the forbidden names in any non-test module of app/agent/consensus/', () => {
    const found = CONSENSUS_MODULES.flatMap((file) => forbiddenNamesIn(sourceOf(file)));
    expect(found).toEqual([]);
  });

  it('reports an inserted largestCluster export, so the scan is not one that would pass on nothing', () => {
    const agreementSource = sourceOf('agreement.ts');
    const violating = insertAfter(
      agreementSource,
      "import type { Ulid } from '@app/core';\n",
      'export function largestCluster(): never {\n  throw new Error("not real");\n}\n',
    );

    expect(forbiddenNamesIn(violating)).toEqual(['largestCluster']);
    // The real file itself still reports nothing, confirming the control added the only occurrence.
    expect(forbiddenNamesIn(agreementSource)).toEqual([]);
  });
});

// -- The constants: three pinned at their measured value, one deferred (Req 2.5, 8.3, 9.7) -------

describe('the already-landed constants (Req 2.5, 8.3, 9.7)', () => {
  it('pins PEER_FLOOR, ATTRIBUTION_POOL_CORRECTNESS_GATE, and the two token budgets', () => {
    expect(PEER_FLOOR).toBe(3);
    expect(ATTRIBUTION_POOL_CORRECTNESS_GATE).toBe(0.5);
    expect(SESSION_TOKEN_BUDGET).toBe(80_000);
    expect(RUN_TOKEN_BUDGET).toBe(200_000);
  });

  // NOT YET DEFINED: `CONSENSUS_POOL_SIZE` is added by task 13.1 to `app/agent/consensus/
  // session.ts`, at a measured value of 8. Once it lands, task 13.1 adds a case here asserting
  // `expect(CONSENSUS_POOL_SIZE).toBeGreaterThanOrEqual(8)`, per the task's own "at least 8" text.
});

// -- Task 7.6's own type pin: ConsensusHarnessRequest carries no field for RTL, model output, or
//    Spec prose (Req 4.7) -----------------------------------------------------------------------

describe('ConsensusHarnessRequest carries no field that can carry RTL, model output, or Spec prose (Req 4.7)', () => {
  // Compile-time only: `tsc -b` evaluates this, vitest does not. Appended per task 7.6's own
  // instruction ("a `describe` added by whichever of 10.5 or 7.4 lands first appends its own
  // key-set pin after the block below") - the four blocks above are untouched.
  it('pins ConsensusHarnessRequest to its five fields (consensus-harness.ts)', () => {
    expectTypeOf<keyof ConsensusHarnessRequest>().toEqualTypeOf<
      'moduleInterface' | 'timingContract' | 'nonce' | 'watchdogBudgetNs' | 'sampleBudget'
    >();
  });
});
