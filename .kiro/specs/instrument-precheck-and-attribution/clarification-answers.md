# Clarification answers - instrument-precheck-and-attribution

Founder decision: **go with the recommended option on all three.**

---

## Q1 - Is the instrument gate unconditional, or a policy the config can select?

**Answer: A - unconditional, as written.**

Accepted with its stated cost: `tbslice-v1`'s golden pass@1 of 0.700 has no comparable successor,
because a refused sample's candidate is judged as a first candidate with no repair iteration. That
cost is accepted rather than worked around, on the reasoning already in the recommendation - repair
driven by a testbench that rejects the known-good reference design is noise, not capability, and 6 of
the 11 instrument-invalid candidates were already correct before any repair ran. A baseline measured
under a falsified instrument is not a baseline worth defending.

One certified configuration, identical in eval and prod, per `ECE-CONTEXT-ENGINEERING` section 7.

## Q2 - Does an uncompilable testbench end a student's session, or does the loop regenerate once?

**Answer: C - refuse now, spec regeneration separately.**

Regeneration is new capability and wants its own before/after number. The precheck this spec adds is
the instrument that would justify it: we currently hold one 2-of-12 data point, on one arm, at n=1.
Ship the refusal, let the precheck measure how often a generated testbench actually fails to build,
then decide regeneration against a real frequency.

The follow-on must be named in the spec so a later reader sees a deferred decision with a trigger,
not an oversight.

## Q3 - Does the campaign-readiness slice re-run gate the merge?

**Answer: C - gate on the offline proxy; the live slice run is a tracked follow-up.**

Requirement 8.8's real risk is structural - a refused outcome surrendering no candidate - and that is
fully checkable offline by Property 9 and checkpoint 8. Holding a deterministic change behind a hosted
provider that has already cost us 31 of 46 cells to one rate-limit burst buys less than it costs.

Task 12.1 stays, and must be explicitly marked non-blocking for merge.
