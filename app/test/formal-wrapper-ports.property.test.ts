// formal-property-oracle, Property 32: the wrapper's port directions (task 16.11).
//
// ONE SENTENCE SO IT CANNOT BE HALF-REMEMBERED: **inputs must be ports, outputs must not be.**
// Both halves are measured, both failures are silent, and they fail in opposite directions - which is
// why the claim is asserted two-sidedly rather than as "the ports are the ones we expected".
//
//   INPUTS MUST BE PORTS. `write_smt2` makes only TOP-LEVEL INPUTS free variables, so a design input
//   declared as an internal wrapper wire is tied to a constant and the proof then covers ONE input
//   assignment instead of all of them - a `proved` that means far less than it says, with nothing in
//   the output to show for it (Req 3.9).
//   OUTPUTS MUST NOT BE PORTS. MEASURED: with the observed signals declared as wrapper OUTPUTS,
//   `write_aiger` emits `O=4` on `counter_12` and ABC prints `Warning: All 5 outputs will be ORed
//   together` and proceeds - so it ORs the DESIGN'S OWN OUTPUTS into the property and REFUTES a design
//   that z3 and rIC3 both PROVE. Moving the same signals to internal wires so `O=0` makes ABC report
//   `Property proved.` on the identical property. rIC3 is IMMUNE throughout, so the defect is INVISIBLE
//   on one engine and FATAL on another (Req 3.10,
//   `chipAgent/_inbox/gotcha-property-wrapper-must-expose-no-output-ports.md`).
//   CLOCK AND RESET ARE PORTS EVEN THOUGH THEY ARE NOT IN THE PORT LIST. `ModuleInterface` holds them
//   in `clocking`, so a wrapper assembled from `ports` alone leaves `clk` UNDECLARED - and that does not
//   fail loudly: Verilog gives it an implicit width-1 net, which `prep` sees as an UNDRIVEN wire rather
//   than a free input, and a clock that never ticks proves nothing while still reporting a `Status:`.
//   That was a measured defect (Req 3.11,
//   `chipAgent/_inbox/gotcha-formal-wrapper-must-declare-clock-and-reset-as-its-own-ports.md`).
//
// WHAT THIS FILE OWNS THAT PROPERTY 12 DOES NOT
//   Stated plainly, because the overlap is real: `formal-wrapper-content.property.test.ts` (Property 12)
//   carries a port claim of its own - its claim D compares the header's declarations against the
//   expected inputs, and its claim C checks the connections - reached as part of a TOKEN-PROVENANCE
//   argument over the wrapper's four regions. Property 32 is the OWNER of the port-direction claim, and
//   it is written here from a different direction so the two are not one assertion spelled twice:
//     1. A WHOLE-TEXT keyword scan. No `output` and no `inout` appears ANYWHERE in the rendered
//        wrapper, not merely outside the header's declaration lines. A direction keyword smuggled into
//        the internals region, the instance, or a statement fails here and nowhere else.
//     2. A TWO-SIDED LINK per signal. Every input is declared as a port AND connected by name; every
//        non-input is declared as a wire AND connected by name; neither set appears in the other's
//        region. A declaration without its connection - or the reverse - is the undriven-net shape, and
//        it passes a claim that only counts declarations.
//     3. THE CLOCKING CONTRACT'S OWN CLAUSE. The clock and the reset are asserted to be declared, to be
//        `input`, and to be WIDTH 1 - the shape a Verilog header gives them - with the cases that carry
//        them counted, so Req 3.11 is known to have been exercised rather than assumed.
//     4. THE DEGENERATE SHAPES. A design with no declared ports and no clocking at all renders no
//        declaration list and no connection list, and must still render a well-formed module rather
//        than a blank line inside the parentheses.
//
// WHY THE EXPECTATION IS BUILT FROM THE INTERFACE AND NOT FROM THE RENDERER
//   The expected port set is assembled here from `designInterface.ports` plus the two `clocking` names,
//   which is the RULE (Req 3.9, 3.10, 3.11) rather than the implementation: `wrapperSignals` is not
//   exported and is not imported. A pin written in terms of the thing it pins asserts only that the
//   thing equals itself.
//
// NON-VACUITY AND THE RUN COUNT
//   `arbDesignInterface()` draws 0 to 5 declared ports with directions uniform over `input`, `output`,
//   and `inout`, widths 1 to 64, and an independent coin for the clock and for the reset. The shapes
//   each claim needs are counted and asserted: a case carrying an OUTPUT, one carrying an INOUT, one
//   carrying a MULTI-BIT port, one carrying BOTH the clock and the reset (~25%, two independent coins),
//   one carrying NO declared ports, and one carrying NO signals at all (~7.5%: no declared ports and
//   neither clocking name). A DECLARED width-1 port is NOT among them: widths are drawn from 1 to 64, so
//   one is ~1/64 per port, and requiring it would cost thousands of runs for coverage the deterministic
//   suffix case at the end of this file gives exactly - while the generated sample still exercises the
//   suffix-free path on every case carrying a clock or a reset, both of which are width 1 by Req 3.11.
//   `fc.array`'s length distribution is not uniform, so the port-count shares are EMPIRICAL
//   floors enforced by the counters rather than computed probabilities - which is the honest form,
//   because a generator change then fails this test instead of silently thinning its sample.
//   The rarest required shape is the no-signals case at roughly 7.5%: `(1 - 0.075)^300` is ~7e-11, where
//   `(1 - 0.075)^100` is ~4e-4 - a flake rather than a claim. So 300 runs.
//
// The tag is a literal, not `propertyTag(...)`: that helper's `FEATURE_TAG` is hardcoded to a
// different spec (`chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`).
//
// **Validates: Requirements 3.4, 3.7, 3.9, 3.10, 3.11**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { ModuleInterface, Port } from '@app/core';
import {
  renderPropertyWrapper,
  validateExpression,
  type FormalProperty,
  type ResetContract,
  type ValidatedExpression,
} from '@app/tools';

