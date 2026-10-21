// structural-gate-toolchain, Property 6: The Seam_Schema accepts the two new payloads only in
// their declared shapes (task 1.3; Req 3.3, 9.4).
//
// THE CLAIM IS A BICONDITIONAL, SO IT IS CHECKED AGAINST AN INDEPENDENT PREDICATE
//   `expectedAccepted` restates the rule design.md states - presence iff the matching kind, the
//   bounded plain-identifier `topModule`, a boolean `schematic`, and no additional property - from
//   nothing but the kind and the two payload draws. It calls `validateSandboxJob` nowhere, so the
//   property is a real check of the schema and not a restatement of its own machinery.
//
// WHAT A SAMPLED DRAW WOULD MISS, PINNED BY CONSTRUCTION (per design.md's own table for Property 6)
//   - each payload on each wrong kind: `KINDS` is drawn uniformly over all five, independently of
//     which payload is present, so a `synthesize` payload riding on `formal` and a `lint` payload
//     riding on `simulate` are both reached, not left to chance.
//   - `schematic` as the string `"true"`: one dedicated branch of `arbSynthesizePayload`.
//   - a `topModule` of exactly 128 and 129 characters: `TOP_MODULE_AT_LIMIT` and
//     `TOP_MODULE_OVER_LIMIT`, the schema's own `maxLength: 128` boundary.
//   - one extra property on each payload: `engine` on `synthesize`, `depth` on `lint` (the same
//     key `sandbox.test.ts` already uses for the hand-written `lint` extra-key case).
//
// Validates: Requirements 3.3, 9.4

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { validateSandboxJob, type SandboxJobKind } from '@app/tools';

import { propertyParameters } from './property.js';

const PROPERTY =
  'structural-gate-toolchain, Property 6: The Seam_Schema accepts the two new payloads only in ' +
  'their declared shapes';

/** The schema's own ceiling for every `topModule` payload (read off `contract-schema.ts`). */
const MAX_TOP_MODULE_LENGTH = 128;

const LIMITS = { cpu: 1, memMb: 256, procs: 64, diskMb: 64, wallMs: 5000 } as const;

const KINDS: readonly SandboxJobKind[] = [
  'simulate',
  'synthesize',
  'formal',
  'formalPrepass',
  'lint',
];

/** The `formal` payload a `formal`-kind job must carry so only the biconditional under test varies. */
const FORMAL_PAYLOAD = { topModule: 'wrapper_top', depth: 4 } as const;

/** The `formalPrepass` payload a `formalPrepass`-kind job must carry, for the same reason. */
const FORMAL_PREPASS_PAYLOAD = { topModule: 'dut' } as const;

const VALID_TOP_MODULE = 'top_module_1';
/** Exactly the schema's `maxLength` (128 characters): the accepted boundary. */
const TOP_MODULE_AT_LIMIT = `a${'b'.repeat(MAX_TOP_MODULE_LENGTH - 1)}`;
/** One character past the ceiling (129 characters): the refused boundary. */
const TOP_MODULE_OVER_LIMIT = `a${'b'.repeat(MAX_TOP_MODULE_LENGTH)}`;

/** A payload candidate, alongside whether IT ALONE (independent of which kind it rides on) is well-formed. */
interface PayloadDraw {
  readonly value: unknown;
  readonly shapeValid: boolean;
}

