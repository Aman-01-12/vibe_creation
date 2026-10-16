// The Waveform_Signature reducer: one run's stdout folded to a comparable fact (C9).
//
// `reduceSignature` is a pure function from one Consensus_Run's stdout to a
// `WaveformSignature` or to nothing (Req 7.1, 7.3, 7.5, 7.6, 7.7, 7.8). It is the
// only place a run's simulated behaviour becomes the fact the Agreement_Cluster
// (C10) compares, and it is pure: no filesystem, no clock, no simulator call, and
// no parameter or field that could carry Candidate_Design source text (Req 7.6).
//
// NONE OF THE PROTOTYPE'S VCD SCAFFOLDING IS PORTED
//
//   The prototype read dumps from testbenches it did not author, so it needed a
//   VCD parser, value interning, a `dutScope` regex, reset-release inference, a
//   `valueBefore` binary search, and a `$dumplimit` exclusion. Here the harness
//   (C6) authors the run and prints one `ECE_SAMPLE` line per Sample_Point itself,
//   so none of that machinery has anything to do. The one stated behaviour
//   difference is nibble-granularity normalization (the harness prints `%0h`),
//   which Property 6 checks is safe.
//
// THE END MARKER REPLACES TWO SEPARATE PROTOTYPE MECHANISMS
//
//   An incomplete run (a watchdog stop, a `$finish` the design forced, a
//   truncated stdout, a crash) is exactly one with no single, correctly counted
//   `ECE_SAMPLE_END` line - one check, no inference, where the prototype needed
//   both a `$dumplimit` exclusion and a release-time inference.

import type { ModuleInterface, Port } from '@app/core';

/** Bumps whenever the mask rule, the normalization, or the digest input moves. */
export const SIGNATURE_REDUCTION_VERSION = 1;

/** One Sample_Point's output values, in declared port order. */
export interface SampleRecord {
  readonly step: number;
  /** One entry per output port in declared order; `null` is a Masked_Output. */
  readonly values: readonly (string | null)[];
}

/** One run's reduced, comparable behaviour. */
export interface WaveformSignature {
  /** The hash the Agreement_Cluster (C10) compares; derived from `trace` alone. */
  readonly digest: string;
  /** The retained per-sample trace, so agreement is replayable with no simulation. */
  readonly trace: readonly SampleRecord[];
  readonly sampleCount: number;
}

const SAMPLE_LINE_KEYWORD = 'ECE_SAMPLE';
const END_LINE_KEYWORD = 'ECE_SAMPLE_END';

/** The declared output ports of `moduleInterface`, in declared order. */
function outputPorts(moduleInterface: ModuleInterface): readonly Port[] {
  return moduleInterface.ports.filter((port) => port.direction === 'output');
}

/**
 * Parse one `ECE_SAMPLE <nonce> <step> <v0> <v1> ...` line into a `SampleRecord`,
 * or `null` when it is not an `ECE_SAMPLE` line, its nonce does not match, its
 * step is not a non-negative integer, or it does not carry exactly
 * `outputPortCount` values.
 *
 * Tokenized by whitespace split rather than by a regex built from `nonce`, so no
 * nonce value needs regex-escaping to be matched safely.
 */
function parseSampleLine(
  line: string,
  nonce: string,
  outputPortCount: number,
): SampleRecord | null {
  const tokens = line.trim().split(/\s+/);
  const expectedTokenCount = outputPortCount + 3;
  if (
    tokens.length !== expectedTokenCount ||
    tokens[0] !== SAMPLE_LINE_KEYWORD ||
    tokens[1] !== nonce
  ) {
    return null;
  }
  const step = Number(tokens[2]);
  if (!Number.isInteger(step) || step < 0) {
    return null;
  }
  return { step, values: tokens.slice(3) };
}

/**
 * Parse one `ECE_SAMPLE_END <nonce> <count>` line's count, or `null` when it is
 * not an `ECE_SAMPLE_END` line, its nonce does not match, or its count is not a
 * non-negative integer.
 */
function parseEndLine(line: string, nonce: string): number | null {
  const tokens = line.trim().split(/\s+/);
  if (tokens.length !== 3 || tokens[0] !== END_LINE_KEYWORD || tokens[1] !== nonce) {
    return null;
  }
  const count = Number(tokens[2]);
  return Number.isInteger(count) && count >= 0 ? count : null;
}

