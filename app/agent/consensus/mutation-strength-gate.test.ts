// Example tests for the Peer_Calibrated_Mutant_Set rule (C12; Req 12.1, 12.2,
// 12.3, 12.5, 12.6). Each test pins one shape task 4.3's own body names:
//   - exactly one peer killed one mutant yields a one-mutant requirement and a
//     `passed` outcome naming it;
//   - no peer killed anything yields `not-run`, never a vacuous pass;
//   - a mutant whose parent design fails T is absent from the requirement;
//   - a surviving mutant is named in the `failed` outcome.
//
// Driven entirely through `MutantRunRecord` fixtures: no simulator, no RTL, no
// toolchain. The run facts this gate reads are already-decided booleans, so the
// gate's own correctness is checkable with no sandbox present.

import { describe, expect, it } from 'vitest';

import type { MutantIdentity } from '@app/tools';

import {
  judgeMutationStrength,
  PeerCalibratedMutationStrengthGate,
  type MutantRunRecord,
  type MutationStrengthRequest,
} from './mutation-strength-gate.js';

/** A `MutantIdentity` fixture, numbered for readability across the test cases. */
function mutant(n: number): MutantIdentity {
  return {
    mutantId: `ARITH_PLUS_TO_MINUS@${n}:1`,
    operator: 'ARITH_PLUS_TO_MINUS',
    site: { line: n, column: 1, before: '+', after: '-' },
  };
}

/** A fully-killed, fully-valid run record for `mutant(n)`, overridable per field. */
function run(n: number, overrides: Partial<MutantRunRecord> = {}): MutantRunRecord {
  return {
    mutant: mutant(n),
    compiled: true,
    parentPassedJudged: true,
    killedByPeer: true,
    killedByJudged: true,
    ...overrides,
  };
}

function requestOf(mutantRuns: readonly MutantRunRecord[]): MutationStrengthRequest {
  return { testbenchId: 'testbench-1', mutantRuns };
}

describe('judgeMutationStrength - the Peer_Calibrated_Mutant_Set rule', () => {
  it('given exactly one peer-killed mutant that T also kills, yields a passed one-mutant requirement', () => {
    const outcome = judgeMutationStrength(requestOf([run(1)]));

    expect(outcome).toEqual({
      kind: 'passed',
      killed: [mutant(1)],
      killRate: 1,
    });
  });

  it('given a pool where no peer killed anything, yields not-run rather than a vacuous pass', () => {
    const outcome = judgeMutationStrength(
      requestOf([run(1, { killedByPeer: false }), run(2, { killedByPeer: false })]),
    );

    expect(outcome).toEqual({ kind: 'not-run' });
  });

  it('excludes a mutant whose parent design fails T from the requirement', () => {
    // The excluded mutant is peer-killed but its parent already fails T, so it
    // carries no information about T's own discriminating power; the surviving
    // requirement entry is peer-killed, parent-passing, and judged-killed, so the
    // gate still reads passed on the one mutant that qualifies.
    const outcome = judgeMutationStrength(
      requestOf([run(1, { parentPassedJudged: false }), run(2)]),
    );

    expect(outcome).toEqual({ kind: 'passed', killed: [mutant(2)], killRate: 1 });
  });

  it('names a surviving mutant in the failed outcome', () => {
    const outcome = judgeMutationStrength(requestOf([run(1), run(2, { killedByJudged: false })]));

    expect(outcome).toEqual({ kind: 'failed', survivors: [mutant(2)] });
  });

  it('reports a mix of surviving and killed requirement mutants as failed, naming only the survivors', () => {
    const outcome = judgeMutationStrength(
      requestOf([run(1), run(2, { killedByJudged: false }), run(3, { killedByJudged: false })]),
    );

    expect(outcome).toEqual({ kind: 'failed', survivors: [mutant(2), mutant(3)] });
  });

  it('yields not-run when no mutant compiled at all', () => {
    const outcome = judgeMutationStrength(requestOf([run(1, { compiled: false })]));

    expect(outcome).toEqual({ kind: 'not-run' });
  });

  it('yields not-run for an empty mutant run list', () => {
    const outcome = judgeMutationStrength(requestOf([]));

    expect(outcome).toEqual({ kind: 'not-run' });
  });

  it('reports the kill rate over every compiled mutant, not only the requirement set', () => {
    // mutant(1) is in the requirement (peer-killed, parent-passing) and T kills it.
    // mutant(2) compiled but no peer killed it, so it sits outside the requirement
    // while still counting in the kill-rate denominator, and T does not kill it.
    const outcome = judgeMutationStrength(
      requestOf([run(1), run(2, { killedByPeer: false, killedByJudged: false })]),
    );

    expect(outcome).toEqual({ kind: 'passed', killed: [mutant(1)], killRate: 0.5 });
  });

  it('excludes a non-compiling mutant from the kill rate denominator entirely', () => {
    const outcome = judgeMutationStrength(
      requestOf([run(1), run(2, { compiled: false, killedByPeer: false, killedByJudged: false })]),
    );

    expect(outcome).toEqual({ kind: 'passed', killed: [mutant(1)], killRate: 1 });
  });
});

describe('PeerCalibratedMutationStrengthGate - the production adapter', () => {
  it('judges through the same pure rule, wrapped in a Promise', async () => {
    const gate = new PeerCalibratedMutationStrengthGate();

    await expect(gate.judge(requestOf([run(1)]))).resolves.toEqual({
      kind: 'passed',
      killed: [mutant(1)],
      killRate: 1,
    });
  });

  it('never produces a vacuous pass when the requirement is empty', async () => {
    const gate = new PeerCalibratedMutationStrengthGate();

    await expect(gate.judge(requestOf([run(1, { killedByPeer: false })]))).resolves.toEqual({
      kind: 'not-run',
    });
  });
});
