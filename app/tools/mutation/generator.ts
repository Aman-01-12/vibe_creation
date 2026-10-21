// Deterministically breaking a reference design ON PURPOSE, so a testbench that passes
// everything can be caught.
//
// RELOCATED from `@app/eval/corpus/verilog-mutation.ts` (reference-model-consensus-gate,
// design-answers-round3.md DQ-8/DQ-9 preamble), the same move and the same reason task 4.1
// already gave the rest of the mutation vocabulary: `@app/agent`'s Session orchestrator needs
// to mutate a Candidate_Design's own RTL inside a live Session, and `@app/agent` may never
// import `@app/eval` (Req 17.2, enforced by `consensus-import-boundary.test.ts`).
// `@app/eval/corpus/verilog-mutation.ts` re-exports `generateMutants` and
// `MAX_MUTATED_SOURCE_CHARS` by binding, so every existing eval call site is untouched.
//
// WHAT THIS IS, AND WHAT IT IS EXPLICITLY NOT
//   This is TEXT-LEVEL mutation. It does NOT parse Verilog, does not build a syntax tree,
//   and does not understand scope, types, or elaboration. It finds narrow lexical shapes and
//   rewrites exactly one of them per mutant. Claiming more than that would be the interesting
//   lie here, so the boundary is stated up front: every operator below is a string
//   substitution chosen because its shape is recognizable WITHOUT a parser.
//
// WHY THAT IS SAFE ENOUGH
//   Two independent guards make an imprecise transform degrade to WASTE rather than to a
//   wrong verdict:
//
//   1. Nothing fires on non-code. A single left-to-right scan classifies every character as
//      code or not-code, and no operator may fire on an offset inside a `//` comment, a
//      `/* */` comment, a `"..."` string literal, or a backtick compiler directive. That
//      removes the classic text-mutation failure - editing a comment and calling it a
//      mutant - structurally rather than by hoping the regex is tight.
//   2. A mutant that does not compile is NOT a valid mutant. Both the golden calibration
//      (`@app/eval/corpus/mutation-calibration.ts`) and the in-Session peer calibration
//      (`@app/agent/consensus/mutant-matrix-executor.ts`) discard and COUNT a mutant that
//      fails to build. So an operator that produced garbage costs wall clock and shows up in
//      the non-compiling count; it can never make a testbench look better or worse than it is.
//
//   Guard 2 is why the operators can be pragmatic. Guard 1 is why they are still tight.
//
// DETERMINISM IS A CONTRACT, NOT A CONVENIENCE
//   There is no randomness here, seeded or otherwise. The same reference plus the same
//   `MutationConfig` yields the same mutants, in the same order, with the same ids - which is
//   what makes the golden-testbench calibration cacheable at all, and what makes a survivor
//   reproducible by hand.
//
// THE CAP IS APPLIED BY ROUND-ROBIN, NOT BY "FIRST N FOUND"
//   A reference with forty `+` signs and one reset branch would otherwise spend the whole
//   budget on arithmetic and never test whether a testbench notices a broken reset. So
//   selection takes one site from each operator in `MUTATION_OPERATORS` order, then a second
//   from each, and so on until the cap. Deterministic, and it spreads the budget across
//   defect CLASSES instead of across text positions.
//
// Pure: no clock, no I/O, no randomness.

import { isEntirelyCode, scanSource, type SourceMask } from '../verilog/source-mask.js';
import {
  mutantIdOf,
  MAX_SITE_TEXT_CHARS,
  MUTATION_OPERATORS,
  type Mutant,
  type MutationConfig,
  type MutationOperatorId,
  type MutationSite,
} from './operators.js';

/**
 * Longest reference source this generator will mutate.
 *
 * Matches the bound the corpus's other Verilog readers use. RTLLM references are a few
 * kilobytes, so this is never close; it exists because the source is third-party input and
 * the scan is linear in its length. An over-long source yields NO mutants, which the caller
 * reports as `no-mutants-generated` rather than as a silent partial mutation.
 */
