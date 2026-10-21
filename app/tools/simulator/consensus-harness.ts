// The Consensus_Harness renderer: the product-written top module that owns the clock, the
// Drive_Point, and the Sample_Point for a Consensus_Run (C6; Req 4.1, 4.2, 4.3, 4.4, 4.5, 4.6,
// 4.7, 4.8, 4.9, 5.2, 6.5, 6.6).
//
// THE CONSENSUS_HARNESS REPLACES `SIMULATION_HARNESS`, IT DOES NOT EXTEND IT
//
//   `simulation-harness.ts` is not edited by this file. The existing harness is deliberately an
//   uninstantiated second root module that reads nothing from the testbench, because there the
//   model-written testbench is the top module and owns its own clock. This harness inverts that
//   ownership: it IS the top module, it instantiates the Candidate_Design, and it owns the clock.
//   A module cannot be both uninstantiated and the instantiator, which is why the two cannot
//   merge.
//
// THE REFERENCE_MODEL IS FOUR FUNCTIONS, NOT A SECOND RTL MODULE
//
//   C7 has the model write exactly three `function automatic` bodies - `ece_reset_state`,
//   `ece_next_state`, and `ece_expect` - whose headers this harness renders. The fourth,
//   `ece_stimulus`, is rendered by this harness itself from the Declared_Interface and the
//   Role_Declaration alone (C4, C5), so the model never writes stimulus. A Verilog function cannot contain a delay control, an event
//   control, or `fork`, and cannot declare a port or instantiate anything, so every construct
//   Requirement 5 criterion 2 excludes is refused by the compiler rather than by a denylist. This
//   harness instantiates only the Candidate_Design; the Reference_Model's "state" is a harness-
//   owned register threaded between steps, which is what makes it callable with no clock of its
//   own. An EARLIER DRAFT of this file instantiated a second copy of the Candidate_Design's own
//   module under a `ece_reference` instance name, intending it to stand in for the Reference_
//   Model - a hand-verified `iverilog` run of that draft caught the real defect this causes: two
//   module instances sharing one port list drive every output wire from two sources at once,
//   a multi-driver conflict. That draft is NOT what is rendered below.
//
// WHAT CARRIES OVER FROM `renderSimulationHarness`
//
//   Four properties that make that renderer safe, unchanged in shape here: rendering from fixed
//   product text plus validated scalars, a version constant that moves whenever the text moves, a
//   hyphenated file path so no identifier-derived path can collide with it, and every number
//   validated through `requirePositiveSafeInteger` before it reaches a Verilog literal.
//
// WHY THIS RENDERER RETURNS A `Result`, WHICH IS THE ONE PLACE THE CONTRACT HAD TO GROW
//
//   `renderSimulationHarness` emits no identifier, so it only had to validate numbers. This
//   renderer interpolates the module name and every port name into Verilog text, and those names
//   arrive from a Spec built out of student and model text. So the renderer is the trust boundary
//   for identifiers reaching Verilog: a name that is not a bounded plain Verilog identifier
//   refuses the render, which refuses the Session - the same shape the sandbox seam already
//   applies to `FormalJobRequest.topModule` (`app/tools/sandbox/contract-schema.ts`). Nothing is
//   sanitized or rewritten, because a rewritten port name names a different port.
//
// `ConsensusHarnessRequest` HAS NO FIELD THAT CAN CARRY RTL, MODEL OUTPUT, OR SPEC PROSE
//
//   Requirement 4 criterion 7 is therefore structural rather than a convention: the request type
//   below carries only a `ModuleInterface`, a `TimingContract`, a nonce, and bounded scalars.
//
// WHY DRIVE, SAMPLE, AND THE SAMPLING EDGE ARE THREE STATEMENTS IN ONE PROCESS
//
//   The clocked form is ONE sequential process owning the clock, the Drive_Point, and the
//   Sample_Point in that order inside one iteration: drive every input, settle a half period minus
//   the skew, read every output and compare and emit one sample line, settle the skew, then raise
//   the clock, then lower it. Their relative order is fixed by the language rather than by
//   event-scheduling order among competing processes. No input can be written on the sampling
//   edge, because the only statement at that instant is the clock assignment. That removes the
//   race class the stimulus measurement found, where correct designs agreed under 100% of
//   combinational stimuli, 81% of clean clocked ones, and 69% of race-prone ones.
//
//   The combinational form is the same loop with the clock statements removed: drive, settle, then
//   read, which is a read strictly later than that step's Drive_Point. There is no Sampling_Edge,
//   so the counter advances one step per Stimulus_Scenario step.
//
// RESET AND THE TIMING CONTRACT
//
//   Reset is asserted and released by the harness using the declared name and polarity, with
//   release a whole number of cycles before step 0, so Sample_Point numbering starts from a
//   release the harness performed - which is why the prototype's reset-release inference is not
//   ported (6 of 456 holdout units had candidates disagreeing on release time, and that case
//   cannot arise here). The state starts from `ece_reset_state`, not from zero (Q-16).
//
//   `ece_expect(s, in)` is what the outputs show now (Q-15). Every port is compared against this
//   step's expectation; a `registered` port's is evaluated with an all-zero input so it cannot
//   depend on the input applied in the same cycle. That is a per-port rule, never a per-design
//   mode. Version 1 compared a registered port against the previous step's expectation, and 7 of
//   8 counter_12 pilot draws wrote the other convention (design-council.md).
//
// LINE SHAPES ARE EMITTED AS COMPLETE, SELF-CONTAINED `$display` CALLS
//
//   `$display` always terminates with a newline; `$write` does not. An early draft interleaved
//   `$write` and `$display` across the sample-line fields and produced a corrupted stream where
//   the end of one line ran into the start of the next - caught by a hand-verified `iverilog` run.
//   Every line below is therefore one `$display` call building its complete text (including every
//   output's hex value) from one format string and one argument list, never split across calls.
//
// THE NONCE CLOSES THE ONE FORGERY THE DESIGN HAS TO CLOSE
//
//   The model writes `function automatic` bodies, and Verilog permits `$display` inside a
//   function, so a model-written `$display("CHECK ... PASS")` would forge a pass. Every line the
//   harness emits therefore carries a per-run nonce the product generates: `CHECK <nonce>_<port>
//   PASS`, `ECE_SAMPLE <nonce> <step> <v0> <v1> ...`, and `ECE_SAMPLE_END <nonce> <count>`. The
//   Reference_Model is generated with no knowledge of the harness text and therefore no knowledge
//   of the nonce, so a forged line cannot carry it and task 2.1's reducer discards it. The nonce
//   reaches no value the DUT sees, so it does not break Requirement 4 criterion 9's determinism:
//   the only per-run variation in the emitted text is the nonce itself. Generating it spends no
//   model tokens (Requirement 15 criterion 6 is unaffected). Task 7.2 validates the nonce as its
//   own identifier-fragment trust boundary; this task already renders it into every line shape.
//
// SIZING THE SAMPLE_BUDGET FROM THE DECLARED PORT WIDTHS
//
//   A sample line is the nonce, the step, and one hex value per output port, so a 16-port
//   interface at 64 bits is roughly 300 bytes, and 2048 samples is roughly 600 KB - inside the
//   sandbox worker's 1,048,576-byte stdout retention (`MAX_CAPTURED_STDOUT_BYTES`,
//   `app/tools/sandbox/worker/src/tool_runner_worker/commands.py`) with room for the CHECK lines.
//   A wider interface needs a smaller budget, so `sizedSampleBudget` computes a budget from the
//   declared port widths and takes the smaller of that and the caller-requested `sampleBudget`.
//   This is a second, deliberately redundant mechanism: the reducer already treats a truncated
//   stream as an incomplete run rather than as a short one (Req 7.7), so this sizing is a bound on
//   a HEALTHY run, not the mechanism that catches an unhealthy one - two mechanisms, same answer.
//   The byte-per-sample estimate here is checked against the real worker cap by task 8.6's
//   integration test, since only the simulator settles what Icarus actually prints.
//
// COMPARE WITH `===`, THE FAIL-SAFE DIRECTION
//
//   Exactly as the existing `ece_check` does, so an `x` output reads FAIL rather than PASS.
//
// VERIFIED: the clocked single-output skeleton below (one Candidate_Design instance, the three
// function headers called with threaded state, one `$display` per complete line) was hand-built
// and run through a real `iverilog`+`vvp` pass with stub bodies before being encoded here,
// confirming it compiles and produces the three documented line shapes correctly ordered.

