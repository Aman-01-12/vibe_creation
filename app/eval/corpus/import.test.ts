// Unit tests for the RTLLM importer, driven through an IN-MEMORY checkout.
//
// No network fetch and no disk: the `CorpusCheckoutPort` seam exists so the whole
// conversion - id derivation, interface derivation, the clock/reset split, the single
// whole-design acceptance criterion, and every quarantine path - is testable offline.
//
// The fixtures are reduced but structurally faithful to the pinned commit, including
// the three awkward realities the importer exists to handle: the reference top is
// usually prefixed `verified_`, is sometimes named something else entirely, and is not
// always the first module in its file.

import { describe, expect, it } from 'vitest';

import type { EvalProblem } from '../problem.js';
import type { CorpusCheckoutPort } from './checkout-port.js';
import type { RtllmCorpus } from './corpus-types.js';
import { importRtllmCorpus, readOverriddenParameters, renameTopModule } from './import.js';
import { RTLLM_PINNED_COMMIT } from './pinned-source.js';
import { FixedTimingDerivation, RefusingTimingDerivation } from './timing-derivation-double.js';
import type { TimingDerivationPort } from './timing-derivation-port.js';

/** One design folder's files, keyed by filename. */
type DesignFolder = Readonly<Record<string, string>>;

/** A checkout laid out as `<Category>/<Subcategory>/<design>` -> files. */
type CheckoutTree = Readonly<
  Record<string, Readonly<Record<string, Readonly<Record<string, DesignFolder>>>>>
>;

/** An in-memory `CorpusCheckoutPort` over a plain nested object. */
class FakeCheckout implements CorpusCheckoutPort {
  readonly #tree: CheckoutTree;

  constructor(tree: CheckoutTree) {
    this.#tree = tree;
  }

