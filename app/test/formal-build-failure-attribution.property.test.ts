// formal-property-oracle, Properties 10, 11, and 25: a build failure decides nothing, a rejection is
// attributed, and the report parse refuses what it does not recognize (task 5.8).
//
// WHY ATTRIBUTION IS A CORRECTNESS CLAIM AND NOT A DIAGNOSTIC NICETY
//   A lowering that aborted produced no SMT2, so every condition behind it is a CONSEQUENCE rather
//   than a finding: its assertion count is zero because nothing was written, not because the solver
//   saw an empty problem. Reporting `zero-assertions` there would name a symptom and throw away the
//   one fact a reader needs - WHOSE file broke. Two frontend rejections were measured on the corpus
//   (`verified_float_multi`, `verified_synchronizer`), and calling either of them a solver problem
//   would send a student looking in the wrong place.
//   The ASYMMETRY is the requirement's own reasoning (Req 8.8, 8.9): the design file yields
//   `frontend-rejected`, and the wrapper file, BOTH files, or neither yields
//   `property-build-failed`. An unattributable build failure is charged to OUR instrument, because
//   blaming the artifact under test for a wrapper we generated is the wrong direction to be wrong in.
//
// WHAT THE ADVERSARIAL DIAGNOSTICS ARE FOR
//   The tail is untrusted text that crossed a process boundary and ends up in a log and on a screen.
//   So the generated diagnostics carry, in generated combinations: a URL whose authority is a host
//   name, a `user@host` form, an absolute filesystem path, a Python traceback with a `File "..."`
//   frame, an ANSI escape, a NUL, and a carriage return. Every one is asserted ABSENT from the
//   surfaced text by the exact token that was planted, rather than by re-spelling the redaction
//   patterns - a test that restates the regex it is checking asserts only that the code equals
//   itself.
//   The complementary half is asserted in the same breath: sanitizing must not destroy the EVIDENCE.
//   A workspace-relative filename is deliberately NOT redacted, because attribution is by that name,
//   so a diagnostic short enough to survive the bound must still carry the name it was attributed by.
//
// THE ONE PLACE THE RAW TAIL AND THE SURFACED TAIL COME APART, ASSERTED RATHER THAN ASSUMED
//   Attribution reads the RAW tail; the surfaced `diagnostic` is the sanitized, bounded TAIL of it -
//   the tail and not the prefix, because Yosys aborts on its first fatal error and that message is
//   the last thing it writes. So an over-length diagnostic is still attributed correctly while its
//   leading `ERROR:` line is legitimately gone from what a reader sees. The filename claim is
//   therefore conditioned on the tail fitting inside `MAX_DIAGNOSTIC_CHARS`, and the bound itself is
//   asserted on every case.
//
// WHY THE PARSE IS A PARSE AND NOT A CAST (Property 25)
//   `formal-report.json` is a FILE written inside a sandbox workspace by another process in another
//   language, and it is the evidence a `Verified` label is derived from. Req 11.10 permits a
//   Formal_Verdict to be derived from it only through a parse that REJECTS what it does not
//   recognize, so the schema is closed at every level and each generated mutation below is a document
//   the parse must refuse: an unknown root key, a missing check, a count that is not an integer, a
//   negative count, a `reachedStep` on the wrong check, an induction line on the wrong check, a
//   non-string diagnostic tail, and an audit of an audit. The issue list is asserted to name fields
//   and rules WITHOUT quoting values, because a value inside that document can itself be a host name
//   or a fragment of a tool diagnostic.
//
// PROPERTY 10 CLAIMS ATTRIBUTION ONLY OVER A RUN THE CLOCK DID NOT KILL (Req 7.23)
//   A lowering our own wall clock stopped exits non-zero, so a failed lowering beside `timedOut` is
//   the budget's doing and not the design's. The attribution causes (`frontend-rejected`,
//   `property-build-failed`) are therefore claimed over the UNKILLED half of the draw, and the killed
//   half claims `proof-timeout`. The verdict is `could-not-verify` in both; only the cause moves. The
//   `killedRuns > 0` non-vacuity clause moved onto the timeout branch with it. The old order is NOT
//   the fix: it reports `frontend-rejected` for a budget of ours, the blame-the-student direction.
//
// PROPERTY 25 IS EXTENDED BY TWO CLAUSES (task 20.4)
//   COVER STEP (Req 11.19, 11.10). The report schema cannot refuse a cover step at or past the depth
//   the invocation searched to - the depth is not in the document - so the parse accepts it and the
//   INTERPRETER refuses it, as `toolchain-unavailable`. Asserted over every rung depth, the exact
//   boundary, and the shapes the step must not be allowed to source: a finished proof, a refutation
//   with its counterexample registered, and the zero-assertion corner where Req 11.19 and Req 2.2
//   contradict and placement decides for 11.19. Its control is the same report with the step capped
//   to `depth - 1` (`withCoverStepBelowDepth`), counted to be not refused on some draws.
//   SECRET (Req 11.6, 11.20). Every surfaced diagnostic carries no match of the Secret_Pattern_Set,
//   asserted over the single owner's `SECRET_PATTERN_SOURCES` and over the exact token planted from
//   the SHARED generator (`generators/secrets.ts`), not a second one. The secret-named host
//   `runner@sk-AAAAAAAAAAAAAAAAAAAA.internal.example.test` is planted too and must surface as `<host>`.
//
// RUN COUNTS
//   500 for each of the three properties. Every required shape is a generated CASE KIND rather than a
//   rare coincidence - the four attribution choices are each a quarter of Property 11's sample, and
//   the five report-text kinds are each at least a ninth of Property 25's - so the rarest is ~11% and
//   the miss probability at 500 runs is ~1e-25. The one shape that is not a case kind is Property
//   10's "the four checks looked like a finished proof while the lowering failed", at ~1.1% of draws
//   by the same arithmetic `formal-zero-assertion-guard.property.test.ts` records: ~6 expected cases
//   at 500 runs and a miss probability of ~0.4%, so that property runs at 2000 instead. Recipe from
//   `chipAgent/_inbox/verification-recipe-every-row-coverage-needs-numruns-scaled-to-the-table.md`.
//
// The tag strings are literals, not `propertyTag(...)`, whose `FEATURE_TAG` is hardcoded to a
// different spec's property numbering
// (`chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`).
//
// **Validates: Requirements 1.9, 6.11, 6.12, 7.23, 8.1, 8.2, 8.3, 8.4, 8.5, 8.8, 8.9, 11.6, 11.8,
// 11.10, 11.13, 11.19, 11.20**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { SECRET_PATTERN_SOURCES } from '@app/core';
import {
  CLOCKED_DEPTH_LADDER,
  COMBINATIONAL_DEPTH,
  COUNTEREXAMPLE_ARTIFACT_KEY,
  interpretFormalReport,
  MAX_DIAGNOSTIC_CHARS,
  MAX_REPORT_CHARS,
  parseFormalReport,
  type ArtifactBlobRef,
  type FormalProperty,
  type FormalReport,
  type FormalReportRejection,
  type FormalRunContext,
  type PropertyResult,
  type SandboxResult,
} from '@app/tools';

