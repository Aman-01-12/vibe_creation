// Model-input assembly for the Testbench_Agent (Req 7.1-7.6).
//
// This is where the anti-circular guarantee becomes concrete at the model seam:
// `buildTestbenchModelInput` builds the entire `ModelRequest` from a
// `TestbenchGenerationInput` and the derived required checks ONLY. Its parameter
// list has no channel for RTL, and every string it interpolates comes from the
// Spec, the intent summary, or OKF passages. Property 4 (task 13.4) serializes the
// output of this function and asserts it contains none of the generated RTL.
//
// The prompt instructs the model to compute expected values independently from the
// Spec (never from an implementation) and to emit one `CHECK <name> PASS|FAIL` line
// per required check, using the exact names this module was given.
//
// The signalling sentences here restate what the oracle reader
// (`@app/tools` `readCheckSignals`) actually guarantees - the status is a complete
// token, a trailing reason is allowed, and a check that prints nothing is not a
// pass - so the prompt and the parser cannot disagree. The reader remains the
// guarantee: this is belt and braces, because a prompt is advice a model may ignore.
//
// Five rules here exist because each one, when broken, produces a testbench that
// rejects the KNOWN-GOOD reference design - an instrument that measures nothing:
//
//   - Expected values must be COMPUTED at simulation time from the driven stimulus.
//     A literal the model worked out by hand while writing the code makes the check
//     test that hand calculation instead of the design.
//   - State anchoring must not re-anchor to a state the declared interface cannot
//     reach (typically an assumed zero on a module with no reset port).
//   - Concurrency is the MENTAL MODEL the three timing rules all depend on: a design
//     is a concurrent machine observed, not a sequential program stepped. The two
//     rules below say WHICH moment may be sampled and WHICH inputs form one result;
//     this one says why a testbench that steps its own copy of the design forward
//     cannot answer either question. It is the rule that stops the defect re-entering
//     as a "wrong expected value" with no timing word anywhere in the failure line.
//   - Timing must not assume a latency, pipeline depth, or valid cycle the Spec
//     never stated; many events settle on one clock edge, so an assumed cycle
//     offset rejects a correct design. That governs the OUTPUT side.
//   - Input windows must not assume the edge on which a data input is sampled. The
//     same defect one step earlier: where the Spec does not pin the sampling moment,
//     which of the driven inputs form one result is unstated, and a testbench that
//     picks a window asserts an input-side timing of its own.
//
// A sixth rule is here for the opposite failure. A testbench can pass the reference
// design and still measure nothing, by driving only values at which a broken design
// and a correct one agree. The stimulus-adequacy rule requires stimulus that can
// tell them apart. It is stated at the altitude of what a check must DISTINGUISH,
// never as a list of the defect classes the negative control injects: naming those
// would teach the instrument the shape of its own exam, which is the circularity
// this whole role exists to avoid.
//
// A seventh rule is upstream of all of them: the dialect rule. The six above assume
// the testbench RUNS. A quarter of the measured instrument-invalid samples never
// compiled, because the model wrote SystemVerilog into a file the oracle compiles as
// Verilog-2001. That is not a style preference; it is a fact about the toolchain, and
// it is stated as one.
//
// The anchoring, timing, input-window, and stimulus-adequacy rules are all
// conditioned on the DECLARED interface, so the model is never told to reason about
// a control this module does not have. The expected-value, concurrency, and dialect
// rules depend on no interface detail and are therefore unconditional constants. See
// the vault notes
// `gotcha-generated-testbench-assumes-a-reset-that-does-not-exist`,
// `gotcha-three-testbench-defect-classes-that-fail-the-reference-design`, and
// `gotcha-stage1-screen-v2-dialect-and-concurrency-are-the-two-instrument-defects`.

import type { ModelRequest } from '../../model-router/index.js';
import type { RepairHint } from '../../orchestrator/repair-hint.js';

import type { KnowledgePassage } from '@app/knowledge';
import type { ClockingContract, ModuleInterface, PortDirection, Spec } from '@app/core';

