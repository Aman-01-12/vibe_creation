// Unit tests for the production `EvalLoopRunner` (task 19.4).
//
// NO NETWORK AND NO REAL MODEL CALL. The bedrock-mantle transport's HTTP seam is a
// fake that records every outbound request and replies from a script, the sandbox
// runtime is a `FakeSandboxRuntime` that derives its capture from the RTL it is
// handed, and the credential is a synthetic string used only to prove it stays in the
// outbound header. Everything BETWEEN those two seams is the real production wiring:
// the real Model_Router with its real bedrock-mantle adapter and eval routing policy,
// the real Generation_Agent, the real RTL-isolated Testbench_Agent, the real
// generation gate, the real Simulator adapter, and the real oracle Trust_Labeler.
//
// What these examples pin:
//   - the per-sample seed and the fixed temperature reach EVERY model call;
//   - the harness's metered student-caps budget and its sandbox limits are threaded
//     through UNCHANGED, into the model calls and into every simulate run;
//   - the outcome is the ORACLE's: a candidate the testbench passes yields `verified`
//     bound to a recorded oracle span, and a candidate it fails never does, no matter
//     what the model text claimed;
//   - a missing credential, an unreachable transport, and a sandbox fault each
//     surface as a sanitized non-pass rather than a crash or a silent pass;
//   - the testbench-generation request cannot carry RTL (anti-circular, Property 4).

import { describe, expect, it } from 'vitest';

import {
  makePort,
  makeSessionBudget,
  makeTimingContract,
  newUlid,
  type AcceptanceCriterion,
  type ModuleInterface,
  type Port,
  type PortDirection,
  type SessionBudget,
  type Spec,
} from '@app/core';
import type { KnowledgeQuery, KnowledgeRetriever, RetrievalResult } from '@app/knowledge';
import {
  FakeSandboxRuntime,
  type ContainerSpec,
  type FormalArtifactReader,
  type RawRunCapture,
  type ResourceLimits,
  type SandboxJob,
  type SourceFile,
} from '@app/tools';
import {
  BEDROCK_CREDENTIAL_ENV_KEY,
  EnvSecretManager,
  createFetchJsonHttpPort,
  formatCheckLine,
  requiredChecks,
  type HostByteReader,
  type HostByteStream,
  type HostFetch,
  type JsonHttpPort,
  type JsonHttpRequest,
  type VerificationOutcome,
} from '@app/agent';

import { MeteredSessionBudget } from './metered-budget.js';
import type { EvalProblem } from './problem.js';
import { singleModelEvalRoutingPolicy } from './routing-policy.js';
import { EvalVerificationLoopRunner } from './verification-loop-runner.js';

// -- Fixtures ---------------------------------------------------------------

/** A synthetic credential. Never a real token; used to prove it never leaks. */
const SYNTHETIC_CREDENTIAL = 'synthetic-bearer-value-for-tests';

/** The one bedrock-mantle catalog id every role is served from in these examples. */
const MODEL_ID = 'qwen.qwen3-coder-480b-a35b-instruct';

/** Sandbox limits the harness supplies; asserted to reach the runtime unchanged. */
const LIMITS: ResourceLimits = { cpu: 1, memMb: 384, procs: 48, diskMb: 96, wallMs: 12_345 };

/** The student-session caps every sample runs under. */
const CAPS: SessionBudget = {
  sessionId: newUlid(),
  maxIterations: 6,
  maxTokens: 1_000_000,
  maxWallClockMs: 1_000_000,
  maxCostCents: 1_000_000,
  consumedIterations: 0,
  consumedTokens: 0,
  consumedMs: 0,
  consumedCostCents: 0,
};

/** The deterministic per-sample seed and temperature the harness would derive. */
const SEED = 20_240_115;
const TEMPERATURE = 0;

/** Token usage the fake provider reports, so charged cost is real, not invented. */
const USAGE = { prompt_tokens: 1_000, completion_tokens: 1_000, total_tokens: 2_000 };

