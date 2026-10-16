// reference-model-consensus-gate, Property 9 and Property 10: the rendered Consensus_Harness is
// faithful to the Declared_Interface and to the Timing_Contract per port (tasks 7.4, 7.5).
//
// THE ORACLE IS A SEPARATE READING OF THE TEXT, NOT THE RENDERER RESTATED
//   Every helper below extracts facts from `renderConsensusHarness`'s OUTPUT TEXT by regex or line
//   index, never by importing or calling an internal of `consensus-harness.ts`
//   (`CONSENSUS_HARNESS_MODULE`, `CANDIDATE_INSTANCE_NAME`, `RESET_CYCLES`, `requireVerilogIdentifier`,
//   `timingOf`, `inputBundleSlice`, ... are none of them exported, and none is imported here even
//   where they are). The literal line shapes checked against are read directly off
//   `app/tools/simulator/consensus-harness.ts`'s own `lines.push(...)` calls, which is what makes
//   this file a check on the rendered artifact rather than a restatement of the function that
//   produced it.
//
// IDENTIFIERS ARE PREFIX-GUARANTEED RATHER THAN FILTERED
//   `renderConsensusHarness` refuses any module/port/clock/reset/nonce name that is not a bounded
//   plain Verilog identifier or that collides with a reserved keyword. Every generated identifier
//   below is the fixed, non-keyword prefix `zzid` followed by 0-6 further identifier characters, so
//   no SystemVerilog-2017 keyword can ever be drawn and fast-check never retries a rejected name.
//
// Validates (task 7.4, Property 9): Requirements 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 5.5, 17.4
// Validates (task 7.5, Property 10): Requirements 6.3, 6.5, 6.6

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  makeModuleInterface,
  makePort,
  makeTimingContract,
  type ClockingContract,
  type ModuleInterface,
  type Port,
  type PortDirection,
  type PortTiming,
  type TimingContract,
  type TimingContractEntry,
} from '@app/core';
import { renderConsensusHarness, type ConsensusHarnessRequest } from '@app/tools';

import { ASCII_IDENT_CHARS, stringFromChars } from './generators/chars.js';
import { propertyParameters } from './property.js';

// ---------------------------------------------------------------------------
// Shared fixture builders (used by both property tests below)
// ---------------------------------------------------------------------------

/** No SystemVerilog-2017 keyword begins with this, so prefixing closes the keyword draw entirely. */
const IDENT_PREFIX = 'zzid';

/** A Verilog-safe identifier the renderer's own identifier rule will always accept. */
function identifierArbitrary(): fc.Arbitrary<string> {
  return stringFromChars(ASCII_IDENT_CHARS, 0, 6).map((suffix) => `${IDENT_PREFIX}${suffix}`);
}

/** Build a `Port` through the validating constructor, or fail the generator loudly. */
function portOrThrow(name: string, direction: PortDirection, width: number): Port {
  const built = makePort({ name, direction, width });
  if (!built.ok) {
    throw new Error(`generator produced an invalid port: ${built.error.code}`);
  }
  return built.value;
}

/** The raw, pre-naming shape of one design: how many ports of each width, and the clocking coins. */
interface DesignShape {
  readonly moduleName: string;
  readonly outputWidths: readonly number[];
  readonly inputWidths: readonly number[];
  readonly hasClock: boolean;
  readonly hasReset: boolean;
  readonly resetActiveLow: boolean;
}

/** A `ModuleInterface` plus the output/input `Port`s it was built from, in declared order. */
interface GeneratedDesign {
  readonly moduleInterface: ModuleInterface;
  readonly outputPorts: readonly Port[];
  readonly inputPorts: readonly Port[];
}

