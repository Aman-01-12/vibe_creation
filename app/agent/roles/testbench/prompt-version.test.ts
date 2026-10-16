// Pinned prompt digest test (Req 11.6; task 9.2).
//
// WHY THIS TEST EXISTS
//   `TESTBENCH_PROMPT_VERSION` is a hand-bumped integer precisely because a digest
//   of the prompt would change on every wording edit with no human decision
//   involved (see `prompt-version.ts`). This test is the other half of that design:
//   it digests the prompt assembled for one fixed, canonical Spec and compares it
//   against a LITERAL pinned beside the version constant. If a rule in `prompt.ts`
//   changes - the wording of a rule, which branch fires, the order sections appear
//   in - the digest changes and this test fails loudly, even though nothing forced
//   the author to bump the version by hand.
//
// WHY THE EXPECTED VALUE IS A LITERAL, NOT A RECOMPUTATION
//   Asserting `digest(prompt) === digest(prompt)` proves nothing: it passes no
//   matter how the prompt changes. The expected string below is the digest observed
//   for the Cycle_Timed prompt at `TESTBENCH_PROMPT_VERSION = 7`, typed in as a constant. A
//   real prompt change requires a human to look at the diff, decide it is (or is
//   not) a rule change, and only then update this literal alongside a version bump.

import { describe, expect, it } from 'vitest';

import {
  buildGroundedTestbenchModelInput,
  buildScoreboardModelInput,
  buildTestbenchModelInput,
  EXPECTED_VALUE_RULE,
  renderScoreboardScaffold,
  requiredChecks,
  requiredChecksFor,
  TESTBENCH_PROMPT_VERSION,
} from '@app/agent';
import {
  makeTimingContract,
  newUlid,
  type ModuleInterface,
  type Spec,
  type TimingContract,
} from '@app/core';

/**
 * The subset of the Web Crypto `SubtleCrypto` interface this file needs.
 *
 * `app/agent`'s tsconfig deliberately carries no ambient `types` (see
 * `tsconfig.base.json`), so `node:crypto`'s type declarations are not visible here.
 * The host `crypto.subtle` global (available in every Node version this repo
 * targets, with no import) is read through a narrow structural cast instead,
 * mirroring how `fetch-json-http-port.ts` already reads the host `fetch` and
 * `TextDecoder` globals in this same package.
 */
interface HostSubtleCrypto {
  digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer>;
}

/** Encodes text to UTF-8 bytes, without a runtime-specific typing. */
interface HostTextEncoder {
  encode(input: string): Uint8Array;
}

/** The host constructor shape; absent on a runtime with no text encoding. */
type HostTextEncoderCtor = new () => HostTextEncoder;

/** The host Web Crypto `subtle` digest function, read the same way `hostFetch` is. */
function hostSubtleCrypto(): HostSubtleCrypto {
  const subtle = (globalThis as { crypto?: { subtle: HostSubtleCrypto } }).crypto?.subtle;
  if (subtle === undefined) {
    throw new Error('no Web Crypto subtle digest is available in this runtime');
  }
  return subtle;
}

/** A fresh host text encoder, or throws when the runtime provides none. */
function newHostTextEncoder(): HostTextEncoder {
  const ctor = (globalThis as { TextEncoder?: HostTextEncoderCtor }).TextEncoder;
  if (typeof ctor !== 'function') {
    throw new Error('no TextEncoder is available in this runtime');
  }
  return new ctor();
}

