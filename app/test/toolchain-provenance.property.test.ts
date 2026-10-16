// Property 25 over generated probe outputs, run through the pure classification the real
// probe applies after it spawns. The real-host half is toolchain-probe.integration.test.ts,
// and the measured output shapes are the ones design.md, Component C16 records.
//
// A generated case carries no path: paths are built inside the property from labels, so a
// counterexample and every assertion message name a member and a shape, never a path.
//
// The tag is a literal because `propertyTag` in this package hardcodes another spec's slug.
//
// **Validates: Requirements 8.1, 8.3, 8.4, 8.7**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  classifyVersionProbe,
  yosysBuildIdOf,
  type ProbedVersion,
  type VersionProbeRun,
} from '@app/eval';

import { propertyParameters } from './property.js';

// Feature: formal-gate-first-light, Property 25: Toolchain provenance is complete, reasoned, and path-free
const PROPERTY =
  'formal-gate-first-light, Property 25: Toolchain provenance is complete, reasoned, and path-free';

/** Each member meets each shape in about 1 of 21 draws, so 1000 leaves no cell to luck. */
const NUM_RUNS = 1000;

/** The Formal_Toolchain, as design.md C16 names it. */
const MEMBERS = ['yosys', 'yosys-smtbmc', 'bitwuzla', 'z3'] as const;

type Member = (typeof MEMBERS)[number];

// -- Measured output, verbatim -------------------------------------------------

const MEASURED_YOSYS_SHA1 = '143eb14f9cc55d6f8927e68523b0c9d2166ed02c';

const MEASURED_YOSYS_LINE = `Yosys 0.69+post (git sha1 ${MEASURED_YOSYS_SHA1}, Release, AppleClang clang++ 21.0.0.21000334)`;

const MEASURED_Z3_LINE = 'Z3 version 4.15.4 - 64 bit';

/** The first lines `yosys-smtbmc --version` prints, on stdout, before it exits 1. */
const MEASURED_SMTBMC_USAGE = 'yosys-smtbmc [options] <yosys_smt2_output>\n    -h, --help\n';

// -- Pools ---------------------------------------------------------------------

/** smtbmc's banner, `bitwuzla --help` as measured, and z3's usage line. */
const USAGE_BANNERS = [
  MEASURED_SMTBMC_USAGE,
  'Usage:\n  bitwuzla [<options>] [<input>]\n',
  'Usage: z3 [options] [-file:]file\n',
] as const;

/** Lines with no digit; the first is what `yosys -h` prints first, as measured. */
const NO_DIGIT_LINES = [
  'Yosys Open SYnthesis Suite',
  'version unknown',
  'development snapshot',
] as const;

/** What a yosys release line carries after its git field, in three real build styles. */
const YOSYS_BUILDS = [
  'Release, AppleClang clang++ 21.0.0.21000334',
  'clang 14.0.0 -fPIC -Os',
  'gcc 11.4.0-1ubuntu1~22.04 -fPIC -O3',
] as const;

/** Path segments no version text contains, so finding one in a record is a leak. */
const USERNAMES = ['alice', 'jdoe'] as const;

/** `usage-stats` reads as a usage banner to any guard that judges the path, not the record. */
const DIRECTORIES = ['buildroot', 'toolchains', 'stage1', 'build42', 'usage-stats'] as const;

/** Directories carrying a digit, for a line whose only digits sit inside its path. */
const DIGIT_DIRECTORIES = ['stage1', 'build42'] as const;

/** Wider than any plausible bound on a recorded line, so a line this long is always cut. */
const MAX_PADDING = 1000;

// -- Shapes --------------------------------------------------------------------

const SPAWN_SHAPES = [
  'spawn-ENOENT',
  'spawn-ETIMEDOUT',
  'spawn-EACCES',
  'spawn-EPERM',
  'spawn-ENOBUFS',
  'spawn-uncoded',
] as const;

const PATH_SHAPES = [
  'path-absolute',
  'path-relative',
  'path-home-relative',
  'path-username-first',
] as const;

const SHAPES = [
  ...SPAWN_SHAPES,
  'empty',
  'whitespace-only',
  'usage-only',
  'no-digit',
  'non-zero-exit',
  'well-formed',
  'blank-line-before',
  'measured',
  ...PATH_SHAPES,
  'digits-only-in-path',
  'overlong-unbroken',
  'arbitrary',
] as const;

