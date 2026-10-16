// The Model_Fragment contract: the only model text that reaches a Scoreboard_Testbench
// (testbench-in-order-scoreboard, C3 and C4).
//
// Model output spliced into Verilog is a trust boundary. The scaffold is product code; the model
// supplies a run length, one Expectation expression per Data_Output, and stimulus statements per
// required check, and nothing reaches the assembler until it has been validated here.

import { err, ok, type Result } from '@app/core';
import {
  balanceRefusal,
  constructName,
  foreignSpanRefusal,
  lexAdmitted,
  type AdmitList,
  type LexToken,
} from '@app/tools';

import { parseJsonEnvelope } from '../../model-output-envelope.js';

/** The longest Transaction_Run a fragment may declare; `serial2parallel` needs 8. */
export const MAX_RUN_LENGTH = 16;

/** Static bound on `send_transaction` plus `idle_cycle` executions, so a run always ends. */
export const MAX_STIMULUS_CALLS = 512;

/** Per-fragment and whole-reply length caps, in characters, checked before any parse. */
export const MAX_EXPECTATION_CHARS = 2_000;
export const MAX_STIMULUS_CHARS = 8_000;
export const MAX_REPLY_CHARS = 64_000;

/** The Requirement 4 criterion a refused fragment failed. */
export type FragmentCriterion = '4.7' | '4.11' | '4.12';

/** Why a reply was refused: which fragment, which criterion, and the construct that failed it. */
export interface FragmentRefusal {
  /** `runLength`, `expectations.<port>`, `stimulus.<check>`, or `reply` for the object itself. */
  readonly fragment: string;
  readonly criterion: FragmentCriterion;
  /** Printable and bounded, because untrusted text produced it. */
  readonly construct: string;
}

/**
 * Module-private brand key: nothing outside this module can name it, so only this module's
 * validator can construct a `ValidatedFragments`, and the assembler cannot be handed raw text.
 */
declare const VALIDATED_FRAGMENTS: unique symbol;

/** A reply every fragment of which passed validation. The brand is the point. */
export interface ValidatedFragments {
  readonly runLength: number;
  /** Data_Output name to its Expectation expression, byte-identical to the model's text. */
  readonly expectations: ReadonlyMap<string, string>;
  /** Required check name to its stimulus statements, byte-identical to the model's text. */
  readonly stimulus: ReadonlyMap<string, string>;
  readonly [VALIDATED_FRAGMENTS]: true;
}

// -- The validator ------------------------------------------------------------------------

/** What the validator needs from a scaffold: which names exist to be read and filled. */
export interface FragmentTargets {
  readonly dataInputs: readonly { readonly name: string }[];
  readonly dataOutputs: readonly { readonly name: string }[];
  readonly checkNames: readonly string[];
}

/**
 * One validation failure inside a fragment, before it is attributed to its key. An `Error`
 * so the parser can unwind from any depth; it never escapes `attempt`, so callers see values.
 */
class Fault extends Error {
  constructor(
    readonly criterion: FragmentCriterion,
    readonly construct: string,
  ) {
    super(construct);
  }
}

const NOT_SINGLE_EXPRESSION = 'not a single expression';
const NOT_A_STATEMENT = 'not a stimulus statement';
const LOOP_VARIABLES: ReadonlySet<string> = new Set(['stim_i', 'stim_j', 'stim_k']);
const STIMULUS_CALLS: ReadonlySet<string> = new Set(['send_transaction', 'idle_cycle']);
const UNARY_OPERATORS: ReadonlySet<string> = new Set([
  '!',
  '~',
  '&',
  '|',
  '^',
  '~&',
  '~|',
  '~^',
  '^~',
  '+',
  '-',
]);
/** Binary operators, listed rather than inferred, so `;` and `=` can never chain an expression. */
const BINARY_OPERATORS: ReadonlySet<string> = new Set([
  '===',
  '!==',
  '==',
  '!=',
  '&&',
  '||',
  '<=',
  '>=',
  '<<<',
  '>>>',
  '<<',
  '>>',
  '**',
  '~^',
  '^~',
  '&',
  '|',
  '^',
  '+',
  '-',
  '*',
  '/',
  '%',
  '<',
  '>',
]);
const DECIMAL = /^[0-9]+$/;

