// **Feature: timing-contract-inference, Property 17: The harness request carries the Spec's own contract**
//
// THE SEAM OBSERVED, AND WHY
//   `LiveReferenceModelGenerator` takes no render port, so the `ConsensusHarnessRequest` it
//   assembles is not reachable from outside the method that builds it. This file therefore drives
//   the REAL `generate` through a fake `ModelRouter` and reads the request's contract back out of
//   the rendered harness text, which is that request's only observable consequence. The renderer
//   compares a `combinational` port against `ece_exp_bits` (this step's applied input) and a
//   `registered` port against `ece_exp_reg_bits` (this step's zero-input expectation), one
//   comparison line per declared output port, so the two bundle names recover the request's
//   per-port timing exactly. Nothing here calls `renderConsensusHarness` itself and nothing here
//   reimplements the assembly: the request under test is the one the Live_Wiring actually built,
//   which is what makes this evidence for Requirements 5.1 and 5.2 rather than evidence about a
//   copy of the wiring.
//
// WHY IDENTITY AND ENTRY ORDER ARE NOT ASSERTED
//   The harness's only consumer of the contract is a lookup by port name (`timingOf` finds the
//   entry for a port), so neither the object's identity nor its entry ORDER has any rendered
//   consequence to observe - two contracts with the same per-port mapping in different orders
//   render byte-identical text. Entry-for-entry deep equality over the port-name mapping is
//   therefore the strongest claim available at this seam, and it is what is asserted. The
//   complement - that no reconstruction site exists at all, so the request's value is the Spec's
//   own object - is a source-level claim and belongs to task 6.3's scan for a deleted
//   `makeTimingContract` call, not here. Entry order is still DRAWN as a permutation of the
//   declared output ports, so a contract whose order differs from the interface's is routinely
//   exercised rather than left untested.
//
// THE DECISIVE CLAUSE
//   The deleted `buildRegisteredTimingContract` mapped every declared output port to `registered`
//   and read `spec.timingContract` not at all. An all-`registered` draw is exactly what that
//   fabrication also produces, so it cannot discriminate. The draws that can are a contract
//   carrying `combinational` for some port, and in particular a MIXED contract that carries both
//   values across the output ports of ONE interface - which no constant can reproduce. Both counts
//   are required non-zero below.
//
// GENERATOR OBLIGATIONS
//   Interfaces declare two to five output ports (two is the floor at which "mixed" is satisfiable)
//   and one to three input ports, and each contract is drawn as all-`registered`, all-
//   `combinational`, or mixed with at least one entry of each value forced by construction rather
//   than by a coin flip per port. Port names carry a drawn suffix behind an `o_i`/`i_i` prefix,
//   which keeps them unique and keeps them clear of the Verilog keywords and the harness's own
//   `ece_`-prefixed identifiers; widths play no part in the decode and are drawn small.
//
// Validates: Requirements 5.1, 5.2

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  makeBudgetLedger,
  type ModelRouter,
  type ModelTask,
  type RoutedModelResult,
} from '@app/agent';
import {
  makeTimingContract,
  ok,
  type ModuleInterface,
  type Port,
  type PortTiming,
  type Result,
  type Spec,
  type TimingContractEntry,
} from '@app/core';

import {
  LiveReferenceModelGenerator,
  modelIdFor,
} from '../eval/consensus-regression/live-wiring.js';

import { ASCII_IDENT_CHARS, stringFromChars } from './generators/chars.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  "timing-contract-inference, Property 17: The harness request carries the Spec's own contract";

/** Three contract shapes sampled uniformly; 150 runs leaves the chance of missing one negligible. */
const NUM_RUNS = 150;

/** A reference-model reply that parses and clears the Authoring_Contract for any interface: the
 * three required function bodies are interface-independent, and only `roles` has to be total over
 * the drawn input ports. Nothing compiles this text, so the body widths play no part. */
function replyFor(moduleInterface: ModuleInterface): string {
  return JSON.stringify({
    functions: [
      { name: 'ece_reset_state', body: "ece_reset_state = 128'd0;" },
      { name: 'ece_next_state', body: 'ece_next_state = s;' },
      { name: 'ece_expect', body: "ece_expect = 1'b0;" },
    ],
    roles: moduleInterface.ports
      .filter((port) => port.direction === 'input')
      .map((port) => ({ port: port.name, role: 'data' })),
  });
}

/** A `ModelRouter` answering every call with one fixed reply; it holds no credential and calls out
 * nowhere, so `generate` reaches the harness render with no model traffic. */
class ReplyingRouter implements ModelRouter {
  readonly #reply: string;

