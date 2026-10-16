// Example tests for the Consensus_Harness renderer (C6; Req 4.1-4.9, 5.2, 6.5, 6.6), pinning the
// cases task 7.1's own body names: the version is 1; the rendered text declares exactly one top
// module; a port name with a space, a semicolon, a newline, a backtick, or a `/*` refuses with a
// DomainError; a module name that is a Verilog keyword refuses; two renders of one request are
// byte-identical.

import { describe, expect, it } from 'vitest';

import { makeTimingContract } from '@app/core';
import type { ClockingContract, ModuleInterface, Port, TimingContract } from '@app/core';

import {
  CONSENSUS_HARNESS_PATH,
  CONSENSUS_HARNESS_VERSION,
  renderConsensusHarness,
  SAMPLE_BUDGET,
  sizedSampleBudget,
  type ConsensusHarnessRequest,
} from './consensus-harness.js';

const CLOCKED: ClockingContract = { clockName: 'clk', resetName: 'rst', resetActiveLow: false };
const COMBINATIONAL: ClockingContract = { clockName: null, resetName: null, resetActiveLow: false };

function moduleInterfaceWith(
  moduleName: string,
  ports: readonly Port[],
  clocking: ClockingContract,
): ModuleInterface {
  return { moduleName, ports, clocking, validityOutputName: null };
}

/** Build a `TimingContract` where every output port of `moduleInterface` is `registered`. */
function allRegisteredTiming(moduleInterface: ModuleInterface): TimingContract {
  const entries = moduleInterface.ports
    .filter((port) => port.direction === 'output')
    .map((port) => ({ portName: port.name, timing: 'registered' as const }));
  const built = makeTimingContract(moduleInterface, entries);
  if (!built.ok) {
    throw new Error(`test fixture defect: ${built.error.code}`);
  }
  return built.value;
}

// `clk` and `rst` are carried by `CLOCKED` (ClockingContract), NOT by `ports` - the corpus
// importer excludes a matched clock/reset port from its own built `ports` list the same way
// (`app/eval/corpus/import.test.ts` asserts `.not.toContain('clk')`), and the Candidate_Design's
// own module still declares those two ports, connected via `clockName`/`resetName` instead.
const COUNTER_INTERFACE = moduleInterfaceWith(
  'counter',
  [
    { name: 'en', direction: 'input', width: 1 },
    { name: 'q', direction: 'output', width: 4 },
  ],
  CLOCKED,
);

function requestFor(
  moduleInterface: ModuleInterface,
  overrides: Partial<ConsensusHarnessRequest> = {},
): ConsensusHarnessRequest {
  return {
    moduleInterface,
    timingContract: allRegisteredTiming(moduleInterface),
    nonce: 'abc123',
    watchdogBudgetNs: 2_000_000,
    sampleBudget: SAMPLE_BUDGET,
    ...overrides,
  };
}

/** The number of lines in `text` that begin a module declaration. */
function moduleDeclarationCount(text: string): number {
  return text.split('\n').filter((line) => /^module\s+\w/.test(line)).length;
}

