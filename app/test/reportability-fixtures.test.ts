// testbench-failure-reportability, task 10.2 (C9): the committed Detector_Fixtures asserted
// against `countValuelessFailureReports`, so a detector regression fails by fixture name
// rather than surfacing only in the Pinned_Baseline's two totals.
//
// `app/test/fixtures/reportability/index.json` carries 8 byte-exact copies of real captured
// `testbench.v` sources from `.eval-runs/grounding-confirmatory-v1`, one per `<model>.<strategy>`
// arm, with a hand-verified ground-truth count pinned beside each. Needs no toolchain: the
// detector is a pure function over text (design C9, Req 7.5, 8.14).
//
// Validates: Requirements 7.6, 7.7, 7.8

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { countValuelessFailureReports } from '@app/tools';

/** `app/test/fixtures/reportability/`, the root every indexed `file` is relative to. */
const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'reportability');

/** One indexed fixture, validated out of `index.json`. */
interface FixtureEntry {
  readonly file: string;
  readonly origin: string;
  readonly valuelessFailureReports: number;
}

/** The raw shape `index.json` is read through; every field re-validated below. */
interface RawIndex {
  readonly fixtures?: readonly {
    readonly file?: unknown;
    readonly origin?: unknown;
    readonly valuelessFailureReports?: unknown;
  }[];
}

/**
 * Validate one raw index entry into a `FixtureEntry`, throwing on any malformed field.
 *
 * `index.json` is untrusted file input: a non-integer count or a missing field is a named
 * failure here rather than a fixture silently dropped from coverage.
 */
function entryAt(raw: NonNullable<RawIndex['fixtures']>[number], position: number): FixtureEntry {
  const { file, origin, valuelessFailureReports } = raw;
  if (typeof file !== 'string' || file.length === 0) {
    throw new Error(`fixture index entry ${position} has no file`);
  }
  if (typeof origin !== 'string' || origin.length === 0) {
    throw new Error(`fixture index entry ${position} (${file}) has no origin`);
  }
  if (!Number.isInteger(valuelessFailureReports) || (valuelessFailureReports as number) < 0) {
    throw new Error(`fixture index entry ${position} (${file}) has no valid committed count`);
  }
  return { file, origin, valuelessFailureReports: valuelessFailureReports as number };
}

/** Read and validate the committed index once, at collection time. */
function readFixtureIndex(): readonly FixtureEntry[] {
  const parsed: unknown = JSON.parse(readFileSync(join(FIXTURE_ROOT, 'index.json'), 'utf8'));
  const { fixtures } = parsed as RawIndex;
  if (fixtures === undefined) {
    throw new Error('fixture index holds no `fixtures` array');
  }
  return fixtures.map(entryAt);
}

const FIXTURES: readonly FixtureEntry[] = readFixtureIndex();

describe('the committed Detector_Fixtures against countValuelessFailureReports (Req 7.6-7.8)', () => {
  it('indexes at least one fixture', () => {
    expect(FIXTURES.length).toBeGreaterThan(0);
  });

  it('names a file that exists on disk for every indexed fixture', () => {
    for (const entry of FIXTURES) {
      expect(() => readFileSync(join(FIXTURE_ROOT, entry.file), 'utf8')).not.toThrow();
    }
  });

  it('holds at least one fixture counting 0 and one counting more than 0 (Req 7.7)', () => {
    expect(FIXTURES.some((entry) => entry.valuelessFailureReports === 0)).toBe(true);
    expect(FIXTURES.some((entry) => entry.valuelessFailureReports > 0)).toBe(true);
  });

  // One assertion per fixture, each message naming the fixture and both counts (Req 7.8):
  // "a fixture disagrees" is not actionable, "<file> committed N, detector reported M" is.
  for (const entry of FIXTURES) {
    it(`${entry.file} (${entry.origin}) reports ${entry.valuelessFailureReports}`, () => {
      const source = readFileSync(join(FIXTURE_ROOT, entry.file), 'utf8');
      const observed = countValuelessFailureReports(source);
      expect(
        observed,
        `${entry.file} committed ${entry.valuelessFailureReports}, detector reported ${observed}`,
      ).toBe(entry.valuelessFailureReports);
    });
  }
});
