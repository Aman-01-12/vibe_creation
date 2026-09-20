# Clarification answers - design-phase open decisions (DQ1-DQ2)

Delegated: "go with your recommendation." Reasoning is the agent's own, made on that
delegation, recorded per the same workflow rule every other decision in this folder follows.

## DQ1: which `ModelTask` the repair call routes under

Decision: **Option A.** Reuse `'testbench'` for both first-draft generation and repair. No
new `ModelTask` member is minted.

Why: nothing in `requirements.md` asks for testbench repair to be independently
bake-off-able, and Requirement 8 asks only for one shared repair primitive - which Option A
gives without deciding a bake-off question nobody raised. Minting `'testbench-repair'` would
force every `SweepConfig` arm fixture and every `RoutingPolicy` construction site to gain a
required key the day this ships, on pure speculation that a future measurement will want to
assign it a different model. If that measurement ever happens, minting the task then is a
small, isolated change - cheaper than carrying the unused key now.

## DQ2: how `ruleFamilyFor` maps a failed check to a `DefectClass`

Decision: **the heuristic table, as drafted** in design.md - a fixed mapping over
Spec-interface structure (`declaresVectorDataPort`, `timingQualifierNames`,
`inputQualifierNames`), reusing exactly the interface facts `prompt.ts`'s first-draft rule
builders already branch on, with `'unclassified'` as the honest fallback.

Why: always-`'unclassified'` would make three of the five vocabulary members
(`state-anchoring`, `timing`, `input-window`) unreachable in practice for most Specs, which
defeats the vocabulary's own stated purpose - an auditable, populated list is only useful if
it is actually populated some of the time. The per-criterion-authored alternative is more
principled long-term but widens `RequiredCheck`'s surface with information the interface
already states, and requirements.md never asked for it.

The design's own `ponytail:` comment marking this as a deliberate, measured-later ceiling is
the right treatment - proceed as drafted, revisit once real repair volume gives evidence about
which family actually correlates with which check shape.
