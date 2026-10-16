// The identity of the assembled Testbench_Agent prompt (Req 11.1-11.5; task 9.1).
//
// WHY THIS EXISTS
//   A prompt is part of the experiment, not part of the harness: change a rule the
//   model is instructed by, and a sample generated before the change answers a
//   different question than one generated after. Two prompt versions are two
//   experiments, and their samples must not pool in a resumed run or a shared
//   summary - exactly the reasoning `./config-identity.ts` already applies to the
//   seed, the caps, and the model ids.
//
// WHY A HAND-BUMPED INTEGER AND NOT A DIGEST OF THE PROMPT ITSELF
//   A digest would change on every prompt edit with no human decision involved,
//   including edits that do not change a rule (comment wording, formatting). Bumping
//   this by hand is a deliberate act - "this changed what the model is told to do" -
//   and task 9.2 pins a digest of the assembled prompt against this exact value, so a
//   rule change without a matching bump still fails loudly rather than silently.
//
// HISTORY
//   1 - the prompt as first assembled.
//   2 - the expected-value, state-anchoring, timing, input-window, and
//       stimulus-adequacy rules.
//   3 - two rules added from the stage1-screen-v2 campaign (495 samples): the
//       Verilog-2001 DIALECT rule, aimed at the ~25% of instrument-invalid samples
//       whose testbench never compiled, and the RTL CONCURRENCY rule, aimed at the
//       ~60% that compiled and then rejected the reference design. See
//       `chipAgent/_inbox/gotcha-stage1-screen-v2-dialect-and-concurrency-are-the-two-instrument-defects.md`.
//   4 - the In_Order_Scoreboard Checking_Approach (testbench-in-order-scoreboard): for a
//       Spec routed to it, the model fills product-rendered scaffold slots with stimulus
//       and Expectation fragments instead of writing a testbench, under CONCURRENCY_RULE
//       plus one carve-out sentence. Cycle_Timed model inputs are byte-identical to 3; the
//       version moves because the Treatment_Arm's inputs changed and identity is per build.
//   5 - the scoreboard fragment contract states that "runLength" is a JSON integer. The first
//       52 slots of scoreboard-ab-v1 ran under 4 and are discarded with it: kimi-k2.5 wrote
//       "4" for 4 on every accu sample, so version 4 measured JSON typing, not the approach.
//       Cycle_Timed model inputs are still byte-identical to 3.
//   6 - the Grounded_Arm (testbench-spec-grounding): for a Sweep_Arm with strategy
//       "grounded", the prompt adds the Spec's Architecture_Text as a labelled section, drops
//       the up-counter known-answer check, and asks for one fenced Verilog block parsed by its
//       own parser. Control_Arm and Treatment_Arm model inputs are byte-identical to 5.
//   7 - the Check_Report_Rule (testbench-failure-reportability): every required check is
//       reported by calling the Check_Report_Task with both the expected and the observed
//       value, which needs SIMULATION_HARNESS_VERSION 3 to render that task. The rule is
//       unconditional, so Control_Arm and Grounded_Arm inputs stay byte-identical to each
//       other outside the Architecture_Section and the output contract.
export const TESTBENCH_PROMPT_VERSION = 7;
