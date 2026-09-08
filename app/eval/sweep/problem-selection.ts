// Resolving a config's problem selection against the SCORED corpus.
//
// WHY THE SCORED CORPUS AND NOTHING ELSE
//   Four RTLLM designs are quarantined because their own golden testbench is not a usable
//   measuring stick under Icarus - the reference does not pass its own testbench, so the
//   judge cannot tell "the candidate is wrong" from "the judge is broken" (see
//   `../corpus/stage0-quarantine.ts`). Scoring against them would produce a number whose
//   denominator includes problems nobody can pass. So a selection always resolves within
//   the scored set, and the manifest records the exclusions that were applied.
//
// AN EMPTY SELECTION IS AN ERROR, NOT AN EMPTY RUN
//   A typo'd problem id or a category with no scored designs left would otherwise produce
//   a run that finishes instantly and reports pass@k over zero problems - which reads as
//   a completed experiment. It fails instead, naming the ids that did not match.

import type { EvalProblem } from '../problem.js';
import { asRtllmCategory, type RtllmCategory } from '../corpus/pinned-source.js';
import type { SweepProblemSelection } from './config.js';
import { configFailure, configValue, type SweepConfigResult } from './config-values.js';

/** Most unmatched ids named in one error message, so it stays readable. */
const MAX_REPORTED_UNMATCHED = 10;

/**
 * The category segment of a `rtllm/<category>/<design>` id, or null.
 *
 * Derived from the id rather than stored on the problem, because the id is the stable
 * published key and the corpus importer already guarantees its shape.
 */
function categoryOf(problemId: string): RtllmCategory | null {
  const segment = problemId.split('/')[1];
  if (segment === undefined || segment.length === 0) {
    return null;
  }
  return asRtllmCategory(segment.charAt(0).toUpperCase() + segment.slice(1));
}

/** Select by explicit id, reporting every id that matched nothing. */
function selectByIds(
  scored: readonly EvalProblem[],
  ids: readonly string[],
): SweepConfigResult<readonly EvalProblem[]> {
  const byId = new Map(scored.map((problem) => [problem.id, problem]));
  const selected: EvalProblem[] = [];
  const unmatched: string[] = [];
  for (const id of ids) {
    const problem = byId.get(id);
    if (problem === undefined) {
      unmatched.push(id);
      continue;
    }
    selected.push(problem);
  }
  if (unmatched.length > 0) {
    const shown = unmatched.slice(0, MAX_REPORTED_UNMATCHED).join(', ');
    const more = unmatched.length > MAX_REPORTED_UNMATCHED ? ', ...' : '';
    return configFailure(
      'PROBLEM_SELECTION_INVALID',
      'problems.ids',
      `these problem ids are not in the scored corpus: ${shown}${more}`,
    );
  }
  return configValue(selected);
}

/** Select by category, preserving the corpus's own deterministic order. */
function selectByCategories(
  scored: readonly EvalProblem[],
  categories: readonly RtllmCategory[],
): SweepConfigResult<readonly EvalProblem[]> {
  const wanted = new Set(categories);
  const selected = scored.filter((problem) => {
    const category = categoryOf(problem.id);
    return category !== null && wanted.has(category);
  });
  if (selected.length === 0) {
    return configFailure(
      'PROBLEM_SELECTION_INVALID',
      'problems.categories',
      `no scored problem belongs to: ${categories.join(', ')}`,
    );
  }
  return configValue(selected);
}

/**
 * Resolve a selection to the problems that will actually be run, in corpus order.
 *
 * Order is the corpus's own, never the config's, so two configs naming the same problems
 * in different orders plan the same run and their manifests list the same sequence.
 */
export function selectProblems(
  scored: readonly EvalProblem[],
  selection: SweepProblemSelection,
): SweepConfigResult<readonly EvalProblem[]> {
  if (scored.length === 0) {
    return configFailure(
      'PROBLEM_SELECTION_INVALID',
      'problems',
      'the scored corpus is empty; run `npm run corpus:fetch` and re-check the import',
    );
  }
  if (selection.kind === 'all') {
    return configValue(scored);
  }
  if (selection.kind === 'categories') {
    return selectByCategories(scored, selection.categories);
  }
  const byIds = selectByIds(scored, selection.ids);
  if (!byIds.ok) {
    return byIds;
  }
  const wanted = new Set(byIds.value.map((problem) => problem.id));
  return configValue(scored.filter((problem) => wanted.has(problem.id)));
}
