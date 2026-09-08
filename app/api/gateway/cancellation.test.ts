// API_Gateway boundary test for the downstream cancellation signal (task 15.10;
// Design: Error Handling, streaming and cancellation; Req 17.6).
//
// The transport-provided cancellation signal is UNTRUSTED input at the gateway.
// This pins both halves of the contract `resolveDownstreamSignal` promises:
//   - a valid inbound `AbortSignal` is passed through UNCHANGED, so a client abort
//     (unmount, navigation, or timeout) actually reaches downstream model/tool
//     calls; and
//   - absent or malformed input FAILS SAFE to a fresh, never-aborting signal, so a
//     missing signal can neither crash the pipeline nor wrongly cancel work.

import { describe, expect, it } from 'vitest';

import { resolveDownstreamSignal } from './cancellation.js';

describe('resolveDownstreamSignal passes a valid inbound signal through unchanged', () => {
  it('returns the exact same AbortSignal instance', () => {
    const controller = new AbortController();
    expect(resolveDownstreamSignal(controller.signal)).toBe(controller.signal);
  });

  it('preserves an already-aborted inbound signal', () => {
    const controller = new AbortController();
    controller.abort();
    const resolved = resolveDownstreamSignal(controller.signal);
    expect(resolved).toBe(controller.signal);
    expect(resolved.aborted).toBe(true);
  });

  it('propagates a later abort of the passed-through signal to downstream consumers', () => {
    const controller = new AbortController();
    const resolved = resolveDownstreamSignal(controller.signal);
    let downstreamSawAbort = false;
    resolved.addEventListener('abort', () => {
      downstreamSawAbort = true;
    });

    expect(resolved.aborted).toBe(false);
    controller.abort();

    expect(downstreamSawAbort).toBe(true);
    expect(resolved.aborted).toBe(true);
  });
});

describe('resolveDownstreamSignal fails safe for absent or malformed input', () => {
  const malformedInputs: ReadonlyArray<readonly [string, unknown]> = [
    ['undefined', undefined],
    ['null', null],
    ['a number', 42],
    ['a string', 'abort'],
    ['a plain object', {}],
    [
      'an object with a non-boolean aborted',
      { aborted: 'nope', addEventListener: () => undefined },
    ],
    ['an object missing addEventListener', { aborted: false }],
  ];

  for (const [label, input] of malformedInputs) {
    it(`returns a fresh, non-aborted AbortSignal for ${label}`, () => {
      const resolved = resolveDownstreamSignal(input);

      expect(resolved).toBeInstanceOf(AbortSignal);
      expect(resolved.aborted).toBe(false);
      // The fallback is never the malformed input itself.
      expect(resolved).not.toBe(input);
    });
  }

  it('returns a distinct fresh signal on each call so callers never share a fallback', () => {
    const first = resolveDownstreamSignal(undefined);
    const second = resolveDownstreamSignal(undefined);
    expect(first).not.toBe(second);
  });

  it('yields a signal that never aborts on its own (no orphaned cancellation)', async () => {
    const resolved = resolveDownstreamSignal(null);
    let aborted = false;
    resolved.addEventListener('abort', () => {
      aborted = true;
    });

    // Give any stray asynchronous abort a chance to fire; none should.
    await Promise.resolve();
    expect(aborted).toBe(false);
    expect(resolved.aborted).toBe(false);
  });
});
