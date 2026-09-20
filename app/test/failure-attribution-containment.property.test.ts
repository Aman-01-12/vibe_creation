// instrument-precheck-and-attribution, Property 3: Attribution is a filter of
// the caller's own paths (task 1.3).
//
// `classifyRunFailure` (`app/tools/simulator/failure-attribution.ts`) identifies
// a build failure's attributed files by MEMBERSHIP in the caller's own
// `submittedPaths`, never by extracting a path out of diagnostic text
// (design "MEMBERSHIP, NEVER EXTRACTION"; Req 2.4, 2.5, 2.6). That is a security
// property: `submittedPaths` is trusted (workspace filenames derive from the
// Spec's module name), while diagnostic text is untrusted tool output that must
// never be allowed to introduce a path of its own into a persisted record.
//
// This test builds diagnostic text designed to make that boundary as easy to
// cross as possible: absolute paths, `../`-traversal segments, and basenames
// that never appear in `submittedPaths` at all, freely mixed with lines that DO
// name a submitted file. `attributedFilesIn`'s real matching is a basename
// substring test line-anchored on `<basename>:` (see failure-attribution.ts),
// so an absolute or traversal-prefixed diagnostic line still matches on the
// submitted file's basename and correctly attributes it - the guarantee this
// property pins is narrower and stronger than "no path-shaped string reaches
// the output": every attributed entry is one of the caller's own
// `submittedPaths` strings, verbatim, never a value parsed from the diagnostic
// (so a `../../etc/passwd:1: error` line can never cause `../../etc/passwd`
// itself to appear in `attributedFiles` - only a submitted path can).
//
// Validates: Requirements 2.4, 2.5, 2.6

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { classifyRunFailure, type SandboxResult } from '@app/tools';
import { propertyParameters } from '@app/test';

const PROPERTY =
  "instrument-precheck-and-attribution, Property 3: Attribution is a filter of the caller's own paths";

// -- Generators ---------------------------------------------------------------

/** A submitted workspace path shaped like the RTL/testbench files a real job submits. */
const submittedPathArbitrary: fc.Arbitrary<string> = fc
  .tuple(fc.stringMatching(/^[a-z][a-z0-9_]{0,15}$/), fc.constantFrom('v', '_tb.v'))
  .map(([name, suffix]) => `${name}${suffix}`);

/** A non-empty, deduplicated list of submitted paths, mirroring one run's RTL + testbench. */
const submittedPathsArbitrary: fc.Arbitrary<readonly string[]> = fc.uniqueArray(
  submittedPathArbitrary,
  { minLength: 1, maxLength: 4 },
);

/**
 * A basename that is guaranteed absent from `submittedPaths`: drawn from a
 * disjoint alphabet (`x`-prefixed) so it can never collide with a generated
 * submitted path, however the run's own paths were drawn.
 */
const foreignBasenameArbitrary: fc.Arbitrary<string> = fc
  .stringMatching(/^x[a-z0-9_]{0,15}$/)
  .map((name) => `${name}.v`);

/** One diagnostic line naming `basename` at a source location, in the toolchain's own shape. */
function buildFailureLine(basename: string, line: number): string {
  return `${basename}:${line}: error`;
}

/**
 * Diagnostic text mixing four kinds of `<name>:<line>` lines around a
 * submitted file's basename, so the filter is exercised against the widest
 * plausible attempt to smuggle a path into the output:
 *
 *   1. the bare basename (the toolchain's real shape)
 *   2. the same basename behind an absolute directory prefix
 *   3. the same basename behind a `../`-traversal prefix
 *   4. an unrelated basename that never appears in `submittedPaths`
 *
 * All four are built from ONE submitted path's basename (cases 1-3) plus one
 * foreign basename (case 4), so the diagnostic both names a real submitted
 * file (exercising a true match) and a file absent from the list (exercising
 * the filter's negative case - the design's own note that Property 3 "must
 * generate diagnostics that name paths NOT in the submitted list, or the
 * filter is never exercised").
 */
