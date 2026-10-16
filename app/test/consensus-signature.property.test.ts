// reference-model-consensus-gate, Property 15: The Waveform_Signature masks exactly where
// validity is low (task 2.2).
//
// THE ORACLE
//   Known by construction, never read back off the reducer or off `validityOutputName`. The
//   generator itself decides, per Sample_Point, whether the planted Validity_Output reads high or
//   low, and the expected mask is exactly the step set it decided low. The generator renders that
//   decision into an `ECE_SAMPLE` / `ECE_SAMPLE_END` stream and `reduceSignature` is checked
//   against the plant, never against its own masking restated.
//
// THE THREE INTERFACE SHAPES
//   `declared` (a Validity_Output among two or more output ports), `none` (no Validity_Output
//   at all, so masking can never trigger regardless of any column's value), and `validity-only`
//   (the interface's one output port is the Validity_Output, so there is nothing else to mask -
//   the decisive case for "the Validity_Output's own entry is never masked" when it is also the
//   only entry).
//
// Validates: Requirements 7.1, 7.2, 7.3, 7.4, 7.5

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  makeModuleInterface,
  makePort,
  type ModuleInterface,
  type Port,
  type PortDirection,
} from '@app/core';

import { reduceSignature } from '../agent/consensus/signature.js';

import { ASCII_IDENT_CHARS, stringFromChars } from './generators/chars.js';
import { propertyParameters } from './property.js';

const PROPERTY =
  'reference-model-consensus-gate, Property 15: The Waveform_Signature masks exactly where validity is low';

/** Hex digits only, matching the harness's own `%0h` nibble rendering (Property 6's premise). */
const HEX_CHARS: readonly string[] = '0123456789abcdef'.split('');

/** The literal tokens `reduceSignature` itself reads as validity-high and validity-low. */
const HIGH_VALIDITY_TOKEN = '1';
const LOW_VALIDITY_TOKEN = '0';

function identifierArbitrary(): fc.Arbitrary<string> {
  return stringFromChars(ASCII_IDENT_CHARS, 1, 8);
}

function valueTokenArbitrary(): fc.Arbitrary<string> {
  return stringFromChars(HEX_CHARS, 1, 4);
}

/** Build a `Port` through the validating constructor, or fail the generator loudly. */
function portOrThrow(name: string, direction: PortDirection): Port {
  const built = makePort({ name, direction, width: 1 });
  if (!built.ok) {
    throw new Error(`generator produced an invalid port: ${built.error.code}`);
  }
  return built.value;
}

/** One of the three decisive interface shapes the task names. */
type Shape = 'declared' | 'none' | 'validity-only';

/**
 * A `ModuleInterface` plus the plant the oracle checks against: the declared output order and
 * which position (if any) is the Validity_Output. Known from how the interface was built, so the
 * mask check below never has to read `moduleInterface.validityOutputName` back.
 */
interface GeneratedInterface {
  readonly moduleInterface: ModuleInterface;
  readonly outputNames: readonly string[];
  /** Position of the Validity_Output among `outputNames`, or -1 when none is declared. */
  readonly validityIndex: number;
}

function buildInterface(
  moduleName: string,
  outputNames: readonly string[],
  inputNames: readonly string[],
  validityIndex: number,
): GeneratedInterface {
  const validityOutputName = validityIndex === -1 ? null : (outputNames[validityIndex] as string);
  const built = makeModuleInterface({
    moduleName,
    ports: [
      ...outputNames.map((name) => portOrThrow(name, 'output')),
      ...inputNames.map((name) => portOrThrow(name, 'input')),
    ],
    clocking: { clockName: null, resetName: null, resetActiveLow: false },
    validityOutputName,
  });
  if (!built.ok) {
    throw new Error(`generator produced an invalid module interface: ${built.error.code}`);
  }
  return { moduleInterface: built.value, outputNames, validityIndex };
}

/** Draw one of the three decisive shapes, with the output/input counts and names it needs. */
function generatedInterfaceArbitrary(): fc.Arbitrary<GeneratedInterface> {
  return fc.constantFrom<Shape>('declared', 'none', 'validity-only').chain((shape) => {
    const outputCountArbitrary =
      shape === 'validity-only'
        ? fc.constant(1)
        : shape === 'declared'
          ? fc.integer({ min: 2, max: 5 })
          : fc.integer({ min: 1, max: 5 });

    return fc
      .record({
        moduleName: identifierArbitrary(),
        outputCount: outputCountArbitrary,
        inputCount: fc.integer({ min: 0, max: 2 }),
      })
      .chain(({ moduleName, outputCount, inputCount }) => {
        const needed = outputCount + inputCount;
        return fc
          .uniqueArray(identifierArbitrary(), { minLength: needed, maxLength: needed })
          .chain((names) => {
            const outputNames = names.slice(0, outputCount);
            const inputNames = names.slice(outputCount);
            const validityIndexArbitrary =
              shape === 'none'
                ? fc.constant(-1)
                : shape === 'validity-only'
                  ? fc.constant(0)
                  : fc.nat({ max: outputCount - 1 });
            return validityIndexArbitrary.map((validityIndex) =>
              buildInterface(moduleName, outputNames, inputNames, validityIndex),
            );
          });
      });
  });
}

