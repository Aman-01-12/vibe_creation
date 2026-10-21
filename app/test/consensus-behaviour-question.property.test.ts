// reference-model-consensus-gate, Property 21: The Behaviour_Question grammar admits only
// four token sources (task 12.4).
//
// Checks grammar CLOSURE, not comprehensibility: a grammar-closed question can still read
// as confusing to a student. No assertion here claims otherwise.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { AgreementCluster } from '../agent/consensus/agreement.js';
import {
  buildBehaviourQuestion,
  containsJargon,
  isDisagreementEscalation,
  renderQuestion,
  type QuestionToken,
  type SentenceFrameId,
} from '../agent/consensus/behaviour-question.js';
import { MIN_MODEL_FAMILIES } from '../agent/consensus/model-family.js';
import type { ModuleInterface } from '@app/core';

import { propertyParameters } from './property.js';

const PROPERTY =
  'reference-model-consensus-gate, Property 21: The Behaviour_Question grammar admits only ' +
  'four token sources';

const FRAME_IDS: readonly SentenceFrameId[] = [
  'output-differs-at-cycle',
  'output-settles-at-cycle',
];
const SENTENCE_FRAME_TEXT: Record<SentenceFrameId, string> = {
  'output-differs-at-cycle': 'does the output differ at cycle',
  'output-settles-at-cycle': 'does the output settle at cycle',
};

function moduleInterfaceWith(portNames: readonly string[]): ModuleInterface {
  return {
    validityOutputName: null,
    moduleName: 'm',
    ports: portNames.map((name) => ({ name, direction: 'output' as const, width: 1 })),
    clocking: { clockName: null, resetName: null, resetActiveLow: false },
  };
}

const arbPortName = fc.constantFrom('q', 'data_out', 'valid_out');
const arbFrameId = fc.constantFrom(...FRAME_IDS);

function arbSignalToken(name: string): fc.Arbitrary<QuestionToken> {
  return fc.constant({ kind: 'signal' as const, name });
}
function arbValueToken(): fc.Arbitrary<QuestionToken> {
  return fc.string({ minLength: 1, maxLength: 4 }).map((literal) => ({
    kind: 'value' as const,
    literal,
  }));
}
function arbCycleToken(): fc.Arbitrary<QuestionToken> {
  return fc.nat().map((index) => ({ kind: 'cycle' as const, index }));
}
function arbFrameToken(): fc.Arbitrary<QuestionToken> {
  return arbFrameId.map((id) => ({ kind: 'frame' as const, id }));
}

/** A valid token list: exactly one frame, plus zero or more signal/value/cycle tokens. */
function arbValidTokens(portName: string): fc.Arbitrary<readonly QuestionToken[]> {
  return fc
    .array(fc.oneof(arbSignalToken(portName), arbValueToken(), arbCycleToken()), { maxLength: 4 })
    .chain((rest) => arbFrameToken().map((frame) => [...rest, frame]));
}

function design(index: number): string {
  return `design-${index}`;
}

/** A cluster of `size` designs starting at `startIndex`, with no overlap with another cluster. */
function clusterOf(startIndex: number, size: number): AgreementCluster {
  return {
    designIds: Array.from({ length: size }, (_, offset) => design(startIndex + offset)),
    digestsByTestbench: [],
  };
}