import {
  domainError,
  err,
  ok,
  type DomainError,
  type ModuleInterface,
  type Result,
  type TimingContract,
} from '@app/core';

import type { SourceFile } from '../sandbox/contract.js';

/** Moves whenever the harness text, the clock period, the skew, or the Sample_Budget moves. */
export const CONSENSUS_HARNESS_VERSION = 3;

/** A hyphenated path, so no identifier-derived RTL or testbench path can collide with it. */
export const CONSENSUS_HARNESS_PATH = 'ece-consensus-harness.v';

/** Clock period in ns; the Drive_Point sits a half period from the Sampling_Edge. */
export const CLOCK_PERIOD_NS = 10;

/** How far before the Sampling_Edge the Sample_Point sits, in ns. */
export const SAMPLE_SKEW_NS = 1;

/** The cap on Sample_Points per run, which bounds the stdout stream by construction. */
export const SAMPLE_BUDGET = 2048;

/** The closed Role_Vocabulary; no Spec, Session, reply, or sweep argument extends it (Req 1.2, 1.9). */
export const INPUT_ROLES = ['data', 'enable'] as const;

export type InputRole = (typeof INPUT_ROLES)[number];

export interface PortRole {
  readonly portName: string;
  readonly role: InputRole;
}

/**
 * A Total_Role_Declaration: one entry per input port of the Declared_Interface, in any order,
 * with no omission, no unknown port, and no duplicate (Req 1.3). An array, not a
 * `Record<string, InputRole>`: a JSON object silently collapses a repeated key to its last
 * value, so a reply naming one port twice would parse as a valid total declaration and
 * criterion 1.6 would be unenforceable. The array keeps the duplicate visible at the boundary,
 * which is where it has to be refused.
 */
export type RoleDeclaration = readonly PortRole[];

/** MEASURED: 79.2% kill rate at 20, against 70.8% at 40 and 54.2% never released (Req 2.7). */
export const ENABLE_FRAME_PERIOD = 20;

/**
 * Steps between mid-run reset assertions (Req 5.2, 5.3). UNMEASURED: chosen so a 2048-step run
 * exercises the reset branch 8 times while leaving roughly twelve clear multiply-length windows
 * between assertions, and so assertions do not alias onto the Enable_Frame_Period's release
 * (256 mod 20 = 16, so the mid-run assertions land on several different enable-frame phases
 * rather than all on one). The `accu` Reset_Branch_Disabled survivor count is this constant's
 * own falsifier: a survivor still alive means raise the frequency; a design's kill rate below
 * its own Degenerate_Constant_Control means lower it.
 */
export const RESET_FRAME_PERIOD = 256;

/**
 * The sandbox worker's stdout retention ceiling, mirrored from `MAX_CAPTURED_STDOUT_BYTES`
 * (`app/tools/sandbox/worker/src/tool_runner_worker/commands.py`). Not imported - the worker is a
 * separate Python process with no TypeScript module to import from - so this is a cross-language
 * constant kept in sync by the comment pointing each way, the same discipline the design's own
 * figure already cites against this exact value.
 */
const WORKER_STDOUT_RETENTION_BYTES = 1_048_576;

