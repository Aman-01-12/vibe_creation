// The identity of the Verification_Loop's instrument-admission behaviour (Req
// 7.4-7.8; task 3.5).
//
// WHY THIS EXISTS
//   Whether the loop runs a Testbench_Precheck and consults an Instrument_Admission
//   port before spending a repair iteration is part of the experiment, not part of
//   the harness: change that behaviour, and a sample measured before the change
//   answers a different question than one measured after - exactly the reasoning
//   `../roles/testbench/prompt-version.ts` already applies to the assembled
//   Testbench_Agent prompt.
//
// WHY A SECOND CONSTANT AND NOT A BUMP OF `TESTBENCH_PROMPT_VERSION`
//   The Testbench_Agent's prompt did not change, and `prompt-version.test.ts` pins
//   a digest of the assembled prompt against that exact constant; bumping it here
//   would make that pin assert something false. This is a separate build constant
//   for a separate concern (`app/eval/sweep/config-identity.ts` folds it in under
//   its own reserved key, `__instrumentPolicyVersion`), so the two identities can
//   never be conflated and each is a one-line edit that cannot collide with an
//   unrelated one.
export const INSTRUMENT_POLICY_VERSION = 1;
