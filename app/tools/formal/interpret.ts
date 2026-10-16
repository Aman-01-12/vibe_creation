// `interpretFormalReport`: the one place a `SandboxResult` plus a validated `FormalReport` becomes
// a `PropertyResult` (design.md Component 4's classification function; Req 1.8, 1.9, 1.10, 2.2,
// 2.3, 2.5, 2.7, 2.8, 4.2, 4.3, 4.8, 5.3, 5.4, 5.7, 6.11, 6.12, 7.2, 7.3, 7.4, 7.5, 8.1, 8.2,
// 8.3, 8.4, 8.5, 8.8, 8.9, 11.6, 11.8, 11.10, 11.13, 11.19, 11.20).
//
// IT DOES NOT OWN THE FIVE-CONDITION RULE, AND THAT IS THE POINT
//   `admitProved` in `./conditions.js` is the single owner of the rule and of its fixed
//   evaluation order. This function reads its answer and never re-derives the order, because two
//   owners of the gate is precisely the defect class this spec exists to remove. Where it needs
//   to know how FAR the order got - "did every condition ahead of the base case hold?" - it asks
//   the owner that too, by handing it the same conditions with the later ones set to their
//   admitting values (`reachedBaseCondition`). So the order is still written down once. The only
//   things this function adds around those calls are facts `admitProved` cannot see: a run the
//   runner killed, a lowering that failed, a registered Counterexample artifact, a reported
//   `Status:` string, and a Solver_Cross_Check. Each is read from a source `ProofConditions` does
//   not carry, so none can be folded into `admitProved` without giving it a second input.
//
// WHY THE VERDICT IS NEVER TAKEN FROM AN EXIT CODE (Req 1.8)
//   `yosys-smtbmc` exits 0 for `PASSED` and 1 for EVERYTHING else, so the exit code cannot
//   distinguish a false property (`FAILED`) from contradictory assumptions (`PREUNSAT`), and it
//   cannot distinguish either from an unparseable run. The `Status:` string is therefore parsed
//   and closed to the three MEASURED values, and any other value - including absent - falls to
//   `could-not-verify` / `toolchain-unavailable` (Req 1.9). The lowering's exit code IS read, but
//   only as "Yosys completed or it did not", which is the one thing an exit code can say.
//
// THE ORDER OF THE CHECKS BELOW, AND WHY EACH ONE SITS WHERE IT DOES
//   1. No report at all. Covers every shape of missing evidence at once (Req 11.8): a run the
//      Tool_Runner classified `error`, a missing `formalReport` artifact, and a report that failed
//      schema validation. The caller collapses all three into `null` because they are one fact -
//      we have no evidence - and `SandboxResult` cannot tell them apart anyway
//      (`chipAgent/_inbox/gotcha-sandbox-result-collapses-error-causes.md`: `error` folds timeout,
//      infrastructure failure, missing output, and truncated capture into one verdict). The one
//      cause that IS recoverable is `timedOut`, which is carried on the result precisely because
//      a wall-clock kill leaves nothing else to infer from; everything else is
//      `toolchain-unavailable`.
//   2. A killed run, AHEAD OF THE FAILED LOWERING and ahead of the gate. Req 7.3 and 7.4 forbid
//      `proved` and `refuted` for a property whose budget was spent, and a killed run's evidence
//      is incomplete by definition. Ahead of the lowering because a lowering that OUR wall clock
//      stopped exits non-zero, so read the other way round it lands on
//      `attributeLoweringFailure` and becomes `frontend-rejected` - which Req 8 defines as
//      attributable to the candidate design, so the design would be blamed, and counted in the
//      recorded quarantine, for a budget that is ours (Req 7.23). That is the blame-the-student
//      direction, and the timeout is the fact that explains the whole invocation while a
//      non-zero exit code under a kill says only that the kill worked.
//      THE CASE IS UNREACHABLE TODAY, and the order is fixed before it becomes reachable: the
//      adapter reads no report for a Tool_Runner `error` result, and a killed run is an `error`
//      result, so `timedOut` arrives here only beside a `null` report, which check 1 already
//      answers with `proof-timeout`. The day a timed-out run does carry a partial report is not
//      the day to work out which of the two checks reads it first.
//   3. A failed lowering, BEFORE the assertion-count guard. This ordering is load-bearing: a
//      lowering that aborted wrote no SMT2, so its assertion count is zero as a CONSEQUENCE.
//      Reporting `zero-assertions` there would name a symptom and lose the attribution Req 8.1
//      and 8.8 require, and would turn the two measured frontend rejections
//      (`verified_float_multi`, `verified_synchronizer`) into a cause about the solver.
//   4. A Cover_Check naming a reached step AT OR PAST the depth its own invocation ran at, ahead
//      of the WHOLE five-condition order (Req 11.19). This is a REJECTION OF THE REPORT and not a
//      reading of a condition, which is why it sits where it does: `yosys-smtbmc` reaches a cover
//      only at a step BELOW the depth it searched to, so a report naming step >= depth is forged
//      or corrupt, and the schema cannot catch it - `reachedStep` is bounded only by
//      `minimum: 0`, with no cross-field relation to the depth expressible there. Req 11.10 is
//      the rule it serves: a verdict is derived from tool output only through a parse that
//      REJECTS what it does not recognize, and an impossible step is not recognized. It is ahead
//      of the order because reading ANY of the five conditions off that document would be reading
//      a document we have already judged unreadable, and it would let the step feed the
//      Proof_Depth rule Req 4.6 states. It is BEHIND the three checks above because those are
//      facts about the RUN rather than about the report's internal consistency - no evidence at
//      all, a wall-clock kill, a lowering that aborted - and each carries an attribution (Req
//      8.8, 7.23) that this guard has no reason to take away.
//      It reads the REPORT alone and not the property: a step naming a cover for a property that
//      has no antecedent is equally impossible, so no `coveredAntecedent` call gates it, and
//      `coverCondition` is left exactly as it is - the guard refuses the report rather than
//      reinterpreting the cover, so the cover condition keeps its single owner.
//   5. `zero-assertions`, ahead of every other condition and ahead of the refutation, whatever
//      the `Status:` said (Req 2.3). This is the measured silent-failure trap: the chain missing
//      `async2sync` and `chformal -lower` exits 0, emits ZERO assertions, and reports
//      `Status: PASSED` for a property that is provably FALSE of `adder_8bit`. A `FAILED` under
//      zero assertions is no more meaningful than a `PASSED` under zero assertions.
//   6. A DISAGREEING Solver_Cross_Check, ahead of the refutation and of the remaining conditions
//      (Req 4.16). A disagreement invalidates the basis on which the solver was chosen, so no
//      verdict may be read from either solver's output on that run - neither a `proved` nor a
//      `refuted`, and neither solver is preferred, because reconciling a disagreement would be
//      fitting the evidence to the choice. It sits BEHIND `zero-assertions` because two solvers
//      agreeing about an empty problem is not agreement about anything.
//   7. The refutation, from the BASE CASE and from nothing else (Req 4.8, 4.10, and design.md's
//      Property 6). THIS IS THE CORRECTION THAT MATTERS MOST IN THIS FILE: it previously read
//      `refuted` off the INDUCTION check's `FAILED`, which refutes CORRECT designs.
//      `yosys-smtbmc`'s k-induction emits no simple-path constraints, so a correct design reports
//      a passing base case with a failing inductive step at EVERY depth - measured on a
//      constructed `bounded_ctr`, on `counter_12`'s `out != 4'd13`, and on the Yosys issue-3378
//      ROM case at depths 1, 5, 20, and 40 - and upstream SymbiYosys treats that situation as
//      UNKNOWN rather than as a failure. A base-case failure is the opposite kind of fact: with
//      the reset assume present, the base-case failure rate on correct designs with known-true
//      properties went from 4 of 6 to 0 of 6, so a base-case `FAILED` is a counterexample
//      reachable from the design's ACTUAL reset state.
//      It sits ahead of the remaining conditions because a refuting run reports no
//      temporal-induction success, so deferring to `admitProved` would rename every real
//      counterexample `induction-inconclusive`. It is guarded by `reachedBaseCondition`, so a
//      `FAILED` base case under contradictory assumptions or an unreached antecedent reports THAT
//      cause instead - a failure under `false` is not a counterexample.
//   8. The rest of the gate, straight from `admitProved`, with the ONE fact it structurally cannot
//      see supplied here: the induction check's RAW reported `FAILED` over a PASSING base case is
//      `induction-engine-incomplete` and not `induction-inconclusive` (Req 4.11, 4.12).
//      `ProofConditions['induction']` records what the check ESTABLISHED, so the gate cannot tell
//      a reported failure from a bounded pass; the two have different remedies - more depth for
//      the second, nothing known for the first - so they are named apart here.
//   9. `proved` only when the gate admitted, and on nothing else. The `Status:` strings are
//      already folded INTO the conditions (`baseCondition`, `inductionCondition`, and
//      `PRESAT_FOR_STATUS` each require a recognized status), which is how Req 1.8's "the parsed
//      `Status:` TOGETHER WITH the conditions" is honoured without a second status read racing the
//      gate's answer.
//
// TWO THINGS DELIBERATELY NOT READ, EACH BECAUSE READING IT WAS MEASURED TO BE WRONG
//   The FAILING STEP is not read at all, and no Proof_Condition or verdict rests on a threshold
//   over it (Req 1.15, 1.16). Both thresholds were measured and rejected: a clocked assertion
//   SAMPLES the step-0 state and reports at step 1, so "step > 0" admits every failing clocked
//   property including every polarity error, and at depth 20 polarity errors and genuine
//   reset-state bugs both fail at step 1 byte for byte while real functional mutants fail at steps
//   3 to 14, so "step > 1" discards every genuine reset-state bug. Where a step is ever read, it
//   is read from the last `Checking assertions in step N..` line preceding `BMC failed!` and never
//   from an `Assert failed` line, which does not carry it. The COVER step check 4 reads is a
//   different number put to the opposite use: it REFUSES a report rather than grading one, so it
//   can only move a result towards `could-not-verify` and no verdict rests on a failing step.
//   An ABSENT Counterexample trace is not an error on that ground alone (Req 12.19): a proof
//   writes no trace, so its absence is the ordinary shape of a run that found no counterexample.
//   The one place it decides anything is a base-case `FAILED` with no trace registered, which is
//   `toolchain-unavailable` by Req 1.17.
//
// Pure and total: no model call, and no file, network, clock, or random-source read. It returns on
// every input, throws on none, and reports `proved` or `refuted` from no unrecognized condition -
// every fall-through direction is `could-not-verify`.