/**
 * A conservative upper estimate of one `ECE_SAMPLE` line's byte length for an interface whose
 * output ports sum to `outputBundleWidth` bits: the nonce plus the step plus one space-separated
 * hex value per output port, each hex value's digit count bounded by `ceil(width / 4)`. The CHECK
 * line(s) for the same step add roughly the same again, which `BYTES_PER_SAMPLE_LINE_MULTIPLIER`
 * accounts for as headroom rather than a second, separately-estimated figure.
 *
 * MEASURED (task 8.6, `consensus-sample-budget.integration.test.ts`): the widest retained RTLLM
 * corpus interface, `sub_64bit` at 65 output bits, printed 285,739 real stdout bytes over its
 * full 2048-sample run under real Icarus - 139.5 bytes/sample on average, well under the roughly
 * 300 bytes/line this estimate assumed. The estimate is a safe overestimate for this corpus, not
 * a tight one; it still has to hold for an interface this corpus does not contain.
 */
const BYTES_PER_SAMPLE_LINE_MULTIPLIER = 2;

/** Estimate one sample line's byte length for an output bundle of `outputBundleWidth` bits. */
function estimatedBytesPerSample(nonceLength: number, outputBundleWidth: number): number {
  const hexDigitsPerOutput = Math.ceil(outputBundleWidth / 4);
  // "ECE_SAMPLE " + nonce + " " + step digits (bounded generously at 10) + one space-prefixed hex
  // value run, then doubled for the CHECK line(s) the same step also emits.
  const sampleLineBytes = 'ECE_SAMPLE '.length + nonceLength + 1 + 10 + 1 + hexDigitsPerOutput;
  return sampleLineBytes * BYTES_PER_SAMPLE_LINE_MULTIPLIER;
}

/**
 * Size the Sample_Budget from the declared port widths, taking the smaller of the computed cap
 * and `requestedSampleBudget` (Req 7.7, 15.4). Always at least 1, so no interface renders a loop
 * that never samples.
 */
export function sizedSampleBudget(
  nonceLength: number,
  outputBundleWidth: number,
  requestedSampleBudget: number,
): number {
  const bytesPerSample = estimatedBytesPerSample(nonceLength, outputBundleWidth);
  const widthBoundedBudget = Math.floor(WORKER_STDOUT_RETENTION_BYTES / bytesPerSample);
  return Math.max(1, Math.min(requestedSampleBudget, widthBoundedBudget));
}

/** The root module's name. */
const CONSENSUS_HARNESS_MODULE = 'ece_consensus_harness';

/** The Candidate_Design's instance name under judgment. */
const CANDIDATE_INSTANCE_NAME = 'ece_candidate';

/** The number of reset cycles the harness holds reset asserted for, before step 0 (Req 4.5). */
const RESET_CYCLES = 2;

/** The product-fixed width of the Reference_Model's threaded state register (C7). */
const REFERENCE_MODEL_STATE_WIDTH = 128;

/** Reference_Model function headers (C7); the model supplies only the bodies. */
export const ECE_STATE_W = REFERENCE_MODEL_STATE_WIDTH;

/** Sum of a port list's widths, at least 1 bit (matches the renderer's own bundle sizing). */
function bundleWidth(ports: readonly { readonly width: number }[]): number {
  return Math.max(
    1,
    ports.reduce((sum, port) => sum + port.width, 0),
  );
}

/**
 * The three Reference_Model function headers for `moduleInterface`'s packed bundles (C7). The
 * `ece_stimulus` header is no longer one of them: the renderer below computes it inline, since
 * the Stimulus_Function is now harness text rather than a header the model's body fills (C4, C5).
 */
export function referenceModelFunctionHeaders(moduleInterface: ModuleInterface): {
  readonly resetState: string;
  readonly nextState: string;
  readonly expect: string;
} {
  const inW = bundleWidth(moduleInterface.ports.filter((port) => port.direction === 'input'));
  const expW = bundleWidth(moduleInterface.ports.filter((port) => port.direction === 'output'));
  const stateW = ECE_STATE_W;
  return {
    // `dummy` only because a Verilog-2001 function must declare at least one input.
    resetState: `function automatic [${String(stateW - 1)}:0] ece_reset_state(input dummy);`,
    nextState:
      `function automatic [${String(stateW - 1)}:0] ece_next_state` +
      `(input [${String(stateW - 1)}:0] s, input [${String(inW - 1)}:0] in);`,
    expect:
      `function automatic [${String(expW - 1)}:0] ece_expect` +
      `(input [${String(stateW - 1)}:0] s, input [${String(inW - 1)}:0] in);`,
  };
}

/** The three printed line shapes, exported so a reader (the signature reducer) owns one source. */
export const CHECK_REPORT_PASS_FORMAT = 'CHECK %0s PASS' as const;
export const CHECK_REPORT_FAIL_FORMAT = 'CHECK %0s FAIL' as const;
export const SAMPLE_LINE_PREFIX = 'ECE_SAMPLE' as const;
export const SAMPLE_END_PREFIX = 'ECE_SAMPLE_END' as const;

/** A bounded plain Verilog identifier: the same form and ceiling `FormalJobRequest.topModule` already holds a name to. */
const VERILOG_IDENTIFIER_PATTERN = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const MAX_IDENTIFIER_LENGTH = 128;

/**
 * Reserved words that would be syntactically invalid as a module or port name even though they
 * match the identifier pattern. Not exhaustive of every SystemVerilog-2017 keyword; the common
 * core a refusal test can exercise.
 */
