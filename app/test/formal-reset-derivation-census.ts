// formal-gate-first-light, Component 20: the reset-cell census, read off the elaborated netlist.
//
// WHY THE SCRIPT AND THE BOUNDS COME FROM THE WORKER AND NOT FROM HERE
//   The census has to read the SAME netlist the pre-pass reads, or it would describe a different
//   elaboration than the one that derived the contract. So the driver asks the worker interpreter
//   for `YOSYS_PREPASS_SCRIPT`, the netlist filename and `MAX_PREPASS_NETLIST_BYTES` rather than
//   restating any of them. A restated script is the one way this measurement could confidently
//   describe a netlist nobody proved over.
//
// THE PARAMETER NAME DECIDES, NOT THE CELL TYPE
//   A reset entry is any cell carrying `ARST_POLARITY` or `SRST_POLARITY`, which is the worker's
//   own rule. It keeps two measured near-misses out structurally: `$aldff` carries
//   `ALOAD_POLARITY`, an async LOAD, and `$dlatch` carries `EN_POLARITY`. Neither is a reset, and
//   a cell-type whitelist would have to be kept up to date to exclude them.
//
// POLARITY IS PARSED, NEVER COMPARED AS A STRING
//   Yosys prints a polarity as a binary string whose WIDTH IS NOT STABLE: the worker records
//   `ARST_POLARITY` 0 printing as 32 characters after `prep`, and `SRST_POLARITY` 1 as
//   `"00000000000000000000000000000001"` after `opt_dff -sat`. So every value here goes through
//   base-2 parsing, and an unreadable one fails the census rather than defaulting to zero.
//
// NO CREDENTIAL REACHES EITHER SPAWN
//   Both the interpreter probe and the `yosys` run take `projectWorkerEnvironment(process.env).env`,
//   the same closed allowlist the sandbox worker is spawned under, so neither inherits the host
//   environment.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { projectWorkerEnvironment, WORKER_SOURCE_ROOT } from '@app/tools';
import type { SourceFile } from '@app/tools';

import type { ResetCellEntry } from './formal-reset-derivation-classify.js';

/** The worker constants this census runs from, read from the worker and never restated. */
export interface WorkerPrepassConstants {
  readonly script: string;
  readonly netlistFilename: string;
  readonly maxNetlistBytes: number;
}

/** Why a census could not be taken. A refusal is never a census of zero cells. */
export type CensusRefusal =
  | 'worker-constants-unreadable'
  | 'yosys-run-failed'
  | 'netlist-over-bound'
  | 'netlist-shape-unreadable';

/** A census, or the named reason there is none. */
export type CensusResult =
  | { readonly kind: 'taken'; readonly cells: readonly ResetCellEntry[] }
  | { readonly kind: 'refused'; readonly reason: CensusRefusal };

/** The closed environment both spawns run under; no credential can reach generated Verilog. */
function spawnEnvironment(): Record<string, string> {
  return {
    ...projectWorkerEnvironment(process.env).env,
    PYTHONPATH: WORKER_SOURCE_ROOT,
  };
}

/**
 * Ask the worker interpreter for its own pre-pass constants.
 *
 * The netlist filename is module-private in the worker, which is exactly why it is READ rather
 * than copied: a private name is one nobody guarantees, so a copy here could silently describe a
 * file the worker stopped writing.
 */
export function readWorkerPrepassConstants(pythonBin: string): WorkerPrepassConstants | null {
  const program = [
    'import json',
    'from tool_runner_worker import eda',
    'print(json.dumps({',
    '  "script": eda.YOSYS_PREPASS_SCRIPT,',
    '  "netlistFilename": eda._PREPASS_NETLIST_FILENAME,',
    '  "maxNetlistBytes": eda.MAX_PREPASS_NETLIST_BYTES,',
    '}))',
  ].join('\n');
  const run = spawnSync(pythonBin, ['-c', program], {
    encoding: 'utf8',
    env: spawnEnvironment(),
  });
  if (run.error !== undefined || run.status !== 0) {
    return null;
  }
  try {
    const raw: unknown = JSON.parse(run.stdout);
    if (typeof raw !== 'object' || raw === null) {
      return null;
    }
    const { script, netlistFilename, maxNetlistBytes } = raw as Record<string, unknown>;
    if (
      typeof script !== 'string' ||
      typeof netlistFilename !== 'string' ||
      typeof maxNetlistBytes !== 'number'
    ) {
      return null;
    }
    return { script, netlistFilename, maxNetlistBytes };
  } catch {
    return null;
  }
}

/** The two parameter names that mark a reset, and the connection each one names. */
const RESET_PARAMETERS: readonly (readonly [string, string])[] = [
  ['ARST_POLARITY', 'ARST'],
  ['SRST_POLARITY', 'SRST'],
];

/** One Yosys bit: a number for a driven net, a string for a constant. */
type NetlistBit = number | string;

/** A base-2 parameter value, or `null` where it cannot be read exactly. */
function polarityOf(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) ? value : null;
  }
  if (typeof value !== 'string' || !/^[01]+$/.test(value)) {
    return null;
  }
  const parsed = Number.parseInt(value, 2);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

