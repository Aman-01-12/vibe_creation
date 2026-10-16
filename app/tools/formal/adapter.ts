// The Formal_Oracle adapter: the Reset_Contract_Prepass, the deterministic Proof_Depth ladder, the
// two job assemblies, and the Property_Time_Budget (design.md Component 4; Req 1.18, 3.5, 3.6, 3.8,
// 4.5, 4.6, 4.7, 4.13, 7.1, 7.13, 7.14, 7.15, 7.16, 11.1, 11.2, 11.3, 11.4, 11.5, 11.9, 11.12,
// 12.19, 14.25).
//
// THIS MODULE IS ORCHESTRATION, AND EVERY RULE IT TOUCHES BELONGS TO SOMEONE ELSE
//   Two jobs, a render between them, a ladder, and a budget. That is the whole job. Each fact it
//   would otherwise be tempted to decide already has exactly one owner, and it calls that owner:
//     - `admitProved` (`./conditions.js`) owns the five-condition rule and its fixed order.
//     - `interpretFormalReport` (`./interpret.js`) owns turning one `SandboxResult` plus one
//       validated report into one `PropertyResult`, and `refusedWithoutProof` owns the shape of a
//       refusal reported ahead of that order.
//     - `readFormalPrepassContract` (`./prepass.js`) owns the parse of the pre-pass document, the
//       reset/clock derivation, the refusal ORDER between them, the single line that says an
//       unreadable pre-pass report is `toolchain-unavailable` - which the narrowed Req 14.26 now
//       reaches only where the invocation did NOT raise a Yosys frontend error - and which readings
//       a refusal still establishes, which is what lets a refusal stay distinguishable from a
//       pre-pass that was never read (Req 14.27, 14.39).
//     - `emitsAssertionGate` (`../verilog/property.js`) owns whether the `if (!$initstate)` gate is
//       emitted, so the fact this module RECORDS on the Formal_Outcome and the text the renderer
//       EMITS come from one rule.
//     - `parseFormalReport` (`./report.js`) owns the validating parse of `formal-report.json`.
//     - `renderPropertyWrapper` (`../verilog/property.js`) owns every byte of emitted Verilog.
//     - The WORKER owns the Lowering_Sequence, the four checks, the solver, the derived reset
//       polarity, and the Clock_Contract (Req 3.3, 14.24, 14.38). No flip-flop cell is walked here
//       and no Yosys pass name appears anywhere below, so there is no way to assemble an invocation
//       that omits a pass: the passes are not ours to name.
//   Nothing here reads a `Status:` string, re-derives a Proof_Condition, or decides what a condition
//   means. It DOES read a reported `cause` - `antecedent-unreached` - and that is orchestration
//   rather than duplication: Req 4.7 keys the escalation on exactly that cause, and the cause is the
//   one the owner produced.
//   ONE ATTRIBUTION IS DECIDED HERE, and it is here because the FACT it rests on is: whether the
//   Reset_Contract_Prepass raised a Yosys frontend error is a fact about a job THIS MODULE
//   ASSEMBLED, and its attribution follows from that job holding the candidate design ALONE
//   (Req 8.10, 8.11, 8.13). `./interpret.js`'s `attributeLoweringFailure` is deliberately NOT reused
//   for it - see `#deriveContract`, which records the measurement that rules the reuse out - and it
//   is untouched on the lowering path, where it remains the only owner.
//
// TWO METHODS, ONE IMPLEMENTATION (Req 14.27, 14.39)
//   `proveSet` decides a whole Property_Set under ONE pre-pass and returns the run-level
//   `FormalOutcome`; `prove` is that method over a one-element set, returning its single result.
//   The delegation is not tidiness - two implementations could drift into different behaviours, and
//   a verdict that depends on which method a caller reached for is the failure that forbids.
//
// WHY THE PRE-PASS IS CALLED FIRST, AS ITS OWN JOB (Req 14.11)
//   The Property_Wrapper is what needs the pre-pass's answers, and a `formal` job's `-top` IS that
//   wrapper, so the pre-pass cannot be a step inside the `formal` kind. It runs over the candidate
//   DESIGN ALONE under the `formalPrepass` kind, and NOTHING is rendered until it answers: where it
//   refuses, the cause it names is reported ahead of the whole fixed condition order, no
//   Proof_Condition is evaluated, and no wrapper is built (Req 1.18, 14.18).
//
// CONTAINMENT (Req 11.1, 11.2, 11.3, 11.4, 11.5, 14.25)
//   Every invocation - the pre-pass included - goes through the INJECTED `ToolRunner` and nothing
//   else. This module spawns no process, opens no socket, and reads no file: it has no `node:child_process`,
//   no `node:fs`, and no `node:net` import, and the one thing it cannot get off a `SandboxResult` -
//   the text of a registered report artifact - arrives through a second injected port rather than a
//   file read of its own (see `FormalArtifactReader`). Every job carries all four resource caps
//   (`cpu`, `memMb`, `procs`, `diskMb`) plus a `wallMs` derived from the remaining budget, and the
//   container spec the Tool_Runner builds from that job denies network and mounts no secret
//   (`SANDBOX_ISOLATION`, `mountSecrets: false`). Only sanitized reasons leave this module, because
//   every `PropertyResult` it returns was built by `./interpret.js`, which owns the redaction.
//
// Not pure: it drives injected ports and reads an injected clock. It is TOTAL in the sense that
// matters - every path returns a `PropertyResult`, and every unrecognized condition is
// `could-not-verify` rather than `proved` or `refuted`.

import { err, ok, type ModuleInterface, type Result } from '@app/core';

import type { PropertyResult } from './conditions.js';
import { CLOCKED_DEPTH_LADDER, COMBINATIONAL_DEPTH } from './depth-ladder.js';
import { interpretFormalReport, refusedWithoutProof, type FormalRunContext } from './interpret.js';
import {
  readFormalPrepassContract,
  type ClockPolarity,
  type FormalPrepassRefusal,
  type FormalPrepassReport,
  type ResetContract,
} from './prepass.js';
import { parseFormalReport, type FormalReport } from './report.js';
// BOTH SANDBOX VALUES ARE REACHED PAST THE BARREL, ON PURPOSE (Req 11.5). `../sandbox/index.js`
// re-exports `RunscSandboxRuntime`, `LocalWorkerRuntime`, `FakeSandboxRuntime`, and
// `SandboxToolRunner` - the four concrete executors this module must not depend on - so a RUNTIME
// import of it made Node evaluate every one of them to reach a validator and a number. Importing
// each from the module that declares it leaves the runtimes unloaded as well as unbound, which is
// what makes the module graph match the claim `structural-claims.test.ts` states about it rather
// than relying on the binding allow-list alone. The TYPES below still come from the barrel: an
// `import type` is erased by `verbatimModuleSyntax`, so it loads nothing, and the barrel is this
// package's documented type surface.
import { MAX_RETAINED_ARTIFACT_BYTES } from '../sandbox/artifact-retention.js';
import { validateSandboxJob } from '../sandbox/validation.js';
import type {
  ArtifactBlobRef,
  RequiredOutput,
  ResourceLimits,
  SandboxJob,
  SandboxResult,
  SourceFile,
  ToolRunner,
} from '../sandbox/index.js';
import {
  emitsAssertionGate,
  renderPropertyWrapper,
  type FormalProperty,
} from '../verilog/property.js';