export const MAX_MUTATED_SOURCE_CHARS = 200_000;

/** Most sites one operator contributes, so a pathological source cannot flood selection. */
const MAX_SITES_PER_OPERATOR = 256;

/** Longest `if` condition this generator will rewrite; keeps a site excerpt bounded. */
const MAX_CONDITION_CHARS = 200;

/** Largest literal value `CONST_INCREMENTED` will touch, so the text stays sane. */
const MAX_INCREMENTABLE_VALUE = 1_000_000_000;

/** Characters that may appear inside a Verilog identifier. */
const IDENTIFIER_CHARACTER = /[A-Za-z0-9_$]/;

/** A decimal digit. */
const DECIMAL_DIGIT = /[0-9]/;

/** Base specifiers that may precede a literal's digits (`8'd12`, `4'b0`). */
const BASE_SPECIFIER = /[bBoOdDhH]/;

/** Bases whose digit run is a plain decimal number, so incrementing it is meaningful. */
const DECIMAL_BASES: ReadonlySet<string> = new Set(['d', 'D']);

/** An identifier token naming a reset, however the design spells it. */
const RESET_IDENTIFIER = /\b[A-Za-z_$][A-Za-z0-9_$]*\b/g;

/** Whether an identifier names a reset; deliberately generous, since a false positive here
 * only produces a mutant the golden testbench then judges on its merits. */
const RESET_NAME = /(rst|reset)/i;

/** Whitespace this scanner steps over when looking for a significant character. */
const WHITESPACE: ReadonlySet<string> = new Set([' ', '\t', '\n', '\r', '\f', '\v']);

/**
 * Characters that can END an operand.
 *
 * Used to tell a BINARY `-` from a unary one without parsing: `a - b` has an operand
 * character before the `-`, `= -b` does not. An identifier character covers a name or a
 * digit; the brackets cover an indexed or concatenated operand; the apostrophe covers the
 * tail of a sized literal written `8'd5`.
 */
const OPERAND_TAIL: ReadonlySet<string> = new Set([')', ']', '}', "'"]);

/** One planned single-point mutation of the source. */
interface MutationCandidate {
  readonly operator: MutationOperatorId;
  /** Offset of the first replaced character. */
  readonly start: number;
  /** Offset just past the last replaced character. */
  readonly end: number;
  readonly replacement: string;
}

/** The nearest preceding significant code character, or `null` at the start of the source. */
function precedingOperandCharacter(source: string, mask: SourceMask, index: number): string | null {
  for (let at = index - 1; at >= 0; at -= 1) {
    if (mask.code[at] !== 1) {
      continue;
    }
    const character = source.charAt(at);
    if (!WHITESPACE.has(character)) {
      return character;
    }
  }
  return null;
}

/** Whether an operand ends immediately before `index`, i.e. the operator there is binary. */
function followsOperand(source: string, mask: SourceMask, index: number): boolean {
  const previous = precedingOperandCharacter(source, mask, index);
  if (previous === null) {
    return false;
  }
  return IDENTIFIER_CHARACTER.test(previous) || OPERAND_TAIL.has(previous);
}

/**
 * One operator-token swap, described declaratively.
 *
 * The guards are what keep a one- or two-character substitution from silently becoming a
 * DIFFERENT operator: without `notFollowedBy`, swapping the `<` of `<=` would rewrite a
 * nonblocking assignment, and without `notPrecededBy`, the second `=` of `===` would read as
 * an `==`.
 */
interface TokenSwap {
  readonly operator: MutationOperatorId;
  /** The exact source token to match. */
  readonly token: string;
  readonly replacement: string;
  /** Characters that must not sit immediately before the token. */
  readonly notPrecededBy: readonly string[];
  /** Characters that must not sit immediately after the token. */
  readonly notFollowedBy: readonly string[];
  /** Whether an operand must end immediately before the token (binary position). */
  readonly requiresOperand: boolean;
}

