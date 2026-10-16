// Unit tests for the structural claims the formal oracle's TYPES and SOURCE carry (task 6.8;
// Req 3.3, 7.15, 7.16, 11.5, 11.15, 14.8).
//
// WHERE TASK 6.8's EIGHT CLAIMS LIVE, AND WHICH HALF IS ASSERTED WHERE
//   Most of these claims are carried by a type, by an import list, or by a constant in the Python
//   worker, so no behavioural test can state them alone. This file reads SOURCE and evaluates
//   TYPES. The behavioural halves sit beside the fixtures they need, in `adapter.test.ts` (the
//   groups marked "task 6.8") and in the worker's `tests/test_formal_lowering.py` (its "Task 6.8"
//   section). A half an existing test already pins is CITED here rather than restated.
//
//   1. No concrete sandbox runtime; only the injected `ToolRunner` (Req 11.5). HERE: the adapter's
//      runtime-import allow-list, the two inert values it binds from the sandbox, no runtime named
//      in any formal module, and the deps type. Every test in `adapter.test.ts` already drives the
//      adapter through a scripted `ToolRunner` double, which is the behavioural half.
//   2. No pass name in an adapter-side string, and no job field to carry one (Req 3.3). HERE: every
//      string literal in every formal module, and the two payload types. The worker owns the
//      Lowering_Sequence and pins it (`test_only_the_two_known_yosys_scripts_exist_in_the_module`,
//      `test_the_lowering_emits_the_whole_sequence_in_order`, and task 6.8's
//      `test_only_the_sources_and_the_top_module_reach_the_lowering_script`), and the seam refuses
//      a third payload key (`sandbox.test.ts`, 'given an extra key inside the formal payload').
//   3. Exactly four checks and no step-0 check (Req 14.8). The worker owns the list and pins it on
//      every outcome path (`test_every_outcome_path_issues_the_same_four_main_checks_and_no_step_0_
//      check`). HERE: the TypeScript mirror's types. `adapter.test.ts` adds that a report carrying a
//      fifth check is REFUSED rather than read.
//   4. The Cover_Check is its own invocation (Req 5.13). Worker-owned: the same every-path test and
//      `test_the_vacuity_answer_is_read_from_the_cover_run_alone`. The TypeScript half was already
//      pinned: `adapter.test.ts`'s ladder test reports `antecedent-unreached` beside a SUCCESSFUL
//      induction, so the proof's own result does not answer vacuity.
//   5. The Solver_Cross_Check on exactly the proved-shaped path, and no `-s z3` re-run on the
//      present-but-not-invocable one (Req 4.15, 11.15). Worker-owned: the two-path audit tests plus
//      task 6.8's every-path and not-invocable tests. HERE: no formal-module string names a solver,
//      so this side has no way to ask for one. `adapter.test.ts` adds that the not-invocable report
//      ends the run after ONE formal job.
//   6. The trace is opportunistic and both reports are required (Req 12.18, 12.19). The worker's
//      registration (`test_a_run_whose_checks_all_proved_registers_no_trace_at_all`,
//      `test_the_refuting_base_case_takes_the_vcd_key_and_other_traces_take_their_own`) and both
//      assemblers (`adapter.test.ts`, 'job assembly') were pinned. `adapter.test.ts` adds every
//      SUBMITTED job and what the real seam's classification makes of each.
//   7. No predicate over the design on the route to the Simulation_Fallback (Req 7.15, 7.16). HERE:
//      the Verification_Loop's route and the adapter's reads off the design. `adapter.test.ts` adds
//      that designs differing only in name, ports, and arithmetic class take ONE route.
//   8. A test double satisfies `FormalOraclePort` (Req 11.12). `adapter.test.ts`, beside the
//      fixtures a request needs. `verification-loop.test.ts`'s `ScriptedOracle` already drives every
//      gate test with no toolchain present.
//
// WHY THE LOOP'S ROUTE IS READ AS SOURCE AND NOT DRIVEN (claim 7)
//   `@app/tools` may import `@app/core` alone, so no test in this package can construct the
//   Verification_Loop, and the loop's own test file belongs to another task. The route is isolated
//   enough to read: the fallback decision is ONE method, `#runFormalGate`, fed by two branch-free
//   methods and two one-line predicates. Read structurally, that says something a behavioural pair
//   cannot, which is that NO design reaches a branch there - a pair of candidates shows only that
//   the two it tried were routed alike.
//
// EVERY SOURCE CHECK HAS A POSITIVE CONTROL: the same check, run over the real file with one
// violating line inserted, reports that line. A scanner that saw nothing would otherwise pass all.