/**
 * One request to decide one Formal_Property about one candidate design.
 *
 * ONE DESIGN AND ONE PROPERTY, AND NO PARAMETER A REFERENCE DESIGN COULD OCCUPY (Req 3.8). The
 * only caller that holds a reference at all is `Property_Set_Admission` in `@app/eval`, and when it
 * scores a mutant it supplies the MUTANT as `designSource` - there is no second source field for a
 * reference observation to arrive through.
 *
 * THERE IS NO FIELD FOR A DEPTH (Req 4.5). The Proof_Depth is chosen by `proofDepthsFor` below from
 * the design and the property, so a model has no channel to one even indirectly.
 *
 * THERE IS NO FIELD FOR `wallMs` EITHER, and that is the same kind of omission. The budget is the
 * only time bound, and it is turned into each job's `wallMs` by `#limits`, so no caller can hand
 * over a per-job timer that would race the budget.
 */
export interface FormalProveRequest {
  /** The candidate design, written into the workspace EQUAL IN VALUE to this value (Req 3.5). */
  readonly designSource: SourceFile;
  /** The design's declared interface: the wrapper's port list and the pre-pass's `-top`. */
  readonly designInterface: ModuleInterface;
  /** The typed, validated property. A raw string cannot reach here (Req 6.13, 11.9). */
  readonly property: FormalProperty;
  /** The Property_Time_Budget for this property, in milliseconds (Req 7.1). */
  readonly budgetMs: number;
}

/**
 * One request to decide a whole Property_Set about one candidate design.
 *
 * `FormalProveRequest` with `property` widened to `properties`, and every omission that request
 * records holds here for the same reason: one design and no second source field (Req 3.8), no
 * depth (Req 4.5), and no `wallMs`.
 *
 * `budgetMs` IS THE PER-PROPERTY Property_Time_Budget AND NOT A BUDGET FOR THE SET (Req 7.1). Each
 * property gets its own window, so a set of five properties is not silently held to one property's
 * allowance, and `prove`'s one-element set is then bounded exactly as it was before this method
 * existed. What the set SHARES is the pre-pass, whose elapsed time is deducted from every window
 * once, because every window depends on it having completed.
 */
export interface FormalProveSetRequest {
  /** The candidate design, written into the workspace EQUAL IN VALUE to this value (Req 3.5). */
  readonly designSource: SourceFile;
  /** The design's declared interface: each wrapper's port list and the pre-pass's `-top`. */
  readonly designInterface: ModuleInterface;
  /** The typed, validated properties, decided in THIS order (Req 1.11). */
  readonly properties: readonly FormalProperty[];
  /** The Property_Time_Budget for EACH property, in milliseconds (Req 7.1). */
  readonly budgetMs: number;
}

/**
 * Why the whole Counterexample trace could not be read. THREE reasons, each distinguishable.
 *
 * `over-cap` is separated from `unresolved` deliberately, and the separation is what makes the
 * DECLARED-size check below worth having: the retention store refuses to hold anything past the
 * same cap, so a trace too large would otherwise arrive as "its bytes could not be resolved",
 * which names the wrong thing. A reader told `over-cap` knows the trace existed and was too big;
 * a reader told `unresolved` knows the store no longer had it.
 */
export type CounterexampleRefusal = 'over-cap' | 'unresolved' | 'read-failed';

/**
 * A `refuted` property's Counterexample trace, read where its OWN run ended (Req 12.24).
 *
 * WHY THE READ HAPPENS AT THE RUN AND NOT AT THE SAMPLE. The retention store the bytes live in
 * holds at most `MAX_RETAINED_TOTAL_BYTES` (1 MiB) with `MAX_RETAINED_ARTIFACT_BYTES` (128 KiB)
 * per artifact, evicted oldest-first by LAST WRITE, and `LocalWorkerRuntime.launch` retains every
 * job's artifacts with no job-kind filter - so every simulation, control, and mutant run on a
 * shared runtime keeps filling it, and a reader that waits for the whole sample to finish can LOSE
 * THE RACE. Reading immediately after the invocation that registered the trace removes the
 * dependency on a shared FIFO rather than lowering the odds, and it is the ONLY route by which a
 * trace can reach the Student path, which has no artifact store at all. The counterexample is the
 * single most valuable pedagogy artifact this gate produces: it is the concrete failing waveform a
 * Student is coached from.
 *
 * `trace` IS THE WHOLE VCD TEXT AND IS NEVER CUT, because a truncated VCD is not a VCD. It is at
 * most `MAX_RETAINED_ARTIFACT_BYTES` bytes - the retention module's OWN cap, reused rather than
 * re-declared, and the value `MAX_COUNTEREXAMPLE_TRACE_BYTES` in `app/eval/artifact-sink.ts`
 * already equals - so no second number can drift from the store's.
 *
 * THE `reference` RIDES ON BOTH ARMS, so the layer that writes the bytes can re-check the recorded
 * SHA-256 itself rather than trusting this read, and so a refusal still names the trace it is
 * about. The SIZE and the HASH are checked by different owners on purpose: the cap here, because
 * only this layer knows the store's bound, and the digest at the write, because only the writer
 * decides what reaches a disk.
 *
 * NO MEMBER OF THIS TYPE CAN CHANGE A Formal_Verdict. The refutation was decided by the Base_Check
 * and the trace is its EVIDENCE rather than its cause, so every reason this value exists for is a
 * fact about our ability to hand the evidence over - never about the design.
 */
export type CounterexampleCapture =
  | { readonly kind: 'trace'; readonly reference: ArtifactBlobRef; readonly trace: string }
  | {
      readonly kind: 'refused';
      readonly reference: ArtifactBlobRef;
      readonly refusal: CounterexampleRefusal;
    };

/**
 * The Formal_Outcome the Glossary defines: one verdict per property, plus the RUN's own facts.
 *
 * THE THREE RUN-LEVEL FACTS SIT HERE BECAUSE THEY ARE PROPERTIES OF THE RUN AND NOT OF ONE
 * PROPERTY: one pre-pass derives one Reset_Contract and one Clock_Contract for the whole
 * Property_Set, and the per-property facts the Glossary names for a Formal_Outcome - the
 * Formal_Verdict, the Proof_Conditions, the Proof_Depth, and the elapsed time - are already on
 * `PropertyResult` and are not repeated here (Req 14.27, 14.39).
 *
 * `ResetContract` AND `ClockPolarity` ARE IMPORTED AND NEVER RE-DECLARED. Both are unions
 * `./prepass.js` already owns, and `ResetContract` is `renderPropertyWrapper`'s fourth parameter, so
 * a second structurally-similar shape would let this record and the wrapper drift apart on the one
 * value they must agree about.
 *
 * WHY THE TWO NULLABLE FIELDS ARE NULLABLE, AND WHAT `null` MAY NEVER MEAN. `null` is reserved for
 * "the pre-pass was NEVER REACHED" - a killed or missing invocation, a job the seam refused, or a
 * Yosys frontend rejection, none of which produced a reading. A pre-pass that RAN AND REFUSED
 * records the refused arm `{ derived: false }` and the Clock_Contract it read, so a refusal stays
 * distinguishable from a reading that never happened. Recording `null` for a real run would collapse
 * the two, which is the collapse design.md's `FormalProvenance` block forbids.
 *
 * `assertionGateEmitted` STAYS A PLAIN BOOLEAN across both no-run cases, because the gate genuinely
 * was not emitted in either of them: no Property_Wrapper was built for a gate to be emitted into.
 */
