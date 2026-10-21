// Unit tests for the importer's inference count report (task 5.5; Req 3.3, 3.4, 3.6).
//
// WHICH CHECK CARRIES THE "NO POPULATION SIZE AS A LITERAL" CLAIM, AND WHY BOTH ARE HERE
//   The behavioural check is the honest one for the figures that MOVE: change membership and
//   every moving figure must move with it, which no literal-pinned field can do. It cannot
//   speak for the three static figures - a report writing `populationSize: 48` would satisfy
//   any comparison against the committed constant, because the constant is 48 too. So the
//   claim's remaining half is read off SOURCE, and the scan carries a positive control: the
//   same scan over the real file with one violating line appended must report that line, or a
//   scanner that sees nothing would pass everything.
//
// No size is written as a literal HERE either: the forbidden set is built from the imported
// constants, so this file tracks task 1.3 rather than restating it.

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import type { EvalProblem } from '../problem.js';
import type { QuarantinedDesign, RtllmCorpus } from './corpus-types.js';
import { RTLLM_PINNED_COMMIT } from './pinned-source.js';
import { STAGE0_QUARANTINE } from './stage0-quarantine.js';
import { timingInferenceCountReport } from './timing-count-report.js';
import {
  DERIVABLE_SCORING_COHORT_SIZE,
  DERIVATION_POPULATION_SIZE,
  SCORING_COHORT_SIZE,
  SOURCE_UNIVERSE_SIZE,
} from './timing-populations.js';

const ADDER_8BIT = 'rtllm/arithmetic/adder_8bit';
const ALU = 'rtllm/miscellaneous/alu';
const CLKGENERATOR = 'rtllm/miscellaneous/clkgenerator';
const FSM = 'rtllm/control/fsm';

const ALU_CAUSE = 'UNDRIVEN_OUTPUT: carry, negative, overflow';

/** A corpus carrying only what the report reads: imported problem ids and quarantine records. */
function corpusOf(
  problemIds: readonly string[],
  quarantined: readonly QuarantinedDesign[] = [],
): RtllmCorpus {
  return {
    pinnedCommit: RTLLM_PINNED_COMMIT,
    problems: problemIds.map((id) => ({ id }) as unknown as EvalProblem),
    golden: new Map(),
    references: new Map(),
    quarantined,
    designsSeen: problemIds.length + quarantined.length,
  };
}

/** One quarantine record, with the code under test's cause carried in `detail`. */
function quarantine(
  problemId: string,
  code: QuarantinedDesign['code'],
  detail: string,
): QuarantinedDesign {
  const designName = problemId.slice(problemId.lastIndexOf('/') + 1);
  return { problemId, designName, category: 'Miscellaneous', stage: 'import', code, detail };
}

