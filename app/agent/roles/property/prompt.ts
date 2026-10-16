// Model-input assembly for the Property_Author (Req 6.8, 6.15, 6.16, 6.17).
//
// RTL-BLIND BY CONSTRUCTION, NOT BY INSTRUCTION. `buildPropertyModelInput` is a pure
// function of ONE `Spec`. Its parameter list has no channel a candidate design source
// could occupy, so the RTL-blindness is a fact about the signature rather than a
// sentence in the prompt a model could ignore - the same structural guarantee
// `buildTestbenchModelInput` already has, and the one Property 30 (task 9.3) extends
// over this role rather than restating in a parallel test. Every string interpolated
// below comes from the Spec's goal, constraints, declared interface, or acceptance
// criteria, and from nothing else.
//
// WHY THE NARROW DIALECT IS AN ADVANTAGE FOR GENERATION RATHER THAN A LIMITATION
//   This is stated here because a future editor who does not know it will widen the
//   dialect to "help" the model, and that would be a regression dressed as a feature.
//   The accepted set is small and REGULAR: there is no sequence algebra, and exactly
//   ONE way to write implication (`!a || b`). So there are no sampling semantics for a
//   model to choose wrongly - `|->` versus `|=>`, which cycle a `##N` lands on, where
//   a `throughout` begins - and the space in which it can go wrong is correspondingly
//   smaller than full SVA. And every rejected form fails at PARSE time: the validator
//   names the construct it refused, or Yosys refuses the wrapper. Contrast the
//   behavioural testbench this oracle exists to supplement, whose wrong expectation
//   compiles perfectly and then rejects a correct design - the 229-sample class
//   Requirement 6's evidence section records. A loud refusal costs one
//   `could-not-verify`; a silent wrong expectation costs a false verdict.
//
// WHY THE CLOCK IS NOT ASKED FOR
//   A clocked property's `clock` is taken from the Spec's own `ClockingContract` by
//   `property-agent.ts`, never from model text. The model is told as much below, so it
//   does not supply one. That removes a whole error class structurally rather than by
//   validation: a model cannot name a clock signal the interface does not declare if
//   it is never asked to name a clock at all.
//
// WHY THE PROMPT STATES A NARROWER FUNCTION SET THAN THE VALIDATOR ACCEPTS
//   The validator also admits `$countones` and `$anyconst`; this prompt deliberately
//   advertises only the six sampled-value functions task 9.1 names. The prompt is
//   therefore NARROWER than the validator and never wider, which is the only direction
//   that is safe: a form the prompt withholds is one the model will not reach for, and
//   a form the prompt invented would be refused downstream and cost a criterion.

import type { AcceptanceCriterion, Spec } from '@app/core';

import { expectedInterfacePorts } from '../generation/spec-view.js';
import type { ModelRequest } from '../../model-router/index.js';

/**
 * The target dialect, stated as the CLOSED accepted set and nothing wider (Req 6.1-6.5).
 *
 * Every clause is pinned to a MEASURED fact about Yosys 0.66 rather than to a style
 * preference: it has no SVA property parser at all, so each listed rejection is a parse
 * error the feasibility probe actually observed. The rejected list is spelled out rather
 * than summarized as "no SVA", because a model that agrees with "write simple
 * assertions" still reaches for `|->` on the next line.
 */
const DIALECT_RULE = [
  'Dialect: the accepted set below is CLOSED. Nothing wider is accepted, and a form',
  'outside it is REFUSED before it ever reaches the toolchain.',
  '  - A CLOCKED property becomes an immediate assertion inside a clocked `always`',
  '    block: `always @(posedge <clock>) if (<antecedent>) assert(<consequent>);`. Give',
  '    the antecedent and the consequent only; the clock is supplied for you from the',
  '    declared interface, so do not name one.',
  '  - A COMBINATIONAL property becomes an unclocked module-level',
  '    `assert property (<consequent>);` carrying no clocking event, so it takes no',
  '    antecedent at all.',
  '  - Write implication as `!a || b`. There is no other form, and that is the only',
  '    spelling the validator accepts.',
  '  - The only temporal functions are `$past`, `$rose`, `$fell`, `$stable`,',
  '    `$changed`, and `$initstate`. Use `$stable` only in a clocked property.',
  '  - Everything else is rejected: no `@` anywhere in an expression, no `|->`, no',
  '    `|=>`, no `##N`, no `throughout`, no `[*N]`, no `s_eventually`, no',
  '    `disable iff`, no `property ... endproperty`, no `default clocking`, and no',
  '    `$sampled`.',
  '  - Reference only the signal names listed under the module interface below, each by',
  '    its own name. A hierarchical path into the design (`dut.count`) is rejected,',
  '    because it silently binds to a fresh net instead of the one you meant.',
].join('\n');

