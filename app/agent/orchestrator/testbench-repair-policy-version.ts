// The identity of the testbench-repair-loop's behaviour (Req 7.1; task 6.3).
//
// WHY THIS EXISTS
//   Whether `#admitInstrument` attempts a precheck-path repair, and whether the
//   harness attempts a positive-control-path repair via `EvalTestbenchRepair`, is
//   part of the experiment, not part of the harness: change that behaviour, and a
//   sample measured with the repair loop OFF answers a different question than one
//   measured with it ON - the same reasoning `instrument-policy-version.ts`
//   already applies to the Verification_Loop's instrument-admission behaviour.
//
// WHY A THIRD CONSTANT AND NOT A BUMP OF `TESTBENCH_PROMPT_VERSION` OR `INSTRUMENT_POLICY_VERSION`
//   Neither the Testbench_Agent's first-draft prompt nor the existing
//   instrument-admission policy changed - only whether a repair is attempted did.
//   Bumping either existing constant would make its own pin assert something
//   false. This is a separate build constant for a separate concern
//   (`app/eval/sweep/config-identity.ts` folds it in under its own reserved key,
//   `__testbenchRepairPolicyVersion`, mirroring `__instrumentPolicyVersion`'s
//   precedent), so all three identities can never be conflated and each is a
//   one-line edit that cannot collide with an unrelated one.
//
// WHY 1 -> 2 (testbench-dialect-normalization, Req 7.4)
//   Version 1's regime had two repair trigger points: the precheck-path repair
//   inside `#admitInstrument`, and a positive-control-path repair the harness
//   attempted via `EvalTestbenchRepair`. This spec retires the positive-control-path
//   trigger entirely - `EvalTestbenchRepair` and `#repairIfTriggered` are deleted,
//   not merely disabled - leaving only the precheck-path trigger. That is exactly
//   the change this constant's own contract above says cannot pass silently: a
//   sample measured under version 1 (repair reachable from two trigger points)
//   answers a different question than one measured under version 2 (repair
//   reachable from one), even though the precheck-path repair itself is
//   unchanged. The bump records that the trigger surface moved, not that the
//   repair logic did.
export const TESTBENCH_REPAIR_POLICY_VERSION = 2;