import { readdirSync, readFileSync } from 'node:fs';

import { describe, expect, expectTypeOf, it } from 'vitest';

import type { FormalOracleDeps } from './adapter.js';
import type { ProofConditions } from './conditions.js';
import type { FormalChecksReport } from './report.js';
import type { FormalJobRequest, FormalPrepassJobRequest, ToolRunner } from '../sandbox/index.js';

// -- Reading source ----------------------------------------------------------------------------

/**
 * One token a scan must not look inside: a comment, or a string or template literal.
 *
 * ONE alternation scanned left to right, so whichever opens first wins: a quote inside a comment is
 * comment, and a `//` inside a string is string. NOT a TypeScript lexer: a regex literal holding a
 * quote, a backtick, or `/*`, and a template literal nesting another inside `${}`, would mislead
 * it. Neither shape occurs in the files this suite reads today.
 */
const LEXICAL_TOKEN =
  /\/\/[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^'\\\n]|\\.)*'|"(?:[^"\\\n]|\\.)*"|`(?:[^`\\]|\\[\s\S])*`/g;

/** The indent every class member sits at, because Prettier formats every file read here. */
const MEMBER_INDENT = '  ';

/** The text of a file, resolved from this one. */
function sourceAt(pathFromHere: string): string {
  return readFileSync(new URL(pathFromHere, import.meta.url), 'utf8');
}

/** Whether a token is a comment: the only tokens that open with a slash. */
function isComment(token: string): boolean {
  return token.startsWith('/');
}

/** `source` with every comment blanked to spaces and every newline kept, so the lines line up. */
function codeOf(source: string): string {
  return source.replace(LEXICAL_TOKEN, (token) =>
    isComment(token) ? token.replace(/[^\n]/g, ' ') : token,
  );
}

/** Every string and template literal in `source`, quotes included. A comment is not a string. */
function stringLiteralsIn(source: string): readonly string[] {
  return [...source.matchAll(LEXICAL_TOKEN)]
    .map((match) => match[0])
    .filter((token) => !isComment(token));
}

/**
 * The modules one source file loads at runtime, in source order.
 *
 * The rule `app/test/testbench-rtl-isolation.property.test.ts` pins its import allow-list with:
 * every line-leading `import` counts except `import type`, which `verbatimModuleSyntax` erases.
 */
function runtimeImportsOf(source: string): readonly string[] {
  return [...source.matchAll(/^import(?!\s+type\b)[^;]*?['"]([^'"]+)['"]/gm)].map(
    (match) => match[1] ?? '',
  );
}

/**
 * The VALUE bindings `source` imports from every specifier `admits` accepts.
 *
 * A member spelled `type X` inside the braces is erased like an `import type` line, so it binds
 * nothing at runtime and is not returned.
 */
function valueBindingsIn(
  source: string,
  admits: (specifier: string) => boolean,
): readonly string[] {
  return [...source.matchAll(/^import\s*\{([^}]*)\}\s*from\s*'([^']+)';/gm)]
    .filter((match) => admits(match[2] ?? ''))
    .flatMap((match) => (match[1] ?? '').split(','))
    .map((member) => member.trim())
    .filter((member) => member.length > 0 && !member.startsWith('type '));
}

/**
 * One member of `code`: from the line declaring it to the first later line that closes it.
 *
 * A member opens on the line starting `indent + declaration` and closes on the first later line that
 * is exactly `indent + '}'`, because every inner block sits deeper. Throws when either is missing,
 * so a rename or a reformat fails LOUD rather than handing every check an empty member to pass.
 */
function memberOf(code: string, declaration: string, indent: string): string {
  const lines = code.split('\n');
  const start = lines.findIndex((line) => line.startsWith(`${indent}${declaration}`));
  const end = lines.findIndex((line, index) => index > start && line === `${indent}}`);
  if (start < 0 || end < 0) {
    throw new Error(`no member is declared as ${declaration}`);
  }
  return lines.slice(start, end + 1).join('\n');
}

