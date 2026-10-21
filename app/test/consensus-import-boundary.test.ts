// The consensus barrel's transitive import closure never reaches @app/eval, and stays inside
// what @app/agent's own header permits (task 5.1; Req 17.2).
//
// WHY A GREP IS NOT ENOUGH
//   `app/agent/orchestrator/instrument-admission.ts` names `@app/eval` on four comment lines and
//   `app/agent/model-router/index.ts` on one, so a text search for the package reports five
//   violations that do not exist. This walk reads only RUNTIME specifiers: it blanks every comment
//   and string first (the same `codeOf` discipline `app/tools/formal/structural-claims.test.ts`
//   established), then extracts the specifier of every `import` or `export ... from` line that
//   `verbatimModuleSyntax` does not erase - which rules out `import type` and `export type` the
//   same way that file's `runtimeImportsOf` already does for plain imports. A barrel's re-exports
//   (`export * from './agreement.js';`) carry no `import` keyword at all, so a scanner limited to
//   `import` lines would see this barrel as a closure of one and nothing beyond it.
//
// WHY A FRESH WALKER, NOT `runtimeImportsOf` ITSELF
//   That helper reads one file's own text; nothing in `structural-claims.test.ts` resolves a
//   specifier to a file on disk or recurses. This module adds exactly that: resolve a relative
//   specifier against its importing file's directory, swap its `.js` extension for the `.ts` the
//   compiler actually reads, and walk until nothing new is reached. A package specifier (anything
//   not starting with `.` or `..`, e.g. `@app/core`) is collected and never followed - there is no
//   file on this disk literally named `@app/core`.
//
// EVERY CHECK HAS A POSITIVE CONTROL, same reason `structural-claims.test.ts` states it: a walker
// that visited nothing would otherwise report a clean closure too.

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** This file's directory, for resolving the fixed paths below. */
const HERE = dirname(fileURLToPath(import.meta.url));

/** The walk's start, and the file whose header comment states what `@app/agent` may import. */
const CONSENSUS_BARREL = resolvePath(HERE, '../agent/consensus/index.ts');
const AGENT_INDEX = resolvePath(HERE, '../agent/index.ts');

/**
 * One token a scan must not look inside: a comment, or a string or template literal.
 *
 * Mirrors `app/tools/formal/structural-claims.test.ts`'s `LEXICAL_TOKEN`: one alternation scanned
 * left to right, so whichever opens first wins. Not a TypeScript lexer - see that file's own
 * caveat about regex literals and nested template interpolation, which does not occur here either.
 */
const LEXICAL_TOKEN =
  /\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\[\s\S])*`/g;

/** Whether a token is a comment: the only tokens that open with a slash. */
function isComment(token: string): boolean {
  return token.startsWith('/');
}

/** `source` with every comment blanked to spaces and every newline kept, so line numbers line up. */
function codeOf(source: string): string {
  return source.replace(LEXICAL_TOKEN, (token) =>
    isComment(token) ? token.replace(/[^\n]/g, ' ') : token,
  );
}

/**
 * Every RUNTIME specifier a line-leading `import` or `export ... from` names in already-blanked
 * `code`, in source order.
 *
 * Extends `structural-claims.test.ts`'s `runtimeImportsOf` rule (every line-leading `import`
 * except `import type`, because `verbatimModuleSyntax` erases those) to `export ... from` too,
 * excluded the same way by `export type`: a barrel re-exports its modules with `export * from`,
 * never with `import`, so a rule that only matched `import` would see every barrel as a dead end.
 */
function runtimeSpecifiersOf(code: string): readonly string[] {
  return [...code.matchAll(/^(?:import|export)(?!\s+type\b)[^;]*?\sfrom\s*['"]([^'"]+)['"]/gm)].map(
    (match) => match[1] ?? '',
  );
}

/** Whether a specifier names a relative file (`./...` or `../...`) rather than a package. */
function isRelative(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

/**
 * Resolve a relative specifier the way `NodeNext` resolution reads it at runtime, back to the
 * `.ts` file the compiler actually type-checks: every relative specifier in this codebase names
 * its compiled `.js` extension (`verbatimModuleSyntax` requires one explicitly), so swapping the
 * extension is resolution, not a guess.
 */
function resolveRelativeSpecifier(fromFile: string, specifier: string): string {
  const tsSpecifier = specifier.endsWith('.js') ? `${specifier.slice(0, -3)}.ts` : specifier;
  return resolvePath(dirname(fromFile), tsSpecifier);
}

/** The result of walking one file's transitive relative-import closure. */
interface ClosureWalk {
  /** Every file visited, this file included. */
  readonly files: ReadonlySet<string>;
  /** Every package specifier (non-relative) reached from any visited file. */
  readonly packages: ReadonlySet<string>;
}

/**
 * Walk `entryFile`'s transitive closure of RELATIVE imports, collecting every file visited and
 * every package specifier reached from any of them.
 *
 * `readSource` defaults to the real file on disk; a test may override it for exactly one path to
 * drive a positive control through this same walk, in-memory, the way
 * `structural-claims.test.ts`'s `insertAfter` feeds a modified string back through its own scan
 * function rather than writing to the real file.
 */
function walkClosure(
  entryFile: string,
  readSource: (file: string) => string = (file) => readFileSync(file, 'utf8'),
): ClosureWalk {
  const files = new Set<string>();
  const packages = new Set<string>();
  const queue: string[] = [entryFile];

  while (queue.length > 0) {
    const file = queue.pop();
    if (file === undefined || files.has(file)) {
      continue;
    }
    files.add(file);

    for (const specifier of runtimeSpecifiersOf(codeOf(readSource(file)))) {
      if (isRelative(specifier)) {
        queue.push(resolveRelativeSpecifier(file, specifier));
      } else {
        packages.add(specifier);
      }
    }
  }

  return { files, packages };
}

/**
 * `source` with `inserted` placed right after `anchor`, for a positive control. Mirrors
 * `structural-claims.test.ts`'s `insertAfter`: throws unless the anchor occurs exactly once, so a
 * control cannot silently insert nothing.
 */
function insertAfter(source: string, anchor: string, inserted: string): string {
  const parts = source.split(anchor);
  if (parts.length !== 2) {
    throw new Error(`a positive control's anchor must occur exactly once: ${anchor}`);
  }
  return parts.join(`${anchor}${inserted}`);
}

