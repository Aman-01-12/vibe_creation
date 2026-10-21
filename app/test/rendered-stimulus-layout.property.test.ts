// reference-model-rendered-stimulus, Property 3: The Stimulus_Function is total over the budget
// and faithful to the packed layout (task 2.8, C5).
//
// THE ORACLE IS A SEPARATE PARSE OF THE RENDERED TEXT, CROSS-CHECKED AGAINST `packedPortSlices`
//   This file parses `ece_stimulus`'s own rendered body by regex, independent of
//   `renderStimulusFunction`'s source (that function is not imported here). "Computed
//   independently" in the task text means independent of the STIMULUS RENDERING logic, not of
//   `packedPortSlices` itself: that function is the one shared layout source both the renderer
//   and the Reference_Model prompt already read from, so re-deriving its arithmetic a second time
//   would duplicate logic the design deliberately reuses rather than add any real check. It is
//   imported and called as the oracle's own source of each input port's slice.
//
// WHY TOTALITY IS A STRUCTURAL CHECK, NOT A SIMULATION
//   `ece_stimulus` is a pure function of `step` with no simulator in this file. Its body is a
//   fixed sequence of unconditional assignments - no `if`/`case` keys off `step` inside the
//   function - so "defined at every step from 0 to one less than the rendered budget" reduces to
//   "every rendered body line is a recognized assignment statement, and the lane assignments tile
//   the header width with no gap and no overlap". A line this parser cannot classify would be
//   exactly the sign of a step-dependent branch that could leave some step undefined, so it fails
//   the parse loudly rather than being skipped.
//
// WHY THE MAIN POPULATION DECLARES EVERY PORT `data`
//   Property 4 (task 2.9) owns the `enable` role's own release-frame behaviour. This file still
//   checks role fidelity generically (an `enable` port's slice must carry exactly one overwrite,
//   a `data` port's slice must carry none), but the sampled population here needs only `data` to
//   exercise the layout claim; `roleOf` and the role-fidelity check exist so the two non-vacuity
//   fixtures and this file's own logic stay consistent with the renderer's documented layout
//   rules in C5 rather than assuming `data` everywhere.
//
// NON-VACUITY: TWO FIXTURES, BUILT LOCALLY AND EXHAUSTED DIRECTLY, NOT WEIGHTED INTO `fc.oneof`
//   Per `chipAgent/_inbox/gotcha-interface-header-roundtrip-constructed-draws-sampled-not-exhausted-flaked.md`,
//   a closed, frozen non-vacuity obligation is exhausted in a deterministic test, not drawn
//   through a weighted sampler that can occasionally miss it. Both fixtures below are plain `it()`
//   blocks with no `fc.property` - zero sampling, zero flake surface - and are built locally
//   rather than appended to `interface-header-arbitraries.ts`'s own `CONSTRUCTED_DRAWS`, which
//   belongs to a different spec's property and whose population this file must not widen.
//     1. An input bundle wider than 64 bits, so the renderer emits more than one lane. Every
//        probed design is at most 33 bits, so a renderer that drops every lane above lane 0 would
//        pass every narrow draw silently; this fixture is the only thing that catches it.
//     2. An interface declaring no input ports at all, where `bundleWidth` floors at 1 and the
//        rendered width and the (empty) port-slice set must still agree.
//
// **Validates: Requirements 2.1, 2.2, 2.4**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  makeModuleInterface,
  makePort,
  makeTimingContract,
  type ModuleInterface,
  type Port,
  type PortDirection,
  type TimingContract,
} from '@app/core';
import {
  packedPortSlices,
  renderConsensusHarness,
  type ConsensusHarnessRequest,
  type InputRole,
  type RoleDeclaration,
} from '@app/tools';
// ENABLE_FRAME_PERIOD is not re-exported through the `@app/tools` barrel (simulator/index.ts),
// so it is read from its own module directly, matching the convention
// `rendered-stimulus-enable.property.test.ts` already uses for this same constant.
import { ENABLE_FRAME_PERIOD } from '../tools/simulator/consensus-harness.js';

import { ASCII_IDENT_CHARS, stringFromChars } from './generators/chars.js';
import { arbModuleInterface } from './interface-header-arbitraries.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'reference-model-rendered-stimulus, Property 3: The Stimulus_Function is total over the ' +
  'budget and faithful to the packed layout';

// ---------------------------------------------------------------------------
// Shared fixture plumbing
// ---------------------------------------------------------------------------

/** No SystemVerilog-2017 keyword begins with this, so a drawn nonce never needs a retry. */
const NONCE_PREFIX = 'zzid';