/** Price for the one model in play, so per-session cost is measurable. */
const PRICES = {
  [MODEL_ID]: { inputCentsPerMillionTokens: 100, outputCentsPerMillionTokens: 100 },
} as const;

/** Cents one priced model call costs: 2000 tokens at 100c per million. */
const CENTS_PER_CALL = 0.2;

/** Build a fixture `Port`, failing loudly on an invalid hardcoded value. */
function port(name: string, direction: PortDirection, width: number): Port {
  const built = makePort({ name, direction, width });
  if (!built.ok) {
    throw new Error(`invalid fixture port "${name}": ${built.error.message}`);
  }
  return built.value;
}

/** The module interface the candidate RTL must match exactly (combinational). */
const MODULE_INTERFACE: ModuleInterface = {
  validityOutputName: null,
  moduleName: 'passthrough',
  ports: [port('a', 'input', 1), port('y', 'output', 1)],
  clocking: { clockName: null, resetName: null, resetActiveLow: false },
};

/** One simulation-verifiable acceptance criterion. */
const CRITERION: AcceptanceCriterion = {
  id: newUlid(),
  text: 'the output tracks the input',
  measurable: true,
  method: 'simulation',
};

/** Placeholder Timing_Contract for `MODULE_INTERFACE`, placing `y` at `combinational`. */
const TIMING_CONTRACT = (() => {
  const built = makeTimingContract(MODULE_INTERFACE, [{ portName: 'y', timing: 'combinational' }]);
  if (!built.ok) {
    throw new Error(`invalid fixture timing contract: ${built.error.message}`);
  }
  return built.value;
})();

/** The pre-approved Spec the loop generates against and the oracle verifies. */
const SPEC: Spec = {
  id: newUlid(),
  projectId: newUlid(),
  goal: 'Drive the output directly from the input.',
  constraints: ['Purely combinational'],
  moduleInterface: MODULE_INTERFACE,
  timingContract: TIMING_CONTRACT,
  acceptanceCriteria: [CRITERION],
  architecture: 'A single continuous assignment from the input to the output.',
  approved: true,
  version: 1,
};

/** The eval problem one sample attempts. */
const PROBLEM: EvalProblem = {
  id: 'unit/passthrough',
  title: 'Passthrough',
  source: 'VerilogEval',
  spec: SPEC,
  intentSummary: 'A one-bit wire that copies its input to its output.',
};

/** RTL matching the Spec interface exactly; the fake oracle passes it. */
const CORRECT_RTL = `module passthrough (
  input  wire a,
  output wire y
);
  assign y = a;
endmodule
`;

/** RTL with the same interface but inverted behavior; the fake oracle fails it. */
const BUGGY_RTL = `module passthrough (
  input  wire a,
  output wire y
);
  assign y = ~a; // BUG: inverts instead of passing through
endmodule
`;

/** The check names the Testbench_Agent requires for this Spec. */
const CHECK_NAMES: readonly string[] = requiredChecks(SPEC).map((check) => check.name);

/** A testbench source emitting every required check, as the real agent would. */
const TESTBENCH_SOURCE = `\`timescale 1ns/1ps
module passthrough_tb;
  reg a;
  wire y;
  passthrough dut (.a(a), .y(y));
  initial begin
    $dumpfile("dump.vcd");
    $dumpvars(0, passthrough_tb);
${CHECK_NAMES.map((name) => `    $display("${formatCheckLine(name, true)}");`).join('\n')}
    $finish;
  end
endmodule
`;

// -- Fake provider (the ONLY model seam; no network) ------------------------

/** One scripted provider reply body: generation RTL or a testbench source. */
function replyBody(payload: Readonly<Record<string, string>>): string {
  return JSON.stringify({
    choices: [{ message: { content: JSON.stringify(payload) } }],
    usage: USAGE,
  });
}

/**
 * A fake `JsonHttpPort` that records every outbound request and answers from the
 * prompt: a testbench prompt gets the testbench source, anything else gets RTL.
 *
 * Routing on the prompt (rather than on call order) keeps the fake honest about the
 * loop running generation and testbench generation in PARALLEL.
 */
