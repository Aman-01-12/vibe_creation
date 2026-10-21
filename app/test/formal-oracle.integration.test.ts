// formal-property-oracle, integration test 1: THE VACUOUS CHAIN IS LOUD (task 6.2).
//
// This is the single most important test in the spec, and what it measures is a WRONG ANSWER in
// the measuring instrument itself. On `adder_8bit`, asserting `cout == 1'b0` - a property that is
// PROVABLY FALSE of that design, since `a=254, b=255, cin=1` sums to 510 - the lowering chain with
// `async2sync` and `chformal -lower` omitted:
//
//     emits ZERO assertions into the SMT2, and NEVER refutes the false property.
//
// `grep -c assert` on the generated SMT2 returned 0 for that chain and 2 for the correct one, and
// that count is the ONLY signal separating them that does not depend on the Yosys version - which
// is why the worker reports it unconditionally and why the gate weighs it FIRST. This file is what
// makes those two numbers measured facts in this repository rather than a recorded claim in a
// comment.
//
// HOW LOUD THE EMPTY CHAIN IS DEPENDS ON THE YOSYS VERSION, AND THE COUNT DOES NOT (task 17.2)
//   On Yosys 0.66 - the host every anchor below was first measured on - the empty chain `exits 0`
//   and reports `Status: PASSED`, so from the verdict alone that run is indistinguishable from a
//   real proof. That is the silent wrong answer this file was written for.
//
//   On the upgraded host (Yosys 0.69+post, git sha1 143eb14f) the SAME chain is REFUSED outright:
//   `write_smt2` errors with `Unsupported cell type $check ... please run 'async2sync' or
//   'clk2fflogic' before 'write_smt2'`, Yosys exits 1, the partial SMT2 it leaves behind carries 0
//   assertion-bearing lines, and `yosys-smtbmc` then exits 1 printing NO `Status:` line at all.
//
//   Both arms are the SAME defect where the gate stands: the assertion count is 0, so `admitProved`
//   refuses with `zero-assertions` either way. The upgrade made the trap loud at the toolchain
//   layer; it did NOT change the gate condition, which is why `FORMAL_ORACLE_VERSION` does not move
//   for it. The test below pins the UPGRADED shape, because `FORMAL_PROBE` requires
//   `yosys-smtbmc -s bitwuzla` to be invocable with no shim and no Yosys older than 0.67 clears
//   that bar - so the 0.66 arm is unreachable wherever this group runs, and recording it as a
//   tolerated alternative would be dead text rather than a second case.
//
// ---------------------------------------------------------------------------------------------
// THE WHOLE FILE NOW RUNS WITH NO SHIM - EVERY "SKIPS HERE" NOTE BELOW IS SUPERSEDED (task 17.2)
// ---------------------------------------------------------------------------------------------
//   Each group header below records, as the state of its own session, that `yosys-smtbmc -s
//   bitwuzla` was not invocable on Yosys 0.66, that `FORMAL_PROBE` therefore reported the toolchain
//   NOT INVOCABLE, that the group SKIPPED, and that its anchors were taken under `-s z3` or under a
//   temporary bitwuzla flag shim that was never committed. **All of that is now historical.** Task
//   17.1 upgraded the host and task 17.2 re-ran this file against it:
//
//     yosys           0.69+post (git sha1 143eb14f9cc55d6f8927e68523b0c9d2166ed02c)
//     yosys-smtbmc    shipped with that Yosys
//     bitwuzla        0.9.1
//     z3              4.15.4
//
//   `FORMAL_PROBE.available` is TRUE there, so all 34 `RUNNABLE`-gated tests in this file EXECUTE
//   rather than skip, under the SHIPPED `-s bitwuzla` invocation with no shim on PATH. Executed and
//   skipped counts are what separate an upgraded host from an unupgraded one, so they are the first
//   thing to read off a run of this file: 55 tests collected, 0 skipped.
//
//   THE GATED COUNT MOVED FROM 33 TO 34, AND THE COLLECTED COUNT FROM 54 TO 55 (task 18.3). Task
//   17.2 pinned 33 and 54 as the counts of the upgraded host; task 18.3 added exactly ONE
//   `RUNNABLE`-gated case - the bare-internal-name build failure, in the task 6.8 dialect group -
//   and nothing else in this file was added or removed. Any later reader comparing against 33 is
//   reading the pre-18.3 number.
//
//   EVERY 0.66-era anchor below was re-observed and held, with the ONE exception recorded above:
//   the false property still refutes with a true counterexample, both adder mutants still refute,
//   the vacuous property is still detected at the ladder's top rung, `bad_init` is still refuted
//   rather than masked, both mixed-edge dividers are still REFUSED rather than refuted, both
//   quarantined references still fail in the Yosys frontend with their recorded diagnostics, and
//   the `CLK_POLARITY` and free-initial-state reads still come back as their tables record them.
//   The per-group anchor tables are left spelled as the 0.66 measurements they were, because that
//   is their provenance; what moved is named at the point it moved and nowhere else.
//
// WHY THE MEASUREMENT RUNS YOSYS DIRECTLY INSTEAD OF THROUGH THE WORKER
//   The Lowering_Sequence is a CONSTANT in the worker (`YOSYS_FORMAL_SCRIPT` in `eda.py`) precisely
//   so that no caller can vary it - there is no job field, no adapter string, and no parameter that
//   could omit a pass. So the vacuous chain is unreachable through our own seam, which is the whole
//   point of building it that way, and the only way to measure what it DOES is to run the two
//   chains side by side outside the worker. The worker's own copy of the correct sequence is pinned
//   by `app/tools/sandbox/worker/tests/test_formal_lowering.py` (task 2.3); this file asserts what
//   the TOOLCHAIN does with and without the two load-bearing passes, which is a different claim and
//   needs its own measurement.
//
// WHAT IS REAL HERE
//   The design is RTLLM's own `adder_8bit` reference at the pinned commit, read through the same
//   importer every other corpus suite uses. The wrapper is rendered by `renderPropertyWrapper`, so
//   the assertion being counted is one OUR renderer emitted rather than one hand-written for the
//   test. The property goes through `validateExpression`, so it is inside the accepted dialect. Only
//   the two Yosys invocations and the `yosys-smtbmc` invocation are spawned here.
//
//   The pre-pass is NOT in this path. This file measures the LOWERING, and `adder_8bit` carries no
//   reset net, so the wrapper is rendered with a REFUSED Reset_Contract - which emits no reset
//   assume and no assertion gate, and is the right wrapper for a reset-less combinational design.
//   Whether a reset-less design survives the pre-pass on the way to a verdict is task 6.3's
//   question, not this one's.
//
// SKIP, AND WHY A SKIP HERE IS NOT A WEAKENING
//   Gated on `FORMAL_PROBE.available` through the harness's single skip mechanism. That probe
//   requires yosys, `yosys-smtbmc`, bitwuzla, z3, and the worker Python to be PRESENT, and it
//   additionally requires `yosys-smtbmc -s bitwuzla` to be INVOCABLE - bitwuzla 0.9.x is present and
//   spawnable while the composed invocation fails on every input, and a run under a broken solver
//   would report `toolchain-unavailable` for every sample, which in a results table looks like a
//   measurement of the design. The real assertions below are NOT weakened to pass without the
//   binaries: where the tools are absent or not invocable the suite skips with its reason surfaced,
//   and where they are present and the behaviour is wrong it FAILS.
//
// WHAT THE FIRST MEASUREMENT DELIBERATELY DOES NOT ASSERT
//   The gate RULE - that a zero or absent count overrides every other signal, over generated
//   reports - is Property 3, asserted in `formal-zero-assertion-guard.property.test.ts`. What is
//   added here is the JOIN: the count the REAL vacuous chain produces is fed to the real gate, so
//   the measured number and the rule meet.
//
// ---------------------------------------------------------------------------------------------
// integration test 2 (task 6.3): THE GATE DISCRIMINATES - THREE REFUTATIONS AND TWO PROOFS
// ---------------------------------------------------------------------------------------------
//
// The measurement above establishes that a chain which checks NOTHING is caught. It says nothing
// about whether the chain that checks SOMETHING gets the answer right, and those are separable:
// an oracle that refuses everything passes every negative control ever written. So this half
// drives FIVE properties through the real adapter and asserts both directions.
//
//   NEGATIVE CONTROLS - each must report `refuted`
//     1. `adder_8bit` asserting `cout == 1'b0`, which is PROVABLY FALSE of that design.
//     2. `ARITH_PLUS_TO_MINUS`: `full_adder`'s `a + b + cin` mutated to `a + b - cin`, against
//        the CORRECT exact-sum property.
//     3. `INDEX_OFF_BY_ONE`: `FA3`'s `.cin(c[2])` mutated to `.cin(c[1])`, so `c[1]` feeds both
//        FA2 and FA3 and the carry chain is misrouted, against the same correct property. This is
//        the subtle misroute random simulation vectors can miss, killed here exhaustively.
//
//   POSITIVE CONTROLS - each must report `proved`
//     4. `counter_12` asserting `out <= 4'd11`, proved by temporal induction at depth 20.
//     5. The CLEAN `adder_8bit` against the correct exact-sum property, proved at depth 1.
//
//   WHY THE POSITIVE CONTROLS CARRY THE WEIGHT. A suite of only negative controls passes if the
//   oracle refutes everything, which is exactly what a broken instrument does - and refuting a
//   correct design is the ONE failure direction that reaches a student as a verdict about their
//   own work. Control 5 in particular makes `adder_8bit` two-directional: the same design under
//   the same chain is refuted for a false property and proved for a true one, so neither answer
//   can be an artifact of the design or of the fixture.
//
// WHY `adder_8bit` REACHES A VERDICT AT ALL, WHICH IS LOAD-BEARING AND EASY TO MISS
//   `adder_8bit` is purely combinational: it holds no flip-flop cell, so the Reset_Contract_Prepass
//   retains no reset entry and derives `clockPolarity: 'none'`. Until criteria 14.40 and 14.41 were
//   added, criterion 14.18 refused that finding with `reset-contract-unresolved` before any solver
//   ran, and ALL FOUR of this task's original assertions were unreachable - refused at the pre-pass.
//   The narrowing admits a `derived: false` finding as a contract REQUIRING NO RESET wherever the
//   DERIVED `clockPolarity` is `none`, and `adder_8bit` reaching any verdict below is the
//   end-to-end evidence for it (`chipAgent/_inbox/gotcha-criterion-14-18-refused-the-whole-
//   combinational-class-and-made-three-other-criteria-dead-text.md`).
//
//   THE WRAPPER FOR IT MUST CARRY NO RESET ASSUME AND NO `if (!$initstate)` GATE (Req 14.41), and
//   both omissions are correct rather than incidental. A reset assume over a design with no state
//   pins nothing. An `!$initstate` gate would be actively WRONG: step 0 is the ONLY step at
//   `COMBINATIONAL_DEPTH = 1`, so the gate would suppress the single sample and yield a VACUOUS
//   PASS - precisely the failure mode the zero-assertion measurement above exists to catch. A gate
//   wrongly emitted here would therefore make controls 1 to 3 pass for the WRONG reason, which is
//   why control 5 is the one that would notice.
//
// MEASURED ANCHORS, AND THE ONE THING THAT MAKES THEM READABLE AT ALL
//   Every number below was measured out of band on this host - Yosys 0.66, z3 4.15.4,
//   bitwuzla 0.9.1 - under the lowering sequence exactly as `YOSYS_FORMAL_SCRIPT` pins it, and
//   under `-s z3` RATHER THAN the worker's pinned `-s bitwuzla`. That is not a substitution made
//   for convenience: `yosys-smtbmc -s bitwuzla` is BROKEN against bitwuzla 0.9.1, because
//   `smtio.py:229` still builds `[solver, '--smt2', '-i']` and 0.9.1 rejects `--smt2` outright
//   (`[error] invalid option '--smt2'`), confirmed in the installed Yosys 0.66. So `FORMAL_PROBE`
//   reports this toolchain NOT INVOCABLE and this whole group SKIPS here, exactly as task 6.2
//   designed - and the assertions are grounded in the z3 measurements rather than in an
//   expectation. They were additionally re-run green end to end under a temporary flag shim for
//   bitwuzla, which was then deleted; the shim is test-environment scaffolding and is not in the
//   repo. `_SOLVER` stays pinned to bitwuzla and the probe rule is unchanged.
//
//     1. The false property. 2 assertions in the SMT2; `Assert failed in formal_property_wrapper`
//        then `Status: FAILED`, refuted at step 0. The dumped VCD at `#0` carries `a = 11111110`
//        (254), `b = 11111111` (255), `cin = 1`, `cout = 1`. 254 + 255 + 1 = 510, which exceeds
//        8 bits, so `cout` must be 1 and the property is false: z3 selected PRECISELY the values
//        the task predicted, which cross-checks the task's own arithmetic rather than merely
//        agreeing with it.
//     2. `ARITH_PLUS_TO_MINUS`: 2 assertions, `Status: FAILED`.
//     3. `INDEX_OFF_BY_ONE`: 2 assertions, `Status: FAILED`.
//     4. `counter_12` at `-t 20`: 2 assertions; presat `Status: PASSED`, base `Status: PASSED`,
//        and `-i` reports `Trying induction in step 18..` then `Temporal induction successful.`
//        then `Status: PASSED`. Its reset is async active-low (`always @(posedge clk or negedge
//        rst_n)`), so the derived contract is `resetActiveLow: true` / `resetKind: 'async'`, the
//        wrapper carries the unclocked `assume property (!$initstate || !rst_n);` - uninverted
//        because the derived polarity is active-LOW, per criterion 14.2 - and NO `if
//        (!$initstate)` gate, per criterion 14.4.
//     5. The clean `adder_8bit` against the exact-sum property: 2 assertions, `Status: PASSED` at
//        depth 1.
//
// THE COUNTEREXAMPLE IS CHECKED FOR TRUTH, NOT FOR PRESENCE
//   Control 1 resolves the refutation's `ArtifactBlobRef` to the VCD's bytes and reads `a`, `b`,
//   `cin`, and `cout` out of step 0, then asserts the ARITHMETIC: the sum overflows 8 bits and
//   `cout` is 1. Asserting the arithmetic rather than the exact model is deliberate and is the
//   STRONGER claim - a solver model is not unique, any `a + b + cin >= 256` is a valid witness, so
//   pinning z3's particular triple would assert which solver ran rather than that the answer is
//   true. The measured triple is recorded above as the anchor it is.
//
// _Requirements: 1.10, 2.1, 3.1, 3.2, 4.1, 4.8, 5.3, 5.4, 5.5, 5.7, 5.8, 11.14, 13.7, 13.9,
// 14.40, 14.41_

import { spawnSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import type { ModuleInterface, Result } from '@app/core';
import {
  FileSystemCorpusCheckout,
  importRtllmCorpus,
  REFERENCE_PREFIX,
  RTLLM_CHECKOUT_PATH,
  RTLLM_PINNED_COMMIT,
  type RtllmCorpus,
} from '@app/eval';
import {
  admitProved,
  assembleFormalPrepassJob,
  CLOCKED_DEPTH_LADDER,
  COMBINATIONAL_DEPTH,
  createWorkspaceRoot,
  DEFAULT_PROPERTY_TIME_BUDGET_MS,
  FREE_INITIAL_STATE_PREDICATE,
  parseFormalPrepassReport,
  PROPERTY_WRAPPER_FILE_NAME,
  PROPERTY_WRAPPER_MODULE_NAME,
  readFormalPrepassReport,
  removeWorkspaceRoot,
  renderPropertyWrapper,
  type ArtifactBlobRef,
  type ClockPolarity,
  type CouldNotVerifyCause,
  type CoverCondition,
  type FormalPrepassDocument,
  type FormalPrepassRejection,
  type FormalPrepassReport,
  type FormalProperty,
  type ProofConditions,
  type PropertyResult,
  type ProvedEvidence,
  type ResetContract,
  type ResourceLimits,
  type SourceFile,
} from '@app/tools';

import { clockedProperty, combinationalProperty, guardedProperty } from './formal-fixtures.js';
import {
  CORPUS_TIMING_STAND_IN,
  FORMAL_CAPS,
  FORMAL_PROBE,
  realFormalAdapter,
  type RealFormalOracle,
} from './real-oracle-harness.js';

// -- Corpus availability probe ----------------------------------------------

/** Whether the pinned checkout is present, and why not when it is absent. */
interface CorpusProbe {
  readonly available: boolean;
  readonly reason: string;
}

/**
 * Probe for the fetched checkout through the same read-only port the importer uses.
 *
 * A missing checkout is the normal state of a fresh clone, not a failure.
 */
async function probeCorpus(): Promise<CorpusProbe> {
  const categories = await new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH).listDirectories([]);
  if (categories.length === 0) {
    return {
      available: false,
      reason: `no RTLLM checkout at the pinned commit ${RTLLM_PINNED_COMMIT}; run \`npm run corpus:fetch\``,
    };
  }
  return { available: true, reason: 'the pinned RTLLM checkout is present' };
}

const CORPUS = await probeCorpus();
const SKIP_REASON = !FORMAL_PROBE.available ? FORMAL_PROBE.reason : CORPUS.reason;
const RUNNABLE = FORMAL_PROBE.available && CORPUS.available;

if (!RUNNABLE) {
  // One explicit note that the spec's most important measurement was NOT reproduced here, so the
  // 0-versus-2 assertion counts recorded elsewhere stand as a prior measurement rather than as one
  // this environment took.
  console.warn(
    `[formal-oracle.integration] The vacuous-chain measurement was NOT exercised: ${SKIP_REASON}. ` +
      'The zero-assertion guard itself is still asserted over generated reports by ' +
      'formal-zero-assertion-guard.property.test.ts, which needs no toolchain.',
  );
}

// -- The designs under test, imported once -----------------------------------

/** One candidate design as the oracle takes it: its source, and its declared interface. */
interface FormalDesign {
  /** The reference source, with its top module already renamed to the interface's name. */
  readonly source: SourceFile;
  readonly moduleInterface: ModuleInterface;
}

/**
 * The pinned corpus import, memoized for this process.
 *
 * LAZY rather than module-level `await`, so a fresh clone with no checkout pays nothing, and
 * MEMOIZED because three groups in this file need designs out of the same import and reading the
 * whole checkout once per group is work with no answer attached to it. The memo holds the PROMISE
 * rather than the value, so two concurrent callers share one read instead of racing two.
 */
let corpusOnce: Promise<RtllmCorpus> | null = null;

/** The pinned corpus, read through the same read-only port `probeCorpus` used. */
function pinnedCorpus(): Promise<RtllmCorpus> {
  corpusOnce ??= importRtllmCorpus(
    new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH),
    CORPUS_TIMING_STAND_IN,
  );
  return corpusOnce;
}

/**
 * One corpus design, or a throw naming what was missing.
 *
 * THROWS rather than returning `null`, and it is called from `beforeAll` for that reason: a
 * missing design is a broken fixture rather than an absent toolchain, so it must FAIL the group
 * loudly instead of joining the skip. Throwing at module load would report "0 tests", which is
 * the one failure shape a reader cannot tell from a skip.
 */
async function formalDesign(problemId: string): Promise<FormalDesign> {
  const corpus = await pinnedCorpus();
  const reference = corpus.references.get(problemId);
  const problem = corpus.problems.find((candidate) => candidate.id === problemId);
  if (reference === undefined || problem === undefined) {
    throw new Error(`the pinned corpus has no reference or problem for ${problemId}`);
  }
  return { source: reference.rtl, moduleInterface: problem.spec.moduleInterface };
}

// -- Fixtures ---------------------------------------------------------------

/** RTLLM's 8-bit ripple-carry adder: the design the silent failure was measured on. */
const ADDER_PROBLEM_ID = 'rtllm/arithmetic/adder_8bit';

/** RTLLM's mod-12 counter: async active-low reset, and this file's clocked positive control. */
const COUNTER_PROBLEM_ID = 'rtllm/control/counter_12';

/**
 * A property PROVABLY FALSE of `adder_8bit`: `a=254, b=255, cin=1` sums to 510, so `cout` is 1.
 *
 * Falseness is what makes the measurement mean anything. A chain that emits no assertions reports
 * `PASSED` for every property, true or false alike, so only a property with a counterexample can
 * tell "proved" from "never checked".
 */
const FALSE_PROPERTY_TEXT = "cout == 1'b0";

/** The generated SMT2's workspace-relative filename, one per chain so neither overwrites the other. */
const CORRECT_SMT2 = 'correct.smt2';
const VACUOUS_SMT2 = 'vacuous.smt2';

/**
 * The lowering passes between `prep` and `write_smt2` in the CORRECT sequence.
 *
 * The same four the worker's `YOSYS_FORMAL_SCRIPT` runs, in the same order. Spelled here because
 * the measurement has to run the chain without the worker (see the header); the worker's copy is
 * pinned on its own side.
 */
const CORRECT_LOWERING: readonly string[] = [
  'memory_map -rom-only -keepdc',
  'async2sync',
  'dffunmap',
  'chformal -lower',
];

/**
 * The VACUOUS sequence: the same chain with `async2sync` and `chformal -lower` REMOVED.
 *
 * Exactly the two passes design.md names, and the other two left in place, so the measurement
 * isolates those two rather than measuring a wholly different chain. Measured separately on Yosys
 * 0.66: the stricter `prep` straight into `write_smt2`, with all four omitted, reported the same
 * 0 / exit 0 / `Status: PASSED`. The 0 is what survived the 0.69 upgrade; the exit 0 and the
 * `PASSED` did not (see the header).
 */
const VACUOUS_LOWERING: readonly string[] = CORRECT_LOWERING.filter(
  (pass) => pass !== 'async2sync' && pass !== 'chformal -lower',
);

/** Timeout for the whole real measurement: two Yosys runs plus two solver runs. */
const MEASUREMENT_TIMEOUT_MS = 120_000;

/** The Proof_Conditions with every condition BUT the count at its admitting value. */
const ADMITTING_EXCEPT_COUNT: Omit<ProofConditions, 'assertionCount'> = {
  presat: 'satisfiable',
  cover: { reached: 'not-applicable' },
  base: 'passed',
  induction: 'successful',
};

// -- Measurement ------------------------------------------------------------

/** What one lowering chain produced: the assertion count, and what the solver then said. */
interface ChainMeasurement {
  readonly yosysExitCode: number | null;
  /** Lines of the generated SMT2 mentioning an assertion - the worker's own `grep -c assert`. */
  readonly assertionCount: number;
  readonly smtBmcExitCode: number | null;
  /** The `Status:` line the solver reported, or `''` where none was printed. */
  readonly status: string;
}

/** Build one Yosys `-p` script for a given lowering and output file. */
function yosysScript(
  sources: readonly string[],
  lowering: readonly string[],
  smt2Out: string,
): string {
  return [
    `read_verilog -sv -formal ${sources.join(' ')}`,
    `prep -top ${PROPERTY_WRAPPER_MODULE_NAME} -flatten`,
    ...lowering,
    `write_smt2 -wires ${smt2Out}`,
  ].join('; ');
}

/** The parsed `Status:` token from a `yosys-smtbmc` transcript, or `''` where none was printed. */
function statusOf(transcript: string): string {
  return /^.*\bStatus:\s*(\S+)/m.exec(transcript)?.[1] ?? '';
}

/** Run one chain end to end in `workspaceRoot` and report what it produced. */
async function measureChain(
  workspaceRoot: string,
  sources: readonly string[],
  lowering: readonly string[],
  smt2Out: string,
): Promise<ChainMeasurement> {
  const yosys = spawnSync('yosys', ['-p', yosysScript(sources, lowering, smt2Out)], {
    cwd: workspaceRoot,
    encoding: 'utf8',
  });
  const smt2 = await readFile(join(workspaceRoot, smt2Out), 'utf8');
  const smtBmc = spawnSync('yosys-smtbmc', ['-s', 'bitwuzla', '-t', '1', smt2Out], {
    cwd: workspaceRoot,
    encoding: 'utf8',
  });
  return {
    yosysExitCode: yosys.status,
    // The worker's own count: lines mentioning an assertion, not a parse of the SMT2 grammar.
    assertionCount: smt2.split('\n').filter((line) => line.includes('assert')).length,
    smtBmcExitCode: smtBmc.status,
    status: statusOf(smtBmc.stdout ?? ''),
  };
}

// -- Tests ------------------------------------------------------------------

describe('formal real-tool capability probe', () => {
  it('documents whether the real formal path was exercised in this environment', () => {
    // Always runs. A probe that reports UNAVAILABLE with a reason is the correct outcome on a host
    // without the toolchain, and a present-but-not-invocable chain reports the same way - that
    // equivalence is the point of Req 11.14.
    expect(typeof FORMAL_PROBE.available).toBe('boolean');
    expect(FORMAL_PROBE.reason.length).toBeGreaterThan(0);
    // An unavailable probe hands back NO interpreter, so a caller cannot half-run the real path.
    if (FORMAL_PROBE.available) {
      expect(FORMAL_PROBE.pythonBin.length).toBeGreaterThan(0);
    } else {
      expect(FORMAL_PROBE.pythonBin).toBe('');
    }
  });
});

describe.skipIf(!RUNNABLE)(
  'the vacuous lowering chain is loud (yosys + yosys-smtbmc, real toolchain; Req 2.1, 3.1, 3.2)',
  () => {
    let workspaceRoot = '';
    let vacuous: ChainMeasurement;
    let correct: ChainMeasurement;

    beforeAll(async () => {
      const design = await formalDesign(ADDER_PROBLEM_ID);
      const property = combinationalProperty('vacuous-chain-probe', FALSE_PROPERTY_TEXT);
      // A NO-RESET Reset_Contract: `adder_8bit` has no reset net, so no assume and no gate is
      // emitted - see the header for why the pre-pass is not in this path.
      const wrapper = renderPropertyWrapper(
        design.moduleInterface,
        property,
        PROPERTY_WRAPPER_MODULE_NAME,
        { derived: false },
      );

      workspaceRoot = await createWorkspaceRoot();
      await writeFile(join(workspaceRoot, design.source.path), design.source.contents, 'utf8');
      await writeFile(join(workspaceRoot, PROPERTY_WRAPPER_FILE_NAME), wrapper, 'utf8');
      const sources = [design.source.path, PROPERTY_WRAPPER_FILE_NAME];

      vacuous = await measureChain(workspaceRoot, sources, VACUOUS_LOWERING, VACUOUS_SMT2);
      correct = await measureChain(workspaceRoot, sources, CORRECT_LOWERING, CORRECT_SMT2);
    }, MEASUREMENT_TIMEOUT_MS);

    afterAll(async () => {
      await removeWorkspaceRoot(workspaceRoot);
    });

    it('emits ZERO assertions for the chain that omits the two load-bearing passes', () => {
      // THE VERSION-INDEPENDENT FACT, and the only one the gate reads: measured 0 on Yosys 0.66
      // and again on 0.69+post. The chain carries NOTHING for the solver to check.
      expect(vacuous.assertionCount).toBe(0);
      // ...and it NEVER refutes the provably false property, which is what makes that 0 a defect
      // rather than a sound encoding that merely counts differently. Asserted as `not FAILED`
      // rather than as a single token because the two measured arms print different ones: 0.66
      // prints `PASSED`, 0.69 prints nothing at all.
      expect(vacuous.status).not.toBe('FAILED');

      // THE MOVED ANCHOR (task 17.2). On 0.66 this chain was SILENT - exit 0, `Status: PASSED`.
      // On the upgraded host `write_smt2` refuses the un-lowered `$check` cell outright, so the
      // trap is loud at the toolchain layer too. See the header for why the 0.66 arm is not
      // tolerated here and why this does not move `FORMAL_ORACLE_VERSION`.
      expect(vacuous.yosysExitCode).toBe(1);
      expect(vacuous.smtBmcExitCode).toBe(1);
      expect(vacuous.status).toBe('');
    });

    it('emits a NON-ZERO assertion count for the correct sequence, and then FAILS', () => {
      // The positive control, and the measured value: 2 lines mention an assertion, and the same
      // property on the same design under the same solver is now refuted. The two chains differ in
      // exactly two passes.
      expect(correct.yosysExitCode).toBe(0);
      expect(correct.assertionCount).toBeGreaterThan(0);
      expect(correct.assertionCount).toBe(2);
      expect(correct.status).toBe('FAILED');
    });

    it('makes the guard LOUD: the measured vacuous count reports `zero-assertions`', () => {
      // The join. Every other condition is held at its ADMITTING value, so the measured assertion
      // count is the only variable between the two calls below - which is what makes the refusal
      // attributable to the count and to nothing else in the fixture.
      expect(
        admitProved({ ...ADMITTING_EXCEPT_COUNT, assertionCount: vacuous.assertionCount }),
      ).toBe('zero-assertions');

      const admitted = admitProved({
        ...ADMITTING_EXCEPT_COUNT,
        assertionCount: correct.assertionCount,
      });
      expect(admitted).not.toBe('zero-assertions');
      // Evidence rather than a cause: the count the correct chain produced is one a proof can rest
      // on, so the refusal above was the count being zero and not a fixture that could never admit.
      expect(typeof admitted).toBe('object');
    });
  },
);

// ============================================================================
// Task 6.3: the falsifiability assertions - three refutations and two proofs
// ============================================================================
//
// Everything below drives the REAL adapter (`realFormalAdapter`) rather than Yosys directly,
// because the claim being made is about the ADAPTER's verdict: the pre-pass, the rendered wrapper,
// the depth ladder, the four checks, the Solver_Cross_Check, and the five-condition gate all have
// to line up for a `refuted` or a `proved` to come back. The direct-Yosys runs above exist only
// because the Lowering_Sequence is a worker CONSTANT and the vacuous chain is therefore
// unreachable through our own seam; no such exemption applies here.

// -- The properties, and the two single-site mutants --------------------------

/**
 * The CORRECT exact-sum property for `adder_8bit`: the concatenation equals the true sum.
 *
 * TRUE of the clean design and FALSE of both mutants, which is what lets one property serve as
 * both the positive control and the two negative ones. `{cout, sum}` is 9 bits wide, so the
 * comparison evaluates `a + b + cin` at 9 bits and the carry is part of the compared value rather
 * than discarded - the property would be trivially satisfiable at 8 bits.
 */