type Shape = (typeof SHAPES)[number];

type PathShape = (typeof PATH_SHAPES)[number];

// -- Generated cases, which carry no path -------------------------------------

interface Release {
  readonly major: number;
  readonly minor: number;
  readonly patch: number;
  readonly suffix: string;
  /** `unknown` is how a tarball build fills the git field; `absent` prints no field at all. */
  readonly revision: 'hex' | 'unknown' | 'absent';
  readonly hex: string;
  readonly build: number;
}

interface PathChoice {
  /** The path's form; the path shapes fix their own, and only the digits-only shape reads it. */
  readonly shape: PathShape;
  readonly placement: 'prefix' | 'suffix';
  readonly user: number;
  readonly first: number;
  readonly second: number;
}

interface ProbeCase {
  readonly shape: Shape;
  readonly stream: 'stdout' | 'stderr';
  readonly exit: number | null;
  readonly release: Release;
  readonly pick: number;
  readonly path: PathChoice;
  readonly whitespace: string;
  readonly noise: readonly [string, string];
}

type ProbeSet = Readonly<Record<Member, ProbeCase>>;

const EXIT_ZERO: fc.Arbitrary<number | null> = fc.constant(0);

/** Non-zero statuses, and `null` for a process a signal ended. */
const EXIT_NON_ZERO: fc.Arbitrary<number | null> = fc.constantFrom(1, 2, 127, 255, null);

const EXIT_ANY = fc.oneof(EXIT_ZERO, EXIT_NON_ZERO);

/** A shape whose point is its line exits 0, so no earlier guard decides it. */
function exitFor(shape: Shape): fc.Arbitrary<number | null> {
  if (shape === 'non-zero-exit') {
    return EXIT_NON_ZERO;
  }
  const decidedByItsLine: readonly Shape[] = [
    'no-digit',
    'well-formed',
    'blank-line-before',
    'digits-only-in-path',
    'overlong-unbroken',
    ...PATH_SHAPES,
  ];
  return decidedByItsLine.includes(shape) ? EXIT_ZERO : EXIT_ANY;
}

const releaseArbitrary: fc.Arbitrary<Release> = fc.record({
  major: fc.nat({ max: 30 }),
  minor: fc.nat({ max: 99 }),
  patch: fc.nat({ max: 99 }),
  suffix: fc.constantFrom('', '+post', '+12'),
  revision: fc.constantFrom('hex', 'unknown', 'absent'),
  hex: fc.string({ unit: fc.constantFrom(...'0123456789abcdef'), minLength: 7, maxLength: 40 }),
  build: fc.nat(),
});

const pathChoiceArbitrary: fc.Arbitrary<PathChoice> = fc.record({
  shape: fc.constantFrom(...PATH_SHAPES),
  placement: fc.constantFrom('prefix', 'suffix'),
  user: fc.nat(),
  first: fc.nat(),
  second: fc.nat(),
});

function caseArbitrary(shape: Shape): fc.Arbitrary<ProbeCase> {
  return fc.record({
    shape: fc.constant(shape),
    stream: fc.constantFrom('stdout', 'stderr'),
    exit: exitFor(shape),
    release: releaseArbitrary,
    pick: fc.nat(),
    path: pathChoiceArbitrary,
    whitespace: fc.string({
      unit: fc.constantFrom(' ', '\t', '\n', '\r', '\v', '\f'),
      minLength: 1,
      maxLength: 8,
    }),
    noise: fc.tuple(
      fc.string({ unit: 'grapheme', maxLength: 40 }),
      fc.string({ unit: 'grapheme', maxLength: 40 }),
    ),
  });
}

const anyCase = fc.oneof(...SHAPES.map(caseArbitrary));

/** One probe output per member, every shape equally likely for each. */
const probeSetArbitrary: fc.Arbitrary<ProbeSet> = fc.record({
  yosys: anyCase,
  'yosys-smtbmc': anyCase,
  bitwuzla: anyCase,
  z3: anyCase,
});

// -- Materialization: the run, and what its record must then hold -------------