import { arbDesignInterface, arbFormalProperty, arbResetContract } from './formal-arbitraries.js';
import { propertyParameters } from './property.js';

// **Feature: formal-property-oracle, Property 32: Every design input is a wrapper port and no design
// output is**
const PROPERTY =
  'formal-property-oracle, Property 32: Every design input is a wrapper port and no design output is';

/** The wrapper name is caller-owned and no model output reaches it; one fixed value suffices. */
const WRAPPER_NAME = 'formal_property_wrapper';

/** See the RUN COUNT note in the header: the rarest required shape is the no-signals case at ~7.5%. */
const NUM_RUNS = 300;

/** The line closing the wrapper's port list. */
const HEADER_TERMINATOR = ');';

/** The line closing the design instance's connection list. */
const INSTANCE_TERMINATOR = '  );';

/**
 * The two direction keywords a Property_Wrapper may never carry, as whole words (Req 3.10).
 *
 * Scanned over the WHOLE rendered text rather than over the header alone, and as word-bounded
 * patterns so a signal named `output_valid` - which `SIGNAL_NAMES` legitimately contains shapes like -
 * is not mistaken for a declaration. Non-global regexes, so no `lastIndex` is carried between calls
 * (`chipAgent/_inbox/gotcha-shared-global-regex-lastindex-infinite-loop.md`).
 */
const FORBIDDEN_DIRECTIONS: readonly RegExp[] = [/\boutput\b/, /\binout\b/];

/** One port declaration of the header: `  input [7:0] a` or `  input clk`, with no trailing comma. */
const DECLARATION_PATTERN = /^ {2}input(?: \[(\d+):0\])? ([A-Za-z_][A-Za-z0-9_$]*)$/;

/** One internal-wire declaration: `  wire [3:0] out;`. */
const WIRE_PATTERN = /^ {2}wire(?: \[(\d+):0\])? ([A-Za-z_][A-Za-z0-9_$]*);$/;

/** One by-name connection: `    .a(a)`, with no trailing comma. */
const CONNECTION_PATTERN = /^ {4}\.([A-Za-z_][A-Za-z0-9_$]*)\(([A-Za-z_][A-Za-z0-9_$]*)\)$/;

/** The Warm_Up_Gate's counter declaration, which shares the internals region with the wires. */
const COUNTER_PATTERN = /^ {2}reg(?: \[\d+:0\])? __formal_warmup_age = 0;$/;

/** The minimum share of generated cases each required shape must reach. */
const MIN_SHAPE_SHARE = 0.05;

/** The minimum share for the degenerate no-signals shape, which is the product of three draws. */
const MIN_DEGENERATE_SHARE = 0.02;

/** The width a clocking signal must be declared at: a Verilog header lists it as a width-1 input. */
const CLOCKING_WIDTH = 1;