/** The `@app/...` package names `@app/agent`'s own header comment says it may import. */
function packagesAgentMayImport(): readonly string[] {
  const headerLine = readFileSync(AGENT_INDEX, 'utf8')
    .split('\n')
    .find((line) => line.includes('may import'));
  if (headerLine === undefined) {
    throw new Error(`${AGENT_INDEX} no longer states which packages @app/agent may import`);
  }
  return [...headerLine.matchAll(/@app\/\w+/g)].map((match) => match[0]);
}

/** The consensus module filenames the barrel itself re-exports, read off its own export lines. */
function consensusModulesNamedByTheBarrel(): readonly string[] {
  const exported = [
    ...codeOf(readFileSync(CONSENSUS_BARREL, 'utf8')).matchAll(
      /^export \* from '\.\/([\w-]+)\.js';$/gm,
    ),
  ].map((match) => `${match[1] ?? ''}.ts`);
  if (exported.length === 0) {
    throw new Error(`${CONSENSUS_BARREL} no longer re-exports any sibling module`);
  }
  return exported;
}

describe('the consensus barrel reaches no @app/eval module (Req 17.2)', () => {
  // WHAT THIS CANNOT SEE. A specifier assembled at runtime from fragments. A package reached only
  // through a TYPE import/export, which `verbatimModuleSyntax` erases before anything runs - the
  // same reason `structural-claims.test.ts` excludes `import type`. A cycle back into `consensus`
  // from deeper in `@app/agent` would simply be revisited and skipped, not mistaken for a dead end.

  it('walks a non-empty closure that names the real sibling modules, not a vacuous visit', () => {
    const { files } = walkClosure(CONSENSUS_BARREL);
    const visitedNames = [...files].map((file) => file.slice(file.lastIndexOf('/') + 1));

    expect(files.size).toBeGreaterThan(0);
    expect(visitedNames).toEqual(expect.arrayContaining([...consensusModulesNamedByTheBarrel()]));
    // The walk also recurses PAST the consensus directory itself (into `../model-router/index.js`
    // and everything it re-exports), which is the difference between following imports and only
    // reading the one file this suite started from.
    expect(files.size).toBeGreaterThan(consensusModulesNamedByTheBarrel().length + 1);
  });

  it('reaches no @app/eval package, and stays inside what @app/agent may import', () => {
    const { packages } = walkClosure(CONSENSUS_BARREL);
    const allowed = packagesAgentMayImport();
    const disallowed = [...packages].filter((specifier) => !allowed.includes(specifier));

    expect(packages.has('@app/eval')).toBe(false);
    expect(disallowed).toEqual([]);
  });

  it('reports an inserted @app/eval import, so the walk is not one that would pass on nothing', () => {
    const agreementPath = resolvePath(HERE, '../agent/consensus/agreement.ts');
    const realSource = readFileSync(agreementPath, 'utf8');
    const violating = insertAfter(
      realSource,
      "import type { Ulid } from '@app/core';\n",
      "import { violatesTheBoundary } from '@app/eval';\n",
    );

    const { packages } = walkClosure(CONSENSUS_BARREL, (file) =>
      file === agreementPath ? violating : readFileSync(file, 'utf8'),
    );

    expect(packages.has('@app/eval')).toBe(true);
  });
});

