// Edge-case identifier generators (task 1.3).
//
// These feed the identifier-validation properties across the stack: whitespace
// and unicode identifiers must be rejected or normalized at trust boundaries
// (Spec signal names, file names, project names) rather than silently accepted.

import fc from 'fast-check';

import { ASCII_IDENT_CHARS, stringFromChars } from './chars.js';

/** ASCII and unicode whitespace, including the "invisible" separators. */
const WHITESPACE_CHARS: readonly string[] = [
  ' ',
  '\t',
  '\n',
  '\r',
  '\f',
  '\v',
  '\u00a0', // no-break space
  '\u2028', // line separator
  '\u2029', // paragraph separator
  '\u3000', // ideographic space
  '\ufeff', // zero-width no-break space (BOM)
];

/**
 * A sample of non-ASCII code points that commonly break naive identifier
 * handling: accented and non-Latin letters, a combining mark, zero-width
 * joiners, a right-to-left override, and an astral-plane emoji (surrogate pair).
 */
const UNICODE_SAMPLE_CHARS: readonly string[] = [
  '\u00e9', // é
  '\u00f1', // ñ
  '\u4e2d', // 中
  '\u0905', // Devanagari A
  '\u0301', // combining acute accent
  '\u200b', // zero-width space
  '\u200d', // zero-width joiner
  '\u202e', // right-to-left override
  '\u{1f600}', // 😀
];

/**
 * An identifier that always contains at least one whitespace character
 * (leading, internal, or trailing).
 */
export function whitespaceIdentifierArbitrary(): fc.Arbitrary<string> {
  return fc
    .tuple(
      stringFromChars(ASCII_IDENT_CHARS, 0, 8),
      stringFromChars(WHITESPACE_CHARS, 1, 3),
      stringFromChars(ASCII_IDENT_CHARS, 0, 8),
    )
    .map(([lead, space, trail]) => `${lead}${space}${trail}`);
}

/** An identifier that always contains at least one non-ASCII unicode character. */
export function unicodeIdentifierArbitrary(): fc.Arbitrary<string> {
  return fc
    .tuple(
      stringFromChars(ASCII_IDENT_CHARS, 0, 6),
      stringFromChars(UNICODE_SAMPLE_CHARS, 1, 4),
      stringFromChars(ASCII_IDENT_CHARS, 0, 6),
    )
    .map(([lead, unicode, trail]) => `${lead}${unicode}${trail}`);
}

/** Either a whitespace-bearing or a unicode-bearing identifier. */
export function hostileIdentifierArbitrary(): fc.Arbitrary<string> {
  return fc.oneof(whitespaceIdentifierArbitrary(), unicodeIdentifierArbitrary());
}
