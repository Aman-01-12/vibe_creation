// Pins the task 1.4 relocation (structural-gate-toolchain, C7, DQ-01): `parseDeclaredModule` and
// `evaluateIntExpression` moved to `@app/tools/verilog/`, and `@app/eval/corpus/verilog-module.ts`
// / `int-expr.ts` became re-exports so `import.ts` and the existing unit tests keep their paths.
//
// WHY IDENTITY, NOT EQUALITY
//   A re-export that happened to construct an equivalent function would still be a logic change -
//   exactly the thing task 1.4 forbids. Reference equality (`toBe`) is the only check that tells a
//   re-export apart from a second, parallel implementation that merely behaves the same today.
//
// WHY A SOURCE SCAN FOR THE IMPORT CLAIM
//   The moved files' own header comments say they import only `@app/core` and each other; this
//   scan reads the two files on disk and fails if a runtime `import`/`export ... from` specifier
//   ever names `@app/eval` or `@app/agent`, so a later edit that reintroduces an outward edge is
//   caught here rather than only by `eslint`'s layer-boundary rule.

import { readFileSync } from 'node:fs';
import { dirname, resolve as resolvePath } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  evaluateIntExpression as evalFromEval,
  parseDeclaredModule as parseFromEval,
} from '@app/eval';
import {
  evaluateIntExpression as evalFromTools,
  parseDeclaredModule as parseFromTools,
} from '@app/tools';

/** This file's directory, for resolving the two moved files relative to it. */
const HERE = dirname(fileURLToPath(import.meta.url));

/** The two files task 1.4 moved to `@app/tools`, read fresh so the scan reflects the real code. */
const MOVED_FILES = [
  resolvePath(HERE, '../tools/verilog/declared-module.ts'),
  resolvePath(HERE, '../tools/verilog/int-expr.ts'),
];

/** Every runtime (non-type) import/export specifier a moved file's source names. */
function runtimeSpecifiersOf(filePath: string): readonly string[] {
  const source = readFileSync(filePath, 'utf8');
  return [
    ...source.matchAll(/^(?:import|export)(?!\s+type\b)[^;]*?\sfrom\s*['"]([^'"]+)['"]/gm),
  ].map((match) => match[1] ?? '');
}

describe('the relocated parser and evaluator are re-exported by identity', () => {
  it('@app/eval.parseDeclaredModule is the exact @app/tools.parseDeclaredModule object', () => {
    expect(parseFromEval).toBe(parseFromTools);
  });

  it('@app/eval.evaluateIntExpression is the exact @app/tools.evaluateIntExpression object', () => {
    expect(evalFromEval).toBe(evalFromTools);
  });
});

describe('the moved files import nothing from @app/eval or @app/agent', () => {
  it.each(MOVED_FILES)('%s names no @app/eval or @app/agent specifier', (filePath) => {
    const specifiers = runtimeSpecifiersOf(filePath);
    expect(specifiers).not.toContain('@app/eval');
    expect(specifiers).not.toContain('@app/agent');
  });

  it('reports an inserted @app/eval import, so the scan is not one that would pass on nothing', () => {
    const fakeSource = "import { x } from '@app/eval';\n";
    const specifiers = [
      ...fakeSource.matchAll(/^(?:import|export)(?!\s+type\b)[^;]*?\sfrom\s*['"]([^'"]+)['"]/gm),
    ].map((match) => match[1] ?? '');
    expect(specifiers).toContain('@app/eval');
  });
});