export interface FormalOutcome {
  /** One result per SUBMITTED property, in submission order, with no cross-influence (Req 1.11). */
  readonly results: readonly PropertyResult[];
  /**
   * The Property_Wrapper source rendered for each submitted property, paired BY INDEX with
   * `results`, or `null` for a property no wrapper was rendered for (Req 12.15, 12.23).
   *
   * RETURNED RATHER THAN RE-RENDERED, so the wrapper a reader inspects is the one the solver ran
   * on. A second `renderPropertyWrapper` call anywhere else would need the design's
   * `ModuleInterface`, the `FormalProperty`, and the DERIVED Reset_Contract, and a call that
   * disagreed with this one on any of the three would describe a wrapper nobody submitted.
   *
   * ON THE OUTCOME AND NOT ON `PropertyResult`, so a result's size stays bounded by its field count
   * rather than by the design's port list; the text reaches disk through the Artifact_Sink, which
   * bounds it.
   *
   * ONE ENTRY PER RESULT, `null` included, because the pairing is by index: a shorter list would
   * hand a reader's index the wrong property. `null` means no wrapper was rendered for that
   * property - its pre-pass refused or never answered - and never "the wrapper is unknown". A
   * property whose budget was spent before its first rung still carries the text rendered for it:
   * the render happened, it is byte for byte what every rung of its ladder submits, and the
   * result's own `depth` of 0 already says no rung ran.
   */
  readonly propertyWrapperSources: readonly (string | null)[];
  /**
   * The Counterexample_Capture for each submitted property, paired BY INDEX with `results`
   * (Req 12.16, 12.24).
   *
   * `null` FOR EVERY RESULT THAT IS NOT `refuted`, which is the ordinary shape of a run that found
   * no counterexample (Req 12.20) - a proof writes no trace - and for a `refuted` one either the
   * whole trace text or the named reason it could not be read whole.
   *
   * ONE ENTRY PER RESULT, `null` INCLUDED, by the same rule `propertyWrapperSources` follows: the
   * pairing is by index, so a shorter list would hand a reader's index another property's trace.
   *
   * THE BYTES RIDE HERE AND NOT ON `PropertyResult`, which still carries the reference and no
   * bytes. That keeps a result's size bounded by its field count, and keeps "no Verilog source
   * text on a `PropertyResult`" true of a type a VCD would otherwise be the first exception to.
   */
  readonly counterexampleCaptures: readonly (CounterexampleCapture | null)[];
  /** The derived Reset_Contract, or `null` where the pre-pass was never reached (Req 14.27). */
  readonly resetContract: ResetContract | null;
  /**
   * Whether the `if (!$initstate)` assertion gate was emitted into ANY rendered Property_Wrapper
   * (Req 14.27).
   *
   * ANY rather than EVERY, because one wrapper is rendered per property and the gate's rule reads
   * the property as well as the contract: a set mixing clocked and combinational properties over a
   * sync-reset free-initial-state design gates the clocked wrappers and cannot gate the
   * combinational ones. `false` must therefore mean no wrapper carried the gate, which is the
   * reading a reader auditing for the gate's measured MASKING effect needs; `every` would report
   * `false` for a run where a clocked wrapper did carry it, understating exactly that exposure.
   */
  readonly assertionGateEmitted: boolean;
  /** The Clock_Contract read, or `null` where the pre-pass was never reached (Req 14.39). */
  readonly clockPolarity: ClockPolarity | null;
}

/**
 * The Formal_Oracle port (Req 11.12): decide one property or one Property_Set, or say why not.
 *
 * Callers depend on this interface and never on the class below, so every test of the
 * five-condition gate runs against a double with no toolchain present.
 *
 * `prove` IS IMPLEMENTED AS `proveSet` OVER A ONE-ELEMENT SET, and that is the point of the shape
 * rather than tidiness. The named risk is the two methods DRIFTING into different behaviours, which
 * would be a verdict that depends on which method a caller reached for; delegation makes that
 * divergence structurally impossible instead of merely discouraged. Every implementation of this
 * port owes the same relation between its two methods.
 */
export interface FormalOraclePort {
  /** One Formal_Property. The per-property window onto `proveSet`, unchanged for its callers. */
  prove(request: FormalProveRequest): Promise<PropertyResult>;
  /** One Property_Set, returning the run-level Formal_Outcome the Glossary defines. */
  proveSet(request: FormalProveSetRequest): Promise<FormalOutcome>;
}

/**
 * The text of one artifact the Tool_Runner registered, or `null` where it cannot be read.
 *
 * A SECOND PORT, AND A NAMED SEAM GAP RATHER THAN A QUIET ONE. `SandboxResult.artifacts` carries
 * `ArtifactBlobRef` values - a name, a size, and a SHA-256 - and no bytes, which is the model the
 * seam already documents ("their bytes live in the blob store, fetched by ref, never inline
 * contents", `../synth/adapter.ts`). Both formal reports are workspace files registered that way,
 * so their TEXT has no channel across the seam today, and the gate cannot read a verdict it cannot
 * see. Req 11.2 forbids this module from reading a file of its own, so the resolution is a port: the
 * composition root supplies whatever can resolve a ref to bytes on its runtime, and this module
 * still executes nothing and opens nothing.
 *
 * `null` is a first-class answer and the fail-safe one: it flows into `report === null` and
 * `readFormalPrepassReport('')`, both of which already mean "we have no evidence" and both of which
 * yield `could-not-verify`. No implementation of this port can produce a `proved` by failing.
 */
export interface FormalArtifactReader {
  readText(artifact: ArtifactBlobRef): Promise<string | null>;
}

/**
 * The four resource caps every formal invocation carries (Req 11.3).
 *
 * `wallMs` is EXCLUDED by construction, not by convention: it is derived from the remaining
 * Property_Time_Budget on every job, so the sandbox is the only thing enforcing the budget and there
 * is no second timer to race it. `Omit` rather than a fresh interface, so a fifth cap added to
 * `ResourceLimits` arrives here automatically instead of being silently dropped.
 */
export type FormalResourceCaps = Omit<ResourceLimits, 'wallMs'>;

/** What the adapter needs injected. A deps object, matching the orchestrator's own convention. */
export interface FormalOracleDeps {
  /** The ONLY surface that executes Yosys, `yosys-smtbmc`, bitwuzla, or Z3 (Req 11.1, 11.5). */
  readonly toolRunner: ToolRunner;
  /** Resolves a registered report artifact to its text. See `FormalArtifactReader`. */
  readonly artifacts: FormalArtifactReader;
  /** The four caps, identical on the pre-pass and on every proof attempt (Req 11.3, 14.25). */
  readonly caps: FormalResourceCaps;
  /** Wall-clock source for the budget; defaults to `Date.now`, as elsewhere in this repo. */
  readonly now?: () => number;
}

// Both depths moved to `./depth-ladder.js`, which imports nothing, so the renderer can derive
// the Warm_Up_Ceiling from the first rung without a cycle. Re-exported here so the
// `@app/tools` surface and every importer stay as they were. See design.md, Component 18.
export { CLOCKED_DEPTH_LADDER, COMBINATIONAL_DEPTH };

