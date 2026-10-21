import { describe, expect, it } from 'vitest';

import { RTLLM_VALIDITY_OUTPUTS, validityOutputFor } from './validity-outputs.js';

describe('RTLLM_VALIDITY_OUTPUTS', () => {
  it('declares exactly the reviewed entries, so an edit is deliberate', () => {
    expect(RTLLM_VALIDITY_OUTPUTS).toEqual({ 'rtllm/arithmetic/accu': 'valid_out' });
  });

  it('reads null for an undeclared design and for an inherited property name', () => {
    expect(validityOutputFor('rtllm/arithmetic/accu')).toBe('valid_out');
    expect(validityOutputFor('rtllm/control/counter_12')).toBeNull();
    expect(validityOutputFor('toString')).toBeNull();
  });
});