import { arbFormalProperty, arbFormalReport } from './formal-arbitraries.js';
import { withCoverStepBelowDepth } from './formal-cover-depth.js';
import { secretShapedTokenArbitrary } from './generators/secrets.js';
import { propertyParameters } from './property.js';

// **Feature: formal-property-oracle, Property 10: A build or frontend failure decides nothing about
// the design**
const PROPERTY_10 =
  'formal-property-oracle, Property 10: A build or frontend failure decides nothing about the design';

// **Feature: formal-property-oracle, Property 11: A rejection is attributed to a named submitted
// file, and an unattributable one falls to the wrapper**
const PROPERTY_11 =
  'formal-property-oracle, Property 11: A rejection is attributed to a named submitted file, and an unattributable one falls to the wrapper';

// **Feature: formal-property-oracle, Property 25: The report parse rejects what it does not
// recognize and never throws**
const PROPERTY_25 =
  'formal-property-oracle, Property 25: The report parse rejects what it does not recognize and never throws';

/** See the RUN COUNTS note: every required shape here is a generated case kind at >= ~11%. */
const NUM_RUNS = 500;

/**
 * Property 10's rarest required shape is the proof-shaped check set, at ~1.1% of draws, and it is
 * now required in BOTH halves of the kill split, so each half sees half of it: ~0.55% of draws,
 * 22 expected at 4000 runs and a miss probability of ~3e-10 per half (it was 2000 runs for the
 * whole shape before the split).
 */
const BUILD_FAILURE_NUM_RUNS = 4_000;

/**
 * An explicit timeout, above vitest's 5s default. HEADROOM NOW, not a workaround.
 *
 * It was written for a MEASURED defect that is now FIXED: `sanitizeDiagnostic` applied its
 * redactions to the whole raw string and only then applied `MAX_DIAGNOSTIC_CHARS`, so a long
 * WHITESPACE-FREE `lowering.stderrTail` - which `arbFormalReport()` generates on about a fifth of
 * draws - cost quadratic time (84ms, 320ms, 1268ms, 5046ms per 100 calls at 500, 1000, 2000, 4000
 * characters). `interpret.ts` now bounds the text BEFORE any regex sees it, so that path costs
 * 0.003ms and this file's slowest test is a measured 166ms - 30x inside the default. The timeout
 * stays only as headroom for a 2000-run property on a shared runner; nothing here depends on it
 * (`chipAgent/_inbox/gotcha-sanitizediagnostic-redacts-before-bounding-so-a-long-unbroken-tail-is-quadratic.md`,
 * and `app/test/formal-diagnostic-bound.test.ts` is the guard that keeps the cost from returning).
 */
const SLOW_PROPERTY_TIMEOUT_MS = 30_000;

/** The two causes a failed lowering can be attributed to, and the only two it may report. */
const ATTRIBUTION_CAUSES: readonly string[] = Object.freeze([
  'frontend-rejected',
  'property-build-failed',
]);

/** Every reason the parse may refuse a report text. Closed, so a fourth fails this test. */
const DECLARED_REJECTIONS: readonly FormalReportRejection['reason'][] = Object.freeze([
  'report-too-large',
  'not-json',
  'schema-violation',
]);

/** The two submitted filenames, as a pair. Disjoint, and named by no planted payload below. */
interface SubmittedFiles {
  readonly designFileName: string;
  readonly wrapperFileName: string;
}

