// Shared types for the Generation_Agent (S4): the untrusted-output boundary
// shapes, the interface-exactness result, the compiler seam, the progress-event
// stream, and the terminal outcome (Requirements 6.1-6.7, 17.6).
//
// The Generation_Agent produces candidate RTL and revises it against COMPILER
// errors under the Session_Budget; it never assigns a pass verdict. Only the
// Verification_Loop's oracle decides pass (Req 6.6), so every candidate this agent
// emits is labeled `Unverified` (or nothing), never `Verified`.

import type {
  BudgetStopReason,
  LabeledArtifact,
  ModuleVersion,
  PortDirection,
  Spec,
  Ulid,
} from '@app/core';
import type { SourceFile } from '@app/tools';

import type { ModelRouterFailure } from '../../model-router/index.js';

/** The approved-Spec-driven request to generate a candidate implementation. */
export interface GenerationInput {
  readonly sessionId: Ulid;
  readonly projectId: Ulid;
  /** The approved Spec whose Module_Interface the candidate must implement exactly. */
  readonly spec: Spec;
}

/** A single port signature, the unit the interface-exactness check compares. */
export interface PortSignature {
  readonly name: string;
  readonly direction: PortDirection;
  /** Declared bit width; a positive integer. */
  readonly width: number;
}

/** The module interface parsed back out of generated RTL (the source of truth for exactness). */
export interface ParsedInterface {
  readonly moduleName: string;
  readonly ports: readonly PortSignature[];
}

/** A port present in both interfaces whose direction or width diverges. */
export interface PortMismatch {
  readonly name: string;
  readonly expected: Pick<PortSignature, 'direction' | 'width'>;
  readonly actual: Pick<PortSignature, 'direction' | 'width'>;
}

/**
 * The result of checking a generated module's interface against the Spec exactly
 * (Req 6.1, 6.4). Property 17 (task 13.2) states over this structure.
 *
 * `matches` is true iff the module name matches, no Spec port is missing, no port
 * outside the Spec is introduced, and every shared port agrees on direction and
 * width.
 */
export interface InterfaceMatch {
  readonly matches: boolean;
  readonly moduleNameMatches: boolean;
  readonly expectedModuleName: string;
  readonly actualModuleName: string;
  /** Spec ports (including clock/reset) absent from the generated module. */
  readonly missingPorts: readonly PortSignature[];
  /** Ports on the generated module that are absent from the Spec (Req 6.4). */
  readonly extraPorts: readonly PortSignature[];
  /** Shared ports whose direction or width diverges from the Spec. */
  readonly mismatchedPorts: readonly PortMismatch[];
}

/**
 * One generated candidate: its RTL, the interface parsed from it, the exactness
 * verdict, the persisted `ModuleVersion`, and its trust label.
 *
 * `label` is always `Unverified` from this agent: a candidate is never presented
 * as correct until the Verification_Loop reports an oracle pass (Req 6.6).
 */
export interface GeneratedCandidate {
  readonly rtl: string;
  readonly parsedInterface: ParsedInterface;
  readonly interfaceMatch: InterfaceMatch;
  readonly moduleVersion: ModuleVersion;
  /** The oracle-derived trust label; `Unverified` for every pre-verification candidate. */
  readonly label: LabeledArtifact;
}

/** The outcome of one compile-only run over a candidate: did it compile, and why not. */
export interface CompileOutcome {
  /** Whether the candidate compiled without a compiler error. */
  readonly compiled: boolean;
  /** The compiler diagnostics the agent revises against; empty on a clean compile. */
  readonly diagnostics: string;
}

/**
 * The compiler seam the Generation_Agent revises against.
 *
 * This is intentionally narrow and decoupled from the independent testbench and
 * the pass verdict: the agent only needs to know whether a candidate compiles and,
 * if not, the compiler errors to feed the next revision (Req 6.2, 6.3). The full
 * generate-simulate-fix loop against the testbench is the Verification_Loop's job.
 */
export interface CandidateCompiler {
  compile(rtl: readonly SourceFile[]): Promise<CompileOutcome>;
}

/** Which step of generation a progress event reports. */
export type GenerationPhase = 'generating' | 'revising' | 'checking-interface' | 'compiling';

/**
 * A non-blocking progress event streamed to the Editor while generation runs
 * (Req 6.7, 17.6).
 *
 * This is a domain event; the API_Gateway maps it to its own stream frame. The
 * agent layer never imports the gateway, so the shape stays provider-neutral.
 */
export interface GenerationProgressEvent {
  readonly kind: 'progress';
  /** The 0-based iteration this event belongs to. */
  readonly iteration: number;
  readonly phase: GenerationPhase;
  /** A short, non-sensitive human-readable status line. */
  readonly message: string;
}

/** A compiling candidate whose interface matches the Spec, ready for the Verification_Loop. */
export interface ReadyForVerification {
  readonly status: 'ready-for-verification';
  /** The candidate: interface-exact and compiling, but still `Unverified` (Req 6.6). */
  readonly candidate: GeneratedCandidate;
  readonly iterations: number;
}

/**
 * Budget exhausted before a compiling candidate was found (Req 6.5).
 *
 * Presents the last failing candidate and its diagnostics, labeled `Unverified`.
 * `candidate` is `null` only when no parseable candidate was ever produced.
 */
export interface BudgetExhausted {
  readonly status: 'budget-exhausted';
  readonly candidate: GeneratedCandidate | null;
  /** The last compiler or interface diagnostics presented to the Student. */
  readonly diagnostics: string;
  readonly stopReason: BudgetStopReason;
  readonly iterations: number;
}

/** Generation could not proceed or produce any candidate (fail-safe, no false claim). */
export interface GenerationFailed {
  readonly status: 'generation-failed';
  readonly reason: 'spec-not-approved' | 'model-unavailable' | 'no-candidate-produced';
  readonly detail: string;
  readonly iterations: number;
}

/** The terminal result of a generation run. */
export type GenerationOutcome = ReadyForVerification | BudgetExhausted | GenerationFailed;

/**
 * A produced candidate together with the interface-exactness diagnostics it must
 * still resolve.
 *
 * `interfaceDiagnostics` is empty when the candidate's interface matches the Spec
 * exactly; otherwise it lists the deviations to feed the next revision. A candidate
 * is "produced" even when its interface is wrong - that is a defect to revise, not a
 * failure to generate.
 */
export interface CandidateEval {
  readonly candidate: GeneratedCandidate;
  readonly interfaceDiagnostics: string;
}

/** Why producing a single candidate failed (distinct from a candidate that is merely defective). */
export interface CandidateFailure {
  readonly reason: 'model-unavailable' | 'unparseable';
  /** A short, non-sensitive reason; never raw model output or a secret. */
  readonly detail: string;
  /** Present when the cause was a Model_Router budget stop, so the loop can classify it. */
  readonly budgetStopReason?: BudgetStopReason;
  /**
   * The redacted router failure, when the cause was the Model_Router.
   *
   * The TYPED counterpart of `detail`, which for this path is only `failure.code`
   * stringified. A caller that must decide whether "no provider answered" is a measurement
   * or an infrastructure gap needs the code as a value, not as text embedded in a note -
   * see `VerificationSetupFailed.cause`. Mirrors
   * `TestbenchGenerationFailure.routerFailure` deliberately, so both setup halves expose
   * the same fact in the same shape.
   */
  readonly routerFailure?: ModelRouterFailure;
}
