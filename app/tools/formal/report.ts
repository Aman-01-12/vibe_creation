// The `formal-report.json` the sandbox worker writes, its JSON Schema, and the ONE validating
// parse that turns its untrusted text into a `FormalReport` or a named rejection
// (design.md Component 2's report shape; Req 11.10, 2.8).
//
// WHY THIS IS A PARSE AND NOT A CAST
//   The report is a FILE, written inside a sandbox workspace by a separate process in another
//   language, and it is the evidence a `Verified` label is derived from. Req 11.10 makes the rule
//   explicit: every byte of Tool_Runner output is untrusted, and a Formal_Verdict may be derived
//   from it only through a parse that REJECTS what it does not recognize. So the schema is closed
//   (`additionalProperties: false` at every level) and the parse returns a `Result`, never a
//   partially-trusted object.
//
// WHAT THE SCHEMA IS MIRRORED FROM, EXACTLY
//   `eda.py`'s `_write_formal_report`, `_SmtBmcCheck.as_dict`, and `_CrossCheck.as_dict` are the
//   ground truth, not design.md's illustrative snippet - which predates the worker's rework and
//   shows neither `tracePath` nor `crossCheck`. Five facts about the real payload drive the shape
//   below:
//     1. `assertionCount` is written on EVERY run, including as 0. The guard must never be able
//        to read an absent count as a satisfied one (Req 2.7, 2.8), so it is REQUIRED here.
//     2. `checks` always carries exactly FOUR entries - `presat`, `base`, `cover`, and `induct` -
//        because the worker builds the map from its own `_SMTBMC_CHECKS` tuple and its not-run
//        path fills every entry. All four are required: a check that could not run is REPORTED
//        as not-run rather than omitted, so an absent key is a report we do not recognize. The
//        keys are listed in the worker's RUN order; the gate's EVALUATION order is a different
//        order and lives in `conditions.ts`, which is its single owner.
//     3. `exitCode` (on the lowering and on each check) and `status` are NULLABLE. `exit_code` is
//        `int | None`, null exactly when the check did not run because no SMT2 was written, and
//        `status` is null when no `Status:` line could be parsed. Making either non-nullable
//        would reject the honest "this check did not run" report.
//     4. `reachedStep`, `coverAnswered`, `inductionSuccessful`, `tracePath`, and `crossCheck` are
//        emitted ONLY where they apply - the cover check, the cover check, the induction check, a
//        check that wrote a counterexample trace, and a check whose own result was `PASSED`-shaped
//        - so the presence of the field is itself information. They are therefore optional, and
//        each is declared on ONLY the checks that can carry it: a `reachedStep` on `presat` is a
//        report we do not recognize, and neither is an `inductionSuccessful` on a cross-check of
//        the cover. `coverAnswered` is the exception to "presence is the information": it is
//        present on any cover check that RAN, and its VALUE is what says whether the analysis
//        answered.
//     5. `crossCheck` is a DISTINCT shape rather than a nested check: it adds `solver`, because
//        the whole value of an audit is which solver said this (Req 4.15), and it carries no
//        `reachedStep`, because a differing cover step changes no verdict while a differing
//        induction line changes `proved`. It cannot nest a cross-check of its own, which makes
//        "an audit of an audit" unrepresentable rather than merely never built.
//
// WHAT THE SCHEMA DELIBERATELY DOES NOT CLOSE
//   The `Status:` string is validated as a string and NOT against the measured vocabulary
//   (`PASSED`, `FAILED`, `PREUNSAT`). That is not an oversight: Req 1.9 requires an unparseable
//   or unrecognized `Status:` to become `could-not-verify` with `toolchain-unavailable`, which
//   means the value has to SURVIVE the parse and be classified. Rejecting the whole document
//   would also throw away the assertion count, which is the one fact that does not depend on the
//   solver. Shape is the schema's job; closing the status vocabulary is `interpret.ts`'s.
//
// THE ajv STRICT-MODE TRAP THIS SCHEMA IS WRITTEN AROUND
//   The instance below is built with `strict: true`, matching `../sandbox/validation.ts`, and
//   `strict: true` turns `strictRequired` ON: every name in a `required` must be declared in the
//   `properties` of THE SAME subschema. A violation throws at ajv COMPILE time, which is module
//   load, so the failure shape is a suite reporting "0 test" rather than a failing assertion
//   (`chipAgent/_inbox/gotcha-ajv-strictrequired-refuses-required-in-a-then-branch.md`). Every
//   `required` here names only properties its own subschema declares, and there is no `if`/`then`
//   anywhere, so the rule is satisfied structurally rather than by care.
//
// Pure and total: no model call, and no file, network, clock, or random-source read. The file is
// read by the caller; this module only parses the text it is handed, and never throws on it.