/**
 * The filename pairs a run can be taken under.
 *
 * Two pairs rather than one, so the attribution claim cannot be satisfied by a match against a single
 * hardcoded string. Neither name in a pair is a substring of the other, because `includes` is what
 * "names the submitted file" means and a nested name would make the `both` case unreachable.
 */
const DEFAULT_FILES: SubmittedFiles = Object.freeze({
  designFileName: 'design.v',
  wrapperFileName: 'wrapper.v',
});

const FILE_PAIRS: readonly SubmittedFiles[] = Object.freeze([
  DEFAULT_FILES,
  { designFileName: 'candidate_rtl.sv', wrapperFileName: 'formal_top.sv' },
]);

/** Which submitted files the generated diagnostic names. */
type NamedFiles = 'design' | 'wrapper' | 'both' | 'neither';

const NAMED_FILE_CHOICES: readonly NamedFiles[] = Object.freeze([
  'design',
  'wrapper',
  'both',
  'neither',
]);

/**
 * The untrusted payloads a tool diagnostic can carry, each paired with the token asserted absent.
 *
 * `leaks` is what must NOT survive into the surfaced text. It is the planted token itself rather than
 * a restatement of the redaction pattern, so this test cannot pass by agreeing with a broken regex.
 */
interface AdversarialPayload {
  readonly text: string;
  readonly leaks: readonly string[];
  /**
   * Text that must SURVIVE sanitization when the whole diagnostic fits the bound, for a payload whose
   * point is WHAT replaces the leak: a sanitizer that ate the line could not pass it.
   */
  readonly surfaces?: readonly string[];
  /** Whether the payload carries a token the Secret_Pattern_Set matches, for the non-vacuity counter. */
  readonly carriesSecret?: boolean;
}

const ADVERSARIAL_PAYLOADS: readonly AdversarialPayload[] = Object.freeze([
  {
    text: 'see https://build-07.internal.example.test/jobs/42 for the full log',
    leaks: ['internal.example.test', 'https://'],
  },
  {
    text: 'reported by runner@build-07.internal.example.test',
    leaks: ['runner@', 'internal.example.test'],
  },
  {
    // A HOST whose first label is itself secret-shaped. It fixes the Secret_Pattern_Set pass AFTER
    // the host and path redactions: run ahead of them it yields `runner@<secret>.internal.example.test`,
    // `<` is not in the host character class, and the HOST SURVIVES. It must surface as `<host>`
    // (`chipAgent/_inbox/decision-the-secret-pass-runs-after-the-host-and-path-redactions-because-secret-first-leaks-a-host.md`).
    text: 'reported by runner@sk-AAAAAAAAAAAAAAAAAAAA.internal.example.test',
    leaks: ['runner@', 'internal.example.test', 'sk-AAAAAAAAAAAAAAAAAAAA'],
    surfaces: ['reported by <host>'],
    carriesSecret: true,
  },
  {
    text: 'while reading /var/lib/formal-runner/workspace-8f21/toplevel.sv',
    leaks: ['/var/lib/formal-runner', 'workspace-8f21'],
  },
  {
    text: 'Traceback (most recent call last):\n  File "/opt/yosys/smtio.py", line 229, in <module>',
    leaks: ['Traceback (most recent call last)', 'smtio.py'],
  },
  {
    // An ANSI colour escape, a NUL, and a carriage return: terminal control a reader never typed.
    text: 'cell \u001b[31m$check$1\u001b[0m\u0000 unmapped\r',
    leaks: ['\u001b', '\u0000', '\r'],
  },
]);

/** The run context, carrying whichever filename pair the case was drawn with. */
function runContextFor(files: SubmittedFiles): FormalRunContext {
  return { depth: 20, elapsedMs: 4_321, ...files };
}

/** A run that completed or was killed, carrying the given captured stderr. */
function sandboxResult(stderr: string, timedOut: boolean): SandboxResult {
  return {
    verdict: timedOut ? 'error' : 'fail',
    timedOut,
    exitCode: timedOut ? null : 1,
    stdout: '',
    stderr,
    stdoutTruncated: false,
    stderrTruncated: false,
    diskLimitExceeded: false,
    artifacts: {},
    deniedOperations: [],
    resourceUsage: { wallMs: 10, maxMemMb: 1, cpuMs: 10 },
  };
}

/** The `ERROR:` line naming whichever submitted files the case is about. */
function namedFileLine(choice: NamedFiles, files: SubmittedFiles): string {
  switch (choice) {
    case 'design':
      return `ERROR: syntax error near token 'endmodule' in ${files.designFileName}:41`;
    case 'wrapper':
      return `ERROR: cannot resolve identifier 'cnt' in ${files.wrapperFileName}:7`;
    case 'both':
      return `ERROR: ${files.designFileName}:41 conflicts with ${files.wrapperFileName}:7`;
    default:
      // A real measured Yosys rejection that names no file at all.
      return "ERROR: Module `\\float_multi' contains unmapped cells.";
  }
}

/** A generated lowering diagnostic: the named-file line, the payloads, and an optional overflow. */
interface GeneratedDiagnostic {
  readonly names: NamedFiles;
  readonly files: SubmittedFiles;
  readonly payloads: readonly AdversarialPayload[];
  readonly overLength: boolean;
}

