# Design-phase open decisions - testbench-repair-loop

Two decisions came up while writing `design.md` that are not settled by
`requirements.md` or `clarification-answers.md` (which fixed Option C+A and Q1-Q3,
and are not being reopened here). Both are already reflected in `design.md` with a
specific choice made and reasoned inline, so the design is not blocked on these
answers - but per the founder's spec-clarification workflow, they are surfaced here
rather than left as silent calls the founder never saw.

---

## DQ1: which `ModelTask` the repair call routes under

**Maps to:** Component 5 (`TestbenchAgent#repairTestbench`), Requirement 8.1-8.2.

**The tension:** The router's `ModelTask` union already separates RTL generation
(`'generation'`) from RTL repair (`'repair'`) as two distinct routable tasks, so a
per-role bake-off can assign the repair-call model differently from the
first-draft-call model for that capability. Testbench generation has its own single
task, `'testbench'`, used for `generateTestbench`. The new `repairTestbench` method
needs a `ModelTask` to route under, and there are two shapes available: reuse
`'testbench'` for both first-draft and repair, or mint a new `'testbench-repair'`
member paralleling the RTL side's `'generation'` / `'repair'` split.

**Why it matters beyond a naming choice:** `MODEL_TASKS` drives `RoutingPolicy`,
`ManifestArm.roleModels`, `modelSignatureOf`, and every per-role cost/price table
(`armCostIsKnown`). Reusing `'testbench'` means one model id serves both first-draft
and repair testbench calls with no way to bake off a different model for the repair
capability specifically. Minting a new task member means every `RoutingPolicy`,
every `SweepConfig.arm.roleModels`, and every price table gains a required key the
day this ships - a wider, mechanical diff across config/test fixtures than the
design's stated blast radius otherwise implies.

**Options:**

- **A - reuse `'testbench'` (chosen in the current design draft).** Testbench
  repair is framed as the same measured capability axis as testbench generation
  (does this agent produce a testbench that measures something), not a separately
  bake-off-able one. No new `ModelTask` member, no new required `roleModels` key,
  smallest diff to `routing.ts`/`config.ts`/every existing arm fixture.
  Rationale for choosing this as the default: the RTL side's `'generation'` /
  `'repair'` split exists for a reason specific to THAT role's cost profile (the
  design doc's own comment on `REPAIR_TASK` does not state the reason, but the
  precedent is per-role, not automatic), and nothing in `requirements.md` asks for
  a testbench-repair bake-off; Requirement 8 asks only for one shared repair
  PRIMITIVE, which Option A gives without deciding the bake-off question.
- **B - mint `'testbench-repair'` as a new `ModelTask` member.** Parallels the RTL
  side exactly and leaves the door open to bake off a cheaper/faster model for
  repair specifically once repair volume is measured. Costs: every `SweepConfig`
  arm fixture and every `RoutingPolicy` construction site (test and production)
  gains a required key on the day this ships, whether or not anyone intends to
  assign it a different model than `'testbench'` gets.

**Recommendation:** A, as drafted. Nothing in the requirements or the founder's
prior rulings asks for testbench-repair to be independently bake-off-able, and nothing
about the mechanism (Requirement 8's "one repair primitive, two trigger points")
depends on which task name routes it. If a future measurement shows repair calls
benefit from a different model than first-draft testbench calls, minting the task
then is a small, isolated change - it does not need to be paid for now on
speculation.

---

## DQ2: how `ruleFamilyFor` maps a failed check to a `DefectClass`

**Maps to:** Component 3, Requirement 2.3 (the classified-hint's defect class).

**The tension:** Requirement 2.3 says the hint "SHALL carry only the failing
check's name and one Defect_Class drawn from a closed, stated vocabulary" but does
not say HOW the defect class is chosen for a given failing check - that choice was
explicitly left to design (per Q3's own text: "The exact member set and wording are
a design-phase artifact"). The current design draft proposes a **fixed heuristic
table over check shape and interface facts** (`declaresVectorDataPort`,
`timingQualifierNames`, `inputQualifierNames` - literally re-reading the same
interface facts `prompt.ts`'s first-draft rule builders already branch on) rather
than either of two alternatives:

- **Always `'unclassified'`.** The simplest, cheapest-to-audit option: every
  functional failure gets the residual member, and the model is told only "this
  check failed" with no family guess at all. Trivially satisfies Req 2.4-2.6 (there
  is nothing to get wrong), but gives the repair call strictly less signal than the
  five-family vocabulary was built to carry, weakening the whole premise that a
  second attempt informed by WHICH rule family failed beats a blind guess.
- **A per-criterion authored mapping**, where `RequiredCheck` (or `Spec` itself) is
  extended with an explicit, human-authored `likelyDefectClass` field set at
  spec-derivation time (in `coverage.ts`, alongside `criterionCheckName`) rather
  than inferred later from interface shape. More auditable per-criterion, but
  widens `RequiredCheck`'s surface and duplicates information the interface facts
  already carry.
- **The heuristic table (chosen in the current design draft).** Reuses exactly the
  interface facts `prompt.ts` already computes, so the mapping and the rules it is
  guessing about can never disagree about what the interface declares. Marked in
  the design with a `ponytail:` comment as a deliberate first guess with a named
  upgrade path (revisit once the vault has measured which family actually
  correlates with which check shape), per this workspace's lazy-dev convention for
  a corner cut on purpose.

**Recommendation:** the heuristic table, as drafted, specifically BECAUSE it is
already flagged as a measured-later ceiling rather than presented as settled truth.
Always-`'unclassified'` is defensible as a stricter reading of "we do not actually
know which rule the model violated," but it would make three of the five vocabulary
members (`state-anchoring`, `timing`, `input-window`) unreachable in practice for
most Specs, which seems to defeat the vocabulary's own stated purpose (Q3's
reasoning: "auditable against the anti-circularity bound... by inspection of a
fixed, finite list" presumes the list is actually populated some of the time). The
per-criterion-authored alternative is the more principled long-term answer but is
new surface on `RequiredCheck` that requirements.md never asked for and that
overlaps with information the interface already states.

---

Founder: please add your decisions (or "go with your recommendation" for either or
both) in a `clarification-answers-dq.md` in this same folder, following the existing
convention, and I will fold them into `design.md` before moving to tasks.