/**
 * A cursor over admitted tokens. Every parse method either consumes tokens and returns, or
 * throws a `Fault`; the throw stays inside this module, so the public parser stays total.
 */
class TokenCursor {
  #index = 0;
  readonly #tokens: readonly LexToken[];
  readonly #criterion: FragmentCriterion;

  constructor(tokens: readonly LexToken[], criterion: FragmentCriterion) {
    this.#tokens = tokens;
    this.#criterion = criterion;
  }

  peek(offset = 0): LexToken | undefined {
    return this.#tokens[this.#index + offset];
  }

  done(): boolean {
    return this.#index >= this.#tokens.length;
  }

  next(): LexToken {
    const token = this.#tokens[this.#index];
    if (token === undefined) {
      throw this.fault(NOT_SINGLE_EXPRESSION);
    }
    this.#index += 1;
    return token;
  }

  /** Consume `text` or fail naming what was found instead. */
  expect(text: string): void {
    const token = this.next();
    if (token.text !== text) {
      throw this.fault(token.text);
    }
  }

  accept(text: string): boolean {
    if (this.peek()?.text !== text) {
      return false;
    }
    this.#index += 1;
    return true;
  }

  fault(construct: string): Fault {
    return new Fault(this.#criterion, constructName(construct));
  }
}

/** How a grammar reads one operand; the two fragment kinds differ only here. */
type OperandReader = (cursor: TokenCursor, token: LexToken) => void;

function readExpression(cursor: TokenCursor, operand: OperandReader): void {
  readBinary(cursor, operand);
  if (cursor.accept('?')) {
    readExpression(cursor, operand);
    cursor.expect(':');
    readExpression(cursor, operand);
  }
}

/** Binary chains are accepted whatever their precedence, because only membership is decided. */
function readBinary(cursor: TokenCursor, operand: OperandReader): void {
  readUnary(cursor, operand);
  for (;;) {
    const token = cursor.peek();
    if (token?.kind !== 'operator' || !BINARY_OPERATORS.has(token.text)) {
      return;
    }
    cursor.next();
    readUnary(cursor, operand);
  }
}

function readUnary(cursor: TokenCursor, operand: OperandReader): void {
  while (cursor.peek()?.kind === 'operator' && UNARY_OPERATORS.has(cursor.peek()?.text ?? '')) {
    cursor.next();
  }
  readPrimary(cursor, operand);
}

function readPrimary(cursor: TokenCursor, operand: OperandReader): void {
  const token = cursor.next();
  if (token.kind === 'number') {
    return;
  }
  if (token.text === '(') {
    readExpression(cursor, operand);
    cursor.expect(')');
    return;
  }
  if (token.text === '{') {
    readBraces(cursor, operand);
    return;
  }
  if (token.kind === 'word' || token.kind === 'system') {
    operand(cursor, token);
    return;
  }
  throw cursor.fault(token.text);
}

/** `{a, b}` concatenation or `{N{a}}` replication. */
function readBraces(cursor: TokenCursor, operand: OperandReader): void {
  if (cursor.peek()?.kind === 'number' && cursor.peek(1)?.text === '{') {
    cursor.next();
    cursor.next();
    readExpression(cursor, operand);
    cursor.expect('}');
    cursor.expect('}');
    return;
  }
  readExpression(cursor, operand);
  while (cursor.accept(',')) {
    readExpression(cursor, operand);
  }
  cursor.expect('}');
}

/** An optional `[n]` or `[n:m]` select with constant indices. */
function readConstantSelect(cursor: TokenCursor): void {
  if (!cursor.accept('[')) {
    return;
  }
  const first = cursor.next();
  if (first.kind !== 'number') {
    throw cursor.fault(first.text);
  }
  if (cursor.accept(':')) {
    const second = cursor.next();
    if (second.kind !== 'number') {
      throw cursor.fault(second.text);
    }
  }
  cursor.expect(']');
}

/**
 * The expression operators a fragment may use, longest first. Kept apart from the formal
 * Property_Validator's list on purpose: a change to what the formal gate admits must never
 * silently widen this boundary. Absent, so refused: `.`, `;` (in an expression), `#`, and `@`.
 */
const EXPRESSION_OPERATORS: readonly string[] = [
  '===',
  '!==',
  '<<<',
  '>>>',
  '==',
  '!=',
  '&&',
  '||',
  '<=',
  '>=',
  '<<',
  '>>',
  '**',
  '~^',
  '^~',
  '~&',
  '~|',
  '!',
  '~',
  '&',
  '|',
  '^',
  '+',
  '-',
  '*',
  '/',
  '%',
  '<',
  '>',
  '?',
  ':',
  ',',
  '(',
  ')',
  '[',
  ']',
  '{',
  '}',
];

const EXPECTATION_ADMIT: AdmitList = {
  systemNames: new Set(),
  reservedWords: new Set(),
  operators: EXPRESSION_OPERATORS,
};

const STIMULUS_ADMIT: AdmitList = {
  systemNames: new Set(['$random']),
  reservedWords: new Set(),
  // `=` and `;` come last, so the longer `==`, `<=`, and `>=` still win the first match.
  operators: [...EXPRESSION_OPERATORS, '=', ';'],
};

/** Lex a fragment, or the fault that refuses it, under one criterion. */
function lexFragment(
  text: string,
  admit: AdmitList,
  criterion: FragmentCriterion,
): readonly LexToken[] | Fault {
  const refusal = foreignSpanRefusal(text) ?? balanceRefusal(text);
  const lexed = refusal === null ? lexAdmitted(text, admit) : err(refusal);
  if (lexed.ok) {
    return lexed.value;
  }
  return new Fault(
    criterion,
    lexed.error.reason === 'unaccepted-construct' ? lexed.error.construct : 'unbalanced',
  );
}

/** Run a parse, turning a thrown `Fault` back into a value; any other throw is a defect. */
function attempt(parse: () => void): Fault | null {
  try {
    parse();
    return null;
  } catch (thrown) {
    if (thrown instanceof Fault) {
      return thrown;
    }
    throw thrown;
  }
}

/** Validate one Expectation expression: exactly one expression over its run's inputs (Req 4.11). */
function expectationFault(text: string, targets: FragmentTargets, runLength: number): Fault | null {
  if (text.trim().length === 0) {
    return new Fault('4.11', NOT_SINGLE_EXPRESSION);
  }
  const tokens = lexFragment(text, EXPECTATION_ADMIT, '4.11');
  if (tokens instanceof Fault) {
    return tokens;
  }
  const recorded = new Set(targets.dataInputs.map((port) => `txn_${port.name}`));
  const operand: OperandReader = (cursor, token) => {
    if (token.kind !== 'word' || !recorded.has(token.text)) {
      throw cursor.fault(token.text);
    }
    cursor.expect('[');
    const index = cursor.next();
    if (!DECIMAL.test(index.text) || Number(index.text) >= runLength) {
      throw cursor.fault(`${token.text}[${index.text}]`);
    }
    cursor.expect(']');
    readConstantSelect(cursor);
  };
  const cursor = new TokenCursor(tokens, '4.11');
  return attempt(() => {
    readExpression(cursor, operand);
    if (!cursor.done()) {
      throw cursor.fault(NOT_SINGLE_EXPRESSION);
    }
  });
}

/** Saturating arithmetic, so a hostile nest of loops cannot overflow the call count. */
const CALL_CEILING = MAX_STIMULUS_CALLS + 1;
function capped(value: number): number {
  return Math.min(value, CALL_CEILING);
}

/** The stimulus grammar (Req 4.12), returning each statement's largest call count. */
class StimulusParser {
  readonly #cursor: TokenCursor;
  readonly #staged: ReadonlySet<string>;
  readonly #loops: string[] = [];

