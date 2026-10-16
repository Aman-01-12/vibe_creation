// formal-gate-first-light, Component 6: the False_Refutation adjudicator.
//
// WHAT THIS DECIDES, AND WHAT IT REFUSES TO DECIDE
//   The Formal_Oracle returning `refuted` for a property whose author expected `proved` is a
//   CONTRADICTION, not a finding. Two explanations fit it: the property is wrong, or the
//   Reset_Contract the pre-pass derived is wrong and the oracle proved something about a design
//   state that cannot occur. Telling them apart needs an INDEPENDENT referee, so the
//   counterexample is replayed on the unmodified design under iverilog.
//
// WHY iverilog AND NOT A SECOND SOLVER
//   A second SMT solver shares the elaboration front end with the first, so an elaboration-level
//   error reproduces in both and the two agree for the wrong reason. iverilog reads the source
//   independently, which is the only way to tell a derivation defect from a real bug.
//
// WHY THERE ARE THREE OUTCOMES AND NOT TWO (FL-23)
//   `not-realizable` is EVIDENCE THAT THE DERIVATION IS DEFECTIVE. A referee that never ran, or
//   whose trace this reader cannot resolve, has established nothing of the kind - so folding
//   either into `not-realizable` would record a missing simulator as a derivation defect and
//   manufacture a False_Refutation out of an absent toolchain. The third arm is the same shape
//   `RecordedInstrumentVerdict` uses one layer over, whose `unchecked` arm means a control could
//   not speak for the sample; see design.md Component 6 and section J of clarification-answers.md.
//
// THE SCOPE TRAP THIS READER MUST NOT FALL INTO
//   A flattened design re-declares short port names inside a `$scope` per instance, so a
//   scope-blind VCD reader resolves a name like `a` to whichever one-bit slice input came last.
//   Only declarations at depth 1, immediately inside the wrapper's own scope, are the wrapper's
//   own signals. A name this reader cannot resolve there is `unadjudicated`, never a verdict.
//
// Pure except for the one injected referee call. No model call, no clock, no random source.

import type { ModuleInterface, Verdict } from '@app/core';
import type {
  ArtifactBlobRef,
  FormalVerdict,
  ResourceLimits,
  SimulatorAdapter,
  SourceFile,
} from '@app/tools';

/** Why an adjudication reached no finding; a closed set, so `unadjudicated` is never vague. */
export type UnadjudicatedReason =
  /** The iverilog referee is not available on this host, so no replay was attempted. */
  | 'probe-unavailable'
  /**
   * The referee ran and produced no verdict: a timeout, a crash, or no capture.
   *
   * Kept apart from `probe-unavailable` on the precedent `InstrumentUncheckedReason` sets by
   * separating `control-unavailable` from `control-resource-exhausted`: a referee that never
   * started and one that started and died are different facts about the host, and only the
   * second says the replay was attempted at all.
   */
  | 'referee-run-errored'
  /** A counterexample name could not be resolved in the design's own scope. */
  | 'name-unresolvable-in-scope'
  /**
   * The trace does not begin in a state a testbench can drive the design into.
   *
   * MEASURED, and it is why this reason exists rather than a `not-realizable`. A BMC
   * counterexample's step-0 state includes INTERNAL REGISTER values the solver chose freely,
   * and a testbench drives inputs only. So unless the trace starts from an asserted reset, the
   * replay starts somewhere else and cannot reproduce the path however faithfully it drives.
   *
   * The positive control is what caught this: `adder-pipe-64bit-carry-never-set` is false by
   * construction, so its refutation is genuine and a sound adjudicator must call it realizable.
   * Replay reported not-realizable, which would have recorded a FALSE False_Refutation. An
   * adjudicator that cannot distinguish must abstain, never accuse.
   */
  | 'trace-start-state-unreachable'
  /**
   * The replay harness has not passed its own positive control, so it may not accuse.
   *
   * MEASURED: `adder-pipe-64bit-carry-never-set` is false by construction, so its refutation is
   * genuine and a sound adjudicator must call it realizable. The sequence replay reports
   * not-realizable for it, which means the harness cannot yet tell a real counterexample from
   * one it merely failed to reproduce. Suspected cause: a registered output at step i reflects
   * the inputs of step i-1, and the comparison reads both at i.
   *
   * So a replay MISMATCH abstains with this reason instead of returning `not-realizable`.
   * `not-realizable` is an accusation against the Reset_Contract derivation, and an instrument
   * that fails its own control must not be allowed to make one. The confirming direction is
   * still reported, because a replay that DOES reproduce the path is evidence either way.
   */
  | 'replay-harness-unvalidated'
  /**
   * The counterexample is a MULTI-STEP trace, and this referee drives one step.
   *
   * Measured on `multi_16bit`, whose 17-deep `$past` window puts the witnessing behaviour at
   * least eighteen steps out. A counterexample is a path, and replaying one state of a path is a
   * different question rather than a weaker form of the same one, so this abstains instead of
   * answering the wrong one. See FL-24; sequence replay is the specified fix.
   */
  | 'sequence-replay-unsupported';