/** The arm a shape calls for; a read records its version, or exactly its line when clean. */
type Expectation =
  | { readonly arm: 'not-measured' }
  | { readonly arm: 'read'; readonly version: string; readonly line: string | null }
  | { readonly arm: 'unconstrained' };

interface Segment {
  readonly role: 'username' | 'directory';
  readonly name: string;
}

interface ProbeOutput {
  readonly run: VersionProbeRun;
  readonly expectation: Expectation;
  /** The path segments the output carries, none of which a record may hold. */
  readonly segments: readonly Segment[];
  /** The git revision the printed yosys release line carries, or null. */
  readonly sha1: string | null;
}

const NOT_MEASURED: Expectation = { arm: 'not-measured' };

/** The pool entry an index lands on, wrapping so any generated index is valid. */
function pick<T>(pool: readonly [T, ...T[]], index: number): T {
  return pool[index % pool.length] ?? pool[0];
}

interface ReleaseLine {
  readonly line: string;
  readonly version: string;
  readonly sha1: string | null;
}

function yosysLineOf(release: Release): ReleaseLine {
  const version = `${release.major}.${release.minor}${release.suffix}`;
  const field = {
    hex: `git sha1 ${release.hex}, `,
    unknown: 'git sha1 UNKNOWN, ',
    absent: '',
  }[release.revision];
  return {
    line: `Yosys ${version} (${field}${pick(YOSYS_BUILDS, release.build)})`,
    version,
    sha1: release.revision === 'hex' ? release.hex : null,
  };
}

/** A well-formed line in each tool's measured style; smtbmc's is hypothetical, it has none. */
function releaseLineOf(member: Member, release: Release): ReleaseLine {
  const dotted = `${release.major}.${release.minor}`;
  const full = `${dotted}.${release.patch}`;
  switch (member) {
    case 'yosys':
      return yosysLineOf(release);
    case 'yosys-smtbmc':
      return { line: `yosys-smtbmc ${dotted}${release.suffix}`, version: dotted, sha1: null };
    case 'bitwuzla':
      return { line: full, version: full, sha1: null };
    case 'z3':
      return { line: `Z3 version ${full} - 64 bit`, version: full, sha1: null };
  }
}

interface PathText {
  readonly text: string;
  readonly segments: readonly Segment[];
}

function pathOf(
  shape: PathShape,
  choice: PathChoice,
  directories: readonly [string, ...string[]] = DIRECTORIES,
): PathText {
  const user: Segment = { role: 'username', name: pick(USERNAMES, choice.user) };
  const first: Segment = { role: 'directory', name: pick(directories, choice.first) };
  const second: Segment = { role: 'directory', name: pick(DIRECTORIES, choice.second) };
  switch (shape) {
    case 'path-absolute':
      return {
        text: `/Users/${user.name}/${first.name}/${second.name}`,
        segments: [user, first, second],
      };
    case 'path-relative':
      return { text: `${first.name}/${second.name}`, segments: [first, second] };
    case 'path-home-relative':
      return { text: `~/${first.name}/${second.name}`, segments: [first, second] };
    case 'path-username-first':
      return { text: `${user.name}/${first.name}`, segments: [user, first] };
  }
}

function withPath(line: string, path: string, placement: PathChoice['placement']): string {
  return placement === 'prefix' ? `${path}: ${line}` : `${line} (${path})`;
}

/** The run of a process that printed `text` on one stream and exited with the case's status. */
function printed(text: string, probe: ProbeCase): VersionProbeRun {
  return probe.stream === 'stdout'
    ? { status: probe.exit, stdout: text, stderr: '' }
    : { status: probe.exit, stdout: '', stderr: text };
}

function unread(run: VersionProbeRun): ProbeOutput {
  return { run, expectation: NOT_MEASURED, segments: [], sha1: null };
}

/** A binary that never started printed nothing; a killed or overflowed one may have. */
function spawnFailure(code: string | null, member: Member, probe: ProbeCase): ProbeOutput {
  const error = Object.assign(new Error('spawn failed'), code === null ? {} : { code });
  const started = code === 'ETIMEDOUT' || code === 'ENOBUFS';
  const release = releaseLineOf(member, probe.release);
  const output = started
    ? printed(`${release.line}\n`, probe)
    : { status: probe.exit, stdout: null, stderr: null };
  return {
    run: { ...output, error },
    expectation: NOT_MEASURED,
    segments: [],
    sha1: started ? release.sha1 : null,
  };
}

