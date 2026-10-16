// The production `PropertySetGate`: the RTLLM-backed MEASUREMENT behind the property-set
// mutation gate (Req 6.1, 6.2, 6.8).
//
// WHAT IT MEASURES, AND WHAT IT DELIBERATELY DOES NOT DECIDE
//   It generates single-operator mutants of the problem's reference design, asks the
//   INDEPENDENT golden judge what each one does (through `RtllmMutationCalibrator`, which is
//   also what the Negative_Control reads), submits the sample's already-authored Property_Set to
//   the REAL Formal_Oracle once per mutant, and hands back the calibrated population.
//   `admitPropertySet` then applies the rule. That division is the whole reason this file is
//   small: the gate's rule - exclude every unscorable mutant, refuse only on a judge-killed
//   mutant the Property_Set PROVED - lives one layer up, so no gate implementation can widen or
//   weaken which mutants a Property_Set is held to (Req 10.5), and this adapter does not restate
//   it.
//
// IT PASSES IDENTITIES AND NEVER FULL MUTANTS (Req 6.8)
//   `Mutant extends MutantIdentity` with an `rtl` field, so an adapter that set
//   `identity: entry.mutant` straight from the generator TYPE-CHECKS and would carry the whole
//   mutated reference RTL onto a refusal - a record that promises to describe the Property_Set
//   alone. `identityOf` is called HERE, at the one point the full mutant is in hand, which makes
//   the criterion true of what this gate produces rather than only of what the layer above
//   projects. `admitPropertySet`'s own projection stays as the backstop for every other gate.
//
// NO MODEL CALL OF ITS OWN (Req 6.7)
//   The Property_Set arrives on the request, authored once per sample by the memoizing source,
//   so the object scored here is the object the Verification_Loop is handed. This gate submits
//   it and never authors one.
//
// WHY THE FORMAL CAPS ARE NOT `request.limits`
//   `FormalOraclePort` takes no `ResourceLimits` per request: the four sandbox caps are
//   constructor state on the oracle (`FormalOracleDeps.caps`). So the composition root hands
//   this gate the SAME oracle instance the loop verifies with, and `request.limits` reaches the
//   GOLDEN side alone, where the calibrator does take it per call. One oracle rather than two is
//   also what keeps a mutant and a candidate from being measured under different caps.
//
// Sequential by construction: each mutant is one real toolchain invocation in a resource-capped
// sandbox, so the population is walked in generation order rather than in parallel.

import type { ModuleInterface } from '@app/core';
import {
  DEFAULT_PROPERTY_TIME_BUDGET_MS,
  type FormalOraclePort,
  type FormalVerdict,
  type PropertyResult,
  type SourceFile,
} from '@app/tools';

import type { CalibratedMutant, RtllmMutationCalibrator } from './corpus/mutation-calibration.js';
import { identityOf, type MutantCalibration, type MutantIdentity } from './mutation-control.js';
import type {
  CalibratedFormalMutant,
  PropertySetGate,
  PropertySetGateRequest,
} from './property-set-admission.js';

/** The injected collaborators one production gate needs; no globals, no runtime named. */
export interface RtllmPropertySetGateDeps {
  /**
   * The golden side: which mutants exist, and what the INDEPENDENT judge made of each.
   *
   * The SAME instance the Negative_Control is given, so the two gates are scored over ONE
   * mutant set (Req 9.8) and the judge's verdicts are measured and cached once.
   */
  readonly calibrator: RtllmMutationCalibrator;
  /**
   * The formal side: the SAME `FormalOraclePort` the Verification_Loop reaches its own verdict
   * through, so a mutant and a candidate are decided by one engine under one set of caps.
   */
  readonly oracle: FormalOraclePort;
  /**
   * Each problem's declared module interface, keyed by problem id.
   *
   * Needed because the request carries a problem ID and not a Spec, and every Property_Wrapper
   * is rendered from the design's port list. A map keyed by problem id, matching the
   * calibrator's own `references` and `golden` deps, so the composition root supplies all three
   * from the same imported corpus.
   */
  readonly interfaces: ReadonlyMap<string, ModuleInterface>;
  /**
   * The Property_Time_Budget each mutant's proof attempt runs under, in milliseconds.
   *
   * Defaults to the SAME build constant the loop submits its own candidate under, so a mutant
   * is not held to a different clock than the design: a gate that gave mutants less time would
   * manufacture `proof-timeout` refusals, which are excluded, and silently shrink its own gate
   * set.
   */
  readonly budgetMs?: number;
}

/**
 * The order a submitted result DECIDES the mutant in, which is the Verification_Loop's own
 * precedence over a Property_Set (`#runFormalGate`): a refutation decides, else a refusal, else
 * every property proved.
 *
 * Restated here rather than imported because `app/agent` exports no predicate for it, and the
 * agreement is pinned in the test beside this module. The precedence is also the fail-safe
 * direction for the mixed case: one property proving while another could not be reasoned about
 * is recorded as unscorable, so the Property_Set is never refused over a mutant the oracle did
 * not fully see.
 */
