# Clarification answer - what may the testbench repair loop SEE?

Decision: **Option C, with Option A folded in.**

Delegated: "go with your recommendation." Reasoning is the agent's own, made on that
delegation - recorded here per the workflow rule that every decision states who decided
and why.

## What this means concretely

The repair loop, when a sample's testbench fails a control, sees:

- **Compiler diagnostics, verbatim (Option A).** A build failure against the reference or
  its own stub reveals nothing about any implementation's behaviour, so there is no
  circularity cost to passing it through unmodified.
- **A classified hint for a functional failure, values withheld (Option C).** Names the
  failing check and a defect CLASS (e.g. "this check likely assumes a latency, an initial
  state, or an input window the Spec does not state"), but never the reference's observed
  value, never the reference's structure, and never a diff against it.

## Why

The signal we would feed back for a functional failure is the testbench's failure against
RTLLM's known-good reference - which IS the positive control. "Our testbench passes the
reference" stops being independent evidence of instrument validity the moment we repair the
testbench BY that exact signal, because the number then partly reflects what we trained it
to pass rather than what it independently caught.

Measured reason to not weaken that gate casually: of 58 samples that passed the positive
control in `stage1-screen-v3`, only 16 failed the negative control (mutation coverage). The
negative control does independent work on ~28% of positive-passing samples today - real,
but not yet strong enough to carry instrument validity alone. Moving to Option B now would
mean the validity gate rests almost entirely on a control that is not yet proven sufficient
on its own.

Option B (full functional failure, verbatim) is not rejected outright - it is the strongest
signal and remains available. But adopting it should be an explicit, separately-decided
move to WEAKEN the positive control's independence, made after strengthening the negative
control, not an incidental side effect of wanting a bigger instrument-valid number out of
this feature.

## What proceeds now

A full spec (requirements -> design -> tasks) for the testbench repair loop, built on
Option C, through the standard spec workflow - not a single ad hoc sub-agent dispatch, since
this changes a terminal-outcome shape, a controls invariant, and the experiment identity.

The five invariants from the original clarification question carry forward as
non-negotiable requirements regardless of anything decided in the design phase:

- runs at most once per sample;
- consumes the same Session_Budget, no widened caps;
- every failure path degrades to today's behaviour (refuse), never to a pass;
- a repaired testbench is re-checked by the SAME two controls before being trusted;
- candidate RTL is never in scope - `buildTestbenchModelInput` keeps no channel for it,
  and Property 4 keeps asserting that;
- a repaired sample is recorded as repaired, so no cited number can hide that its
  instrument was fixed rather than sound on the first draft;
- this is a different experiment: the identity carrier and the config hashes move, and
  samples on either side must never pool.


---

# Clarification answers - requirements-phase questions (Q1-Q3)

Delegated: "go with your recommendation" for all three (Q2/Q3 immediately; Q1 after being
asked to rule specifically and delegating in turn). Reasoning is the agent's own, made on
that delegation, recorded here per the same workflow rule the original Option C answer
followed.

## Q1: a new port, symmetric to `InstrumentAdmission`

Decision: **Shape 2.** A new port (name to be settled in design, e.g. `TestbenchRepair`),
declared in `app/agent/orchestrator`, implemented in `app/eval`, consulted by
`EvalHarness#runSample` at the point a positive-control-caused refusal would otherwise be
finalized - before `budget.consumed()` is snapshotted for the record.

Why: symmetry with `InstrumentAdmission` is worth a second small port more than it is worth
overloading the first one's contract. `MemoizingInstrumentAdmission`'s documented job is
"memoize a decision"; making it also "mutate the testbench and re-derive the decision" is a
second responsibility for a class whose existing tests and contract assume it does neither.
A separate port keeps the repair decision visibly distinct from the admission decision it
follows, mirrors how `InstrumentAdmission` itself was kept a port rather than folded into
`RtllmInstrumentControl` (design.md, instrument-precheck-and-attribution), and makes the
budget-before-snapshot ordering an explicit step in `EvalHarness#runSample` rather than a
side effect hidden inside `admit()`.

The precheck-path repair (fully inside `app/agent`, no import-boundary issue) uses the same
underlying repair primitive on the `TestbenchAgent` (a new method mirroring
`reviseFromErrors`'s shape) as the positive-control path's new port calls into - one repair
call, two trigger points, not two independently-evolving implementations.

## Q2: a new `TESTBENCH_REPAIR_POLICY_VERSION` constant

Decision: mint a new build constant, folded into `config-identity.ts` under its own
reserved key, distinct from `INSTRUMENT_POLICY_VERSION`.

Why: `INSTRUMENT_POLICY_VERSION`'s own history frames it narrowly as admission/refusal
*timing* ("whether the loop runs a Testbench_Precheck and consults an Instrument_Admission
port before spending a repair iteration"). A repair changes what testbench a sample's
validity is judged against - a different axis from when the check runs - the same reasoning
that already kept `TESTBENCH_PROMPT_VERSION` and `INSTRUMENT_POLICY_VERSION` as two separate
constants rather than one, so a future change on either axis alone re-pins only its own
constant.

## Q3: a fixed closed enum of defect classes for the classified hint

Decision: the classified hint's vocabulary is a small, closed, non-conditional enum (one
member per existing prompt rule family - state-anchoring, concurrency, timing, input-window,
stimulus-adequacy - plus a residual member for a failure the compiler-diagnostic path and
this vocabulary both cannot explain), never the conditional, interface-specific prose the
rule-describing functions in `prompt.ts` already build.

Why: a closed enum is independently auditable against the anti-circularity bound (Property
4's extension to the repair path) by inspection of a fixed, finite list; reusing the
conditional prose builders as literal hint text would require re-auditing every clause,
by hand, every time `prompt.ts`'s rule text changes, with nothing in the type system forcing
that re-audit to happen. The exact member set and wording are a design-phase artifact; the
requirements-level commitment is only that the vocabulary is closed and enumerable, not
constructed from live prose.