  constructor(reply: string) {
    this.#reply = reply;
  }

  invoke(task: ModelTask): Promise<Result<RoutedModelResult, never>> {
    return Promise.resolve(
      ok({
        task,
        provider: 'bedrock-mantle' as const,
        modelId: 'fake',
        outputText: this.#reply,
        tokensUsed: 0,
        costCents: 0,
        attempts: 1,
        fellBack: false,
      }),
    );
  }

  describeRouting() {
    return { tasks: [], providers: [] };
  }
}

type ContractShape = 'all-registered' | 'all-combinational' | 'mixed';
const CONTRACT_SHAPES: readonly ContractShape[] = ['all-registered', 'all-combinational', 'mixed'];
const TIMINGS: readonly PortTiming[] = ['registered', 'combinational'];

/** One drawn case: the ports to declare, the contract shape, and the order to declare entries in. */
interface Draw {
  readonly outputs: readonly { readonly suffix: string; readonly width: number }[];
  readonly inputs: readonly { readonly suffix: string; readonly width: number }[];
  readonly shape: ContractShape;
  readonly drawnTimings: readonly PortTiming[];
  readonly combinationalIndex: number;
  readonly registeredOffset: number;
  readonly entryOrder: readonly number[];
}

function portShapeArbitrary(): fc.Arbitrary<{ readonly suffix: string; readonly width: number }> {
  return fc.record({
    suffix: stringFromChars(ASCII_IDENT_CHARS, 1, 6),
    width: fc.integer({ min: 1, max: 4 }),
  });
}

function drawArbitrary(): fc.Arbitrary<Draw> {
  return fc
    .record({
      outputs: fc.array(portShapeArbitrary(), { minLength: 2, maxLength: 5 }),
      inputs: fc.array(portShapeArbitrary(), { minLength: 1, maxLength: 3 }),
      shape: fc.constantFrom(...CONTRACT_SHAPES),
    })
    .chain((base) => {
      const count = base.outputs.length;
      return fc.record<Draw>({
        outputs: fc.constant(base.outputs),
        inputs: fc.constant(base.inputs),
        shape: fc.constant(base.shape),
        drawnTimings: fc.array(fc.constantFrom(...TIMINGS), {
          minLength: count,
          maxLength: count,
        }),
        combinationalIndex: fc.nat({ max: count - 1 }),
        // A non-zero offset modulo `count` picks a DIFFERENT index, so a mixed draw always
        // carries both values rather than collapsing when the two indices coincide.
        registeredOffset: fc.integer({ min: 1, max: count - 1 }),
        entryOrder: fc.shuffledSubarray([...Array(count).keys()], {
          minLength: count,
          maxLength: count,
        }),
      });
    });
}

/** The per-port timings `draw` declares, with a mixed shape's two values forced by construction. */
function timingsOf(draw: Draw): readonly PortTiming[] {
  const count = draw.outputs.length;
  if (draw.shape === 'all-registered') {
    return Array.from({ length: count }, () => 'registered' as const);
  }
  if (draw.shape === 'all-combinational') {
    return Array.from({ length: count }, () => 'combinational' as const);
  }
  const mixed = [...draw.drawnTimings];
  mixed[draw.combinationalIndex] = 'combinational';
  mixed[(draw.combinationalIndex + draw.registeredOffset) % count] = 'registered';
  return mixed;
}

/**
 * Build the Spec one `draw` describes.
 *
 * Clocking mirrors the Live_Wiring's own unit fixture: the clock and reset are named but not
 * declared as ports, so every declared port is a data port and the contract covers every output.
 * Throws if the drawn entries fail `makeTimingContract`, which would be a generator defect: the
 * entries are a permutation of exactly the declared output ports.
 */
function specFor(draw: Draw): Spec {
  const timings = timingsOf(draw);
  const outputPorts: readonly Port[] = draw.outputs.map((shape, index) => ({
    name: `o_${String(index)}${shape.suffix}`,
    direction: 'output' as const,
    width: shape.width,
  }));
  const inputPorts: readonly Port[] = draw.inputs.map((shape, index) => ({
    name: `i_${String(index)}${shape.suffix}`,
    direction: 'input' as const,
    width: shape.width,
  }));
  const moduleInterface: ModuleInterface = {
    moduleName: 'drawn_module',
    ports: [...outputPorts, ...inputPorts],
    clocking: { clockName: 'clk', resetName: 'rst_n', resetActiveLow: true },
    validityOutputName: null,
  };
  const entries: readonly TimingContractEntry[] = draw.entryOrder.map((index) => ({
    portName: (outputPorts[index] as Port).name,
    timing: timings[index] as PortTiming,
  }));
  const built = makeTimingContract(moduleInterface, entries);
  if (!built.ok) {
    throw new Error(`generator produced an invalid timing contract: ${built.error.code}`);
  }
  return {
    id: 'spec-1',
    projectId: 'proj-1',
    goal: 'A drawn interface',
    constraints: [],
    architecture: 'n/a',
    moduleInterface,
    timingContract: built.value,
    acceptanceCriteria: [],
    approved: true,
    version: 1,
  };
}

