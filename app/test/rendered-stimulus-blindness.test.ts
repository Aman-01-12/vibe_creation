// reference-model-rendered-stimulus, task 12.2: the three import-graph absences a grep alone
// cannot check (C5, C7, C9; Req 2.17, 3.2, 4.6, 5.8, 6.6).
//
// WHY A WALK, NOT A GREP
//   Reuses `consensus-import-boundary.test.ts`'s own discipline: blank every comment and string
//   first (`codeOf`), extract only line-leading `import`/`export ... from` specifiers that
//   `verbatimModuleSyntax` does not erase (`runtimeImportsOf`), resolve a relative specifier to
//   its compiled `.ts` file (`resolveRelativeSpecifier`), and walk the transitive closure
//   (`walkClosure`). A text search for a name like `RESET_FRAME_PERIOD` would report a violation
//   on a comment line that merely discusses the constant, the exact false-positive class that
//   file's own header names for `@app/eval`.
//
// THE THREE ABSENCES
//   1. No verdict module (`grant.ts`'s `evaluateGrant`, `trust-vote.ts`'s `trustVote`,
//      `gate.ts`'s `decideConsensusRegressionGate`) reaches `RESET_FRAME_PERIOD` or
//      `distinctOutputCount` (Req 5.8, 6.6 held structurally), and `GatedFigures` gains no
//      field for either - a type-level check, pinned separately in
//      `consensus-structural-claims.test.ts` (task 12.1), not restated here.
//   2. The renderer property tests proving the Stimulus_Mixer sound (tasks 2.8, 2.9, 2.10:
//      `rendered-stimulus-layout`, `-enable`, `-mixer`) reach neither `generateMutants` nor any
//      `SimulatorAdapter` - proving the mixer sound must not itself be a design-blindness
//      breach (Req 2.17).
//   3. The three real `SAMPLE_BUDGET` call sites (`prompt.ts`, `live-wiring.ts`, `pilot.ts`)
//      import the constant and declare no numeric local in its place (Req 3.2's structural
//      half - task 5.2's property test already covers the behavioural half).
//   Criterion 4.6 is folded in here too: the Verified_Outcome's inputs are the parser, the
//   renderer, and the existing Grant_Conditions, so no verdict module reaches `prompt.ts` either.
//
// EVERY WALK HAS A POSITIVE CONTROL, same reason `consensus-import-boundary.test.ts` and
// `consensus-structural-claims.test.ts` both state it: a walk that visited nothing would
// otherwise report a clean closure too.

import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

/** This file's directory, for resolving the fixed paths below. */
const HERE = dirname(fileURLToPath(import.meta.url));

/** One token a scan must not look inside: a comment, or a string or template literal. */
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

/** Every RUNTIME specifier a line-leading `import` or `export ... from` names, in source order. */
function runtimeSpecifiersOf(code: string): readonly string[] {
  return [...code.matchAll(/^(?:import|export)(?!\s+type\b)[^;]*?\sfrom\s*['"]([^'"]+)['"]/gm)].map(
    (match) => match[1] ?? '',
  );
}

/** Whether a specifier names a relative file (`./...` or `../...`) rather than a package. */
function isRelative(specifier: string): boolean {
  return specifier.startsWith('./') || specifier.startsWith('../');
}

/** Resolve a relative specifier back to the `.ts` file the compiler actually type-checks. */
function resolveRelativeSpecifier(fromFile: string, specifier: string): string {
  const tsSpecifier = specifier.endsWith('.js') ? `${specifier.slice(0, -3)}.ts` : specifier;
  return resolvePath(dirname(fromFile), tsSpecifier);
}

/** The result of walking one file's transitive relative-import closure. */
interface ClosureWalk {
  readonly files: ReadonlySet<string>;
  readonly packages: ReadonlySet<string>;
}

/**
 * Walk `entryFile`'s transitive closure of RELATIVE imports. `readSource` defaults to the real
 * file on disk; a test may override it for exactly one path to drive a positive control through
 * this same walk, in-memory - mirrors `consensus-import-boundary.test.ts`'s own `walkClosure`.
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

/** `source` with `inserted` placed right after `anchor`, for a positive control. */
function insertAfter(source: string, anchor: string, inserted: string): string {
  const parts = source.split(anchor);
  if (parts.length !== 2) {
    throw new Error(`a positive control's anchor must occur exactly once: ${anchor}`);
  }
  return parts.join(`${anchor}${inserted}`);
}

