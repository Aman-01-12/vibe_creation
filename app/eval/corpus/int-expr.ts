// A tiny, total integer-expression evaluator for Verilog port-range bounds.
//
// A port declared `output [DATA_WIDTH:0] result` has a width only once
// `DATA_WIDTH` is resolved and `msb - lsb + 1` is computed, so importing a
// parameterized reference means evaluating small integer expressions like
// `DATA_WIDTH-1`, `size*2-1`, or `$clog2(DEPTH)-1`.
//
// This is a hand-written tokenizer plus recursive-descent parser on purpose. The
// input is third-party benchmark source - untrusted external input by our own
// rules - so `eval`, `new Function`, or any other host-language execution of it is
// out of the question. What is supported is exactly what the corpus needs and no
// more: decimal literals, sized Verilog literals, identifiers resolved from a
// caller-supplied table, `$clog2`, unary minus, and `+ - * / % ( )`. Anything
// outside that vocabulary FAILS rather than being guessed at, so a design whose
// range we cannot resolve is quarantined instead of being imported with a wrong
// width.

/** A resolved integer, or the reason the expression could not be evaluated. */
export type IntExprResult =
  { readonly ok: true; readonly value: number } | { readonly ok: false; readonly reason: string };

/** Identifier values available to the expression (Verilog parameters/localparams). */
export type IntExprScope = ReadonlyMap<string, number>;

/** The longest expression this evaluator will consider; bounds untrusted input. */
const MAX_EXPRESSION_LENGTH = 200;

/** The largest magnitude a resolved sub-expression may reach; bounds runaway values. */
const MAX_MAGNITUDE = 1_000_000;

/** One lexical token: an integer value, an identifier, or a single-character operator. */
interface Token {
  readonly kind: 'number' | 'identifier' | 'operator';
  readonly text: string;
  readonly value: number;
}

/** Matches a decimal integer, optionally preceded by a Verilog size and base (`8'd12`, `'h1F`). */
const SIZED_LITERAL = /^(?:\d+)?'[sS]?([bBoOdDhH])([0-9a-fA-F_]+)/;

/** Matches a plain decimal integer with optional underscores (`64`, `1_024`). */
const DECIMAL_LITERAL = /^\d[\d_]*/;

/** Matches a Verilog identifier, including the `$clog2` system-function form. */
const IDENTIFIER = /^\$?[A-Za-z_][A-Za-z0-9_$]*/;

/** The single-character operators the evaluator understands. */
const OPERATORS = '+-*/%()' as const;

/** Radix for each Verilog base character. */
const RADIX_BY_BASE: Readonly<Record<string, number>> = {
  b: 2,
  o: 8,
  d: 10,
  h: 16,
};

/** Parse a based-literal body, or `null` when a digit is out of range for the radix. */
function basedLiteralValue(base: string, digits: string): number | null {
  const radix = RADIX_BY_BASE[base.toLowerCase()];
  if (radix === undefined) {
    return null;
  }
  const cleaned = digits.replace(/_/g, '');
  if (cleaned.length === 0) {
    return null;
  }
  const value = Number.parseInt(cleaned, radix);
  return Number.isSafeInteger(value) ? value : null;
}

/** Tokenize an expression, or report the first character it cannot classify. */
function tokenize(source: string): { readonly ok: true; readonly tokens: Token[] } | IntExprResult {
  const tokens: Token[] = [];
  let rest = source;
  while (rest.length > 0) {
    const trimmed = rest.replace(/^\s+/, '');
    if (trimmed.length === 0) {
      break;
    }
    const token = nextToken(trimmed);
    if (token === null) {
      return {
        ok: false,
        reason: `unsupported character in range expression: ${trimmed[0] ?? ''}`,
      };
    }
    tokens.push(token);
    rest = trimmed.slice(token.text.length);
  }
  return { ok: true, tokens };
}

/** Read the single leading token of an already-left-trimmed string, or `null`. */
function nextToken(input: string): Token | null {
  const sized = SIZED_LITERAL.exec(input);
  if (sized !== null) {
    const value = basedLiteralValue(sized[1] ?? '', sized[2] ?? '');
    return value === null ? null : { kind: 'number', text: sized[0], value };
  }
  const decimal = DECIMAL_LITERAL.exec(input);
  if (decimal !== null) {
    const value = Number.parseInt(decimal[0].replace(/_/g, ''), 10);
    return Number.isSafeInteger(value) ? { kind: 'number', text: decimal[0], value } : null;
  }
  const identifier = IDENTIFIER.exec(input);
  if (identifier !== null) {
    return { kind: 'identifier', text: identifier[0], value: 0 };
  }
  const head = input[0] ?? '';
  return OPERATORS.includes(head) ? { kind: 'operator', text: head, value: 0 } : null;
}

/** Mutable cursor over the token stream, shared by the recursive-descent functions. */
interface Cursor {
  readonly tokens: readonly Token[];
  index: number;
}

/** The token at the cursor, or `null` at the end of input. */
function peek(cursor: Cursor): Token | null {
  return cursor.tokens[cursor.index] ?? null;
}

/** Whether the cursor sits on one of the given operators. */
function atOperator(cursor: Cursor, operators: readonly string[]): boolean {
  const token = peek(cursor);
  return token !== null && token.kind === 'operator' && operators.includes(token.text);
}

