// The Property_Only_Measurement report, rendered as plain text.
//
// WHY A SECOND RENDERER RATHER THAN EXTENDING `../sweep/summary.ts`
//   That renderer reads sweep records and computes End_To_End_Formal_Rates. Teaching it to
//   read this record too would put both populations inside one function, and the separation
//   would then depend on that function continuing to keep them apart. Two renderers over two
//   record types cannot merge the two populations without someone writing a third thing.
//
// TWO FIGURES, NEVER A THIRD
//   Every block emits a property-only figure over the Admitted_Population and an
//   End_To_End_Formal_Rate over the Student_Path's own population, each named. The
//   end-to-end figure is always NOT MEASURED here, because this record holds no sweep result
//   and this file reads none (Req 9.3, 9.9). No line combines the two.
//
// NO POOLED FIGURE
//   One block per Authoring_Model, keyed off the design result's own `authoringModel`, and no
//   aggregate anywhere: a pooled rate over two models describes neither of them (Req 5.14).
//
// NOT MEASURED, NEVER `0`
//   The token and the rule are `../sweep/summary.ts`'s: a count that was never taken renders
//   as `NOT MEASURED`, because a `0` is a claim about something that ran and found nothing.
//   A count that WAS taken and came to zero still renders as `0` (Req 9.6).
//
// THE WALL-CLOCK COMPARISON IS A FIGURE, NOT A STOP CONDITION
//   Since FL-26 the guard's wall-clock arm is the declared Property_Time_Budget, so a design
//   slower than the pilot's maximum that still finished inside that budget ran legitimately.
//   The comparison is therefore reported and stops nothing (Req 5.22, design.md C7), and the
//   arm a stop was taken from is named with its Limit_Reason so a derived arm is not read as a
//   measured figure (Req 12.10).
//
// HOW A STOPPED RUN IS DETECTED WITHOUT RE-OWNING THE ANOMALY_GUARD
//   The record carries no "I was stopped" flag, and the guard's rule belongs to the
//   Property_Only_Mode, not to a renderer. What the record does show is coverage: a model
//   whose population is short of the scored corpus did not finish it. A run short of a
//   declared design-count bound ran to that bound; a run short of the corpus with no such
//   bound was stopped mid-population, which is reported as a suspected defect in the run
//   rather than as a rate (Req 5.9, 12.5).
//
// Pure: no clock, no I/O, no randomness.

import { FORMAL_VERDICTS, type FormalVerdict } from '@app/tools';

import { RTLLM_SCORED_DESIGN_COUNT } from '../corpus/stage0-quarantine.js';
import type { MeasurementLimit } from '../measurement-limit.js';
import type { ManifestToolchain, ProbedVersion } from '../sweep/manifest.js';
import type { PropertyOnlyDesignResult, PropertyOnlyMeasurement } from './record.js';

/** The one token for a count nobody took, spelled as `../sweep/summary.ts` spells it. */
const NOT_MEASURED = 'NOT MEASURED';

/** How many decimal places a reported rate is rendered with, matching the sibling renderer. */
const RATE_DIGITS = 3;

/**
 * How many decimal places an elapsed wall clock is rendered with.
 *
 * One, so a measured millisecond figure can never take the three-decimal shape this document
 * uses for rates, and a reader scanning for rates cannot pick one up by accident.
 */
const ELAPSED_DIGITS = 1;

/** The column every continuation line indents to, matching the `label:` value column above. */
const CONTINUATION_COLUMN = ' '.repeat(19);

/** Render a rate as a fixed-precision string. */
function rate(value: number): string {
  return value.toFixed(RATE_DIGITS);
}

/** Render a measured elapsed wall clock with its unit. */
function elapsed(valueMs: number): string {
  return `${valueMs.toFixed(ELAPSED_DIGITS)} ms`;
}

/** One declared limit with its reason, so no figure is read without the bound it ran under. */
function describeLimit(limit: MeasurementLimit): string {
  return `${limit.name} = ${limit.value} ${limit.unit} (${limit.reason})`;
}

// -- The guard's two arms ---------------------------------------------------

/** One Anomaly_Guard arm, and the declared Measurement_Limit its threshold is taken from. */
interface GuardArm {
  readonly arm: string;
  readonly limit: MeasurementLimit;
}

