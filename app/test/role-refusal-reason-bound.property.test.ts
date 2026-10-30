// stimulus-transaction-structure, Property 17: A refusal reason is bounded and leaks nothing
// (task 7.3; Req 2.11, 2.12).
//
// TWO BOUNDARIES, FOUR CALL SITES, ONE SHAPE
//   `boundedRefusalText` (`app/tools/simulator/consensus-harness.ts`, the Harness_Renderer's own
//   independent re-check) and `boundedText` (`app/agent/roles/reference-model/parse.ts`, the
//   Role_Parser) are both `text.slice(0, 64)`. The renderer has four call sites; this file drives
//   three of them - the out-of-vocabulary role (which bounds BOTH the role and the port name in
//   one message), the duplicate-port-name fault, and the undeclared-port fault. The fourth,
//   "roles omits input port X", names an input port already drawn from `moduleInterface.ports`,
//   which `validateIdentifiers` has already capped at 128 characters before the role check ever
//   runs - so it is not a vector for an ARBITRARILY long name and is left untested here. The
//   parser has exactly one call site reachable with untrusted text: the empty-port-name fault,
//   which bounds the role text.
//
// NON-INTERFERENCE, NOT CONTAINMENT
//   `chipAgent/_inbox/gotcha-a-credential-leak-property-written-as-containment-is-both-unsound-
//   and-weak.md` records that "the leaked value is not a substring of the output" is both unsound
//   (a short random value can coincidentally be a substring of the emitter's own fixed prose) and
//   weak (a long random value almost never collides, so the same check also passes on an emitter
//   that leaks a truncated or re-wrapped copy). The primary claim here is stated as
//   non-interference instead: two replies that agree on the first 64 characters of the long text
//   but differ arbitrarily after it - including by control bytes, an escape sequence, a RTL
//   override, and an unpaired surrogate half, never reaching 64 characters before the drawn tail
//   starts - must produce byte-identical refusal text. That holds regardless of what the
//   truncation scheme turns out to be, not only for a simple `.slice`.
//   Layered on top: the kept 64-character prefix really appears (non-vacuity), neither full
//   drawn string appears verbatim, the message stays under a fixed ceiling no matter how long the
//   drawn tail is (the "no linear growth" half of "bounded"), and the message holds no character
//   outside printable ASCII - sound because every hazard character is chosen from ranges (control,
//   C1, bidi-override, surrogate) no hand-written English refusal sentence or `[A-Za-z0-9_]`
//   prefix can ever produce, so an escape anywhere in the message is distinguishable from the
//   fixed prose by construction, not by luck.
//
// Validates: Requirements 2.11, 2.12

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { parseReferenceModelDraft } from '@app/agent';
import {
  makeTimingContract,
  type ClockingContract,
  type ModuleInterface,
  type TimingContract,
} from '@app/core';
import {
  renderConsensusHarness,
  type ConsensusHarnessRequest,
  type RoleDeclaration,
} from '@app/tools';

import { ASCII_IDENT_CHARS, stringFromChars } from './generators/chars.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'stimulus-transaction-structure, Property 17: A refusal reason is bounded and leaks nothing';

/** Every message this file checks is hand-written English ASCII; this range excludes it entirely. */
const PRINTABLE_ASCII_ONLY = /^[\x20-\x7e]*$/;

/** A conservative ceiling on any of the four checked messages, independent of how long the drawn tail is. */
const MESSAGE_LENGTH_CEILING = 300;

/**
 * Characters chosen because no fixed refusal sentence and no `ASCII_IDENT_CHARS` prefix can ever
 * contain one: control bytes, an ANSI escape opener, a terminal bidi override, and an unpaired
 * surrogate half (the hazard a naive `slice` at a code-unit boundary could otherwise produce).
 */
const HAZARD_CHARS: readonly string[] = [
  '\u0000',
  '\u0007',
  '\n',
  '\r',
  '\t',
  '\u001b',
  '\u007f',
  '\u202e',
  '\ud83d',
];

/** One long text, split at exactly 64 safe characters, with two differently-tailed full values. */
interface PrefixPair {
  readonly prefix: string;
  readonly fullA: string;
  readonly fullB: string;
}

/** Draws a 64-character safe prefix plus a hazardous tail, then forms two values differing only after it. */
function prefixPairArbitrary(maxOverflow: number): fc.Arbitrary<PrefixPair> {
  return fc
    .tuple(
      stringFromChars(ASCII_IDENT_CHARS, 64, 64),
      stringFromChars(HAZARD_CHARS, 1, maxOverflow),
    )
    .map(([prefix, overflow]) => ({
      prefix,
      fullA: `${prefix}${overflow}TAILA`,
      fullB: `${prefix}${overflow}TAILB`,
    }));
}