/**
 * The report-unexpressed rule, and the reason it is the most important rule here.
 *
 * A weaker property emitted in place of one the dialect cannot express is EXACTLY the
 * property-strength failure Requirement 10 exists to catch, introduced deliberately: it
 * would be proved, the sample would read as verified, and the measurement would be of
 * something smaller than the criterion asked for. An omitted criterion is reported as
 * unexpressed and the sample falls back to the simulation gate, which is a worse result
 * than a real proof and a far better one than a false one.
 */
const UNEXPRESSED_RULE = [
  'Unexpressed criteria: if a criterion cannot be stated in the dialect above, OMIT it',
  'entirely. Do NOT emit a weaker, partial, or approximate property in its place. A',
  'property that asserts less than its criterion asked for still gets proved, and the',
  'proof then reports more confidence than was measured, which is worse than no',
  'property at all. Omitting the criterion is the CORRECT answer: it is recorded as',
  'unexpressed and the criterion is checked by the other gate instead.',
].join('\n');

/**
 * The output contract: one JSON object carrying one array.
 *
 * The model is NOT asked which criteria it could not express. That is derived by
 * ABSENCE in `property-agent.ts`, so a criterion cannot vanish because a model forgot
 * to list it in a second array (Req 6.15, 6.17).
 */
const OUTPUT_CONTRACT = [
  'Return a JSON object with exactly one field, "properties", whose value is an array',
  'of objects, each carrying exactly these fields:',
  '  - "criterionId": the id of the acceptance criterion this property is derived from,',
  '    copied EXACTLY from the list below;',
  '  - "kind": either "clocked" or "combinational";',
  '  - "antecedent": the gating condition of a clocked property, or null for an',
  '    unconditional clocked property and for every combinational property;',
  '  - "consequent": the expression asserted.',
  'Emit at most one property per criterion, and omit any criterion you cannot express.',
  'Return nothing else.',
].join('\n');

/**
 * Render the signal names an expression may reference.
 *
 * Reuses `expectedInterfacePorts` rather than re-deriving the flattening, because the
 * Spec keeps clock and reset in its `ClockingContract` while a Verilog header lists
 * them as ordinary width-1 inputs - and the Property_Wrapper connects exactly that
 * flattened set. `spec-view.ts` is the single owner of that rule for every prompt, and
 * a second owner here would let this prompt advertise a signal the wrapper does not
 * declare.
 */
function describeInterface(spec: Spec): string {
  const signals = expectedInterfacePorts(spec.moduleInterface)
    .map((port) => `  - ${port.name}: ${port.direction} [${port.width}]`)
    .join('\n');
  return [`Module: ${spec.moduleInterface.moduleName}`, 'Referenceable signals:', signals].join(
    '\n',
  );
}

/** Render each acceptance criterion with the id a property must name (Req 6.14). */
function describeCriteria(criteria: readonly AcceptanceCriterion[]): string {
  return criteria.map((criterion) => `  - ${criterion.id}: ${criterion.text}`).join('\n');
}

/**
 * The instruction block: the role, the dialect, the unexpressed rule, the contract.
 *
 * A CONSTANT rather than a function of the Spec, and that is worth naming: none of the
 * four rules is conditioned on the declared interface. The dialect is a fact about Yosys
 * 0.66, the implication form is a fact about the validator, the unexpressed rule is a
 * fact about what a weaker property costs, and the output contract is ours. Contrast
 * `roles/testbench/prompt.ts`, whose anchoring, timing, and input-window rules ARE
 * interface-conditioned, because each of them would otherwise tell a model to reason
 * about a control its module does not have.
 */
const INSTRUCTIONS = [
  'You are the Property_Author for a single Verilog module.',
  'You are given ONLY the approved Spec. You are NOT given any implementation or RTL,',
  'and you must NOT assume one: derive every property from the acceptance criteria',
  'below, never from an implementation.',
  '',
  'For each acceptance criterion you can express, write ONE formal property as a',
  "boolean expression over the module's own signals, and name the criterion it came",
  'from so the resulting verdict is attributable to a requirement.',
  '',
  DIALECT_RULE,
  '',
  UNEXPRESSED_RULE,
  '',
  OUTPUT_CONTRACT,
].join('\n');

/**
 * Assemble the complete model request for property derivation (Req 6.8, 6.15, 6.16).
 *
 * A pure function of the Spec alone: same Spec, same prompt, every time. Exported so
 * Property 30 (task 9.3) can serialize its output and assert no candidate design source
 * reached it - there is no parameter through which one could.
 */
export function buildPropertyModelInput(spec: Spec): ModelRequest {
  const prompt = [
    INSTRUCTIONS,
    '',
    'Spec goal:',
    spec.goal,
    '',
    'Constraints:',
    spec.constraints.map((constraint) => `  - ${constraint}`).join('\n'),
    '',
    'Module interface:',
    describeInterface(spec),
    '',
    'Acceptance criteria (name the id of the one each property is derived from):',
    describeCriteria(spec.acceptanceCriteria),
  ].join('\n');
  return { prompt };
}
