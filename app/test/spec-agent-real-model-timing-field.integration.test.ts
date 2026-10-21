// timing-contract-inference, task 8.13: does the UPDATED Spec_Agent_Prompt actually make a real
// model emit `timingContractEntries`, one statement per port it proposes as an output?
//
// WHY THIS NEEDS A REAL MODEL AND CANNOT BE DISCHARGED BY READING THE PROMPT
//   `spec-agent-prompt-timing-field.test.ts` (task 8.1) proves the ASSEMBLED PROMPT asks for the
//   field. `spec-agent-timing-authoring-integration.test.ts` (task 8.12) proves the PARSER AND
//   VALIDATOR handle a reply that carries the field, one that omits it, and one that gets it
//   wrong - but every reply in that file is a scripted literal, authored by this session, not
//   produced by a model reading the prompt. Neither file can tell us whether the prompt edit
//   actually MOVES a real model's behaviour. This file spends exactly one real call to answer
//   that, and only that.
//
// ONE REQUEST, NO RETRY (Req 4.1; founder-authorized for this task, separately from Req 8.9)
//   Task 8.9's hold on the Paired_Contract_Experiment (task group 15) does not cover this check:
//   this is not a step of that re-measurement. The founder authorized this single real call in
//   session. The router is wired so a parse failure or a timeout CANNOT trigger a second
//   provider attempt: `singleProviderRoutingPolicy` with no `fallbackModel` yields a one-entry
//   chain for every task, so `TaskModelRouter.invoke` can try at most once no matter what the
//   reply looks like. If the call fails, times out, or the reply does not carry the field, that
//   is the finding this test reports - nothing here re-sends.
//
// MODEL CHOICE
//   `deepseek.v3.2` on the `bedrock-mantle` host: it is the model Requirement-area routing already
//   treats as the generation-class default across this codebase's eval wiring (`live-wiring.ts`,
//   MODEL_IDS), so picking it adds no new routing policy shape, just one more
//   `singleProviderRoutingPolicy` call of the kind already used by `grounded-reply-probe.ts`.
//
// SKIP, AND WHY A SKIP HERE IS NOT A WEAKENING
//   Gated on the Credential_File (`DEFAULT_CREDENTIAL_FILE`) being present and non-empty, read
//   once at module load exactly as `real-oracle-harness.ts`'s toolchain probes are. A host with no
//   credential provisioned skips with its reason surfaced; it never fabricates a result or silently
//   passes. The credential's VALUE is never read into a variable this file keeps past the one
//   `RefreshingSecretManager` call that resolves it at the point of use, and it is never logged.
//
// WHAT IS ASSERTED, AND WHAT IS DELIBERATELY NOT
//   The raw reply is parsed with the SAME `parseSpecDraft` boundary production uses, so the
//   assertion is over the real trust boundary and not a hand-rolled regex. What is checked is
//   CARDINALITY: one `timingContractEntries` entry per port the model proposed as an output,
//   named with that port's own name. Exact wording, exact port names, and exact timing values are
//   never asserted - the model is free to propose any interface it likes for the intent given.
//   A resulting `needs-revision` presentation (e.g. because the model's `timing` value or a port
//   name does not validate) is reported, not failed on, as long as the field itself was present at
//   the right cardinality in the raw reply: that is a validation-layer finding, not a prompt
//   finding, and task 8.12 already covers the validation layer.

import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createBedrockMantleTransport,
  createFetchJsonHttpPort,
  createModelRouter,
  DEFAULT_CREDENTIAL_FILE,
  InMemorySessionBudgetHandle,
  InMemoryTracePersistence,
  MODEL_TASKS,
  parseSpecDraft,
  RefreshingSecretManager,
  singleProviderRoutingPolicy,
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

/** This module's directory, resolved in either the source or the built-`dist` layout. */
const HERE = dirname(fileURLToPath(import.meta.url));

/** The repository root, two levels up from `app/test/` in either layout. */
const REPOSITORY_ROOT = resolve(HERE, basename(HERE) === 'dist' ? '../../..' : '../..');

/** The Credential_File path this probe and the real secret manager both resolve against. */
const CREDENTIAL_PATH = join(REPOSITORY_ROOT, DEFAULT_CREDENTIAL_FILE);

/** The one model id this file sends its one request to. See header for why this one. */
const MODEL_ID = 'deepseek.v3.2';

/** Per-call deadline. Generous enough for one hard-planning reply; no retry follows a breach. */
const REQUEST_TIMEOUT_MS = 60_000;

/** The vitest timeout for the one test below: the request deadline plus headroom. */
const TEST_TIMEOUT_MS = REQUEST_TIMEOUT_MS + 30_000;

/** Whether the Credential_File exists and is usable, checked once without ever holding its text. */
interface CredentialProbe {
  readonly available: boolean;
  readonly reason: string;
}

/** Read the Credential_File once, synchronously, and report usability without exposing its text. */
function probeCredential(): CredentialProbe {
  let raw: string | null;
  try {
    raw = readFileSync(CREDENTIAL_PATH, 'utf8');
  } catch {
    raw = null;
  }
  if (raw === null || raw.trim().length === 0) {
    return { available: false, reason: `no usable credential at ${DEFAULT_CREDENTIAL_FILE}` };
  }
  return { available: true, reason: `${DEFAULT_CREDENTIAL_FILE} is present and non-empty` };
}