/**
 * One planted Sample_Point: whether the Validity_Output reads low, and every output column's raw
 * value. The Validity_Output's own column is overwritten below to the literal token
 * `reduceSignature` itself reads as high (`"1"`) or low (anything else), so the plant and the
 * check agree on what "low" means without the check ever asking the reducer.
 */
interface StepPlan {
  readonly low: boolean;
  readonly values: readonly string[];
}

function stepsArbitrary(
  outputCount: number,
  validityIndex: number,
): fc.Arbitrary<readonly StepPlan[]> {
  return fc
    .array(
      fc.record({
        low: fc.boolean(),
        values: fc.array(valueTokenArbitrary(), { minLength: outputCount, maxLength: outputCount }),
      }),
      { minLength: 1, maxLength: 8 },
    )
    .map((rows) =>
      rows.map((row) => {
        if (validityIndex === -1) {
          return row;
        }
        const forcedValidityToken = row.low ? LOW_VALIDITY_TOKEN : HIGH_VALIDITY_TOKEN;
        const values = row.values.map((value, index) =>
          index === validityIndex ? forcedValidityToken : value,
        );
        return { low: row.low, values };
      }),
    );
}

interface Scenario {
  readonly generated: GeneratedInterface;
  readonly nonce: string;
  readonly steps: readonly StepPlan[];
}

function scenarioArbitrary(): fc.Arbitrary<Scenario> {
  return generatedInterfaceArbitrary().chain((generated) =>
    fc.record({
      generated: fc.constant(generated),
      nonce: identifierArbitrary(),
      steps: stepsArbitrary(generated.outputNames.length, generated.validityIndex),
    }),
  );
}

/** Render the planted steps as the harness's own `ECE_SAMPLE` / `ECE_SAMPLE_END` wire format. */
function renderStdout(nonce: string, steps: readonly StepPlan[]): string {
  const sampleLines = steps.map((step, index) =>
    ['ECE_SAMPLE', nonce, String(index), ...step.values].join(' '),
  );
  const endLine = ['ECE_SAMPLE_END', nonce, String(steps.length)].join(' ');
  return [...sampleLines, endLine].join('\n');
}

describe(PROPERTY, () => {
  it(
    'masks exactly the steps planted validity-low, keeps every other position exact, and never ' +
      "masks the Validity_Output's own entry",
    () => {
      let declaredCases = 0;
      let noneCases = 0;
      let validityOnlyCases = 0;

      fc.assert(
        fc.property(scenarioArbitrary(), (scenario) => {
          const { generated, nonce, steps } = scenario;
          const { moduleInterface, outputNames, validityIndex } = generated;

          const stdout = renderStdout(nonce, steps);
          const signature = reduceSignature(stdout, nonce, moduleInterface);

          expect(signature).not.toBeNull();
          if (signature === null) {
            return;
          }

          // Positional invariant: one record per emitted Sample_Point, in step order.
          expect(signature.trace).toHaveLength(steps.length);

          steps.forEach((step, index) => {
            const record = signature.trace[index];
            if (record === undefined) {
              throw new Error('trace is shorter than the planted step list');
            }
            expect(record.step).toBe(index);
            // One entry per output port, in declared order.
            expect(record.values).toHaveLength(outputNames.length);

            outputNames.forEach((_, portIndex) => {
              const actual = record.values[portIndex] as string | null;
              const planted = step.values[portIndex] as string;

              if (portIndex === validityIndex) {
                // Never masked, even when it is the interface's only output port.
                expect(actual).not.toBeNull();
                expect(actual).toBe(planted);
                return;
              }

              const maskedHere = validityIndex !== -1 && step.low;
              expect(actual).toBe(maskedHere ? null : planted);
            });
          });

          if (validityIndex === -1) {
            noneCases += 1;
          } else if (outputNames.length === 1) {
            validityOnlyCases += 1;
          } else {
            declaredCases += 1;
          }
        }),
        propertyParameters(),
      );

      // NON-VACUITY: every decisive shape the task names must actually have been exercised.
      expect({
        declaredCases: declaredCases > 0,
        noneCases: noneCases > 0,
        validityOnlyCases: validityOnlyCases > 0,
      }).toEqual({
        declaredCases: true,
        noneCases: true,
        validityOnlyCases: true,
      });
    },
  );
});