describe('timingInferenceCountReport - the count names its population', () => {
  it('states which population the count is over and that population size', () => {
    const report = timingInferenceCountReport(corpusOf([ADDER_8BIT, FSM]));

    expect(report.population).toBe('Derivation_Population');
    expect(report.populationSize).toBe(DERIVATION_POPULATION_SIZE);
    expect(report.inferenceCount).toBe(2);
  });

  it('publishes all six population figures alongside the count', () => {
    const report = timingInferenceCountReport(
      corpusOf([ADDER_8BIT, FSM], [quarantine(ALU, 'TIMING_UNDERIVABLE', ALU_CAUSE)]),
    );

    expect(report.populations).toEqual({
      sourceUniverse: SOURCE_UNIVERSE_SIZE,
      derivationPopulation: DERIVATION_POPULATION_SIZE,
      derivedContracts: 2,
      derivationExclusions: [{ design: 'alu', cause: ALU_CAUSE }],
      scoringCohort: SCORING_COHORT_SIZE,
      timingAwareScoringCohort: DERIVABLE_SCORING_COHORT_SIZE - 1,
    });
  });

  it('moves every affected figure when a derived design becomes a refusal', () => {
    const derived = timingInferenceCountReport(corpusOf([ADDER_8BIT, ALU]));
    const refused = timingInferenceCountReport(
      corpusOf([ADDER_8BIT], [quarantine(ALU, 'TIMING_UNDERIVABLE', ALU_CAUSE)]),
    );

    expect(refused.inferenceCount).toBe(derived.inferenceCount - 1);
    expect(refused.populations.timingAwareScoringCohort).toBe(
      derived.populations.timingAwareScoringCohort - 1,
    );
    expect(refused.populations.derivationExclusions).toEqual([{ design: 'alu', cause: ALU_CAUSE }]);
  });

  it('counts a read failure as neither derived nor a derivation exclusion', () => {
    const report = timingInferenceCountReport(
      corpusOf(
        [ADDER_8BIT],
        [quarantine(ALU, 'DESCRIPTION_UNREADABLE', 'design_description.txt is absent')],
      ),
    );

    expect(report.inferenceCount).toBe(1);
    expect(report.populations.derivationExclusions).toEqual([]);
    expect(report.populations.timingAwareScoringCohort).toBe(DERIVABLE_SCORING_COHORT_SIZE);
  });
});

describe("timingInferenceCountReport - clkgenerator's exclusion is cited, not repeated", () => {
  it('cites the committed Stage-0 entry and records no second cause for it', () => {
    const report = timingInferenceCountReport(corpusOf([ADDER_8BIT, FSM]));
    const cited = report.scoringCohortCitations.find((entry) => entry.problemId === CLKGENERATOR);

    expect(report.scoringCohortCitations).toBe(STAGE0_QUARANTINE);
    expect(cited?.reason).toContain('same-timestep race');
    expect(report.populations.derivationExclusions).toEqual([]);
  });

  it('leaves the cohort unchanged if a refusal for it is recorded anyway', () => {
    const withoutIt = timingInferenceCountReport(corpusOf([ADDER_8BIT]));
    const withIt = timingInferenceCountReport(
      corpusOf(
        [ADDER_8BIT],
        [quarantine(CLKGENERATOR, 'TIMING_UNDERIVABLE', 'UNDRIVEN_OUTPUT: clk')],
      ),
    );

    expect(withIt.populations.timingAwareScoringCohort).toBe(
      withoutIt.populations.timingAwareScoringCohort,
    );
  });
});

/** The measured sizes, taken from the constants rather than restated as literals. */
const POPULATION_SIZES = new Set([
  SOURCE_UNIVERSE_SIZE,
  DERIVATION_POPULATION_SIZE,
  SCORING_COHORT_SIZE,
  DERIVABLE_SCORING_COHORT_SIZE,
]);

/** A comment, string, or template literal, scanned left to right so whichever opens first wins. */
const LEXICAL_TOKEN =
  /\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\[\s\S])*`/g;

/** Every numeric token in `source` naming a population size, comments excluded. */
function populationSizeLiteralsIn(source: string): readonly string[] {
  const code = source.replace(LEXICAL_TOKEN, (token) => (token.startsWith('/') ? ' ' : token));
  return [...code.matchAll(/\b\d+\b/g)]
    .map((match) => match[0])
    .filter((digits) => POPULATION_SIZES.has(Number(digits)));
}

describe('the report module carries no population size as a literal', () => {
  const source = readFileSync(new URL('./timing-count-report.ts', import.meta.url), 'utf8');

  it('writes no measured population size anywhere in its code', () => {
    expect(populationSizeLiteralsIn(source)).toEqual([]);
  });

  it('positive control: the same scan reports an inserted size literal', () => {
    const violating = `${source}\nconst pinned = ${DERIVATION_POPULATION_SIZE};\n`;

    expect(populationSizeLiteralsIn(violating)).toEqual([String(DERIVATION_POPULATION_SIZE)]);
  });
});
