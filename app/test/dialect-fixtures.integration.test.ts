// testbench-dialect-normalization, tasks 14.2 and 15.7: the 40 committed Dialect_Fixtures
// asserted against the REAL Icarus toolchain - fail-before, and the per-class fixed counts
// PINNED at what the transform actually achieves TODAY.
//
// WHAT THIS SUITE IS
//   `app/test/fixtures/dialect/index.json` indexes 40 testbenches a real campaign produced,
//   each recorded with the first `syntax error` line iverilog reported for it. `observed` is
//   GROUND TRUTH (iverilog said it, external to us); `classified` is THE TOOL'S LABEL (our
//   normalizer's opinion). This suite compiles every one of them through the real toolchain
//   before and after `normalizeDialect`, so the transform's effect on measured model output
//   is a number rather than a claim.
//
// POSITION, NOT THE LABEL, IS WHAT THE PARSER READS: 25 OF 29
//   The `unnamed-begin-declaration` rule does two things to a block that declares after a
//   statement: it inserts a `: tbnorm_blk_<n>` label, and it MOVES that block's block-item
//   declarations to the top of the same block. Only the move is what the parser reacts to.
//   Measured with `-g2012`, a block-item declaration is accepted as the FIRST item of its block
//   and rejected AFTER a statement, whether or not the block carries a label; the label is
//   retained for IEEE 1364 conformance alone. This suite pinned the class at 0 of 29 for one
//   task cycle, while the rule inserted a label and nothing else, because the original
//   calibration was a confounded experiment that varied the label and the declaration's
//   position together and credited the label.
//
//   With the move, the class is 25 of 29, and the 4-fixture residue is EXPLAINED rather than
//   slippage - 3 declined `unbalanced-block` (two write C-style `}` instead of `end`, one is a
//   bare prose `CHECK` line, so a `begin` never finds its `end`) and 1 declined
//   `declaration-not-relocatable` (`genvar i;` in a function body, rejected as a block item at
//   ANY position, so no move can help). Against the fixtures this class can own, 25 of 25.
//   Each of the 4 is NAMED in `UNNAMED_BEGIN_DECLINES` below with the cause it must report, so
//   a residual fixture is asserted as a correct decline rather than tolerated as a miss.
//
// WHY THE ASSERTIONS ARE AT THE PARSE LEVEL AND NOT THROUGH `TestbenchPrecheck`
//   Structural, not convenience. `.eval-corpus/` and `.eval-runs/` are both gitignored, so no
//   Spec and no reference design exists in this repository for the 11 RTLLM DUTs these
//   fixtures instantiate. With a stub that does not declare the instantiated module, iverilog
//   reports `Unknown module type` AT a testbench line, which `attributedFiles` correctly
//   attributes to the testbench - so `TestbenchPrecheck` would answer `testbench-build-failed`
//   both BEFORE and AFTER normalization for all 40 and the entire after-half would go vacuous.
//   Compiling each fixture ALONE through the real `SimulatorAdapter` and reading whether a
//   `syntax error` naming it is present asks exactly the question the dialect classes are
//   about, and cross-checks it against the committed `observed.firstSyntaxErrorLine`.
//   Do not "improve" this into a stub-based version.
//
//   Deriving each fixture's `ModuleInterface` from its own instantiation was REJECTED: it means
//   a test-only Verilog parser whose failure mode is a confusing red gate rather than a real
//   finding. ONE real `TestbenchPrecheck` PAIR over the SMALLEST fixture, with a HAND-WRITTEN
//   interface - refused before normalization and accepted after - keeps the precheck path
//   exercised end to end (see the last describe block).
//
// READ THE PRESENCE OF A `syntax error` LINE, NEVER THE EXIT CODE
//   A rejected parse was observed exiting 1, 2, AND 4 across these fixtures, so any assertion
//   keyed on a particular exit code is flaky. The line's presence, and its line number, are
//   the stable signals.
//
// WHY THERE IS NO FAKE-SIMULATOR TWIN
//   The dual real/fake trajectory pattern (`real-oracle-integration-dual-trajectory-pattern`)
//   exists so a real-oracle test still exercises logic when the toolchain is absent. It does
//   not apply here: the fact under test IS the parser's verdict, and a fake simulator would be
//   asserting a hand-written answer about Verilog syntax. So this suite skips with a printed
//   warning instead, the same shape `testbench-precheck-measured-cases.integration.test.ts`
//   and `dialect-comments-are-whitespace.test.ts` use.
//
// Validates: Requirements 9.4, 9.6, 9.7, 9.8, 9.9, 9.10, 9.11

