// formal-property-oracle, task 12.9: the pinned versions, the stale-schema advice, the two v10
// filenames, and `sweepConfigHash`'s arity and call sites.
//
// WHY THESE LIVE TOGETHER IN app/test
//   The pinned constants live in three packages - `FORMAL_ORACLE_VERSION` in `@app/agent`, the
//   two schema versions in `@app/eval`, and the Warm_Up_Ceiling and the shape check in
//   `@app/tools` - and `app/test` is the one layer the import boundary lets read them all. They
//   are read through the package exports, which resolve to `dist/`, so run `npx tsc -b` first:
//   an unbuilt bump is invisible here, and that has produced a false green.
//
// WHAT IS PINNED ELSEWHERE, AND NOT REPEATED
//   - The fold-in of `FORMAL_ORACLE_VERSION` into the identity and the manifest is Property 27,
//     in `formal-config-identity.property.test.ts`.
//   - `results-log.test.ts` pins `RESULTS_SCHEMA_VERSION` 13 and the advice's WORDS. The
//     version is repeated below on purpose, so this spec's three versions fail side by side, and
//     the advice is held here to the STATEMENT Req 12.13 requires rather than to its words.
//   - Which files one sample's directory holds is pinned end to end - the capture through the
//     store, across all three deciding verdicts - in `app/eval/sweep/artifact-store-node.test.ts`.
//     This file pins the NAMES those files are written under.
//
// Every assertion's core takes its subject as a parameter - a value, a filename record, or a
// source text - so it can be shown to fail on a wrong subject without editing a shared file.
//
// Validates: Requirements 12.1, 12.4, 12.9, 12.13, 12.14, 12.15, 12.16, 13.8, 13.19

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { FORMAL_ORACLE_VERSION } from '@app/agent';
import type { ModuleInterface } from '@app/core';
import {
  ARTIFACT_DOCUMENT_SCHEMA_VERSION,
  ARTIFACT_FILENAMES,
  RESULTS_SCHEMA_VERSION,
  STALE_SCHEMA_ADVICE,
  sweepConfigHash,
} from '@app/eval';
import {
  MAX_WARM_UP_DEPTH,
  propertyShapeRejection,
  renderPropertyWrapper,
  validateExpression,
  type FormalProperty,
  type ResetContract,
  type ValidatedExpression,
} from '@app/tools';

/** The repository root, against which every source path here is keyed. */
const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** The `app/` directory, the root the call-site scan walks. */
const APP_ROOT = join(REPOSITORY_ROOT, 'app');

/** The module that owns the Formal_Oracle_Version. */
const FORMAL_ORACLE_VERSION_MODULE = 'app/agent/orchestrator/formal-oracle-version.ts';

/** The module that owns `sweepConfigHash`. */
const CONFIG_IDENTITY_MODULE = 'app/eval/sweep/config-identity.ts';

/** The sweep CLI, the one production caller of `sweepConfigHash`. */
const CLI_MODULE = 'app/eval/sweep/cli.ts';

/** One source file's text, by its repository-relative path. */
function sourceOf(repositoryPath: string): string {
  return readFileSync(join(REPOSITORY_ROOT, repositoryPath), 'utf8');
}

/**
 * Assert a version module declares `FORMAL_ORACLE_VERSION` as a bare integer literal and imports
 * nothing (Req 12.1).
 *
 * Req 12.1's "distinct from" the four sibling identities is a claim no value pin can check: a
 * sibling can hold the same value, so an alias of it passes the value pin above until one of the
 * two moves. A module with no import cannot alias a sibling, and its constant is a one-line edit.
 */
function expectOwnLiteralConstant(source: string): void {
  expect(source).toMatch(/^export const FORMAL_ORACLE_VERSION = \d+;$/m);
  expect(source).not.toMatch(/^import\b/m);
}

/** Put a pinned expression through the sole constructor of the brand, or fail loudly. */
function validatedOrThrow(text: string): ValidatedExpression {
  const result = validateExpression(text);
  if (!result.ok) {
    throw new Error(`pinned expression is outside the accepted dialect: ${text}`);
  }
  return result.value;
}

/** A combinational property carrying `consequent`, read by the shape check and the assume co-pin. */
function combinational(consequent: string): FormalProperty {
  return {
    kind: 'combinational',
    id: 'pinned',
    criterionRef: '13.19',
    consequent: validatedOrThrow(consequent),
  };
}

/** The wrapper name is caller-owned and no model output reaches it; one fixed value suffices. */
const WRAPPER_NAME = 'formal_property_wrapper';

/**
 * The enable-gated design the co-pinned assume is rendered over, with both nets as input ports.
 *
 * The assume names the enable, so the wrapper has to declare it: an undeclared net is one Yosys
 * declares implicitly and only warns about.
 */