/** Operator-facing words for each reason; total, so a new reason cannot ship without them. */
const UNADJUDICATED_DESCRIPTIONS: Readonly<Record<UnadjudicatedReason, string>> = Object.freeze({
  'probe-unavailable':
    'the iverilog referee is unavailable on this host, so the counterexample was never replayed',
  'referee-run-errored':
    'the referee ran and reached no verdict, so the replay establishes nothing either way',
  'name-unresolvable-in-scope':
    "a counterexample signal could not be resolved in the design's own scope, so the replay would have driven the wrong net",
  'replay-harness-unvalidated':
    'the replay did not reproduce the counterexample, but the replay harness has not passed its own positive control, so this is not evidence against the derivation',
  'trace-start-state-unreachable':
    'the counterexample does not begin in a state a testbench can drive the design into, because a solver may choose any initial register values and stimulus cannot impose them',
  'sequence-replay-unsupported':
    'the counterexample is a multi-step trace and this referee drives a single step, so replaying it would answer a different question',
});

/** What the referee observed when it replayed a counterexample. Diagnostics only, never bytes. */
export interface SimulationEvidence {
  /** The referee's own verdict for the replay run. */
  readonly verdict: Verdict;
  /** The replay checks that did NOT pass, by name, in emission order. */
  readonly failedChecks: readonly string[];
  /** The referee process exit code, or `null` where it did not run to an exit. */
  readonly exitCode: number | null;
  /** The replay's own waveform, or `null` where the run produced none. */
  readonly vcd: ArtifactBlobRef | null;
}

/**
 * One adjudication of one candidate.
 *
 * A discriminated union rather than a kind plus nullable fields, so "realizable with no
 * evidence" and "unadjudicated with evidence" are not representable - the same discipline
 * `RecordedInstrumentVerdict` uses in `app/eval/instrument-control.ts`.
 */
export type Adjudication =
  | { readonly kind: 'realizable'; readonly evidence: SimulationEvidence }
  | { readonly kind: 'not-realizable'; readonly evidence: SimulationEvidence }
  | { readonly kind: 'unadjudicated'; readonly reason: UnadjudicatedReason };

/** The counterexample occurs on the unmodified design, so the refutation is on its merits. */
export function realizable(evidence: SimulationEvidence): Adjudication {
  return { kind: 'realizable', evidence };
}

/** The counterexample does NOT occur on the unmodified design: a derivation defect. */
export function notRealizable(evidence: SimulationEvidence): Adjudication {
  return { kind: 'not-realizable', evidence };
}

/** No finding, with the reason there was none. Carries no evidence, because there is none. */
export function unadjudicated(reason: UnadjudicatedReason): Adjudication {
  return { kind: 'unadjudicated', reason };
}

/** One adjudication in operator-facing words. */
export function describeAdjudication(adjudication: Adjudication): string {
  if (adjudication.kind === 'unadjudicated') {
    return `unadjudicated: ${UNADJUDICATED_DESCRIPTIONS[adjudication.reason]}`;
  }
  if (adjudication.kind === 'realizable') {
    return 'realizable: the counterexample occurs on the unmodified design, so the property is refuted on its merits';
  }
  return 'not-realizable: the counterexample does not occur on the unmodified design, so the Reset_Contract derivation is the suspect';
}