import { CHECK_KEYWORD } from './signalling.js';
import type {
  RepairTestbenchModelInput,
  RequiredCheck,
  TestbenchGenerationInput,
} from './types.js';

/** Longest OKF passage excerpt included as a hint, to bound the prompt size. */
const MAX_PASSAGE_CHARS = 800;

/**
 * Single-bit port names that a design uses to qualify when data is accepted or ready.
 *
 * ONE keyword set serves both halves of a handshake, because a design names both
 * halves from the same vocabulary (`valid_in` / `valid_out`, `ready` / `ack`). A
 * testbench may derive its timing from an OUTPUT qualifier instead of counting
 * cycles, and its input windows from an INPUT one, which are the only two moments
 * the Spec is not required to state. Lowercase substring matches against declared
 * port names; nothing here is inferred from RTL.
 */
const HANDSHAKE_QUALIFIER_KEYWORDS: readonly string[] = [
  'valid',
  'ready',
  'done',
  'ack',
  'busy',
  'complete',
];

/**
 * The compute-never-precompute rule for expected values.
 *
 * Unconditional, because it depends on no interface detail: a hand-computed literal
 * is wrong for any design whose expected value the model cannot evaluate reliably in
 * its head, and a Verilog expression over the driven stimulus is both correct and
 * idiomatic. Stated over any arithmetic or bit-manipulation result rather than over
 * one operator, so it does not read as a special case.
 */
const EXPECTED_VALUE_RULE = [
  'Expected values: COMPUTE each one in the testbench, as a Verilog expression over',
  'the same stimulus you drive (for example `expected_sum = a + b + cin;`), and',
  'compare the output against that. Do NOT write in a constant you worked out by',
  'hand while composing the testbench: for any arithmetic or bit-manipulation result',
  'the check then tests your own hand calculation rather than the design.',
].join('\n');

/**
 * The Verilog-2001 declaration and dialect rule.
 *
 * Unconditional, because the dialect is a property of the TOOLCHAIN and not of any
 * one interface: the oracle compiles the testbench as Verilog-2001 with Icarus
 * Verilog, so a SystemVerilog idiom is a compile error for every design. This is the
 * only rule here that fires BEFORE simulation - the other six presuppose a testbench
 * that built - and it is the single largest measured cause of a non-building one.
 *
 * Stated as a fact about the compiler rather than as a style constraint, and pinned
 * to the exact constructs the measurement actually caught (a declaration inside a
 * procedural block or after an executable statement, a declaration with an initial
 * value, an SV type keyword, an array-with-initializer, and a misplaced sign on a
 * signed literal) rather than as a general "write portable Verilog", which a model
 * can agree with and still violate line by line.
 */
const DIALECT_RULE = [
  'Dialect: the testbench is compiled as Verilog-2001 by Icarus Verilog, which REJECTS',
  'SystemVerilog constructs - a testbench that does not compile measures nothing.',
  '  - Declare EVERY `reg`, `integer`, and array at MODULE scope, before the first',
  '    `initial` or `always` block - never inside a procedural block, and never after an',
  '    executable statement.',
  '  - Give no declaration an initial value: write `reg [3:0] count;` at module scope and',
  '    assign it inside an `initial` block, never `reg [3:0] count = 0;`.',
  '  - Use `reg` and `wire` only; `logic`, `bit`, and every other SystemVerilog type is',
  '    rejected.',
  '  - There is no array-with-initializer syntax; assign array elements inside an',
  '    `initial` block.',
  "  - Write a signed literal with the sign in front: `-9'sd1`, never `9'sd-1`.",
].join('\n');