function mixedDiagnosticArbitrary(
  submittedPaths: readonly string[],
): fc.Arbitrary<{ diagnostics: string; namedSubmittedPath: string }> {
  return fc
    .tuple(
      fc.constantFrom(...submittedPaths),
      foreignBasenameArbitrary,
      fc.integer({ min: 1, max: 999 }),
      fc.integer({ min: 1, max: 999 }),
    )
    .map(([namedSubmittedPath, foreignBasename, line1, line2]) => {
      const basename = namedSubmittedPath.replace(/^.*[/\\]/, '');
      const lines = [
        buildFailureLine(basename, line1),
        buildFailureLine(`/home/x/project/${basename}`, line2),
        buildFailureLine(`../../etc/${basename}`, line1),
        buildFailureLine(foreignBasename, line2),
      ];
      return { diagnostics: lines.join('\n'), namedSubmittedPath };
    });
}

/**
 * A closed run failure cause other than `build-failed`, restricted to the three
 * causes that `classifyRunFailure` ranks BEFORE it ever reaches the attribution
 * scan (`timed-out`, `disk-capped`, `output-incomplete` - see the ranking list
 * in failure-attribution.ts). `tool-failed` is deliberately excluded here: it is
 * reached only when the scan finds no match, so pairing it with a diagnostic
 * built to always name a submitted file (`mixedDiagnosticArbitrary`) would be
 * self-contradictory - that combination cannot occur in `classifyRunFailure`'s
 * own ranking, and the emptiness of `attributedFiles` on a genuine
 * `tool-failed` is instead covered by a unit example below.
 */
const nonBuildFailedCauseArbitrary: fc.Arbitrary<
  'timed-out' | 'disk-capped' | 'output-incomplete'
> = fc.constantFrom('timed-out', 'disk-capped', 'output-incomplete');

/** A `SandboxResult` shaped to force one specific pre-attribution cause, carrying the mixed diagnostic as stderr regardless. */
function nonBuildFailedResultArbitrary(stderr: string): fc.Arbitrary<SandboxResult> {
  return nonBuildFailedCauseArbitrary.map((cause) => ({
    verdict: 'error',
    timedOut: cause === 'timed-out',
    exitCode: 1,
    stdout: '',
    stderr,
    stdoutTruncated: cause === 'output-incomplete',
    stderrTruncated: false,
    diskLimitExceeded: cause === 'disk-capped',
    artifacts: {},
    deniedOperations: [],
    resourceUsage: { wallMs: 0, maxMemMb: 0, cpuMs: 0 },
  }));
}

/** A `SandboxResult` that reaches the `build-failed` branch (no kill, no truncation), carrying `stderr` verbatim. */
function buildFailedResultArbitrary(stderr: string): SandboxResult {
  return {
    verdict: 'error',
    timedOut: false,
    exitCode: 1,
    stdout: '',
    stderr,
    stdoutTruncated: false,
    stderrTruncated: false,
    diskLimitExceeded: false,
    artifacts: {},
    deniedOperations: [],
    resourceUsage: { wallMs: 0, maxMemMb: 0, cpuMs: 0 },
  };
}

// -- Property 3 -----------------------------------------------------------------

