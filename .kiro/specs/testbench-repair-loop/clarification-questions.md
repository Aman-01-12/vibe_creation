# Clarification question - what may the testbench repair loop SEE?

One blocking design decision, before any code. It determines what `instrument-valid` means
afterwards, and therefore what the pass@k denominator and the `Verified` label rest on.

Please answer in `clarification-answers.md` in this folder.

---

## Context: the measured case for the repair loop

`.eval-runs/stage1-screen-v3` (495 samples, 11 models x 15 designs x n=3), under
`TESTBENCH_PROMPT_VERSION` 3:

| defect                            | count |
| --------------------------------- | ----- |
| TESTBENCH_FAILED_REFERENCE        | 226   |
| TESTBENCH_REFERENCE_UNBUILDABLE   |  64   |
| TESTBENCH_SURVIVED_MUTANTS        |  16   |
| CONTROL_RUN_ERRORED               |  16   |
| instrument-valid (both controls)  |  42   |

Three successive prompt-wording attempts at the FAILED_REFERENCE class have now failed
(recorded in `gotcha-three-testbench-defect-classes-...` and
`gotcha-stage1-screen-v2-dialect-and-concurrency-...`). The most recent A/B showed the
dialect rule working (-44% unbuildable) while the concurrency rule did not move its target
(+27%), with the population shifting downstream nearly 1:1. Hence a structural fix:
let the testbench be REPAIRED once from its own measured failure, rather than trying to
predict the model's next wrong assumption in prose.

## The tension

The failure signal we would feed back is our testbench's failure against RTLLM's
KNOWN-GOOD REFERENCE design - which is the positive control.

Property 4 (anti-circular) forbids deriving the testbench from the CANDIDATE RTL, and that
is NOT at risk here: the reference is a third party's implementation, not the model's, so a
candidate's passing verdict stays meaningful.

What IS at risk is the positive control as a MEASURE. "Our testbench passes the reference"
is not independent evidence of instrument validity if we repaired the testbench until it
passed the reference. The gate would become partly a training target.

Load-bearing detail: of 58 samples that passed the positive control in v3, only 16 failed
the negative one. So the negative control (mutation coverage) does independent work on
about 28% of positive-passing samples - it is real, but it is not currently strong enough
to carry the validity gate alone.

## Options

| | option | what the repair sees | consequence |
| --- | --- | --- | --- |
| A | **Compiler diagnostics only.** | The build error from our own testbench file (`instrument_control_tb.v:50: syntax error`). | ZERO circularity: a syntax error in our own file reveals nothing about any implementation. Both controls stay fully independent. But it targets only the 64 UNBUILDABLE, and the dialect rule already cut that class from 115 - diminishing returns. |
| B | **Full functional failure.** | The `CHECK <name> FAIL: expected 0, got 1` line, verbatim, including the reference's observed values. | Strongest signal, targets all 226. But it teaches the testbench a correct implementation's behaviour, and the positive control becomes a repair target - so instrument validity would have to rest on the NEGATIVE control alone, which today does independent work on only 28% of positive-passing samples. That is a deliberate weakening of the gate the whole harness rests on. |
| C | **Classified hint, values withheld.** | "Check `<name>` rejected a known-good design. Your expectation likely assumes a latency, an initial state, or an input window the Spec does not state." Names the check and the defect class; withholds the observed values. | Preserves independence - no implementation behaviour leaks, so both controls keep their current meaning. Targets the dominant class. Weaker signal than B, and unproven; the defect-class inference is a heuristic we would be writing. |
| D | Hold out a second reference: repair against one, gate on the other. | - | Not available. RTLLM ships one reference per problem. |

## Recommended: C, with A folded in

Compiler diagnostics (A) are safe to pass VERBATIM and cost nothing, so they should be in
regardless. Functional failures get C's classified-hint treatment, so the positive control
keeps meaning what it means today.

The reason not to start at B: it silently re-bases the definition of `instrument-valid`
midway through a model bake-off whose earlier numbers were measured under the current
definition. If C underperforms, B stays available - but it should then be an explicit,
recorded decision to weaken the gate, with the negative control strengthened first, rather
than a side effect of wanting the bigger number.

## Regardless of the choice

These hold in every option and are not up for decision:

- The repair runs AT MOST ONCE per sample (bounded, like every other loop here).
- It consumes the same Session_Budget; no widened caps.
- Every failure path degrades to today's behaviour (refuse), never to a pass.
- A repaired testbench is re-checked by the SAME controls before it is trusted.
- The candidate RTL is never in scope: `buildTestbenchModelInput` keeps having no channel
  for it, and Property 4 keeps asserting that.
- It changes the experiment, so `TESTBENCH_PROMPT_VERSION` (or a new policy constant) moves
  and the config hashes re-pin - samples either side must not pool.