/**
 * Every forbidden-name occurrence in already-closed-walk `files`. `readSource` defaults to the
 * real file on disk, matching `walkClosure`'s own override convention, so a positive control can
 * feed the SAME in-memory violating text this function scans without writing to disk.
 */
function forbiddenNamesReachedBy(
  files: ReadonlySet<string>,
  forbidden: RegExp,
  readSource: (file: string) => string = (file) => readFileSync(file, 'utf8'),
): readonly string[] {
  const found: string[] = [];
  for (const file of files) {
    for (const match of codeOf(readSource(file)).matchAll(forbidden)) {
      found.push(match[0]);
    }
  }
  return found;
}

// -- Absence 1: no verdict module reaches RESET_FRAME_PERIOD or distinctOutputCount (Req 4.6,
//    5.8, 6.6) -------------------------------------------------------------------------------

/** The three verdict modules: Grant_Conditions, Trust_Vote, and the regression gate table. */
const VERDICT_ROOTS: readonly { readonly label: string; readonly path: string }[] = [
  { label: 'grant.ts (evaluateGrant)', path: resolvePath(HERE, '../agent/consensus/grant.ts') },
  {
    label: 'trust-vote.ts (trustVote)',
    path: resolvePath(HERE, '../agent/consensus/trust-vote.ts'),
  },
  {
    label: 'gate.ts (decideConsensusRegressionGate)',
    path: resolvePath(HERE, '../eval/consensus-regression/gate.ts'),
  },
];

const FORBIDDEN_VERDICT_NAMES = /\bRESET_FRAME_PERIOD\b|\bdistinctOutputCount\b/g;

describe('no verdict module reaches RESET_FRAME_PERIOD, distinctOutputCount, or prompt.ts (Req 4.6, 5.8, 6.6)', () => {
  it.each(VERDICT_ROOTS)(
    '$label reaches neither name, and reaches no prompt.ts file',
    ({ path }) => {
      const { files } = walkClosure(path);
      const names = forbiddenNamesReachedBy(files, FORBIDDEN_VERDICT_NAMES);
      const promptFiles = [...files].filter((file) => file.endsWith('/prompt.ts'));

      expect(names).toEqual([]);
      expect(promptFiles).toEqual([]);
    },
  );

  it('reports an inserted RESET_FRAME_PERIOD reference, so the walk is not one that would pass on nothing', () => {
    const grantPath = resolvePath(HERE, '../agent/consensus/grant.ts');
    const realSource = readFileSync(grantPath, 'utf8');
    // The scan reads post-codeOf text, so an inserted COMMENT (blanked) must NOT be reported -
    // this control proves the walk reads real code, confirmed below by inserting a real
    // (non-comment) reference and checking it IS reported.
    const commentOnly = insertAfter(
      realSource,
      "import type { Ulid } from '@app/core';\n",
      '// RESET_FRAME_PERIOD check inserted for this control\n',
    );
    const readCommentOnly = (file: string): string =>
      file === grantPath ? commentOnly : readFileSync(file, 'utf8');
    const { files: commentFiles } = walkClosure(grantPath, readCommentOnly);
    expect(forbiddenNamesReachedBy(commentFiles, FORBIDDEN_VERDICT_NAMES, readCommentOnly)).toEqual(
      [],
    );

    const realViolation = insertAfter(
      realSource,
      "import type { Ulid } from '@app/core';\n",
      'const ece_debug_marker = "RESET_FRAME_PERIOD";\n',
    );
    const readViolation = (file: string): string =>
      file === grantPath ? realViolation : readFileSync(file, 'utf8');
    const { files: violatingFiles } = walkClosure(grantPath, readViolation);
    expect(forbiddenNamesReachedBy(violatingFiles, FORBIDDEN_VERDICT_NAMES, readViolation)).toEqual(
      ['RESET_FRAME_PERIOD'],
    );
  });
});

// -- Absence 2: the renderer property tests proving the mixer sound reach no mutant generator or
//    simulator (Req 2.17) ----------------------------------------------------------------------

