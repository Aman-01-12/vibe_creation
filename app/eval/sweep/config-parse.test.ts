// Unit tests for the sweep-config boundary.
//
// The config is untrusted input and it is the ONLY thing standing between an operator's
// typo and an overnight run that measures the wrong thing. These tests pin down that a
// valid config parses to exactly the declared experiment, and that each way of getting it
// wrong is refused with the offending field named - before any model call is possible.

import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { parseSweepConfig } from './config-parse.js';
import {
  DEFAULT_MUTANT_WALL_MS,
  MAX_MUTANT_WALL_MS,
  MIN_MUTANT_WALL_MS,
  MUTATION_OPERATORS,
} from '../mutation-control.js';

import {
  armCostIsKnown,
  DEFAULT_CAPTURE_ARTIFACTS,
  DEFAULT_NEGATIVE_CONTROL_CONFIG,
  DEFAULT_NEGATIVE_CONTROL_ENABLED,
  isSingleModel,
  modelSignatureOf,
  mutationConfigFor,
} from './config.js';
import { DEFAULT_KILL_SWITCH_BOUNDS, DEFAULT_TRANSPORT_RETRY_POLICY } from './index.js';

/** A minimal valid config; each test overrides exactly the field it is about. */
function baseConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    runName: 'bakeoff-v1',
    arms: [{ name: 'glm-5', model: 'zai.glm-5' }],
    problems: { kind: 'all' },
    sampleCount: 5,
    ks: [5, 1, 1],
    seed: 42,
    temperature: 0,
    caps: {
      maxIterations: 12,
      maxTokens: 1_000_000,
      maxWallClockMs: 900_000,
      maxCostCents: 100_000,
    },
    limits: { cpu: 1, memMb: 512, procs: 128, diskMb: 128, wallMs: 30_000 },
    costEnvelopeCents: 25,
    modelHost: { region: 'us-east-1' },
    outputDir: '.eval-runs/bakeoff-v1',
    ...overrides,
  };
}

/** Parse and assert success, returning the value so a test can assert on it. */
function parseOk(raw: Record<string, unknown>) {
  const parsed = parseSweepConfig(raw);
  if (!parsed.ok) {
    throw new Error(`expected a valid config, got ${parsed.error.code} at ${parsed.error.field}`);
  }
  return parsed.value;
}

/** Parse and assert failure, returning the typed error. */
function parseErr(raw: unknown) {
  const parsed = parseSweepConfig(raw);
  if (parsed.ok) {
    throw new Error('expected the config to be rejected');
  }
  return parsed.error;
}

describe('parseSweepConfig - a valid campaign', () => {
  it('resolves a single-model arm to one model id for every role', () => {
    const config = parseOk(baseConfig());
    const arm = config.arms[0];
    expect(arm?.name).toBe('glm-5');
    expect(arm === undefined ? [] : Object.values(arm.roleModels)).toEqual(
      Array.from({ length: 5 }, () => 'zai.glm-5'),
    );
    expect(arm === undefined ? false : isSingleModel(arm)).toBe(true);
  });

  it('accepts a per-role arm and reports it as not single-model', () => {
    const config = parseOk(
      baseConfig({
        arms: [
          {
            name: 'mixed',
            roleModels: {
              generation: 'zai.glm-5',
              repair: 'qwen.qwen3-coder-30b-a3b-instruct',
              orchestration: 'zai.glm-5',
              teaching: 'zai.glm-5',
              'hard-planning': 'zai.glm-5',
            },
          },
        ],
      }),
    );
    const arm = config.arms[0];
    expect(arm === undefined ? true : isSingleModel(arm)).toBe(false);
    expect(arm?.roleModels.repair).toBe('qwen.qwen3-coder-30b-a3b-instruct');
  });

  it('dedupes and sorts the reported k values', () => {
    expect(parseOk(baseConfig()).ks).toEqual([1, 5]);
  });

  it('defaults concurrency, retry, kill switch, and prices when they are omitted', () => {
    const config = parseOk(baseConfig());
    expect(config.concurrency).toBe(2);
    expect(config.transportRetry).toEqual(DEFAULT_TRANSPORT_RETRY_POLICY);
    expect(config.killSwitch).toEqual(DEFAULT_KILL_SWITCH_BOUNDS);
    expect(config.prices).toEqual({});
  });
});

