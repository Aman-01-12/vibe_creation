// Converting a fetched RTLLM checkout into our `EvalProblem` corpus.
//
// HOW ACCEPTANCE CRITERIA ARE MODELLED, AND WHY
//   RTLLM ships ONE whole-design golden testbench per design. It does not ship
//   itemized, individually-checked criteria. So each imported problem carries
//   EXACTLY ONE acceptance criterion, stating the design's whole-design functional
//   requirement in RTLLM's own words, marked `measurable` and `method: 'simulation'`.
//
//   The alternative - splitting the description's prose into five or six
//   fine-grained criteria - would look richer and be a lie: nothing in the corpus
//   verifies any individual one of them, so a per-criterion pass rate computed
//   against them would be measuring our own invention. Our Spec model already has a
//   `measurable: false` escape hatch for criteria that cannot be checked; using it
//   here would be worse still, because the requirement IS checkable, just not
//   decomposable with the evidence upstream provides.
//
//   The criterion deliberately does NOT say "passes RTLLM's golden testbench". The
//   Testbench_Agent derives its independent testbench from these criteria, and a
//   criterion that names the golden judge would make that derivation circular and,
//   worse, would tell the agent about the judge that is supposed to be able to
//   falsify it. It states the BEHAVIOUR; the judge stays out of the Spec entirely.
//
// EVERY FILE READ IS UNTRUSTED
//   Description text, reference RTL, testbench text, and data-file names all come
//   from a third-party checkout. Each is size-bounded, validated at this boundary,
//   and any shape we cannot read becomes a recorded QUARANTINE rather than a throw,
//   a guess, or a silent skip. A malformed design cannot crash the import or slip
//   into the scored corpus with an invented interface.

import {
  makePort,
  makeTimingContract,
  newUlid,
  type AcceptanceCriterion,
  type ClockingContract,
  type ModuleInterface,
  type Port,
  type Spec,
  type TimingContract,
} from '@app/core';
import type { SourceFile } from '@app/tools';

import type { EvalProblem } from '../problem.js';
import type { CorpusCheckoutPort } from './checkout-port.js';
import { parseDesignDescription, type DesignDescription } from './design-description.js';
import {
  asRtllmCategory,
  DESIGN_DESCRIPTION_FILENAME,
  GOLDEN_TESTBENCH_FILENAME,
  REFERENCE_PREFIX,
  RTLLM_CATEGORY_DIRECTORIES,
  RTLLM_PINNED_COMMIT,
  rtllmProblemId,
  VCS_MAKEFILE_FILENAME,
  type RtllmCategory,
} from './pinned-source.js';
import {
  listDeclaredModuleNames,
  parseDeclaredModule,
  type DeclaredPort,
} from './verilog-module.js';
import type {
  GoldenTestbench,
  QuarantinedDesign,
  QuarantineReasonCode,
  ReferenceDesign,
  RtllmCorpus,
} from './corpus-types.js';

/** Workspace filename the (renamed) reference RTL is materialized under for Stage 0. */
export const REFERENCE_WORKSPACE_FILENAME = 'dut_reference.v' as const;

/** Data-file names we are willing to write into a sandbox workspace. */
const SAFE_DATA_FILENAME = /^[A-Za-z0-9._-]{1,64}$/;

/** Port-name patterns that identify a clock input. */
const CLOCK_NAME_PATTERN = /^(?:clk|clock)(?:_?(?:in|i))?$/i;

/**
 * Port-name patterns that identify a reset input.
 *
 * The optional single-letter prefix matches per-domain resets (`arstn`, `brstn`,
 * `wrstn`), which matters because a design carrying two of them has no single reset:
 * `soleMatch` then leaves the contract empty rather than naming one and implying it
 * is the only one.
 */
const RESET_NAME_PATTERN = /^[a-z]?_?(?:a?rst|reset|res)(?:_?n)?$/i;

/** Whether a reset port name signals active-low polarity. */
const ACTIVE_LOW_RESET = /(?:_n|n)$/;

/** One design folder located in the checkout, before anything is read from it. */
interface DesignLocation {
  readonly category: RtllmCategory;
  /** Category-relative segments to the design folder (subcategory, design). */
  readonly segments: readonly string[];
  readonly designName: string;
  readonly problemId: string;
}