/** Put a fixture expression through the sole constructor of the brand, or fail loudly. */
function validatedOrThrow(text: string): ValidatedExpression {
  const result = validateExpression(text);
  if (!result.ok) {
    throw new Error(`fixture expression is outside the accepted dialect: ${text}`);
  }
  return result.value;
}

/** An unconditional clocked property, so the named case renders one assert and no cover. */
const NAMED_CASE_PROPERTY: FormalProperty = {
  kind: 'clocked',
  id: 'p1',
  criterionRef: 'ac-1',
  clock: validatedOrThrow('clk'),
  antecedent: null,
  consequent: validatedOrThrow('q == 0'),
};

/** A signal the wrapper must declare, as the name and width its declaration must carry. */
interface ExpectedSignal {
  readonly name: string;
  readonly width: number;
}

/** A sort key making a signal-set comparison order-free but duplicate-sensitive. */
function signalKey(signal: ExpectedSignal): string {
  return `${signal.name}|${String(signal.width)}`;
}

/** The expected signals, split by the ONE rule that decides the split (Req 3.9, 3.10, 3.11). */
interface ExpectedSignals {
  /** Every design INPUT plus the clock and the reset: the wrapper's only ports. */
  readonly ports: readonly ExpectedSignal[];
  /** Every design output and every other observed signal: internal wires. */
  readonly wires: readonly ExpectedSignal[];
}

/**
 * Split one design interface the way the requirements do, independently of the renderer.
 *
 * The clocking names are taken from `clocking` and NEVER from `ports`, and each becomes a WIDTH-1
 * input - which is Req 3.11's whole content. Not deduplicated against the declared ports, matching the
 * renderer's own deliberate choice: an interface declaring its clock twice renders a duplicate
 * declaration and an unbuildable wrapper, which is attributed to our own instrument, where keeping the
 * first occurrence could silently keep an `output clk` and drop the clock input.
 */
function expectedSignalsOf(designInterface: ModuleInterface): ExpectedSignals {
  const { clockName, resetName } = designInterface.clocking;
  const clockingPorts: readonly ExpectedSignal[] = [clockName, resetName]
    .filter((name): name is string => name !== null)
    .map((name) => ({ name, width: CLOCKING_WIDTH }));
  const declaredInputs = designInterface.ports
    .filter((port: Port) => port.direction === 'input')
    .map((port: Port) => ({ name: port.name, width: port.width }));
  return {
    ports: [...declaredInputs, ...clockingPorts],
    wires: designInterface.ports
      .filter((port: Port) => port.direction !== 'input')
      .map((port: Port) => ({ name: port.name, width: port.width })),
  };
}

/** The rendered wrapper's regions, located by its own fixed line structure. */
interface WrapperRegions {
  readonly declarations: readonly string[];
  readonly internals: readonly string[];
  readonly connections: readonly string[];
}

/** The index of the sole line equal to `line`, failing the case when it is not exactly one. */
function soleLineIndex(lines: readonly string[], line: string): number {
  const indices = lines.flatMap((candidate, index) => (candidate === line ? [index] : []));
  expect({ line, indices }).toEqual({ line, indices: [indices[0] ?? -1] });
  return indices[0] as number;
}

/**
 * Split the rendered wrapper into its declaration, internal, and connection regions.
 *
 * EVERY MARKER IS LOCATED BY CONTENT, including the module header. The instance opener always was,
 * because the internal wires and the Warm_Up_Gate's counter are declared between it and the header.
 * The header itself used to be read as `lines[0]`, and that stopped being true the moment task 18.1
 * put `` `default_nettype none `` above it (Req 6.25): the opener assertion broke and every region
 * shifted by one, while the two suites that located their lines by content survived the same change
 * untouched
 * (`chipAgent/_inbox/gotcha-default-nettype-none-as-the-wrappers-first-line-breaks-two-test-pins-not-one.md`).
 *
 * This file's CLAIMS are unchanged - `soleLineIndex` asserts the header line occurs exactly once,
 * which is the pin the index comparison carried - and the directive line itself is owned by Property
 * 12, which pins it as text and pins the absence of its conventional restore.
 */