const VERILOG_KEYWORDS: ReadonlySet<string> = new Set([
  'always',
  'and',
  'assign',
  'automatic',
  'begin',
  'buf',
  'bufif0',
  'bufif1',
  'case',
  'casex',
  'casez',
  'cell',
  'cmos',
  'config',
  'deassign',
  'default',
  'defparam',
  'design',
  'disable',
  'edge',
  'else',
  'end',
  'endcase',
  'endconfig',
  'endfunction',
  'endgenerate',
  'endmodule',
  'endprimitive',
  'endspecify',
  'endtable',
  'endtask',
  'event',
  'for',
  'force',
  'forever',
  'fork',
  'function',
  'generate',
  'genvar',
  'highz0',
  'highz1',
  'if',
  'ifnone',
  'incdir',
  'include',
  'initial',
  'inout',
  'input',
  'instance',
  'integer',
  'join',
  'liblist',
  'library',
  'localparam',
  'macromodule',
  'module',
  'nand',
  'negedge',
  'nmos',
  'nor',
  'noshowcancelled',
  'not',
  'notif0',
  'notif1',
  'or',
  'output',
  'parameter',
  'pmos',
  'posedge',
  'primitive',
  'pull0',
  'pull1',
  'pulldown',
  'pullup',
  'pulsestyle_ondetect',
  'pulsestyle_onevent',
  'rcmos',
  'real',
  'realtime',
  'reg',
  'release',
  'repeat',
  'rnmos',
  'rpmos',
  'rtran',
  'rtranif0',
  'rtranif1',
  'scalared',
  'showcancelled',
  'signed',
  'specify',
  'specparam',
  'strong0',
  'strong1',
  'supply0',
  'supply1',
  'table',
  'task',
  'time',
  'tran',
  'tranif0',
  'tranif1',
  'tri',
  'tri0',
  'tri1',
  'triand',
  'trior',
  'trireg',
  'unsigned',
  'use',
  'vectored',
  'wait',
  'wand',
  'weak0',
  'weak1',
  'while',
  'wire',
  'wor',
  'xnor',
  'xor',
]);

/** One Consensus_Run's harness request; carries no RTL, model output, or Spec prose (Req 4.7). */
export interface ConsensusHarnessRequest {
  readonly moduleInterface: ModuleInterface;
  readonly timingContract: TimingContract;
  /** Per-run nonce prefixing every harness-emitted line; validated as its own boundary by task 7.2. */
  readonly nonce: string;
  readonly watchdogBudgetNs: number;
  readonly sampleBudget: number;
  /** Total over the Declared_Interface's input ports; refused otherwise (Req 2.1). */
  readonly roles: RoleDeclaration;
}

/** Refuse a value that would reach Verilog text as anything but a positive integer literal. */
function requirePositiveSafeInteger(
  fieldLabel: string,
  value: number,
  max: number,
): DomainError | null {
  if (!Number.isSafeInteger(value) || value <= 0 || value > max) {
    return domainError(
      'INVALID_VERILOG_IDENTIFIER',
      `${fieldLabel} must be a positive safe integer no greater than ${String(max)}`,
      fieldLabel,
    );
  }
  return null;
}

/** Refuse `name` unless it is a bounded plain Verilog identifier that is not a reserved keyword. */
function requireVerilogIdentifier(fieldLabel: string, name: string): DomainError | null {
  if (
    name.length === 0 ||
    name.length > MAX_IDENTIFIER_LENGTH ||
    !VERILOG_IDENTIFIER_PATTERN.test(name)
  ) {
    return domainError(
      'INVALID_VERILOG_IDENTIFIER',
      `${fieldLabel} must be a plain Verilog identifier of at most ${String(MAX_IDENTIFIER_LENGTH)} characters`,
      fieldLabel,
    );
  }
  if (VERILOG_KEYWORDS.has(name.toLowerCase())) {
    return domainError(
      'RESERVED_VERILOG_KEYWORD',
      `${fieldLabel} must not be a reserved Verilog keyword: "${name}"`,
      fieldLabel,
    );
  }
  return null;
}

/** Validate every identifier `request` interpolates into Verilog text, in a fixed check order. */
function validateIdentifiers(request: ConsensusHarnessRequest): DomainError | null {
  const { moduleInterface, nonce } = request;
  const moduleNameError = requireVerilogIdentifier(
    'moduleInterface.moduleName',
    moduleInterface.moduleName,
  );
  if (moduleNameError !== null) {
    return moduleNameError;
  }
  const nonceError = requireVerilogIdentifier('nonce', nonce);
  if (nonceError !== null) {
    return nonceError;
  }
  for (const port of moduleInterface.ports) {
    const portError = requireVerilogIdentifier(`port "${port.name}"`, port.name);
    if (portError !== null) {
      return portError;
    }
  }
  const { clockName, resetName } = moduleInterface.clocking;
  if (clockName !== null) {
    const clockError = requireVerilogIdentifier('moduleInterface.clocking.clockName', clockName);
    if (clockError !== null) {
      return clockError;
    }
  }
  if (resetName !== null) {
    const resetError = requireVerilogIdentifier('moduleInterface.clocking.resetName', resetName);
    if (resetError !== null) {
      return resetError;
    }
  }
  const portNames = moduleInterface.ports.map((port) => port.name);
  if (new Set(portNames).size !== portNames.length) {
    return domainError(
      'DUPLICATE_PORT_NAME',
      'ModuleInterface declares the same port name more than once',
      'moduleInterface.ports',
    );
  }
  return null;
}

/** Declare one port as a Verilog wire at its declared width. */
function wireDeclarationLine(port: { readonly name: string; readonly width: number }): string {
  return port.width === 1
    ? `  wire ${port.name};`
    : `  wire [${String(port.width - 1)}:0] ${port.name};`;
}

/**
 * The port-connection list for the Candidate_Design instance: every declared data port, in
 * declared order, PLUS the clock and reset ports named by `ClockingContract` - which the module
 * itself declares as ports even though `ModuleInterface.ports` deliberately excludes them (the
 * corpus importer splits them out this same way; `app/eval/corpus/import.test.ts` asserts a
 * clock port is absent from the built `ports` list). Omitting them here would instantiate the
 * Candidate_Design with its clock and reset ports left unconnected.
 */
