// Testbench_Agent (S6) data shapes: the RTL-isolated generation input, the
// untrusted model draft, and the outcome states of testbench generation
// (Req 7.1-7.7).
//
// THE ANTI-CIRCULAR GUARANTEE LIVES IN THE TYPES HERE.
//
// `TestbenchGenerationInput` is the single, closed set of inputs from which a
// Testbench is derived. It has exactly three fields - the approved Spec, the
// restated intent summary, and OKF retrieval passages - and deliberately NO field
// that can carry RTL, a candidate module, an implementation, or any Generation_Agent
// artifact. Because the Testbench_Agent assembles its entire model context from a
// value of this type and nothing else, it is impossible *by type* to feed the
// generated RTL into testbench generation, including during development and
// debugging (Req 7.2). There is also no shared mutable context object between this
// agent and the Generation_Agent: each field below is read-only and sourced only
// from the Spec, the intent, and the Knowledge_Retriever. Property 4 (task 13.4)
// states directly over this type and the model input assembled from it.
//
// `RepairTestbenchModelInput` and `RepairTestbenchRequest` (Req 2.8, 2.9) extend the
// identical guarantee to a repair attempt. RTL is structurally unrepresentable there
// too: the fields are the approved Spec, OUR OWN previously-generated testbench
// source, and a sanitized Repair_Hint (`../../orchestrator/repair-hint.js`) - never a
// candidate module, never the reference design's observed behaviour or source. See
// `repair-hint.ts` for why the hint itself cannot carry that content either.

import type { Spec, Testbench, Ulid } from '@app/core';
import type { KnowledgePassage } from '@app/knowledge';

import type { RepairHint } from '../../orchestrator/repair-hint.js';
import type { ModelRouterFailure } from '../../model-router/index.js';

import type { CheckingApproach } from './approach-router.js';
import type { TestbenchParseRefusal } from './parse.js';
import type { FragmentRefusal } from './scoreboard/fragments.js';

/**
 * The complete, closed set of inputs from which a Testbench is generated.
 *
 * RTL is structurally unrepresentable here: there is no field for a candidate
 * module, generated source, implementation, or a shared conversation with the
 * Generation_Agent. Every field is derived solely from the Spec, the intent, and
 * OKF retrieval, so the assembled model input cannot contain the RTL under test.
 */
export interface TestbenchGenerationInput {
  /** The approved Spec: the sole source of truth for expected behavior. */
  readonly spec: Spec;
  /** The restated intent summary (a `Not_Applicable` artifact), for context only. */
  readonly intentSummary: string;
  /** OKF retrieval passages: hints only, never authority over correctness. */
  readonly okfPassages: readonly KnowledgePassage[];
}

/**
 * The request to generate a Testbench for an approved Spec (Req 7.1).
 *
 * Like `TestbenchGenerationInput`, this request has no field that can carry RTL:
 * the caller supplies only the session, the approved Spec, and the intent summary.
 * The agent retrieves OKF hints and assembles the generation input internally.
 */
export interface GenerateTestbenchRequest {
  readonly sessionId: Ulid;
  /** The approved Spec to derive the Testbench from. */
  readonly spec: Spec;
  /** The Student-confirmed restated intent from S0, for grounding context. */
  readonly intentSummary: string;
  /** Optional explicit Testbench id; a fresh ULID is generated when omitted. */
  readonly testbenchId?: Ulid;
}

/**
 * The complete, closed set of inputs from which a Testbench REPAIR is generated
 * (Req 2.8, 2.9).
 *
 * RTL is structurally unrepresentable here, for the identical reason it is
 * unrepresentable in `TestbenchGenerationInput`: there is no field for a
 * candidate module, generated source, implementation, or a shared conversation
 * with the Generation_Agent. This is the repair sibling of
 * `TestbenchGenerationInput`, with the same three-field discipline - `spec`,
 * `previousSource`, `hint` - and deliberately no OKF re-retrieval, since the
 * model already has a testbench to revise rather than a blank page.
 * `previousSource` is OUR OWN previously-generated testbench text, never RTL.
 */
export interface RepairTestbenchModelInput {
  /** The approved Spec: the sole source of truth for expected behavior. */
  readonly spec: Spec;
  /** Our own previously-generated testbench source, for the model to revise. */
  readonly previousSource: string;
  /** The sanitized Repair_Hint: never the reference's observed value or source. */
  readonly hint: RepairHint;
}

/**
 * The request to repair a previously-generated Testbench for an approved Spec
 * (Req 2.8, 2.9, 8.2).
 *
 * Like `GenerateTestbenchRequest`, this request has no field that can carry
 * RTL: the caller supplies only the session, the approved Spec, our own prior
 * testbench source, and a sanitized Repair_Hint. The agent assembles the
 * repair model input internally with no OKF re-retrieval.
 */
