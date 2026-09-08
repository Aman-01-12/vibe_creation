// Teach_Mode data shapes and the one non-omittable teaching constant
// (Requirements 11.1-11.9).
//
// TWO INVARIANTS ARE ENCODED IN THE TYPES HERE, so they cannot be violated by
// construction rather than merely asserted in prose:
//
// 1. Per-claim grounding by claim TYPE (Req 11.2, 11.3, 11.7, 11.8). A claim is a
//    discriminated union on `kind`: a `design` claim (about THIS design or its
//    results) STRUCTURALLY carries a `ToolOutputRef` - an oracle verdict, a
//    recorded Trace span, or a VCD/waveform reading - and a `general` domain fact
//    STRUCTURALLY carries a `Citation`. A design claim can never be grounded by a
//    citation, and a general fact can never be grounded by tool output, because
//    neither shape can hold the other's grounding. Both grounding types may appear
//    together in one explanation (a mixed `claims` list), which is exactly Req 11.8.
//
// 2. The simulation-vs-silicon limit is a REQUIRED, non-omittable part of a
//    `Verified` presentation (Req 11.5, 11.9). `VerifiedResultPresentation.
//    simulationVsSiliconLimit` is typed as the literal `SIMULATION_VS_SILICON_LIMIT`
//    constant, so a Verified result cannot be constructed without stating the limit
//    and cannot state anything other than the canonical limit text.
//
// Teach_Mode output artifacts are themselves Trust_Tier `Not_Applicable` (pedagogy
// makes no correctness claim); the CLAIMS they cite carry the grounding of what
// they reference. There is no writable `verified` flag anywhere here: a claim that
// lacks its appropriate grounding is labeled `Unverified` (via the core trust
// labeler) or is not taught at all (Req 11.6, 11.9).

import type {
  Citation,
  FailingCase,
  LabeledArtifact,
  NotApplicableArtifact,
  Spec,
  Ulid,
  UnverifiedArtifact,
  Verdict,
  VerificationResult,
  VerifiedArtifact,
} from '@app/core';

import type { BudgetStopReason } from '@app/core';

/**
 * The canonical simulation-vs-silicon limitation statement (Req 11.5, 11.9).
 *
 * A single source of truth for the limit Teach_Mode MUST state whenever it presents
 * a `Verified` result: a simulation pass is not a silicon guarantee. It is a literal
 * `as const` so `VerifiedResultPresentation.simulationVsSiliconLimit` can require
 * exactly this text and nothing else.
 */
export const SIMULATION_VS_SILICON_LIMIT =
  'This result is verified by simulation only: the design passed the spec-derived testbench in the deterministic simulator. Simulation is not a silicon guarantee - it does not certify timing, power, or fabrication-level behavior on real hardware.' as const;

/** Which family of claim an explanation makes; each has its own grounding (Req 11.2). */
export type ClaimKind = 'design' | 'general';

/**
 * A reference to verified tool output from THIS session that grounds a design claim
 * (Req 11.2, 11.3).
 *
 * A closed union over the three kinds of verified tool output a design-specific
 * claim may be grounded in: an oracle verdict, a recorded Trace span, or a reading
 * from the value-change dump (VCD/waveform). Every arm names a concrete session
 * artifact by id, so a design claim can only be grounded in an artifact that
 * actually exists in the session - it cannot invent one (Req 11.1).
 */
export type ToolOutputRef =
  | {
      readonly kind: 'oracle-verdict';
      /** The recorded verification result whose verdict grounds the claim. */
      readonly verificationResultId: Ulid;
      /** The Trace span that IS the ground truth for that verdict. */
      readonly oracleSpanId: Ulid;
    }
  | {
      readonly kind: 'trace-span';
      /** A recorded Trace span in this session that grounds the claim. */
      readonly spanId: Ulid;
    }
  | {
      readonly kind: 'waveform-reading';
      /** The waveform (VCD) artifact the reading is taken from. */
      readonly waveformArtifactId: Ulid;
      /** The signal read, which must exist in that waveform. */
      readonly signal: string;
      /** The simulation time of the reading, in nanoseconds. */
      readonly atSimTimeNs: number;
    };