const EXACT_SUM_PROPERTY_TEXT = '{cout, sum} == a + b + cin';

/** `counter_12`'s declared range: the clocked positive control's property. */
const COUNTER_RANGE_PROPERTY_TEXT = "out <= 4'd11";

/** The exact-sum expression inside `full_adder`, and its `ARITH_PLUS_TO_MINUS` form. */
const ADDER_SUM_SITE = 'a + b + cin';
const ADDER_SUM_MUTATED = 'a + b - cin';

/**
 * `FA3`'s carry input, and the `INDEX_OFF_BY_ONE` form of it - which is FA2's own carry input.
 *
 * That collision IS the defect, and it is why the applied-check below counts `FA2_CARRY_IN`: after
 * the edit `c[1]` feeds BOTH FA2 and FA3, so the ripple chain skips `c[2]` and the upper bits carry
 * the wrong value for some operand pairs and the right one for most. A misroute of exactly this
 * shape is what random simulation vectors miss and an exhaustive proof does not.
 */
const FA3_CARRY_IN_SITE = '.cin(c[2])';
const FA2_CARRY_IN = '.cin(c[1])';

/** `adder_8bit`'s sum width: a total above `2 ** WIDTH` is what `cout` reports. */
const ADDER_SUM_WIDTH = 8;

/** The smallest `a + b + cin` that overflows the sum, so `cout` must be 1. */
const ADDER_OVERFLOW_THRESHOLD = 2 ** ADDER_SUM_WIDTH;

/**
 * The assertion count MEASURED in the generated SMT2 for every one of the five cases below.
 *
 * The same 2 the correct chain produced in the vacuous-chain measurement above, which is the point:
 * the number that separates a real proof from the silent one is identical across all five, so none
 * of these verdicts is standing on an empty problem.
 */
const MEASURED_ASSERTION_COUNT = 2;

/**
 * The ladder's first rung: the depth a clocked proof lands at with no escalation. MEASURED 20.
 *
 * Read off `CLOCKED_DEPTH_LADDER` rather than spelled, so the assertion tracks the ladder. The
 * `?? 0` is unreachable - both arms of `proofDepthsFor` are non-empty - and 0 is the fail-safe
 * value anyway: no run that happened reports depth 0, so an empty ladder would FAIL rather than
 * quietly match.
 */
const FIRST_CLOCKED_DEPTH = CLOCKED_DEPTH_LADDER.at(0) ?? 0;

/** Timeout for one real proof: the pre-pass, the lowering, four checks, and the cross-checks. */
const PROOF_TIMEOUT_MS = 120_000;

/** How many times `needle` occurs in `text`. A substring count, so nothing needs escaping. */
function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

// The two mutants are SOURCE TRANSFORMATIONS of the pinned reference rather than checked-in copies,
// so a corpus refresh cannot leave a stale mutant behind asserting something about a design that
// no longer exists.
//
// WHY NOT `generateMutants` FROM `@app/eval`, WHICH OWNS THESE TWO OPERATOR NAMES. That engine's
// contract is "enumerate every site for these operators, round-robin up to a cap", and what is
// needed here is ONE named site. Addressing a single site through it means either a line/column
// literal - which is exactly the stale-fixture failure the transformations exist to avoid - or
// filtering its output by the same substring these two functions already match on. Both are more
// code around the same match. What that engine's coverage does NOT give is the assurance that
// matters here, and it is asserted directly instead: that the edit APPLIED. A transformation that
// silently matched nothing would leave the clean design in place and a negative control would then
// report `refuted`-or-`proved` for a reason unrelated to the mutant - the same class of defect as
// the vacuous chain, where a well-formed answer described something other than what was asked.
//
// `String#replace` with a STRING argument rewrites the FIRST occurrence only, which is what a
// single-site mutation means; each site occurs exactly once in the clean source, asserted below.

/** `ARITH_PLUS_TO_MINUS` at the one exact-sum site in `full_adder`. */
function arithPlusToMinus(source: string): string {
  return source.replace(ADDER_SUM_SITE, ADDER_SUM_MUTATED);
}

/** `INDEX_OFF_BY_ONE` at `FA3`'s carry input, misrouting the ripple chain. */
function indexOffByOne(source: string): string {
  return source.replace(FA3_CARRY_IN_SITE, FA2_CARRY_IN);
}

/**
 * The same design with its SOURCE transformed, and its declared interface untouched.
 *
 * Untouched because neither mutation reaches a port: both edit an internal connection or an
 * internal expression, so the interface the wrapper is rendered from is still the design's own.
 * A mutant reaches the oracle through exactly the channel a candidate design does - there is no
 * second parameter it could arrive through, and none for the reference it was derived from.
 */
function mutated(design: FormalDesign, mutate: (source: string) => string): FormalDesign {
  return {
    source: { path: design.source.path, contents: mutate(design.source.contents) },
    moduleInterface: design.moduleInterface,
  };
}

// -- Reading one PropertyResult ----------------------------------------------

/**
 * The verdict, carrying its cause where it has one, so a failed expectation names WHY.
 *
 * `expect(verdictOf(result)).toBe('refuted')` failing with `could-not-verify: toolchain-unavailable`
 * is a diagnosis; the same assertion on `result.verdict` alone would report only that the two
 * strings differ.
 */
function verdictOf(result: PropertyResult): string {
  return result.verdict === 'could-not-verify'
    ? `could-not-verify: ${result.cause}`
    : result.verdict;
}

/** The Counterexample a refutation carries, or `null` for any other verdict (Req 1.10). */
function counterexampleOf(result: PropertyResult): ArtifactBlobRef | null {
  return result.verdict === 'refuted' ? result.counterexample : null;
}

/** The `ProvedEvidence` a proof carries, or `null` for any other verdict. */
function evidenceOf(result: PropertyResult): ProvedEvidence | null {
  return result.verdict === 'proved' ? result.evidence : null;
}

/** The design's OWN clock name, for a clocked property's clocking event. */
function clockOf(design: FormalDesign): string {
  const clockName = design.moduleInterface.clocking.clockName;
  if (clockName === null) {
    throw new Error(`${design.moduleInterface.moduleName} declares no clock`);
  }
  return clockName;
}

/** Decide one property about one design, under the default Property_Time_Budget. */
function prove(
  real: RealFormalOracle,
  design: FormalDesign,
  property: FormalProperty,
): Promise<PropertyResult> {
  return real.oracle.prove({
    designSource: design.source,
    designInterface: design.moduleInterface,
    property,
    budgetMs: DEFAULT_PROPERTY_TIME_BUDGET_MS,
  });
}

// -- Reading the Counterexample's own contents -------------------------------
//
// The VCD is the evidence a refutation rests on, and the difference between checking that the tool
// ANSWERED and checking that the answer is TRUE is whether anything reads it. The format below is
// `yosys-smtbmc`'s own, measured on this host:
//
//     $var wire 8 n0 a $end          <- inside `$scope module formal_property_wrapper $end`
//     ...
//     #0
//     b11111110 n0
//
// SCOPE TRACKING IS REQUIRED AND NOT DEFENSIVE. The flattened design re-declares `a`, `b`, `cin`,
// and `cout` inside a `$scope` per `full_adder` instance, so a reader that ignored scopes would
// resolve `a` to whichever 1-bit FA input came last. Only declarations at depth 1 - immediately
// inside the wrapper's own scope - are the wrapper's ports and wires.

/** One `$var` declaration: `$var <type> <width> <id> <name> $end`. */
const VCD_VAR_RE = /^\$var\s+\S+\s+\d+\s+(\S+)\s+(\S+)\s+\$end/;

/** One value change for a vector or a scalar: `b<bits> <id>`, the only form written for a wire. */
const VCD_VALUE_RE = /^b([01xzXZ]+)\s+(\S+)$/;

/** The simulation time this file reads: a combinational counterexample is entirely at step 0. */
const VCD_STEP_ZERO = 0;

/**
 * The wrapper-scope signal values at step 0 of one counterexample VCD, by signal name.
 *
 * Total: any text yields a map, an empty one for text that carries no readable step 0. A bit run
 * containing `x` or `z` parses to `NaN`, which fails every comparison below rather than reading as
 * a number - the fail-safe direction, since a don't-care is not a witness.
 */
function stepZeroModel(vcd: string): ReadonlyMap<string, number> {
  const names = new Map<string, string>();
  const values = new Map<string, number>();
  let depth = 0;
  let step: number | null = null;
  for (const raw of vcd.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('$scope')) {
      depth += 1;
      continue;
    }
    if (line.startsWith('$upscope')) {
      depth -= 1;
      continue;
    }
    if (line.startsWith('#')) {
      step = Number(line.slice(1));
      continue;
    }
    const declaration = VCD_VAR_RE.exec(line);
    if (declaration !== null) {
      const [, id, name] = declaration;
      if (depth === 1 && id !== undefined && name !== undefined) {
        names.set(id, name);
      }
      continue;
    }
    if (step !== VCD_STEP_ZERO) {
      continue;
    }
    const change = VCD_VALUE_RE.exec(line);
    const [, bits, id] = change ?? [];
    const name = id === undefined ? undefined : names.get(id);
    if (name !== undefined && bits !== undefined) {
      values.set(name, Number.parseInt(bits, 2));
    }
  }
  return values;
}

/**
 * One signal's value, or `-1` where the trace carried none.
 *
 * `-1` rather than a throw, because it fails every assertion below - it is neither 1 nor part of an
 * overflowing sum - so a trace missing a signal reports a failed expectation naming the signal
 * rather than an exception naming the helper.
 */
function signalValue(model: ReadonlyMap<string, number>, name: string): number {
  return model.get(name) ?? -1;
}

// -- The mutants, asserted without any toolchain -----------------------------

describe.skipIf(!CORPUS.available)(
  'the two adder_8bit mutants are single-site edits that actually APPLIED (Req 4.8)',
  () => {
    let clean = '';

    beforeAll(async () => {
      clean = (await formalDesign(ADDER_PROBLEM_ID)).source.contents;
    });

    it('ARITH_PLUS_TO_MINUS rewrites the one exact-sum site and moves nothing else', () => {
      expect(occurrences(clean, ADDER_SUM_SITE)).toBe(1);
      expect(occurrences(clean, ADDER_SUM_MUTATED)).toBe(0);

      const mutant = arithPlusToMinus(clean);

      expect(occurrences(mutant, ADDER_SUM_SITE)).toBe(0);
      expect(occurrences(mutant, ADDER_SUM_MUTATED)).toBe(1);
      // One operator for another, so the length is unchanged: evidence that the edit is the single
      // site and not a wider rewrite that happens to contain it.
      expect(mutant).toHaveLength(clean.length);
    });

    it('INDEX_OFF_BY_ONE leaves FA3 reading the carry FA2 already reads', () => {
      expect(occurrences(clean, FA3_CARRY_IN_SITE)).toBe(1);
      expect(occurrences(clean, FA2_CARRY_IN)).toBe(1);

      const mutant = indexOffByOne(clean);

      expect(occurrences(mutant, FA3_CARRY_IN_SITE)).toBe(0);
      // The whole defect in one number: `c[1]` now feeds BOTH FA2 and FA3, so `c[2]` drives nothing.
      expect(occurrences(mutant, FA2_CARRY_IN)).toBe(2);
    });
  },
);

// -- The five verdicts, over the real toolchain ------------------------------

describe.skipIf(!RUNNABLE)(
  'the formal gate discriminates over the real toolchain (Req 1.10, 4.1, 4.8, 14.40, 14.41)',
  () => {
    let real: RealFormalOracle;
    let adder: FormalDesign;
    let counter: FormalDesign;

    beforeAll(async () => {
      real = realFormalAdapter(FORMAL_PROBE.pythonBin);
      adder = await formalDesign(ADDER_PROBLEM_ID);
      counter = await formalDesign(COUNTER_PROBLEM_ID);
    });

    it(
      'REFUTES the false property, with a counterexample whose arithmetic is real',
      async () => {
        const result = await prove(
          real,
          adder,
          combinationalProperty('adder-false-cout', FALSE_PROPERTY_TEXT),
        );

        expect(verdictOf(result)).toBe('refuted');
        // Depth 1 is the whole state space of a combinational design, so no rung sits above it -
        // and reaching a rung at all is the evidence for criteria 14.40 and 14.41.
        expect(result.depth).toBe(COMBINATIONAL_DEPTH);

        const trace = counterexampleOf(result);
        expect(trace).not.toBeNull();
        const vcd = trace === null ? null : await real.artifacts.readText(trace);
        expect(vcd).not.toBeNull();

        // The counterexample checked for TRUTH rather than for presence: `cout` is 1 where the
        // property asserted 0, and the operands it is 1 FOR really do overflow the 8-bit sum.
        // MEASURED: z3 selected a = 254, b = 255, cin = 1, so the sum is 510 - precisely the triple
        // the task predicted. The assertion is on the arithmetic because a solver model is not
        // unique: any `a + b + cin >= 256` is a valid witness, so pinning the triple would assert
        // which solver ran rather than that the witness is real.
        const model = stepZeroModel(vcd ?? '');
        expect(signalValue(model, 'cout')).toBe(1);
        expect(
          signalValue(model, 'a') + signalValue(model, 'b') + signalValue(model, 'cin'),
        ).toBeGreaterThanOrEqual(ADDER_OVERFLOW_THRESHOLD);
      },
      PROOF_TIMEOUT_MS,
    );

    it(
      'REFUTES the ARITH_PLUS_TO_MINUS mutant against the correct exact-sum property',
      async () => {
        const result = await prove(
          real,
          mutated(adder, arithPlusToMinus),
          combinationalProperty('adder-exact-sum', EXACT_SUM_PROPERTY_TEXT),
        );

        expect(verdictOf(result)).toBe('refuted');
        expect(counterexampleOf(result)).not.toBeNull();
      },
      PROOF_TIMEOUT_MS,
    );

    it(
      'REFUTES the INDEX_OFF_BY_ONE carry misroute, which random vectors can miss',
      async () => {
        const result = await prove(
          real,
          mutated(adder, indexOffByOne),
          combinationalProperty('adder-exact-sum', EXACT_SUM_PROPERTY_TEXT),
        );

        expect(verdictOf(result)).toBe('refuted');
        expect(counterexampleOf(result)).not.toBeNull();
      },
      PROOF_TIMEOUT_MS,
    );

    it(
      'PROVES the CLEAN adder against the same property the two mutants failed',
      async () => {
        // The control that makes the three refutations mean something. Same design, same chain,
        // same depth as the false-property case: one property is refuted and one is proved, so
        // neither answer can be an artifact of the design or of the fixture. It is also what would
        // notice an `if (!$initstate)` gate wrongly emitted for this class - the gate would suppress
        // the only sample at depth 1 and this would report a VACUOUS pass with the count intact.
        const result = await prove(
          real,
          adder,
          combinationalProperty('adder-exact-sum', EXACT_SUM_PROPERTY_TEXT),
        );

        expect(verdictOf(result)).toBe('proved');
        expect(result.depth).toBe(COMBINATIONAL_DEPTH);
        expect(evidenceOf(result)?.assertionCount).toBe(MEASURED_ASSERTION_COUNT);
      },
      PROOF_TIMEOUT_MS,
    );

    it(
      'PROVES counter_12 stays inside its declared range, by temporal induction',
      async () => {
        const result = await prove(
          real,
          counter,
          clockedProperty('counter-range', clockOf(counter), COUNTER_RANGE_PROPERTY_TEXT),
        );

        expect(verdictOf(result)).toBe('proved');
        // The ladder's FIRST rung, so the proof landed with no escalation.
        expect(result.depth).toBe(FIRST_CLOCKED_DEPTH);

        const evidence = evidenceOf(result);
        expect(evidence).not.toBeNull();
        // `induction: 'successful'` is the one field a bounded pass cannot produce: it requires
        // `Status: PASSED` AND the reported `Temporal induction successful.` line beside it, which
        // is what makes this an UNBOUNDED proof rather than "no counterexample within 20 steps".
        expect(evidence?.induction).toBe('successful');
        // The Base_Check from the design's REAL reset state, which is what makes the induction
        // result mean anything - the wrapper's `assume property (!$initstate || !rst_n);` is what
        // pins that state, uninverted because the DERIVED polarity is active-low (Req 14.2).
        expect(evidence?.base).toBe('passed');
        expect(evidence?.presat).toBe('satisfiable');
        // Unconditional, so no cover was emitted and none was owed (Req 5.10).
        expect(evidence?.cover).toEqual({ reached: 'not-applicable' });
        expect(evidence?.assertionCount).toBe(MEASURED_ASSERTION_COUNT);
      },
      PROOF_TIMEOUT_MS,
    );
  },
);

// ============================================================================
// Task 6.4: the vacuity detector answers in BOTH directions, and contradictory
// assumptions are their own diagnostic
// ============================================================================
//
// The two groups above establish that a chain checking NOTHING is caught, and that the chain
// checking SOMETHING gets true and false properties right. Neither says anything about a property
// that was never EVALUATED, which is a third outcome and the quietest of the three: the assertion
// is present, the count is healthy, the solver answers, and the answer describes a path the design
// can never take. THE PRIOR MEASUREMENT THAT MADE THIS DETECTOR NON-OPTIONAL, carried from the
// spec rather than taken here: `multi_booth_8bit`'s `rdy` is first reachable at step 19, so a
// CORRECT product property reported `PASSED` at every depth at or below 19 without ever being
// evaluated, and only a cover on its own antecedent flagged it.
//
// WHAT THE DETECTOR IS, AND THAT THIS IS THE RESTORED DESIGN RATHER THAN THE FIRST ONE
//   The detector is the BOUNDED COVER plus the DEPTH LADDER, and nothing else. An earlier decision
//   to replace the cover with a NEGATED-ANTECEDENT UNBOUNDED QUERY is WITHDRAWN: that pattern is
//   ENGINE-SPECIFIC and does not work on the engine this repo ships. PRIOR MEASUREMENTS, attributed
//   as such (`chipAgent/_inbox/pattern-unbounded-reachability-replaces-the-bounded-cover-as-the-
//   vacuity-detector.md`): on the unreachable-antecedent case rIC3 reports `UNSAT` and ABC `pdr`
//   and `int` both report `Property proved`, so on an engine with an unbounded reachability route
//   the negated antecedent does answer - while `yosys-smtbmc`'s only unbounded route is `-i`, and
//   `-i` on that negated assert reports `Temporal induction failed!` for the REACHABLE and the
//   UNREACHABLE case ALIKE. A detector keyed on that string would read the vacuous case as
//   non-vacuous, which is the FALSE-PASS direction. So the LADDER is retained for BOTH the vacuity
//   question and the proof, and the vacuity query stays SEPARATE from the property's own proof,
//   because a vacuously true property is simply TRUE and no prover reports vacuity as a defect.
//
// MEASURED ANCHORS AND THEIR PROVENANCE
//   Every number below was measured out of band on this host - Yosys 0.66 (git 7f8fdfd8),
//   z3 4.15.4 - under the lowering sequence exactly as `YOSYS_FORMAL_SCRIPT` pins it, over
//   `counter_12` and wrappers of the shape `renderPropertyWrapper` emits for its importer-accurate
//   interface: `ports: [valid_count, out]` with `clocking: { clk, rst_n, resetActiveLow: true }`,
//   and the DERIVED contract `{ resetName: 'rst_n', resetActiveLow: true, resetKind: 'async',
//   initialStateFree: true }`. That contract yields the unclocked `assume property (!$initstate ||
//   !rst_n);` - uninverted because the derived polarity is active-LOW (Req 14.2) - and NO
//   `if (!$initstate)` gate, because the reset is async (Req 14.4). All three cases carry THREE
//   assertion-mentioning lines in the SMT2, one more than the unconditional shape task 6.3
//   measured at 2, and the extra line is the cover's.
//
//   1. THE VACUOUS PROPERTY. Antecedent `out == 4'd15`, consequent `out == 4'd9`. 15 is
//      unreachable after reset, because the counter runs 0 to 11. The cover invocation (`-c`)
//      reports `Unreached cover statement at formal_property_wrapper: ... ($cover$...)` followed by
//      **`Status: FAILED`** at depths 13, 14, 20 and 40 alike.
//   2. THE REACHABLE COVER, the other direction. Antecedent `out == 4'd11`, consequent
//      `out <= 4'd11`:
//        depth 13 -> `Unreached cover statement` / `Status: FAILED`
//        depth 14 -> `Reached cover statement in step 13` / `Status: PASSED`
//        depth 20 -> `Reached cover statement in step 13` / `Status: PASSED`
//        depth 40 -> `Reached cover statement in step 13` / `Status: PASSED`
//      So the antecedent is first reachable at STEP 13 and reports unreached at every depth below
//      14. 13 is the HONEST depth, measured with the reset assume PRESENT; the free-initial-state
//      model used to report `Reached cover statement in step 1` through a state the design cannot
//      occupy, and that older number appears nowhere in this file.
//   3. CONTRADICTORY ASSUMPTIONS, with the reachable antecedent from case 2 and both
//      `assume property (rst_n);` and `assume property (!rst_n);` in force:
//        presat (`--presat`) -> `Assumptions are unsatisfiable!` / `Status: PREUNSAT`
//        base                -> `Status: PASSED`
//        cover (`-c`)        -> `Unreached cover statement` / `Status: FAILED`
//        induct (`-i`)       -> `Temporal induction successful.` / `Status: PASSED`
//
// WHY CASE 1 FAILS A `Status:`-READING IMPLEMENTATION, WHICH IS THE POINT OF WRITING IT DOWN
//   The cover reports `Status: FAILED` at EVERY rung. An implementation that read that string would
//   classify the vacuous case as an ASSERT FAILURE and hand the student a REFUTATION of their own
//   design for a property that was never evaluated. So the assertion below is the verdict AND the
//   direction: `could-not-verify` / `antecedent-unreached`, and explicitly NOT `refuted`.
//
// WHY CASE 3 IS THE MOST INFORMATIVE OF THE THREE
//   Two separate things follow from that table, and both are asserted rather than only narrated.
//     - THE BASE CASE AND THE INDUCTION CHECK BOTH REPORT `PASSED`, and the induction check prints
//       its temporal-induction line beside it. Under unsatisfiable assumptions every assertion is
//       vacuously true, so this run is BYTE FOR BYTE the shape of a PROOF: four of the five
//       conditions sit at their admitting values and the Presat_Check is the only thing between
//       this wrapper and a `proved` verdict. That is the five-condition gate earning its keep on a
//       real design rather than on a generated report.
//     - THE COVER ALSO REPORTS UNREACHED, because nothing is reachable at all when the assumptions
//       cannot be satisfied. So the presat condition must be weighed BEFORE the cover or this run
//       reports `antecedent-unreached` - a VACUOUS-PROPERTY diagnostic - for what is actually a
//       contradictory-assumption authoring mistake. Those are different mistakes wanting different
//       remedies, which is why the `not antecedent-unreached` assertion is not redundant: the
//       measured cover result is exactly the one that would produce it.
//   `formal-cause-ordering.property.test.ts` (Property 2) already pins that order over GENERATED
//   reports, exhaustively. This is the real-toolchain JOIN rather than a duplicate of it: the
//   conditions fed to the gate here are the ones the REAL chain produced.
//
// HOW THE CONTRADICTION REACHES THE ORACLE, AND WHY THAT CHANNEL IS FAITHFUL
//   The measured wrapper carried the two assumes, and no caller can make ours carry them: the
//   adapter owns every byte of the Property_Wrapper and exposes no seam for an extra assume, which
//   is the same reason task 6.2 had to run Yosys directly to reach the vacuous lowering. Driving
//   the REAL adapter therefore leaves exactly one channel - the candidate DESIGN - so the two
//   assumes are injected into `counter_12` behind an `` `ifdef FORMAL `` fence and flattened into
//   the wrapper by `prep -top ... -flatten`, which is where the measured wrapper's own assumes end
//   up too.
//
//   THE FENCE IS LOAD-BEARING AND NOT TIDINESS. The Reset_Contract_Prepass reads the design with
//   `read_verilog -sv` and WITHOUT `-formal` (`YOSYS_PREPASS_SCRIPT`), deliberately, because SVA
//   would add `$check` cells `write_smt2` cannot translate and the pre-pass would lose its
//   initial-state predicate. MEASURED HERE, this session, on the same Yosys 0.66: `-formal` DOES
//   define `FORMAL` - the fenced block yields 2 `$check` cells under `read_verilog -sv -formal` and
//   0 under `read_verilog -sv` - so the pre-pass derives the SAME contract it derives for the clean
//   design and only the proof sees the contradiction. ALSO MEASURED HERE: the injected design
//   reproduces the dispatched case-3 table exactly - 3 assertion lines, `PREUNSAT`, `PASSED`,
//   `Unreached` / `FAILED`, `Temporal induction successful.` / `PASSED` - so the channel is a
//   faithful stand-in for the wrapper-carried form and not merely a plausible one.
//
// WHAT THE SHIMMED RUN MEASURED, since an only-ever-skipping test is indistinguishable from a wrong
// one. All three cases below ran green end to end against the real toolchain under a temporary
// bitwuzla flag shim, which was then deleted and is not in the repo: bitwuzla as `_SOLVER` and z3 as
// the Solver_Cross_Check AGREE on all three, every condition record matching the `-s z3` anchors
// above field for field, with zero cross-check disagreements. The vacuous case cost 24.3s against
// 0.6s and 0.8s for the other two, and that 30x is the escalation being real: it is three rungs at
// 20, 40 and 80 with four checks each, where the other two land on the first rung. It sits inside
// both the 150s Property_Time_Budget and this file's 120s per-test timeout with room, but it is the
// one case here whose cost is a depth ladder rather than a single proof.
//
// TWO FACTS MEASURED HERE THAT THE DISPATCHED TABLES DID NOT NAME, both recorded because they are
// what the assertions below actually rest on:
//   - On case 1 the INDUCTION check reports `Temporal induction failed!` / `Status: FAILED` at
//     depths 20 AND 80, over a PASSING base case. That pair is the `induction-engine-incomplete`
//     shape, and the ONLY reason the reported cause is `antecedent-unreached` instead is that the
//     cover sits AHEAD of the base case in the fixed order. The recorded `induction: 'inconclusive'`
//     beside an `antecedent-unreached` cause is that ordering doing its job, so it is asserted.
//   - On case 1 the base case reports `PASSED` at both rungs, so nothing on this path could have
//     sourced a refutation anyway; the `not refuted` assertion is about what a DIFFERENT
//     implementation would do with the cover's `FAILED`, not about this run having a counterexample.
//
// _Requirements: 5.3, 5.4, 5.5, 5.7, 5.8_

/** The antecedent `counter_12` can never satisfy after reset: the counter runs 0 to 11. */
const UNREACHABLE_ANTECEDENT_TEXT = "out == 4'd15";

/**
 * The consequent guarded by that antecedent. FALSE of the design wherever `out` is 15.
 *
 * Deliberately not a tautology: were the consequent trivially true, a `proved` verdict would be
 * indistinguishable from the vacuity finding, and the whole question here is whether a property
 * that was never EVALUATED is told apart from one that was.
 */
const VACUOUS_CONSEQUENT_TEXT = "out == 4'd9";

/** The antecedent `counter_12` REACHES, measured at step 13 once the reset assume is present. */
const REACHABLE_ANTECEDENT_TEXT = "out == 4'd11";

/** The step the reachable cover is MEASURED to be reached at. Not the free-state model's 1. */
const MEASURED_COVER_STEP = 13;

/**
 * The assertion count MEASURED in the SMT2 for all three cases below.
 *
 * One more than task 6.3's `MEASURED_ASSERTION_COUNT` of 2, and the extra line is the COVER's:
 * these are the guarded shape, which emits `cover(<antecedent>)` beside the assertion. The number
 * is asserted for the same reason it is asserted there - it is the one signal separating a real
 * verdict from the silent vacuous chain - so none of these three findings rests on an empty
 * problem.
 */
const COVERED_ASSERTION_COUNT = 3;

/**
 * The ladder's LAST rung: the depth an unreached antecedent is finally reported at. MEASURED 80.
 *
 * Read off `CLOCKED_DEPTH_LADDER` for the reason `FIRST_CLOCKED_DEPTH` is, and with the same
 * unreachable `?? 0` fail-safe: no run that happened reports depth 0, so an empty ladder FAILS the
 * assertion rather than quietly matching it.
 */
const LAST_CLOCKED_DEPTH = CLOCKED_DEPTH_LADDER.at(-1) ?? 0;

// -- The contradictory-assumption injection ----------------------------------

/** `counter_12`'s reset net, checked against the importer's own `clocking` below. */
const RESET_NET_NAME = 'rst_n';

/** The compiler directives fencing the injection into the `-formal` read alone. */
const FORMAL_FENCE_OPEN = '`ifdef FORMAL';
const FORMAL_FENCE_CLOSE = '`endif';

/** The two assumes that cannot both hold: the reset asserted, and the reset released. */
const RESET_ASSERTED_ASSUME = `  assume property (${RESET_NET_NAME});`;
const RESET_RELEASED_ASSUME = `  assume property (!${RESET_NET_NAME});`;

/** The design's own module terminator, which the injection is placed immediately before. */
const MODULE_TERMINATOR = 'endmodule';

/**
 * The same design with two contradictory assumes fenced into its `-formal` read.
 *
 * Placed before the LAST `endmodule` so the assumes land inside the design's own module and
 * constrain its `rst_n` net rather than sitting beside it at file scope. A source declaring no
 * module is returned UNCHANGED, which is total and fail-safe: the applied-check group below asserts
 * the edit landed, so a no-op would fail loudly there rather than run a clean design under a test
 * that claims it carries a contradiction.
 */
function contradictoryAssumptions(source: string): string {
  const terminator = source.lastIndexOf(MODULE_TERMINATOR);
  if (terminator === -1) {
    return source;
  }
  const fenced = [
    FORMAL_FENCE_OPEN,
    RESET_ASSERTED_ASSUME,
    RESET_RELEASED_ASSUME,
    FORMAL_FENCE_CLOSE,
    '',
  ].join('\n');
  return source.slice(0, terminator) + fenced + source.slice(terminator);
}

