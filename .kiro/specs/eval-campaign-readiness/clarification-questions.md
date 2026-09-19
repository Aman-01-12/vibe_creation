# Clarification questions - Track B (raised during task 4.3, blocking task 5.3)

> Raised by: resuming the spec at task 4.3 (Retry-After wired into the JSON HTTP port).
> Status: **task 4.3 is implemented and the gate is green**, but it resolved an open question by choosing one side of a spec contradiction. That choice determines how task 5.3 must be written, so it needs your call before 5.3 is built.
> How to answer: reply with `clarification-answers.md` in this folder, or annotate inline. I will then fold the decision into the spec through the spec subagent, never by hand-editing.

---

## TB-1: What is the ceiling on a host-supplied `Retry-After` delay, and may the applied delay exceed `policy.maxDelayMs`?

### Where this maps

- **Requirement 5.4:** "THE Retry_After_Reader SHALL report a delay **no greater than the retry policy's maximum delay**."
- **Requirement 5.5:** Transport_Retry waits "at least the greater of that delay and its own jittered backoff".
- **design.md line 244:** "A parsed delay is **clamped to `maxDelayMs`**, because the header is untrusted input and a hostile or misconfigured host must not be able to park a campaign for hours."
- **design.md line 485 (the stated property):** "*For any* header text, the parsed delay is either `null` or a number in the range **`[0, maxDelayMs]`**."
- **tasks.md 5.3:** "clamp the product to `policy.maxDelayMs`, **then raise the result to the reply's Retry-After delay - the floor after the clamp, so a host asking for longer than our ceiling is still obeyed**."

### The tension

**These cannot all be true at once.**

Requirements 5.4 and 5.5, plus both design statements, imply the applied delay is bounded by `policy.maxDelayMs` (currently `30_000` in `DEFAULT_TRANSPORT_RETRY_POLICY`). If the parsed delay can never exceed that clamp, then the floor in task 5.3 can never raise the delay above it either.

But task 5.3's stated rationale - "a host asking for **longer than our ceiling** is still obeyed" - is only meaningful if the parsed delay **can** exceed `policy.maxDelayMs`. Otherwise the phrase describes something the code cannot do.

### What task 4.3 actually shipped, and why

The implementation clamps to a **new build constant** `MAX_HONOURED_RETRY_AFTER_MS = 60_000` declared in `fetch-json-http-port.ts`, **not** to `policy.maxDelayMs`. Two reasons were given, and both are sound as far as they go:

1. **Layering.** `app/eval` imports `@app/agent`, never the reverse. The port reading `TransportRetryPolicy` would invert the dependency direction the port exists to hold.
2. **Otherwise 5.3's floor is near-dead code.** If the port had already clamped to `policy.maxDelayMs`, the floor could only ever raise a *small* computed backoff up to that same clamp - never past it - so "longer than our ceiling is still obeyed" would be unachievable.

**The consequence to be explicit about:** with the default policy, the applied retry delay can now reach **60s, double the 30s `policy.maxDelayMs`**, and Requirement 5.4 as literally written is violated. Worst case per request is `maxAttempts - 1` waits, so roughly 3 minutes at the defaults, and only when the host explicitly asks for >= 60s each time.

### Why it matters

- It is a **safety-versus-obedience** trade, not a detail. A longer honoured delay is *more* cooperative with a throttling host and *more* exposed to a host that misreports.
- It decides whether task 5.3 keeps its floor clause or drops it.
- Requirement 5.4 and the design's Property-8 range statement are currently **false about the shipped system**, and a requirement that is false is worse than one that is missing.

### Options

**Option A - Honour 5.4 literally: the port clamps at `policy.maxDelayMs`.**
The applied delay never exceeds 30s. Requires either threading the policy value into the port (inverts the dependency direction) or introducing a shared constant both layers read.
*Consequence:* task 5.3's floor clause must be **struck** - "a host asking for longer than our ceiling is still obeyed" becomes unachievable and should be deleted rather than left as aspirational text.

**Option B - Keep the shipped 60s port ceiling, and amend Requirement 5.4.** ← **recommended**
Reword 5.4 to bound the reader by **the port's own honoured ceiling** rather than by the retry policy's maximum, and state plainly in the design that the applied delay may exceed `policy.maxDelayMs` up to that ceiling. Update the design's range statement from `[0, maxDelayMs]` to `[0, MAX_HONOURED_RETRY_AFTER_MS]`.
*Rationale:* it preserves the layering (the port cannot reach upward for a policy), it keeps 5.3's floor meaningful, and it makes the two documents true about the code. The cost is one clearly-bounded number, which is the thing the clamp exists to guarantee.

**Option C - Make both ceilings the same number.**
Raise `policy.maxDelayMs` to 60s, or lower `MAX_HONOURED_RETRY_AFTER_MS` to 30s, so the two agree and 5.4 is literally satisfiable.
*Consequence:* 5.3's floor becomes almost inert (it can only ever match the clamp, never exceed it), and changing `policy.maxDelayMs` alters existing backoff behaviour that current tests pin. Cheapest to state, weakest in substance.

### What I need from you

1. **A, B, or C.**
2. If B: confirm **60s** is the ceiling you want, or name a different one. The 60s anchor was chosen because it is the same order as `breakerCooldownMs` (the wait we already accept for an unhealthy endpoint) and far below anything that parks an overnight campaign.
3. Confirm that "the applied retry delay may exceed `policy.maxDelayMs`" is acceptable as a documented behaviour, since that is the observable change.

---

## Not blocking - noted for the record

**TB-2: the tasks.md checkboxes were stale.** Every task read `[ ]` on resume, but Track A (1.1, 1.3, 1.5, 2.1, 2.2), task 4.1, and Track C tasks 7.1 and 8.1 are all verifiably implemented and committed. I have marked only 4.3, which I executed. **Do you want the already-done tasks reconciled to `[x]`?** Leaving them unchecked means the spec understates progress and a future session may redo work; checking them asserts completion I verified by deliverable rather than by running each task's stated verification.

**TB-3: task 4.3 shipped without its tests, by instruction.** Task 4.4 is starred (optional) and was skipped. So the new header path has **no test of its own** - the green suite only proves no regression, because every existing fake returns no `headers` and exercises only the absent branch. Unexercised today: a reply carrying `Retry-After`, the HTTP-date branch against the injected clock, the clamp, the throwing-accessor guard, and "the returned object exposes no other header". **Recommend running 4.4 before 5.3**, since 5.3 composes on top of this value and a wrong sign or unit here would surface as a mysterious backoff rather than as a failing test.
