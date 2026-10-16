// The Secret_Pattern_Set: the ONE set of secret-shaped token patterns this product
// redacts by (Req 11.20, design.md Component 16).
//
// WHY IT LIVES IN `@app/core` AND NOT WHERE IT WAS WRITTEN
//   It has two readers, in two different layers. The Action_Recorder
//   (`app/agent/action-recorder/redaction.ts`) scrubs every value on its way into a
//   persisted Trace; `sanitizeDiagnostic` (`app/tools/formal/interpret.ts`) scrubs an
//   untrusted tool diagnostic on its way out to a log and a screen. `@app/core` is the
//   lowest package both already import, so one owner costs no new dependency edge and
//   adds nothing in a direction the layering forbids - this module imports NOTHING.
//
//   One owner is the whole point. A second copy of a redaction set drifts, and the copy
//   that drifts is the copy that quietly stops redacting. So this is the only place these
//   shapes are written down; a reader imports them and never restates them.
//
// WHY A PATTERN SET AND NOT A HIGH-ENTROPY HEURISTIC
//   Redacting arbitrary high-entropy tokens would also redact the content hashes, module
//   digests, and generated net names a Student legitimately needs to read in a diagnostic.
//   A closed set of measured credential shapes redacts what is a credential and leaves
//   what is evidence.
//
// Pure data: no state, no compiled regex, no import. Each consumer compiles the sources
// with whatever flags it needs, which is also why they are stored flag-FREE - a shared
// `/g` regex carries a mutable `lastIndex` across its readers, and that is a measured hang
// in this repository (`chipAgent/_inbox/gotcha-shared-global-regex-lastindex-infinite-loop.md`).

/**
 * Regex sources (flag-free, so `.test` on a freshly built regex is not stateful) for
 * secret-shaped tokens: OpenAI `sk-`, AWS `AKIA`, GitHub `ghp_`, `Bearer`, JWT triples,
 * and hex `api_`.
 *
 * These mirror the synthetic shapes produced by `@app/test`'s secret generators
 * (`app/test/generators/secrets.ts`) so the redaction is testable by property, and each is
 * written to match when EMBEDDED in a larger string rather than only on its own.
 *
 * Every pattern is anchored by a required literal prefix (`sk-`, `AKIA`, `ghp_`, `Bearer`,
 * `api_`) or by a word boundary, which is what keeps them cheap on hostile input: a greedy
 * quantifier ahead of a required literal is a quadratic scan on text that lacks the literal
 * (see `sanitizeDiagnostic`'s own notes), and a required prefix means such a scan starts
 * only where the prefix actually occurs. Do not relax a prefix to a character class.
 */
export const SECRET_PATTERN_SOURCES: readonly string[] = Object.freeze([
  'sk-[A-Za-z0-9]{20,}',
  'AKIA[A-Z2-7]{16}',
  'ghp_[A-Za-z0-9]{30,}',
  'Bearer\\s+[A-Za-z0-9._-]{20,}',
  '\\b[A-Za-z0-9]{10,}\\.[A-Za-z0-9]{10,}\\.[A-Za-z0-9]{20,}\\b',
  'api_[0-9a-f]{32,}',
]);
