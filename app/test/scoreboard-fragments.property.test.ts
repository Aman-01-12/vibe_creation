// testbench-in-order-scoreboard, Properties 8 and 9: the Model_Fragment validator accepts its
// whole grammar byte-for-byte and refuses everything outside it, at the right criterion.
//
// This is a trust boundary, so the refusal side is the one that matters: each mutation below is
// a way model text could reach the host, time a comparison, print a verdict, or touch scoreboard
// state, and each must be refused rather than spliced.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  assembleScoreboardTestbench,
  MAX_STIMULUS_CALLS,
  parseFragmentReply,
  renderScoreboardScaffold,
  type FragmentTargets,
} from '@app/agent';
import type { ModuleInterface } from '@app/core';

import { propertyParameters } from './property.js';

const PROPERTY_8 =
  'Feature: testbench-in-order-scoreboard, Property 8: The validator accepts its whole grammar unchanged';
const PROPERTY_7 =
  'Feature: testbench-in-order-scoreboard, Property 7: Assembly preserves the skeleton';
const PROPERTY_9 =
  'Feature: testbench-in-order-scoreboard, Property 9: The validator refuses everything outside its grammar';

const TARGETS: FragmentTargets = {
  dataInputs: [{ name: 'a' }, { name: 'b' }],
  dataOutputs: [{ name: 'q' }, { name: 'r' }],
  checkNames: ['ac1_first', 'ac2_second'],
};

const BINARY = ['+', '-', '*', '&', '|', '^', '==', '!=', '<', '>=', '<<', '&&', '||'];
const UNARY = ['~', '!', '-'];
const NUMBERS = ['0', '7', "8'hff", "4'b1010", "1'b0"];

/** An Expectation expression over the recorded inputs of a run of `runLength`. */
function arbExpectation(runLength: number): fc.Arbitrary<string> {
  const leaf = fc.oneof(
    fc
      .tuple(fc.constantFrom('a', 'b'), fc.integer({ min: 0, max: runLength - 1 }))
      .map(([port, index]) => `txn_${port}[${String(index)}]`),
    fc.constantFrom(...NUMBERS),
  );
  const { tree } = fc.letrec<{ tree: string }>((self) => ({
    tree: fc.oneof(
      { depthSize: 'small', withCrossShrink: true },
      leaf,
      fc
        .tuple(self('tree'), fc.constantFrom(...BINARY), self('tree'))
        .map(([l, op, r]) => `${l} ${op} ${r}`),
      fc.tuple(fc.constantFrom(...UNARY), self('tree')).map(([op, e]) => `${op}(${e})`),
      self('tree').map((e) => `(${e})`),
      fc.tuple(self('tree'), self('tree')).map(([l, r]) => `{${l}, ${r}}`),
      fc.tuple(self('tree'), self('tree'), self('tree')).map(([c, t, e]) => `${c} ? ${t} : ${e}`),
    ),
  }));
  return tree;
}

type Stmt = { text: string; calls: number };

/** Loop-free statements. A loop body draws only from these, so nested loops never share a var. */
const arbLoopFree: fc.Arbitrary<Stmt> = fc.letrec<{ stmt: Stmt }>((self) => ({
  stmt: fc.oneof(
    { depthSize: 'small' },
    fc.constantFrom({ text: 'send_transaction;', calls: 1 }, { text: 'idle_cycle;', calls: 1 }),
    fc
      .tuple(
        fc.constantFrom('stage_a', 'stage_b'),
        fc.constantFrom('stim_i + 1', '$random', "8'h5a", 'stage_a ^ 3'),
      )
      .map(([target, value]) => ({ text: `${target} = ${value};`, calls: 0 })),
    fc.tuple(fc.integer({ min: 0, max: 3 }), self('stmt')).map(([n, body]) => ({
      text: `repeat (${String(n)}) ${body.text}`,
      calls: n * body.calls,
    })),
    fc.tuple(self('stmt'), self('stmt')).map(([then, other]) => ({
      text: `if (stage_a == 0) ${then.text} else ${other.text}`,
      calls: Math.max(then.calls, other.calls),
    })),
    fc.array(self('stmt'), { maxLength: 3 }).map((body) => ({
      text: `begin ${body.map((s) => s.text).join(' ')} end`,
      calls: body.reduce((sum, s) => sum + s.calls, 0),
    })),
  ),
})).stmt;

