// Unit tests for the pure view-state reducer (task 6.2).
//
// The reducer is where untrusted, display-only stream data is folded into the
// Editor's state. These cover the transitions, the resumable-cursor tracking, and
// the fail-safe handling of malformed server data.

import { describe, expect, it } from 'vitest';

import type { GatewayStreamEvent } from '@app/api';

import { applyStreamEvent, initialEditorViewState, isTerminalPhase } from './view-state.js';

describe('applyStreamEvent transitions', () => {
  it('moves idle to running and accumulates progress with the event seq', () => {
    let state = initialEditorViewState();
    state = applyStreamEvent(state, { kind: 'progress', seq: 0, data: { message: 'compiling' } });
    state = applyStreamEvent(state, { kind: 'progress', seq: 1, data: { message: 'simulating' } });

    expect(state.phase).toBe('running');
    expect(state.progress).toEqual([
      { seq: 0, message: 'compiling' },
      { seq: 1, message: 'simulating' },
    ]);
    expect(state.lastEventId).toBe(1);
    expect(state.outcome).toBeNull();
  });

  it('maps a pass verdict to the passed phase with its outcome', () => {
    const state = applyStreamEvent(initialEditorViewState(), {
      kind: 'result',
      seq: 3,
      data: { verdict: 'pass', message: 'ok' },
    });

    expect(state.phase).toBe('passed');
    expect(state.outcome).toEqual({ verdict: 'pass', detail: 'ok' });
    expect(state.lastEventId).toBe(3);
  });

  it('maps a fail verdict to the failed phase', () => {
    const state = applyStreamEvent(initialEditorViewState(), {
      kind: 'result',
      seq: 1,
      data: { verdict: 'fail' },
    });

    expect(state.phase).toBe('failed');
    expect(state.outcome?.verdict).toBe('fail');
  });

  it('maps an error event to the errored phase', () => {
    const state = applyStreamEvent(initialEditorViewState(), {
      kind: 'error',
      seq: 2,
      data: { message: 'infra failure' },
    });

    expect(state.phase).toBe('errored');
    expect(state.outcome).toEqual({ verdict: 'error', detail: 'infra failure' });
  });
});

describe('applyStreamEvent untrusted-data handling', () => {
  it('fails safe to error when the verdict is missing', () => {
    const state = applyStreamEvent(initialEditorViewState(), { kind: 'result', seq: 0, data: {} });

    expect(state.phase).toBe('errored');
    expect(state.outcome?.verdict).toBe('error');
  });

  it('falls back to a default message when data is not an object', () => {
    const state = applyStreamEvent(initialEditorViewState(), {
      kind: 'progress',
      seq: 0,
      data: 'not-an-object',
    });

    expect(state.progress[0]?.message).toBe('working');
  });

  it('does not throw on null data and still records the event', () => {
    const state = applyStreamEvent(initialEditorViewState(), { kind: 'error', seq: 0, data: null });

    expect(state.phase).toBe('errored');
    expect(state.outcome?.detail).toBe('run failed');
  });
});

describe('applyStreamEvent terminal immutability', () => {
  it('ignores any event once a terminal phase is reached', () => {
    const terminal = applyStreamEvent(initialEditorViewState(), {
      kind: 'result',
      seq: 0,
      data: { verdict: 'pass' },
    });
    const after: GatewayStreamEvent = { kind: 'result', seq: 1, data: { verdict: 'fail' } };

    expect(applyStreamEvent(terminal, after)).toBe(terminal);
  });
});

describe('isTerminalPhase', () => {
  it('is true only for settled phases', () => {
    expect(isTerminalPhase('idle')).toBe(false);
    expect(isTerminalPhase('running')).toBe(false);
    expect(isTerminalPhase('passed')).toBe(true);
    expect(isTerminalPhase('failed')).toBe(true);
    expect(isTerminalPhase('errored')).toBe(true);
  });
});
