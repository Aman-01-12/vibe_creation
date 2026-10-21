// **Feature: timing-contract-inference, source scan: no absent-consumer Port_Timing placeholder
// comment survives, and the PortTiming vocabulary stays at two members (task 9.2)**
//
// WHAT THIS FILE CHECKS, AND WHY IT IS A COMMENT-TEXT SCAN FOR HALF OF IT
//   Requirement 9.3 names three sites - the Corpus_Importer, the Spec_Agent, and the
//   Live_Wiring - and requires each to carry no comment justifying a Port_Timing placeholder by
//   the absence of a consumer. Tasks 5.2, 8.7, and 6.1 deleted the three fabricating functions
//   and their `ponytail:` comments ("nothing reads this yet", "changes no behaviour today"), but
//   nothing pins that the JUSTIFICATION LANGUAGE itself does not reappear elsewhere in those
//   files - a later edit could restate the same excuse beside a different placeholder without
//   ever naming `buildTimingContract` again. So the scan reads COMMENTS ONLY (code blanked out,
//   the same technique `live-wiring-timing-contract-source.test.ts` uses for identifiers) for the
//   shape of that excuse, rather than for the deleted identifiers.
//
// WHY THE SECOND CLAIM IS A RUNTIME CHECK, NOT MORE SOURCE TEXT
//   The `PortTiming` cardinality (Req 7.4: the vocabulary stays at exactly `registered` and
//   `combinational`) is a claim about the MODULE'S BEHAVIOUR, not its text - a source grep would
//   not catch a third member added via a second `Set` the exported type forgot to widen around.
//   `app/core` exports `isPortTiming` but not the `PORT_TIMINGS` set itself, so the cardinality is
//   derived by probing `isPortTiming` over a fixed candidate pool and counting the members it
//   accepts, through the real imported module.
//
// Validates: Requirements 9.3, 7.4

import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { isPortTiming } from '@app/core';

const SCANNED_MODULES = [
  '../eval/corpus/import.ts',
  '../agent/roles/spec/spec-agent.ts',
  '../eval/consensus-regression/live-wiring.ts',
] as const;

/** Each scanned file's source, read fresh from `.ts` so a reintroduced comment is caught pre-build. */
const SOURCES: ReadonlyMap<string, string> = new Map(
  SCANNED_MODULES.map((path) => [path, readFileSync(new URL(path, import.meta.url), 'utf8')]),
);

/** A line comment or a block comment - the only spans this scan reads. */
const COMMENT = /\/\/[^\n]*|\/\*[\s\S]*?\*\//g;

/** Every comment span of `source`, concatenated with newlines so a match cannot straddle two files. */
function commentsOf(source: string): string {
  return [...source.matchAll(COMMENT)].map((match) => match[0]).join('\n');
}

/**
 * The excuse Requirement 9.3 forbids: a placeholder justified by nothing reading it yet, paired
 * with timing/contract language so an unrelated "no consumer" comment about some other concern
 * does not false-positive.
 *
 * Two independent clauses, both required, rather than one long alternation: the "absent consumer"
 * half covers "nothing reads this", "no consumer (reads/exists)", and "changes no behaviour (yet
 * |today)"; the "timing" half covers `timing`, `Port_Timing`, and `TimingContract` so the match
 * stays anchored to this feature's placeholder rather than any absent-consumer comment in the file.
 */
const ABSENT_CONSUMER_CLAUSE =
  /nothing\s+reads\s+this|no\s+consumer\s+(?:reads|exists)|changes\s+no\s+behaviou?r\s+(?:yet|today)/i;
const TIMING_CLAUSE = /timing|port[_-]?timing|timingcontract/i;

/** Whether `source`'s comments carry the absent-consumer placeholder excuse, paired with timing language. */
function hasPlaceholderJustification(source: string): boolean {
  const comments = commentsOf(source);
  return ABSENT_CONSUMER_CLAUSE.test(comments) && TIMING_CLAUSE.test(comments);
}

describe('no scanned file carries a timing placeholder justified by the absence of a consumer (Req 9.3)', () => {
  it.each(SCANNED_MODULES)('%s carries no such comment', (path) => {
    const source = SOURCES.get(path);
    if (source === undefined) {
      throw new Error(`fixture defect: source for ${path} was not loaded`);
    }
    expect(hasPlaceholderJustification(source)).toBe(false);
  });

  it('reports a violation when one is appended, so the clean result above is a measurement', () => {
    // POSITIVE CONTROL. Without it a scan that matches nothing would pass every file. One
    // violating comment is appended per scanned file, in the exact shape the three deleted
    // comments carried (e.g. import.ts's "This corpus's `timingContract` is not read by anything
    // yet ... the placeholder changes no behaviour today").
    for (const path of SCANNED_MODULES) {
      const source = SOURCES.get(path);
      if (source === undefined) {
        throw new Error(`fixture defect: source for ${path} was not loaded`);
      }
      const violation =
        '\n// This timing placeholder changes no behaviour today: nothing reads this value yet.\n';
      expect(hasPlaceholderJustification(`${source}${violation}`)).toBe(true);
    }
  });

  it('leaves an unrelated absent-consumer comment and a bare timing comment alone', () => {
    // NEGATIVE CONTROLS, pinning what the scan must NOT ban. Each permitted comment supplies
    // only one of the two required clauses, so a scan anchored to either clause alone - rather
    // than requiring both - would wrongly flag one of these.
    const permitted = [
      '// nothing reads this cache entry yet; it is populated eagerly for a future metrics page\n',
      '// the timing budget for this step is generous and unlikely to ever bind\n',
    ];
    for (const comment of permitted) {
      expect(hasPlaceholderJustification(comment)).toBe(false);
    }
  });
});

describe('the PortTiming vocabulary stays at exactly two members (Req 7.4)', () => {
  it('accepts registered and combinational and nothing else probed', () => {
    // The two real members, the three prototype-chain names a `Record` index would leak, and a
    // handful of plausible third-member guesses - counted, so this is a measured cardinality
    // rather than a check of two names in isolation.
    const probes = [
      'registered',
      'combinational',
      '__proto__',
      'constructor',
      'toString',
      'latched',
      'asynchronous',
      'tristate',
      '',
    ];
    const accepted = probes.filter((probe) => isPortTiming(probe));
    expect(accepted).toEqual(['registered', 'combinational']);
    expect(accepted).toHaveLength(2);
  });
});
