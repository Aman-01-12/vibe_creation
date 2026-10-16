// Property 24 over the Credential_File provider, driven by a fake `ReadTextFile` and never a
// real file. See design.md of `formal-gate-first-light`, C14.
//
// The scenario is generated as contents KINDS and the contents themselves are materialized
// inside the property, and every outcome is asserted by a one-character identity label rather
// than by the value it stands for, so no counterexample fast-check prints can hold a credential.
//
// Resolving "once per request, from the current source" is two claims, and the read log decides
// both: the number of reads a request caused, and the contents the file held at that request's
// own time. So the file is rewritten before the first request, between requests, and after the
// last one.
//
// **Validates: Requirements 7.10, 7.11**

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { providerCredentialRef, RefreshingSecretManager, type ReadTextFile } from '@app/agent';

import { propertyParameters } from './property.js';

// Feature: formal-gate-first-light, Property 24: The credential is resolved once per request,
// from the current source
const PROPERTY =
  'formal-gate-first-light, Property 24: The credential is resolved once per request, from the current source';

/** Nine interleaving shapes have to appear below, and a short scenario shows few of them. */
const NUM_RUNS = 300;

/** A fake path. No test reads a real Credential_File. */
const CREDENTIAL_PATH = '.secrets/fake-per-request-token';

/** The one ref the Credential_File serves. */
const SERVED_REF = providerCredentialRef('bedrock-mantle');

// -- The file's states, as kinds ---------------------------------------------

const CONTENTS_KINDS = [
  'absent',
  'empty',
  'whitespace',
  'token-a',
  'token-a-padded',
  'token-b',
] as const;

type ContentsKind = (typeof CONTENTS_KINDS)[number];

/** What the fake reader returns per kind. `null` is a file it cannot read. Values are fake. */
const CONTENTS_BY_KIND: Record<ContentsKind, string | null> = {
  absent: null,
  empty: '',
  whitespace: ' \t\n ',
  'token-a': 'not-a-real-credential-aaa',
  'token-a-padded': '  not-a-real-credential-aaa\n',
  'token-b': 'not-a-real-credential-bbb',
};

/** The typed absence, as an outcome label. */
const ABSENT = '-';

/** The identity a request's outcome is asserted by, never the value itself. */
const OUTCOME_BY_KIND: Record<ContentsKind, string> = {
  absent: ABSENT,
  empty: ABSENT,
  whitespace: ABSENT,
  'token-a': 'A',
  'token-a-padded': 'A',
  'token-b': 'B',
};

/** Every usable credential this test materializes, for the table checks below. */
const USABLE_CONTENTS: readonly string[] = CONTENTS_KINDS.flatMap((kind) =>
  OUTCOME_BY_KIND[kind] === ABSENT ? [] : [(CONTENTS_BY_KIND[kind] ?? '').trim()],
);

/** Resolved value back to its label, so a resolved credential is never named directly. */
const OUTCOME_BY_VALUE = new Map<string, string>(
  CONTENTS_KINDS.flatMap((kind) => {
    const contents = CONTENTS_BY_KIND[kind];
    return contents === null ? [] : [[contents.trim(), OUTCOME_BY_KIND[kind]] as const];
  }),
);

type Resolution = Awaited<ReturnType<RefreshingSecretManager['resolveSecret']>>;

/** A label for what one request carried. `?` is a value no generated file held. */
function outcomeOf(resolution: Resolution): string {
  return resolution.ok ? (OUTCOME_BY_VALUE.get(resolution.value) ?? '?') : ABSENT;
}

// -- Generators ---------------------------------------------------------------

/** A write is the operator refreshing the file; a request is one model request. */
type Event = { readonly kind: 'request' } | { readonly kind: 'write'; readonly to: ContentsKind };

interface Scenario {
  readonly initial: ContentsKind;
  readonly events: readonly Event[];
}

const eventArbitrary: fc.Arbitrary<Event> = fc.oneof(
  fc.constant<Event>({ kind: 'request' }),
  fc.record({ kind: fc.constant('write' as const), to: fc.constantFrom(...CONTENTS_KINDS) }),
);

const scenarioArbitrary: fc.Arbitrary<Scenario> = fc.record({
  initial: fc.constantFrom(...CONTENTS_KINDS),
  events: fc.array(eventArbitrary, { minLength: 1, maxLength: 12 }),
});

// -- Running one scenario -----------------------------------------------------

interface RequestObservation {
  /** The label the file's contents at this request's own time should resolve to. */
  readonly expected: string;
  readonly actual: string;
  /** Reads this one request caused. */
  readonly reads: number;
}

interface Run {
  readonly observations: readonly RequestObservation[];
  readonly paths: readonly string[];
}

async function runScenario(scenario: Scenario): Promise<Run> {
  const paths: string[] = [];
  let current: ContentsKind = scenario.initial;
  const readFile: ReadTextFile = (path) => {
    paths.push(path);
    return Promise.resolve(CONTENTS_BY_KIND[current]);
  };
  const manager = new RefreshingSecretManager({ path: CREDENTIAL_PATH, readFile });

  const observations: RequestObservation[] = [];
  for (const event of scenario.events) {
    if (event.kind === 'write') {
      current = event.to;
      continue;
    }
    const readsBefore = paths.length;
    const expected = OUTCOME_BY_KIND[current];
    const resolution = await manager.resolveSecret(SERVED_REF);
    observations.push({
      expected,
      actual: outcomeOf(resolution),
      reads: paths.length - readsBefore,
    });
  }
  return { observations, paths };
}