/**
 * Which declared limit each arm is taken from, in the order the guard checks them.
 *
 * The two arms are sized from two different places since FL-26, so an arm named without its
 * source reads as a measured figure. Named here rather than filtered by Limit_Reason, because
 * the wall-clock arm's reason is `population-honesty` and the token arm's is
 * `anomaly-detection`, and `cost-pilot-design-count` shares the latter while stopping nothing.
 */
const GUARD_ARM_SOURCES: readonly { readonly arm: string; readonly limitName: string }[] = [
  { arm: 'token arm', limitName: 'anomaly-guard' },
  { arm: 'wall-clock arm', limitName: 'shipped-property-time-budget' },
];

/** The arms the record declares a limit for, each paired with that limit (Req 12.10). */
function guardArms(limits: readonly MeasurementLimit[]): readonly GuardArm[] {
  return GUARD_ARM_SOURCES.flatMap(({ arm, limitName }) => {
    const limit = limits.find((one) => one.name === limitName);
    return limit === undefined ? [] : [{ arm, limit }];
  });
}

// -- Coverage ---------------------------------------------------------------

/**
 * What this model's recorded population says about how the run ended.
 *
 * `bounded` is a run that reached a declared design-count limit, which is a result.
 * `stopped` is a population short of the corpus with no such bound, which is a diagnosis.
 */
type Coverage =
  | { readonly kind: 'full' }
  | { readonly kind: 'bounded'; readonly limit: MeasurementLimit }
  | { readonly kind: 'stopped'; readonly arms: readonly GuardArm[] };

/** The declared bound on how many designs a run covers, where one was declared. */
function designCountLimit(limits: readonly MeasurementLimit[]): MeasurementLimit | undefined {
  return limits.find((limit) => limit.unit === 'designs');
}

/** Classify a model's coverage from the record alone, without recomputing any guard. */
function coverageOf(designCount: number, limits: readonly MeasurementLimit[]): Coverage {
  if (designCount >= RTLLM_SCORED_DESIGN_COUNT) {
    return { kind: 'full' };
  }
  const bound = designCountLimit(limits);
  if (bound !== undefined && designCount <= bound.value) {
    return { kind: 'bounded', limit: bound };
  }
  return { kind: 'stopped', arms: guardArms(limits) };
}

// -- Per-model figures ------------------------------------------------------

/** Every figure one Authoring_Model's block renders, each over a population it names. */
interface ModelFigures {
  readonly designs: readonly PropertyOnlyDesignResult[];
  readonly admitted: readonly PropertyOnlyDesignResult[];
  readonly refusedCount: number;
  /** Admitted designs holding at least one property a Deterministic_Oracle decided. */
  readonly decidedCount: number;
  /** Designs whose Property_Author expressed nothing, which is why the denominator is short. */
  readonly declinedCount: number;
  readonly provedCount: number;
  readonly verdicts: Readonly<Record<FormalVerdict, number>>;
  readonly notMeasuredProperties: number;
  readonly unprovenancedCount: number;
}

/** Whether any member of the toolchain answered with a version at all. */
function toolchainRead(toolchain: ManifestToolchain): boolean {
  const legacy = [toolchain.iverilogVersion, toolchain.vvpVersion, toolchain.workerPython];
  const probed: readonly ProbedVersion[] = [
    toolchain.yosysVersion,
    toolchain.yosysBuildId,
    toolchain.yosysSmtBmcVersion,
    toolchain.bitwuzlaVersion,
    toolchain.z3Version,
  ];
  return legacy.some((version) => version !== null) || probed.some((one) => one.kind === 'read');
}

/**
 * Whether the oracle proved everything it decided on this design.
 *
 * A design nothing was decided on is not proved and not disproved, so it is excluded from the
 * rate's denominator by `decidedCount` rather than counted here as a failure.
 */
function designProved(design: PropertyOnlyDesignResult): boolean {
  const measured = design.properties.filter((one) => one.outcome.kind === 'measured');
  return (
    measured.length > 0 &&
    measured.every((one) => one.outcome.kind === 'measured' && one.outcome.verdict === 'proved')
  );
}