/**
 * The token swaps, with the reason each guard exists.
 *
 * `+:` and `-:` are Verilog part-select operators, `->` is an event trigger, `===`/`!==` are
 * case equality, `<<<`/`>>>` are arithmetic shifts, and `<=` is both less-or-equal and
 * nonblocking assignment. Every one of those is excluded by an adjacency guard rather than by
 * a lookahead into semantics.
 */
const TOKEN_SWAPS: readonly TokenSwap[] = Object.freeze([
  {
    operator: 'ARITH_PLUS_TO_MINUS',
    token: '+',
    replacement: '-',
    notPrecededBy: ['+'],
    notFollowedBy: ['+', '=', ':'],
    requiresOperand: true,
  },
  {
    operator: 'ARITH_MINUS_TO_PLUS',
    token: '-',
    replacement: '+',
    notPrecededBy: ['-'],
    notFollowedBy: ['-', '=', ':', '>'],
    requiresOperand: true,
  },
  {
    operator: 'BITWISE_AND_TO_OR',
    token: '&',
    replacement: '|',
    notPrecededBy: ['&'],
    notFollowedBy: ['&', '='],
    requiresOperand: false,
  },
  {
    operator: 'BITWISE_OR_TO_AND',
    token: '|',
    replacement: '&',
    notPrecededBy: ['|'],
    notFollowedBy: ['|', '='],
    requiresOperand: false,
  },
  {
    operator: 'RELATIONAL_LT_TO_LE',
    token: '<',
    replacement: '<=',
    notPrecededBy: ['<'],
    notFollowedBy: ['<', '=', '>'],
    requiresOperand: true,
  },
  {
    operator: 'EQUALITY_TO_INEQUALITY',
    token: '==',
    replacement: '!=',
    notPrecededBy: ['=', '!', '<', '>'],
    notFollowedBy: ['=', '?'],
    requiresOperand: true,
  },
  {
    operator: 'SHIFT_DIRECTION_SWAPPED',
    token: '<<',
    replacement: '>>',
    notPrecededBy: ['<'],
    notFollowedBy: ['<', '='],
    requiresOperand: true,
  },
  {
    operator: 'SHIFT_DIRECTION_SWAPPED',
    token: '>>',
    replacement: '<<',
    notPrecededBy: ['>'],
    notFollowedBy: ['>', '='],
    requiresOperand: true,
  },
] as const);

/** Whether one token swap may fire at `index`. */
function swapApplies(source: string, mask: SourceMask, swap: TokenSwap, index: number): boolean {
  const end = index + swap.token.length;
  if (!isEntirelyCode(mask, index, end)) {
    return false;
  }
  if (swap.notPrecededBy.includes(source.charAt(index - 1))) {
    return false;
  }
  if (swap.notFollowedBy.includes(source.charAt(end))) {
    return false;
  }
  return !swap.requiresOperand || followsOperand(source, mask, index);
}

/** Every site the declarative token swaps fire on, in ascending offset order. */
function tokenSwapCandidates(source: string, mask: SourceMask): readonly MutationCandidate[] {
  const candidates: MutationCandidate[] = [];
  for (const swap of TOKEN_SWAPS) {
    let found = 0;
    let index = source.indexOf(swap.token);
    while (index >= 0 && found < MAX_SITES_PER_OPERATOR) {
      if (swapApplies(source, mask, swap, index)) {
        const end = index + swap.token.length;
        candidates.push({
          operator: swap.operator,
          start: index,
          end,
          replacement: swap.replacement,
        });
        found += 1;
      }
      index = source.indexOf(swap.token, index + 1);
    }
  }
  return candidates;
}