/**
 * The RTL concurrency rule: a design is observed, not stepped.
 *
 * Unconditional, and deliberately a different KIND of rule from `describeTiming`.
 * `describeTiming` and `describeInputWindow` answer WHICH moment may be sampled and
 * WHICH inputs form one result; both are answers a model can follow to the letter and
 * still get wrong, because they do not touch the belief underneath. This rule states
 * the belief: hardware resolves many things at once on one edge, and an LLM trained on
 * sequential imperative code reasons about it as a program it steps.
 *
 * Every measured sub-symptom is that one error wearing a different disguise - a
 * post-reset value off by one instant, a shadow pipeline array indexed at a stage the
 * testbench chose, a shadow state machine carrying its own phase, a chosen timeout
 * bound. The failure lines mostly read `expected X, got Y` with no timing word in them
 * at all, which is why two earlier prompt attempts at this class each saw it re-enter
 * looking like a value bug. So the rule is aimed at the model, not at the moment.
 *
 * It composes with `describeStateAnchoring` rather than contradicting it. That rule
 * permits carrying an expected value forward from a phase boundary or deriving it from
 * the OBSERVED outputs; both are anchored in observation. What this rule forbids is
 * re-deriving the design's own state transition and stepping it, which is anchored in
 * nothing. The cross-reference is stated in the prompt text so the two cannot be read
 * as a conflict.
 */
const CONCURRENCY_RULE = [
  'Concurrency: a design is a CONCURRENT machine you OBSERVE, not a sequential program',
  'you step. At one active clock edge every register updates at once, so a reset',
  'deassertion and the first state update can resolve on the SAME edge - "reset ends,',
  'THEN the behaviour starts" is wrong, and it rejects a correct design.',
  'Do NOT build a second implementation of the design inside the testbench: no shadow',
  'pipeline, no shadow state machine, no array you shift yourself to model latency, no',
  "expected state you re-derive from the design's own transition and carry across clock",
  'edges. (Carrying forward a value you OBSERVED, as the state-anchoring rule above',
  'allows, is not that: what is forbidden is modelling the transition yourself.) A',
  'disagreement between your model and the design is a disagreement between two',
  'implementations, and yours is the unverified one.',
  'Sample an output only in the SETTLED part of a clock period - after the active edge',
  'has completed its nonblocking updates, at the opposite edge or after an explicit delay',
  'past it - never in the same instant as the edge. Compute an expectation with blocking',
  'assignments only over values you have ALREADY observed, never over values the design',
  'is updating in the same time step.',
].join('\n');

/**
 * Render the reset as its port name and polarity, or `none` when there is no reset.
 *
 * Shared by the interface rendering and the state-anchoring rule so the prompt
 * cannot describe an interface as reset-free in one place and name a reset port in
 * the other.
 */
function describeReset(clocking: ClockingContract): string {
  return clocking.resetName === null
    ? 'none'
    : `${clocking.resetName} (${clocking.resetActiveLow ? 'active-low' : 'active-high'})`;
}

/** Render the module interface as a compact, unambiguous port list. */
function describeInterface(spec: Spec): string {
  const ports = spec.moduleInterface.ports
    .map((port) => `  - ${port.name}: ${port.direction} [${port.width}]`)
    .join('\n');
  const clocking = spec.moduleInterface.clocking;
  const clock = clocking.clockName ?? 'none (combinational)';
  return [
    `Module: ${spec.moduleInterface.moduleName}`,
    'Ports:',
    ports,
    `Clock: ${clock}`,
    `Reset: ${describeReset(clocking)}`,
  ].join('\n');
}

/**
 * The state-anchoring rule, conditioned on whether the interface declares a reset.
 *
 * A phase-structured testbench that re-anchors its expected value to a state the
 * declared interface cannot reach fails EVERY design, including a correct one, so
 * the anchors that are actually reachable are named rather than left to inference.
 * The reset-free sentence is emitted only when there is genuinely no reset port, so
 * the model is never told to reason about a control this module does not have.
 */
function describeStateAnchoring(clocking: ClockingContract): string {
  const reachableAnchors =
    clocking.resetName === null
      ? [
          'This interface declares NO reset, so once your own stimulus has run there is',
          'nothing you can drive that returns the design to a known state; assuming a zero',
          'or default state mid-simulation fails every design, including a correct one.',
        ]
      : [
          'The only states you may assume outright are time 0 and the state reached by',
          `asserting ${describeReset(clocking)}.`,
        ];
  return [
    'State anchoring: do NOT re-anchor an expected value to a state the declared',
    'interface cannot reach. At each stimulus phase boundary, either carry the expected',
    'value forward from the previous phase, or derive it from the OBSERVED outputs at',
    'that boundary.',
    ...reachableAnchors,
  ].join('\n');
}

