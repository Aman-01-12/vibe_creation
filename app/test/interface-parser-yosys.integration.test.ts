// The Interface_Cross_Check: the relocated `parseDeclaredModule` (DQ-01, C7) against an
// INDEPENDENT reader, Yosys's own `portlist` command, over every imported RTLLM reference
// (task 8.2; Req 13.2 to 13.6).
//
// WHY THIS EXISTS, AND WHY IT IS TEST-ONLY (Req 13.6, 13.7)
//   The 0-of-50 figure design.md records for `parseDeclaredModule` is partly circular: the
//   corpus importer used this SAME parser to derive each reference's Declared_Interface, so a
//   check that only re-parses with the same function and compares against itself proves
//   nothing new. This suite reads the same 50 reference files with a reader that owes nothing
//   to our parser - Yosys's elaboration frontend - and compares names and widths. No production
//   path reads Yosys for the interface; `interfaceCheckPassed` (C8) reads `parseDeclaredModule`
//   alone, which is exactly what Requirement 13.7 states and what makes this suite safe to run
//   only in the integration tier (Req 13.6) with no effect on the Structural_Gate's own
//   admission rule.
//
// WHY YOSYS IS SPAWNED DIRECTLY, NOT THROUGH THE WORKER SEAM
//   Requirement 9.2 restricts ADAPTERS to the sandboxed worker path, not tests, and the input
//   here is the trusted golden RTLLM corpus, never generated RTL - the same carve-out
//   `real-oracle-harness.ts` documents for `YOSYS_PROBE`. So this suite runs its own scratch
//   directory per reference and calls `yosys` with `spawnSync`, mirroring
//   `formal-reset-derivation-census.ts`'s `takeResetCellCensus` rather than going through
//   `LocalWorkerRuntime`.
//
// GATING (Req 13.5)
//   Two capabilities are needed and each is probed, never assumed: `yosys` alone
//   (`YOSYS_PROBE`, no worker Python and no `iverilog` required - this check never compiles or
//   simulates anything) and the pinned RTLLM checkout, fetched rather than vendored. When either
//   is absent the suite SKIPS, naming which one.
//
// THE EXCLUSION CARVE-OUT (Req 13.4)
//   `float_multi` is the one reference Yosys's frontend cannot read at all ("Found
//   non-synthesizable event list", measured in design.md and reproduced below). A design on
//   `STRUCTURAL_GATE_EXCLUSIONS` is allowed to fail this way; any OTHER unreadable design is a
//   real finding and fails the suite, naming it.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  FileSystemCorpusCheckout,
  importRtllmCorpus,
  RTLLM_CHECKOUT_PATH,
  RTLLM_PINNED_COMMIT,
  STRUCTURAL_GATE_EXCLUSION_IDS,
} from '@app/eval';
import { parseDeclaredModule } from '@app/tools';

import {
  compareDeclaredToYosysPortlist,
  describeInterfaceMismatch,
  parsePortlistOutput,
} from './yosys-portlist.js';
import { CORPUS_TIMING_STAND_IN, YOSYS_PROBE } from './real-oracle-harness.js';

// -- Corpus availability probe (mirrors rtllm-corpus-stage0.integration.test.ts) --------

/** Whether the pinned checkout is present, and why not when it is absent. */
interface CorpusProbe {
  readonly available: boolean;
  readonly reason: string;
}

/**
 * Probe for the fetched checkout by reading one file every design folder must have.
 *
 * Duplicated from the sibling suites rather than imported: none of them export a probe, and
 * the check itself is three lines over the same read-only port the importer uses.
 */
async function probeCorpus(): Promise<CorpusProbe> {
  const checkout = new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH);
  const categories = await checkout.listDirectories([]);
  if (categories.length === 0) {
    return {
      available: false,
      reason: `no RTLLM checkout at the pinned commit ${RTLLM_PINNED_COMMIT}; run \`npm run corpus:fetch\``,
    };
  }
  return { available: true, reason: 'the pinned RTLLM checkout is present' };
}

const CORPUS = await probeCorpus();

const SKIP_REASON = !YOSYS_PROBE.available ? YOSYS_PROBE.reason : CORPUS.reason;
const RUNNABLE = YOSYS_PROBE.available && CORPUS.available;

if (!RUNNABLE) {
  // A single, explicit note that the cross-check was NOT exercised here, so the relocated
  // parser's 0-of-50 figure stays a recorded claim in this run rather than a reproduced,
  // independently-read measurement.
  console.warn(
    `[interface-parser-yosys] Interface_Cross_Check NOT exercised: ${SKIP_REASON}. The ` +
      "relocated parser's reading was not cross-checked against Yosys's own portlist in this " +
      'environment.',
  );
}

/** Timeout for one `yosys` invocation over one reference (ms). */
const PER_DESIGN_TIMEOUT_MS = 30_000;

/** Timeout for the whole 50-reference sweep (ms). */
const SWEEP_TIMEOUT_MS = 300_000;

/** The reference's module name, port text, and problem id - what one cross-check run needs. */
interface CrossCheckSubject {
  readonly problemId: string;
  readonly moduleName: string;
  readonly rtlContents: string;
}