function releaseOutput(
  member: Member,
  probe: ProbeCase,
  arm: 'read' | 'not-measured',
  before = '',
): ProbeOutput {
  const release = releaseLineOf(member, probe.release);
  return {
    run: printed(`${before}${release.line}\n`, probe),
    expectation:
      arm === 'read' ? { arm, version: release.version, line: release.line } : NOT_MEASURED,
    segments: [],
    sha1: release.sha1,
  };
}

function pathBearing(shape: PathShape, member: Member, probe: ProbeCase): ProbeOutput {
  const release = releaseLineOf(member, probe.release);
  const path = pathOf(shape, probe.path);
  return {
    run: printed(`${withPath(release.line, path.text, probe.path.placement)}\n`, probe),
    expectation: { arm: 'read', version: release.version, line: null },
    segments: path.segments,
    sha1: release.sha1,
  };
}

/** A line reporting no version, whose only digits sit inside a path it mentions. */
function digitsOnlyInPath(probe: ProbeCase): ProbeOutput {
  const path = pathOf(probe.path.shape, probe.path, DIGIT_DIRECTORIES);
  const line = withPath(pick(NO_DIGIT_LINES, probe.pick), path.text, probe.path.placement);
  return { ...unread(printed(`${line}\n`, probe)), segments: path.segments };
}

/** A release line run together into one token too long for any bound, so none of it fits. */
function overlongUnbroken(member: Member, probe: ProbeCase): ProbeOutput {
  const release = releaseLineOf(member, probe.release);
  const token = `${release.line.replace(/\s/g, '_')}_${'x'.repeat(MAX_PADDING)}`;
  return unread(printed(`${token}\n`, probe));
}

const MEASURED: Readonly<Record<Member, ProbeOutput>> = {
  yosys: {
    run: { status: 0, stdout: `${MEASURED_YOSYS_LINE}\n`, stderr: '' },
    expectation: { arm: 'read', version: '0.69+post', line: MEASURED_YOSYS_LINE },
    segments: [],
    sha1: MEASURED_YOSYS_SHA1,
  },
  // The designed-for case: usage on stdout, exit 1, stderr empty.
  'yosys-smtbmc': unread({ status: 1, stdout: MEASURED_SMTBMC_USAGE, stderr: '' }),
  bitwuzla: {
    run: { status: 0, stdout: '0.9.1\n', stderr: '' },
    expectation: { arm: 'read', version: '0.9.1', line: '0.9.1' },
    segments: [],
    sha1: null,
  },
  z3: {
    run: { status: 0, stdout: `${MEASURED_Z3_LINE}\n`, stderr: '' },
    expectation: { arm: 'read', version: '4.15.4', line: MEASURED_Z3_LINE },
    segments: [],
    sha1: null,
  },
};

