// Example/edge-case unit tests for Teach_Mode explanation PHRASING (task 16.6;
// Req 11.1, 11.4, 11.5).
//
// These concrete, example-based checks complement the numbered fast-check
// Property 25 (teach-mode grounds each claim by its type, task 16.5). They pin the
// phrasing behaviors the design's Testing Strategy calls out as example/edge-case
// coverage:
//
//   - Req 11.5 (the crux): whenever Teach_Mode presents a `Verified` result it
//     ALWAYS states the simulation-vs-silicon limit, and states EXACTLY the
//     canonical `SIMULATION_VS_SILICON_LIMIT` text - never a paraphrase and never
//     omitted. This is asserted both on the pure presenter and end to end through
//     `TeachMode.explain` over a fake Model_Router, and it is asserted to FAIL
//     CLOSED: no `Verified` result (and so no limit) is presented unless the module
//     is actually `Verified` and backed by a passing oracle verdict.
//   - Req 11.4: on a non-pass the explanation coaches on the failing case in plain
//     language grounded in the oracle verdict span - it names the failing check and
//     contrasts expected vs observed, and for a tool/infra `error` it says
//     correctness is undetermined rather than blaming the design.
//   - Req 11.1: the explanation is tied to the session's ACTUAL artifacts - the
//     explanation artifact itself is `Not_Applicable` (pedagogy), and a taught
//     design claim references a real session artifact by id.
//
// Every model call runs through a FAKE Model_Router (no provider, no network) plus
// a real Trace recorder over in-memory persistence, so the deterministic behavior
// is exercised through the real Teach_Mode shell.

import { describe, expect, it } from 'vitest';

import {
  InMemorySessionBudgetHandle,
  InMemoryTracePersistence,
  SIMULATION_VS_SILICON_LIMIT,
  TeachMode,
  TraceActionRecorder,
  coachFailingCase,
  parseTeachClaims,
  presentVerifiedResult,
  type Explanation,
  type ModelRequest,
  type ModelRouter,
  type ModelRouterFailure,
  type ModelTask,
  type ProposedClaim,
  type RoutedModelResult,
  type RoutingDiagnostics,
  type SessionBudgetHandle,
  type TeachSession,
} from '@app/agent';
import {
  isOk,
  makeSessionBudget,
  makeVerificationResult,
  newUlid,
  notApplicable,
  unverified,
  verified,
  type ArtifactRef,
  type Citation,
  type FailingCase,
  type LabeledArtifact,
  type Result,
  type Spec,
  type Verdict,
  type VerificationResult,
} from '@app/core';
import { routedModelIdFor } from '@app/test';

// --- Fixtures ----------------------------------------------------------------

/** A citation the Knowledge_Retriever surfaced this session (grounds a general fact). */
const AVAILABLE_CITATION: Citation = {
  claim: 'Synchronous counters update on the active clock edge.',
  sourceUrl: 'https://example.test/hdl/counters',
  sourceTitle: 'Synchronous counter design',
  presentation: 'cited',
};

/** A minimal approved single-module Spec with a non-empty goal (Req 11.1 anchor). */
function counterSpec(): Spec {
  return {
    id: newUlid(),
    projectId: newUlid(),
    goal: 'A 4-bit synchronous up-counter that clears to zero on reset.',
    constraints: ['single module'],
    architecture: 'One always block incrementing count on the rising clock edge.',
    moduleInterface: {
      moduleName: 'up_counter',
      ports: [
        { name: 'clk', direction: 'input', width: 1 },
        { name: 'rst', direction: 'input', width: 1 },
        { name: 'count', direction: 'output', width: 4 },
      ],
      clocking: { clockName: 'clk', resetName: 'rst', resetActiveLow: false },
    },
    acceptanceCriteria: [
      {
        id: newUlid(),
        text: 'reset clears the output to zero',
        measurable: true,
        method: 'simulation',
      },
    ],
    approved: true,
    version: 1,
  };
}

/** Build a recorded `VerificationResult` for a verdict, or throw on setup error. */
function verificationResult(verdict: Verdict, failingCase?: FailingCase): VerificationResult {
  const built = makeVerificationResult({
    id: newUlid(),
    moduleVersionId: newUlid(),
    testbenchId: newUlid(),
    verdict,
    allChecksPassed: verdict === 'pass',
    ...(failingCase === undefined ? {} : { failingCase }),
    iterations: 1,
    costCents: 0,
    oracleSpanId: newUlid(),
  });
  if (!isOk(built)) {
    throw new Error(`test setup: could not build a ${verdict} VerificationResult`);
  }
  return built.value;
}