import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  CHECK_KEYWORD,
  normalizeDialect,
  sourceEmitsCheck,
  TestbenchPrecheck,
  type DialectClass,
  type DialectFinding,
} from '@app/agent';
import { makePort, type ModuleInterface, type Port } from '@app/core';
import type { ResourceLimits, SourceFile } from '@app/tools';

import { PROBE, realOracleAdapter } from './real-oracle-harness.js';

if (!PROBE.available) {
  console.warn(
    `[dialect-fixtures.integration] Real-toolchain path NOT exercised: ${PROBE.reason}. ` +
      'Every fixture assertion in this suite is SKIPPED in this environment, including the ' +
      'pinned per-class fixed counts, so nothing here passes vacuously.',
  );
}

/** Generous real-run caps: local process startup plus a real iverilog invocation. */
const REAL_LIMITS: ResourceLimits = { cpu: 1, memMb: 512, procs: 128, diskMb: 128, wallMs: 30_000 };

/** The whole 80-compile measurement pass runs once in `beforeAll`; give it room. */
const MEASUREMENT_TIMEOUT_MS = 600_000;

// -- The committed index ------------------------------------------------------

/** `app/test/fixtures/dialect/`, the root every `index.json` path is relative to. */
const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'dialect');

/** The closed three-member vocabulary an index entry's class must be a member of. */
const DIALECT_CLASSES: readonly DialectClass[] = [
  'unnamed-begin-declaration',
  'malformed-sized-literal',
  'prose-as-statement',
];

/** One indexed fixture, validated out of `index.json`. */
interface FixtureEntry {
  /** Path relative to `FIXTURE_ROOT`, as `index.json` records it. */
  readonly path: string;
  /** The basename, which is the workspace path each compile below submits. */
  readonly submittedPath: string;
  /** The tool's label. */
  readonly dialectClass: DialectClass;
  /** GROUND TRUTH: the first `syntax error` line the campaign's iverilog reported. */
  readonly observedFirstSyntaxErrorLine: number;
}

/** The raw shape `index.json` is read through; every field re-validated below. */
interface RawIndex {
  readonly fixtures?: readonly {
    readonly path?: unknown;
    readonly observed?: { readonly firstSyntaxErrorLine?: unknown };
    readonly classified?: { readonly dialectClass?: unknown };
  }[];
}

/**
 * Validate one raw index entry into a `FixtureEntry`, throwing on any malformed field.
 *
 * Loud rather than lenient on purpose: a silently dropped entry would quietly shrink this
 * suite's coverage, which is the one failure mode a fixture suite must not have.
 */
function entryAt(raw: NonNullable<RawIndex['fixtures']>[number], position: number): FixtureEntry {
  const { path } = raw;
  const line = raw.observed?.firstSyntaxErrorLine;
  const dialectClass = raw.classified?.dialectClass;
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error(`fixture index entry ${position} has no path`);
  }
  if (typeof line !== 'number' || !Number.isInteger(line) || line <= 0) {
    throw new Error(`fixture index entry ${position} (${path}) has no observed syntax-error line`);
  }
  if (!DIALECT_CLASSES.includes(dialectClass as DialectClass)) {
    throw new Error(`fixture index entry ${position} (${path}) has an unknown DialectClass`);
  }
  return {
    path,
    submittedPath: basename(path),
    dialectClass: dialectClass as DialectClass,
    observedFirstSyntaxErrorLine: line,
  };
}

