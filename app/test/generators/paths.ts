// Edge-case path generators (task 1.3).
//
// These feed the sandbox path-confinement work (Property 9, tasks 3.2/3.4): every
// file name derived from a Spec, model output, or student input must be confined
// to the workspace, and traversal / absolute / encoded / symlink-style paths must
// be rejected and recorded. The generators emit only raw structural values; the
// discriminating `kind` documents intent so both the TypeScript validator and the
// Python worker can consume the same cases.

import fc from 'fast-check';

import { LOWER_ALPHA, stringFromChars } from './chars.js';

/** The category an unsafe path falls into, kept for assertions and diagnostics. */
export type UnsafePathKind = 'traversal' | 'absolute' | 'encoded' | 'symlink';

/** A raw path string paired with the reason it must be rejected. */
export interface UnsafePath {
  readonly kind: UnsafePathKind;
  readonly raw: string;
}

/** Path-segment sized lowercase tokens. */
function segmentArbitrary(): fc.Arbitrary<string> {
  return stringFromChars(LOWER_ALPHA, 1, 6);
}

/** Paths that always contain at least one `..` traversal token. */
export function traversalPathArbitrary(): fc.Arbitrary<string> {
  const upToken = fc.constantFrom('../', '..\\', '....//');
  const tail = fc.array(
    fc.oneof(
      upToken,
      segmentArbitrary().map((s) => `${s}/`),
    ),
    {
      minLength: 0,
      maxLength: 4,
    },
  );
  return fc.tuple(upToken, tail).map(([head, rest]) => `${head}${rest.join('')}`);
}

/** Paths anchored outside any relative workspace root (POSIX, Windows drive, UNC). */
export function absolutePathArbitrary(): fc.Arbitrary<string> {
  const prefix = fc.constantFrom('/', '/etc/', '/root/', 'C:\\', '\\\\server\\');
  const tail = fc.array(segmentArbitrary(), { minLength: 1, maxLength: 4 }).map((s) => s.join('/'));
  return fc.tuple(prefix, tail).map(([head, rest]) => `${head}${rest}`);
}

/** Paths that always contain at least one percent-encoded traversal/separator token. */
export function encodedPathArbitrary(): fc.Arbitrary<string> {
  const encodedToken = fc.constantFrom(
    '%2e%2e%2f', // ../
    '%2e%2e/', // ../ (partial)
    '..%2f', // ../ (partial)
    '%252e%252e%252f', // double-encoded ../
    '%2e%2e%5c', // ..\
    '%00', // encoded NUL truncation
  );
  const tail = fc.array(fc.oneof(encodedToken, segmentArbitrary()), { minLength: 0, maxLength: 4 });
  return fc.tuple(encodedToken, tail).map(([head, rest]) => `${head}${rest.join('')}`);
}

/**
 * Paths whose leading component names a symlink-style alias followed by a
 * sensitive leaf. The `symlink` kind marks that the leading component is meant
 * to resolve outside the workspace via a link, which a raw string alone cannot
 * express.
 */
export function symlinkStylePathArbitrary(): fc.Arbitrary<string> {
  const alias = fc.constantFrom('link', 'symlink', 'alias', 'shortcut', 'workspace-link');
  const leaf = fc.constantFrom('passwd', 'id_rsa', 'environ', 'secrets.env', 'config');
  return fc.tuple(alias, leaf).map(([a, l]) => `${a}/${l}`);
}

/** Any unsafe path, tagged with the reason it must be rejected. */
export function unsafePathArbitrary(): fc.Arbitrary<UnsafePath> {
  return fc.oneof(
    traversalPathArbitrary().map((raw) => ({ kind: 'traversal' as const, raw })),
    absolutePathArbitrary().map((raw) => ({ kind: 'absolute' as const, raw })),
    encodedPathArbitrary().map((raw) => ({ kind: 'encoded' as const, raw })),
    symlinkStylePathArbitrary().map((raw) => ({ kind: 'symlink' as const, raw })),
  );
}