function splitWrapper(rendered: string, designInterface: ModuleInterface): WrapperRegions {
  const lines = rendered.split('\n');
  const headerStart = soleLineIndex(lines, `module ${WRAPPER_NAME} (`);
  const headerEnd = soleLineIndex(lines, HEADER_TERMINATOR);
  const instanceOpener = soleLineIndex(lines, `  ${designInterface.moduleName} dut (`);
  const instanceEnd = soleLineIndex(lines, INSTANCE_TERMINATOR);
  expect({
    headerBeforeTerminator: headerEnd > headerStart,
    instanceAfterHeader: instanceOpener > headerEnd,
  }).toEqual({
    headerBeforeTerminator: true,
    instanceAfterHeader: true,
  });
  return {
    declarations: lines.slice(headerStart + 1, headerEnd),
    internals: lines.slice(headerEnd + 1, instanceOpener),
    connections: lines.slice(instanceOpener + 1, instanceEnd),
  };
}

/** Parse the header's declarations, failing any line that is not an `input` declaration. */
function declaredPorts(declarations: readonly string[]): readonly ExpectedSignal[] {
  return declarations.map((line) => {
    const text = line.endsWith(',') ? line.slice(0, -1) : line;
    const match = DECLARATION_PATTERN.exec(text);
    // `input` is the pattern's only alternative, so a declaration of any other direction fails HERE
    // rather than being parsed and compared against a direction we also expected.
    expect({ line, parsedAsAnInput: match !== null }).toEqual({ line, parsedAsAnInput: true });
    const [, high, name] = match as RegExpExecArray;
    return { name: name as string, width: high === undefined ? 1 : Number(high) + 1 };
  });
}

/** Parse the internals region into its wires, counting the Warm_Up_Gate's counter separately. */
function declaredWires(internals: readonly string[]): readonly ExpectedSignal[] {
  const wires: ExpectedSignal[] = [];
  for (const line of internals) {
    if (COUNTER_PATTERN.test(line)) {
      continue;
    }
    const match = WIRE_PATTERN.exec(line);
    expect({ line, parsedAsAWire: match !== null }).toEqual({ line, parsedAsAWire: true });
    const [, high, name] = match as RegExpExecArray;
    wires.push({ name: name as string, width: high === undefined ? 1 : Number(high) + 1 });
  }
  return wires;
}

/** Parse the connection list, failing any connection that is not straight through by name. */
function connectedNames(connections: readonly string[]): readonly string[] {
  return connections.map((line) => {
    const text = line.endsWith(',') ? line.slice(0, -1) : line;
    const match = CONNECTION_PATTERN.exec(text);
    expect({ line, parsed: match !== null }).toEqual({ line, parsed: true });
    const [, formal, actual] = match as RegExpExecArray;
    // Straight through BY NAME (Req 3.10): a crossed connection would prove a property about a
    // different design than the one the student wrote, and it is invisible in the property text.
    expect({ line, straightThrough: formal === actual }).toEqual({ line, straightThrough: true });
    return formal as string;
  });
}