/** The reset facts the pre-pass derived, as a candidate carries them. */
export interface CandidateResetContract {
  readonly kind: string;
  readonly polarity: string;
}

/**
 * A surprising refutation, recorded with the evidence an adjudication needs.
 *
 * Recorded BEFORE any Fixture_Property changes, and the expected verdict stays as its author
 * stated it while the contradiction is unadjudicated, so the record cannot be read as having
 * been reconciled by the change that followed it.
 */
export interface CandidateFalseRefutation {
  readonly propertyId: string;
  readonly designId: string;
  /** The UNMODIFIED design the referee replays against. */
  readonly design: SourceFile;
  readonly designInterface: ModuleInterface;
  /** The verdict the Fixture_Property's author stated, left exactly as stated. */
  readonly expectedVerdict: FormalVerdict;
  /** The verdict the Formal_Oracle returned. */
  readonly actualVerdict: FormalVerdict;
  /** The Counterexample trace text the Formal_Oracle returned. */
  readonly counterexample: string;
  /** The Reset_Contract the pre-pass derived, or `null` where it derived none. */
  readonly resetContract: CandidateResetContract | null;
}

/** The one shape that is a candidate: `proved` expected, `refuted` returned. */
export function isCandidateShape(expected: FormalVerdict, actual: FormalVerdict): boolean {
  return expected === 'proved' && actual === 'refuted';
}

// -- Reading the counterexample ----------------------------------------------

/** One `$var` declaration: `$var <type> <width> <id> <name> $end`. */
const VCD_VAR_RE = /^\$var\s+\S+\s+\d+\s+(\S+)\s+(\S+)\s+\$end/;

/** A vector value change, the form `yosys-smtbmc` writes for a wire. */
const VCD_VECTOR_RE = /^b([01xzXZ]+)\s+(\S+)$/;

/** A scalar value change: one character then the identifier, with no separator. */
const VCD_SCALAR_RE = /^([01xzXZ])(\S+)$/;

/**
 * Names in the trace that are not design signals.
 *
 * `smt_clock` and `smt_step` are smtbmc's own bookkeeping and `__formal_warmup_age` is OUR
 * gate counter, so none of the three is a signal the design declares and none may be driven.
 */
const NON_DESIGN_SIGNALS: ReadonlySet<string> = new Set([
  'smt_clock',
  'smt_step',
  '__formal_warmup_age',
]);

/** One time step of the counterexample: the design's own depth-1 signal values at that step. */
export interface TraceStep {
  readonly step: number;
  /**
   * Values as `bigint`, NOT `number`.
   *
   * MEASURED: `adder_pipe_64bit` carries 64-bit operands and a 65-bit result, and reading those
   * with `Number.parseInt` silently rounds above 2^53 - the trace's 2^64 came back as
   * 18446744073709552000. The replay then drove a value the solver never chose, so the
   * counterexample could not reproduce and the positive control failed. A register is a bit
   * vector of arbitrary width, so the only honest carrier is one that does not round.
   */
  readonly values: ReadonlyMap<string, bigint>;
}

/**
 * Every step of the counterexample, in order, with values CARRIED FORWARD.
 *
 * A VCD records only CHANGES, so a signal that holds its value appears once and then not again.
 * Carrying forward is therefore not a convenience: a reader taking each step's lines literally
 * would see a held input as absent and drive it to zero, replaying a different stimulus than the
 * one the solver found.
 *
 * A bit run holding `x` or `z` is dropped rather than coerced, so a don't-care is an absent value
 * and never a witness. Total: any text yields a list, empty for text with no readable step.
 */
