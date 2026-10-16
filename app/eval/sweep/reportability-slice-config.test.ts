// Feature: testbench-failure-reportability, C11: the Measurement_Slice config and its script.
//
// This slice is Control_Arm only, so the test that matters most is a negative one: no arm
// declares a Grounded strategy. Everything else it must copy from the Confirmatory config
// field for field, because a cap or a seed that drifted would make the two runs incomparable.

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { parseSweepConfig } from './config-parse.js';

const HERE = dirname(fileURLToPath(import.meta.url));

/** The 19 Confirmatory designs, in the order the slice must preserve. */
const CONFIRMATORY_IDS = [
  'rtllm/arithmetic/adder_8bit',
  'rtllm/arithmetic/adder_16bit',
  'rtllm/arithmetic/adder_pipe_64bit',
  'rtllm/arithmetic/multi_16bit',
  'rtllm/arithmetic/multi_pipe_8bit',
  'rtllm/arithmetic/multi_booth_8bit',
  'rtllm/arithmetic/div_16bit',
  'rtllm/control/fsm',
  'rtllm/control/counter_12',
  'rtllm/control/JC_counter',
  'rtllm/memory/right_shifter',
  'rtllm/memory/asyn_fifo',
  'rtllm/miscellaneous/signal_generator',
  'rtllm/miscellaneous/calendar',
  'rtllm/miscellaneous/traffic_light',
  'rtllm/arithmetic/accu',
  'rtllm/miscellaneous/parallel2serial',
  'rtllm/miscellaneous/serial2parallel',
  'rtllm/miscellaneous/width_8to16',
] as const;

/** The four Model_Arms the slice measures, each Control only. */
const MODEL_ARMS = ['moonshotai.kimi-k2.5', 'zai.glm-5', 'zai.glm-4.7', 'deepseek.v3.2'] as const;

/** Every field the slice must copy from the Confirmatory config unchanged (Req 8.5). */
const COPIED_FIELDS = ['seed', 'temperature', 'caps', 'limits', 'modelHost'] as const;

async function json(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(resolve(HERE, name), 'utf8')) as Record<string, unknown>;
}

const slice = (): Promise<Record<string, unknown>> =>
  json('sweep.config.reportability-slice-v1.json');
const confirmatory = (): Promise<Record<string, unknown>> =>
  json('sweep.config.grounding-confirmatory-v1.json');

describe('sweep.config.reportability-slice-v1.json', () => {
  it('parses, and declares 4 arms, all Control', async () => {
    const parsed = parseSweepConfig(await slice());

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.value.arms.map((arm) => arm.name)).toEqual(
      MODEL_ARMS.map((model) => `${model}.control`),
    );
    expect(parsed.value.arms.map((arm) => arm.strategy)).toEqual(MODEL_ARMS.map(() => 'control'));
  });

  it('selects the 19 Confirmatory ids, in the same order', async () => {
    const parsed = parseSweepConfig(await slice());

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.value.problems).toEqual({ kind: 'ids', ids: CONFIRMATORY_IDS });
  });

  it('is 76 slots: 4 Model_Arms x 19 designs x 1 sample', async () => {
    const parsed = parseSweepConfig(await slice());

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.value.reproducibility.sampleCount).toBe(1);
    expect(parsed.value.ks).toEqual([1]);
    expect(
      parsed.value.arms.length * CONFIRMATORY_IDS.length * parsed.value.reproducibility.sampleCount,
    ).toBe(76);
    // 76 slots plus 8 of headroom, so one deferred-tail retake still leaves a runaway stopped.
    expect(parsed.value.killSwitch.maxSamples).toBe(84);
    expect(parsed.value.killSwitch.maxWallClockMs).toBe(3_316_364);
  });

  it('copies seed, temperature, caps, limits, and modelHost from the Confirmatory config', async () => {
    const campaign = await slice();
    const reference = await confirmatory();

    for (const field of COPIED_FIELDS) {
      expect({ field, value: campaign[field] }).toEqual({ field, value: reference[field] });
    }
  });

  it('declares neither Campaign block, so no adoption criterion and no product constant moves', async () => {
    const parsed = parseSweepConfig(await slice());

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.value.groundingCampaign).toBeUndefined();
    expect(parsed.value.scoreboardCampaign).toBeUndefined();
  });

  it('reaches the Replay_Gate through the top-level replayGateReportPath', async () => {
    const parsed = parseSweepConfig(await slice());

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.value.replayGateReportPath).toBe(
      '.eval-runs/reportability-slice-v1/replay-gate.json',
    );
  });

  it('runs the prompt-version, RTL-isolation, and fixture pins before the sweep CLI', async () => {
    const manifest = JSON.parse(await readFile(resolve(HERE, '../../../package.json'), 'utf8')) as {
      readonly scripts: Record<string, string>;
    };
    const script = manifest.scripts['eval:reportability-slice'] ?? '';

    const cliIndex = script.indexOf('cli.js');
    expect(cliIndex).toBeGreaterThan(-1);
    for (const pin of [
      'prompt-version.test.ts',
      'testbench-rtl-isolation.property.test.ts',
      'reportability-fixtures.test.ts',
    ]) {
      expect(script).toContain(pin);
      expect(script.indexOf(pin)).toBeLessThan(cliIndex);
    }
    expect(script).toContain('sweep.config.reportability-slice-v1.json');
  });
});

