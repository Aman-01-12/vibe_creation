// timing-contract-inference, task 11.1: the pass-sequence equivalence GATE.
//
// WHAT THIS ESTABLISHES
//   Whether `prep -top {top} -flatten` ALONE derives the same timing classification, the same
//   refusal, and the same port coverage as the existing enriched `prep -top {top} -flatten;
//   opt_dff -sat` sequence, over every design of the Derivation_Population. Only the enriched
//   sequence has been measured so far (design.md, "Pass sequence"), so Req 1.13's equivalence
//   claim is outstanding until this comparison has actually run.
//
// WHY TWO DIRECT YOSYS INVOCATIONS, RATHER THAN TWO `TimingDerivationPort`s
//   `YOSYS_PREPASS_SCRIPT` is a worker-side constant with the enriched sequence baked in
//   (`opt_dff -sat` is load-bearing there for RESET, which is a different finding measured on a
//   different tradeoff). Standing up a second sandbox job kind just to drop one pass would be a
//   production change for a one-off measurement. So this script runs `yosys` directly, twice per
//   design - once with the production script, once with `opt_dff -sat` removed - and reuses the
//   WORKER'S OWN `_timing_finding` (via a one-line Python driver) to turn each netlist into the
//   same `PrepassTimingFinding` shape the real pre-pass report carries. The classification itself
//   then goes through the production `classifyPortTiming` from `@app/tools`, so the comparison
//   exercises the real classifier and only swaps the pass sequence underneath it.
//
// WHAT IS COMPARED, PER DESIGN AND PER PORT
//   The design-level refusal cause (if either run refuses structurally), and otherwise each
//   declared output port's classification or per-port refusal cause. A port-coverage difference -
//   a port named by one run's `timing.ports` and not the other's - is also a disagreement.
//
// Run with `node app/eval/dist/scripts/timing-pass-sequence-equivalence.js`, after `npm run build`.
// Requires `yosys` on PATH and the pinned RTLLM checkout (`npm run corpus:fetch`).

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

import { classifyPortTiming, projectWorkerEnvironment, WORKER_SOURCE_ROOT } from '@app/tools';
import type { PrepassTimingFinding, TimingRefusal } from '@app/tools';
import type { ModuleInterface, Result } from '@app/core';
import {
  FileSystemCorpusCheckout,
  FixedTimingDerivation,
  importRtllmCorpus,
  inDerivationPopulation,
  RTLLM_CHECKOUT_PATH,
} from '@app/eval';

/** The two pass sequences under comparison, named for the report. */
export type PassSequenceLabel = 'prep-alone' | 'enriched';

/** The production enriched sequence, read from the worker rather than restated - see below. */
let ENRICHED_SCRIPT_TEMPLATE: string | null = null;

/** The closed environment the `yosys` spawn and the worker-constant probe both run under. */
function spawnEnvironment(): Record<string, string> {
  return {
    ...projectWorkerEnvironment(process.env).env,
    PYTHONPATH: WORKER_SOURCE_ROOT,
  };
}

/** Ask the worker interpreter for its own `YOSYS_PREPASS_SCRIPT`, so it is read, not copied. */
function readEnrichedScriptTemplate(pythonBin: string): string {
  if (ENRICHED_SCRIPT_TEMPLATE !== null) {
    return ENRICHED_SCRIPT_TEMPLATE;
  }
  const run = spawnSync(
    pythonBin,
    ['-c', 'from tool_runner_worker import eda; print(eda.YOSYS_PREPASS_SCRIPT)'],
    {
      encoding: 'utf8',
      env: spawnEnvironment(),
    },
  );
  if (run.error !== undefined || run.status !== 0) {
    throw new Error('could not read YOSYS_PREPASS_SCRIPT from the worker interpreter');
  }
  const template = run.stdout.trim();
  ENRICHED_SCRIPT_TEMPLATE = template;
  return template;
}

/** The "prep alone" sequence: the enriched one with `opt_dff -sat; ` removed, and nothing else. */
function prepAloneScriptTemplate(enriched: string): string {
  const withoutOptDff = enriched.replace('opt_dff -sat; ', '');
  if (withoutOptDff === enriched) {
    throw new Error('the enriched script template did not contain "opt_dff -sat; " to remove');
  }
  return withoutOptDff;
}

/** One design's raw timing finding under one pass sequence, or the reason none was derived. */
type RawFindingOutcome =
  | { readonly kind: 'finding'; readonly finding: PrepassTimingFinding }
  | { readonly kind: 'netlist-unavailable'; readonly reason: string };

