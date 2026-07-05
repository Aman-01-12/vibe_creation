// Unit tests for the non-blocking gateway stream consumer (task 6.2).
//
// These drive the consumer against a fake async event source (no browser, no
// network) and assert the behavior the M0 spine relies on: the view state updates
// incrementally as events arrive, the run settles on the correct pass/fail/error
// verdict, a terminal error event is handled, late events after a terminal are
// ignored, the consumer never blocks the event loop, and aborting tears the
// stream down.

import { describe, expect, it } from 'vitest';

import type { GatewayStreamEvent } from '@app/api';

import { consumeGatewayStream } from './stream-consumer.js';
import type { EditorPhase, EditorViewState } from './view-state.js';

/** Yield a fixed list of events as an async iterable, awaiting a tick between each. */
async function* fromEvents(
  events: readonly GatewayStreamEvent[],
): AsyncIterable<GatewayStreamEvent> {
  for (const event of events) {
    await Promise.resolve();
    yield event;
  }
}

/** A progress event with an optional message. */
function progress(seq: number, message?: string): GatewayStreamEvent {
  return { kind: 'progress', seq, data: message === undefined ? {} : { message } };
}

/** A terminal result event carrying a verdict. */
function result(seq: number, verdict: string, message?: string): GatewayStreamEvent {
  return { kind: 'result', seq, data: { verdict, ...(message === undefined ? {} : { message }) } };
}

/** A terminal stream/tool error event. */
function errorEvent(seq: number, message?: string): GatewayStreamEvent {
  return { kind: 'error', seq, data: message === undefined ? {} : { message } };
}

describe('consumeGatewayStream incremental updates', () => {
  it('emits a state per event and lands on passed for a passing run', async () => {
    const states: EditorViewState[] = [];
    const events = [
      progress(0, 'compiling'),
      progress(1, 'simulating'),
      result(2, 'pass', 'all checks passed'),
    ];

    const final = await consumeGatewayStream(fromEvents(events), {
      onState: (state) => states.push(state),
    });

    expect(states.map((state) => state.phase)).toEqual<EditorPhase[]>([
      'running',
      'running',
      'passed',
    ]);
    expect(states[0]?.progress).toHaveLength(1);
    expect(states[1]?.progress).toHaveLength(2);
    expect(final.phase).toBe('passed');
    expect(final.outcome).toEqual({ verdict: 'pass', detail: 'all checks passed' });
    expect(final.lastEventId).toBe(2);
  });

  it('lands on failed when the terminal result verdict is fail', async () => {
    const final = await consumeGatewayStream(fromEvents([progress(0), result(1, 'fail')]));

    expect(final.phase).toBe('failed');
    expect(final.outcome?.verdict).toBe('fail');
    expect(final.lastEventId).toBe(1);
  });

  it('handles a terminal error event as an errored run', async () => {
    const final = await consumeGatewayStream(
      fromEvents([progress(0, 'starting'), errorEvent(1, 'sandbox timeout')]),
    );

    expect(final.phase).toBe('errored');
    expect(final.outcome).toEqual({ verdict: 'error', detail: 'sandbox timeout' });
    expect(final.progress).toHaveLength(1);
  });

  it('fails safe to error when a result verdict is missing or invalid', async () => {
    const final = await consumeGatewayStream(
      fromEvents([{ kind: 'result', seq: 0, data: { verdict: 'bogus' } }]),
    );

    expect(final.phase).toBe('errored');
    expect(final.outcome?.verdict).toBe('error');
  });
});

describe('consumeGatewayStream termination and safety', () => {
  it('stops at the first terminal event and ignores anything after it', async () => {
    const states: EditorViewState[] = [];
    const events = [result(0, 'pass'), progress(1, 'late'), result(2, 'fail')];

    const final = await consumeGatewayStream(fromEvents(events), {
      onState: (state) => states.push(state),
    });

    expect(states).toHaveLength(1);
    expect(final.phase).toBe('passed');
    expect(final.lastEventId).toBe(0);
  });

  it('returns the idle state for an empty stream', async () => {
    const final = await consumeGatewayStream(fromEvents([]));

    expect(final.phase).toBe('idle');
    expect(final.lastEventId).toBeNull();
  });

  it('does not block the event loop while consuming', async () => {
    let macrotaskRan = false;
    setTimeout(() => {
      macrotaskRan = true;
    }, 0);

    // A source that yields across real macrotask boundaries: if the consumer
    // blocked the loop it would starve the timer above, which must fire during
    // consumption because the loop stays free between events.
    async function* spanningMacrotasks(): AsyncIterable<GatewayStreamEvent> {
      for (const event of [progress(0), progress(1), result(2, 'pass')]) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        yield event;
      }
    }

    await consumeGatewayStream(spanningMacrotasks());

    expect(macrotaskRan).toBe(true);
  });
});

describe('consumeGatewayStream cancellation', () => {
  it('stops consuming and releases the source when aborted mid-stream', async () => {
    const controller = new AbortController();
    let returned = false;
    let produced = 0;

    const source: AsyncIterable<GatewayStreamEvent> = {
      [Symbol.asyncIterator]: () => ({
        next: async (): Promise<IteratorResult<GatewayStreamEvent>> => {
          await Promise.resolve();
          produced += 1;
          if (produced === 2) {
            controller.abort();
          }
          return { value: progress(produced - 1), done: false };
        },
        return: (): Promise<IteratorResult<GatewayStreamEvent>> => {
          returned = true;
          return Promise.resolve({ value: undefined, done: true });
        },
      }),
    };

    const final = await consumeGatewayStream(source, { signal: controller.signal });

    expect(returned).toBe(true);
    expect(final.phase).toBe('running');
    // The loop exits once the abort is observed rather than running unbounded.
    expect(produced).toBeLessThanOrEqual(3);
  });
});