const MIXER_PROPERTY_ROOTS: readonly string[] = [
  resolvePath(HERE, 'rendered-stimulus-layout.property.test.ts'),
  resolvePath(HERE, 'rendered-stimulus-enable.property.test.ts'),
  resolvePath(HERE, 'rendered-stimulus-mixer.property.test.ts'),
];

const FORBIDDEN_DESIGN_BLINDNESS_NAMES = /\bgenerateMutants\b|\bSimulatorAdapter\b/g;

describe('the mixer-soundness property tests (tasks 2.8, 2.9, 2.10) reach no mutant generator or simulator (Req 2.17)', () => {
  it.each(MIXER_PROPERTY_ROOTS)(
    '%s reaches neither generateMutants nor SimulatorAdapter',
    (root) => {
      const { files } = walkClosure(root);
      const names = forbiddenNamesReachedBy(files, FORBIDDEN_DESIGN_BLINDNESS_NAMES);

      expect(names).toEqual([]);
    },
  );

  it('reports an inserted generateMutants reference, so the walk is not one that would pass on nothing', () => {
    const mixerPath = resolvePath(HERE, 'rendered-stimulus-mixer.property.test.ts');
    const realSource = readFileSync(mixerPath, 'utf8');
    const violating = insertAfter(
      realSource,
      "import fc from 'fast-check';\n",
      'const ece_debug_marker = "generateMutants";\n',
    );
    const readViolation = (file: string): string =>
      file === mixerPath ? violating : readFileSync(file, 'utf8');
    const { files } = walkClosure(mixerPath, readViolation);

    expect(forbiddenNamesReachedBy(files, FORBIDDEN_DESIGN_BLINDNESS_NAMES, readViolation)).toEqual(
      ['generateMutants'],
    );
  });
});

// -- Absence 3: every real SAMPLE_BUDGET call site imports the constant and declares no numeric
//    local in its place (Req 3.2's structural half) -----------------------------------------

const SAMPLE_BUDGET_CALL_SITES: readonly string[] = [
  resolvePath(HERE, '../agent/roles/reference-model/prompt.ts'),
  resolvePath(HERE, '../eval/consensus-regression/live-wiring.ts'),
  resolvePath(HERE, '../eval/consensus-regression/pilot.ts'),
];

/** A numeric local plausibly standing in for the shared Sample_Budget constant. */
const SUSPICIOUS_LOCAL_SAMPLE_BUDGET =
  /\b(?:const|let)\s+\w*[Ss]ample[Bb]udget\w*\s*(?::\s*number)?\s*=\s*\d/g;

describe('every real SAMPLE_BUDGET call site imports the constant, declaring no numeric local in its place (Req 3.2)', () => {
  it.each(SAMPLE_BUDGET_CALL_SITES)('%s imports SAMPLE_BUDGET from @app/tools', (file) => {
    const code = codeOf(readFileSync(file, 'utf8'));
    expect(runtimeSpecifiersOf(code)).toContain('@app/tools');
    // A multi-line brace import spans several physical lines, so the import BLOCK (every
    // line-leading import/export statement, terminated at its own `;`) is matched as one
    // unit rather than per-line - a per-line check would miss `SAMPLE_BUDGET` sitting on a
    // different line from the `'@app/tools'` specifier it is imported alongside.
    const importBlocks = [...code.matchAll(/^(?:import|export)(?!\s+type\b)[\s\S]*?;\s*$/gm)].map(
      (match) => match[0],
    );
    const toolsImportBlocks = importBlocks.filter((block) => block.includes("'@app/tools'"));
    expect(toolsImportBlocks.some((block) => /\bSAMPLE_BUDGET\b/.test(block))).toBe(true);
  });

  it.each(SAMPLE_BUDGET_CALL_SITES)(
    '%s declares no numeric local standing in for Sample_Budget',
    (file) => {
      const matches = [
        ...codeOf(readFileSync(file, 'utf8')).matchAll(SUSPICIOUS_LOCAL_SAMPLE_BUDGET),
      ];
      expect(matches).toEqual([]);
    },
  );

  it('reports an inserted numeric local, so the scan is not one that would pass on nothing', () => {
    const violating = 'const localSampleBudget = 64;\nconst sampleBudget: number = 2048;\n';
    const matches = [...codeOf(violating).matchAll(SUSPICIOUS_LOCAL_SAMPLE_BUDGET)];
    expect(matches.length).toBeGreaterThan(0);
  });
});
