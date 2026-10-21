// Prompt identity for the Reference_Model role (C7). Bumped by hand on a rule change,
// never derived from a digest, so an edit that doesn't change a rule needs no bump.
//
// 1 - the prompt as first assembled.
// 2 - names the JSON reply envelope parseReferenceModelDraft requires
//     ({"functions": [{"name": ..., "body": ...}]}). Version 1 never told the model
//     the required shape, so it replied with three fenced Verilog blocks instead and
//     every reply failed to parse (task 18.1 pilot, first run: 24 of 24 draws).
// 3 - carries the Declared_Interface's packed bit layout, each output's Port_Timing meaning,
//     the acceptance criteria, and that ports are out of scope inside the functions. Under 2,
//     9 of 24 pilot draws failed to elaborate, mostly on port names (rst_n, valid_count) used
//     inside a body; design.md C7 already required the interface and Timing_Contract.
// 4 - Q-15 to Q-17 (design-council.md): ece_expect is what the outputs show now, a fourth
//     body ece_reset_state states the post-reset state, and the architecture text is carried.
// 5 - Q-19: each packing is also shown as a concatenation, and one worked four-body example
//     with a non-zero reset is carried. Under 4, all four Model_Arms packed outputs MSB-first
//     in declaration order and returned a zero reset state the Spec contradicted.
// 6 - the product renders the Stimulus_Function from a declared per-port role, so the reply
//     drops ece_stimulus and gains a roles array (Req 4.1, 4.3, 4.4); a ROLE_RULE states the
//     vocabulary; the Sample_Budget the Stimulus_Function is rendered over is stated so
//     ece_next_state and ece_expect are authored against that step count (Req 3.5); and
//     ece_reset_state is stated as the state after EVERY reset, since reset is now asserted
//     more than once over a run (Req 5.6).
export const REFERENCE_MODEL_PROMPT_VERSION = 6;