/** One design's raw files, as read from the checkout. */
interface DesignFiles {
  readonly descriptionText: string;
  readonly testbenchText: string;
  readonly referenceFilename: string;
  readonly referenceText: string;
  readonly dataFiles: readonly SourceFile[];
}

/** A successfully converted design: its problem, its judge, and its reference. */
interface ConvertedDesign {
  readonly problem: EvalProblem;
  readonly golden: GoldenTestbench;
  readonly reference: ReferenceDesign;
}

/** Either a converted design or the reason it is quarantined. */
type ConversionOutcome =
  | { readonly ok: true; readonly design: ConvertedDesign }
  | { readonly ok: false; readonly code: QuarantineReasonCode; readonly detail: string };

/** Build a quarantine outcome without repeating the shape at each guard. */
function reject(code: QuarantineReasonCode, detail: string): ConversionOutcome {
  return { ok: false, code, detail };
}

/**
 * Locate every design folder in a checkout, in fixed category order.
 *
 * The layout is `<Category>/<Subcategory>/<design>/`, and the id is derived from the
 * category and design folder names only - never from the subcategory, which upstream
 * has already renamed once - so a subcategory reshuffle cannot silently change a
 * problem id and invalidate a recorded baseline.
 */
async function locateDesigns(checkout: CorpusCheckoutPort): Promise<readonly DesignLocation[]> {
  const located: DesignLocation[] = [];
  for (const categoryName of RTLLM_CATEGORY_DIRECTORIES) {
    const category = asRtllmCategory(categoryName);
    if (category === null) {
      continue;
    }
    for (const subcategory of await checkout.listDirectories([categoryName])) {
      for (const designName of await checkout.listDirectories([categoryName, subcategory])) {
        located.push({
          category,
          segments: [categoryName, subcategory, designName],
          designName,
          problemId: rtllmProblemId(category, designName),
        });
      }
    }
  }
  return located;
}

/** Whether a filename is a Verilog source (the compiler inputs of a design folder). */
function isVerilogSource(filename: string): boolean {
  return filename.toLowerCase().endsWith('.v');
}

/** Whether a filename is a data file the testbench may read at run time. */
function isDataFile(filename: string): boolean {
  return (
    !isVerilogSource(filename) &&
    filename !== DESIGN_DESCRIPTION_FILENAME &&
    filename !== VCS_MAKEFILE_FILENAME
  );
}

/** Read every data file of a design, rejecting any name we will not write. */
async function readDataFiles(
  checkout: CorpusCheckoutPort,
  location: DesignLocation,
  filenames: readonly string[],
): Promise<
  | { readonly ok: true; readonly files: readonly SourceFile[] }
  | { readonly ok: false; readonly detail: string }
> {
  const files: SourceFile[] = [];
  for (const filename of filenames.filter(isDataFile)) {
    if (!SAFE_DATA_FILENAME.test(filename)) {
      return { ok: false, detail: 'a testbench data file has a name we will not materialize' };
    }
    const contents = await checkout.readTextFile([...location.segments, filename]);
    if (contents !== null) {
      files.push({ path: filename, contents });
    }
  }
  return { ok: true, files };
}

/** Read one design's files, or report which required file is missing. */
async function readDesignFiles(
  checkout: CorpusCheckoutPort,
  location: DesignLocation,
): Promise<
  | { readonly ok: true; readonly files: DesignFiles }
  | { readonly ok: false; readonly code: QuarantineReasonCode; readonly detail: string }
> {
  const filenames = await checkout.listFiles(location.segments);
  const descriptionText = await checkout.readTextFile([
    ...location.segments,
    DESIGN_DESCRIPTION_FILENAME,
  ]);
  if (descriptionText === null) {
    return {
      ok: false,
      code: 'DESCRIPTION_UNREADABLE',
      detail: 'design_description.txt is absent',
    };
  }
  const testbenchText = await checkout.readTextFile([
    ...location.segments,
    GOLDEN_TESTBENCH_FILENAME,
  ]);
  if (testbenchText === null) {
    return { ok: false, code: 'GOLDEN_TESTBENCH_MISSING', detail: 'testbench.v is absent' };
  }
  const references = filenames.filter(
    (name) => isVerilogSource(name) && name !== GOLDEN_TESTBENCH_FILENAME,
  );
  const referenceFilename = references[0];
  if (references.length !== 1 || referenceFilename === undefined) {
    return {
      ok: false,
      code: 'REFERENCE_FILE_AMBIGUOUS',
      detail: `expected exactly one reference .v file, found ${references.length}`,
    };
  }
  const referenceText = await checkout.readTextFile([...location.segments, referenceFilename]);
  if (referenceText === null) {
    return {
      ok: false,
      code: 'REFERENCE_FILE_AMBIGUOUS',
      detail: 'the reference .v file could not be read',
    };
  }
  const data = await readDataFiles(checkout, location, filenames);
  if (!data.ok) {
    return { ok: false, code: 'DATA_FILE_NAME_UNSAFE', detail: data.detail };
  }
  return {
    ok: true,
    files: {
      descriptionText,
      testbenchText,
      referenceFilename,
      referenceText,
      dataFiles: data.files,
    },
  };
}