/** Read and validate the committed index once, at collection time. */
function readFixtureIndex(): readonly FixtureEntry[] {
  const parsed: unknown = JSON.parse(readFileSync(join(FIXTURE_ROOT, 'index.json'), 'utf8'));
  const { fixtures } = parsed as RawIndex;
  if (fixtures === undefined) {
    throw new Error('fixture index holds no `fixtures` array');
  }
  return fixtures.map(entryAt);
}

const FIXTURES: readonly FixtureEntry[] = readFixtureIndex();

/** Every fixture of one class, in index order. */
function ofClass(dialectClass: DialectClass): readonly FixtureEntry[] {
  return FIXTURES.filter((entry) => entry.dialectClass === dialectClass);
}

// -- The pinned numbers -------------------------------------------------------

/**
 * The VERIFIED class sizes, replacing the vault note's unverified 24 / 8 / 6 hand count.
 *
 * Derived by running the real compiled `normalizeDialect` over the real captured artifacts and
 * reading every unclassified residue by hand at its exact iverilog error line. Counted off the
 * index array below, because no stored total exists to trust. Do not "correct" them back.
 */
const PINNED_CLASS_SIZES: Readonly<Record<DialectClass, number>> = {
  'unnamed-begin-declaration': 29,
  'malformed-sized-literal': 7,
  'prose-as-statement': 4,
  // No captured syntax-error fixture is a dump task: the class removes calls that compile.
  'model-dump-task': 0,
};

/**
 * The PINNED count, per class, of fixtures whose `syntax error` is GONE after normalization.
 *
 * `unnamed-begin-declaration` at 25 is the MEASURED CEILING for this class, not a target: the
 * remaining 4 are the declines named in `UNNAMED_BEGIN_DECLINES` below, 3 `unbalanced-block`
 * and 1 `declaration-not-relocatable`, each of which the toolchain still refuses for a reason
 * no meaning-preserving rewrite can reach. Against the fixtures this class can own, 25 of 25.
 * `prose-as-statement` at 0 is CORRECT and permanent - that class is detected and reported and
 * is never rewritten, because synthesizing a `$display` from our own prompt prose would
 * fabricate a check the model never wrote.
 *
 * ponytail: this suite alone cannot distinguish "the rule declined correctly" from "the rule
 * stopped firing" - both read as a fixture that still fails. The count pin IS the upgrade for
 * that ceiling, already applied: a rule that silently stops firing moves one of these numbers.
 * The per-fixture decline-cause assertions below close the rest of the gap for this class.
 */
const PINNED_FIXED_COUNTS: Readonly<Record<DialectClass, number>> = {
  'unnamed-begin-declaration': 25,
  'malformed-sized-literal': 3,
  'prose-as-statement': 0,
  'model-dump-task': 0,
};

/** The closed decline vocabulary, read off `DialectFinding` rather than re-exported for a test. */
type DeclineCause = NonNullable<DialectFinding['declinedBecause']>;

/**
 * The 4 `unnamed-begin-declaration` fixtures the transform DECLINES, each with the cause it
 * must report - named rather than counted, the way `SIZED_LITERAL_DECLINES` names its own.
 *
 * Naming them with their cause is what makes the 25-fixed / 4-declined split visible in this
 * suite's report instead of collapsing into a count, and it is strictly stronger than a bare
 * "still fails": a fixture that starts failing for a DIFFERENT reason - or that the rule quietly
 * stops seeing at all - breaks the cause assertion even though the count is unmoved.
 *
 * The first 3 are not really this class's failures at all: their first error is a `begin` with no
 * matching `end` (two use C-style `}` braces, one is a bare prose `CHECK` line). The 4th is the
 * hard ceiling - `genvar` is rejected as a block item at ANY position, so position, the only
 * thing the move can change, is irrelevant.
 */
const UNNAMED_BEGIN_DECLINES: ReadonlyMap<string, DeclineCause> = new Map([
  [
    'unnamed-begin-declaration/deepseek.v3.2__rtllm_control_JC_counter__sample-0.v',
    'unbalanced-block',
  ],
  [
    'unnamed-begin-declaration/qwen.qwen3-235b-a22b-2507__rtllm_miscellaneous_traffic_light__sample-0.v',
    'unbalanced-block',
  ],
  [
    'unnamed-begin-declaration/qwen.qwen3-coder-30b-a3b-instruct__rtllm_control_counter_12__sample-0.v',
    'unbalanced-block',
  ],
  [
    'unnamed-begin-declaration/qwen.qwen3-coder-next__rtllm_memory_asyn_fifo__sample-2.v',
    'declaration-not-relocatable',
  ],
]);