/** A deterministic, extreme-length pinned pair (the "500 or 5000 characters" case), not left to sampling. */
function fixedPrefixPair(label: string, overflowLength: number): PrefixPair {
  const unit = `${label}_`;
  const prefix = unit.repeat(Math.ceil(64 / unit.length) + 1).slice(0, 64);
  const overflow = HAZARD_CHARS.join('')
    .repeat(Math.ceil(overflowLength / HAZARD_CHARS.length))
    .slice(0, overflowLength);
  return { prefix, fullA: `${prefix}${overflow}TAILA`, fullB: `${prefix}${overflow}TAILB` };
}

/**
 * The shared assertion: `messageA`/`messageB` differ only in which full value produced them, so
 * their equality IS the non-interference claim, then the bound and leak-free checks layer on top.
 */
function expectLeakFreeAndBounded(
  messageA: string,
  messageB: string,
  pairs: readonly PrefixPair[],
): void {
  expect(messageA).toBe(messageB);
  expect(messageA.length).toBeLessThan(MESSAGE_LENGTH_CEILING);
  expect(messageA).toMatch(PRINTABLE_ASCII_ONLY);
  for (const { prefix, fullA, fullB } of pairs) {
    expect(messageA).toContain(prefix);
    expect(messageA).not.toContain(fullA);
    expect(messageA).not.toContain(fullB);
  }
}

const COMBINATIONAL: ClockingContract = { clockName: null, resetName: null, resetActiveLow: false };

const MODULE_INTERFACE: ModuleInterface = {
  moduleName: 'm',
  ports: [
    { name: 'a', direction: 'input', width: 1 },
    { name: 'y', direction: 'output', width: 1 },
  ],
  clocking: COMBINATIONAL,
  validityOutputName: null,
};

function combinationalTiming(): TimingContract {
  const built = makeTimingContract(MODULE_INTERFACE, [{ portName: 'y', timing: 'combinational' }]);
  if (!built.ok) {
    throw new Error(`test fixture defect: ${built.error.code}`);
  }
  return built.value;
}

function requestWithRoles(roles: RoleDeclaration): ConsensusHarnessRequest {
  return {
    moduleInterface: MODULE_INTERFACE,
    timingContract: combinationalTiming(),
    nonce: 'nonce1',
    watchdogBudgetNs: 2_000_000,
    sampleBudget: 8,
    roles,
  };
}