// -- Reading the conditions off either verdict shape --------------------------

/**
 * The five conditions as recorded, or a NEVER-ADMITTING record for a `proved` result.
 *
 * A `proved` result carries the stronger `ProvedEvidence` instead of a `ProofConditions`, so the
 * fallback exists to keep this total. It is zeroed rather than filled with admitting values on
 * purpose: a `proved` arriving where a refusal was asserted then FAILS the comparison below instead
 * of reading as one, which is the fail-safe direction for a helper feeding a trust decision.
 */
function conditionsOf(result: PropertyResult): ProofConditions {
  return result.verdict === 'proved'
    ? {
        assertionCount: 0,
        presat: 'not-run',
        cover: { reached: false },
        base: 'not-run',
        induction: 'not-run',
      }
    : result.conditions;
}

/**
 * What the Cover_Check established, whatever the verdict was.
 *
 * Both shapes carry it - `ProvedEvidence.cover` for a proof and `ProofConditions.cover` for
 * everything else - and the reachability question is the same question either way, so reading it
 * through one helper is what lets the reachable case assert the measured STEP without first
 * asserting which verdict it arrived as.
 */
function coverOf(result: PropertyResult): CoverCondition {
  return evidenceOf(result)?.cover ?? conditionsOf(result).cover;
}

// -- The injection, asserted without any toolchain ---------------------------

describe.skipIf(!CORPUS.available)(
  'the contradictory-assumption injection is FENCED and actually APPLIED (Req 5.7)',
  () => {
    let counter: FormalDesign;

    beforeAll(async () => {
      counter = await formalDesign(COUNTER_PROBLEM_ID);
    });

    it('fences both assumes into the -formal read and moves nothing else', () => {
      const clean = counter.source.contents;
      // The two assumes name the reset the IMPORTER read off the design, so the literal above is a
      // checked fact rather than a hope: a corpus refresh that renamed the net fails here.
      expect(counter.moduleInterface.clocking.resetName).toBe(RESET_NET_NAME);
      expect(occurrences(clean, 'assume')).toBe(0);
      expect(occurrences(clean, MODULE_TERMINATOR)).toBe(1);

      const injected = contradictoryAssumptions(clean);

      // Everything ahead of the design's own terminator, and the terminator itself, survive
      // untouched - so the design under test is still `counter_12` plus two assumes, and not a
      // design this test rewrote.
      const terminator = clean.lastIndexOf(MODULE_TERMINATOR);
      expect(injected.startsWith(clean.slice(0, terminator))).toBe(true);
      expect(injected.endsWith(clean.slice(terminator))).toBe(true);
      expect(occurrences(injected, RESET_ASSERTED_ASSUME)).toBe(1);
      expect(occurrences(injected, RESET_RELEASED_ASSUME)).toBe(1);
      // The fence, which is what keeps the PRE-PASS reading the clean design: it reads without
      // `-formal`, and MEASURED on this Yosys, `-formal` is what defines `FORMAL`.
      expect(injected.indexOf(FORMAL_FENCE_OPEN)).toBeLessThan(
        injected.indexOf(RESET_ASSERTED_ASSUME),
      );
      expect(injected.indexOf(RESET_RELEASED_ASSUME)).toBeLessThan(
        injected.indexOf(FORMAL_FENCE_CLOSE),
      );
    });
  },
);

// -- The three verdicts, over the real toolchain -----------------------------

describe.skipIf(!RUNNABLE)(
  'the vacuity detector answers in BOTH directions, and contradictory assumptions are their own diagnostic (Req 5.3, 5.4, 5.5, 5.7, 5.8)',
  () => {
    let real: RealFormalOracle;
    let counter: FormalDesign;

    beforeAll(async () => {
      real = realFormalAdapter(FORMAL_PROBE.pythonBin);
      counter = await formalDesign(COUNTER_PROBLEM_ID);
    });

    it(
      "DETECTS the vacuous property, reporting it after the ladder's TOP rung and never as a pass",
      async () => {
        const result = await prove(
          real,
          counter,
          guardedProperty(
            'counter-vacuous',
            clockOf(counter),
            UNREACHABLE_ANTECEDENT_TEXT,
            VACUOUS_CONSEQUENT_TEXT,
          ),
        );

        expect(verdictOf(result)).toBe('could-not-verify: antecedent-unreached');
        // THE DISCRIMINATING DIRECTION, restated deliberately rather than left implied by the
        // verdict above: the cover reports `Status: FAILED` at every rung, so an implementation
        // that read that string would land HERE, refuting a design over a property it never
        // evaluated. This is the assertion such an implementation fails.
        expect(result.verdict).not.toBe('refuted');
        // The unreached answer holds at 20, 40 and 80 alike, so the ladder is climbed to its end
        // and the finding is reported at the TOP rung rather than at the first (Req 4.7).
        expect(result.depth).toBe(LAST_CLOCKED_DEPTH);

        // The whole record, because what it says is the point. The count is healthy, so this is not
        // the silent chain; the assumptions are satisfiable, so it is not case 3; the base case
        // PASSED, so nothing here could have sourced a refutation. And `induction: 'inconclusive'`
        // is the measured `Temporal induction failed!` over that passing base case - the
        // `induction-engine-incomplete` shape - which reports as `antecedent-unreached` for exactly
        // one reason: the cover is weighed AHEAD of the base case and the induction step.
        expect(conditionsOf(result)).toEqual({
          assertionCount: COVERED_ASSERTION_COUNT,
          presat: 'satisfiable',
          cover: { reached: false },
          base: 'passed',
          induction: 'inconclusive',
        });
      },
      PROOF_TIMEOUT_MS,
    );

    it(
      'reports the REACHABLE cover reached at the measured step, so the detector is not merely pessimistic',
      async () => {
        const result = await prove(
          real,
          counter,
          guardedProperty(
            'counter-reachable',
            clockOf(counter),
            REACHABLE_ANTECEDENT_TEXT,
            COUNTER_RANGE_PROPERTY_TEXT,
          ),
        );

        // The other direction of the same detector, and the reason the case above means anything: a
        // detector that reported every antecedent unreached would pass that assertion and refuse
        // every real property. MEASURED step 13, with the reset assume present.
        expect(coverOf(result)).toEqual({ reached: true, step: MEASURED_COVER_STEP });
        // The ladder's FIRST rung of 20 already clears the step-14 threshold, so the reach is found
        // with no escalation - which is also what makes the top-rung depth above attributable to the
        // escalation rather than to the ladder being climbed regardless.
        expect(result.depth).toBe(FIRST_CLOCKED_DEPTH);
        // `proved` is the MEASURED verdict, and it is strictly stronger than the task's own claim
        // that this is not `antecedent-unreached`, so the weaker form is not restated.
        expect(verdictOf(result)).toBe('proved');
        expect(evidenceOf(result)?.assertionCount).toBe(COVERED_ASSERTION_COUNT);
      },
      PROOF_TIMEOUT_MS,
    );

    it(
      'reports CONTRADICTORY ASSUMPTIONS as their own cause, over a run shaped exactly like a proof',
      async () => {
        const result = await prove(
          real,
          mutated(counter, contradictoryAssumptions),
          guardedProperty(
            'counter-contradictory',
            clockOf(counter),
            REACHABLE_ANTECEDENT_TEXT,
            COUNTER_RANGE_PROPERTY_TEXT,
          ),
        );

        expect(verdictOf(result)).toBe('could-not-verify: contradictory-assumptions');
        // Under unsatisfiable assumptions every assertion is vacuously true, so the run is the
        // shape of a proof and this is the assertion that says so.
        expect(result.verdict).not.toBe('proved');
        // No escalation: `contradictory-assumptions` is not the escalating cause, so the refusal
        // lands on the first rung instead of spending two more on a wrapper nothing can satisfy.
        expect(result.depth).toBe(FIRST_CLOCKED_DEPTH);

        const measured = conditionsOf(result);
        // FOUR of the five conditions sit at their admitting values - the count is healthy, the
        // cover is the only unsatisfied one, the base case PASSED and the induction check reported
        // its temporal-induction success - so the Presat_Check is the single thing standing between
        // this wrapper and a `proved` verdict.
        expect(measured).toEqual({
          assertionCount: COVERED_ASSERTION_COUNT,
          presat: 'preunsat',
          cover: { reached: false },
          base: 'passed',
          induction: 'successful',
        });

        // THE JOIN, and what makes the assertion below it non-redundant. The cover ALSO reports
        // unreached here, because nothing is reachable at all when the assumptions cannot hold: flip
        // the ONE condition that refused and the SAME measured record reports the VACUITY
        // diagnostic. So the fixed order is the only thing telling the two authoring mistakes apart,
        // and the cause above is not merely "some refusal".
        expect(admitProved({ ...measured, presat: 'satisfiable' })).toBe('antecedent-unreached');
        expect(verdictOf(result)).not.toBe('could-not-verify: antecedent-unreached');
      },
      PROOF_TIMEOUT_MS,
    );
  },
);

// ============================================================================
// Task 6.5: the RENDERED DIALECT elaborates, and the QUARANTINE OF 2 is loud
// ============================================================================
//
// Two claims share this section because they are one question asked in opposite directions: does the
// Yosys frontend accept what reaches it. The first is about OUR renderer, and every shape
// `renderPropertyWrapper` can emit has to survive `read_verilog -sv -formal` and the
// Lowering_Sequence. The second is about the TWO corpus references Yosys REFUSES, and what our gate
// is obliged to say about a design it could not elaborate.
//
// ---------------------------------------------------------------------------------------------
// WHY THE DIALECT ASSERTION IS DELIBERATELY WEAKER THAN A PROOF, which is the whole reason this
// group is not a fourth copy of the three above it
// ---------------------------------------------------------------------------------------------
//   The strongest signal available for "the wrapper elaborated" is that the run REACHED A VERDICT. A
//   wrapper outside the accepted dialect fails in `read_verilog`, the failure is attributed to the
//   wrapper file rather than to the design, and the result is `property-build-failed` with no verdict
//   at any depth and an assertion count of zero. Tasks 6.3, 6.4 and 6.9 all reach verdicts, so every
//   one of them demonstrates that INCIDENTALLY - and that is precisely why this group asserts the
//   NON-VERDICT facts instead of re-proving anything. What it pins, for each renderable shape in one
//   place, is that `property-build-failed` was NOT reported and that the measured assertion count IS
//   present. A group that asserted `proved` would fail for a dozen reasons having nothing to do with
//   the renderer, and would then be a duplicate of the three above rather than a named test of the
//   dialect.
//
//   THE COUNT IS HALF THE CLAIM AND NOT DECORATION. "It elaborated" and "it elaborated WITH OUR
//   ASSERTION IN IT" are different facts, and the vacuous-chain measurement at the top of this file
//   is the case that separates them: a chain can exit 0, produce a well-formed SMT2, and carry ZERO
//   assertions. A renderer that emitted a syntactically valid wrapper with the assertion dropped
//   would pass a verdict-only check and fail here.
//
//   THE MEASURED SHAPES, and the two numbers they come down to. Every count was measured under the
//   lowering sequence exactly as `YOSYS_FORMAL_SCRIPT` pins it, on Yosys 0.66 with z3 4.15.4 in place
//   of the worker's pinned bitwuzla, for the reason the task 6.3 header records.
//
//     | kind                    | design       | assertion-mentioning lines | extra line is |
//     |-------------------------|--------------|----------------------------|---------------|
//     | combinational           | `adder_8bit` | 2                          | -             |
//     | clocked, unconditional  | `counter_12` | 2                          | -             |
//     | clocked, guarded        | `counter_12` | 3                          | the cover's   |
//
//   Both numbers are ALREADY NAMED in this file - `MEASURED_ASSERTION_COUNT` from task 6.3 and
//   `COVERED_ASSERTION_COUNT` from task 6.4 - and they are reused rather than re-declared, so a
//   change to either reads as the disagreement it is instead of as agreement with a third constant.
//   The combinational wrapper is rendered against a REFUSED Reset_Contract because `adder_8bit`
//   carries no reset net, so it has neither a reset assume nor an `if (!$initstate)` gate and 2 is
//   the bare assert-plus-lowering count (Req 14.41).
//
// ---------------------------------------------------------------------------------------------
// THE QUARANTINE HALF WAS UNREACHABLE UNTIL MINUTES BEFORE IT WAS WRITTEN, AND A READER WHO MISSES
// THAT WILL MISREAD IT
// ---------------------------------------------------------------------------------------------
//   Both `frontend-rejected` assertions below are reachable ONLY because criteria 8.10 to 8.13
//   landed. Criterion 14.11 requires the Reset_Contract_Prepass to complete BEFORE the
//   Property_Wrapper is rendered, so the pre-pass reaches `read_verilog` and `prep` FIRST and a
//   design Yosys refuses fails there, writing no report; criterion 14.26 then mapped every way a
//   pre-pass can fail to `toolchain-unavailable`. So both references reported OUR INSTRUMENT as
//   broken for a design Yosys correctly rejected, and the spec's own framing of this class - a NAMED
//   quarantine of 2 rather than a frontend we cannot trust - read instead as "2 designs report that
//   our tooling is unavailable", which is the opposite of naming.
//
//   THE ORDERING IS MECHANICALLY UNAVOIDABLE rather than incidental, which is why the fix had to be
//   an attribution rule and not a reordering: the `synchronizer` error is raised in `proc`, `proc`
//   runs inside `prep`, and BOTH the pre-pass and the Lowering_Sequence run `prep`.
//
//   THIS GROUP IS THE REAL-TOOLCHAIN JOIN AND NOT A SECOND COPY OF THE UNIT TESTS.
//   `app/tools/formal/adapter.test.ts` already pins the branch over SCRIPTED `SandboxResult`s, which
//   is where the exit-code-and-`ERROR:`-marker rule belongs. What is added here is that the ACTUAL
//   Yosys output from the ACTUAL references actually takes it.
//
// ---------------------------------------------------------------------------------------------
// MEASURED ANCHORS FOR THE TWO REFERENCES, taken through the real adapter on this host
// ---------------------------------------------------------------------------------------------
//   Yosys 0.66. Both cases were measured END TO END through `realFormalAdapter`, with NO solver
//   shim, because they fail in Yosys before any solver runs:
//
//     | design         | verdict            | cause               | surfaced diagnostic                                          | ms  |
//     |----------------|--------------------|---------------------|--------------------------------------------------------------|-----|
//     | `float_multi`  | could-not-verify   | `frontend-rejected` | `dut_reference.v:17: ERROR: Found non-synthesizable event list!` | 181 |
//     | `synchronizer` | could-not-verify   | `frontend-rejected` | `ERROR: Multiple edge sensitive events found for this signal!`   | 120 |
//
//   Both record `depth: 0` and the all-`not-run` conditions, which is Req 1.18's "no Proof_Condition
//   was evaluated" written down as a value: a pre-pass refusal ran no invocation at any depth.
//
//   ONE THING THE SPEC'S OWN TABLE COULD NOT HAVE SHOWN, measured here and worth recording. The
//   spec's out-of-band probe wrote the design as `design.v` and its table says `design.v:17:`; the
//   adapter writes the candidate design under ITS OWN path, which for a corpus reference is
//   `dut_reference.v`, so the filename the student would actually see is that one. The assertion
//   below therefore reads the filename OUT OF the design rather than spelling it, and asserts the
//   DIAGNOSTIC TEXT rather than the whole line - which is the claim that is about the frontend rather
//   than about our own workspace layout.
//
//   `float_multi`'s LINE NUMBER IS CHECKED AGAINST THE SOURCE, so the diagnostic is shown to name the
//   DEFECT and not merely a file. Line 17 of the imported reference is
//   `always @(posedge clk or rst) begin`, an event list mixing an EDGE with a LEVEL, which is exactly
//   what Yosys refuses; the same source carries seven `always @(counter)` blocks beside it.
//
// ---------------------------------------------------------------------------------------------
// `synchronizer` IS THE LOAD-BEARING ONE OF THE PAIR
// ---------------------------------------------------------------------------------------------
//   Its diagnostic carries NO FILENAME AT ALL, so it is the case that fails if the attribution is
//   ever rewritten to read the diagnostic's filename rather than the pre-pass job's contents
//   (criterion 8.13). Reusing `interpret.ts`'s `attributeLoweringFailure` here looks like a one-line
//   fix and is MEASURED to fail on exactly this half of the pair: `float_multi`'s diagnostic names
//   `dut_reference.v` and would attribute correctly, while `synchronizer`'s names nothing and would
//   fall through to `property-build-failed`, blaming a Property_Wrapper that DOES NOT EXIST YET,
//   which is a worse label than the one being replaced. Only ONE of the two measured cases reveals
//   that, so a probe over `float_multi` alone would have shipped it. The absence of a filename is
//   therefore ASSERTED rather than narrated, and both wrong labels are named in their own
//   expectations, because each would be produced by a different plausible implementation:
//   `property-build-failed` by the filename rule, and `toolchain-unavailable` by the behaviour that
//   shipped before criteria 8.10 to 8.13.
//
//   THE ROOT CAUSE IS A DEFECT IN THE REFERENCE ITSELF, confirmed in its source rather than inferred:
//   line 19 is `always@(posedge clk_a or negedge arstn)` while line 21 branches on `if(!brstn)`, a
//   DIFFERENT net. The block resets on one signal's edge while testing another, so Yosys demands
//   `brstn` be edge-sensitive too and can map the block to no flop primitive. A stricter frontend
//   therefore found a real defect in a benchmark's own human-verified reference, which makes this an
//   independent check on our GROUND TRUTH and not only a cost. That shape is asserted against the
//   imported source below, so a corpus refresh cannot silently invalidate the recorded root cause:
//   two blocks are sensitive to `negedge arstn` and EXACTLY ONE of them branches on `!brstn`.
//
// ---------------------------------------------------------------------------------------------
// THE CORPUS-WIDE CLAIM IS A RECORDED MEASUREMENT AND NOT AN ASSERTION, DELIBERATELY
// ---------------------------------------------------------------------------------------------
//   RE-MEASURED on Yosys 0.66 and holding exactly: under `read_verilog -sv -formal;
//   prep -auto-top -flatten`, 48 OF THE 50 references elaborate unmodified with no silent wrong
//   answers, and the only two failures are these two carrying these two diagnostics. That is what
//   makes this a NAMED QUARANTINE OF 2 rather than a frontend we cannot trust. It stays in this
//   comment because sweeping all 50 designs inside a test is a minutes-long run whose answer is a
//   corpus fact rather than a behaviour of ours, and a suite that slow gets skipped by the people who
//   need it.
//
// ---------------------------------------------------------------------------------------------
// AN OBSERVATION ABOUT THE GATE ON THIS GROUP, RECORDED RATHER THAN ACTED ON
// ---------------------------------------------------------------------------------------------
//   The two quarantine cases fail in YOSYS, before any solver runs, so they need no working
//   `yosys-smtbmc -s bitwuzla` to reach their verdict - measured, with no shim, in the table above.
//   They are nonetheless gated on `FORMAL_PROBE` like everything else in this file, so on a host where
//   the composed solver invocation is not invocable they SKIP for a reason that cannot affect them.
//   That is the cost of ONE skip mechanism, and the probe's composed-invocation rule is a settled
//   decision: a second, narrower gate would be a second place where "can this run" is decided.
//
// ---------------------------------------------------------------------------------------------
// THE INVERSE CASE: A BARE INTERNAL NAME MUST BE A BUILD FAILURE AND MUST NEVER BE A PROOF
// (task 18.3; Req 6.18, 6.25, 6.26, 8.8, 8.9)
// ---------------------------------------------------------------------------------------------
//   Every case above asserts that a wrapper OUR RENDERER emits does NOT report
//   `property-build-failed`. This one asserts the other direction of the same rule, and it is the
//   direction a student's verdict depends on: a property naming an identifier the Property_Wrapper
//   does not declare must FAIL TO BUILD, loudly, and must never be reported as a proof.
//
//   WHAT THE PROPERTY NAMES, AND WHY IT IS NOT A TYPO. `c` is `adder_8bit`'s OWN internal carry
//   wire - `wire [8:0] c`, the ripple chain between `FA0` and `FA7`. It is a name a property author
//   reading the design would reach for naturally, and it is NOT a wrapper signal: the wrapper
//   declares the design's PORTS (`a`, `b`, `cin` as inputs; `sum`, `cout` as wires) and nothing
//   else. So this is the UNDOTTED route to the false proof, reached without a `.` and therefore
//   without anything for the Property_Validator's operator set to refuse - `validateExpression`
//   admits any non-keyword identifier, and must, because a port name can be anything.
//
//   `c < 9'd2` IS THE SHAPE THAT MAKES THE PRE-FIX BEHAVIOUR A PROOF RATHER THAN A REFUTATION, and
//   the choice is load-bearing. Yosys implicitly declares an undeclared identifier as a fresh
//   1-BIT net, so `c < 9'd2` is TRIVIALLY TRUE of that net for either of its two values, while it
//   is PROVABLY FALSE of the design's real 9-bit `c`: at `a=255, b=255` every carry is 1 and `c` is
//   `9'd255`. A property like `c == 1'b0` would instead be REFUTED pre-fix, because an unconstrained
//   1-bit net can take the value 1 - which would look like the oracle working and would leave the
//   false-proof route unmeasured. The measured sibling on a counter is the same shape for the same
//   reason: `cnt < 4'd2` over a counter that reaches 9.
//
//   THE EXPECTED DIRECTION, WRITTEN DOWN BEFORE THE RUN, because integration test 9 taught that a
//   case whose direction is recorded after the fact cannot tell a fix from a false green:
//
//     PRE-FIX (the renderer with no `` `default_nettype none ``), MEASURED on the counter sibling:
//       `Warning: Identifier '\cnt' is implicitly declared`, Yosys exits 0, 3 assertions reach the
//       SMT2, base `Status: PASSED` at step 19, `Temporal induction successful`. The zero-assertion
//       guard, the base case, and induction ALL pass, so the verdict is `proved` - a false property
//       labelled Verified with no error anywhere. A RUN OF THIS CASE THAT PASSES BEFORE THE FIX IS
//       THEREFORE THE FALSE PROOF ITSELF AND NOT A GREEN TEST.
//
//     POST-FIX (task 18.1 made `` `default_nettype none `` the wrapper's first line, with no
//     trailing reset): the IDENTICAL wrapper fails in the Yosys frontend -
//       `ERROR: Identifier '\c' is implicitly declared and 'default_nettype is set to none.`,
//     exit 1, raised in the WRAPPER file. The attribution rule (Req 8.8, 8.9) therefore sends it to
//     `property-build-failed` and NOT to `frontend-rejected`, which is the half that matters for
//     blame: the candidate design elaborated fine and must not be accused of our instrument's
//     property text. So the expectation is `could-not-verify` / `property-build-failed`, with no
//     verdict at any depth and no Proof_Condition evaluated.
//
//   THE ASSERTION IS TWO-SIDED ON PURPOSE. `property-build-failed` alone would be satisfied by an
//   oracle that reported it for everything, and `not proved` alone would be satisfied by a
//   refutation - which is the WRONG answer here too, because a property that did not compile
//   refutes nothing about the design (Req 6.12). Both halves are stated, and `proved` is named in
//   its own expectation because it is the one outcome that reaches a student as a lie.
//
//   OBSERVED, AGAINST THE DIRECTION ABOVE. `could-not-verify` / `property-build-failed`, as
//   written - with the diagnostic naming the implicit declaration, every Proof_Condition `not-run`,
//   and the assertion count 0. ONE detail of the direction was wrong and is corrected at its
//   assertion rather than quietly: the depth is 1, not the quarantine's 0, because this failure is
//   raised inside the Lowering_Sequence of the first ladder rung rather than ahead of every
//   invocation.
//
//   AND ONE RUN OUT OF EIGHT REPORTED `proved`, WHICH IS WORTH MORE THAN THE SEVEN GREENS. It was
//   traced, not shrugged at: `@app/tools` resolves through its package `exports` to BUILT output,
//   and `app/tools/dist/verilog/property.js` was rewritten mid-run by a build landing in another
//   session. So that run exercised the PRE-18.1 renderer - no `` `default_nettype none ``, `c`
//   implicitly declared as a fresh 1-bit net - and reported exactly the false proof recorded above.
//   The case is deterministic against a settled build: 10 of 10 repeats of this same `prove` in one
//   process, and 7 of 7 whole-file runs. The lesson is about the harness and not about this
//   assertion - a test in this file measures the DIST, so a build in flight can make a real failure
//   look like a flake and a real fix look absent.
//
// _Requirements: 6.1, 6.2, 6.18, 6.25, 8.1, 8.2, 8.3, 8.8, 8.9, 8.10, 8.11, 8.12, 8.13_

/** RTLLM's IEEE-754 multiplier: the frontend reject, from an event list mixing an edge and a level. */
const FLOAT_MULTI_PROBLEM_ID = 'rtllm/arithmetic/float_multi';

/** RTLLM's two-clock synchronizer: the elaboration reject, from a defect in the reference itself. */
const SYNCHRONIZER_PROBLEM_ID = 'rtllm/miscellaneous/synchronizer';

/** The MEASURED Yosys diagnostic for `float_multi`, without the filename its line prefix carries. */
const FLOAT_MULTI_DIAGNOSTIC = 'ERROR: Found non-synthesizable event list!';

/** The MEASURED Yosys diagnostic for `synchronizer`. It names NO FILE, which is the point of it. */
const SYNCHRONIZER_DIAGNOSTIC = 'ERROR: Multiple edge sensitive events found for this signal!';

/**
 * The event list Yosys refuses in `float_multi`: `posedge clk` mixed with the LEVEL `rst`.
 *
 * Checked against the LINE the diagnostic names, so the recorded root cause is a fact about the
 * imported source rather than a claim about upstream's line numbering.
 */
const FLOAT_MULTI_EVENT_LIST = 'always @(posedge clk or rst)';

/** `synchronizer`'s reset EDGE, and the reset BRANCH of a different net. The mismatch is the defect. */
const SYNCHRONIZER_RESET_EDGE = 'negedge arstn';
const SYNCHRONIZER_RESET_BRANCH = '!brstn';

/** How many of `synchronizer`'s blocks are sensitive to `negedge arstn`. MEASURED 2, one defective. */
const SYNCHRONIZER_ARSTN_BLOCKS = 2;

/**
 * The properties driven at the two quarantined references, and their text is IMMATERIAL.
 *
 * The Reset_Contract_Prepass refuses before `renderPropertyWrapper` is ever called (Req 14.11), so
 * no property text and no property KIND can change either verdict below. They are combinational
 * because that is the shape needing least from the interface: `synchronizer` is two-clock, so the
 * importer leaves its `ClockingContract` empty and there is no clock name a clocked property could
 * name. Each names one real output of its own design so the expression is inside the accepted
 * dialect for a reason rather than by luck.
 */
const FLOAT_MULTI_PROPERTY_TEXT = "z == 32'd0";
const SYNCHRONIZER_PROPERTY_TEXT = "dataout == 4'd0";

/**
 * A property over `adder_8bit`'s OWN internal carry wire, which the Property_Wrapper does not
 * declare (Req 6.18).
 *
 * `wire [8:0] c` is the design's ripple chain; the wrapper declares the design's ports and nothing
 * else. The `< 9'd2` shape is what makes the pre-fix behaviour a PROOF rather than a refutation -
 * see the group header for why that choice is load-bearing.
 */
const UNDECLARED_NAME_PROPERTY_TEXT = "c < 9'd2";

/** The internal net the property above names, as `adder_8bit` declares it. */
const UNDECLARED_NAME_DECLARATION = 'wire [8:0] c;';

/**
 * The Yosys diagnostic the directive produces for that name, without its `'` quoting of the net.
 *
 * Matched as a SUBSTRING of the escaped-name form Yosys prints (`'\c'`), so the assertion is about
 * the frontend refusing an implicit declaration rather than about Yosys's own quoting.
 */
const IMPLICIT_DECLARATION_DIAGNOSTIC = 'is implicitly declared';

/** One `always` block boundary. Splitting here is what lets a SINGLE block be asserted about. */
const ALWAYS_KEYWORD_RE = /\balways\s*@/;

/** A Yosys diagnostic's `<file>.v:<line>:` prefix, capturing the file and the line it names. */
const DIAGNOSTIC_FILE_LINE_RE = /^(\S+\.v):(\d+):/;

/**
 * The depth a Reset_Contract_Prepass refusal records: none, because it ran no invocation at one.
 *
 * Zero rather than a ladder rung, and asserted rather than assumed: a first rung here would claim a
 * proof attempt that never happened, and it is the ladder's own `FIRST_CLOCKED_DEPTH` of 20 that a
 * refusal reported from inside the ladder would carry instead.
 */
const NO_PROOF_ATTEMPTED_DEPTH = 0;

/**
 * The Proof_Conditions a pre-pass refusal records: every check `not-run` and the count zero.
 *
 * Req 1.18's "no Proof_Condition was evaluated" has to be WRITTEN DOWN as a value, because
 * `PropertyResult`'s `could-not-verify` member requires a `ProofConditions`. The cover is
 * `not-applicable` rather than unreached because it is taken from the PROPERTY, and "this property
 * has no antecedent" stays true of a run that never happened. Asserting the whole record is what
 * separates a refusal reported AHEAD of the fixed order from one reported after checks ran.
 */
const NO_CONDITION_EVALUATED: ProofConditions = {
  assertionCount: 0,
  presat: 'not-run',
  cover: { reached: 'not-applicable' },
  base: 'not-run',
  induction: 'not-run',
};

/** The `always` blocks of one source, each running from its own keyword to the next. */
function alwaysBlocks(source: string): readonly string[] {
  return source.split(ALWAYS_KEYWORD_RE).slice(1);
}

/**
 * The assertion count the run recorded, whichever verdict shape carries it.
 *
 * `ProvedEvidence` first, because `conditionsOf` deliberately reports a NEVER-ADMITTING record for a
 * `proved` result and reading the count out of that would report 0 for the healthiest runs in the
 * file. Every other verdict carries its `ProofConditions`, so this is total over all three.
 */
