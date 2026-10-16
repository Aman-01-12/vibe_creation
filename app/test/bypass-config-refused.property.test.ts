// Feature: formal-gate-first-light, Property 33: A bypass-shaped configuration refuses to start
// by name.
//
// The design states it as: for any configuration value that would bypass the
// Instrument_Admission step on the Student_Path, the run refuses to start and names that
// configuration value (Req 10.4).
//
// Two things make this a property rather than a restatement of the example cases beside the
// boundary in `app/eval/property-only/config.test.ts`:
//
//   1. "BY NAME" is load-bearing. `parsePropertyOnlyConfig` checks for a bypass-shaped key
//      BEFORE the generic unknown-key check, and the two refusals are operator-facing
//      different: the bypass one names the key and says it is shaped like a step or an outcome
//      of the Student_Path, the generic one says only that the field is not recognized. So each
//      case asserts the named field, the key inside the message, the explanation, AND the
//      absence of the generic text. A refusal that merely failed to parse does not pass.
//   2. The boundary's key-name pattern is deliberately open-ended so it catches the NEXT such
//      name and not only the ones someone thought of today. So the key is generated across
//      every alternative of that pattern, in three casings, with innocuous camel affixes, and
//      planted at the top level, inside an otherwise legal block, inside a legal array, and at
//      every record nesting level the walk reaches.
//
// The pattern's alternatives and the placements are both CLOSED sets, and each is load-bearing
// on its own, so their cross product is exhausted rather than sampled; sampling 96 cases at 100
// runs leaves a real chance of missing one, and raising `numRuns` is the wrong lever for a
// closed vocabulary. The generated property then covers the open dimension, which is the shape
// of the surrounding name.
//
// The positive control is what stops that from passing for the wrong reason: a pattern that
// matched everything would refuse every config, valid ones included. So a generated LEGAL config
// is asserted to parse, and every legal key name - the declared top-level keys plus the nested
// `limits` and `caps` keys, derived from the valid config rather than restated - is asserted not
// to match.
//
// The tag above is a literal rather than `propertyTag(...)`, because that helper's `FEATURE_TAG`
// is hardcoded to a different spec's slug.
//
// Validates: Requirements 10.4

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  bypassShapedKeyIn,
  DECLARED_LIMITS,
  parsePropertyOnlyConfig,
  PROPERTY_ONLY_CONFIG_KEYS,
  REQUIRED_AUTHORING_MODELS,
} from '@app/eval';

import { propertyParameters } from './property.js';

const PROPERTY =
  'formal-gate-first-light, Property 33: A bypass-shaped configuration refuses to start by name';

/** The declared Cost_Pilot bound, read from the registry so the control stays legal (Req 5.5). */
const COST_PILOT_DESIGN_COUNT = DECLARED_LIMITS['cost-pilot-design-count']?.value ?? 0;

/**
 * The alternatives of the boundary's own bypass-shaped-key pattern, restated.
 *
 * The pattern is private to `config.ts`, so this is the test's statement of it rather than a
 * shared constant. It cannot drift silently: every key built from a word here is asserted
 * refused, so dropping a word from the pattern fails this property instead of weakening it.
 */
const BYPASS_WORDS = [
  'instrument',
  'admission',
  'bypass',
  'skip',
  'disable',
  'verdict',
  'trust',
  'fallback',
] as const;

/** Camel fragments that do NOT match the pattern, so only the bypass word makes a key match. */
const PREFIXES = ['', 'allow', 'student', 'legacy', 'operator'] as const;
const SUFFIXES = ['', 'Mode', 'Step', 'Route', 'Label', 'Override'] as const;

/** The three casings a case-insensitive pattern must still catch. */
const CASINGS = ['lower', 'upper', 'capital'] as const;
type Casing = (typeof CASINGS)[number];

/**
 * The deepest record nesting level at which the walk still finds a key.
 *
 * The walk inspects a top-level key at depth 0 and descends one depth per record, stopping at a
 * cap of 8, so a key at nesting level n is inspected when n < 8. Level 7 is therefore the last
 * one found, and the test below pins both sides of that boundary.
 */
const DEEPEST_FOUND_LEVEL = 7;

/** The sandbox-limit block, typed so a placement needs no cast. */
interface RawLimits {
  readonly cpu: number;
  readonly memMb: number;
  readonly procs: number;
  readonly diskMb: number;
  readonly wallMs: number;
}

/** The student-cap block, typed for the same reason. */
interface RawCaps {
  readonly maxIterations: number;
  readonly maxTokens: number;
  readonly maxWallClockMs: number;
  readonly maxCostCents: number;
}