export function traceSteps(vcd: string): readonly TraceStep[] {
  const names = new Map<string, string>();
  const carried = new Map<string, bigint>();
  const steps: TraceStep[] = [];
  let depth = 0;
  let current: number | null = null;
  const closeStep = (): void => {
    if (current !== null) {
      steps.push({ step: current, values: new Map(carried) });
    }
  };
  for (const raw of vcd.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('$scope')) {
      depth += 1;
      continue;
    }
    if (line.startsWith('$upscope')) {
      depth -= 1;
      continue;
    }
    if (line.startsWith('#')) {
      closeStep();
      current = Number(line.slice(1));
      continue;
    }
    const declaration = VCD_VAR_RE.exec(line);
    if (declaration !== null) {
      const [, id, name] = declaration;
      if (depth === 1 && id !== undefined && name !== undefined && !NON_DESIGN_SIGNALS.has(name)) {
        names.set(id, name);
      }
      continue;
    }
    if (current === null || line.startsWith('$') || line.length === 0) {
      continue;
    }
    const change = VCD_VECTOR_RE.exec(line) ?? VCD_SCALAR_RE.exec(line);
    const [, bits, id] = change ?? [];
    const name = id === undefined ? undefined : names.get(id);
    if (name === undefined || bits === undefined || /[xzXZ]/.test(bits)) {
      continue;
    }
    // Base-2 through `BigInt`, so a 65-bit result is exact rather than rounded.
    carried.set(name, BigInt(`0b${bits}`));
  }
  closeStep();
  return steps;
}

/**
 * The trace reduced to ONE CLOCK PHASE, which is one entry per clock cycle.
 *
 * MEASURED: smtbmc emits a step per HALF cycle, so the design's own `clk` alternates 1, 0, 1, 0
 * down the trace and consecutive step pairs are the same logical cycle. A replay driving one
 * rising edge between consecutive STEPS therefore advanced the design twice as fast as the trace,
 * which is why the positive control could not reproduce a counterexample it was known to reach.
 *
 * The retained phase is the one where the clock is HIGH, because that is the state a
 * posedge-triggered design has just sampled into. On `adder_pipe_64bit` the reduction yields
 * eight cycles with the enable at cycle 1 and the result at cycle 5, a four-cycle pipeline
 * latency that agrees with the `$past(.., 4)` the fixture's own sum property uses.
 *
 * A trace that does not carry the clock is returned unchanged: there is no phase to select, and
 * dropping steps on a guess would replay a different stimulus.
 */
export function samplingPhaseSteps(
  steps: readonly TraceStep[],
  clockName: string | null,
): readonly TraceStep[] {
  if (clockName === null || !steps.some((entry) => entry.values.has(clockName))) {
    return steps;
  }
  const sampled = steps.filter((entry) => entry.values.get(clockName) === 1n);
  // Never return nothing: a trace whose clock is low throughout carries no sampling phase, and
  // an empty replay would read as a vacuous agreement rather than as an abstention.
  return sampled.length > 0 ? sampled : steps;
}

/** The design's own input ports, which are what a replay has to drive. */
function drivenInputs(designInterface: ModuleInterface): readonly string[] {
  const { clockName, resetName } = designInterface.clocking;
  const clocking = [clockName, resetName].filter((name): name is string => name !== null);
  return [
    ...designInterface.ports.filter((port) => port.direction === 'input').map((port) => port.name),
    ...clocking,
  ];
}

/** The design's own output ports, which are what a replay compares. */
function observedOutputs(designInterface: ModuleInterface): readonly string[] {
  return designInterface.ports
    .filter((port) => port.direction === 'output')
    .map((port) => port.name);
}

/** The check name the replay testbench emits; one check, one question. */
export const REPLAY_CHECK_NAME = 'counterexample_realizable';

/** One Verilog literal of a given width, which is how every driven value is spelled. */
function literal(width: number, value: bigint): string {
  return `${String(width)}'d${value.toString()}`;
}

/**
 * The replay testbench: drive the counterexample's whole TRACE, compare the outputs it carries.
 *
 * THE QUESTION IT ASKS IS NARROW ON PURPOSE. It does not re-evaluate the property, which would
 * need a second renderer and put this file in the business of translating properties. It asks
 * whether the unmodified design, driven with the counterexample's own input sequence, produces
 * the counterexample's own output sequence. A design that does reproduces the path the solver
 * found, so the refutation stands on its merits; a design that cannot was never on that path,
 * which points at the contract the oracle derived rather than at the property.
 *
 * THE CLOCK IS GENERATED, NEVER DRIVEN FROM THE TRACE. The trace's clock is the BMC's own step
 * encoding, so replaying it as data would drive a net the design also derives its timing from.
 * One rising edge per step, written out straight-line rather than from an `always` block, so
 * there is no race between the stimulus and the edge and the sequence is exactly reproducible.
 *
 * Each step settles with `#1` before its outputs are read, which is after the design's
 * non-blocking updates for that step have landed.
 */