class FakeProviderHttp {
  readonly requests: JsonHttpRequest[] = [];
  readonly #rtl: string;
  readonly #reachable: boolean;

  constructor(rtl: string, reachable = true) {
    this.#rtl = rtl;
    this.#reachable = reachable;
  }

  get port(): JsonHttpPort {
    return (request) => {
      this.requests.push(request);
      if (!this.#reachable) {
        return Promise.reject(new Error('network unreachable'));
      }
      const isTestbench = request.body.includes('testbench');
      const payload = isTestbench ? { source: TESTBENCH_SOURCE } : { rtl: this.#rtl };
      return Promise.resolve({ status: 200, body: replyBody(payload) });
    };
  }

  /** Every recorded request body, parsed. */
  bodies(): Record<string, unknown>[] {
    return this.requests.map((request) => JSON.parse(request.body) as Record<string, unknown>);
  }
}

/** The per-call deadline the fetch-backed seam carries; the fake never waits on it. */
const FETCH_PORT_TIMEOUT_MS = 240_000;

/** A one-chunk reply stream over an ASCII body, as the host `fetch` exposes one. */
function bodyStream(body: string): HostByteStream {
  const bytes = new Uint8Array(body.length);
  for (let index = 0; index < body.length; index += 1) {
    bytes[index] = body.charCodeAt(index);
  }
  return {
    getReader: (): HostByteReader => {
      let delivered = false;
      return {
        read: () => {
          if (delivered) {
            return Promise.resolve({ done: true });
          }
          delivered = true;
          return Promise.resolve({ done: false, value: bytes });
        },
        cancel: () => Promise.resolve(),
      };
    },
  };
}

/**
 * The same scripted provider exposed as a host `fetch` instead of a `JsonHttpPort`.
 *
 * This lets one example drive the loop through the REAL production HTTP port
 * (`createFetchJsonHttpPort`), proving it is a drop-in `http` dependency, while the
 * only fake left in the chain is the host `fetch` itself - so still no network.
 */
function providerFetch(provider: FakeProviderHttp): HostFetch {
  return async (url, init) => {
    const reply = await provider.port({
      url,
      headers: init.headers,
      body: init.body,
      timeoutMs: FETCH_PORT_TIMEOUT_MS,
    });
    return { status: reply.status, body: bodyStream(reply.body) };
  };
}

/** A retriever that returns no passages, so the OKF seam is real but empty. */
class EmptyRetriever implements KnowledgeRetriever {
  readonly queries: KnowledgeQuery[] = [];