const ENABLE_GATED_INTERFACE: ModuleInterface = {
  validityOutputName: null,
  moduleName: 'LIFObuffer',
  ports: [
    { name: 'EN', direction: 'input', width: 1 },
    { name: 'out', direction: 'output', width: 4 },
  ],
  clocking: { clockName: 'Clk', resetName: 'Rst', resetActiveLow: false },
};

/**
 * The contract `LIFObuffer`'s seven `$sdffce` reset cells derive: a synchronous active-high reset
 * that fires only while `EN` is asserted high.
 */
const ENABLE_GATED_CONTRACT: ResetContract = {
  derived: true,
  resetName: 'Rst',
  resetActiveLow: false,
  resetKind: 'sync',
  initialStateFree: true,
  resetEnable: { name: 'EN', activeLow: false },
};

/** The line version 3 emits for that contract; version 2 emitted `(!$initstate || Rst)`. */
const ENABLE_GATED_ASSUME = '  assume property (!$initstate || (Rst && EN));\n';

describe('formal-property-oracle: the pinned versions (Req 12.1, 12.9, 12.14)', () => {
  it('pins FORMAL_ORACLE_VERSION at 4', () => {
    // Version 4 exempts the Cover_Check's audit where the Base_Check failed, which moves a
    // refutation out of `could-not-verify`. A bump records its `WHY n -> n+1` section in the
    // version module and moves the two pinned config hashes, so this pin moves with them
    // deliberately.
    expect(FORMAL_ORACLE_VERSION).toBe(4);
  });

  it('emits the enable-gated reset assume version 3 names, beside the version that moves with it', () => {
    // Co-pinned here rather than only in `formal-reset-assume-polarity.property.test.ts`, because
    // widening or narrowing this assume changes what a `proved` verdict means and is therefore a
    // Formal_Oracle_Version move (criterion 4.18 of formal-gate-first-light). It sits next to the
    // line that has to move with it so neither can move alone: dropping the enable renders the
    // version-2 line and fails here, which is the measured difference between `could-not-verify`
    // and `proved` on `LIFObuffer`.
    const rendered = renderPropertyWrapper(
      ENABLE_GATED_INTERFACE,
      combinational('out == 0'),
      WRAPPER_NAME,
      ENABLE_GATED_CONTRACT,
    );

    expect(rendered).toContain(ENABLE_GATED_ASSUME);
  });

  it('pins MAX_WARM_UP_DEPTH at 18, beside the version the ceiling moves with', () => {
    // Co-pinned here rather than only where it is derived, because moving the ceiling - directly,
    // or by moving the first clocked rung or the Clocked_Check_Delay it is derived from - changes
    // which properties the gate expresses, which is a Formal_Oracle_Version move (Req 13.8). This
    // sits next to the line that has to move with it so neither can move alone.
    expect(MAX_WARM_UP_DEPTH).toBe(18);
  });

  it('declares FORMAL_ORACLE_VERSION as its own literal, never as an alias of a sibling identity', () => {
    expectOwnLiteralConstant(sourceOf(FORMAL_ORACLE_VERSION_MODULE));
  });

  it('pins RESULTS_SCHEMA_VERSION at 17', () => {
    // The refusal is `schemaVersion !== RESULTS_SCHEMA_VERSION`, so this number IS the gate that
    // keeps a v12 record, which carries no formal field, out of an aggregate.
    expect(RESULTS_SCHEMA_VERSION).toBe(17);
  });

  it('pins ARTIFACT_DOCUMENT_SCHEMA_VERSION at 10', () => {
    // v10 is the document that carries the wrapper, the assertion count, and the counterexample
    // reference; a v9 document carries none of the three.
    expect(ARTIFACT_DOCUMENT_SCHEMA_VERSION).toBe(10);
  });
});

/**
 * The refused set's edge: which combinational consequents `propertyShapeRejection` refuses, and
 * by which function name, with `null` for the ones it accepts.
 *
 * Four rows rather than a sampled property, because these are the two refusals and the two
 * acceptances immediately beside them - a `$past` with no depth argument reads as depth 1 and is
 * refused, a `$stable` is refused outright, while `$past(d, 0)` reaches back across no boundary
 * and `$rose` is `$past`-derived but still EMITTED. Widening or narrowing the refused set moves a
 * row here, beside the version line it has to move with (Req 13.19).
 */
const PINNED_SHAPE_REFUSALS: readonly (readonly [string, string | null])[] = [
  ['$past(d)', '$past'],
  ['$stable(d)', '$stable'],
  ['$past(d, 0) == d', null],
  ['$rose(d)', null],
];

