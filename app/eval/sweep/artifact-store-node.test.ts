// Unit tests for the Node-backed artifact store, against real files in a real temp directory.
//
// WHAT THESE PIN DOWN (Req 12.16, 12.25)
//   1. A sample whose capture carries a Counterexample TRACE gets `counterexample.vcd`, byte for
//      byte those bytes, listed in `outcome.json`. A sample carrying no capture gets no trace
//      file and no note - which is every proof and every sample of a run with the formal gate
//      off, whose directory stays exactly what the store wrote before a trace could reach it.
//   2. EVERY WAY A REFUTED SAMPLE CAN LACK ITS TRACE LEAVES A NOTE: the oracle's three refusals
//      (`over-cap`, `unresolved`, `read-failed`), the loop's `malformed-reference` marker, and
//      the store's own refusal of bytes that are not the whole trace its reference names - each
//      gets NO trace file and exactly ONE sanitized note, while the rest of the capture and the
//      reference itself still land.
//   3. A trace write that fails leaves no partial file behind, under either name.
//   4. END TO END FROM THE CAPTURE (Req 12.15, 12.16): a provenance run through
//      `captureSampleArtifacts` and then this store yields `property-wrapper.v`, holding the
//      DECIDING result's wrapper, for every sample whose deciding result carries one, and
//      `counterexample.vcd` exactly when that result is `refuted` and its trace arrived whole.
//      A sample no formal run decided gets neither. Points 1-3 hand the store artifacts built by
//      hand, so without this nothing joins the capture's choice to what lands on disk.
//
// The store resolves nothing: the bytes arrive on the capture, read where the refuting run
// ended, so every case here is driven by a capture built in exactly one way. The bytes still
// cross a port, which is why the two cases the WRITER decides - over the cap, and not the
// digest the reference names - are driven as well as the four the capture reports.

import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { NO_FORMAL_RUN, NO_REPAIR, type FormalProvenance } from '@app/agent';
import {
  admitProved,
  type ArtifactBlobRef,
  type ProofConditions,
  type PropertyResult,
} from '@app/tools';

import {
  captureSampleArtifacts,
  MAX_COUNTEREXAMPLE_TRACE_BYTES,
  type CapturedCounterexample,
  type CapturedOutcome,
  type CapturedText,
  type EvalArtifactDescriptor,
  type EvalSampleArtifacts,
} from '../artifact-sink.js';
import type { SampleResult } from '../report.js';
import {
  ARTIFACT_FILENAMES,
  artifactSampleSegments,
  encodeArtifactDocument,
  planArtifactFiles,
  type ArtifactDocument,
} from './artifact-layout.js';
import { FileSystemArtifactStore } from './artifact-store-node.js';

/** The arm every sample here is written under. */
const ARM = 'kimi-k2_5';

/** The one sample every test writes. */
const DESCRIPTOR: EvalArtifactDescriptor = {
  problemId: 'rtllm/control/counter_12',
  sampleIndex: 0,
  seed: 1_234,
};

/** The sample's directory, as segments under the run directory. */
const SAMPLE_SEGMENTS = artifactSampleSegments(ARM, DESCRIPTOR.problemId, DESCRIPTOR.sampleIndex);

/** The sample's path, as a note names it. */
const SAMPLE_PATH = SAMPLE_SEGMENTS.join('/');

/** A small trace in the shape `yosys-smtbmc --dump-vcd` writes: header, scope nesting, step 0. */
const TRACE = [
  '$timescale 1ns $end',
  '$scope module formal_property_wrapper $end',
  '$var wire 4 ! out $end',
  '$upscope $end',
  '$enddefinitions $end',
  '#0',
  'b1101 !',
  '',
].join('\n');

/** The worker's name for the base case's trace, which the reference keeps. */
const TRACE_NAME = 'formal-trace-base-bitwuzla.vcd';

/** One byte more than the trace's own cap. */
const OVERSIZED = 'x'.repeat(MAX_COUNTEREXAMPLE_TRACE_BYTES + 1);

/** Lowercase hex SHA-256 of a text's UTF-8 bytes, the digest an `ArtifactBlobRef` carries. */
function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** The reference the worker registers for a trace of exactly these bytes. */
function referenceFor(trace: string): ArtifactBlobRef {
  return { name: TRACE_NAME, sizeBytes: Buffer.byteLength(trace, 'utf8'), sha256: sha256(trace) };
}

