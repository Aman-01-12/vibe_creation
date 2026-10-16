// The Grounding closeout (grounding-adoption-confirmatory, C8): one `status: candidate` note
// with every figure copied, the required Student_Path arm stated, a Measured_Negative label on
// a non-success verdict, and no environment value anywhere in it.

import { describe, expect, it } from 'vitest';

import {
  GROUNDING_CLOSEOUT,
  REQUIRED_ARM_PREFIX,
  groundingCloseoutNote,
  groundingSummaryOf,
  requiredStudentPathArm,
} from './grounding-closeout.js';
import { runCloseout, type CampaignSummary, type CloseoutPorts } from './scoreboard-closeout.js';

const RUN_NAME = 'grounding-confirmatory-v1';

const MANIFEST = JSON.stringify({
  runName: RUN_NAME,
  configHash: '0123456789abcdef',
  replayGate: { passed: true, watchdogBudgetNs: 2_000_000, replaySetSize: 489 },
});

/** A summary in the shape `renderGroundingReport` prints, trimmed to what the note reads. */
function summaryText(verdict: string): string {
  return [
    'GROUNDING CAMPAIGN TABLE (no figure pools two Strategy_Arms, Model_Arms, or designs)',
    '    control  ALL: instrument-valid 70/532 judged 81/532 golden-agreement 0.966 (78/81)',
    '    grounded ALL: instrument-valid 116/532 judged 136/532 golden-agreement 0.948 (129/136)',
    '',
    '  slot-pairs pooled: pairs 532 grounded-only-valid 78 control-only-valid 32',
    '',
    '  coverage-gap survivors per mutant (per-Model_Arm evidence; clause 7.1 decides pooled)',
    '    coverage-gap control  ALL: 122/2090 0.058',
    '    coverage-gap grounded ALL: 140/3122 0.045',
    '',
    '  coverage-gap operators (most frequent first)',
    '    operators control  ALL: ARITH_PLUS_TO_MINUS 40',
    '',
    '  deferred control zai.glm-5: 0',
    '  deferred-by-cause control: provider-unreachable 0 harness-error 0',
    '',
    'cross-run reading across two Config_Identities - NOT a Campaign figure, and used in no Campaign_Verdict',
    '  baseline unavailable: nothing to read',
    '',
    `GROUNDING VERDICT: ${verdict}`,
    '    6.1 pooled exact McNemar: held (b 78, c 32, p 0.00001)',
    '    7.1 coverage-gap rate non-inferior: held (control 122/2090 0.058, grounded 140/3122 0.045, difference -1.34pt, margin 2pt)',
    '    8.1 missed-bug rate non-inferior: NOT held (control 2/81 0.025, grounded 9/136 0.066, difference +4.14pt, margin 3pt, min-denominator 34)',
    '    pairs observed 532 of 532',
    '',
  ].join('\n');
}

/** The summary, or a failure naming the reason the reader refused it. */
function summaryOf(verdict: string): CampaignSummary {
  const summary = groundingSummaryOf(summaryText(verdict), MANIFEST);
  if (typeof summary === 'string') {
    throw new Error(`the reader refused the fixture: ${summary}`);
  }
  return summary;
}