function assertionCountOf(result: PropertyResult): number {
  return evidenceOf(result)?.assertionCount ?? conditionsOf(result).assertionCount;
}

/** The sanitized diagnostic a `could-not-verify` carries, or `null` for any other verdict. */
function diagnosticOf(result: PropertyResult): string | null {
  return result.verdict === 'could-not-verify' ? result.diagnostic : null;
}

// -- The two recorded root causes, asserted without any toolchain -------------

describe.skipIf(!CORPUS.available)(
  'the two quarantined references still carry the defects the spec records (Req 8.1)',
  () => {
    let floatMulti: FormalDesign;
    let synchronizer: FormalDesign;

    beforeAll(async () => {
      floatMulti = await formalDesign(FLOAT_MULTI_PROBLEM_ID);
      synchronizer = await formalDesign(SYNCHRONIZER_PROBLEM_ID);
    });

    it('float_multi still mixes an EDGE with a LEVEL in one event list', () => {
      // The one construct Yosys names, beside the seven level-sensitive blocks the Evidence block
      // records. Both are checked so a corpus refresh that rewrote either cannot leave the recorded
      // root cause standing as a claim about a source that no longer says it.
      expect(occurrences(floatMulti.source.contents, FLOAT_MULTI_EVENT_LIST)).toBe(1);
      expect(occurrences(floatMulti.source.contents, 'always @(counter)')).toBe(7);
    });

    it('synchronizer still resets on ONE net edge while testing ANOTHER', () => {
      const blocks = alwaysBlocks(synchronizer.source.contents);
      // TWO blocks are sensitive to `negedge arstn` and EXACTLY ONE of them branches on `!brstn`, so
      // the assertion is the MISMATCH rather than the mere presence of two tokens: the sibling block
      // branches on `!arstn` and is correct, which is what makes the defective one a defect.
      expect(occurrences(synchronizer.source.contents, SYNCHRONIZER_RESET_EDGE)).toBe(
        SYNCHRONIZER_ARSTN_BLOCKS,
      );
      expect(
        blocks.filter(
          (block) =>
            block.includes(SYNCHRONIZER_RESET_EDGE) && block.includes(SYNCHRONIZER_RESET_BRANCH),
        ),
      ).toHaveLength(1);
    });
  },
);

// -- The dialect and the quarantine, over the real toolchain -----------------

describe.skipIf(!RUNNABLE)(
  'the rendered dialect elaborates and the quarantine of 2 is LOUD (Req 6.1, 6.2, 8.2, 8.3, 8.10, 8.11, 8.12, 8.13)',
  () => {
    let real: RealFormalOracle;
    let adder: FormalDesign;
    let counter: FormalDesign;
    let floatMulti: FormalDesign;
    let synchronizer: FormalDesign;

    beforeAll(async () => {
      real = realFormalAdapter(FORMAL_PROBE.pythonBin);
      adder = await formalDesign(ADDER_PROBLEM_ID);
      counter = await formalDesign(COUNTER_PROBLEM_ID);
      floatMulti = await formalDesign(FLOAT_MULTI_PROBLEM_ID);
      synchronizer = await formalDesign(SYNCHRONIZER_PROBLEM_ID);
    });

    it(
      'elaborates a COMBINATIONAL wrapper: a verdict is reached and our assertion is IN the SMT2',
      async () => {
        const result = await prove(
          real,
          adder,
          combinationalProperty('dialect-combinational', EXACT_SUM_PROPERTY_TEXT),
        );

        // THE DIALECT CLAIM, and it is deliberately not the verdict. A wrapper outside the accepted
        // dialect fails in `read_verilog`, is attributed to the wrapper file, and reports THIS cause
        // with no verdict at any depth.
        expect(verdictOf(result)).not.toBe('could-not-verify: property-build-failed');
        // The other half: it elaborated WITH OUR ASSERTION IN IT. A renderer that emitted valid
        // Verilog with the assertion dropped would pass the line above and fail this one, which is
        // the vacuous shape the measurement at the top of this file exists to catch.
        expect(assertionCountOf(result)).toBe(MEASURED_ASSERTION_COUNT);
      },
      PROOF_TIMEOUT_MS,
    );

    it(
      'elaborates a CLOCKED wrapper in BOTH its shapes, and the GUARDED one carries the cover',
      async () => {
        const unconditional = await prove(
          real,
          counter,
          clockedProperty('dialect-clocked', clockOf(counter), COUNTER_RANGE_PROPERTY_TEXT),
        );
        const guarded = await prove(
          real,
          counter,
          guardedProperty(
            'dialect-clocked-guarded',
            clockOf(counter),
            REACHABLE_ANTECEDENT_TEXT,
            COUNTER_RANGE_PROPERTY_TEXT,
          ),
        );

        expect(verdictOf(unconditional)).not.toBe('could-not-verify: property-build-failed');
        expect(verdictOf(guarded)).not.toBe('could-not-verify: property-build-failed');
        // The two clocked shapes are asserted SEPARATELY because they are different rendered text:
        // the clocking event and the reset assume are common, and the guarded shape adds a
        // `cover(<the antecedent>)` beside the assertion. The count is what tells them apart, so the
        // difference of exactly one line is the evidence that the cover elaborated too.
        expect(assertionCountOf(unconditional)).toBe(MEASURED_ASSERTION_COUNT);
        expect(assertionCountOf(guarded)).toBe(COVERED_ASSERTION_COUNT);
        expect(assertionCountOf(guarded) - assertionCountOf(unconditional)).toBe(1);
      },
      PROOF_TIMEOUT_MS,
    );

    it(
      'QUARANTINES float_multi as frontend-rejected, with the diagnostic naming the defective line',
      async () => {
        const result = await prove(
          real,
          floatMulti,
          combinationalProperty('float-multi-quarantine', FLOAT_MULTI_PROPERTY_TEXT),
        );

        expect(verdictOf(result)).toBe('could-not-verify: frontend-rejected');
        // Req 8.2 and 8.3, stated rather than implied: a design that did not elaborate had no
        // property decided about it, in either direction.
        expect(result.verdict).not.toBe('refuted');
        expect(result.verdict).not.toBe('proved');
        // No Proof_Condition was evaluated and no invocation ran at any depth, which is what
        // separates a pre-pass refusal from one reported after the fixed order ran.
        expect(result.depth).toBe(NO_PROOF_ATTEMPTED_DEPTH);
        expect(conditionsOf(result)).toEqual(NO_CONDITION_EVALUATED);

        // THE DIAGNOSTIC'S CONTENT, which is what makes this an assertion about the FRONTEND rather
        // than about any refusal: the surfaced text is the one Yosys printed.
        const diagnostic = diagnosticOf(result);
        expect(diagnostic).toContain(FLOAT_MULTI_DIAGNOSTIC);

        // And it names the DEFECT and not merely a file. The filename is read OUT OF the design
        // rather than spelled, because the adapter writes the candidate design under its own path -
        // `dut_reference.v` for a corpus reference - and the claim here is about the frontend, not
        // about our workspace layout.
        const located = DIAGNOSTIC_FILE_LINE_RE.exec(diagnostic ?? '');
        expect(located?.[1]).toBe(floatMulti.source.path);
        // `?? 0` yields line 0, which indexes to `undefined` and FAILS the expectation below rather
        // than reading as a line that happened to match.
        const lineNumber = Number(located?.[2] ?? 0);
        expect(floatMulti.source.contents.split('\n').at(lineNumber - 1)).toContain(
          FLOAT_MULTI_EVENT_LIST,
        );
      },
      PROOF_TIMEOUT_MS,
    );

    it(
      'QUARANTINES synchronizer as frontend-rejected THOUGH ITS DIAGNOSTIC NAMES NO FILE',
      async () => {
        const result = await prove(
          real,
          synchronizer,
          combinationalProperty('synchronizer-quarantine', SYNCHRONIZER_PROPERTY_TEXT),
        );

        expect(verdictOf(result)).toBe('could-not-verify: frontend-rejected');
        // THE LOAD-BEARING HALF OF THE PAIR, and the two wrong labels are named separately because a
        // different plausible implementation produces each: reusing the lowering's FILENAME rule
        // sends this case to `property-build-failed`, blaming a Property_Wrapper that does not exist
        // yet, and the behaviour that shipped before criteria 8.10 to 8.13 reported
        // `toolchain-unavailable`, naming OUR INSTRUMENT for a design Yosys correctly rejected.
        expect(verdictOf(result)).not.toBe('could-not-verify: property-build-failed');
        expect(verdictOf(result)).not.toBe('could-not-verify: toolchain-unavailable');
        expect(result.verdict).not.toBe('refuted');
        expect(result.verdict).not.toBe('proved');
        expect(result.depth).toBe(NO_PROOF_ATTEMPTED_DEPTH);
        expect(conditionsOf(result)).toEqual(NO_CONDITION_EVALUATED);

        const diagnostic = diagnosticOf(result);
        expect(diagnostic).toContain(SYNCHRONIZER_DIAGNOSTIC);
        // THE ABSENCE OF A FILENAME, ASSERTED RATHER THAN NARRATED. This is the fact that makes the
        // attribution-by-job-contents rule load-bearing (Req 8.13): there is no filename here for a
        // filename rule to match, so a rule that read one would fall through.
        expect(diagnostic).not.toMatch(DIAGNOSTIC_FILE_LINE_RE);
      },
      PROOF_TIMEOUT_MS,
    );

    it(
      'FAILS THE BUILD for a property naming a BARE INTERNAL design net, and never proves it',
      async () => {
        // The name is the design's own, checked against the imported source rather than asserted
        // from memory: if a corpus refresh renamed `c`, this case would otherwise silently become a
        // test about a typo instead of about a real internal net a property author would reach for.
        expect(adder.source.contents).toContain(UNDECLARED_NAME_DECLARATION);

        const result = await prove(
          real,
          adder,
          combinationalProperty('undeclared-internal-name', UNDECLARED_NAME_PROPERTY_TEXT),
        );

        // THE EXPECTED DIRECTION, as the group header wrote it down ahead of the run: the failure
        // is raised in the WRAPPER file, so it is attributed to our property text and not to the
        // candidate design.
        expect(verdictOf(result)).toBe('could-not-verify: property-build-failed');
        // THE OTHER SIDE, and the one a false green would satisfy. Pre-fix this exact case reported
        // base `PASSED` plus `Temporal induction successful` over a fresh 1-bit net nothing drives,
        // which is `proved` for a property that is false of the design.
        expect(result.verdict).not.toBe('proved');
        // ...and not `refuted` either: a wrapper that did not compile refutes nothing (Req 6.12).
        expect(result.verdict).not.toBe('refuted');
        // Nor is the DESIGN blamed. `adder_8bit` elaborates - every case above it in this group
        // proves that - so `frontend-rejected` here would accuse the student's artifact of our
        // instrument's property text, which is the blame-the-student direction Req 8.9 forbids.
        expect(verdictOf(result)).not.toBe('could-not-verify: frontend-rejected');

        // No Proof_Condition was evaluated, which is what separates a build failure from a run that
        // checked something and reported this cause afterwards. The zero count is the half that
        // matters most: a build failure carrying a non-zero count would mean an assertion reached
        // the solver, and the pre-fix false proof carried 3.
        expect(conditionsOf(result)).toEqual(NO_CONDITION_EVALUATED);
        // THE ONE PLACE THE RUN DISAGREED WITH THE DIRECTION WRITTEN AHEAD OF IT, recorded as the
        // measurement it is: this case reports `depth: 1` and NOT the quarantine's
        // `NO_PROOF_ATTEMPTED_DEPTH` of 0. The two are different facts and both are right. A
        // Reset_Contract_Prepass refusal ran no invocation at any depth, so 0 is the only honest
        // value there; this failure is raised INSIDE the Lowering_Sequence of the first ladder rung,
        // so the depth whose invocation was attempted is `COMBINATIONAL_DEPTH`. The conditions above
        // already carry "nothing was checked", so the depth is reporting WHERE the attempt died
        // rather than claiming a proof was evaluated at it.
        expect(result.depth).toBe(COMBINATIONAL_DEPTH);

        // The surfaced diagnostic names the IMPLICIT DECLARATION, so the failure is shown to be the
        // directive's doing rather than any other way a wrapper can fail to build.
        expect(diagnosticOf(result)).toContain(IMPLICIT_DECLARATION_DIAGNOSTIC);
      },
      PROOF_TIMEOUT_MS,
    );
  },
);

// ============================================================================
// Task 6.9: the two INDUCTION controls, which are OPPOSITE failures of ONE gate
// ============================================================================
//
// The three groups above measure what happens when the chain checks NOTHING, when it checks
// something TRUE or FALSE, and when the property was never EVALUATED. All three read the Base_Check
// and the Induction_Check as given. The two controls below are about those two checks themselves,
// and they are the same rule failing in opposite directions:
//
//   - WITHOUT THE BASE CASE, A WRONG INITIAL STATE IS PROVED. `initial out = 4'd15` against
//     `out <= 4'd11` reports `Temporal induction successful.` and `Status: PASSED`, because
//     k-induction never asks where the design STARTS. The Base_Check is the whole difference
//     between that and a proof.
//   - WITH THE INDUCTION CHECK AS A REFUTATION SOURCE, A CORRECT DESIGN IS REFUTED.
//     `yosys-smtbmc`'s k-induction emits no simple-path constraints, so a correct design can fail
//     the inductive step at every depth, and reading that `FAILED` as a counterexample hands a
//     student a refutation of work that is right.
//
// One ordering answers both: the base case decides `refuted` and the induction step never does.
// Control 1 is the direction that reaches a student as a FALSE `Verified` label, control 2 the
// direction that reaches one as a FALSE accusation, and a suite holding only one of them cannot
// tell a correct gate from a gate that is wrong in the other direction.
//
// ---------------------------------------------------------------------------------------------
// CONTROL 1 IS WRITTEN DOWN AS EXPECTED-TO-FAIL, AND THIS PARAGRAPH IS AHEAD OF THE ASSERTION
// DELIBERATELY
// ---------------------------------------------------------------------------------------------
//   `bad_init` MUST be REFUTED. A `proved` verdict for it is the masking defect, not a surprise to
//   be investigated later. The reason for recording the direction first is the task's own: a
//   positive result on a control that is supposed to fail is the highest-value signal available,
//   and it is only available if the expected direction was written down before the run. The spike's
//   first version of this fixture carried the `if (!$initstate)` gate UNIVERSALLY, z3 proved it, and
//   chasing why a control built to fail was passing is the only reason the masking was found at all.
//
// ---------------------------------------------------------------------------------------------
// THE FIXTURE MUST BE SYNCHRONOUS-RESET. AN ASYNC `bad_init` IS NOT A VALID CONTROL AND IT PASSES
// ---------------------------------------------------------------------------------------------
//   MEASURED on this host, and recorded because it costs a session to rediscover: taking the corpus
//   `counter_12` AS IS - which is async active-low, `always @(posedge clk or negedge rst_n)` - adding
//   `initial out = 4'd15`, and proving `out <= 4'd11` under the CORRECT ungated wrapper gives presat
//   `PASSED`, base `PASSED`, and `Temporal induction successful.` / `PASSED`. The design is PROVED
//   and the wrong initial value is INVISIBLE.
//
//   THAT IS NOT A DEFECT AND MUST NOT BE REPORTED AS ONE. `async2sync` makes an async reset take
//   effect in the SAME step, and the unclocked reset assume pins `rst_n` low at step 0, so `out` is
//   driven to 0 at step 0 whatever the `initial` value said. Real hardware behaves identically: an
//   async reset asserted at power-up overrides whatever the register powered up as. The proof is
//   CORRECT for that circuit, and an async `bad_init` measures nothing.
//
//   The masking this control is about needs a SYNC reset, where the reset takes effect at step 1 and
//   step 0 therefore still shows the `initial` value. That is exactly why criterion 14.3 scopes the
//   `if (!$initstate)` gate to a SYNCHRONOUS reset in the first place, and it is why the fixture
//   below is constructed rather than taken from the corpus - and why the group that needs no
//   toolchain asserts the sensitivity list it was constructed with.
//
// ---------------------------------------------------------------------------------------------
// MEASURED ANCHORS, AND THEIR PROVENANCE
// ---------------------------------------------------------------------------------------------
//   Yosys 0.66, z3 4.15.4, under the lowering sequence exactly as `YOSYS_FORMAL_SCRIPT` pins it,
//   under `-s z3` rather than the worker's pinned `-s bitwuzla` for the reason the task 6.3 header
//   records: `yosys-smtbmc -s bitwuzla` is not invocable here, because `smtio.py:229` still builds
//   `[solver, '--smt2', '-i']` and bitwuzla 0.9.1 rejects `--smt2`. So `FORMAL_PROBE` reports this
//   toolchain NOT INVOCABLE, the real-toolchain group below SKIPS, and its assertions are grounded
//   in the z3 measurements rather than in an expectation.
//
//   `bad_init`'s PRE-PASS facts, measured rather than assumed, because the wrapper the proof is taken
//   under follows from them: the initial-state predicate is NOT literally `true` - it is a
//   conjunction pinning the state bits - so `initialStateFree` is FALSE, and the reset derives as
//   `resetKind: 'sync'`, `resetActiveLow: true`. Criterion 14.3 therefore emits NO
//   `if (!$initstate)` gate, because the gate needs sync AND free and only the first holds.
//
//   Over the property `out <= 4'd11` at `-t 20`:
//
//     | design             | wrapper                          | asserts | base   | induct |
//     |--------------------|----------------------------------|---------|--------|--------|
//     | `bad_init` sync    | UNGATED (correct per 14.5)       | 2       | FAILED | PASSED |
//     | `bad_init` sync    | GATED (the spike's blanket gate) | 3       | PASSED | PASSED |
//     | `good_sync`        | GATED (correct per 14.3)         | 3       | PASSED | PASSED |
//
//   Row 1 is the control: the bad initial value is CAUGHT, and `refuted` is the verdict.
//   Row 2 is the MASKING: the same design and the same property become a PROOF when the gate alone
//   is added.
//   Row 3 is `good_sync`, the same design with the `initial` line REMOVED, whose predicate IS `true`
//   so the gate is correctly emitted - and it is the control that keeps row 1 from being an artifact
//   of the sync-reset class simply never proving anything.
//
//   `base: 'failed'` OVER `induction: 'successful'` IS THE `bad_init` SIGNATURE, and Requirement 14
//   states it is byte for byte the same shape a WRONG RESET POLARITY produces - measured separately
//   on a constructed active-low async counter, where the INVERTED assume `!$initstate || rst_n` gives
//   base `FAILED` over induction `PASSED` (`chipAgent/_inbox/gotcha-an-inverted-reset-assume-is-
//   caught-by-nothing-until-property-35-lands.md`). The pair is asserted explicitly below because it
//   is the shape the whole two-condition rule was derived from, and because the two facts it is made
//   of are the two this task's controls separate.
//
// ---------------------------------------------------------------------------------------------
// ROW 2 IS ASSERTED AT THE RENDERER, BECAUSE THE ADAPTER OFFERS NO CHANNEL TO A WRONGLY-GATED
// WRAPPER
// ---------------------------------------------------------------------------------------------
//   The adapter owns every byte of the Property_Wrapper and derives the Reset_Contract from its own
//   pre-pass, so there is no job field, no request field, and no parameter through which a caller
//   could ask for a gated wrapper over a PINNED initial state. That is the same closure that forced
//   task 6.2 to run Yosys directly for the vacuous lowering, and unlike that case there is nothing
//   left to measure outside the seam: the gate is a RENDERER decision, so the renderer's decision is
//   what is asserted - no `if (!$initstate)` for a `{ derived: true, resetKind: 'sync',
//   initialStateFree: false }` contract, and the gate present for the same contract with
//   `initialStateFree: true`. Row 2 is recorded above as the reason that omission is LOAD-BEARING
//   rather than incidental, and no channel is fabricated to re-measure it.
//
// ---------------------------------------------------------------------------------------------
// CONTROL 2, AND WHY ITS SECOND ASSERTION IS THE WHOLE POINT
// ---------------------------------------------------------------------------------------------
//   The CLEAN corpus `counter_12`, unmodified, with the property `out != 4'd13` - TRUE of the design,
//   which counts 0 to 11. Measured at `-t 20`, 2 assertions: presat `Status: PASSED`, base
//   `Status: PASSED`, and the induction check `Temporal induction failed!` then `Assert failed in
//   formal_property_wrapper` then `Status: FAILED`. So the inductive step fails over a PASSING base
//   case, on a design that satisfies the property.
//
//   The verdict must be `could-not-verify` with `induction-engine-incomplete`, and it must NEVER be
//   `refuted`. That second assertion is why the control exists: a `refuted` here tells a student
//   their correct design is broken. The base case is asserted `passed` for the same reason - sourcing
//   a refutation from the induction check over a passing base case is precisely the defect this
//   control catches, and the recorded condition is what separates "the engine could not conclude"
//   from "the design is wrong".
//
//   THERE IS NO ESCALATION. `induction-engine-incomplete` is not the escalating cause, so the refusal
//   lands on the ladder's FIRST rung rather than spending two more on a step no depth is known to
//   repair. `yosys-smtbmc`'s own `Loop detected, increasing induction depth will not help` message
//   printed on NONE of the measured failing cases, so the tool gives no signal in either direction
//   and the decision not to escalate rests on the measurement rather than on the tool's advice.
//
// ---------------------------------------------------------------------------------------------
// WHAT THE SHIMMED RUN MEASURED, since an only-ever-skipping test is indistinguishable from a
// wrong one
// ---------------------------------------------------------------------------------------------
//   All three cases below ran GREEN end to end against the real toolchain under a temporary
//   bitwuzla flag shim, which was then deleted and is not in the repo: bitwuzla as `_SOLVER` and z3
//   as the Solver_Cross_Check AGREE on all three, every recorded condition matching the `-s z3`
//   anchors above field for field, with zero cross-check disagreements. `bad_init` 0.55s,
//   `good_sync` 0.70s, `counter_12`'s `out != 4'd13` 0.67s - all on the first rung, none escalating,
//   and well inside both the 150s Property_Time_Budget and this file's 120s per-test timeout.
//
//   `bad_init`'s counterexample VCD carries `out = 1111` at step 0, which is the `initial` value and
//   nothing else: the refutation is ABOUT the defect rather than merely present. Asserted as that
//   exact value, unlike task 6.3's arithmetic assertion over solver-chosen operands, because this
//   one is pinned by the source and no solver had a choice to make.
//
//   ONE THING THE UNSHIMMED SPIKE COULD NOT HAVE CAUGHT, recorded because the fixture was wrong on
//   the first run here: RTLLM's reference declares `verified_counter_12` and the importer RENAMES it
//   to the Spec's `counter_12`, so a constructed fixture carrying the upstream name renders a wrapper
//   instantiating a module that does not exist. The out-of-band measurements were taken against a
//   hand-written wrapper and were blind to it. The fixture's module name is therefore asserted
//   against `moduleInterface.moduleName` below rather than trusted, and the failure it prevents is
//   `property-build-failed` on a control that would then have measured nothing.
//
// _Requirements: 4.8, 4.10, 4.11, 4.13, 14.5_

/**
 * `bad_init`: a SYNC-reset mod-12 counter whose power-up value is outside its own declared range.
 *
 * CONSTRUCTED rather than imported, and every line that differs from the corpus `counter_12` is
 * load-bearing:
 *   - `initial out = 4'd15;` IS THE DEFECT. 15 is outside the counter's 0 to 11 range, so the design
 *     violates `out <= 4'd11` in the state it actually starts in.
 *   - `always @(posedge clk)` WITHOUT `negedge rst_n` is what makes that defect OBSERVABLE. A
 *     synchronous reset takes effect at step 1, so step 0 still shows the `initial` value; the async
 *     form is MEASURED to be proved with the defect invisible, for the correct reason recorded in the
 *     header above.
 *   - `if (!rst_n) out <= 4'b0000;` keeps the reset ACTIVE-LOW, matching the interface the wrapper is
 *     rendered from, so the reset assume is the same `!rst_n` term the corpus design gets.
 *   - The port list is `counter_12`'s own, so the importer-produced interface is the accurate one for
 *     this source rather than one hand-built beside it.
 *   - THE MODULE NAME IS THE IMPORTER'S, NOT UPSTREAM'S. RTLLM's reference declares
 *     `verified_counter_12` and the importer RENAMES its top module to the Spec's `counter_12`, which
 *     is the name `renderPropertyWrapper` instantiates. A fixture carrying the upstream name renders
 *     a wrapper instantiating a module that does not exist, so the run reports
 *     `property-build-failed` and the control measures nothing - caught here by the assertion below,
 *     which is why the literal is checked against the interface rather than trusted.
 */
const BAD_INIT_SOURCE = `module counter_12 (
  input rst_n,
  input clk,
  input valid_count,
  output reg [3:0] out
);
  initial out = 4'd15;
  always @(posedge clk) begin
    if (!rst_n) out <= 4'b0000;
    else if (valid_count) begin
      if (out == 4'd11) out <= 4'b0000;
      else out <= out + 1;
    end else out <= out;
  end
endmodule
`;

/** The ONE line that is the defect, spelled once so the deletion below cannot drift from it. */
const BAD_INIT_DEFECT_LINE = "  initial out = 4'd15;";

/**
 * The value that line pins `out` to at step 0: `4'd15`, outside the counter's 0 to 11 range.
 *
 * Read out of the counterexample VCD below, so the refutation is checked to be ABOUT the defect
 * rather than merely present. Asserted as an exact value and not as a range, because unlike an
 * operand a solver chose, this one is pinned by the source: there is no other value step 0 can hold.
 */
const BAD_INIT_VALUE = 15;

/**
 * `good_sync`: the SAME design with the defect line deleted, so its predicate is literally `true`.
 *
 * Derived by deletion rather than written out a second time, so the two fixtures cannot drift into
 * differing in something other than the `initial` value - and the deletion is asserted to have
 * APPLIED, for the reason task 6.3 asserts its mutants applied: a transformation that silently
 * matched nothing leaves a test making a claim about a design it is not running.
 */
const GOOD_SYNC_SOURCE = BAD_INIT_SOURCE.replace(`${BAD_INIT_DEFECT_LINE}\n`, '');

/** The sensitivity list that makes the defect observable: a SYNC reset, and no `negedge` term. */
const SYNC_SENSITIVITY_LIST = 'always @(posedge clk)';

/** The async term the CORPUS `counter_12` carries and the fixture must not: the trap, as a check. */
const ASYNC_RESET_TERM = 'negedge rst_n';

/** The property TRUE of `counter_12` at every depth, which `yosys-smtbmc`'s induction still fails. */
const INDUCTION_INCOMPLETE_PROPERTY_TEXT = "out != 4'd13";

/** The gate text criterion 14.3 scopes to a sync reset over a FREE initial state. */
const INITSTATE_GATE = 'if (!$initstate)';

/**
 * The assertion count MEASURED for a GATED wrapper over an UNCONDITIONAL property.
 *
 * One more than the ungated `MEASURED_ASSERTION_COUNT` of 2, and the extra line is ATTRIBUTABLE to
 * the gate by the controlled comparison the two fixtures are: they differ by one source line, the
 * only thing that line changes downstream is the gate decision, and the count differs by one.
 *
 * It coincides with task 6.4's `COVERED_ASSERTION_COUNT`, and the two are kept apart deliberately -
 * that 3 is the COVER's extra line on a guarded property, this 3 is the gate's on an unconditional
 * one, and folding them would make a change to either read as agreement with the other.
 */
const GATED_ASSERTION_COUNT = 3;

/**
 * `bad_init`'s derived contract: a sync active-low reset over a PINNED initial state.
 *
 * The values the pre-pass was MEASURED to derive for that source, so the renderer assertion below is
 * fed the contract the real chain would hand it rather than a shape invented for the test.
 */
const PINNED_SYNC_CONTRACT: ResetContract = {
  derived: true,
  resetName: RESET_NET_NAME,
  resetActiveLow: true,
  resetKind: 'sync',
  initialStateFree: false,
};

/** `good_sync`'s derived contract: the same reset over a FREE initial state. One field apart. */
const FREE_SYNC_CONTRACT: ResetContract = { ...PINNED_SYNC_CONTRACT, initialStateFree: true };

/** The same interface with a CONSTRUCTED source in place of the corpus reference's. */
function constructedDesign(design: FormalDesign, contents: string): FormalDesign {
  return {
    source: { path: design.source.path, contents },
    moduleInterface: design.moduleInterface,
  };
}

// -- The fixtures and the gate decision, asserted without any toolchain ------

