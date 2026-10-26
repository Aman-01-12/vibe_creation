// **Feature: timing-contract-inference, scan: the Spec_Agent_Prompt asks for per-port timing**
// (task 8.1).
//
// WHY THE ASSEMBLED PROMPT AND NOT THE SOURCE TEXT
//   Requirement 4.1 is about what the prompt ASKS FOR, and `spec-agent.ts` may name an admitted
//   value outside the prompt (it did, in the `assembleTimingContract` task 8.7 deleted, and a
//   comment names one still). A raw text scan of the module would therefore find both admitted
//   values whether or not the prompt mentions them - a false green of exactly the shape task 4.2
//   measured. So the scan runs over the prompt string the
//   model actually receives, captured through the injected `ModelRouter` seam. `#buildRequest` is
//   private and runs before the router result is consulted, so a scripted failure is enough.
//
// REQUIREMENT 7.5: THE REFERENCE_MODEL PROMPT PIN IS CITED, NOT DUPLICATED
//   A pin already exists: `PINNED_DIGEST_V6` in
//   `app/agent/roles/reference-model/prompt-version.test.ts` digests the assembled
//   Reference_Model prompt and compares it to a frozen SHA-256, so any edit to that prompt's text
//   fails there. Repeating the digest here would be a second place to update, and the digest is
//   the stronger check. What that file cannot do is notice its own deletion, so the one thing
//   added here is a scan asserting the pin is still in force - if the digest assertion is removed
//   or weakened, Req 7.5 loses its guard silently, and this fails instead.
//
// Validates: Requirements 4.1, 7.5

import { readFileSync } from 'node:fs';

import {
  InMemorySessionBudgetHandle,
  InMemoryTracePersistence,
  SpecAgent,
  TraceActionRecorder,
  type ModelRequest,
  type ModelRouter,
  type ModelRouterFailure,
  type ModelTask,
  type RoutedModelResult,
  type RoutingDiagnostics,
  type SessionBudgetHandle,
} from '@app/agent';
import { makeSessionBudget, newUlid, type Result } from '@app/core';
import { describe, expect, it } from 'vitest';

/** The field name the Spec_Parser reads entries from, and the closed `PortTiming` vocabulary. */
const TIMING_FIELD = 'timingContractEntries';
const ADMITTED_VALUES = ['registered', 'combinational'] as const;

/** The pinned-digest test that keeps the Reference_Model prompt text fixed (Req 7.5). */
const REFERENCE_MODEL_PIN = '../agent/roles/reference-model/prompt-version.test.ts';

/**
 * Which of the names Requirement 4.1 requires are absent from `prompt`, in listed order.
 *
 * Returns the MISSING names rather than the present ones so a failure reports what to add. The
 * per-port and entry-shape requests are checked separately below, because naming the field is not
 * the same as asking for one statement per declared output port.
 */
function missingTimingNamesIn(prompt: string): readonly string[] {
  return [TIMING_FIELD, ...ADMITTED_VALUES].filter(
    (name) => !new RegExp(`\\b${name}\\b`, 'u').test(prompt),
  );
}

/** A router that keeps the request it was handed and then fails the call. */
class PromptCapturingRouter implements ModelRouter {
  prompt: string | null = null;

  invoke(
    _task: ModelTask,
    request: ModelRequest,
    budget: SessionBudgetHandle,
  ): Promise<Result<RoutedModelResult, ModelRouterFailure>> {
    this.prompt = request.prompt;
    budget.charge({ tokens: 1, costCents: 0, wallClockMs: 1 });
    return Promise.resolve({
      ok: false,
      error: { code: 'ALL_PROVIDERS_FAILED', task: 'hard-planning', attempts: 1 },
    });
  }

  describeRouting(): RoutingDiagnostics {
    return { tasks: [], providers: [] };
  }
}

/** A budget generous enough that the router seam, not the budget, ends the call. */
function generousBudget(): SessionBudgetHandle {
  const built = makeSessionBudget({
    sessionId: newUlid(),
    maxIterations: 100,
    maxTokens: 1_000_000,
    maxWallClockMs: 1_000_000,
    maxCostCents: 1_000_000,
    consumedIterations: 0,
    consumedTokens: 0,
    consumedMs: 0,
    consumedCostCents: 0,
  });
  if (!built.ok) {
    throw new Error('test budget must be valid');
  }
  return new InMemorySessionBudgetHandle(built.value);
}

/** The prompt the Spec_Agent hands the Model_Router for one confirmed intent. */
async function assembledPrompt(): Promise<string> {
  const router = new PromptCapturingRouter();
  const agent = new SpecAgent({
    router,
    recorder: new TraceActionRecorder(new InMemoryTracePersistence()),
    now: () => 1_700_000_000_000,
  });
  await agent.produceSpec(
    {
      sessionId: newUlid(),
      projectId: newUlid(),
      confirmedIntent: 'Build a 4-bit synchronous up counter with reset.',
    },
    generousBudget(),
  );
  if (router.prompt === null) {
    throw new Error('the Spec_Agent assembled no prompt, so there is nothing to scan');
  }
  return router.prompt;
}

describe('the Spec_Agent_Prompt requests one Port_Timing statement per output port (Req 4.1)', () => {
  it('names the timing field and both admitted values', async () => {
    expect(missingTimingNamesIn(await assembledPrompt())).toEqual([]);
  });

  it('asks for the entry shape the Spec_Parser reads, one per declared output port', async () => {
    // NON-VACUITY: the three names above could all appear in prose that asks for nothing. The
    // field must carry `{ portName, timing }` entries, one per declared output port.
    const prompt = await assembledPrompt();
    expect(prompt).toMatch(/timingContractEntries\s*\n?\s*\[\{\s*portName,\s*timing\s*\}\]/u);
    expect(prompt).toMatch(/exactly one timingContractEntries entry per declared output port/u);
  });

  it('reports the field as missing once it is stripped, so the clean result above is a measurement', async () => {
    // POSITIVE CONTROL. A scan that matched nothing would pass every prompt. Stripping each name
    // in turn must be reported, and stripping the field must not be masked by the other two.
    const prompt = await assembledPrompt();
    for (const name of [TIMING_FIELD, ...ADMITTED_VALUES]) {
      expect(missingTimingNamesIn(prompt.replaceAll(name, ''))).toEqual([name]);
    }
    expect(missingTimingNamesIn(prompt.replaceAll(/^.*timingContractEntries.*$/gmu, ''))).toEqual([
      TIMING_FIELD,
    ]);
  });
});

describe('the Reference_Model prompt stays pinned unchanged by this feature (Req 7.5)', () => {
  it('keeps the pinned-digest assertion in force in the Reference_Model role', () => {
    // The digest itself is NOT repeated here - see the header. This asserts only that the pin
    // still exists and still compares an assembled prompt against a frozen 64-hex digest, so
    // deleting or loosening it fails loudly rather than silently retiring Req 7.5's guard.
    const pinSource = readFileSync(new URL(REFERENCE_MODEL_PIN, import.meta.url), 'utf8');
    expect(pinSource).toMatch(/const PINNED_DIGEST_V\d+ = '[0-9a-f]{64}';/u);
    expect(pinSource).toMatch(/sha256Hex\(prompt\)\)\.resolves\.toBe\(PINNED_DIGEST_V\d+\)/u);
  });
});
