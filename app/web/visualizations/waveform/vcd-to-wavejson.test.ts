// Unit tests for the pure VCD -> WaveDrom WaveJSON transform (task 15.3).
//
// Cover the worked cases the Waveform_Viewer depends on: a well-formed dump becomes
// one WaveJSON row per declared signal with `.` marking unchanged slots; scalar and
// vector signals are shaped correctly; and untrusted/malformed input degrades to an
// explicit, sanitized error result rather than a throw or a partial guess.

import { describe, expect, it } from 'vitest';

import { vcdToWaveJson } from './vcd-to-wavejson.js';

const HEADER = ['$timescale 1ns $end', '$scope module top $end'].join('\n');

/** Assemble a VCD from a var section and a value-change body. */
function vcd(vars: readonly string[], body: readonly string[]): string {
  return [HEADER, ...vars, '$upscope $end', '$enddefinitions $end', ...body].join('\n');
}

describe('vcdToWaveJson - well-formed dumps', () => {
  it('produces one scalar row per declared 1-bit signal, sampled per time step', () => {
    const result = vcdToWaveJson(
      vcd(['$var wire 1 ! clk $end'], ['#0', '0!', '#5', '1!', '#10', '0!']),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.wave.signal).toEqual([{ name: 'clk', wave: '010' }]);
  });

  it('collapses an unchanged value into a `.` repeat character', () => {
    const result = vcdToWaveJson(
      vcd(['$var wire 1 ! d $end'], ['#0', '1!', '#5', '1!', '#10', '0!']),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.wave.signal[0]?.wave).toBe('1.0');
  });

  it('renders a multi-bit vector as `=` slots with a data array of its values', () => {
    const result = vcdToWaveJson(
      vcd(['$var wire 4 # bus [3:0] $end'], ['#0', 'b0001 #', '#5', 'b0010 #', '#10', 'b0010 #']),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const bus = result.wave.signal[0];
    expect(bus?.name).toBe('bus');
    expect(bus?.wave).toBe('==.');
    expect(bus?.data).toEqual(['0001', '0010']);
  });

  it('maps x/z scalar values to the unknown character', () => {
    const result = vcdToWaveJson(vcd(['$var wire 1 ! d $end'], ['#0', 'x!', '#5', '1!']));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.wave.signal[0]?.wave).toBe('x1');
  });

  it('emits multiple signals in declaration order', () => {
    const result = vcdToWaveJson(
      vcd(
        ['$var wire 1 ! clk $end', '$var wire 1 " rst $end'],
        ['#0', '0!', '1"', '#5', '1!', '0"'],
      ),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.wave.signal.map((s) => s.name)).toEqual(['clk', 'rst']);
  });
});

describe('vcdToWaveJson - untrusted/malformed input fails safe', () => {
  it('returns EMPTY_INPUT for an empty string', () => {
    const result = vcdToWaveJson('');
    expect(result).toEqual({ ok: false, code: 'EMPTY_INPUT' });
  });

  it('returns NO_SIGNALS when the dump declares no variables', () => {
    const result = vcdToWaveJson(vcd([], ['#0', '#5']));
    expect(result).toEqual({ ok: false, code: 'NO_SIGNALS' });
  });

  it('returns NO_SIGNALS for arbitrary non-VCD text', () => {
    const result = vcdToWaveJson('this is not a vcd file at all\n<script>alert(1)</script>');
    expect(result).toEqual({ ok: false, code: 'NO_SIGNALS' });
  });

  it('returns INPUT_TOO_LARGE for an oversized dump', () => {
    const huge = `${HEADER}\n${'x'.repeat(5_000_001)}`;
    const result = vcdToWaveJson(huge);
    expect(result).toEqual({ ok: false, code: 'INPUT_TOO_LARGE' });
  });

  it('ignores unrecognized body lines instead of trusting them', () => {
    const result = vcdToWaveJson(
      vcd(['$var wire 1 ! d $end'], ['#0', '0!', 'garbage line', '#5', '1!']),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.wave.signal[0]?.wave).toBe('01');
  });
});