/** The `Verified` module label bound to a passing oracle span, or throw. */
function verifiedLabel(): LabeledArtifact {
  const ref: ArtifactRef = { kind: 'module-version', id: newUlid(), version: 1 };
  const label = verified(ref, newUlid());
  if (!isOk(label)) {
    throw new Error('test setup: could not build a Verified label');
  }
  return label.value;
}

/** The `Unverified` module label (no passing oracle span). */
function unverifiedLabel(): LabeledArtifact {
  return unverified({ kind: 'module-version', id: newUlid(), version: 1 });
}

/**
 * A passing session: the module is `Verified` and a passing oracle verdict backs it.
 *
 * The design claim's oracle-verdict grounding, when cited, resolves against this
 * session's verification id and oracle span, so a grounded claim is genuinely taught.
 */
function passingSession(): TeachSession {
  return {
    sessionId: newUlid(),
    spec: counterSpec(),
    moduleLabel: verifiedLabel(),
    verification: verificationResult('pass'),
    waveform: null,
    traceSpanIds: [],
    availableCitations: [AVAILABLE_CITATION],
  };
}

/** A non-passing session with a localized failing case (Req 11.4 coaching input). */
function failingSession(failingCase: FailingCase): TeachSession {
  return {
    sessionId: newUlid(),
    spec: counterSpec(),
    moduleLabel: unverifiedLabel(),
    verification: verificationResult('fail', failingCase),
    waveform: null,
    traceSpanIds: [],
    availableCitations: [],
  };
}

/** The concrete failing case surfaced to the Student on a non-pass. */
function failingCase(): FailingCase {
  return {
    checkName: 'reset_clears_output',
    description: 'the counter did not clear on reset',
    expected: "count == 4'b0000",
    observed: "count == 4'b0011",
    atSimTimeNs: 40,
  };
}

/** A generous budget so the model seam, not the budget, drives every case. */
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
  if (!isOk(built)) {
    throw new Error('test budget must be valid');
  }
  return new InMemorySessionBudgetHandle(built.value);
}

/** How a provider presents the JSON envelope on the wire; the default is bare JSON. */
type EnvelopePresentation = (envelopeJson: string) => string;

/** Return the envelope exactly as serialized, the presentation most providers use. */
const asBareJson: EnvelopePresentation = (envelopeJson) => envelopeJson;

/**
 * Wrap an envelope in the markdown fence real providers also emit.
 *
 * The leading space before the fence is faithful to the observed provider reply,
 * which a strict `JSON.parse` rejected even though the envelope inside was correct.
 */
const asFencedJson: EnvelopePresentation = (envelopeJson) => ` \`\`\`json\n${envelopeJson}\n\`\`\``;

/** A Model_Router test double that returns scripted teaching output as JSON. */
class FakeTeachRouter implements ModelRouter {
  readonly calls: ModelTask[] = [];
  readonly #claims: readonly ProposedClaim[];
  readonly #present: EnvelopePresentation;

  constructor(claims: readonly ProposedClaim[], present: EnvelopePresentation = asBareJson) {
    this.#claims = claims;
    this.#present = present;
  }

  invoke(
    task: ModelTask,
    request: ModelRequest,
    budget: SessionBudgetHandle,
  ): Promise<Result<RoutedModelResult, ModelRouterFailure>> {
    void request;
    this.calls.push(task);
    budget.charge({ tokens: 1, costCents: 0, wallClockMs: 1 });
    const value: RoutedModelResult = {
      task,
      provider: 'gemini',
      modelId: routedModelIdFor('gemini'),
      outputText: this.#present(JSON.stringify({ claims: this.#claims })),
      tokensUsed: 32,
      costCents: 3,
      attempts: 1,
      fellBack: false,
    };
    return Promise.resolve({ ok: true, value });
  }

  describeRouting(): RoutingDiagnostics {
    return { tasks: [], providers: [] };
  }
}

/** Wire a fresh Teach_Mode over the scripted fake router with a real recorder. */
function teachModeReturning(
  claims: readonly ProposedClaim[],
  present: EnvelopePresentation = asBareJson,
): {
  readonly teach: TeachMode;
  readonly router: FakeTeachRouter;
} {
  const router = new FakeTeachRouter(claims, present);
  const teach = new TeachMode({
    router,
    recorder: new TraceActionRecorder(new InMemoryTracePersistence()),
    now: () => 1_700_000_000_000,
  });
  return { teach, router };
}

/** Explain the session, asserting success, and return the explanation. */
async function explainOrThrow(teach: TeachMode, session: TeachSession): Promise<Explanation> {
  const result = await teach.explain(session, generousBudget());
  if (!result.ok) {
    throw new Error(`expected an explanation, got error ${result.error.code}`);
  }
  return result.value;
}

