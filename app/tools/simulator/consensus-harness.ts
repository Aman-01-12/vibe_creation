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
// THE REFERENCE_MODEL IS THREE FUNCTIONS, NOT A SECOND RTL MODULE
//
//   C7 (the Authoring_Contract role, not yet landed) has the model write exactly three
//   `function automatic` bodies - `ece_stimulus`, `ece_next_state`, and `ece_expect` - whose
//   headers this harness renders. A Verilog function cannot contain a delay control, an event
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
//   cannot arise here).
//
//   The Timing_Contract renders as a per-port selection of which expectation to compare, never as
//   a per-design mode: the harness keeps the previous step's expectation for every port and
//   compares a `registered` port against the previous step's value and a `combinational` port
//   against this step's.
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
export const CONSENSUS_HARNESS_VERSION = 1;

/** A hyphenated path, so no identifier-derived RTL or testbench path can collide with it. */
export const CONSENSUS_HARNESS_PATH = 'ece-consensus-harness.v';

/** Clock period in ns; the Drive_Point sits a half period from the Sampling_Edge. */
export const CLOCK_PERIOD_NS = 10;

/** How far before the Sampling_Edge the Sample_Point sits, in ns. */
export const SAMPLE_SKEW_NS = 1;

/** The cap on Sample_Points per run, which bounds the stdout stream by construction. */
export const SAMPLE_BUDGET = 2048;

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
 * The previous-step-EXPECTATION shadow register for one output port, read by a `registered`
 * comparison. This stores `ece_expect`'s result from the PRIOR iteration, not the DUT's own
 * previous output - design.md's own words are "the harness keeps the previous step's
 * EXPECTATION", and a `registered` port compares the DUT's current output against that stored
 * expectation while a `combinational` port compares against the fresh one computed this step.
 */