describe(PROPERTY, () => {
  it('every rendered word traces to a declared signal, a value, a cycle numeral, or a frame word', () => {
    fc.assert(
      fc.property(arbPortName, (portName) => {
        const moduleInterface = moduleInterfaceWith([portName]);
        return fc.assert(
          fc.property(arbValidTokens(portName), (tokens) => {
            const built = buildBehaviourQuestion(tokens, moduleInterface, []);
            expect(built.ok).toBe(true);
            if (!built.ok) {
              return;
            }
            const rendered = renderQuestion(built.value);
            const expectedWords = tokens
              .map((token) => {
                switch (token.kind) {
                  case 'signal':
                    return token.name;
                  case 'value':
                    return token.literal;
                  case 'cycle':
                    return String(token.index);
                  case 'frame':
                    return SENTENCE_FRAME_TEXT[token.id];
                }
              })
              .join(' ');
            expect(rendered).toBe(expectedWords);
          }),
          propertyParameters(),
        );
      }),
      propertyParameters(),
    );
  });

  it('the alternatives number exactly what was given, each carrying only a cluster id and a trace', () => {
    const moduleInterface = moduleInterfaceWith(['q']);
    const tokens: QuestionToken[] = [{ kind: 'frame', id: 'output-differs-at-cycle' }];
    const alternatives = [
      { clusterId: 'cluster-a', trace: [{ step: 0, values: ['1'] }] },
      { clusterId: 'cluster-b', trace: [{ step: 0, values: ['0'] }] },
    ];
    const built = buildBehaviourQuestion(tokens, moduleInterface, alternatives);
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.value.alternatives).toHaveLength(2);
      expect(built.value.alternatives.map((alt) => alt.clusterId)).toEqual([
        'cluster-a',
        'cluster-b',
      ]);
    }
  });

  it('refuses a token list with zero frame tokens', () => {
    const moduleInterface = moduleInterfaceWith(['q']);
    const tokens: QuestionToken[] = [{ kind: 'signal', name: 'q' }];
    const built = buildBehaviourQuestion(tokens, moduleInterface, []);
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.error.code).toBe('BEHAVIOUR_QUESTION_FRAME_COUNT_NOT_ONE');
    }
  });

  it('refuses a token list with two or more frame tokens', () => {
    fc.assert(
      fc.property(arbFrameId, arbFrameId, (first, second) => {
        const moduleInterface = moduleInterfaceWith(['q']);
        const tokens: QuestionToken[] = [
          { kind: 'frame', id: first },
          { kind: 'frame', id: second },
        ];
        const built = buildBehaviourQuestion(tokens, moduleInterface, []);
        expect(built.ok).toBe(false);
        if (!built.ok) {
          expect(built.error.code).toBe('BEHAVIOUR_QUESTION_FRAME_COUNT_NOT_ONE');
        }
      }),
      propertyParameters(),
    );
  });

  it('refuses a signal token naming a port outside the declared interface', () => {
    const moduleInterface = moduleInterfaceWith(['q']);
    const tokens: QuestionToken[] = [
      { kind: 'signal', name: 'not_a_declared_port' },
      { kind: 'frame', id: 'output-differs-at-cycle' },
    ];
    const built = buildBehaviourQuestion(tokens, moduleInterface, []);
    expect(built.ok).toBe(false);
    if (!built.ok) {
      expect(built.error.code).toBe('BEHAVIOUR_QUESTION_UNADMITTED_TOKEN');
    }
  });

  it('plants Spec signal names that are substrings of denylist terms, and refuses nothing extra for it', () => {
    // "registered" and "clock_domain" are deliberately denylist-adjacent port names: the grammar
    // itself must still accept them as ordinary declared signals (containsJargon's own exception
    // is Property 22's concern, task 12.5).
    const moduleInterface = moduleInterfaceWith(['registered', 'clock_domain', 'reg']);
    const tokens: QuestionToken[] = [
      { kind: 'signal', name: 'registered' },
      { kind: 'signal', name: 'clock_domain' },
      { kind: 'signal', name: 'reg' },
      { kind: 'frame', id: 'output-differs-at-cycle' },
    ];
    const built = buildBehaviourQuestion(tokens, moduleInterface, []);
    expect(built.ok).toBe(true);
  });

  it.each([
    'Mealy',
    'Moore',
    'registered',
    'combinational',
    'blocking assignment',
    'clock domain',
    'handshake latency',
  ])('containsJargon finds the named term %s', (term) => {
    expect(containsJargon(`the design uses a ${term} style`)).toContain(term.toLowerCase());
  });

  it('containsJargon finds nothing in a correctly-built rendered question over non-jargon signals', () => {
    fc.assert(
      fc.property(arbPortName, (portName) => {
        const moduleInterface = moduleInterfaceWith([portName]);
        return fc.assert(
          fc.property(arbValidTokens(portName), (tokens) => {
            const built = buildBehaviourQuestion(tokens, moduleInterface, []);
            expect(built.ok).toBe(true);
            if (built.ok) {
              expect(containsJargon(renderQuestion(built.value))).toEqual([]);
            }
          }),
          propertyParameters(),
        );
      }),
      propertyParameters(),
    );
  });

  it('escalates if and only if the pool spans >= 3 families, forms no majority, and has >= 2 qualifying clusters (biconditional)', () => {
    const poolSize = 8;
    // Satisfying case: three singleton+ clusters of size 2, 2, 2, 2 - no majority, 2 qualify.
    const satisfying = [clusterOf(0, 2), clusterOf(2, 2), clusterOf(4, 2), clusterOf(6, 2)];
    expect(isDisagreementEscalation(satisfying, poolSize, MIN_MODEL_FAMILIES)).toBe(true);

    // Near-miss 1: one qualifying cluster, one singleton - only 1 qualifying cluster.
    const oneSingleton = [clusterOf(0, 2), clusterOf(2, 1)];
    expect(isDisagreementEscalation(oneSingleton, poolSize, MIN_MODEL_FAMILIES)).toBe(false);

    // Near-miss 2: only 2 distinct families, otherwise satisfying.
    expect(isDisagreementEscalation(satisfying, poolSize, MIN_MODEL_FAMILIES - 1)).toBe(false);

    // Near-miss 3: a cluster that IS a Strict_Majority (> half of 8 = 5).
    const majorityCluster = [clusterOf(0, 5), clusterOf(5, 2)];
    expect(isDisagreementEscalation(majorityCluster, poolSize, MIN_MODEL_FAMILIES)).toBe(false);
  });
});

