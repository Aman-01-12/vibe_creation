// Unit tests for the Editor skeleton wiring (task 6.2).
//
// These assert the full submit -> consume -> render loop against a fake gateway
// (no network, no browser): the hardcoded sample is submitted, progress renders
// incrementally, and the run settles on the streamed verdict. The fake gateway
// stands in for the typed tRPC client, keeping the Editor's only outbound seam
// under test without a provider.

import { describe, expect, it } from 'vitest';

import type { GatewayStreamEvent, SkeletonSimulationInput } from '@app/api';

import {
  createTextEditorView,
  EditorSkeleton,
  renderEditorViewState,
  type EditorGatewayClient,
} from './index.js';
import { SAMPLE_SKELETON_SIMULATION } from './sample-design.js';
import { initialEditorViewState } from './view-state.js';

/** A gateway that replays a fixed event script and records the submitted input. */
class FakeGateway implements EditorGatewayClient {
  submitted: SkeletonSimulationInput | null = null;
  readonly #events: readonly GatewayStreamEvent[];

  constructor(events: readonly GatewayStreamEvent[]) {
    this.#events = events;
  }

  runSkeletonSimulation(input: SkeletonSimulationInput): AsyncIterable<GatewayStreamEvent> {
    this.submitted = input;
    const events = this.#events;
    return {
      async *[Symbol.asyncIterator](): AsyncIterator<GatewayStreamEvent> {
        for (const event of events) {
          await Promise.resolve();
          yield event;
        }
      },
    };
  }
}

describe('EditorSkeleton.runSample', () => {
  it('submits the hardcoded sample and renders through to a pass verdict', async () => {
    const gateway = new FakeGateway([
      { kind: 'progress', seq: 0, data: { message: 'compiling' } },
      { kind: 'progress', seq: 1, data: { message: 'simulating' } },
      { kind: 'result', seq: 2, data: { verdict: 'pass', message: 'all checks passed' } },
    ]);
    const rendered: string[] = [];
    const editor = new EditorSkeleton(
      gateway,
      createTextEditorView((line) => rendered.push(line)),
    );

    const final = await editor.runSample();

    expect(gateway.submitted).toBe(SAMPLE_SKELETON_SIMULATION);
    expect(final.phase).toBe('passed');
    // Initial idle render, then one render per streamed event.
    expect(rendered).toHaveLength(4);
    expect(rendered[0]).toContain('[idle]');
    expect(rendered.at(-1)).toContain('[passed]');
    expect(rendered.at(-1)).toContain('verdict=pass');
  });

  it('renders a failing run through to the failed phase', async () => {
    const gateway = new FakeGateway([{ kind: 'result', seq: 0, data: { verdict: 'fail' } }]);
    const editor = new EditorSkeleton(
      gateway,
      createTextEditorView(() => undefined),
    );

    const final = await editor.runSample();

    expect(final.phase).toBe('failed');
  });
});

describe('renderEditorViewState', () => {
  it('renders the idle state with no progress lines', () => {
    expect(renderEditorViewState(initialEditorViewState())).toBe(
      '[idle] 0 update(s) | last event none',
    );
  });

  it('lists progress lines under a running header', () => {
    const text = renderEditorViewState({
      phase: 'running',
      progress: [
        { seq: 0, message: 'compiling' },
        { seq: 1, message: 'simulating' },
      ],
      lastEventId: 1,
      outcome: null,
    });

    expect(text).toContain('[running] 2 update(s) | last event #1');
    expect(text).toContain('  #0 compiling');
    expect(text).toContain('  #1 simulating');
  });
});