// Feature: testbench-failure-reportability, Property 18: The slice plans Control slots only.
//
// `planUnits` in runner.ts is private, so the oracle here independently recomputes what it
// would plan (one unit per arm per design per sample) from the parsed config, rather than
// calling the production function. The planning rule itself (Req 7.10) is one unit per arm
// per problem per sample index, in arm-then-problem-then-sample order; no filtering by
// strategy happens anywhere in that rule, so a Control-only arm list plans Control-only units.
interface PlannedUnit {
  readonly strategy: string;
  readonly designId: string;
}

function plan(
  arms: readonly { strategy?: string }[],
  designIds: readonly string[],
  sampleCount: number,
): readonly PlannedUnit[] {
  const units: PlannedUnit[] = [];
  for (const arm of arms) {
    for (const designId of designIds) {
      for (let sample = 0; sample < sampleCount; sample += 1) {
        units.push({ strategy: arm.strategy ?? 'control', designId });
      }
    }
  }
  return units;
}

describe('Property 18: the slice plans Control slots only', () => {
  it('plans exactly 76 Control units over the 19 Confirmatory designs, from the real config', async () => {
    const parsed = parseSweepConfig(await slice());

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) {
      return;
    }
    expect(parsed.value.problems.kind).toBe('ids');
    const ids = parsed.value.problems.kind === 'ids' ? parsed.value.problems.ids : [];
    const units = plan(parsed.value.arms, ids, parsed.value.reproducibility.sampleCount);

    expect(units).toHaveLength(76);
    expect(units.every((unit) => unit.strategy === 'control')).toBe(true);
    expect(new Set(units.map((unit) => unit.designId))).toEqual(new Set(CONFIRMATORY_IDS));
    for (const id of CONFIRMATORY_IDS) {
      expect(units.filter((unit) => unit.designId === id)).toHaveLength(4);
    }
  });

  it('plans only Control units for any arm-count/design-count config whose arms all declare control', () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ minLength: 1, maxLength: 12 }), { minLength: 1, maxLength: 6 }),
        fc.array(fc.string({ minLength: 1, maxLength: 12 }), { minLength: 1, maxLength: 10 }),
        fc.integer({ min: 1, max: 3 }),
        (modelNames, designIds, sampleCount) => {
          const arms = modelNames.map((name) => ({ strategy: 'control' as const, name }));
          const units = plan(arms, designIds, sampleCount);

          expect(units).toHaveLength(arms.length * designIds.length * sampleCount);
          expect(units.every((unit) => unit.strategy === 'control')).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });
});
