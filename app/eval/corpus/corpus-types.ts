// The shapes one imported RTLLM corpus is made of.
//
// Three bodies of material come out of a checkout and they are kept in SEPARATE,
// id-keyed structures on purpose, not merged into one fat per-design record:
//
//   EvalProblem       what the loop is allowed to see: the approved Spec and the
//                     confirmed-intent summary. Already defined by `../problem.js`.
//   GoldenTestbench   the INDEPENDENT JUDGE: RTLLM's unmodified `testbench.v` plus
//                     the data files it reads. The loop must never see this - a
//                     judge the agent can read is a judge the agent can fit.
//   ReferenceDesign   RTLLM's human reference RTL, i.e. THE ANSWER. Used only by the
//                     Stage 0 instrument check, never by scoring and never by the
//                     loop.
//
// Keeping them in three maps rather than one object means the loop-runner is handed
// an `EvalProblem` that structurally cannot carry the judge or the answer, which is
// the same anti-circularity discipline the Verification_Loop applies to its
// Testbench_Agent: enforced by type, not by convention.

import type { SourceFile } from '@app/tools';

import type { EvalProblem } from '../problem.js';
import type { RtllmCategory } from './pinned-source.js';

/**
 * RTLLM's golden testbench for one design: the independent judge.
 *
 * `testbench.contents` is BYTE-IDENTICAL to upstream. Nothing in this layer
 * rewrites it, reformats it, or translates its signalling - the whole value of an
 * independent judge is that we did not write it.
 */
export interface GoldenTestbench {
  /** The stable problem id this judge belongs to. */
  readonly problemId: string;
  /** The module name the testbench instantiates; a candidate must use exactly this. */
  readonly moduleName: string;
  /** Upstream `testbench.v`, unmodified. */
  readonly testbench: SourceFile;
  /** Data files the testbench reads (`$readmemh`, `$fscanf`), materialized alongside it. */
  readonly dataFiles: readonly SourceFile[];
  /**
   * Parameter names the golden testbench OVERRIDES on the instantiation
   * (`dut #(.WIDTH(8)) ...`), in declaration order; empty for most designs.
   *
   * Recorded because it is a real hazard our Spec model cannot express: a candidate
   * generated from a `ModuleInterface` (which has no parameter concept) will fail to
   * elaborate against a testbench that overrides a parameter it never declared. The
   * design is still imported - the reference passes - but the gap is visible rather
   * than silent.
   */
  readonly overriddenParameters: readonly string[];
}

/**
 * RTLLM's human reference RTL for one design, adapted for Stage 0 only.
 *
 * The single adaptation is the top-module rename described by
 * `topModuleRenamedFrom`: upstream prefixes most reference tops with `verified_` so
 * the reference does not occupy the module name a candidate must implement, and the
 * golden testbench instantiates the unprefixed name. The rename is applied to the
 * REFERENCE, never to the testbench.
 */
export interface ReferenceDesign {
  readonly problemId: string;
  /** The reference source, with its top module renamed to `moduleName` if needed. */
  readonly rtl: SourceFile;
  /** The original top-module identifier, or `null` when no rename was needed. */
  readonly topModuleRenamedFrom: string | null;
}

/** Which phase decided a design is unusable. */
export type QuarantineStage =
  /** Import: the checkout's own files could not be read into a usable problem. */
  | 'import'
  /** Stage 0: the reference does not pass its own golden testbench under Icarus. */
  | 'stage0';

/** Why a design was quarantined; a closed set so every exclusion is accountable. */
export type QuarantineReasonCode =
  /** `design_description.txt` is missing, oversized, or has no module name/statement. */
  | 'DESCRIPTION_UNREADABLE'
  /** `testbench.v` is missing or unreadable. */
  | 'GOLDEN_TESTBENCH_MISSING'
  /** No reference `.v`, or more than one, so the reference is ambiguous. */
  | 'REFERENCE_FILE_AMBIGUOUS'
  /** Several modules are declared and none matches the required name. */
  | 'REFERENCE_TOP_MODULE_AMBIGUOUS'
  /** Renaming the top to the required name would collide with another declared module. */
  | 'REFERENCE_RENAME_COLLIDES'
  /** The top module's ports, directions, or widths could not be resolved. */
  | 'INTERFACE_UNPARSEABLE'
  /** A resolved port violates the domain's positive-width invariant. */
  | 'INTERFACE_PORT_INVALID'
  /** The reviewed Validity_Output table names a port that is not one of the design's outputs. */
  | 'VALIDITY_OUTPUT_UNDECLARED'
  /** The required module name never appears in the golden testbench text. */
  | 'MODULE_NAME_ABSENT_FROM_TESTBENCH'
  /** A data file the testbench needs has a name we will not write into a workspace. */
  | 'DATA_FILE_NAME_UNSAFE'
  /**
   * The Timing_Derivation refused this design, so no Port_Timing value is determined.
   *
   * The `detail` carries the refusal's closed cause token and its named output ports and
   * nothing else. Recorded rather than defaulted: a design whose timing is undetermined is
   * excluded with its cause, because the only available default is the all-`registered`
   * fabrication this corpus used to carry (Req 3.5).
   */
  | 'TIMING_UNDERIVABLE'
  /** Stage 0: the reference plus its golden testbench does not compile under iverilog. */
  | 'REFERENCE_COMPILE_FAILED'
  /** Stage 0: the reference compiles but its own golden testbench reports failures. */
  | 'REFERENCE_FAILED_GOLDEN'
  /** Stage 0: the run produced no banner at all (crash, timeout, missing capture). */
  | 'REFERENCE_RUN_ERRORED';

/**
 * One excluded design, with the reason recorded.
 *
 * A quarantined design is never silently dropped and never "fixed" by weakening an
 * assertion: it is reported, with its code and detail, and excluded from the scored
 * corpus. The count of these is what makes the usable corpus size an honest number.
 */
export interface QuarantinedDesign {
  readonly problemId: string;
  readonly designName: string;
  readonly category: RtllmCategory;
  readonly stage: QuarantineStage;
  readonly code: QuarantineReasonCode;
  /** Short, operator-facing explanation; carries no path and no stack trace. */
  readonly detail: string;
}

/** One imported corpus: the scored problems, their judges, the answers, and the exclusions. */
export interface RtllmCorpus {
  /** The verified upstream commit these problems were imported from. */
  readonly pinnedCommit: string;
  /** The importable problems, in fixed category/design order. */
  readonly problems: readonly EvalProblem[];
  /** The independent judge for each importable problem, keyed by problem id. */
  readonly golden: ReadonlyMap<string, GoldenTestbench>;
  /** The reference RTL for each importable problem, keyed by problem id (Stage 0 only). */
  readonly references: ReadonlyMap<string, ReferenceDesign>;
  /** Every design excluded at import, with its recorded reason. */
  readonly quarantined: readonly QuarantinedDesign[];
  /** Design folders seen in the checkout, importable or not. */
  readonly designsSeen: number;
}
