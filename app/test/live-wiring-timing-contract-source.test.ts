// **Feature: timing-contract-inference, source scan: the Live_Wiring builds no Timing_Contract**
// (task 6.3).
//
// WHY A SOURCE SCAN AND NOT A BEHAVIOURAL TEST
//   Requirement 5.3 forbids the Live_Wiring from INVOKING a Timing_Contract constructor. No
//   behavioural test can see that: a wiring that rebuilt a contract identical to the Spec's would
//   hand the harness the same request as one that read `spec.timingContract` straight through, so
//   task 6.2's Property 17 passes either way. The absence of the constructor is therefore a fact
//   about the SOURCE TEXT, and this file reads it as text. Importing the module and inspecting it
//   at runtime would not work either - an import that is not there leaves nothing to inspect.
//
// WHAT IS FORBIDDEN, PRECISELY
//   The CONSTRUCTOR, not the type. The Live_Wiring must still name `Spec`, and naming a
//   `TimingContract` type would be fine: `import type` erases under `verbatimModuleSyntax` and
//   loads no code. What may not appear is `makeTimingContract`, in any import or call position,
//   and `buildRegisteredTimingContract` - the all-`registered` helper task 6.1 deleted, which is
//   the specific fabrication being retired and would reintroduce the fault without ever touching
//   `@app/core`. Both names are checked, and a negative control below appends the type import to
//   prove the scan does not ban it.
//
// REQUIREMENT 6.2 IS ALREADY COVERED, SO IT IS NOT REPEATED HERE
//   Task 6.3 also cites Req 6.2, the Ground_Truth_Manifest's provenance. Task 1.2 already landed
//   that scan in `timing-ground-truth-manifest.property.test.ts`, under
//   "the Ground_Truth manifest imports no derivation and computes nothing at load (Req 6.2)": it
//   reads the manifest source as text, pins its import list to `@app/core` alone, carries a
//   positive control over three derivation module shapes (the timing module, the prepass, and the
//   `@app/tools` barrel), and pins the export to a frozen literal array rather than a call. That
//   is both halves of the criterion - no derivation import, no computation at load - with its own
//   control, so a near-duplicate here would add no measurement and would be a second place to
//   update. Only the `live-wiring.ts` half is new, and it is what this file adds.
//
// Validates: Requirements 5.3, 6.2

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

const LIVE_WIRING_MODULE = '../eval/consensus-regression/live-wiring.ts';

/**
 * The Live_Wiring's own source, read fresh from `.ts` rather than from `dist`.
 *
 * Fresh so that a reintroduced constructor fails here before `tsc -b` has rebuilt the output, and
 * so a positive control can append a violating line without touching disk.
 */
const LIVE_WIRING_SOURCE = readFileSync(new URL(LIVE_WIRING_MODULE, import.meta.url), 'utf8');

/**
 * The two names that would mean the Live_Wiring builds a contract of its own: `@app/core`'s
 * constructor, and the local helper task 6.1 deleted.
 */
const FORBIDDEN_NAMES = ['makeTimingContract', 'buildRegisteredTimingContract'] as const;

/**
 * A comment, or a quoted string - the tokens a scan for an identifier must not look inside.
 *
 * Template literals are deliberately NOT blanked: an interpolation is executable code, so
 * blanking the whole template would hide a constructor call inside one. The cost is that the
 * forbidden name inside a backtick string would be reported - a loud false failure rather than a
 * silent false pass, which is the direction this scan must err in.
 */
const COMMENT_OR_STRING = /\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"/g;

/** `source` with every comment and quoted string blanked to spaces, newlines kept so lines align. */
function codeOf(source: string): string {
  return source.replace(COMMENT_OR_STRING, (token) => token.replace(/[^\n]/g, ' '));
}

/**
 * Which of `FORBIDDEN_NAMES` appear in `source` as executable identifiers, in listed order.
 *
 * Position-independent on purpose: it catches the name in a named import, in a namespace member
 * access off a `await import()`, and in a bare call, which a scan anchored to `^import` would
 * miss. Comments and quoted strings are blanked first, so the explanatory comment above - which
 * names both forbidden identifiers - does not report itself.
 */
function forbiddenNamesIn(source: string): readonly string[] {
  const code = codeOf(source);
  return FORBIDDEN_NAMES.filter((name) => new RegExp(`\\b${name}\\b`, 'u').test(code));
}

describe('the Live_Wiring assembles its harness request without a Timing_Contract constructor (Req 5.3)', () => {
  it('names neither the constructor nor the deleted all-registered helper', () => {
    expect(forbiddenNamesIn(LIVE_WIRING_SOURCE)).toEqual([]);
  });

  it("reads the Spec's contract instead, so the scan is pointed at the module that does the work", () => {
    // NON-VACUITY: absence proves nothing if this is the wrong file or an empty one. The request
    // the scan is about is in there, taking its contract from the Spec (task 6.1).
    expect(codeOf(LIVE_WIRING_SOURCE)).toMatch(/timingContract:\s*spec\.timingContract/);
  });

  it('reports a violation when one is appended, so the clean result above is a measurement', () => {
    // POSITIVE CONTROL. Without it a scanner that matched nothing would pass every source. Three
    // shapes, because the constructor can re-enter by any of them: the named import task 6.1
    // deleted, a call with no import of its own (via a re-export or a namespace), and the deleted
    // helper being written back.
    const violations: readonly [string, readonly string[]][] = [
      [`import { makeTimingContract } from '@app/core';\n`, ['makeTimingContract']],
      [`const contract = makeTimingContract([]);\n`, ['makeTimingContract']],
      [
        `function buildRegisteredTimingContract() {\n  return null;\n}\n`,
        ['buildRegisteredTimingContract'],
      ],
    ];
    for (const [violation, expected] of violations) {
      expect(forbiddenNamesIn(`${LIVE_WIRING_SOURCE}\n${violation}`)).toEqual(expected);
    }
  });

  it('leaves a type-only import and a comment naming the constructor alone', () => {
    // NEGATIVE CONTROLS, pinning what the scan must NOT ban. The type erases and loads no code,
    // so the Live_Wiring may name it; and a comment explaining why the constructor is absent is
    // not an invocation of it. A scan that banned the bare word `TimingContract`, or that skipped
    // comment blanking, would fail one of these.
    for (const permitted of [
      `import type { TimingContract } from '@app/core';\n`,
      `// never makeTimingContract, and never buildRegisteredTimingContract, here\n`,
      `/* makeTimingContract is the Spec_Agent's to call, not this module's */\n`,
    ]) {
      expect(forbiddenNamesIn(`${LIVE_WIRING_SOURCE}\n${permitted}`)).toEqual([]);
    }
  });
});