function nonceArbitrary(): fc.Arbitrary<string> {
  return stringFromChars(ASCII_IDENT_CHARS, 0, 6).map((suffix) => `${NONCE_PREFIX}${suffix}`);
}

/** Build a `Port` through the validating constructor, or fail the fixture loudly. */
function portOrThrow(name: string, direction: PortDirection, width: number): Port {
  const built = makePort({ name, direction, width });
  if (!built.ok) {
    throw new Error(`fixture defect: invalid port "${name}": ${built.error.code}`);
  }
  return built.value;
}

/** A total Role_Declaration naming every input port of `moduleInterface` as `data`. */
function allDataRoles(moduleInterface: ModuleInterface): RoleDeclaration {
  return moduleInterface.ports
    .filter((port) => port.direction === 'input')
    .map((port) => ({ portName: port.name, role: 'data' as const }));
}

/** One `registered` entry per output port of `moduleInterface`, built directly from its own ports. */
function allRegisteredTiming(moduleInterface: ModuleInterface): TimingContract {
  const entries = moduleInterface.ports
    .filter((port) => port.direction === 'output')
    .map((port) => ({ portName: port.name, timing: 'registered' as const }));
  const built = makeTimingContract(moduleInterface, entries);
  if (!built.ok) {
    throw new Error(`fixture defect building the timing contract: ${built.error.code}`);
  }
  return built.value;
}

/** `roles`'s role for `portName`, or `'data'` when `roles` carries no entry - mirrors the
 * renderer's own default so this file's role-fidelity check reads the same vocabulary it does. */
function roleOf(roles: RoleDeclaration, portName: string): InputRole {
  return roles.find((role) => role.portName === portName)?.role ?? 'data';
}

function rangesOverlap(
  a: { readonly low: number; readonly high: number },
  b: { readonly low: number; readonly high: number },
): boolean {
  return a.low <= b.high && b.low <= a.high;
}

// ---------------------------------------------------------------------------
// The test's own independent parser over the rendered `ece_stimulus` body
// ---------------------------------------------------------------------------

const STIMULUS_HEADER_LINE =
  /^function automatic \[(\d+):0\] ece_stimulus\(input \[31:0\] step\);$/;