import { SECRET_PATTERN_SOURCES } from '@app/core';

import {
  admitProved,
  type CouldNotVerifyCause,
  type CoverCondition,
  type ProofConditions,
  type PropertyResult,
} from './conditions.js';
import type { FormalCheckReport, FormalChecksReport, FormalReport } from './report.js';
import type { SandboxResult } from '../sandbox/index.js';
import { coveredAntecedent, type FormalProperty } from '../verilog/property.js';

/**
 * What this invocation was, beyond the report itself.
 *
 * The three scalars design.md's sketch passes positionally (`depth`, `elapsedMs`) plus the two
 * submitted filenames, grouped into one value for two reasons. First, `depth` and `elapsedMs` are
 * adjacent numbers, and two adjacent same-typed positional parameters are a swap waiting to
 * happen in a function whose output decides a trust label. Second, the filenames have nowhere
 * else to come from: attribution is BY the submitted filename (Req 8.8), and neither the report
 * nor the property carries what the adapter chose to call the files in the workspace.
 */
export interface FormalRunContext {
  /** The Proof_Depth every `yosys-smtbmc` invocation in this run used (Req 4.4). */
  readonly depth: number;
  /** Wall-clock milliseconds this run spent, recorded even when it timed out (Req 7.5). */
  readonly elapsedMs: number;
  /** The workspace-relative name the candidate design was submitted under (Req 8.8). */
  readonly designFileName: string;
  /** The workspace-relative name the Property_Wrapper was submitted under (Req 8.8). */
  readonly wrapperFileName: string;
}

/**
 * The artifact key a Counterexample is registered under (Req 1.10).
 *
 * `vcd` is the worker's own artifact key for a waveform, so a counterexample trace registered by
 * the formal path arrives under the same name a simulation waveform does. Exported so the adapter
 * and its tests name the same key rather than two spellings of it.
 */
export const COUNTEREXAMPLE_ARTIFACT_KEY = 'vcd';

/**
 * The bound on a surfaced diagnostic tail, in characters (Req 8.4).
 *
 * Bounded a SECOND time here, below the worker's own 4096-character bound, and deliberately so.
 * The worker's bound is a transport bound on a field inside an artifact; this one bounds a field
 * that is carried on a `PropertyResult`, persisted once per Formal_Property, and rendered. A
 * Yosys ERROR plus its surrounding context is a few hundred characters, so 2000 holds every
 * measured diagnostic whole - the same order as `MAX_EXPRESSION_CHARS`, the existing bounded
 * field in this area. Re-bounding is not distrust of the worker as such: this is a trust boundary
 * crossed by a file, and a field that is only ever bounded on the far side of a boundary is a
 * field that is not bounded.
 */