import { Ajv } from 'ajv';
import type { ErrorObject, SchemaObject, ValidateFunction } from 'ajv';

import { err, ok, type Result } from '@app/core';

/**
 * One check's Solver_Cross_Check: the same invocation re-run under the other solver (Req 4.15).
 *
 * Present only where the main run's own result was `PASSED`-shaped, so its ABSENCE says "this
 * check was not audited" with no sentinel value. NO COMPARISON IS RECORDED HERE, deliberately:
 * both results travel side by side and `interpret.ts` decides what a disagreement means, because
 * a worker that reconciled them would be fitting the evidence to the solver choice (Req 4.16).
 */
export interface FormalCrossCheckReport {
  /** Which solver produced this result. An audit with no solver beside it is a reconciliation. */
  readonly solver: string;
  /** The audit's process exit code; `null` where it did not run. */
  readonly exitCode: number | null;
  /** The audit's parsed `Status:` string; `null` when none could be parsed. */
  readonly status: string | null;
  readonly elapsedMs: number;
  /**
   * Whether THIS solver reported temporal-induction success. Present only on an audit of the
   * induction check, which is the one check where the status alone is not the whole result: a
   * bounded pass and an unbounded proof both report `PASSED`, so a status-only audit could read
   * as agreement while the two solvers disagreed about the one fact `proved` rests on.
   */
  readonly inductionSuccessful?: boolean;
  /** The trace this re-run wrote, or absent where it wrote none. Recorded, not read. */
  readonly tracePath?: string;
}

/** One `yosys-smtbmc` check's reported facts, as the worker writes them. No verdict. */
export interface FormalCheckReport {
  /** The check's process exit code; `null` exactly when the check did not run. */
  readonly exitCode: number | null;
  /** The parsed `Status:` string; `null` when none could be parsed. Not yet a vocabulary. */
  readonly status: string | null;
  readonly elapsedMs: number;
  /** The step a cover was reached at. Present only on the cover check, and only when reached. */
  readonly reachedStep?: number;
  /**
   * Whether the cover analysis printed EITHER cover line. Present only on the cover check.
   *
   * THE ONE OPTIONAL FIELD WHOSE `false` MEANS SOMETHING. `reachedStep` is absent both for a
   * cover that answered `Unreached cover statement` and for one that printed neither line, so the
   * step alone makes two OPPOSITE facts the same document. This field separates them, which is
   * what lets `interpretFormalReport` report an unanswered reachability question as
   * `toolchain-unavailable` rather than as an unreached antecedent (Req 5.12) - an unanswered
   * question is not an unreached antecedent.
   *
   * Absent on a cover check the lowering left unrun, where the exit code is `null` too.
   */
  readonly coverAnswered?: boolean;
  /** Whether temporal induction reported success. Present only on the induction check. */
  readonly inductionSuccessful?: boolean;
  /**
   * The counterexample trace this check wrote, or absent where it wrote none.
   *
   * RECORDED HERE AND NOT READ AS THE COUNTEREXAMPLE. A refutation's evidence travels as a
   * registered artifact on the `SandboxResult`, under the key `COUNTEREXAMPLE_ARTIFACT_KEY`,
   * because that is the channel that carries a content hash a reader can resolve; this field is
   * the filename the worker chose, which is evidence about the run rather than the trace itself.
   */
  readonly tracePath?: string;
  /** The audit of this check, present only where its own result was `PASSED`-shaped. */
  readonly crossCheck?: FormalCrossCheckReport;
}

/** The Yosys lowering's reported facts. */
export interface FormalLoweringReport {
  /** Yosys's exit code. `0` is the only value that means the SMT2 lowering completed. */
  readonly exitCode: number | null;
  /** The worker's bounded, path-redacted tail of Yosys's diagnostic. Re-sanitized before use. */
  readonly stderrTail: string;
}