/** Deal unique names to the outputs, then the inputs, then the clock, then the reset. */
function buildDesign(shape: DesignShape, names: readonly string[]): GeneratedDesign {
  let cursor = 0;
  const outputPorts = shape.outputWidths.map((width) =>
    portOrThrow(names[cursor++] as string, 'output', width),
  );
  const inputPorts = shape.inputWidths.map((width) =>
    portOrThrow(names[cursor++] as string, 'input', width),
  );
  const clockName = shape.hasClock ? (names[cursor++] as string) : null;
  const resetName = shape.hasReset ? (names[cursor++] as string) : null;
  const clocking: ClockingContract = { clockName, resetName, resetActiveLow: shape.resetActiveLow };
  const built = makeModuleInterface({
    moduleName: shape.moduleName,
    ports: [...outputPorts, ...inputPorts],
    clocking,
    validityOutputName: null,
  });
  if (!built.ok) {
    throw new Error(`generator produced an invalid module interface: ${built.error.code}`);
  }
  return { moduleInterface: built.value, outputPorts, inputPorts };
}

/** 0-4 outputs, 0-3 inputs, with the clock and reset coins drawn independently and deliberately
 * (not left to a rare branch): each is a plain `fc.boolean()`, so the clockless loop - a genuinely
 * different rendered shape from the clocked one - is hit on roughly half of all generated cases. */
function designShapeArbitrary(): fc.Arbitrary<DesignShape> {
  return fc.record<DesignShape>({
    moduleName: identifierArbitrary(),
    outputWidths: fc.array(fc.integer({ min: 1, max: 16 }), { minLength: 0, maxLength: 4 }),
    inputWidths: fc.array(fc.integer({ min: 1, max: 16 }), { minLength: 0, maxLength: 3 }),
    hasClock: fc.boolean(),
    hasReset: fc.boolean(),
    resetActiveLow: fc.boolean(),
  });
}

function generatedDesignArbitrary(): fc.Arbitrary<GeneratedDesign> {
  return designShapeArbitrary().chain((shape) => {
    const needed =
      shape.outputWidths.length +
      shape.inputWidths.length +
      (shape.hasClock ? 1 : 0) +
      (shape.hasReset ? 1 : 0);
    return fc
      .uniqueArray(identifierArbitrary(), { minLength: needed, maxLength: needed })
      .map((names) => buildDesign(shape, names));
  });
}

/** Draw a `TimingContract` assigning an independent `registered`/`combinational` choice per output
 * port, through the validating constructor. */
function timingContractArbitrary(moduleInterface: ModuleInterface): fc.Arbitrary<TimingContract> {
  const outputPorts = moduleInterface.ports.filter((port) => port.direction === 'output');
  return fc
    .array(fc.constantFrom<PortTiming>('registered', 'combinational'), {
      minLength: outputPorts.length,
      maxLength: outputPorts.length,
    })
    .map((timings) => {
      const entries: TimingContractEntry[] = outputPorts.map((port, index) => ({
        portName: port.name,
        timing: timings[index] as PortTiming,
      }));
      const built = makeTimingContract(moduleInterface, entries);
      if (!built.ok) {
        throw new Error(`generator produced an invalid timing contract: ${built.error.code}`);
      }
      return built.value;
    });
}

function requestArbitrary(
  moduleInterface: ModuleInterface,
  timingContract: TimingContract,
): fc.Arbitrary<ConsensusHarnessRequest> {
  return fc
    .record({
      nonce: identifierArbitrary(),
      watchdogBudgetNs: fc.integer({ min: 1, max: 2_000_000 }),
      sampleBudget: fc.integer({ min: 1, max: 64 }),
    })
    .map(({ nonce, watchdogBudgetNs, sampleBudget }) => ({
      moduleInterface,
      timingContract,
      nonce,
      watchdogBudgetNs,
      sampleBudget,
    }));
}

/** Render through the one public entry point, throwing loudly on a refusal the generator should
 * never produce: every identifier drawn above already satisfies the renderer's own identifier rule. */
function renderOrThrow(request: ConsensusHarnessRequest): string {
  const rendered = renderConsensusHarness(request);
  if (!rendered.ok) {
    throw new Error(`generator produced a request the renderer refused: ${rendered.error.code}`);
  }
  return rendered.value.contents;
}

// ---------------------------------------------------------------------------
// The test's own independent parser over the rendered text
// ---------------------------------------------------------------------------