- A sample whose testbench was repaired is RECORDED as such, so no number can be cited
  without knowing the instrument was repaired rather than written correctly first time.


---

# Requirements-phase clarification questions (testbench-repair-loop)

Surfaced while drafting `requirements.md`, after Option C+A was already decided in
`clarification-answers.md`. These are NEW, requirements-level open questions the design
phase (or a founder ruling now) must resolve - they are not re-litigating Option C.

## Q1: Where does the positive-control repair call live, and who drives the repair-then-recheck sequence?

**Maps to:** Requirement group on "where in the loop this is wired" (spec prompt item 6).

**The tension.** There are structurally TWO repair trigger points, and only one of them is a
clean fit for the pattern already used by `TestbenchPrecheck`/`InstrumentAdmission`:

- **The precheck path** (`VerificationLoop#admitInstrument`, before iteration 1) can repair
  entirely inside `app/agent`: `TestbenchPrecheck` is model-free and RTL-free, and the
  `TestbenchAgent` that would perform the repair already lives in `app/agent`. No import
  boundary is crossed.
- **The positive-control path** is different in kind. `RtllmInstrumentControl.check` lives in
  `app/eval` (it needs the RTLLM reference design), runs strictly AFTER `VerificationLoop`
  has already returned (`EvalHarness#runSample`: `#drive` completes, `budget.consumed()` is
  read, and only then is `#controlInstrument` - or `admission.recorded()` - consulted). By that
  point:
  - the `SessionBudgetHandle` for the sample has already been read for the record (`consumed`,
    `stopReason`) - repairing "under the same Session_Budget" (a non-negotiable from
    `clarification-answers.md`) requires charging the SAME handle before it is snapshotted,
    which means the repair-then-recheck sequence must run BEFORE that snapshot, not after;
  - `app/agent` cannot import `app/eval` (Req 9.6/9.7 of `instrument-precheck-and-attribution`),
    so the repair call (which needs the `TestbenchAgent`, an `app/agent` role) cannot be issued
    FROM inside `RtllmInstrumentControl` or `MemoizingInstrumentAdmission` without inverting
    that boundary;
  - `MemoizingInstrumentAdmission.admit` today runs the control the loop already consults
    pre-iteration-1 - it is itself inside the `#admitInstrument` precheck→admission sequence,
    which IS still inside `app/agent`'s call graph at the point it executes (the port is
    declared in `app/agent`, implemented in `app/eval`). So the admission path may already be
    early enough to repair-and-recheck through the SAME port, without a second call site at
    all - but that depends on whether `admit`'s single call already reflects a repair, or
    whether repair needs to happen at a THIRD point (inside `EvalHarness`, symmetric to but
    separate from `admission`).

**Two reasonable shapes, and the codebase does not yet decide between them:**

- **Shape 1 - repair rides inside the existing `InstrumentAdmission` port.** `admit()` (or a
  sibling method) becomes responsible for driving repair-then-recheck itself when it detects a
  `TESTBENCH_FAILED_REFERENCE`-shaped positive-control failure, using a `TestbenchAgent`
  reference `MemoizingInstrumentAdmission` would need to be constructed with. This keeps ONE
  call site (`#admitInstrument`) doing double duty, but means the eval-layer adapter has to
  hold and drive an agent-layer role directly, which is a new responsibility for a class
  whose current contract (`design.md` component 8) is "memoize a decision", not "mutate and
  re-derive the instrument."
- **Shape 2 - a new, distinct step `EvalHarness#runSample` takes, symmetric to but separate
  from `#buildAdmission`/`#controlInstrument`.** A `TestbenchRepair` (or similarly named) port,
  declared in `app/agent` next to `InstrumentAdmission`, implemented in `app/eval`, consulted
  by the harness (not the loop) at the point where a `TESTBENCH_FAILED_REFERENCE`-shaped
  admission/control result would otherwise be finalized - BEFORE `budget.consumed()` is
  snapshotted. This adds a second port and a second harness-level branch, but keeps
  `MemoizingInstrumentAdmission`'s contract unchanged and keeps the repair decision visibly
  separate from the admission decision it follows.

