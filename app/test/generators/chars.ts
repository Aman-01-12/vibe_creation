// Internal helper for the shared generators (task 1.3).
//
// Building strings from an explicit character set with `fc.array(...).map(join)`
// keeps the generators stable across fast-check string-API revisions and makes
// the exact alphabet of each edge-case generator obvious at the call site.

import fc from 'fast-check';

/** ASCII characters that form a conventional, well-formed identifier. */
export const ASCII_IDENT_CHARS: readonly string[] =
  'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_'.split('');

/** Lowercase ASCII letters, used for path segments and filler text. */
export const LOWER_ALPHA: readonly string[] = 'abcdefghijklmnopqrstuvwxyz'.split('');

/**
 * An arbitrary string drawn from `chars`, with a length in `[min, max]`.
 *
 * `chars` must be non-empty. A `min` of 0 permits the empty string.
 */
export function stringFromChars(
  chars: readonly string[],
  min: number,
  max: number,
): fc.Arbitrary<string> {
  const [first, ...rest] = chars;
  if (first === undefined) {
    throw new Error('stringFromChars requires a non-empty character set');
  }
  return fc
    .array(fc.constantFrom(first, ...rest), { minLength: min, maxLength: max })
    .map((picked) => picked.join(''));
}