export const MAX_DIAGNOSTIC_CHARS = 2_000;

/**
 * The `Status:` strings the feasibility probe measured. Closed, because Req 11.10 requires a
 * parse that rejects what it does not recognize, and Req 1.9 makes an unrecognized one
 * `toolchain-unavailable` rather than a guess.
 */
const MEASURED_STATUSES = ['PASSED', 'FAILED', 'PREUNSAT'] as const;

/** One recognized `Status:` value. */
type MeasuredStatus = (typeof MEASURED_STATUSES)[number];

/**
 * What each recognized `Status:` says about the Presat_Check.
 *
 * A total `Record` rather than a comparison chain, by the same rule `conditions.ts` applies to its
 * failure-cause maps: a fourth measured status is a COMPILE ERROR here instead of silently
 * defaulting to a reading nobody observed. `PREUNSAT` is the measured signal for contradictory
 * assumptions (`assume(rst_n)` together with `assume(!rst_n)`); `FAILED` reads as `satisfiable`
 * because a run that found a counterexample necessarily had a satisfiable assumption set - if the
 * assumptions could not all hold there would be no model to exhibit.
 */
const PRESAT_FOR_STATUS: Readonly<Record<MeasuredStatus, ProofConditions['presat']>> =
  Object.freeze({ PASSED: 'satisfiable', FAILED: 'satisfiable', PREUNSAT: 'preunsat' });

/**
 * What each recognized `Status:` says about the Base_Check, by the same totality rule.
 *
 * `FAILED` is the ONLY value in this whole module that can source a `refuted`, which is why
 * `PREUNSAT` maps to `not-run` rather than to `failed`: the Base_Check is invoked with neither
 * `-i` nor `-c` and without `--presat`, so a contradictory-assumption verdict coming back from it
 * is a result we cannot read as a base-case result at all. Mapping it to `failed` would let an
 * unexpected status refute a design, which is the direction this file exists to stop being wrong
 * in. `not-run` is the honest record - we witnessed no base-case outcome - and it maps to
 * `toolchain-unavailable`.
 */
const BASE_FOR_STATUS: Readonly<Record<MeasuredStatus, ProofConditions['base']>> = Object.freeze({
  PASSED: 'passed',
  FAILED: 'failed',
  PREUNSAT: 'not-run',
});

/**
 * What each recognized `Status:` says about the Induction_Check BEFORE the induction line is read.
 *
 * `PASSED` is `successful` only as a CANDIDATE - `inductionCondition` still requires the temporal
 * -induction line beside it, because a bounded pass reports `PASSED` and prints no such line.
 * `FAILED` is `inconclusive` rather than `not-run`, because the check RAN and established no
 * induction success; the caller reads the raw `FAILED` to name it `induction-engine-incomplete`,
 * and this is what the record carries (Req 2.7). `PREUNSAT` is `not-run` for the reason
 * `BASE_FOR_STATUS` gives: the Induction_Check runs without `--presat`, so that verdict from it is
 * not an induction result we can read.
 */
const INDUCTION_FOR_STATUS: Readonly<Record<MeasuredStatus, ProofConditions['induction']>> =
  Object.freeze({ PASSED: 'successful', FAILED: 'inconclusive', PREUNSAT: 'not-run' });

