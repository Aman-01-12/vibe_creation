// Property 2 over the Local_Worker_Runtime's own diagnostics, without spawning anything; task
// 1.5's test owns the child and its stdout. See design.md, Component C2.
//
// Containment alone cannot decide a leak: a short value is a substring of ordinary prose and `''`
// is a substring of everything. So each case is emitted twice under disjoint values, and a value
// counts as leaked only where the disjoint emission does not hold it too.
//
// Values are materialized from a closed kind union inside the property and every assertion is
// phrased over names and labels, so no counterexample prints a value (Req 1.9).
//
// **Validates: Requirements 1.8, 1.9**

import { readFileSync } from 'node:fs';

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  TOOL_RUNNER_WORKSPACE_ENV,
  WORKER_ENVIRONMENT_ALLOWLIST,
  WORKER_ENV_ABSENT_NOTE,
  WORKER_SOURCE_ROOT,
  WORKSPACE_CLEANUP_FAILED_NOTE,
  workerSpawnEnvironment,
} from '@app/tools';

import { propertyParameters } from './property.js';

// Feature: formal-gate-first-light, Property 2: No environment value reaches any emitted text
const PROPERTY =
  'formal-gate-first-light, Property 2: No environment value reaches any emitted text';

/** Two shapes below need one specific name drawn with one specific kind, so 2000. */
const NUM_RUNS = 2000;

/** A host environment as `workerSpawnEnvironment` declares it. */
type HostEnvironment = Readonly<Record<string, string | undefined>>;

// -- The two value assignments -----------------------------------------------

const VALUE_KINDS = [
  'unset',
  'empty',
  'prose-word',
  'variable-name',
  'secret',
  'secret-extended',
  'secret-embedded',
] as const;

type ValueKind = (typeof VALUE_KINDS)[number];

/** The last three nest, so a containment check cannot pass by matching only the longest. */
const VALUE_BY_KIND: Record<ValueKind, string | undefined> = {
  unset: undefined,
  empty: '',
  'prose-word': 'worker',
  'variable-name': 'PATH',
  secret: 'Q7rare',
  'secret-extended': 'Q7rare-tail',
  'secret-embedded': 'head-Q7rare-tail',
};

/** Same presence per kind, disjoint contents: the text a value could not have influenced. */
const ALT_VALUE_BY_KIND: Record<ValueKind, string | undefined> = {
  unset: undefined,
  empty: '',
  'prose-word': 'Z9',
  'variable-name': 'Z9m',
  secret: 'Z9mm',
  'secret-extended': 'Z9mmm',
  'secret-embedded': 'Z9mmmm',
};

/** The workspace root becomes a child environment value, so it is a value under test too. */
const ROOT = '/tmp/tr-W4root';
const ALT_ROOT = '/tmp/tr-Z9root';

/** Non-empty values under each assignment. The disjointness test below reads these. */
const PRIMARY_VALUES = [...VALUE_KINDS.map((kind) => VALUE_BY_KIND[kind]), ROOT].filter(
  (value): value is string => value !== undefined && value !== '',
);

const ALTERNATE_VALUES = [...VALUE_KINDS.map((kind) => ALT_VALUE_BY_KIND[kind]), ALT_ROOT].filter(
  (value): value is string => value !== undefined && value !== '',
);

// -- Generators ---------------------------------------------------------------

/** The two the runtime sets itself, plus a credential's name. Only its value is secret. */
const OTHER_HOST_NAMES = [
  'HOME',
  'AWS_BEARER_TOKEN_BEDROCK',
  'PYTHONPATH',
  TOOL_RUNNER_WORKSPACE_ENV,
] as const;

const hostNameArbitrary: fc.Arbitrary<string> = fc.oneof(
  { arbitrary: fc.constantFrom(...WORKER_ENVIRONMENT_ALLOWLIST), weight: 4 },
  { arbitrary: fc.constantFrom(...OTHER_HOST_NAMES), weight: 4 },
  { arbitrary: fc.string({ unit: 'grapheme' }), weight: 2 },
);

/** Draw-order entries, so a repeated name resolves the way an assignment would. */
const hostEntriesArbitrary = fc.array(
  fc.tuple(hostNameArbitrary, fc.constantFrom(...VALUE_KINDS)),
  { maxLength: 10 },
);

/** `Object.fromEntries` defines own properties, so `__proto__` lands as a key, not a prototype. */
function materialize(
  entries: readonly (readonly [string, ValueKind])[],
  assignment: Record<ValueKind, string | undefined>,
): HostEnvironment {
  return Object.fromEntries(entries.map(([name, kind]) => [name, assignment[kind]]));
}

// -- What the runtime emits, and what it must not hold -----------------------

const EMISSIONS = ['absence-note', 'cleanup-note'] as const;

type Emission = (typeof EMISSIONS)[number];

/**
 * Every text the runtime hands its note sink, for one host environment. `''` stands for a note it
 * did not emit. The absence note mirrors the template in `#runWorker`; the structural test below
 * pins that these two are all of them.
 */
function emit(host: HostEnvironment, root: string): Record<Emission, string> {
  const { absent } = workerSpawnEnvironment(host, root);
  return {
    'absence-note': absent.length > 0 ? `${WORKER_ENV_ABSENT_NOTE} ${absent.join(', ')}` : '',
    'cleanup-note': WORKSPACE_CLEANUP_FAILED_NOTE,
  };
}

/** Every value a diagnostic could leak: the host's own, and the ones the child receives. */
function valuesUnderTest(
  host: HostEnvironment,
  root: string,
): readonly (readonly [string, string])[] {
  // `NodeJS.ProcessEnv` admits an undefined value, so the child side is filtered the same way.
  const entries = [
    ...Object.entries(host),
    ...Object.entries(workerSpawnEnvironment(host, root).env).map(
      ([name, value]) => [`child:${name}`, value] as const,
    ),
  ];
  return entries.flatMap(([name, value]) => (value === undefined ? [] : [[name, value] as const]));
}