describe.skipIf(!CORPUS.available)(
  'the bad_init fixture is SYNC-reset and the gate decision separates it from good_sync (Req 14.5)',
  () => {
    let counter: FormalDesign;

    beforeAll(async () => {
      counter = await formalDesign(COUNTER_PROBLEM_ID);
    });

    it('carries the defect on a SYNCHRONOUS reset, which the corpus design is not', () => {
      expect(occurrences(BAD_INIT_SOURCE, BAD_INIT_DEFECT_LINE)).toBe(1);
      // The trap, as a checked fact rather than a warning. A SYNC reset takes effect at step 1, so
      // step 0 still shows the `initial` value and the defect is observable; the corpus design's
      // async form pins step 0 through the reset assume and is MEASURED to be PROVED with the same
      // `initial` line added, correctly, because that is what the circuit does.
      expect(occurrences(BAD_INIT_SOURCE, SYNC_SENSITIVITY_LIST)).toBe(1);
      expect(occurrences(BAD_INIT_SOURCE, ASYNC_RESET_TERM)).toBe(0);
      expect(occurrences(counter.source.contents, ASYNC_RESET_TERM)).toBe(1);
      // The module the wrapper instantiates is the one this source declares, so the interface reused
      // from the corpus is the accurate interface for it.
      expect(BAD_INIT_SOURCE).toContain(`module ${counter.moduleInterface.moduleName} `);
    });

    it('derives good_sync by deleting exactly that one line and nothing else', () => {
      expect(occurrences(GOOD_SYNC_SOURCE, BAD_INIT_DEFECT_LINE)).toBe(0);
      // The deletion APPLIED, and it moved nothing else: the two sources are line for line identical
      // once the defect line is dropped.
      expect(BAD_INIT_SOURCE.split('\n').filter((line) => line !== BAD_INIT_DEFECT_LINE)).toEqual(
        GOOD_SYNC_SOURCE.split('\n'),
      );
    });

    it('WITHHOLDS the !$initstate gate for a PINNED initial state and emits it for a FREE one', () => {
      const property = clockedProperty(
        'bad-init-range',
        clockOf(counter),
        COUNTER_RANGE_PROPERTY_TEXT,
      );
      const render = (reset: ResetContract): string =>
        renderPropertyWrapper(
          counter.moduleInterface,
          property,
          PROPERTY_WRAPPER_MODULE_NAME,
          reset,
        );

      const withheld = render(PINNED_SYNC_CONTRACT);
      const emitted = render(FREE_SYNC_CONTRACT);

      // THE ROW-2 CLAIM, at the only seam that owns it. The gate is what turned a DETECTED BUG into
      // a PROOF in the measurement above, so its absence over a pinned step 0 is the load-bearing
      // omission - and its presence over a free step 0 is what keeps this from being a renderer that
      // simply never gates.
      expect(withheld).not.toContain(INITSTATE_GATE);
      expect(emitted).toContain(INITSTATE_GATE);
      // The GATE is the only difference between the two, asserted rather than assumed: the reset
      // assume also mentions `!$initstate`, so a test that grepped for the bare token would pass on
      // a renderer that emitted no gate at all.
      expect(emitted.replaceAll(`${INITSTATE_GATE} `, '')).toBe(withheld);
      expect(withheld).toContain(`assume property (!$initstate || !${RESET_NET_NAME});`);
    });
  },
);

// -- The two controls, over the real toolchain -------------------------------

describe.skipIf(!RUNNABLE)(
  'the two INDUCTION controls answer in opposite directions (Req 4.8, 4.10, 4.11, 4.13, 14.5)',
  () => {
    let real: RealFormalOracle;
    let counter: FormalDesign;

    beforeAll(async () => {
      real = realFormalAdapter(FORMAL_PROBE.pythonBin);
      counter = await formalDesign(COUNTER_PROBLEM_ID);
    });

    it(
      'REFUTES bad_init rather than MASKING it, with the base-over-induction signature intact',
      async () => {
        const result = await prove(
          real,
          constructedDesign(counter, BAD_INIT_SOURCE),
          clockedProperty('bad-init-range', clockOf(counter), COUNTER_RANGE_PROPERTY_TEXT),
        );

        // EXPECTED TO FAIL, recorded ahead of the run: see the header. A `proved` here IS the masking
        // defect, so the two assertions are stated separately - the second is the one a blanket gate
        // would fail, and it fails with the verdict named rather than by omission.
        expect(verdictOf(result)).toBe('refuted');
        expect(result.verdict).not.toBe('proved');
        // No escalation: `refuted` terminates the ladder, so the verdict lands on the first rung.
        expect(result.depth).toBe(FIRST_CLOCKED_DEPTH);

        // THE SIGNATURE. `base: 'failed'` over `induction: 'successful'` is byte for byte what a
        // WRONG RESET POLARITY also produces, which is why the whole two-condition rule was derived
        // from it: the induction check reports its temporal-induction success here, so an
        // implementation reading induction alone would report this design PROVED.
        expect(conditionsOf(result)).toEqual({
          assertionCount: MEASURED_ASSERTION_COUNT,
          presat: 'satisfiable',
          cover: { reached: 'not-applicable' },
          base: 'failed',
          induction: 'successful',
        });

        const trace = counterexampleOf(result);
        expect(trace).not.toBeNull();
        const vcd = trace === null ? null : await real.artifacts.readText(trace);
        // The counterexample checked for TRUTH rather than presence, as task 6.3 checks its own:
        // step 0 carries the `initial` value, and that value is what violates the property. A
        // refutation showing anything else at step 0 would be about some other defect.
        expect(signalValue(stepZeroModel(vcd ?? ''), 'out')).toBe(BAD_INIT_VALUE);
      },
      PROOF_TIMEOUT_MS,
    );

    it(
      'PROVES good_sync, so the refutation above is not the sync-reset class failing wholesale',
      async () => {
        const result = await prove(
          real,
          constructedDesign(counter, GOOD_SYNC_SOURCE),
          clockedProperty('good-sync-range', clockOf(counter), COUNTER_RANGE_PROPERTY_TEXT),
        );

        // The same reset, the same property, the same depth, one line apart - and the opposite
        // verdict. Without this the refutation above could be a sync-reset design never proving
        // anything, and the fixture would measure the instrument's blind spot instead of the defect.
        expect(verdictOf(result)).toBe('proved');
        expect(result.depth).toBe(FIRST_CLOCKED_DEPTH);
        const evidence = evidenceOf(result);
        expect(evidence?.base).toBe('passed');
        expect(evidence?.induction).toBe('successful');
        // The GATED count, which is the other half of the row-3 measurement: this design's predicate
        // IS `true`, so the gate is emitted and the SMT2 carries the extra assertion-mentioning line.
        expect(evidence?.assertionCount).toBe(GATED_ASSERTION_COUNT);
      },
      PROOF_TIMEOUT_MS,
    );

    it(
      'reports induction-engine-incomplete over a PASSING base case, and NEVER refutes',
      async () => {
        const result = await prove(
          real,
          counter,
          clockedProperty(
            'counter-induction-incomplete',
            clockOf(counter),
            INDUCTION_INCOMPLETE_PROPERTY_TEXT,
          ),
        );

        expect(verdictOf(result)).toBe('could-not-verify: induction-engine-incomplete');
        // THE WHOLE POINT OF THE CONTROL, stated as its own assertion rather than left implied by
        // the verdict above: `out != 4'd13` is TRUE of this design, so a `refuted` here tells a
        // student their correct design is broken. This is the assertion an implementation that
        // sourced `refuted` from the induction check fails.
        expect(result.verdict).not.toBe('refuted');
        // NO ESCALATION. `induction-engine-incomplete` is not the escalating cause, so the refusal
        // lands on the FIRST rung instead of spending two more on a step no depth is known to
        // repair - and the tool printed no `Loop detected` advice on any measured failing case, so
        // that decision rests on the measurement rather than on a signal from the tool.
        expect(result.depth).toBe(FIRST_CLOCKED_DEPTH);

        // The record, and the fact that makes the cause readable: the base case PASSED, so nothing
        // on this path could have sourced a refutation, and `induction: 'inconclusive'` beside it is
        // the measured `Temporal induction failed!` - the engine, not the design.
        expect(conditionsOf(result)).toEqual({
          assertionCount: MEASURED_ASSERTION_COUNT,
          presat: 'satisfiable',
          cover: { reached: 'not-applicable' },
          base: 'passed',
          induction: 'inconclusive',
        });
      },
      PROOF_TIMEOUT_MS,
    );
  },
);
// ============================================================================
// Task 6.10: the RESET CONTRACT is LOAD-BEARING, and its POLARITY DERIVATION
// REFUSES rather than guessing
// ============================================================================
//
// Every group above takes the Reset_Contract as given. It is the input the whole chain rests on:
// the reset assume is what pins the design's real reset state, so it decides whether a base-case
// failure is a fact about the student's design or an artifact of our own instrument. Three claims
// are asserted here, and they are three different ways that one input can be wrong.
//
// ---------------------------------------------------------------------------------------------
// CLAIM 1: THE ASSUME IS LOAD-BEARING, AND ONLY A CONTROL THAT REMOVES IT CAN SHOW THAT
// ---------------------------------------------------------------------------------------------
//   A wrapper whose assume is PRESENT BUT IGNORED is indistinguishable from a working one on every
//   design that passes, so no passing sample measures that the assume does anything at all. The
//   only control that does is one where the assume is GONE and everything else is identical.
//
//   MEASURED, this session, on `counter_12` with `out <= 4'd11`, under the lowering sequence exactly
//   as `YOSYS_FORMAL_SCRIPT` pins it (Yosys 0.66, `-s z3` for the reason the task 6.3 header
//   records), over two wrappers `renderPropertyWrapper` produced that differ by ONE LINE:
//
//     | wrapper                                        | asserts | base   | induct |
//     |------------------------------------------------|---------|--------|--------|
//     | WITH `assume property (!$initstate || !rst_n);` | 2       | PASSED | PASSED |
//     | assume REMOVED, otherwise identical            | 2       | FAILED | PASSED |
//
//   Both carry the SAME 2 assertion-mentioning lines, so the flip is not confounded by the count -
//   it is not the vacuous chain wearing a different hat. The `induct` column reports `Temporal
//   induction successful.` in BOTH rows, which is the part worth staring at: with no base case, the
//   assume-less wrapper is a PROOF.
//
//   THE SIGNATURE COLLISION, WHICH IS THE MOST USEFUL THING IN THAT TABLE.
//   `base: 'failed'` over `induction: 'successful'` is now the MEASURED signature of THREE distinct
//   causes, and NONE of them is the design being wrong:
//     1. A wrong `initial` value - the `bad_init` control in the task 6.9 group above.
//     2. An INVERTED reset assume - the Property 35 finding
//        (`chipAgent/_inbox/gotcha-an-inverted-reset-assume-is-caught-by-nothing-until-property-35-
//        lands.md`).
//     3. A MISSING reset assume - the control measured here.
//   One signature, three causes. What follows from that is a constraint on how this suite may be
//   written: THE SIGNATURE ALONE CANNOT DIAGNOSE, so a single assertion over the signature would
//   pass for any of the three and distinguish none of them. Each cause therefore needs its OWN
//   control - cause 1 has task 6.9's `bad_init`, cause 2 has the renderer's polarity assertions
//   below, and cause 3 has this group's - rather than a shared assertion over the shape they share.
//
//   WHY THIS CLAIM IS ASSERTED AT THE RENDERER RATHER THAN RE-MEASURED THROUGH THE ADAPTER.
//   The adapter owns every byte of the Property_Wrapper and derives the Reset_Contract from its own
//   pre-pass, so there is no job field, no request field, and no parameter through which a caller
//   could ask for an assume-less wrapper over a reset-BEARING design: the pre-pass either derives a
//   contract, which emits the assume, or it refuses with `reset-contract-unresolved` and no wrapper
//   is built at all. That is the same closure task 6.9 hit for its gated-wrapper row and task 6.2
//   hit for the vacuous lowering, and unlike the lowering there is nothing left to measure outside
//   the seam: the emission is a RENDERER decision, so the renderer's decision is what is asserted.
//   The measured table above is recorded as the reason that emission is LOAD-BEARING rather than
//   incidental, and no channel is fabricated to re-measure it.
//
//   THE ASSUME-LESS WRAPPER IS NOT HAND-WRITTEN, WHICH IS WHAT MAKES THE TABLE'S "OTHERWISE
//   IDENTICAL" A CHECKED FACT. MEASURED here: the render for a REFUSED contract is byte for byte the
//   render for the DERIVED one with the assume line deleted, so the second row of the table is the
//   renderer's own `{ derived: false }` output rather than a text this file edited. Renderable and
//   adapter-unreachable are different things, and the assertion below pins both.
//
// ---------------------------------------------------------------------------------------------
// CLAIM 2: THE DERIVED POLARITY AGREES WITH THE SOURCE, AND `asyn_fifo` REFUSES
// ---------------------------------------------------------------------------------------------
//   MEASURED this session under `prep -auto-top -flatten; opt_dff -sat`, which is
//   `YOSYS_PREPASS_SCRIPT`'s own sequence, reading the raw parameter values off `write_json`:
//
//     | design       | parameter        | raw value                          | cells | means             | source says      |
//     |--------------|------------------|------------------------------------|-------|-------------------|------------------|
//     | `counter_12` | `ARST_POLARITY`  | `00000000000000000000000000000000`  | 1     | 0, active LOW, async | `negedge rst_n` - AGREES |
//     | `radix2_div` | `SRST_POLARITY`  | `00000000000000000000000000000001`  | 11    | 1, active HIGH, sync | AGREES           |
//     | `asyn_fifo`  | `ARST_POLARITY`  | `00000000000000000000000000000000`  | 8     | 0 on TWO nets     | refuses          |
//
//   `radix2_div`'s 11 cells are 7 on the top-level port `rst` plus 4 on internal nets that the
//   top-level-input-port filter drops, which is that filter doing real work on every sync-reset run.
//
//   WHY `asyn_fifo` REFUSES, AND WHY THE REASON IS THE WHOLE POINT. It has TWO DISTINCT top-level
//   reset input ports - `wrstn` on 4 cells and `rrstn` on 4 cells - and BOTH ARE ACTIVE-LOW, so the
//   POLARITIES AGREE. The refusal is therefore the MORE-THAN-ONE-NET condition and NOT a polarity
//   conflict, and that distinction is a claim about a derivation we might plausibly have written: a
//   derivation that checked only polarity CONSISTENCY would ACCEPT this design and then pick one of
//   the two reset nets arbitrarily, driving one FIFO domain out of reset while assuming the other
//   INTO it. The measured top-level input list is `wclk, rclk, wrstn, rrstn, winc, rinc, wdata`, so
//   both reset nets survive the port filter and the filter is not what refuses it either. Both facts
//   are asserted below rather than narrated, because each rules out a different wrong derivation.
//
//   The expected verdict is `could-not-verify` with `reset-contract-unresolved`, reported from the
//   PRE-PASS with no wrapper built, so no Proof_Condition is evaluated and no invocation runs at any
//   depth - the same shape the task 6.5 quarantine cases record.
//
// ---------------------------------------------------------------------------------------------
// CLAIM 3: THE ASSERTION TESTS THE PARSE, NOT THE CORPUS - AND THE PARSE TRAP IS WORSE THAN THE
// SPEC'S OWN EVIDENCE SAYS
// ---------------------------------------------------------------------------------------------
//   The worker parses every polarity with `int(v, 2)` and must NEVER string-compare against `"1"`,
//   because `write_json`'s emitted WIDTH IS NOT STABLE. Requirement 14's Evidence states the
//   instability holds ACROSS pass sequences: `"1"` after `prep`, 32 characters after `opt_dff -sat`.
//
//   MEASURED HERE, AND STRONGER THAN THAT. The inconsistency exists WITHIN A SINGLE NETLIST UNDER A
//   SINGLE PASS SEQUENCE. On `asyn_fifo` after `prep -auto-top -flatten; opt_dff -sat`,
//   `CLK_POLARITY` appears in TWO SPELLINGS AT ONCE:
//
//     `00000000000000000000000000000001` on 3 cells, and bare `1` on 6 cells.
//
//   So a compare against `"1"` would read those 6 cells as posedge and the other 3 as NEGEDGE IN THE
//   SAME DESIGN, yielding a spurious `mixed` Clock_Contract and a FALSE `clock-contract-unsupported`
//   refusal of a design whose clocks are uniformly posedge. That is a false refusal produced by the
//   PARSE alone, needing no second pass sequence to demonstrate. It STRENGTHENS rather than
//   contradicts the recorded cross-pass-sequence evidence: the trap fires on one netlist read once.
//
//   WHAT MAKES THE ASSERTION BELOW A TEST OF THE PARSE. The derived polarity is compared against the
//   SOURCE-STATED ground truth for each design, and `radix2_div` is in the set precisely because its
//   raw value is a 32-character string whose LAST CHARACTER IS `1` - the case a `=== "1"` compare
//   gets wrong. Which raw spelling each derived value came from is recorded in the table above, so a
//   later reader can see exactly what would have to change for the assertion to move.
//
//   AND THAT IS MEASURED HERE RATHER THAN ARGUED, by replacing the worker's `int(v, 2)` with a
//   `== "1"` compare, running this group, and putting the parse back. Two runs, and the SECOND is the
//   one that earns `radix2_div` its place:
//     - REPLACING THE SHARED PARSE refuses ALL FOUR real-toolchain cases below, every one of them
//       with `clock-contract-unsupported`. That is claim 3's predicted FALSE REFUSAL arriving end to
//       end through the real chain: the clock check sits AHEAD of the reset in the fixed order, so a
//       `CLK_POLARITY` misread short-circuits before any reset polarity is ever reported, and three
//       designs whose clocks are uniformly posedge are refused for their clocking.
//     - REPLACING THE RESET PARSE ALONE, leaving the clock parse intact, flips exactly one field:
//       `radix2_div`'s `resetActiveLow` goes `false` to `true`, and the assertion catches it - while
//       `counter_12` STILL PASSES, because its 32 zeros read active-low under both rules. So
//       `counter_12` alone would pass a broken parse silently, `radix2_div` is the load-bearing row,
//       and `resetActiveLow: false` is the one field in this file that moves.
//
// ---------------------------------------------------------------------------------------------
// HOW THE DERIVED CONTRACT IS OBSERVED, AND WHY IT NEEDS ITS OWN SUBMISSION
// ---------------------------------------------------------------------------------------------
//   `PropertyResult` carries a verdict, the five conditions, a depth, and an elapsed time. It does
//   NOT carry the Reset_Contract the verdict was taken under - that is `FormalProvenance`'s job and
//   `FormalProvenance` is not wired yet - so the derived polarity is not readable off a `prove`
//   result at all. The pre-pass's own report IS readable: `assembleFormalPrepassJob` is submitted
//   through the SAME Tool_Runner the oracle uses, and the `formalPrepassReport` it registers is read
//   back through `readFormalPrepassReport`, which is the identical parse and the identical
//   derivation the adapter runs. Nothing is reimplemented here and no second composition is built.
//
// ---------------------------------------------------------------------------------------------
// WHAT THE SHIMMED RUN MEASURED, since an only-ever-skipping test is indistinguishable from a wrong
// one
// ---------------------------------------------------------------------------------------------
//   All three real-toolchain cases below ran GREEN end to end under a temporary bitwuzla flag shim,
//   which was then deleted and is not in the repo. The two derived contracts came back field for
//   field as the table above records them, `asyn_fifo` refused with `reset-contract-unresolved`
//   before any solver ran, and every pre-pass landed well inside its own budget - the pre-pass is
//   measured at roughly 0.7s over all 48 elaborating references, so it is free relative to the proof
//   it protects.
//
// _Requirements: 14.9, 14.16, 14.17, 14.18_

/** RTLLM's radix-2 divider: SYNC active-HIGH reset, and the row a `=== "1"` compare gets wrong. */
const RADIX2_DIV_PROBLEM_ID = 'rtllm/arithmetic/radix2_div';

/** RTLLM's async FIFO: the design with TWO reset ports, which the derivation must REFUSE. */
const ASYN_FIFO_PROBLEM_ID = 'rtllm/memory/asyn_fifo';

/**
 * `asyn_fifo`'s two reset ports, and the fact that there are TWO of them IS the refusal.
 *
 * Named separately from the input list below because the two lists answer different questions: this
 * one is why the derivation refuses, and that one is why the top-level-input-port filter is not what
 * refused it. Asserted as the EXPECTED VALUE of a list derived from the source below rather than as
 * a standalone claim, so it is a query against the design and not a restatement of itself.
 */
const ASYN_FIFO_RESET_PORTS: readonly string[] = ['wrstn', 'rrstn'];

/**
 * `asyn_fifo`'s full declared input list, MEASURED off the elaborated netlist's top-level ports.
 *
 * Asserted against the importer's own interface, so the netlist measurement and the interface the
 * pre-pass job is built from are shown to name the same ports. Both reset nets are in it, which is
 * what rules out the port filter as the thing that refuses this design.
 */
const ASYN_FIFO_DECLARED_INPUTS: readonly string[] = [
  'wclk',
  'rclk',
  'wrstn',
  'rrstn',
  'winc',
  'rinc',
  'wdata',
];

/** One output of `asyn_fifo`, so its property is inside the dialect for a reason rather than by luck. */
const ASYN_FIFO_PROPERTY_TEXT = "wfull == 1'b0";

/** A property over `radix2_div`'s own clock, for the ACTIVE-HIGH render. Never proved here. */
const RADIX2_DIV_PROPERTY_TEXT = "res_valid == 1'b0";

/** `radix2_div`'s reset net, as the derivation reads it off the elaborated netlist's port list. */
const RADIX2_RESET_NET_NAME = 'rst';

/**
 * The contract the pre-pass DERIVES for `counter_12`: async active-LOW over a FREE initial state.
 *
 * Every field MEASURED through the real worker. `resetActiveLow: true` came from
 * `ARST_POLARITY` spelled as 32 zeros, and `initialStateFree: true` from an initial-state predicate
 * that is literally `true` - the corpus design carries no `initial` block.
 */
const COUNTER_DERIVED_CONTRACT: ResetContract = {
  derived: true,
  resetName: RESET_NET_NAME,
  resetActiveLow: true,
  resetKind: 'async',
  initialStateFree: true,
};

/**
 * The contract the pre-pass DERIVES for `radix2_div`: sync active-HIGH over a FREE initial state.
 *
 * `resetActiveLow: false` IS THE PARSE ASSERTION. It came from `SRST_POLARITY` spelled
 * `00000000000000000000000000000001`, so `int(v, 2)` reads 1 and the reset is active-HIGH, while a
 * `=== "1"` compare on that same 32-character string reads FALSE and would derive active-LOW. This
 * is the one field in this file that moves if the base-2 parse is replaced by a string compare.
 */
const RADIX2_DERIVED_CONTRACT: ResetContract = {
  derived: true,
  resetName: RADIX2_RESET_NET_NAME,
  resetActiveLow: false,
  resetKind: 'sync',
  initialStateFree: true,
};

/** The Clock_Contract all three designs derive: uniformly posedge, including `asyn_fifo`'s two clocks. */
const DERIVED_CLOCK_POLARITY = 'posedge';

/** The reset assume `counter_12`'s DERIVED active-low contract emits, uninverted (Req 14.2). */
const ACTIVE_LOW_ASSUME = `  assume property (!$initstate || !${RESET_NET_NAME});`;

/** The reset assume `radix2_div`'s DERIVED active-HIGH contract emits: the SAME term, UNINVERTED. */
const ACTIVE_HIGH_ASSUME = `  assume property (!$initstate || ${RADIX2_RESET_NET_NAME});`;

/** The INVERTED form of that assume: what a `=== "1"` parse would emit, and a false refutation. */
const INVERTED_ACTIVE_HIGH_ASSUME = `!${RADIX2_RESET_NET_NAME});`;

/** The Reset_Contract the pre-pass hands back when it REFUSES: the discriminant and nothing else. */
const REFUSED_CONTRACT: ResetContract = { derived: false };

/**
 * `asyn_fifo`'s two reset terms as its SOURCE states them: a `negedge` edge, and a `~` branch test.
 *
 * Both halves of the ground-truth method, per reset port. `negedge x` together with a branch on
 * `~x` is active-LOW, so a design carrying both terms for both ports states that its two resets
 * AGREE - which is what makes the refusal the more-than-one-net condition rather than a conflict.
 */
const ASYN_FIFO_SOURCE_TERMS: readonly (readonly [edge: string, branch: string])[] = [
  ['negedge wrstn', 'if(~wrstn)'],
  ['negedge rrstn', 'if(~rrstn)'],
];

/**
 * The caps and the wall-clock bound one pre-pass submission gets.
 *
 * The same four caps every real formal job gets, plus the `wallMs` the adapter would derive from an
 * unspent Property_Time_Budget on its FIRST job - so the pre-pass here runs under the bound it runs
 * under in production rather than a number invented for the test.
 */
const PREPASS_LIMITS: ResourceLimits = {
  ...FORMAL_CAPS,
  wallMs: DEFAULT_PROPERTY_TIME_BUDGET_MS,
};

/**
 * The `formal-prepass-report.json` text the REAL worker wrote for one design, or `''`.
 *
 * ONE real `formalPrepass` submission through the same Tool_Runner the oracle uses. The two readers
 * below both go through it, so a design's derived contract and its RAW document come from the SAME
 * worker-written report rather than from two runs that could disagree.
 *
 * The artifact key is read OFF THE JOB rather than spelled, so it cannot drift from the name the
 * adapter's own pre-pass job requires. The `?? ''` is fail-safe rather than defensive: an empty key
 * resolves no artifact, and both readers below refuse empty text, which FAILS every assertion
 * instead of quietly matching one.
 */
async function prepassReportText(real: RealFormalOracle, design: FormalDesign): Promise<string> {
  const job = assembleFormalPrepassJob(design.source, design.moduleInterface, PREPASS_LIMITS);
  const submitted = await real.toolRunner.run(job);
  const artifact = submitted.artifacts[job.requiredOutputs.at(0) ?? ''];
  const text = artifact === undefined ? null : await real.artifacts.readText(artifact);
  return text ?? '';
}

/**
 * The contract the REAL pre-pass derived for one design, or the `CouldNotVerifyCause` refusing it.
 *
 * The real worker, the real `formalPrepass` job, and the real parse: `readFormalPrepassReport` is
 * the same function the adapter calls, so this reads the pre-pass rather than re-deriving anything.
 */
async function derivedContract(
  real: RealFormalOracle,
  design: FormalDesign,
): Promise<Result<FormalPrepassReport, CouldNotVerifyCause>> {
  return readFormalPrepassReport(await prepassReportText(real, design));
}

/**
 * The RAW pre-pass DOCUMENT for one design, before the derivation collapses it.
 *
 * `readFormalPrepassReport` is the composition of `parseFormalPrepassReport` and
 * `deriveFormalPrepassReport`, and the derivation turns a REFUSING `clockPolarity` into a
 * `CouldNotVerifyCause` - so `mixed` and `negedge` are both unreadable off a derived contract.
 * This reader stops at the first half, which is the ONLY channel carrying WHICH of the four
 * vocabulary members the worker actually derived. It is the adapter's own parse, called directly:
 * no schema is restated and no derivation is reimplemented here.
 */
async function prepassDocument(
  real: RealFormalOracle,
  design: FormalDesign,
): Promise<Result<FormalPrepassDocument, FormalPrepassRejection>> {
  return parseFormalPrepassReport(await prepassReportText(real, design));
}

// -- Claim 1, at the renderer, and claim 2's source ground truth: no toolchain --

describe.skipIf(!CORPUS.available)(
  'the reset assume is the ONE thing a derived contract adds to the wrapper (Req 14.9, 14.17)',
  () => {
    let counter: FormalDesign;
    let radix2: FormalDesign;

    beforeAll(async () => {
      counter = await formalDesign(COUNTER_PROBLEM_ID);
      radix2 = await formalDesign(RADIX2_DIV_PROBLEM_ID);
    });

    it('EMITS the assume for a DERIVED contract and WITHHOLDS it for a refused one', () => {
      const property = clockedProperty(
        'reset-assume-control',
        clockOf(counter),
        COUNTER_RANGE_PROPERTY_TEXT,
      );
      const render = (reset: ResetContract): string =>
        renderPropertyWrapper(
          counter.moduleInterface,
          property,
          PROPERTY_WRAPPER_MODULE_NAME,
          reset,
        );

      const emitted = render(COUNTER_DERIVED_CONTRACT);
      const withheld = render(REFUSED_CONTRACT);

      expect(emitted).toContain(ACTIVE_LOW_ASSUME);
      expect(withheld).not.toContain('assume');
      // THE CONTROL'S OWN "OTHERWISE IDENTICAL", AS A CHECKED FACT. The measured base-case flip was
      // taken over two wrappers differing by exactly this line, and this is the assertion that says
      // the second one is the renderer's own output rather than a text edited by hand: delete the
      // assume from the derived render and what is left IS the refused render, byte for byte. So
      // `assume REMOVED, otherwise identical` in the table above is not a claim about tidiness.
      expect(emitted.replace(`${ACTIVE_LOW_ASSUME}\n`, '')).toBe(withheld);
      // And the async contract emits NO `if (!$initstate)` gate (Req 14.4), so the assume really is
      // the only difference - a gate riding along would make the flip attributable to two changes.
      expect(emitted).not.toContain(INITSTATE_GATE);
    });

    it('emits the assume UNINVERTED for an ACTIVE-HIGH derived polarity', () => {
      // The downstream consequence of claim 3, at the seam that shows it: the derived polarity is
      // what picks the assume's term, so a parse that read `radix2_div` as active-LOW would emit
      // `!rst` here. That is the INVERTED assume, which is measured to give a FAILING base case over
      // a PASSING induction check - the signature collision's second cause, and a FALSE REFUTATION
      // of a design that is correct.
      const rendered = renderPropertyWrapper(
        radix2.moduleInterface,
        clockedProperty('radix2-assume-polarity', clockOf(radix2), RADIX2_DIV_PROPERTY_TEXT),
        PROPERTY_WRAPPER_MODULE_NAME,
        RADIX2_DERIVED_CONTRACT,
      );

      expect(rendered).toContain(ACTIVE_HIGH_ASSUME);
      expect(rendered).not.toContain(INVERTED_ACTIVE_HIGH_ASSUME);
      // The SYNC half of the same contract, over a FREE initial state, so the gate IS owed here -
      // which is also why this render is not a second copy of the async one above (Req 14.3).
      expect(rendered).toContain(INITSTATE_GATE);
    });
  },
);

