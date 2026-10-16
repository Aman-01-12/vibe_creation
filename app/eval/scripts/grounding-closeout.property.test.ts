// Feature: grounding-adoption-confirmatory, properties of the Campaign_Closeout.
//
// Property 14: the closeout writes exactly one complete note.
// Property 15: every figure in the note comes from the run's own files, and no credential does.
// Property 16: any single port failure reports incomplete and writes nothing.
//
// Validates: Requirements 11.5, 11.7, 11.8, 11.9, 11.11.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { STUDENT_PATH_STRATEGY_ARM } from '@app/agent';

import { CONFIRMATORY_CLAUSES } from '../sweep/grounding-report.js';
import {
  GROUNDING_CLOSEOUT,
  REQUIRED_ARM_PREFIX,
  groundingCloseoutNote,
  groundingSummaryOf,
  requiredStudentPathArm,
} from './grounding-closeout.js';
import { runCloseout, type CampaignSummary, type CloseoutPorts } from './scoreboard-closeout.js';

const PROPERTY_14 =
  'Feature: grounding-adoption-confirmatory, Property 14: The closeout writes exactly one complete note';
const PROPERTY_15 =
  'Feature: grounding-adoption-confirmatory, Property 15: Every figure in the note comes from the run, and no credential reaches it';
const PROPERTY_16 =
  'Feature: grounding-adoption-confirmatory, Property 16: Any single closeout port failure reports incomplete and writes nothing';

const RUN_NAME = 'grounding-confirmatory-v1';
const CONFIG_HASH = '0123456789abcdef';
const VERDICTS = ['succeeded', 'failed', 'not-decided'] as const;
const OUTCOMES = ['held', 'NOT held', 'not decided'] as const;

interface Drawn {
  readonly verdict: (typeof VERDICTS)[number];
  readonly outcomes: readonly string[];
  readonly pairs: number;
  readonly judgedControl: number;
  readonly judgedGrounded: number;
  readonly gapsControl: number;
  readonly scoredControl: number;
}

/** A summary in the shape `renderGroundingReport` prints, with every figure drawn. */
function summaryText(drawn: Drawn): string {
  return [
    'GROUNDING CAMPAIGN TABLE (no figure pools two Strategy_Arms, Model_Arms, or designs)',
    `    control  ALL: instrument-valid ${String(drawn.judgedControl)}/${String(drawn.pairs)} judged ${String(drawn.judgedControl)}/${String(drawn.pairs)}`,
    `    grounded ALL: instrument-valid ${String(drawn.judgedGrounded)}/${String(drawn.pairs)} judged ${String(drawn.judgedGrounded)}/${String(drawn.pairs)}`,
    '',
    `  slot-pairs pooled: pairs ${String(drawn.pairs)} grounded-only-valid 78 control-only-valid 32`,
    '',
    '  coverage-gap survivors per mutant (per-Model_Arm evidence; clause 7.1 decides pooled)',
    `    coverage-gap control  ALL: ${String(drawn.gapsControl)}/${String(drawn.scoredControl)} 0.058`,
    '',
    '  coverage-gap operators (most frequent first)',
    '    operators control  ALL: ARITH_PLUS_TO_MINUS 40',
    '',
    '  deferred control zai.glm-5: 0',
    '',
    'cross-run reading across two Config_Identities - NOT a Campaign figure, and used in no Campaign_Verdict',
    '  baseline unavailable: nothing to read',
    '',
    `GROUNDING VERDICT: ${drawn.verdict}`,
    ...CONFIRMATORY_CLAUSES.map(
      (clause, at) =>
        `    ${clause.id} ${clause.label}: ${drawn.outcomes[at] ?? 'held'} (control 1/2 0.500)`,
    ),
    `    pairs observed ${String(drawn.pairs)} of 532`,
    '',
  ].join('\n');
}

function manifestText(): string {
  return JSON.stringify({
    runName: RUN_NAME,
    configHash: CONFIG_HASH,
    replayGate: { passed: true, watchdogBudgetNs: 2_000_000, replaySetSize: 489 },
  });
}

const arbDrawn: fc.Arbitrary<Drawn> = fc.record({
  verdict: fc.constantFrom(...VERDICTS),
  outcomes: fc.array(fc.constantFrom(...OUTCOMES), { minLength: 6, maxLength: 6 }),
  pairs: fc.integer({ min: 0, max: 532 }),
  judgedControl: fc.integer({ min: 0, max: 200 }),
  judgedGrounded: fc.integer({ min: 0, max: 200 }),
  gapsControl: fc.integer({ min: 0, max: 200 }),
  scoredControl: fc.integer({ min: 1, max: 4_000 }),
});

/** The summary the reader produced, or a failure naming why the fixture was refused. */
function summaryOf(drawn: Drawn): CampaignSummary {
  const summary = groundingSummaryOf(summaryText(drawn), manifestText());
  if (typeof summary === 'string') {
    throw new Error(`the reader refused the fixture: ${summary}`);
  }
  return summary;
}

function ports(overrides: Partial<CloseoutPorts> = {}): {
  readonly ports: CloseoutPorts;
  readonly written: { path: string; text: string }[];
} {
  const written: { path: string; text: string }[] = [];
  return {
    written,
    ports: {
      readText: (path) =>
        Promise.resolve(
          path.endsWith('manifest.json')
            ? manifestText()
            : summaryText({
                verdict: 'failed',
                outcomes: [...OUTCOMES, ...OUTCOMES].slice(0, 6),
                pairs: 532,
                judgedControl: 81,
                judgedGrounded: 136,
                gapsControl: 122,
                scoredControl: 2_090,
              }),
        ),
      writeNew: (path, text) => {
        written.push({ path, text });
        return Promise.resolve();
      },
      regenerateManifest: () => true,
      now: () => '2026-10-10T00:00:00Z',
      ...overrides,
    },
  };
}