const DECIDING_PRECEDENCE = [
  'refuted',
  'could-not-verify',
  'proved',
] as const satisfies readonly FormalVerdict[];

/**
 * Which submitted property's result decides this mutant, or `null` where none did (pure, total).
 *
 * `null` is reachable only for an EMPTY Property_Set, which `proveSet` answers with no results
 * at all. A verdict missing from the precedence above would also land here, which is the
 * fail-safe direction: the mutant becomes unscorable rather than silently proved.
 */
function decidingResult(results: readonly PropertyResult[]): PropertyResult | null {
  for (const verdict of DECIDING_PRECEDENCE) {
    const found = results.find((result) => result.verdict === verdict);
    if (found !== undefined) {
      return found;
    }
  }
  return null;
}

/**
 * One mutant's calibrated record, from the judge's verdict and the oracle's own results
 * (pure, total).
 *
 * The four cases are spelled out rather than routed through `formalCalibrationOf`, because the
 * unscorable arm carries a `CouldNotVerifyCause` that only the `could-not-verify` RESULT holds
 * (Req 9.5) and no mapping over a bare verdict can supply it. The agreement with
 * `formalCalibrationOf` is asserted in the test beside this module, so the two cannot drift
 * unnoticed.
 */
function calibratedFrom(
  identity: MutantIdentity,
  golden: MutantCalibration,
  results: readonly PropertyResult[],
): CalibratedFormalMutant {
  const deciding = decidingResult(results);
  if (deciding === null) {
    // An empty Property_Set submits nothing, so no assertion ever reached the solver - which is
    // precisely what `zero-assertions` names. Excluded, and counted.
    return { identity, golden, formal: 'formal-could-not-verify', cause: 'zero-assertions' };
  }
  if (deciding.verdict === 'could-not-verify') {
    return { identity, golden, formal: 'formal-could-not-verify', cause: deciding.cause };
  }
  return deciding.verdict === 'refuted'
    ? { identity, golden, formal: 'formal-refuted' }
    : { identity, golden, formal: 'formal-proved' };
}

/** One mutant as the design source a formal job reads. */
function mutantDesignSource(rtl: string, designInterface: ModuleInterface): SourceFile {
  // The workspace path comes from the TRUSTED interface and never from the mutated text, the
  // same derivation `#proveSet` uses for a candidate. Mutation rewrites operators inside the
  // body, so the mutant still declares the interface's own module name.
  return { path: `${designInterface.moduleName}.v`, contents: rtl };
}

/** A `PropertySetGate` over RTLLM reference mutants, the real judge, and the real oracle. */
export class RtllmPropertySetGate implements PropertySetGate {
  readonly #deps: RtllmPropertySetGateDeps;

  constructor(deps: RtllmPropertySetGateDeps) {
    this.#deps = deps;
  }

  /**
   * Calibrate this problem's mutant population against the request's Property_Set, or `null`
   * where the gate could not run at all.
   *
   * `null` MEANS ONE THING AND IS NOT WIDENED. It is "no reference design to mutate" - the
   * calibrator's own absence answer, or a problem with no declared interface to render a
   * Property_Wrapper from. The harness records that as `'not-gated'`. An EMPTY population is a
   * DIFFERENT fact: the gate ran and had nothing to hold the Property_Set to, which
   * `admitPropertySet` reports as `'no-gate-set'`. Collapsing a problem with no valid mutants
   * into `null` would lose exactly that distinction, so it is returned as the empty population
   * it is.
   */
  async calibrate(
    request: PropertySetGateRequest,
  ): Promise<readonly CalibratedFormalMutant[] | null> {
    const designInterface = this.#deps.interfaces.get(request.problemId);
    const calibrated = await this.#deps.calibrator.calibrate(request.problemId, request.limits);
    if (designInterface === undefined || calibrated === null) {
      return null;
    }
    const population: CalibratedFormalMutant[] = [];
    for (const entry of calibrated.valid) {
      population.push(await this.#score(entry, designInterface, request));
    }
    return population;
  }

  /**
   * What the Property_Set did to ONE mutant: one `proveSet` submission, folded to a calibration.
   *
   * `identityOf` is called here and the full `Mutant` goes no further, which is Req 6.8 at the
   * only point in the flow where it could still be violated.
   */
  async #score(
    entry: CalibratedMutant,
    designInterface: ModuleInterface,
    request: PropertySetGateRequest,
  ): Promise<CalibratedFormalMutant> {
    const outcome = await this.#deps.oracle.proveSet({
      designSource: mutantDesignSource(entry.mutant.rtl, designInterface),
      designInterface,
      properties: request.propertySet.properties,
      budgetMs: this.#deps.budgetMs ?? DEFAULT_PROPERTY_TIME_BUDGET_MS,
    });
    return calibratedFrom(identityOf(entry.mutant), entry.calibration, outcome.results);
  }
}