function portConnectionsOf(
  ports: readonly { readonly name: string }[],
  clockName: string | null,
  resetName: string | null,
): string {
  const dataConnections = ports.map((port) => `.${port.name}(${port.name})`);
  const clockConnection = clockName === null ? [] : [`.${clockName}(${clockName})`];
  const resetConnection = resetName === null ? [] : [`.${resetName}(${resetName})`];
  return [...clockConnection, ...resetConnection, ...dataConnections].join(', ');
}

/** Resolve `portName`'s Port_Timing from `timingContract`'s entries (total for a real `TimingContract`; `makeTimingContract` guarantees one entry per output port). */
function timingOf(
  timingContract: TimingContract,
  portName: string,
): 'registered' | 'combinational' | null {
  return timingContract.entries.find((entry) => entry.portName === portName)?.timing ?? null;
}

/** The packed-bundle slice `inputPorts[index]` occupies: the first declared port takes the lowest bits. */
function inputBundleSlice(
  inputPorts: readonly { readonly width: number }[],
  index: number,
): { high: number; low: number } {
  let high = inputPorts.slice(0, index + 1).reduce((sum, port) => sum + port.width, 0) - 1;
  const low = inputPorts.slice(0, index).reduce((sum, port) => sum + port.width, 0);
  // Guard against a zero-port call site; never reached when inputPorts is non-empty.
  high = Math.max(high, low);
  return { high, low };
}

/** Each port's slice of its packed bundle, in declared order; the one layout the harness renders. */
export function packedPortSlices(
  ports: readonly { readonly name: string; readonly width: number }[],
): readonly { readonly name: string; readonly high: number; readonly low: number }[] {
  return ports.map((port, index) => ({ name: port.name, ...inputBundleSlice(ports, index) }));
}

/**
 * Refuse `roles` unless it names every one of `inputPorts` exactly once, with no unknown port.
 * Re-checked here even though a parser upstream already checks it (C5): two mechanisms reaching
 * the same answer is the discipline this renderer already applies to the Sample_Budget. A silent
 * default for an unnamed port would turn an unnoticed parser regression into weaker stimulus in
 * every Session at once, so this refuses rather than defaults.
 */
function requireTotalRoleDeclaration(
  inputPorts: readonly { readonly name: string }[],
  roles: RoleDeclaration,
): DomainError | null {
  const declaredNames = roles.map((role) => role.portName);
  const inputNames = new Set(inputPorts.map((port) => port.name));
  const isTotal =
    declaredNames.length === inputNames.size &&
    new Set(declaredNames).size === declaredNames.length &&
    declaredNames.every((name) => inputNames.has(name));
  if (!isTotal) {
    return domainError(
      'INCOMPLETE_ROLE_DECLARATION',
      'roles must name every input port of moduleInterface exactly once, with no unknown port',
      'roles',
    );
  }
  return null;
}

/** `roles`'s role for `portName`, or `'data'` when `roles` carries no entry for it. */
function roleOf(roles: RoleDeclaration, portName: string): InputRole {
  return roles.find((role) => role.portName === portName)?.role ?? 'data';
}

/**
 * Render `ece_mix`, the Stimulus_Mixer: the splitmix64 finalizer applied to `{lane, step}` (Req
 * 2.12, 2.13). The statement sequence is verbatim from the probe that produced every splitmix
 * figure in the requirements, so it is copied rather than re-derived (C4).
 */
function renderStimulusMixer(): readonly string[] {
  return [
    '// Stimulus_Mixer: the splitmix64 finalizer (Req 2.12, 2.13). `lane` keys the 64-bit slice',
    '// of a bundle wider than 64 bits; lane 0 is the expression the probe measured.',
    'function automatic [63:0] ece_mix(input [31:0] lane, input [31:0] step);',
    '  reg [63:0] h;',
    '  begin',
    "    h = {lane, step} + 64'h9E3779B97F4A7C15;",
    '    h = h ^ (h >> 30);',
    "    h = h * 64'hBF58476D1CE4E5B9;",
    '    h = h ^ (h >> 27);',
    "    h = h * 64'h94D049BB133111EB;",
    '    h = h ^ (h >> 31);',
    '    ece_mix = h;',
    '  end',
    'endfunction',
  ];
}

/**
 * Render `ece_stimulus`, the Stimulus_Function, over `inputPorts` and `roles` (Req 2.1 through
 * 2.8, 2.11 through 2.14; C5). One lane assignment per 64 bits of the input bundle, then one
 * overwrite per `enable`-role port over its own `packedPortSlices` slice, then the return.
 */
function renderStimulusFunction(
  inputPorts: readonly { readonly name: string; readonly width: number }[],
  inputBundleWidth: number,
  roles: RoleDeclaration,
): readonly string[] {
  const lines: string[] = [
    '// Stimulus_Function: a pure function of step, rendered from the Declared_Interface and the',
    '// Role_Declaration alone (Req 2.1, 2.2, 2.4). Every bit is a Stimulus_Mixer bit unless an',
    '// enable-role port owns it.',
    `function automatic [${String(inputBundleWidth - 1)}:0] ece_stimulus(input [31:0] step);`,
    `  reg [${String(inputBundleWidth - 1)}:0] v;`,
    '  begin',
  ];
  const laneCount = Math.ceil(inputBundleWidth / 64);
  for (let lane = 0; lane < laneCount; lane += 1) {
    const low = lane * 64;
    const high = Math.min(inputBundleWidth, 64 * (lane + 1)) - 1;
    lines.push(`    v[${String(high)}:${String(low)}] = ece_mix(32'd${String(lane)}, step);`);
  }
  for (const { name, high, low } of packedPortSlices(inputPorts)) {
    if (roleOf(roles, name) !== 'enable') {
      continue;
    }
    const width = high - low + 1;
    // Req 2.6, 2.7: released one step in every ENABLE_FRAME_PERIOD, held asserted otherwise.
    lines.push(
      `    v[${String(high)}:${String(low)}] = {${String(width)}{(step % ${String(ENABLE_FRAME_PERIOD)}) != 0}};`,
    );
  }
  lines.push('    ece_stimulus = v;', '  end', 'endfunction');
  return lines;
}

