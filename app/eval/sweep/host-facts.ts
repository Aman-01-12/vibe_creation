// The host facts a manifest needs, probed rather than assumed.
//
// WHY PROBE INSTEAD OF DECLARE
//   The simulator version is part of what a verdict MEANS: the Stage 0 quarantine exists
//   precisely because Icarus and VCS disagree about several golden testbenches. A manifest
//   that recorded a hardcoded "iverilog 13" would be a claim, not a measurement, and would
//   go stale the first time a host upgraded. So `iverilog -V` and `vvp -V` are actually
//   executed and their first line recorded; a probe that cannot read a version records
//   `null`, which reads as unknown and never as a default.
//
// WHY THE PROBE IS SHARED, NOT COPIED
//   `probeOracleToolchain` in `../gate/measure.ts` already owns "is the Icarus toolchain
//   on PATH", and it is reused here rather than reimplemented, so the sweep and the CI
//   gate can never disagree about whether this host can decide a verdict. What this module
//   adds is what the gate does not need: the VERSION strings, the worker-capable Python
//   interpreter, and the git provenance of the harness itself.
//
// THE DIRTY-TREE PROBE IS THE POINT OF THE GIT SECTION
//   A commit hash alone is misleading when the tree is dirty: it names code that did not
//   produce the result. `git status --porcelain` decides it, and a probe that cannot run
//   git records `null` for both fields rather than claiming a clean tree.
//
// EVERY CHILD PROCESS IS SPAWNED WITHOUT A SHELL, with array arguments and no interpolated
// values, so nothing here can be turned into command injection by a config or an
// environment.

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { WORKER_SOURCE_ROOT } from '@app/tools';

import { binaryPresent, probeOracleToolchain, type OracleToolchainProbe } from '../gate/measure.js';
import type {
  ManifestHarness,
  ManifestHost,
  ManifestToolchain,
  ProbedVersion,
} from './manifest.js';

/** This module's directory, resolved from its module URL. */
const HERE = dirname(fileURLToPath(import.meta.url));

/** Longest version string recorded, so a chatty tool cannot bloat the manifest. */
const MAX_VERSION_CHARS = 200;

/** How long any probe process may run before it is abandoned (ms). */
const PROBE_TIMEOUT_MS = 10_000;

/**
 * Python interpreters to try, most-preferred first.
 *
 * The repo venv per `dev-tooling.md`, then the standard interpreters. This module
 * compiles to `app/eval/dist/sweep/`, and is authored at `app/eval/sweep/`, so the venv
 * sits a different number of levels up in each layout; both are listed rather than
 * guessed, and a candidate that cannot import the worker is simply skipped.
 */
const PYTHON_CANDIDATES: readonly string[] = [
  resolve(HERE, '../../../.venv/bin/python'),
  resolve(HERE, '../../../../.venv/bin/python'),
  'python3',
  'python',
];

/** Run a probe process and return its trimmed stdout+stderr, or null on any failure. */
function probeOutput(bin: string, args: readonly string[]): string | null {
  const result = spawnSync(bin, [...args], {
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
  });
  if (result.error !== undefined) {
    return null;
  }
  const text = `${result.stdout ?? ''}${result.stderr ?? ''}`.trim();
  return text.length === 0 ? null : text;
}

/** The first line of a tool's version output, bounded. */
function firstLine(text: string | null): string | null {
  if (text === null) {
    return null;
  }
  const line = text.split('\n')[0]?.trim() ?? '';
  return line.length === 0 ? null : line.slice(0, MAX_VERSION_CHARS);
}

/**
 * The first Python interpreter that can import the sandbox worker, or null.
 *
 * Returned as the candidate string the caller passes to `LocalWorkerRuntime`. The
 * manifest records only its basename (see `workerPythonLabel`) because a full path names
 * a developer's home directory and answers nothing about reproducibility.
 */
