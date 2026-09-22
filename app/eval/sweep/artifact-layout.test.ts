// Unit tests for the per-sample artifact layout: pure, no disk.
//
// WHAT THESE PIN DOWN
//   1. A problem id is not a path. Ids contain `/`, so they are reduced to ONE segment, and
//      a traversal attempt stays inside the run directory - asserted by resolving the joined
//      path, not by trusting the sanitizer's charset.
//   2. An ABSENT artifact produces no file. A `blocked` or `setup-failed` sample never had
//      RTL, and an empty `candidate.v` would read as "the model wrote nothing".
//   3. A TRUNCATED artifact says so in its first line, with the kept end named, so a cut
//      Verilog source is never mistaken for a model that stopped mid-module.
//   4. `outcome.json` carries the verdict fields and the check verdicts, lists exactly the
//      files that exist, and does not repeat the stream text that sits beside it.

import { isAbsolute, join, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { NO_REPAIR } from '@app/agent';

import type {
  CapturedSimulation,
  CapturedText,
  EvalArtifactDescriptor,
  EvalSampleArtifacts,
} from '../artifact-sink.js';
import {
  ARTIFACT_DOCUMENT_SCHEMA_VERSION,
  ARTIFACT_FILENAMES,
  ARTIFACTS_DIRNAME,
  artifactDocument,
  artifactSampleSegments,
  encodeArtifactDocument,
  planArtifactFiles,
  safePathSegment,
} from './artifact-layout.js';

/** A run output directory, as the CLI resolves one. */
const RUN_DIR = resolve('/tmp/eval-runs/bakeoff-v1');

/** A captured text that was not truncated. */
function whole(text: string, keptEnd: 'head' | 'tail' = 'head'): CapturedText {
  return { text, truncated: false, originalChars: text.length, keptEnd };
}

/** A captured text that WAS truncated, keeping the named end. */
function cut(text: string, originalChars: number, keptEnd: 'head' | 'tail'): CapturedText {
  return { text, truncated: true, originalChars, keptEnd };
}

/** The oracle evidence of a failing run. */
function simulation(overrides: Partial<CapturedSimulation> = {}): CapturedSimulation {
  return {
    verdict: 'fail',
    checks: [
      { name: 'reset_clears_output', passed: true },
      { name: 'shift_by_three', passed: false },
    ],
    checksTruncated: false,
    exitCode: 1,
    stdout: whole('CHECK shift_by_three FAIL\n', 'tail'),
    stderr: null,
    ...overrides,
  };
}

/** One sample's artifacts; each test overrides exactly the part it is about. */
function artifacts(overrides: Partial<EvalSampleArtifacts> = {}): EvalSampleArtifacts {
  return {
    outcomeStatus: 'unverified',
    passed: false,
    iterations: 6,
    stopReason: 'max-iterations',
    failureNote: null,
    instrumentVerdict: { validity: 'valid' },
    controlStdout: null,
    controlStderr: null,
    controlExitCode: null,
    mutation: null,
    candidateRtl: whole('module m(input a, output y); endmodule'),
    testbenchSource: whole('module m_tb; endmodule'),
    simulation: simulation(),
    runFailureCause: null,
    attributedFiles: [],
    rejectedTestbenchDraft: null,
    missingCheckNames: [],
    missingCheckNamesTruncated: false,
    failingCase: {
      checkName: 'shift_by_three',
      description: 'Spec-derived check "shift_by_three" did not pass.',
      expected: 'the check to report PASS',
      observed: 'the check reported FAIL',
      atSimTimeNs: 40,
    },
    goldenVerdict: { kind: 'passed', failureCount: 0 },
    repairProvenance: NO_REPAIR,
    rejectedPreRepairTestbench: null,
    repairHint: null,
    precheckDiagnostic: null,
    repairDeclineReason: null,
    checkNameVisibilitySignal: false,
    preNormalizationTestbench: null,
    normalizerReport: null,
    normalizerReportFindingsTruncated: false,
    ...overrides,
  };
}

/** The artifacts of a sample that produced no evidence at all. */
function noEvidence(): EvalSampleArtifacts {
  return artifacts({
    outcomeStatus: 'setup-failed',
    iterations: 0,
    stopReason: null,
    failureNote: 'generation-unavailable: the model host declined every attempt',
    candidateRtl: null,
    testbenchSource: null,
    simulation: null,
    failingCase: null,
    goldenVerdict: null,
    // No testbench was produced, so there was no instrument to put under control.
    instrumentVerdict: { validity: 'unchecked', reason: 'no-testbench' },
  });
}

/** A descriptor for one sample. */
function descriptor(overrides: Partial<EvalArtifactDescriptor> = {}): EvalArtifactDescriptor {
  return {
    problemId: 'rtllm/arithmetic/multi_pipe_8bit',
    sampleIndex: 0,
    seed: 3_776_211_701,
    ...overrides,
  };
}

/** The named file in a plan, or undefined when the plan does not include it. */
function planned(sample: EvalSampleArtifacts, filename: string) {
  return planArtifactFiles(sample).find((file) => file.filename === filename);
}

describe('safePathSegment - a problem id is untrusted as a path', () => {
  it('reduces an id containing separators to ONE readable segment', () => {
    expect(safePathSegment('rtllm/arithmetic/multi_pipe_8bit')).toBe(
      'rtllm_arithmetic_multi_pipe_8bit',
    );
  });

  it('never produces a separator, whichever platform separator was used', () => {
    for (const raw of ['a/b', 'a\\b', 'a:b', 'a b']) {
      const segment = safePathSegment(raw);
      expect(segment).not.toContain('/');
      expect(segment).not.toContain('\\');
      expect(segment).not.toContain(sep);
    }
  });

  it('turns a parent reference into a name, so it cannot climb', () => {
    expect(safePathSegment('..')).toBe('unnamed');
    expect(safePathSegment('.')).toBe('unnamed');
    expect(safePathSegment('....')).toBe('unnamed');
  });

  it('names an id that reduces to nothing rather than returning an empty segment', () => {
    expect(safePathSegment('')).toBe('unnamed');
    expect(safePathSegment('///')).toBe('_');
  });

  it('strips a null byte, which the OS would otherwise refuse outright', () => {
    expect(safePathSegment('rtllm\u0000/x')).not.toContain('\u0000');
  });
});

describe('artifactSampleSegments - confinement to the run directory', () => {
  it('is keyed arm, then problem, then sample index, under the artifacts directory', () => {
    expect(artifactSampleSegments('kimi-k2_5', 'rtllm/control/fsm', 2)).toEqual([
      ARTIFACTS_DIRNAME,
      'kimi-k2_5',
      'rtllm_control_fsm',
      'sample-2',
    ]);
  });

  it('confines a traversal attempt inside the run directory', () => {
    // The attack this refuses: a problem id crafted to write above the run directory.
    for (const hostile of [
      '../../../../etc/passwd',
      '..',
      '/etc/passwd',
      'a/../../../b',
      '..\\..\\windows',
    ]) {
      const segments = artifactSampleSegments('armA', hostile, 0);
      const path = join(RUN_DIR, ...segments);
      expect(resolve(path).startsWith(`${RUN_DIR}${sep}`)).toBe(true);
      expect(segments.every((segment) => !segment.includes(sep))).toBe(true);
      expect(segments).not.toContain('..');
    }
  });

  it('confines a hostile arm name too, even though the config validator already refuses one', () => {
    const path = join(RUN_DIR, ...artifactSampleSegments('../../escape', 'rtllm/x/y', 0));
    expect(resolve(path).startsWith(`${RUN_DIR}${sep}`)).toBe(true);
  });

  it('never yields an absolute segment', () => {
    for (const segment of artifactSampleSegments('/arm', '/rtllm/x', 0)) {
      expect(isAbsolute(segment)).toBe(false);
    }
  });

  it('names an unusable sample index rather than putting it in a path', () => {
    expect(artifactSampleSegments('armA', 'p', -1)).toContain('sample-unknown');
    expect(artifactSampleSegments('armA', 'p', 1.5)).toContain('sample-unknown');
    expect(artifactSampleSegments('armA', 'p', Number.NaN)).toContain('sample-unknown');
  });
});

describe('planArtifactFiles - absent evidence produces no file', () => {
  it('writes the candidate, our testbench, and the streams that exist', () => {
    const files = planArtifactFiles(artifacts()).map((file) => file.filename);
    expect(files).toEqual([
      ARTIFACT_FILENAMES.candidateRtl,
      ARTIFACT_FILENAMES.testbench,
      ARTIFACT_FILENAMES.simulatorStdout,
    ]);
    // stderr was absent, so no empty file claims the run printed nothing to it.
    expect(files).not.toContain(ARTIFACT_FILENAMES.simulatorStderr);
  });

  it('plans nothing at all for a sample that produced no evidence', () => {
    expect(planArtifactFiles(noEvidence())).toEqual([]);
  });

  it('writes the captured text verbatim when it was not truncated', () => {
    const file = planned(artifacts(), ARTIFACT_FILENAMES.candidateRtl);
    expect(file?.contents).toBe('module m(input a, output y); endmodule');
    expect(file?.truncated).toBe(false);
  });
});

describe('planArtifactFiles - a truncated artifact says so', () => {
  it('marks a cut source with a Verilog comment, so the file stays valid Verilog', () => {
    const sample = artifacts({ candidateRtl: cut('module m', 90_000, 'head') });
    const file = planned(sample, ARTIFACT_FILENAMES.candidateRtl);
    const firstLine = file?.contents.split('\n')[0] ?? '';

    expect(firstLine.startsWith('// TRUNCATED')).toBe(true);
    expect(firstLine).toContain('90000 characters');
    expect(firstLine).toContain('first');
    expect(file?.contents.endsWith('module m')).toBe(true);
    expect(file?.truncated).toBe(true);
    expect(file?.originalChars).toBe(90_000);
  });

  it('marks cut simulator output as tail-kept, because the error is at the end', () => {
    const sample = artifacts({
      simulation: simulation({ stdout: cut('...FAIL at time 40', 50_000, 'tail') }),
    });
    const firstLine =
      planned(sample, ARTIFACT_FILENAMES.simulatorStdout)?.contents.split('\n')[0] ?? '';

    expect(firstLine.startsWith('TRUNCATED')).toBe(true);
    expect(firstLine).toContain('last');
    expect(firstLine).toContain('50000 characters');
  });
});

describe('artifactDocument - the machine-readable index', () => {
  it('carries the verdict fields, the check verdicts, and the independent verdict', () => {
    const document = artifactDocument(descriptor(), artifacts(), planArtifactFiles(artifacts()));

    expect(document.schemaVersion).toBe(ARTIFACT_DOCUMENT_SCHEMA_VERSION);
    expect(document.problemId).toBe('rtllm/arithmetic/multi_pipe_8bit');
    expect(document.seed).toBe(3_776_211_701);
    expect(document.passed).toBe(false);
    expect(document.iterations).toBe(6);
    expect(document.stopReason).toBe('max-iterations');
    // The disagreement this whole capture exists for: our oracle failed it, golden passed it.
    expect(document.goldenVerdict).toEqual({ kind: 'passed', failureCount: 0 });
    expect(document.simulation?.checks).toHaveLength(2);
    expect(document.failingCase?.checkName).toBe('shift_by_three');
  });

  it('does not repeat the stream text that sits in the sibling files', () => {
    const document = artifactDocument(descriptor(), artifacts(), planArtifactFiles(artifacts()));
    expect(Object.keys(document.simulation ?? {})).toEqual([
      'verdict',
      'checks',
      'checksTruncated',
      'exitCode',
    ]);
  });

  it('lists exactly the files written, with each one truncation state', () => {
    const sample = artifacts({ candidateRtl: cut('module m', 90_000, 'head') });
    const document = artifactDocument(descriptor(), sample, planArtifactFiles(sample));

    expect(Object.keys(document.files)).toEqual([
      ARTIFACT_FILENAMES.candidateRtl,
      ARTIFACT_FILENAMES.testbench,
      ARTIFACT_FILENAMES.simulatorStdout,
    ]);
    expect(document.files[ARTIFACT_FILENAMES.candidateRtl]).toEqual({
      truncated: true,
      originalChars: 90_000,
    });
  });

  it('lists no files and no simulation for a sample that produced no evidence', () => {
    const document = artifactDocument(descriptor(), noEvidence(), planArtifactFiles(noEvidence()));
    expect(document.files).toEqual({});
    expect(document.simulation).toBeNull();
    expect(document.failureNote).toContain('generation-unavailable');
  });

  it('encodes as pretty JSON ending in a newline, so the file is reviewable', () => {
    const text = encodeArtifactDocument(descriptor(), artifacts(), planArtifactFiles(artifacts()));
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toEqual(
      artifactDocument(descriptor(), artifacts(), planArtifactFiles(artifacts())),
    );
  });
});

describe('the positive control leaves its evidence beside the testbench that caused it', () => {
  /** The artifacts of a sample whose testbench REJECTS the reference design. */
  function invalidInstrumentArtifacts(): EvalSampleArtifacts {
    return artifacts({
      instrumentVerdict: { validity: 'invalid', defect: 'TESTBENCH_FAILED_REFERENCE' },
      controlStdout: whole(
        'CHECK ac1_under_simulation_right_shifter_produces FAIL\n' +
          'ERROR at fill-1s step 0: expected q=10000000, got q=11010101\n',
        'tail',
      ),
      controlStderr: null,
      controlExitCode: 0,
    });
  }

  it('writes the control stdout beside testbench.v, so no cross-reference is needed', () => {
    const sample = invalidInstrumentArtifacts();

    const files = planArtifactFiles(sample).map((file) => file.filename);

    expect(files).toContain(ARTIFACT_FILENAMES.testbench);
    expect(files).toContain(ARTIFACT_FILENAMES.controlStdout);
  });

  it('carries the control verdict in the index, so a directory reads on its own', () => {
    const sample = invalidInstrumentArtifacts();

    const document = artifactDocument(descriptor(), sample, planArtifactFiles(sample));

    expect(document.instrumentVerdict).toEqual({
      validity: 'invalid',
      defect: 'TESTBENCH_FAILED_REFERENCE',
    });
    expect(document.controlExitCode).toBe(0);
  });

  it('omits a control file the run never produced, so absence is the record', () => {
    const sample = artifacts({ controlStdout: null, controlStderr: null });

    const files = planArtifactFiles(sample).map((file) => file.filename);

    expect(files).not.toContain(ARTIFACT_FILENAMES.controlStdout);
    expect(files).not.toContain(ARTIFACT_FILENAMES.controlStderr);
  });

  it('labels a truncated control stream in the file itself', () => {
    const sample = artifacts({
      controlStderr: cut('...the last 30 characters here', 90_000, 'tail'),
    });

    const file = planned(sample, ARTIFACT_FILENAMES.controlStderr);

    expect(file?.truncated).toBe(true);
    expect(file?.contents).toContain('TRUNCATED');
    expect(file?.contents).toContain('90000 characters');
    expect(file?.originalChars).toBe(90_000);
  });

  it('records an unchecked instrument as a statement, not as an absent field', () => {
    const document = artifactDocument(descriptor(), noEvidence(), []);

    expect(document.instrumentVerdict).toEqual({
      validity: 'unchecked',
      reason: 'no-testbench',
    });
  });
});