describe.skipIf(!CORPUS.available)(
  'asyn_fifo genuinely has TWO reset ports whose polarities AGREE (Req 14.18)',
  () => {
    let asynFifo: FormalDesign;
    let declaredInputs: readonly string[] = [];

    beforeAll(async () => {
      asynFifo = await formalDesign(ASYN_FIFO_PROBLEM_ID);
      declaredInputs = asynFifo.moduleInterface.ports
        .filter((port) => port.direction === 'input')
        .map((port) => port.name);
    });

    it('declares MORE THAN ONE reset net among its top-level inputs, which is the refusal', () => {
      // The measured top-level input list, in order, checked against the interface the pre-pass job
      // is actually built from - so the netlist measurement and the importer are shown to name the
      // same ports rather than being asserted to separately.
      expect(declaredInputs).toEqual(ASYN_FIFO_DECLARED_INPUTS);

      // THE MORE-THAN-ONE-NET CONDITION, DERIVED FROM THE DESIGN rather than restated. Which of this
      // design's declared inputs carry an async reset edge is a question about the source, and the
      // answer is TWO: both survive the top-level-input-port filter, so the filter is not what
      // refuses this design and the derivation really does see two candidate reset nets.
      const resetInputs = declaredInputs.filter((name) =>
        asynFifo.source.contents.includes(`negedge ${name}`),
      );

      expect(resetInputs).toEqual([...ASYN_FIFO_RESET_PORTS]);
      // The importer left the clocking contract EMPTY because the design is two-clock, which is the
      // same ambiguity one layer up and is why the property driven at it below is combinational:
      // there is no single clock name a clocked property could name, and no single reset name either.
      expect(asynFifo.moduleInterface.clocking.clockName).toBeNull();
      expect(asynFifo.moduleInterface.clocking.resetName).toBeNull();
    });

    it('states BOTH resets ACTIVE-LOW in source, so a polarity-consistency check would ACCEPT it', () => {
      // THE POINT OF THE WHOLE GROUP. If the two polarities AGREE, a derivation that checked only
      // polarity CONSISTENCY would accept this design and then pick one of the two nets arbitrarily,
      // driving one FIFO domain out of reset while assuming the other INTO it. So the refusal has to
      // be the more-than-one-net condition, and the agreement is what makes that testable.
      for (const [edge, branch] of ASYN_FIFO_SOURCE_TERMS) {
        // Both halves of the ground-truth method per port: a `negedge` term in the sensitivity list
        // AND a `~`-tested branch in the body is active-LOW.
        expect(asynFifo.source.contents).toContain(edge);
        expect(asynFifo.source.contents).toContain(branch);
        // And NO `posedge` form of either reset anywhere, so neither port is active-HIGH and the two
        // readings cannot disagree.
        expect(asynFifo.source.contents).not.toContain(edge.replace('negedge', 'posedge'));
      }
      // Every source term above names a port this design really declares, so the loop is a query
      // against the interface rather than a pair of literals agreeing with each other.
      expect(ASYN_FIFO_SOURCE_TERMS.map(([edge]) => edge.split(' ').at(-1))).toEqual([
        ...ASYN_FIFO_RESET_PORTS,
      ]);
      for (const resetPort of ASYN_FIFO_RESET_PORTS) {
        expect(declaredInputs).toContain(resetPort);
      }
    });
  },
);

// -- Claims 2 and 3, over the real toolchain ---------------------------------

describe.skipIf(!RUNNABLE)(
  'the derived reset polarity AGREES with the source, and two reset ports REFUSE (Req 14.9, 14.16, 14.17, 14.18)',
  () => {
    let real: RealFormalOracle;
    let counter: FormalDesign;
    let radix2: FormalDesign;
    let asynFifo: FormalDesign;

    beforeAll(async () => {
      real = realFormalAdapter(FORMAL_PROBE.pythonBin);
      counter = await formalDesign(COUNTER_PROBLEM_ID);
      radix2 = await formalDesign(RADIX2_DIV_PROBLEM_ID);
      asynFifo = await formalDesign(ASYN_FIFO_PROBLEM_ID);
    });

    it(
      'derives counter_12 as ASYNC ACTIVE-LOW, agreeing with its `negedge rst_n` source',
      async () => {
        const derived = await derivedContract(real, counter);

        // The whole contract, because every field feeds a different emission: the name and the
        // polarity pick the assume's term, and the kind and the free-initial-state fact together
        // decide the `if (!$initstate)` gate. MEASURED from `ARST_POLARITY` spelled as 32 ZEROS.
        expect(derived).toEqual({
          ok: true,
          value: { reset: COUNTER_DERIVED_CONTRACT, clockPolarity: DERIVED_CLOCK_POLARITY },
        });
        // The cross-check that matters: the derivation AGREES with the Spec's own claim here. It is
        // asserted as agreement and never used as the source - `ClockingContract.resetActiveLow`
        // originates in model-generated text, and reading the polarity off it is exactly the trust
        // the pre-pass exists to remove (Req 14.9, 14.10).
        expect(counter.moduleInterface.clocking.resetActiveLow).toBe(true);
      },
      PROOF_TIMEOUT_MS,
    );

    it(
      'derives radix2_div as SYNC ACTIVE-HIGH, which a string compare against "1" gets WRONG',
      async () => {
        const derived = await derivedContract(real, radix2);

        // THE PARSE ASSERTION. The raw `SRST_POLARITY` here is the 32-character string
        // `00000000000000000000000000000001`, so `int(v, 2)` reads 1 and the reset is active-HIGH,
        // while `=== "1"` on that same string reads FALSE and would derive `resetActiveLow: true`.
        // This expectation is the one that fails in that case, and `counter_12` above would not:
        // its 32 zeros read active-low under BOTH rules, so it passes a broken parse silently.
        expect(derived).toEqual({
          ok: true,
          value: { reset: RADIX2_DERIVED_CONTRACT, clockPolarity: DERIVED_CLOCK_POLARITY },
        });
        expect(radix2.moduleInterface.clocking.resetActiveLow).toBe(false);
      },
      PROOF_TIMEOUT_MS,
    );

    it(
      'REFUSES asyn_fifo for having TWO reset nets, not for a polarity conflict',
      async () => {
        const derived = await derivedContract(real, asynFifo);

        // The derivation refuses - `derived: false` and the named cause - while the CLOCK contract
        // is fine. That pairing is the assertion: `posedge` on every one of this design's flops means
        // the refusal came from the RESET side, and the source group above establishes that the two
        // reset polarities AGREE, so what is left is the more-than-one-net condition.
        expect(derived).toEqual({ ok: false, error: 'reset-contract-unresolved' });
      },
      PROOF_TIMEOUT_MS,
    );

    it(
      'reports reset-contract-unresolved FROM THE PRE-PASS, with no wrapper and no depth',
      async () => {
        const result = await prove(
          real,
          asynFifo,
          combinationalProperty('asyn-fifo-two-resets', ASYN_FIFO_PROPERTY_TEXT),
        );

        expect(verdictOf(result)).toBe('could-not-verify: reset-contract-unresolved');
        // Neither direction, stated rather than implied: a design whose reset we could not derive had
        // no property decided about it. A `refuted` here would be a FALSE accusation against a
        // correct FIFO, which is the direction the whole refusal exists to close.
        expect(result.verdict).not.toBe('refuted');
        expect(result.verdict).not.toBe('proved');
        // AHEAD of the whole fixed order (Req 1.18): no invocation ran at any depth, no
        // Proof_Condition was evaluated, and no Property_Wrapper was built. The same shape the two
        // quarantine cases record, reached by a different refusal.
        expect(result.depth).toBe(NO_PROOF_ATTEMPTED_DEPTH);
        expect(conditionsOf(result)).toEqual(NO_CONDITION_EVALUATED);
        // NOT the labels the two plausible wrong implementations produce: a derivation that guessed
        // one of the two nets would have reached a verdict at a ladder rung, and a refusal routed
        // through the unreadable-report path would name OUR INSTRUMENT for a design whose netlist we
        // read perfectly well.
        expect(verdictOf(result)).not.toBe('could-not-verify: toolchain-unavailable');
        expect(verdictOf(result)).not.toBe('could-not-verify: property-build-failed');
      },
      PROOF_TIMEOUT_MS,
    );
  },
);

// ============================================================================
// Task 6.11: a MIXED-EDGE design is REFUSED, and is NEVER REFUTED
// ============================================================================
//
// THIS IS THE ONLY CONTROL IN THIS FILE WHOSE FAILING DIRECTION IS A FALSE REFUTATION OF A CORRECT
// DESIGN, and a reader who skims it as "another negative control" has it backwards. Every other
// negative control here asserts that something WRONG is caught: a false property, two mutants, a
// vacuous antecedent, a pinned bad initial state, a design whose reset we could not derive. This one
// asserts that something RIGHT is not condemned. Both dividers below are CORRECT frequency dividers
// and the assertion is that the gate declines to decide rather than declaring them broken.
//
// THAT IS NOT A SOFTER FAULT THAN A FALSE PROOF, and it is worth saying plainly because the reflex is
// to rank it as one. A false proof hands a student a `Verified` label our instrument did not earn,
// which is a fault pointed at US. A false refutation tells a student their CORRECT design is broken,
// which is the same fault pointed at the STUDENT. It costs them the trust in the tool and the hours
// spent looking for a defect that was never there, so it is not a lesser failure - it is the same
// failure aimed the other way.
//
// ---------------------------------------------------------------------------------------------
// THE PRIOR MEASUREMENTS THIS CONTROL EXISTS FOR, attributed as PRIOR rather than taken here
// ---------------------------------------------------------------------------------------------
//   - THE GATE REFUTED A TRUE PROPERTY. On a minimal mixed-edge reproducer - `a` written on
//     `posedge clk`, `b` written on `negedge clk` with `b <= a`, and the property
//     `always @(posedge clk) if (!$initstate) assert(b == a);` - the gate reported `Status: FAILED`,
//     refuted at STEP 2, over 3 assertions in the SMT2, under `-s z3 -t 20`.
//   - THE PROPERTY IS TRUE OF THE DESIGN. iverilog over 40 randomised cycles, sampling the SAME
//     condition at the SAME edge, reported `mismatches=0`. So the two instruments disagree on a
//     design neither should have trouble with, and the formal one is the one that is wrong.
//   - THE ROOT CAUSE WAS READ OFF THE COUNTEREXAMPLE VCD RATHER THAN INFERRED. `async2sync` rewrites
//     the async RESET only, so a negedge-clocked flop reaches `write_smt2` as an ordinary `$dff`
//     carrying `CLK_POLARITY = 0`, and `write_smt2`'s transition relation advances EVERY `$dff` one
//     step together regardless of polarity. The half-cycle offset between the two clock domains is
//     therefore absent from the model, and NOTHING IN THE CHAIN WARNS: no pass errors, no assertion
//     count drops, no status line hints at it. The verdict is well formed and describes a circuit
//     that is not the one submitted (`chipAgent/_inbox/gotcha-mixed-edge-clocking-collapses-in-
//     write-smt2-and-falsely-refutes.md`).
//   - WHY THESE TWO DESIGNS SPECIFICALLY CANNOT SURVIVE THAT COLLAPSE. Both are frequency dividers,
//     and an ODD divider works PRECISELY because its negedge domain is offset half a cycle from its
//     posedge domain - that offset IS the mechanism, which is why both sources OR a posedge-clocked
//     register with a negedge-clocked one to produce the divided output. Deleting the offset does not
//     perturb these designs at the margin; it removes the thing they are built out of. They are the
//     designs in this corpus least able to tolerate the collapse, which is what makes them the right
//     two to refuse rather than an arbitrary pair.
//
// ---------------------------------------------------------------------------------------------
// WHAT WAS MEASURED HERE, and it is the Clock_Contract for both designs
// ---------------------------------------------------------------------------------------------
//   Yosys 0.66 (git 7f8fdfd8). Pre-pass sequence exactly as `YOSYS_PREPASS_SCRIPT` pins it -
//   `read_verilog -sv <source>; prep -top <top> -flatten; opt_dff -sat` - with `CLK_POLARITY` read
//   off `write_json` and parsed base-2, which is the worker's own `int(v, 2)` rule.
//
//     | design           | top module declared | `$dff` flavour | CLK_POLARITY 1 | CLK_POLARITY 0 | Clock_Contract |
//     |------------------|---------------------|----------------|----------------|----------------|----------------|
//     | `freq_divbyodd`  | `freq_divbyodd`     | `$adff` x4     | 2 cells        | 2 cells        | **mixed**      |
//     | `freq_divbyfrac` | `freq_divbyfrac`    | `$adff` x3     | 2 cells        | 1 cell         | **mixed**      |
//
//   Both polarities present on both designs, so both are `mixed` and both refuse. Those cell counts
//   agree ONE FOR ONE with the source sensitivity-term counts - `freq_divbyodd` has 2 `posedge clk`
//   blocks and 2 `negedge clk` blocks, `freq_divbyfrac` has 2 and 1 - because `opt_dff -sat` leaves
//   exactly one flop cell per `always` block in both. That correspondence is a property of THESE TWO
//   SOURCES rather than a general rule, and it is recorded because it is what makes the source-shape
//   assertion below a cross-check of the measured cell counts rather than a separate claim.
//
//   THE RESET DERIVES CLEANLY FOR BOTH, WHICH MATTERS FOR WHAT THIS GROUP DOES NOT MEASURE. Measured
//   in the same walk: `ARST_POLARITY` is `00000000000000000000000000000000` on every cell of both
//   designs and the `ARST` connection names the single top-level input `rst_n` on all of them. So
//   each design derives an async active-low reset perfectly well, and the refusal below comes from
//   the CLOCK CHECK ALONE. Neither design is criterion 14.33's both-refuse case, so nothing here
//   measures that precedence - `asyn_fifo` in the task 6.10 group is the reset refusal, and the two
//   refusals have not been observed together on any reference.
//
//   AND THIS GROUP IS NOT `CLK_POLARITY` PARSE COVERAGE, which is worth stating because the header
//   above makes the parse sound load-bearing here. MEASURED: on both dividers `CLK_POLARITY` is
//   spelled BARE - `1` and `0`, one character - while `ARST_POLARITY` on the very same cells is 32
//   characters. So a `=== "1"` compare would read the bare `1` cells as posedge correctly and the
//   bare `0` cells as not-posedge correctly, still derive `mixed`, and still refuse. The two designs
//   whose refusal the base-2 parse protects are themselves IMMUNE to the string-compare trap. The
//   load-bearing parse rows are elsewhere: `radix2_div`'s 32-character `SRST_POLARITY` in the task
//   6.10 group, and `asyn_fifo`'s two `CLK_POLARITY` spellings inside one netlist.
//
// ---------------------------------------------------------------------------------------------
// THE REFUSAL CONDITION IS THE WIDER ONE, AND THAT CHOICE IS UNMEASURED - KEEP THE LABEL
// ---------------------------------------------------------------------------------------------
//   Criterion 14.32 conditions the refusal on ANY single flip-flop cell presenting a polarity other
//   than posedge, NOT on more than one polarity being present. That is FAIL-SAFE REASONING rather
//   than measurement, and the requirements document marks it UNMEASURED: a negedge-only design is
//   equally unmodelled by a posedge-sampled assertion, so the wider condition is chosen on fail-safe
//   grounds and the narrower one has no measured advantage.
//
//   WHAT IS MEASURED IS THAT NO REFERENCE CAN DECIDE BETWEEN THEM. Over all 50 references the
//   negedge-only class is EMPTY - 2 mixed, 0 negedge only, 31 posedge only, 15 with no clocked state,
//   2 that do not elaborate - so every design this corpus can offer refuses identically under either
//   condition. Both cases below are `mixed`, so neither separates the two either, and no assertion in
//   this file can. The label stays UNMEASURED rather than being quietly upgraded by a green suite.
//
// ---------------------------------------------------------------------------------------------
// THE CORPUS TOP-NAME INCONSISTENCY, AND WHY THE MODULE NAME IS READ RATHER THAN SPELLED
// ---------------------------------------------------------------------------------------------
//   Both references declare their top module WITHOUT the `verified_` prefix - `module freq_divbyodd`
//   and `module freq_divbyfrac` - although both FILES are named `verified_<design>.v`. That is the
//   known corpus inconsistency, and it means the importer renames NOTHING for these two, unlike
//   `counter_12` whose reference declares `verified_counter_12`. So a literal module name would
//   happen to be right here and happen to be wrong there, which is the worst kind of correct. Every
//   name below is read off `moduleInterface.moduleName`, and the absence of the rename is asserted
//   rather than assumed - for the reason task 6.9's constructed fixture had to learn the hard way,
//   where a wrapper instantiating a module that did not exist reported `property-build-failed` and
//   the control measured nothing.
//
// ---------------------------------------------------------------------------------------------
// ONE BULLET OF THIS TASK IS DEFERRED RATHER THAN STUBBED, AND THIS IS THE RECORD OF IT
// ---------------------------------------------------------------------------------------------
//   The task's last bullet asks that the sample then take the Simulation_Fallback with the
//   Fallback_Reason `clock-contract-unsupported`, which is REQUIREMENT 14.35. IT IS NOT ASSERTED
//   HERE, and the omission is deliberate.
//
//   GROUP 8 OWNS IT - "Wire the oracle into the loop, formal-first with a recorded fallback", tasks
//   8.1 to 8.6 - and group 8 is entirely unstarted. There is no `FormalProvenance`, no
//   `fallbackReason` field, no `FallbackReason` type anywhere in `app/`, and nothing in `app/agent`
//   or `app/eval` calls the formal oracle at all: `verification-loop.ts` does not know this oracle
//   exists. Requirement 14.35's subject is THE VERIFICATION_LOOP, not the Formal_Oracle, and the
//   Formal_Oracle's side of it - reporting `clock-contract-unsupported` as the cause a fallback would
//   be keyed on - is exactly what the assertions below measure.
//
//   ASSERTING IT HERE WOULD REQUIRE STUBBING A VERIFICATION_LOOP THAT DOES NOT EXIST, and a test over
//   that stub would assert the stub rather than the behaviour. That is the same false-green shape this
//   file's own header warns about from the other direction: a well-formed answer describing something
//   other than what was asked. Task 8.4's property test is where the recorded fallback belongs, over
//   generated causes including this one.
//
//   ON THIS CLASS THE FALLBACK IS MEASURED CORRECT RATHER THAN ASSUMED, which is unusual enough to
//   record even while deferring the assertion: iverilog gave 0 mismatches on the very case the gate
//   refused. So the deferred assertion is worth making later for a stronger reason than consistency -
//   here the fallback is the demonstrably RIGHT answer rather than merely the honest one. That is
//   recorded as the reason to make it, NOT as something this group asserted.
//
// ---------------------------------------------------------------------------------------------
// AN OBSERVATION ABOUT THE GATE ON THIS GROUP, RECORDED RATHER THAN ACTED ON
// ---------------------------------------------------------------------------------------------
//   Both designs refuse in the PRE-PASS, before any solver runs, so they need no working
//   `yosys-smtbmc -s bitwuzla` to reach their verdict at all. They are nonetheless gated on
//   `FORMAL_PROBE` like everything else in this file, so on a host where the composed solver
//   invocation is not invocable they SKIP for a reason that cannot affect them. That is the same
//   observation the task 6.5 quarantine group records, it is the cost of ONE skip mechanism, and the
//   probe's composed-invocation rule is a settled decision rather than something to work around here.
//
// ---------------------------------------------------------------------------------------------
// WHAT THE SHIMMED RUN MEASURED, since an only-ever-skipping test is indistinguishable from a wrong
// one
// ---------------------------------------------------------------------------------------------
//   Both cases below ran GREEN end to end against the real toolchain under a temporary bitwuzla flag
//   shim, which was then deleted and is not in the repo. Both came back
//   `could-not-verify` / `clock-contract-unsupported` at depth 0 with every condition `not-run`,
//   neither was `refuted`, and neither was `proved`.
//
//   THE COST IS THE ONE FACT WORTH RECORDING BESIDES THE VERDICTS: the whole group - two real
//   `formalPrepass` submissions through the sandbox worker plus the two source-shape checks - costs
//   roughly 0.3s of test time, against 24.3s for the task 6.4 vacuous case that climbs the whole
//   ladder. That is what "refused before any solver runs" costs, and it is consistent with the
//   pre-pass measured at roughly 0.7s across all 48 elaborating references: these two designs never
//   reach a rung, so no `-t` value and no solver appears in their run at all. The shim is therefore
//   not what makes them pass, and the only thing it changes for this group is whether
//   `FORMAL_PROBE.available` lets them run.
//
// _Requirements: 1.18, 14.30, 14.31, 14.32_
// _Deferred to group 8: 14.35 (the Simulation_Fallback and its recorded Fallback_Reason)_

/** RTLLM's odd-ratio frequency divider: one of exactly TWO mixed-edge references in the corpus. */
const FREQ_DIVBYODD_PROBLEM_ID = 'rtllm/miscellaneous/freq_divbyodd';

/** RTLLM's fractional frequency divider: the other one. Both refuse, and neither may be refuted. */
const FREQ_DIVBYFRAC_PROBLEM_ID = 'rtllm/miscellaneous/freq_divbyfrac';

/** The ONE output both dividers declare, which is what their property below names. */
const DIVIDER_OUTPUT_NAME = 'clk_div';

/**
 * The property driven at both dividers, and its text is IMMATERIAL to either verdict.
 *
 * The Reset_Contract_Prepass refuses before `renderPropertyWrapper` is ever called (Req 14.11, 14.30),
 * so no property text and no property KIND can change the outcome. It is CLOCKED because both designs
 * declare a clock and a clocked property is the shape a divider would really be given, and it names
 * the one output each design declares so the expression is inside the accepted dialect for a reason
 * rather than by luck - asserted as that design's whole port list below.
 */
const DIVIDER_PROPERTY_TEXT = `${DIVIDER_OUTPUT_NAME} == 1'b0`;

/**
 * One mixed-edge design and the `CLK_POLARITY` cell counts MEASURED for it.
 *
 * The counts are the anchors from the header's table, carried as data so the source-shape assertion
 * is a cross-check against them rather than a second set of literals. `negedgeCells` is the half of
 * each design `write_smt2` advances in lockstep with the other half, which is the collapse itself.
 */
interface MixedEdgeAnchor {
  readonly problemId: string;
  /** Flip-flop cells reading `CLK_POLARITY` 1 after `opt_dff -sat`. MEASURED. */
  readonly posedgeCells: number;
  /** Flip-flop cells reading `CLK_POLARITY` 0. MEASURED, and non-zero is what refuses the design. */
  readonly negedgeCells: number;
}

/** Both dividers with their measured cell counts, in the order every assertion below reports them. */
const MIXED_EDGE_ANCHORS: readonly MixedEdgeAnchor[] = [
  { problemId: FREQ_DIVBYODD_PROBLEM_ID, posedgeCells: 2, negedgeCells: 2 },
  { problemId: FREQ_DIVBYFRAC_PROBLEM_ID, posedgeCells: 2, negedgeCells: 1 },
];

/** The verdict, the depth, and the five conditions of one refusal, read as one value. */
interface RefusalShape {
  readonly verdict: string;
  readonly depth: number;
  readonly conditions: ProofConditions;
}

/**
 * The shape BOTH dividers must report: refused from the pre-pass with nothing evaluated.
 *
 * `NO_PROOF_ATTEMPTED_DEPTH` and `NO_CONDITION_EVALUATED` are the task 6.5 quarantine group's own
 * constants, REUSED rather than re-declared, because the claim is that this refusal has the SAME
 * shape as those: reported ahead of the fixed order, with no Property_Wrapper built and no
 * invocation run at any depth (Req 1.18). A third copy of those values would let one drift from the
 * other and read as agreement.
 */
const CLOCK_REFUSAL_SHAPE: RefusalShape = {
  verdict: 'could-not-verify: clock-contract-unsupported',
  depth: NO_PROOF_ATTEMPTED_DEPTH,
  conditions: NO_CONDITION_EVALUATED,
};

/** What one result reports, through the same two readers every group above uses. */
function refusalShape(result: PropertyResult): RefusalShape {
  return { verdict: verdictOf(result), depth: result.depth, conditions: conditionsOf(result) };
}

/** Which of the decided dividers came back with `verdict`, by problem id. Empty is the pass. */
function dividersReporting(
  decided: ReadonlyMap<string, PropertyResult>,
  verdict: PropertyResult['verdict'],
): readonly string[] {
  return [...decided]
    .filter(([, result]) => result.verdict === verdict)
    .map(([problemId]) => problemId);
}

// -- The mixed-edge SHAPE, asserted without any toolchain --------------------

describe.skipIf(!CORPUS.available)(
  'both dividers still carry the MIXED-EDGE shape the recorded root cause rests on (Req 14.30)',
  () => {
    const designs = new Map<string, FormalDesign>();

    beforeAll(async () => {
      for (const { problemId } of MIXED_EDGE_ANCHORS) {
        designs.set(problemId, await formalDesign(problemId));
      }
    });

    it('drives BOTH edges of ONE clock, in the counts the measured cells agree with', () => {
      for (const { problemId, posedgeCells, negedgeCells } of MIXED_EDGE_ANCHORS) {
        const design = designs.get(problemId);
        expect(design).toBeDefined();
        const source = design?.source.contents ?? '';
        // The clock is read off the importer rather than spelled, so both terms below name THIS
        // design's own clock and a corpus refresh that renamed it fails here instead of counting zero
        // occurrences of a signal that no longer exists.
        const clock = design === undefined ? '' : clockOf(design);

        // THE MIXED-EDGE SHAPE AS A CHECKED FACT: a `posedge` term AND a `negedge` term on the SAME
        // clock. This is what turns the recorded root cause - `async2sync` rewriting the reset only,
        // and `write_smt2` advancing every `$dff` together - from a claim about these designs into an
        // assertion a corpus refresh cannot silently invalidate.
        expect({ problemId, posedge: occurrences(source, `posedge ${clock}`) }).toEqual({
          problemId,
          posedge: posedgeCells,
        });
        expect({ problemId, negedge: occurrences(source, `negedge ${clock}`) }).toEqual({
          problemId,
          negedge: negedgeCells,
        });
        // Non-zero on BOTH sides is the refusing condition, stated rather than left to the counts:
        // a design with zero negedge terms is `posedge` and is SUPPORTED, so the mixture is the fact.
        expect(negedgeCells).toBeGreaterThan(0);
        expect(posedgeCells).toBeGreaterThan(0);
      }
    });

    it('declares its top module WITHOUT the verified_ prefix, so no name may be spelled', () => {
      for (const { problemId } of MIXED_EDGE_ANCHORS) {
        const design = designs.get(problemId);
        const moduleName = design?.moduleInterface.moduleName ?? '';

        // The importer's name is the one the source declares, so the rename did not happen for these
        // two - which is the corpus inconsistency, recorded as an assertion. `renderPropertyWrapper`
        // instantiates `moduleInterface.moduleName`, so this is the fact a literal would get wrong on
        // the NEXT design rather than on this one.
        expect(design?.source.contents).toContain(`module ${moduleName}`);
        expect(moduleName).not.toContain(REFERENCE_PREFIX);
        // The property text names the one output this design declares, so the expression driven below
        // is inside the accepted dialect because of the interface rather than by coincidence.
        expect(design?.moduleInterface.ports.map((port) => port.name)).toEqual([
          DIVIDER_OUTPUT_NAME,
        ]);
      }
    });
  },
);

// -- The refusal, over the real toolchain ------------------------------------

describe.skipIf(!RUNNABLE)(
  'a MIXED-EDGE design is REFUSED from the pre-pass and is NEVER REFUTED (Req 1.18, 14.30, 14.31, 14.32)',
  () => {
    const decided = new Map<string, PropertyResult>();

    beforeAll(async () => {
      const real = realFormalAdapter(FORMAL_PROBE.pythonBin);
      for (const { problemId } of MIXED_EDGE_ANCHORS) {
        const design = await formalDesign(problemId);
        decided.set(
          problemId,
          await prove(
            real,
            design,
            clockedProperty(`${problemId}-clock-contract`, clockOf(design), DIVIDER_PROPERTY_TEXT),
          ),
        );
      }
    }, PROOF_TIMEOUT_MS);

    it('reports clock-contract-unsupported FROM THE PRE-PASS, with no wrapper and no depth', () => {
      // Both designs in ONE expectation, keyed by problem id, so a failure names WHICH divider moved
      // and in which of the three fields - a per-design loop would report only that two objects
      // differ. The whole shape is compared because each field is a separate claim: the CAUSE is the
      // clock check, the DEPTH of 0 is that no invocation ran at a rung, and the all-`not-run`
      // conditions are Req 1.18's "no Proof_Condition was evaluated" written down as a value.
      expect(
        Object.fromEntries([...decided].map(([id, result]) => [id, refusalShape(result)])),
      ).toEqual({
        [FREQ_DIVBYODD_PROBLEM_ID]: CLOCK_REFUSAL_SHAPE,
        [FREQ_DIVBYFRAC_PROBLEM_ID]: CLOCK_REFUSAL_SHAPE,
      });
    });

    it('NEVER reports refuted for either divider, which is the ENTIRE POINT of this control', () => {
      // ITS OWN NAMED ASSERTION rather than a consequence of the verdict above, because this is the
      // claim the group exists to make and the one direction no other control in this file covers:
      // the gate was MEASURED to refute a property iverilog confirms is TRUE, so `refuted` here is
      // the recorded behaviour of the chain with this refusal removed rather than a hypothetical.
      // The filter reports WHICH divider was refuted, so the failure names the design.
      //
      // BOTH DESIGNS ARE ASSERTED PRESENT FIRST, because an "is this list empty" assertion over an
      // EMPTY map passes for the wrong reason - a `beforeAll` that decided nothing would report this
      // control GREEN, which is the false-green shape this file's own header is about. The test above
      // would catch it, but a control this file exists to trust must not depend on a sibling for
      // that.
      expect(decided.size).toBe(MIXED_EDGE_ANCHORS.length);
      expect(dividersReporting(decided, 'refuted')).toEqual([]);
      // And not `proved` either. A pass would be a `Verified` label over a model missing the
      // half-cycle offset these designs are built out of, which is the false-proof direction of the
      // same unfaithful model - a weaker risk here, since the collapse was measured to refute rather
      // than to prove, but the same model either way.
      expect(dividersReporting(decided, 'proved')).toEqual([]);
    });
  },
);