/** Drop a whole stack-frame line: a Yosys backtrace, or `yosys-smtbmc`'s Python traceback. */
const STACK_FRAME_RE = /^\s*(?:Traceback \(most recent call last\)|File "|#\d+\s+0x|at 0x)/;

// The host-and-path redaction patterns. Every one is used ONLY with `String#replace`, which resets
// `lastIndex` on a global regex, so none of them is exposed to the shared-`/g`-across-scan-loops
// hang (`chipAgent/_inbox/gotcha-shared-global-regex-lastindex-infinite-loop.md`) - that trap needs
// an `exec` loop, and there is none here. Do not convert one to an `exec` loop. The same rule holds
// for the Secret_Pattern_Set regexes below them.
//
// TWO OF THE THREE ARE QUADRATIC IN THE LENGTH OF AN UNBROKEN RUN, AND THAT IS WHY THE BOUND IS
// APPLIED FIRST (see `boundedTail`). A greedy quantifier ahead of a REQUIRED literal - `\S+` before
// `@`, `[A-Za-z0-9+.-]*` before `://` - restarts at every offset on text that lacks the literal,
// consumes to the end of the run, and backtracks the whole way. Measured per 100 calls on
// `'e'.repeat(n)`: `URL_RE` 42ms, 160ms, 642ms, 2731ms and `USER_AT_HOST_RE` 42ms, 161ms, 640ms,
// 2672ms at n = 500, 1000, 2000, 4000 - 4x per doubling, each contributing about half the cost.
// ONE call at n = 16000 costs a measured 813ms across the two, which puts the worker's
// `MAX_CAPTURED_STDERR_BYTES = 262_144` cap at about 218 SECONDS of synchronous CPU.
// Rewriting the local part as a negated class that cannot cross the literal (`[^\s@]+@`) was
// MEASURED and does NOT help - 2838ms at n = 4000, marginally worse than `\S+@`, because the engine
// backtracks through a negated class just the same - and it redacts LESS: on `a@b@host.example` it
// leaves `<host>@host.example`, so the host survives. Bounding the INPUT is the fix; narrowing these
// patterns is not.

/** A URL, redacted whole because its authority is a host name (Req 8.5, 11.6). */
const URL_RE = /[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+/g;

/** A `user@host` form, the other realistic way a host name reaches a diagnostic. */
const USER_AT_HOST_RE = /\S+@[A-Za-z0-9.-]+/g;

/**
 * An absolute filesystem path.
 *
 * The same shape the worker redacts, applied again on this side. Workspace-RELATIVE names are
 * left intact on purpose, here as there: `attributeLoweringFailure` reads the design file's and
 * the wrapper's own names out of the diagnostic, so redacting those would destroy the evidence
 * rather than protect anything.
 */
const ABSOLUTE_PATH_RE = /\/(?:[\w.+$-]+\/)*[\w.+$-]+/g;

/** The marker written over a Secret_Pattern_Set match, in this file's own placeholder style. */
const SECRET_MARKER = '<secret>';

/**
 * The Secret_Pattern_Set, compiled once (Req 11.20).
 *
 * The SOURCES come from `@app/core`, which is their single owner, shared with the
 * Action_Recorder's `redactJson`. Req 11.6 requires the surfaced diagnostic to carry no secret,
 * and the five redactions this file had - a stack-frame line, a URL, a `user@host` form, an
 * absolute path, control characters - recognize no secret-shaped token, so that half of 11.6
 * rested entirely on the Tool_Runner mounting no secret (Req 11.4). Resting a non-negotiable on
 * another component's guarantee is a single point of failure, so it is enforced here too.
 *
 * Compiled at module load rather than per call, because `sanitizeDiagnostic` runs once per
 * Formal_Property on a hot path and building six regexes per call is six allocations for a value
 * that never changes. `/g` is safe for the same reason the patterns above are: every use is a
 * `String#replace`, which resets `lastIndex`. Do not hand one of these to an `exec` loop.
 *
 * NOT a high-entropy heuristic, deliberately: redacting any token that merely looks random would
 * also redact the content hashes and generated net names a Student needs to read in a Yosys
 * diagnostic. A closed set of measured credential shapes redacts credentials and keeps evidence.
 */
const SECRET_RES: readonly RegExp[] = SECRET_PATTERN_SOURCES.map(
  (source) => new RegExp(source, 'g'),
);

/**
 * The text with every Secret_Pattern_Set match replaced (Req 11.20).
 *
 * RUNS AFTER THE HOST AND PATH REDACTIONS, AND BEFORE THE OUTPUT BOUND. Both halves of that
 * placement are load-bearing.
 *
 * After the host patterns, because inserting `<secret>` ahead of a host name DEFEATS them:
 * `USER_AT_HOST_RE` reads its host as `[A-Za-z0-9.-]+`, which `<` is not in, so on
 * `runner@sk-AAAAAAAAAAAAAAAAAAAA.internal.example.test` a secret-first order yields
 * `runner@<secret>.internal.example.test` and the HOST SURVIVES - the same leak shape a blind
 * output cut was measured to produce. Running the secrets last cannot defeat the host patterns in
 * the other direction, because no pattern in the set can match a `:`, an `@`, or a `/`, so a URL
 * or path match that overlaps a secret CONTAINS it and redacts it whole.
 * The one residual, recorded rather than hidden: `Bearer\s+<token>` is the only shape in the set
 * that spans a whitespace, so a literal `/some/path/Bearer <token>` has its `Bearer` eaten by
 * `ABSOLUTE_PATH_RE` first and the bare token survives. Closing it needs either a second secret
 * pass before the paths - which reopens the host leak above, a worse trade - or the entropy
 * heuristic this set exists instead of. No measured Yosys or `yosys-smtbmc` diagnostic has that
 * shape; a host name in one is the realistic case, which is the one kept closed.
 *
 * Before the output bound, because that `slice` is a BLIND cut: a secret straddling it would lose
 * its identifying prefix and surface as a bare token. Cutting after this pass cannot create a
 * match it missed - every pattern matches a substring, so dropping a prefix only ever removes
 * matches - which is what makes that order safe.
 *
 * The cost is bounded by `boundedTail` having already run: this is handed at most
 * `MAX_DIAGNOSTIC_CHARS + 1` characters, exactly like the three patterns above it, so nothing here
 * sits ahead of the bound. The patterns are cheap on hostile input in their own right as well, and
 * that was MEASURED rather than assumed - each is anchored by a required literal prefix or a word
 * boundary, so the backtracking scan that makes `\S+@` quadratic starts only where a prefix
 * actually occurs. Per 100 passes over the worst window the bound still admits (a 2000-character
 * unbroken run): the three patterns above cost 1334ms, this pass costs 1.1ms. On the dot-dense
 * shape the JWT triple could in principle backtrack on (133 fourteen-character runs joined by
 * `.`): 1267ms above, 2.4ms here. Three orders of magnitude of headroom, so the bound and the
 * guard in `app/test/formal-diagnostic-bound.test.ts` keep the whole function where they left it.
 */
function withoutSecrets(text: string): string {
  return SECRET_RES.reduce((redacted, pattern) => redacted.replace(pattern, SECRET_MARKER), text);
}

/** Tab and newline: the two C0 controls a multi-line tool diagnostic legitimately carries. */
const KEPT_CONTROL_CODES: readonly number[] = [0x09, 0x0a];

/** The first printable code point, and the DEL that sits above the printable ASCII range. */
const FIRST_PRINTABLE_CODE = 0x20;
const DELETE_CODE = 0x7f;

/**
 * The text with C0 control characters and DEL removed, keeping tab and newline.
 *
 * A code-point filter rather than a regex, the same shape `constructName` in
 * `../verilog/property.ts` already uses for the same job: a control-character class inside a
 * regex literal is itself flagged as a defect, and the filter states the rule in one readable
 * predicate. The reason for the rule is not cosmetic - this string is untrusted text that reaches
 * a log and a screen, and an ANSI escape or a carriage return inside it is a terminal-control
 * sequence that a reader never typed. Non-ASCII characters are left alone: they are not controls.
 */
function withoutControlCharacters(text: string): string {
  return [...text]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return (
        KEPT_CONTROL_CODES.includes(code) || (code >= FIRST_PRINTABLE_CODE && code !== DELETE_CODE)
      );
    })
    .join('');
}

/**
 * The leading run of non-whitespace, which is the token the bound cut in half, if it cut one.
 *
 * `*` rather than `+`, so a window that already begins at a whitespace matches the empty string and
 * loses nothing. Non-global and anchored, so it has no `lastIndex` state and one start position -
 * neither the `/g` hang nor the backtracking above can reach it.
 */
const LEADING_PARTIAL_TOKEN_RE = /^\S*/;