export function findWorkerPython(): string | null {
  for (const candidate of PYTHON_CANDIDATES) {
    const result = spawnSync(candidate, ['-c', 'import tool_runner_worker'], {
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
      env: { ...process.env, PYTHONPATH: WORKER_SOURCE_ROOT },
    });
    if (result.error === undefined && result.status === 0) {
      return candidate;
    }
  }
  return null;
}

/** The manifest label for an interpreter: its basename only, never its full path. */
function workerPythonLabel(pythonBin: string | null): string | null {
  if (pythonBin === null) {
    return null;
  }
  const segments = pythonBin.split('/');
  return segments[segments.length - 1] ?? pythonBin;
}

/** Whether this host can decide a real oracle verdict, and why not when it cannot. */
export interface ToolchainAvailability {
  readonly available: boolean;
  readonly reason: string;
  /** The interpreter to hand `LocalWorkerRuntime`; empty when unavailable. */
  readonly pythonBin: string;
}

/**
 * Probe the host for everything a real verdict needs: iverilog, vvp, and a
 * worker-capable Python.
 *
 * The binary presence check is delegated to the gate's existing probe so there is one
 * definition of "the toolchain is here" in the codebase.
 */
export function probeToolchainAvailability(): ToolchainAvailability {
  const binaries = probeOracleToolchain();
  if (!binaries.available) {
    return { available: false, reason: binaries.reason, pythonBin: '' };
  }
  const pythonBin = findWorkerPython();
  if (pythonBin === null) {
    return {
      available: false,
      reason: 'no Python interpreter can import the tool_runner_worker package',
      pythonBin: '',
    };
  }
  return { available: true, reason: binaries.reason, pythonBin };
}

// -- The FORMAL chain: four binaries, and one COMPOSED INVOCATION -----------------------
//
// This is the one probe here that presence cannot answer, and the reason is MEASURED on this
// machine: `bitwuzla` 0.9.1 is installed and spawnable, and `yosys-smtbmc -s bitwuzla` still
// fails on EVERY input, because Yosys's `smtio.py:229` builds the command
// `bitwuzla --smt2 -i` and 0.9.x rejects both flags - `[error] invalid option '--smt2'`,
// exit 1, no `Status:` line. A presence check passes, every formal run then reports
// `toolchain-unavailable`, and a results table full of those is indistinguishable, from the
// record alone, from a measurement of the designs (Req 11.14, 11.18).
//
// So the composed invocation is checked, and `binaryPresent`'s spawn-error rule is KEPT for
// each binary on its own rather than replaced: a missing `yosys` and a broken solver need
// different fixes, and naming the wrong one wastes an operator's evening.
//
// THIS IS THE SINGLE OWNER OF THAT CHECK. `FORMAL_PROBE` in `app/test/real-oracle-harness.ts`
// - which decides whether the real-toolchain vitest suites skip - calls this function rather
// than keeping its own copy, so a suite that skips and a campaign that refuses can never
// disagree about whether this host can run a proof. What stays on the test side is the part
// that is developer-environment policy (which repo venv to prefer) and the skip message.

/** The solver `yosys-smtbmc` is invoked with. Pinned in the WORKER (`_SOLVER` in `eda.py`). */
const FORMAL_SOLVER = 'bitwuzla';

/**
 * The binaries a formal run needs, with a probe flag for each.
 *
 * `z3` is here because it is the Solver_Cross_Check the worker re-runs any `PROVED`-shaped
 * result under: the bitwuzla path goes through a flag shim we would have written, and the
 * cheapest audit of our own patch is a solver we did not.
 */
const FORMAL_BINARIES: readonly (readonly [bin: string, args: readonly string[]])[] = [
  ['yosys', ['-V']],
  ['yosys-smtbmc', ['--help']],
  [FORMAL_SOLVER, ['--version']],
  ['z3', ['--version']],
];