/**
 * The declared single-bit handshake qualifiers of one direction.
 *
 * Read from the interface the Spec declares, so the prompt can only ever name a
 * qualifier this module genuinely has. The declared clock and reset are excluded
 * through the clocking contract rather than by name guessing: they are control, not
 * a handshake, and a testbench waiting on one of them would be counting cycles under
 * another name.
 */
function handshakeQualifierNames(
  moduleInterface: ModuleInterface,
  direction: PortDirection,
): readonly string[] {
  const { clockName, resetName } = moduleInterface.clocking;
  return moduleInterface.ports
    .filter(
      (port) =>
        port.direction === direction &&
        port.width === 1 &&
        port.name !== clockName &&
        port.name !== resetName &&
        HANDSHAKE_QUALIFIER_KEYWORDS.some((keyword) => port.name.toLowerCase().includes(keyword)),
    )
    .map((port) => port.name);
}

/**
 * The declared single-bit outputs a testbench may legally wait on for timing.
 */
export function timingQualifierNames(moduleInterface: ModuleInterface): readonly string[] {
  return handshakeQualifierNames(moduleInterface, 'output');
}

/**
 * The declared single-bit inputs that tell a design when to accept its data inputs.
 *
 * The input-side peer of `timingQualifierNames`, and the only signal from which a
 * testbench may legally derive which of the inputs it drove belong to one result.
 */
export function inputQualifierNames(moduleInterface: ModuleInterface): readonly string[] {
  return handshakeQualifierNames(moduleInterface, 'input');
}

/**
 * The timing rule, conditioned on whether the interface declares a ready qualifier.
 *
 * An assumed latency, pipeline depth, or valid cycle that the Spec never stated
 * fails a correct design as readily as a wrong expected value, so the legal way to
 * decide WHEN to sample is named rather than left to inference.
 *
 * It composes with the two rules above rather than restating them. State anchoring
 * governs WHICH state an expected value may be anchored to; this governs WHEN an
 * output may be read. And it carves the one exception out of the expected-value
 * rule: where the interface declares a qualifier, that qualifier is an observation
 * to wait on, not a value to compute an expectation for - predicting it per cycle is
 * how an unstated latency re-enters as an "expected value".
 */
function describeTiming(moduleInterface: ModuleInterface): string {
  const qualifiers = timingQualifierNames(moduleInterface);
  const legalDerivation =
    qualifiers.length === 0
      ? [
          'This interface declares no such qualifier, so sample an output only where the',
          'Spec itself pins the moment down, never at a cycle number you chose.',
        ]
      : [
          `Wait on the design's own ${qualifiers.join(' / ')} to tell you when a result`,
          'is ready, instead of counting cycles to it. Treat that signal as an OBSERVATION',
          'that gates your data check, never as an expected value you predict: unless the',
          'Spec pins the cycle it changes on, a per-cycle expectation for it asserts a',
          'latency of your own.',
        ];
  return [
    'Timing: the Spec is the only source of latency, pipeline depth, and the cycle on',
    'which an output becomes valid. Where it states none, do NOT assume one - many',
    'events settle on a single clock edge, so an assumed cycle offset rejects a',
    'correct design.',
    ...legalDerivation,
  ].join('\n');
}

/**
 * The input-window rule, conditioned on whether the interface declares an input
 * qualifier.
 *
 * The INPUT-side sibling of `describeTiming`, and the same defect one step earlier.
 * The Spec pins WHAT a design computes from its inputs, not the edge on which those
 * inputs are sampled, so which of the driven inputs belong to one result is unstated.
 * A testbench that picks a window is asserting an input-side timing of its own and
 * rejects a correct design exactly as an assumed output latency does - measured as
 * `expected data_out=0a0, got 040`, where the expectation summed four driven inputs
 * and the design had taken one.
 *
 * Exactly ONE derivation is offered, and it is stated over an input handshake rather
 * than over accumulation, because the same shape reaches any design that accepts data
 * under a qualifier.
 */