**What the precheck-path repair implies for symmetry.** Whichever shape is chosen for the
positive-control path, the precheck-path repair (fully inside `app/agent`, no boundary issue)
should almost certainly use the SAME repair primitive (likely a new `TestbenchAgent` method
mirroring `reviseFromErrors`'s shape) so there is one repair call, invoked from two trigger
points, rather than two independently-evolving repair implementations.

**Recommended:** Shape 2 (a new symmetric port), for the same reason `InstrumentAdmission`
itself was made a port rather than folding admission logic into `RtllmInstrumentControl`
directly (design.md, instrument-precheck-and-attribution: "the role-local-port shape the
repository already uses to keep the orchestrator free of its callers"). It also keeps
`MemoizingInstrumentAdmission`'s existing, already-tested contract untouched, and it makes the
"repair happens before the budget snapshot" ordering an explicit, reviewable step in
`EvalHarness#runSample` rather than a side effect buried inside an `admit()` call. One-line
rationale: symmetry with the existing `InstrumentAdmission` port is worth a second small port
more than it is worth overloading the first one's contract.

**This is a design-phase decision if the founder does not rule on it now**, per the process
requirement in the workflow prompt: it must not be silently picked in `requirements.md`.

## Q2: Does the precheck-path repair reuse `INSTRUMENT_POLICY_VERSION`, or does the spec mint a new "repair policy version"?

**Maps to:** Requirement group on "experiment identity" (spec prompt item 7).

**The tension.** `INSTRUMENT_POLICY_VERSION` (`app/agent/orchestrator/instrument-policy-version.ts`)
is documented as identifying "the Verification_Loop's instrument-admission behaviour" - and
adding a repair attempt INSIDE `#admitInstrument`, before a refusal, is arguably a change to
exactly that behaviour, which would make bumping it (1 -> 2) the correct, minimal move with no
new constant needed. Against that: `INSTRUMENT_POLICY_VERSION`'s own history comment frames it
narrowly as "whether the loop runs a Testbench_Precheck and consults an Instrument_Admission
port before spending a repair iteration" - admission/refusal timing, not what happens to the
testbench's CONTENT before that decision is reached. A repair changes what testbench a sample's
validity is even judged against, which reads like a different axis from "when do we check", the
same way `TESTBENCH_PROMPT_VERSION` and `INSTRUMENT_POLICY_VERSION` were kept as two separate
constants rather than one, specifically so two independent concerns could move independently
without a false pin failure on the unrelated one.

**Recommended:** mint a new constant (e.g. `TESTBENCH_REPAIR_POLICY_VERSION`), folded into
`config-identity.ts` under its own reserved key, for the same stated reason
`INSTRUMENT_POLICY_VERSION` itself was kept distinct from `TESTBENCH_PROMPT_VERSION`: this is a
third, independent axis of "what the instrument-admission behaviour is", and conflating it with
`INSTRUMENT_POLICY_VERSION` would make a future admission-timing-only change and a future
repair-only change collide on one pin. But this is close enough to a 50/50 call (reusing
`INSTRUMENT_POLICY_VERSION` is not unreasonable, and is a smaller diff) that it should not be
silently decided in requirements.md - the spec prompt already flags this as founder-visible if
genuinely ambiguous, and it is.

## Q3: What does the classified-hint vocabulary actually enumerate, and who owns keeping it in sync with the prompt rules it must reuse?

**Maps to:** Requirement group on "what the repair prompt may/may not contain" (spec prompt item 2).

**The tension.** `clarification-answers.md` names the hint's shape by example ("this check
likely assumes a latency, an initial state, or an input window the Spec does not state") and
explicitly points at reusing `prompt.ts`'s `describeStateAnchoring`/`describeTiming`/
`describeInputWindow`/`CONCURRENCY_RULE`. But those four functions are CONDITIONAL on the
declared interface (each renders different text depending on whether a reset/qualifier port
exists) and are worded as INSTRUCTIONS ("do NOT re-anchor..."), not as classification labels.
Turning them into a closed hint vocabulary means deciding: (a) is the vocabulary a fixed enum
independent of the interface (e.g. `state-anchoring | concurrency | timing | input-window |
stimulus-adequacy`, one member per existing rule), with the interface-specific detail dropped
from the hint entirely; or (b) does the hint carry the SAME conditional text the rule functions
already produce (reusing them as literal string builders), which risks a hint that is
detailed enough to nudge the model toward the observed value indirectly (e.g. naming the exact
qualifier port by name might be fine, since it is Spec-derived and not reference-derived, but
this needs to be checked clause by clause against the "never let the reviser reconstruct the
reference's behaviour" bound in the spec prompt).

**Recommended:** (a), a small fixed closed enum of defect classes, one per existing prompt rule
family (plus a residual `other` member for a `CONTROL_RUN_ERRORED`-shaped failure that a
compiler-diagnostic hint cannot cover either) - because a closed enum is independently
auditable against the anti-circularity bound (Property 4's extension), whereas reusing the
conditional prose builders as-is would require a per-clause manual audit every time `prompt.ts`
changes, and nothing would force that audit to happen. This is a design-phase decision (the
exact enum members and their wording are a design artifact, not a requirement), but the
CHOICE of (a) over (b) is requirements-level because it determines whether "never receives a
diff against the reference" (clarification-answers.md's own bound) is checked by construction
or by convention.