describe(PROPERTY_14, () => {
  it('writes one note carrying every required element, under every verdict', () => {
    fc.assert(
      fc.property(arbDrawn, (drawn) => {
        const summary = summaryOf(drawn);
        const note = groundingCloseoutNote(summary, '2026-10-10T00:00:00Z', manifestText());

        // The required-element list, written out here rather than read from the renderer.
        expect(note.text).toContain(`GROUNDING VERDICT: ${drawn.verdict}`);
        expect(note.text).toContain(CONFIG_HASH);
        for (const [at, clause] of CONFIRMATORY_CLAUSES.entries()) {
          const line =
            note.text
              .split('\n')
              .find((candidate) => candidate.trim().startsWith(`${clause.id} `)) ?? '';
          expect(line).toContain(clause.label);
          expect(line).toContain(drawn.outcomes[at] ?? 'held');
        }
        expect(note.text).toContain('coverage-gap survivors per mutant');
        expect(note.text).toContain('coverage-gap operators');
        expect(note.text).toContain('773b798cf6bbe129');
        expect(note.text).toContain(
          `${REQUIRED_ARM_PREFIX} ${requiredStudentPathArm(drawn.verdict)}`,
        );
        expect(note.text).toContain('NON-CIRCULAR');
        expect(note.text).toContain('`failed` verdict STANDS unchanged');
        expect(note.text).toContain('status: candidate');
        expect(note.text).not.toContain('status: trusted');
        expect(note.fileName).toBe(`decision-${RUN_NAME}-campaign-verdict.md`);
      }),
      { numRuns: 100 },
    );
  });

  it('writes exactly one file, and only into the inbox', async () => {
    const { ports: injected, written } = ports();

    const result = await runCloseout('/run', '/inbox', injected, GROUNDING_CLOSEOUT);

    expect(result.exitCode).toBe(0);
    expect(written).toHaveLength(1);
    expect(written[0]?.path.startsWith('/inbox')).toBe(true);
  });
});

describe(PROPERTY_15, () => {
  it('takes every number in its fenced figure blocks from the summary or the manifest', () => {
    fc.assert(
      fc.property(arbDrawn, (drawn) => {
        const source = `${summaryText(drawn)}\n${manifestText()}`;
        const note = groundingCloseoutNote(
          summaryOf(drawn),
          '2026-10-10T00:00:00Z',
          manifestText(),
        );
        // The fenced regions are the copied ones; the prose around them is this build's own.
        const fenced = note.text.split('```').filter((_, at) => at % 2 === 1);

        for (const block of fenced) {
          for (const token of block.match(/\d+/g) ?? []) {
            expect({ token, inSource: source.includes(token) }).toEqual({ token, inSource: true });
          }
        }
      }),
      { numRuns: 100 },
    );
  });

  it('never carries a credential-shaped token, from the environment or from the summary', () => {
    const canary = 'ece-canary-credential-must-not-appear';
    process.env.ECE_CLOSEOUT_CANARY = canary;
    try {
      const drawn: Drawn = {
        verdict: 'failed',
        outcomes: [...OUTCOMES, ...OUTCOMES].slice(0, 6),
        pairs: 532,
        judgedControl: 81,
        judgedGrounded: 136,
        gapsControl: 122,
        scoredControl: 2_090,
      };
      // Planted in a region of the summary the note does not copy.
      const planted = `${summaryText(drawn)}\nAUTHORIZATION: ${canary}\n`;
      const summary = groundingSummaryOf(planted, manifestText());
      expect(typeof summary).not.toBe('string');
      if (typeof summary === 'string') {
        return;
      }
      const note = groundingCloseoutNote(summary, '2026-10-10T00:00:00Z', manifestText());

      expect(note.text).not.toContain(canary);
      expect(note.text).not.toContain('AUTHORIZATION');
    } finally {
      delete process.env.ECE_CLOSEOUT_CANARY;
    }
  });
});

describe(PROPERTY_16, () => {
  it('reports incomplete, writes nothing into the run directory, and leaves the arm alone', async () => {
    const failures: readonly (keyof CloseoutPorts)[] = [
      'readText',
      'writeNew',
      'regenerateManifest',
    ];
    const armBefore = STUDENT_PATH_STRATEGY_ARM;

    for (const port of failures) {
      const overrides: Partial<CloseoutPorts> =
        port === 'readText'
          ? { readText: () => Promise.reject(new Error('unreadable')) }
          : port === 'writeNew'
            ? { writeNew: () => Promise.reject(new Error('exists')) }
            : { regenerateManifest: () => false };
      const { ports: injected, written } = ports(overrides);

      const result = await runCloseout('/run', '/inbox', injected, GROUNDING_CLOSEOUT);

      expect(result.exitCode).toBe(1);
      expect(result.lines.filter((line) => line.includes('closeout incomplete'))).toHaveLength(1);
      expect(written.filter((one) => one.path.startsWith('/run'))).toHaveLength(0);
      if (port !== 'regenerateManifest') {
        expect(written).toHaveLength(0);
      }
      expect(STUDENT_PATH_STRATEGY_ARM).toBe(armBefore);
    }
  });
});