function describeInputWindow(moduleInterface: ModuleInterface): string {
  const qualifiers = inputQualifierNames(moduleInterface);
  const legalDerivation =
    qualifiers.length === 0
      ? [
          'This interface declares NO input qualifier, so treat several driven inputs as one',
          'result ONLY where the Spec pins the sampling moment. Otherwise drive one input,',
          'check the result it produces, and derive the next expectation from what you',
          'observed rather than from how many inputs you had sent.',
        ]
      : [
          `Accept one input per assertion of the design's own ${qualifiers.join(' / ')}: hold`,
          'each data input stable for the whole clock period in which you assert the qualifier,',
          'and build the expected result from the inputs YOU drove under an asserted qualifier -',
          'one contribution per assertion. Never from a count of cycles, and never from a window',
          'boundary you chose.',
        ];
  return [
    'Input windows: the Spec is the only source of the edge on which a data input is',
    "sampled. Where it pins none, do NOT decide on the design's behalf which of the inputs",
    'you drove belong to one result.',
    ...legalDerivation,
  ].join('\n');
}

/**
 * Whether the interface declares a data port wider than one bit.
 *
 * Data ports are derived from the clocking contract, the same way `standard-blocks.ts`
 * derives them, so "is there a vector to index" is answered by the declaration rather
 * than guessed from a name. A single-bit interface has no index to walk, and telling
 * the model to walk one would assert a structure the ports cannot justify.
 */
export function declaresVectorDataPort(moduleInterface: ModuleInterface): boolean {
  const { clockName, resetName } = moduleInterface.clocking;
  return moduleInterface.ports.some(
    (port) => port.name !== clockName && port.name !== resetName && port.width > 1,
  );
}

/**
 * The stimulus-adequacy rule: stimulus must be able to tell a wrong design from a
 * right one.
 *
 * The other four rules stop the testbench REJECTING a correct design. This one stops
 * it ACCEPTING a broken one, which is the failure that mints a false `Verified`. The
 * measured gaps were six defect classes the independent judge caught and ours did not,
 * and they were six faces of one weakness: the stimulus never reached a value at which
 * the broken design and the correct one differ.
 *
 * Stated at the altitude of what a check must DISTINGUISH, and deliberately NOT as the
 * list of defect classes the negative control injects. Naming those would teach the
 * instrument the shape of its own exam - a testbench written to beat a known mutation
 * list is no longer independent evidence about anything else, which is exactly the
 * circularity this role exists to avoid.
 *
 * Kept as prose rather than promoted into a derived `RequiredCheck` in `coverage.ts`,
 * because whether the model FOLLOWS the rule is a measurement over real samples that
 * a committed fixture pair cannot make: a fixture written to obey the rule shows the
 * rule is sufficient, never that prose was enough to obtain it.
 */
function describeStimulusAdequacy(moduleInterface: ModuleInterface): string {
  const rangeRules = [
    '  - drive the lowest and the highest value each declared port can carry, so a',
    '    boundary that sits one position off the specified one is reached rather than',
    '    stepped over;',
  ];
  if (declaresVectorDataPort(moduleInterface)) {
    rangeRules.push(
      '  - address the first and the last element of every declared vector, so an index or',
      '    a width that is off by one is exercised at the only two places it shows.',
    );
  }
  return [
    'Stimulus adequacy: for each required check, choose stimulus that a WRONG design',
    'would fail. A check that drives only values where a broken design and a correct one',
    'agree passes both, so it proves nothing. Derive the values from the declared ports',
    'and from what each acceptance criterion below asserts:',
    '  - drive both sides of every condition a criterion implies, so a condition that is',
    '    the wrong way round shows up as a wrong output rather than as an untaken path;',
    '  - compare each equality at the value itself and at both of its neighbours, so a',
    '    comparison relaxed to admit one more value is distinguishable from the one the',
    '    criterion states;',
    '  - choose operands that leave the result sensitive to the operation - not zero, not',
    '    equal, and unequal in a known direction - so a changed constant or a flipped',
    '    arithmetic sign moves the value you compare against;',
    ...rangeRules,
  ].join('\n');
}