/**
 * The 4 `malformed-sized-literal` fixtures the transform DECLINES, named rather than counted.
 *
 * A decline is NOT a suite failure: a rewrite the normalizer cannot perform without guessing
 * what the model meant is the meaning-preserving outcome Requirement 5.7 demands. Naming them
 * is what makes the 3-fixed / 4-declined split visible in this suite's report instead of
 * collapsing into a bare pass.
 */
const SIZED_LITERAL_DECLINES: ReadonlySet<string> = new Set([
  'malformed-sized-literal/qwen.qwen3-235b-a22b-2507__rtllm_arithmetic_adder_pipe_64bit__sample-2.v',
  'malformed-sized-literal/qwen.qwen3-coder-next__rtllm_arithmetic_multi_booth_8bit__sample-2.v',
  'malformed-sized-literal/qwen.qwen3-coder-next__rtllm_control_JC_counter__sample-2.v',
  'malformed-sized-literal/qwen.qwen3-coder-next__rtllm_miscellaneous_signal_generator__sample-0.v',
]);

// -- Reading the toolchain ----------------------------------------------------

/**
 * The line number of the first `syntax error` naming `submittedPath`, or `null` if there is
 * none.
 *
 * Membership over `stderr`'s lines, never the exit code: a rejected parse was observed exiting
 * 1, 2, and 4 across these fixtures. iverilog writes `<path>:<line>: syntax error`, so the
 * number is read as an index into that line's own text and nothing is extracted from any path
 * the diagnostic mentions.
 */
function firstSyntaxErrorLine(stderr: string, submittedPath: string): number | null {
  const prefix = `${submittedPath}:`;
  for (const line of stderr.split('\n')) {
    if (!line.startsWith(prefix) || !line.includes('syntax error')) {
      continue;
    }
    const afterPath = line.slice(prefix.length);
    const separator = afterPath.indexOf(':');
    if (separator <= 0) {
      continue;
    }
    const lineNumber = Number.parseInt(afterPath.slice(0, separator), 10);
    if (Number.isInteger(lineNumber)) {
      return lineNumber;
    }
  }
  return null;
}

/**
 * Compile one source ALONE through the real `SimulatorAdapter` and report the first
 * `syntax error` line naming it.
 *
 * `rtl: []` is what "alone" means: no stub, no DUT, so the reading is a pure PARSE fact about
 * the testbench and a missing module type cannot contaminate it. The run's verdict is always
 * `error` (the DUT the fixture instantiates does not exist), which is why the verdict is not
 * read at all - only the diagnostics are.
 */
async function parseAlone(contents: string, submittedPath: string): Promise<number | null> {
  const file: SourceFile = { path: submittedPath, contents };
  const verdict = await realOracleAdapter().simulate([], file, REAL_LIMITS);
  return firstSyntaxErrorLine(verdict.stderr, submittedPath);
}

/**
 * The distinct check names a testbench SOURCE emits, in first-emission order.
 *
 * `sourceEmitsCheck` is the production owner of "does this source emit `CHECK <name>`" - it
 * exists for exactly that question over model-authored testbench text - so it is what the
 * assertion below uses. `readCheckSignals` is the WRONG owner: that reader parses a RUN'S
 * STDOUT and anchors the `CHECK` keyword at the start of a line, so a
 * `$display("CHECK <name> PASS");` inside a source does not match it at all and every such
 * assertion would pass vacuously.
 *
 * `sourceEmitsCheck` is a predicate, not an enumerator, and no production module enumerates
 * (the only enumerator, `prose-as-statement.ts`'s pattern, is deliberately private). So the
 * enumeration lives here - and it uses the PREDICATE'S OWN grammar rather than a second one:
 * the identifier-shaped token immediately following the keyword, separated by spaces or tabs.
 * An earlier draft enumerated `\S+` followed by `PASS|FAIL`, which captured `ac1_produces_the:`
 * with its colon out of a prose `CHECK <name>: PASS;` line and `<name>` out of a comment
 * quoting the convention - neither of which the predicate can find, because its trailing `\b`
 * needs a word character before it. Two grammars disagreeing is a test defect, not a finding,
 * and the assertion below anchors against it by checking the INPUT side too.
 *
 * The pattern is built per call rather than shared at module level: a shared `/g` regex carries
 * its `lastIndex` between callers, which has already hung this package's suite once.
 */