/** The raw document this file plants keys into. */
interface RawConfig {
  readonly runName: string;
  readonly outputDir: string;
  readonly region: string;
  readonly authoringModels: readonly string[];
  readonly costPilotDesignIds: readonly string[];
  readonly limits: RawLimits;
  readonly caps: RawCaps;
  readonly extrapolationFrom: string | null;
}

/** The accepted example shape, so every refusal below is one key away from an accepted file. */
function validConfig(): RawConfig {
  return {
    runName: 'property-only-cost-pilot',
    outputDir: '.eval-runs/property-only-cost-pilot',
    region: 'us-east-1',
    authoringModels: [...REQUIRED_AUTHORING_MODELS],
    costPilotDesignIds: ['rtllm/arithmetic/adder_8bit', 'rtllm/control/counter_12'],
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

/**
 * Every key name a legal config may hold, nested ones included.
 *
 * Derived from the valid config rather than restated, so a key added to either block joins the
 * control automatically instead of silently escaping it.
 */
const LEGAL_KEY_NAMES: readonly string[] = [
  ...PROPERTY_ONLY_CONFIG_KEYS,
  ...Object.keys(validConfig().limits),
  ...Object.keys(validConfig().caps),
];

/** Where in the document the generated key is planted. */
type Placement =
  | { readonly kind: 'top' }
  | { readonly kind: 'block'; readonly block: 'limits' | 'caps' }
  | { readonly kind: 'array'; readonly field: 'authoringModels' | 'costPilotDesignIds' }
  | { readonly kind: 'nested'; readonly levels: number };

/**
 * The top level, both legal blocks, both legal arrays, and every nesting level within the cap.
 *
 * A closed list, exhausted below, because each entry is a distinct way for a key to hide: a
 * walk that stopped at the top level, or skipped array entries, would pass a placement-sampling
 * test on the draws it happened to get.
 */
const ALL_PLACEMENTS: readonly Placement[] = [
  { kind: 'top' },
  { kind: 'block', block: 'limits' },
  { kind: 'block', block: 'caps' },
  { kind: 'array', field: 'authoringModels' },
  { kind: 'array', field: 'costPilotDesignIds' },
  ...Array.from({ length: DEEPEST_FOUND_LEVEL }, (_unused, index): Placement => ({
    kind: 'nested',
    levels: index + 1,
  })),
];

/** The word in the given casing. */
function cased(word: string, casing: Casing): string {
  if (casing === 'upper') {
    return word.toUpperCase();
  }
  if (casing === 'capital') {
    return word.slice(0, 1).toUpperCase() + word.slice(1);
  }
  return word;
}

/** `{ [key]: true }` wrapped in `levels` plain containers, none of which matches the pattern. */
function nest(key: string, levels: number): Record<string, unknown> {
  let node: Record<string, unknown> = { [key]: true };
  for (let level = levels; level > 0; level -= 1) {
    node = { [`container${String(level)}`]: node };
  }
  return node;
}

/** A copy of the valid config carrying `key` at the given placement. */
function plant(key: string, placement: Placement): Record<string, unknown> {
  const config = validConfig();
  const document: Record<string, unknown> = { ...config };
  switch (placement.kind) {
    case 'top':
      document[key] = true;
      break;
    case 'block':
      document[placement.block] = { ...config[placement.block], [key]: true };
      break;
    case 'array':
      document[placement.field] = [...config[placement.field], { [key]: true }];
      break;
    case 'nested':
      Object.assign(document, nest(key, placement.levels));
      break;
  }
  return document;
}

/**
 * Assert that `key` at `placement` refuses the run AS a bypass, naming the key.
 *
 * Shared by the exhaustive row and the generated one so both halves hold the refusal to the same
 * standard: a document that merely failed to parse does not satisfy criterion 10.4.
 */
function expectRefusedByName(key: string, placement: Placement): void {
  const document = plant(key, placement);

  expect(bypassShapedKeyIn(document)).toBe(key);

  const parsed = parsePropertyOnlyConfig(document);
  if (parsed.ok) {
    throw new Error(`"${key}" was accepted; a bypass-shaped key must refuse the run`);
  }
  // "Names that configuration value": the bare key, at every depth, never a dotted path.
  expect(parsed.error.field).toBe(key);
  expect(parsed.error.message).toContain(key);
  // And refuses AS a bypass. A generic unknown-key refusal names the key too, so the explanation
  // is the only thing that distinguishes the two, and it is the half of criterion 10.4 that
  // makes the refusal useful to an operator.
  expect(parsed.error.message).toContain('Student_Path');
  expect(parsed.error.message).not.toContain('is not a recognized field');
}

/** A bypass-shaped key: every pattern alternative, in every casing, with camel affixes. */
const arbBypassKey: fc.Arbitrary<string> = fc
  .tuple(
    fc.constantFrom(...PREFIXES),
    fc.constantFrom(...BYPASS_WORDS),
    fc.constantFrom(...CASINGS),
    fc.constantFrom(...SUFFIXES),
  )
  .map(([prefix, word, casing, suffix]) => `${prefix}${cased(word, casing)}${suffix}`);

/** A config that must parse: every field legal, varied across its accepted range. */
const arbLegalConfig: fc.Arbitrary<RawConfig> = fc
  .record({
    runName: fc.constantFrom('property-only-cost-pilot', 'po-1', 'property-only-full-population'),
    region: fc.constantFrom('us-east-1', 'us-west-2', 'eu-central-1'),
    extraModels: fc.subarray(['qwen.qwen3-coder-30b-a3b-instruct', 'anthropic.claude-sonnet-4']),
    designCount: fc.integer({ min: 1, max: COST_PILOT_DESIGN_COUNT }),
    limits: fc.record({
      cpu: fc.integer({ min: 1, max: 8 }),
      memMb: fc.integer({ min: 256, max: 8_192 }),
      procs: fc.integer({ min: 1, max: 256 }),
      diskMb: fc.integer({ min: 16, max: 4_096 }),
      wallMs: fc.integer({ min: 1_000, max: 600_000 }),
    }),
    caps: fc.record({
      maxIterations: fc.integer({ min: 1, max: 100 }),
      maxTokens: fc.integer({ min: 1, max: 10_000_000 }),
      maxWallClockMs: fc.integer({ min: 1, max: 3_600_000 }),
      maxCostCents: fc.integer({ min: 1, max: 1_000_000 }),
    }),
    extrapolationFrom: fc.option(fc.constant('.eval-runs/property-only-cost-pilot'), {
      nil: null,
    }),
  })
  .map((parts) => ({
    runName: parts.runName,
    // Req 9.10: the last segment of the output directory is the measurement's own name.
    outputDir: `.eval-runs/${parts.runName}`,
    region: parts.region,
    authoringModels: [...REQUIRED_AUTHORING_MODELS, ...parts.extraModels],
    costPilotDesignIds: Array.from(
      { length: parts.designCount },
      (_unused, index) => `rtllm/arithmetic/design_${String(index)}`,
    ),
    limits: parts.limits,
    caps: parts.caps,
    extrapolationFrom: parts.extrapolationFrom,
  }));

describe(PROPERTY, () => {
  it('refuses every alternative of the pattern at every placement the walk reaches', () => {
    for (const word of BYPASS_WORDS) {
      for (const placement of ALL_PLACEMENTS) {
        expectRefusedByName(word, placement);
      }
    }
  });

  it('refuses a bypass-shaped key BY NAME whatever name surrounds the bypass word', () => {
    fc.assert(
      fc.property(arbBypassKey, fc.constantFrom(...ALL_PLACEMENTS), expectRefusedByName),
      propertyParameters(),
    );
  });

  it('still parses a legal config, so the pattern is not refusing everything', () => {
    expect(COST_PILOT_DESIGN_COUNT).toBeGreaterThan(0);

    fc.assert(
      fc.property(arbLegalConfig, (config) => {
        expect(bypassShapedKeyIn(config)).toBeNull();

        const parsed = parsePropertyOnlyConfig(config);
        if (!parsed.ok) {
          throw new Error(
            `a legal config was refused at "${parsed.error.field}": ${parsed.error.message}`,
          );
        }
        expect(parsed.value.runName).toBe(config.runName);
      }),
      propertyParameters(),
    );
  });

  it('matches no legal key name, top-level or nested', () => {
    // A closed vocabulary, so it is exhausted rather than sampled. Without this control a
    // pattern that matched everything would pass the property above.
    expect(LEGAL_KEY_NAMES.length).toBeGreaterThan(PROPERTY_ONLY_CONFIG_KEYS.length);
    for (const key of LEGAL_KEY_NAMES) {
      expect(bypassShapedKeyIn({ [key]: 1 })).toBeNull();
    }
  });

  it('finds a key at the deepest level the cap reaches, and refuses past it by another name', () => {
    const deepest = plant('skipAdmission', { kind: 'nested', levels: DEEPEST_FOUND_LEVEL });
    expect(bypassShapedKeyIn(deepest)).toBe('skipAdmission');

    const pastCap = plant('skipAdmission', { kind: 'nested', levels: DEEPEST_FOUND_LEVEL + 1 });
    expect(bypassShapedKeyIn(pastCap)).toBeNull();
    // The cap bounds a hostile file rather than leaving a hole: burying the key takes a container
    // chain, and the chain's own head is not a declared field, so the run still refuses to start.
    // It just refuses by the generic name, without the bypass explanation.
    const parsed = parsePropertyOnlyConfig(pastCap);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.error.field).toBe('container1');
    expect(parsed.error.message).not.toContain('Student_Path');
  });
});