/**
 * Run one pass sequence over one design and read back the worker's own `_timing_finding`.
 *
 * Reuses `eda._timing_finding` and `eda._top_level_input_bits` directly, through a one-line
 * driver program, rather than re-implementing the cone walk: the walk has exactly one owner
 * (`eda.py`), and this script's job is to vary the PASS SEQUENCE feeding it, not to second-guess
 * what it does with a netlist.
 */
function runPassSequence(
  pythonBin: string,
  scriptTemplate: string,
  rtl: string,
  topModule: string,
): RawFindingOutcome {
  const workspace = mkdtempSync(join(tmpdir(), 'timing-pass-sequence-'));
  try {
    const sourceName = 'd.v';
    writeFileSync(join(workspace, sourceName), rtl, 'utf8');
    const netlistName = 'netlist.json';
    const script = scriptTemplate
      .replaceAll('{sources}', sourceName)
      .replaceAll('{top}', topModule)
      // The worker's own filename constant is not this script's to guess at, so the comparison
      // writes its own fixed name and reads it back under that same name.
      .replace(/write_json\s+\S+;/, `write_json ${netlistName};`);
    const run = spawnSync('yosys', ['-p', script], {
      cwd: workspace,
      encoding: 'utf8',
      env: spawnEnvironment(),
    });
    if (run.error !== undefined || run.status !== 0) {
      return { kind: 'netlist-unavailable', reason: 'yosys run failed or could not be spawned' };
    }
    const program = [
      'import json',
      'from tool_runner_worker import eda',
      `with open(${JSON.stringify(join(workspace, netlistName))}, encoding="utf-8") as handle:`,
      '    netlist = json.load(handle)',
      `module = netlist.get("modules", {}).get(${JSON.stringify(topModule)})`,
      'if not isinstance(module, dict):',
      '    print(json.dumps({"ok": False}))',
      'else:',
      '    input_bits = eda._top_level_input_bits(module)',
      '    finding = eda._timing_finding(module, input_bits)',
      '    print(json.dumps({"ok": True, "finding": finding}))',
    ].join('\n');
    const read = spawnSync(pythonBin, ['-c', program], {
      encoding: 'utf8',
      env: spawnEnvironment(),
    });
    if (read.error !== undefined || read.status !== 0) {
      return { kind: 'netlist-unavailable', reason: 'the netlist could not be read back' };
    }
    const parsed = JSON.parse(read.stdout) as {
      readonly ok: boolean;
      readonly finding?: PrepassTimingFinding;
    };
    if (!parsed.ok || parsed.finding === undefined) {
      return { kind: 'netlist-unavailable', reason: 'the requested top module was not elaborated' };
    }
    return { kind: 'finding', finding: parsed.finding };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

/** One declared output port's classification outcome, flattened for comparison. */
export type PortOutcome =
  | { readonly kind: 'classified'; readonly timing: 'registered' | 'combinational' }
  | { readonly kind: 'refused'; readonly cause: string };

/** Classify every declared output port of `moduleInterface` from one raw finding outcome. */
function classifyAll(
  moduleInterface: ModuleInterface,
  outcome: RawFindingOutcome,
): ReadonlyMap<string, PortOutcome> {
  const outputs = moduleInterface.ports.filter((port) => port.direction === 'output');
  if (outcome.kind === 'netlist-unavailable') {
    const map = new Map<string, PortOutcome>();
    for (const port of outputs)
      map.set(port.name, { kind: 'refused', cause: 'netlist-unavailable' });
    return map;
  }
  const classified: Result<
    { entries: readonly { portName: string; timing: string }[] },
    TimingRefusal
  > = classifyPortTiming(moduleInterface, outcome.finding);
  const map = new Map<string, PortOutcome>();
  if (classified.ok) {
    for (const entry of classified.value.entries) {
      map.set(entry.portName, {
        kind: 'classified',
        timing: entry.timing as 'registered' | 'combinational',
      });
    }
    return map;
  }
  for (const port of classified.error.ports) {
    map.set(port, { kind: 'refused', cause: classified.error.cause });
  }
  // A port the refusal did not name (Req 2.2 says every undetermined port is named, so this is
  // defensive only) still needs an entry, or a silent gap would read as agreement by omission.
  for (const port of outputs) {
    if (!map.has(port.name)) map.set(port.name, { kind: 'refused', cause: classified.error.cause });
  }
  return map;
}

/** One port's disagreement between the two sequences, naming every value a reader needs. */
export interface PassSequenceDisagreement {
  readonly design: string;
  readonly port: string;
  readonly prepAlone: PortOutcome;
  readonly enriched: PortOutcome;
}

function outcomesEqual(a: PortOutcome, b: PortOutcome): boolean {
  if (a.kind === 'classified' && b.kind === 'classified') return a.timing === b.timing;
  if (a.kind === 'refused' && b.kind === 'refused') return a.cause === b.cause;
  return false;
}

/** Compare the two sequences' per-port outcomes for one design, naming every disagreement. */
export function compareDesign(
  design: string,
  moduleInterface: ModuleInterface,
  prepAlone: RawFindingOutcome,
  enriched: RawFindingOutcome,
): readonly PassSequenceDisagreement[] {
  const prepAloneByPort = classifyAll(moduleInterface, prepAlone);
  const enrichedByPort = classifyAll(moduleInterface, enriched);
  const ports = new Set([...prepAloneByPort.keys(), ...enrichedByPort.keys()]);
  const disagreements: PassSequenceDisagreement[] = [];
  for (const port of ports) {
    const a = prepAloneByPort.get(port) ?? { kind: 'refused', cause: 'port-not-reported' };
    const b = enrichedByPort.get(port) ?? { kind: 'refused', cause: 'port-not-reported' };
    if (!outcomesEqual(a, b)) {
      disagreements.push({ design, port, prepAlone: a, enriched: b });
    }
  }
  return disagreements;
}

/** The whole measurement's result. */
export interface PassSequenceEquivalenceReport {
  readonly designsMeasured: number;
  readonly disagreements: readonly PassSequenceDisagreement[];
}

/** Run the comparison over every design of the Derivation_Population. */
export async function runPassSequenceEquivalenceMeasurement(
  pythonBin: string,
): Promise<PassSequenceEquivalenceReport> {
  const corpus = await importRtllmCorpus(
    new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH),
    // No contract is read from the import for this measurement - the comparison classifies its
    // own two raw findings, below - so a FIXED stand-in is used only to keep every design that
    // elaborates OUT of the importer's TIMING_UNDERIVABLE quarantine: a refusing stand-in would
    // exclude every design before a reference is even recorded, leaving nothing to compare.
    new FixedTimingDerivation('registered'),
  );
  const enrichedTemplate = readEnrichedScriptTemplate(pythonBin);
  const prepAloneTemplate = prepAloneScriptTemplate(enrichedTemplate);
  const disagreements: PassSequenceDisagreement[] = [];
  let designsMeasured = 0;
  for (const problem of corpus.problems) {
    if (!inDerivationPopulation(problem.id)) continue;
    const reference = corpus.references.get(problem.id);
    if (reference === undefined) continue;
    const moduleInterface = problem.spec.moduleInterface;
    const prepAlone = runPassSequence(
      pythonBin,
      prepAloneTemplate,
      reference.rtl.contents,
      moduleInterface.moduleName,
    );
    const enriched = runPassSequence(
      pythonBin,
      enrichedTemplate,
      reference.rtl.contents,
      moduleInterface.moduleName,
    );
    designsMeasured += 1;
    disagreements.push(...compareDesign(problem.id, moduleInterface, prepAlone, enriched));
  }
  return { designsMeasured, disagreements };
}

/** Describe one outcome for the console. */
function describeOutcome(outcome: PortOutcome): string {
  return outcome.kind === 'classified' ? outcome.timing : `refused(${outcome.cause})`;
}

async function main(): Promise<void> {
  const pythonBin = process.argv.includes('--python')
    ? (process.argv[process.argv.indexOf('--python') + 1] ?? 'python')
    : 'python';
  const report = await runPassSequenceEquivalenceMeasurement(pythonBin);
  console.log(
    `Pass_Sequence_Equivalence: ${String(report.designsMeasured)} designs measured, ` +
      `${String(report.disagreements.length)} disagreement(s)`,
  );
  for (const d of report.disagreements) {
    console.log(
      `  DISAGREE ${d.design} ${d.port}: prep-alone=${describeOutcome(d.prepAlone)} ` +
        `enriched=${describeOutcome(d.enriched)}`,
    );
  }
  if (report.disagreements.length === 0) {
    console.log('EQUIVALENCE HOLDS: prep alone reproduces the enriched sequence on every port.');
  } else {
    console.log('EQUIVALENCE DOES NOT HOLD: see disagreements above.');
    process.exitCode = 1;
  }
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === `file://${invokedPath}`) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : 'unknown failure';
    console.error(`timing-pass-sequence-equivalence: ${message}`);
    process.exitCode = 1;
  });
}