/** Tally the verdicts of every property on the admitted designs, keeping untaken ones apart. */
function tallyVerdicts(admitted: readonly PropertyOnlyDesignResult[]): {
  readonly verdicts: Readonly<Record<FormalVerdict, number>>;
  readonly notMeasuredProperties: number;
} {
  const verdicts: Record<FormalVerdict, number> = { proved: 0, refuted: 0, 'could-not-verify': 0 };
  let notMeasuredProperties = 0;
  for (const design of admitted) {
    for (const { outcome } of design.properties) {
      if (outcome.kind === 'measured') {
        verdicts[outcome.verdict] += 1;
      } else {
        notMeasuredProperties += 1;
      }
    }
  }
  return { verdicts, notMeasuredProperties };
}

/** Derive one model's figures; every denominator here is one population, never both. */
function figuresOf(designs: readonly PropertyOnlyDesignResult[]): ModelFigures {
  const admitted = designs.filter((design) => design.population === 'admitted');
  const decided = admitted.filter((design) =>
    design.properties.some((one) => one.outcome.kind === 'measured'),
  );
  return {
    designs,
    admitted,
    refusedCount: designs.length - admitted.length,
    decidedCount: decided.length,
    declinedCount: designs.filter((design) => design.properties.length === 0).length,
    provedCount: decided.filter(designProved).length,
    ...tallyVerdicts(admitted),
    unprovenancedCount: designs.filter((design) => !toolchainRead(design.toolchain)).length,
  };
}

// -- The lines of one block -------------------------------------------------

/** Both populations and their sizes, so no count below is read over the wrong one. */
function populationLine(figures: ModelFigures): string {
  return (
    `  population:      ${figures.designs.length} design(s) recorded - ` +
    `${figures.admitted.length} Admitted_Population, ${figures.refusedCount} Refused_Population`
  );
}

/**
 * The property-only figure, over the Admitted_Population alone.
 *
 * The Refused_Population is out of this denominator entirely (Req 9.12): a design the pre-pass
 * refused before any solver ran had no chance to be proved, so counting it as a failure would
 * make the refusal floor hit this rate twice.
 */
function propertyOnlyLines(figures: ModelFigures): readonly string[] {
  const { decidedCount, provedCount, declinedCount, designs } = figures;
  const value =
    decidedCount === 0
      ? `${NOT_MEASURED} - no design in the Admitted_Population carries an oracle verdict`
      : `${rate(provedCount / decidedCount)}  (${provedCount}/${decidedCount} decided design(s))`;
  return [
    `  property-only:   ${value}`,
    `${CONTINUATION_COLUMN}<== PROPERTY-ONLY, over the Admitted_Population. No Testbench_Agent`,
    `${CONTINUATION_COLUMN}and no Instrument_Admission step ran in this path, so it answers a`,
    `${CONTINUATION_COLUMN}narrower question than an End_To_End_Formal_Rate does.`,
    `${CONTINUATION_COLUMN}Its denominator is ${decidedCount} of ${designs.length} recorded` +
      ` design(s), because the`,
    `${CONTINUATION_COLUMN}Property_Author expressed nothing for ${declinedCount} of them. The` +
      ` rate, that`,
    `${CONTINUATION_COLUMN}denominator and that decline count are one statement, so the rate is`,
    `${CONTINUATION_COLUMN}never read over the whole population (Req 5.27).`,
    `${CONTINUATION_COLUMN}WHY the Property_Author declined is ${NOT_MEASURED} (Req 5.28).`,
  ];
}

/** The second figure, named and empty: this record holds no end-to-end result to rate. */
function endToEndLines(): readonly string[] {
  return [
    `  end-to-end:      ${NOT_MEASURED} - this record holds no End_To_End_Formal_Rate, and no`,
    `${CONTINUATION_COLUMN}report of one reads this file. That rate's population is the`,
    `${CONTINUATION_COLUMN}Student_Path's own, measured by the sweep summary. The two figures`,
    `${CONTINUATION_COLUMN}stay separate and are never combined into a third.`,
  ];
}

/** The refusal floor, on its own denominator: the whole scored population, not the admitted one. */
function refusalFloorLines(figures: ModelFigures, coverage: Coverage): readonly string[] {
  const recorded = figures.designs.length;
  const floor = `${figures.refusedCount}/${recorded} = ${rate(figures.refusedCount / recorded)}`;
  return [
    `  refusal floor:   ${floor} refused by the Reset_Contract_Prepass, over this model's`,
    `${CONTINUATION_COLUMN}whole recorded population (both populations, separate from the rate`,
    `${CONTINUATION_COLUMN}above). The scored corpus is ${RTLLM_SCORED_DESIGN_COUNT} design(s)` +
      `${coverage.kind === 'full' ? ', all recorded.' : `, so ${recorded} is short of it.`}`,
  ];
}