/**
 * The capture a faithful oracle hands over for a trace it read whole.
 *
 * Typed as the TRACE arm alone, not the whole union, so one helper serves both seams: it is what
 * the Verification_Loop records on a provenance and what the sink hands this store.
 */
function carrying(trace: string): Extract<CapturedCounterexample, { kind: 'trace' }> {
  return { kind: 'trace', reference: referenceFor(trace), trace };
}

/** A captured text that was not truncated. */
function whole(text: string): CapturedText {
  return { text, truncated: false, originalChars: text.length, keptEnd: 'head' };
}

/** A refuted formal sample's artifacts; each test overrides exactly the part it is about. */
function refutedSample(overrides: Partial<EvalSampleArtifacts> = {}): EvalSampleArtifacts {
  return {
    outcomeStatus: 'unverified',
    passed: false,
    iterations: 1,
    stopReason: null,
    failureNote: null,
    candidateRtl: whole('module counter_12(input clk, output [3:0] out); endmodule\n'),
    testbenchSource: null,
    simulation: null,
    failingCase: null,
    runFailureCause: null,
    attributedFiles: [],
    rejectedTestbenchDraft: null,
    missingCheckNamesTruncated: false,
    missingCheckNames: [],
    goldenVerdict: null,
    instrumentVerdict: { validity: 'unchecked', reason: 'control-absent' },
    controlStdout: null,
    controlStderr: null,
    controlExitCode: null,
    mutation: null,
    repairProvenance: NO_REPAIR,
    rejectedPreRepairTestbench: null,
    repairHint: null,
    precheckDiagnostic: null,
    repairDeclineReason: null,
    checkNameVisibilitySignal: false,
    preNormalizationTestbench: null,
    normalizerReport: null,
    normalizerReportFindingsTruncated: false,
    propertyWrapperSource: null,
    formalAssertionCount: 1,
    formalCounterexample: referenceFor(TRACE),
    formalCounterexampleCapture: carrying(TRACE),
    ...overrides,
  };
}

/** The sample the harness measured; its verdict fields are copied verbatim and not under test. */
const MEASURED: SampleResult = {
  sampleIndex: DESCRIPTOR.sampleIndex,
  seed: DESCRIPTOR.seed,
  passed: false,
  outcomeStatus: 'unverified',
  failureNote: null,
  noVerdictCause: null,
  iterations: 1,
  costCents: 0,
  promptTokens: 0,
  completionTokens: 0,
  totalTokens: 0,
  unreportedUsageCalls: 0,
  stopReason: null,
  goldenVerdict: null,
  instrumentVerdict: { validity: 'unchecked', reason: 'control-absent' },
  mutationProbe: null,
  propertySetAdmitted: 'not-gated',
  propertySetAuthoredUpFront: false,
  // No gate ran, so there is no calibrated population to tally.
  formalMutationCounts: null,
  propertySetSurvivorCount: 0,
  repairProvenance: NO_REPAIR,
  formal: NO_FORMAL_RUN,
  checkNameVisibilitySignal: false,
  checkingApproach: 'cycle-timed',
  testbenchParseRefusal: null,
  // No testbench source is captured for this sample, so none was measured.
  valuelessFailureReports: null,
  positiveControlRun: null,
  designGroup: 'cycle-exact',
};

/** Five Proof_Conditions that all admit, over one assertion. */
const ADMITTING: ProofConditions = {
  assertionCount: 1,
  presat: 'satisfiable',
  cover: { reached: 'not-applicable' },
  base: 'passed',
  induction: 'successful',
};

/** A `proved` result, its evidence built by `admitProved`, the sole constructor of one. */
function provedResult(criterionRef: string): PropertyResult {
  const evidence = admitProved(ADMITTING);
  if (typeof evidence === 'string') {
    throw new Error(`the fixture's own conditions were refused: ${evidence}`);
  }
  return { verdict: 'proved', evidence, depth: 20, elapsedMs: 10, criterionRef };
}