const arbLoop: fc.Arbitrary<Stmt> = fc
  .tuple(fc.integer({ min: 0, max: 4 }), fc.integer({ min: 1, max: 2 }), arbLoopFree)
  .map(([to, step, body]) => ({
    text: `for (stim_j = 0; stim_j < ${String(to)}; stim_j = stim_j + ${String(step)}) ${body.text}`,
    calls: Math.ceil(to / step) * body.calls,
  }));

/** A stimulus fragment: sibling loops may reuse a variable, because none encloses another. */
const arbStatement: fc.Arbitrary<Stmt> = fc
  .array(fc.oneof(arbLoopFree, arbLoop), { minLength: 1, maxLength: 3 })
  .map((parts) => ({
    text: parts.map((p) => p.text).join(' '),
    calls: parts.reduce((sum, p) => sum + p.calls, 0),
  }));

/** A whole accepted reply, as the object the model would send. */
const arbAcceptedReply = fc
  .integer({ min: 1, max: 8 })
  .chain((runLength) =>
    fc.record({
      runLength: fc.constant(runLength),
      expectations: fc.record({ q: arbExpectation(runLength), r: arbExpectation(runLength) }),
      stimulus: fc.record({ ac1_first: arbStatement, ac2_second: arbStatement }),
    }),
  )
  .filter(
    (reply) =>
      reply.stimulus.ac1_first.calls + reply.stimulus.ac2_second.calls <= MAX_STIMULUS_CALLS,
  )
  .map((reply) => ({
    runLength: reply.runLength,
    expectations: reply.expectations,
    stimulus: {
      ac1_first: reply.stimulus.ac1_first.text,
      ac2_second: reply.stimulus.ac2_second.text,
    },
  }));

describe(PROPERTY_8, () => {
  it('accepts every reply its grammar generates, returning each fragment byte-identical', () => {
    fc.assert(
      fc.property(arbAcceptedReply, (reply) => {
        const parsed = parseFragmentReply(JSON.stringify(reply), TARGETS);
        expect(parsed.ok ? null : parsed.error).toBeNull();
        if (!parsed.ok) {
          return;
        }
        expect(parsed.value.runLength).toBe(reply.runLength);
        expect(Object.fromEntries(parsed.value.expectations)).toEqual(reply.expectations);
        expect(Object.fromEntries(parsed.value.stimulus)).toEqual(reply.stimulus);
      }),
      propertyParameters(),
    );
  });
});

type Reply = {
  runLength: unknown;
  expectations: Record<string, unknown>;
  stimulus: Record<string, unknown>;
};

/** One way out of the grammar, and the fragment and criterion its refusal must name. */
interface Mutation {
  readonly name: string;
  readonly fragment: string;
  readonly criterion: '4.7' | '4.11' | '4.12';
  readonly apply: (reply: Reply) => Reply;
}

const setExpectation =
  (text: string) =>
  (r: Reply): Reply => ({ ...r, expectations: { ...r.expectations, q: text } });
const setStimulus =
  (text: string) =>
  (r: Reply): Reply => ({ ...r, stimulus: { ...r.stimulus, ac1_first: text } });
const E = 'expectations.q';
const S = 'stimulus.ac1_first';