// --- Req 11.5: the simulation-vs-silicon limit on a Verified result ----------

describe('Verified-result phrasing states the simulation-vs-silicon limit (Req 11.5)', () => {
  it('pins the canonical limit text to plain-language simulation-only wording', () => {
    // The limit is not a vague disclaimer: it says the pass is simulation-only and
    // is explicitly not a silicon guarantee (timing/power/fabrication).
    expect(SIMULATION_VS_SILICON_LIMIT).toContain('verified by simulation only');
    expect(SIMULATION_VS_SILICON_LIMIT).toContain('not a silicon guarantee');
    expect(SIMULATION_VS_SILICON_LIMIT).toContain('spec-derived testbench');
  });

  it('always includes the exact limit statement when presenting a Verified result', () => {
    const presentation = presentVerifiedResult(passingSession());

    expect(presentation).not.toBeNull();
    // Exact canonical text, never a paraphrase and never omitted.
    expect(presentation?.simulationVsSiliconLimit).toBe(SIMULATION_VS_SILICON_LIMIT);
    expect(presentation?.verdict).toBe('pass');
    expect(presentation?.label.tier).toBe('Verified');
  });

  it('carries the limit through TeachMode.explain end to end, routed as a teaching task', async () => {
    const session = passingSession();
    const verification = session.verification;
    if (verification === null) {
      throw new Error('test setup: passing session must have a verification');
    }
    const { teach, router } = teachModeReturning([
      {
        kind: 'design',
        statement: 'The counter passed every spec-derived check in simulation.',
        grounding: {
          kind: 'oracle-verdict',
          verificationResultId: verification.id,
          oracleSpanId: verification.oracleSpanId,
        },
      },
    ]);

    const explanation = await explainOrThrow(teach, session);

    // The Verified result is presented with the mandatory, exact limit (Req 11.5).
    expect(explanation.verifiedResult).not.toBeNull();
    expect(explanation.verifiedResult?.simulationVsSiliconLimit).toBe(SIMULATION_VS_SILICON_LIMIT);
    // Teaching is routed to the teaching task, and no failing-case coaching appears
    // on a pass.
    expect(router.calls).toEqual(['teaching']);
    expect(explanation.coaching).toBeNull();
  });

  it('fails closed: presents no Verified result (and no limit) unless truly Verified and passing', () => {
    // An Unverified module never yields a Verified presentation, even if some
    // verdict exists.
    expect(
      presentVerifiedResult({ ...passingSession(), moduleLabel: unverifiedLabel() }),
    ).toBeNull();

    // A Verified label with a non-passing verdict is a contradiction the presenter
    // refuses rather than dressing up as correct.
    expect(
      presentVerifiedResult({
        ...passingSession(),
        verification: verificationResult('fail', failingCase()),
      }),
    ).toBeNull();

    // No recorded verdict at all: nothing to present.
    expect(presentVerifiedResult({ ...passingSession(), verification: null })).toBeNull();
  });
});

// --- Req 11.4: plain-language coaching on the failing case -------------------

describe('non-pass phrasing coaches on the failing case (Req 11.4)', () => {
  it('names the failing check and contrasts expected vs observed, grounded in the oracle span', () => {
    const theCase = failingCase();
    const session = failingSession(theCase);

    const coaching = coachFailingCase(session);

    expect(coaching).not.toBeNull();
    expect(coaching?.verdict).toBe('fail');
    // Plain-language guidance surfaces the concrete failure (Req 11.4), not a
    // generic "it failed".
    expect(coaching?.guidance).toContain(theCase.checkName);
    expect(coaching?.guidance).toContain(theCase.expected);
    expect(coaching?.guidance).toContain(theCase.observed);
    // Grounded in the oracle verdict span so the failure is diagnosable, and it
    // directs the fix at the design, not the independently derived testbench.
    expect(coaching?.grounding.kind).toBe('oracle-verdict');
    expect(coaching?.guidance).toContain('do not change the testbench');
  });

  it('explains a tool/infra error as undetermined correctness, not a design failure', () => {
    const session: TeachSession = {
      ...failingSession(failingCase()),
      verification: verificationResult('error'),
    };

    const coaching = coachFailingCase(session);

    expect(coaching?.verdict).toBe('error');
    expect(coaching?.guidance).toContain('tool or infrastructure error');
    expect(coaching?.guidance).toContain('not a functional failure');
  });

  it('presents coaching (not a Verified result) through explain on a non-pass', async () => {
    const session = failingSession(failingCase());
    const { teach } = teachModeReturning([]);

    const explanation = await explainOrThrow(teach, session);

    expect(explanation.verifiedResult).toBeNull();
    expect(explanation.coaching).not.toBeNull();
    expect(explanation.coaching?.guidance).toContain('reset_clears_output');
  });
});