/** A `refuted` result: a failed base case, reported with the reference `TRACE` hashes to. */
function refutedResult(criterionRef: string): PropertyResult {
  return {
    verdict: 'refuted',
    counterexample: referenceFor(TRACE),
    conditions: { ...ADMITTING, base: 'failed', induction: 'not-run' },
    depth: 20,
    elapsedMs: 10,
    criterionRef,
  };
}

/** A `could-not-verify` result whose Property_Time_Budget ran out. */
function couldNotVerifyResult(criterionRef: string): PropertyResult {
  return {
    verdict: 'could-not-verify',
    cause: 'proof-timeout',
    conditions: { ...ADMITTING, induction: 'not-run' },
    depth: 20,
    elapsedMs: 150_000,
    criterionRef,
    diagnostic: null,
    crossCheckDisagreed: false,
  };
}

/** A pre-pass refusal: no invocation ran, so every check is `not-run` and no wrapper exists. */
function prepassRefusedResult(criterionRef: string): PropertyResult {
  return {
    verdict: 'could-not-verify',
    cause: 'reset-contract-unresolved',
    conditions: {
      assertionCount: 0,
      presat: 'not-run',
      cover: { reached: 'not-applicable' },
      base: 'not-run',
      induction: 'not-run',
    },
    depth: 0,
    elapsedMs: 10,
    criterionRef,
    diagnostic: null,
    crossCheckDisagreed: false,
  };
}

/** The wrapper source the oracle submitted for one criterion; distinct per criterion. */
function wrapperFor(criterionRef: string): string {
  return `module formal_property_wrapper(input clk);\n  // ${criterionRef}\nendmodule\n`;
}

/**
 * A provenance over these results, with each wrapper AND each capture paired by index.
 *
 * A refuted result carries the trace its own run read; every other result carries `null`,
 * which is the shape the Verification_Loop records.
 */
function provenanceOf(results: readonly PropertyResult[]): FormalProvenance {
  return {
    ...NO_FORMAL_RUN,
    results,
    propertyWrapperSources: results.map((result) => wrapperFor(result.criterionRef)),
    counterexampleCaptures: results.map((result) =>
      result.verdict === 'refuted' ? carrying(TRACE) : null,
    ),
  };
}

/**
 * One sample's artifacts as the harness derives them from a measured provenance of `formal`.
 *
 * The outcome carries the same provenance because the harness copies it from there, and nothing
 * else, because nothing else on it is under test; the capture reads `measured.formal`.
 */
function capturedFrom(formal: FormalProvenance): EvalSampleArtifacts {
  const outcome = { status: 'unverified', formal } as unknown as CapturedOutcome;
  return captureSampleArtifacts({ outcome, measured: { ...MEASURED, formal }, control: null });
}