/** One `if` statement's parenthesized condition. */
interface ConditionSite {
  /** Offset of the `(`. */
  readonly open: number;
  /** Offset just past the `)`. */
  readonly end: number;
  /** The raw text between the parentheses, comments and all. */
  readonly inner: string;
}

/** Whether `[index, index + 2)` is the keyword `if` standing on its own. */
function isIfKeyword(source: string, mask: SourceMask, index: number): boolean {
  if (source.charAt(index) !== 'i' || source.charAt(index + 1) !== 'f') {
    return false;
  }
  if (!isEntirelyCode(mask, index, index + 2)) {
    return false;
  }
  const before = source.charAt(index - 1);
  const after = source.charAt(index + 2);
  return !IDENTIFIER_CHARACTER.test(before) && !IDENTIFIER_CHARACTER.test(after);
}

/** The offset of the `(` opening this `if`'s condition, or `null` when there is none. */
function conditionOpenParen(source: string, mask: SourceMask, afterIf: number): number | null {
  for (let at = afterIf; at < source.length; at += 1) {
    if (mask.code[at] !== 1) {
      continue;
    }
    const character = source.charAt(at);
    if (WHITESPACE.has(character)) {
      continue;
    }
    return character === '(' ? at : null;
  }
  return null;
}

/** The offset just past the `)` matching `open`, or `null` when the parens do not balance. */
function matchingCloseParen(source: string, mask: SourceMask, open: number): number | null {
  let depth = 0;
  const limit = Math.min(source.length, open + MAX_CONDITION_CHARS);
  for (let at = open; at < limit; at += 1) {
    if (mask.code[at] !== 1) {
      continue;
    }
    const character = source.charAt(at);
    if (character === '(') {
      depth += 1;
    } else if (character === ')') {
      depth -= 1;
      if (depth === 0) {
        return at + 1;
      }
    }
  }
  return null;
}

/** Every `if` condition in the source, in ascending offset order. */
function findConditions(source: string, mask: SourceMask): readonly ConditionSite[] {
  const sites: ConditionSite[] = [];
  for (let at = 0; at + 1 < source.length && sites.length < MAX_SITES_PER_OPERATOR; at += 1) {
    if (!isIfKeyword(source, mask, at)) {
      continue;
    }
    const open = conditionOpenParen(source, mask, at + 2);
    if (open === null) {
      continue;
    }
    const end = matchingCloseParen(source, mask, open);
    if (end === null) {
      continue;
    }
    sites.push({ open, end, inner: source.slice(open + 1, end - 1) });
  }
  return sites;
}

/** Whether a condition's own identifiers name a reset. */
function mentionsReset(inner: string): boolean {
  for (const match of inner.matchAll(RESET_IDENTIFIER)) {
    if (RESET_NAME.test(match[0])) {
      return true;
    }
  }
  return false;
}

/**
 * The `if`-anchored candidates: an inverted branch, and a reset that never fires.
 *
 * `RESET_BRANCH_DISABLED` neutralizes the condition rather than deleting the branch's
 * statements. Deleting statements from text is not provably safe without a parser - the
 * branch may be a bare statement, a `begin`/`end` block, or a nest of both - whereas
 * replacing a balanced parenthesized condition with `(1'b0)` leaves the syntax intact and
 * still makes the reset unreachable, which is the behaviour the mutation is about.
 */
function conditionCandidates(source: string, mask: SourceMask): readonly MutationCandidate[] {
  const candidates: MutationCandidate[] = [];
  for (const site of findConditions(source, mask)) {
    candidates.push({
      operator: 'CONDITION_NEGATED',
      start: site.open,
      end: site.end,
      replacement: `(!(${site.inner}))`,
    });
    if (mentionsReset(site.inner)) {
      candidates.push({
        operator: 'RESET_BRANCH_DISABLED',
        start: site.open,
        end: site.end,
        replacement: "(1'b0)",
      });
    }
  }
  return candidates;
}