const MUTATIONS: readonly Mutation[] = [
  { name: 'reads a data output', fragment: E, criterion: '4.11', apply: setExpectation('q + 1') },
  {
    name: 'reads the qualifier',
    fragment: E,
    criterion: '4.11',
    apply: setExpectation('valid_out'),
  },
  {
    name: 'index past the run',
    fragment: E,
    criterion: '4.11',
    apply: setExpectation('txn_a[99]'),
  },
  {
    name: 'non-constant index',
    fragment: E,
    criterion: '4.11',
    apply: setExpectation('txn_a[sb_head]'),
  },
  {
    name: 'two expressions',
    fragment: E,
    criterion: '4.11',
    apply: setExpectation('txn_a[0]; txn_b[0]'),
  },
  { name: 'reads time', fragment: E, criterion: '4.11', apply: setExpectation('$time') },
  { name: 'empty expression', fragment: E, criterion: '4.11', apply: setExpectation('  ') },
  { name: 'host system task', fragment: S, criterion: '4.12', apply: setStimulus("$fopen(8'h1);") },
  { name: 'prints a verdict', fragment: S, criterion: '4.12', apply: setStimulus('$display(1);') },
  { name: 'string literal', fragment: S, criterion: '4.12', apply: setStimulus('stage_a = "x";') },
  { name: 'closes the block', fragment: S, criterion: '4.12', apply: setStimulus('end') },
  {
    name: 'opens a module',
    fragment: S,
    criterion: '4.12',
    apply: setStimulus('module m; endmodule'),
  },
  {
    name: 'declares a task',
    fragment: S,
    criterion: '4.12',
    apply: setStimulus('task t; endtask'),
  },
  {
    name: 'delay control',
    fragment: S,
    criterion: '4.12',
    apply: setStimulus('#1 send_transaction;'),
  },
  {
    name: 'event control',
    fragment: S,
    criterion: '4.12',
    apply: setStimulus('@(posedge clk) send_transaction;'),
  },
  {
    name: 'unbounded loop',
    fragment: S,
    criterion: '4.12',
    apply: setStimulus('while (1) send_transaction;'),
  },
  { name: 'writes a port', fragment: S, criterion: '4.12', apply: setStimulus('a = 1;') },
  { name: 'touches the queue', fragment: S, criterion: '4.12', apply: setStimulus('sb_tail = 0;') },
  {
    name: 'reads a recorded input',
    fragment: S,
    criterion: '4.12',
    apply: setStimulus('stage_a = txn_a[0];'),
  },
  {
    name: 'nonblocking write',
    fragment: S,
    criterion: '4.12',
    apply: setStimulus('stage_a <= 1;'),
  },
  { name: 'comment', fragment: S, criterion: '4.12', apply: setStimulus('send_transaction; // x') },
  { name: 'directive', fragment: S, criterion: '4.12', apply: setStimulus('`define X 1') },
  {
    name: 'over the call bound',
    fragment: S,
    criterion: '4.12',
    apply: setStimulus('repeat (513) send_transaction;'),
  },
  {
    name: 'extra key',
    fragment: 'reply',
    criterion: '4.7',
    apply: (r) => ({ ...r, extra: 1 }) as Reply,
  },
  {
    name: 'run length zero',
    fragment: 'runLength',
    criterion: '4.7',
    apply: (r) => ({ ...r, runLength: 0 }),
  },
  {
    name: 'run length fractional',
    fragment: 'runLength',
    criterion: '4.7',
    apply: (r) => ({ ...r, runLength: 1.5 }),
  },
  {
    name: 'missing output key',
    fragment: 'expectations',
    criterion: '4.7',
    apply: (r) => ({ ...r, expectations: { q: r.expectations.q } }),
  },
  {
    name: 'non-string fragment',
    fragment: S,
    criterion: '4.7',
    apply: (r) => ({ ...r, stimulus: { ...r.stimulus, ac1_first: 3 } }),
  },
];

describe(PROPERTY_9, () => {
  it('refuses each mutation of an accepted reply under the criterion it breaks', () => {
    const seen = new Set<string>();
    fc.assert(
      fc.property(arbAcceptedReply, fc.constantFrom(...MUTATIONS), (reply, mutation) => {
        seen.add(mutation.name);
        const parsed = parseFragmentReply(JSON.stringify(mutation.apply(reply)), TARGETS);
        expect(parsed.ok).toBe(false);
        if (parsed.ok) {
          return;
        }
        // An earlier key can refuse first only when it is the same fragment the mutation hit.
        expect({ fragment: parsed.error.fragment, criterion: parsed.error.criterion }).toEqual({
          fragment: mutation.fragment,
          criterion: mutation.criterion,
        });
        expect(parsed.error.construct).toMatch(/^[ -~]{1,32}$/);
      }),
      propertyParameters({ numRuns: MUTATIONS.length * 10 }),
    );
    // Non-vacuity: every mutation was actually drawn.
    expect(seen.size).toBe(MUTATIONS.length);
  });

  it('returns a result and never throws for any text', () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.json()), (raw) => {
        expect(() => parseFragmentReply(raw, TARGETS)).not.toThrow();
      }),
      propertyParameters(),
    );
  });
});

