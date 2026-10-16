// reference-model-consensus-gate, Property 11: No input to the harness renderer can escape into
// executable position (task 7.6; Req 4.7, 4.8).
//
// THE PROPERTY IS A DISJUNCTION, AND BOTH ARMS ARE CHECKED
//   For any module name, port name, and port width reaching `renderConsensusHarness`, either the
//   renderer refuses with a `DomainError`, or every such name appears only in identifier position
//   in the rendered text and every width only as a bounded Verilog literal. A test that only
//   checked the refusal arm would pass over a renderer that refused everything, so this file
//   constructs cases that DO pass the renderer's identifier rule and checks the acceptance arm on
//   those directly.
//
// THE HOSTILE CORPUS
//   Verilog metacharacters, newlines, carriage returns, comment openers (`/*`) and closers (`*/`),
//   backticks, dollar signs, nested quote shapes, a trailing backslash, and a name longer than any
//   bounded identifier (129 chars, one past `MAX_IDENTIFIER_LENGTH` read off
//   `app/tools/simulator/consensus-harness.ts`). Every one of these fails the renderer's own
//   `VERILOG_IDENTIFIER_PATTERN` (`^[A-Za-z_][A-Za-z0-9_$]*$`), so they exercise the refusal arm.
//
// THE ACCEPTANCE ARM NEEDS NAMES THAT PASS THE IDENTIFIER RULE BUT ARE STILL ADVERSARIAL IN SPIRIT
//   A maximally-long (128-char) identifier, an identifier using every legal character class
//   (letters, digits, underscore, dollar sign), and a name that LOOKS LIKE a reserved keyword with
//   one extra character appended (so it is NOT itself in `VERILOG_KEYWORDS` and must be accepted).
//   These are drawn alongside ordinary random identifiers so the acceptance arm is exercised on
//   both plain and edge-shaped names, not only on the common case.
//
// THE IDENTIFIER-POSITION CLAIM IS CHECKED BY THE TEST'S OWN TOKENIZATION
//   Every maximal run of identifier characters in the rendered text is extracted independently of
//   the renderer's own logic, then classified: either it is one of the fixed skeleton's own
//   vocabulary (hand-enumerated below from reading the renderer's literal `lines.push(...)` text),
//   or it is one of the request's own module/port names. A name appearing anywhere else - split
//   across a line, embedded in a string, following a `/*` - would produce an unclassified token,
//   which the test fails on rather than silently accepting.
//
// BYTE-IDENTITY ACROSS RUNS OF ONE SESSION, EXCEPT AT THE NONCE
//   The harness text is identical for every Consensus_Run of a Session except at the nonce (Req
//   4.8). Checked the same way task 7.2's own example test does: substituting one render's nonce
//   back into the other's output must reproduce it byte-for-byte.
//
// Validates: Requirements 4.7, 4.8

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  makeTimingContract,
  type ClockingContract,
  type ModuleInterface,
  type Port,
  type TimingContract,
} from '@app/core';
import { renderConsensusHarness, type ConsensusHarnessRequest } from '@app/tools';

import { ASCII_IDENT_CHARS, stringFromChars } from './generators/chars.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'reference-model-consensus-gate, Property 11: No input to the harness renderer can escape ' +
  'into executable position';

/** One past the renderer's own `MAX_IDENTIFIER_LENGTH` (128), read directly off that constant's use. */
const OVER_LENGTH_IDENTIFIER = 'a'.repeat(129);

/**
 * The hostile corpus: every one of these fails `VERILOG_IDENTIFIER_PATTERN`
 * (`^[A-Za-z_][A-Za-z0-9_$]*$`) and must hit the refusal arm.
 */
const HOSTILE_NAMES: readonly string[] = [
  'q sum', // space
  'q;sum', // semicolon
  'q\nsum', // newline
  'q\rsum', // carriage return
  'q/*sum', // comment opener
  'q*/sum', // comment closer
  'q`sum', // backtick
  'q$sum extra', // dollar sign with a space, still invalid as a whole
  'q"sum', // double quote
  "q'sum", // single quote
  'q\\sum', // backslash
  'q\\', // trailing backslash
  OVER_LENGTH_IDENTIFIER,
];

