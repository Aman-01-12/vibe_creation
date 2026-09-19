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
export const TESTBENCH_PROMPT_VERSION = 2;