/**
 * Mask every output value except the Validity_Output's own at every
 * `SampleRecord` where the Validity_Output's value is not `"1"` (Req 7.3, 7.5).
 * `validityIndex` is the Validity_Output's position among the declared output
 * ports.
 */
function maskedTrace(trace: readonly SampleRecord[], validityIndex: number): SampleRecord[] {
  return trace.map((record) => {
    if (record.values[validityIndex] === '1') {
      return record;
    }
    return {
      step: record.step,
      values: record.values.map((value, index) => (index === validityIndex ? value : null)),
    };
  });
}

const FNV_PRIME = 0x01000193;
const FNV_SEED_A = 0x811c9dc5;
/** A second, independent seed, so the two passes below do not just repeat each other. */
const FNV_SEED_B = 0x9e3779b9;

/** FNV-1a over `text` from `seed`, coerced to an unsigned 32-bit integer. */
function fnv1a(text: string, seed: number): number {
  let hash = seed;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
}

/**
 * Hash `trace` to a stable hex digest, two independent FNV-1a passes
 * concatenated to widen the output to 16 hex characters - the same width
 * `@app/eval`'s `sweepConfigHash` already treats as far beyond enough to
 * distinguish its inputs.
 *
 * Not cryptographic, and this reduction guards nothing security-sensitive:
 * `@app/agent` carries no ambient Node types (see `prompt-version.test.ts`), so
 * `node:crypto` is unavailable here, and the host Web Crypto `subtle.digest` used
 * elsewhere in this package is Promise-only, which `reduceSignature` cannot be
 * (C9's signature is synchronous). A collision would need EVERY
 * Reference_Model_Testbench in a design's cluster-key tuple (C10) to collide at
 * once, which stays negligible at this pool size even at 32 bits per testbench.
 *
 * ponytail: the digest is over the WHOLE trace, so two signatures differing at
 * one Sample_Point out of 2048 are as unequal as two that differ everywhere;
 * if a near-miss cluster is ever wanted, add a per-step diff beside the digest
 * rather than loosening this one.
 */
function digestOf(trace: readonly SampleRecord[]): string {
  const canonical = JSON.stringify(trace);
  const high = fnv1a(canonical, FNV_SEED_A).toString(16).padStart(8, '0');
  const low = fnv1a(canonical, FNV_SEED_B).toString(16).padStart(8, '0');
  return `${high}${low}`;
}

/**
 * Reduce one Consensus_Run's stdout to a `WaveformSignature`, or to `null` when
 * the run is incomplete (Req 7.7).
 *
 * Four steps, in order: keep only `ECE_SAMPLE`/`ECE_SAMPLE_END` lines whose nonce
 * matches `nonce`, which discards any forged line; parse each matching
 * `ECE_SAMPLE` into a `SampleRecord` in declared port order; apply the
 * Validity_Output mask from `moduleInterface.validityOutputName` (Req 7.3, 7.4,
 * 7.5); require exactly one matching `ECE_SAMPLE_END` whose count equals the
 * number of samples parsed, returning `null` otherwise.
 *
 * `digest` and `trace` are both derived from `stdout` alone - there is no
 * parameter and no field through which Candidate_Design source text could reach
 * either (Req 7.6). A run with no signature is the absence of a
 * `WaveformSignature`, never one with an empty trace.
 */
export function reduceSignature(
  stdout: string,
  nonce: string,
  moduleInterface: ModuleInterface,
): WaveformSignature | null {
  const ports = outputPorts(moduleInterface);
  const lines = stdout.split(/\r?\n/);

  const rawTrace: SampleRecord[] = [];
  let endCount: number | null = null;
  let endMarkersSeen = 0;

  for (const line of lines) {
    const sample = parseSampleLine(line, nonce, ports.length);
    if (sample !== null) {
      rawTrace.push(sample);
      continue;
    }
    const end = parseEndLine(line, nonce);
    if (end !== null) {
      endCount = end;
      endMarkersSeen += 1;
    }
  }

  if (endMarkersSeen !== 1 || endCount !== rawTrace.length) {
    return null;
  }

  const validityIndex =
    moduleInterface.validityOutputName === null
      ? -1
      : ports.findIndex((port) => port.name === moduleInterface.validityOutputName);
  const trace = validityIndex === -1 ? rawTrace : maskedTrace(rawTrace, validityIndex);

  return { digest: digestOf(trace), trace, sampleCount: trace.length };
}