const LANE_ASSIGN_LINE = /^ {4}v\[(\d+):(\d+)\] = ece_mix\(32'd(\d+), step\);$/;
const ENABLE_ASSIGN_LINE = new RegExp(
  `^ {4}v\\[(\\d+):(\\d+)\\] = \\{(\\d+)\\{\\(step % ${String(ENABLE_FRAME_PERIOD)}\\) != 0\\}\\};$`,
);
const STIMULUS_RETURN_LINE = '    ece_stimulus = v;';

interface ParsedStimulusFunction {
  /** The header's declared width (`inputBundleWidth`), read off `[W-1:0]`. */
  readonly width: number;
  readonly laneRanges: readonly {
    readonly low: number;
    readonly high: number;
    readonly lane: number;
  }[];
  readonly enableRanges: readonly {
    readonly low: number;
    readonly high: number;
    readonly width: number;
  }[];
}

/**
 * Parse the rendered `ece_stimulus` function body into its lane and enable-overwrite statements.
 *
 * Throws when a body line is none of {lane assignment, enable overwrite, the final return} - that
 * is exactly a step-dependent branch (an `if`/`case`) this renderer must never emit, so it is a
 * hard failure of Property 3's totality claim rather than a line this oracle silently ignores.
 */
function parseStimulusFunction(contents: string): ParsedStimulusFunction {
  const lines = contents.split('\n');
  const headerIndex = lines.findIndex((line) => STIMULUS_HEADER_LINE.test(line));
  if (headerIndex === -1) {
    throw new Error('rendered text carries no ece_stimulus header');
  }
  const headerMatch = STIMULUS_HEADER_LINE.exec(lines[headerIndex] as string) as RegExpExecArray;
  const width = Number(headerMatch[1]) + 1;

  const beginIndex = lines.indexOf('  begin', headerIndex);
  if (beginIndex === -1) {
    throw new Error('ece_stimulus header carries no begin block');
  }
  const endIndex = lines.indexOf('  end', beginIndex);
  if (endIndex === -1) {
    throw new Error('ece_stimulus begin block carries no matching end');
  }

  const bodyLines = lines.slice(beginIndex + 1, endIndex);
  const lastLine = bodyLines[bodyLines.length - 1];
  if (lastLine !== STIMULUS_RETURN_LINE) {
    throw new Error(
      `ece_stimulus body's last statement is not the unconditional return: ${String(lastLine)}`,
    );
  }

  const laneRanges: { low: number; high: number; lane: number }[] = [];
  const enableRanges: { low: number; high: number; width: number }[] = [];
  for (const line of bodyLines.slice(0, -1)) {
    const laneMatch = LANE_ASSIGN_LINE.exec(line);
    if (laneMatch !== null) {
      laneRanges.push({
        high: Number(laneMatch[1]),
        low: Number(laneMatch[2]),
        lane: Number(laneMatch[3]),
      });
      continue;
    }
    const enableMatch = ENABLE_ASSIGN_LINE.exec(line);
    if (enableMatch !== null) {
      enableRanges.push({
        high: Number(enableMatch[1]),
        low: Number(enableMatch[2]),
        width: Number(enableMatch[3]),
      });
      continue;
    }
    throw new Error(
      `ece_stimulus body carries an unrecognized statement, which breaks totality: ${line}`,
    );
  }
  return { width, laneRanges, enableRanges };
}

/**
 * Assert Property 3 over one rendered harness: the header width matches the declared input
 * bundle, the lanes tile `[0, width)` by the exact `v[min(width,64(k+1))-1:64k]` formula with no
 * gap and no overlap, every port's `packedPortSlices` slice shares no bit with another port's,
 * and each port's role is honoured - an `enable` port carries exactly one overwrite over its own
 * slice, a `data` port carries none.
 */
function assertStimulusLayoutFaithful(
  moduleInterface: ModuleInterface,
  roles: RoleDeclaration,
  renderedContents: string,
): void {
  const inputPorts = moduleInterface.ports.filter((port) => port.direction === 'input');
  const expectedWidth = Math.max(
    1,
    inputPorts.reduce((sum, port) => sum + port.width, 0),
  );
  const { width, laneRanges, enableRanges } = parseStimulusFunction(renderedContents);
  expect(width).toBe(expectedWidth);

  // Lane tiling: the exact formula from C5, not just "contiguous" - a dropped or misordered lane
  // fails here even if some other lane happens to cover the gap.
  const sortedLanes = [...laneRanges].sort((a, b) => a.low - b.low);
  const expectedLaneCount = Math.ceil(width / 64);
  expect(sortedLanes.length).toBe(expectedLaneCount);
  sortedLanes.forEach((lane, index) => {
    expect({ low: lane.low, high: lane.high, lane: lane.lane }).toEqual({
      low: index * 64,
      high: Math.min(width, 64 * (index + 1)) - 1,
      lane: index,
    });
  });
  // Totality over the header width: no bit from 0 to width-1 is left unassigned.
  expect(sortedLanes[0]?.low).toBe(0);
  expect(sortedLanes[sortedLanes.length - 1]?.high).toBe(width - 1);

  // Each port's own slice, read from the shared layout source, shares no bit with another port's.
  const slices = packedPortSlices(inputPorts);
  const sortedSlices = [...slices].sort((a, b) => a.low - b.low);
  sortedSlices.forEach((slice, index) => {
    const previous = sortedSlices[index - 1];
    if (previous !== undefined) {
      expect(slice.low).toBe(previous.high + 1);
    }
  });
  if (sortedSlices.length > 0) {
    expect(sortedSlices[0]?.low).toBe(0);
    expect(sortedSlices[sortedSlices.length - 1]?.high).toBe(width - 1);
  }

  // Role fidelity: an enable-role port's slice is overwritten exactly once; a data-role port's
  // slice carries no overwrite at all, so its bits come solely from the lane tiling above.
  for (const slice of slices) {
    const role = roleOf(roles, slice.name);
    const matchingEnableRanges = enableRanges.filter(
      (range) => range.low === slice.low && range.high === slice.high,
    );
    if (role === 'enable') {
      expect(matchingEnableRanges.length).toBe(1);
      expect(matchingEnableRanges[0]?.width).toBe(slice.high - slice.low + 1);
    } else {
      expect(enableRanges.some((range) => rangesOverlap(range, slice))).toBe(false);
    }
  }
}

// ---------------------------------------------------------------------------
// The sampled population
// ---------------------------------------------------------------------------

/** A `ConsensusHarnessRequest` for a drawn `moduleInterface`, every input port rendered `data`. */
function arbRequestScenario(): fc.Arbitrary<{
  readonly moduleInterface: ModuleInterface;
  readonly request: ConsensusHarnessRequest;
}> {
  return arbModuleInterface().chain((moduleInterface) =>
    fc
      .record({
        nonce: nonceArbitrary(),
        watchdogBudgetNs: fc.integer({ min: 1, max: 2_000_000 }),
        sampleBudget: fc.integer({ min: 1, max: 64 }),
      })
      .map(({ nonce, watchdogBudgetNs, sampleBudget }) => ({
        moduleInterface,
        request: {
          moduleInterface,
          timingContract: allRegisteredTiming(moduleInterface),
          nonce,
          watchdogBudgetNs,
          sampleBudget,
          roles: allDataRoles(moduleInterface),
        },
      })),
  );
}

describe(PROPERTY, () => {
  it(
    'renders a Stimulus_Function whose lanes tile the header width exactly and whose declared ' +
      'input ports share no bit, for a widely varied Declared_Interface',
    () => {
      let acceptedAtLeastOnce = false;

      fc.assert(
        fc.property(arbRequestScenario(), ({ moduleInterface, request }) => {
          const rendered = renderConsensusHarness(request);
          if (!rendered.ok) {
            // `arbModuleInterface()`'s identifier generator avoids only a small keyword set, not
            // the renderer's full `VERILOG_KEYWORDS` list, so an occasional reserved-keyword draw
            // is a legitimate refusal rather than a defect in this property (see
            // rendered-stimulus-determinism.property.test.ts for the same reasoning).
            return;
          }
          acceptedAtLeastOnce = true;
          assertStimulusLayoutFaithful(moduleInterface, request.roles, rendered.value.contents);
        }),
        propertyParameters(),
      );

      expect(acceptedAtLeastOnce, 'no draw was accepted by the renderer').toBe(true);
    },
  );
});

// ---------------------------------------------------------------------------
// Non-vacuity: constructed interfaces, exhausted directly rather than sampled
// ---------------------------------------------------------------------------

/** Constructed draw: an input bundle of 81 bits (40 + 41), so the renderer must emit two lanes. */
function buildWideBundleInterface(): ModuleInterface {
  const built = makeModuleInterface({
    moduleName: 'wide_bundle_mod',
    ports: [
      portOrThrow('a', 'input', 40),
      portOrThrow('b', 'input', 41),
      portOrThrow('y', 'output', 8),
    ],
    clocking: { clockName: null, resetName: null, resetActiveLow: false },
  });
  if (!built.ok) {
    throw new Error(`fixture defect building the wide-bundle interface: ${built.error.code}`);
  }
  return built.value;
}

/** Constructed draw: no input ports at all, where `bundleWidth` floors the rendered width at 1. */
function buildNoInputPortsInterface(): ModuleInterface {
  const built = makeModuleInterface({
    moduleName: 'no_input_mod',
    ports: [portOrThrow('y', 'output', 4)],
    clocking: { clockName: null, resetName: null, resetActiveLow: false },
  });
  if (!built.ok) {
    throw new Error(`fixture defect building the no-input-ports interface: ${built.error.code}`);
  }
  return built.value;
}

function buildRequest(moduleInterface: ModuleInterface, nonce: string): ConsensusHarnessRequest {
  return {
    moduleInterface,
    timingContract: allRegisteredTiming(moduleInterface),
    nonce,
    watchdogBudgetNs: 1000,
    sampleBudget: 8,
    roles: allDataRoles(moduleInterface),
  };
}

describe(`${PROPERTY} - non-vacuity`, () => {
  it('renders more than one lane for an input bundle wider than 64 bits', () => {
    const moduleInterface = buildWideBundleInterface();
    const request = buildRequest(moduleInterface, 'zzidwide');
    const rendered = renderConsensusHarness(request);
    if (!rendered.ok) {
      throw new Error(
        `fixture defect: renderer refused the wide-bundle fixture: ${rendered.error.code}`,
      );
    }
    const parsed = parseStimulusFunction(rendered.value.contents);
    // The trap this fixture exists to catch: a renderer dropping every lane above lane 0 would
    // still pass every narrow draw, so this count must be asserted directly, not just covered.
    expect(parsed.laneRanges.length).toBeGreaterThan(1);
    assertStimulusLayoutFaithful(moduleInterface, request.roles, rendered.value.contents);
  });

  it('floors the rendered width at 1 bit for an interface declaring no input ports', () => {
    const moduleInterface = buildNoInputPortsInterface();
    expect(moduleInterface.ports.filter((port) => port.direction === 'input')).toHaveLength(0);
    const request = buildRequest(moduleInterface, 'zzidnoin');
    const rendered = renderConsensusHarness(request);
    if (!rendered.ok) {
      throw new Error(
        `fixture defect: renderer refused the no-input-ports fixture: ${rendered.error.code}`,
      );
    }
    const parsed = parseStimulusFunction(rendered.value.contents);
    expect(parsed.width).toBe(1);
    assertStimulusLayoutFaithful(moduleInterface, request.roles, rendered.value.contents);
  });
});