/** One run of decimal digits that forms a complete literal value. */
interface NumericRun {
  readonly start: number;
  readonly end: number;
  readonly digits: string;
  /** Whether the run sits inside a `[...]`, i.e. is an index or a range bound. */
  readonly bracketed: boolean;
  /** Whether the run is the SIZE of a sized literal (`8'd12`), which must not be perturbed. */
  readonly sizePrefix: boolean;
  /** The base letter when the run follows `'<base>`, else `null`. */
  readonly base: string | null;
}

/** The base specifier a digit run sits behind, or `null` when it has none. */
function runBase(source: string, start: number): string | null {
  const previous = source.charAt(start - 1);
  if (previous === "'") {
    return null;
  }
  return BASE_SPECIFIER.test(previous) && source.charAt(start - 2) === "'" ? previous : null;
}

/** Whether a digit run is a complete literal value rather than part of a longer token. */
function isCompleteLiteral(source: string, start: number, end: number): boolean {
  const previous = source.charAt(start - 1);
  const next = source.charAt(end);
  if (previous === '.' || next === '.') {
    return false;
  }
  if (next.length > 0 && IDENTIFIER_CHARACTER.test(next) && !DECIMAL_DIGIT.test(next)) {
    // A trailing letter means a hex literal (`'h1F`) or an identifier suffix (`bit0a`).
    return false;
  }
  if (!IDENTIFIER_CHARACTER.test(previous)) {
    return true;
  }
  return runBase(source, start) !== null;
}

/** Every complete decimal-digit literal run in the source, in ascending offset order. */
function findNumericRuns(source: string, mask: SourceMask): readonly NumericRun[] {
  const runs: NumericRun[] = [];
  let at = 0;
  while (at < source.length) {
    if (mask.code[at] !== 1 || !DECIMAL_DIGIT.test(source.charAt(at))) {
      at += 1;
      continue;
    }
    let end = at;
    while (end < source.length && mask.code[end] === 1 && DECIMAL_DIGIT.test(source.charAt(end))) {
      end += 1;
    }
    if (isCompleteLiteral(source, at, end)) {
      runs.push({
        start: at,
        end,
        digits: source.slice(at, end),
        bracketed: (mask.bracketDepth[at] ?? 0) > 0,
        sizePrefix: source.charAt(end) === "'",
        base: runBase(source, at),
      });
    }
    at = end + 1;
  }
  return runs;
}

/** Whether a run's base makes decimal arithmetic on its digits meaningful. */
function isDecimalValued(run: NumericRun): boolean {
  return run.base === null || DECIMAL_BASES.has(run.base);
}

/**
 * The literal-perturbation candidates.
 *
 * The three are kept DISJOINT so no two operators produce the same mutant twice:
 *   - `CONST_ZERO_TO_ONE` takes unbracketed zeros of any base (`'d0`, `4'b0`, a bare `0`);
 *   - `CONST_INCREMENTED` takes unbracketed non-zero DECIMAL literals;
 *   - `INDEX_OFF_BY_ONE` takes bracketed decimal literals, and owns them exclusively,
 *     because a bit-select index moving is a different defect class from a wrong constant.
 * A sized literal's SIZE prefix is excluded from all three: perturbing the `8` of `8'd12`
 * changes the literal's width rather than its value, which is a different experiment.
 */
function literalCandidates(source: string, mask: SourceMask): readonly MutationCandidate[] {
  const candidates: MutationCandidate[] = [];
  for (const run of findNumericRuns(source, mask)) {
    if (run.sizePrefix) {
      continue;
    }
    const value = Number.parseInt(run.digits, 10);
    const span = { start: run.start, end: run.end };
    if (run.bracketed && isDecimalValued(run)) {
      const moved = value > 0 ? value - 1 : 1;
      candidates.push({ operator: 'INDEX_OFF_BY_ONE', ...span, replacement: String(moved) });
    } else if (run.bracketed) {
      continue;
    } else if (value === 0) {
      candidates.push({ operator: 'CONST_ZERO_TO_ONE', ...span, replacement: '1' });
    } else if (isDecimalValued(run) && value < MAX_INCREMENTABLE_VALUE) {
      candidates.push({ operator: 'CONST_INCREMENTED', ...span, replacement: String(value + 1) });
    }
  }
  return candidates;
}