// ============================================================================
// Task 6.12: the wrapper's PORT LIST and the memory pass, against what YOSYS SEES
// ============================================================================
//
// Two claims, and they share one design and one Yosys invocation.
//
//   CLAIM 1. Every port the rendered Property_Wrapper declares is an INPUT (Req 3.10), read off the
//   ELABORATED NETLIST rather than off the rendered text.
//
//   CLAIM 2. `verified_ROM` lowers and PROVES with `memory_map -rom-only -keepdc` in the sequence,
//   and the pinned sequence constant carries that pass in its measured position - after
//   `prep -top <top> -flatten` and before `async2sync` (Req 3.1, 3.3).
//
// ---------------------------------------------------------------------------------------------
// WHY CLAIM 1 IS READ OFF THE NETLIST AND NOT OFF THE TEXT, WHICH IS THE WHOLE OF THE BULLET
// ---------------------------------------------------------------------------------------------
//   `renderPropertyWrapper` emits `input` as a LITERAL for every port it declares, so a text-level
//   assertion over the rendered source is a check on our own template. It would pass on a wrapper
//   whose `output` YOSYS INFERRED for some other reason, and the reason the rule exists is a
//   TOOL-SIDE one: a wrapper exposing an output port is a measured FALSE REFUTATION, because ABC ORs
//   every AIGER output into the property and refutes a design z3 and rIC3 both prove
//   (`chipAgent/_inbox/gotcha-property-wrapper-must-expose-no-output-ports.md`). The claim that
//   matters is therefore about the module Yosys ELABORATED, so the port directions below are read out
//   of `write_json` - the same backend the schematic path uses - and never out of the wrapper text.
//   The weaker text-level form is asserted too, in the no-toolchain group, and is labelled there as
//   the renderer's side of the claim rather than as a stand-in for it.
//
//   THE PORTS ARE READ AT BOTH ENDS OF THE LOWERING, out of ONE Yosys run writing TWO netlists:
//   after `prep -top <wrapper> -flatten`, and again after all four lowering passes, which is the
//   netlist `write_smt2` would be handed. Reading only the first would leave "no later pass adds a
//   port" as an argument; reading both makes it a measurement, and it costs nothing because the
//   second `write_json` replaces `write_smt2` in the same invocation.
//
// ---------------------------------------------------------------------------------------------
// WHY `ROM`, AND NOT `adder_8bit`
// ---------------------------------------------------------------------------------------------
//   Both render a wrapper of the interesting shape - the design's INPUTS become the wrapper's ports
//   and its OUTPUTS become internal wires, so any output port at all is the failure - and
//   `adder_8bit` would give a wider port list (3 in, 2 out) than `ROM`'s minimum interesting one
//   (1 in, 1 out). `ROM` is chosen because ONE netlist read then answers claim 1 AND the cell census
//   claim 2 rests on: that this design reaches the memory pass as a MEMORY cell. On `adder_8bit` the
//   census says nothing, so the port claim would cost a second elaboration for facts `ROM`'s own
//   netlist already carries. `ROM`'s partition is non-vacuous in both directions all the same -
//   `addr` must be IN the port list and `dout` must be ABSENT from it - and both are asserted.
//
// ---------------------------------------------------------------------------------------------
// MEASURED ANCHORS. Yosys 0.66 (git 7f8fdfd8), z3 4.15.4
// ---------------------------------------------------------------------------------------------
//   The wrapper is `renderPropertyWrapper`'s own output for `ROM`'s importer interface under a
//   REFUSED Reset_Contract, which is the contract the real pre-pass derives for it (below):
//
//       module formal_property_wrapper (
//         input [7:0] addr
//       );
//         wire [15:0] dout;
//         ROM dut ( .addr(addr), .dout(dout) );
//         assert property (addr != 8'd0 || dout == 16'hA0A0);
//       endmodule
//
//   ONE Yosys run, `read_verilog -sv -formal <design> <wrapper>; prep -top <wrapper> -flatten;
//   write_json; <the four lowering passes>; write_json`:
//
//     | netlist                    | top-level ports  | cells                                          |
//     |----------------------------|------------------|------------------------------------------------|
//     | after `prep`               | `addr` **input** | 6: `$mem_v2` 1, `$check` 1, `$eq` 1, `$logic_or` 1, `$reduce_bool` 1, `$scopeinfo` 1 |
//     | after the lowering         | `addr` **input** | 514: `$mux` 255, `$ff` 252, `$assert` 1, and 6 others |
//
//   FOUR facts in that table, and each is a separate assertion below.
//     - `addr` is the ONLY port at both ends, and its direction is `input`. `dout` appears in
//       NEITHER port list, which is the wrapper holding the design's output as an internal wire.
//     - AFTER `prep` the netlist carries exactly ONE `$mem_v2` and ZERO flip-flop or latch cells of
//       any flavour. That is what the memory pass has to act on, and it is also the residual finding
//       recorded below.
//     - AFTER the lowering the `$mem_v2` is GONE: `memory_map -rom-only -keepdc` replaced it with a
//       255-way `$mux` tree, so the pass is measurably IN the chain and ACTING rather than merely
//       spelled in a constant. The SMT2 grows from 4258 bytes to 282451 for exactly that reason.
//     - The 252 `$ff` cells are the 252 UNINITIALISED ROM entries becoming free constants, which is
//       why this design has state AFTER the pass and none before it. Their PRESENCE is asserted and
//       their COUNT is only recorded: the exact mux and flop counts are a Yosys-version detail, while
//       a flop flavour appearing at all is what keeps the ZERO-flop reading before the pass from
//       being a pattern that matches nothing. `chformal -lower` turning the one `$check` into one
//       `$assert` is visible in the same column, which is the pass whose absence is silent.
//
//   THROUGH THE REAL ADAPTER, under the pinned sequence and the four checks:
//
//     | design                          | verdict   | depth | asserts | conditions                          |
//     |---------------------------------|-----------|-------|---------|-------------------------------------|
//     | `ROM` as the corpus holds it    | `proved`  | 1     | 2       | presat sat, base passed, cover n/a, induction successful |
//     | `mem[0]` = `16'h1234`           | `refuted` | 1     | 2       | presat sat, base FAILED, induction inconclusive |
//
//   0.75s and 0.55s of oracle-reported elapsed time. The refutation's VCD carries `addr = 00000000`
//   and `dout = 0001001000110100` (`16'h1234`) at step 0, in the WRAPPER's own scope - the `dut`
//   scope re-declares both names one level down, which is the scope-tracking `stepZeroModel` exists
//   for.
//
// ---------------------------------------------------------------------------------------------
// THE HONEST LIMIT: THIS DESIGN DOES NOT DEMONSTRATE THE PASS IS NECESSARY
// ---------------------------------------------------------------------------------------------
//   MEASURED, same wrapper, same property, same solver, the one difference being the pass:
//
//     | lowering                              | SMT2 bytes | asserts | status |
//     |---------------------------------------|------------|---------|--------|
//     | WITH `memory_map -rom-only -keepdc`   | 282451     | 2       | PASSED |
//     | that pass OMITTED                     | 4258       | 2       | PASSED |
//
//   So `write_smt2` on Yosys 0.66 handles the `$mem_v2` cell either way for this shape, and the pass
//   is DEFENSIVE here rather than load-bearing. That is recorded as a measured observation and NOT as
//   a defect: the pass joined the sequence on a measured no-regression basis in the first place, and
//   its one recorded benefit is converting a spurious induction failure into a proof on the Yosys
//   issue-3378 ROM shape, which is not this design. No reference in this corpus is known to REQUIRE
//   it. The assertions below therefore claim what is true - `ROM` lowers and proves UNDER the pinned
//   sequence, and the constant carries the pass in its measured position - and claim no necessity,
//   because none was demonstrated. Nothing here is an argument for removing the pass either: an
//   omitted pass is measured to be silent when it matters (task 6.2's whole subject), so "changes
//   nothing on the one design that exercises it" is the weakest possible ground for dropping it.
//
// ---------------------------------------------------------------------------------------------
// A FINDING THAT CONTRADICTS A RECORDED RESIDUAL. FLAGGED HERE, NOT FIXED HERE
// ---------------------------------------------------------------------------------------------
//   Requirement 14's Evidence block records an UNMEASURED residual: a design holding state in
//   LATCHES or MEMORIES rather than `$dff` cells reports `clockPolarity: 'none'` and is ADMITTED with
//   a free initial state rather than refused - closing with "No corpus reference is latch-only or
//   memory-only, so nothing in this corpus measures that residual." `prepass.ts`'s own comment above
//   `deriveFormalPrepassReport` mirrors that sentence.
//
//   `ROM` IS MEMORY-ONLY. One `$mem_v2`, zero `$dff`, measured in the table above. So that closing
//   sentence is FACTUALLY WRONG and the residual has a corpus member. The correction belongs to the
//   requirements document and to that comment, and neither is edited from here.
//
//   WHAT ACTUALLY HAPPENS TO IT, MEASURED, AND WHY THE FEARED RISK DOES NOT MATERIALISE. The real
//   pre-pass over `ROM` reports `reset: { derived: false }` with `clockPolarity: 'none'`, so the
//   no-reset arm of criterion 14.40 is taken and the design is ADMITTED. That arm reads NO
//   initial-state predicate at all - `initialStateFree` lives on the DERIVED member alone - so
//   nothing is assumed free. The renderer then emits no reset assume and no `if (!$initstate)` gate,
//   which is what leaves the `initial` block's pinned ROM contents VISIBLE at step 0.
//
//   The predicate the pre-pass DOES write and then discards is the evidence for that: it is not
//   literally `true`, it opens `(and ` and pins the four initialised entries
//   (`... #b00000000) ... #b1010000010100000`, which is `mem[0] == 16'hA0A0`). A design whose step-0
//   memory contents were free would not carry it.
//
//   So the residual's direction holds - a free initial state would admit MORE behaviours, running in
//   the false-REFUTATION direction and unable to produce a false proof with no gate emitted - and on
//   THIS member nothing is freed at all. The mutated-entry control below is what turns that from an
//   argument into a checked fact: `mem[0]` changed to `16'h1234` is REFUTED, so a wrong ROM entry is
//   still caught at step 0.
//
// ---------------------------------------------------------------------------------------------
// WHERE THE PINNED POSITION IS ASSERTED, AND WHY THE WORKER'S OWN CONSTANT IS READ
// ---------------------------------------------------------------------------------------------
//   The Lowering_Sequence lives in the WORKER as `YOSYS_FORMAL_SCRIPT`, and this file holds
//   `CORRECT_LOWERING` as a MIRROR of its four middle passes, spelled because task 6.2's measurement
//   has to run the chain without the worker. The position is asserted over the composed script this
//   file's own measurements run under - so it is a claim about a real chain rather than about a list
//   of tokens - AND the worker's constant is read out of `eda.py` and asserted to agree.
//
//   THE SECOND HALF IS THE ONE THAT ADDS SOMETHING. `test_formal_lowering.py` already pins the worker
//   constant's text and order on its own side, and the worker owns the sequence, so re-pinning it
//   here would assert a constant equals itself one language over. What NOTHING asserted until now is
//   that the TS MIRROR STILL MATCHES IT: if the worker constant moved and the mirror did not, task
//   6.2 would keep reporting a 0-versus-2 assertion count for a chain that is no longer the one the
//   proofs are taken under, and every number in this file would drift quietly. That is the same
//   false-green shape this file exists to catch, one level up.
//
// ---------------------------------------------------------------------------------------------
// WHAT THE SHIMMED RUN MEASURED, since an only-ever-skipping test is indistinguishable from a wrong
// one
// ---------------------------------------------------------------------------------------------
//   Every real-toolchain case below ran GREEN end to end under a temporary bitwuzla flag shim, which
//   was then deleted and is not in the repo: bitwuzla as `_SOLVER` and z3 as the Solver_Cross_Check
//   agree on both verdicts, with zero cross-check disagreements. The whole group - one Yosys
//   elaboration at roughly 0.06s, one pre-pass, and two proofs - costs about 1.5s, against 24.3s for
//   the task 6.4 vacuous case that climbs the whole ladder.
//
// _Requirements: 3.1, 3.3, 3.10_

/**
 * RTLLM's initialised ROM: this group's design, and a MEMORY-ONLY reference.
 *
 * Memory-only is MEASURED of this design and asserted below. Whether it is the corpus's only such
 * reference is NOT measured here and is not claimed: what Requirement 14's residual needs is one
 * member, and one is what this is.
 */
const ROM_PROBLEM_ID = 'rtllm/miscellaneous/ROM';

/** `ROM`'s one INPUT, which must be the wrapper's one port, and its declared width. */
const ROM_ADDRESS_PORT = 'addr';
const ROM_ADDRESS_WIDTH = 8;

/** `ROM`'s one OUTPUT, which must be an internal WIRE and must appear in NO port list. */
const ROM_DATA_PORT = 'dout';
const ROM_DATA_WIDTH = 16;

/** The `initial` block's entry 0, and the value the property below reads. */
const ROM_ENTRY_ZERO_SITE = "mem[0] = 16'hA0A0;";

/** Entry 1, asserted UNTOUCHED by the mutant, so the edit is shown to be entry 0's alone. */
const ROM_ENTRY_ONE_SITE = "mem[1] = 16'hB1B1;";

/**
 * Entry 0 rewritten to a DIFFERENT value: the mutant that must be refuted.
 *
 * The same width as the value it replaces, so the applied-check below can assert the source length
 * is unchanged - evidence the edit is the single site rather than a wider rewrite containing it.
 */
const ROM_ENTRY_ZERO_MUTATED = "mem[0] = 16'h1234;";

/** Entry 0's value as the property names it, and as a number for reading the counterexample. */
const ROM_ENTRY_ZERO_LITERAL = "16'hA0A0";
const ROM_ENTRY_ZERO_VALUE = 0xa0a0;

/**
 * The property driven at `ROM`: TRUE of the design, and NON-VACUOUS for a specific reason.
 *
 * Proving it requires reasoning about `mem[0]` - the only address at which the disjunction can fail
 * is `addr == 0`, so the proof rests on the `initial` block's first entry surviving the lowering.
 * That is what makes it the right property for a memory design rather than any true property: a
 * consequent over `addr` alone would prove with the memory entirely unread.
 */
const ROM_PROPERTY_TEXT = `${ROM_ADDRESS_PORT} != 8'd0 || ${ROM_DATA_PORT} == ${ROM_ENTRY_ZERO_LITERAL}`;

/** `ROM`'s combinational read, so the design carries no clocked state for a flop to come from. */
const ROM_COMBINATIONAL_READ = 'always @(*)';

/** The `initial` block that pins the four entries, and the reason step 0 is not free. */
const ROM_INITIAL_BLOCK = 'initial begin';

/** The memory pass whose POSITION is claim 2, and the two passes it must sit between. */
const MEMORY_MAP_PASS = 'memory_map -rom-only -keepdc';
const PREP_PASS = 'prep -top';
const ASYNC2SYNC_PASS = 'async2sync';

/** The frontend command that brackets the four passes, and whose `-formal` admits the assertion. */
const FORMAL_FRONTEND = 'read_verilog -sv -formal';

/** The Clock_Contract a design with NO flip-flop cell derives, and the key to criterion 14.40. */
const NO_CLOCKED_STATE_POLARITY = 'none';

/** The Yosys cell the elaborated ROM arrives as, and the one `memory_map` consumes. */
const MEMORY_CELL_TYPE = '$mem_v2';

/**
 * Flip-flop and latch cell types, as a pattern over `write_json`'s own type names.
 *
 * A PATTERN rather than a list, because Yosys spells one flop a dozen ways - `$dff`, `$adff`,
 * `$sdff`, `$dffe`, `$aldffe`, `$dlatch`, `$dlatchsr` - and a list would silently miss the flavour a
 * design actually carries.
 *
 * THE CEILING RUNS IN THE FALSE-PASS DIRECTION, WHICH IS WHY IT IS CONTROLLED RATHER THAN NOTED. It
 * recognises a stateful cell by its NAME, so a cell type spelled without `dff`, `latch`, or a bare
 * `$ff` reads as stateless - and the claim it serves is that the set is EMPTY, so a pattern matching
 * nothing would report every design memory-only. The control is the POST-lowering netlist: the same
 * predicate is asserted NON-empty there, over the `$ff` cells `memory_map` produces, so the empty
 * reading before the pass is measured against a non-empty one after it.
 */
const STATEFUL_CELL_RE = /dff|latch|^\$ff$/;

/** The flip-flop flavour the mapped ROM's UNINITIALISED entries become. MEASURED: 252 of them. */
const MAPPED_ROM_FLOP_TYPE = '$ff';

/** The netlist file names the two `write_json` backends in one Yosys run write to. */
const PRE_LOWERING_NETLIST = 'pre-lowering.json';
const POST_LOWERING_NETLIST = 'post-lowering.json';

/** The worker module holding the pinned Lowering_Sequence, resolved from this file's own location. */
const WORKER_EDA_PATH = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../tools/sandbox/worker/src/tool_runner_worker/eda.py',
);

/**
 * The `YOSYS_FORMAL_SCRIPT` assignment block in the worker's `eda.py`.
 *
 * The ASSIGNMENT and not the whole file, because the four pass names also appear in the module's
 * prose comments - including in a paragraph explaining why each is load-bearing - so an index
 * comparison over the raw text would order comment prose rather than the script.
 */
const YOSYS_FORMAL_SCRIPT_RE = /^YOSYS_FORMAL_SCRIPT = \(([\s\S]*?)\n\)/m;

/** Two source names for composing a script whose text is read rather than run. */
const SCRIPT_PROBE_SOURCES: readonly string[] = ['design.v', PROPERTY_WRAPPER_FILE_NAME];

/** What one elaborated netlist reports: its top-level port directions, and its cell census. */
interface ElaboratedNetlist {
  /** Every top-level port, by name, as `write_json` states its direction. */
  readonly ports: ReadonlyMap<string, string>;
  /** How many cells of each type the module holds. */
  readonly cells: ReadonlyMap<string, number>;
}

/** Both netlists one Yosys run wrote: before the lowering passes, and after all four. */
interface WrapperElaboration {
  readonly yosysExitCode: number | null;
  readonly preLowering: ElaboratedNetlist;
  readonly postLowering: ElaboratedNetlist;
}

/** An EMPTY netlist reading: what a run that produced nothing reports, and it FAILS every assertion. */
const NO_NETLIST: ElaboratedNetlist = { ports: new Map(), cells: new Map() };

/** `ROM`'s combinational property, built through the real validator like every other one here. */
function romProperty(): FormalProperty {
  return combinationalProperty('rom-entry-zero', ROM_PROPERTY_TEXT);
}

/** `mem[0]` rewritten to a different value, at the one site the applied-check pins. */
function mutateRomEntryZero(source: string): string {
  return source.replace(ROM_ENTRY_ZERO_SITE, ROM_ENTRY_ZERO_MUTATED);
}

/**
 * One module's ports and cell census out of a `write_json` document.
 *
 * TOTAL: unreadable or unexpected text yields `NO_NETLIST`, an empty reading that fails every
 * assertion below rather than throwing inside a helper. That is the fail-safe direction - the
 * expectations are over non-empty maps - and it keeps a failure reported as the expectation it is.
 */
function readNetlist(json: string, moduleName: string): ElaboratedNetlist {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(json);
  } catch {
    // Not a silent catch: the only honest reading of unparseable output is that the netlist was not
    // read, and an unread netlist must fail the assertions rather than excuse them.
    return NO_NETLIST;
  }
  const document = parsed as {
    modules?: Record<
      string,
      {
        ports?: Record<string, { direction?: unknown }>;
        cells?: Record<string, { type?: unknown }>;
      }
    >;
  };
  const module = document.modules?.[moduleName];
  if (module === undefined) {
    return NO_NETLIST;
  }
  const ports = new Map<string, string>();
  for (const [name, port] of Object.entries(module.ports ?? {})) {
    ports.set(name, typeof port.direction === 'string' ? port.direction : '');
  }
  const cells = new Map<string, number>();
  for (const cell of Object.values(module.cells ?? {})) {
    const type = typeof cell.type === 'string' ? cell.type : '';
    cells.set(type, (cells.get(type) ?? 0) + 1);
  }
  return { ports, cells };
}

/** Which flip-flop or latch flavours a census holds, sorted. EMPTY is the memory-only finding. */
function statefulCellTypes(netlist: ElaboratedNetlist): readonly string[] {
  return [...netlist.cells.keys()].filter((type) => STATEFUL_CELL_RE.test(type)).sort();
}

/**
 * The Yosys script that elaborates the wrapper and dumps the netlist at BOTH ends of the lowering.
 *
 * The frontend and `prep` are `yosysScript`'s own first two commands and the four passes in the
 * middle are `CORRECT_LOWERING` itself, so the only thing this script does differently is write JSON
 * where the real chain writes SMT2. It is a separate builder rather than a parameter on
 * `yosysScript` because it emits TWO backends and no `write_smt2` at all, and folding both shapes
 * into one function would take a flag that every existing caller would have to pass.
 */
function wrapperNetlistScript(sources: readonly string[]): string {
  return [
    `${FORMAL_FRONTEND} ${sources.join(' ')}`,
    `prep -top ${PROPERTY_WRAPPER_MODULE_NAME} -flatten`,
    `write_json ${PRE_LOWERING_NETLIST}`,
    ...CORRECT_LOWERING,
    `write_json ${POST_LOWERING_NETLIST}`,
  ].join('; ');
}

/**
 * Elaborate one design plus its rendered wrapper, and read both netlists back.
 *
 * ONE Yosys invocation, in a workspace removed in a `finally`, so a failed read cannot leave a
 * temporary tree behind. The wrapper is `renderPropertyWrapper`'s own output under the REFUSED
 * contract the real pre-pass derives for this design, so the port list being read is the one
 * production would hand Yosys.
 */
async function elaborateWrapper(
  design: FormalDesign,
  property: FormalProperty,
): Promise<WrapperElaboration> {
  const workspaceRoot = await createWorkspaceRoot();
  try {
    const wrapper = renderPropertyWrapper(
      design.moduleInterface,
      property,
      PROPERTY_WRAPPER_MODULE_NAME,
      REFUSED_CONTRACT,
    );
    await writeFile(join(workspaceRoot, design.source.path), design.source.contents, 'utf8');
    await writeFile(join(workspaceRoot, PROPERTY_WRAPPER_FILE_NAME), wrapper, 'utf8');
    const script = wrapperNetlistScript([design.source.path, PROPERTY_WRAPPER_FILE_NAME]);
    const yosys = spawnSync('yosys', ['-p', script], { cwd: workspaceRoot, encoding: 'utf8' });
    const read = async (file: string): Promise<ElaboratedNetlist> =>
      readNetlist(await readFile(join(workspaceRoot, file), 'utf8'), PROPERTY_WRAPPER_MODULE_NAME);
    return {
      yosysExitCode: yosys.status,
      preLowering: await read(PRE_LOWERING_NETLIST),
      postLowering: await read(POST_LOWERING_NETLIST),
    };
  } finally {
    await removeWorkspaceRoot(workspaceRoot);
  }
}

/** The pinned `YOSYS_FORMAL_SCRIPT` text from the worker's own source, or `''` where unreadable. */
async function workerLoweringScript(): Promise<string> {
  const source = await readFile(WORKER_EDA_PATH, 'utf8');
  return YOSYS_FORMAL_SCRIPT_RE.exec(source)?.[1] ?? '';
}

/** Where each of the three positioned passes sits in one script, in the order they must run. */
function passPositions(script: string): readonly number[] {
  return [PREP_PASS, MEMORY_MAP_PASS, ASYNC2SYNC_PASS].map((pass) => script.indexOf(pass));
}

/** How many times each of the three positioned passes occurs. `[1, 1, 1]` is one position each. */
function passOccurrences(script: string): readonly number[] {
  return [PREP_PASS, MEMORY_MAP_PASS, ASYNC2SYNC_PASS].map((pass) => occurrences(script, pass));
}

/** The same list sorted ascending, for asserting a position list is strictly in order. */
function ascending(positions: readonly number[]): readonly number[] {
  return [...positions].sort((left, right) => left - right);
}

// -- The pinned position: no toolchain and no corpus --------------------------

describe('the pinned Lowering_Sequence carries the memory pass in its measured position (Req 3.1, 3.3)', () => {
  it('places it AFTER `prep -top <top> -flatten` and BEFORE `async2sync`', () => {
    const script = yosysScript(SCRIPT_PROBE_SOURCES, CORRECT_LOWERING, CORRECT_SMT2);
    const positions = passPositions(script);

    // Each of the three occurs EXACTLY ONCE, so "after" and "before" are claims about one position
    // each - and it is what keeps the ordering assertion honest, because `indexOf` reports -1 for an
    // ABSENT pass and -1 sorts ahead of every real position.
    expect(passOccurrences(script)).toEqual([1, 1, 1]);
    expect(positions).toEqual(ascending(positions));
    // The composed script, not a token list: the frontend and the writer bracket the four passes, so
    // the position asserted above is a position inside a complete lowering.
    expect(script.startsWith(FORMAL_FRONTEND)).toBe(true);
    expect(script).toContain(`write_smt2 -wires ${CORRECT_SMT2}`);
  });

  it('agrees with the WORKER constant every proof in this file is taken under', async () => {
    const pinned = await workerLoweringScript();
    const positions = passPositions(pinned);

    // The assignment was found at all. An empty read would make every position -1 and the ordering
    // assertion vacuous, so this is the guard that keeps the rest a measurement.
    expect(pinned.length).toBeGreaterThan(0);
    expect(passOccurrences(pinned)).toEqual([1, 1, 1]);
    expect(positions).toEqual(ascending(positions));

    // THE MIRROR CHECK, and the reason this test exists rather than restating the worker's own
    // pytest pin: every pass of THIS FILE's `CORRECT_LOWERING` appears in the worker constant, in the
    // SAME RELATIVE ORDER. A worker constant that moved without the mirror would leave task 6.2
    // measuring a chain the proofs are no longer taken under, and nothing else would notice.
    const mirrored = CORRECT_LOWERING.map((pass) => pinned.indexOf(pass));
    expect(mirrored.filter((at) => at < 0)).toEqual([]);
    expect(mirrored).toEqual(ascending(mirrored));
  });
});

// -- The ROM reference's own shape, and the renderer's side: no toolchain -----

describe.skipIf(!CORPUS.available)(
  'the ROM reference is MEMORY-ONLY and its mutant is a single-site edit (Req 3.10)',
  () => {
    let rom: FormalDesign;

    beforeAll(async () => {
      rom = await formalDesign(ROM_PROBLEM_ID);
    });

    it('declares ONE input and ONE output, with no clock and no reset', () => {
      // The partition the netlist claim rests on, as a query against the importer rather than a
      // literal: `addr` is what must become the wrapper's port and `dout` is what must not.
      expect(rom.moduleInterface.ports).toEqual([
        { name: ROM_ADDRESS_PORT, direction: 'input', width: ROM_ADDRESS_WIDTH },
        { name: ROM_DATA_PORT, direction: 'output', width: ROM_DATA_WIDTH },
      ]);
      // No clocking ports, so every wrapper port comes from the design's OWN input list and none is
      // added by the renderer from a `ClockingContract`.
      expect(rom.moduleInterface.clocking.clockName).toBeNull();
      expect(rom.moduleInterface.clocking.resetName).toBeNull();
      // The module name is the one the source declares - no importer rename, the same corpus
      // inconsistency the two dividers carry - so nothing below may spell it.
      expect(rom.source.contents).toContain(`module ${rom.moduleInterface.moduleName}`);
      expect(rom.moduleInterface.moduleName).not.toContain(REFERENCE_PREFIX);
    });

    it('reads its memory COMBINATIONALLY and pins four entries in an `initial` block', () => {
      // The source-side ground truth for the ZERO-flip-flop measurement: a combinational read and no
      // edge-sensitive block at all, so the one cell the elaboration reports is the memory itself.
      expect(rom.source.contents).toContain(ROM_COMBINATIONAL_READ);
      expect(rom.source.contents).not.toContain('posedge');
      expect(rom.source.contents).not.toContain('negedge');
      // And the `initial` block that makes step 0 NON-free, which is why the mutant below is caught
      // with no reset assume and no assertion gate in force.
      expect(rom.source.contents).toContain(ROM_INITIAL_BLOCK);
      expect(occurrences(rom.source.contents, ROM_ENTRY_ZERO_SITE)).toBe(1);
    });

    it('rewrites ENTRY 0 alone, and the edit APPLIES', () => {
      expect(occurrences(rom.source.contents, ROM_ENTRY_ZERO_MUTATED)).toBe(0);

      const mutant = mutateRomEntryZero(rom.source.contents);

      expect(occurrences(mutant, ROM_ENTRY_ZERO_SITE)).toBe(0);
      expect(occurrences(mutant, ROM_ENTRY_ZERO_MUTATED)).toBe(1);
      // One 16-bit literal for another, so the length is unchanged: evidence the edit is the single
      // site and not a wider rewrite that happens to contain it. A transformation that matched
      // NOTHING would leave the clean design in place and the refutation below would then be a
      // verdict about something other than what was asked.
      expect(mutant).toHaveLength(rom.source.contents.length);
      // Entry 1 is untouched, so the mutant differs from the reference at entry 0 and nowhere else in
      // the block the proof reads.
      expect(occurrences(mutant, ROM_ENTRY_ONE_SITE)).toBe(1);
    });

    it('renders a wrapper with NO reset assume and NO `if (!$initstate)` gate (Req 14.41)', () => {
      const rendered = renderPropertyWrapper(
        rom.moduleInterface,
        romProperty(),
        PROPERTY_WRAPPER_MODULE_NAME,
        REFUSED_CONTRACT,
      );

      // Both omissions are what leave the `initial` block's contents VISIBLE at step 0, which is why
      // the mutated entry is caught at all: a gate here would suppress the only sample at
      // `COMBINATIONAL_DEPTH` and report a vacuous pass for the mutant too.
      expect(rendered).not.toContain('assume');
      expect(rendered).not.toContain(INITSTATE_GATE);
      // THE WEAKER, TEXT-LEVEL FORM of the port claim, and it is recorded as weaker: the design's
      // output is declared as an internal wire and the one input as the only port. This does NOT
      // stand in for the netlist assertions below - it is a check on our own template, and it is kept
      // because it is the only form that holds on a host with no toolchain.
      expect(rendered).toContain(`  wire [${ROM_DATA_WIDTH - 1}:0] ${ROM_DATA_PORT};`);
      expect(rendered).toContain(`  input [${ROM_ADDRESS_WIDTH - 1}:0] ${ROM_ADDRESS_PORT}`);
      expect(rendered).not.toContain('output');
    });
  },
);