describe('parseSweepConfig - artifact capture', () => {
  it('defaults to capturing artifacts, because a campaign exists to be tuned', () => {
    // A default of off would make every run as blind as the smoke sweep was: it disagreed
    // with the independent judge on two of three problems and could not say why.
    expect(parseOk(baseConfig()).captureArtifacts).toBe(true);
    expect(DEFAULT_CAPTURE_ARTIFACTS).toBe(true);
  });

  it('accepts an explicit opt-out', () => {
    expect(parseOk(baseConfig({ captureArtifacts: false })).captureArtifacts).toBe(false);
  });

  it('refuses a non-boolean rather than reading "false" as truthy', () => {
    const error = parseErr(baseConfig({ captureArtifacts: 'false' }));
    expect(error.code).toBe('FIELD_NOT_A_BOOLEAN');
    expect(error.field).toBe('captureArtifacts');
  });

  it('ignores keys prefixed with an underscore so the file can carry comments', () => {
    expect(parseOk(baseConfig({ _note: 'this is documentation' })).runName).toBe('bakeoff-v1');
  });

  it('parses the committed smoke config', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const text = await readFile(resolve(here, 'sweep.config.smoke.json'), 'utf8');
    const parsed = parseSweepConfig(JSON.parse(text));
    expect(parsed.ok).toBe(true);
  });

  it('parses the committed example config', async () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const text = await readFile(resolve(here, 'sweep.config.example.json'), 'utf8');
    const parsed = parseSweepConfig(JSON.parse(text));
    expect(parsed.ok).toBe(true);
  });
});

describe('parseSweepConfig - a model id is never checked against a catalog', () => {
  it('accepts an arbitrary model id, because the upstream catalog moves without us', () => {
    const config = parseOk(
      baseConfig({ arms: [{ name: 'future', model: 'vendor.not-yet-released' }] }),
    );
    expect(config.arms[0]?.roleModels.generation).toBe('vendor.not-yet-released');
  });
});

describe('parseSweepConfig - arms', () => {
  it('rejects an arm that declares both a single model and a per-role map', () => {
    const error = parseErr(
      baseConfig({ arms: [{ name: 'both', model: 'zai.glm-5', roleModels: {} }] }),
    );
    expect(error.code).toBe('ARM_MODEL_AMBIGUOUS');
    expect(error.field).toBe('arms[0]');
  });

  it('rejects a per-role map missing a role rather than back-filling it', () => {
    const error = parseErr(
      baseConfig({ arms: [{ name: 'partial', roleModels: { generation: 'zai.glm-5' } }] }),
    );
    expect(error.code).toBe('ARM_ROLE_MODEL_MISSING');
    expect(error.field).toContain('roleModels.');
  });

  it('rejects a duplicated arm name, because names key every persisted record', () => {
    const error = parseErr(
      baseConfig({
        arms: [
          { name: 'same', model: 'zai.glm-5' },
          { name: 'same', model: 'deepseek.v3.2' },
        ],
      }),
    );
    expect(error.code).toBe('ARM_NAME_DUPLICATED');
  });

  it('rejects an arm name that could be unsafe in a filename or a log line', () => {
    const error = parseErr(baseConfig({ arms: [{ name: '../escape', model: 'zai.glm-5' }] }));
    expect(error.code).toBe('ARM_INVALID');
    expect(error.field).toBe('arms[0].name');
  });

  it('rejects an empty arms array', () => {
    expect(parseErr(baseConfig({ arms: [] })).field).toBe('arms');
  });
});

describe('parseSweepConfig - problem selection', () => {
  it('accepts an explicit id list and dedupes it', () => {
    const config = parseOk(
      baseConfig({ problems: { kind: 'ids', ids: ['rtllm/a/x', 'rtllm/a/x', 'rtllm/b/y'] } }),
    );
    expect(config.problems).toEqual({ kind: 'ids', ids: ['rtllm/a/x', 'rtllm/b/y'] });
  });

  it('accepts a category filter and narrows each entry to a known category', () => {
    const config = parseOk(
      baseConfig({ problems: { kind: 'categories', categories: ['Arithmetic', 'Control'] } }),
    );
    expect(config.problems).toEqual({
      kind: 'categories',
      categories: ['Arithmetic', 'Control'],
    });
  });

  it('rejects an unknown category rather than silently dropping it', () => {
    const error = parseErr(
      baseConfig({ problems: { kind: 'categories', categories: ['Analog'] } }),
    );
    expect(error.code).toBe('PROBLEM_SELECTION_INVALID');
  });

  it('rejects an unrecognized selection kind rather than defaulting to running everything', () => {
    expect(parseErr(baseConfig({ problems: { kind: 'most' } })).field).toBe('problems.kind');
  });
});

describe('parseSweepConfig - sampling and k', () => {
  it('rejects a k greater than sampleCount, which would make pass@k ill-defined', () => {
    const error = parseErr(baseConfig({ sampleCount: 2, ks: [1, 5] }));
    expect(error.code).toBe('K_OUT_OF_RANGE');
    expect(error.field).toBe('ks[1]');
  });

  it('rejects a temperature outside the accepted range', () => {
    expect(parseErr(baseConfig({ temperature: 3 })).field).toBe('temperature');
  });

  it('rejects a non-integer seed', () => {
    expect(parseErr(baseConfig({ seed: 1.5 })).field).toBe('seed');
  });
});