/**
 * The last `MAX_DIAGNOSTIC_CHARS` characters, cut at a WHITESPACE boundary rather than mid-token.
 *
 * THIS RUNS AHEAD OF THE REDACTIONS, AND THE ORDER IS THE SECURITY PROPERTY. Two of the three
 * patterns above are quadratic in the length of an unbroken whitespace-free run, and on the
 * no-report path the input is `result.stderr`, capped by the worker at 262_144 bytes - a measured
 * 218 seconds of SYNCHRONOUS CPU, on a single-threaded event loop, from untrusted tool output at a
 * trust boundary. One base64 blob or one unbroken line echoing model-written source is enough. So
 * the text handed to a regex is bounded FIRST and the regexes are left alone; bounding downstream of
 * the expensive step protects only the cheap step. Measured per 100 calls on a 4000-character
 * unbroken stderr: 5147ms redacting first, 0.3ms bounding first.
 *
 * WHY THE CUT MOVES FORWARD TO A WHITESPACE, which is not decoration either. All three patterns are
 * whitespace-free, so no match can span a space or a newline: cutting at a token boundary therefore
 * leaves every match in the window WHOLE, and each is redacted exactly as it would have been in the
 * full text. A blind `slice(-MAX)` does not have that property and was measured to LEAK - with the
 * cut inside `https://build-07.internal.example.test/jobs/42` the surviving suffix is no longer a
 * URL, so the scheme-anchored pattern no longer matches it and the text surfaces as
 * `internal.example.test<path>`, a host name this function exists to remove (Req 8.5, 11.6).
 * The price is the partial token: an over-bound tail that is ONE unbroken run keeps nothing, which
 * is the honest reading of a 2000-character blob with no readable diagnostic in it.
 *
 * THE TAIL, not the prefix, for the reason the worker records: Yosys aborts on its first fatal
 * error and the message it aborts with is the last thing it writes.
 */
function boundedTail(text: string): string {
  if (text.length <= MAX_DIAGNOSTIC_CHARS) {
    return text;
  }
  // ONE character of overlap, so the pattern can see for itself whether the cut fell inside a token
  // without a separate index peek. What survives is exactly the whole tokens that fit in the bound.
  return text.slice(-(MAX_DIAGNOSTIC_CHARS + 1)).replace(LEADING_PARTIAL_TOKEN_RE, '');
}

/**
 * The bounded, sanitized tail of an untrusted tool diagnostic, or `null` when nothing is left.
 *
 * Four things are removed, and together they are what Req 11.6 asks of this function: a stack
 * frame, a host name, an absolute path, and every Secret_Pattern_Set match (Req 11.20). The ORDER
 * of the middle three is fixed and argued at `withoutSecrets`; the bound's position relative to all
 * of them is argued at `boundedTail` and is the security property here.
 *
 * The bound is applied TWICE, and each application has its own reason. `boundedTail` bounds the
 * INPUT, which is what keeps the redactions' cost bounded and is the security property described
 * there. The `slice` below bounds the OUTPUT, which is what Req 8.4 actually asks for and is still
 * needed because redaction can GROW the text: `/a` is two characters and `<path>` is six, so a
 * path-dense window can leave more characters than it started with. It also keeps the
 * control-character filter's work bounded. Cutting there is safe in a way cutting the input is not,
 * because by then every host, path, and secret has already been replaced.
 */
function sanitizeDiagnostic(raw: string): string | null {
  const withoutFrames = raw
    .split('\n')
    .filter((line) => !STACK_FRAME_RE.test(line))
    .join('\n');
  const redacted = withoutSecrets(
    boundedTail(withoutFrames.trim())
      .replace(URL_RE, '<host>')
      .replace(USER_AT_HOST_RE, '<host>')
      .replace(ABSOLUTE_PATH_RE, '<path>'),
  );
  const bounded = withoutControlCharacters(redacted.trim().slice(-MAX_DIAGNOSTIC_CHARS)).trim();
  return bounded.length === 0 ? null : bounded;
}

/** Whether a diagnostic names a submitted file. An unnamed file matches nothing. */
function namesSubmittedFile(diagnostic: string, fileName: string): boolean {
  return fileName.length > 0 && diagnostic.includes(fileName);
}

/**
 * Attribute a failed lowering to the design under test or to our own instrument (Req 8.8, 8.9).
 *
 * The design file yields `frontend-rejected`; the wrapper file, or a diagnostic naming neither,
 * yields `property-build-failed`. The asymmetry is the requirement's own reasoning and it matters:
 * attributing an unattributable build failure to the design under test would blame the artifact
 * for our instrument, which is the wrong direction to be wrong in. A diagnostic naming BOTH files
 * is attributable to neither, so it falls the same way.
 */
function attributeLoweringFailure(diagnostic: string, run: FormalRunContext): CouldNotVerifyCause {
  const design = namesSubmittedFile(diagnostic, run.designFileName);
  const wrapper = namesSubmittedFile(diagnostic, run.wrapperFileName);
  return design && !wrapper ? 'frontend-rejected' : 'property-build-failed';
}

/** One recognized `Status:` string, or `null` for absent and for anything unmeasured. */
function measuredStatus(raw: string | null): MeasuredStatus | null {
  return MEASURED_STATUSES.find((status) => status === raw) ?? null;
}

/**
 * What the antecedent Cover_Check established (Req 5.3, 5.4, 5.5, 5.10).
 *
 * `not-applicable` comes from the PROPERTY and never from the report: a property with no
 * antecedent has no cover in its wrapper, so the condition is satisfied without a Cover_Check
 * having run. `coveredAntecedent` is the single owner of that question, shared with the renderer
 * that emits the cover, so the two cannot drift.
 *
 * A reached cover is recognized by its STEP, which is the only thing the report says only when
 * the cover was reached: the worker emits `reachedStep` solely from "Reached cover statement in
 * step N", and the unreached case prints "Unreached cover statement" with no step. The step is
 * carried through rather than defaulted, because Req 5.5 records the step a cover was reached at
 * and a defaulted step would be a number nobody measured.
 *
 * Everything else - unreached, absent, or a check that never ran - is `reached: false`. Two facts
 * are collapsed there and both deliberately: an unreachable antecedent and one whose first
 * reachable step merely exceeds the depth used are not distinguishable from one Cover_Check at
 * one depth (Req 5.4, `counter_12`'s `out == 11` is reached at step 13 and reports unreached at
 * every depth below 14), and `CoverCondition` has no `not-run` member, so a cover that applies
 * but never ran records the only non-admitting value there is. That is the fail-safe direction:
 * `reached: false` cannot admit a proof, and the result's `cause` carries what actually happened -
 * `reportedReachability` is what keeps a cover that ANSWERED NOTHING out of `antecedent-unreached`,
 * so the collapse here costs no attribution (Req 5.12).
 *
 * UNCHANGED BY TASK 5.2, deliberately, and the reason is measured: the condition is read from the
 * reached STEP and never from the `-c` mode `Status:` string, because that string reports `FAILED`
 * both for an unreached cover AND for an assert failing on a covering path that printed
 * `Reached cover statement in step 1` in the same run - one string over two opposite facts.
 */
function coverCondition(property: FormalProperty, check: FormalCheckReport | null): CoverCondition {
  if (coveredAntecedent(property) === null) {
    return { reached: 'not-applicable' };
  }
  const step = check?.reachedStep;
  return step === undefined ? { reached: false } : { reached: true, step };
}