/**
 * The line an over-length diagnostic is padded with, repeated past `MAX_DIAGNOSTIC_CHARS`.
 *
 * A LINE-BROKEN filler rather than one long run of a single character, which is what a real Yosys
 * diagnostic looks like. It was ALSO what kept this test's cost linear while `sanitizeDiagnostic`
 * redacted ahead of its bound (a measured 12.7ms for 2000 unbroken characters against 0.1ms for the
 * same length broken into lines); that defect is FIXED - `interpret.ts` bounds the text before any
 * regex sees it - so the line breaks are now here for realism alone
 * (`chipAgent/_inbox/gotcha-sanitizediagnostic-redacts-before-bounding-so-a-long-unbroken-tail-is-quadratic.md`).
 * They also keep this case asserting something: the bound now cuts at a whitespace and drops the
 * token it would have split, so a filler with no whitespace in it would surface as nothing at all.
 * Neither the submitted filenames nor any planted leak token appears in it.
 */
const OVERFLOW_LINE = 'ERROR: unmapped cell $check$1 in the lowered model';

/** The diagnostic text one generated case carries. */
function diagnosticTextOf(generated: GeneratedDiagnostic): string {
  const lines = [
    namedFileLine(generated.names, generated.files),
    ...generated.payloads.map((payload) => payload.text),
  ];
  const body = lines.join('\n');
  if (!generated.overLength) {
    return body;
  }
  // The overflow is APPENDED, because the surfaced text is the TAIL: this is the case in which
  // attribution still succeeds off the raw tail while the named line is legitimately out of view.
  const overflowLines = Math.ceil(MAX_DIAGNOSTIC_CHARS / OVERFLOW_LINE.length) + 1;
  return [body, ...Array.from({ length: overflowLines }, () => OVERFLOW_LINE)].join('\n');
}

/**
 * A credential a tool could echo, from the SHARED secret generator, in a diagnostic line.
 *
 * `leaks` is the generated token itself, so the assertion is over the exact text planted. The
 * generator is `secretShapedTokenArbitrary` and no second one: its `AKIA` body is drawn from the
 * base32 alphabet the pattern requires, which a hand-written generator gets wrong.
 */
function arbSecretPayload(): fc.Arbitrary<AdversarialPayload> {
  return secretShapedTokenArbitrary().map((token) => ({
    text: `credential rejected: ${token} (not retried)`,
    leaks: [token],
    carriesSecret: true,
  }));
}

/** A lowering diagnostic with its provenance, so the expectation is the INTENT and not a re-read. */
function arbGeneratedDiagnostic(): fc.Arbitrary<GeneratedDiagnostic> {
  return fc.record<GeneratedDiagnostic>({
    names: fc.constantFrom(...NAMED_FILE_CHOICES),
    files: fc.constantFrom(...FILE_PAIRS),
    payloads: fc
      .tuple(
        // Spread to a mutable copy: `fc.subarray`'s parameter is `T[]`, not `readonly T[]`.
        fc.subarray([...ADVERSARIAL_PAYLOADS]),
        fc.option(arbSecretPayload(), { nil: null }),
      )
      .map(([fixed, secret]) => (secret === null ? fixed : [...fixed, secret])),
    overLength: fc.boolean(),
  });
}

/** The single owner's Secret_Pattern_Set, compiled flag-free; this file restates none of it. */
const SECRET_PATTERN_RES: readonly RegExp[] = SECRET_PATTERN_SOURCES.map(
  (source) => new RegExp(source),
);

/**
 * A lowering that FAILED: a non-zero exit code, or none at all because Yosys never reported one.
 *
 * `fc.constantFrom` carries NO explicit type argument, deliberately: its type parameter is the TUPLE
 * of values rather than the element type, so an annotation there is a compile error and the widening
 * is done by the enclosing `fc.oneof`
 * (`chipAgent/_inbox/verification-recipe-a-generator-needs-its-own-self-check-and-two-fast-check-v4-typing-traps.md`).
 */
function arbFailedLoweringExitCode(): fc.Arbitrary<number | null> {
  return fc.oneof(
    { weight: 3, arbitrary: fc.constant<number | null>(1) },
    { weight: 1, arbitrary: fc.constantFrom(2, 124, 127, -1) },
    { weight: 1, arbitrary: fc.constant<number | null>(null) },
  );
}

/** The cause of a `could-not-verify`, or `null` for any other verdict. */
function causeOf(result: PropertyResult): string | null {
  return result.verdict === 'could-not-verify' ? result.cause : null;
}

/** Whether the four checks together report what a COMPLETE PROOF looks like. */
function looksLikeAProof(report: FormalReport): boolean {
  return (
    report.checks.presat.status === 'PASSED' &&
    report.checks.base.status === 'PASSED' &&
    report.checks.cover.reachedStep !== undefined &&
    report.checks.induct.status === 'PASSED' &&
    report.checks.induct.inductionSuccessful === true
  );
}