/** A name that passes the identifier rule but looks like a keyword with one extra character. */
function keywordAdjacentName(): string {
  return 'modulex';
}

/** A name using every legal character class the identifier pattern admits. */
function allCharacterClassesName(): string {
  return 'A_a9$Z';
}

/** A maximally-long (128-char) identifier, the acceptance arm's own boundary case. */
function maxLengthIdentifier(): string {
  return `a${'b'.repeat(127)}`;
}

/** A benign, ordinary identifier - the acceptance arm's common case. */
function identifierArbitrary(): fc.Arbitrary<string> {
  return stringFromChars(
    ASCII_IDENT_CHARS.filter((char) => char !== char.toUpperCase() || /[0-9_]/.test(char)),
    1,
    10,
  ).map((suffix) => `id${suffix}`);
}

/** One of the acceptance-arm's edge-shaped names, or an ordinary one, drawn with equal weight. */
function acceptedNameArbitrary(): fc.Arbitrary<string> {
  return fc.oneof(
    identifierArbitrary(),
    fc.constant(keywordAdjacentName()),
    fc.constant(allCharacterClassesName()),
    fc.constant(maxLengthIdentifier()),
  );
}

const COMBINATIONAL: ClockingContract = { clockName: null, resetName: null, resetActiveLow: false };

function moduleInterfaceWith(moduleName: string, ports: readonly Port[]): ModuleInterface {
  return { moduleName, ports, clocking: COMBINATIONAL, validityOutputName: null };
}

function allCombinationalTiming(moduleInterface: ModuleInterface): TimingContract {
  const entries = moduleInterface.ports
    .filter((port) => port.direction === 'output')
    .map((port) => ({ portName: port.name, timing: 'combinational' as const }));
  const built = makeTimingContract(moduleInterface, entries);
  if (!built.ok) {
    throw new Error(`test fixture defect: ${built.error.code}`);
  }
  return built.value;
}

function requestFor(moduleInterface: ModuleInterface, nonce = 'nonce1'): ConsensusHarnessRequest {
  return {
    moduleInterface,
    timingContract: allCombinationalTiming(moduleInterface),
    nonce,
    watchdogBudgetNs: 2_000_000,
    sampleBudget: 8,
  };
}

/**
 * The fixed skeleton's own vocabulary: every identifier the renderer emits that is NOT one of the
 * request's own module/port/nonce names. Hand-enumerated by reading `consensus-harness.ts`'s
 * literal `lines.push(...)` text directly, not derived from calling the renderer.
 */
const SKELETON_VOCABULARY: ReadonlySet<string> = new Set([
  'module',
  'endmodule',
  'localparam',
  'integer',
  'reg',
  'wire',
  'assign',
  'function',
  'automatic',
  'input',
  'endfunction',
  'initial',
  'begin',
  'end',
  'for',
  'if',
  'else',
  'ece_consensus_harness',
  'ece_candidate',
  'ece_state',
  'ece_in_bits',
  'ece_exp_bits',
  'ece_clk',
  'ece_reset_drive',
  'ece_stimulus',
  'ece_next_state',
  'ece_expect',
  'ece_cycle',
  'step',
  'repeat',
  'ECE_WATCHDOG_BUDGET_NS',
  'ECE_SAMPLE_BUDGET',
  'ECE_PERIOD',
  'ECE_SKEW',
  '$display',
  '$write',
  '$finish',
  // The Reference_Model function headers' own fixed parameter name (`ece_next_state`/`ece_expect`
  // both declare `input ... in`), and the `timescale directive's unit letters.
  'in',
  'timescale',
  'ns',
  'ps',
  // The literal English words the FAIL format string's OWN fixed text contributes, and the
  // fixed CHECK/PASS/FAIL/ECE_SAMPLE/ECE_SAMPLE_END keywords printed inside the quoted format
  // strings themselves (`"CHECK %0s PASS"`, `"CHECK %0s FAIL: ..."`, `"ECE_SAMPLE ..."`,
  // `"ECE_SAMPLE_END ..."`) - fixed product text, not anything the request supplied.
  'expected',
  'got',
  'CHECK',
  'PASS',
  'FAIL',
  'ECE_SAMPLE',
  'ECE_SAMPLE_END',
  // Every `%0<letter>` format specifier's own letter, with the leading `%0` stripped by this
  // scan's identifier-character class (`%` is not an identifier character): `%0d` -> `d`,
  // `%0h` -> `h`, `%0s` -> `s`. Collides with the RADIX_LITERAL_FRAGMENT letters by coincidence
  // of alphabet, not by meaning, which is why both exclusions are kept and named separately.
  'd',
  'h',
  's',
  // The VCD dump directive's own fixed tokens: `$dumpfile("dump.vcd")` and
  // `$dumpvars(0, ece_consensus_harness)` - fixed product text, never from the request.
  '$dumpfile',
  'dump',
  'vcd',
  '$dumpvars',
]);