/** The harness's per-port comparison line, the one place a request's Port_Timing becomes text. */
const COMPARISON_LINE =
  /if \((ece_exp_bits|ece_exp_reg_bits)\[\d+:\d+\] === ([A-Za-z_][A-Za-z0-9_]*)\)/gu;

/** Recover the request's contract from the rendered harness: the zero-input bundle witnesses
 * `registered`, the applied-input bundle witnesses `combinational`. */
function decodeContract(harness: string): readonly TimingContractEntry[] {
  const decoded: TimingContractEntry[] = [];
  for (const match of harness.matchAll(COMPARISON_LINE)) {
    decoded.push({
      portName: match[2] as string,
      timing: match[1] === 'ece_exp_reg_bits' ? 'registered' : 'combinational',
    });
  }
  return decoded;
}

/** An order-independent view, since the renderer emits in declared-port order rather than entry order. */
function byPortName(entries: readonly TimingContractEntry[]): readonly TimingContractEntry[] {
  return [...entries].sort((left, right) => left.portName.localeCompare(right.portName));
}

async function renderedHarnessFor(spec: Spec): Promise<string> {
  const generator = new LiveReferenceModelGenerator(
    new Map([[modelIdFor(0), new ReplyingRouter(replyFor(spec.moduleInterface))]]),
  );
  const produced = await generator.generate(
    spec,
    makeBudgetLedger(100_000, 'session-token-budget'),
  );
  return produced.harness.contents;
}

describe(PROPERTY, () => {
  it("renders every declared output port at the timing the Spec's own contract states for it", async () => {
    let mixedDraws = 0;
    let combinationalBearingDraws = 0;
    let allRegisteredDraws = 0;
    let reorderedDraws = 0;

    await fc.assert(
      fc.asyncProperty(drawArbitrary(), async (draw) => {
        const spec = specFor(draw);
        const declared = spec.timingContract.entries;

        const decoded = decodeContract(await renderedHarnessFor(spec));

        // One comparison line per declared output port, each naming a distinct port: a decode that
        // silently matched twice or missed a port would otherwise weaken the equality below.
        expect(new Set(decoded.map((entry) => entry.portName)).size).toBe(decoded.length);
        // Entry for entry: the request carried the Spec's contract, so each port renders at the
        // value the Spec states and no port renders at a value the Spec does not state.
        expect(byPortName(decoded)).toEqual(byPortName(declared));
        // The decisive clause, stated on its own so a regression reads as what it is: a
        // `combinational` entry reaches the harness as `combinational`.
        for (const entry of declared.filter((candidate) => candidate.timing === 'combinational')) {
          expect(decoded).toContainEqual({ portName: entry.portName, timing: 'combinational' });
        }

        const timings = new Set(declared.map((entry) => entry.timing));
        if (timings.size > 1) {
          mixedDraws += 1;
        }
        if (timings.has('combinational')) {
          combinationalBearingDraws += 1;
        }
        if (timings.size === 1 && timings.has('registered')) {
          allRegisteredDraws += 1;
        }
        const outputOrder = spec.moduleInterface.ports
          .filter((port) => port.direction === 'output')
          .map((port) => port.name);
        if (declared.some((entry, index) => entry.portName !== outputOrder[index])) {
          reorderedDraws += 1;
        }
      }),
      propertyParameters({ numRuns: NUM_RUNS }),
    );

    // NON-VACUITY: a run of all-`registered` contracts would pass on the very fabrication this
    // property exists to forbid, so the mixed and combinational-bearing draws must both be real.
    // The all-`registered` and reordered rows are the control shapes, counted so a generator that
    // stopped drawing them would be visible rather than silently narrowing the population.
    expect({
      mixedDraws: mixedDraws > 0,
      combinationalBearingDraws: combinationalBearingDraws > 0,
      allRegisteredDraws: allRegisteredDraws > 0,
      reorderedDraws: reorderedDraws > 0,
    }).toEqual({
      mixedDraws: true,
      combinationalBearingDraws: true,
      allRegisteredDraws: true,
      reorderedDraws: true,
    });
  });
});
