// Result type for expected, recoverable failures.
//
// Per ECE-CODE-QUALITY-STANDARDS.md section 6, expected failures (validation,
// not-found, permission-denied) are modelled as typed result/error values rather
// than thrown exceptions or null. Every validating constructor in this layer
// returns a `Result` so the caller must handle both outcomes explicitly.

/** A successful outcome carrying a value. */
export interface Ok<out T> {
  readonly ok: true;
  readonly value: T;
}

/** A failed outcome carrying a typed error. */
export interface Err<out E> {
  readonly ok: false;
  readonly error: E;
}

/**
 * The outcome of an operation that can fail in an expected way.
 *
 * Narrow on the `ok` discriminant: when `true`, `value` is present; when `false`,
 * `error` is present.
 */
export type Result<T, E> = Ok<T> | Err<E>;

/** Construct a successful result. */
export function ok<T>(value: T): Ok<T> {
  return { ok: true, value };
}

/** Construct a failed result. */
export function err<E>(error: E): Err<E> {
  return { ok: false, error };
}

/** Type guard narrowing a result to its success arm. */
export function isOk<T, E>(result: Result<T, E>): result is Ok<T> {
  return result.ok;
}

/** Type guard narrowing a result to its failure arm. */
export function isErr<T, E>(result: Result<T, E>): result is Err<E> {
  return !result.ok;
}