describe('formal-property-oracle: the combinational shapes refused by name (Req 13.19)', () => {
  it.each(PINNED_SHAPE_REFUSALS)('reads %s as the pinned outcome', (consequent, refusedAs) => {
    const rejection = propertyShapeRejection(combinational(consequent));

    if (refusedAs === null) {
      expect(rejection).toBeNull();
      return;
    }
    // The construct is NAMED, because the Property_Author reports the criterion unexpressed and
    // can only say which construct cost it if the refusal carries one (Req 6.7).
    expect(rejection?.reason).toBe('unaccepted-construct');
    expect(rejection?.reason === 'unaccepted-construct' ? rejection.construct : '').toContain(
      refusedAs,
    );
  });
});

/**
 * The two facts Req 12.13 requires the stale-schema advice to STATE, each matched as the claim it
 * makes, so advice naming the formal fields while saying something else about them fails.
 */
const REQUIRED_ADVICE_STATEMENTS: Readonly<Record<string, RegExp>> = Object.freeze({
  'a formal verdict, its conditions, and a fallback reason are now recorded':
    /\ba formal verdict, its conditions, and a fallback reason are now recorded\b/i,
  'a fresh output directory is required': /\bre-run the campaign into a fresh outputDir\b/i,
});

/** The required statements an advice text does not make; empty when it makes them all. */
function missingAdviceStatements(advice: readonly string[]): readonly string[] {
  // Joined with a space, so a statement wrapped across two lines still reads whole.
  const text = advice.join(' ');
  return Object.entries(REQUIRED_ADVICE_STATEMENTS)
    .filter(([, statement]) => !statement.test(text))
    .map(([fact]) => fact);
}

describe('formal-property-oracle: the stale-schema advice (Req 12.13)', () => {
  it('states that the formal facts are now recorded and that a fresh output directory is required', () => {
    expect(missingAdviceStatements(STALE_SCHEMA_ADVICE)).toEqual([]);
  });
});

/** A filename for every key the artifact layout names, so a wrong name can be handed in. */
type ArtifactFilenames = Readonly<Record<keyof typeof ARTIFACT_FILENAMES, string>>;

/** A filename as a case-insensitive filesystem compares it, which is the default on macOS. */
function folded(filename: string): string {
  return filename.toLowerCase();
}

/** Every pair of layout keys whose filenames name one file on a case-insensitive filesystem. */
function collidingKeys(filenames: Readonly<Record<string, string>>): readonly string[] {
  const entries = Object.entries(filenames);
  return entries.flatMap(([key, name], index) =>
    entries
      .slice(index + 1)
      .filter(([, other]) => folded(other) === folded(name))
      .map(([otherKey]) => `${key} = ${otherKey}`),
  );
}

/**
 * Assert the wrapper's filename is its own, reading every comparison off `filenames` rather than
 * off a list, so a file the layout gains later is compared too (Req 12.15).
 *
 * No two captured files share a name, which covers `candidate.v` and every testbench-shaped name
 * at once, and also means the trace can neither overwrite a sibling nor be overwritten by one.
 * The wrapper's name must not even READ as a testbench, because it is the formal instrument and
 * neither of those; "testbench-shaped" is anchored on `testbench.v` so it cannot quietly empty.
 */
function expectWrapperNamedApart(filenames: ArtifactFilenames): void {
  expect(collidingKeys(filenames)).toEqual([]);
  const testbenchShaped = Object.values(filenames)
    .map(folded)
    .filter((name) => name.includes('testbench'));
  expect(testbenchShaped).toContain(folded(filenames.testbench));
  expect(testbenchShaped).not.toContain(folded(filenames.propertyWrapper));
}

describe('formal-property-oracle: the two v10 captured filenames (Req 12.15, 12.16)', () => {
  it('writes the wrapper to property-wrapper.v and the trace to counterexample.vcd', () => {
    // The names the v10 document comment and design.md give these files; a reader looks for them.
    expect(ARTIFACT_FILENAMES.propertyWrapper).toBe('property-wrapper.v');
    expect(ARTIFACT_FILENAMES.counterexampleTrace).toBe('counterexample.vcd');
  });

  it("gives the wrapper a name of its own: not the candidate's, not testbench-shaped, and no other file's", () => {
    expectWrapperNamedApart(ARTIFACT_FILENAMES);
  });
});

// WHAT THE CALL-SITE SCAN CANNOT SEE
//   It matches the name followed by `(` in the text of every script file under `app/`, outside
//   build output, installed packages, dot-directories, test files, and the `app/test` package.
//   So it does not see:
//   - a call that never spells the name before its parenthesis: an alias, a renamed import,
//     `.call`/`.apply`/`.bind`, a computed member access, or a dynamic import;
//   - any file outside that scope: `scripts/`, `dist/`, `node_modules/`, and tests. Tests are left
//     out deliberately: their calls exercise the function rather than depend on it, this spec
//     legitimately added some, and pinning their count would pin nothing Req 12.4 is about;
//   - a call's ARGUMENTS, which the type system holds against the declaration pinned below.
//   A comment or a string spelling the call form counts as a call, so for anything that spells
//   the name the scan errs toward a false red rather than a false green.