describe(PROPERTY_10, () => {
  it(
    'decides nothing about the design when the lowering failed, whatever the checks reported',
    () => {
      let total = 0;
      let proofShapedUnkilled = 0;
      let proofShapedKilled = 0;
      let killedRuns = 0;
      const causesObserved = new Set<string | null>();
      fc.assert(
        fc.property(
          arbFormalReport(),
          arbFormalProperty(),
          arbFailedLoweringExitCode(),
          fc.boolean(),
          (
            generated: FormalReport,
            property: FormalProperty,
            exitCode: number | null,
            timedOut: boolean,
          ) => {
            total += 1;
            const report: FormalReport = {
              ...generated,
              lowering: { ...generated.lowering, exitCode },
            };
            const proofShaped = looksLikeAProof(report);
            if (timedOut) {
              killedRuns += 1;
              proofShapedKilled += proofShaped ? 1 : 0;
            } else {
              proofShapedUnkilled += proofShaped ? 1 : 0;
            }

            const result = interpretFormalReport(
              sandboxResult('', timedOut),
              report,
              property,
              runContextFor(DEFAULT_FILES),
            );
            causesObserved.add(causeOf(result));

            // NEITHER `proved` NOR `refuted`, on a killed run and an unkilled one alike (Req 8.1, 8.2).
            expect(result.verdict).toBe('could-not-verify');
            // THE CAUSE DEPENDS ON WHO STOPPED THE LOWERING, and the attribution claim is made ONLY
            // over a run the clock did not kill (Req 7.23). A lowering our wall clock stopped exits
            // non-zero, and reading that exit code first would report `frontend-rejected` for a budget
            // of ours - the design blamed, and counted as quarantined, for OUR clock. So a killed run
            // is `proof-timeout` whatever its lowering reported, and an unkilled one names a build
            // failure rather than a solver condition that is only zero because nothing was written
            // (Req 8.1, 8.2, 8.3). This property used to assert the attribution causes on EVERY draw and
            // a non-vacuity clause that REQUIRED killed runs inside that population, which is the
            // pre-7.23 order written into a test
            // (`chipAgent/_inbox/gotcha-the-req-7-23-timeout-reorder-breaks-property-10s-killed-run-non-vacuity-clause.md`).
            if (timedOut) {
              expect(causeOf(result)).toBe('proof-timeout');
            } else {
              expect(ATTRIBUTION_CAUSES).toContain(causeOf(result));
            }
          },
        ),
        propertyParameters({ numRuns: BUILD_FAILURE_NUM_RUNS }),
      );
      // Non-vacuity. The claim is "decides nothing", so the sample has to contain the reports that
      // would otherwise have decided something - including one whose four checks look like a finished
      // proof - IN BOTH HALVES of the kill split: the attribution half needs an unkilled proof-shaped
      // run, and the timeout half needs a killed one, which is the run a verdict must never be read
      // off. The killed-run clause now belongs to the timeout branch, where it is the thing asserted.
      expect(total).toBe(BUILD_FAILURE_NUM_RUNS);
      expect(proofShapedUnkilled).toBeGreaterThan(0);
      expect(proofShapedKilled).toBeGreaterThan(0);
      expect(killedRuns).toBeGreaterThan(0);
      expect(causesObserved).toEqual(new Set([...ATTRIBUTION_CAUSES, 'proof-timeout']));
    },
    SLOW_PROPERTY_TIMEOUT_MS,
  );
});

describe(PROPERTY_11, () => {
  it(
    'charges the design file only when it alone is named, and leaks no host, path, or frame',
    () => {
      let total = 0;
      let boundedTails = 0;
      let payloadCarryingCases = 0;
      const choicesObserved = new Set<NamedFiles>();
      fc.assert(
        fc.property(
          arbFormalReport(),
          arbFormalProperty(),
          arbGeneratedDiagnostic(),
          arbFailedLoweringExitCode(),
          (
            generated: FormalReport,
            property: FormalProperty,
            diagnostic: GeneratedDiagnostic,
            exitCode: number | null,
          ) => {
            total += 1;
            choicesObserved.add(diagnostic.names);
            if (diagnostic.payloads.length > 0) {
              payloadCarryingCases += 1;
            }
            const stderrTail = diagnosticTextOf(diagnostic);
            const { designFileName, wrapperFileName } = diagnostic.files;

            // The composed text is asserted to name exactly the files the case INTENDED, so a payload
            // that grew a submitted filename fails here rather than silently inverting the oracle.
            expect({
              namesDesign: stderrTail.includes(designFileName),
              namesWrapper: stderrTail.includes(wrapperFileName),
            }).toEqual({
              namesDesign: diagnostic.names === 'design' || diagnostic.names === 'both',
              namesWrapper: diagnostic.names === 'wrapper' || diagnostic.names === 'both',
            });

            const report: FormalReport = { ...generated, lowering: { exitCode, stderrTail } };
            const result = interpretFormalReport(
              sandboxResult('', false),
              report,
              property,
              runContextFor(diagnostic.files),
            );

            // THE ASYMMETRY (Req 8.8, 8.9): the design file alone is the candidate's fault; the
            // wrapper, both files, and neither are ours.
            expect({ cause: causeOf(result), names: diagnostic.names }).toEqual({
              cause: diagnostic.names === 'design' ? 'frontend-rejected' : 'property-build-failed',
              names: diagnostic.names,
            });

            const surfaced = result.verdict === 'could-not-verify' ? result.diagnostic : null;
            const shown = surfaced ?? '';
            // BOUNDED on our side of the seam, whatever the worker sent (Req 8.4).
            expect(shown.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_CHARS);
            if (diagnostic.overLength) {
              boundedTails += 1;
            }
            // NO HOST, NO ABSOLUTE PATH, NO STACK FRAME, NO TERMINAL CONTROL (Req 8.5, 11.6).
            for (const payload of diagnostic.payloads) {
              for (const leak of payload.leaks) {
                expect(shown).not.toContain(leak);
              }
            }
            // AND THE EVIDENCE SURVIVES. A workspace-relative name is deliberately not redacted,
            // because attribution is by that name; only an over-length tail may push it out of view.
            if (!diagnostic.overLength && diagnostic.names !== 'neither') {
              const named = diagnostic.names === 'wrapper' ? wrapperFileName : designFileName;
              expect(shown).toContain(named);
            }
          },
        ),
        propertyParameters({ numRuns: NUM_RUNS }),
      );
      // Non-vacuity: all four attribution choices, a real share of payload-carrying diagnostics, and
      // the over-length tail the second bound exists for.
      expect(total).toBe(NUM_RUNS);
      expect(choicesObserved).toEqual(new Set(NAMED_FILE_CHOICES));
      expect(payloadCarryingCases).toBeGreaterThan(0);
      expect(boundedTails).toBeGreaterThan(0);
    },
    SLOW_PROPERTY_TIMEOUT_MS,
  );
});

