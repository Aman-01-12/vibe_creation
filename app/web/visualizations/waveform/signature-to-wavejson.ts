// Waveform_Signature trace -> WaveDrom WaveJSON transform (C19, Req 13.10).
//
// A trace is already one row per Sample_Point, so no parser is needed here -
// `vcd-to-wavejson.ts` exists because a VCD needs one; this does not. A `null`
// value (a Masked_Output) renders as the WaveDrom unknown slot `x`, which is the
// honest rendering of "deliberately not observed", never a guessed value.

import type { WaveJson, WaveJsonSignal } from './vcd-to-wavejson.js';
import type { VcdToWaveJsonResult } from './vcd-to-wavejson.js';

/** One Sample_Point's output values, mirroring `app/agent/consensus/signature.ts`'s own shape. */
export interface SampleRecord {
  readonly step: number;
  readonly values: readonly (string | null)[];
}

/** Same row cap `vcdToWaveJson` holds samples to, so a 2048-sample trace behaves identically. */
const MAX_SAMPLES = 4096;

/** Map one value (a hex string, or `null` for a Masked_Output) to its WaveDrom character. */
function waveChar(
  value: string | null,
  previous: string | null,
): { char: string; data: string | null } {
  if (value === null) {
    return { char: 'x', data: null };
  }
  if (value === previous) {
    return { char: '.', data: null };
  }
  return { char: '=', data: value };
}

/** Build one port's WaveDrom row across `trace`, at `portIndex`. */
function buildPortSignal(
  portName: string,
  portIndex: number,
  trace: readonly SampleRecord[],
): WaveJsonSignal {
  let wave = '';
  const data: string[] = [];
  let previous: string | null = null;
  for (const sample of trace.slice(0, MAX_SAMPLES)) {
    const value = sample.values[portIndex] ?? null;
    const { char, data: dataValue } = waveChar(value, previous);
    wave += char;
    if (dataValue !== null) {
      data.push(dataValue);
    }
    previous = value;
  }
  return { name: portName, wave: wave === '' ? 'x' : wave, data };
}

/**
 * Transform a Waveform_Signature trace into WaveDrom WaveJSON, degrading to the
 * existing `unavailable` cause when `portNames`' count disagrees with the trace's
 * own value count (a misaligned row is worse than no row).
 */
export function signatureToWaveJson(
  trace: readonly SampleRecord[],
  portNames: readonly string[],
): VcdToWaveJsonResult {
  if (trace.length === 0) {
    return { ok: false, code: 'EMPTY_INPUT' };
  }
  if (portNames.length === 0) {
    return { ok: false, code: 'NO_SIGNALS' };
  }
  const firstRowWidth = trace[0]?.values.length ?? 0;
  if (firstRowWidth !== portNames.length) {
    return { ok: false, code: 'NO_SIGNALS' };
  }
  const signal: WaveJsonSignal[] = portNames.map((portName, index) =>
    buildPortSignal(portName, index, trace),
  );
  const wave: WaveJson = { signal };
  return { ok: true, wave };
}