/**
 * Render `ece_harness_reset`, the task asserting and releasing reset for RESET_CYCLES cycles,
 * zeroing `ece_in_bits` at the start of the interval (C6, Req 5.1, 5.7). A TASK, not a function,
 * because only a task may carry a delay control. Not one of the four Reference_Model names, so
 * the Authoring_Contract's `ece_*` assignment ban already refuses a model body that assigns it -
 * this task is module-scoped by design, since it is product text the model never authors and
 * never calls, unlike ece_reset_state/ece_next_state/ece_expect which resolve to the separate
 * Reference_Model file's compilation-unit-scope declarations and so must never be shadowed by a
 * same-named module-scoped declaration here.
 *
 * Driving `ece_in_bits` to zero at the start of every interval (including the one at step 0) is
 * a deliberate behaviour change from the version-2 harness, which left it at its Verilog-default
 * `x` before its first assignment: an `x` propagating into a register reset does not cover would
 * read FAIL for a reason that has nothing to do with the design under test. A register the
 * design never writes still reads `x` after this change and still correctly FAILs.
 */
function renderHarnessResetTask(
  inputBundleWidth: number,
  resetActiveLow: boolean,
): readonly string[] {
  return [
    '  task ece_harness_reset;',
    '    begin',
    `      ece_in_bits = {${String(inputBundleWidth)}{1'b0}};`,
    `      ece_reset_drive = ${resetActiveLow ? "1'b0" : "1'b1"};`,
    `      repeat (${String(RESET_CYCLES)}) begin`,
    "        #(ECE_PERIOD/2) ece_clk = 1'b1;",
    "        #(ECE_PERIOD/2) ece_clk = 1'b0;",
    '      end',
    `      ece_reset_drive = ${resetActiveLow ? "1'b1" : "1'b0"};`,
    '    end',
    '  endtask',
  ];
}

/**
 * Render the Consensus_Harness, validating every identifier and every scalar before any reaches
 * Verilog text (Req 4.1 through 4.9, 5.2, 6.5, 6.6).
 *
 * Pure and total: no file, network, clock, or random-source read, and refuses with a `DomainError`
 * rather than throwing on any invalid input. Two calls with the same `request` produce
 * byte-identical text (Req 4.8), since nothing here reads a clock or a random source.
 */