/**
 * The output-contract instruction shared by first-draft generation and repair.
 *
 * Factored out so both prompts state the identical contract by construction
 * rather than by two hand-synchronized copies: the model returns a JSON object
 * with exactly one field, `"source"`, holding the complete Verilog testbench.
 */
const OUTPUT_CONTRACT_INSTRUCTION =
  'Return a JSON object with exactly one field: "source", whose value is the\n' +
  'complete Verilog testbench as a string. Return nothing else.';

/** Render each required check as a naming instruction traceable to its source. */
function describeRequiredChecks(checks: readonly RequiredCheck[]): string {
  return checks
    .map((check) => `  - ${CHECK_KEYWORD} ${check.name}: ${check.description}`)
    .join('\n');
}

/** Render OKF passages as clearly-labeled, size-bounded hints (never authority). */
function describeOkfHints(passages: readonly KnowledgePassage[]): string {
  if (passages.length === 0) {
    return 'No OKF hints were retrieved.';
  }
  return passages
    .map((passage) => `  - ${passage.title}: ${passage.content.slice(0, MAX_PASSAGE_CHARS)}`)
    .join('\n');
}

/**
 * The instruction block that pins the output contract, the independence rule, and
 * the expected-value, state-anchoring, concurrency, timing, input-window,
 * stimulus-adequacy, and dialect rules for the interface actually declared by the
 * Spec.
 *
 * Order is deliberate. The concurrency rule sits between state anchoring and the two
 * moment-choosing rules because it is the mental model those two rest on, and because
 * it cross-references the anchoring rule immediately above it. The dialect rule sits
 * last among the rules, next to the output contract, because it is the only one about
 * how the file must be WRITTEN rather than about what it must assert.
 */
function instructions(checks: readonly RequiredCheck[], moduleInterface: ModuleInterface): string {
  return [
    'You are the Testbench_Agent for a single Verilog module.',
    'You are given ONLY the approved Spec, the intent, and OKF hints. You are NOT',
    'given any implementation or RTL, and you must NOT assume one: compute every',
    'expected value independently from the Spec, never from an implementation.',
    '',
    'Write a self-checking Verilog testbench that instantiates the module by its',
    'interface, drives nominal stimulus AND boundary/error stimulus implied by the',
    'Spec, and verifies each acceptance criterion. Include the known-answer checks',
    'listed below for any standard block.',
    '',
    EXPECTED_VALUE_RULE,
    '',
    describeStateAnchoring(moduleInterface.clocking),
    '',
    CONCURRENCY_RULE,
    '',
    describeTiming(moduleInterface),
    '',
    describeInputWindow(moduleInterface),
    '',
    describeStimulusAdequacy(moduleInterface),
    '',
    DIALECT_RULE,
    '',
    'For EACH required check below, print exactly one line to standard output of',
    `the form "${CHECK_KEYWORD} <name> PASS" or "${CHECK_KEYWORD} <name> FAIL",`,
    'using the exact check name given. Use $finish when done. You may print other',
    'diagnostics freely; only these CHECK lines are read as the verdict.',
    'The verdict word is exactly PASS or FAIL, never PASSED or FAILURE. A reason may',
    'follow it on the same line ("FAIL: expected 8\'h00") or sit on its own line;',
    'both are read. Print every required check even when the run fails early: a',
    'check that prints nothing is not a pass.',
    '',
    'Required checks (emit every one, with its exact name):',
    describeRequiredChecks(checks),
    '',
    OUTPUT_CONTRACT_INSTRUCTION,
  ].join('\n');
}

/**
 * Assemble the complete model request for testbench generation (Req 7.1, 7.3-7.6).
 *
 * The request is built solely from the RTL-free `TestbenchGenerationInput` and the
 * derived required checks; there is no parameter through which RTL could enter.
 * This function is exported so Property 4 can serialize its output and assert the
 * RTL never appears in the model input.
 */