/** Ports that record what was written and never touch a real filesystem. */
function ports(overrides: Partial<CloseoutPorts> = {}): {
  readonly ports: CloseoutPorts;
  readonly written: { path: string; text: string }[];
} {
  const written: { path: string; text: string }[] = [];
  return {
    written,
    ports: {
      readText: (path) =>
        Promise.resolve(path.endsWith('manifest.json') ? MANIFEST : summaryText('failed')),
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

describe('requiredStudentPathArm - the one owner of the verdict-to-arm mapping', () => {
  it('adopts only on succeeded', () => {
    expect(requiredStudentPathArm('succeeded')).toBe('grounded');
    expect(requiredStudentPathArm('failed')).toBe('control');
    expect(requiredStudentPathArm('not-decided')).toBe('control');
  });
});

describe('groundingSummaryOf', () => {
  it('reads the verdict, the clause lines, and the table blocks', () => {
    const summary = summaryOf('failed');

    expect(summary.verdict).toBe('failed');
    expect(summary.configHash).toBe('0123456789abcdef');
    expect(summary.verdictLines.join('\n')).toContain('6.1 pooled exact McNemar: held');
    expect(summary.verdictLines.join('\n')).toContain('8.1 missed-bug rate non-inferior: NOT held');
    expect(summary.verdictLines.join('\n')).toContain('slot-pairs pooled');
    expect(summary.groupLines.join('\n')).toContain('grounded ALL: instrument-valid 116/532');
    expect(summary.groupLines.join('\n')).toContain('coverage-gap control  ALL: 122/2090');
    expect(summary.groupLines.join('\n')).toContain('operators control  ALL: ARITH_PLUS_TO_MINUS');
    // The cross-run block travels with its label, so the note cannot quote it unlabelled.
    expect(summary.groupLines.join('\n')).toContain('used in no Campaign_Verdict');
  });

  it('reads whatever run name the manifest carries, rather than a hardcoded one', () => {
    const renamed = JSON.stringify({
      runName: 'grounding-rerun-v9',
      configHash: 'fedcba9876543210',
    });
    const summary = groundingSummaryOf(summaryText('failed'), renamed);

    expect(typeof summary === 'string' ? summary : summary.runName).toBe('grounding-rerun-v9');
  });

  it('returns a reason string rather than throwing when the verdict line is absent', () => {
    // Throwing was reported by `runCloseout` as the misleading missing-summary message.
    expect(groundingSummaryOf('nothing here', MANIFEST)).toBe(
      'the summary holds no GROUNDING VERDICT line',
    );
  });

  it('refuses a manifest with no valid identity', () => {
    expect(groundingSummaryOf(summaryText('failed'), '{')).toBe('the run manifest is not JSON');
    expect(groundingSummaryOf(summaryText('failed'), '{"runName":"ok"}')).toBe(
      'the run manifest carries no valid config hash',
    );
  });
});

describe('groundingCloseoutNote', () => {
  it('copies every figure, and is a candidate note that never claims trusted', () => {
    const note = groundingCloseoutNote(summaryOf('failed'), '2026-10-10T00:00:00Z', MANIFEST);

    expect(note.text).toContain('status: candidate');
    expect(note.text).not.toContain('status: trusted');
    expect(note.text).toContain('8.1 missed-bug rate non-inferior: NOT held');
    expect(note.text).toContain('instrument-valid 116/532');
    expect(note.text).toContain('coverage-gap grounded ALL: 140/3122');
    // The Replay_Gate report the Campaign refused to start without.
    expect(note.text).toContain('"watchdogBudgetNs": 2000000');
    expect(note.fileName).toBe(`decision-${RUN_NAME}-campaign-verdict.md`);
  });

  it('states the required Student_Path arm on one fixed-prefix line', () => {
    for (const verdict of ['succeeded', 'failed', 'not-decided']) {
      const note = groundingCloseoutNote(summaryOf(verdict), '2026-10-10T00:00:00Z', MANIFEST);

      expect(note.text).toContain(`${REQUIRED_ARM_PREFIX} ${requiredStudentPathArm(verdict)}`);
    }
  });

  it.each(['failed', 'not-decided'])('labels %s as a Measured_Negative', (verdict) => {
    const note = groundingCloseoutNote(summaryOf(verdict), '2026-10-10T00:00:00Z', MANIFEST);

    expect(note.text).toContain('MEASURED NEGATIVE');
    expect(note.text).toContain('measured-negative');
    expect(note.text).toContain('stays `control` PERMANENTLY');
    // The arm stays available to the eval plane; what is refused is the shipped default.
    expect(note.text).toContain('RETAINED for the eval plane');
  });

  it('adopts the Grounded_Arm only on succeeded', () => {
    const note = groundingCloseoutNote(summaryOf('succeeded'), '2026-10-10T00:00:00Z', MANIFEST);

    expect(note.text).toContain('is ADOPTED');
    expect(note.text).not.toContain('MEASURED NEGATIVE');
    expect(note.text).not.toContain('PERMANENTLY');
  });

  it('names the next work and that the Exploratory verdict stands, under every verdict', () => {
    for (const verdict of ['succeeded', 'failed', 'not-decided']) {
      const note = groundingCloseoutNote(summaryOf(verdict), '2026-10-10T00:00:00Z', MANIFEST);

      expect(note.text).toContain('NON-CIRCULAR');
      expect(note.text).toContain('`failed` verdict STANDS unchanged');
      expect(note.text).toContain('773b798cf6bbe129');
      expect(note.text).toContain('Requirement 4.12 is a checked fact for the CAMPAIGN HOST ONLY');
      expect(note.text).toContain('real-oracle-and-containment-unexercised-m0');
    }
  });

  it('never carries an environment value into the note', () => {
    process.env.ECE_CLOSEOUT_CANARY = 'canary-must-not-appear';
    try {
      const note = groundingCloseoutNote(summaryOf('failed'), '2026-10-10T00:00:00Z', MANIFEST);

      expect(note.text).not.toContain('canary-must-not-appear');
    } finally {
      delete process.env.ECE_CLOSEOUT_CANARY;
    }
  });
});

describe('runCloseout with the Grounding pair', () => {
  it('writes exactly one note and regenerates the vault manifest', async () => {
    const { ports: injected, written } = ports();

    const result = await runCloseout('/run', '/inbox', injected, GROUNDING_CLOSEOUT);

    expect(result.exitCode).toBe(0);
    expect(written).toHaveLength(1);
    expect(written[0]?.path).toContain(`decision-${RUN_NAME}-campaign-verdict.md`);
  });

  it('reports the real reason when the summary holds no verdict', async () => {
    const { ports: injected, written } = ports({
      readText: (path) => Promise.resolve(path.endsWith('manifest.json') ? MANIFEST : 'nothing'),
    });

    const result = await runCloseout('/run', '/inbox', injected, GROUNDING_CLOSEOUT);

    expect(result.exitCode).toBe(1);
    expect(result.lines.join(' ')).toContain('no GROUNDING VERDICT line');
    expect(written).toHaveLength(0);
  });

  it('exits non-zero and writes nothing when the note cannot be written', async () => {
    const { ports: injected, written } = ports({
      writeNew: () => Promise.reject(new Error('exists')),
    });

    const result = await runCloseout('/run', '/inbox', injected, GROUNDING_CLOSEOUT);

    expect(result.exitCode).toBe(1);
    expect(result.lines.join(' ')).toContain('closeout incomplete');
    expect(written).toHaveLength(0);
  });

  it('exits non-zero when the vault manifest could not be regenerated', async () => {
    const { ports: injected } = ports({ regenerateManifest: () => false });

    const result = await runCloseout('/run', '/inbox', injected, GROUNDING_CLOSEOUT);

    expect(result.exitCode).toBe(1);
    expect(result.lines.join(' ')).toContain('vault:manifest failed');
  });
});