/**
 * The smallest SMT2 document `yosys-smtbmc` accepts: one stateless module, no assertions.
 *
 * Hand-written rather than produced by a Yosys run, so the check costs one spawn instead of
 * two. It is trivially true, so `Status: PASSED` is the only correct answer and anything else
 * means the composed chain did not work - which is exactly the question being asked. The
 * function names are the ones `yosys-smtbmc` looks up (`_a` assertions, `_u` assumptions,
 * `_i` initial, `_h` hierarchy, `_t` transition).
 */
const FORMAL_PROBE_SMT2 = `; yosys-smt2-module probe
(declare-sort |probe_s| 0)
(declare-fun |probe_is| (|probe_s|) Bool)
(define-fun |probe_a| ((state |probe_s|)) Bool true)
(define-fun |probe_u| ((state |probe_s|)) Bool true)
(define-fun |probe_i| ((state |probe_s|)) Bool true)
(define-fun |probe_h| ((state |probe_s|)) Bool true)
(define-fun |probe_t| ((state |probe_s|) (next_state |probe_s|)) Bool true)
; yosys-smt2-topmod probe
; end of yosys output
`;

/** Why a present-but-broken chain is refused. Named, because it is not "missing". */
const SMTBMC_NOT_INVOCABLE_REASON =
  `yosys-smtbmc -s ${FORMAL_SOLVER} is present but NOT INVOCABLE: the composed invocation ` +
  'reported no `Status:` line (measured here as bitwuzla 0.9.x rejecting the `--smt2` and ' +
  '`-i` flags smtio.py passes it), so every proof attempt would report `toolchain-unavailable`';

/**
 * Whether the COMPOSED `yosys-smtbmc -s <solver>` invocation actually runs, or why not.
 *
 * `null` when it works and the refusal reason otherwise, so a caller reads it exactly the way
 * it reads an absent binary. Never throws: the only honest reading of a probe that could not
 * be run is that the question was not answered, and an unanswered question refuses.
 */
function composedFormalChainRefusal(): string | null {
  let probeDir: string | null = null;
  try {
    probeDir = mkdtempSync(join(tmpdir(), 'formal-invocability-probe-'));
    const smt2Path = join(probeDir, 'probe.smt2');
    writeFileSync(smt2Path, FORMAL_PROBE_SMT2, 'utf8');
    const run = spawnSync('yosys-smtbmc', ['-s', FORMAL_SOLVER, '-t', '1', smt2Path], {
      encoding: 'utf8',
      timeout: PROBE_TIMEOUT_MS,
    });
    if (run.error !== undefined) {
      return 'yosys-smtbmc could not be spawned for the invocability probe';
    }
    const answered = run.status === 0 && (run.stdout ?? '').includes('Status: PASSED');
    return answered ? null : SMTBMC_NOT_INVOCABLE_REASON;
  } catch {
    // Not a silent catch: a temp directory we could not create or write leaves the question
    // unanswered, and an unanswered question is reported as a refusal rather than as a pass.
    return 'the yosys-smtbmc invocability probe could not be run in this environment';
  } finally {
    if (probeDir !== null) {
      rmSync(probeDir, { recursive: true, force: true });
    }
  }
}

/**
 * Whether this host can run a FORMAL proof: every binary present, and the composed
 * `yosys-smtbmc -s bitwuzla` invocation actually invocable (Req 11.14, 11.18).
 *
 * Carries no `pythonBin`: a formal job runs through the same sandbox worker a simulate job
 * does, so the interpreter is already established by `probeToolchainAvailability` above and
 * asking twice would create a second owner of one fact.
 */
export function probeFormalToolchainAvailability(): OracleToolchainProbe {
  for (const [bin, args] of FORMAL_BINARIES) {
    if (!binaryPresent(bin, args)) {
      return { available: false, reason: `${bin} is not installed on PATH` };
    }
  }
  const refusal = composedFormalChainRefusal();
  if (refusal !== null) {
    return { available: false, reason: refusal };
  }
  return {
    available: true,
    reason: `yosys + yosys-smtbmc + ${FORMAL_SOLVER} + z3 are present, and yosys-smtbmc -s ${FORMAL_SOLVER} is invocable`,
  };
}