/** Whether an identifier appears as a whole word in a body of text. */
function mentionsIdentifier(text: string, identifier: string): boolean {
  const escaped = identifier.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${escaped}\\b`).test(text);
}

/**
 * Select the reference's TOP module for a required module name.
 *
 * Upstream is inconsistent here, so the rule is explicit rather than positional:
 * prefer a declared module named exactly the required name or `verified_<name>`;
 * failing that, accept a lone declared module (three designs name their reference
 * top something else entirely, e.g. `verified_multi_pipe` for `multi_pipe_4bit`);
 * otherwise refuse to guess. Taking "the first declared module" would be wrong -
 * `asyn_fifo`'s reference declares its `dual_port_RAM` submodule first.
 */
function selectTopModule(declared: readonly string[], moduleName: string): string | null {
  const exact = declared.find(
    (name) => name === moduleName || name === `${REFERENCE_PREFIX}${moduleName}`,
  );
  if (exact !== undefined) {
    return exact;
  }
  return declared.length === 1 ? (declared[0] ?? null) : null;
}

/** Rename a module identifier throughout a source, on whole-word boundaries only. */
export function renameTopModule(source: string, from: string, to: string): string {
  if (from === to) {
    return source;
  }
  const escaped = from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return source.replace(new RegExp(`\\b${escaped}\\b`, 'g'), to);
}

/** Whether a port looks like the module's clock. */
function isClockPort(port: DeclaredPort): boolean {
  return port.direction === 'input' && port.width === 1 && CLOCK_NAME_PATTERN.test(port.name);
}

/** Whether a port looks like the module's reset. */
function isResetPort(port: DeclaredPort): boolean {
  return port.direction === 'input' && port.width === 1 && RESET_NAME_PATTERN.test(port.name);
}

/**
 * The single port matching a predicate, or `null` when zero or several match.
 *
 * Deliberately conservative: several designs are multi-clock (`asyn_fifo` has
 * `wclk`/`rclk`, `synchronizer` has `clk_a`/`clk_b`) and a `ClockingContract` names
 * exactly one clock, so an ambiguous case leaves the contract empty and keeps every
 * signal as an ordinary declared port. Either way the flattened interface the
 * generation check uses lists each port exactly once.
 */
function soleMatch(
  ports: readonly DeclaredPort[],
  predicate: (port: DeclaredPort) => boolean,
): DeclaredPort | null {
  const matches = ports.filter(predicate);
  return matches.length === 1 ? (matches[0] ?? null) : null;
}

/** The declared ports split into the clock/reset contract and the remaining ports. */
function splitClocking(ports: readonly DeclaredPort[]): {
  readonly clocking: ClockingContract;
  readonly declared: readonly DeclaredPort[];
} {
  const clock = soleMatch(ports, isClockPort);
  const reset = soleMatch(ports, isResetPort);
  const contracted = new Set([clock?.name, reset?.name].filter((name) => name !== undefined));
  return {
    clocking: {
      clockName: clock?.name ?? null,
      resetName: reset?.name ?? null,
      resetActiveLow: reset === null ? false : ACTIVE_LOW_RESET.test(reset.name),
    },
    declared: ports.filter((port) => !contracted.has(port.name)),
  };
}

/** Build the domain `Port` list, surfacing the first invariant violation. */
function buildPorts(
  ports: readonly DeclaredPort[],
):
  | { readonly ok: true; readonly ports: readonly Port[] }
  | { readonly ok: false; readonly detail: string } {
  const built: Port[] = [];
  for (const port of ports) {
    const made = makePort({ name: port.name, direction: port.direction, width: port.width });
    if (!made.ok) {
      return { ok: false, detail: `port "${port.name}": ${made.error.message}` };
    }
    built.push(made.value);
  }
  return { ok: true, ports: built };
}

/** Collapse a multi-line statement into one line for embedding in a criterion. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/**
 * The single whole-design acceptance criterion for an imported design.
 *
 * See the module header for why there is exactly one and why it never mentions the
 * golden testbench.
 */
function wholeDesignCriterion(
  moduleName: string,
  description: DesignDescription,
): AcceptanceCriterion {
  return {
    id: newUlid(),
    text:
      `Under simulation, ${moduleName} produces the behaviour the design requires on ` +
      `every case exercised: ${oneLine(description.statement)}`,
    measurable: true,
    method: 'simulation',
  };
}

/** The parameter names a golden testbench overrides on the DUT instantiation. */
export function readOverriddenParameters(
  testbenchText: string,
  moduleName: string,
): readonly string[] {
  const escaped = moduleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const instantiation = new RegExp(`\\b${escaped}\\s*#\\s*\\(([^;]*?)\\)\\s*[A-Za-z_]`).exec(
    testbenchText,
  );
  if (instantiation === null) {
    return [];
  }
  const names: string[] = [];
  for (const match of (instantiation[1] ?? '').matchAll(/\.\s*([A-Za-z_][A-Za-z0-9_$]*)\s*\(/g)) {
    const name = match[1];
    if (name !== undefined && !names.includes(name)) {
      names.push(name);
    }
  }
  return names;
}

