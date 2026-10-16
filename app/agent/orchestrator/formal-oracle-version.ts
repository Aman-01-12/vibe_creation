// The identity of the Formal_Oracle's gate behaviour (Req 12.1, 12.7, 12.8; task 8.1).
//
// WHY THIS EXISTS
//   What the Formal_Oracle accepts as a proof is part of the experiment, not part of the
//   harness: change the gate, and a sample measured before the change answers a different
//   question than one measured after - the same reasoning `normalizer-version.ts` already
//   applies to the Dialect_Normalizer's transform and `instrument-policy-version.ts` to the
//   Verification_Loop's instrument-admission behaviour.
//
// WHY A FIFTH CONSTANT AND NOT A BUMP OF `TESTBENCH_PROMPT_VERSION`,
// `INSTRUMENT_POLICY_VERSION`, `TESTBENCH_REPAIR_POLICY_VERSION`, OR `NORMALIZER_VERSION`
//   None of the four existing identities changed when the Formal_Oracle arrived: not the
//   Testbench_Agent's first-draft prompt, not the instrument-admission policy, not the
//   testbench-repair loop's trigger surface, and not the set of mechanical rewrites applied
//   to a generated Testbench source. Bumping any of them would make that constant's own pin
//   assert something false. This is a separate build constant for a separate concern, so all
//   five identities can never be conflated and each is a one-line edit that cannot collide
//   with an unrelated one.
//
//   `app/eval/sweep/config-identity.ts` folds each sibling into the canonical experiment
//   fingerprint under its own reserved key (`__normalizerVersion` mirroring
//   `__testbenchRepairPolicyVersion`'s precedent), and this constant takes the same fold-in
//   under its own reserved key. That fold-in is task 12.1's, not this file's.
//
// WHAT THIS CONSTANT COVERS - SIX THINGS, NOT ONE
//   It must change whenever ANY of the following changes, because each of them changes what a
//   sample MEASURES rather than how it is reported, so two runs reporting the same
//   FORMAL_ORACLE_VERSION were taken under the same instrument:
//     1. The Lowering_Sequence - the pinned pass order `read_verilog -sv -formal`,
//        `prep -top <top> -flatten`, `memory_map -rom-only -keepdc`, `async2sync`, `dffunmap`,
//        `chformal -lower`, `write_smt2 -wires`. A pass added, removed, or MOVED is a change:
//        the passes are order-sensitive and a `proved` taken under a different order is a
//        different claim.
//     2. The five-condition rule - the assertion count, the presat, the cover, the base case,
//        and induction. Relaxing, adding, or reordering a condition changes what `proved` means.
//     3. The Property_Dialect - the closed set of forms a Formal_Property may be written in,
//        including the Past_Depth bound (derived from the first clocked rung and the
//        Clocked_Check_Delay) and the refusal of a combinational `$past` or `$stable`. Widening
//        it admits properties the previous gate rejected at parse time; narrowing it refuses
//        properties the previous gate expressed.
//     4. The Proof_Depth rule and its ladder - `COMBINATIONAL_DEPTH = 1` and
//        `CLOCKED_DEPTH_LADDER = [20, 40, 80]` in `app/tools/formal/depth-ladder.ts`, and the
//        rule deciding which of the two a property takes. A shallower rung can prove less; a
//        deeper one can prove more.
//     5. The solver the invocations name - bitwuzla, with z3 as the Solver_Cross_Check. A
//        verdict from a solver other than the one this version names would make the recorded
//        identity a lie, which is why the unshimmed-bitwuzla case reports
//        `toolchain-unavailable` rather than silently re-running under z3 (Req 11.15).
//     6. The default Property_Time_Budget - `DEFAULT_PROPERTY_TIME_BUDGET_MS`, 150s. The budget
//        is the difference between `proved` and `proof-timeout` on a slow design, so it decides
//        verdicts.
//
// THIS CONSTANT IDENTIFIES THE FORMAL_ORACLE ALONE
//   It must NEVER be bumped to carry a `TESTBENCH_PROMPT_VERSION` or `NORMALIZER_VERSION`
//   change (Req 12.8). `prompt-version.test.ts` pins a digest of the ASSEMBLED prompt against
//   the first of those, so a prompt change recorded here would leave that pin asserting
//   something false while this constant claimed a gate moved that did not - the same reasoning
//   `normalizer-version.ts` gives for being a fourth constant rather than a bump of a third.
//   The inverse holds too: a change to any of the six things above belongs HERE and nowhere
//   else.
//
// HOW A FUTURE BUMP IS RECORDED
//   Every bump gets its own `WHY n -> n+1` section below, naming which of the six things moved,
//   what it moved from and to, and why a sample measured under n must never pool with one
//   measured under n+1. A bump that lands without one leaves the identity unexplained, which is
//   the failure the sibling constants' bump histories exist to prevent.
//
// WHY 1 -> 2
//   The Property_Dialect moved three ways, and nothing else of the six did (design.md,
//   Component 18): the Past_Depth ceiling went from 16 to 18, the first clocked rung minus one
//   less the Clocked_Check_Delay; a depth above it or in a form the reader cannot hold exactly
//   went from a silent render of no assertion to a named validation refusal; and a combinational
//   `$past` of nonzero depth or `$stable` is now refused at assembly where it used to be
//   emitted and render nothing. Each of the three moves what a sample RECORDS, not how it is
//   reported - a depth from 17 to 18 is now decided where it rendered nothing, and a sample
//   whose only property is now refused falls back as `no-property-expressed` rather than on
//   `zero-assertions` - so a sample taken under 1 must never pool with one taken under 2.
//
// WHY 2 -> 3
//   The emitted reset assume moved and nothing else did (design.md, Component 20): a Reset_Contract
//   carrying an enabling signal now assumes that signal at its asserted level beside the reset, so
//   `assume property (!$initstate || Rst);` became `assume property (!$initstate || (Rst && EN));`.
//   The assumed reset step is therefore one that fires, so a `proved` taken with the enable free and
//   one taken with it asserted are not comparable - measured on `LIFObuffer`, criterion 4.8 moved
//   from `could-not-verify` to `proved` at Proof_Depth 20 while the false half stayed `refuted`.
//
// WHY 3 -> 4
//   The Solver_Cross_Check's agreement rule moved and nothing else did
//   (`.kiro/specs/refutation-lost-to-cover-cross-check/`): the Cover_Check's audit is no longer
//   compared where the Base_Check FAILED. Cover mode's `Status:` string is overloaded at its
//   source - `yosys-smtbmc` breaks out of its loop on a failed assertion before it can report
//   every cover reached - so `FAILED` there means "a cover was unreached" OR "an assertion failed
//   on the covering path", and only the second is possible once the base check failed.
//   This moves what a sample RECORDS: a refutation whose cover audit differed used to be reported
//   as `could-not-verify` with `toolchain-unavailable` and is now `refuted` carrying its
//   Counterexample. Measured on five of the 92 pairs in
//   `.eval-runs/property-only-full-population-v2`, and reproduced on `rtllm/miscellaneous/RAM` and
//   `rtllm/arithmetic/adder_pipe_64bit`, which came back `refuted` with 2,289-byte and
//   10,413-byte counterexamples. A sample taken under 3 must never pool with one taken under 4,
//   because the same run reports a different verdict.
export const FORMAL_ORACLE_VERSION = 4;
