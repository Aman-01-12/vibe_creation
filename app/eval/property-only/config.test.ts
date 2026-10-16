// What the Property_Only_Mode's configuration boundary REFUSES.
//
// A config file is external input, so every assertion here is about a refusal and about the
// FIELD it names: criterion 10.4 is satisfied by a run that refuses to start and says which
// configuration value it refused, not by one that ignores the value.

import { describe, expect, it } from 'vitest';

import { DECLARED_LIMITS } from '../measurement-limit.js';
import {
  bypassShapedKeyIn,
  parsePropertyOnlyConfig,
  PROPERTY_ONLY_CONFIG_KEYS,
  REQUIRED_AUTHORING_MODELS,
} from './config.js';

/** A config that parses, so every refusal below is one field away from an accepted file. */
function validConfig(): Record<string, unknown> {
  return {
    runName: 'property-only-cost-pilot',
    outputDir: '.eval-runs/property-only-cost-pilot',
    region: 'us-east-1',
    authoringModels: ['zai.glm-5', 'moonshotai.kimi-k2.5'],
    costPilotDesignIds: [
      'rtllm/arithmetic/adder_8bit',
      'rtllm/control/counter_12',
      'rtllm/arithmetic/adder_16bit',
    ],
    limits: { cpu: 1, memMb: 2048, procs: 128, diskMb: 512, wallMs: 300_000 },
    caps: {
      maxIterations: 12,
      maxTokens: 1_000_000,
      maxWallClockMs: 900_000,
      maxCostCents: 100_000,
    },
    extrapolationFrom: null,
  };
}

describe('parsePropertyOnlyConfig', () => {
  it('accepts the example shape and carries no extrapolation by default', () => {
    const parsed = parsePropertyOnlyConfig(validConfig());

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    // No recorded extrapolation is what confines the first run to the Cost_Pilot (Req 5.6).
    expect(parsed.value.extrapolationFrom).toBeNull();
    expect(parsed.value.authoringModels).toEqual(REQUIRED_AUTHORING_MODELS);
  });

  it('defaults authoringModels to the two models criterion 5.11 names', () => {
    // Deleted rather than destructured away: `ignoreRestSiblings` is false in this repo, so the
    // omit-a-key rest destructure is a lint error.
    const config = validConfig();
    delete config.authoringModels;
    const parsed = parsePropertyOnlyConfig(config);

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.value.authoringModels).toEqual(REQUIRED_AUTHORING_MODELS);
  });

  it.each([
    'skipInstrumentAdmission',
    'instrumentAdmission',
    'bypassGate',
    'trustLabel',
    'formalVerdict',
    'fallbackRoute',
    'disableAdmission',
  ])('refuses the bypass-shaped key %s BY NAME', (key) => {
    const parsed = parsePropertyOnlyConfig({ ...validConfig(), [key]: true });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    // The criterion is "names that configuration value", so the key itself is the field.
    expect(parsed.error.field).toBe(key);
    expect(parsed.error.message).toContain(key);
    expect(parsed.error.message).toContain('Student_Path');
  });

  it('refuses a bypass-shaped key NESTED inside an otherwise legal block', () => {
    const config = validConfig();
    const parsed = parsePropertyOnlyConfig({
      ...config,
      limits: { ...(config.limits as Record<string, unknown>), skipAdmission: true },
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.field).toBe('skipAdmission');
  });

  it('holds no key of its own that the bypass pattern would refuse', () => {
    // Non-vacuity for the rule above: if a legitimate key ever matched the pattern, every
    // config would refuse and the test above would pass for the wrong reason.
    for (const key of PROPERTY_ONLY_CONFIG_KEYS) {
      expect(bypassShapedKeyIn({ [key]: 1 })).toBeNull();
    }
  });

  it('refuses an unrecognized key by name, so a typo is not a silent default', () => {
    const parsed = parsePropertyOnlyConfig({ ...validConfig(), costPilotDesign: [] });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.code).toBe('UNKNOWN_FIELD');
    expect(parsed.error.field).toBe('costPilotDesign');
  });

  it('refuses an outputDir whose last segment is not the measurement name (Req 9.10)', () => {
    const parsed = parsePropertyOnlyConfig({
      ...validConfig(),
      outputDir: '.eval-runs/formal-gate-v1-pilot',
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.field).toBe('outputDir');
    expect(parsed.error.message).toContain('runName');
  });

  it.each(['/tmp/property-only-cost-pilot', '../property-only-cost-pilot'])(
    'refuses the escaping outputDir %s',
    (outputDir) => {
      const parsed = parsePropertyOnlyConfig({ ...validConfig(), outputDir });

      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.error.field).toBe('outputDir');
    },
  );

  it.each([['zai.glm-5'], ['moonshotai.kimi-k2.5']])(
    'refuses an authoringModels list of only %s',
    (model) => {
      const parsed = parsePropertyOnlyConfig({ ...validConfig(), authoringModels: [model] });

      expect(parsed.ok).toBe(false);
      if (parsed.ok) return;
      expect(parsed.error.field).toBe('authoringModels');
    },
  );

  it('refuses a two-model list that drops one of the two required models', () => {
    const parsed = parsePropertyOnlyConfig({
      ...validConfig(),
      authoringModels: ['zai.glm-5', 'qwen.qwen3-coder-30b-a3b-instruct'],
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.message).toContain('moonshotai.kimi-k2.5');
  });

  it('accepts a third model, because the list is a list rather than a pair', () => {
    const parsed = parsePropertyOnlyConfig({
      ...validConfig(),
      authoringModels: [...REQUIRED_AUTHORING_MODELS, 'qwen.qwen3-coder-30b-a3b-instruct'],
    });

    expect(parsed.ok).toBe(true);
  });

  it('refuses more Cost_Pilot designs than the DECLARED limit allows (Req 5.5)', () => {
    const allowed = DECLARED_LIMITS['cost-pilot-design-count']?.value ?? 0;
    const tooMany = Array.from({ length: allowed + 1 }, (_unused, index) => `design-${index}`);
    const parsed = parsePropertyOnlyConfig({ ...validConfig(), costPilotDesignIds: tooMany });

    expect(allowed).toBeGreaterThan(0);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.field).toBe('costPilotDesignIds');
    expect(parsed.error.message).toContain('cost-pilot-design-count');
  });

  it('refuses a duplicated design id without echoing the value back', () => {
    const parsed = parsePropertyOnlyConfig({
      ...validConfig(),
      costPilotDesignIds: ['rtllm/arithmetic/adder_8bit', 'rtllm/arithmetic/adder_8bit'],
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    // A config can hold a pasted credential, so a message names the field and not the value.
    expect(parsed.error.message).not.toContain('adder_8bit');
  });

  it('refuses a region that is not a region label, because it reaches the endpoint URL', () => {
    const parsed = parsePropertyOnlyConfig({
      ...validConfig(),
      region: 'us-east-1/../evil.example.com',
    });

    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.field).toBe('region');
  });

  it.each([
    ['limits', { cpu: 1, memMb: 2048, procs: 128, diskMb: 512 }],
    ['caps', { maxIterations: 12, maxTokens: 1_000_000, maxWallClockMs: 900_000 }],
  ])('refuses an incomplete %s block rather than defaulting the missing field', (key, block) => {
    const parsed = parsePropertyOnlyConfig({ ...validConfig(), [key]: block });

    expect(parsed.ok).toBe(false);
  });

  it('refuses anything that is not an object', () => {
    for (const raw of [null, 42, 'config', [validConfig()]]) {
      expect(parsePropertyOnlyConfig(raw).ok).toBe(false);
    }
  });
});