  constructor(tokens: readonly LexToken[], targets: FragmentTargets) {
    this.#cursor = new TokenCursor(tokens, '4.12');
    this.#staged = new Set(targets.dataInputs.map((port) => `stage_${port.name}`));
  }

  statements(until: string | null): number {
    let calls = 0;
    while (until === null ? !this.#cursor.done() : this.#cursor.peek()?.text !== until) {
      calls = capped(calls + this.statement());
    }
    return calls;
  }

  statement(): number {
    const token = this.#cursor.next();
    switch (token.text) {
      case 'begin': {
        const calls = this.statements('end');
        this.#cursor.expect('end');
        return calls;
      }
      case 'if':
        return this.conditional();
      case 'repeat':
        return this.repeat();
      case 'for':
        return this.loop();
      default:
        return this.simple(token);
    }
  }

  conditional(): number {
    this.#cursor.expect('(');
    this.expression();
    this.#cursor.expect(')');
    const then = this.statement();
    return this.#cursor.accept('else') ? Math.max(then, this.statement()) : then;
  }

  repeat(): number {
    this.#cursor.expect('(');
    const count = this.decimal();
    this.#cursor.expect(')');
    return capped(count * this.statement());
  }

  /** `for (v = A; v < B; v = v + C)`, the one loop shape whose trip count is static. */
  loop(): number {
    this.#cursor.expect('(');
    const variable = this.loopVariable();
    // Reusing an enclosing loop's variable would reassign it and break the static call bound.
    if (this.#loops.includes(variable)) {
      throw this.#cursor.fault(`${variable} reused by a nested loop`);
    }
    this.#cursor.expect('=');
    const from = this.decimal();
    this.#cursor.expect(';');
    this.sameVariable(variable);
    this.#cursor.expect('<');
    const to = this.decimal();
    this.#cursor.expect(';');
    this.sameVariable(variable);
    this.#cursor.expect('=');
    this.sameVariable(variable);
    this.#cursor.expect('+');
    const step = this.decimal();
    this.#cursor.expect(')');
    if (step < 1) {
      throw this.#cursor.fault('for step < 1');
    }
    this.#loops.push(variable);
    const body = this.statement();
    this.#loops.pop();
    return capped(Math.max(0, Math.ceil((to - from) / step)) * body);
  }

