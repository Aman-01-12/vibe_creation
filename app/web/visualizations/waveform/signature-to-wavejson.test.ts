// Example tests for signatureToWaveJson (task 14.1).

import { describe, expect, it } from 'vitest';

import { signatureToWaveJson, type SampleRecord } from './signature-to-wavejson.js';

describe('signatureToWaveJson', () => {
  it('renders a one-port one-sample trace', () => {
    const trace: SampleRecord[] = [{ step: 0, values: ['1'] }];
    const result = signatureToWaveJson(trace, ['q']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.wave.signal).toEqual([{ name: 'q', wave: '=', data: ['1'] }]);
    }
  });

  it('renders a masked value in the middle of a trace as the WaveDrom unknown slot', () => {
    const trace: SampleRecord[] = [
      { step: 0, values: ['1'] },
      { step: 1, values: [null] },
      { step: 2, values: ['1'] },
    ];
    const result = signatureToWaveJson(trace, ['q']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      const row = result.wave.signal[0];
      expect(row?.wave).toBe('=x=');
      expect(row?.data).toEqual(['1', '1']);
    }
  });

  it('degrades rather than rendering a misaligned row when portNames disagrees with the trace width', () => {
    const trace: SampleRecord[] = [{ step: 0, values: ['1', '0'] }];
    const result = signatureToWaveJson(trace, ['q']); // 1 name for a 2-value row
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('NO_SIGNALS');
    }
  });

  it('degrades on an empty trace', () => {
    const result = signatureToWaveJson([], ['q']);
    expect(result.ok).toBe(false);
  });

  it('degrades on an empty portNames list', () => {
    const result = signatureToWaveJson([{ step: 0, values: ['1'] }], []);
    expect(result.ok).toBe(false);
  });

  it('renders a repeated value as the "." unchanged slot', () => {
    const trace: SampleRecord[] = [
      { step: 0, values: ['1'] },
      { step: 1, values: ['1'] },
    ];
    const result = signatureToWaveJson(trace, ['q']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.wave.signal[0]?.wave).toBe('=.');
    }
  });

  it('renders multiple ports in declared order', () => {
    const trace: SampleRecord[] = [{ step: 0, values: ['1', '0'] }];
    const result = signatureToWaveJson(trace, ['q', 'r']);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.wave.signal.map((signal) => signal.name)).toEqual(['q', 'r']);
    }
  });
});