/**
 * The default Property_Time_Budget, in milliseconds. ONE named build constant (Req 7.13, 7.14).
 *
 * Covered by `FORMAL_ORACLE_VERSION`, so a change to it moves the recorded experiment identity.
 *
 * THE NUMBER IS NOT TUNED - IT SITS INSIDE A MEASURED EMPTY GAP, which is a stronger claim than
 * defending 150 against 140. The measured cost distribution is BIMODAL. Everything the chain proves
 * once the reset assume is in place lands at roughly 3.4s or below (`adder_pipe_64bit`'s Base_Check
 * 2.72s and its full run 3.35s, `JC_counter` 0.87s), and the next measurement up is
 * `multi_booth_8bit`, whose Base_Check is 53.50s with the Induction_Check separately 104s to 110s -
 * roughly 160s for one property on that one design. Nothing sits between roughly 3.4s and roughly
 * 160s, so any budget inside that gap behaves identically: it admits everything measured to prove
 * and refuses the multiplier class without cutting through a cluster.
 *
 * THERE IS NO MULTIPLIER SHORT-CIRCUIT, and `proofDepthsFor` is the only routing decision in this
 * module (Req 7.15, 7.16). Every candidate design the frontend accepted ATTEMPTS the proof, and
 * `proof-timeout` is the only route by which the multiplier class leaves the formal gate. The class
 * is not generically definable without either hardcoding corpus design names, which does not survive
 * contact with a student's design, or a netlist heuristic that can be wrong in both directions. A
 * budget that expires is an honest `could-not-verify`; a class predicate that misfires is a silent
 * routing decision.
 */
export const DEFAULT_PROPERTY_TIME_BUDGET_MS = 150_000;

/**
 * The Property_Wrapper's module name: the `-top` of every `formal` job (Req 3.6).
 *
 * ADAPTER-OWNED and a plain Verilog identifier, so no model output reaches `prep -top`. The worker
 * re-validates the same value against its own identifier pattern before it becomes a command-line
 * argument, because the worker is a trust boundary in its own right.
 */
export const PROPERTY_WRAPPER_MODULE_NAME = 'formal_property_wrapper';

/**
 * The workspace-relative filename the Property_Wrapper is submitted under.
 *
 * Distinct from any candidate design's and any Testbench's (Req 12.15), and the name
 * `interpretFormalReport` attributes a lowering failure BY (Req 8.8).
 *
 * No collision guard, deliberately. A caller that submitted its design under this exact path would
 * have the wrapper written over it, and the failure is then already loud and already correctly
 * attributed: the same file arrives twice on the `read_verilog` line, Yosys reports a duplicate
 * module, the diagnostic names the WRAPPER, and the cause is `property-build-failed` - our
 * instrument, which is the right thing to blame. A guard here would add a branch that nothing can
 * reach past the behaviour that already covers it.
 */
export const PROPERTY_WRAPPER_FILE_NAME = 'formal_property_wrapper.v';

/**
 * The `formal` job's required outputs: the report, and NOT the counterexample trace (Req 12.19).
 *
 * THIS ASYMMETRY WITH THE PRE-PASS IS WHAT KEEPS A SUCCESSFUL PROOF FROM CLASSIFYING AS `error`.
 * `missingRequiredOutputs` forces the whole invocation to `error` when a required output is absent,
 * and a successful proof writes NO trace, so naming the trace here would classify every proof as an
 * error. It is registered opportunistically instead, under `COUNTEREXAMPLE_ARTIFACT_KEY`, and read
 * from `SandboxResult.artifacts` by `./interpret.js` where a refutation needs it.
 */
const FORMAL_REQUIRED_OUTPUTS: readonly RequiredOutput[] = ['formalReport'];

/**
 * The `formalPrepass` job's required outputs: the report, which IS required.
 *
 * The other side of the asymmetry above. A pre-pass that produced no report produced nothing - its
 * entire output is the report - so there is no success case in which the report is legitimately
 * absent, and its absence should classify the invocation `error`.
 */
const PREPASS_REQUIRED_OUTPUTS: readonly RequiredOutput[] = ['formalPrepassReport'];

/** The artifact key `formal-report.json` is registered under. Spelled once on this side. */
const FORMAL_REPORT_ARTIFACT_KEY = 'formalReport';

/** The artifact key `formal-prepass-report.json` is registered under. */
const PREPASS_REPORT_ARTIFACT_KEY = 'formalPrepassReport';

/**
 * The `depth` recorded for a refusal reported before any invocation ran at one.
 *
 * Zero rather than a ladder rung, because `PropertyResult.depth` records the depth every
 * `yosys-smtbmc` invocation in the run used (Req 4.4) and a pre-pass refusal ran none. A first rung
 * here would claim a proof attempt that never happened.
 */
const NO_PROOF_DEPTH = 0;

/**
 * The `wallMs` floor for a job that still has budget left, in milliseconds.
 *
 * A remaining budget rounds down to a positive integer for the seam's `wallMs`, and a sub-millisecond
 * remainder must not become `0` - the seam would reject it, and a zero cap is not what "there is
 * still time" means. One millisecond is the smallest honest expression of a budget that is almost
 * but not quite spent; the run is killed immediately and reports `proof-timeout`, which is the same
 * answer the exhausted branch gives.
 */
const MIN_JOB_WALL_MS = 1;

/**
 * The marker a Yosys FRONTEND or elaboration error prints. Half of the pre-pass discriminator.
 *
 * MEASURED on `verified_float_multi.v` under Yosys 0.66: the frontend error is
 * `design.v:17: ERROR: Found non-synthesizable event list!`. `verified_synchronizer.v` prints
 * `ERROR: Multiple edge sensitive events found for this signal!`, which carries NO FILENAME - the
 * reason the attribution below is by the job's CONTENTS and never by the diagnostic's text.
 */
const YOSYS_ERROR_MARKER = 'ERROR:';

/**
 * The ordered Proof_Depth ladder for one design and one property. Deterministic and pure (Req 4.5).
 *
 * A function of the DESIGN and the PROPERTY and of nothing else - no clock, no random source, no
 * configuration, and above all no model output - so two identical requests choose identical depths.
 *
 * IT READS BOTH INPUTS, AND THE DESIGN HALF IS LOAD-BEARING RATHER THAN DECORATIVE. Depth 1 is only
 * sound where there is no state to step through, and a property with no clocking event can still sit
 * on a design full of flops (a module-level `assert property (...)` over a clocked design elaborates
 * fine). Keying depth on the property's kind ALONE would run k=1 induction over that design's state
 * - an under-depth proof, which is the direction that manufactures a false `proved`. So depth 1 is
 * reserved for the case where both halves agree there is nothing to step through, and everything
 * else takes the clocked ladder. Being wrong the other way costs a fraction of a second: the
 * combinational anchor is 0.09s at depth 1.
 */
export function proofDepthsFor(
  designInterface: ModuleInterface,
  property: FormalProperty,
): readonly number[] {
  const stateless =
    designInterface.clocking.clockName === null && property.kind === 'combinational';
  return stateless ? [COMBINATIONAL_DEPTH] : CLOCKED_DEPTH_LADDER;
}

/**
 * Assemble the `formalPrepass` job: the candidate design ALONE, under its OWN module name.
 *
 * The design's own name is the `-top`, not a wrapper's, because no wrapper exists yet - that is the
 * whole reason this is a second job kind. Pure and exported so job assembly is assertable without a
 * toolchain.
 */
export function assembleFormalPrepassJob(
  designSource: SourceFile,
  designInterface: ModuleInterface,
  limits: ResourceLimits,
): SandboxJob {
  return {
    kind: 'formalPrepass',
    // The design, passed through unchanged: EQUAL IN VALUE to the source we were given (Req 3.5).
    workspaceFiles: [designSource],
    limits,
    requiredOutputs: PREPASS_REQUIRED_OUTPUTS,
    formalPrepass: { topModule: designInterface.moduleName },
  };
}