/** What a generated report text is, and therefore what the parse must do with it. */
type ReportTextKind = 'valid' | 'schema-violation' | 'not-json' | 'too-large' | 'fuzz';

const REPORT_TEXT_KINDS: readonly ReportTextKind[] = Object.freeze([
  'valid',
  'schema-violation',
  'not-json',
  'too-large',
  'fuzz',
]);

/** One generated report text with its provenance, so each kind's expectation is exact. */
interface ReportTextCase {
  readonly kind: ReportTextKind;
  readonly text: string;
}

/** A host name planted INSIDE a rejected document, to check the issue list quotes no values. */
const PLANTED_DOCUMENT_SECRET = 'internal.example.test';

/**
 * The schema violations a closed schema must refuse, one per measured way a document can be wrong.
 *
 * Each returns a plain object rather than mutating a parsed one, so no `any` enters the file and the
 * mutation is readable as the shape it produces.
 */
const SCHEMA_VIOLATIONS: readonly ((report: FormalReport) => Record<string, unknown>)[] =
  Object.freeze([
    (report) => ({ ...report, solver: 'bitwuzla' }),
    (report) => ({
      ...report,
      checks: {
        presat: report.checks.presat,
        cover: report.checks.cover,
        induct: report.checks.induct,
      },
    }),
    (report) => ({ ...report, assertionCount: 'two' }),
    (report) => ({ ...report, assertionCount: -1 }),
    (report) => ({
      ...report,
      checks: { ...report.checks, presat: { ...report.checks.presat, reachedStep: 3 } },
    }),
    (report) => ({
      ...report,
      checks: { ...report.checks, cover: { ...report.checks.cover, inductionSuccessful: true } },
    }),
    (report) => ({ ...report, lowering: { ...report.lowering, stderrTail: 42 } }),
    (report) => ({
      ...report,
      checks: {
        ...report.checks,
        base: {
          ...report.checks.base,
          crossCheck: {
            solver: 'z3',
            exitCode: 0,
            status: 'PASSED',
            elapsedMs: 1,
            crossCheck: { solver: 'bitwuzla', exitCode: 0, status: 'PASSED', elapsedMs: 1 },
          },
        },
      },
    }),
  ]);

/** Texts that are not JSON at all, including the empty one. */
const NON_JSON_TEXTS: readonly string[] = Object.freeze([
  '',
  '   ',
  '{',
  '{"lowering":',
  '[1, 2',
  'ERROR: yosys-smtbmc crashed before writing a report',
  'undefined',
]);

/** A report text of each kind, tagged with what it is. */
function arbReportTextCase(): fc.Arbitrary<ReportTextCase> {
  const planted = (report: FormalReport): FormalReport => ({
    ...report,
    lowering: {
      ...report.lowering,
      stderrTail: `ERROR: unreachable ${PLANTED_DOCUMENT_SECRET} while lowering`,
    },
  });
  return fc.oneof(
    {
      weight: 2,
      arbitrary: arbFormalReport().map((report): ReportTextCase => ({
        kind: 'valid',
        text: JSON.stringify(report),
      })),
    },
    {
      weight: 2,
      arbitrary: fc
        .tuple(arbFormalReport(), fc.constantFrom(...SCHEMA_VIOLATIONS))
        .map(([report, violate]): ReportTextCase => ({
          kind: 'schema-violation',
          text: JSON.stringify(violate(planted(report))),
        })),
    },
    {
      weight: 2,
      arbitrary: fc
        .constantFrom(...NON_JSON_TEXTS)
        .map((text): ReportTextCase => ({ kind: 'not-json', text })),
    },
    {
      weight: 1,
      // An otherwise WELL-FORMED document pushed past the size bound, which is the case that bound
      // exists for: refuse rather than truncate, because a truncated document is not a report.
      arbitrary: arbFormalReport().map((report): ReportTextCase => {
        const oversized: FormalReport = {
          ...report,
          lowering: { ...report.lowering, stderrTail: 'e'.repeat(MAX_REPORT_CHARS) },
        };
        return { kind: 'too-large', text: JSON.stringify(oversized) };
      }),
    },
    {
      weight: 1,
      arbitrary: fc
        .string({ maxLength: 64 })
        .map((text): ReportTextCase => ({ kind: 'fuzz', text })),
    },
  );
}