export function buildTestbenchModelInput(
  input: TestbenchGenerationInput,
  checks: readonly RequiredCheck[],
): ModelRequest {
  const prompt = [
    instructions(checks, input.spec.moduleInterface),
    '',
    'Intent summary:',
    input.intentSummary,
    '',
    'Spec goal:',
    input.spec.goal,
    '',
    'Constraints:',
    input.spec.constraints.map((constraint) => `  - ${constraint}`).join('\n'),
    '',
    'Module interface:',
    describeInterface(input.spec),
    '',
    'OKF hints (advisory only, never authority over correctness):',
    describeOkfHints(input.okfPassages),
  ].join('\n');
  return { prompt };
}

/**
 * Render a Repair_Hint as prompt text (Req 2.1, 2.2, 2.9).
 *
 * Includes the toolchain's own diagnostic text verbatim, under a clear label -
 * never a reference's observed value, a diff, or its source, none of which
 * this type can even carry (Req 2.4, 2.5, 2.6). Testbench-dialect-normalization
 * task 10.3 retired the two positive-control trigger points, so `RepairHint`
 * is now a single-member union and this function has no second branch; kept
 * as its own function (rather than inlined at the one call site) so a future
 * second hint kind is additive rather than a rewrite of its signature.
 *
 * Exported (testbench-repair-loop task 8.7) so `app/eval/artifact-sink.ts`'s
 * `EvalSampleArtifacts.repairHint` renders the identical text the model itself
 * was shown, rather than a second, independently-drifting rendering of the
 * same `RepairHint`.
 */
export function describeRepairHint(hint: RepairHint): string {
  return ['The testbench did not compile. Toolchain diagnostic:', hint.diagnostic].join('\n');
}

/**
 * The instruction block for a repair attempt: revise the given testbench so it
 * no longer exhibits the hinted failure, returning the same output contract a
 * first draft uses.
 *
 * Deliberately does not restate the five first-draft rules
 * (`describeStateAnchoring`, `describeTiming`, `describeInputWindow`,
 * `describeStimulusAdequacy`, `EXPECTED_VALUE_RULE`, `CONCURRENCY_RULE`,
 * `DIALECT_RULE`): the model already has a testbench that mostly satisfies
 * them, and restating all seven here would push the hint's specific,
 * measured signal off the altitude a repair call is for. The hint text above
 * cross-references the relevant rule by name; the model is not left without
 * it.
 */
function repairInstructions(hint: RepairHint): string {
  return [
    'You are the Testbench_Agent for a single Verilog module, revising a',
    'testbench you previously wrote for this Spec. You are given ONLY the',
    'approved Spec, your previous testbench source, and a hint about what',
    'failed. You are NOT given any implementation or RTL, and you must NOT',
    'assume one: compute every expected value independently from the Spec,',
    'never from an implementation.',
    '',
    describeRepairHint(hint),
    '',
    'Revise the testbench to fix this failure while continuing to instantiate',
    'the module by its interface, drive the same stimulus categories as',
    'before, and verify every acceptance criterion. Do not remove or rename',
    'any `CHECK <name>` line already present.',
    '',
    OUTPUT_CONTRACT_INSTRUCTION,
  ].join('\n');
}

/**
 * Assemble the complete model request for a testbench repair (Req 2.8, 2.9, 8.2).
 *
 * The request is built solely from the RTL-free `RepairTestbenchModelInput`;
 * there is no parameter through which RTL, or the reference design's observed
 * behaviour or source, could enter. Per the Testbench_Repair model input's
 * three-field discipline, OKF passages are never re-retrieved or re-included -
 * the model already has a testbench to revise rather than a blank page.
 */
export function buildRepairModelInput(input: RepairTestbenchModelInput): ModelRequest {
  const prompt = [
    repairInstructions(input.hint),
    '',
    'Spec goal:',
    input.spec.goal,
    '',
    'Constraints:',
    input.spec.constraints.map((constraint) => `  - ${constraint}`).join('\n'),
    '',
    'Module interface:',
    describeInterface(input.spec),
    '',
    'Previous testbench source (revise this):',
    input.previousSource,
  ].join('\n');
  return { prompt };
}