/**
 * Build the Timing_Contract for an imported design.
 *
 * ponytail: RTLLM carries no per-port Port_Timing source - `verilog-module.ts`
 * discards the `reg`/`wire` qualifier while parsing, and inferring from it would
 * only move the guess rather than remove it. Every output port is placed at
 * `registered` here, which is wrong on 13 of 31 clocked references (Req 6.2's own
 * 42% figure). This corpus's `timingContract` is not read by anything yet - only
 * `golden-judge.ts`'s Icarus run against the untouched RTLLM testbench scores a
 * design - so the placeholder changes no behaviour today. The upgrade path, per
 * `clarification-answers.md` Q-07, is the Spec role stating per-port timing at
 * authoring time; this placeholder must be replaced once a consumer reads it.
 */
function buildTimingContract(moduleInterface: ModuleInterface): TimingContract {
  const entries = moduleInterface.ports
    .filter((port) => port.direction === 'output')
    .map((port) => ({ portName: port.name, timing: 'registered' as const }));
  const built = makeTimingContract(moduleInterface, entries);
  if (!built.ok) {
    // Unreachable: `entries` is derived from `moduleInterface`'s own output ports.
    throw new Error(`corpus import built an invalid timing contract: ${built.error.message}`);
  }
  return built.value;
}

/** Assemble the approved Spec for one imported design. */
function buildSpec(
  moduleName: string,
  description: DesignDescription,
  moduleInterface: ModuleInterface,
): Spec {
  return {
    id: newUlid(),
    projectId: newUlid(),
    goal: description.statement,
    // RTLLM states no separable constraints; inventing some would put words in the
    // benchmark's mouth and could contradict the description a candidate is judged on.
    constraints: [],
    moduleInterface,
    timingContract: buildTimingContract(moduleInterface),
    acceptanceCriteria: [wholeDesignCriterion(moduleName, description)],
    architecture:
      description.implementation.length > 0
        ? description.implementation
        : 'The design description states no block-level architecture.',
    approved: true,
    version: 1,
  };
}

/** Convert one design's files into a problem, judge, and reference, or quarantine it. */
function convertDesign(location: DesignLocation, files: DesignFiles): ConversionOutcome {
  const parsedDescription = parseDesignDescription(files.descriptionText);
  if (!parsedDescription.ok) {
    return reject('DESCRIPTION_UNREADABLE', parsedDescription.reason);
  }
  const description = parsedDescription.description;
  const { moduleName } = description;
  if (!mentionsIdentifier(files.testbenchText, moduleName)) {
    return reject(
      'MODULE_NAME_ABSENT_FROM_TESTBENCH',
      `the golden testbench never mentions "${moduleName}", so it is not the judged interface`,
    );
  }
  const declared = listDeclaredModuleNames(files.referenceText);
  const topModule = selectTopModule(declared, moduleName);
  if (topModule === null) {
    return reject(
      'REFERENCE_TOP_MODULE_AMBIGUOUS',
      `the reference declares ${declared.length} modules and none is "${moduleName}"`,
    );
  }
  if (topModule !== moduleName && declared.includes(moduleName)) {
    return reject(
      'REFERENCE_RENAME_COLLIDES',
      `renaming "${topModule}" to "${moduleName}" would collide with another declared module`,
    );
  }
  const parsedModule = parseDeclaredModule(files.referenceText, topModule);
  if (!parsedModule.ok) {
    return reject('INTERFACE_UNPARSEABLE', parsedModule.reason);
  }
  return assembleDesign(location, files, description, {
    topModule,
    ports: parsedModule.module.ports,
  });
}