/** The sole line index equal to `line`, or -1 when absent; throws when there is more than one. */
function soleIndexOf(lines: readonly string[], line: string): number {
  const indices = lines.flatMap((candidate, index) => (candidate === line ? [index] : []));
  if (indices.length > 1) {
    throw new Error(
      `expected at most one line ${JSON.stringify(line)}, found ${String(indices.length)}`,
    );
  }
  return indices[0] ?? -1;
}

/** `  wire name;` or `  wire [H:0] name;`: the width-bearing data-port declaration line shape. */
const WIRE_LINE = /^ {2}wire(?: \[(\d+):0\])? ([A-Za-z_][A-Za-z0-9_$]*);$/;

/** Every declared wire's name mapped to its declared width, read straight off the text. */
function wireWidths(lines: readonly string[]): Map<string, number> {
  const widths = new Map<string, number>();
  for (const line of lines) {
    const match = WIRE_LINE.exec(line);
    if (match === null) {
      continue;
    }
    const [, high, name] = match;
    widths.set(name as string, high === undefined ? 1 : Number(high) + 1);
  }
  return widths;
}

/** The one `$display("ECE_SAMPLE ...", step, out1, out2, ...)` call: the Sample_Point's own read. */
const SAMPLE_DISPLAY_LINE = /^ {6}\$display\("ECE_SAMPLE [^"]*", (.+)\);$/;