  listDirectories(segments: readonly string[]): Promise<readonly string[]> {
    const [category, subcategory] = segments;
    if (category === undefined) {
      return Promise.resolve(Object.keys(this.#tree).sort());
    }
    const categoryNode = this.#tree[category];
    if (categoryNode === undefined) {
      return Promise.resolve([]);
    }
    if (subcategory === undefined) {
      return Promise.resolve(Object.keys(categoryNode).sort());
    }
    return Promise.resolve(Object.keys(categoryNode[subcategory] ?? {}).sort());
  }

  listFiles(segments: readonly string[]): Promise<readonly string[]> {
    return Promise.resolve(Object.keys(this.#folder(segments) ?? {}).sort());
  }

  readTextFile(segments: readonly string[]): Promise<string | null> {
    const filename = segments[segments.length - 1];
    const folder = this.#folder(segments.slice(0, -1));
    if (folder === undefined || filename === undefined) {
      return Promise.resolve(null);
    }
    return Promise.resolve(folder[filename] ?? null);
  }

  /** The folder at `[category, subcategory, design]`, or undefined. */
  #folder(segments: readonly string[]): DesignFolder | undefined {
    const [category, subcategory, design] = segments;
    if (category === undefined || subcategory === undefined || design === undefined) {
      return undefined;
    }
    return this.#tree[category]?.[subcategory]?.[design];
  }
}

/** A description in the layout most designs use. */
function description(
  moduleName: string,
  statement: string,
  implementation = 'Do it well.',
): string {
  return [
    'Please act as a professional verilog designer.',
    statement,
    'Module name:',
    `    ${moduleName}`,
    'Input ports:',
    '    a: an input.',
    'Implementation:',
    implementation,
    'Give me the complete code.',
    '',
  ].join('\n');
}

/** A minimal golden testbench that instantiates `moduleName`. */
function testbench(moduleName: string, parameters = ''): string {
  return `module tb;
  reg clk; reg rst_n; wire [7:0] out;
  ${moduleName} ${parameters}dut (.clk(clk), .rst_n(rst_n), .out(out));
  initial $display("===========Your Design Passed===========");
endmodule
`;
}

/** A one-design checkout, with the design folder's files supplied by the caller. */
function oneDesign(designName: string, files: DesignFolder): CheckoutTree {
  return { Arithmetic: { Adder: { [designName]: files } } };
}

/**
 * Import a tree, returning the corpus.
 *
 * The default derivation succeeds for every design, because these cases are about the
 * conversion rather than the timing; the refusal path passes its own port.
 */
function importTree(
  tree: CheckoutTree,
  timing: TimingDerivationPort = new FixedTimingDerivation('combinational'),
): Promise<RtllmCorpus> {
  return importRtllmCorpus(new FakeCheckout(tree), timing);
}

/** The single imported problem, failing the test if there is not exactly one. */
function soleProblem(corpus: RtllmCorpus): EvalProblem {
  const problem = corpus.problems[0];
  if (corpus.problems.length !== 1 || problem === undefined) {
    throw new Error(
      `expected exactly one problem, got ${corpus.problems.length}; quarantined: ${JSON.stringify(corpus.quarantined)}`,
    );
  }
  return problem;
}

/** The reference RTL for a sequential design whose top carries the `verified_` prefix. */
const PREFIXED_REFERENCE = `module verified_counter_12
(
  input rst_n,
  input clk,
  input valid_count,
  output reg [3:0] out
);
endmodule
`;

describe('importRtllmCorpus - problem identity and provenance', () => {
  it('derives a stable id from the category and design folder only', async () => {
    // Not from the subcategory, the file name, or the parsed module name: upstream has
    // already moved all three, and the id feeds the deterministic per-sample seed.
    const corpus = await importTree(
      oneDesign('counter_12', {
        'design_description.txt': description('counter_12', 'Count to twelve.'),
        'testbench.v': testbench('counter_12'),
        'verified_counter_12.v': PREFIXED_REFERENCE,
        makefile: 'vcs:\n\tvcs -sverilog\n',
      }),
    );

    expect(soleProblem(corpus).id).toBe('rtllm/arithmetic/counter_12');
    expect(corpus.pinnedCommit).toBe(RTLLM_PINNED_COMMIT);
    expect(corpus.designsSeen).toBe(1);
    expect(soleProblem(corpus).source).toBe('RTLLM');
  });

  it('names the module after the description, not the prefixed reference top', async () => {
    // The golden testbench instantiates `counter_12`; the reference top is
    // `verified_counter_12`, which exists only so it does not occupy that name.
    const corpus = await importTree(
      oneDesign('counter_12', {
        'design_description.txt': description('counter_12', 'Count to twelve.'),
        'testbench.v': testbench('counter_12'),
        'verified_counter_12.v': PREFIXED_REFERENCE,
      }),
    );

    expect(soleProblem(corpus).spec.moduleInterface.moduleName).toBe('counter_12');
    expect(corpus.references.get('rtllm/arithmetic/counter_12')?.topModuleRenamedFrom).toBe(
      'verified_counter_12',
    );
  });

  it('accepts a lone reference module whose name matches neither convention', async () => {
    // `multi_pipe_4bit`'s reference top is `verified_multi_pipe`.
    const corpus = await importTree(
      oneDesign('multi_pipe_4bit', {
        'design_description.txt': description('multi_pipe_4bit', 'Multiply, pipelined.'),
        'testbench.v': testbench('multi_pipe_4bit', '#(.size(4)) '),
        'verified_multi_pipe.v': `module verified_multi_pipe#(
  parameter size = 4
)(
  input clk,
  input rst_n,
  input [size-1:0] mul_a,
  output reg [size*2-1:0] mul_out
);
endmodule
`,
      }),
    );

    const problem = soleProblem(corpus);
    expect(problem.spec.moduleInterface.moduleName).toBe('multi_pipe_4bit');
    expect(problem.spec.moduleInterface.ports.map((port) => port.width)).toEqual([4, 8]);
  });
});

describe('importRtllmCorpus - the derived module interface', () => {
  it('takes ports, directions, and widths from the reference declaration', async () => {
    const corpus = await importTree(
      oneDesign('counter_12', {
        'design_description.txt': description('counter_12', 'Count to twelve.'),
        'testbench.v': testbench('counter_12'),
        'verified_counter_12.v': PREFIXED_REFERENCE,
      }),
    );

    const moduleInterface = soleProblem(corpus).spec.moduleInterface;
    expect(
      moduleInterface.ports.map((port) => `${port.direction} ${port.name}[${port.width}]`),
    ).toEqual(['input valid_count[1]', 'output out[4]']);
  });

  it('lifts a single clock and reset into the clocking contract, not the port list', async () => {
    // The Spec keeps clock/reset separate from declared ports; duplicating them would
    // make the generation interface check reject a correct candidate.
    const corpus = await importTree(
      oneDesign('counter_12', {
        'design_description.txt': description('counter_12', 'Count to twelve.'),
        'testbench.v': testbench('counter_12'),
        'verified_counter_12.v': PREFIXED_REFERENCE,
      }),
    );

    const clocking = soleProblem(corpus).spec.moduleInterface.clocking;
    expect(clocking).toEqual({ clockName: 'clk', resetName: 'rst_n', resetActiveLow: true });
    expect(soleProblem(corpus).spec.moduleInterface.ports.map((port) => port.name)).not.toContain(
      'clk',
    );
  });

  it('leaves the clocking contract empty for a multi-clock design', async () => {
    // `asyn_fifo` has wclk/rclk and wrstn/rrstn: a single-clock contract cannot
    // describe it, so both stay ordinary declared inputs rather than one being picked.
    const corpus = await importTree({
      Memory: {
        FIFO: {
          asyn_fifo: {
            'design_description.txt': description('asyn_fifo', 'An async FIFO.'),
            'testbench.v': testbench('asyn_fifo'),
            'verified_asyn_fifo.v': `module verified_asyn_fifo(
  input wclk,
  input rclk,
  input wrstn,
  input rrstn,
  output wire wfull
);
endmodule
`,
          },
        },
      },
    });

    const moduleInterface = soleProblem(corpus).spec.moduleInterface;
    expect(moduleInterface.clocking).toEqual({
      clockName: null,
      resetName: null,
      resetActiveLow: false,
    });
    expect(moduleInterface.ports.map((port) => port.name)).toEqual([
      'wclk',
      'rclk',
      'wrstn',
      'rrstn',
      'wfull',
    ]);
  });

  it('does not treat an output named clk as the module clock', async () => {
    // `clkgenerator` GENERATES the clock; lifting it into the contract would turn a
    // required output into a required input.
    const corpus = await importTree(
      oneDesign('clkgenerator', {
        'design_description.txt': description('clkgenerator', 'Generate a clock.'),
        'testbench.v': testbench('clkgenerator'),
        'clkgenerator.v': 'module clkgenerator (output reg clk);\nendmodule\n',
      }),
    );

    const moduleInterface = soleProblem(corpus).spec.moduleInterface;
    expect(moduleInterface.clocking.clockName).toBeNull();
    expect(moduleInterface.ports).toEqual([{ name: 'clk', direction: 'output', width: 1 }]);
  });
});

describe('importRtllmCorpus - the Spec and its single acceptance criterion', () => {
  it('carries exactly one measurable, simulation-verifiable whole-design criterion', async () => {
    // RTLLM ships ONE whole-design golden testbench, so one whole-design criterion is
    // the only claim the corpus can back. Splitting it would invent structure that
    // nothing verifies.
    const corpus = await importTree(
      oneDesign('counter_12', {
        'design_description.txt': description('counter_12', 'Count to twelve, then wrap.'),
        'testbench.v': testbench('counter_12'),
        'verified_counter_12.v': PREFIXED_REFERENCE,
      }),
    );

    const criteria = soleProblem(corpus).spec.acceptanceCriteria;
    expect(criteria).toHaveLength(1);
    expect(criteria[0]?.measurable).toBe(true);
    expect(criteria[0]?.method).toBe('simulation');
    expect(criteria[0]?.text).toContain('Count to twelve, then wrap.');
  });

  it('never mentions the golden testbench in the criterion the agent derives from', async () => {
    // The Testbench_Agent derives its independent testbench from these criteria. A
    // criterion naming the judge would be circular and would leak the judge.
    const corpus = await importTree(
      oneDesign('counter_12', {
        'design_description.txt': description('counter_12', 'Count to twelve.'),
        'testbench.v': testbench('counter_12'),
        'verified_counter_12.v': PREFIXED_REFERENCE,
      }),
    );

    const text = soleProblem(corpus).spec.acceptanceCriteria[0]?.text ?? '';
    expect(text.toLowerCase()).not.toContain('testbench');
    expect(text.toLowerCase()).not.toContain('golden');
  });

  it('produces an approved Spec with the description as goal and architecture', async () => {
    const corpus = await importTree(
      oneDesign('counter_12', {
        'design_description.txt': description(
          'counter_12',
          'Count to twelve.',
          'A single clocked always block.',
        ),
        'testbench.v': testbench('counter_12'),
        'verified_counter_12.v': PREFIXED_REFERENCE,
      }),
    );

    const { spec, intentSummary } = soleProblem(corpus);
    expect(spec.approved).toBe(true);
    expect(spec.goal).toBe('Count to twelve.');
    expect(spec.architecture).toBe('A single clocked always block.');
    expect(spec.constraints).toEqual([]);
    expect(intentSummary).toBe('Count to twelve.');
  });
});

describe('importRtllmCorpus - the golden judge material', () => {
  it('keeps the golden testbench byte-identical to upstream', async () => {
    const upstream = testbench('counter_12');
    const corpus = await importTree(
      oneDesign('counter_12', {
        'design_description.txt': description('counter_12', 'Count to twelve.'),
        'testbench.v': upstream,
        'verified_counter_12.v': PREFIXED_REFERENCE,
      }),
    );

    expect(corpus.golden.get('rtllm/arithmetic/counter_12')?.testbench.contents).toBe(upstream);
  });

  it('carries the data files a testbench reads, and not the makefile or description', async () => {
    const corpus = await importTree(
      oneDesign('counter_12', {
        'design_description.txt': description('counter_12', 'Count to twelve.'),
        'testbench.v': testbench('counter_12'),
        'verified_counter_12.v': PREFIXED_REFERENCE,
        'reference.dat': '00\n01\n',
        makefile: 'vcs:\n\tvcs -sverilog\n',
      }),
    );

    const golden = corpus.golden.get('rtllm/arithmetic/counter_12');
    expect(golden?.dataFiles.map((file) => file.path)).toEqual(['reference.dat']);
    expect(golden?.dataFiles[0]?.contents).toBe('00\n01\n');
  });

  it('records the parameters the golden testbench overrides on the instantiation', async () => {
    const corpus = await importTree(
      oneDesign('multi_pipe_4bit', {
        'design_description.txt': description('multi_pipe_4bit', 'Multiply, pipelined.'),
        'testbench.v': testbench('multi_pipe_4bit', '#(.size(4)) '),
        'verified_multi_pipe.v': `module verified_multi_pipe#(parameter size = 4)(
  input clk, input rst_n, input [size-1:0] mul_a, output reg [size*2-1:0] mul_out);
endmodule
`,
      }),
    );

    expect(corpus.golden.get('rtllm/arithmetic/multi_pipe_4bit')?.overriddenParameters).toEqual([
      'size',
    ]);
  });

  it('does not place the golden testbench or the reference inside the EvalProblem', async () => {
    // Structural anti-circularity: the loop-runner receives only the EvalProblem, so
    // it cannot read the judge or the answer even by accident.
    const corpus = await importTree(
      oneDesign('counter_12', {
        'design_description.txt': description('counter_12', 'Count to twelve.'),
        'testbench.v': testbench('counter_12'),
        'verified_counter_12.v': PREFIXED_REFERENCE,
      }),
    );

    const serialized = JSON.stringify(soleProblem(corpus));
    expect(serialized).not.toContain('===========Your Design Passed===========');
    expect(serialized).not.toContain('endmodule');
  });
});

describe('importRtllmCorpus - quarantines (recorded, never silent)', () => {
  /** Import a one-design tree and return its sole quarantine record. */
  async function quarantineFor(files: DesignFolder): Promise<{ code: string; detail: string }> {
    const corpus = await importTree(oneDesign('broken', files));
    const record = corpus.quarantined[0];
    if (corpus.quarantined.length !== 1 || record === undefined) {
      throw new Error(`expected one quarantine, got ${corpus.quarantined.length}`);
    }
    expect(corpus.problems).toHaveLength(0);
    expect(record.stage).toBe('import');
    return { code: record.code, detail: record.detail };
  }

  it('quarantines a design whose description is absent', async () => {
    const record = await quarantineFor({
      'testbench.v': testbench('broken'),
      'broken.v': 'module broken(input a);\nendmodule\n',
    });
    expect(record.code).toBe('DESCRIPTION_UNREADABLE');
  });

  it('quarantines a design whose golden testbench is absent', async () => {
    const record = await quarantineFor({
      'design_description.txt': description('broken', 'Do a thing.'),
      'broken.v': 'module broken(input a);\nendmodule\n',
    });
    expect(record.code).toBe('GOLDEN_TESTBENCH_MISSING');
  });

  it('quarantines a design with more than one candidate reference file', async () => {
    const record = await quarantineFor({
      'design_description.txt': description('broken', 'Do a thing.'),
      'testbench.v': testbench('broken'),
      'broken.v': 'module broken(input a);\nendmodule\n',
      'also_broken.v': 'module also_broken(input a);\nendmodule\n',
    });
    expect(record.code).toBe('REFERENCE_FILE_AMBIGUOUS');
  });

  it('quarantines a design whose required module name is absent from its testbench', async () => {
    const record = await quarantineFor({
      'design_description.txt': description('broken', 'Do a thing.'),
      'testbench.v': testbench('something_else'),
      'broken.v': 'module broken(input a);\nendmodule\n',
    });
    expect(record.code).toBe('MODULE_NAME_ABSENT_FROM_TESTBENCH');
  });

  it('quarantines a multi-module reference where no module matches the required name', async () => {
    const record = await quarantineFor({
      'design_description.txt': description('broken', 'Do a thing.'),
      'testbench.v': testbench('broken'),
      'ref.v': 'module one(input a);\nendmodule\nmodule two(input b);\nendmodule\n',
    });
    expect(record.code).toBe('REFERENCE_TOP_MODULE_AMBIGUOUS');
  });

  it('quarantines a design whose rename would collide with another declared module', async () => {
    const record = await quarantineFor({
      'design_description.txt': description('broken', 'Do a thing.'),
      'testbench.v': testbench('broken'),
      'ref.v':
        'module broken_helper(input a);\nendmodule\nmodule verified_broken(input b);\nendmodule\nmodule broken(input c);\nendmodule\n',
    });
    // `verified_broken` is preferred as the top, but `broken` already exists.
    expect(record.code).toBe('REFERENCE_RENAME_COLLIDES');
  });

  it('quarantines a design whose port range cannot be resolved', async () => {
    const record = await quarantineFor({
      'design_description.txt': description('broken', 'Do a thing.'),
      'testbench.v': testbench('broken'),
      'broken.v': 'module broken(input [UNKNOWN-1:0] a, output y);\nendmodule\n',
    });
    expect(record.code).toBe('INTERFACE_UNPARSEABLE');
  });

  it('quarantines a design carrying a data file whose name we will not materialize', async () => {
    const record = await quarantineFor({
      'design_description.txt': description('broken', 'Do a thing.'),
      'testbench.v': testbench('broken'),
      'broken.v': 'module broken(input a);\nendmodule\n',
      'weird name with spaces.txt': 'x',
    });
    expect(record.code).toBe('DATA_FILE_NAME_UNSAFE');
  });
});

describe('importRtllmCorpus - the required Timing_Derivation (task 5.2)', () => {
  /** A design that converts cleanly, so the only thing deciding its fate is the derivation. */
  const COUNTER = oneDesign('counter_12', {
    'design_description.txt': description('counter_12', 'Count to twelve.'),
    'testbench.v': testbench('counter_12'),
    'verified_counter_12.v': PREFIXED_REFERENCE,
  });

  it('excludes a refused design, recording its cause and its named ports (Req 3.5)', async () => {
    // GIVEN a port that refuses with a design-level cause naming the undetermined output.
    const refusing = new RefusingTimingDerivation({
      cause: 'undriven-output-port',
      ports: ['out'],
    });

    const corpus = await importTree(COUNTER, refusing);

    // THEN the design is out, with the cause and the port names recorded - not defaulted in.
    expect(corpus.problems).toEqual([]);
    expect(corpus.quarantined).toEqual([
      {
        problemId: 'rtllm/arithmetic/counter_12',
        designName: 'counter_12',
        category: 'Arithmetic',
        stage: 'import',
        code: 'TIMING_UNDERIVABLE',
        detail:
          'the timing derivation refused (undriven-output-port); undetermined output ports: out',
      },
    ]);
    // Still accounted for in the denominator: excluded, never silently unseen.
    expect(corpus.designsSeen).toBe(1);
  });

  it('distinguishes an instrument failure from a design-level refusal (Req 2.3)', async () => {
    const corpus = await importTree(
      COUNTER,
      new RefusingTimingDerivation({ cause: 'netlist-unavailable', ports: ['out'] }),
    );

    expect(corpus.quarantined[0]?.detail).toContain('netlist-unavailable');
  });

  it('carries the derived Port_Timing into the imported Spec (Req 3.1)', async () => {
    // The POSITIVE CONTROL for the two cases above: a port that refused unconditionally
    // would satisfy them both, so one succeeding derivation has to reach the Spec.
    const corpus = await importTree(COUNTER, new FixedTimingDerivation('combinational'));

    expect(soleProblem(corpus).spec.timingContract).toEqual({
      entries: [{ portName: 'out', timing: 'combinational' }],
    });
  });
});

describe('renameTopModule', () => {
  it('renames the identifier on whole-word boundaries only', () => {
    const source = 'module verified_adder(a);\nfull_adder u0();\nendmodule\n';
    const renamed = renameTopModule(source, 'verified_adder', 'adder');
    expect(renamed).toContain('module adder(a)');
    // `full_adder` shares a suffix and must not be touched.
    expect(renamed).toContain('full_adder u0()');
  });

  it('returns the source unchanged when no rename is needed', () => {
    const source = 'module adder(a);\nendmodule\n';
    expect(renameTopModule(source, 'adder', 'adder')).toBe(source);
  });
});

describe('readOverriddenParameters', () => {
  it('reads every overridden parameter name in order', () => {
    const text =
      'adder_pipe_64bit #(\n .DATA_WIDTH(DATA_WIDTH),\n .STG_WIDTH(16)\n)\nu0 (.clk(CLK));';
    expect(readOverriddenParameters(text, 'adder_pipe_64bit')).toEqual(['DATA_WIDTH', 'STG_WIDTH']);
  });

  it('reports none when the testbench instantiates without an override list', () => {
    expect(readOverriddenParameters('adder_8bit uut (.a(a));', 'adder_8bit')).toEqual([]);
  });
});

describe('importRtllmCorpus - the reviewed Validity_Output table (Q-18)', () => {
  function accu(reference: string): DesignFolder {
    return {
      'design_description.txt': description('accu', 'Accumulate four inputs.'),
      'testbench.v': testbench('accu'),
      'accu.v': reference,
    };
  }

  it('declares the tabled Validity_Output for accu', async () => {
    const corpus = await importTree(
      oneDesign(
        'accu',
        accu(
          'module accu(input clk, input rst_n, output reg [9:0] data_out, output reg valid_out);\nendmodule\n',
        ),
      ),
    );
    expect(soleProblem(corpus).spec.moduleInterface.validityOutputName).toBe('valid_out');
  });

  it('quarantines accu when the tabled port is not one of its outputs', async () => {
    const corpus = await importTree(
      oneDesign(
        'accu',
        accu('module accu(input clk, input rst_n, output reg [9:0] data_out);\nendmodule\n'),
      ),
    );
    expect(corpus.problems).toEqual([]);
    expect(corpus.quarantined.map((record) => record.code)).toEqual(['VALIDITY_OUTPUT_UNDECLARED']);
  });

  it('leaves every untabled design without a Validity_Output', async () => {
    const corpus = await importTree(
      oneDesign('counter_12', {
        'design_description.txt': description('counter_12', 'Count to twelve.'),
        'testbench.v': testbench('counter_12'),
        'verified_counter_12.v': PREFIXED_REFERENCE,
      }),
    );
    expect(soleProblem(corpus).spec.moduleInterface.validityOutputName).toBeNull();
  });
});
