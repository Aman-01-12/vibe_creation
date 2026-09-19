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
//   for `TESTBENCH_PROMPT_VERSION = 2`'s prompt output, typed in as a constant. A
//   real prompt change requires a human to look at the diff, decide it is (or is
//   not) a rule change, and only then update this literal alongside a version bump.

import { describe, expect, it } from 'vitest';

import { buildTestbenchModelInput, requiredChecks, TESTBENCH_PROMPT_VERSION } from '@app/agent';
import { newUlid, type Spec } from '@app/core';

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
  return {
    id: newUlid(),
    projectId: newUlid(),
    goal: 'A 4-bit synchronous up counter with reset',
    constraints: ['synchronous active-high reset'],
    architecture: 'A single clocked always block increments q on each rising clk edge.',
    moduleInterface: {
      moduleName: 'up_counter',
      ports: [
        { name: 'clk', direction: 'input', width: 1 },
        { name: 'rst', direction: 'input', width: 1 },
        { name: 'q', direction: 'output', width: 4 },
      ],
      clocking: { clockName: 'clk', resetName: 'rst', resetActiveLow: false },
    },
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

/**
 * Digest the prompt assembled for the canonical fixture Spec.
 *
 * The intent summary and OKF passages are fixed literals (as they are for every
 * generation call in this Spec's session), so the only source of prompt content
 * is the Spec and the derived required checks - exactly what `prompt.ts` is
 * documented to build from.
 */
function promptDigest(): Promise<string> {
  const spec = canonicalFixtureSpec();
  const { prompt } = buildTestbenchModelInput(
    { spec, intentSummary: 'a fixed canonical intent summary for digest pinning', okfPassages: [] },
    requiredChecks(spec),
  );
  return sha256Hex(prompt);
}

/**
 * The digest pinned for `TESTBENCH_PROMPT_VERSION = 2`.
 *
 * Recompute and update this literal ONLY as part of a deliberate prompt-rule
 * change, together with bumping `TESTBENCH_PROMPT_VERSION` in `prompt-version.ts`.
 */
const PINNED_PROMPT_DIGEST_V2 = 'f781f7a40956068567507aaa7ebec08144ff3371d06ee0c1f7ab9dac080aeab9';

describe('Testbench_Agent prompt digest is pinned to the prompt version (Req 11.6)', () => {
  it('given the canonical fixture Spec when the prompt is assembled then its digest matches the value pinned for the current prompt version', async () => {
    expect(TESTBENCH_PROMPT_VERSION).toBe(2);
    await expect(promptDigest()).resolves.toBe(PINNED_PROMPT_DIGEST_V2);
  });

  it('given two builds for the same canonical fixture Spec when digested then the digest is deterministic', async () => {
    await expect(promptDigest()).resolves.toBe(await promptDigest());
  });
});
