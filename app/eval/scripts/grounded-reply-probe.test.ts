// The Reply-format probe's OFFLINE half (testbench-spec-grounding, C18): `--parse` over
// committed fixture replies, with a router that fails the test if it is called.
//
// The fixtures are one reply per outcome the parser can reach, so the tally this prints is
// pinned against a known set rather than against whatever the models happened to send.

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseSavedReplies, probeOutcomeOf, readSavedReplies } from './grounded-reply-probe.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(HERE, 'fixtures/grounded-reply-probe');

describe('the Reply-format probe, parsing saved replies', () => {
  it('tallies one reply per outcome, per Model_Arm, making no call at all', async () => {
    // No router is constructed on this path: `--parse` reads files and nothing else, which is
    // what makes a parser fix re-measurable against the same replies for free.
    const tally = await parseSavedReplies(FIXTURES);

    expect(tally.modelA).toMatchObject({ accepted: 2, 'not-json': 0, 'no-fence': 1 });
    expect(tally.modelB).toMatchObject({
      accepted: 0,
      'multiple-fences': 1,
      'unterminated-fence': 1,
      'empty-source': 1,
      'oversize-source': 1,
    });
  });

  it('reads each saved reply back with the arm and design its name carries', async () => {
    const replies = await readSavedReplies(FIXTURES);

    expect(replies).toHaveLength(7);
    expect(replies.map((reply) => reply.modelArm)).toEqual([
      'modelA',
      'modelA',
      'modelA',
      'modelB',
      'modelB',
      'modelB',
      'modelB',
    ]);
    expect(replies[0]?.problemId).toBe('design1');
  });

  it('reports no replies, rather than throwing, for a directory that does not exist', async () => {
    expect(await readSavedReplies(resolve(FIXTURES, 'absent'))).toEqual([]);
  });

  it('classifies a JSON envelope as no-fence, which is the measurement that matters', () => {
    // A model that answers in the OLD contract is a format refusal and not a bad testbench:
    // this is exactly the class the probe exists to find before the Campaign pays for it.
    expect(probeOutcomeOf('{"source": "module tb; endmodule"}')).toBe('no-fence');
    expect(probeOutcomeOf('```verilog\nmodule tb; endmodule\n```')).toBe('accepted');
  });
});