/** The signals actually present in a session waveform, used to validate readings. */
export interface WaveformReadingSource {
  readonly waveformArtifactId: Ulid;
  /** The signal names present in the VCD; a reading of any other signal is ungrounded. */
  readonly signals: readonly string[];
}

/**
 * The actual session artifacts Teach_Mode explains over (Req 11.1).
 *
 * Assembled by the composition root from the real session state; Teach_Mode grounds
 * every claim against THIS context and never fabricates an artifact. `verification`
 * is the recorded oracle verdict for the module under discussion (or `null` when no
 * run exists yet); `moduleLabel` is that module's current trust label; `waveform`
 * and `traceSpanIds` are the VCD reading source and recorded spans a design claim
 * may cite; `availableCitations` are the citations the Knowledge_Retriever surfaced
 * this session, the only citations a general fact may be grounded in.
 */
export interface TeachSession {
  readonly sessionId: Ulid;
  /** The approved Spec that anchors the explanation. */
  readonly spec: Spec;
  /** The current trust label of the module under discussion. */
  readonly moduleLabel: LabeledArtifact;
  /** The recorded oracle verdict for the module, or `null` if none exists yet. */
  readonly verification: VerificationResult | null;
  /** The waveform reading source available this session, or `null` if none. */
  readonly waveform: WaveformReadingSource | null;
  /** Ids of Trace spans recorded this session a design claim may reference. */
  readonly traceSpanIds: readonly Ulid[];
  /** Citations surfaced by the Knowledge_Retriever this session (Req 13.5). */
  readonly availableCitations: readonly Citation[];
}

/** A design-specific claim proposed by the teaching model (untrusted until grounded). */
export interface ProposedDesignClaim {
  readonly kind: 'design';
  readonly statement: string;
  /** The tool-output the model cites; `null` when it cited none (then ungrounded). */
  readonly grounding: ToolOutputRef | null;
}

/** A general domain fact proposed by the teaching model (untrusted until grounded). */
export interface ProposedGeneralFact {
  readonly kind: 'general';
  readonly statement: string;
  /** The citation the model cites; `null` when it cited none (then ungrounded). */
  readonly citation: Citation | null;
}

/** One claim the teaching model proposes, before grounding decides its disposition. */
export type ProposedClaim = ProposedDesignClaim | ProposedGeneralFact;

/** A design claim that is grounded in verified tool output and therefore taught. */
export interface GroundedDesignClaim {
  readonly kind: 'design';
  readonly disposition: 'taught';
  readonly statement: string;
  /** The verified tool output from this session that grounds it (Req 11.2). */
  readonly grounding: ToolOutputRef;
}

/** A general fact that is grounded in a session citation and therefore taught. */
export interface GroundedGeneralFact {
  readonly kind: 'general';
  readonly disposition: 'taught';
  readonly statement: string;
  /** The citation from this session that grounds it (Req 11.2, 13.5). */
  readonly citation: Citation;
}

/**
 * A claim that lacked its appropriate grounding and is therefore labeled
 * `Unverified` rather than presented as correct (Req 11.3, 11.6, 11.9).
 *
 * `label` reuses the core trust labeler; there is no writable verified flag.
 */
export interface UnverifiedClaim {
  readonly kind: ClaimKind;
  readonly disposition: 'unverified';
  readonly statement: string;
  /** The `Unverified` trust label for this claim (Req 11.3). */
  readonly label: UnverifiedArtifact;
}

/**
 * A claim that is not taught at all (Req 11.9's "or SHALL NOT teach it").
 *
 * Used for a degenerate claim there is nothing to teach from (for example an empty
 * statement); it is neither presented as correct nor labeled, it is simply dropped
 * with a non-sensitive reason recorded for the Trace.
 */
