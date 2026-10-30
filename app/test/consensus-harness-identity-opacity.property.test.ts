// stimulus-transaction-structure, Property 21: No identity constant reaches harness text (task
// 10.4, C12).
//
// THE REAL FALSE-POSITIVE TRAP THIS FILE HAS TO SURVIVE
//   `CONSENSUS_HARNESS_VERSION` is 4 and `REFERENCE_MODEL_PROMPT_VERSION` is 11 (C12). A blanket
//   "the rendered text contains no occurrence of '4' or '11'" assertion is unsound against the
//   renderer's OWN text, not only against generator noise: a caller asking for 4 Sample_Points
//   renders `` localparam integer ECE_SAMPLE_BUDGET = 4; ``, which is exactly
//   `CONSENSUS_HARNESS_VERSION`'s own value, and a width-based draw hits the same trap - a 4-bit
//   port renders `[3:0]`. (At prompt version 10 the renderer's fixed `ECE_PERIOD = CLOCK_PERIOD_NS`
//   collided with `REFERENCE_MODEL_PROMPT_VERSION` the same way. The version has since moved to 11,
//   so THAT coincidence is historical - which is why the example below sources its expected period
//   from `CLOCK_PERIOD_NS` and never from the version constant, and pins its live collision on the
//   Sample_Budget instead.) Property 21 names what actually must hold: the two constants read from
//   `CONSENSUS_HARNESS_VERSION` and `REFERENCE_MODEL_PROMPT_VERSION` never reach the rendered text
//   AS A HARNESS CONSTANT - i.e. the renderer never declares a NEW named constant carrying either
//   version's identity. It is not a claim about the digits 4 or 11 appearing anywhere at all.
//
// TWO CHECKS, NEITHER SENSITIVE TO AN INCIDENTAL DIGIT
//   1. The rendered text contains no occurrence of the word "version" (case-insensitive, scanned
//      over the raw text including the harness's own fixed header comment). Today nothing the
//      renderer emits names anything "version" at all, so this is a direct, literal check on the
//      ONE word a version-carrying constant or comment would have to use to be legible as a
//      version in the first place, and it cannot be satisfied by a coincidental digit.
//   2. Every `localparam` declaration the renderer emits is scanned for its declared NAME (never
//      its value), and that name must be one of the five the renderer is known to declare today
//      (`ECE_WATCHDOG_BUDGET_NS`, `ECE_SAMPLE_BUDGET`, `ECE_PERIOD`, `ECE_SKEW`,
//      `ECE_RESET_FRAME` - read directly off `consensus-harness.ts`'s own `lines.push(...)` text,
//      the same discipline `consensus-harness-identifier.property.test.ts`'s `SKELETON_VOCABULARY`
//      already applies to the whole harness). A future edit that interpolated either version
//      constant into a NEW named `localparam` - regardless of what digit it happened to carry -
//      is what this catches; `ECE_PERIOD`'s legitimate value of 10 is simply an allowed name
//      carrying an allowed value, never inspected for being equal to anything.
//
// NON-VACUITY: THE COLLISION IS DRAWN ON PURPOSE, NOT AVOIDED
//   `sampleBudgetArbitrary`/`watchdogBudgetNsArbitrary` below are biased to land exactly on 4 and
//   11 a real fraction of the time, and `designShapeArbitrary` draws port widths over a range that
//   includes both - so the two checks above are proven to tolerate the real incidental occurrences
//   of both digits, not merely never exercised against them. A dedicated example test additionally
//   pins one such collision deterministically - `ECE_SAMPLE_BUDGET = CONSENSUS_HARNESS_VERSION`'s
//   own value - since a sampled generator could in principle go a whole run without drawing one.
//
// Validates: Requirements 9.7

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { REFERENCE_MODEL_PROMPT_VERSION } from '@app/agent';
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
} from '@app/core';
import {
  CLOCK_PERIOD_NS,
  CONSENSUS_HARNESS_VERSION,
  INPUT_ROLES,
  renderConsensusHarness,
  SAMPLE_BUDGET,
  type ConsensusHarnessRequest,
  type InputRole,
  type RoleDeclaration,
} from '@app/tools';

import { ASCII_IDENT_CHARS, stringFromChars } from './generators/chars.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'stimulus-transaction-structure, Property 21: No identity constant reaches harness text';

/**
 * The renderer's own closed set of `localparam` names, hand-enumerated from
 * `consensus-harness.ts`'s literal `lines.push(...)` text (never derived by calling the
 * renderer). A sixth name appearing here is exactly the regression this property guards: a new
 * harness constant, whatever value it carries.
 */
const KNOWN_LOCALPARAM_NAMES: ReadonlySet<string> = new Set([
  'ECE_WATCHDOG_BUDGET_NS',
  'ECE_SAMPLE_BUDGET',
  'ECE_PERIOD',
  'ECE_SKEW',
  'ECE_RESET_FRAME',
]);