export function replaySequenceTestbench(
  candidate: CandidateFalseRefutation,
  steps: readonly TraceStep[],
): string {
  const { moduleName, clocking } = candidate.designInterface;
  const clockName = clocking.clockName;
  const driven = drivenInputs(candidate.designInterface).filter((name) => name !== clockName);
  const outputs = observedOutputs(candidate.designInterface);
  const widthOf = (name: string): number =>
    candidate.designInterface.ports.find((port) => port.name === name)?.width ?? 1;
  const connected = [...driven, ...outputs, ...(clockName === null ? [] : [clockName])];
  const declare = (keyword: string, name: string): string => {
    const width = widthOf(name);
    const range = width > 1 ? `[${String(width - 1)}:0] ` : '';
    return `  ${keyword} ${range}${name};`;
  };

  const body: string[] = [];
  steps.forEach((entry, index) => {
    body.push(`    // step ${String(entry.step)}`);
    for (const name of driven) {
      const value = entry.values.get(name);
      if (value !== undefined) {
        body.push(`    ${name} = ${literal(widthOf(name), value)};`);
      }
    }
    body.push('    #1;');
    for (const name of outputs) {
      const value = entry.values.get(name);
      if (value === undefined) {
        continue;
      }
      // Only what the trace carries is compared: an output it never mentioned is not a
      // disagreement, so asserting a default for it would invent a finding.
      body.push(
        `    if (${name} !== ${literal(widthOf(name), value)}) mismatches = mismatches + 1;`,
      );
    }
    if (clockName !== null && index < steps.length - 1) {
      body.push(`    ${clockName} = 1'b1; #1; ${clockName} = 1'b0; #1;`);
    }
  });

  return [
    '`timescale 1ns/1ps',
    'module counterexample_replay_tb;',
    ...driven.map((name) => declare('reg', name)),
    ...(clockName === null ? [] : [`  reg ${clockName};`]),
    ...outputs.map((name) => declare('wire', name)),
    '  integer mismatches;',
    '',
    `  ${moduleName} dut (`,
    connected.map((name) => `    .${name}(${name})`).join(',\n'),
    '  );',
    '',
    '  initial begin',
    '    $dumpfile("dump.vcd");',
    '    $dumpvars(0, counterexample_replay_tb);',
    '    mismatches = 0;',
    ...(clockName === null ? [] : [`    ${clockName} = 1'b0;`]),
    ...body,
    '    if (mismatches == 0)',
    `      $display("CHECK ${REPLAY_CHECK_NAME} PASS");`,
    '    else',
    `      $display("CHECK ${REPLAY_CHECK_NAME} FAIL");`,
    '    $finish;',
    '  end',
    'endmodule',
    '',
  ].join('\n');
}

/** Generous caps for one short replay under a real local iverilog + vvp. */
const REPLAY_LIMITS: ResourceLimits = {
  cpu: 1,
  memMb: 512,
  procs: 128,
  diskMb: 128,
  wallMs: 30_000,
};

/**
 * Adjudicate one candidate against an independent referee.
 *
 * `probe-unavailable` is NOT produced here, and that is deliberate: this function has a referee
 * by its signature, so a host with no referee is the caller's fact to report, through the
 * exported `unadjudicated` constructor. Tasks 4.5 and 4.25 rely on exactly that.
 */