describe(PROPERTY, () => {
  it('plants hazard characters no fixed refusal sentence or safe prefix could ever contain', () => {
    // The soundness guard the printable-ASCII-only check stands on: were any hazard character
    // actually printable ASCII, that check would report a leak that never happened.
    for (const hazard of HAZARD_CHARS) {
      expect(PRINTABLE_ASCII_ONLY.test(hazard)).toBe(false);
    }
    // And the fixture bug this guards against: a label-derived prefix that came out short would
    // let the slice dip into the hazardous tail, which is exactly what a 64-character bound test
    // must not do.
    expect(fixedPrefixPair('WHO', 5000).prefix).toHaveLength(64);
    expect(fixedPrefixPair('ROLETEXT', 5000).prefix).toHaveLength(64);
  });

  describe('the Harness_Renderer (requireRoleVocabularyMembership, via requireTotalRoleDeclaration)', () => {
    /** Outside `INPUT_ROLES` - only reachable through a cast, same as the renderer's own comment notes. */
    function vocabularyRoles(
      rolePair: PrefixPair,
      portPair: PrefixPair,
      variant: 'A' | 'B',
    ): RoleDeclaration {
      return [
        {
          portName: variant === 'A' ? portPair.fullA : portPair.fullB,
          role: variant === 'A' ? rolePair.fullA : rolePair.fullB,
        },
      ] as unknown as RoleDeclaration;
    }

    function render(rolePair: PrefixPair, portPair: PrefixPair, variant: 'A' | 'B') {
      return renderConsensusHarness(requestWithRoles(vocabularyRoles(rolePair, portPair, variant)));
    }

    function check(rolePair: PrefixPair, portPair: PrefixPair): void {
      const resultA = render(rolePair, portPair, 'A');
      const resultB = render(rolePair, portPair, 'B');
      expect(resultA.ok).toBe(false);
      if (resultA.ok) return;
      expect(resultB.ok).toBe(false);
      if (resultB.ok) return;
      expect(resultA.error.code).toBe('ROLE_OUTSIDE_VOCABULARY');
      expectLeakFreeAndBounded(resultA.error.message, resultB.error.message, [rolePair, portPair]);
    }

    it('bounds an arbitrarily long out-of-vocabulary role and its port name to 64 characters each', () => {
      fc.assert(
        fc.property(prefixPairArbitrary(500), prefixPairArbitrary(500), (rolePair, portPair) => {
          check(rolePair, portPair);
        }),
        propertyParameters(),
      );
    });

    it('still bounds a 5000-character role and port name at the same ceiling', () => {
      check(fixedPrefixPair('ROLE', 5000), fixedPrefixPair('PORT', 5000));
    });
  });

  describe('the Harness_Renderer (requireNoDuplicateRolePort, via requireTotalRoleDeclaration)', () => {
    function duplicateRoles(portPair: PrefixPair, variant: 'A' | 'B'): RoleDeclaration {
      const portName = variant === 'A' ? portPair.fullA : portPair.fullB;
      return [
        { portName, role: 'data' },
        { portName, role: 'enable' },
      ];
    }

    function check(portPair: PrefixPair): void {
      const resultA = renderConsensusHarness(requestWithRoles(duplicateRoles(portPair, 'A')));
      const resultB = renderConsensusHarness(requestWithRoles(duplicateRoles(portPair, 'B')));
      expect(resultA.ok).toBe(false);
      if (resultA.ok) return;
      expect(resultB.ok).toBe(false);
      if (resultB.ok) return;
      expect(resultA.error.code).toBe('INCOMPLETE_ROLE_DECLARATION');
      expect(resultA.error.message).toContain('more than once');
      expectLeakFreeAndBounded(resultA.error.message, resultB.error.message, [portPair]);
    }

    it('bounds an arbitrarily long port name named twice', () => {
      fc.assert(
        fc.property(prefixPairArbitrary(500), (portPair) => {
          check(portPair);
        }),
        propertyParameters(),
      );
    });

    it('still bounds a 5000-character duplicated port name at the same ceiling', () => {
      check(fixedPrefixPair('DUPE', 5000));
    });
  });

  describe('the Harness_Renderer (requireRolePortsDeclared, via requireTotalRoleDeclaration)', () => {
    function undeclaredRoles(portPair: PrefixPair, variant: 'A' | 'B'): RoleDeclaration {
      return [{ portName: variant === 'A' ? portPair.fullA : portPair.fullB, role: 'data' }];
    }

    function check(portPair: PrefixPair): void {
      const resultA = renderConsensusHarness(requestWithRoles(undeclaredRoles(portPair, 'A')));
      const resultB = renderConsensusHarness(requestWithRoles(undeclaredRoles(portPair, 'B')));
      expect(resultA.ok).toBe(false);
      if (resultA.ok) return;
      expect(resultB.ok).toBe(false);
      if (resultB.ok) return;
      expect(resultA.error.code).toBe('INCOMPLETE_ROLE_DECLARATION');
      expect(resultA.error.message).toContain('which is not a declared input port');
      expectLeakFreeAndBounded(resultA.error.message, resultB.error.message, [portPair]);
    }

    it('bounds an arbitrarily long undeclared port name', () => {
      fc.assert(
        fc.property(prefixPairArbitrary(500), (portPair) => {
          check(portPair);
        }),
        propertyParameters(),
      );
    });

    it('still bounds a 5000-character undeclared port name at the same ceiling', () => {
      check(fixedPrefixPair('WHO', 5000));
    });
  });

  describe('the Role_Parser (the empty-port-name fault)', () => {
    const VALID_FUNCTIONS = [
      { name: 'ece_reset_state', body: "ece_reset_state = 1'b0;" },
      { name: 'ece_next_state', body: 'ece_next_state = s;' },
      { name: 'ece_expect', body: "ece_expect = 1'b0;" },
    ];

    function reply(role: string): string {
      return JSON.stringify({ functions: VALID_FUNCTIONS, roles: [{ port: '', role }] });
    }

    function check(rolePair: PrefixPair): void {
      const resultA = parseReferenceModelDraft(reply(rolePair.fullA), MODULE_INTERFACE);
      const resultB = parseReferenceModelDraft(reply(rolePair.fullB), MODULE_INTERFACE);
      expect(resultA.ok).toBe(false);
      if (resultA.ok) return;
      expect(resultB.ok).toBe(false);
      if (resultB.ok) return;
      expect(resultA.error.reason).toContain('named an empty port name');
      expectLeakFreeAndBounded(resultA.error.reason, resultB.error.reason, [rolePair]);
    }

    it('bounds an arbitrarily long role text named for an empty port', () => {
      fc.assert(
        fc.property(prefixPairArbitrary(500), (rolePair) => {
          check(rolePair);
        }),
        propertyParameters(),
      );
    });

    it('still bounds a 5000-character role text at the same ceiling', () => {
      check(fixedPrefixPair('ROLETEXT', 5000));
    });
  });
});