// reference-model-consensus-gate, Property 22: The Jargon_Denylist finds nothing in a
// grammatical question (task 12.5). A finding here is a bug report about the grammar,
// not a defence that caught one.

const PROPERTY_22 =
  'reference-model-consensus-gate, Property 22: The Jargon_Denylist finds nothing in a ' +
  'grammatical question';

const ALL_JARGON_TERMS = [
  'Mealy',
  'Moore',
  'registered',
  'combinational',
  'blocking assignment',
  'clock domain',
  'handshake latency',
];

describe(PROPERTY_22, () => {
  it('positive control: containsJargon reports every denylist term when planted directly', () => {
    const planted = ALL_JARGON_TERMS.join(' and a ');
    const found = containsJargon(planted);
    for (const term of ALL_JARGON_TERMS) {
      expect(found).toContain(term.toLowerCase());
    }
  });

  it('for any question the grammar built from non-jargon signals, the denylist finds nothing', () => {
    fc.assert(
      fc.property(arbPortName, (portName) => {
        const moduleInterface = moduleInterfaceWith([portName]);
        return fc.assert(
          fc.property(arbValidTokens(portName), (tokens) => {
            const built = buildBehaviourQuestion(tokens, moduleInterface, []);
            expect(built.ok).toBe(true);
            if (built.ok) {
              expect(containsJargon(renderQuestion(built.value))).toEqual([]);
            }
          }),
          propertyParameters(),
        );
      }),
      propertyParameters(),
    );
  });

  it('a declared signal genuinely named "registered" is an admitted token, and the denylist reports it as a known exception', () => {
    // A student's own signal name is the one legitimate way a denylist term can reach a
    // rendered question. This is a stated, known exception, not a bug: the grammar emits
    // the question because "registered" is a declared port, and the denylist correctly
    // flags it. "clock_domain" (an underscore identifier) does NOT trigger "clock domain"
    // (the denylist's space-separated phrase) - a real, deliberately recorded non-match
    // between a Verilog identifier's spelling and a prose jargon phrase.
    const moduleInterface = moduleInterfaceWith(['registered', 'clock_domain']);
    const tokens: QuestionToken[] = [
      { kind: 'signal', name: 'registered' },
      { kind: 'signal', name: 'clock_domain' },
      { kind: 'frame', id: 'output-differs-at-cycle' },
    ];
    const built = buildBehaviourQuestion(tokens, moduleInterface, []);
    expect(built.ok).toBe(true);
    if (built.ok) {
      const found = containsJargon(renderQuestion(built.value));
      expect(found).toContain('registered');
      expect(found).not.toContain('clock domain');
    }
  });
});