describe(PROPERTY_25, () => {
  it(
    'refuses what it does not recognize, never throws, and surfaces a sanitized bounded reason',
    () => {
      let total = 0;
      const kindsObserved = new Set<ReportTextKind>();
      const reasonsObserved = new Set<FormalReportRejection['reason']>();
      let acceptedCases = 0;
      let boundedTails = 0;
      let secretCasesChecked = 0;
      let hostLeakSurfaced = 0;
      fc.assert(
        fc.property(
          arbReportTextCase(),
          arbGeneratedDiagnostic(),
          fc.boolean(),
          arbFormalProperty(),
          (
            textCase: ReportTextCase,
            captured: GeneratedDiagnostic,
            timedOut: boolean,
            property: FormalProperty,
          ) => {
            total += 1;
            kindsObserved.add(textCase.kind);

            // NEVER THROWS, on any byte sequence offered as a report (Req 11.10).
            expect(() => parseFormalReport(textCase.text)).not.toThrow();
            const parsed = parseFormalReport(textCase.text);

            if (parsed.ok) {
              acceptedCases += 1;
              expect(textCase.kind).toBe('valid');
              // An accepted report is one the parse would accept again, and it carries all four
              // checks - a report missing one is a report from which no verdict may be read.
              expect(parseFormalReport(JSON.stringify(parsed.value)).ok).toBe(true);
              expect(Object.keys(parsed.value.checks).sort()).toEqual([
                'base',
                'cover',
                'induct',
                'presat',
              ]);
              expect(Number.isSafeInteger(parsed.value.assertionCount)).toBe(true);
            } else {
              reasonsObserved.add(parsed.error.reason);
              expect(DECLARED_REJECTIONS).toContain(parsed.error.reason);
              if (textCase.kind === 'schema-violation') {
                expect(parsed.error.reason).toBe('schema-violation');
              }
              if (textCase.kind === 'too-large') {
                expect(parsed.error.reason).toBe('report-too-large');
              }
              if (textCase.kind === 'not-json') {
                expect(parsed.error.reason).toBe('not-json');
              }
              if (parsed.error.reason === 'schema-violation') {
                // The issues name a field and a rule and QUOTE NO VALUES, because a value inside this
                // document can be a host name or a fragment of a tool diagnostic.
                expect(parsed.error.issues.length).toBeGreaterThan(0);
                for (const issue of parsed.error.issues) {
                  expect(issue).not.toContain(PLANTED_DOCUMENT_SECRET);
                }
              }
            }

            // A REJECTED OR ABSENT REPORT DECIDES NOTHING, and its reason is sanitized and bounded
            // (Req 1.9, 8.4, 8.5, 11.6, 11.8, 11.13). The interpreter sees every shape of missing
            // evidence as one fact - `report: null` - because `SandboxResult` cannot tell them apart.
            const stderr = diagnosticTextOf(captured);
            const result = interpretFormalReport(
              sandboxResult(stderr, timedOut),
              null,
              property,
              runContextFor(captured.files),
            );
            expect(result.verdict).toBe('could-not-verify');
            expect(causeOf(result)).toBe(timedOut ? 'proof-timeout' : 'toolchain-unavailable');
            const shown = (result.verdict === 'could-not-verify' ? result.diagnostic : null) ?? '';
            expect(shown.length).toBeLessThanOrEqual(MAX_DIAGNOSTIC_CHARS);
            if (captured.overLength) {
              boundedTails += 1;
            }
            for (const payload of captured.payloads) {
              for (const leak of payload.leaks) {
                expect(shown).not.toContain(leak);
              }
              // Only where the whole text fits the bound: an over-length tail legitimately drops
              // the payloads, and their absence then says nothing about what replaced a leak.
              for (const surfaced of captured.overLength ? [] : (payload.surfaces ?? [])) {
                expect(shown).toContain(surfaced);
                hostLeakSurfaced += 1;
              }
              secretCasesChecked += !captured.overLength && payload.carriesSecret === true ? 1 : 0;
            }
            // THE SECRET CLAUSE (Req 11.6, 11.20): for any diagnostic carrying a token the
            // Secret_Pattern_Set matches, the surfaced diagnostic carries no such token. Stated over
            // the single owner's set, so it also catches a match the planted tokens did not name.
            for (const pattern of SECRET_PATTERN_RES) {
              expect(shown).not.toMatch(pattern);
            }
          },
        ),
        propertyParameters({ numRuns: NUM_RUNS }),
      );
      // Non-vacuity: every text kind was generated, every declared rejection reason was reached, the
      // accept path ran, the over-length tail the second bound exists for appeared, a secret-bearing
      // diagnostic was sanitized, and the secret-named host surfaced as `<host>` on one that fit.
      expect(total).toBe(NUM_RUNS);
      expect(kindsObserved).toEqual(new Set(REPORT_TEXT_KINDS));
      expect(reasonsObserved).toEqual(new Set(DECLARED_REJECTIONS));
      expect(acceptedCases).toBeGreaterThan(0);
      expect(boundedTails).toBeGreaterThan(0);
      expect(secretCasesChecked).toBeGreaterThan(0);
      expect(hostLeakSurfaced).toBeGreaterThan(0);
    },
    SLOW_PROPERTY_TIMEOUT_MS,
  );
});

// ---------------------------------------------------------------------------
// Property 25, cover-step clause (Req 11.19, 11.10)
// ---------------------------------------------------------------------------