  /** A call, or an assignment to a staging register or a loop variable. */
  simple(token: LexToken): number {
    if (STIMULUS_CALLS.has(token.text)) {
      // `send_transaction();` is the same zero-argument call, and Icarus accepts it at -g2001.
      if (this.#cursor.accept('(')) {
        this.#cursor.expect(')');
      }
      this.#cursor.expect(';');
      return 1;
    }
    if (this.#staged.has(token.text)) {
      readConstantSelect(this.#cursor);
    } else if (LOOP_VARIABLES.has(token.text)) {
      if (this.#loops.includes(token.text)) {
        throw this.#cursor.fault(`${token.text} assigned in its own loop`);
      }
    } else {
      throw this.#cursor.fault(
        token.kind === 'operator' ? token.text : token.text || NOT_A_STATEMENT,
      );
    }
    this.#cursor.expect('=');
    this.expression();
    this.#cursor.expect(';');
    return 0;
  }

  expression(): void {
    readExpression(this.#cursor, (cursor, token) => {
      if (token.text === '$random') {
        return;
      }
      if (LOOP_VARIABLES.has(token.text)) {
        // A bit of a loop counter (`stim_i[0]`) still reads only the loop counter.
        readConstantSelect(cursor);
        return;
      }
      if (!this.#staged.has(token.text)) {
        throw cursor.fault(token.text);
      }
      readConstantSelect(cursor);
    });
  }

  loopVariable(): string {
    const token = this.#cursor.next();
    if (!LOOP_VARIABLES.has(token.text)) {
      throw this.#cursor.fault(token.text);
    }
    return token.text;
  }

  sameVariable(variable: string): void {
    this.#cursor.expect(variable);
  }

  decimal(): number {
    const token = this.#cursor.next();
    if (!DECIMAL.test(token.text)) {
      throw this.#cursor.fault(token.text);
    }
    return Number(token.text);
  }
}

/** Validate one stimulus fragment and return its largest call count, or why it is refused. */
function stimulusCalls(text: string, targets: FragmentTargets): number | Fault {
  const tokens = lexFragment(text, STIMULUS_ADMIT, '4.12');
  if (tokens instanceof Fault) {
    return tokens;
  }
  const parser = new StimulusParser(tokens, targets);
  let calls = 0;
  const fault = attempt(() => {
    calls = parser.statements(null);
  });
  return fault ?? calls;
}

function refusal(fragment: string, fault: Fault): Result<ValidatedFragments, FragmentRefusal> {
  return err({ fragment, criterion: fault.criterion, construct: fault.construct });
}