/** The Sample_Point emission's full argument list and the line index it sits at. */
function sampleDisplayArgs(lines: readonly string[]): {
  readonly args: readonly string[];
  readonly lineIndex: number;
} {
  const matches = lines
    .map((line, index) => ({ index, match: SAMPLE_DISPLAY_LINE.exec(line) }))
    .filter((entry): entry is { index: number; match: RegExpExecArray } => entry.match !== null);
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one ECE_SAMPLE $display call, found ${String(matches.length)}`,
    );
  }
  const entry = matches[0] as { index: number; match: RegExpExecArray };
  return { args: (entry.match[1] as string).split(', '), lineIndex: entry.index };
}

/** `  if (<expectation> === <port>)`: one per-output comparison, in textual (declared) order. */
const CHECK_IF_LINE = /^ {6}if \((.+) === ([A-Za-z_][A-Za-z0-9_$]*)\)$/;

interface CheckLine {
  readonly expectation: string;
  readonly portName: string;
  readonly lineIndex: number;
}

/** Every per-port `if (...)` comparison line, in the order it appears in the rendered text. */
function checkIfLines(lines: readonly string[]): readonly CheckLine[] {
  const result: CheckLine[] = [];
  lines.forEach((line, index) => {
    const match = CHECK_IF_LINE.exec(line);
    if (match !== null) {
      result.push({
        expectation: match[1] as string,
        portName: match[2] as string,
        lineIndex: index,
      });
    }
  });
  return result;
}

/** The Drive_Point statement: every input driven from this step's packed stimulus bits. */
const DRIVE_POINT_LINE = '      ece_in_bits = ece_stimulus(step);';

/** The Sampling_Edge: the clock rising after the Sample_Point, in the clocked loop only. */
const SAMPLING_EDGE_LINE = "      #(ECE_SKEW) ece_clk = 1'b1;";

/** The reset-drive assignment at the declared polarity, before (assert) or after (release) the
 * reset-cycle repeat loop. */
function resetDriveLine(resetActiveLow: boolean, phase: 'assert' | 'release'): string {
  const assertedToken = resetActiveLow ? "1'b0" : "1'b1";
  const releasedToken = resetActiveLow ? "1'b1" : "1'b0";
  return `    ece_reset_drive = ${phase === 'assert' ? assertedToken : releasedToken};`;
}

// ---------------------------------------------------------------------------
// Task 7.4 - Property 9: faithful to the Declared_Interface
// ---------------------------------------------------------------------------

describe('reference-model-consensus-gate, Property 9: The rendered harness is faithful to the Declared_Interface', () => {
  it(
    'declares every port at its own width, reads every output exactly once per Sample_Point in ' +
      'declared order, generates the declared clock and no clock at all when none is declared, ' +
      'asserts and releases the declared reset at its polarity before the first Sample_Point, and ' +
      'orders the Drive_Point before the Sample_Point before the Sampling_Edge',
    () => {
      let clockedCases = 0;
      let clocklessCases = 0;
      let resetCases = 0;
      let noResetCases = 0;
      let multiOutputCases = 0;

      fc.assert(
        fc.property(
          generatedDesignArbitrary().chain((generated) =>
            timingContractArbitrary(generated.moduleInterface).chain((timingContract) =>
              requestArbitrary(generated.moduleInterface, timingContract).map((request) => ({
                generated,
                request,
              })),
            ),
          ),
          (scenario) => {
            const { generated, request } = scenario;
            const { moduleInterface, outputPorts } = generated;
            const { clockName, resetName, resetActiveLow } = moduleInterface.clocking;

            const text = renderOrThrow(request);
            const lines = text.split('\n');

            // Clause 1: every declared port (output and input) is declared at exactly its width.
            const widths = wireWidths(lines);
            for (const port of moduleInterface.ports) {
              expect({ port: port.name, declaredWidth: widths.get(port.name) }).toEqual({
                port: port.name,
                declaredWidth: port.width,
              });
            }

            // Clause 2: the one Sample_Point emission reads every output exactly once, in order.
            const { args: sampleArgs, lineIndex: sampleLineIndex } = sampleDisplayArgs(lines);
            expect(sampleArgs).toEqual(['step', ...outputPorts.map((port) => port.name)]);

            // Clause 3: the declared clock is generated; no clock token at all when none is declared.
            if (clockName !== null) {
              clockedCases += 1;
              expect(lines).toContain('  reg ece_clk;');
              expect(text).toContain("ece_clk = 1'b1;");
              expect(text).toContain("ece_clk = 1'b0;");
            } else {
              clocklessCases += 1;
              expect(text).not.toContain('ece_clk');
            }

            // Clause 4: the declared reset is asserted, then released at the declared polarity,
            // strictly before the first Sample_Point; absent entirely when none is declared.
            if (resetName !== null) {
              resetCases += 1;
              const assertIndex = soleIndexOf(lines, resetDriveLine(resetActiveLow, 'assert'));
              const releaseIndex = soleIndexOf(lines, resetDriveLine(resetActiveLow, 'release'));
              expect(assertIndex).toBeGreaterThanOrEqual(0);
              expect(releaseIndex).toBeGreaterThan(assertIndex);
              expect(releaseIndex).toBeLessThan(sampleLineIndex);
            } else {
              noResetCases += 1;
              expect(text).not.toContain('ece_reset_drive');
            }

            // Clauses 5 and 6: Drive_Point strictly before Sample_Point; Sample_Point strictly
            // before the Sampling_Edge in the clocked loop, which has none at all in the clockless one.
            const driveIndex = soleIndexOf(lines, DRIVE_POINT_LINE);
            expect(driveIndex).toBeGreaterThanOrEqual(0);
            expect(driveIndex).toBeLessThan(sampleLineIndex);
            if (clockName !== null) {
              const edgeIndex = soleIndexOf(lines, SAMPLING_EDGE_LINE);
              expect(edgeIndex).toBeGreaterThan(sampleLineIndex);
            } else {
              expect(text).not.toContain(SAMPLING_EDGE_LINE);
            }

            if (outputPorts.length >= 2) {
              multiOutputCases += 1;
            }
          },
        ),
        propertyParameters(),
      );

      // NON-VACUITY: the clockless branch is a genuinely different loop and must be deliberately
      // exercised rather than left to a rare draw; both reset shapes and a multi-output ordering
      // case must also have been reached.
      expect({
        clockedCases: clockedCases > 0,
        clocklessCases: clocklessCases > 0,
        resetCases: resetCases > 0,
        noResetCases: noResetCases > 0,
        multiOutputCases: multiOutputCases > 0,
      }).toEqual({
        clockedCases: true,
        clocklessCases: true,
        resetCases: true,
        noResetCases: true,
        multiOutputCases: true,
      });
    },
  );
});

// ---------------------------------------------------------------------------
// Task 7.5 - Property 10: faithful to the Timing_Contract per port
// ---------------------------------------------------------------------------

/** At least 2 outputs, so a mixed contract and the independence clause both have two ports to work
 * with; otherwise the same shape as `designShapeArbitrary`. */
function multiOutputDesignShapeArbitrary(): fc.Arbitrary<DesignShape> {
  return fc.record<DesignShape>({
    moduleName: identifierArbitrary(),
    outputWidths: fc.array(fc.integer({ min: 1, max: 16 }), { minLength: 2, maxLength: 4 }),
    inputWidths: fc.array(fc.integer({ min: 1, max: 16 }), { minLength: 0, maxLength: 3 }),
    hasClock: fc.boolean(),
    hasReset: fc.boolean(),
    resetActiveLow: fc.boolean(),
  });
}

function multiOutputDesignArbitrary(): fc.Arbitrary<GeneratedDesign> {
  return multiOutputDesignShapeArbitrary().chain((shape) => {
    const needed =
      shape.outputWidths.length +
      shape.inputWidths.length +
      (shape.hasClock ? 1 : 0) +
      (shape.hasReset ? 1 : 0);
    return fc
      .uniqueArray(identifierArbitrary(), { minLength: needed, maxLength: needed })
      .map((names) => buildDesign(shape, names));
  });
}

/** Force at least two distinct timing values among 2+ drawn timings, by construction rather than
 * by sampling: the task names a mixed contract as the real case, not a corner one, so this makes
 * every generated case in this section mixed instead of leaving it to a coin flip per port. */
function ensureMixed(timings: readonly PortTiming[]): readonly PortTiming[] {
  if (timings.length < 2 || timings.some((timing) => timing !== timings[0])) {
    return timings;
  }
  const flipped: PortTiming = timings[0] === 'registered' ? 'combinational' : 'registered';
  return [...timings.slice(0, -1), flipped];
}

function mixedTimingContractArbitrary(
  moduleInterface: ModuleInterface,
): fc.Arbitrary<TimingContract> {
  const outputPorts = moduleInterface.ports.filter((port) => port.direction === 'output');
  return fc
    .array(fc.constantFrom<PortTiming>('registered', 'combinational'), {
      minLength: outputPorts.length,
      maxLength: outputPorts.length,
    })
    .map(ensureMixed)
    .map((timings) => {
      const entries: TimingContractEntry[] = outputPorts.map((port, index) => ({
        portName: port.name,
        timing: timings[index] as PortTiming,
      }));
      const built = makeTimingContract(moduleInterface, entries);
      if (!built.ok) {
        throw new Error(`generator produced an invalid timing contract: ${built.error.code}`);
      }
      return built.value;
    });
}

function timingOfPort(timingContract: TimingContract, portName: string): PortTiming {
  const entry = timingContract.entries.find((candidate) => candidate.portName === portName);
  if (entry === undefined) {
    throw new Error(`fixture defect: no timing entry for port "${portName}"`);
  }
  return entry.timing;
}

/** The packed `ece_exp_bits` slice for `outputPorts[index]`: MSB-first by cumulative width in
 * declared order, matching how the harness packs its output bundle. Computed independently here
 * from the fixture's own port list, never read off the renderer's `inputBundleSlice`. */
function outputSlice(
  outputPorts: readonly Port[],
  index: number,
): { readonly high: number; readonly low: number } {
  const low = outputPorts.slice(0, index).reduce((sum, port) => sum + port.width, 0);
  const high = low + (outputPorts[index] as Port).width - 1;
  return { high, low };
}

/** The expectation expression `timing` renders for `outputPorts[index]`: the previous step's
 * shadow register for `registered`, or this step's packed slice for `combinational`. */
function expectedExpectationExpr(
  outputPorts: readonly Port[],
  index: number,
  timing: PortTiming,
): string {
  const port = outputPorts[index] as Port;
  if (timing === 'registered') {
    return `ece_prev_exp_${port.name}`;
  }
  const { high, low } = outputSlice(outputPorts, index);
  return `ece_exp_bits[${String(high)}:${String(low)}]`;
}

describe('reference-model-consensus-gate, Property 10: The rendered harness is faithful to the Timing_Contract per port', () => {
  it(
    "compares a registered port against the previous Sample_Point's expectation and a " +
      "combinational port against this Sample_Point's, selected per port rather than per design",
    () => {
      let mixedCases = 0;

      fc.assert(
        fc.property(
          multiOutputDesignArbitrary().chain((generated) =>
            mixedTimingContractArbitrary(generated.moduleInterface).chain((timingContract) =>
              requestArbitrary(generated.moduleInterface, timingContract).map((request) => ({
                generated,
                timingContract,
                request,
              })),
            ),
          ),
          (scenario) => {
            const { generated, timingContract, request } = scenario;
            const { outputPorts } = generated;

            const text = renderOrThrow(request);
            const lines = text.split('\n');
            const checksByPort = new Map(
              checkIfLines(lines).map((check) => [check.portName, check]),
            );

            outputPorts.forEach((port, index) => {
              const timing = timingOfPort(timingContract, port.name);
              const expected = expectedExpectationExpr(outputPorts, index, timing);
              const actual = checksByPort.get(port.name);
              expect({ port: port.name, expectation: actual?.expectation }).toEqual({
                port: port.name,
                expectation: expected,
              });
            });

            const timings = outputPorts.map((port) => timingOfPort(timingContract, port.name));
            if (new Set(timings).size > 1) {
              mixedCases += 1;
            }
          },
        ),
        propertyParameters(),
      );

      // NON-VACUITY: a contract mixing both values on one interface is the real case this property
      // exists for, not a corner - `ensureMixed` makes it the case every run in this section reaches.
      expect(mixedCases).toBeGreaterThan(0);
    },
  );

  it(
    "changes only the flipped port's rendered comparison, leaving every other port's four check " +
      'lines byte-identical - the clause a per-design implementation would fail',
    () => {
      fc.assert(
        fc.property(
          multiOutputDesignArbitrary().chain((generated) =>
            mixedTimingContractArbitrary(generated.moduleInterface).chain((timingContract) =>
              requestArbitrary(generated.moduleInterface, timingContract).map((request) => ({
                generated,
                timingContract,
                request,
              })),
            ),
          ),
          fc.nat(),
          (scenario, flipSeed) => {
            const { generated, timingContract, request } = scenario;
            const { moduleInterface, outputPorts } = generated;
            const flipIndex = flipSeed % outputPorts.length;
            const flippedPortName = (outputPorts[flipIndex] as Port).name;

            const baselineLines = renderOrThrow(request).split('\n');

            const flippedEntries: TimingContractEntry[] = outputPorts.map((port, index) => {
              const current = timingOfPort(timingContract, port.name);
              const timing: PortTiming =
                index === flipIndex
                  ? current === 'registered'
                    ? 'combinational'
                    : 'registered'
                  : current;
              return { portName: port.name, timing };
            });
            const flippedContract = makeTimingContract(moduleInterface, flippedEntries);
            if (!flippedContract.ok) {
              throw new Error(
                `fixture defect building the flipped contract: ${flippedContract.error.code}`,
              );
            }
            const flippedRequest: ConsensusHarnessRequest = {
              ...request,
              timingContract: flippedContract.value,
            };
            const flippedLines = renderOrThrow(flippedRequest).split('\n');

            const baselineChecks = checkIfLines(baselineLines);
            const flippedChecks = checkIfLines(flippedLines);

            outputPorts.forEach((port) => {
              const baseCheck = baselineChecks.find((check) => check.portName === port.name);
              const flipCheck = flippedChecks.find((check) => check.portName === port.name);
              if (baseCheck === undefined || flipCheck === undefined) {
                throw new Error(`fixture defect: no check line found for port "${port.name}"`);
              }
              // Each port's full four-line block: `if (...)`, the PASS display, `else`, the FAIL
              // display - the whole rendered comparison for that one port.
              const baseBlock = baselineLines.slice(baseCheck.lineIndex, baseCheck.lineIndex + 4);
              const flipBlock = flippedLines.slice(flipCheck.lineIndex, flipCheck.lineIndex + 4);

              if (port.name === flippedPortName) {
                expect(flipBlock).not.toEqual(baseBlock);
              } else {
                expect(flipBlock).toEqual(baseBlock);
              }
            });
          },
        ),
        propertyParameters(),
      );
    },
  );
});