export interface OmittedClaim {
  readonly kind: ClaimKind;
  readonly disposition: 'omitted';
  readonly statement: string;
  /** A short, non-sensitive reason the claim was not taught. */
  readonly reason: string;
}

/** A claim that survived grounding and is taught (design- or citation-grounded). */
export type TaughtClaim = GroundedDesignClaim | GroundedGeneralFact;

/** The disposition of one proposed claim after grounding (Req 11.2, 11.6, 11.9). */
export type ClaimDecision = TaughtClaim | UnverifiedClaim | OmittedClaim;

/**
 * The presentation of a `Verified` result, which MUST state the limit (Req 11.5).
 *
 * `simulationVsSiliconLimit` is typed as the literal `SIMULATION_VS_SILICON_LIMIT`,
 * so a Verified result cannot be built without the limit and cannot alter it. It is
 * grounded in the passing oracle verdict, so it is itself a design-grounded claim.
 */
export interface VerifiedResultPresentation {
  readonly verdict: 'pass';
  /** The oracle-bound `Verified` label of the module (Req 8.3). */
  readonly label: VerifiedArtifact;
  /** The required, non-omittable simulation-vs-silicon limit statement (Req 11.5). */
  readonly simulationVsSiliconLimit: typeof SIMULATION_VS_SILICON_LIMIT;
  /** The passing oracle verdict this presentation is grounded in. */
  readonly grounding: ToolOutputRef;
}

/**
 * Constructive coaching on a non-passing verification result (Req 11.4, 11.8).
 *
 * Built from the actual failing case (or, for an `error` verdict, from the recorded
 * failure), grounded in the oracle verdict span; it explains the failure rather than
 * hiding it. `failingCase` is `null` for an `error` verdict that localized no case.
 */
export interface FailingCaseCoaching {
  readonly verdict: Exclude<Verdict, 'pass'>;
  /** The concrete failing case, or `null` when none was localized (e.g. tool error). */
  readonly failingCase: FailingCase | null;
  /** Plain-language, constructive guidance toward diagnosing and fixing the failure. */
  readonly guidance: string;
  /** The oracle verdict span this coaching is grounded in (Req 11.2). */
  readonly grounding: ToolOutputRef;
}

/**
 * A grounded explanation tied to the session's actual artifacts (Req 11.1).
 *
 * The explanation artifact itself is `Not_Applicable` (pedagogy); its `claims` each
 * carry the grounding of what they reference. `verifiedResult` is present only when
 * a `Verified` result is presented (and then always states the limit); `coaching` is
 * present only when the verification did not pass (Req 11.4, 11.5).
 */
export interface Explanation {
  readonly sessionId: Ulid;
  /** The `Not_Applicable` label for this explanation artifact (pedagogy). */
  readonly artifact: NotApplicableArtifact;
  /** The grounded, unverified, or omitted claims, in the order proposed. */
  readonly claims: readonly ClaimDecision[];
  /** The Verified-result presentation with its mandatory limit, or `null`. */
  readonly verifiedResult: VerifiedResultPresentation | null;
  /** The failing-case coaching on a non-pass, or `null` when the module passed. */
  readonly coaching: FailingCaseCoaching | null;
}

/** Why a Teach_Mode operation could not complete, as a typed, sanitized value. */
export type TeachModeErrorCode = 'EMPTY_SESSION' | 'MODEL_UNAVAILABLE' | 'INVALID_MODEL_OUTPUT';

/** A sanitized Teach_Mode failure: a stable code and a non-sensitive message. */
export interface TeachModeError {
  readonly code: TeachModeErrorCode;
  readonly message: string;
  /** The budget cap that stopped the run, when the cause was the Session_Budget. */
  readonly budgetStopReason?: BudgetStopReason;
}