function shapeRefusal(
  fragment: string,
  construct: string,
): Result<ValidatedFragments, FragmentRefusal> {
  return err({ fragment, criterion: '4.7', construct: constructName(construct) });
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether an object's own keys are exactly `expected`, in any order. */
function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

/** Read `object[key]` as a bounded string, or null. */
function boundedString(object: Record<string, unknown>, key: string, cap: number): string | null {
  const value = object[key];
  return typeof value === 'string' && value.length <= cap ? value : null;
}

/** The reply's three-key shape, before any fragment grammar is applied. */
interface ReplyShape {
  readonly runLength: number;
  readonly expectations: Record<string, unknown>;
  readonly stimulus: Record<string, unknown>;
}

/**
 * The run length as an integer in range, or null. A string of decimal digits is the same
 * number: models in the paid run wrote `"4"` for 4, and refusing it measured JSON typing.
 */
function runLengthOf(value: unknown): number | null {
  const parsed = typeof value === 'string' && DECIMAL.test(value) ? Number(value) : value;
  return typeof parsed === 'number' &&
    Number.isInteger(parsed) &&
    parsed >= 1 &&
    parsed <= MAX_RUN_LENGTH
    ? parsed
    : null;
}

function replyShape(raw: string, targets: FragmentTargets): ReplyShape | FragmentRefusal {
  const fail = (fragment: string, construct: string): FragmentRefusal => ({
    fragment,
    criterion: '4.7',
    construct: constructName(construct),
  });
  if (raw.length > MAX_REPLY_CHARS) {
    return fail('reply', 'reply too long');
  }
  const parsed = parseJsonEnvelope(raw);
  if (!parsed.ok || !isPlainObject(parsed.value)) {
    return fail('reply', 'not a JSON object');
  }
  const reply = parsed.value;
  if (!hasExactKeys(reply, ['runLength', 'expectations', 'stimulus'])) {
    return fail('reply', 'unexpected keys');
  }
  const runLength = runLengthOf(reply.runLength);
  if (runLength === null) {
    return fail('runLength', 'runLength out of range');
  }
  const { expectations, stimulus } = reply;
  if (
    !isPlainObject(expectations) ||
    !hasExactKeys(
      expectations,
      targets.dataOutputs.map((port) => port.name),
    )
  ) {
    return fail('expectations', 'keys must be the data outputs');
  }
  if (!isPlainObject(stimulus) || !hasExactKeys(stimulus, targets.checkNames)) {
    return fail('stimulus', 'keys must be the required checks');
  }
  return { runLength, expectations, stimulus };
}

/**
 * Parse and validate a model reply against the scaffold it will fill. Pure and total: it never
 * throws, and it returns the first refusal in key order, so the result is deterministic.
 *
 * Accepted fragment text is returned byte-identical, so the assembler splices exactly what the
 * model wrote and nothing the validator re-printed.
 */
export function parseFragmentReply(
  raw: string,
  targets: FragmentTargets,
): Result<ValidatedFragments, FragmentRefusal> {
  const shape = replyShape(raw, targets);
  if ('fragment' in shape) {
    return err(shape);
  }
  const expectations = new Map<string, string>();
  for (const port of targets.dataOutputs) {
    const key = `expectations.${port.name}`;
    const text = boundedString(shape.expectations, port.name, MAX_EXPECTATION_CHARS);
    if (text === null) {
      return shapeRefusal(key, 'not a bounded string');
    }
    const fault = expectationFault(text, targets, shape.runLength);
    if (fault !== null) {
      return refusal(key, fault);
    }
    expectations.set(port.name, text);
  }
  const stimulus = new Map<string, string>();
  let totalCalls = 0;
  for (const check of targets.checkNames) {
    const key = `stimulus.${check}`;
    const text = boundedString(shape.stimulus, check, MAX_STIMULUS_CHARS);
    if (text === null) {
      return shapeRefusal(key, 'not a bounded string');
    }
    const calls = stimulusCalls(text, targets);
    if (typeof calls !== 'number') {
      return refusal(key, calls);
    }
    totalCalls = capped(totalCalls + calls);
    if (totalCalls > MAX_STIMULUS_CALLS) {
      return refusal(key, new Fault('4.12', `stimulus calls > ${String(MAX_STIMULUS_CALLS)}`));
    }
    stimulus.set(check, text);
  }
  // The brand's only constructor: the key is undeclarable outside this module, so the cast is
  // the point rather than an escape hatch.
  const validated = { runLength: shape.runLength, expectations, stimulus };
  return ok(validated as unknown as ValidatedFragments);
}