/** The interface TARGETS describes: inputs `a` and `b`, qualifier `valid_out`, outputs `q`, `r`. */
const TARGET_INTERFACE: ModuleInterface = {
  validityOutputName: null,
  moduleName: 'two_by_two',
  ports: [
    { name: 'clk', direction: 'input', width: 1 },
    { name: 'a', direction: 'input', width: 8 },
    { name: 'b', direction: 'input', width: 8 },
    { name: 'valid_out', direction: 'output', width: 1 },
    { name: 'q', direction: 'output', width: 8 },
    { name: 'r', direction: 'output', width: 8 },
  ],
  clocking: { clockName: 'clk', resetName: null, resetActiveLow: false },
};

describe(PROPERTY_7, () => {
  it('splices exactly the validated text at each slot and changes nothing else', () => {
    const rendered = renderScoreboardScaffold(TARGET_INTERFACE, TARGETS.checkNames);
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) {
      return;
    }
    const scaffold = rendered.value;
    // Split the scaffold on its slot markers independently of the assembler's own split.
    const pieces = scaffold.text.split(/\/\*@SLOT ([^@]+)@\*\//);
    fc.assert(
      fc.property(arbAcceptedReply, (reply) => {
        const parsed = parseFragmentReply(JSON.stringify(reply), TARGETS);
        if (!parsed.ok) {
          throw new Error('the accepted-reply generator produced a refused reply');
        }
        const fills: Record<string, string> = {
          runLength: String(reply.runLength),
          'expectations.q': reply.expectations.q,
          'expectations.r': reply.expectations.r,
          'stimulus.ac1_first': reply.stimulus.ac1_first,
          'stimulus.ac2_second': reply.stimulus.ac2_second,
        };
        const expected = pieces
          .map((piece, index) => (index % 2 === 0 ? piece : (fills[piece] ?? '<missing>')))
          .join('');
        const assembled = assembleScoreboardTestbench(scaffold, parsed.value);
        expect(assembled).toBe(expected);
        expect(assembled).not.toContain('/*@SLOT');
      }),
      propertyParameters(),
    );
  });
});

// Three shapes the paid run's first 52 slots showed models writing for the grammar's own meaning.
describe('the grammar accepts the measured spellings of its own constructs', () => {
  const reply = (overrides: Record<string, unknown>): string =>
    JSON.stringify({
      runLength: 2,
      expectations: { q: 'txn_a[0] + txn_a[1]', r: 'txn_b[1]' },
      stimulus: { ac1_first: 'stage_a = 1; send_transaction;', ac2_second: 'idle_cycle;' },
      ...overrides,
    });

  it('reads a decimal-string runLength as the same integer, and still bounds it', () => {
    const parsed = parseFragmentReply(reply({ runLength: '2' }), TARGETS);
    expect(parsed.ok && parsed.value.runLength).toBe(2);
    expect(parseFragmentReply(reply({ runLength: '17' }), TARGETS).ok).toBe(false);
    expect(parseFragmentReply(reply({ runLength: '2.0' }), TARGETS).ok).toBe(false);
  });

  it('accepts a zero-argument call written with parentheses', () => {
    const stimulus = { ac1_first: 'send_transaction();', ac2_second: 'idle_cycle ( ) ;' };
    expect(parseFragmentReply(reply({ stimulus }), TARGETS).ok).toBe(true);
    const withArgument = { ac1_first: 'send_transaction(1);', ac2_second: 'idle_cycle;' };
    expect(parseFragmentReply(reply({ stimulus: withArgument }), TARGETS).ok).toBe(false);
  });

  it('accepts a constant bit-select of a loop counter, and nothing else in the brackets', () => {
    const loop = 'for (stim_i = 0; stim_i < 4; stim_i = stim_i + 1) begin';
    const bit = {
      ac1_first: `${loop} stage_a = stim_i[0]; send_transaction; end`,
      ac2_second: 'idle_cycle;',
    };
    expect(parseFragmentReply(reply({ stimulus: bit }), TARGETS).ok).toBe(true);
    const variable = {
      ...bit,
      ac1_first: `${loop} stage_a = stim_i[stim_j]; send_transaction; end`,
    };
    expect(parseFragmentReply(reply({ stimulus: variable }), TARGETS).ok).toBe(false);
  });
});