describe('renderConsensusHarness', () => {
  it('is at version 1', () => {
    expect(CONSENSUS_HARNESS_VERSION).toBe(1);
  });

  it('renders text declaring exactly one top module', () => {
    const rendered = renderConsensusHarness(requestFor(COUNTER_INTERFACE));
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.value.path).toBe(CONSENSUS_HARNESS_PATH);
    expect(moduleDeclarationCount(rendered.value.contents)).toBe(1);
  });

  it.each([
    ['a space', 'q sum'],
    ['a semicolon', 'q;sum'],
    ['a newline', 'q\nsum'],
    ['a backtick', 'q`sum'],
    ['a /* comment-open', 'q/*sum'],
  ])('refuses a port name containing %s with a DomainError', (_label, badPortName) => {
    const moduleInterface = moduleInterfaceWith(
      'counter',
      [{ name: badPortName, direction: 'output', width: 1 }],
      COMBINATIONAL,
    );
    const timingBuilt = makeTimingContract(moduleInterface, [
      { portName: badPortName, timing: 'combinational' },
    ]);
    // The bad name may also fail the identifier-safe TimingContract construction; in that case
    // the renderer never even sees a complete request, which is fine - the trust boundary already
    // held. Build a trivially-passing TimingContract directly when that happens, so the renderer
    // itself is exercised on the identifier.
    const timingContract: TimingContract = timingBuilt.ok
      ? timingBuilt.value
      : { entries: [{ portName: badPortName, timing: 'combinational' }] };
    const rendered = renderConsensusHarness(requestFor(moduleInterface, { timingContract }));
    expect(rendered.ok).toBe(false);
    if (rendered.ok) return;
    expect(rendered.error.code).toBe('INVALID_VERILOG_IDENTIFIER');
  });

  it('refuses a module name that is a reserved Verilog keyword', () => {
    const moduleInterface = moduleInterfaceWith('module', [], COMBINATIONAL);
    const rendered = renderConsensusHarness(
      requestFor(moduleInterface, { timingContract: { entries: [] } }),
    );
    expect(rendered.ok).toBe(false);
    if (rendered.ok) return;
    expect(rendered.error.code).toBe('RESERVED_VERILOG_KEYWORD');
  });

  it('renders byte-identical text across two renders of one request', () => {
    const first = renderConsensusHarness(requestFor(COUNTER_INTERFACE));
    const second = renderConsensusHarness(requestFor(COUNTER_INTERFACE));
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.value.contents).toBe(second.value.contents);
  });

  it('refuses a non-positive-integer watchdogBudgetNs', () => {
    const rendered = renderConsensusHarness(requestFor(COUNTER_INTERFACE, { watchdogBudgetNs: 0 }));
    expect(rendered.ok).toBe(false);
    if (rendered.ok) return;
    expect(rendered.error.code).toBe('INVALID_VERILOG_IDENTIFIER');
  });

  it('refuses a Timing_Contract missing an entry for a declared output port', () => {
    const rendered = renderConsensusHarness(
      requestFor(COUNTER_INTERFACE, { timingContract: { entries: [] } }),
    );
    expect(rendered.ok).toBe(false);
    if (rendered.ok) return;
    expect(rendered.error.code).toBe('MISSING_PORT_TIMING');
  });

  it('declares no clock statements for a clockless interface', () => {
    const moduleInterface = moduleInterfaceWith(
      'adder',
      [
        { name: 'a', direction: 'input', width: 4 },
        { name: 'sum', direction: 'output', width: 4 },
      ],
      COMBINATIONAL,
    );
    const rendered = renderConsensusHarness(requestFor(moduleInterface));
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.value.contents).not.toContain('ece_clk');
  });

  it('instantiates the Candidate_Design once and CALLS the three Reference_Model functions without redeclaring them', () => {
    const rendered = renderConsensusHarness(requestFor(COUNTER_INTERFACE));
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    // ONE instance: a second instance of the same module would drive every output wire from two
    // sources at once (see the module header's note on the earlier, iverilog-caught draft).
    const instanceCount = (rendered.value.contents.match(/\bece_candidate\b/g) ?? []).length;
    expect(instanceCount).toBeGreaterThan(0);
    expect(rendered.value.contents).not.toContain('ece_reference');
    // NO `function automatic` declaration anywhere in this file: a module-scoped redeclaration
    // of the same name SHADOWS the Reference_Model file's own compilation-unit-scope definition,
    // which silently resolves every call to an empty stub reading 'x' - a real bug an earlier
    // draft had, caught only by task 8.4's real-toolchain integration test (see module header).
    expect(rendered.value.contents).not.toContain('function automatic');
    expect(rendered.value.contents).toContain('ece_stimulus(');
    expect(rendered.value.contents).toContain('ece_next_state(');
    expect(rendered.value.contents).toContain('ece_expect(');
  });
});