/**
 * Every construct in `code` that branches on a VALUE: each `if` with its condition, then each
 * `&&`, `||`, ternary `?`, and `switch`.
 *
 * `??` and `?.` are not counted. They default or short-circuit on NULLISHNESS, and a predicate over
 * a design's structure, name, or arithmetic class needs a comparison, which a counted form makes.
 */
function branchesIn(code: string): readonly string[] {
  const conditions = [...code.matchAll(/\bif\s*\(([^)]*)\)/g)].map(
    (match) => `if (${(match[1] ?? '').trim()})`,
  );
  const operators = [...code.matchAll(/&&|\|\||(?<!\?)\?(?![?.])|\bswitch\b/g)].map(
    (match) => match[0],
  );
  return [...conditions, ...operators];
}

/** The fields `code` reads off the identifier `name` - `name.x`, `name?.x`, `name[...]` - sorted. */
function readsOff(code: string, name: string): readonly string[] {
  const read = new RegExp(String.raw`\b${name}\s*(?:\?\.|\.)\s*(\w+)|\b${name}\s*\[`, 'g');
  return [...new Set([...code.matchAll(read)].map((match) => match[1] ?? '[]'))].sort();
}

/**
 * `source` with `inserted` placed right after `anchor`, for a positive control: the real file
 * carrying one line it does not carry. Throws unless the anchor occurs exactly once, so a control
 * cannot silently insert nothing.
 */
function insertAfter(source: string, anchor: string, inserted: string): string {
  const parts = source.split(anchor);
  if (parts.length !== 2) {
    throw new Error(`a positive control's anchor must occur exactly once: ${anchor}`);
  }
  return parts.join(`${anchor}${inserted}`);
}

/**
 * The non-test modules of this directory: the TypeScript side of the Formal_Oracle.
 *
 * Read off the directory rather than listed, so a module added here later is scanned without
 * anyone remembering to add it.
 */
const FORMAL_MODULES: readonly string[] = readdirSync(new URL('.', import.meta.url))
  .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
  .sort();

// -- Claim 1: the injected Tool_Runner port, and no concrete runtime ----------------------------

/** The sandbox classes that execute a job, or stand in for executing one. */
const CONCRETE_RUNTIMES: readonly string[] = [
  'SandboxToolRunner',
  'RunscSandboxRuntime',
  'LocalWorkerRuntime',
  'FakeSandboxRuntime',
];

/** Whether a specifier names a sandbox module, through the barrel or past it. */
function fromSandbox(specifier: string): boolean {
  return specifier.startsWith('../sandbox/');
}

/**
 * Every RUNTIME import in `source` of the sandbox barrel, as `file: specifier`.
 *
 * The barrel is the one sandbox module from which all four concrete runtimes are reachable by name,
 * so loading it - even binding nothing - makes Node evaluate every one of them. An `import type`
 * from it is erased and is not returned.
 */
function barrelLoadsIn(file: string, source: string): readonly string[] {
  return runtimeImportsOf(source)
    .filter((specifier) => fromSandbox(specifier) && specifier.endsWith('/index.js'))
    .map((specifier) => `${file}: ${specifier}`);
}

/**
 * The sandbox VALUE bindings that execute nothing, so binding one is not an execution reach.
 *
 * NAMED rather than excused by a blanket exemption: anything else bound from `../sandbox/` is still
 * reported. `validateSandboxJob` is the seam's own schema validator, asked rather than re-spelled
 * (Req 11.9), and `MAX_RETAINED_ARTIFACT_BYTES` is a NUMBER - the retention store's per-artifact
 * cap, which the Counterexample read reuses rather than re-declaring beside it (Req 12.24).
 *
 * Each is imported from the module that DECLARES it rather than from `../sandbox/index.js`, so the
 * allow-list below is no longer the only thing standing between this module and a concrete runtime
 * - see the import-allow-list test for what that buys.
 */
const INERT_SANDBOX_BINDINGS: readonly string[] = [
  'MAX_RETAINED_ARTIFACT_BYTES',
  'validateSandboxJob',
];