// -- Non-vacuity: the interleavings this property exists for ------------------

const SHAPES = [
  'write-before-the-first-request',
  'write-between-two-requests',
  'write-after-the-last-request',
  'two-requests-with-no-write-between',
  'absence-becomes-a-credential',
  'credential-becomes-an-absence',
  'credential-replaced-by-another',
  'padded-contents-requested',
  'unusable-contents-requested',
] as const;

type Shape = (typeof SHAPES)[number];

/** The kinds requests saw, in order, plus the write positions around them. */
function shapesOf(scenario: Scenario): ReadonlySet<Shape> {
  const shapes = new Set<Shape>();
  const requested: ContentsKind[] = [];
  let current: ContentsKind = scenario.initial;
  let writesSinceRequest = 0;

  for (const event of scenario.events) {
    if (event.kind === 'write') {
      current = event.to;
      writesSinceRequest += 1;
      continue;
    }
    const first = requested.length === 0;
    if (writesSinceRequest > 0) {
      shapes.add(first ? 'write-before-the-first-request' : 'write-between-two-requests');
    } else if (!first) {
      shapes.add('two-requests-with-no-write-between');
    }
    requested.push(current);
    writesSinceRequest = 0;
  }
  if (requested.length > 0 && writesSinceRequest > 0) {
    shapes.add('write-after-the-last-request');
  }

  requested.forEach((kind, index) => {
    if (kind === 'token-a-padded') {
      shapes.add('padded-contents-requested');
    }
    if (OUTCOME_BY_KIND[kind] === ABSENT) {
      shapes.add('unusable-contents-requested');
    }
    const previous = index === 0 ? undefined : requested[index - 1];
    if (previous === undefined) {
      return;
    }
    const before = OUTCOME_BY_KIND[previous];
    const after = OUTCOME_BY_KIND[kind];
    if (before === ABSENT && after !== ABSENT) {
      shapes.add('absence-becomes-a-credential');
    }
    if (before !== ABSENT && after === ABSENT) {
      shapes.add('credential-becomes-an-absence');
    }
    if (before !== ABSENT && after !== ABSENT && before !== after) {
      shapes.add('credential-replaced-by-another');
    }
  });

  return shapes;
}

function zeroedShapeCounts(): Record<Shape, number> {
  return {
    'write-before-the-first-request': 0,
    'write-between-two-requests': 0,
    'write-after-the-last-request': 0,
    'two-requests-with-no-write-between': 0,
    'absence-becomes-a-credential': 0,
    'credential-becomes-an-absence': 0,
    'credential-replaced-by-another': 0,
    'padded-contents-requested': 0,
    'unusable-contents-requested': 0,
  };
}

// -- Property 24 --------------------------------------------------------------

describe(PROPERTY, () => {
  it('reads the declared path exactly once per request, and carries what it then held', async () => {
    const seen = zeroedShapeCounts();

    await fc.assert(
      fc.asyncProperty(scenarioArbitrary, async (scenario) => {
        for (const shape of shapesOf(scenario)) {
          seen[shape] += 1;
        }

        const { observations, paths } = await runScenario(scenario);

        // Req 7.11: a request carries the source's value at its own time, so a file rewritten
        // mid-run reaches the next request and never a later or an earlier one.
        expect(observations.map((observation) => observation.actual)).toEqual(
          observations.map((observation) => observation.expected),
        );

        // Req 7.10: once per request, which is also no read a request did not ask for.
        expect(observations.map((observation) => observation.reads)).toEqual(
          observations.map(() => 1),
        );
        expect(paths).toEqual(observations.map(() => CREDENTIAL_PATH));
      }),
      propertyParameters({ numRuns: NUM_RUNS }),
    );

    for (const shape of SHAPES) {
      expect(seen[shape], `no draw exercised ${shape}`).toBeGreaterThan(0);
    }
  });

  it('labels outcomes rather than values, so no counterexample can print a credential', () => {
    const labelsHoldingContents = Object.values(OUTCOME_BY_KIND).filter((label) =>
      USABLE_CONTENTS.some((value) => label.includes(value)),
    );
    expect(labelsHoldingContents).toEqual([]);

    // Distinct labels must stand for distinct values, or an outcome check could pass by luck.
    const collisions = CONTENTS_KINDS.flatMap((kind) =>
      CONTENTS_KINDS.filter(
        (other) =>
          OUTCOME_BY_KIND[kind] !== OUTCOME_BY_KIND[other] &&
          (CONTENTS_BY_KIND[kind] ?? '').trim() === (CONTENTS_BY_KIND[other] ?? '').trim(),
      ),
    );
    expect(collisions).toEqual([]);
  });

  it('varies padding without varying the credential, so trimming is exercised', () => {
    const padded = CONTENTS_BY_KIND['token-a-padded'];
    const plain = CONTENTS_BY_KIND['token-a'];

    expect(padded).not.toBe(plain);
    expect(padded?.trim()).toBe(plain);
    expect(OUTCOME_BY_KIND['token-a-padded']).toBe(OUTCOME_BY_KIND['token-a']);
  });
});