/** Total over the shapes, so a new shape cannot be drawn without saying what it obliges. */
const OUTPUT_OF: Readonly<Record<Shape, (member: Member, probe: ProbeCase) => ProbeOutput>> = {
  'spawn-ENOENT': (member, probe) => spawnFailure('ENOENT', member, probe),
  'spawn-ETIMEDOUT': (member, probe) => spawnFailure('ETIMEDOUT', member, probe),
  'spawn-EACCES': (member, probe) => spawnFailure('EACCES', member, probe),
  'spawn-EPERM': (member, probe) => spawnFailure('EPERM', member, probe),
  'spawn-ENOBUFS': (member, probe) => spawnFailure('ENOBUFS', member, probe),
  'spawn-uncoded': (member, probe) => spawnFailure(null, member, probe),
  // Both streams empty, or both absent as a process that never started reports them.
  empty: (_member, probe) =>
    unread(
      probe.stream === 'stdout'
        ? { status: probe.exit, stdout: '', stderr: '' }
        : { status: probe.exit, stdout: null, stderr: null },
    ),
  'whitespace-only': (_member, probe) => unread(printed(probe.whitespace, probe)),
  'usage-only': (_member, probe) => unread(printed(pick(USAGE_BANNERS, probe.pick), probe)),
  'no-digit': (_member, probe) => unread(printed(`${pick(NO_DIGIT_LINES, probe.pick)}\n`, probe)),
  'non-zero-exit': (member, probe) => releaseOutput(member, probe, 'not-measured'),
  'well-formed': (member, probe) => releaseOutput(member, probe, 'read'),
  // Whitespace, then a line break, so the first line is blank and the version is on the next.
  'blank-line-before': (member, probe) =>
    releaseOutput(member, probe, 'read', `${probe.whitespace}\n`),
  measured: (member) => MEASURED[member],
  'path-absolute': (member, probe) => pathBearing('path-absolute', member, probe),
  'path-relative': (member, probe) => pathBearing('path-relative', member, probe),
  'path-home-relative': (member, probe) => pathBearing('path-home-relative', member, probe),
  'path-username-first': (member, probe) => pathBearing('path-username-first', member, probe),
  'digits-only-in-path': (_member, probe) => digitsOnlyInPath(probe),
  'overlong-unbroken': (member, probe) => overlongUnbroken(member, probe),
  arbitrary: (_member, probe) => ({
    run: { status: probe.exit, stdout: probe.noise[0], stderr: probe.noise[1] },
    expectation: { arm: 'unconstrained' },
    segments: [],
    sha1: null,
  }),
};

// -- Probing a set, and the cells a run must cover -----------------------------

interface ProbedMember {
  readonly member: Member;
  readonly shape: Shape;
  readonly output: ProbeOutput;
  readonly entry: ProbedVersion;
}

interface ProbedSet {
  readonly yosys: ProbedMember;
  readonly members: readonly ProbedMember[];
  readonly buildId: ProbedVersion;
}

function probedMember(member: Member, probe: ProbeCase): ProbedMember {
  const output = OUTPUT_OF[probe.shape](member, probe);
  return { member, shape: probe.shape, output, entry: classifyVersionProbe(member, output.run) };
}

/** Classify every member, and derive the build identifier the way the manifest does. */
function probeAll(set: ProbeSet): ProbedSet {
  const yosys = probedMember('yosys', set.yosys);
  const others = (['yosys-smtbmc', 'bitwuzla', 'z3'] as const).map((member) =>
    probedMember(member, set[member]),
  );
  return { yosys, members: [yosys, ...others], buildId: yosysBuildIdOf(yosys.entry) };
}

const BUILD_ID_CELLS = [
  'yosys release read with a git sha1',
  'yosys release read without one',
  'yosys release not read',
] as const;

function buildIdCellOf({ expectation, sha1 }: ProbeOutput): string | null {
  if (expectation.arm === 'unconstrained') {
    return null;
  }
  if (expectation.arm === 'not-measured') {
    return BUILD_ID_CELLS[2];
  }
  return sha1 === null ? BUILD_ID_CELLS[1] : BUILD_ID_CELLS[0];
}

const EVERY_CELL: readonly string[] = [
  ...MEMBERS.flatMap((member) => SHAPES.map((shape) => `${member} ${shape}`)),
  ...BUILD_ID_CELLS,
];

/** Run `check` over generated sets, then fail if any member/shape cell went undrawn. */
function assertOverProbeSets(check: (probed: ProbedSet) => void): void {
  const seen = new Set<string>();
  fc.assert(
    fc.property(probeSetArbitrary, (set) => {
      // Classification runs here, so a throw fails the property like a false assertion.
      const probed = probeAll(set);
      for (const { member, shape } of probed.members) {
        seen.add(`${member} ${shape}`);
      }
      const buildIdCell = buildIdCellOf(probed.yosys.output);
      if (buildIdCell !== null) {
        seen.add(buildIdCell);
      }
      check(probed);
    }),
    propertyParameters({ numRuns: NUM_RUNS }),
  );
  expect(
    EVERY_CELL.filter((cell) => !seen.has(cell)),
    'cells no draw exercised',
  ).toEqual([]);
}

/** One of the two arms, carrying a non-empty value or a non-empty reason. */
function isWellFormed(entry: ProbedVersion): boolean {
  const payload = entry.kind === 'read' ? entry.value : entry.reason;
  return (
    (entry.kind === 'read' || entry.kind === 'not-measured') &&
    typeof payload === 'string' &&
    payload.trim().length > 0
  );
}