function checkNamesEmittedBy(source: string): readonly string[] {
  const pattern = new RegExp(`${CHECK_KEYWORD}[ \\t]+([A-Za-z0-9_$]+)`, 'g');
  const names = new Set<string>();
  for (const match of source.matchAll(pattern)) {
    const name = match[1];
    if (name !== undefined) {
      names.add(name);
    }
  }
  return [...names];
}

// -- The measurement pass -----------------------------------------------------

/** Everything measured for one fixture, from one compile of each phase. */
interface FixtureMeasurement {
  readonly beforeSyntaxErrorLine: number | null;
  readonly afterSyntaxErrorLine: number | null;
  /** Whether the `syntax error` is gone after normalization: the "fixed" predicate. */
  readonly fixed: boolean;
  readonly findings: readonly DialectFinding[];
  /** The fixture's own bytes, as committed. */
  readonly source: string;
  readonly normalizedSource: string;
  readonly emittedCheckNames: readonly string[];
}

const MEASURED = new Map<string, FixtureMeasurement>();

/** The measurement for one fixture, failing loudly rather than silently skipping. */
function measurementOf(entry: FixtureEntry): FixtureMeasurement {
  const measured = MEASURED.get(entry.path);
  if (measured === undefined) {
    throw new Error(`no measurement recorded for ${entry.path}`);
  }
  return measured;
}

/** How many fixtures of one class the transform fixed. */
function fixedCountOf(dialectClass: DialectClass): number {
  return ofClass(dialectClass).filter((entry) => measurementOf(entry).fixed).length;
}

