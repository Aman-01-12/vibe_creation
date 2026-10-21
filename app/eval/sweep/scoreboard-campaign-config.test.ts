// The committed A/B Campaign config (task 9.2): its shape, its slot count, the fields copied
// from the baseline, and the block the supplement rule produced. Requirements 7.8, 7.9, 8.1-8.6,
// 8.8, 8.9, 8.12, 10.1, 10.2.

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_CREDENTIAL_FILE } from '@app/agent';
import { describe, expect, it } from 'vitest';

import {
  FileSystemCorpusCheckout,
  FixedTimingDerivation,
  importRtllmCorpus,
  scoredRtllmCorpus,
} from '../corpus/index.js';
import { RTLLM_CHECKOUT_PATH } from '../corpus/fetch-node.js';
import { scoreboardCampaignLists } from '../scripts/scoreboard-supplement.js';
import { parseSweepConfig } from './config-parse.js';
import { PRE_REGISTERED_SUCCESS_CRITERION } from './success-criterion.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const SUPPLEMENT = [
  'rtllm/arithmetic/accu',
  'rtllm/miscellaneous/parallel2serial',
  'rtllm/miscellaneous/serial2parallel',
  'rtllm/miscellaneous/width_8to16',
];
const STREAMING_BASELINE = ['rtllm/arithmetic/multi_16bit'];

async function json(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(resolve(HERE, name), 'utf8')) as Record<string, unknown>;
}

describe('sweep.config.scoreboard-ab-v1.json', () => {
  it('parses into 22 pair-ordered arms over 19 designs, which is 1254 slots', async () => {
    const parsed = parseSweepConfig(await json('sweep.config.scoreboard-ab-v1.json'));
    if (!parsed.ok) {
      throw new Error(parsed.error.message);
    }
    const config = parsed.value;
    expect(config.arms).toHaveLength(22);
    config.arms.forEach((arm, index) => {
      expect(arm.strategy).toBe(index % 2 === 0 ? 'control' : 'treatment');
      expect(arm.name.endsWith(`.${arm.strategy}`)).toBe(true);
    });
    const ids = config.problems.kind === 'ids' ? config.problems.ids : [];
    expect(ids).toHaveLength(19);
    expect(ids.length * 11 * config.reproducibility.sampleCount * 2).toBe(1254);
    expect(config.killSwitch.maxSamples).toBeGreaterThan(1254);
  });

  it('copies every setting the comparison depends on verbatim from the baseline', async () => {
    const campaign = await json('sweep.config.scoreboard-ab-v1.json');
    const baseline = await json('sweep.config.stage1-screen-dialect-v1.json');
    const copied = ['schemaVersion', 'sampleCount', 'ks', 'seed', 'temperature', 'caps', 'limits'];
    const rest = ['costEnvelopeCents', 'modelHost', 'prices', 'captureArtifacts', 'concurrency'];
    for (const field of [...copied, ...rest, 'transportRetry']) {
      expect(campaign[field], field).toEqual(baseline[field]);
    }
    const baselineIds = (baseline.problems as { ids: string[] }).ids;
    expect((campaign.problems as { ids: string[] }).ids).toEqual([...baselineIds, ...SUPPLEMENT]);
    const baselineModels = (baseline.arms as { model: string }[]).map((arm) => arm.model);
    const models = (campaign.arms as { model: string }[]).map((arm) => arm.model);
    expect(models).toEqual(baselineModels.flatMap((model) => [model, model]));
  });

  it('holds the block the supplement rule produced and the pre-registered criterion', async () => {
    const campaign = (await json('sweep.config.scoreboard-ab-v1.json')).scoreboardCampaign as {
      designGroups: Record<string, string>;
      streamingSupplement: string[];
      successCriterion: unknown;
      baseline: { configHash: string };
      maxResumes: number;
    };
    expect(campaign.streamingSupplement).toEqual(SUPPLEMENT);
    const streaming = Object.keys(campaign.designGroups).filter(
      (id) => campaign.designGroups[id] === 'streaming',
    );
    expect(streaming.sort()).toEqual([...STREAMING_BASELINE, ...SUPPLEMENT].sort());
    expect(campaign.successCriterion).toEqual(PRE_REGISTERED_SUCCESS_CRITERION);
    expect(campaign.baseline.configHash).toBe('e27c5b40e6e7983f');
    expect(campaign.maxResumes).toBe(2);
  });

  it('names no credential: the one source is the credential file the loader reads', async () => {
    const text = await readFile(resolve(HERE, 'sweep.config.scoreboard-ab-v1.json'), 'utf8');
    expect(DEFAULT_CREDENTIAL_FILE).toBe('.secrets/bedrock-token');
    expect(text).not.toMatch(/api[_-]?key|token"|secret"|bearer/i);
  });

  // The corpus checkout is gitignored local data, so this runs wherever it has been fetched.
  it.runIf(existsSync(RTLLM_CHECKOUT_PATH))(
    'equals what the supplement script computes from the pinned corpus right now',
    async () => {
      const corpus = scoredRtllmCorpus(
        // This suite compares problem id LISTS and never reads `timingContract`, so a fixed
        // double stands in rather than paying a real netlist derivation per design.
        await importRtllmCorpus(
          new FileSystemCorpusCheckout(RTLLM_CHECKOUT_PATH),
          new FixedTimingDerivation('combinational'),
        ),
      );
      const baselineIds = (
        (await json('sweep.config.stage1-screen-dialect-v1.json')).problems as {
          ids: string[];
        }
      ).ids;
      const lists = scoreboardCampaignLists(corpus.problems, baselineIds);
      const campaign = await json('sweep.config.scoreboard-ab-v1.json');
      const block = campaign.scoreboardCampaign as Record<string, unknown>;
      expect(block.designGroups).toEqual(lists.designGroups);
      expect(block.streamingSupplement).toEqual(lists.streamingSupplement);
      expect((campaign.problems as { ids: string[] }).ids).toEqual(lists.problemIds);
    },
  );
});