/** The call form the scan counts: the name, optional whitespace, then an opening parenthesis. */
const CALL_FORM = /\bsweepConfigHash\s*\(/g;

/**
 * `sweepConfigHash`'s declaration, exactly: two typed parameters and nothing after them.
 *
 * Pinned from source because `.length` cannot see a defaulted third parameter -
 * `(config, digest, version = FORMAL_ORACLE_VERSION)` still has length 2 - and that is precisely
 * the shape threading the version through the signature would take.
 */
const PINNED_DECLARATION =
  'export function sweepConfigHash(config: SweepConfig, digest: DigestHex): string {';

/**
 * Every production file spelling the call form, and how often: the CLI's one call,
 * `sweepConfigHash(config, sha256Hex)`, and the declaration itself, which the scan counts by the
 * same form. The same two files and counts the tree held before the version fold-in.
 */
const PINNED_CALL_SITES: Readonly<Record<string, number>> = Object.freeze({
  [CLI_MODULE]: 1,
  [CONFIG_IDENTITY_MODULE]: 1,
});

/** Directories the scan never descends into: build output and installed packages. */
const UNSCANNED_DIRECTORIES: ReadonlySet<string> = new Set(['dist', 'node_modules']);

/** A JavaScript or TypeScript source file, by its extension. */
const SCRIPT_FILE = /\.[cm]?[jt]sx?$/;

/** A test file, whose calls exercise the function rather than depend on it. */
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** The test package, every file of which is test support rather than production. */
const TEST_PACKAGE_PREFIX = 'app/test/';

/** A path relative to the repository root, with `/` separators on every platform. */
function repositoryPathOf(path: string): string {
  return relative(REPOSITORY_ROOT, path).split(sep).join('/');
}

/** Every script file under `directory`, skipping build output, installs, and dot-directories. */
function scriptFilesUnder(directory: string): readonly string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      const skipped = UNSCANNED_DIRECTORIES.has(entry.name) || entry.name.startsWith('.');
      return skipped ? [] : scriptFilesUnder(path);
    }
    return SCRIPT_FILE.test(entry.name) ? [path] : [];
  });
}

/** Every production source under `app/`, keyed by its repository-relative path. */
function productionSources(): ReadonlyMap<string, string> {
  const sources = new Map<string, string>();
  for (const path of scriptFilesUnder(APP_ROOT)) {
    const key = repositoryPathOf(path);
    if (!TEST_FILE.test(key) && !key.startsWith(TEST_PACKAGE_PREFIX)) {
      sources.set(key, readFileSync(path, 'utf8'));
    }
  }
  return sources;
}

/** Per file, how many times the call form occurs; a file with none is omitted. */
function callSitesIn(sources: ReadonlyMap<string, string>): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const [path, text] of sources) {
    const found = text.match(CALL_FORM)?.length ?? 0;
    if (found > 0) {
      counts[path] = found;
    }
  }
  return counts;
}

/** How many times `needle` occurs in `text`, non-overlapping. */
function occurrencesOf(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe('formal-property-oracle: sweepConfigHash keeps its signature and its call sites (Req 12.4)', () => {
  it('takes exactly two parameters at runtime', () => {
    expect(sweepConfigHash.length).toBe(2);
  });

  it('is declared once, with two typed parameters and nothing defaulted after them', () => {
    expect(occurrencesOf(sourceOf(CONFIG_IDENTITY_MODULE), PINNED_DECLARATION)).toBe(1);
  });

  it('is called from exactly the production call sites it had before the version fold-in', () => {
    expect(callSitesIn(productionSources())).toEqual(PINNED_CALL_SITES);
  });

  it('reports one call inserted into a copy of a scanned file, so the pin above can fail', () => {
    // GIVEN the real tree, with ONE extra call appended to an in-memory copy of the CLI's source
    // and no file on disk touched ...
    const sources = productionSources();
    const cli = sources.get(CLI_MODULE);
    expect(cli, `${CLI_MODULE} was not scanned`).toBeDefined();
    const inserted = new Map(sources).set(
      CLI_MODULE,
      `${cli ?? ''}\nconst again = sweepConfigHash(config, sha256Hex);\n`,
    );
    const before = callSitesIn(sources);

    // ... THEN the scan reports that file exactly one higher, and every other file unchanged.
    expect(callSitesIn(inserted)).toEqual({
      ...before,
      [CLI_MODULE]: (before[CLI_MODULE] ?? 0) + 1,
    });
  });
});