/**
 * The four checks, always all present: a check that could not run is reported, not omitted.
 *
 * In the worker's RUN order - presat, base, cover, induct - because this interface mirrors what
 * the worker wrote. The gate weighs them in a different order (presat, cover, BASE, induction),
 * and `conditions.ts` is the single owner of that one.
 */
export interface FormalChecksReport {
  readonly presat: FormalCheckReport;
  /** Plain BMC from the design's real reset state: the ONLY admissible source of `refuted`. */
  readonly base: FormalCheckReport;
  readonly cover: FormalCheckReport;
  readonly induct: FormalCheckReport;
}

/** One formal run's reported facts, validated. Carries no verdict: `interpret.ts` decides. */
export interface FormalReport {
  readonly lowering: FormalLoweringReport;
  readonly assertionCount: number;
  readonly checks: FormalChecksReport;
}

/**
 * The accepted size of one report document, in characters.
 *
 * Checked BEFORE `JSON.parse`, so an oversized blob is refused rather than turned into a parse
 * tree first. The realistic upper bound on a well-formed report is the worker's own
 * `MAX_STDERR_TAIL_CHARS` (4096) plus a few hundred characters of numbers and keys, so 64 KiB is
 * roughly fifteen times the widest honest report while still bounding the work done on a file
 * this layer does not trust. Reject rather than truncate: a truncated JSON document is not a
 * report, and repairing one would be inventing evidence.
 */
export const MAX_REPORT_CHARS = 65_536;

/**
 * Why a report text was refused. NAMED rather than boolean, because the caller records it.
 *
 * Every member falls to the same verdict - `could-not-verify` - so the names exist for the
 * reader of a failure rather than for the gate: a report we cannot read is not a verdict we may
 * interpret, whichever way it was unreadable.
 */
export type FormalReportRejection =
  | { readonly reason: 'report-too-large' }
  | { readonly reason: 'not-json' }
  | { readonly reason: 'schema-violation'; readonly issues: readonly string[] };

/**
 * The fields every invocation reports, main run and audit alike. Spelled once, so the two shapes
 * cannot drift in what they share while still differing in what only one of them carries.
 */
const INVOCATION_PROPERTIES: Readonly<Record<string, SchemaObject>> = Object.freeze({
  exitCode: { type: ['integer', 'null'] },
  status: { type: ['string', 'null'] },
  elapsedMs: { type: 'integer', minimum: 0 },
});

/** The names of those fields, as the `required` list. Derived, so it cannot fall behind. */
const INVOCATION_REQUIRED: readonly string[] = Object.keys(INVOCATION_PROPERTIES);

/**
 * A written trace's workspace-relative filename. Shape only, and unbounded HERE on purpose:
 * `MAX_REPORT_CHARS` bounds the whole document before it is parsed at all, so a second length
 * bound on one field inside it would be a magic number with nothing left to protect.
 */
const TRACE_PATH_SCHEMA: SchemaObject = { type: 'string' };

/** The reported temporal-induction line, carried by the induction check and by its audit. */
const INDUCTION_SUCCESSFUL_SCHEMA: SchemaObject = { type: 'boolean' };

/**
 * The schema for one check's Solver_Cross_Check, plus the one field only some audits carry.
 *
 * `solver` is validated as a string and NOT closed to the measured value, by the same rule the
 * `Status:` string follows below: rejecting the document would also throw away the assertion
 * count, which is the one fact that depends on neither solver.
 */
function crossCheckSchema(
  conditionalProperties: Readonly<Record<string, SchemaObject>>,
): SchemaObject {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['solver', ...INVOCATION_REQUIRED],
    properties: {
      solver: { type: 'string' },
      ...INVOCATION_PROPERTIES,
      tracePath: TRACE_PATH_SCHEMA,
      ...conditionalProperties,
    },
  };
}

/**
 * The schema for one `yosys-smtbmc` check, plus the fields only that check may carry.
 *
 * A factory rather than four hand-written copies, so the four checks cannot drift in the
 * fields they SHARE while still differing in the fields the worker emits conditionally. Every
 * check may carry a `tracePath` and a `crossCheck`, because the worker dumps a trace on every
 * invocation and audits any check whose own result was `PASSED`-shaped; the conditional
 * parameter is for the fields that belong to ONE check only.
 */