/** Every way `source` reaches an execution surface other than an injected port, as `file: how`. */
function executionReachIn(file: string, source: string): readonly string[] {
  const code = codeOf(source);
  const named = CONCRETE_RUNTIMES.filter((runtime) =>
    new RegExp(String.raw`\b${runtime}\b`).test(code),
  );
  const dynamic = [...code.matchAll(/\bimport\s*\(|\brequire\s*\(/g)].map((match) => match[0]);
  const host = runtimeImportsOf(source).filter((specifier) => specifier.startsWith('node:'));
  const bound = valueBindingsIn(source, fromSandbox).filter(
    (binding) => !INERT_SANDBOX_BINDINGS.includes(binding),
  );
  return [...new Set([...named, ...dynamic, ...host, ...bound])].map((how) => `${file}: ${how}`);
}

describe('the adapter depends on the injected Tool_Runner port alone (Req 11.5)', () => {
  // WHAT THESE CANNOT SEE. A runtime reached THROUGH an allowed module - the formal siblings are
  // held to the same rule below, `@app/core` may import nothing from `@app/tools` (the boundary
  // rule), and `../verilog/property.js`'s own imports are pinned to `@app/core` and
  // `./source-mask.js` by `testbench-rtl-isolation.property.test.ts`. A host channel reached with no
  // import at all, such as `process.binding`. And a host channel inside an allowed sandbox module:
  // `../sandbox/artifact-retention.js` imports `node:crypto`, `node:fs/promises`, and `node:path`
  // for the store this adapter does not construct, and the number it binds from there carries none
  // of them.
  //
  // WHAT CHANGED, AND WHY IT IS NOT A WIDENING. These two values used to be bound from
  // `../sandbox/index.js`, which also re-exports `SandboxToolRunner`, `RunscSandboxRuntime`,
  // `LocalWorkerRuntime`, and `FakeSandboxRuntime`. That import bound none of the four, so the
  // claim held - but only as a claim about what the adapter can CALL, because Node EVALUATED every
  // runtime module on the way to a validator and a number. Reaching each value past the barrel
  // makes the module graph itself carry the claim: no formal module names a concrete runtime, and
  // after this change no formal module LOADS one either (every other sandbox import in this
  // directory is `import type`, which `verbatimModuleSyntax` erases). The allow-list grew by one
  // specifier and lost the one that reached the four runtimes.
  const adapter = sourceAt('./adapter.ts');

  it('loads no module that declares a runtime, only two leaf sandbox modules', () => {
    expect(runtimeImportsOf(adapter)).toEqual([
      '@app/core',
      // A pure constants leaf, so it declares no runtime; see design.md, Component 18.
      './depth-ladder.js',
      './interpret.js',
      './prepass.js',
      './report.js',
      '../sandbox/artifact-retention.js',
      '../sandbox/validation.js',
      '../verilog/property.js',
    ]);
    // The barrel is reached for TYPES, which load nothing - so NO formal module loads it, and this
    // is the only check that says so: `executionReachIn` below reports a runtime that is NAMED or
    // BOUND, and a bare barrel import is neither.
    expect(FORMAL_MODULES.flatMap((file) => barrelLoadsIn(file, sourceAt(`./${file}`)))).toEqual(
      [],
    );
    // Positive control: one runtime import of the barrel, binding nothing, and it is reported.
    const loading = `${adapter}\nimport '../sandbox/index.js';\n`;
    expect(barrelLoadsIn('adapter.ts', loading)).toEqual(['adapter.ts: ../sandbox/index.js']);
  });

  it('binds only INERT values from the sandbox, and reaches no executor', () => {
    expect(valueBindingsIn(adapter, fromSandbox)).toEqual(INERT_SANDBOX_BINDINGS);
    expect(FORMAL_MODULES).toContain('adapter.ts');
    expect(FORMAL_MODULES.flatMap((file) => executionReachIn(file, sourceAt(`./${file}`)))).toEqual(
      [],
    );
    // Positive control: one more import line, and the reach is reported by name and as a binding.
    const reaching = `${adapter}\nimport { LocalWorkerRuntime } from '../sandbox/index.js';\n`;
    expect(executionReachIn('adapter.ts', reaching)).toEqual(['adapter.ts: LocalWorkerRuntime']);
  });

  it('takes ONE execution-capable dependency, typed as the port (compile-time; tsc -b)', () => {
    // `tsc -b` evaluates these and vitest does not. The other three deps are a reader port that
    // returns text, four numbers, and a clock - none of them executes anything.
    expectTypeOf<FormalOracleDeps['toolRunner']>().toEqualTypeOf<ToolRunner>();
    expectTypeOf<keyof FormalOracleDeps>().toEqualTypeOf<
      'artifacts' | 'caps' | 'now' | 'toolRunner'
    >();
  });
});

// -- Claims 2 and 5: no string spells a command, and no job field carries one ------------------

/**
 * The words a Yosys command line is made of, matched whole: `prep` is not inside `prepass`.
 *
 * The Lowering_Sequence first (Req 3.1), whose middle four are the passes Req 3.3 forbids any
 * invocation to omit; then the pre-pass's own passes and the measured alternative lowering of a
 * flop; then the binaries, and every solver a `-s` could name (Req 11.15).
 */
const COMMAND_WORDS: readonly string[] = [
  'read_verilog',
  'prep',
  'memory_map',
  'async2sync',
  'dffunmap',
  'chformal',
  'write_smt2',
  'opt_dff',
  'write_json',
  'clk2fflogic',
  'yosys',
  'yosys-smtbmc',
  'bitwuzla',
  'z3',
  'yices',
];

/** The command words one string names. */
function commandWordsIn(text: string): readonly string[] {
  return COMMAND_WORDS.filter((word) =>
    new RegExp(String.raw`(?<![\w-])${word}(?![\w-])`).test(text),
  );
}

/** Every string literal in `source` that names a command word, as `file: literal names word`. */
function spelledCommandsIn(file: string, source: string): readonly string[] {
  return stringLiteralsIn(source).flatMap((literal) =>
    commandWordsIn(literal).map((word) => `${file}: ${literal} names ${word}`),
  );
}

describe('no formal module can spell a Yosys command (Req 3.3, 11.15)', () => {
  // WHAT THIS CANNOT SEE. A word assembled at runtime from fragments, or computed from data. A word
  // reaching a job from OUTSIDE these modules, which the import allow-list above bounds. A word
  // missing from the list. Comments are excluded ON PURPOSE: they never reach an argv.

  it('holds no string literal naming a pass, a binary, or a solver', () => {
    expect(
      FORMAL_MODULES.flatMap((file) => spelledCommandsIn(file, sourceAt(`./${file}`))),
    ).toEqual([]);
    // NOT A SCAN THAT SAW NOTHING. The words ARE in these files, in comments...
    expect(commandWordsIn(sourceAt('./adapter.ts'))).toEqual(
      expect.arrayContaining(['read_verilog', 'prep', 'write_smt2']),
    );
    // ...and one string that spells a command is reported, word by word.
    const spelling = `${sourceAt('./adapter.ts')}\nconst SCRIPT = 'prep -top w; async2sync';\n`;
    expect(spelledCommandsIn('adapter.ts', spelling)).toEqual([
      "adapter.ts: 'prep -top w; async2sync' names prep",
      "adapter.ts: 'prep -top w; async2sync' names async2sync",
    ]);
  });

  it('types no job field a pass or a solver could ride in (compile-time; tsc -b)', () => {
    // The payloads ARE the job fields that reach a command line. The worker reads `topModule` into
    // `prep -top` and `depth` into `-t`, and refuses either unless it is an identifier and a bounded
    // integer; the seam schema refuses a third key at runtime (`sandbox.test.ts`).
    expectTypeOf<keyof FormalJobRequest>().toEqualTypeOf<'depth' | 'topModule'>();
    expectTypeOf<keyof FormalPrepassJobRequest>().toEqualTypeOf<'topModule'>();
  });
});

// -- Claim 3: the TypeScript mirror of the check list ------------------------------------------

describe('the gate types four checks and no step-0 check (Req 14.8)', () => {
  it('reads four report checks into five Proof_Conditions (compile-time; tsc -b)', () => {
    // The worker owns the list; this is what the gate can READ of it. A fifth check could only
    // reach a verdict through a new member here, and a report carrying one is refused at the parse
    // (`adapter.test.ts`), because the schema closes `checks` to these four keys.
    expectTypeOf<keyof FormalChecksReport>().toEqualTypeOf<
      'base' | 'cover' | 'induct' | 'presat'
    >();
    expectTypeOf<keyof ProofConditions>().toEqualTypeOf<
      'assertionCount' | 'base' | 'cover' | 'induction' | 'presat'
    >();
  });
});

// -- Claim 7: the route to the Simulation_Fallback ---------------------------------------------

/** One `formalProvenanceOf` argument on one line: whitespace collapsed, a trailing comma dropped. */
function asOneLine(argument: string): string {
  return argument
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/,\s*\}$/, ' }');
}