// Task 7.2: the per-run nonce closes the one forgery the design has to close (Req 4.8, 4.9, 15.6).
// Every CHECK/SAMPLE/SAMPLE_END line the harness emits carries the nonce, so a model-written
// $display forging a pass cannot carry it (the Reference_Model never sees the harness text).
describe('the per-run nonce (C6)', () => {
  it('renders text that differs between two nonces only at the nonce occurrences', () => {
    const first = renderConsensusHarness(requestFor(COUNTER_INTERFACE, { nonce: 'nonceAAA' }));
    const second = renderConsensusHarness(requestFor(COUNTER_INTERFACE, { nonce: 'nonceBBB' }));
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    // Substituting the second render's nonce back to the first's own nonce text must restore
    // byte-identical output - this is a stronger claim than merely differing somewhere, since it
    // proves EVERY difference between the two renders is accounted for by the nonce occurrences
    // alone, with no other hidden source of per-run variation.
    const restored = second.value.contents.split('nonceBBB').join('nonceAAA');
    expect(restored).toBe(first.value.contents);
    expect(first.value.contents).not.toBe(second.value.contents);
  });

  it.each([
    ['a space', 'bad nonce'],
    ['a quote', 'bad"nonce'],
  ])('refuses a nonce containing %s with a DomainError', (_label, badNonce) => {
    const rendered = renderConsensusHarness(requestFor(COUNTER_INTERFACE, { nonce: badNonce }));
    expect(rendered.ok).toBe(false);
    if (rendered.ok) return;
    expect(rendered.error.code).toBe('INVALID_VERILOG_IDENTIFIER');
    expect(rendered.error.field).toBe('nonce');
  });

  it("names the end marker's count field as the sample count (the loop's own bound), not the watchdog budget", () => {
    // A distinctive, mutually-unequal pair, so a renderer that accidentally emitted the wrong
    // constant would be caught rather than coincidentally matching.
    const rendered = renderConsensusHarness(
      requestFor(COUNTER_INTERFACE, { sampleBudget: 777, watchdogBudgetNs: 999_000 }),
    );
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.value.contents).toContain(
      '$display("ECE_SAMPLE_END abc123 %0d", ECE_SAMPLE_BUDGET);',
    );
    expect(rendered.value.contents).toContain('localparam integer ECE_SAMPLE_BUDGET = 777;');
    expect(rendered.value.contents).not.toContain(
      'ECE_SAMPLE_END abc123 %0d", ECE_WATCHDOG_BUDGET_NS',
    );
  });

  it('carries no trailing free text on any of the three line shapes, keeping exactly the documented formats', () => {
    const rendered = renderConsensusHarness(requestFor(COUNTER_INTERFACE));
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    // The CHECK line is a fixed two-field format ("CHECK %0s PASS"/"CHECK %0s FAIL") with no
    // appended diagnostic text on the PASS arm - the arm a forged line would try to imitate - and
    // the FAIL arm's extra fields are a SEPARATE, fully-specified display call rather than
    // free text appended to the PASS shape.
    expect(rendered.value.contents).toContain(`$display("${'CHECK %0s PASS'}"`);
    expect(rendered.value.contents).not.toMatch(/CHECK %0s PASS[^"]/);
  });
});

// Task 7.3: the Sample_Budget is sized from the declared port widths, taking the smaller of the
// computed cap and the caller's request, so a wide interface's sample stream stays inside the
// sandbox worker's stdout retention (Req 7.7, 15.4).
describe('sizedSampleBudget (C6, C8)', () => {
  it('yields the requested SAMPLE_BUDGET for a one-port one-bit interface', () => {
    expect(sizedSampleBudget('abc123'.length, 1, SAMPLE_BUDGET)).toBe(SAMPLE_BUDGET);
  });

  it('yields strictly fewer than SAMPLE_BUDGET for an interface wide enough to exceed the worker cap at 2048 samples', () => {
    // A very wide bundle (4096 bits, 1024 hex digits per sample) pushes the per-sample byte
    // estimate past 1,048,576 / 2048, so the computed cap must come in below the request.
    const budget = sizedSampleBudget('abc123'.length, 4096, SAMPLE_BUDGET);
    expect(budget).toBeLessThan(SAMPLE_BUDGET);
    expect(budget).toBeGreaterThanOrEqual(1);
  });

  it('is always at least 1, so no interface renders a loop that never samples', () => {
    // An extreme width that would otherwise compute to zero or negative.
    expect(sizedSampleBudget('abc123'.length, 1_000_000, SAMPLE_BUDGET)).toBeGreaterThanOrEqual(1);
  });

  it('renders the resized budget into the loop bound and the end marker, not the raw request', () => {
    const wideInterface = moduleInterfaceWith(
      'wide_dut',
      [
        { name: 'a', direction: 'input', width: 1 },
        { name: 'y', direction: 'output', width: 4096 },
      ],
      COMBINATIONAL,
    );
    const timingBuilt = makeTimingContract(wideInterface, [
      { portName: 'y', timing: 'combinational' },
    ]);
    if (!timingBuilt.ok) throw new Error(`test fixture defect: ${timingBuilt.error.code}`);
    const rendered = renderConsensusHarness(
      requestFor(wideInterface, { timingContract: timingBuilt.value, sampleBudget: SAMPLE_BUDGET }),
    );
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.value.contents).not.toContain(`ECE_SAMPLE_BUDGET = ${String(SAMPLE_BUDGET)};`);
    const expectedBudget = sizedSampleBudget('abc123'.length, 4096, SAMPLE_BUDGET);
    expect(rendered.value.contents).toContain(`ECE_SAMPLE_BUDGET = ${String(expectedBudget)};`);
  });
});