/** Bit id to net name, built from the module's own `netnames`. */
function netNamesByBit(netnames: unknown): ReadonlyMap<number, string> {
  const byBit = new Map<number, string>();
  if (typeof netnames !== 'object' || netnames === null) {
    return byBit;
  }
  for (const [name, entry] of Object.entries(netnames as Record<string, unknown>)) {
    const bits = (entry as { bits?: unknown }).bits;
    if (!Array.isArray(bits)) {
      continue;
    }
    for (const bit of bits as NetlistBit[]) {
      // First declaration wins, so a net aliased later does not rename an earlier one.
      if (typeof bit === 'number' && !byBit.has(bit)) {
        byBit.set(bit, name);
      }
    }
  }
  return byBit;
}

/** The net one connection resolves to, and whether every bit of it is a constant. */
function resolveConnection(
  connection: unknown,
  byBit: ReadonlyMap<number, string>,
): { readonly net: string | null; readonly isConstant: boolean } {
  if (!Array.isArray(connection) || connection.length === 0) {
    return { net: null, isConstant: false };
  }
  const bits = connection as NetlistBit[];
  const isConstant = bits.every((bit) => typeof bit === 'string');
  const first = bits.at(0);
  const net =
    typeof first === 'number' ? (byBit.get(first) ?? `bit${String(first)}`) : String(first);
  return { net, isConstant };
}

/**
 * Every reset-carrying cell in one Yosys `write_json` netlist.
 *
 * `null` where the shape cannot be read, which FAILS the measurement rather than reporting an
 * empty census: a census of zero cells and an unreadable netlist would otherwise classify the
 * same way, and only one of them is a finding.
 */
export function censusFromNetlist(netlistJson: string): readonly ResetCellEntry[] | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(netlistJson);
  } catch {
    return null;
  }
  const modules = (parsed as { modules?: unknown }).modules;
  if (typeof modules !== 'object' || modules === null) {
    return null;
  }
  const entries: ResetCellEntry[] = [];
  for (const module of Object.values(modules as Record<string, unknown>)) {
    const cells = (module as { cells?: unknown }).cells;
    const byBit = netNamesByBit((module as { netnames?: unknown }).netnames);
    if (typeof cells !== 'object' || cells === null) {
      continue;
    }
    for (const cell of Object.values(cells as Record<string, unknown>)) {
      const cellType = (cell as { type?: unknown }).type;
      const parameters = (cell as { parameters?: unknown }).parameters;
      const connections = (cell as { connections?: unknown }).connections;
      if (typeof cellType !== 'string' || typeof parameters !== 'object' || parameters === null) {
        continue;
      }
      const params = parameters as Record<string, unknown>;
      for (const [polarityName, resetConnection] of RESET_PARAMETERS) {
        if (!(polarityName in params)) {
          continue;
        }
        const resetPolarity = polarityOf(params[polarityName]);
        if (resetPolarity === null) {
          // An unreadable polarity is not a zero; it fails the census.
          return null;
        }
        const conns = (connections ?? {}) as Record<string, unknown>;
        const reset = resolveConnection(conns[resetConnection], byBit);
        const enable = resolveConnection(conns.EN, byBit);
        entries.push({
          cellType,
          resetNet: reset.net ?? 'unconnected',
          resetPolarity,
          enableNet: enable.net,
          enablePolarity: 'EN_POLARITY' in params ? polarityOf(params.EN_POLARITY) : null,
          enableIsConstant: enable.net !== null && enable.isConstant,
        });
      }
    }
  }
  return entries;
}

/** Take the census for one design, through the worker's own script and bounds. */
export function takeResetCellCensus(
  design: SourceFile,
  topModule: string,
  constants: WorkerPrepassConstants,
): CensusResult {
  const workspace = mkdtempSync(join(tmpdir(), 'reset-census-'));
  try {
    const sourceName = design.path;
    writeFileSync(join(workspace, sourceName), design.contents, 'utf8');
    const script = constants.script
      .replaceAll('{sources}', sourceName)
      .replaceAll('{top}', topModule);
    const run = spawnSync('yosys', ['-p', script], {
      cwd: workspace,
      encoding: 'utf8',
      env: spawnEnvironment(),
    });
    if (run.error !== undefined || run.status !== 0) {
      return { kind: 'refused', reason: 'yosys-run-failed' };
    }
    const netlistPath = join(workspace, constants.netlistFilename);
    if (statSync(netlistPath).size > constants.maxNetlistBytes) {
      // The worker's own bound, so a netlist it would refuse is refused here too.
      return { kind: 'refused', reason: 'netlist-over-bound' };
    }
    const cells = censusFromNetlist(readFileSync(netlistPath, 'utf8'));
    return cells === null
      ? { kind: 'refused', reason: 'netlist-shape-unreadable' }
      : { kind: 'taken', cells };
  } catch {
    // A missing netlist, an unreadable workspace: either way no census was taken.
    return { kind: 'refused', reason: 'netlist-shape-unreadable' };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}