function previousExpectationDeclarationLine(port: {
  readonly name: string;
  readonly width: number;
}): string {
  const prevName = `ece_prev_exp_${port.name}`;
  return port.width === 1
    ? `  reg ${prevName};`
    : `  reg [${String(port.width - 1)}:0] ${prevName};`;
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

/** A Verilog bit-select literal for the packed input-bundle slice `inputPorts[index]` occupies, MSB-first in declared order. */
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
  const { moduleInterface, timingContract, nonce, watchdogBudgetNs, sampleBudget } = request;

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
    '// Product-written Consensus_Harness: the top module, instantiating the Candidate_Design,',
    '// owning the clock, the Drive_Point, and the Sample_Point, and calling the Reference_Model',
    "// as three function headers the model's bodies implement (C7).",
    `module ${CONSENSUS_HARNESS_MODULE};`,
    `  localparam [63:0] ECE_WATCHDOG_BUDGET_NS = 64'd${String(watchdogBudgetNs)};`,
    `  localparam integer ECE_SAMPLE_BUDGET = ${String(effectiveSampleBudget)};`,
    `  localparam integer ECE_PERIOD = ${String(CLOCK_PERIOD_NS)};`,
    `  localparam integer ECE_SKEW = ${String(SAMPLE_SKEW_NS)};`,
    '  integer step;',
    `  reg [${String(REFERENCE_MODEL_STATE_WIDTH - 1)}:0] ece_state;`,
    `  reg [${String(inputBundleWidth - 1)}:0] ece_in_bits;`,
    `  reg [${String(outputBundleWidth - 1)}:0] ece_exp_bits;`,
    ...moduleInterface.ports.map(wireDeclarationLine),
    ...outputPorts.map(previousExpectationDeclarationLine),
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
  }

  // Pack the input bundle onto the harness's own wires, in declared input-port order.
  inputPorts.forEach((port, index) => {
    const { high, low } = inputBundleSlice(inputPorts, index);
    lines.push(`  assign ${port.name} = ece_in_bits[${String(high)}:${String(low)}];`);
  });

  // ONE instance only: the Candidate_Design under judgment. The Reference_Model is three
  // behavioral FUNCTIONS, not a second RTL module sharing this interface's ports - instantiating
  // a second copy of this same module would drive every output wire from two sources at once,
  // a multi-driver conflict a hand-verified iverilog run of an earlier draft caught (see header).
  lines.push(
    `  ${moduleInterface.moduleName} ${CANDIDATE_INSTANCE_NAME} ` +
      `(${portConnectionsOf(moduleInterface.ports, clockName, resetName)});`,
  );

  // THE REFERENCE_MODEL FUNCTION HEADERS ARE NOT RENDERED HERE, AND MUST NEVER BE
  //
  //   MEASURED BUG (caught by task 8.4's real-toolchain integration test, not by any unit test):
  //   an earlier draft of this renderer declared empty `function automatic ... endfunction`
  //   stubs for ece_stimulus/ece_next_state/ece_expect INSIDE this module, intending them as
  //   "headers the model's body implements". That is wrong: Verilog scopes a function declared
  //   inside a module to that module, which SHADOWS the compilation-unit-scope function of the
  //   same name the separate Reference_Model file declares with its real body - so every call
  //   below silently resolved to the harness's own empty stub and read 'x' on every step. Real
  //   `iverilog -g2012` accepts this with NO error, because it is not a true duplicate
  //   declaration (different scopes), which is exactly why no compile-time check caught it.
  //   The fix: this module declares NOTHING named ece_stimulus/ece_next_state/ece_expect. It only
  //   CALLS them below, resolving to the Reference_Model workspace file's own compilation-unit
  //   scope declaration - the same mechanism confirmed (see consensus-harness.test.ts's module
  //   header) by which a standalone function in one file is callable from a module in another.

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
  if (resetName !== null) {
    lines.push(`    ece_reset_drive = ${resetActiveLow ? "1'b0" : "1'b1"};`);
  }
  lines.push(`    ece_state = {${String(REFERENCE_MODEL_STATE_WIDTH)}{1'b0}};`);
  if (isClocked) {
    lines.push(`    repeat (${String(RESET_CYCLES)}) begin`);
    lines.push("      #(ECE_PERIOD/2) ece_clk = 1'b1;");
    lines.push("      #(ECE_PERIOD/2) ece_clk = 1'b0;");
    lines.push('    end');
  }
  if (resetName !== null) {
    lines.push(`    ece_reset_drive = ${resetActiveLow ? "1'b1" : "1'b0"};`);
  }
  // Prime the previous-step-expectation shadow registers before step 0: there is no "previous
  // step's inputs" yet, so the harness's own defined starting point is ece_expect over the
  // post-release state and an all-zero stimulus. A hand-verified iverilog run of an earlier draft
  // (which primed the DUT's own output instead of an expectation, and read 'x' on step 0) caught
  // the need for an explicit priming step at all, even though that earlier shape was the wrong one.
  lines.push(`    ece_exp_bits = ece_expect(ece_state, {${String(inputBundleWidth)}{1'b0}});`);
  outputPorts.forEach((port, index) => {
    const { high, low } = inputBundleSlice(outputPorts, index);
    lines.push(`    ece_prev_exp_${port.name} = ece_exp_bits[${String(high)}:${String(low)}];`);
  });

  lines.push('    for (step = 0; step < ECE_SAMPLE_BUDGET; step = step + 1) begin');
  // Drive_Point (Req 4.3): every input driven from this step's packed stimulus bits.
  lines.push('      ece_in_bits = ece_stimulus(step);');
  if (isClocked) {
    lines.push('      #(ECE_PERIOD/2 - ECE_SKEW);');
  } else {
    lines.push('      #(ECE_SKEW);');
  }
  // Sample_Point (Req 4.2, 6.3, 6.5, 6.6): compute the expectation, compare per port against the
  // Timing_Contract-selected value, and emit the CHECK line(s) and the sample line, each a single
  // complete `$display` call so no line is split across two calls (see header note).
  lines.push('      ece_exp_bits = ece_expect(ece_state, ece_in_bits);');
  outputPorts.forEach((port, index) => {
    const timing = timingOf(timingContract, port.name);
    const { high, low } = inputBundleSlice(outputPorts, index);
    const expSlice = `ece_exp_bits[${String(high)}:${String(low)}]`;
    // registered (Req 6.5): compare the DUT's current output against the PREVIOUS step's
    // expectation. combinational (Req 6.6): compare against THIS step's expectation. Both read
    // the DUT's actual output on the left of `===`; only the expectation side moves (Property 10).
    const expectationValue = timing === 'registered' ? `ece_prev_exp_${port.name}` : expSlice;
    lines.push(`      if (${expectationValue} === ${port.name})`);
    lines.push(`        $display("${CHECK_REPORT_PASS_FORMAT}", "${nonce}_${port.name}");`);
    lines.push('      else');
    lines.push(
      `        $display("${CHECK_REPORT_FAIL_FORMAT}: expected %0h, got %0h", "${nonce}_${port.name}", ${expectationValue}, ${port.name});`,
    );
  });
  const sampleFormatFields = outputPorts.map(() => '%0h').join(' ');
  const sampleFormat =
    outputPorts.length > 0
      ? `${SAMPLE_LINE_PREFIX} ${nonce} %0d ${sampleFormatFields}`
      : `${SAMPLE_LINE_PREFIX} ${nonce} %0d`;
  const sampleArgs = ['step', ...outputPorts.map((port) => port.name)].join(', ');
  lines.push(`      $display("${sampleFormat}", ${sampleArgs});`);
  // Carry this step's expectation forward as next step's "previous expectation" (Req 6.5).
  outputPorts.forEach((port, index) => {
    const { high, low } = inputBundleSlice(outputPorts, index);
    lines.push(`      ece_prev_exp_${port.name} = ece_exp_bits[${String(high)}:${String(low)}];`);
  });
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