// -- What Yosys SEES, and the verdicts, over the real toolchain ---------------

describe.skipIf(!RUNNABLE)(
  'the ELABORATED wrapper declares only inputs, and ROM lowers and PROVES (Req 3.1, 3.3, 3.10)',
  () => {
    let real: RealFormalOracle;
    let rom: FormalDesign;
    let elaboration: WrapperElaboration;

    beforeAll(async () => {
      real = realFormalAdapter(FORMAL_PROBE.pythonBin);
      rom = await formalDesign(ROM_PROBLEM_ID);
      elaboration = await elaborateWrapper(rom, romProperty());
    }, MEASUREMENT_TIMEOUT_MS);

    it('declares EVERY top-level port as an INPUT, at BOTH ends of the lowering', () => {
      expect(elaboration.yosysExitCode).toBe(0);

      // THE CLAIM, as one value at each end rather than as a filter over directions: the whole port
      // map is compared, so a port Yosys inferred from somewhere we did not look fails here instead
      // of slipping past a check that only looked at the ones we expected.
      const expected = { [ROM_ADDRESS_PORT]: 'input' };
      expect(Object.fromEntries(elaboration.preLowering.ports)).toEqual(expected);
      expect(Object.fromEntries(elaboration.postLowering.ports)).toEqual(expected);
      // Named separately because it is the failing direction the rule exists for: a wrapper with ANY
      // output port is refuted by ABC for a reason that has nothing to do with the design, and the
      // design's own output is the port that would appear if the renderer's partition inverted.
      expect(elaboration.preLowering.ports.has(ROM_DATA_PORT)).toBe(false);
      expect(elaboration.postLowering.ports.has(ROM_DATA_PORT)).toBe(false);
      expect([...elaboration.postLowering.ports.values()]).toEqual(['input']);
    });

    it('arrives at the memory pass as a MEMORY cell with ZERO flip-flops, and leaves without one', () => {
      // THE MEMORY-ONLY FINDING, and the contradiction of Requirement 14's recorded residual: one
      // memory cell, and no flop or latch of any flavour. This is the netlist the Reset_Contract
      // derivation walks, which is why it reports `clockPolarity: 'none'` for a design that holds
      // state.
      expect(elaboration.preLowering.cells.get(MEMORY_CELL_TYPE)).toBe(1);
      expect(statefulCellTypes(elaboration.preLowering)).toEqual([]);

      // And the pass ACTED: no memory cell survives it. That is the evidence that
      // `memory_map -rom-only -keepdc` is in the chain doing something to THIS design rather than
      // merely spelled in a constant - it replaced the cell with a mux tree, which is the 4258 to
      // 282451 byte growth recorded in the header.
      expect(elaboration.postLowering.cells.has(MEMORY_CELL_TYPE)).toBe(false);
      expect(elaboration.postLowering.cells.size).toBeGreaterThan(
        elaboration.preLowering.cells.size,
      );
      // THE NON-VACUITY CONTROL FOR THE EMPTY SET ABOVE, and it is not optional: `statefulCellTypes`
      // recognises a flop by its NAME, so a pattern matching nothing would report every design
      // memory-only. Here the same predicate returns NON-empty, over the `$ff` cells the 252
      // UNINITIALISED ROM entries became - which is also why this design holds state AFTER the pass
      // and none before it.
      expect(statefulCellTypes(elaboration.postLowering)).toEqual([MAPPED_ROM_FLOP_TYPE]);
    });

    it(
      'is ADMITTED through the no-reset arm, with NOTHING assumed free (Req 14.40)',
      async () => {
        const derived = await derivedContract(real, rom);

        // The measured mechanism behind the residual being benign on this member: the pre-pass finds
        // no flop, so it derives `clockPolarity: 'none'`, REFUSES the reset finding, and criterion
        // 14.40 admits that pairing as a contract requiring no reset. The refused arm reads NO
        // initial-state predicate, so `initialStateFree` is not on this contract to be true - which
        // is the difference between "admitted with a free initial state" and what actually happens.
        expect(derived).toEqual({
          ok: true,
          value: { reset: REFUSED_CONTRACT, clockPolarity: NO_CLOCKED_STATE_POLARITY },
        });
      },
      PROOF_TIMEOUT_MS,
    );

    it(
      'PROVES the entry-0 property under the pinned sequence, memory pass included',
      async () => {
        const result = await prove(real, rom, romProperty());

        expect(verdictOf(result)).toBe('proved');
        // Depth 1 is the whole state space of a design with no clocked state, so no rung sits above
        // it - and reaching a rung at all is criterion 14.40 admitting this design.
        expect(result.depth).toBe(COMBINATIONAL_DEPTH);

        const evidence = evidenceOf(result);
        expect(evidence).not.toBeNull();
        // The SAME assertion count every other case in this file measures, which is what says this
        // proof is not standing on an empty problem: a memory design is the shape most likely to
        // lose its assertions in the lowering, and it did not.
        expect(evidence?.assertionCount).toBe(MEASURED_ASSERTION_COUNT);
        expect(evidence?.presat).toBe('satisfiable');
        expect(evidence?.base).toBe('passed');
        expect(evidence?.cover).toEqual({ reached: 'not-applicable' });
      },
      PROOF_TIMEOUT_MS,
    );

    it(
      'REFUTES a mutated ROM entry, so the pinned contents are VISIBLE at step 0',
      async () => {
        const result = await prove(real, mutated(rom, mutateRomEntryZero), romProperty());

        // NON-VACUITY AND THE RESIDUAL, IN ONE CONTROL. The proof above rests on `mem[0]`, so a wrong
        // entry 0 must be caught - and it is caught with no reset assume and no assertion gate in
        // force, which is what turns "nothing is assumed free on this arm" from an argument about the
        // code into a measured fact about a wrong answer being refused.
        expect(verdictOf(result)).toBe('refuted');
        expect(result.depth).toBe(COMBINATIONAL_DEPTH);
        expect(conditionsOf(result).assertionCount).toBe(MEASURED_ASSERTION_COUNT);

        const trace = counterexampleOf(result);
        expect(trace).not.toBeNull();
        const vcd = trace === null ? null : await real.artifacts.readText(trace);
        expect(vcd).not.toBeNull();

        // The counterexample read for TRUTH rather than for presence, in the wrapper's own scope:
        // `addr` is 0, which is the ONLY address at which this property can fail, and `dout` there is
        // NOT the entry the property names. MEASURED: `addr = 0`, `dout = 16'h1234`, the mutated
        // value. The assertion is `not the named entry` rather than the exact mutant value, because
        // what makes the trace a real witness is the property being violated at that address.
        const model = stepZeroModel(vcd ?? '');
        expect(signalValue(model, ROM_ADDRESS_PORT)).toBe(0);
        expect(signalValue(model, ROM_DATA_PORT)).not.toBe(ROM_ENTRY_ZERO_VALUE);
      },
      PROOF_TIMEOUT_MS,
    );
  },
);
// ============================================================================
// Task 6.13: the `CLK_POLARITY` PARSE and the FREE-INITIAL-STATE READ, against
// what the REAL tool wrote
// ============================================================================
//
// This is the CLOCK-POLARITY half of what the task 6.10 group does for the RESET polarity, and both
// halves rest on one property of the tool: `write_json` spells a polarity parameter at whatever width
// the internal constant happened to carry, so a compare against `"1"` reads a 32-character `...0001`
// as NOT one. The two halves differ in what that costs. On the reset side a misread flips ONE FIELD,
// `resetActiveLow`, and the wrapper then carries an inverted assume. On the clock side it changes the
// VERDICT outright, because `posedge` is the only clocked member the Clock_Contract admits and
// `negedge` refuses, so a misread turns a supported design into `clock-contract-unsupported` before
// any solver runs.
//
// ---------------------------------------------------------------------------------------------
// WHAT WAS MEASURED, AND THE TWO POSEDGE ROWS ARE THE LOAD-BEARING ONES
// ---------------------------------------------------------------------------------------------
//   Yosys 0.66 (git 7f8fdfd8), under `YOSYS_PREPASS_SCRIPT`'s OWN sequence and no other -
//   `read_verilog -sv <source>; prep -top <top> -flatten; opt_dff -sat` - reading `CLK_POLARITY` off
//   `write_json`. `prep -top <top>` and never `-auto-top`: the script names the top module, and
//   earlier probes that used `-auto-top` agreed on these designs while not running what the worker
//   runs.
//
//     | design          | raw `CLK_POLARITY`                 | cells | Clock_Contract |
//     |-----------------|------------------------------------|-------|----------------|
//     | `counter_12`    | `00000000000000000000000000000001` | 1     | **posedge**    |
//     | `radix2_div`    | `00000000000000000000000000000001` | 12    | **posedge**    |
//     | `freq_divbyodd` | bare `1` x2 and bare `0` x2        | 4     | **mixed**      |
//
//   BOTH POSEDGE ROWS SPELL THE VALUE AS 32 CHARACTERS ENDING IN `1`, and that is what makes them a
//   test of the PARSE rather than of the corpus. Substitute `== "1"` for `int(v, 2)` and both read as
//   NOT posedge, the worker's `_derived_clock_polarity` then sees `{0}` and reports `negedge`, and the
//   derivation refuses a UNIFORMLY POSEDGE design with `clock-contract-unsupported`. The two rows
//   below are written so that substitution FAILS them.
//
//   THE TWO ROWS ARE NOT ONE CLAIM TWICE. `counter_12` carries ONE clocked cell, so it is the minimal
//   row: exactly one value has to be read correctly. `radix2_div` carries TWELVE (`$sdff` x1,
//   `$sdffe` x9, `$sdffce` x1, `$dffe` x1), so ALL TWELVE have to read 1 or the distinct set is not
//   `{1}` and the finding is `mixed` rather than `posedge`. A parse that got one cell of twelve wrong
//   fails the second row and passes the first.
//
//   THE RAW SPELLING IS NOT READABLE AT THIS SEAM, which is why it is recorded above as an
//   out-of-band anchor rather than asserted. The worker parses `CLK_POLARITY` before it writes
//   anything, so `formal-prepass-report.json` carries the DERIVED member and never the string it came
//   from. The observable here is therefore the member, and the anchor is what explains why the member
//   moves under substitution.
//
//   WHY THIS EARNS ITS PLACE AT ALL, which is the task's own reason and is about the corpus rather
//   than about these three designs: only 2 of the 50 references are mixed-edge. A `CLK_POLARITY`
//   string compare is INVISIBLE on the other 46 that elaborate - it reads a uniformly posedge design
//   as uniformly negedge, which refuses it, and a suite that never asserted the member would see a
//   refusal it had no expectation for. So the trap passes the whole corpus silently unless something
//   asserts the member on a 32-character row, and these two rows are that something.
//
// ---------------------------------------------------------------------------------------------
// `freq_divbyodd` IS NOT PARSE COVERAGE, AND SAYING SO IS PART OF THE TASK
// ---------------------------------------------------------------------------------------------
//   MEASURED on the same netlist read: this design's `CLK_POLARITY` is ONE CHARACTER WIDE - bare `1`
//   and bare `0` - while `ARST_POLARITY` on the VERY SAME `$adff` cells is 32 characters. So a string
//   compare reads the bare `1` cells as posedge correctly and the bare `0` cells as not-posedge
//   correctly, still derives `mixed`, and still refuses. The design whose refusal the base-2 parse
//   exists to protect is itself IMMUNE to the string-compare trap
//   (`chipAgent/_inbox/gotcha-the-two-mixed-edge-dividers-are-immune-to-the-clk-polarity-string-
//   compare-trap.md`).
//
//   IT IS HERE AS THE THIRD VOCABULARY MEMBER REACHED AGAINST THE REAL TOOL, and that is a different
//   claim from the parse. `posedge` is reached by the two rows above, `none` by the `verified_ROM`
//   case in the task 6.12 group, and `mixed` here - three of the four members of `CLOCK_POLARITIES`
//   produced by the real worker rather than by a fixture. The fourth, `negedge`, is measured EMPTY
//   across all 50 references, so no design in this corpus can reach it.
//
// ---------------------------------------------------------------------------------------------
// THE FREE-INITIAL-STATE READ, BOTH DIRECTIONS, AND THE SINGLE INVOCATION IS THE POINT
// ---------------------------------------------------------------------------------------------
//   | design     | initial-state predicate, MEASURED    | `initialStateFree` |
//   |------------|--------------------------------------|--------------------|
//   | `counter_12` | literally `true`                   | **true**           |
//   | `bad_init`   | `(= (\|counter_12#1\| state) #b1111)` | **false**          |
//
//   ONE PRE-PASS SUBMISSION PER DESIGN, AND THE SINGLE INVOCATION IS THE CLAIM RATHER THAN AN
//   OPTIMISATION. Criterion 14.21 requires the `write_smt2` that emits the predicate to run IN THE
//   SAME INVOCATION as the `write_json` the polarity walk reads, so a test that took the predicate
//   from one run and the polarity from another would assert the two facts and NOT the criterion. The
//   report text is therefore read ONCE per design and BOTH readers are applied to that one text:
//   `parseFormalPrepassReport` for the predicate, which only the wire document carries, and
//   `readFormalPrepassReport` for the fact, which only the derived contract carries. The pre-pass is
//   measured at roughly 0.7s over all 48 elaborating references, so nothing here is saving time.
//
//   `bad_init` IS TASK 6.9'S OWN FIXTURE, reused rather than duplicated. Its `initial out = 4'd15;`
//   is the one line that pins step 0, and a second fixture would be a second thing to keep in step
//   with the interface the wrapper is rendered from.
//
//   ONE MEASURED DISAGREEMENT WITH THE TASK'S OWN DESCRIPTION, recorded because it is a fact about
//   the tool. The task predicted `bad_init`'s predicate would open `(and `. It opens `(= `: this
//   fixture initialises ONE register, so `write_smt2` emits ONE equality and has nothing to conjoin.
//   `(and ` is the shape for two or more initialised registers. The direction that matters is
//   unchanged and is what is asserted - the body is not `true`, so the initial state is NOT free -
//   and the assertion below reads the pinned VALUE out of the predicate rather than its opening
//   token, which is the same discipline task 6.3 applies to a counterexample: checked for what it
//   says, not for being present.
//
// ---------------------------------------------------------------------------------------------
// WHAT GROUP 6 NOW LEAVES UNCOVERED AT THE WORKER SEAM, read off the code rather than restated
// ---------------------------------------------------------------------------------------------
//   The task's last bullet says these two halves leave "the `formalPrepass` kind dispatching and the
//   report parse against a report the REAL worker wrote" without real-toolchain cover. THAT IS NO
//   LONGER ACCURATE, and the accurate version is worth more than the restatement.
//
//   BOTH OF THOSE ARE ALREADY COVERED, and were before this group. `derivedContract` in the task 6.10
//   group and `prepassDocument` here both submit an `assembleFormalPrepassJob` through the SAME
//   `SandboxToolRunner` the oracle uses, which dispatches the `formalPrepass` KIND to the real Python
//   worker, and both read the registered `formalPrepassReport` back through the adapter's OWN parse.
//   So the dispatch and the parse-against-a-real-report are measured. What THIS group closes is the
//   last two derived FIELDS: `clockPolarity` at three of its four members, and `initialStateFree` in
//   both directions. With task 6.10's reset name, polarity, and kind, every field of a
//   `FormalPrepassReport` is now asserted against a report the real worker wrote.
//
//   WHAT ACTUALLY REMAINS, and none of it is a parse or a dispatch:
//     1. THE PRODUCTION ISOLATION WRAPPER. Every run in this file goes through `LocalWorkerRuntime`
//        rather than the gVisor `RunscSandboxRuntime` production uses, and
//        `sandbox-containment.integration.test.ts` drives the `simulate` kind only, so no test has
//        ever run a `formalPrepass` job under `runsc`.
//     2. THE PRE-PASS JOB'S OWN CONTAINMENT. Task 6.7 extends Property 24's four caps, denied
//        network, and no-secret-mounted rule to the `formalPrepass` job, and task 6.7 is unstarted.
//     3. EVERY UNREADABLE-REPORT PATH. `report-too-large`, `not-json`, and `schema-violation` are
//        refusals over a document a REAL worker never writes, and the absent-report path needs an
//        unreadable netlist or an unreadable polarity, which no elaborating reference produces. They
//        are asserted over generated text by `formal-reset-contract-derivation.property.test.ts`,
//        which is the only place they are reachable.
//     4. THE `negedge` MEMBER, empty across the corpus as recorded above.
//
// ---------------------------------------------------------------------------------------------
// WHAT THIS GROUP DOES NOT ADD, so a reader does not take it for an omission
// ---------------------------------------------------------------------------------------------
//   NO TOOLCHAIN-FREE COMPANION GROUP, unlike tasks 6.9 to 6.12, and there is nothing left for one to
//   assert: `bad_init`'s sync-reset shape and its one defect line are asserted by the task 6.9 group,
//   `radix2_div`'s active-high source ground truth by the task 6.10 group, and `freq_divbyodd`'s
//   both-edges-of-one-clock shape and its cell counts by the task 6.11 group. A fourth group would
//   restate those.
//
//   NO `prove` CALL. All three designs are decided at the pre-pass, so no wrapper is rendered and no
//   solver runs; `freq_divbyodd`'s end-to-end `could-not-verify` verdict is the task 6.11 group's
//   assertion and is strictly stronger than a report-level reading of the same refusal. These tests
//   are nonetheless gated on `FORMAL_PROBE` like everything else in this file, which is the cost of
//   one skip mechanism that the task 6.11 header already records.
//
// ---------------------------------------------------------------------------------------------
// WHAT THE SHIMMED RUN MEASURED, since an only-ever-skipping test is indistinguishable from a wrong
// one
// ---------------------------------------------------------------------------------------------
//   All four cases below ran GREEN end to end under a temporary bitwuzla flag shim, which was then
//   deleted and is not in the repo. The three Clock_Contract members came back as the table records
//   them, both predicates came back as the second table records them, and the two derived contracts
//   matched `COUNTER_DERIVED_CONTRACT` and the task 6.9 group's `PINNED_SYNC_CONTRACT` field for
//   field - so neither constant needed changing to agree with the tool.
//
//   AND THE PARSE WAS MUTATED AND PUT BACK, as tasks 6.10 and 6.12 both did, because a test written
//   to fail under substitution is worth only what a run proves. Replacing the worker's
//   `_polarity_bit` with `== "1"` and running this file: both posedge rows FAILED, reporting
//   `negedge` where the table says `posedge`, and `freq_divbyodd` still reported `mixed` and still
//   refused - exactly the immunity recorded above. The worker was restored byte-clean and the file
//   re-run green.
//
// _Requirements: 14.21, 14.22, 14.28, 14.29, 14.36_

/**
 * The `mixed` Clock_Contract member, TYPED rather than left a bare string.
 *
 * `ClockPolarity` is the closed four-member vocabulary, so the annotation is what pins this literal
 * to it: a misspelling, or a member removed from `CLOCK_POLARITIES`, fails to COMPILE here instead
 * of failing as a string mismatch at run time. The two other members this file reaches are
 * `DERIVED_CLOCK_POLARITY` (task 6.10) and `NO_CLOCKED_STATE_POLARITY` (task 6.12), reused below
 * rather than respelled.
 */
const MIXED_CLOCK_POLARITY: ClockPolarity = 'mixed';

/** The counter's ONE output port, whose step-0 value the `bad_init` predicate pins. */
const COUNTER_OUTPUT_PORT = 'out';

/**
 * The bit literal the REAL predicate pins `out` to for `bad_init`. MEASURED: `#b1111`.
 *
 * The anchor, cross-checked below against the SAME value derived from `BAD_INIT_VALUE` at the
 * design's own declared `out` width - so the assertion is a query against the fixture and the
 * interface rather than a literal agreeing with itself.
 */
const BAD_INIT_PINNED_LITERAL = '#b1111';

/** The token a PINNED predicate opens with, MEASURED: one equality, and nothing to conjoin. */
const PINNED_PREDICATE_OPENER = '(= ';

/**
 * `freq_divbyodd`'s reset finding as the WORKER WROTE IT: derived, async, active-LOW on `rst_n`.
 *
 * One field shorter than a `ResetContract` because the WIRE shape carries no `initialStateFree`: the
 * worker hands the predicate's text across and the TypeScript side reads it. On this design that read
 * never happens, because the clock check refuses first - which is exactly why this finding has to be
 * asserted off the DOCUMENT and cannot be read off a derived contract.
 */
const DIVIDER_RESET_FINDING = {
  derived: true,
  resetName: RESET_NET_NAME,
  resetActiveLow: true,
  resetKind: 'async',
};

/**
 * One wire document minus its timing finding, for the whole-document equality below.
 *
 * Field by field rather than by rest-destructuring, and the `Omit` return type is what keeps it
 * honest: a FIFTH wire field fails to compile here rather than silently dropping out of an equality
 * that reads as if it covered the whole document.
 */
function withoutTiming(document: FormalPrepassDocument): Omit<FormalPrepassDocument, 'timing'> {
  return {
    reset: document.reset,
    clockPolarity: document.clockPolarity,
    initialStatePredicate: document.initialStatePredicate,
  };
}

/** One parsed document's `clockPolarity`, or `''` where the document could not be read at all. */
function clockPolarityOf(document: Result<FormalPrepassDocument, FormalPrepassRejection>): string {
  return document.ok ? document.value.clockPolarity : '';
}

/**
 * One parsed document's initial-state predicate, or `''` where it was absent or unreadable.
 *
 * `''` is fail-safe in both directions here, which is why it is the right empty value: it is not
 * `FREE_INITIAL_STATE_PREDICATE`, so the free direction FAILS on it, and it contains no bit literal,
 * so the pinned direction fails too. The worker already `.strip()`s the body it hands across; the
 * trim here is the same rule `readFreeInitialState` applies before comparing, not a second one.
 */
function initialStatePredicateOf(
  document: Result<FormalPrepassDocument, FormalPrepassRejection>,
): string {
  return document.ok ? (document.value.initialStatePredicate ?? '').trim() : '';
}

/**
 * `BAD_INIT_VALUE` as an SMT2 bit literal at the DESIGN's own declared `out` width, or `''`.
 *
 * `''` rather than a bare `#b1111` where the port is missing, because `toContain('')` passes on every
 * string: an empty literal would make the pinned-value assertion vacuous, which is the one failure
 * shape this file exists to refuse. The value is cross-checked against the measured anchor below, so
 * the two have to agree before either is used.
 */
function pinnedStepZeroLiteral(design: FormalDesign): string {
  const width =
    design.moduleInterface.ports.find((port) => port.name === COUNTER_OUTPUT_PORT)?.width ?? 0;
  return width === 0 ? '' : `#b${BAD_INIT_VALUE.toString(2).padStart(width, '0')}`;
}

// -- The three Clock_Contract cases and both predicates, over the real toolchain --

describe.skipIf(!RUNNABLE)(
  'the REAL pre-pass derives the Clock_Contract and reads the free initial state (Req 14.21, 14.22, 14.28, 14.29, 14.36)',
  () => {
    let counter: FormalDesign;
    /**
     * `counter_12`'s report text, read ONCE: its predicate and its derived fact come off this run.
     *
     * The text rather than either reader's output, because criterion 14.21 is a claim about ONE
     * invocation producing both - see the header. `''` fails every assertion below, so a `beforeAll`
     * that submitted nothing cannot report this group green.
     */
    let counterReport = '';
    /** `bad_init`'s report text, read ONCE, for the same reason. */
    let badInitReport = '';
    /**
     * The two designs whose DERIVED side is not what is being read, initialised to a REFUSAL.
     *
     * `parseFormalPrepassReport('')` is `{ ok: false }`, so an unassigned reading fails rather than
     * passing, and the type is the reader's own without a `null` to narrow at every use.
     */
    let radix2Document = parseFormalPrepassReport('');
    let divbyoddDocument = parseFormalPrepassReport('');

    beforeAll(async () => {
      const real = realFormalAdapter(FORMAL_PROBE.pythonBin);
      counter = await formalDesign(COUNTER_PROBLEM_ID);
      counterReport = await prepassReportText(real, counter);
      badInitReport = await prepassReportText(real, constructedDesign(counter, BAD_INIT_SOURCE));
      radix2Document = await prepassDocument(real, await formalDesign(RADIX2_DIV_PROBLEM_ID));
      divbyoddDocument = await prepassDocument(real, await formalDesign(FREQ_DIVBYODD_PROBLEM_ID));
    }, PROOF_TIMEOUT_MS);

    it('derives posedge over ONE cell and over TWELVE, and mixed over both edges of one clock', () => {
      // THE PARSE ASSERTION, as one expectation keyed by problem id so a failure names WHICH design
      // moved rather than reporting that two objects differ. Both `posedge` rows are read from a raw
      // `CLK_POLARITY` spelled as 32 characters ending in `1`, so a `== "1"` compare reports
      // `negedge` for both and this expectation is what fails - see the header for the measurement
      // that says it does. `freq_divbyodd` is the third VOCABULARY member and not a parse row: its
      // value is one character wide and a string compare still derives `mixed`.
      expect({
        [COUNTER_PROBLEM_ID]: clockPolarityOf(parseFormalPrepassReport(counterReport)),
        [RADIX2_DIV_PROBLEM_ID]: clockPolarityOf(radix2Document),
        [FREQ_DIVBYODD_PROBLEM_ID]: clockPolarityOf(divbyoddDocument),
      }).toEqual({
        [COUNTER_PROBLEM_ID]: DERIVED_CLOCK_POLARITY,
        [RADIX2_DIV_PROBLEM_ID]: DERIVED_CLOCK_POLARITY,
        [FREQ_DIVBYODD_PROBLEM_ID]: MIXED_CLOCK_POLARITY,
      });
      // Three of the four members reached against the real tool in this file, with the fourth named:
      // `none` is the task 6.12 `verified_ROM` case, and `negedge` is the measured-empty class no
      // reference can produce. Stated as a non-equality so the two supported members cannot both be
      // whatever a broken derivation defaulted to.
      expect(MIXED_CLOCK_POLARITY).not.toBe(DERIVED_CLOCK_POLARITY);
      expect(MIXED_CLOCK_POLARITY).not.toBe(NO_CLOCKED_STATE_POLARITY);
    });

    it('reports the mixed design with its RESET derived, so the CLOCK alone refuses it', () => {
      // THE WHOLE WIRE DOCUMENT AS ONE VALUE, which is what makes the attribution rather than the
      // polarity field alone: this design's reset derives CLEANLY - one retained net, one polarity,
      // async - and its initial-state predicate is the FREE one, so neither of the other two
      // refusals applies and `mixed` is the only reason `readFormalPrepassReport` refuses it. The
      // task 6.11 header records that reset as prose; this is the assertion.
      //
      // The document's fourth field is OMITTED from the equality rather than pinned: what this
      // design's cone walk derives is a claim the Ground_Truth cross-check owns
      // (timing-contract-inference Req 6.12), and a value spelled here that nobody read off the
      // reference source would be a second, unmeasured owner of it.
      expect(divbyoddDocument.ok && withoutTiming(divbyoddDocument.value)).toEqual({
        reset: DIVIDER_RESET_FINDING,
        clockPolarity: MIXED_CLOCK_POLARITY,
        initialStatePredicate: FREE_INITIAL_STATE_PREDICATE,
      });
    });

    it('reads counter_12 as FREE from a predicate that is literally `true`', () => {
      // THE PREDICATE ITSELF, before the rule is applied to it. The corpus design carries no
      // `initial` block, so no register contributes an equality and the body `write_smt2` emitted is
      // nothing but SMT-LIB's own literal - compared against the constant that OWNS that rule
      // (Req 14.22) rather than against a `'true'` spelled here, so the two cannot drift.
      expect(initialStatePredicateOf(parseFormalPrepassReport(counterReport))).toBe(
        FREE_INITIAL_STATE_PREDICATE,
      );

      // And the FACT, from the SAME report text, through the adapter's OWN composition:
      // `initialStateFree` lives on the derived member alone, so this is the only channel carrying
      // it. The expectation deliberately repeats the task 6.10 group's - the CONTRACT is the same
      // one - because what is new here is that the predicate above and this fact come from ONE
      // invocation, which is the criterion rather than an economy.
      expect(readFormalPrepassReport(counterReport)).toEqual({
        ok: true,
        value: { reset: COUNTER_DERIVED_CONTRACT, clockPolarity: DERIVED_CLOCK_POLARITY },
      });
    });

    it('reads bad_init as NOT free from a predicate that PINS out to the initial value', () => {
      const predicate = initialStatePredicateOf(parseFormalPrepassReport(badInitReport));

      // The other direction, and NOT merely "differs from `true`": the predicate is checked for what
      // it SAYS. The literal is derived from `BAD_INIT_VALUE` at the design's own declared `out`
      // width and cross-checked against the measured anchor, so a helper that returned `''` - which
      // `toContain` would accept from any string - fails on the first line instead of passing
      // vacuously on the second.
      expect(predicate).not.toBe(FREE_INITIAL_STATE_PREDICATE);
      expect(pinnedStepZeroLiteral(counter)).toBe(BAD_INIT_PINNED_LITERAL);
      expect(predicate).toContain(BAD_INIT_PINNED_LITERAL);
      // The MEASURED opening token, recorded as an assertion because the task predicted `(and `:
      // ONE initialised register yields ONE equality and nothing to conjoin. See the header.
      expect(predicate.startsWith(PINNED_PREDICATE_OPENER)).toBe(true);

      // The FACT, from the same one invocation: `initialStateFree: false` on task 6.9's own
      // `PINNED_SYNC_CONTRACT`, which the real pre-pass derives field for field. That contract is
      // what WITHHOLDS the `if (!$initstate)` gate, and the gate is what turned this fixture's
      // detected defect into a proof in the measurement task 6.9 records - so this is the pre-pass
      // side of that control, read off the tool rather than constructed for the renderer.
      expect(readFormalPrepassReport(badInitReport)).toEqual({
        ok: true,
        value: { reset: PINNED_SYNC_CONTRACT, clockPolarity: DERIVED_CLOCK_POLARITY },
      });
    });
  },
);