export function renderConsensusHarness(
  request: ConsensusHarnessRequest,
): Result<SourceFile, DomainError> {
  const { moduleInterface, timingContract, nonce, watchdogBudgetNs, sampleBudget, roles } = request;

  const scalarError =
    requirePositiveSafeInteger('watchdogBudgetNs', watchdogBudgetNs, Number.MAX_SAFE_INTEGER) ??
    requirePositiveSafeInteger('sampleBudget', sampleBudget, Number.MAX_SAFE_INTEGER);
  if (scalarError !== null) {
    return err(scalarError);
  }

  const identifierError = validateIdentifiers(request);
  if (identifierError !== null) {
    return err(identifierError);
  }

  const inputPorts = moduleInterface.ports.filter((port) => port.direction === 'input');
  const outputPorts = moduleInterface.ports.filter((port) => port.direction === 'output');

  const roleError = requireTotalRoleDeclaration(inputPorts, roles);
  if (roleError !== null) {
    return err(roleError);
  }
  for (const port of outputPorts) {
    if (timingOf(timingContract, port.name) === null) {
      return err(
        domainError(
          'MISSING_PORT_TIMING',
          `Timing_Contract carries no entry for declared output port "${port.name}"`,
          'timingContract.entries',
        ),
      );
    }
  }

  const validityName = moduleInterface.validityOutputName;
  if (validityName !== null && !outputPorts.some((port) => port.name === validityName)) {
    return err(
      domainError(
        'VALIDITY_OUTPUT_NOT_A_DECLARED_OUTPUT_PORT',
        'validityOutputName must name a declared output port',
        'moduleInterface.validityOutputName',
      ),
    );
  }
  const hasRegistered = outputPorts.some(
    (port) => timingOf(timingContract, port.name) === 'registered',
  );

  const { clockName, resetName, resetActiveLow } = moduleInterface.clocking;
  const isClocked = clockName !== null;
  const inputBundleWidth = Math.max(
    1,
    inputPorts.reduce((sum, port) => sum + port.width, 0),
  );
  const outputBundleWidth = Math.max(
    1,
    outputPorts.reduce((sum, port) => sum + port.width, 0),
  );
  // Req 7.7, 15.4: the rendered loop bound is the SMALLER of the caller's request and what this
  // interface's width allows inside the worker's stdout retention - never the raw request alone.
  const effectiveSampleBudget = sizedSampleBudget(nonce.length, outputBundleWidth, sampleBudget);

  const lines: string[] = [
    '`timescale 1ns/1ps',
    // Compilation-unit scope, ABOVE the module: a function declared INSIDE the module would
    // SHADOW the real Reference_Model body of the same name under `iverilog -g2012` with no
    // compile error, silently reading `x` on every CHECK line (see the module header below).
    // Rendering ece_mix/ece_stimulus here keeps that rule true for all four Reference_Model
    // names and turns a stray in-module redeclaration into a hard compile error instead.
    ...renderStimulusMixer(),
    ...renderStimulusFunction(inputPorts, inputBundleWidth, roles),
    '// Product-written Consensus_Harness: the top module, instantiating the Candidate_Design,',
    '// owning the clock, the Drive_Point, and the Sample_Point, and calling the Reference_Model',
    '// as four functions: ece_stimulus rendered above by this harness, the other three as',
    "// headers the model's bodies implement (C7).",
    `module ${CONSENSUS_HARNESS_MODULE};`,
    `  localparam [63:0] ECE_WATCHDOG_BUDGET_NS = 64'd${String(watchdogBudgetNs)};`,
    `  localparam integer ECE_SAMPLE_BUDGET = ${String(effectiveSampleBudget)};`,
    `  localparam integer ECE_PERIOD = ${String(CLOCK_PERIOD_NS)};`,
    `  localparam integer ECE_SKEW = ${String(SAMPLE_SKEW_NS)};`,
    // Req 5.8: no reset to assert on a no-reset or clockless interface, so no ECE_RESET_FRAME
    // localparam and no reset task are rendered at all - different rendered text, not a
    // conditional default.
    ...(resetName !== null && isClocked
      ? [`  localparam integer ECE_RESET_FRAME = ${String(RESET_FRAME_PERIOD)};`]
      : []),
    '  integer step;',
    `  reg [${String(REFERENCE_MODEL_STATE_WIDTH - 1)}:0] ece_state;`,
    `  reg [${String(inputBundleWidth - 1)}:0] ece_in_bits;`,
    `  reg [${String(outputBundleWidth - 1)}:0] ece_exp_bits;`,
    ...(hasRegistered ? [`  reg [${String(outputBundleWidth - 1)}:0] ece_exp_reg_bits;`] : []),
    ...moduleInterface.ports.map(wireDeclarationLine),
  ];

  if (clockName !== null) {
    lines.push(`  wire ${clockName};`);
    lines.push('  reg ece_clk;');
    lines.push(`  assign ${clockName} = ece_clk;`);
  }
  if (resetName !== null) {
    lines.push(`  wire ${resetName};`);
    lines.push('  reg ece_reset_drive;');
    lines.push(`  assign ${resetName} = ece_reset_drive;`);
    // A declared reset with no clock has no edge to assert-then-release across (Req 5.8), so
    // `renderHarnessResetTask` below never runs for this shape - leaving `ece_reset_drive`
    // undriven would default it to Verilog's `x`, corrupting the reset wire for the whole run
    // (confirmed: every CHECK line read FAIL from step 0, caught by a real iverilog run of this
    // exact shape, not by any text-only check). The released polarity is the only value that
    // keeps a clockless-but-reset-bearing interface's own combinational logic observable at all.
    if (!isClocked) {
      lines.push(`  initial ece_reset_drive = ${resetActiveLow ? "1'b1" : "1'b0"};`);
    }
  }

  // Pack the input bundle onto the harness's own wires, in declared input-port order.
  inputPorts.forEach((port, index) => {
    const { high, low } = inputBundleSlice(inputPorts, index);
    lines.push(`  assign ${port.name} = ece_in_bits[${String(high)}:${String(low)}];`);
  });

  // The reset task (C6), module-scoped: not one of the four Reference_Model names, so the
  // Authoring_Contract already refuses a model body assigning it. It references ece_clk and
  // ece_reset_drive, which are declared above only when BOTH a clock and a reset are declared -
  // `ClockingContract` carries no type-level guarantee that a reset implies a clock, so this is
  // checked explicitly rather than assumed from `resetName !== null` alone.
  if (resetName !== null && isClocked) {
    lines.push(...renderHarnessResetTask(inputBundleWidth, resetActiveLow));
  }

  // ONE instance only: the Candidate_Design under judgment. The Reference_Model is three
  // behavioral FUNCTIONS, not a second RTL module sharing this interface's ports - instantiating
  // a second copy of this same module would drive every output wire from two sources at once,
  // a multi-driver conflict a hand-verified iverilog run of an earlier draft caught (see header).
  lines.push(
    `  ${moduleInterface.moduleName} ${CANDIDATE_INSTANCE_NAME} ` +
      `(${portConnectionsOf(moduleInterface.ports, clockName, resetName)});`,
  );

  // THE MODULE DECLARES NONE OF THE FOUR REFERENCE_MODEL NAMES, AND MUST NEVER
  //
  //   MEASURED BUG (caught by task 8.4's real-toolchain integration test, not by any unit test):
  //   an earlier draft of this renderer declared empty `function automatic ... endfunction`
  //   stubs for ece_stimulus/ece_next_state/ece_expect INSIDE this module, intending them as
  //   "headers the model's body implements". That is wrong: Verilog scopes a function declared
  //   inside a module to that module, which SHADOWS the compilation-unit-scope function of the
  //   same name a separate file declares with its real body - so every call below silently
  //   resolved to the harness's own empty stub and read 'x' on every step. Real `iverilog
  //   -g2012` accepts this with NO error, because it is not a true duplicate declaration
  //   (different scopes), which is exactly why no compile-time check caught it. The fix: this
  //   module declares NOTHING named ece_reset_state/ece_stimulus/ece_next_state/ece_expect; it
  //   only CALLS them below. `ece_mix` and `ece_stimulus` are rendered above, at this same
  //   file's compilation-unit scope (ABOVE this module, not inside it); `ece_reset_state`,
  //   `ece_next_state`, and `ece_expect` resolve the same way to the Reference_Model workspace
  //   file's own compilation-unit-scope declarations.

  // The VCD waveform: never read anywhere downstream (C8's own stated design - the VCD bytes
  // are never read, only the stdout stream the sequential process below prints), but every
  // `simulate` sandbox job's REQUIRED-OUTPUT set is fixed and includes `vcd`
  // (`SIMULATE_REQUIRED_OUTPUTS` in `app/tools/simulator/adapter.ts`), so a run that never calls
  // `$dumpfile`/`$dumpvars` produces no waveform and the whole run classifies `error` for a
  // missing required output - caught only by a real end-to-end run through the actual sandbox
  // (task 8.4's integration test), since no unit test exercises the real required-output
  // enforcement. Mirrors `simulation-harness.ts`'s own separate dump `initial` block.
  lines.push(
    '  initial begin',
    '    $dumpfile("dump.vcd");',
    '    $dumpvars(0, ece_consensus_harness);',
    '  end',
  );

  // -- The one sequential process owning the clock, the Drive_Point, and the Sample_Point -------
  lines.push('  initial begin : ece_cycle');
  if (isClocked) {
    lines.push("    ece_clk = 1'b0;");
  }
  if (resetName === null && isClocked) {
    // No declared reset: still settle RESET_CYCLES edges before step 0, the unchanged prior
    // behaviour for a clocked-but-resetless interface. A reset-bearing interface gets NO
    // pre-loop settle here - ece_harness_reset below is the only reset-and-settle site, and the
    // in-loop modulo check (0 % N == 0) reaches step 0 through that same site (Req 5.1, 5.7).
    lines.push(`    repeat (${String(RESET_CYCLES)}) begin`);
    lines.push("      #(ECE_PERIOD/2) ece_clk = 1'b1;");
    lines.push("      #(ECE_PERIOD/2) ece_clk = 1'b0;");
    lines.push('    end');
  }
  // Req 5.12: the state is primed inside the loop in BOTH branches below, not here - the
  // reset-bearing branch primes via its modulo check (which reaches step 0 too), and the
  // no-reset branch primes via its own `step == 0` guard, so neither interface shape gets a
  // second, redundant priming site outside the loop.

  lines.push('    for (step = 0; step < ECE_SAMPLE_BUDGET; step = step + 1) begin');
  if (resetName !== null && isClocked) {
    // Req 5.1 through 5.3, 5.7: step 0 and every mid-run reset share ONE rendered site. The
    // check fires at step 0 too (0 % ECE_RESET_FRAME == 0), so no separate pre-loop priming is
    // rendered for a reset-bearing interface - this is the only site that ever calls
    // ece_harness_reset or primes ece_state for one.
    lines.push('      if ((step % ECE_RESET_FRAME) == 0) begin');
    lines.push('        ece_harness_reset;');
    lines.push("        ece_state = ece_reset_state(1'b0);");
    lines.push('      end');
  } else {
    // Req 5.8: the no-reset guard is `step == 0`, not the modulo, and different rendered text
    // from the reset-bearing branch above rather than one shared template.
    lines.push('      if (step == 0) begin');
    lines.push("        ece_state = ece_reset_state(1'b0);");
    lines.push('      end');
  }
  // Drive_Point (Req 4.3): every input driven from this step's packed stimulus bits.
  lines.push('      ece_in_bits = ece_stimulus(step);');
  if (isClocked) {
    lines.push('      #(ECE_PERIOD/2 - ECE_SKEW);');
  } else {
    lines.push('      #(ECE_SKEW);');
  }
  // Sample_Point (Req 4.2, 6.5, 6.6, 7.9): every port is compared against THIS step's
  // expectation. A registered port's is evaluated with an all-zero input, so it cannot depend on
  // the input applied in the same cycle; a combinational port's sees the applied input.
  lines.push('      ece_exp_bits = ece_expect(ece_state, ece_in_bits);');
  if (hasRegistered) {
    lines.push(
      `      ece_exp_reg_bits = ece_expect(ece_state, {${String(inputBundleWidth)}{1'b0}});`,
    );
  }
  outputPorts.forEach((port, index) => {
    const timing = timingOf(timingContract, port.name);
    const { high, low } = inputBundleSlice(outputPorts, index);
    const bundle = timing === 'registered' ? 'ece_exp_reg_bits' : 'ece_exp_bits';
    const expectationValue = `${bundle}[${String(high)}:${String(low)}]`;
    // Req 7.9: a data output is not checked where the declared Validity_Output is not 1, the same
    // values the signature reducer masks.
    const masked = validityName !== null && port.name !== validityName;
    const indent = masked ? '        ' : '      ';
    if (masked) {
      lines.push(`      if (${validityName} === 1'b1) begin`);
    }
    lines.push(`${indent}if (${expectationValue} === ${port.name})`);
    lines.push(`${indent}  $display("${CHECK_REPORT_PASS_FORMAT}", "${nonce}_${port.name}");`);
    lines.push(`${indent}else`);
    lines.push(
      `${indent}  $display("${CHECK_REPORT_FAIL_FORMAT}: expected %0h, got %0h", "${nonce}_${port.name}", ${expectationValue}, ${port.name});`,
    );
    if (masked) {
      lines.push('      end');
    }
  });
  const sampleFormatFields = outputPorts.map(() => '%0h').join(' ');
  const sampleFormat =
    outputPorts.length > 0
      ? `${SAMPLE_LINE_PREFIX} ${nonce} %0d ${sampleFormatFields}`
      : `${SAMPLE_LINE_PREFIX} ${nonce} %0d`;
  const sampleArgs = ['step', ...outputPorts.map((port) => port.name)].join(', ');
  lines.push(`      $display("${sampleFormat}", ${sampleArgs});`);
  lines.push('      ece_state = ece_next_state(ece_state, ece_in_bits);');
  if (isClocked) {
    lines.push("      #(ECE_SKEW) ece_clk = 1'b1;");
    lines.push("      #(ECE_PERIOD/2) ece_clk = 1'b0;");
  }
  lines.push('    end');
  lines.push(`    $display("${SAMPLE_END_PREFIX} ${nonce} %0d", ECE_SAMPLE_BUDGET);`);
  lines.push('    $finish;');
  lines.push('  end');
  lines.push('endmodule');
  lines.push('');

  return ok({ path: CONSENSUS_HARNESS_PATH, contents: lines.join('\n') });
}