describe('parseSweepConfig - a typo must never take a default silently', () => {
  it('rejects an unknown top-level field', () => {
    const error = parseErr(baseConfig({ sampleCounts: 5 }));
    expect(error.code).toBe('UNKNOWN_FIELD');
    expect(error.field).toBe('sampleCounts');
  });

  it('rejects a misspelled kill-switch knob instead of granting the default bound', () => {
    const error = parseErr(baseConfig({ killSwitch: { maxWallClokMs: 1_000 } }));
    expect(error.code).toBe('UNKNOWN_FIELD');
    expect(error.field).toBe('killSwitch.maxWallClokMs');
  });

  it('rejects a misspelled retry knob', () => {
    expect(parseErr(baseConfig({ transportRetry: { maxAttempt: 2 } })).code).toBe('UNKNOWN_FIELD');
  });
});

describe('parseSweepConfig - structural refusals', () => {
  it('rejects a non-object config', () => {
    expect(parseErr(['not', 'an', 'object']).code).toBe('NOT_AN_OBJECT');
  });

  it('rejects an unsupported schema version', () => {
    expect(parseErr(baseConfig({ schemaVersion: 2 })).code).toBe('SCHEMA_VERSION_UNSUPPORTED');
  });

  it('rejects an outputDir containing a parent traversal', () => {
    expect(parseErr(baseConfig({ outputDir: '../../elsewhere' })).field).toBe('outputDir');
  });

  it('rejects a missing caps block', () => {
    const config = baseConfig();
    delete config.caps;
    expect(parseErr(config).code).toBe('FIELD_MISSING');
  });

  it('rejects a malformed price entry rather than dropping it and understating spend', () => {
    const error = parseErr(
      baseConfig({ prices: { 'zai.glm-5': { inputCentsPerMillionTokens: 'cheap' } } }),
    );
    expect(error.code).toBe('PRICE_INVALID');
  });
});

describe('arm cost knowledge', () => {
  const tasks = ['generation', 'repair', 'orchestration', 'teaching', 'hard-planning'] as const;

  it('is known only when every model the arm uses has a price', () => {
    const config = parseOk(
      baseConfig({
        arms: [
          {
            name: 'mixed',
            roleModels: {
              generation: 'zai.glm-5',
              repair: 'deepseek.v3.2',
              orchestration: 'zai.glm-5',
              teaching: 'zai.glm-5',
              'hard-planning': 'zai.glm-5',
            },
          },
        ],
        prices: {
          'zai.glm-5': { inputCentsPerMillionTokens: 60, outputCentsPerMillionTokens: 220 },
        },
      }),
    );
    const arm = config.arms[0];
    expect(arm === undefined ? true : armCostIsKnown(arm, tasks, config.prices)).toBe(false);
    expect(arm === undefined ? '' : modelSignatureOf(arm, tasks)).toContain('repair=deepseek.v3.2');
  });

  it('is known when the one model of a single-model arm is priced', () => {
    const config = parseOk(
      baseConfig({
        prices: {
          'zai.glm-5': { inputCentsPerMillionTokens: 60, outputCentsPerMillionTokens: 220 },
        },
      }),
    );
    const arm = config.arms[0];
    expect(arm === undefined ? false : armCostIsKnown(arm, tasks, config.prices)).toBe(true);
    expect(arm === undefined ? '' : modelSignatureOf(arm, tasks)).toBe('zai.glm-5');
  });
});