/**
 * Assemble the `formal` job: the unedited design, the rendered wrapper, and the chosen depth.
 *
 * The wrapper is the `-top` (Req 3.6), so the properties elaborate INSIDE the design rather than
 * beside it, and the design file is submitted exactly as received (Req 3.5). Pure and exported.
 */
export function assembleFormalJob(
  designSource: SourceFile,
  wrapper: SourceFile,
  depth: number,
  limits: ResourceLimits,
): SandboxJob {
  return {
    kind: 'formal',
    workspaceFiles: [designSource, wrapper],
    limits,
    requiredOutputs: FORMAL_REQUIRED_OUTPUTS,
    formal: { topModule: PROPERTY_WRAPPER_MODULE_NAME, depth },
  };
}

/**
 * The budget this run may spend, in milliseconds, or `0` for a budget we cannot use.
 *
 * A budget is an ordinary input at a boundary, so it is validated rather than trusted: `NaN`,
 * `Infinity`, a negative, and a fractional value are all "we do not have a usable budget". They
 * collapse to `0`, which reports `proof-timeout` before any job is submitted - fail-safe, because
 * the alternative readings are an unbounded `wallMs` or a fabricated default, and neither can ever
 * be the honest answer to "how long may this property have".
 */
function usableBudgetMs(budgetMs: number): number {
  return Number.isSafeInteger(budgetMs) && budgetMs > 0 ? budgetMs : 0;
}

/**
 * Whether one invocation raised a Yosys frontend or elaboration error (Req 8.10, 8.11).
 *
 * BOTH CONDITIONS, AND THAT IS THE WHOLE CONTENT OF Req 8.11: the run exited NON-ZERO *and* its
 * output carries a Yosys `ERROR:` line. The exit code alone is not the discriminator, because a
 * `write_smt2` failure, a crash, and an absent binary all exit non-zero and every one of them is OUR
 * INSTRUMENT. Attributing those to the candidate design is the blame-the-student direction, so the
 * discriminator is the frontend PHASE and the `ERROR:` marker is what identifies it.
 *
 * A `null` EXIT CODE MUST NOT SATISFY THE NON-ZERO TEST, which is why `!== null` is spelled rather
 * than leaning on `!== 0`. `SandboxResult.exitCode` is `null` on a wall-clock kill, and `null !== 0`
 * is `true` in TypeScript, so the loose form would attribute a KILLED pre-pass to the design the
 * moment its partial output happened to carry an `ERROR:` line. `#deriveContract` checks `timedOut`
 * ahead of this predicate for the same reason, so the two guards are belt and braces on one fact:
 * a run we killed tells us nothing about the design.
 *
 * BOTH STREAMS ARE SCANNED. MEASURED on `verified_float_multi.v` under Yosys 0.66, the frontend
 * error goes to STDERR (exit code 1) and stdout carries only style warnings with no `ERROR:` at all,
 * so stderr alone would in fact have sufficed for the measured class. Scanning stdout too costs
 * nothing - the two are capped independently by the worker, at 262_144 and 1_048_576 bytes - and the
 * alternative is relying on the stream choice of a tool we do not own.
 */
function raisedFrontendError(result: SandboxResult): boolean {
  const failed = result.exitCode !== null && result.exitCode !== 0;
  return (
    failed &&
    (result.stderr.includes(YOSYS_ERROR_MARKER) || result.stdout.includes(YOSYS_ERROR_MARKER))
  );
}

/**
 * What went wrong before a Property_Wrapper existed: the cause, the tool output, and the reading.
 *
 * `FormalPrepassRefusal`'s two nullable readings plus the diagnostic this module owns surfacing.
 * The readings are `null` on every branch BELOW that refuses before a report is read at all - a
 * spent budget, a job the seam refused, a killed run, a frontend rejection - because none of those
 * established a contract, and they are the document's own values on the branch that did read one.
 */
interface PrepassRefusal extends FormalPrepassRefusal {
  /** The pre-pass run's raw stderr, sanitized by `./interpret.js` before it is surfaced. */
  readonly diagnostic: string;
}

/** The two readings a refusal reported before any report was read carries: neither (Req 14.27). */
const NO_PREPASS_READING = { reset: null, clockPolarity: null } as const;

/**
 * One ladder rung's whole answer: the result, and the Counterexample trace read right after it.
 *
 * THE TWO TRAVEL TOGETHER because the trace has to be read at the invocation that registered it,
 * and `#attempt` is the only place that holds both the result and that invocation. Threading a
 * pair through the ladder is what keeps the read AT the run rather than at the set, which is the
 * whole point of Req 12.24; returning the result alone would force a later reader to go back to a
 * shared store that may already have evicted the bytes.
 *
 * `capture` is `null` for every rung whose result is not `refuted`, and for every refusal reported
 * before an invocation ran - neither registered a trace for there to be one of.
 */
interface AttemptOutcome {
  readonly result: PropertyResult;
  readonly capture: CounterexampleCapture | null;
}

/** One result that registered no Counterexample, as an `AttemptOutcome`. */
function withoutCapture(result: PropertyResult): AttemptOutcome {
  return { result, capture: null };
}

/**
 * `FormalOraclePort` backed by the Tool_Runner running Yosys and `yosys-smtbmc`.
 *
 * The `ToolRunner` and the `FormalArtifactReader` are injected, so a `FakeSandboxRuntime`-backed
 * runner drives this class with no toolchain present and the real local-worker runtime drives it
 * with one. No concrete sandbox runtime is named anywhere in this module (Req 11.5).
 */
export class YosysSmtBmcFormalOracle implements FormalOraclePort {
  readonly #toolRunner: ToolRunner;
  readonly #artifacts: FormalArtifactReader;
  readonly #caps: FormalResourceCaps;
  readonly #now: () => number;

  constructor(deps: FormalOracleDeps) {
    this.#toolRunner = deps.toolRunner;
    this.#artifacts = deps.artifacts;
    this.#caps = deps.caps;
    this.#now = deps.now ?? Date.now;
  }

  /**
   * Decide one Formal_Property, as a ONE-ELEMENT Property_Set.
   *
   * NOT A SECOND IMPLEMENTATION, AND THAT IS THE WHOLE REASON FOR THE SHAPE. The risk this method
   * carries is drifting from `proveSet` into different behaviour, which would make a verdict depend
   * on which method a caller reached for, so it builds a one-element set and returns that outcome's
   * single result. There is no pre-pass, no render, and no ladder here to drift.
   *
   * `proveSet` returns one result per submitted property in submission order, so a one-element set
   * yields exactly one result and there is no absent-result case to invent a value for. The
   * fallback below is the one `#budgetlessRefusal` already exists for: unreachable, and present
   * because a total function must answer for the index the type says may be empty.
   */
  async prove(request: FormalProveRequest): Promise<PropertyResult> {
    const outcome = await this.proveSet({
      designSource: request.designSource,
      designInterface: request.designInterface,
      properties: [request.property],
      budgetMs: request.budgetMs,
    });
    return outcome.results[0] ?? this.#budgetlessRefusal(request.property, this.#now());
  }