// --- Req 11.1: the explanation is tied to the session's actual artifacts -----

describe('explanation is grounded in session artifacts (Req 11.1)', () => {
  it('labels the explanation artifact Not_Applicable (pedagogy makes no correctness claim)', async () => {
    const { teach } = teachModeReturning([]);

    const explanation = await explainOrThrow(teach, passingSession());

    expect(explanation.artifact.tier).toBe('Not_Applicable');
    // The Not_Applicable label is exactly a pedagogy label over an explanation ref.
    expect(explanation.artifact).toEqual(notApplicable(explanation.artifact.artifactRef));
    expect(explanation.artifact.artifactRef.kind).toBe('explanation');
  });

  it('teaches a design claim that references a real session artifact, by id', async () => {
    const session = passingSession();
    const verification = session.verification;
    if (verification === null) {
      throw new Error('test setup: passing session must have a verification');
    }
    const { teach } = teachModeReturning([
      {
        kind: 'design',
        statement: 'Reset drives the count output to zero on the next clock edge.',
        grounding: {
          kind: 'oracle-verdict',
          verificationResultId: verification.id,
          oracleSpanId: verification.oracleSpanId,
        },
      },
    ]);

    const explanation = await explainOrThrow(teach, session);

    const taught = explanation.claims.find((claim) => claim.disposition === 'taught');
    expect(taught?.kind).toBe('design');
    if (taught?.kind === 'design' && taught.disposition === 'taught') {
      // The claim is grounded in THIS session's oracle verdict, by id.
      expect(taught.grounding.kind).toBe('oracle-verdict');
      if (taught.grounding.kind === 'oracle-verdict') {
        expect(taught.grounding.verificationResultId).toBe(verification.id);
        expect(taught.grounding.oracleSpanId).toBe(verification.oracleSpanId);
      }
    }
  });

  it('labels a design claim citing an artifact the session lacks as Unverified, not taught', async () => {
    const session = passingSession();
    const { teach } = teachModeReturning([
      {
        kind: 'design',
        // Cites an oracle verdict that does not belong to this session.
        statement: 'The design meets a timing constraint.',
        grounding: {
          kind: 'oracle-verdict',
          verificationResultId: newUlid(),
          oracleSpanId: newUlid(),
        },
      },
    ]);

    const explanation = await explainOrThrow(teach, session);

    const ungrounded = explanation.claims[0];
    expect(ungrounded?.disposition).toBe('unverified');
    if (ungrounded?.disposition === 'unverified') {
      expect(ungrounded.label.tier).toBe('Unverified');
    }
  });
});

// --- The untrusted-output boundary tolerates a presentation wrapper ----------

describe('parseTeachClaims - a conforming envelope wrapped in a markdown code fence', () => {
  /** One well-formed general claim carrying the session's available citation. */
  const generalClaim: ProposedClaim = {
    kind: 'general',
    statement: 'A synchronous counter updates on the active clock edge.',
    citation: AVAILABLE_CITATION,
  };

  it('given a fenced claims envelope when parsed then the fence is stripped and the claims are read', () => {
    const raw = asFencedJson(JSON.stringify({ claims: [generalClaim] }));

    const parsed = parseTeachClaims(raw);

    expect(parsed).toEqual({ ok: true, value: [generalClaim] });
  });

  it('given a genuinely malformed reply when parsed then it fails with the unchanged reason', () => {
    const parsed = parseTeachClaims('not json at all');

    expect(parsed).toEqual({ ok: false, error: { reason: 'model output was not valid JSON' } });
  });

  it('given a fenced claim with a malformed citation when parsed then grounding is still withheld', () => {
    // Shaping never grants grounding: a broken citation becomes null so the pure
    // grounding core still decides the claim is Unverified.
    const raw = asFencedJson(
      JSON.stringify({
        claims: [{ kind: 'general', statement: generalClaim.statement, citation: { claim: 'x' } }],
      }),
    );

    const parsed = parseTeachClaims(raw);

    expect(parsed).toEqual({
      ok: true,
      value: [{ kind: 'general', statement: generalClaim.statement, citation: null }],
    });
  });

  it('given a fenced claims envelope when Teach_Mode runs then the claim is taught', async () => {
    const { teach } = teachModeReturning([generalClaim], asFencedJson);

    const explanation = await explainOrThrow(teach, passingSession());

    expect(explanation.claims[0]?.disposition).toBe('taught');
  });
});