/** The route facts read off the Verification_Loop's source. */
function routeIn(loopCode: string): Readonly<Record<string, unknown>> {
  const gate = memberOf(loopCode, 'async #runFormalGate(', MEMBER_INDENT);
  const submit = memberOf(loopCode, 'async #proveSet(', MEMBER_INDENT);
  const withholding = memberOf(loopCode, 'function withheldSetRoute(', '');
  return {
    gateBranches: branchesIn(gate),
    gateReadsOffTheDesign: ['candidate', 'spec', 'genInput'].flatMap((name) =>
      readsOff(gate, name),
    ),
    decidedBy: [...gate.matchAll(/=\s*results\.find\((\w+)\)/g)].map((match) => match[1]),
    takenRoutes: [...gate.matchAll(/formalProvenanceOf\([^,]+,[^,]+,\s*([^)]+)\)/g)].map((match) =>
      asOneLine(match[1] ?? ''),
    ),
    withholding: {
      reads: ['set', 'properties', 'candidate', 'spec'].flatMap((name) =>
        readsOff(withholding, name),
      ),
      branches: branchesIn(withholding),
    },
    predicates: ['isRefuted', 'isCouldNotVerify'].map((name) => {
      const predicate = memberOf(loopCode, `function ${name}(`, '');
      return { name, reads: readsOff(predicate, 'result'), branches: branchesIn(predicate) };
    }),
    submissionBranches: [submit, memberOf(loopCode, 'async #submitSet(', MEMBER_INDENT)].map(
      branchesIn,
    ),
    budgetHandedToTheOracle: [...submit.matchAll(/budgetMs:\s*([^,\n]+)/g)].map(
      (match) => match[1],
    ),
  };
}