describe.skipIf(!PROBE.available)(
  'the 40 committed Dialect_Fixtures against the real Icarus toolchain (Req 9.4, 9.6-9.11)',
  () => {
    beforeAll(async () => {
      for (const entry of FIXTURES) {
        const source = readFileSync(join(FIXTURE_ROOT, entry.path), 'utf8');
        const { source: normalizedSource, report } = normalizeDialect(source);
        const beforeSyntaxErrorLine = await parseAlone(source, entry.submittedPath);
        const afterSyntaxErrorLine = await parseAlone(normalizedSource, entry.submittedPath);
        MEASURED.set(entry.path, {
          beforeSyntaxErrorLine,
          afterSyntaxErrorLine,
          fixed: beforeSyntaxErrorLine !== null && afterSyntaxErrorLine === null,
          findings: report.findings,
          source,
          normalizedSource,
          emittedCheckNames: checkNamesEmittedBy(source),
        });
      }
    }, MEASUREMENT_TIMEOUT_MS);

    // -- Assertion 1: the index holds exactly 29 / 7 / 4 ----------------------

    describe('the committed index', () => {
      it('holds exactly 40 entries, counted off the array', () => {
        expect(FIXTURES).toHaveLength(40);
      });

      for (const dialectClass of DIALECT_CLASSES) {
        it(`holds exactly ${PINNED_CLASS_SIZES[dialectClass]} ${dialectClass} entries`, () => {
          expect(ofClass(dialectClass)).toHaveLength(PINNED_CLASS_SIZES[dialectClass]);
        });
      }
    });

    // -- Assertion 2: all 40 fail before, at their committed line --------------
    //
    // This is what makes every after-assertion below non-vacuous. It also confirms the
    // fixture capture and the campaign's ground truth against each other: the line iverilog
    // reports here, today, on this machine, is the line the campaign recorded.

    describe('every fixture FAILS before normalization at its committed line (Req 9.4)', () => {
      for (const entry of FIXTURES) {
        it(`${entry.path} reports a syntax error at line ${entry.observedFirstSyntaxErrorLine}`, () => {
          expect(measurementOf(entry).beforeSyntaxErrorLine).toBe(
            entry.observedFirstSyntaxErrorLine,
          );
        });
      }
    });

    // -- Assertion 3: the per-class fixed counts, PINNED ----------------------

    describe('the per-class fixed counts, PINNED at what the transform achieves', () => {
      it('fixes 25 of 29 unnamed-begin-declaration fixtures (the measured ceiling, Req 9.5)', () => {
        // The move, not the label, is what the parser reads. 25 is every fixture this class can
        // own: the other 4 are the named declines asserted below.
        expect(fixedCountOf('unnamed-begin-declaration')).toBe(
          PINNED_FIXED_COUNTS['unnamed-begin-declaration'],
        );
      });

      it('fixes 3 of 7 malformed-sized-literal fixtures', () => {
        expect(fixedCountOf('malformed-sized-literal')).toBe(
          PINNED_FIXED_COUNTS['malformed-sized-literal'],
        );
      });

      it('fixes 0 of 4 prose-as-statement fixtures (CORRECT: reported, never rewritten)', () => {
        expect(fixedCountOf('prose-as-statement')).toBe(PINNED_FIXED_COUNTS['prose-as-statement']);
      });
    });

    // -- Assertion 4: the unnamed-begin split, named ---------------------------

    describe('the unnamed-begin-declaration split: 25 moved and fixed, 4 declined (Req 5.7)', () => {
      for (const entry of ofClass('unnamed-begin-declaration')) {
        const declinedBecause = UNNAMED_BEGIN_DECLINES.get(entry.path);

        if (declinedBecause !== undefined) {
          it(`${entry.path} is DECLINED ${declinedBecause} and still fails at line ${entry.observedFirstSyntaxErrorLine}`, () => {
            const measured = measurementOf(entry);
            const unnamedBegin = measured.findings.filter(
              (finding) => finding.dialectClass === 'unnamed-begin-declaration',
            );

            expect(unnamedBegin).not.toHaveLength(0);
            for (const finding of unnamedBegin) {
              expect(finding.action).toBe('declined');
              expect(finding.declinedBecause).toBe(declinedBecause);
            }
            expect(measured.afterSyntaxErrorLine).toBe(entry.observedFirstSyntaxErrorLine);
          });
          continue;
        }

        it(`${entry.path} is MOVED and loses its syntax error`, () => {
          const measured = measurementOf(entry);

          expect(
            measured.findings.filter(
              (finding) =>
                finding.dialectClass === 'unnamed-begin-declaration' &&
                finding.action === 'rewritten',
            ),
          ).not.toHaveLength(0);
          expect(measured.afterSyntaxErrorLine).toBeNull();
        });
      }

      it('declines exactly 4 of the 29, the ones named in UNNAMED_BEGIN_DECLINES', () => {
        const stillFailing = ofClass('unnamed-begin-declaration')
          .filter((entry) => !measurementOf(entry).fixed)
          .map((entry) => entry.path);

        expect([...stillFailing].sort()).toEqual([...UNNAMED_BEGIN_DECLINES.keys()].sort());
      });
    });

    // -- Assertion 5: the sized-literal split, named ---------------------------

    describe('the malformed-sized-literal split: 3 rewritten and fixed, 4 declined (Req 5.7)', () => {
      for (const entry of ofClass('malformed-sized-literal')) {
        const declines = SIZED_LITERAL_DECLINES.has(entry.path);

        if (declines) {
          it(`${entry.path} is DECLINED value-not-determinable and still fails at line ${entry.observedFirstSyntaxErrorLine}`, () => {
            const measured = measurementOf(entry);
            const sizedLiteral = measured.findings.filter(
              (finding) => finding.dialectClass === 'malformed-sized-literal',
            );

            expect(sizedLiteral).not.toHaveLength(0);
            for (const finding of sizedLiteral) {
              expect(finding.action).toBe('declined');
              expect(finding.declinedBecause).toBe('value-not-determinable');
            }
            expect(measured.afterSyntaxErrorLine).toBe(entry.observedFirstSyntaxErrorLine);
          });
          continue;
        }

        it(`${entry.path} is REWRITTEN and loses its syntax error`, () => {
          const measured = measurementOf(entry);

          expect(
            measured.findings.filter(
              (finding) =>
                finding.dialectClass === 'malformed-sized-literal' &&
                finding.action === 'rewritten',
            ),
          ).not.toHaveLength(0);
          expect(measured.afterSyntaxErrorLine).toBeNull();
        });
      }

      it('declines exactly 4 of the 7, the ones named in SIZED_LITERAL_DECLINES', () => {
        const stillFailing = ofClass('malformed-sized-literal')
          .filter((entry) => !measurementOf(entry).fixed)
          .map((entry) => entry.path);

        expect([...stillFailing].sort()).toEqual([...SIZED_LITERAL_DECLINES].sort());
      });
    });

    // -- Assertion 6: prose-as-statement still fails, and is NAMED -------------

    describe('every prose-as-statement fixture still fails and the class is NAMED', () => {
      // Still-failing is CORRECT here, so this is what stops a future change from starting to
      // rewrite the class. The class must also be REPORTED by name, which is the same
      // `findProseAsStatements` detector `PrecheckDiagnostic.dialectClasses` carries - so
      // asserting it on the normalizer's report asserts the fact the diagnostic reports.
      for (const entry of ofClass('prose-as-statement')) {
        it(`${entry.path} still fails at line ${entry.observedFirstSyntaxErrorLine} and is reported as prose-as-statement`, () => {
          const measured = measurementOf(entry);
          const prose = measured.findings.filter(
            (finding) => finding.dialectClass === 'prose-as-statement',
          );

          expect(prose).not.toHaveLength(0);
          for (const finding of prose) {
            expect(finding.action).toBe('declined');
            expect(finding.declinedBecause).toBe('reported-only');
          }
          expect(measured.afterSyntaxErrorLine).toBe(entry.observedFirstSyntaxErrorLine);
        });
      }
    });

    // -- Assertion 7: no check name is lost ------------------------------------

    describe("every check name the fixture emits survives in the transform's output (Req 5.10)", () => {
      for (const entry of FIXTURES) {
        it(`${entry.path} keeps every CHECK name it emitted`, () => {
          const measured = measurementOf(entry);

          // Non-vacuity: a fixture that emitted no check name would make the loop below
          // assert nothing, and every one of these testbenches signals at least one check.
          expect(measured.emittedCheckNames).not.toHaveLength(0);
          for (const name of measured.emittedCheckNames) {
            // The INPUT side first, so the enumeration above is held to the predicate's own
            // grammar. A name the predicate cannot find in the source it was read from is a
            // disagreement between two graders, and it must fail here rather than masquerade
            // as the transform having dropped a check.
            expect(sourceEmitsCheck(measured.source, name)).toBe(true);
            expect(sourceEmitsCheck(measured.normalizedSource, name)).toBe(true);
          }
        });
      }
    });
  },
);

