// Known-answer references for standard blocks (Req 7.5).
//
// WHERE the Spec describes a standard block with a known reference behavior, the
// Testbench_Agent includes known-answer checks derived from that reference (not
// from any implementation). This module detects a standard block from the Spec's
// module name, goal, and architecture text alone - never from RTL - and yields the
// reference-behavior checks the testbench must emit in addition to the
// criterion-derived checks.
//
// Detection is deterministic and conservative, and it takes TWO agreeing signals:
// a keyword in the Spec's prose, AND a declared interface that can actually carry
// the block's reference behavior. The prose alone is not enough, because a design
// is routinely described in terms of the primitive it is built from - "a 16-bit
// full adder" names the full adder while declaring 16-bit ports, and driving the
// 1-bit full-adder truth table onto those ports fails the reference design. A
// known-answer check that the declared ports cannot justify is therefore not
// emitted at all, and the criterion-derived coverage still stands on its own.

import type { ModuleInterface, Port, Spec } from '@app/core';

/** A recognized textbook block and the reference-behavior check it implies. */
export interface StandardBlockReference {
  /** The reference block name, for the prompt and the Trace summary. */
  readonly block: string;
  /** A whitespace-free known-answer check name emitted as `CHECK <name> PASS|FAIL`. */
  readonly checkName: string;
  /** What the known-answer check verifies against the reference behavior. */
  readonly description: string;
  /** Keywords that identify this block in Spec text (all lowercase). */
  readonly keywords: readonly string[];
  /**
   * Whether the reference behavior is a bit-level truth table, and so is defined
   * only over single-bit data ports.
   */
  readonly assumesSingleBitDataPorts: boolean;
  /** Whether the reference behavior is a sequence that needs a declared clock. */
  readonly assumesClockedSequence: boolean;
}

/**
 * The curated known-answer references for M1 standard blocks.
 *
 * Each entry names a single known-answer check derived from the block's reference
 * truth table or arithmetic identity, independent of any implementation, together
 * with the port semantics that reference behavior assumes. Both assumption fields
 * are required on every entry, so a new dimension of assumed semantics is a compile
 * error here rather than a silently-permissive default. Order is significant only
 * for deterministic detection (first match wins per block).
 */
const STANDARD_BLOCK_REFERENCES: readonly StandardBlockReference[] = [
  {
    block: 'full-adder',
    checkName: 'known_answer_full_adder_truth_table',
    description: 'sum and carry match the full-adder reference truth table for all a,b,cin',
    keywords: ['full adder', 'full_adder', 'fulladder'],
    assumesSingleBitDataPorts: true,
    assumesClockedSequence: false,
  },
  {
    block: 'half-adder',
    checkName: 'known_answer_half_adder_truth_table',
    description: 'sum and carry match the half-adder reference truth table for all a,b',
    keywords: ['half adder', 'half_adder', 'halfadder'],
    assumesSingleBitDataPorts: true,
    assumesClockedSequence: false,
  },
  {
    block: 'multiplexer',
    checkName: 'known_answer_mux_selects_reference_input',
    description: 'output equals the selected input for every select value per the mux reference',
    keywords: ['multiplexer', 'mux'],
    assumesSingleBitDataPorts: false,
    assumesClockedSequence: false,
  },
  {
    block: 'decoder',
    checkName: 'known_answer_decoder_one_hot',
    description: 'exactly the addressed output line is asserted per the decoder reference',
    keywords: ['decoder'],
    assumesSingleBitDataPorts: false,
    assumesClockedSequence: false,
  },
  {
    block: 'up-counter',
    checkName: 'known_answer_counter_increments',
    description: 'the count follows the reference increment sequence and wraps at its modulus',
    keywords: ['up counter', 'up-counter', 'counter'],
    assumesSingleBitDataPorts: false,
    assumesClockedSequence: true,
  },
  {
    block: 'shift-register',
    checkName: 'known_answer_shift_register_sequence',
    description: 'each clock shifts the reference bit pattern by exactly one position',
    keywords: ['shift register', 'shift_register'],
    assumesSingleBitDataPorts: false,
    assumesClockedSequence: true,
  },
];

/** The lowercase haystack a Spec contributes to standard-block detection. */
function specText(spec: Spec): string {
  return [spec.moduleInterface.moduleName, spec.goal, spec.architecture].join(' ').toLowerCase();
}

/**
 * The declared data ports: everything that is not the declared clock or reset.
 *
 * Derived from the clocking contract rather than from name guessing, so which
 * ports carry data is exactly what the Spec declared.
 */
function dataPorts(moduleInterface: ModuleInterface): readonly Port[] {
  const { clockName, resetName } = moduleInterface.clocking;
  return moduleInterface.ports.filter((port) => port.name !== clockName && port.name !== resetName);
}

/**
 * Whether the DECLARED interface can carry a block's reference behavior (Req 7.5).
 *
 * A bit-level truth table is only meaningful over single-bit data ports: applied to
 * a wider interface it asserts the wrong answer and fails every design, including
 * the reference. A clocked reference sequence cannot be stepped at all without a
 * declared clock. Either mismatch means the check is unjustifiable from the ports,
 * so it is dropped rather than emitted.
 */
function interfaceJustifies(
  reference: StandardBlockReference,
  moduleInterface: ModuleInterface,
): boolean {
  if (reference.assumesClockedSequence && moduleInterface.clocking.clockName === null) {
    return false;
  }
  if (!reference.assumesSingleBitDataPorts) {
    return true;
  }
  const data = dataPorts(moduleInterface);
  return data.length > 0 && data.every((port) => port.width === 1);
}

/**
 * Detect the standard blocks a Spec describes, if any (Req 7.5).
 *
 * Returns every reference whose keyword set is present in the Spec's module name,
 * goal, or architecture text AND whose assumed port semantics the declared
 * interface satisfies. Uses only Spec-derived text and the declared interface,
 * never RTL, preserving the anti-circular guarantee. Returns an empty list for a
 * non-standard design, and for a design whose prose names a primitive its ports
 * cannot carry.
 */
export function detectStandardBlocks(spec: Spec): readonly StandardBlockReference[] {
  const haystack = specText(spec);
  return STANDARD_BLOCK_REFERENCES.filter(
    (reference) =>
      reference.keywords.some((keyword) => haystack.includes(keyword)) &&
      interfaceJustifies(reference, spec.moduleInterface),
  );
}

/** Every standard-block reference but the up-counter, whose wrap point no width fixes (Q-03). */
export function detectGroundedStandardBlocks(spec: Spec): readonly StandardBlockReference[] {
  return detectStandardBlocks(spec).filter((reference) => reference.block !== 'up-counter');
}