describe('parseSweepConfig - the negative-control block', () => {
  it('defaults to enabled, with the two wall-clock knobs and nothing else', () => {
    // Defaulting off would leave every future campaign unable to see the class that produced
    // `MISSED BUGS: 1` in smoke-v4-oracle: a testbench that passes everything.
    expect(parseOk(baseConfig()).negativeControl).toEqual(DEFAULT_NEGATIVE_CONTROL_CONFIG);
    expect(DEFAULT_NEGATIVE_CONTROL_ENABLED).toBe(true);
    // The gate is zero coverage-gap survivors, which is not a tunable fraction, so there is no
    // threshold field left to default. What remains is the mutant BUDGET and the per-mutant WALL
    // CAP: how many mutant runs, and how long any one of them may take.
    expect(Object.keys(DEFAULT_NEGATIVE_CONTROL_CONFIG).sort()).toEqual([
      'enabled',
      'maxMutantsPerProblem',
      'mutantWallMs',
    ]);
    expect(DEFAULT_NEGATIVE_CONTROL_CONFIG.mutantWallMs).toBe(DEFAULT_MUTANT_WALL_MS);
  });

  it('accepts an explicit opt-out, since the wall clock is real', () => {
    const config = parseOk(baseConfig({ negativeControl: { enabled: false } }));

    expect(config.negativeControl.enabled).toBe(false);
    // The other fields still default, so a partial block is not a partial configuration.
    expect(config.negativeControl.maxMutantsPerProblem).toBe(
      DEFAULT_NEGATIVE_CONTROL_CONFIG.maxMutantsPerProblem,
    );
    expect(config.negativeControl.mutantWallMs).toBe(DEFAULT_NEGATIVE_CONTROL_CONFIG.mutantWallMs);
  });

  it('accepts a narrower mutant budget', () => {
    const config = parseOk(baseConfig({ negativeControl: { maxMutantsPerProblem: 12 } }));

    expect(config.negativeControl.maxMutantsPerProblem).toBe(12);
  });

  it('given an explicit mutant wall cap in range, when parsed, then it is carried through', () => {
    const config = parseOk(baseConfig({ negativeControl: { mutantWallMs: 8_000 } }));

    expect(config.negativeControl.mutantWallMs).toBe(8_000);
    // And the STUDENT cap is untouched: the mutant cap replaces the wall clock for mutant runs
    // only, and never edits the limits the loop itself runs under.
    expect(config.limits.wallMs).toBe(30_000);
  });

  it('given a zero or negative mutant wall cap, when parsed, then it is REFUSED', () => {
    // Not merely slow: a cap below the real-run band MANUFACTURES timeouts, and a timeout is a
    // golden kill that enlarges the gate set - so an under-set cap corrupts the measurement.
    expect(parseErr(baseConfig({ negativeControl: { mutantWallMs: 0 } })).field).toBe(
      'mutantWallMs',
    );
    expect(parseErr(baseConfig({ negativeControl: { mutantWallMs: -1 } })).field).toBe(
      'mutantWallMs',
    );
    expect(
      parseErr(baseConfig({ negativeControl: { mutantWallMs: MIN_MUTANT_WALL_MS - 1 } })).field,
    ).toBe('mutantWallMs');
  });

  it('given an absurd mutant wall cap, when parsed, then it is REFUSED', () => {
    // Past a minute the cap is not bounding a hang, it is one - multiplied by
    // mutants x samples x problems.
    expect(
      parseErr(baseConfig({ negativeControl: { mutantWallMs: MAX_MUTANT_WALL_MS + 1 } })).field,
    ).toBe('mutantWallMs');
    expect(parseErr(baseConfig({ negativeControl: { mutantWallMs: 86_400_000 } })).field).toBe(
      'mutantWallMs',
    );
  });

  it('given a non-integer mutant wall cap, when parsed, then it is REFUSED', () => {
    expect(parseErr(baseConfig({ negativeControl: { mutantWallMs: 5_000.5 } })).field).toBe(
      'mutantWallMs',
    );
    expect(parseErr(baseConfig({ negativeControl: { mutantWallMs: '5000' } })).field).toBe(
      'mutantWallMs',
    );
  });

  it('refuses the RETIRED minKillRate, so a stale config cannot look like it still gates', () => {
    // It used to be accepted and used to decide validity. Silently ignoring it would leave an
    // operator believing they had set a bar that no longer exists, which is worse than a typo.
    const error = parseErr(baseConfig({ negativeControl: { minKillRate: 0.8 } }));

    expect(error.field).toContain('negativeControl');
  });

  it('refuses an unusable mutant budget', () => {
    expect(parseErr(baseConfig({ negativeControl: { maxMutantsPerProblem: 0 } })).field).toBe(
      'maxMutantsPerProblem',
    );
  });

  it('refuses an unrecognized key, so a typo cannot silently take a default', () => {
    const error = parseErr(baseConfig({ negativeControl: { maxmutantsperproblem: 5 } }));

    expect(error.field).toContain('negativeControl');
  });

  it('refuses a non-object block', () => {
    expect(parseErr(baseConfig({ negativeControl: true })).code).toBe('FIELD_NOT_AN_OBJECT');
  });

  it('derives the mutation config from the parsed sweep config', () => {
    const config = parseOk(baseConfig({ negativeControl: { maxMutantsPerProblem: 9 } }));

    // Derived, never stored: the cache key hashes the mutation config, so it must be a function
    // of the sweep config alone or the two could disagree.
    expect(mutationConfigFor(config).maxMutantsPerProblem).toBe(9);
    expect(mutationConfigFor(config).operators).toEqual(MUTATION_OPERATORS);
  });
});