describe(PROPERTY, () => {
  it('reports only entries drawn from submittedPaths, however the diagnostics dress up other paths', () => {
    fc.assert(
      fc.property(
        submittedPathsArbitrary.chain((submittedPaths) =>
          mixedDiagnosticArbitrary(submittedPaths).map(({ diagnostics, namedSubmittedPath }) => ({
            submittedPaths,
            diagnostics,
            namedSubmittedPath,
          })),
        ),
        ({ submittedPaths, diagnostics, namedSubmittedPath }) => {
          const result = buildFailedResultArbitrary(diagnostics);
          const attribution = classifyRunFailure(result, submittedPaths);

          // Every attributed entry is an element of submittedPaths, verbatim -
          // this also rules out the foreign basename the diagnostic names,
          // since it was never a member of submittedPaths to begin with.
          for (const attributed of attribution.attributedFiles) {
            expect(submittedPaths).toContain(attributed);
          }

          // The submitted file the diagnostic actually names (via its basename,
          // absolute, and traversal-prefixed forms) is attributed: the filter is
          // non-vacuous, not merely "never wrong because it never fires".
          expect(attribution.cause).toBe('build-failed');
          expect(attribution.attributedFiles).toContain(namedSubmittedPath);
        },
      ),
      propertyParameters(),
    );
  });

  it('never attributes a path that is absent from submittedPaths, even when named at every prefix shape', () => {
    fc.assert(
      fc.property(
        submittedPathsArbitrary.chain((submittedPaths) =>
          fc
            .tuple(foreignBasenameArbitrary, fc.integer({ min: 1, max: 999 }))
            .map(([foreignBasename, line]) => ({
              submittedPaths,
              diagnostics: [
                buildFailureLine(foreignBasename, line),
                buildFailureLine(`/abs/${foreignBasename}`, line),
                buildFailureLine(`../../${foreignBasename}`, line),
              ].join('\n'),
              foreignBasename,
            })),
        ),
        ({ submittedPaths, diagnostics, foreignBasename }) => {
          const result = buildFailedResultArbitrary(diagnostics);
          const attribution = classifyRunFailure(result, submittedPaths);

          expect(attribution.attributedFiles).not.toContain(foreignBasename);
          expect(attribution.attributedFiles).not.toContain(`/abs/${foreignBasename}`);
          expect(attribution.attributedFiles).not.toContain(`../../${foreignBasename}`);
          // Nothing absent from submittedPaths can appear at all, whatever cause
          // was reached (a name absent from the list has no basename to match).
          for (const attributed of attribution.attributedFiles) {
            expect(submittedPaths).toContain(attributed);
          }
        },
      ),
      propertyParameters(),
    );
  });

  it('reports an empty attributedFiles whenever the cause is not build-failed, however the diagnostics read', () => {
    fc.assert(
      fc.property(
        submittedPathsArbitrary.chain((submittedPaths) =>
          mixedDiagnosticArbitrary(submittedPaths).chain(({ diagnostics }) =>
            nonBuildFailedResultArbitrary(diagnostics).map((result) => ({
              result,
              submittedPaths,
            })),
          ),
        ),
        ({ result, submittedPaths }) => {
          const attribution = classifyRunFailure(result, submittedPaths);

          expect(attribution.cause).not.toBe('build-failed');
          expect(attribution.attributedFiles).toEqual([]);
        },
      ),
      propertyParameters(),
    );
  });

  it('reproduces an absolute-path build diagnostic correctly attributing the submitted file by basename', () => {
    // Unit anchor: a real toolchain never emits an absolute path, but if a
    // diagnostic line names a submitted file's basename behind an absolute
    // directory prefix, `attributedFilesIn`'s substring match on `<basename>:`
    // still finds it - the module attributes the SUBMITTED path (`adder.v`),
    // never the absolute string that appeared in the diagnostic text.
    const result = buildFailedResultArbitrary('/home/x/workspace/adder.v:12: syntax error');
    const attribution = classifyRunFailure(result, ['adder.v', 'adder_tb.v']);

    expect(attribution.cause).toBe('build-failed');
    expect(attribution.attributedFiles).toEqual(['adder.v']);
    // The absolute string itself never appears; only the trusted submitted path does.
    expect(attribution.attributedFiles).not.toContain('/home/x/workspace/adder.v');
  });

  it('reproduces a traversal-prefixed diagnostic naming a path absent from submittedPaths as never attributed', () => {
    const result = buildFailedResultArbitrary('../../etc/passwd:1: error');
    const attribution = classifyRunFailure(result, ['adder.v', 'adder_tb.v']);

    // No submitted basename appears in the diagnostic, so no build failure is
    // even identified: the cause falls through to tool-failed, and either way
    // attributedFiles is empty.
    expect(attribution.cause).toBe('tool-failed');
    expect(attribution.attributedFiles).toEqual([]);
  });
});