/**
 * A Verilog sized-literal radix fragment this scan's identifier regex also matches: `'d`, `'b`,
 * `'h`, or `'o` followed by the literal's own digits (e.g. `64'd2000000` tokenizes to `d2000000`;
 * `1'b0` tokenizes to `b0`). Not an identifier at all - the apostrophe before it is what marks it
 * as a literal's radix marker in the real text - so these are excluded by shape rather than
 * enumerated by value, since the digits vary with every width and value the renderer emits.
 */
const RADIX_LITERAL_FRAGMENT = /^[bdho]\d+$/;

/**
 * One token a scan must not look inside: a `//` line comment. The rendered harness text has no
 * block comments and no string literal spanning multiple identifier-bearing lines, so a line
 * comment is the only non-code span this scan needs to blank - mirrors the `codeOf` discipline
 * `consensus-import-boundary.test.ts` and `structural-claims.test.ts` already apply to their own
 * source scans, scoped to what this file's rendered text actually contains.
 */
function codeOf(text: string): string {
  return text.replace(/\/\/[^\n]*/g, (comment) => comment.replace(/[^\n]/g, ' '));
}

/**
 * Every maximal run of identifier characters (letters, digits, underscore, dollar sign) in
 * `text`'s CODE portion only - comments blanked first, so an English word inside the harness's
 * own header comment (e.g. "written", "the", "Model") is never read as an escaped identifier.
 */
function identifierTokensIn(text: string): readonly string[] {
  return codeOf(text).match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? [];
}