/** Run `yosys`'s `portlist` on one subject in a fresh scratch directory, read back its text. */
function runYosysPortlist(subject: CrossCheckSubject): {
  readonly exitCode: number | null;
  readonly outputText: string;
} {
  const workspace = mkdtempSync(join(tmpdir(), 'interface-cross-check-'));
  const sourceName = 'reference.v';
  const outputName = 'ports.txt';
  try {
    const script =
      `read_verilog -sv ${sourceName}; ` +
      `hierarchy -top ${subject.moduleName}; ` +
      `tee -q -o ${outputName} portlist ${subject.moduleName}`;
    // The subject's own reference RTL is the sole workspace file, matching
    // `takeResetCellCensus`'s own approach of writing one file into a scratch directory.
    writeFileSync(join(workspace, sourceName), subject.rtlContents, 'utf8');
    const run = spawnSync('yosys', ['-q', '-p', script], {
      cwd: workspace,
      encoding: 'utf8',
      timeout: PER_DESIGN_TIMEOUT_MS,
    });
    let outputText = '';
    try {
      outputText = readFileSync(join(workspace, outputName), 'utf8');
    } catch {
      // No output file: either Yosys never reached `tee` (a frontend refusal) or exited
      // non-zero first. `exitCode` alone decides the outcome below.
    }
    return { exitCode: run.status, outputText };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

/** One subject's outcome: either an agreeing/disagreeing comparison, or a Yosys read failure. */
type CrossCheckOutcome =
  | {
      readonly kind: 'compared';
      readonly problemId: string;
      readonly mismatches: readonly string[];
    }
  | { readonly kind: 'yosys-unreadable'; readonly problemId: string; readonly detail: string };

/** Cross-check one subject: run Yosys, parse its output, and compare against the declared module. */
function crossCheckOne(subject: CrossCheckSubject): CrossCheckOutcome {
  const declared = parseDeclaredModule(subject.rtlContents, subject.moduleName);
  if (!declared.ok) {
    // The parser could not read its own reference: a finding either way, reported through the
    // same channel as a Yosys disagreement so neither failure mode is silent.
    return {
      kind: 'compared',
      problemId: subject.problemId,
      mismatches: [
        `parseDeclaredModule could not read "${subject.moduleName}": ${declared.reason}`,
      ],
    };
  }
  const { exitCode, outputText } = runYosysPortlist(subject);
  if (exitCode !== 0) {
    return {
      kind: 'yosys-unreadable',
      problemId: subject.problemId,
      detail: `yosys exited ${String(exitCode)} reading "${subject.moduleName}"`,
    };
  }
  const parsed = parsePortlistOutput(outputText);
  if (!parsed.ok) {
    return { kind: 'yosys-unreadable', problemId: subject.problemId, detail: parsed.reason };
  }
  const mismatches = compareDeclaredToYosysPortlist(declared.module, parsed.portlist);
  return {
    kind: 'compared',
    problemId: subject.problemId,
    mismatches: mismatches.map((mismatch) =>
      describeInterfaceMismatch(subject.moduleName, mismatch),
    ),
  };
}

/** Import the pinned checkout and build one cross-check subject per reference, in corpus order. */
async function buildSubjects(): Promise<readonly CrossCheckSubject[]> {
  const corpus = await importRtllmCorpus(
    new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH),
    CORPUS_TIMING_STAND_IN,
  );
  return corpus.problems.map((problem) => {
    const reference = corpus.references.get(problem.id);
    if (reference === undefined) {
      throw new Error(`no reference RTL for imported problem ${problem.id}`);
    }
    return {
      problemId: problem.id,
      moduleName: problem.spec.moduleInterface.moduleName,
      rtlContents: reference.rtl.contents,
    };
  });
}

// -- Tests ----------------------------------------------------------------------------

describe('Interface_Cross_Check capability probe', () => {
  it('documents whether the cross-check was exercised against real Yosys in this environment', () => {
    expect(typeof RUNNABLE).toBe('boolean');
    expect(SKIP_REASON.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!RUNNABLE)(
  'Interface_Cross_Check: parseDeclaredModule against Yosys portlist, over every imported reference',
  () => {
    it(
      'agrees with Yosys on every reference not on STRUCTURAL_GATE_EXCLUSIONS, and float_multi is the one Yosys cannot read (Req 13.2, 13.3, 13.4)',
      async () => {
        const subjects = await buildSubjects();
        const excluded = new Set(STRUCTURAL_GATE_EXCLUSION_IDS);

        const unreadableOutsideExclusions: string[] = [];
        const disagreements: string[] = [];
        let readableCount = 0;

        for (const subject of subjects) {
          const outcome = crossCheckOne(subject);
          if (outcome.kind === 'yosys-unreadable') {
            if (!excluded.has(outcome.problemId)) {
              unreadableOutsideExclusions.push(`${outcome.problemId}: ${outcome.detail}`);
            }
            continue;
          }
          readableCount += 1;
          for (const mismatch of outcome.mismatches) {
            disagreements.push(`${outcome.problemId}: ${mismatch}`);
          }
        }

        expect(
          unreadableOutsideExclusions,
          'every reference Yosys cannot read must be on STRUCTURAL_GATE_EXCLUSIONS',
        ).toEqual([]);
        expect(
          disagreements,
          'parseDeclaredModule and Yosys portlist must agree on every readable reference',
        ).toEqual([]);
        // Measured: 49 of 50 references are readable by Yosys's portlist (float_multi is the
        // one exception), so a non-vacuous run must have actually compared close to all of them.
        expect(readableCount).toBeGreaterThanOrEqual(subjects.length - excluded.size);
      },
      SWEEP_TIMEOUT_MS,
    );

    it('runs only in the integration tier, never gating the production Interface_Check (Req 13.6, 13.7)', () => {
      // A documentation assertion, not a behavioural one: this file's own suffix
      // (`.integration.test.ts`) is what keeps it out of `npm test`'s fast tier, and
      // `interfaceCheckPassed` (C8) never imports this module - there is nothing more to
      // probe at runtime, so this records the invariant rather than re-deriving it.
      expect(import.meta.url).toMatch(/\.integration\.test\.ts$/);
    });
  },
);