/** Identical under both assignments, so neither check below can see it; asserted directly. */
const CONSTANT_CHILD_VALUES: readonly string[] = [WORKER_SOURCE_ROOT];

// -- Non-vacuity: the shapes a leaking diagnostic would show up in -----------

const SHAPES = [
  'absence-note-emitted',
  'absence-note-silent',
  'empty-value-held',
  'key-without-value',
  'prose-word-value-held',
  'allowlisted-name-as-value',
  'nested-values-held',
  'foreign-name-held',
] as const;

type Shape = (typeof SHAPES)[number];

/** Values the host holds. `undefined` is a key it holds with nothing in it. */
function heldValues(host: HostEnvironment): readonly string[] {
  return Object.values(host).filter((value): value is string => value !== undefined);
}

const EXHIBITS: Record<Shape, (host: HostEnvironment) => boolean> = {
  'absence-note-emitted': (host) => emit(host, ROOT)['absence-note'] !== '',
  'absence-note-silent': (host) => emit(host, ROOT)['absence-note'] === '',
  'empty-value-held': (host) => heldValues(host).includes(''),
  'key-without-value': (host) => Object.values(host).includes(undefined),
  // Excludes `''`, which every string contains and which therefore shows nothing.
  'prose-word-value-held': (host) =>
    heldValues(host).some(
      (value) =>
        value !== '' &&
        (WORKER_ENV_ABSENT_NOTE.includes(value) || WORKSPACE_CLEANUP_FAILED_NOTE.includes(value)),
    ),
  'allowlisted-name-as-value': (host) =>
    heldValues(host).some((value) => WORKER_ENVIRONMENT_ALLOWLIST.includes(value)),
  'nested-values-held': (host) => {
    const held = heldValues(host).filter((value) => value !== '');
    return held.some((inner) => held.some((outer) => outer !== inner && outer.includes(inner)));
  },
  'foreign-name-held': (host) =>
    Object.keys(host).some((name) => !WORKER_ENVIRONMENT_ALLOWLIST.includes(name)),
};

function zeroedShapeCounts(): Record<Shape, number> {
  return {
    'absence-note-emitted': 0,
    'absence-note-silent': 0,
    'empty-value-held': 0,
    'key-without-value': 0,
    'prose-word-value-held': 0,
    'allowlisted-name-as-value': 0,
    'nested-values-held': 0,
    'foreign-name-held': 0,
  };
}

// -- The source of the emission channel, read as text ------------------------

const RUNTIME_MODULE = '../tools/sandbox/runtime-local-worker.ts';

/** The two expressions `#noteSink` is called with. A third emission fails the test below. */
const NOTE_SINK_ARGUMENTS: readonly string[] = [
  "`${WORKER_ENV_ABSENT_NOTE} ${absent.join(', ')}`",
  'note',
];

// -- Property 2 ---------------------------------------------------------------

describe(PROPERTY, () => {
  it('emits no line holding an environment value, and no line that varies with one', () => {
    const seen = zeroedShapeCounts();

    fc.assert(
      fc.property(hostEntriesArbitrary, (entries) => {
        const host = materialize(entries, VALUE_BY_KIND);
        const alternateHost = materialize(entries, ALT_VALUE_BY_KIND);
        for (const shape of SHAPES) {
          if (EXHIBITS[shape](host)) {
            seen[shape] += 1;
          }
        }

        const primary = emit(host, ROOT);
        const alternate = emit(alternateHost, ALT_ROOT);

        // A value present in text built WITHOUT it is prose, not a leak. Reported by name.
        const leaked = valuesUnderTest(host, ROOT)
          .filter(([, value]) =>
            EMISSIONS.some(
              (label) => primary[label].includes(value) && !alternate[label].includes(value),
            ),
          )
          .map(([name]) => name);
        expect(leaked).toEqual([]);

        // The stronger form, which also catches a value that coincides with the prose.
        const varying = EMISSIONS.filter((label) => primary[label] !== alternate[label]);
        expect(varying).toEqual([]);

        const namingConstant = EMISSIONS.filter((label) =>
          CONSTANT_CHILD_VALUES.some((value) => primary[label].includes(value)),
        );
        expect(namingConstant).toEqual([]);
      }),
      propertyParameters({ numRuns: NUM_RUNS }),
    );

    for (const shape of SHAPES) {
      expect(seen[shape], `no draw exercised ${shape}`).toBeGreaterThan(0);
    }
  });

  it('draws two disjoint value assignments, so no leak can be absolved as prose', () => {
    const overlapping = ALTERNATE_VALUES.filter((alternate) =>
      PRIMARY_VALUES.some((value) => alternate.includes(value)),
    );
    expect(overlapping).toEqual([]);

    const presenceDiffers = VALUE_KINDS.filter(
      (kind) => (VALUE_BY_KIND[kind] === undefined) !== (ALT_VALUE_BY_KIND[kind] === undefined),
    );
    expect(presenceDiffers).toEqual([]);
  });

  it('emits through two note expressions only, and reads the host environment once', () => {
    const source = readFileSync(new URL(RUNTIME_MODULE, import.meta.url), 'utf8');

    const emitted = [...source.matchAll(/#noteSink\((.*)\);/g)].map((match) => match[1] ?? '');
    expect([...emitted].sort()).toEqual([...NOTE_SINK_ARGUMENTS].sort());

    expect([...source.matchAll(/process\.env/g)]).toHaveLength(1);
    expect(source).toContain('workerSpawnEnvironment(process.env, workspaceRoot)');
  });
});