/**
 * What the Base_Check established: the fifth condition, and the only source of `refuted` (Req 4.9).
 *
 * A check with no recognized `Status:` is `not-run`, never defaulted to `passed`. That direction is
 * the whole point: `passed` would restore the measured false proof the condition exists to close -
 * `initial out = 4'd15` against `out <= 11` reports `Temporal induction successful` and
 * `Status: PASSED` at depths 5, 20, and 40 while plain BMC reports `Status: FAILED` at all three.
 */
function baseCondition(check: FormalCheckReport): ProofConditions['base'] {
  const status = measuredStatus(check.status);
  return status === null ? 'not-run' : BASE_FOR_STATUS[status];
}

/**
 * What the Induction_Check established (Req 4.2, 4.3).
 *
 * `successful` requires BOTH `Status: PASSED` and a reported temporal-induction success.
 * A bounded pass reports `PASSED` and prints no induction line, and that is exactly the measured
 * hole: plain BMC passed the `JC_counter` mutant `!Q[0]` -> `!Q[1]` at depths 20, 64, AND 66 and
 * failed only at 70. So `PASSED` without the induction line is `inconclusive`, never `successful`.
 *
 * REQUIRING THE STATUS AS WELL AS THE LINE IS LOAD-BEARING, not belt-and-braces. This report is
 * untrusted text, so a document carrying `status: 'FAILED'` beside `inductionSuccessful: true` is
 * representable, and reading the line alone would admit it as a fifth condition satisfied. Folding
 * the status in HERE rather than re-reading it beside the `proved` return is what lets that return
 * rest on the conditions alone and keeps the gate's answer unraced.
 */
function inductionCondition(check: FormalCheckReport): ProofConditions['induction'] {
  const status = measuredStatus(check.status);
  if (status === null) {
    return 'not-run';
  }
  const established = INDUCTION_FOR_STATUS[status];
  return established === 'successful' && check.inductionSuccessful !== true
    ? 'inconclusive'
    : established;
}

/**
 * Whether one check's Solver_Cross_Check DISAGREES with the main run it audits (Req 4.16).
 *
 * `false` for a check that was not audited, which is the ordinary shape: the worker audits only a
 * check whose own result was `PASSED`-shaped, so an absent `crossCheck` is "not audited" and never
 * "audited and silent".
 *
 * The `Status:` strings are compared RAW rather than through `measuredStatus`, so two identical
 * unrecognized statuses read as agreement - what they say is then classified once, as
 * `toolchain-unavailable`, rather than twice. The induction line is compared as well, because on
 * the induction check the status alone is not the whole result: a bounded pass and an unbounded
 * proof both report `PASSED`, so two solvers could agree on the string while disagreeing about the
 * one fact `proved` rests on. A report where only ONE side carries that line is a shape we do not
 * recognize, and `!==` reads it as a disagreement, which is the fail-safe direction.
 */
function crossCheckDisagrees(check: FormalCheckReport): boolean {
  const cross = check.crossCheck;
  if (cross === undefined) {
    return false;
  }
  return cross.status !== check.status || cross.inductionSuccessful !== check.inductionSuccessful;
}

/**
 * Whether ANY check's audit disagreed. Over every entry, so a fifth check is covered.
 *
 * The Cover_Check is EXEMPT where the Base_Check failed. Cover mode's `Status:` string is
 * overloaded at its source: `yosys-smtbmc` breaks out of its loop on a failed assertion before it
 * can report every cover reached, so `FAILED` means "a cover was unreached" OR "every cover was
 * reached and an assertion failed on the covering path". Only the second is possible once the base
 * check failed, so two solvers printing different strings there have not disagreed about anything.
 *
 * Where the base PASSED, no assertion can fail on that path, so a differing cover status can only
 * be a real reachability disagreement. That is the case gating `proved`, and the audit stays fully
 * active for it. See `design-answers.md` Q1 of the `refutation-lost-to-cover-cross-check` spec.
 */
function solversDisagreed(checks: FormalChecksReport, baseFailed: boolean): boolean {
  const names = Object.keys(checks) as readonly (keyof FormalChecksReport)[];
  return names.some(
    (name) => !(baseFailed && name === 'cover') && crossCheckDisagrees(checks[name]),
  );
}

/**
 * Whether the Cover_Check actually ANSWERED the reachability question (Req 5.12).
 *
 * An unanswered question is not an unreached antecedent, so a cover that never ran, or that ran and
 * produced output nothing could be read from, is `toolchain-unavailable` rather than
 * `antecedent-unreached`.
 *
 * THE ANSWER IS READ FROM `coverAnswered` AND FROM NO `Status:` STRING AT ALL. The worker records
 * whether the cover analysis printed a `Reached` or `Unreached cover statement` line, which is the
 * only fact that separates the three outcomes of one question - reached at step N, answered
 * UNREACHED, answered NOTHING - out of the two fields a report can carry. `reachedStep` alone
 * cannot: it is absent for the second and the third alike. The `-c` mode `Status:` string cannot
 * either, in EITHER direction: it reports `FAILED` both for an unreached cover and for an assert
 * failing on a covering path that printed `Reached cover statement in step 1` in the same run, so
 * its value carries no answer, and reading its mere presence would call a cover that completed and
 * printed neither line "answered" - which is the wrong side of 5.12.
 *
 * `exitCode !== null` is a CONSISTENCY GUARD on untrusted text and not a second reading of the
 * answer. A cover the lowering left unrun reports a null exit code and carries no `coverAnswered`
 * at all, so the conjunction is redundant on every document the worker writes - but this is a file
 * crossing a trust boundary, `coverAnswered: true` beside `exitCode: null` is representable, and
 * that document claims a check both did not run and printed a line. Treating it as UNANSWERED is
 * the fail-safe reading: it reports our instrument rather than attributing an unreached antecedent
 * to the design.
 */
function reportedReachability(check: FormalCheckReport): boolean {
  return check.exitCode !== null && check.coverAnswered === true;
}