// -- Formal_Toolchain VERSIONS: a reason for every absence ------------------------------
//
// The yosys 0.69 upgrade changed the vacuous lowering chain, so a run with no yosys version
// cannot be placed on either side of it. An entry reads as a version only when the tool
// answered with one; every other outcome names which fix applies. See design.md C16.

/** An absence with its reason, which is the only honest reading of an unanswered probe. */
function notMeasured(reason: string): ProbedVersion {
  return { kind: 'not-measured', reason };
}

/** A usage banner, which is what a tool with no version flag prints instead. */
const USAGE_LINE_RE = /\busage\b|\[options\]/i;

/** Any digit. A version line carries a number; an error line usually does not. */
const VERSION_NUMBER_RE = /\d/;

/** The yosys git revision, as `yosys -V` spells it. */
const YOSYS_SHA1_RE = /git sha1 ([0-9a-f]{7,40})/;

/** The token a line ends in, which a cut at the length bound may have split. */
const TRAILING_TOKEN_RE = /\S*$/;

/** Why a probe process never ran, read from the spawn error rather than guessed. */
function spawnRefusal(bin: string, error: Error): string {
  const { code } = error as { readonly code?: string };
  if (code === 'ENOENT') {
    return `${bin} is not installed on PATH`;
  }
  if (code === 'ETIMEDOUT') {
    return `${bin} did not answer within ${PROBE_TIMEOUT_MS} ms`;
  }
  return `${bin} could not be spawned`;
}

/**
 * The line with any path-shaped token replaced: a manifest records no filesystem path.
 *
 * Exported because it is the rule, not a detail - a version string reaches the manifest
 * through here, and nothing else in the chain strips a path.
 */
export function withoutFilesystemPaths(line: string): string {
  // The whole token goes, not just the part after the slash, because a relative path's
  // first segment can be a username. A version number is dotted, so none is caught.
  return line.replace(/\S*\/\S*/g, '<path>');
}

/** The first line that carries any text, trimmed, or null when the output is only whitespace. */
function firstNonBlankLine(text: string): string | null {
  const line = text.trimStart().split('\n', 1)[0]?.trim() ?? '';
  return line.length === 0 ? null : line;
}

/**
 * The line cut to the length bound at a whitespace break, so no token survives in part, and
 * empty when its first token alone overruns the bound. Cut before the path strip, which is
 * quadratic on a long token (chipAgent note on Formal_Toolchain version output shapes).
 */
function withinVersionBound(line: string): string {
  if (line.length <= MAX_VERSION_CHARS) {
    return line;
  }
  return line
    .slice(0, MAX_VERSION_CHARS + 1)
    .replace(TRAILING_TOKEN_RE, '')
    .trimEnd();
}

/** The parts of a finished probe process that decide what it reported. */
export interface VersionProbeRun {
  readonly error?: Error | undefined;
  readonly status: number | null;
  /** Null when the process never started, which `spawnSync` returns despite its typing. */
  readonly stdout: string | null;
  readonly stderr: string | null;
}

/**
 * The version a finished probe reports, or the reason it reported none (pure).
 *
 * Never throws, the same rule `composedFormalChainRefusal` follows: a probe that could not
 * be answered is recorded as unanswered rather than crashing a run that was otherwise fine.
 */