// -- The one end-to-end `TestbenchPrecheck` case ------------------------------

/** Build a `Port`, failing loudly rather than silently on a bad fixture. */
function port(input: {
  readonly name: string;
  readonly direction: Port['direction'];
  readonly width: number;
}): Port {
  const result = makePort(input);
  if (!result.ok) {
    throw new Error(`fixture declared an invalid port: ${result.error.code}`);
  }
  return result.value;
}

/**
 * The smallest of the 40 fixtures by byte length, and the only one run through the precheck.
 *
 * It is one of the 25 the transform fixes, which is what lets the pair below be refused-before
 * and accepted-after on the SAME bytes.
 */
const SMALLEST_FIXTURE =
  'unnamed-begin-declaration/mistral.devstral-2-123b__rtllm_control_JC_counter__sample-1.v';

/** That fixture's committed first `syntax error` line, from `index.json`. */
const SMALLEST_FIXTURE_ERROR_LINE = 34;

/**
 * A HAND-WRITTEN interface for the smallest fixture's DUT, read off its own instantiation by a
 * human and committed as a literal.
 *
 * This is the one place the suite deviates from the parse-level reading, and it is deliberately
 * one place: it keeps `TestbenchPrecheck` - the stub build, the `attributedFiles` attribution,
 * and the decision table - exercised end to end against real model output. Writing 40 of these
 * by machine was rejected (see this file's header); writing one by hand is not a parser.
 */