/** `synthesize` payload candidates: well-formed, each wrong-shape case, and the two named draws. */
function arbSynthesizePayload(): fc.Arbitrary<PayloadDraw> {
  return fc.oneof(
    fc
      .record({
        topModule: fc.constantFrom(VALID_TOP_MODULE, TOP_MODULE_AT_LIMIT),
        schematic: fc.boolean(),
      })
      .map((value) => ({ value, shapeValid: true })),
    fc
      .record({
        topModule: fc.constantFrom('top; rm -rf /', '1leading_digit', TOP_MODULE_OVER_LIMIT, ''),
        schematic: fc.boolean(),
      })
      .map((value) => ({ value, shapeValid: false })),
    // The named draw: `schematic` as the string `"true"` rather than a boolean.
    fc.constant({ topModule: VALID_TOP_MODULE, schematic: 'true' }).map((value) => ({
      value,
      shapeValid: false,
    })),
    fc
      .constantFrom({ topModule: VALID_TOP_MODULE }, { schematic: true }, {})
      .map((value) => ({ value, shapeValid: false })),
    // The named draw: one extra property on an otherwise well-formed payload.
    fc
      .constant({ topModule: VALID_TOP_MODULE, schematic: false, engine: 'yosys' })
      .map((value) => ({ value, shapeValid: false })),
  );
}

/** `lint` payload candidates: well-formed, each wrong-shape case, and the two named draws. */
function arbLintPayload(): fc.Arbitrary<PayloadDraw> {
  return fc.oneof(
    fc
      .record({ topModule: fc.constantFrom(VALID_TOP_MODULE, TOP_MODULE_AT_LIMIT) })
      .map((value) => ({ value, shapeValid: true })),
    fc
      .constantFrom(
        { topModule: 'top; rm -rf /' },
        { topModule: TOP_MODULE_OVER_LIMIT },
        { topModule: '' },
      )
      .map((value) => ({ value, shapeValid: false })),
    fc.constant({}).map((value) => ({ value, shapeValid: false })),
    // The named draw: one extra property, the same key `sandbox.test.ts` uses for this case.
    fc
      .constant({ topModule: VALID_TOP_MODULE, depth: 20 })
      .map((value) => ({ value, shapeValid: false })),
  );
}

/** A job of `kind`, carrying the given kind's OWN required payload plus the two under test. */
function buildJob(
  kind: SandboxJobKind,
  payloads: { readonly synthesize?: unknown; readonly lint?: unknown },
): unknown {
  const kindOwnPayload: Record<string, unknown> =
    kind === 'formal'
      ? { formal: FORMAL_PAYLOAD }
      : kind === 'formalPrepass'
        ? { formalPrepass: FORMAL_PREPASS_PAYLOAD }
        : {};
  return {
    kind,
    workspaceFiles: [{ path: 'top.v', contents: 'module top; endmodule' }],
    limits: LIMITS,
    requiredOutputs: ['exitCode'],
    ...kindOwnPayload,
    ...(payloads.synthesize !== undefined ? { synthesize: payloads.synthesize } : {}),
    ...(payloads.lint !== undefined ? { lint: payloads.lint } : {}),
  };
}

/**
 * The biconditional restated independently of `validateSandboxJob`: accepted iff each present
 * payload rides its own kind and is itself well-formed.
 */
function expectedAccepted(
  kind: SandboxJobKind,
  synthesizeDraw: PayloadDraw | null,
  lintDraw: PayloadDraw | null,
): boolean {
  if ((synthesizeDraw !== null) !== (kind === 'synthesize')) {
    return false;
  }
  if ((lintDraw !== null) !== (kind === 'lint')) {
    return false;
  }
  if (synthesizeDraw !== null && !synthesizeDraw.shapeValid) {
    return false;
  }
  if (lintDraw !== null && !lintDraw.shapeValid) {
    return false;
  }
  return true;
}

/** One case: a kind, and the synthesize/lint payload each either absent or one of the draws above. */
function arbCase(): fc.Arbitrary<{
  kind: SandboxJobKind;
  synthesizeDraw: PayloadDraw | null;
  lintDraw: PayloadDraw | null;
}> {
  return fc
    .record({
      kind: fc.constantFrom(...KINDS),
      synthesizePresent: fc.boolean(),
      lintPresent: fc.boolean(),
      synthesizeDraw: arbSynthesizePayload(),
      lintDraw: arbLintPayload(),
    })
    .map(({ kind, synthesizePresent, lintPresent, synthesizeDraw, lintDraw }) => ({
      kind,
      synthesizeDraw: synthesizePresent ? synthesizeDraw : null,
      lintDraw: lintPresent ? lintDraw : null,
    }));
}