/**
 * Apply the cap by ROUND-ROBIN across operators (pure, deterministic).
 *
 * Sites of one operator are taken in ascending offset order, and operators are visited in
 * `MUTATION_OPERATORS` order, so the selection is a function of the source and the config
 * alone. The effect is that the budget is spread over defect classes: a reference with forty
 * `+` signs still gets its reset branch and its bit-selects mutated.
 */
function selectCandidates(
  candidates: readonly MutationCandidate[],
  config: MutationConfig,
): readonly MutationCandidate[] {
  const enabled = new Set(config.operators);
  const byOperator = new Map<MutationOperatorId, MutationCandidate[]>();
  for (const operator of MUTATION_OPERATORS) {
    if (!enabled.has(operator)) {
      continue;
    }
    const forOperator = candidates
      .filter((candidate) => candidate.operator === operator)
      .sort((left, right) => left.start - right.start);
    if (forOperator.length > 0) {
      byOperator.set(operator, forOperator);
    }
  }
  const selected: MutationCandidate[] = [];
  const deepest = Math.max(0, ...[...byOperator.values()].map((group) => group.length));
  for (
    let round = 0;
    round < deepest && selected.length < config.maxMutantsPerProblem;
    round += 1
  ) {
    for (const group of byOperator.values()) {
      const candidate = group[round];
      if (candidate !== undefined && selected.length < config.maxMutantsPerProblem) {
        selected.push(candidate);
      }
    }
  }
  return selected;
}

/** The 1-based line and column of an offset. */
function locate(mask: SourceMask, offset: number): { line: number; column: number } {
  let low = 0;
  let high = mask.lineStarts.length - 1;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if ((mask.lineStarts[middle] ?? 0) <= offset) {
      low = middle;
    } else {
      high = middle - 1;
    }
  }
  return { line: low + 1, column: offset - (mask.lineStarts[low] ?? 0) + 1 };
}

/** The bounded site record for one selected candidate. */
function siteOf(source: string, mask: SourceMask, candidate: MutationCandidate): MutationSite {
  const { line, column } = locate(mask, candidate.start);
  return {
    line,
    column,
    before: source.slice(candidate.start, candidate.end).slice(0, MAX_SITE_TEXT_CHARS),
    after: candidate.replacement.slice(0, MAX_SITE_TEXT_CHARS),
  };
}

/**
 * Generate the mutant set for one reference source (pure, deterministic, total).
 *
 * Each mutant differs from the reference in EXACTLY ONE site, so a survivor names one
 * concrete defect a testbench does not notice rather than a combination that would be
 * ambiguous to diagnose. Returns an empty array for an empty, over-long, or shape-free
 * source; the caller reports that as `no-mutants-generated`.
 */
export function generateMutants(source: string, config: MutationConfig): readonly Mutant[] {
  if (source.length === 0 || source.length > MAX_MUTATED_SOURCE_CHARS) {
    return [];
  }
  const mask = scanSource(source);
  const candidates = [
    ...tokenSwapCandidates(source, mask),
    ...conditionCandidates(source, mask),
    ...literalCandidates(source, mask),
  ];
  return selectCandidates(candidates, config).map((candidate) => {
    const site = siteOf(source, mask, candidate);
    return {
      mutantId: mutantIdOf(candidate.operator, site),
      operator: candidate.operator,
      site,
      rtl: source.slice(0, candidate.start) + candidate.replacement + source.slice(candidate.end),
    };
  });
}