/** Every `localparam <type> NAME = value;` declaration's own declared NAME, never its value. */
const LOCALPARAM_DECLARATION_NAME =
  /\blocalparam\s+(?:\[[^\]]+\]|integer)\s+([A-Za-z_$][\w$]*)\s*=/g;

function declaredLocalparamNamesIn(renderedText: string): readonly string[] {
  return [...renderedText.matchAll(LOCALPARAM_DECLARATION_NAME)].map((match) => match[1] as string);
}

// ---------------------------------------------------------------------------
// Fixture builders - a design shape that independently coins a clock, a reset, and a
// Role_Declaration over every input port, so both the clocked and clockless rendered shapes, and
// all four Role_Vocabulary emission branches, are exercised.
// ---------------------------------------------------------------------------

/** No SystemVerilog-2017 keyword begins with this, so the identifier draw never needs retrying. */
const IDENT_PREFIX = 'zzid';

function identifierArbitrary(): fc.Arbitrary<string> {
  return stringFromChars(ASCII_IDENT_CHARS, 0, 6).map((suffix) => `${IDENT_PREFIX}${suffix}`);
}

function portOrThrow(name: string, direction: PortDirection, width: number): Port {
  const built = makePort({ name, direction, width });
  if (!built.ok) {
    throw new Error(`generator produced an invalid port: ${built.error.code}`);
  }
  return built.value;
}

interface DesignShape {
  readonly moduleName: string;
  readonly outputWidths: readonly number[];
  readonly inputWidths: readonly number[];
  readonly hasClock: boolean;
  readonly hasReset: boolean;
  readonly resetActiveLow: boolean;
}

interface GeneratedDesign {
  readonly moduleInterface: ModuleInterface;
  readonly inputPorts: readonly Port[];
}

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
  return { moduleInterface: built.value, inputPorts };
}

/**
 * Widths deliberately span 1 to 16, which already includes both 4 and 10 - the two constants'
 * own values - so a width-driven bit range (`[3:0]`, `[9:0]`) is drawn by construction, not left
 * to chance.
 */