// Property 16: An incomplete run yields no signature and a failing pair (task 2.3).
//
// THE ORACLE
//   A stream the generator itself knows is complete (reduceSignature must accept it before any
//   mutilation, which the test checks first) is then mutilated three ways: truncated, stripped of
//   its end marker, or left with its end marker's count shifted by a non-zero delta. Each
//   mutilation must turn the known-complete stream into one `reduceSignature` reduces to `null`.
//   Task 8.4's integration test is the simulator-side half of this determinism claim; neither side
//   here is checked against its own opinion.
//
// TWO TRUNCATION OFFSETS
//   One strictly inside a sample line's own characters (the malformed-line case), and one exactly
//   at a line boundary (the "parseable prefix" case the task calls the easy one to miss, because a
//   boundary cut can discard whole lines, including the end marker, while leaving every surviving
//   line individually well-formed).

/** The lines of a rendered stream, and the absolute offset each line starts at. */
function lineStartOffsets(lines: readonly string[]): readonly number[] {
  const starts: number[] = [];
  let cursor = 0;
  for (const line of lines) {
    starts.push(cursor);
    cursor += line.length + 1; // + the '\n' joiner `renderStdout` uses between lines.
  }
  return starts;
}

/** Every offset that lands exactly on a line boundary, excluding the stream's own full length. */
function lineBoundaryOffsets(lines: readonly string[]): readonly number[] {
  return lineStartOffsets(lines).slice(1);
}

/**
 * An offset strictly inside `lines[lineIndex]`'s own characters: past its first character (which
 * would just be the preceding boundary) and before its last (which would be the next one). `seed`
 * selects among the candidates so the exact interior offset varies across runs.
 */
function offsetInsideLine(lines: readonly string[], lineIndex: number, seed: number): number {
  const start = lineStartOffsets(lines)[lineIndex] as number;
  const line = lines[lineIndex] as string;
  const interiorWidth = Math.max(line.length - 1, 1);
  return start + 1 + (seed % interiorWidth);
}

/** A non-zero shift for the end marker's count; negative shifts exercise the malformed-count path. */
function countDeltaArbitrary(): fc.Arbitrary<number> {
  return fc.integer({ min: -5, max: 5 }).filter((delta) => delta !== 0);
}

describe('reference-model-consensus-gate, Property 16: An incomplete run yields no signature and a failing pair', () => {
  it(
    'truncating mid-line, truncating at a line boundary, dropping the end marker, or shifting ' +
      "its count all turn a complete stream's reduction into null",
    () => {
      fc.assert(
        fc.property(
          scenarioArbitrary(),
          fc.nat(),
          fc.nat(),
          countDeltaArbitrary(),
          (scenario, sampleLineSeed, boundarySeed, countDelta) => {
            const { generated, nonce, steps } = scenario;
            const { moduleInterface } = generated;
            const stdout = renderStdout(nonce, steps);

            // The generator's own completeness claim, checked before any mutilation.
            expect(reduceSignature(stdout, nonce, moduleInterface)).not.toBeNull();

            const lines = stdout.split('\n');

            // Mutilation 1: truncate inside one ECE_SAMPLE line's own characters.
            const sampleLineIndex = sampleLineSeed % steps.length;
            const insideOffset = offsetInsideLine(lines, sampleLineIndex, sampleLineSeed);
            expect(
              reduceSignature(stdout.slice(0, insideOffset), nonce, moduleInterface),
            ).toBeNull();

            // Mutilation 2: truncate exactly at a line boundary, discarding the end marker.
            const boundaryOffsets = lineBoundaryOffsets(lines);
            const boundaryOffset = boundaryOffsets[boundarySeed % boundaryOffsets.length] as number;
            expect(
              reduceSignature(stdout.slice(0, boundaryOffset), nonce, moduleInterface),
            ).toBeNull();

            // Mutilation 3: drop the end marker line entirely.
            const withoutEndMarker = lines.slice(0, -1).join('\n');
            expect(reduceSignature(withoutEndMarker, nonce, moduleInterface)).toBeNull();

            // Mutilation 4: keep the end marker but shift its count by a non-zero delta.
            const endLine = lines[lines.length - 1] as string;
            const [keyword, endNonce, countToken] = endLine.split(' ');
            const shiftedCount = Number(countToken) + countDelta;
            const mutatedEndLine = [keyword, endNonce, String(shiftedCount)].join(' ');
            const withShiftedCount = [...lines.slice(0, -1), mutatedEndLine].join('\n');
            expect(reduceSignature(withShiftedCount, nonce, moduleInterface)).toBeNull();
          },
        ),
        propertyParameters(),
      );
    },
  );
});