/**
 * Whether a Cover_Check names a reached step the invocation that reported it CANNOT have reached
 * (Req 11.19, 11.10).
 *
 * `yosys-smtbmc -c` searches to the depth it was given and prints `Reached cover statement in step
 * N` only for an N strictly BELOW that depth, so `step >= depth` is a relation the real tool cannot
 * produce. The report schema cannot refuse it: `reachedStep` is bounded only by `minimum: 0`, and
 * the depth is not in the document for a cross-field bound to be written against. So the relation
 * has to be checked here, against the depth the caller already carries on `FormalRunContext`.
 *
 * It matters because the step is not inert. Req 4.6 makes the Proof_Depth a function of a known
 * cover step - a depth GREATER than it - so a document naming an impossible step is a document
 * that drives a depth decision no legitimate run could have produced, and `coverCondition` admits
 * it as reached on PRESENCE alone, which is the right rule for the three outcomes it separates and
 * no place to check an arithmetic relation against a value it is not given.
 *
 * `>=` and not `>`: a cover reached AT the depth is already impossible, and that boundary is the
 * one a forged document would sit on.
 *
 * An ABSENT step is not impossible - it is the ordinary shape of an unreached cover, and of a
 * property with no antecedent to cover - so it passes here and is read by `coverCondition` as it
 * always was.
 */
function impossibleCoverStep(check: FormalCheckReport, depth: number): boolean {
  const step = check.reachedStep;
  return step !== undefined && step >= depth;
}

/**
 * The five conditions as recorded, for EVERY run whatever its verdict (Req 2.7).
 *
 * With no report there is no evidence, so the count is zero (Req 2.8: an absent count reads as
 * zero, never as a satisfied precondition) and all three solver checks are `not-run` - the base
 * case included, because a run we have no report for is a run whose base case we did not witness.
 * The cover still comes from the property, because "this property has no antecedent" is a fact
 * about the property and stays true of a run that never happened.
 */
function proofConditionsFor(
  property: FormalProperty,
  report: FormalReport | null,
): ProofConditions {
  if (report === null) {
    return {
      assertionCount: 0,
      presat: 'not-run',
      cover: coverCondition(property, null),
      base: 'not-run',
      induction: 'not-run',
    };
  }
  const presat = measuredStatus(report.checks.presat.status);
  return {
    assertionCount: report.assertionCount,
    presat: presat === null ? 'not-run' : PRESAT_FOR_STATUS[presat],
    cover: coverCondition(property, report.checks.cover),
    base: baseCondition(report.checks.base),
    induction: inductionCondition(report.checks.induct),
  };
}

/**
 * Whether every condition the fixed order places AHEAD of the Base_Check is satisfied.
 *
 * Asked by handing the OWNER of the order the same conditions with the base case and the induction
 * step REPLACED by their admitting values: `admitProved` admits that value if and only if its first
 * three conditions hold, so this re-derives no part of the order and cannot drift from it. Testing
 * the count, the presat, and the cover here instead would give the fixed order a second owner,
 * which is the defect class `conditions.ts` exists to remove.
 *
 * Why it is needed at all: `admitProved` returns the FIRST failing cause, and a `failed` base case
 * and a `not-run` presat both report `toolchain-unavailable`, so the cause alone cannot say how far
 * the order got - and Property 6 makes `refuted` conditional on exactly that.
 */
function reachedBaseCondition(conditions: ProofConditions): boolean {
  return (
    typeof admitProved({ ...conditions, base: 'passed', induction: 'successful' }) !== 'string'
  );
}

/**
 * Whether the gate got as far as weighing the Induction_Check: the four conditions ahead of it
 * hold, so any refusal it returned can only have come from the induction step.
 *
 * Stated in terms of the condition before it, which is what the fixed order says: the induction
 * condition is reached exactly when the base-case condition was reached AND passed.
 */
function reachedInductionCondition(conditions: ProofConditions): boolean {
  return conditions.base === 'passed' && reachedBaseCondition(conditions);
}

/**
 * The gate's refusal, with the two induction failures named apart (Req 4.11, 4.12).
 *
 * The gate's own answer STANDS unless the one thing it structurally cannot see applies: the
 * Induction_Check's raw reported `FAILED` over a PASSING base case.
 * `ProofConditions['induction']` records what the check ESTABLISHED rather than the string it
 * printed, so `admitProved` cannot tell a reported failure from a bounded pass and calls both
 * `induction-inconclusive`. They are different facts with different remedies:
 * `induction-inconclusive` names a depth that was too shallow and the remedy is more depth, while
 * `induction-engine-incomplete` names an incompleteness in `yosys-smtbmc`'s k-induction - it emits
 * no simple-path constraints - which NO depth is known to repair, and the tool's own `Loop
 * detected, increasing induction depth will not help` message printed on none of the measured
 * failing cases, so there is no signal separating the two.
 *
 * `reachedInductionCondition` is required and not decoration: without it a `FAILED` induction under
 * contradictory assumptions or an unreached antecedent would report the engine instead of the
 * earlier condition, breaking the fixed order Req 1.7 requires.
 */
function namedInductionFailure(
  refusal: CouldNotVerifyCause,
  conditions: ProofConditions,
  induct: FormalCheckReport,
): CouldNotVerifyCause {
  const engineIncomplete =
    reachedInductionCondition(conditions) && measuredStatus(induct.status) === 'FAILED';
  return engineIncomplete ? 'induction-engine-incomplete' : refusal;
}

/**
 * The fields every `PropertyResult` member carries, whatever the verdict (Req 4.4, 7.5, 6.14).
 *
 * Typed to the two fields it READS rather than to the whole `FormalRunContext`, so
 * `refusedWithoutProof` below can call it for a refusal that has no submitted wrapper to name.
 */
function runFields(
  property: FormalProperty,
  run: Pick<FormalRunContext, 'depth' | 'elapsedMs'>,
): Pick<PropertyResult, 'depth' | 'elapsedMs' | 'criterionRef'> {
  return { depth: run.depth, elapsedMs: run.elapsedMs, criterionRef: property.criterionRef };
}