export interface RepairTestbenchRequest {
  readonly sessionId: Ulid;
  /** The approved Spec to derive the repaired Testbench from. */
  readonly spec: Spec;
  /** Our own previously-generated testbench source, for the model to revise. */
  readonly previousSource: string;
  /** The sanitized Repair_Hint driving this repair attempt. */
  readonly hint: RepairHint;
  /** Optional explicit Testbench id; a fresh ULID is generated when omitted. */
  readonly testbenchId?: Ulid;
}

/**
 * The untrusted testbench source the model emits.
 *
 * Model output is untrusted like any external content: it is shaped at the
 * boundary (`parseTestbenchDraft`) into this bounded structure before any coverage
 * validation runs on it. Nothing downstream re-parses raw model text.
 */
export interface TestbenchDraft {
  /** The generated Verilog testbench source, bounded and non-empty. */
  readonly source: string;
}

/** Why testbench generation could not yield a validated Testbench (fail safe). */
export type TestbenchGenerationFailureReason =
  | 'spec-not-approved'
  | 'no-simulation-criteria'
  | 'model-call-failed'
  | 'unparseable-output'
  /** The interface cannot carry a Scoreboard_Scaffold; raised before any model call. */
  | 'scaffold-unrenderable';

/** A failure that prevented producing a Testbench, carrying a sanitized detail. */
export interface TestbenchGenerationFailure {
  readonly reason: TestbenchGenerationFailureReason;
  /** A short, non-sensitive explanation; never a secret, host, or stack trace. */
  readonly detail: string;
  /** The redacted router failure, when the cause was the Model_Router. */
  readonly routerFailure?: ModelRouterFailure;
  /** The closed parse-refusal code; present exactly when `reason` is `unparseable-output`. */
  readonly parseRefusal?: TestbenchParseRefusal;
}

/** A required per-check signal the generated testbench must emit. */
export interface RequiredCheck {
  /** Whitespace-free check name emitted as `CHECK <name> PASS|FAIL`. */
  readonly name: string;
  /** Whether this check verifies a Spec criterion or a known-answer reference. */
  readonly kind: 'criterion' | 'known-answer';
  /** The acceptance-criterion id this check traces to, for `criterion` checks. */
  readonly criterionId?: Ulid;
  /** Human-readable description of what the check verifies, used in the prompt. */
  readonly description: string;
}

/** A produced Testbench that emits every required check (Req 7.3-7.6). */
export interface TestbenchGenerated {
  readonly status: 'generated';
  /** The Testbench, `sourceAttribution` fixed to `"spec"` by `makeTestbench`. */
  readonly testbench: Testbench;
  /** The required checks confirmed present in the source. */
  readonly checks: readonly RequiredCheck[];
  /** How the testbench decides when to compare an output; copied onto the eval record. */
  readonly checkingApproach: CheckingApproach;
}

/**
 * A draft that does not emit every required per-check signal.
 *
 * A Testbench is deliberately NOT produced in this state, so a produced Testbench
 * always covers every acceptance criterion verifiable by simulation (Property 6).
 */
export interface TestbenchCoverageIncomplete {
  readonly status: 'coverage-incomplete';
  /** The required checks whose `CHECK <name>` emission was absent from the source. */
  readonly missingChecks: readonly RequiredCheck[];
  /** The rejected draft source, so the caller can inspect or re-prompt. */
  readonly source: string;
}

/**
 * The model's Model_Fragments were refused at the trust boundary, so no testbench was
 * assembled (testbench-in-order-scoreboard, Req 4.10). The loop turns this into one repair.
 */
export interface TestbenchFragmentsRefused {
  readonly status: 'fragments-refused';
  readonly refusal: FragmentRefusal;
  /** The model's own reply, bounded by the reply cap, so a repair can revise it. */
  readonly source: string;
}

/** Generation failed before a coverable draft existed (fail safe). */
export interface TestbenchGenerationFailed {
  readonly status: 'generation-failed';
  readonly failure: TestbenchGenerationFailure;
}

/**
 * The outcome of generating a Testbench from the Spec.
 *
 * A Testbench is produced only in the `generated` state, and only when every
 * required check is present, so coverage (Property 6) holds by construction for
 * any produced Testbench.
 */
export type TestbenchGenerationOutcome =
  | TestbenchGenerated
  | TestbenchCoverageIncomplete
  | TestbenchFragmentsRefused
  | TestbenchGenerationFailed;