describe(PROPERTY, () => {
  it('declares every input as a port, every non-input as a wire, and connects both by name', () => {
    let total = 0;
    let withOutput = 0;
    let withInout = 0;
    let withMultiBitPort = 0;
    let withClockAndReset = 0;
    let withNoDeclaredPorts = 0;
    let withNoSignalsAtAll = 0;

    fc.assert(
      fc.property(
        arbDesignInterface(),
        arbFormalProperty(),
        arbResetContract(),
        (designInterface: ModuleInterface, property: FormalProperty, reset: ResetContract) => {
          total += 1;
          const rendered = renderPropertyWrapper(designInterface, property, WRAPPER_NAME, reset);
          const expected = expectedSignalsOf(designInterface);

          // Claim 1. No direction keyword but `input` anywhere in the whole text. Checked before the
          // regions are split, so a keyword smuggled outside the header is caught by this claim rather
          // than by a region parse that happens to reject the line for another reason.
          for (const forbidden of FORBIDDEN_DIRECTIONS) {
            expect({ pattern: forbidden.source, found: forbidden.test(rendered) }).toEqual({
              pattern: forbidden.source,
              found: false,
            });
          }

          const regions = splitWrapper(rendered, designInterface);

          // Claim 2a. The ports are exactly the design's inputs plus the clocking names, name and
          // width, as a duplicate-sensitive multiset.
          const ports = declaredPorts(regions.declarations);
          expect(ports.map(signalKey).sort()).toEqual(expected.ports.map(signalKey).sort());

          // Claim 2b. The non-inputs are exactly the internal wires - the measured ABC defect's
          // direction: an observed signal that reappears as a port is an output ORed into the property.
          const wires = declaredWires(regions.internals);
          expect(wires.map(signalKey).sort()).toEqual(expected.wires.map(signalKey).sort());

          // Claim 2c. The two-sided link: every declared signal, port or wire, is connected BY NAME,
          // and nothing else is. A declaration without its connection is the undriven-net shape.
          expect([...connectedNames(regions.connections)].sort()).toEqual(
            [...expected.ports, ...expected.wires].map((signal) => signal.name).sort(),
          );

          // Claim 3. The clocking contract's own clause: clock and reset are declared, as width-1
          // inputs, even though neither is in the design's declared port list.
          const portNames = new Set(ports.map((port) => port.name));
          const { clockName, resetName } = designInterface.clocking;
          for (const name of [clockName, resetName]) {
            if (name === null) {
              continue;
            }
            expect({
              name,
              declaredAsAPort: portNames.has(name),
              width: ports.find((port) => port.name === name)?.width,
            }).toEqual({ name, declaredAsAPort: true, width: CLOCKING_WIDTH });
          }

          if (designInterface.ports.some((port: Port) => port.direction === 'output')) {
            withOutput += 1;
          }
          if (designInterface.ports.some((port: Port) => port.direction === 'inout')) {
            withInout += 1;
          }
          if (designInterface.ports.some((port: Port) => port.width > 1)) {
            withMultiBitPort += 1;
          }
          if (clockName !== null && resetName !== null) {
            withClockAndReset += 1;
          }
          if (designInterface.ports.length === 0) {
            withNoDeclaredPorts += 1;
            if (clockName === null && resetName === null) {
              // Claim 4. The degenerate shape: no declaration list and no connection list at all, and
              // the renderer drops both rather than leaving a blank line inside the parentheses.
              withNoSignalsAtAll += 1;
              expect({
                declarations: regions.declarations,
                connections: regions.connections,
              }).toEqual({ declarations: [], connections: [] });
            }
          }
        },
      ),
      propertyParameters({ numRuns: NUM_RUNS }),
    );

    // NON-VACUITY. Claim 2b is trivially true over a sample of input-only designs, and claim 3 over a
    // sample of combinational ones, so both of those shapes are required to have been drawn - the
    // failure mode `chipAgent/_inbox/gotcha-golden-denominator-property-test-was-vacuous-for-new-status.md`
    // records, where a widened union left a property passing over a sample that no longer held it.
    expect({
      withOutput: withOutput / total >= MIN_SHAPE_SHARE,
      withInout: withInout / total >= MIN_SHAPE_SHARE,
      withMultiBitPort: withMultiBitPort / total >= MIN_SHAPE_SHARE,
      withClockAndReset: withClockAndReset / total >= MIN_SHAPE_SHARE,
      withNoDeclaredPorts: withNoDeclaredPorts / total >= MIN_SHAPE_SHARE,
      withNoSignalsAtAll: withNoSignalsAtAll / total >= MIN_DEGENERATE_SHARE,
    }).toEqual({
      withOutput: true,
      withInout: true,
      withMultiBitPort: true,
      withClockAndReset: true,
      withNoDeclaredPorts: true,
      withNoSignalsAtAll: true,
    });
  });

  it('suffixes a multi-bit signal with its range and a width-1 signal with nothing', () => {
    // A DETERMINISTIC case rather than a required generated shape. `arbDesignInterface()` draws widths
    // from 1 to 64, so a DECLARED width-1 port is ~1/64 per port and requiring one would cost thousands
    // of runs for coverage this case gives exactly. The generated sample does exercise the suffix-free
    // path on every case carrying a clock or a reset, because Req 3.11 makes both width 1 - what it does
    // not reliably reach is a suffix-free WIRE, which is the second line below.
    const rendered = renderPropertyWrapper(
      {
        moduleName: 'shift_reg',
        ports: [
          { name: 'd', direction: 'input', width: 8 },
          { name: 'q', direction: 'output', width: 1 },
        ],
        clocking: { clockName: 'clk', resetName: 'rst', resetActiveLow: false },
        validityOutputName: null,
      },
      NAMED_CASE_PROPERTY,
      WRAPPER_NAME,
      { derived: false },
    );
    expect(rendered).toContain('  input [7:0] d,\n');
    expect(rendered).toContain('  input clk,\n');
    expect(rendered).toContain('  wire q;\n');
  });
});