  retrieve(query: KnowledgeQuery): Promise<RetrievalResult> {
    this.queries.push(query);
    return Promise.resolve({
      passages: [],
      citations: [],
      facts: [],
      source: 'okf',
      sanitized: true,
    });
  }
}

// -- Fake oracle (stands in for iverilog + vvp only) -----------------------

/** A synthetic non-null VCD so a completed run classifies functionally. */
const FAKE_VCD = { name: 'dump.vcd', sizeBytes: 8, sha256: 'a'.repeat(64) } as const;

/** The RTL workspace file of a simulate job (the `<module>.v`, not the `_tb.v`). */
function rtlFileOf(job: SandboxJob): SourceFile | undefined {
  return job.workspaceFiles.find(
    (file) => file.path.endsWith('.v') && !file.path.endsWith('_tb.v'),
  );
}

/** The `CHECK` stdout for a passing or failing candidate, one line per check. */
function checkSignalling(passed: boolean): string {
  return `${CHECK_NAMES.map((name) => formatCheckLine(name, passed)).join('\n')}\n`;
}

/** An infrastructure-failure capture: the sandbox produced nothing usable. */
const INFRA_FAILURE: RawRunCapture = {
  timedOut: false,
  infraFailure: true,
  exitCode: null,
  stdout: null,
  stderr: null,
  stdoutTruncated: false,
  stderrTruncated: false,
  diskLimitExceeded: false,
  artifacts: {},
  deniedOperations: [],
  resourceUsage: { wallMs: 0, maxMemMb: 0, cpuMs: 0 },
};

/** Records the container specs and jobs the runtime was launched with. */
interface SandboxLog {
  readonly specs: ContainerSpec[];
  readonly jobs: SandboxJob[];
}

/**
 * A fake sandbox runtime that derives its verdict from the candidate RTL it is
 * handed - exactly as the real toolchain would - and never from a script. It stands
 * in for `iverilog` + `vvp` and gVisor isolation, nothing else.
 */
function fakeRuntime(log: SandboxLog, faulty = false): FakeSandboxRuntime {
  return new FakeSandboxRuntime((job, spec) => {
    log.jobs.push(job);
    log.specs.push(spec);
    if (faulty) {
      return INFRA_FAILURE;
    }
    const rtlFile = rtlFileOf(job);
    const passed = rtlFile?.contents === CORRECT_RTL;
    return {
      timedOut: false,
      infraFailure: false,
      exitCode: 0,
      stdout: checkSignalling(passed),
      stderr: '',
      stdoutTruncated: false,
      stderrTruncated: false,
      diskLimitExceeded: false,
      artifacts: { vcd: FAKE_VCD },
      deniedOperations: [],
      resourceUsage: { wallMs: 5, maxMemMb: 8, cpuMs: 4 },
    };
  });
}

// -- Assembly ---------------------------------------------------------------

/** The environment map the env-backed secret manager resolves the credential from. */
function environment(withCredential: boolean): Record<string, string> {
  return withCredential ? { [BEDROCK_CREDENTIAL_ENV_KEY]: SYNTHETIC_CREDENTIAL } : {};
}

/** One assembled scenario: the runner plus the seams the assertions read. */
interface Scenario {
  readonly runner: EvalVerificationLoopRunner;
  readonly http: FakeProviderHttp;
  readonly sandbox: SandboxLog;
  readonly retriever: EmptyRetriever;
  readonly budget: MeteredSessionBudget;
}

/** Assemble a scenario over the given RTL and seam behaviors. */
function scenario(
  options: {
    readonly rtl?: string;
    readonly withCredential?: boolean;
    readonly reachable?: boolean;
    readonly faultySandbox?: boolean;
    /** Drive the model calls through the real fetch-backed port over a fake `fetch`. */
    readonly viaFetchPort?: boolean;
    /** Inject the formal gate's artifact store, which is what wires the gate at all. */
    readonly formalArtifacts?: FormalArtifactReader;
  } = {},
): Scenario {
  const http = new FakeProviderHttp(options.rtl ?? CORRECT_RTL, options.reachable ?? true);
  const sandbox: SandboxLog = { specs: [], jobs: [] };
  const retriever = new EmptyRetriever();
  const built = makeSessionBudget({ ...CAPS, sessionId: newUlid() });
  if (!built.ok) {
    throw new Error(`invalid fixture budget: ${built.error.message}`);
  }
  const runner = new EvalVerificationLoopRunner({
    modelHost: { region: 'us-east-1', prices: PRICES },
    routingPolicy: singleModelEvalRoutingPolicy(MODEL_ID),
    http:
      (options.viaFetchPort ?? false)
        ? createFetchJsonHttpPort({ fetch: providerFetch(http) })
        : http.port,
    sandboxRuntime: fakeRuntime(sandbox, options.faultySandbox ?? false),
    retriever,
    ...(options.formalArtifacts === undefined ? {} : { formalArtifacts: options.formalArtifacts }),
    secretManager: new EnvSecretManager(environment(options.withCredential ?? true)),
    now: () => 0,
  });
  return { runner, http, sandbox, retriever, budget: new MeteredSessionBudget(built.value) };
}

/** Run one sample through a scenario with the harness-supplied seed/temperature. */
function runSample(
  scene: Scenario,
  overrides: { readonly seed?: number; readonly temperature?: number } = {},
): Promise<VerificationOutcome> {
  return scene.runner.runSample({
    problem: PROBLEM,
    sampleIndex: 0,
    strategyArm: 'control',
    seed: overrides.seed ?? SEED,
    temperature: overrides.temperature ?? TEMPERATURE,
    budget: scene.budget,
    limits: LIMITS,
  });
}

// -- Seed and temperature threading (Req 15.10) ----------------------------

describe('EvalVerificationLoopRunner - seed and temperature threading', () => {
  it('pins the sample seed and the fixed temperature on every model call', async () => {
    const scene = scenario();
    await runSample(scene, { seed: SEED, temperature: 0 });

    expect(scene.http.requests.length).toBeGreaterThanOrEqual(2);
    for (const body of scene.http.bodies()) {
      expect(body.seed).toBe(SEED);
      expect(body.temperature).toBe(0);
      expect(body.model).toBe(MODEL_ID);
    }
  });

  it('carries a different sample seed through unchanged', async () => {
    const scene = scenario();
    await runSample(scene, { seed: 7 });

    for (const body of scene.http.bodies()) {
      expect(body.seed).toBe(7);
    }
  });

  it('honors a non-zero temperature from the reproducibility config', async () => {
    const scene = scenario();
    await runSample(scene, { temperature: 0.7 });

    for (const body of scene.http.bodies()) {
      expect(body.temperature).toBe(0.7);
    }
  });

  it('rejects an out-of-range seed or temperature without making a model call', async () => {
    for (const overrides of [{ seed: -1 }, { seed: 1.5 }, { temperature: 9 }]) {
      const scene = scenario();
      const outcome = await runSample(scene, overrides);

      expect(outcome.status).toBe('setup-failed');
      expect(scene.http.requests).toHaveLength(0);
      expect(scene.sandbox.jobs).toHaveLength(0);
    }
  });
});

// -- Budget and limits threading (Req 15.6) --------------------------------

describe('EvalVerificationLoopRunner - budget and limits threading', () => {
  it('charges the harness budget for every model call and simulate run', async () => {
    const scene = scenario();
    await runSample(scene);
    const consumed = scene.budget.consumed();

    // One generation call plus one testbench call, both reporting real usage.
    expect(consumed.tokens).toBe(2 * USAGE.total_tokens);
    expect(consumed.costCents).toBeCloseTo(2 * CENTS_PER_CALL, 10);
    // Two model calls plus one simulate, each counting one iteration.
    expect(consumed.iterations).toBe(3);
  });

  it('threads the harness sandbox limits into the sandbox unchanged', async () => {
    const scene = scenario();
    await runSample(scene);

    expect(scene.sandbox.jobs.length).toBeGreaterThan(0);
    for (const job of scene.sandbox.jobs) {
      expect(job.limits).toEqual(LIMITS);
    }
    for (const spec of scene.sandbox.specs) {
      expect(spec.limits).toEqual(LIMITS);
    }
  });

  it('stops at the student iteration cap instead of looping forever', async () => {
    const scene = scenario({ rtl: BUGGY_RTL });
    const outcome = await runSample(scene);
    const consumed = scene.budget.consumed();

    expect(outcome.status).toBe('unverified');
    if (outcome.status !== 'unverified') return;
    expect(outcome.stopReason).toBe('max-iterations');
    expect(outcome.iterations).toBeLessThanOrEqual(CAPS.maxIterations);
    // The Verification_Loop always simulates the candidate it already holds BEFORE
    // testing the budget, so a pass found on the last affordable candidate is still
    // Verified (Req 8.9). That deliberately admits exactly one simulate charge past
    // the iteration cap; a simulate charges no tokens and no cents, so the
    // pennies-per-session envelope the harness asserts is unaffected.
    expect(consumed.iterations).toBeLessThanOrEqual(CAPS.maxIterations + 1);
    expect(consumed.costCents).toBeLessThan(CAPS.maxCostCents);
  });
});

// -- The oracle decides (Req 15.3) -----------------------------------------

describe('EvalVerificationLoopRunner - the oracle decides, untouched', () => {
  it('returns the verified outcome bound to the recorded passing oracle span', async () => {
    const outcome = await runSample(scenario());

    expect(outcome.status).toBe('verified');
    if (outcome.status !== 'verified') return;
    expect(outcome.label.tier).toBe('Verified');
    expect(outcome.label.oracleSpanRef).toBe(outcome.oracleSpanId);
    expect(outcome.result.verdict).toBe('pass');
    expect(outcome.simulation.checks.every((check) => check.passed)).toBe(true);
    expect(outcome.moduleVersion.rtl).toBe(CORRECT_RTL);
  });

  it('never reports verified for RTL the oracle failed, whatever the model returned', async () => {
    const scene = scenario({ rtl: BUGGY_RTL });
    const outcome = await runSample(scene);

    expect(outcome.status).toBe('unverified');
    if (outcome.status !== 'unverified') return;
    expect(outcome.label.tier).toBe('Unverified');
    expect(outcome.simulation.verdict).toBe('fail');
    expect(outcome.failingCase?.checkName).toBe(CHECK_NAMES[0]);
  });

  it('classifies a sandbox fault as a non-pass rather than a silent pass', async () => {
    const scene = scenario({ faultySandbox: true });
    const outcome = await runSample(scene);

    expect(outcome.status).toBe('unverified');
    if (outcome.status !== 'unverified') return;
    expect(outcome.simulation.verdict).toBe('error');
    expect(outcome.teachMode.diagnostics).not.toContain('/');
  });
});

// -- Failing safe (sanitized, never a crash) -------------------------------

describe('EvalVerificationLoopRunner - fails safe', () => {
  it('reports a sanitized setup failure when no credential is provisioned', async () => {
    const scene = scenario({ withCredential: false });
    const outcome = await runSample(scene);

    expect(outcome.status).toBe('setup-failed');
    if (outcome.status !== 'setup-failed') return;
    expect(outcome.detail.length).toBeGreaterThan(0);
    expect(outcome.detail).not.toContain(SYNTHETIC_CREDENTIAL);
    expect(outcome.detail).not.toContain('api.aws');
    // The credential was never resolved, so no call was attempted at all.
    expect(scene.http.requests).toHaveLength(0);
  });

  it('reports a sanitized setup failure when the transport cannot reach the host', async () => {
    const scene = scenario({ reachable: false });
    const outcome = await runSample(scene);

    expect(outcome.status).toBe('setup-failed');
    if (outcome.status !== 'setup-failed') return;
    expect(outcome.detail).not.toContain(SYNTHETIC_CREDENTIAL);
    expect(outcome.detail).not.toContain('https://');
    expect(outcome.detail).not.toContain('unreachable');
  });

  it('rejects an illegal host region at construction, not mid-run', () => {
    const http = new FakeProviderHttp(CORRECT_RTL);
    const build = (): EvalVerificationLoopRunner =>
      new EvalVerificationLoopRunner({
        modelHost: { region: 'us-east-1/../evil.example.com' },
        routingPolicy: singleModelEvalRoutingPolicy(MODEL_ID),
        http: http.port,
        sandboxRuntime: fakeRuntime({ specs: [], jobs: [] }),
        retriever: new EmptyRetriever(),
        secretManager: new EnvSecretManager(environment(true)),
      });

    expect(build).toThrow(/invalid region/);
  });
});

// -- Anti-circular guarantee (Property 4) ----------------------------------

describe('EvalVerificationLoopRunner - anti-circular testbench generation', () => {
  it('never puts candidate RTL in the testbench prompt or its retrieval query', async () => {
    const scene = scenario();
    await runSample(scene);

    const testbenchBodies = scene.http
      .bodies()
      .filter((body) => JSON.stringify(body).includes('testbench'));
    expect(testbenchBodies.length).toBeGreaterThan(0);
    for (const body of testbenchBodies) {
      expect(JSON.stringify(body)).not.toContain('assign y = a;');
    }
    for (const query of scene.retriever.queries) {
      expect(JSON.stringify(query)).not.toContain('assign y = a;');
    }
  });

  it('confines the credential to the outbound Authorization header', async () => {
    const scene = scenario();
    const outcome = await runSample(scene);

    for (const request of scene.http.requests) {
      expect(request.headers.Authorization).toBe(`Bearer ${SYNTHETIC_CREDENTIAL}`);
      expect(request.body).not.toContain(SYNTHETIC_CREDENTIAL);
    }
    expect(JSON.stringify(outcome)).not.toContain(SYNTHETIC_CREDENTIAL);
  });
});

// -- The production HTTP port as the injected `http` dependency -------------

describe('EvalVerificationLoopRunner - production HTTP port wiring', () => {
  it('runs a sample end to end with the fetch-backed port as the http dependency', async () => {
    // Same runner, same interface: only the `http` seam differs. The fake is pushed one
    // level down to the host `fetch`, so the REAL production port streams and bounds
    // the reply, and an eval run needs no bespoke client of its own.
    const scene = scenario({ viaFetchPort: true });
    const outcome = await runSample(scene);

    expect(outcome.status).toBe('verified');
    expect(scene.http.requests.length).toBeGreaterThanOrEqual(2);
    for (const request of scene.http.requests) {
      expect(request.url.startsWith('https://')).toBe(true);
      expect(request.headers.Authorization).toBe(`Bearer ${SYNTHETIC_CREDENTIAL}`);
    }
    expect(JSON.stringify(outcome)).not.toContain(SYNTHETIC_CREDENTIAL);
  });
});

// -- The FORMAL_GATE at the production composition root (Req 11.16) ---------

/**
 * An artifact reader that resolves nothing.
 *
 * Never consulted by either example below, and that is the point rather than an omission:
 * the fake provider answers the Property_Author with RTL, so no property is ever submitted
 * and no report is ever written for the reader to resolve. It is here because it is the
 * SWITCH - the runner wires the gate exactly when a store is injected - so these two
 * examples differ in nothing else.
 */
const NO_FORMAL_ARTIFACTS: FormalArtifactReader = { readText: () => Promise.resolve(null) };

describe('EvalVerificationLoopRunner - the formal gate at the composition root', () => {
  it('wires NO gate when no store is injected, so the sample behaves as it did before', async () => {
    const outcome = await runSample(scenario());

    expect(outcome.status).toBe('verified');
    if (outcome.status !== 'verified') return;
    // The three states `FormalGate` keeps separable, read on the one that means NOTHING WAS
    // EVER ASKED: no result, no unexpressed criterion, and no fallback reason. A sample from
    // a campaign that has not turned the gate on must be indistinguishable from a sample
    // recorded before the gate existed.
    expect(outcome.formal.results).toEqual([]);
    expect(outcome.formal.unexpressedCriteria).toEqual([]);
    expect(outcome.formal.fallbackReason).toBeNull();
    expect(outcome.formal.propertySetAdmitted).toBe('not-gated');
  });

  it('wires the gate when a store IS injected, so the Property_Author is reached', async () => {
    const scene = scenario({ formalArtifacts: NO_FORMAL_ARTIFACTS });
    const outcome = await runSample(scene);

    expect(outcome.status).toBe('verified');
    if (outcome.status !== 'verified') return;
    // THE GATE RAN. The fake provider answers every prompt with RTL, so the Property_Author
    // reads no property out of its reply and reports every criterion of the Spec unexpressed
    // - which is exactly how "a gate ran over an empty set" is told apart from "no gate was
    // injected", the two being identical on every other field.
    expect(outcome.formal.unexpressedCriteria).toEqual([CRITERION.id]);
    // No property reached the oracle, so nothing was proved and the SIMULATION still decided
    // this sample: wiring the gate adds no verdict of its own on this path.
    expect(scene.sandbox.jobs.every((job) => job.kind === 'simulate')).toBe(true);
    expect(outcome.formal.results).toEqual([]);
  });
});