/** The verdict tally, or the whole tally as untaken where the population is empty. */
function verdictLines(figures: ModelFigures): readonly string[] {
  if (figures.admitted.length === 0) {
    return [
      `  properties:      ${NOT_MEASURED} - this model has no design in the Admitted_Population,`,
      `${CONTINUATION_COLUMN}so no property over that population was submitted to the oracle.`,
    ];
  }
  const tally = FORMAL_VERDICTS.map((verdict) => `${verdict} ${figures.verdicts[verdict]}`);
  return [
    `  properties:      ${tally.join('  ')} over the Admitted_Population`,
    `  no verdict:      ${figures.notMeasuredProperties} property outcome(s) over the same` +
      ` population reached no oracle`,
    `${CONTINUATION_COLUMN}invocation at all, so they are ${NOT_MEASURED} and not failures.`,
  ];
}

/** Whether this model's figures can be reproduced, which needs a toolchain to reproduce them on. */
function provenanceLines(figures: ModelFigures): readonly string[] {
  if (figures.unprovenancedCount === 0) {
    return [];
  }
  return [
    `  reproducible:    NOT REPRODUCIBLE - ${figures.unprovenancedCount} of ` +
      `${figures.designs.length} design(s) carry no`,
    `${CONTINUATION_COLUMN}Toolchain_Provenance, so their figures cannot be placed on either`,
    `${CONTINUATION_COLUMN}side of a toolchain change.`,
  ];
}

/** One span as the report prints it; an absent Proof_Span is named and never shown as a zero. */
function spanOf(span: number | null): string {
  return span === null ? NOT_MEASURED : elapsed(span);
}

/**
 * The pilot comparison, reported as a figure: every design's wall clock beside the maximum.
 *
 * The maximum is taken over this model's own designs and never across models, so the figure
 * beside the per-design ones is this block's own Per_Design_Extrapolation under the maximum
 * rule `cli.ts` records it with (Req 5.8, 5.14).
 *
 * It stops nothing, and the lines say so: a design slower than this maximum is stopped only by
 * the guard's wall-clock arm, which reads the Proof_Span against the declared
 * Property_Time_Budget, so anything whose proof finished inside that budget was legitimate
 * (Req 5.22, 5.25).
 */
function wallClockLines(figures: ModelFigures): readonly string[] {
  const extrapolation = figures.designs.reduce((max, one) => Math.max(max, one.elapsedMs), 0);
  return [
    `  wall clock:      Per_Design_Extrapolation ${elapsed(extrapolation)} Design_Total, the` +
      ` maximum of`,
    `${CONTINUATION_COLUMN}this model's own per-design figures, beside each design's measured`,
    `${CONTINUATION_COLUMN}Design_Total (authoring and proof) and Proof_Span (the proof alone):`,
    // Two lines per design rather than one: the longest corpus id plus both named spans runs
    // past the readable column, and a truncated figure is worse than a second line.
    ...figures.designs.flatMap((design) => [
      `${CONTINUATION_COLUMN}- ${design.designId}:`,
      `${CONTINUATION_COLUMN}    Design_Total ${elapsed(design.elapsedMs)},` +
        ` Proof_Span ${spanOf(design.proofSpanMs)}`,
    ]),
    `${CONTINUATION_COLUMN}This comparison STOPS NO RUN and is a reported figure. The`,
    `${CONTINUATION_COLUMN}Anomaly_Guard's wall-clock arm reads the Proof_Span against the`,
    `${CONTINUATION_COLUMN}declared Property_Time_Budget, which is the span that budget bounds,`,
    `${CONTINUATION_COLUMN}so no Design_Total above is compared against any arm (Req 5.25).`,
    `${CONTINUATION_COLUMN}A design whose Proof_Span finished inside that budget ran`,
    `${CONTINUATION_COLUMN}legitimately and was not stopped.`,
  ];
}