/**
 * THE ROUTE, as the facts that make it free of any design predicate.
 *
 * The decision branches on the gate's presence, whether the set was WITHHELD, and which verdict
 * arrived - and on nothing it read off the candidate or the Spec. Its two verdicts come from
 * predicates that read `verdict` alone, and what it records is a `TakenRoute`: a fixed cause where
 * our own Property_Set source threw, the withholding route where nothing was submitted, that
 * result's Could_Not_Verify_Cause where one arrived, and `NOT_A_FALLBACK` on the two paths the
 * formal verdict decides. `#proveSet` holds no branch. `#submitSet` holds one ternary, over a
 * result's submission index on the throw path, which charges the thrown port's measured time once
 * (formal-elapsed-time-undercharge Q5-A); it reads nothing off the design. The budget they hand
 * the oracle is the build constant, which matters for Req 7.16: `proof-timeout` is the only route
 * the multiplier class leaves by, and a budget derived from the design would be a class predicate
 * that needs no branch.
 *
 * WHY `withholding` IS PINNED BESIDE THE GATE. Tasks 19.2 and 19.3 moved the gate's own
 * `properties.length === 0` branch out into `withheldSetRoute`, which now answers BOTH withholdings
 * as one total function (Req 7.20, 10.3) - so the gate branches on `withheld !== null` instead. Had
 * this pin only followed that rename, the branch it used to watch would have left its sight: the
 * emptiness test and the refusal test would sit in a function nothing here reads. They are pinned
 * where they moved TO, by the same two facts the gate is held to - what it reads off the design
 * (`propertySetAdmitted` and `length`, neither of them the candidate or the Spec) and what it
 * branches on. The route STRINGS it returns are not pinned here; `FALLBACK_ROUTES` and
 * `formal-fallback-recorded.property.test.ts` own that vocabulary.
 */