export async function adjudicate(
  candidate: CandidateFalseRefutation,
  referee: SimulatorAdapter,
): Promise<Adjudication> {
  const steps = samplingPhaseSteps(
    traceSteps(candidate.counterexample),
    candidate.designInterface.clocking.clockName,
  );
  if (steps.length === 0) {
    // Nothing resolved in the design's own scope, so there is no stimulus to drive.
    return unadjudicated('name-unresolvable-in-scope');
  }
  if (steps.length > 1 && candidate.designInterface.clocking.clockName === null) {
    // A multi-step path over a design with no clock cannot be advanced step by step, and
    // collapsing it to its first state would answer a different question.
    return unadjudicated('sequence-replay-unsupported');
  }
  // THE START STATE MUST BE REACHABLE BY STIMULUS, or no replay outcome means anything. A
  // design whose reset is not asserted at step 0 began from register values the solver picked
  // and a testbench cannot impose, so a mismatch would say nothing about the derivation.
  // Only a STATEFUL design has registers a solver could have initialised freely. A design with
  // no clock holds no state, so its step-0 behaviour is a function of its inputs alone and the
  // replay reaches it by driving them.
  const { clockName, resetName, resetActiveLow } = candidate.designInterface.clocking;
  if (clockName !== null) {
    const resetAtStart = resetName === null ? undefined : steps.at(0)?.values.get(resetName);
    const resetAsserted = resetActiveLow ? resetAtStart === 0n : resetAtStart === 1n;
    if (!resetAsserted) {
      return unadjudicated('trace-start-state-unreachable');
    }
  }
  // AT LEAST ONE COMPARABLE OUTPUT, not every port. The wrapper declares only the signals the
  // property references, so a port the counterexample never mentions constrains nothing, and
  // requiring every one of them abstained on a replayable trace (measured on `multi_16bit`,
  // whose `done` is absent because task 4.21 rewrote the antecedent off it).
  const outputs = observedOutputs(candidate.designInterface);
  const comparable = outputs.filter((name) => steps.some((entry) => entry.values.has(name)));
  if (comparable.length === 0) {
    // Nothing to compare means nothing the replay could disagree with, so there is no finding
    // to be had rather than a negative one.
    return unadjudicated('name-unresolvable-in-scope');
  }
  const testbench: SourceFile = {
    path: 'counterexample_replay_tb.v',
    contents: replaySequenceTestbench(candidate, steps),
  };
  let observed;
  try {
    observed = await referee.simulate([candidate.design], testbench, REPLAY_LIMITS);
  } catch {
    // Dropped rather than surfaced: a referee rejection can quote the design source.
    return unadjudicated('referee-run-errored');
  }
  const evidence: SimulationEvidence = {
    verdict: observed.verdict,
    failedChecks: observed.checks.filter((check) => !check.passed).map((check) => check.name),
    exitCode: observed.exitCode,
    vcd: observed.vcd,
  };
  if (observed.verdict === 'error') {
    return unadjudicated('referee-run-errored');
  }
  // TWO-DIRECTIONAL AGAIN, because the replay now passes its Replay_Positive_Control:
  // `adder-pipe-64bit-carry-never-set` is false by construction and the replay reproduces its
  // counterexample, so a mismatch is evidence about the design rather than about the harness.
  // Three defects had to be fixed before this was true - a single-step reader against a 39-step
  // path, `number` rounding a 65-bit value, and smtbmc's half-cycle stepping - and the control
  // is what caught every one. The gate that keeps this honest is
  // `formal-false-refutation.integration.test.ts`; if it reddens, this line goes back to
  // abstaining. See criterion 4.14.
  return observed.verdict === 'pass' ? realizable(evidence) : notRealizable(evidence);
}

/**
 * One contradiction, as it is recorded BEFORE any Fixture_Property changes (Req 11.4 to 11.6).
 *
 * `authorExpectedVerdict` is carried separately from the candidate on purpose: it is the verdict
 * the author stated, and no adjudication rewrites it. A record whose fixture has since moved is
 * still readable as what was observed at the time, rather than as having been reconciled by the
 * change that followed it.
 */
export interface ContradictionRecord {
  readonly candidate: CandidateFalseRefutation;
  readonly adjudication: Adjudication;
  /** The verdict as its AUTHOR stated it, never rewritten. */
  readonly authorExpectedVerdict: FormalVerdict;
  /**
   * Whether the Fixture_Property may now move.
   *
   * `false` while the contradiction is unadjudicated, because nothing has established which
   * side was wrong, and moving the fixture then would bury the contradiction rather than
   * resolve it.
   */
  readonly fixtureMayMove: boolean;
}

/** Record one contradiction beside its adjudication, with the author's verdict preserved. */
export function recordContradiction(
  candidate: CandidateFalseRefutation,
  adjudication: Adjudication,
): ContradictionRecord {
  return {
    candidate,
    adjudication,
    authorExpectedVerdict: candidate.expectedVerdict,
    fixtureMayMove: adjudication.kind !== 'unadjudicated',
  };
}