export function classifyVersionProbe(bin: string, run: VersionProbeRun): ProbedVersion {
  if (run.error !== undefined) {
    return notMeasured(spawnRefusal(bin, run.error));
  }
  const line = firstNonBlankLine(`${run.stdout ?? ''}${run.stderr ?? ''}`);
  if (line === null) {
    return notMeasured(`${bin} printed nothing`);
  }
  // Every guard below judges the value a read would record, never the raw line.
  const value = withoutFilesystemPaths(withinVersionBound(line));
  if (USAGE_LINE_RE.test(value)) {
    return notMeasured(`${bin} printed usage rather than a version`);
  }
  if (run.status !== 0) {
    // Deliberately stricter than `binaryPresent`, which ignores the exit status: a process
    // that disowned its own output has not answered the question.
    return notMeasured(`${bin} exited ${run.status ?? 'after a signal'} without a version`);
  }
  if (value.length === 0) {
    return notMeasured(
      `${bin} printed a line that opens with a token longer than the ${MAX_VERSION_CHARS}-character bound`,
    );
  }
  if (!VERSION_NUMBER_RE.test(value)) {
    return notMeasured(`${bin} printed no version number`);
  }
  return { kind: 'read', value };
}

/** Spawn a tool's version flag, then classify what came back. */
function probeVersion(bin: string, args: readonly string[]): ProbedVersion {
  const run = spawnSync(bin, [...args], { encoding: 'utf8', timeout: PROBE_TIMEOUT_MS });
  return classifyVersionProbe(bin, run);
}

/** The build identifier beside the yosys release, or why there is none. */
export function yosysBuildIdOf(version: ProbedVersion): ProbedVersion {
  if (version.kind === 'not-measured') {
    return notMeasured('no yosys version was read, so neither was its build identifier');
  }
  const sha1 = YOSYS_SHA1_RE.exec(version.value)?.[1];
  return sha1 === undefined
    ? notMeasured('the yosys version line carries no git sha1')
    : { kind: 'read', value: sha1 };
}

/** Record the EDA tool versions actually installed on this host. */
export function probeToolchainVersions(pythonBin: string | null): ManifestToolchain {
  const yosys = probeVersion('yosys', ['-V']);
  return {
    iverilogVersion: firstLine(probeOutput('iverilog', ['-V'])),
    vvpVersion: firstLine(probeOutput('vvp', ['-V'])),
    workerPython: workerPythonLabel(pythonBin),
    yosysVersion: yosys,
    yosysBuildId: yosysBuildIdOf(yosys),
    yosysSmtBmcVersion: probeVersion('yosys-smtbmc', ['--version']),
    bitwuzlaVersion: probeVersion(FORMAL_SOLVER, ['--version']),
    z3Version: probeVersion('z3', ['--version']),
  };
}

/** The host object that carries platform facts, when the runtime has one. */
interface ProcessHost {
  readonly platform?: string;
  readonly arch?: string;
  readonly version?: string;
}

/**
 * Describe the host as far as reproducibility requires - and no further.
 *
 * No hostname: a machine name identifies a person's laptop and answers nothing the
 * platform, architecture, and runtime version do not already answer.
 */
export function probeHost(): ManifestHost {
  const host = (globalThis as { process?: ProcessHost }).process;
  return {
    platform: host?.platform ?? 'unknown',
    arch: host?.arch ?? 'unknown',
    release: firstLine(probeOutput('uname', ['-r'])) ?? 'unknown',
    runtimeVersion: host?.version ?? 'unknown',
  };
}

/**
 * Probe the harness's own git provenance.
 *
 * Both fields go `null` together when git cannot be read, because a commit without a
 * verified clean/dirty answer is worse than no commit: it invites a reader to assume the
 * code is what the hash says.
 */
export function probeHarnessProvenance(repoRoot: string): ManifestHarness {
  const commit = firstLine(probeOutput('git', ['-C', repoRoot, 'rev-parse', 'HEAD']));
  if (commit === null) {
    return { commit: null, workingTreeDirty: null };
  }
  const status = spawnSync('git', ['-C', repoRoot, 'status', '--porcelain'], {
    encoding: 'utf8',
    timeout: PROBE_TIMEOUT_MS,
  });
  if (status.error !== undefined || status.status !== 0) {
    return { commit, workingTreeDirty: null };
  }
  return { commit, workingTreeDirty: (status.stdout ?? '').trim().length > 0 };
}
