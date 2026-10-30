// THE GATE: the Legacy_Byte_Identity_Check's byte comparison over all 46 scored corpus
// designs (stimulus-transaction-structure, C7, task 5.1).
//
// WHY THIS IS THE FIRST GATE
//   The 20-of-46 RTLLM designs already always verified under CONSENSUS_HARNESS_VERSION 3 earn
//   nothing from this feature; they only risk losing it. Every renderer edit this feature makes
//   (C1 through C5) must leave a Legacy_Interface's rendered text untouched, bit for bit. This
//   suite is the only thing standing between "the renderer still does what it did" and a silent
//   regression of those 20 designs, so nothing from pass 4 onward is believed until this reports
//   zero differing bytes for all 46 (Req 5.6, 5.7).
//
// ANTI-CIRCULARITY: ONE SHARED REQUEST BUILDER, NEVER TWO
//   `legacyGoldenRequestFor`/`renderLegacyGoldenDesign` (task 1.1's `legacy-byte-identity.ts`)
//   are imported here UNCHANGED, the same functions the capture CLI used to write the committed
//   golden files. A second, independently written request-builder could drift from the first
//   without either copy being wrong on its own, and that drift would be indistinguishable, from
//   the diff output alone, from a real renderer regression - see the vault's verification-recipe
//   note on this exact pattern (`chipAgent/_inbox/verification-recipe-capture-the-pre-edit-...`).
//
// WHY INTEGRATION TIER WITH NO REAL TOOLCHAIN PROBE
//   This reads the fetched RTLLM checkout, which is absent on a fresh clone (`npm run
//   corpus:fetch` materializes it) - that is the one thing this suite skips on. It needs no
//   `iverilog`: `renderLegacyGoldenDesign` renders TEXT from a `FixedTimingDerivation` stand-in,
//   never a real toolchain, which is why task 1.1's capture needed no Yosys either.
//
// STOP, DO NOT FIX
//   On any non-zero differing byte count, this reports the design, the first differing byte's
//   offset, and the Input_Role resolved from it - never silently regenerates the golden corpus.
//   Regenerating it to make this pass would erase the one thing it exists to catch.

import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { EvalProblem } from '../problem.js';
import { FileSystemCorpusCheckout } from './checkout-port.js';
import { RTLLM_CHECKOUT_PATH } from './fetch-node.js';
import { importRtllmCorpus } from './import.js';
import {
  legacyGoldenFileName,
  legacyRoleDeclarationFor,
  renderLegacyGoldenDesign,
} from './legacy-byte-identity.js';
import { LEGACY_GOLDEN_FIXTURE_DIR } from './legacy-golden-capture-cli.js';
import { RTLLM_PINNED_COMMIT } from './pinned-source.js';
import { RTLLM_SCORED_DESIGN_COUNT, scoredRtllmCorpus } from './stage0-quarantine.js';
import { FixedTimingDerivation } from './timing-derivation-double.js';
import { packedPortSlices, type InputRole } from '@app/tools';

// -- Corpus availability probe, the only capability this suite needs ------------------------

/** Whether the pinned RTLLM checkout is present, and why not when it is absent. */
interface CorpusProbe {
  readonly available: boolean;
  readonly reason: string;
}

/** Probe for the fetched checkout the same read-only way the importer reads it. */
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

if (!CORPUS.available) {
  // This gate not running is not silent: Req 5.6's byte comparison was NOT exercised in this
  // environment, so nothing downstream of it should be trusted as re-verified here either.
  console.warn(`[legacy-byte-identity-comparison] GATE NOT EXERCISED: ${CORPUS.reason}.`);
}

// -- Fixture location --------------------------------------------------------------------------

/** This module's own directory; tests always run from source, never the built `dist` layout. */
const HERE = dirname(fileURLToPath(import.meta.url));
/** Three levels up from `app/eval/corpus/` reaches the repository root. */
const REPOSITORY_ROOT = resolve(HERE, '..', '..', '..');
/** Where task 1.1 committed the pre-edit golden corpus. */
const FIXTURE_DIR = join(REPOSITORY_ROOT, LEGACY_GOLDEN_FIXTURE_DIR);

/** Generous for 46 pure-text renders and file reads; no toolchain is spawned. */
const TEST_TIMEOUT_MS = 60_000;

// -- Byte diff -------------------------------------------------------------------------------

/** One byte-level diff outcome between the committed golden text and today's render. */
interface ByteDiff {
  readonly differingByteCount: number;
  /** `null` exactly when `differingByteCount` is 0. */
  readonly firstDifferingOffset: number | null;
}

/**
 * Byte-for-byte diff of `golden` against `actual`. A length difference counts every extra
 * trailing byte as one more differing byte; when the shared prefix matches but the lengths
 * differ, the first difference is where the shorter buffer's content runs out.
 */
function diffBytes(golden: Buffer, actual: Buffer): ByteDiff {
  const sharedLength = Math.min(golden.length, actual.length);
  let differingByteCount = Math.abs(golden.length - actual.length);
  let firstDifferingOffset: number | null = null;
  for (let offset = 0; offset < sharedLength; offset += 1) {
    if (golden[offset] !== actual[offset]) {
      differingByteCount += 1;
      firstDifferingOffset ??= offset;
    }
  }
  if (firstDifferingOffset === null && differingByteCount > 0) {
    firstDifferingOffset = sharedLength;
  }
  return { differingByteCount, firstDifferingOffset };
}

