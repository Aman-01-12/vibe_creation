// testbench-dialect-normalization, task 13.1: the three defects the Dialect_Normalizer's
// adjacency scans had, pinned as regression assertions.
//
// THE LANGUAGE GROUND TRUTH THESE ASSERT
//   In Verilog a comment is lexically WHITESPACE: it is stripped before the parser sees the
//   token stream. So `begin // c` newline `: blk` is a NAMED block, and a bare
//   `CHECK <name> PASS;` preceded by a comment still sits exactly where a statement is
//   expected. An adjacency scan that stops AT a comment is asking a different question than
//   the parser answers, and all three cases below were that scan being wrong.
//
// WHY THESE ARE KNOWN-ANSWER CASES AND NOT A PROPERTY
//   Each one is a specific input whose correct output was confirmed against Icarus Verilog
//   13.0 with `-g2012` (design.md's "Comments are lexically whitespace" calibration table).
//   The general statement - inserting a comment at any token boundary changes nothing the
//   transform reports or rewrites - is the separate Property 26 (task 13.6).
//
// THE PRIMARY FORM OF (b) IS BYTE-IDENTITY, WHICH NEEDS NO TOOLCHAIN
//   The false rewrite turned a source Icarus accepts at exit 0 into one it rejects at exit 2,
//   so the belt-and-braces form of the same assertion compiles both through the real
//   toolchain. That form is gated on `PROBE.available` and skips with a printed warning, so a
//   machine without Icarus reports honestly rather than passing vacuously. The byte-identity
//   assertions above it hold on every machine.
//
// Validates: Requirements 4.12, 5.3, 5.4

import { describe, expect, it } from 'vitest';

import { normalizeDialect, TestbenchPrecheck } from '@app/agent';
import { makePort, type ModuleInterface, type Port } from '@app/core';
import type { ResourceLimits, SourceFile } from '@app/tools';

import { PROBE, realOracleAdapter } from './real-oracle-harness.js';

if (!PROBE.available) {
  console.warn(
    `[dialect-comments-are-whitespace] Real-toolchain path NOT exercised: ${PROBE.reason}. ` +
      'The compiles-before-and-after assertion for the already-named block is SKIPPED in this ' +
      'environment; the byte-identity assertions still run.',
  );
}

/** Generous real-run caps: local process startup plus a real iverilog+vvp run. */
const REAL_LIMITS: ResourceLimits = { cpu: 1, memMb: 512, procs: 128, diskMb: 128, wallMs: 30_000 };

// -- (a) prose-as-statement behind a comment --------------------------------
//
// The measured shape: 4 samples in `.eval-runs/stage1-screen-repair-v1`, every one a
// `// Final check` line immediately before a bare `CHECK <name> PASS;`. The nearest preceding
// NON-WHITESPACE character is the comment's last character; the nearest preceding CODE
// character is the `;` that ends the `$display` above it, so a statement is expected here.

const PROSE_BEHIND_COMMENT = `module tb;
  initial begin : checks
    $display("CHECK ac1_adder_produces_sum PASS");
    // Final check
    CHECK ac1_adder_produces_sum PASS;
  end
endmodule
`;

// -- (b) an already-named block whose name sits behind a comment -------------
//
// `begin // c` newline `: blk` compiles at exit 0 under iverilog 13.0 `-g2012`, and so does
// the block-comment variant. Both were confirmed to produce the identical FALSE REWRITE:
// ` : tbnorm_blk_1` inserted after `begin`, yielding `begin : tbnorm_blk_1 // c` newline
// `: blk`, which Icarus rejects at exit 2 with `syntax error` plus `Malformed statement`.

const NAMED_BLOCK_LINE_COMMENT = `module tb;
  initial begin // c
    : blk
    integer i;
  end
endmodule
`;

const NAMED_BLOCK_BLOCK_COMMENT = `module tb;
  initial begin /* c */
    : blk
    integer i;
  end
endmodule
`;

// -- (c) a shadowing declaration whose name sits behind a comment ------------
//
// Module scope declares `a`; the block declares `a` too, so naming the block would let an
// outside reference to `a` silently rebind - the Requirement 5.4 decline. Reading the
// declared name out of the RAW body took `x` from inside the comment instead of `a`, which
// defeated the decline and produced a rewrite.

const SHADOW_BEHIND_COMMENT = `module tb;
  reg a;
  initial begin
    reg /*x*/ a;
    a = 1'b0;
  end
endmodule
`;