  /**
   * Decide a whole Property_Set: ONE pre-pass, then a render and a ladder per property.
   *
   * The order is a correctness constraint rather than a preference. The pre-pass answers first
   * because each wrapper needs its answers and a wrapper is the proof's `-top`; a refusal there is
   * reported ahead of the whole fixed condition order with no Proof_Condition evaluated and no
   * wrapper built (Req 1.18), for EVERY submitted property, because the refusal is a fact about the
   * design they all share.
   *
   * THE PRE-PASS RUNS ONCE FOR THE SET, which is what lets the three run-level facts be returned at
   * all (Req 14.27, 14.39) and incidentally removes the N-1 redundant pre-pass runs the
   * per-property `prove` performed - it holds no cache, so before this method existed the contract
   * was re-derived and discarded once per property. The removal is a side effect and not the reason.
   *
   * The pre-pass time is deducted from every window but recorded once, on the first result, whether
   * the pre-pass admitted or refused. Each result's time is its property's whole interval, so the
   * results tile the run and the Session_Budget is charged each moment exactly once.
   *
   * The loop terminates on every input: the property list is finite and each element is visited once.
   */
  async proveSet(request: FormalProveSetRequest): Promise<FormalOutcome> {
    if (request.properties.length === 0) {
      // No property to decide, so no pre-pass is run and nothing was established. A reading is not
      // taken for a set with nothing to take it for, and the Verification_Loop decides an empty
      // Property_Set from the simulation path rather than calling an empty set proved.
      return {
        results: [],
        propertyWrapperSources: [],
        counterexampleCaptures: [],
        resetContract: null,
        assertionGateEmitted: false,
        clockPolarity: null,
      };
    }
    const startedAt = this.#now();
    const budgetMs = usableBudgetMs(request.budgetMs);

    const contract = await this.#deriveContract(request, budgetMs, startedAt);
    if (!contract.ok) {
      return this.#refusedSet(request.properties, contract.error, this.#elapsedSince(startedAt));
    }
    const prepassMs = this.#elapsedSince(startedAt);
    const { reset, clockPolarity } = contract.value;

    // Each result paired with the reading its interval starts at; the first starts at the run's
    // start, so it carries the pre-pass once.
    const decided: { readonly result: PropertyResult; readonly start: number }[] = [];
    const propertyWrapperSources: string[] = [];
    const counterexampleCaptures: (CounterexampleCapture | null)[] = [];
    let assertionGateEmitted = false;
    for (const property of request.properties) {
      const boundary = this.#now();
      const perProperty: FormalProveRequest = {
        designSource: request.designSource,
        designInterface: request.designInterface,
        property,
        budgetMs: request.budgetMs,
      };
      // Asked of the renderer's own rule rather than re-derived from the contract here, so the
      // recorded fact and the emitted text cannot disagree.
      assertionGateEmitted = assertionGateEmitted || emitsAssertionGate(property, reset);
      const wrapper = wrapperFor(request.designInterface, property, reset);
      const attempt = await this.#climbLadder(perProperty, wrapper, budgetMs - prepassMs, boundary);
      decided.push({ result: attempt.result, start: decided.length === 0 ? startedAt : boundary });
      // Read at the rung that registered it, never here. See `CounterexampleCapture`.
      counterexampleCaptures.push(attempt.capture);
      // The text every rung of this property's ladder submitted, kept rather than re-rendered.
      propertyWrapperSources.push(wrapper.contents);
    }
    // Each interval ends where the next property's begins, and the last one at this final reading.
    const finishedAt = this.#now();
    const results = decided.map(({ result, start }, index) => ({
      ...result,
      elapsedMs: Math.max(0, (decided[index + 1]?.start ?? finishedAt) - start),
    }));
    return {
      results,
      propertyWrapperSources,
      counterexampleCaptures,
      resetContract: reset,
      assertionGateEmitted,
      clockPolarity,
    };
  }