/** Lowercase hex SHA-256 of a UTF-8 string, the digest used to pin the prompt. */
async function sha256Hex(text: string): Promise<string> {
  const bytes = newHostTextEncoder().encode(text);
  const hashed = await hostSubtleCrypto().digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hashed), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The canonical fixture Spec this test digests the prompt for.
 *
 * A 4-bit up-counter with a reset: one clocked port, one reset port, one data
 * port, and two simulation-verifiable acceptance criteria. Chosen because it
 * exercises the reset-bearing branch of the state-anchoring and timing rules
 * (mirrors `approvedCounterSpec()` in `app/test/testbench-agent.test.ts`, kept
 * local here so this file has no dependency on another test file's fixtures).
 * Every field is fixed and inlined rather than derived from `newUlid()` for the
 * criteria, so the ONLY thing this Spec's identity depends on that could vary
 * between runs is excluded from what gets hashed (see `promptDigest` below).
 */
function canonicalFixtureSpec(): Spec {
  const moduleInterface: ModuleInterface = {
    validityOutputName: null,
    moduleName: 'up_counter',
    ports: [
      { name: 'clk', direction: 'input', width: 1 },
      { name: 'rst', direction: 'input', width: 1 },
      { name: 'q', direction: 'output', width: 4 },
    ],
    clocking: { clockName: 'clk', resetName: 'rst', resetActiveLow: false },
  };
  return {
    id: newUlid(),
    projectId: newUlid(),
    goal: 'A 4-bit synchronous up counter with reset',
    constraints: ['synchronous active-high reset'],
    architecture: 'A single clocked always block increments q on each rising clk edge.',
    moduleInterface,
    timingContract: timingContractFor(moduleInterface),
    acceptanceCriteria: [
      {
        id: 'ac-increments',
        text: 'q increments by one on each clock while not in reset',
        measurable: true,
        method: 'simulation',
      },
      {
        id: 'ac-reset',
        text: 'q returns to zero when reset is asserted',
        measurable: true,
        method: 'simulation',
      },
    ],
    approved: true,
    version: 3,
  };
}

/** A placeholder Timing_Contract placing every output port at `registered`; nothing here reads it. */
function timingContractFor(moduleInterface: ModuleInterface): TimingContract {
  const entries = moduleInterface.ports
    .filter((port) => port.direction === 'output')
    .map((port) => ({ portName: port.name, timing: 'registered' as const }));
  const built = makeTimingContract(moduleInterface, entries);
  if (!built.ok) {
    throw new Error(`fixture built an invalid timing contract: ${built.error.message}`);
  }
  return built.value;
}

/**
 * Digest the prompt assembled for the canonical fixture Spec.
 *
 * The intent summary and OKF passages are fixed literals (as they are for every
 * generation call in this Spec's session), so the only source of prompt content
 * is the Spec and the derived required checks - exactly what `prompt.ts` is
 * documented to build from.
 */
function promptDigest(): Promise<string> {
  return sha256Hex(cycleTimedPrompt(canonicalFixtureSpec()));
}

/**
 * The canonical streaming fixture: the `accu` interface, clocked with one output qualifier,
 * so it routes In_Order_Scoreboard under the treatment arm.
 */
function accuFixtureSpec(): Spec {
  const moduleInterface: ModuleInterface = {
    validityOutputName: null,
    moduleName: 'accu',
    ports: [
      { name: 'clk', direction: 'input', width: 1 },
      { name: 'data_in', direction: 'input', width: 8 },
      { name: 'valid_in', direction: 'input', width: 1 },
      { name: 'valid_out', direction: 'output', width: 1 },
      { name: 'data_out', direction: 'output', width: 10 },
    ],
    clocking: { clockName: 'clk', resetName: null, resetActiveLow: false },
  };
  return {
    id: newUlid(),
    projectId: newUlid(),
    goal: 'Accumulate four valid inputs and output their sum',
    constraints: ['no reset'],
    architecture: 'A clocked accumulator that raises valid_out after every fourth valid_in.',
    moduleInterface,
    timingContract: timingContractFor(moduleInterface),
    acceptanceCriteria: [
      {
        id: 'ac-sum',
        text: 'data_out is the sum of the last four valid inputs when valid_out is high',
        measurable: true,
        method: 'simulation',
      },
    ],
    approved: true,
    version: 1,
  };
}

const FIXED_INTENT = 'a fixed canonical intent summary for digest pinning';

/** The Grounded_Arm prompt for the given Spec, with the grounded check list. */
function groundedPrompt(spec: Spec): string {
  return buildGroundedTestbenchModelInput(
    { spec, intentSummary: FIXED_INTENT, okfPassages: [] },
    requiredChecksFor(spec, 'grounded'),
  ).prompt;
}

/** The Cycle_Timed prompt for the given Spec, assembled as the agent assembles it. */
function cycleTimedPrompt(spec: Spec): string {
  return buildTestbenchModelInput(
    { spec, intentSummary: FIXED_INTENT, okfPassages: [] },
    requiredChecks(spec),
  ).prompt;
}

/** The In_Order_Scoreboard prompt for the given Spec, over its rendered scaffold. */
function scoreboardPrompt(spec: Spec): string {
  const checks = requiredChecks(spec);
  const scaffold = renderScoreboardScaffold(
    spec.moduleInterface,
    checks.map((check) => check.name),
  );
  if (!scaffold.ok) {
    throw new Error(`the accu fixture must render a scaffold: ${scaffold.error.reason}`);
  }
  return buildScoreboardModelInput(
    { spec, intentSummary: FIXED_INTENT, okfPassages: [] },
    checks,
    scaffold.value,
  ).prompt;
}

/**
 * The Cycle_Timed digest observed at `TESTBENCH_PROMPT_VERSION = 7`.
 *
 * It held at the version-3 value through 6; the Check_Report_Rule is the first move since.
 */
const PINNED_PROMPT_DIGEST_V7 = 'db4782a0d3ad9a170f7c28bf23d51c7c97eebef451fdd38ad44360337b3adba9';

/** The In_Order_Scoreboard `accu` digest observed at version 5. */
const PINNED_SCOREBOARD_DIGEST_V5 =
  'd87cd6915e6e06f21c8c064623205451cb7974b19cd57bb74d812f56f17073cc';

/** The `accu` scoreboard prompt length in UTF-16 code units observed at version 5. */
const PINNED_SCOREBOARD_PROMPT_LENGTH_V5 = 11_751;

/** The Grounded_Arm digest of the canonical up-counter fixture observed at version 7. */
const PINNED_GROUNDED_DIGEST_V7 =
  'a652c971e02482466fbf2f01a3692aa76090a4d5713b75b0118974835bc360b8';

/** `EXPECTED_VALUE_RULE` as shipped before version 7, typed in so no word can drift (Req 4.8). */
const SHIPPED_EXPECTED_VALUE_RULE =
  'Expected values: COMPUTE each one in the testbench, as a Verilog expression over\n' +
  'the same stimulus you drive (for example `expected_sum = a + b + cin;`), and\n' +
  'compare the output against that. Do NOT write in a constant you worked out by\n' +
  'hand while composing the testbench: for any arithmetic or bit-manipulation result\n' +
  'the check then tests your own hand calculation rather than the design.';

/** The scoreboard prompt may cost at most this multiple of the Cycle_Timed prompt. */
const MAX_SCOREBOARD_TO_CYCLE_TIMED_RATIO = 2;

describe('Testbench_Agent prompt digest is pinned to the prompt version (Req 11.6)', () => {
  it('given the canonical fixture Spec when the Cycle_Timed prompt is assembled at version 7 then its digest matches the version-7 pin', async () => {
    expect(TESTBENCH_PROMPT_VERSION).toBe(7);
    await expect(promptDigest()).resolves.toBe(PINNED_PROMPT_DIGEST_V7);
  });

  it('given the canonical fixture Spec when the Grounded_Arm prompt is assembled then its digest matches the version-7 pin', async () => {
    const spec = canonicalFixtureSpec();
    expect(spec.architecture.trim().length).toBeGreaterThan(0);
    await expect(sha256Hex(groundedPrompt(spec))).resolves.toBe(PINNED_GROUNDED_DIGEST_V7);
  });

  it('given the version-7 prompt when EXPECTED_VALUE_RULE is read then it equals its shipped text word for word (Req 4.8)', () => {
    expect(EXPECTED_VALUE_RULE).toBe(SHIPPED_EXPECTED_VALUE_RULE);
  });

  it('given two builds for the same canonical fixture Spec when digested then the digest is deterministic', async () => {
    await expect(promptDigest()).resolves.toBe(await promptDigest());
  });

  it('given the accu fixture when the In_Order_Scoreboard prompt is assembled then its digest matches the version-5 pin', async () => {
    await expect(sha256Hex(scoreboardPrompt(accuFixtureSpec()))).resolves.toBe(
      PINNED_SCOREBOARD_DIGEST_V5,
    );
  });

  it('given the accu fixture when both prompts are assembled then the scoreboard prompt has its pinned size and at most twice the Cycle_Timed size', () => {
    const spec = accuFixtureSpec();
    const scoreboardLength = scoreboardPrompt(spec).length;
    expect(scoreboardLength).toBe(PINNED_SCOREBOARD_PROMPT_LENGTH_V5);
    expect(scoreboardLength).toBeLessThanOrEqual(
      MAX_SCOREBOARD_TO_CYCLE_TIMED_RATIO * cycleTimedPrompt(spec).length,
    );
  });
});