const ROUTE = {
  gateBranches: [
    'if (gate === undefined)',
    'if (withheld !== null)',
    'if (refuted !== undefined)',
    'if (unverifiable !== undefined)',
  ],
  gateReadsOffTheDesign: [],
  decidedBy: ['isRefuted', 'isCouldNotVerify'],
  takenRoutes: [
    "{ route: 'cause', reason: 'toolchain-unavailable' }",
    'withheld',
    'NOT_A_FALLBACK',
    "{ route: 'cause', reason: unverifiable.cause }",
    'NOT_A_FALLBACK',
  ],
  withholding: {
    reads: ['propertySetAdmitted', 'length'],
    // Both conditions are read up to their first `)`, as the positive control below explains, so
    // the `=== 'refused'` comparison is cut off with the paren that closes the `??` default. The
    // ternary is the emptiness test. Neither mentions the candidate or the Spec, which is the claim.
    branches: ["if ((set.propertySetAdmitted ?? 'not-gated')", '?'],
  },
  predicates: [
    { name: 'isRefuted', reads: ['verdict'], branches: [] },
    { name: 'isCouldNotVerify', reads: ['verdict'], branches: [] },
  ],
  submissionBranches: [[], ['?']],
  budgetHandedToTheOracle: ['DEFAULT_PROPERTY_TIME_BUDGET_MS'],
};

describe('no predicate over the design is on the route to the Simulation_Fallback (Req 7.15, 7.16)', () => {
  // WHAT THESE CANNOT SEE. A design value aliased or destructured into a name the reads check does
  // not watch. A design value folded into the request with no branch construct - which is why the
  // budget, the one input `proof-timeout` is decided against, is pinned to the constant. A predicate
  // inside the Property_Author, which reads the Spec and never the candidate. And the adapter's
  // callees: the renderer reads the ports to render, and `interpretFormalReport` reads the two file
  // names to attribute a lowering failure. `adapter.test.ts` drives the adapter end to end for that.
  //
  // THE `withholding` FACT NEEDS NO CONTROL OF ITS OWN, for two reasons that hold together: its
  // pinned `reads` and `branches` are both NON-EMPTY, so a scan that saw nothing cannot produce
  // them, and `memberOf` THROWS on a member it cannot find, so a rename fails loud rather than
  // handing the comparison an empty member. The control below exercises the same two helpers,
  // `readsOff` and `branchesIn`, over the gate.
  const loop = codeOf(sourceAt('../../agent/orchestrator/verification-loop.ts'));

  it('decides the fallback from the Formal_Verdict and records the Could_Not_Verify_Cause', () => {
    expect(routeIn(loop)).toEqual(ROUTE);
    // Positive control: one predicate over the candidate's source, and the route says so twice.
    const predicated = insertAfter(
      loop,
      '    const { spec } = genInput;\n',
      "    if (candidate.rtl.includes('*')) {\n      return { kind: 'not-decided', provenance: NO_FORMAL_RUN };\n    }\n",
    );
    expect(routeIn(predicated)).toMatchObject({
      gateBranches: [
        'if (gate === undefined)',
        // The condition is read up to its first `)`, so a call inside it is cut short - which
        // still differs from every allowed condition, and that is all the comparison needs.
        "if (candidate.rtl.includes('*')",
        ...ROUTE.gateBranches.slice(1),
      ],
      gateReadsOffTheDesign: ['rtl'],
    });
  });

  it('reads nothing off the design in the adapter but its file name, its top, and its clocking', () => {
    // `path` names the design file for the lowering-failure attribution: a reading of WHICH FILE
    // the frontend's diagnostic blames (Req 8.8), for a design the frontend REJECTED, which Req 7.15
    // excludes by its own terms. `moduleName` is the pre-pass `-top`. `clocking` is the depth rule
    // Req 4.5 makes read the design, and it picks a DEPTH, never a way out of the gate. The design's
    // `contents`, the only channel to an arithmetic class, is never read here at all.
    const adapter = codeOf(sourceAt('./adapter.ts'));
    const reads = (code: string): Readonly<Record<string, readonly string[]>> => ({
      designSource: readsOff(code, 'designSource'),
      designInterface: readsOff(code, 'designInterface'),
      escalation: readsOff(memberOf(code, 'function escalates(', ''), 'result'),
    });

    expect(reads(adapter)).toEqual({
      designSource: ['path'],
      designInterface: ['clocking', 'moduleName'],
      escalation: ['cause', 'verdict'],
    });
    // Positive control: one read of the design's text, and it is reported.
    const classifying = insertAfter(
      adapter,
      '    const depths = proofDepthsFor(request.designInterface, request.property);\n',
      "    const multiplier = request.designSource.contents.includes('*');\n",
    );
    expect(reads(classifying).designSource).toEqual(['contents', 'path']);
  });
});