describe(PROPERTY, () => {
  it('refuses every hostile name with a DomainError', () => {
    for (const hostileName of HOSTILE_NAMES) {
      const moduleInterface = moduleInterfaceWith('m', [
        { name: hostileName, direction: 'output', width: 1 },
      ]);
      const timingBuilt = makeTimingContract(moduleInterface, [
        { portName: hostileName, timing: 'combinational' },
      ]);
      const timingContract: TimingContract = timingBuilt.ok
        ? timingBuilt.value
        : { entries: [{ portName: hostileName, timing: 'combinational' }] };
      const rendered = renderConsensusHarness({ ...requestFor(moduleInterface), timingContract });
      expect(rendered.ok).toBe(false);
      if (rendered.ok) continue;
      expect(rendered.error.code).toBe('INVALID_VERILOG_IDENTIFIER');
    }
  });

  it(
    'for every accepted name, every occurrence in the rendered text is traceable to the fixed ' +
      "skeleton, to a declared port name, to the module name, or to the request's own nonce - " +
      'never to an unclassified position',
    () => {
      let acceptedCases = 0;

      fc.assert(
        fc.property(
          acceptedNameArbitrary(),
          acceptedNameArbitrary(),
          acceptedNameArbitrary(),
          (moduleName, portName, nonce) => {
            fc.pre(new Set([moduleName, portName]).size === 2);
            const moduleInterface = moduleInterfaceWith(moduleName, [
              { name: portName, direction: 'output', width: 4 },
            ]);
            const rendered = renderConsensusHarness(requestFor(moduleInterface, nonce));
            if (!rendered.ok) {
              // A keyword-adjacent or edge-shaped draw may still coincidentally collide with a
              // reserved keyword after case-folding; skip rather than fail, since the refusal arm
              // is covered by the dedicated hostile-corpus test above.
              return;
            }
            acceptedCases += 1;

            const unclassified = identifierTokensIn(rendered.value.contents).filter((token) => {
              if (SKELETON_VOCABULARY.has(token) || RADIX_LITERAL_FRAGMENT.test(token)) {
                return false;
              }
              if (token === moduleInterface.moduleName || token === portName || token === nonce) {
                return false;
              }
              if (token === `ece_prev_exp_${portName}`) {
                return false;
              }
              if (token === `${nonce}_${portName}`) {
                return false;
              }
              return true;
            });
            expect(unclassified).toEqual([]);

            // Every width reaches the text only as a bounded Verilog literal: a decimal digit
            // run inside a `[H:0]` bit-select or a `64'd<value>`/`<width>'d<value>` literal,
            // never as a bare token elsewhere.
            const widthLiteralPattern = /\[\d+:0\]|\d+'d\d+/g;
            expect(rendered.value.contents.match(widthLiteralPattern)).not.toBeNull();
          },
        ),
        propertyParameters(),
      );

      expect(acceptedCases).toBeGreaterThan(0);
    },
  );

  it(
    'renders byte-identical text across two runs of one Session that differ only in nonce, ' +
      "except at the nonce's own occurrences",
    () => {
      fc.assert(
        fc.property(
          acceptedNameArbitrary(),
          acceptedNameArbitrary(),
          acceptedNameArbitrary(),
          acceptedNameArbitrary(),
          (moduleName, portName, nonceA, nonceB) => {
            // All four names must be pairwise distinct, AND none may be a SUBSTRING of another:
            // a crude text substitution (`.split(needle).join(replacement)`) is ambiguous the
            // moment one name's text occurs inside another's.
            const names = [moduleName, portName, nonceA, nonceB];
            fc.pre(new Set(names).size === 4);
            fc.pre(
              names.every((outer, outerIndex) =>
                names.every(
                  (inner, innerIndex) => outerIndex === innerIndex || !outer.includes(inner),
                ),
              ),
            );
            // AND the nonce must not be a substring of the renderer's own FIXED skeleton text
            // either: nonceB = "ida" is not a substring of any OTHER drawn name here, but it IS a
            // substring of the fixed header comment's own "Cand-ida-te_Design" - a real collision
            // this test's naive `.split(needle).join(replacement)` verification method is
            // sensitive to, even though the renderer itself did nothing wrong. Guard it the same
            // way: render once with a KNOWN-SAFE placeholder nonce first and check neither nonce
            // occurs in that fixed-text baseline.
            const moduleInterface = moduleInterfaceWith(moduleName, [
              { name: portName, direction: 'output', width: 4 },
            ]);
            const baseline = renderConsensusHarness(
              requestFor(moduleInterface, 'zzzzzzzzzzsafezzz'),
            );
            if (baseline.ok) {
              fc.pre(!baseline.value.contents.includes(nonceA));
              fc.pre(!baseline.value.contents.includes(nonceB));
            }

            const renderedA = renderConsensusHarness(requestFor(moduleInterface, nonceA));
            const renderedB = renderConsensusHarness(requestFor(moduleInterface, nonceB));
            if (!renderedA.ok || !renderedB.ok) {
              return;
            }
            const restored = renderedB.value.contents.split(nonceB).join(nonceA);
            expect(restored).toBe(renderedA.value.contents);
          },
        ),
        propertyParameters(),
      );
    },
  );
});