/** Name the bound a short population ran under, and say whether it is a result or a diagnosis. */
function coverageLines(coverage: Coverage, recorded: number): readonly string[] {
  if (coverage.kind === 'full') {
    return [];
  }
  if (coverage.kind === 'bounded') {
    return [
      `  limit:           ran to ${describeLimit(coverage.limit)}, which is`,
      `${CONTINUATION_COLUMN}why this block covers ${recorded} design(s) and not ` +
        `${RTLLM_SCORED_DESIGN_COUNT}.`,
    ];
  }
  const named =
    coverage.arms.length === 0
      ? [`${CONTINUATION_COLUMN}- none: no declared Measurement_Limit accounts for the shortfall`]
      : coverage.arms.map(
          ({ arm, limit }) => `${CONTINUATION_COLUMN}- ${arm}: ${describeLimit(limit)}`,
        );
  return [
    `  STOPPED:         ${recorded} of ${RTLLM_SCORED_DESIGN_COUNT} design(s) covered, with no`,
    `${CONTINUATION_COLUMN}declared design-count bound reached. The arm(s) that stop a run, each`,
    `${CONTINUATION_COLUMN}with the declared limit it is taken from and that limit's reason:`,
    ...named,
    `${CONTINUATION_COLUMN}An arm is derived from the limit beside it and is NOT a measured figure.`,
    `${CONTINUATION_COLUMN}The run was stopped as a SUSPECTED DEFECT IN THE RUN, so the figure`,
    `${CONTINUATION_COLUMN}above is a diagnosis and is NOT a measurement of any Authoring_Model.`,
  ];
}

/** One Authoring_Model's whole block; nothing here reads another model's designs. */
function modelLines(
  model: string,
  designs: readonly PropertyOnlyDesignResult[],
  limits: readonly MeasurementLimit[],
): readonly string[] {
  const figures = figuresOf(designs);
  const coverage = coverageOf(designs.length, limits);
  return [
    `authoring model: ${model}`,
    populationLine(figures),
    ...propertyOnlyLines(figures),
    ...endToEndLines(),
    ...refusalFloorLines(figures, coverage),
    ...verdictLines(figures),
    ...provenanceLines(figures),
    ...wallClockLines(figures),
    ...coverageLines(coverage, designs.length),
  ];
}

// -- The report -------------------------------------------------------------

/** Group the results by the model that authored them, keeping first-appearance order. */
function byAuthoringModel(
  results: readonly PropertyOnlyDesignResult[],
): ReadonlyMap<string, readonly PropertyOnlyDesignResult[]> {
  const grouped = new Map<string, PropertyOnlyDesignResult[]>();
  for (const result of results) {
    const existing = grouped.get(result.authoringModel);
    if (existing === undefined) {
      grouped.set(result.authoringModel, [result]);
    } else {
      existing.push(result);
    }
  }
  return grouped;
}

/** What the whole measurement is, before any figure: its kind, its gaps, and its bounds. */
function headerLines(measurement: PropertyOnlyMeasurement): readonly string[] {
  const omitted =
    measurement.omittedStudentPathSteps.length === 0
      ? `${NOT_MEASURED} - the record names no omitted step`
      : measurement.omittedStudentPathSteps.join(', ');
  return [
    `property-only measurement: ${measurement.runName}`,
    `MEASUREMENT KIND: ${measurement.measurementKind} - this is NOT an End_To_End_Formal_Rate`,
    `Student_Path steps this path omitted: ${omitted}`,
    ...(measurement.limits.length === 0
      ? ['limits declared: none']
      : measurement.limits.map(
          (limit, index) =>
            `${index === 0 ? 'limits declared: ' : '                 '}${describeLimit(limit)}`,
        )),
  ];
}

/**
 * The whole report as lines, one block per Authoring_Model and no aggregate across them.
 *
 * Plain text on purpose: it is written beside the measurement file, printed to stdout, and
 * pasted into a report, and it must be readable in all three without a renderer.
 */
export function renderPropertyOnlyReport(measurement: PropertyOnlyMeasurement): readonly string[] {
  const header = headerLines(measurement);
  const grouped = byAuthoringModel(measurement.results);
  if (grouped.size === 0) {
    return [
      ...header,
      `no design result recorded, so every figure over every population is ${NOT_MEASURED}`,
    ];
  }
  return [
    ...header,
    ...[...grouped].flatMap(([model, designs]) => [
      '',
      ...modelLines(model, designs, measurement.limits),
    ]),
  ];
}