/** Build the converted design from the validated description and parsed interface. */
function assembleDesign(
  location: DesignLocation,
  files: DesignFiles,
  description: DesignDescription,
  parsed: { readonly topModule: string; readonly ports: readonly DeclaredPort[] },
): ConversionOutcome {
  const { moduleName } = description;
  const split = splitClocking(parsed.ports);
  const ports = buildPorts(split.declared);
  if (!ports.ok) {
    return reject('INTERFACE_PORT_INVALID', ports.detail);
  }
  const moduleInterface: ModuleInterface = {
    moduleName,
    ports: ports.ports,
    clocking: split.clocking,
    // RTLLM states no Validity_Output; this task changes no behaviour (task 1.3).
    validityOutputName: null,
  };
  const problem: EvalProblem = {
    id: location.problemId,
    title: `${location.designName} (${location.category})`,
    source: 'RTLLM',
    spec: buildSpec(moduleName, description, moduleInterface),
    intentSummary: oneLine(description.statement),
  };
  return {
    ok: true,
    design: {
      problem,
      golden: {
        problemId: location.problemId,
        moduleName,
        // Byte-identical to upstream: the judge is never rewritten.
        testbench: { path: GOLDEN_TESTBENCH_FILENAME, contents: files.testbenchText },
        dataFiles: files.dataFiles,
        overriddenParameters: readOverriddenParameters(files.testbenchText, moduleName),
      },
      reference: {
        problemId: location.problemId,
        rtl: {
          path: REFERENCE_WORKSPACE_FILENAME,
          contents: renameTopModule(files.referenceText, parsed.topModule, moduleName),
        },
        topModuleRenamedFrom: parsed.topModule === moduleName ? null : parsed.topModule,
      },
    },
  };
}

/** The mutable accumulation of one import pass. */
interface ImportAccumulator {
  readonly problems: EvalProblem[];
  readonly golden: Map<string, GoldenTestbench>;
  readonly references: Map<string, ReferenceDesign>;
  readonly quarantined: QuarantinedDesign[];
}

/** Record one design's outcome into the accumulator. */
function accumulate(
  acc: ImportAccumulator,
  location: DesignLocation,
  outcome: ConversionOutcome,
): void {
  if (!outcome.ok) {
    acc.quarantined.push({
      problemId: location.problemId,
      designName: location.designName,
      category: location.category,
      stage: 'import',
      code: outcome.code,
      detail: outcome.detail,
    });
    return;
  }
  acc.problems.push(outcome.design.problem);
  acc.golden.set(location.problemId, outcome.design.golden);
  acc.references.set(location.problemId, outcome.design.reference);
}

/**
 * Import an RTLLM checkout into our corpus.
 *
 * Deterministic: designs are visited in fixed category order, then in sorted
 * subcategory and design order, so two imports of the same checkout produce
 * identical problem lists. Every design either becomes a problem with a judge and a
 * reference, or a quarantine record with a reason - never a silent omission.
 */
export async function importRtllmCorpus(checkout: CorpusCheckoutPort): Promise<RtllmCorpus> {
  const locations = await locateDesigns(checkout);
  const acc: ImportAccumulator = {
    problems: [],
    golden: new Map(),
    references: new Map(),
    quarantined: [],
  };
  for (const location of locations) {
    const read = await readDesignFiles(checkout, location);
    accumulate(
      acc,
      location,
      read.ok ? convertDesign(location, read.files) : reject(read.code, read.detail),
    );
  }
  return {
    pinnedCommit: RTLLM_PINNED_COMMIT,
    problems: acc.problems,
    golden: acc.golden,
    references: acc.references,
    quarantined: acc.quarantined,
    designsSeen: locations.length,
  };
}