function designShapeArbitrary(): fc.Arbitrary<DesignShape> {
  return fc.record<DesignShape>({
    moduleName: identifierArbitrary(),
    outputWidths: fc.array(fc.integer({ min: 1, max: 16 }), { minLength: 1, maxLength: 3 }),
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

function timingContractArbitrary(moduleInterface: ModuleInterface): fc.Arbitrary<TimingContract> {
  const outputPorts = moduleInterface.ports.filter((port) => port.direction === 'output');
  return fc
    .array(fc.constantFrom<PortTiming>('registered', 'combinational'), {
      minLength: outputPorts.length,
      maxLength: outputPorts.length,
    })
    .map((timings) => {
      const built = makeTimingContract(
        moduleInterface,
        outputPorts.map((port, index) => ({
          portName: port.name,
          timing: timings[index] as PortTiming,
        })),
      );
      if (!built.ok) {
        throw new Error(`generator produced an invalid timing contract: ${built.error.code}`);
      }
      return built.value;
    });
}

/** A total Role_Declaration drawn from the full Role_Vocabulary, one independent choice per port. */
function roleDeclarationArbitrary(inputPorts: readonly Port[]): fc.Arbitrary<RoleDeclaration> {
  if (inputPorts.length === 0) {
    return fc.constant([]);
  }
  return fc
    .array(fc.constantFrom<InputRole>(...INPUT_ROLES), {
      minLength: inputPorts.length,
      maxLength: inputPorts.length,
    })
    .map((roles) =>
      inputPorts.map((port, index) => ({ portName: port.name, role: roles[index] as InputRole })),
    );
}

/** Biased to land exactly on `CONSENSUS_HARNESS_VERSION`'s or `REFERENCE_MODEL_PROMPT_VERSION`'s own value a real fraction of draws, not only on the default. */
function sampleBudgetArbitrary(): fc.Arbitrary<number> {
  return fc.oneof(
    {
      weight: 2,
      arbitrary: fc.constantFrom(CONSENSUS_HARNESS_VERSION, REFERENCE_MODEL_PROMPT_VERSION),
    },
    { weight: 6, arbitrary: fc.integer({ min: 1, max: SAMPLE_BUDGET }) },
  );
}

function watchdogBudgetNsArbitrary(): fc.Arbitrary<number> {
  return fc.oneof(
    {
      weight: 2,
      arbitrary: fc.constantFrom(CONSENSUS_HARNESS_VERSION, REFERENCE_MODEL_PROMPT_VERSION),
    },
    { weight: 6, arbitrary: fc.integer({ min: 1, max: 2_000_000 }) },
  );
}

function requestArbitrary(): fc.Arbitrary<ConsensusHarnessRequest> {
  return generatedDesignArbitrary().chain(({ moduleInterface, inputPorts }) =>
    fc
      .record({
        timingContract: timingContractArbitrary(moduleInterface),
        roles: roleDeclarationArbitrary(inputPorts),
        nonce: identifierArbitrary(),
        sampleBudget: sampleBudgetArbitrary(),
        watchdogBudgetNs: watchdogBudgetNsArbitrary(),
      })
      .map(({ timingContract, roles, nonce, sampleBudget, watchdogBudgetNs }) => ({
        moduleInterface,
        timingContract,
        nonce,
        watchdogBudgetNs,
        sampleBudget,
        roles,
      })),
  );
}

describe(PROPERTY, () => {
  it('tolerates a real ECE_SAMPLE_BUDGET collision with CONSENSUS_HARNESS_VERSION\u2019s own value, and renders ECE_PERIOD as the clock period, without reading either as a leaked identity constant', () => {
    const moduleInterface = makeModuleInterface({
      moduleName: 'm',
      ports: [portOrThrow('a', 'input', 1), portOrThrow('y', 'output', 1)],
      clocking: { clockName: 'clk', resetName: 'rst', resetActiveLow: false },
      validityOutputName: null,
    });
    if (!moduleInterface.ok) throw new Error('fixture defect');
    const timingContract = makeTimingContract(moduleInterface.value, [
      { portName: 'y', timing: 'combinational' },
    ]);
    if (!timingContract.ok) throw new Error('fixture defect');
    const rendered = renderConsensusHarness({
      moduleInterface: moduleInterface.value,
      timingContract: timingContract.value,
      nonce: 'n1',
      watchdogBudgetNs: 2_000_000,
      // Asking for exactly CONSENSUS_HARNESS_VERSION Sample_Points, so the rendered budget
      // carries an identity constant's own value under a legitimate name. Small enough that
      // `sizedSampleBudget`'s width cap cannot lower it, so the collision is deterministic.
      sampleBudget: CONSENSUS_HARNESS_VERSION,
      roles: [{ portName: 'a', role: 'data' }],
    });
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    // The real, deterministic collision this property has to survive: 4 appears, legitimately,
    // under a name that is NOT either version constant's name.
    expect(rendered.value.contents).toContain(
      `localparam integer ECE_SAMPLE_BUDGET = ${String(CONSENSUS_HARNESS_VERSION)};`,
    );
    // Sourced from the clock period, which is what the renderer actually interpolates here - never
    // from REFERENCE_MODEL_PROMPT_VERSION, whose equal value at prompt version 10 was coincidence.
    expect(rendered.value.contents).toContain(
      `localparam integer ECE_PERIOD = ${String(CLOCK_PERIOD_NS)};`,
    );
    expect(rendered.value.contents.toLowerCase()).not.toContain('version');
    expect(
      declaredLocalparamNamesIn(rendered.value.contents).every((name) =>
        KNOWN_LOCALPARAM_NAMES.has(name),
      ),
    ).toBe(true);
  });

  it('renders no occurrence of the word "version" and declares no localparam outside the known set, across generated requests including ones that draw 4 or 11 directly', () => {
    let localparamScanCount = 0;
    let sampleBudgetCollisionCases = 0;
    let watchdogCollisionCases = 0;

    fc.assert(
      fc.property(requestArbitrary(), (request) => {
        const rendered = renderConsensusHarness(request);
        // A generated identifier may still coincidentally be a reserved keyword after the
        // renderer's own case-insensitive check; not the claim under test, so such draws are
        // discarded rather than failed, the same convention this feature's other property files
        // already use for this generator shape.
        fc.pre(rendered.ok);
        if (!rendered.ok) return;

        if (
          request.sampleBudget === CONSENSUS_HARNESS_VERSION ||
          request.sampleBudget === REFERENCE_MODEL_PROMPT_VERSION
        ) {
          sampleBudgetCollisionCases += 1;
        }
        if (
          request.watchdogBudgetNs === CONSENSUS_HARNESS_VERSION ||
          request.watchdogBudgetNs === REFERENCE_MODEL_PROMPT_VERSION
        ) {
          watchdogCollisionCases += 1;
        }

        expect(rendered.value.contents.toLowerCase()).not.toContain('version');

        const declaredNames = declaredLocalparamNamesIn(rendered.value.contents);
        localparamScanCount += declaredNames.length;
        for (const name of declaredNames) {
          expect(KNOWN_LOCALPARAM_NAMES.has(name)).toBe(true);
        }
      }),
      propertyParameters(),
    );

    // NON-VACUITY: the scan actually matched real declarations, and the biased draws actually
    // landed on both constants' own values at least once each - otherwise the two checks above
    // would be passing by never having anything to reject in the first place.
    expect(localparamScanCount).toBeGreaterThan(0);
    expect(sampleBudgetCollisionCases).toBeGreaterThan(0);
    expect(watchdogCollisionCases).toBeGreaterThan(0);
  });
});