// -- Property 25 ---------------------------------------------------------------

/** The first entry of every pool, for the deterministic row below. */
const FIRST_PATH_CHOICE: PathChoice = {
  shape: 'path-username-first',
  placement: 'suffix',
  user: 0,
  first: 0,
  second: 0,
};

describe(PROPERTY, () => {
  it('records a well-formed entry for every member, and never throws', () => {
    assertOverProbeSets(({ members, buildId }) => {
      for (const { member, shape, entry } of members) {
        expect(isWellFormed(entry), `${member} ${shape}`).toBe(true);
      }
      expect(isWellFormed(buildId), 'yosys build identifier').toBe(true);
    });
  });

  it('lands each output on the arm its shape calls for, recording the version it printed', () => {
    assertOverProbeSets(({ members }) => {
      for (const { member, shape, output, entry } of members) {
        const { expectation } = output;
        if (expectation.arm === 'unconstrained') {
          continue;
        }
        expect(entry.kind, `${member} ${shape}`).toBe(expectation.arm);
        if (expectation.arm === 'read' && entry.kind === 'read') {
          const recorded =
            expectation.line === null
              ? entry.value.includes(expectation.version)
              : entry.value === expectation.line;
          expect(recorded, `${member} ${shape} recorded other than the version it printed`).toBe(
            true,
          );
        }
      }
    });
  });

  it('records no fragment of a filesystem path in any read value', () => {
    assertOverProbeSets(({ members }) => {
      for (const { member, shape, output, entry } of members) {
        if (entry.kind !== 'read') {
          continue;
        }
        const leaked = output.segments.filter(({ name }) => entry.value.includes(name));
        expect(
          leaked.map(({ role }) => role),
          `${member} ${shape}`,
        ).toEqual([]);
        expect(entry.value.includes('/'), `${member} ${shape} kept a slash`).toBe(false);
      }
    });
  });

  it('records a read value only when it carries a version number', () => {
    assertOverProbeSets(({ members }) => {
      for (const { member, shape, entry } of members) {
        if (entry.kind === 'read') {
          expect(/\d/.test(entry.value), `${member} ${shape} recorded no digit`).toBe(true);
        }
      }
    });
  });

  it('records the yosys build identifier exactly when the read release line carries a sha1', () => {
    assertOverProbeSets(({ yosys, buildId }) => {
      const { expectation, sha1 } = yosys.output;
      if (expectation.arm === 'unconstrained') {
        return;
      }
      const expected = expectation.arm === 'read' ? sha1 : null;
      expect(buildId.kind === 'read' ? buildId.value : null, `yosys ${yosys.shape}`).toBe(expected);
    });
  });

  it('leaves no path segment behind wherever the length bound cuts the line', () => {
    const leaks: string[] = [];
    const lost: string[] = [];
    let boundReached = false;
    for (const shape of PATH_SHAPES) {
      const path = pathOf(shape, FIRST_PATH_CHOICE);
      for (let padding = 0; padding <= MAX_PADDING; padding += 1) {
        const line = `${MEASURED_Z3_LINE} ${'x'.repeat(padding)} ${path.text}`;
        const entry = classifyVersionProbe('z3', { status: 0, stdout: `${line}\n`, stderr: '' });
        const value = entry.kind === 'read' ? entry.value : '';
        // A cut must still keep the whole version tokens the line opens with.
        if (!value.startsWith(MEASURED_Z3_LINE)) {
          lost.push(`${shape} after ${padding} padding characters`);
        }
        // Keeping less than the line minus its path means the bound cut the line.
        boundReached ||= value.length < line.length - path.text.length;
        // A segment cut short at the bound is still a fragment of the path.
        const tail = value.slice(value.lastIndexOf(' ') + 1);
        if (
          path.segments.some(
            ({ name }) => value.includes(name) || (tail.length > 0 && name.startsWith(tail)),
          )
        ) {
          leaks.push(`${shape} after ${padding} padding characters`);
        }
      }
    }
    expect(boundReached, 'no line was long enough to reach the length bound').toBe(true);
    expect(lost, 'lines whose version the cut did not keep').toEqual([]);
    expect(leaks).toEqual([]);
  });
});