// -- Resolving the differing offset to an Input_Role, via packedPortSlices -------------------

/**
 * The exact line every input port renders regardless of role: unpacking its own
 * `packedPortSlices` slice off the shared `ece_in_bits` register (consensus-harness.ts, "Pack
 * the input bundle onto the harness's own wires"). Matching the FULL line, not just the bit
 * range, is what keeps this from cross-resolving to an unrelated port or an output slice that
 * happens to share the same bit numbers.
 */
function inputUnpackLine(portName: string, high: number, low: number): string {
  return `  assign ${portName} = ece_in_bits[${String(high)}:${String(low)}];`;
}

/** The line spanning byte offset `offset` in `text`, or `null` when `offset` is out of range. */
function lineSpanning(text: string, offset: number): string | null {
  if (offset < 0 || offset >= text.length) {
    return null;
  }
  let cursor = 0;
  for (const line of text.split('\n')) {
    const end = cursor + line.length;
    if (offset <= end) {
      return line;
    }
    cursor = end + 1;
  }
  return null;
}

/**
 * The Input_Role of the port whose own `packedPortSlices` line spans byte `offset`, per
 * criterion 5.7. Reads whichever of `actualText`/`goldenText` actually has content at `offset`
 * (the two renders can differ in length, so only the longer one has anything there).
 */
function inputRoleAtOffset(
  problem: EvalProblem,
  actualText: string,
  goldenText: string,
  offset: number,
): { readonly portName: string; readonly role: InputRole } | null {
  const text = offset < actualText.length ? actualText : goldenText;
  const line = lineSpanning(text, offset);
  if (line === null) {
    return null;
  }
  const inputPorts = problem.spec.moduleInterface.ports.filter(
    (port) => port.direction === 'input',
  );
  const roles = legacyRoleDeclarationFor(problem.spec.moduleInterface);
  const slice = packedPortSlices(inputPorts).find(
    (candidate) => line === inputUnpackLine(candidate.name, candidate.high, candidate.low),
  );
  if (slice === undefined) {
    return null;
  }
  const role = roles.find((entry) => entry.portName === slice.name)?.role ?? 'data';
  return { portName: slice.name, role };
}

/** The actionable, per-design diagnosis criterion 5.7 requires: id, offset, Input_Role. */
function describeMismatch(
  problem: EvalProblem,
  actualText: string,
  goldenText: string,
  diff: ByteDiff,
): string {
  const resolved =
    diff.firstDifferingOffset === null
      ? null
      : inputRoleAtOffset(problem, actualText, goldenText, diff.firstDifferingOffset);
  const roleText =
    resolved === null
      ? 'unresolved (no packedPortSlices input-unpack line spans this offset)'
      : `${resolved.role} (port "${resolved.portName}")`;
  return (
    `${problem.id}: ${String(diff.differingByteCount)} differing byte(s), first at offset ` +
    `${String(diff.firstDifferingOffset)}, Input_Role ${roleText}`
  );
}

// -- Tests -----------------------------------------------------------------------------------

describe('Legacy_Byte_Identity_Check capability probe', () => {
  it('documents whether the committed golden corpus was compared in this environment', () => {
    // Always runs, so a skip below is never a silent "0 assertions, exit 0".
    expect(typeof CORPUS.available).toBe('boolean');
    expect(CORPUS.reason.length).toBeGreaterThan(0);
  });
});

describe.skipIf(!CORPUS.available)(
  'Legacy_Byte_Identity_Check: all 46 scored designs against the committed golden corpus',
  () => {
    it(
      "renders byte-identical text to CONSENSUS_HARNESS_VERSION 3's committed golden corpus, for every scored design",
      async () => {
        const corpus = await importRtllmCorpus(
          new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH),
          new FixedTimingDerivation('registered'),
        );
        const scored = scoredRtllmCorpus(corpus).problems;
        // Task 1.1's capture CLI already refuses a count drift at capture time; this guard
        // catches a drift introduced since, so this gate fails loudly rather than silently
        // comparing a differently-sized population than the one it claims to exhaust.
        expect(scored).toHaveLength(RTLLM_SCORED_DESIGN_COUNT);

        const failures: string[] = [];
        for (const problem of scored) {
          const golden = await readFile(join(FIXTURE_DIR, legacyGoldenFileName(problem.id)));
          const actualText = renderLegacyGoldenDesign(problem).contents;
          const diff = diffBytes(golden, Buffer.from(actualText, 'utf8'));
          if (diff.differingByteCount > 0) {
            failures.push(describeMismatch(problem, actualText, golden.toString('utf8'), diff));
          }
        }

        // One assertion over the full exhausted sweep: a non-empty array both fails the gate
        // and prints every design's id/offset/Input_Role diagnosis in the same failure.
        expect(failures).toEqual([]);
      },
      TEST_TIMEOUT_MS,
    );
  },
);