  /**
   * The outcome for a set whose shared pre-pass refused: one refusal per submitted property.
   *
   * Every property carries the SAME cause, because the refusal is a fact about the design they all
   * share and not about any one of them, and the run-level readings are the ones the refusal
   * established - the refused arm and the Clock_Contract where a report was read, neither where
   * none was. `assertionGateEmitted` is `false` and every wrapper source is `null` because no
   * Property_Wrapper was built at all - one `null` per property, so the index pairing holds.
   */
  #refusedSet(
    properties: readonly FormalProperty[],
    refusal: PrepassRefusal,
    prepassMs: number,
  ): FormalOutcome {
    return {
      results: properties.map((property, index) =>
        refusedWithoutProof(
          refusal.cause,
          property,
          // The one pre-pass's time, recorded once. See `proveSet`.
          { depth: NO_PROOF_DEPTH, elapsedMs: index === 0 ? prepassMs : 0 },
          refusal.diagnostic,
        ),
      ),
      propertyWrapperSources: properties.map(() => null),
      // No invocation ran, so no trace was registered for any property to carry one.
      counterexampleCaptures: properties.map(() => null),
      resetContract: refusal.reset,
      assertionGateEmitted: false,
      clockPolarity: refusal.clockPolarity,
    };
  }

  /**
   * Run the ladder, escalating on `antecedent-unreached` alone (Req 4.7, 4.13).
   *
   * ESCALATION HAPPENS ON THAT ONE CAUSE AND ON NOTHING ELSE. One cover result at one depth cannot
   * distinguish a vacuous property from a depth below the antecedent's first reachable step -
   * measured, `counter_12`'s `out == 11` is reached at step 13 and reports unreached at every depth
   * below 14 - so an unreached cover is the one answer more depth can change.
   *
   * IT SPECIFICALLY NEVER ESCALATES ON AN INDUCTION FAILURE. `yosys-smtbmc`'s k-induction emits no
   * simple-path constraints, so a CORRECT design can fail the inductive step at EVERY depth -
   * measured on a constructed `bounded_ctr`, on `counter_12`'s `out != 4'd13`, and on the Yosys
   * issue-3378 ROM shape at depths 1, 5, 20, and 40. No depth is known to repair that, and the tool's
   * own `Loop detected, increasing induction depth will not help` message printed on NONE of the
   * measured failing cases, so there is no signal separating "go deeper" from "no depth will ever
   * help". That case arrives here as `induction-engine-incomplete`, which is not the escalating
   * cause, so it terminates on the rung it was found at with no further work.
   *
   * The loop terminates on every input: the ladder is a fixed finite list and each rung is visited
   * once.
   */
  async #climbLadder(
    request: FormalProveRequest,
    wrapper: SourceFile,
    budgetMs: number,
    startedAt: number,
  ): Promise<AttemptOutcome> {
    const depths = proofDepthsFor(request.designInterface, request.property);
    let last: AttemptOutcome | null = null;
    for (const depth of depths) {
      const remainingMs = budgetMs - this.#elapsedSince(startedAt);
      if (remainingMs <= 0) {
        // Budget spent between rungs, carrying the elapsed time and the DEEPEST depth attempted -
        // or `NO_PROOF_DEPTH` where the budget was already spent by the pre-pass (Req 7.2).
        return withoutCapture(
          refusedWithoutProof(
            'proof-timeout',
            request.property,
            {
              depth: last?.result.depth ?? NO_PROOF_DEPTH,
              elapsedMs: this.#elapsedSince(startedAt),
            },
            '',
          ),
        );
      }
      last = await this.#attempt(request, wrapper, depth, remainingMs);
      if (!escalates(last.result)) {
        return last;
      }
    }
    // The ladder is exhausted and every rung reported an unreached antecedent, which is the honest
    // verdict for the vacuity finding: the deepest rung's own result, reported as it stands.
    return last ?? withoutCapture(this.#budgetlessRefusal(request.property, startedAt));
  }

  /**
   * One proof attempt at one depth: assemble, submit, read the report, classify.
   *
   * Classification is `interpretFormalReport` and nothing else. The only judgement here is which
   * document to hand it, and that is not a judgement either: `report === null` is the seam's own
   * "we have no evidence", covering a run the Tool_Runner classified `error`, an absent
   * `formalReport` artifact, and a report that failed schema validation, all of which the owner
   * already collapses into one answer (Req 11.8, 11.13).
   *
   * THE COUNTEREXAMPLE READ HAPPENS HERE AND NOWHERE LATER (Req 12.24). This method is the only
   * place that holds both a classified result and the invocation that produced it, and the trace
   * lives in a bounded store every other run on the shared runtime keeps overwriting, so one line
   * further out is already a race. It cannot change what this method returns: the capture rides
   * BESIDE the result rather than inside it.
   */
  async #attempt(
    request: FormalProveRequest,
    wrapper: SourceFile,
    depth: number,
    remainingMs: number,
  ): Promise<AttemptOutcome> {
    const job = assembleFormalJob(request.designSource, wrapper, depth, this.#limits(remainingMs));
    const run: FormalRunContext = {
      depth,
      elapsedMs: 0,
      designFileName: request.designSource.path,
      wrapperFileName: wrapper.path,
    };
    const startedAt = this.#now();
    const submitted = await this.#submit(job);
    const elapsedMs = this.#elapsedSince(startedAt);
    if (submitted === null) {
      return withoutCapture(
        refusedWithoutProof('property-build-failed', request.property, { depth, elapsedMs }, ''),
      );
    }
    const report = await this.#reportOf(submitted);
    const result = interpretFormalReport(submitted, report, request.property, {
      ...run,
      elapsedMs,
    });
    return { result, capture: await this.#captureCounterexample(result) };
  }

  /**
   * The Counterexample trace for a `refuted` result, or `null` where there is none to read.
   *
   * TOTAL AND NON-THROWING, and that is the load-bearing property rather than a courtesy. Every
   * way this read can fail is a fact about our ability to hand the EVIDENCE over, so none of them
   * may touch the verdict: the refutation was already decided by the Base_Check, and a trace we
   * cannot produce does not un-refute a design. The caller therefore receives the result it
   * already had plus whichever answer this returns, and has no branch that re-reads the verdict.
   *
   * THE DECLARED SIZE IS CHECKED BEFORE THE READ, which is what makes `over-cap` reachable at all:
   * the store refuses to hold anything past the same cap, so asking first would get `null` back
   * and report `unresolved`, naming the wrong reason. The ACTUAL bytes are then checked too,
   * because the answer crosses an injected port and its size is the port's claim until measured.
   *
   * `typeof` RATHER THAN `=== null`: the port's type says `string | null`, but it is a seam, and
   * any other value would make the byte count below throw inside a method that must not throw.
   *
   * NO DIGEST CHECK HERE, deliberately. The reference rides on the capture so the layer that
   * writes the bytes re-checks the SHA-256 itself, which is the only layer whose decision the
   * digest should gate - and the retention store already recomputes it before admitting a blob,
   * so a lying reference arrives here as `null` and reports `unresolved`.
   */
  async #captureCounterexample(result: PropertyResult): Promise<CounterexampleCapture | null> {
    if (result.verdict !== 'refuted') {
      return null;
    }
    const reference = result.counterexample;
    if (reference.sizeBytes > MAX_RETAINED_ARTIFACT_BYTES) {
      return { kind: 'refused', reference, refusal: 'over-cap' };
    }
    let trace: string | null;
    try {
      trace = await this.#artifacts.readText(reference);
    } catch {
      // Not a silent catch: the port's error can name the store's internals, so it is CLASSIFIED
      // rather than read, and the classification is what the writer turns into its note.
      return { kind: 'refused', reference, refusal: 'read-failed' };
    }
    if (typeof trace !== 'string') {
      return { kind: 'refused', reference, refusal: 'unresolved' };
    }
    return new TextEncoder().encode(trace).length > MAX_RETAINED_ARTIFACT_BYTES
      ? { kind: 'refused', reference, refusal: 'over-cap' }
      : { kind: 'trace', reference, trace };
  }

  /**
   * The pre-pass, its report, and the contract derived from it, or the cause that refuses it.
   *
   * The refusal ORDER between the clock check, the reset derivation, and the initial-state predicate
   * is `deriveFormalPrepassReport`'s, not this method's, and the mapping from an unreadable report to
   * `toolchain-unavailable` is `readFormalPrepassReport`'s. What this method owns is the budget: a
   * pre-pass the sandbox KILLED spent the budget, and Req 7.2 makes that `proof-timeout`.
   *
   * IT ALSO OWNS THE FRONTEND ATTRIBUTION, because the pre-pass is what MEETS the frontend first.
   * Req 14.11 requires it to complete before the Property_Wrapper is rendered, so it reaches
   * `read_verilog` and `prep` ahead of the Lowering_Sequence and a design Yosys refuses fails HERE,
   * writing no report. Before this branch existed that run reached `readFormalPrepassReport('')`,
   * failed the JSON parse, and reported `toolchain-unavailable` - OUR INSTRUMENT, named for a design
   * Yosys correctly rejected. MEASURED on the real toolchain over both quarantined references: the
   * pre-pass script exits 1 and writes no report, printing
   * `design.v:17: ERROR: Found non-synthesizable event list!` for `verified_float_multi` and
   * `ERROR: Multiple edge sensitive events found for this signal!` for `verified_synchronizer`. The
   * ordering is mechanically unavoidable rather than incidental: the second error is raised in
   * `proc`, `proc` runs inside `prep`, and BOTH this pre-pass and the Lowering_Sequence run `prep`.
   *
   * ATTRIBUTED BY THE JOB'S CONTENTS, NOT BY THE DIAGNOSTIC'S FILENAME (Req 8.10, 8.13).
   * `assembleFormalPrepassJob` writes ONE source file, so the only Verilog in that workspace is the
   * candidate design and any frontend error raised in it is the design's BY CONSTRUCTION - no
   * filename matching and no heuristic. That is the STRONGER argument rather than the weaker one: the
   * Lowering_Sequence needs filename attribution precisely BECAUSE it holds two files, and this
   * pre-pass needs none because it holds one.
   *
   * SO `attributeLoweringFailure` IS DELIBERATELY NOT REUSED HERE, and Req 8.13 exists because the
   * reuse looks like a one-line fix and is MEASURED to fail. It reports `frontend-rejected` only
   * where the diagnostic names the design file and not the wrapper file: `verified_float_multi`'s
   * carries `design.v:17:` and would attribute correctly, while `verified_synchronizer`'s carries NO
   * FILENAME AT ALL and would fall through to `property-build-failed`, blaming a Property_Wrapper
   * that does not exist yet - a WORSE label than the one being replaced. Only ONE of the two
   * measured cases reveals that, so a probe over `float_multi` alone would have shipped it.
   *
   * THE CHECK SITS AHEAD OF THE ARTIFACT READ, and that ordering is the conservative direction
   * rather than an accident. Req 8.10 is UNCONDITIONAL on the frontend error, and a run that raised
   * a frontend `ERROR:` yet somehow left a schema-valid report behind is an INCONSISTENT STATE whose
   * derived contract we should refuse to use rather than trust - a reset polarity read off a run
   * Yosys aborted is not a fact about the design. The alternative NOT taken was to read the report
   * first and attribute only where it is missing, which would let exactly that inconsistent run
   * proceed to a proof on a contract of unknown provenance.
   *
   * The diagnostic is `submitted.stderr`, passed exactly as the `proof-timeout` and
   * `toolchain-unavailable` arms already pass it, so `PrepassRefusal`'s existing contract carries it:
   * `./interpret.js` is the single owner of the bound and of the no-host-no-path-no-stack-trace rule
   * (Req 8.4, 8.5, 8.12), and there is no second sanitization step here. `raisedFrontendError` scans
   * stdout as well, so a frontend error printed only there is still ATTRIBUTED; what it surfaces is
   * still the stderr, which is where the measured class prints.
   *
   * UNMEASURED RESIDUAL, named rather than engineered around, and it is FAIL-SAFE. The worker's
   * stream capture is PREFIX-first and says why - compiler diagnostics are head-weighted, the first
   * error is the root cause and the rest is cascade - so a design emitting enough warning output to
   * fill the 262_144-byte stderr cap BEFORE Yosys aborts would have its `ERROR:` line dropped from
   * the capture, and this branch would not fire: the run would report `toolchain-unavailable`
   * instead. That degradation blames our instrument rather than the student, which is the safe
   * direction of the two, and no corpus reference comes near the cap - `verified_float_multi`'s whole
   * stderr is 56 bytes.
   */
  async #deriveContract(
    request: FormalProveSetRequest,
    budgetMs: number,
    startedAt: number,
  ): Promise<Result<FormalPrepassReport, PrepassRefusal>> {
    const remainingMs = budgetMs - this.#elapsedSince(startedAt);
    if (remainingMs <= 0) {
      return err({ cause: 'proof-timeout', diagnostic: '', ...NO_PREPASS_READING });
    }
    const job = assembleFormalPrepassJob(
      request.designSource,
      request.designInterface,
      this.#limits(remainingMs),
    );
    const submitted = await this.#submit(job);
    if (submitted === null) {
      return err({ cause: 'property-build-failed', diagnostic: '', ...NO_PREPASS_READING });
    }
    if (submitted.timedOut) {
      return err({ cause: 'proof-timeout', diagnostic: submitted.stderr, ...NO_PREPASS_READING });
    }
    if (raisedFrontendError(submitted)) {
      return err({
        cause: 'frontend-rejected',
        diagnostic: submitted.stderr,
        ...NO_PREPASS_READING,
      });
    }
    // `?? ''` routes an ABSENT report through the same owner an unreadable one goes through, rather
    // than naming a cause here: `readFormalPrepassContract('')` fails the JSON parse and reports
    // `toolchain-unavailable` with NEITHER reading, which is what "no pre-pass report arrived" means
    // for every run that REACHES this line - the frontend-error class was carved out above, so what
    // is left here is a run whose report is missing or unreadable for a reason of OUR OWN (narrowed
    // Req 14.26). The owner is asked for the READING as well as the cause, because the Formal_Outcome
    // has to tell a pre-pass that ran and refused from one that was never read (Req 14.27, 14.39).
    const text = await this.#artifactText(submitted, PREPASS_REPORT_ARTIFACT_KEY);
    const contract = readFormalPrepassContract(text ?? '');
    return contract.ok
      ? ok(contract.value)
      : err({ ...contract.error, diagnostic: submitted.stderr });
  }

  /** The validated `formal-report.json`, or `null` for every shape of missing evidence. */
  async #reportOf(result: SandboxResult): Promise<FormalReport | null> {
    if (result.verdict === 'error') {
      return null;
    }
    const text = await this.#artifactText(result, FORMAL_REPORT_ARTIFACT_KEY);
    if (text === null) {
      return null;
    }
    const parsed = parseFormalReport(text);
    return parsed.ok ? parsed.value : null;
  }

  /** The text of one registered artifact, or `null` when it was not registered or not readable. */
  async #artifactText(result: SandboxResult, key: string): Promise<string | null> {
    const artifact = result.artifacts[key];
    return artifact === undefined ? null : this.#artifacts.readText(artifact);
  }

  /**
   * Submit one job through the injected Tool_Runner, or `null` where the seam refused it.
   *
   * VALIDATED AGAINST THE SEAM SCHEMA FIRST, through the schema's own validator rather than a second
   * copy of its rules. `SandboxToolRunner.run` THROWS a `SandboxContractError` on a malformed job,
   * and `prove` must never throw - a thrown adapter takes the whole Verification_Loop down. The one
   * reachable way to malform a job here is `designInterface.moduleName`, which originates in a
   * model-generated Spec and becomes `prep -top <name>` inside the sandbox, so it is untrusted input
   * at this boundary (Req 11.9). Asking the schema is what keeps the identifier rule in ONE place;
   * re-spelling the pattern here would be a second owner of a value that reaches a command line.
   */
  async #submit(job: SandboxJob): Promise<SandboxResult | null> {
    return validateSandboxJob(job).ok ? this.#toolRunner.run(job) : null;
  }

  /** The four caps, plus a `wallMs` the remaining budget bounds (Req 11.3, 14.25). */
  #limits(remainingMs: number): ResourceLimits {
    return { ...this.#caps, wallMs: Math.max(MIN_JOB_WALL_MS, Math.floor(remainingMs)) };
  }

  /**
   * Milliseconds since `startedAt`, floored at zero.
   *
   * Floored because `Date.now` is not monotonic: a clock stepped backwards mid-run would otherwise
   * report a negative elapsed time on a `PropertyResult` and hand back MORE budget than the property
   * started with. Zero is the honest floor - no measurable time has passed - and it keeps the budget
   * a ceiling in both directions.
   */
  #elapsedSince(startedAt: number): number {
    return Math.max(0, this.#now() - startedAt);
  }

  /**
   * The refusal for a property no rung was ever entered for.
   *
   * Reached from two places, both unreachable and both needing a total answer: an EMPTY ladder,
   * which `proofDepthsFor` cannot return because both of its arms are non-empty but whose type is
   * `readonly number[]`, and `prove`'s absent single result, which `proveSet`'s one-result-per-
   * submitted-property contract cannot produce but whose index type is nullable under
   * `noUncheckedIndexedAccess`. `proof-timeout` is the fail-safe answer in both, since no proof ran.
   */
  #budgetlessRefusal(property: FormalProperty, startedAt: number): PropertyResult {
    return refusedWithoutProof(
      'proof-timeout',
      property,
      { depth: NO_PROOF_DEPTH, elapsedMs: this.#elapsedSince(startedAt) },
      '',
    );
  }
}