describe(PROPERTY, () => {
  it('accepts a job carrying the synthesize/lint payloads iff each matches its own kind and shape', () => {
    fc.assert(
      fc.property(arbCase(), ({ kind, synthesizeDraw, lintDraw }) => {
        const job = buildJob(kind, {
          synthesize: synthesizeDraw?.value,
          lint: lintDraw?.value,
        });
        expect(validateSandboxJob(job).ok).toBe(expectedAccepted(kind, synthesizeDraw, lintDraw));
      }),
      propertyParameters(),
    );
  });

  it('accepts a well-formed job of every kind that carries no synthesize or lint payload', () => {
    // The positive control: a harness that always refused would otherwise pass the property above
    // vacuously, because every rejection would agree with `expectedAccepted` by refusing too.
    for (const kind of KINDS) {
      if (kind === 'synthesize' || kind === 'lint') {
        continue;
      }
      expect(validateSandboxJob(buildJob(kind, {})).ok).toBe(true);
    }
    expect(
      validateSandboxJob(
        buildJob('synthesize', { synthesize: { topModule: VALID_TOP_MODULE, schematic: true } }),
      ).ok,
    ).toBe(true);
    expect(validateSandboxJob(buildJob('lint', { lint: { topModule: VALID_TOP_MODULE } })).ok).toBe(
      true,
    );
  });

  it('rejects each payload on each wrong kind', () => {
    const synthesizePayload = { topModule: VALID_TOP_MODULE, schematic: false };
    const lintPayload = { topModule: VALID_TOP_MODULE };
    for (const kind of KINDS) {
      if (kind !== 'synthesize') {
        expect(validateSandboxJob(buildJob(kind, { synthesize: synthesizePayload })).ok).toBe(
          false,
        );
      }
      if (kind !== 'lint') {
        expect(validateSandboxJob(buildJob(kind, { lint: lintPayload })).ok).toBe(false);
      }
    }
  });

  it('accepts a topModule of exactly 128 characters and rejects one of 129, on both payloads', () => {
    expect(TOP_MODULE_AT_LIMIT).toHaveLength(MAX_TOP_MODULE_LENGTH);
    expect(TOP_MODULE_OVER_LIMIT).toHaveLength(MAX_TOP_MODULE_LENGTH + 1);

    expect(
      validateSandboxJob(
        buildJob('synthesize', {
          synthesize: { topModule: TOP_MODULE_AT_LIMIT, schematic: false },
        }),
      ).ok,
    ).toBe(true);
    expect(
      validateSandboxJob(
        buildJob('synthesize', {
          synthesize: { topModule: TOP_MODULE_OVER_LIMIT, schematic: false },
        }),
      ).ok,
    ).toBe(false);
    expect(
      validateSandboxJob(buildJob('lint', { lint: { topModule: TOP_MODULE_AT_LIMIT } })).ok,
    ).toBe(true);
    expect(
      validateSandboxJob(buildJob('lint', { lint: { topModule: TOP_MODULE_OVER_LIMIT } })).ok,
    ).toBe(false);
  });

  it('rejects schematic given as the string "true" rather than a boolean', () => {
    expect(
      validateSandboxJob(
        buildJob('synthesize', { synthesize: { topModule: VALID_TOP_MODULE, schematic: 'true' } }),
      ).ok,
    ).toBe(false);
  });

  it('rejects one extra property on each payload', () => {
    expect(
      validateSandboxJob(
        buildJob('synthesize', {
          synthesize: { topModule: VALID_TOP_MODULE, schematic: false, engine: 'yosys' },
        }),
      ).ok,
    ).toBe(false);
    expect(
      validateSandboxJob(buildJob('lint', { lint: { topModule: VALID_TOP_MODULE, depth: 20 } })).ok,
    ).toBe(false);
  });
});