/** The module-load-time probe this suite's one real-call test is gated on. */
const CREDENTIAL_PROBE: CredentialProbe = probeCredential();

if (!CREDENTIAL_PROBE.available) {
  console.warn(
    `[spec-agent-real-model-timing-field] SKIPPED - no real call was made: ${CREDENTIAL_PROBE.reason}`,
  );
}

/** A router that keeps the one routed outcome it was handed, success or failure. */
class CapturingRouter implements ModelRouter {
  result: Result<RoutedModelResult, ModelRouterFailure> | null = null;
  readonly #inner: ModelRouter;

  constructor(inner: ModelRouter) {
    this.#inner = inner;
  }

  async invoke(
    task: ModelTask,
    request: ModelRequest,
    budget: SessionBudgetHandle,
  ): Promise<Result<RoutedModelResult, ModelRouterFailure>> {
    const outcome = await this.#inner.invoke(task, request, budget);
    this.result = outcome;
    return outcome;
  }

  describeRouting(): RoutingDiagnostics {
    return this.#inner.describeRouting();
  }
}

/**
 * The real, credential-confined router for this one call: `bedrock-mantle` only, a one-entry
 * chain per task (no `fallbackModel`), which is what makes a second attempt structurally
 * unreachable regardless of how the first one ends.
 */
function buildRealRouter(): ModelRouter {
  const taskModel = Object.fromEntries(MODEL_TASKS.map((task) => [task, MODEL_ID])) as Record<
    ModelTask,
    string
  >;
  const policy = singleProviderRoutingPolicy({
    provider: 'bedrock-mantle',
    taskModel,
    maxAttempts: 1,
  });
  const transport = createBedrockMantleTransport({
    http: createFetchJsonHttpPort(),
    config: {
      region: process.env['BEDROCK_REGION'] ?? 'us-east-1',
      defaultModelId: MODEL_ID,
      temperature: 0,
      requestTimeoutMs: REQUEST_TIMEOUT_MS,
      prices: {},
    },
  });
  const secretManager = new RefreshingSecretManager({
    path: CREDENTIAL_PATH,
    readFile: async (path: string) => {
      try {
        return await readFile(path, 'utf8');
      } catch {
        return null;
      }
    },
  });
  return createModelRouter({
    secretManager,
    recorder: new TraceActionRecorder(new InMemoryTracePersistence()),
    transports: { 'bedrock-mantle': transport },
    policy,
  });
}

/** A budget comfortably inside the single call's own deadline. */
function callBudget(): SessionBudgetHandle {
  const built = makeSessionBudget({
    sessionId: newUlid(),
    maxIterations: 2,
    maxTokens: 1_000_000,
    maxWallClockMs: REQUEST_TIMEOUT_MS + 10_000,
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

describe.skipIf(!CREDENTIAL_PROBE.available)(
  'the real Spec_Agent prompt, sent once to a real model (Req 4.1, task 8.13)',
  () => {
    it(
      'the raw reply carries one timingContractEntries statement per proposed output port',
      async () => {
        const capturing = new CapturingRouter(buildRealRouter());
        const agent = new SpecAgent({
          router: capturing,
          recorder: new TraceActionRecorder(new InMemoryTracePersistence()),
        });

        const presentation = await agent.produceSpec(
          {
            sessionId: newUlid(),
            projectId: newUlid(),
            confirmedIntent:
              'Build a 4-bit synchronous up counter with an active-low reset and a carry output.',
          },
          callBudget(),
        );

        const invocation = capturing.result;
        if (invocation === null) {
          throw new Error('the Spec_Agent made no router call at all');
        }
        if (!invocation.ok) {
          throw new Error(`the one real call failed: ${invocation.error.code}`);
        }
        // The chain shape (one entry per task) is what makes this structural rather than
        // observed luck: `attempts` can only ever read 1 here.
        expect(invocation.value.attempts).toBe(1);
        expect(invocation.value.fellBack).toBe(false);

        const draft = parseSpecDraft(invocation.value.outputText);
        if (!draft.ok) {
          throw new Error(`the real reply did not parse as a Spec draft: ${draft.error}`);
        }

        const outputPortNames = draft.value.moduleInterface.ports
          .filter((port) => port.direction === 'output')
          .map((port) => port.name);
        // Non-vacuity: a cardinality check against zero proposed output ports would pass
        // trivially and prove nothing about the field this task is measuring.
        expect(outputPortNames.length).toBeGreaterThan(0);

        expect(draft.value.timingContractEntries).toHaveLength(outputPortNames.length);
        expect(new Set(draft.value.timingContractEntries.map((entry) => entry.portName))).toEqual(
          new Set(outputPortNames),
        );

        // Either editable presentation is a sensible outcome of a real reply; a crash is not.
        // `needs-revision` here would mean the field was present but something about its
        // CONTENT failed validation (Req 10.4, 10.5) or the model happened to leave a timing
        // value out despite the cardinality above - both are validation-layer findings already
        // covered by task 8.12, not a reason to fail this prompt-level check.
        expect(['awaiting-approval', 'needs-revision']).toContain(presentation.status);
        if (presentation.status === 'needs-revision') {
          console.warn(
            '[spec-agent-real-model-timing-field] real reply needed revision: ' +
              `timingUnstated=${JSON.stringify(presentation.issues.timingUnstated)}, ` +
              `signalIssues=${String(presentation.issues.signalIssues.length)}`,
          );
        }
      },
      TEST_TIMEOUT_MS,
    );
  },
);