/** Apply a binary operator, refusing division or modulo by zero. */
function applyBinary(op: string, left: number, right: number): IntExprResult {
  if ((op === '/' || op === '%') && right === 0) {
    return { ok: false, reason: 'division by zero in range expression' };
  }
  switch (op) {
    case '+':
      return bounded(left + right);
    case '-':
      return bounded(left - right);
    case '*':
      return bounded(left * right);
    case '/':
      return bounded(Math.trunc(left / right));
    case '%':
      return bounded(left % right);
    default:
      return { ok: false, reason: `unsupported operator ${op} in range expression` };
  }
}

/** Reject a value that has grown past the sane bound for a bit index. */
function bounded(value: number): IntExprResult {
  if (!Number.isSafeInteger(value) || Math.abs(value) > MAX_MAGNITUDE) {
    return { ok: false, reason: 'range expression value is out of bounds' };
  }
  return { ok: true, value };
}

/** Parse a primary term: a literal, a parenthesized expression, `$clog2(...)`, or an identifier. */
function parsePrimary(cursor: Cursor, scope: IntExprScope): IntExprResult {
  const token = peek(cursor);
  if (token === null) {
    return { ok: false, reason: 'range expression ended unexpectedly' };
  }
  if (token.kind === 'operator' && token.text === '-') {
    cursor.index += 1;
    const operand = parsePrimary(cursor, scope);
    return operand.ok ? bounded(-operand.value) : operand;
  }
  if (token.kind === 'operator' && token.text === '(') {
    cursor.index += 1;
    const inner = parseSum(cursor, scope);
    if (!inner.ok) {
      return inner;
    }
    if (!atOperator(cursor, [')'])) {
      return { ok: false, reason: 'unbalanced parentheses in range expression' };
    }
    cursor.index += 1;
    return inner;
  }
  if (token.kind === 'number') {
    cursor.index += 1;
    return bounded(token.value);
  }
  if (token.kind === 'identifier') {
    cursor.index += 1;
    return token.text === '$clog2'
      ? parseClog2(cursor, scope)
      : resolveIdentifier(token.text, scope);
  }
  return { ok: false, reason: `unexpected token ${token.text} in range expression` };
}

/** Parse `$clog2(<expr>)` and return the ceiling log base 2 of its argument. */
function parseClog2(cursor: Cursor, scope: IntExprScope): IntExprResult {
  if (!atOperator(cursor, ['('])) {
    return { ok: false, reason: '$clog2 must be applied to a parenthesized expression' };
  }
  cursor.index += 1;
  const argument = parseSum(cursor, scope);
  if (!argument.ok) {
    return argument;
  }
  if (!atOperator(cursor, [')'])) {
    return { ok: false, reason: 'unbalanced parentheses in $clog2 argument' };
  }
  cursor.index += 1;
  if (argument.value < 0) {
    return { ok: false, reason: '$clog2 of a negative value is undefined' };
  }
  // Verilog's $clog2 is the smallest n with 2**n >= value, and $clog2(0) is 0.
  return bounded(argument.value <= 1 ? 0 : Math.ceil(Math.log2(argument.value)));
}

/** Resolve an identifier from the scope, failing when it is unknown. */
function resolveIdentifier(name: string, scope: IntExprScope): IntExprResult {
  const value = scope.get(name);
  if (value === undefined) {
    return { ok: false, reason: `unresolved parameter ${name} in range expression` };
  }
  return bounded(value);
}

/** Parse a product chain (`*`, `/`, `%`), which binds tighter than `+`/`-`. */
function parseProduct(cursor: Cursor, scope: IntExprScope): IntExprResult {
  let left = parsePrimary(cursor, scope);
  while (left.ok && atOperator(cursor, ['*', '/', '%'])) {
    const op = peek(cursor)?.text ?? '';
    cursor.index += 1;
    const right = parsePrimary(cursor, scope);
    if (!right.ok) {
      return right;
    }
    left = applyBinary(op, left.value, right.value);
  }
  return left;
}

/** Parse a sum chain (`+`, `-`): the expression entry point. */
function parseSum(cursor: Cursor, scope: IntExprScope): IntExprResult {
  let left = parseProduct(cursor, scope);
  while (left.ok && atOperator(cursor, ['+', '-'])) {
    const op = peek(cursor)?.text ?? '';
    cursor.index += 1;
    const right = parseProduct(cursor, scope);
    if (!right.ok) {
      return right;
    }
    left = applyBinary(op, left.value, right.value);
  }
  return left;
}

/**
 * Evaluate a Verilog integer expression against a parameter scope.
 *
 * Total: every input either resolves to a bounded integer or returns a reason.
 * Never executes the input as host-language code, and never falls back to a
 * default width - an unresolvable expression is the caller's signal to quarantine
 * the design rather than import a guessed interface.
 */
export function evaluateIntExpression(source: string, scope: IntExprScope): IntExprResult {
  const trimmed = source.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: 'empty range expression' };
  }
  if (trimmed.length > MAX_EXPRESSION_LENGTH) {
    return { ok: false, reason: 'range expression is too long' };
  }
  const lexed = tokenize(trimmed);
  if (!('tokens' in lexed)) {
    return lexed;
  }
  const cursor: Cursor = { tokens: lexed.tokens, index: 0 };
  const result = parseSum(cursor, scope);
  if (!result.ok) {
    return result;
  }
  if (cursor.index !== cursor.tokens.length) {
    return { ok: false, reason: 'trailing tokens in range expression' };
  }
  return result;
}