/**
 * The Proof_Depths an invocation can run at: the combinational rung and the clocked ladder.
 *
 * Read off the adapter's own constants rather than re-spelled, so a ladder that gains a rung is a
 * rung this clause meets without an edit here.
 */
const PROOF_DEPTHS: readonly number[] = Object.freeze([
  COMBINATIONAL_DEPTH,
  ...CLOCKED_DEPTH_LADDER,
]);

/** How far past the depth an impossible step is drawn; zero is the boundary a forged document sits on. */
const MAX_STEP_OVERSHOOT = 64;

/**
 * Rarest required shape: an impossible step beside a report whose other three checks look like a
 * finished proof, ~1.1% of draws (see the RUN COUNTS note), so ~22 expected at 2000 runs and a miss
 * probability of ~1e-10.
 */
const COVER_STEP_NUM_RUNS = 2_000;

/** A counterexample trace, so the clause can be asserted to hold beside a refutation-shaped report. */
const COVER_CLAUSE_TRACE: ArtifactBlobRef = Object.freeze({
  name: 'formal-trace-base-bitwuzla.vcd',
  sizeBytes: 512,
  sha256: 'd'.repeat(64),
});

/** A run that COMPLETED and was not killed, carrying a counterexample or not. */
function completedRun(withCounterexample: boolean): SandboxResult {
  return {
    ...sandboxResult('', false),
    verdict: 'pass',
    exitCode: 0,
    artifacts: withCounterexample ? { [COUNTEREXAMPLE_ARTIFACT_KEY]: COVER_CLAUSE_TRACE } : {},
  };
}

/** The report with a completed lowering and its Cover_Check answering REACHED at exactly `step`. */
function withCoverReachedAt(report: FormalReport, step: number): FormalReport {
  return {
    ...report,
    lowering: { ...report.lowering, exitCode: 0 },
    checks: {
      ...report.checks,
      cover: { ...report.checks.cover, exitCode: 0, coverAnswered: true, reachedStep: step },
    },
  };
}

describe(`${PROPERTY_25} (cover-step clause)`, () => {
  it(
    'refuses a cover step at or past its own depth as toolchain-unavailable, whatever else the report says',
    () => {
      let total = 0;
      let atTheBoundary = 0;
      let proofShaped = 0;
      let refutationShaped = 0;
      let zeroCount = 0;
      let twinNotRefused = 0;
      const depthsObserved = new Set<number>();
      fc.assert(
        fc.property(
          arbFormalReport(),
          arbFormalProperty(),
          fc.constantFrom(...PROOF_DEPTHS),
          fc.integer({ min: 0, max: MAX_STEP_OVERSHOOT }),
          fc.boolean(),
          (
            generated: FormalReport,
            property: FormalProperty,
            depth: number,
            overshoot: number,
            withCounterexample: boolean,
          ) => {
            total += 1;
            depthsObserved.add(depth);
            const impossible = withCoverReachedAt(generated, depth + overshoot);
            atTheBoundary += overshoot === 0 ? 1 : 0;
            proofShaped += looksLikeAProof(impossible) ? 1 : 0;
            refutationShaped +=
              impossible.checks.base.status === 'FAILED' && withCounterexample ? 1 : 0;
            zeroCount += impossible.assertionCount === 0 ? 1 : 0;
            const run = { ...runContextFor(DEFAULT_FILES), depth };

            const result = interpretFormalReport(
              completedRun(withCounterexample),
              impossible,
              property,
              run,
            );

            // A step no invocation of this depth can have reached is a document the real tool cannot
            // write, so NOTHING is read off it: not a proof, not a refutation, not the zero-assertion
            // override (Req 11.19 wins the one corner where it contradicts Req 2.2, by placement), and
            // not an attribution to the design. The cause is OUR instrument's.
            expect(result.verdict).toBe('could-not-verify');
            expect(causeOf(result)).toBe('toolchain-unavailable');

            // THE CONTROL: the SAME report with its step capped to `depth - 1` is not refused for its
            // step, so the refusal above comes from the step and the clause is not a blanket refusal.
            // Counted and not asserted per draw, because the twin can still read `toolchain-unavailable`
            // for one of the other conditions.
            const twin = interpretFormalReport(
              completedRun(withCounterexample),
              withCoverStepBelowDepth(impossible, depth),
              property,
              run,
            );
            twinNotRefused += causeOf(twin) === 'toolchain-unavailable' ? 0 : 1;
          },
        ),
        propertyParameters({ numRuns: COVER_STEP_NUM_RUNS }),
      );
      // Non-vacuity: every depth, the exact boundary, the Req 2.2 corner (a zero count), a report
      // that looks like a finished proof and one that looks like a refutation - the two verdicts the
      // step must not be allowed to source - and a twin that the step alone was keeping from a cause.
      expect(total).toBe(COVER_STEP_NUM_RUNS);
      expect(depthsObserved).toEqual(new Set(PROOF_DEPTHS));
      expect(atTheBoundary).toBeGreaterThan(0);
      expect(zeroCount).toBeGreaterThan(0);
      expect(proofShaped).toBeGreaterThan(0);
      expect(refutationShaped).toBeGreaterThan(0);
      expect(twinNotRefused).toBeGreaterThan(0);
    },
    SLOW_PROPERTY_TIMEOUT_MS,
  );
});