/**
 * A `could-not-verify` reported AHEAD of the whole fixed order, with NO Proof_Condition evaluated.
 *
 * WHY THIS LIVES HERE AND NOT IN THE ADAPTER (Req 1.18). Criterion 1.18 makes a
 * Reset_Contract_Prepass refusal - `reset-contract-unresolved` or `clock-contract-unsupported` -
 * reportable BEFORE the fixed condition order runs, with no Proof_Condition taken over the
 * candidate design, because no Property_Wrapper exists for one to be taken over. But
 * `PropertyResult`'s `could-not-verify` member REQUIRES a `ProofConditions`, so "no condition was
 * evaluated" still has to be WRITTEN DOWN as a value - and that value is not the adapter's to
 * invent. `proofConditionsFor(property, null)` is already the single owner of "the conditions for a
 * run we have no report from": every solver check `not-run`, the count zero (Req 2.8), and the
 * cover taken from the PROPERTY, because "this property has no antecedent" stays true of a run that
 * never happened. An adapter assembling that record by hand would be a second owner of the reading,
 * which is the defect class this module's header exists to refuse.
 *
 * The same shape serves the adapter's OWN pre-proof refusals, and they are its own to report
 * because they are not gate facts: a Property_Time_Budget already spent (Req 7.1 puts the budget on
 * the Formal_Oracle) and a job the seam schema rejected, which is `property-build-failed` because
 * an invocation we could not even assemble is a fact about our instrument and never about the
 * design (Req 8.9).
 *
 * `depth` is the caller's, because the two cases differ: a pre-pass refusal ran no invocation at
 * any depth and reports 0, while a budget spent mid-escalation reports the deepest depth attempted.
 * `rawDiagnostic` is UNTRUSTED tool output and is sanitized here by the same bounded, redacting
 * path every other diagnostic on a `PropertyResult` takes (Req 8.4, 8.5, 11.6); pass `''` where
 * there is no tool output to surface.
 */
export function refusedWithoutProof(
  cause: CouldNotVerifyCause,
  property: FormalProperty,
  run: Pick<FormalRunContext, 'depth' | 'elapsedMs'>,
  rawDiagnostic: string,
): PropertyResult {
  return {
    verdict: 'could-not-verify',
    cause,
    conditions: proofConditionsFor(property, null),
    diagnostic: sanitizeDiagnostic(rawDiagnostic),
    // No invocation ran, so no audit ran to disagree.
    crossCheckDisagreed: false,
    ...runFields(property, run),
  };
}

/**
 * The `refuted` result for a FAILED Base_Check, or `null` when its Counterexample is absent.
 *
 * Req 1.10 requires a `refuted` outcome to CARRY the Counterexample the refutation was reported
 * with, and `PropertyResult` makes that structural: a `refuted` without one does not type-check.
 * So when the run registered no counterexample artifact there is no `refuted` to report, and the
 * caller falls to `could-not-verify` with `toolchain-unavailable` (Req 1.17). That is the fail-safe
 * direction and it fails LOUDLY: a refutation whose evidence we cannot hand back is a gap in our
 * own instrument, not a finding about the design, and reporting it as a bare verdict would satisfy
 * the requirement's letter while dropping the one thing that makes a refutation actionable.
 *
 * The artifact read is the BASE CASE's trace specifically. The worker dumps a trace on every
 * invocation and registers each under its own filename, EXCEPT the base case's, which it registers
 * under `COUNTEREXAMPLE_ARTIFACT_KEY` precisely because this function reads that key - so the one
 * check whose counterexample can source a refutation is the one whose trace arrives here.
 */
function refutation(
  result: SandboxResult,
  conditions: ProofConditions,
  property: FormalProperty,
  run: FormalRunContext,
): PropertyResult | null {
  const counterexample = result.artifacts[COUNTEREXAMPLE_ARTIFACT_KEY];
  if (counterexample === undefined) {
    return null;
  }
  return { verdict: 'refuted', counterexample, conditions, ...runFields(property, run) };
}

/**
 * Turn one formal invocation into one `PropertyResult`. Pure, total, never throws.
 *
 * `report` is `null` for every shape of missing evidence at once: a `SandboxResult` the runner
 * classified `error`, a missing `formalReport` artifact, and a report that failed schema
 * validation (Req 11.8, 11.13).
 */
export function interpretFormalReport(
  result: SandboxResult,
  report: FormalReport | null,
  property: FormalProperty,
  run: FormalRunContext,
): PropertyResult {
  const conditions = proofConditionsFor(property, report);
  const diagnostic = sanitizeDiagnostic(
    report === null ? result.stderr : report.lowering.stderrTail,
  );
  const couldNotVerify = (
    cause: CouldNotVerifyCause,
    crossCheckDisagreed = false,
  ): PropertyResult => ({
    verdict: 'could-not-verify',
    cause,
    conditions,
    diagnostic,
    crossCheckDisagreed,
    ...runFields(property, run),
  });

  if (report === null) {
    return couldNotVerify(result.timedOut ? 'proof-timeout' : 'toolchain-unavailable');
  }
  // The Tool_Runner's kill is read AHEAD of any lowering failure the same invocation reported
  // (Req 7.23). A lowering our wall clock stopped exits non-zero, so the other order hands its
  // stderr to `attributeLoweringFailure` and reports `frontend-rejected`, blaming the candidate
  // design - and recording it as quarantined - for a budget of ours.
  // UNREACHABLE TODAY: the adapter reads no report for a Tool_Runner `error` result and a killed
  // run is one, so `timedOut` reaches here only beside a `null` report, which the check above
  // already answers. Fixed BEFORE it becomes reachable, because a partial report on a killed run
  // is a change somewhere else entirely, and it must not have to remember this ordering.
  if (result.timedOut) {
    return couldNotVerify('proof-timeout');
  }
  if (report.lowering.exitCode !== 0) {
    return couldNotVerify(attributeLoweringFailure(report.lowering.stderrTail, run));
  }
  // A report whose cover step is impossible is REJECTED before any of the five conditions is read
  // off it (Req 11.19, 11.10). Ahead of the gate, because reading a condition out of a document we
  // have judged corrupt is the thing being refused; behind the three checks above, because each of
  // those is a fact about the run that carries its own attribution.
  if (impossibleCoverStep(report.checks.cover, run.depth)) {
    return couldNotVerify('toolchain-unavailable');
  }

  // The owner of the five-condition rule decides. Everything below reads its answer.
  const admission = admitProved(conditions);
  if (admission === 'zero-assertions') {
    return couldNotVerify(admission);
  }
  if (solversDisagreed(report.checks, conditions.base === 'failed')) {
    return couldNotVerify('toolchain-unavailable', true);
  }
  // Keyed on the cause rather than on the condition, and unambiguously so: `antecedent-unreached`
  // is returned from exactly one place in `admitProved`, so reading it back means the count and the
  // presat held and the cover did not reach. All that is left to ask is whether it ANSWERED.
  if (admission === 'antecedent-unreached' && !reportedReachability(report.checks.cover)) {
    return couldNotVerify('toolchain-unavailable');
  }
  if (conditions.base === 'failed' && reachedBaseCondition(conditions)) {
    return refutation(result, conditions, property, run) ?? couldNotVerify('toolchain-unavailable');
  }
  if (typeof admission === 'string') {
    return couldNotVerify(namedInductionFailure(admission, conditions, report.checks.induct));
  }
  return { verdict: 'proved', evidence: admission, ...runFields(property, run) };
}