/** Build a `Port`, failing loudly rather than silently on a bad fixture. */
function port(input: {
  readonly name: string;
  readonly direction: Port['direction'];
  readonly width: number;
}): Port {
  const result = makePort(input);
  if (!result.ok) {
    throw new Error(`fixture declared an invalid port: ${result.error.code}`);
  }
  return result.value;
}

/**
 * A minimal Spec-derived Interface the precheck can build a stub from.
 *
 * The fixtures above are standalone testbenches that instantiate nothing, so the stub is only
 * ever a second root module the compiler also elaborates; the outcome therefore turns on
 * whether the TESTBENCH parses, which is exactly the question this assertion asks.
 */
const STANDALONE_INTERFACE: ModuleInterface = {
  moduleName: 'dialect_probe_dut',
  ports: [port({ name: 'a', direction: 'input', width: 1 })],
  clocking: { clockName: null, resetName: null, resetActiveLow: false },
};

/** Whether the real toolchain attributes a build failure to `contents` itself. */
async function precheckOutcomeFor(contents: string): Promise<string> {
  const testbench: SourceFile = { path: 'dialect_comment_tb.v', contents };
  const precheck = new TestbenchPrecheck(realOracleAdapter());
  return precheck.run(testbench, STANDALONE_INTERFACE, REAL_LIMITS);
}

describe('a comment is whitespace to every Dialect_Normalizer adjacency scan', () => {
  it('reports a bare CHECK statement whose nearest preceding non-whitespace is a comment', () => {
    const { source, report } = normalizeDialect(PROSE_BEHIND_COMMENT);

    const prose = report.findings.filter(
      (finding) => finding.dialectClass === 'prose-as-statement',
    );
    expect(prose).toHaveLength(1);
    expect(prose[0]?.action).toBe('declined');
    expect(prose[0]?.declinedBecause).toBe('reported-only');
    // Detected and reported, never rewritten: synthesizing a `$display` from our own prompt
    // prose would fabricate a check the model never wrote.
    expect(source).toBe(PROSE_BEHIND_COMMENT);
  });

  it('leaves an already-named block byte-identical when a LINE comment precedes its name', () => {
    const { source, report } = normalizeDialect(NAMED_BLOCK_LINE_COMMENT);

    expect(source).toBe(NAMED_BLOCK_LINE_COMMENT);
    expect(report.changed).toBe(false);
    expect(report.findings.filter((finding) => finding.action === 'rewritten')).toEqual([]);
  });

  it('leaves an already-named block byte-identical when a BLOCK comment precedes its name', () => {
    const { source, report } = normalizeDialect(NAMED_BLOCK_BLOCK_COMMENT);

    expect(source).toBe(NAMED_BLOCK_BLOCK_COMMENT);
    expect(report.changed).toBe(false);
    expect(report.findings.filter((finding) => finding.action === 'rewritten')).toEqual([]);
  });

  it('declines a shadowing declaration whose declared name is written after a comment', () => {
    const { source, report } = normalizeDialect(SHADOW_BEHIND_COMMENT);

    const blocks = report.findings.filter(
      (finding) => finding.dialectClass === 'unnamed-begin-declaration',
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]?.action).toBe('declined');
    expect(blocks[0]?.declinedBecause).toBe('would-shadow-module-scope');
    expect(source).toBe(SHADOW_BEHIND_COMMENT);
    expect(report.changed).toBe(false);
  });
});

describe.skipIf(!PROBE.available)(
  'the real toolchain accepts the normalizer output for an already-named block (Req 5.3)',
  () => {
    it('compiles the line-comment variant both before and after normalization', async () => {
      // The input is the fact the false rewrite violated: iverilog accepts it. Asserted first
      // so a fixture that never compiled could not make the second assertion vacuous.
      await expect(precheckOutcomeFor(NAMED_BLOCK_LINE_COMMENT)).resolves.toBe('undecided');

      const normalized = normalizeDialect(NAMED_BLOCK_LINE_COMMENT).source;
      await expect(precheckOutcomeFor(normalized)).resolves.toBe('undecided');
    }, 60_000);

    it('compiles the block-comment variant both before and after normalization', async () => {
      await expect(precheckOutcomeFor(NAMED_BLOCK_BLOCK_COMMENT)).resolves.toBe('undecided');

      const normalized = normalizeDialect(NAMED_BLOCK_BLOCK_COMMENT).source;
      await expect(precheckOutcomeFor(normalized)).resolves.toBe('undecided');
    }, 60_000);
  },
);
