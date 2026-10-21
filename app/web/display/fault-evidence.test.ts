// Unit tests for the observational fault-evidence renderer (task 14.3).

import { describe, expect, it } from 'vitest';

import { renderFaultEvidence, type FaultEvidenceInput } from './fault-evidence.js';

function peers(overrides: Partial<FaultEvidenceInput['peers']> = {}): FaultEvidenceInput['peers'] {
  return {
    peerPassCount: 6,
    peerDesignCount: 7,
    peerTestbenchPassCount: 5,
    peerTestbenchCount: 7,
    ...overrides,
  };
}

describe('renderFaultEvidence - renders only at or above the gate (Req 10.2)', () => {
  it('renders nothing when the status is advisory', () => {
    expect(renderFaultEvidence({ status: 'advisory', peers: peers() })).toBeNull();
  });

  it('renders the observation when the status is actionable', () => {
    const rendered = renderFaultEvidence({ status: 'actionable', peers: peers() });

    expect(rendered).toBe('6 of the other 7 designs passed this same check.');
  });

  it('renders the exact peer counts given, with no recomputation', () => {
    const rendered = renderFaultEvidence({
      status: 'actionable',
      peers: peers({ peerPassCount: 0, peerDesignCount: 3 }),
    });

    expect(rendered).toBe('0 of the other 3 designs passed this same check.');
  });
});

describe('renderFaultEvidence - never names a verdict or an abstention (Req 13.10)', () => {
  it('contains none of RTL, TESTBENCH, or ABSTAIN when rendered', () => {
    const rendered = renderFaultEvidence({ status: 'actionable', peers: peers() });

    expect(rendered).not.toBeNull();
    expect(rendered).not.toMatch(/RTL/);
    expect(rendered).not.toMatch(/TESTBENCH/);
    expect(rendered).not.toMatch(/ABSTAIN/);
  });
});