describe('FileSystemArtifactStore - the Counterexample trace (Req 12.16, 12.25)', () => {
  let outputDir = '';
  let notes: string[] = [];

  beforeEach(async () => {
    outputDir = await mkdtemp(join(tmpdir(), 'artifact-store-test-'));
    notes = [];
  });

  afterEach(async () => {
    await rm(outputDir, { recursive: true, force: true });
  });

  /** Write the one sample through a store built the one way there is to build it. */
  async function capture(artifacts: EvalSampleArtifacts): Promise<void> {
    const store = new FileSystemArtifactStore({
      outputDir,
      onNote: (note) => {
        notes.push(note);
      },
    });
    await store.sinkFor(ARM).write(DESCRIPTOR, artifacts);
  }

  /** The sample's own directory. */
  function sampleDir(): string {
    return join(outputDir, ...SAMPLE_SEGMENTS);
  }

  /** The names the sample's directory holds, sorted, so a stray staging file cannot hide. */
  async function listed(): Promise<readonly string[]> {
    return (await readdir(sampleDir())).sort();
  }

  /** One file of the sample's directory, as text. */
  function read(filename: string): Promise<string> {
    return readFile(join(sampleDir(), filename), 'utf8');
  }

  /** The sample's parsed `outcome.json`. */
  async function outcomeDocument(): Promise<ArtifactDocument> {
    const raw: unknown = JSON.parse(await read(ARTIFACT_FILENAMES.outcome));
    return raw as ArtifactDocument;
  }

  it('writes counterexample.vcd byte for byte for a sample carrying a trace, and indexes it', async () => {
    await capture(refutedSample());

    expect(await read(ARTIFACT_FILENAMES.counterexampleTrace)).toBe(TRACE);
    const document = await outcomeDocument();
    expect(document.formalCounterexample).toEqual(referenceFor(TRACE));
    expect(document.files[ARTIFACT_FILENAMES.counterexampleTrace]).toEqual({
      truncated: false,
      originalChars: TRACE.length,
    });
    // The trace is the ONE file added beside the planned ones, and no staging name survives.
    expect(await listed()).toEqual(
      [
        ARTIFACT_FILENAMES.candidateRtl,
        ARTIFACT_FILENAMES.counterexampleTrace,
        ARTIFACT_FILENAMES.outcome,
      ].sort(),
    );
    expect(notes).toEqual([]);
  });

  it('writes a trace of exactly the cap whole, because the cap is a ceiling and not a cut', async () => {
    const atCap = TRACE.padEnd(MAX_COUNTEREXAMPLE_TRACE_BYTES, ' ');

    await capture(
      refutedSample({
        formalCounterexample: referenceFor(atCap),
        formalCounterexampleCapture: carrying(atCap),
      }),
    );

    expect(await read(ARTIFACT_FILENAMES.counterexampleTrace)).toBe(atCap);
    expect(notes).toEqual([]);
  });

  it('writes no trace and notes nothing for a sample carrying no capture', async () => {
    await capture(refutedSample({ formalCounterexampleCapture: null }));

    expect(await listed()).toEqual(
      [ARTIFACT_FILENAMES.candidateRtl, ARTIFACT_FILENAMES.outcome].sort(),
    );
    expect(notes).toEqual([]);
  });

  it('with neither a capture nor a reference - every sample of a gate-off run - writes exactly what it wrote before', async () => {
    const artifacts = refutedSample({
      formalCounterexample: null,
      formalCounterexampleCapture: null,
      formalAssertionCount: null,
    });
    const files = planArtifactFiles(artifacts);

    await capture(artifacts);

    // Exactly the pure plan and its index, byte for byte, which is all this store wrote before
    // a trace could reach it: the gate-off path has nothing new to do and does nothing new.
    expect(await listed()).toEqual(
      [...files.map((file) => file.filename), ARTIFACT_FILENAMES.outcome].sort(),
    );
    for (const file of files) {
      expect(await read(file.filename)).toBe(file.contents);
    }
    expect(await read(ARTIFACT_FILENAMES.outcome)).toBe(
      encodeArtifactDocument(DESCRIPTOR, artifacts, files),
    );
    expect(notes).toEqual([]);
  });

  /** One way a refuted sample can lack its trace, and the words its note must carry. */
  interface RefusalRow {
    readonly name: string;
    /** The reference the sample records, which stays in the index either way. */
    readonly reference: ArtifactBlobRef;
    /** The capture handed to the store. */
    readonly capture: CapturedCounterexample;
    /** The words of the note that say WHY no trace was written. */
    readonly reason: string;
  }

  // All five reasons, exhausted rather than sampled: four the capture reports and one the writer
  // decides. A row missing here is a refuted sample that loses its evidence in silence.
  const REFUSALS: readonly RefusalRow[] = [
    {
      // What an evicted trace, or one the run never retained, looks like from the oracle's read.
      name: 'the oracle could not resolve its bytes',
      reference: referenceFor(TRACE),
      capture: { kind: 'absent', reason: 'unresolved' },
      reason: 'its bytes could not be resolved',
    },
    {
      name: "the oracle's read of its bytes failed",
      reference: referenceFor(TRACE),
      capture: { kind: 'absent', reason: 'read-failed' },
      reason: 'reading its bytes failed',
    },
    {
      name: 'the trace was over the cap where it was read',
      reference: referenceFor(OVERSIZED),
      capture: { kind: 'absent', reason: 'over-cap' },
      reason: `exceeds its ${MAX_COUNTEREXAMPLE_TRACE_BYTES}-byte cap`,
    },
    {
      // The loop's marker: the recorded locator is not a usable reference, so nothing can find
      // the trace by it. This is the case that used to leave no file AND no note.
      name: 'no usable reference was recorded for it',
      reference: referenceFor(TRACE),
      capture: { kind: 'absent', reason: 'malformed-reference' },
      reason: 'no usable reference was recorded to locate it by',
    },
    {
      // The capture carries bytes, so ONLY the writer's own cap stands between them and the disk.
      name: 'the bytes carried are over the cap',
      reference: referenceFor(OVERSIZED),
      capture: { kind: 'trace', reference: referenceFor(OVERSIZED), trace: OVERSIZED },
      reason: `exceeds its ${MAX_COUNTEREXAMPLE_TRACE_BYTES}-byte cap`,
    },
    {
      // A head-truncating carrier: a VCD missing its step-0 value, which is the cut trace this
      // store exists never to write. Only the digest can tell it from the whole one.
      name: 'the bytes carried are not the trace the reference names',
      reference: referenceFor(TRACE),
      capture: {
        kind: 'trace',
        reference: referenceFor(TRACE),
        trace: TRACE.slice(0, TRACE.indexOf('#0')),
      },
      reason: 'not the whole trace its reference names',
    },
  ];

  it.each(REFUSALS)(
    'writes no trace and ONE sanitized note when $name',
    async ({ reference, capture: carried, reason }) => {
      await capture(
        refutedSample({ formalCounterexample: reference, formalCounterexampleCapture: carried }),
      );

      // No trace file, while the rest of the capture still lands: the index keeps the reference,
      // so an absent trace beside it reads as "these bytes are gone", not as "never produced".
      expect(await listed()).toEqual(
        [ARTIFACT_FILENAMES.candidateRtl, ARTIFACT_FILENAMES.outcome].sort(),
      );
      const document = await outcomeDocument();
      expect(document.formalCounterexample).toEqual(reference);
      expect(Object.keys(document.files)).not.toContain(ARTIFACT_FILENAMES.counterexampleTrace);
      // ONE note, naming the sample and the reason, and nothing the operator must not see.
      expect(notes).toHaveLength(1);
      const note = notes[0] ?? '';
      expect(note).toContain(`${ARTIFACT_FILENAMES.counterexampleTrace} for ${SAMPLE_PATH}`);
      expect(note).toContain(reason);
      expect(note).not.toContain(outputDir);
      expect(note).not.toContain(reference.sha256);
    },
  );

  it('leaves no partial trace under either name when the trace write itself fails', async () => {
    // A directory squatting on the final name makes the rename fail AFTER the staged bytes are
    // fully written, which is the moment a partial or orphaned trace would be left behind.
    const squatter = join(sampleDir(), ARTIFACT_FILENAMES.counterexampleTrace);
    await mkdir(squatter, { recursive: true });

    await capture(refutedSample());

    // No trace bytes anywhere: the final name is still the empty squatter, no staging name
    // survives, and no index claims a capture that did not complete.
    expect(await readdir(squatter)).toEqual([]);
    expect(await listed()).toEqual(
      [ARTIFACT_FILENAMES.candidateRtl, ARTIFACT_FILENAMES.counterexampleTrace].sort(),
    );
    // The same one note every failed write already gets, with no path or errno in it.
    expect(notes).toEqual([
      `artifacts for ${SAMPLE_PATH} could not be written; the sample's verdict stands`,
    ]);
  });

  it('never writes the final name directly: a trace that cannot be staged is not written', async () => {
    // A write that fails PARTWAY cannot be injected against a real filesystem, and behaviour on
    // success cannot tell a staged write from a direct one. So this pins the mechanism the
    // guarantee rests on: the bytes reach `counterexample.vcd` only by renaming a fully written
    // staging copy. A direct write would ignore the squatter below and land the trace anyway.
    const staging = join(sampleDir(), `${ARTIFACT_FILENAMES.counterexampleTrace}.partial`);
    await mkdir(staging, { recursive: true });

    await capture(refutedSample());

    expect(await listed()).toEqual(
      [ARTIFACT_FILENAMES.candidateRtl, `${ARTIFACT_FILENAMES.counterexampleTrace}.partial`].sort(),
    );
    // The squatter is left as it was: the cleanup removes a staged FILE and never a directory.
    expect(await readdir(staging)).toEqual([]);
    expect(notes).toEqual([
      `artifacts for ${SAMPLE_PATH} could not be written; the sample's verdict stands`,
    ]);
  });

  /** One measured provenance, and every file its sample's directory must hold beside the index. */
  interface DecidedRow {
    readonly name: string;
    readonly formal: FormalProvenance;
    /** Each file and its exact bytes; a formal file absent here must be absent on disk. */
    readonly files: Readonly<Record<string, string>>;
    /** The words of the one note this sample must leave, or `null` for no note at all. */
    readonly noteReason: string | null;
  }

  // The three verdicts are exhausted rather than sampled, because the claim is per member of a
  // closed union. One mixed set puts the refutation LAST, so a capture that read the first result
  // would write `ac-1`'s wrapper and no trace, and "deciding" is not just "only".
  const DECIDED: readonly DecidedRow[] = [
    {
      name: 'a proved result decides: its wrapper and no trace',
      formal: provenanceOf([provedResult('ac-1')]),
      files: { [ARTIFACT_FILENAMES.propertyWrapper]: wrapperFor('ac-1') },
      noteReason: null,
    },
    {
      name: 'a could-not-verify result decides: its wrapper and no trace',
      formal: provenanceOf([couldNotVerifyResult('ac-1')]),
      files: { [ARTIFACT_FILENAMES.propertyWrapper]: wrapperFor('ac-1') },
      noteReason: null,
    },
    {
      name: 'a refuted result decides: its wrapper and the trace',
      formal: provenanceOf([refutedResult('ac-1')]),
      files: {
        [ARTIFACT_FILENAMES.propertyWrapper]: wrapperFor('ac-1'),
        [ARTIFACT_FILENAMES.counterexampleTrace]: TRACE,
      },
      noteReason: null,
    },
    {
      name: 'a refutation submitted after a proof and a could-not-verify decides: its wrapper and the trace',
      formal: provenanceOf([
        provedResult('ac-1'),
        couldNotVerifyResult('ac-2'),
        refutedResult('ac-3'),
      ]),
      files: {
        [ARTIFACT_FILENAMES.propertyWrapper]: wrapperFor('ac-3'),
        [ARTIFACT_FILENAMES.counterexampleTrace]: TRACE,
      },
      noteReason: null,
    },
    {
      // The marker the Verification_Loop mints for a refutation whose locator is unusable. The
      // wrapper still lands, so the absence of the trace beside it is the only thing in question.
      name: 'the deciding refutation recorded the malformed-reference marker: the wrapper, no trace, one note',
      formal: {
        ...provenanceOf([refutedResult('ac-1')]),
        counterexampleCaptures: [{ kind: 'malformed-reference' }],
      },
      files: { [ARTIFACT_FILENAMES.propertyWrapper]: wrapperFor('ac-1') },
      noteReason: 'no usable reference was recorded to locate it by',
    },
    {
      // A capture list that cannot be paired with the results by index: the capture refuses to
      // hand one property's waveform to another, and says so rather than falling silent.
      name: 'the capture list cannot be paired with the results: the wrapper, no trace, one note',
      formal: { ...provenanceOf([refutedResult('ac-1')]), counterexampleCaptures: [] },
      files: { [ARTIFACT_FILENAMES.propertyWrapper]: wrapperFor('ac-1') },
      noteReason: 'no usable reference was recorded to locate it by',
    },
    {
      // The oracle ran and its pre-pass refused, so no wrapper was ever built to persist.
      name: 'the deciding result had no wrapper rendered: neither file',
      formal: { ...provenanceOf([prepassRefusedResult('ac-1')]), propertyWrapperSources: [null] },
      files: {},
      noteReason: null,
    },
    {
      name: 'no formal run decided the sample: neither file',
      formal: NO_FORMAL_RUN,
      files: {},
      noteReason: null,
    },
  ];

  it.each(DECIDED)('from the capture, $name', async ({ formal, files, noteReason }) => {
    await capture(capturedFrom(formal));

    // Exactly these files and the index, so an absent wrapper or trace is asserted, not assumed.
    expect(await listed()).toEqual([...Object.keys(files), ARTIFACT_FILENAMES.outcome].sort());
    for (const [filename, contents] of Object.entries(files)) {
      expect(await read(filename), filename).toBe(contents);
    }
    if (noteReason === null) {
      expect(notes).toEqual([]);
      return;
    }
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain(noteReason);
  });
});