const JC_COUNTER_INTERFACE: ModuleInterface = {
  validityOutputName: null,
  moduleName: 'JC_counter',
  ports: [
    port({ name: 'clk', direction: 'input', width: 1 }),
    port({ name: 'rst_n', direction: 'input', width: 1 }),
    port({ name: 'Q', direction: 'output', width: 64 }),
  ],
  clocking: { clockName: 'clk', resetName: 'rst_n', resetActiveLow: true },
};

// The strongest single pair in this suite: ONE real fixture, REFUSED before normalization and
// ACCEPTED after, through the real `TestbenchPrecheck` - the stub build, the `attributedFiles`
// attribution, and the decision table, not the parse-level shortcut the 40-fixture pass uses.
// The before-case is also the after-case's non-vacuity anchor: it proves this machine's
// toolchain is present, that `simulate` does not throw, and that the hand-written stub declares
// `JC_counter` (otherwise the refusal would have been `Unknown module type`) - so the after-case's
// `undecided` is the precheck finding nothing to refuse, not the precheck never having run.
describe.skipIf(!PROBE.available)(
  'TestbenchPrecheck end to end over the smallest fixture and its hand-written interface',
  () => {
    const testbenchFor = (contents: string): SourceFile => ({
      path: basename(SMALLEST_FIXTURE),
      contents,
    });

    it('refuses the fixture, naming the real syntax error rather than an unknown module', async () => {
      const source = readFileSync(join(FIXTURE_ROOT, SMALLEST_FIXTURE), 'utf8');
      const precheck = new TestbenchPrecheck(realOracleAdapter());

      const { outcome, diagnostic } = await precheck.runWithDiagnostic(
        testbenchFor(source),
        JC_COUNTER_INTERFACE,
        REAL_LIMITS,
      );

      expect(outcome).toBe('testbench-build-failed');
      // The non-vacuity anchor for the hand-written interface: the stub DOES declare
      // `JC_counter`, so the refusal is the fixture's own mid-block declaration and not the
      // `Unknown module type` a non-matching stub would have produced.
      expect(diagnostic.firstError).toContain('syntax error');
      expect(diagnostic.sourceLine?.lineNumber).toBe(SMALLEST_FIXTURE_ERROR_LINE);
    }, 60_000);

    it('ACCEPTS the same fixture after normalization: the refusal is gone', async () => {
      const source = readFileSync(join(FIXTURE_ROOT, SMALLEST_FIXTURE), 'utf8');
      const { source: normalized, report } = normalizeDialect(source);
      const precheck = new TestbenchPrecheck(realOracleAdapter());

      // The rule FIRED, and it MOVED rather than only labelled - the fact the acceptance below
      // is attributable to. A `changed: true` carrying no rewritten finding would be the
      // label-only state this suite pinned at 0 of 29 for a task cycle.
      expect(report.changed).toBe(true);
      expect(
        report.findings.filter(
          (finding) =>
            finding.dialectClass === 'unnamed-begin-declaration' && finding.action === 'rewritten',
        ),
      ).not.toHaveLength(0);

      const { outcome, diagnostic } = await precheck.runWithDiagnostic(
        testbenchFor(normalized),
        JC_COUNTER_INTERFACE,
        REAL_LIMITS,
      );

      // `undecided` is the precheck's ACCEPT: it means "proceed exactly as before this precheck
      // existed" (Property 6). Asserting the whole diagnostic is empty rather than only the
      // outcome is what distinguishes accepted from refused-with-a-different-line.
      expect(outcome).toBe('undecided');
      expect(diagnostic.firstError).toBeNull();
      expect(diagnostic.sourceLine).toBeNull();
      expect(diagnostic.noDiagnosticCaptured).toBe(false);
    }, 60_000);
  },
);