/**
 * The Property_Wrapper for one property under one derived contract, as a workspace file.
 *
 * The renderer is the single owner of every emitted byte, and it takes the pre-pass's DERIVED reset
 * contract - never the Spec's, whose polarity originates in model-generated text (Req 14.9, 14.10).
 * Every property of a set renders under the SAME contract, because one pre-pass derived it for the
 * design they share, and under the same filename, because each is submitted as its own job.
 */
function wrapperFor(
  designInterface: ModuleInterface,
  property: FormalProperty,
  reset: ResetContract,
): SourceFile {
  return {
    path: PROPERTY_WRAPPER_FILE_NAME,
    contents: renderPropertyWrapper(designInterface, property, PROPERTY_WRAPPER_MODULE_NAME, reset),
  };
}

/**
 * Whether this result is the ONE outcome a deeper rung could change (Req 4.7).
 *
 * Reads the `cause` the owner produced and re-derives nothing: `antecedent-unreached` is returned
 * from exactly one place in `admitProved`, and `interpretFormalReport` has already separated it from
 * a cover that ANSWERED NOTHING, which is `toolchain-unavailable` and must not escalate.
 */
function escalates(result: PropertyResult): boolean {
  return result.verdict === 'could-not-verify' && result.cause === 'antecedent-unreached';
}
