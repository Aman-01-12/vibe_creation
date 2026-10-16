// Campaign_Closeout (task 14.1): one candidate note per verdict, every figure copied from the
// run's summary, nothing outside the run directory, and an incomplete closeout touches nothing.

import { describe, expect, it } from 'vitest';

import { runCloseout, type CloseoutPorts } from './scoreboard-closeout.js';

const RUN = '/runs/scoreboard-ab-v1';
const INBOX = '/vault/_inbox';

function summaryText(verdict: string): string {
  return [
    'eval sweep summary  (config 0123456789abcdef)',
    '',
    'A/B CAMPAIGN TABLE (no figure pools two Strategy_Arms, Model_Arms, or Design_Groups)',
    '  model-arm model.a:',
    '    control   streaming: instrument-valid 1/12 missed-bug 0/12 golden-agreement undefined',
    '    treatment streaming: instrument-valid 7/12 missed-bug 0/12 golden-agreement 0.857 (6/7)',
    '    control   rtllm/arithmetic/accu: instrument-valid 0/3',
    '',
    `CAMPAIGN VERDICT: ${verdict}`,
    '    10.5 streaming instrument-valid greater: held (observed 10, threshold 9)',
  ].join('\n');
}

const MANIFEST = JSON.stringify({ runName: 'scoreboard-ab-v1', configHash: '0123456789abcdef' });

/** In-memory ports; the run directory is a map so a test can prove it never changed. */
function ports(files: Map<string, string>, overrides: Partial<CloseoutPorts> = {}): CloseoutPorts {
  return {
    readText: (path) => {
      const text = files.get(path);
      return text === undefined ? Promise.reject(new Error('absent')) : Promise.resolve(text);
    },
    writeNew: (path, text) => {
      if (files.has(path)) {
        return Promise.reject(new Error('exists'));
      }
      files.set(path, text);
      return Promise.resolve();
    },
    regenerateManifest: () => true,
    now: () => '2026-10-09T00:00:00.000Z',
    ...overrides,
  };
}

function runDir(verdict: string): Map<string, string> {
  return new Map([
    [`${RUN}/summary.txt`, summaryText(verdict)],
    [`${RUN}/manifest.json`, MANIFEST],
  ]);
}

describe('runCloseout', () => {
  it.each(['succeeded', 'failed', 'not-decided'])(
    'writes exactly one candidate note for a %s verdict, figures copied verbatim',
    async (verdict) => {
      const files = runDir(verdict);
      const result = await runCloseout(RUN, INBOX, ports(files));
      expect(result.exitCode).toBe(0);
      const notes = [...files.keys()].filter((path) => path.startsWith(INBOX));
      expect(notes).toHaveLength(1);
      const note = files.get(notes[0] ?? '') ?? '';
      expect(note).toContain('status: candidate');
      expect(note).toContain(`CAMPAIGN VERDICT: ${verdict}`);
      expect(note).toContain('treatment streaming: instrument-valid 7/12');
      expect(note).not.toContain('rtllm/arithmetic/accu');
      expect(note).toContain('0123456789abcdef');
      expect(note.includes('decided together with the reference-free')).toBe(
        verdict === 'succeeded',
      );
      expect(note).toContain('keeps Cycle_Timed');
    },
  );

  it('never carries an environment value into the note', async () => {
    const planted = 'PLANTED-SECRET-VALUE-9f3a';
    process.env.CLOSEOUT_TEST_TOKEN = planted;
    try {
      const files = runDir('failed');
      await runCloseout(RUN, INBOX, ports(files));
      for (const text of files.values()) {
        expect(text).not.toContain(planted);
      }
    } finally {
      delete process.env.CLOSEOUT_TEST_TOKEN;
    }
  });

  it('a failing writer exits non-zero, says incomplete, and leaves the run directory byte-identical', async () => {
    const files = runDir('failed');
    const before = new Map(files);
    const result = await runCloseout(
      RUN,
      INBOX,
      ports(files, { writeNew: () => Promise.reject(new Error('disk full')) }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.lines[0]).toContain('closeout incomplete');
    expect(files).toEqual(before);
  });

  it('a failed manifest regeneration is incomplete too', async () => {
    const result = await runCloseout(
      RUN,
      INBOX,
      ports(runDir('failed'), { regenerateManifest: () => false }),
    );
    expect(result.exitCode).toBe(1);
    expect(result.lines[0]).toContain('closeout incomplete');
  });

  it('refuses a summary with no Campaign verdict and writes nothing', async () => {
    const files = new Map([
      [`${RUN}/summary.txt`, 'eval sweep summary'],
      [`${RUN}/manifest.json`, MANIFEST],
    ]);
    const result = await runCloseout(RUN, INBOX, ports(files));
    expect(result.exitCode).toBe(1);
    expect([...files.keys()].some((path) => path.startsWith(INBOX))).toBe(false);
  });
});