function checkSchema(
  conditionalProperties: Readonly<Record<string, SchemaObject>>,
  crossCheck: SchemaObject = crossCheckSchema({}),
): SchemaObject {
  return {
    type: 'object',
    additionalProperties: false,
    required: [...INVOCATION_REQUIRED],
    properties: {
      ...INVOCATION_PROPERTIES,
      tracePath: TRACE_PATH_SCHEMA,
      crossCheck,
      ...conditionalProperties,
    },
  };
}

/**
 * The JSON Schema for `formal-report.json`, closed at every level.
 *
 * Exported so a test asserts against THIS object rather than a hand-copied restatement of it: a
 * test that re-spells the schema it checks asserts only that the schema equals itself.
 */
export const formalReportSchema: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: ['lowering', 'assertionCount', 'checks'],
  properties: {
    lowering: {
      type: 'object',
      additionalProperties: false,
      required: ['exitCode', 'stderrTail'],
      properties: {
        exitCode: { type: ['integer', 'null'] },
        stderrTail: { type: 'string' },
      },
    },
    // Required and non-negative. Zero is a legitimate, meaningful value - it is the measured
    // silent-failure trap - so it must validate and be classified, never rejected here.
    assertionCount: { type: 'integer', minimum: 0 },
    // FOUR keys, all required, in the worker's run order. `base` is the one the refutation is
    // sourced from, so a report missing it is a report from which no verdict may be read.
    checks: {
      type: 'object',
      additionalProperties: false,
      required: ['presat', 'base', 'cover', 'induct'],
      properties: {
        presat: checkSchema({}),
        base: checkSchema({}),
        // The cover check carries TWO fields about one question: the step a cover was reached
        // at, and whether either cover line was printed at all. The second exists because the
        // first cannot distinguish "answered UNREACHED" from "answered nothing" (Req 5.12).
        cover: checkSchema({
          reachedStep: { type: 'integer', minimum: 0 },
          coverAnswered: { type: 'boolean' },
        }),
        // The induction check is the one whose AUDIT also reports the induction line, because
        // `PASSED` alone does not separate a bounded pass from an unbounded proof.
        induct: checkSchema(
          { inductionSuccessful: INDUCTION_SUCCESSFUL_SCHEMA },
          crossCheckSchema({ inductionSuccessful: INDUCTION_SUCCESSFUL_SCHEMA }),
        ),
      },
    },
  },
};

// One ajv instance and one compiled validator for the process, with the same options
// `../sandbox/validation.ts` uses: `strict` surfaces schema authoring mistakes at module load,
// and `allErrors` reports every failure so a rejection lists all issues rather than only the
// first. Compiled once here rather than per call, because compiling a schema is the expensive
// part and this parse runs once per formal invocation.
const validateReport: ValidateFunction<FormalReport> = new Ajv({
  allErrors: true,
  strict: true,
}).compile<FormalReport>(formalReportSchema);

/**
 * Reduce ajv errors to sanitized `path rule` strings, copying `validation.ts`'s discipline.
 *
 * The offending VALUES are never included. This text describes a file produced inside a sandbox
 * workspace, and a value could carry a path or a fragment of a tool diagnostic, so the issue
 * list says which field broke which rule and nothing else.
 */
function summarizeIssues(errors: readonly ErrorObject[] | null | undefined): string[] {
  if (errors === null || errors === undefined) {
    return [];
  }
  return errors.map((issue) => {
    const path = issue.instancePath.length > 0 ? issue.instancePath : '(root)';
    return `${path} ${issue.message ?? 'failed validation'}`;
  });
}

/**
 * Parse and validate one `formal-report.json` text. Total: never throws, on any input.
 *
 * Three refusals in order, cheapest first: the size bound, then JSON well-formedness, then the
 * schema. A `Result` rather than `FormalReport | null`, so the caller that WANTS the reason (the
 * adapter, recording why a run produced no verdict) can have it, while the gate itself only ever
 * needs to know the report is absent.
 */
export function parseFormalReport(text: string): Result<FormalReport, FormalReportRejection> {
  if (text.length > MAX_REPORT_CHARS) {
    return err({ reason: 'report-too-large' });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    // Not a silent catch: `JSON.parse` signals malformed input by throwing and carries no other
    // channel, so the throw IS the rejection. The thrown error is deliberately not surfaced -
    // its message quotes the offending input, which is untrusted text this layer must not carry.
    return err({ reason: 'not-json' });
  }
  if (validateReport(parsed)) {
    return ok(parsed);
  }
  return err({ reason: 'schema-violation', issues: summarizeIssues(validateReport.errors) });
}
