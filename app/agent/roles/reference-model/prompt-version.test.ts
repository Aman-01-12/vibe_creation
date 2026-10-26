// Pinned prompt digest test (task 10.1), mirroring the Testbench_Agent's own
// hand-bumped-version-plus-pinned-digest convention.

import { describe, expect, it } from 'vitest';

import {
  makeTimingContract,
  newUlid,
  type ModuleInterface,
  type Spec,
  type TimingContract,
} from '@app/core';

import { checkAuthoringContract } from './authoring-contract.js';
import { EXAMPLE_DRAFT } from './canonical-example.js';
import { buildReferenceModelInput } from './prompt.js';
import { REFERENCE_MODEL_PROMPT_VERSION } from './prompt-version.js';

interface HostSubtleCrypto {
  digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer>;
}

interface HostTextEncoder {
  encode(input: string): Uint8Array;
}

type HostTextEncoderCtor = new () => HostTextEncoder;

function hostSubtleCrypto(): HostSubtleCrypto {
  const subtle = (globalThis as { crypto?: { subtle: HostSubtleCrypto } }).crypto?.subtle;
  if (subtle === undefined) {
    throw new Error('no Web Crypto subtle digest is available in this runtime');
  }
  return subtle;
}

function newHostTextEncoder(): HostTextEncoder {
  const ctor = (globalThis as { TextEncoder?: HostTextEncoderCtor }).TextEncoder;
  if (typeof ctor !== 'function') {
    throw new Error('no TextEncoder is available in this runtime');
  }
  return new ctor();
}

/** Lowercase hex SHA-256 of a UTF-8 string. */
async function sha256Hex(text: string): Promise<string> {
  const bytes = newHostTextEncoder().encode(text);
  const hashed = await hostSubtleCrypto().digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hashed), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

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

/** 4-bit up-counter with reset: one clocked input, one reset input, one data output. */
function counterSpec(): Spec {
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
    ],
    approved: true,
    version: 1,
  };
}

const PINNED_DIGEST_V7 = '3ab50d336bee656c900bb0e0c8018ffbf006215a5aa49f15fefbe4adb8cb7b9d';

describe('Reference_Model prompt is pinned to the prompt version (Req 5.1, 5.4-5.7)', () => {
  it('given the counter fixture when the prompt is assembled at version 7 then its digest matches the pin', async () => {
    expect(REFERENCE_MODEL_PROMPT_VERSION).toBe(7);
    const prompt = buildReferenceModelInput(counterSpec()).prompt;
    await expect(sha256Hex(prompt)).resolves.toBe(PINNED_DIGEST_V7);
  });

  it('given no minimum/maximum check count language when the prompt is rendered then it names none', () => {
    const prompt = buildReferenceModelInput(counterSpec()).prompt;
    expect(prompt).not.toMatch(/at least \d+ checks?/i);
    expect(prompt).not.toMatch(/no more than \d+ checks?/i);
    expect(prompt).toContain('no required or capped number of checks');
  });

  it('given the counter fixture when the prompt is rendered then it carries the three function headers', () => {
    const prompt = buildReferenceModelInput(counterSpec()).prompt;
    expect(prompt).toContain('ece_reset_state(input dummy)');
    expect(prompt).not.toContain('ece_stimulus');
    expect(prompt).toContain('ece_next_state');
    expect(prompt).toContain('ece_expect');
  });

  it('given the counter fixture when the prompt is rendered then it states the roles vocabulary and the Sample_Budget', () => {
    const prompt = buildReferenceModelInput(counterSpec()).prompt;
    expect(prompt).toContain('`data` or `enable`');
    expect(prompt).toMatch(
      /Sample_Budget: ece_next_state and ece_expect are authored against \d+ steps/,
    );
  });

  it('given two builds for the same Spec when digested then the digest is deterministic', async () => {
    const spec = counterSpec();
    const first = await sha256Hex(buildReferenceModelInput(spec).prompt);
    const second = await sha256Hex(buildReferenceModelInput(spec).prompt);
    expect(first).toBe(second);
  });

  it('given an interface when rendered then each packing is also shown most significant first', () => {
    const prompt = buildReferenceModelInput(counterSpec()).prompt;
    expect(prompt).toContain('as a concatenation, most significant first: {q}');
    expect(prompt).toContain('as a concatenation, most significant first: {zero, cnt}');
  });

  it('given the worked example when contract-checked then the prompt teaches an accepted draft', () => {
    expect(checkAuthoringContract(EXAMPLE_DRAFT).kind).toBe('accepted');
    expect(buildReferenceModelInput(counterSpec()).prompt).toContain(EXAMPLE_DRAFT.resetStateBody);
  });
});