/**
 * The six model-free consensus modules Req 15.6 names: C8's data model, C8's executor (task 8.1),
 * C9's reducer, C10's clustering, C11's vote, and C13's attributor. Each is a root in its own
 * right here, not a file reached from the barrel - `walkClosure` starts fresh from each path.
 *
 * The Run_Matrix executor holds a simulator and no router, which is the same claim this suite
 * already makes for the other five: none of them can spend a token because none of them can
 * reach the thing that spends one.
 *
 * `structural-gate-toolchain`'s task 5.1 adds the Structural_Gate_Adapter (C8) as a seventh root:
 * it holds a `ToolRunner`, a `SimulatorAdapter`, and a `LintAdapter`, none of which can reach the
 * router either.
 */
const MODEL_FREE_ROOTS: readonly string[] = [
  resolvePath(HERE, '../agent/consensus/run-matrix.ts'),
  resolvePath(HERE, '../agent/consensus/run-matrix-executor.ts'),
  resolvePath(HERE, '../agent/consensus/trust-vote.ts'),
  resolvePath(HERE, '../agent/consensus/fault-attributor.ts'),
  resolvePath(HERE, '../agent/consensus/signature.ts'),
  resolvePath(HERE, '../agent/consensus/agreement.ts'),
  // Added by structural-gate-toolchain task 5.1: a gate that could reach the model router could
  // spend tokens admitting a Candidate_Design, so this is held to the same structural fact.
  resolvePath(HERE, '../agent/consensus/structural-gate-adapter.ts'),
];

/** Whether a visited file's path sits under `app/agent/model-router/`. */
function isModelRouterFile(file: string): boolean {
  return file.includes('/agent/model-router/');
}

describe('the five model-free consensus modules reach no model router (Req 15.6)', () => {
  // None of these five can spend a token, because none of them can reach the thing that spends
  // one: this walk makes that a structural fact about the import graph rather than something only
  // a runtime trace would show.

  it.each(MODEL_FREE_ROOTS)('%s reaches no file under app/agent/model-router/', (root) => {
    const { files } = walkClosure(root);
    const routerFiles = [...files].filter(isModelRouterFile);

    expect(routerFiles).toEqual([]);
  });

  it('reports a model-router file in the visited set, so the walk is not one that would pass on nothing', () => {
    const agreementPath = resolvePath(HERE, '../agent/consensus/agreement.ts');
    const realSource = readFileSync(agreementPath, 'utf8');
    const violating = insertAfter(
      realSource,
      "import type { Ulid } from '@app/core';\n",
      "import { createRouter } from '../model-router/create-router.js';\n",
    );

    const { files } = walkClosure(agreementPath, (file) =>
      file === agreementPath ? violating : readFileSync(file, 'utf8'),
    );

    expect([...files].some(isModelRouterFile)).toBe(true);
  });
});

/**
 * The Structural_Gate_Adapter (task 5.1) and the Lint_Adapter it composes (task 4.4) spawn
 * nothing: every tool invocation goes through the injected `ToolRunner` or `SimulatorAdapter`
 * (Req 9.1, 9.2). This reads SOURCE TEXT rather than behaviour, because the claim is "no path to
 * `child_process` exists in these files at all", which a scripted test double cannot show on its
 * own - a double answers what the adapter DOES with the port it was given, not whether a second,
 * unused path to the host exists beside it.
 */
describe('the Structural_Gate_Adapter and the Lint_Adapter spawn nothing directly (Req 9.1, 9.2)', () => {
  const structuralGateAdapterPath = resolvePath(
    HERE,
    '../agent/consensus/structural-gate-adapter.ts',
  );
  const lintDir = resolvePath(HERE, '../tools/lint');

  /** The `.ts` source files in `app/tools/lint/`, non-test files only. */
  function lintAdapterFiles(): readonly string[] {
    return readdirSync(lintDir)
      .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
      .map((name) => resolvePath(lintDir, name));
  }

  it('names no node:child_process specifier, in either file set', () => {
    const files = [structuralGateAdapterPath, ...lintAdapterFiles()];
    const violators = files
      .map((file) => ({
        file,
        specifiers: runtimeSpecifiersOf(codeOf(readFileSync(file, 'utf8'))),
      }))
      .filter(({ specifiers }) => specifiers.includes('node:child_process'));

    expect(violators).toEqual([]);
  });

  it('reports an inserted node:child_process import, so the scan is not one that would pass on nothing', () => {
    const realSource = readFileSync(structuralGateAdapterPath, 'utf8');
    const violating = insertAfter(
      realSource,
      "import type { ModuleInterface, Spec } from '@app/core';\n",
      "import { spawn } from 'node:child_process';\n",
    );

    expect(runtimeSpecifiersOf(codeOf(violating))).toContain('node:child_process');
  });
});
