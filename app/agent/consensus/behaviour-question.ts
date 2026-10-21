// Behaviour_Question: a closed, four-token grammar (C16, Req 6.4, 13.1-13.13).
//
// The guarantee is the grammar's FORM, not a denylist: a question can only ever be
// built from a declared port name, a Spec-named value, a cycle count, and one of
// two fixed sentence frames - there is no free-text path. A grammar bounds
// vocabulary, not comprehensibility: a question built only from these four kinds
// can still be unreadable, and no test here claims otherwise.

import {
  domainError,
  err,
  ok,
  type DomainError,
  type ModuleInterface,
  type Result,
} from '@app/core';

import type { AgreementCluster } from './agreement.js';
import { strictMajority } from './agreement.js';
import { MIN_MODEL_FAMILIES } from './model-family.js';
import type { SampleRecord } from './signature.js';

/** The two escalation triggers; the only prose a question carries. */
export type SentenceFrameId = 'output-differs-at-cycle' | 'output-settles-at-cycle';

/** The four admitted token sources (Req 13.2). There is no free-text variant. */
export type QuestionToken =
  | { readonly kind: 'signal'; readonly name: string }
  | { readonly kind: 'value'; readonly literal: string }
  | { readonly kind: 'cycle'; readonly index: number }
  | { readonly kind: 'frame'; readonly id: SentenceFrameId };

/** A trace slice naming a cluster id, never a design's own source (Req 13.4, 13.10). */
export interface BehaviourAlternative {
  readonly clusterId: string;
  readonly trace: readonly SampleRecord[];
}

export interface BehaviourQuestion {
  /** Exactly one 'frame' token, and every other token drawn from the Spec. */
  readonly tokens: readonly QuestionToken[];
  /** One alternative per disagreeing Agreement_Cluster, as observable behaviour. */
  readonly alternatives: readonly BehaviourAlternative[];
}

/** Declared port names, the only signal tokens a question may name. */
function declaredPortNames(moduleInterface: ModuleInterface): ReadonlySet<string> {
  return new Set(moduleInterface.ports.map((port) => port.name));
}

function frameCountOf(tokens: readonly QuestionToken[]): number {
  return tokens.filter((token) => token.kind === 'frame').length;
}

/**
 * Build a `BehaviourQuestion`, refusing a token list with no frame or more than one
 * (Req 13.2), or a signal token naming a port outside `moduleInterface` (Req 13.9).
 */
export function buildBehaviourQuestion(
  tokens: readonly QuestionToken[],
  moduleInterface: ModuleInterface,
  alternatives: readonly BehaviourAlternative[],
): Result<BehaviourQuestion, DomainError> {
  if (frameCountOf(tokens) !== 1) {
    return err(
      domainError(
        'BEHAVIOUR_QUESTION_FRAME_COUNT_NOT_ONE',
        'a Behaviour_Question must carry exactly one frame token',
      ),
    );
  }
  const portNames = declaredPortNames(moduleInterface);
  for (const token of tokens) {
    if (token.kind === 'signal' && !portNames.has(token.name)) {
      return err(
        domainError(
          'BEHAVIOUR_QUESTION_UNADMITTED_TOKEN',
          `"${token.name}" is not a declared port`,
        ),
      );
    }
  }
  return ok({ tokens, alternatives });
}

const SENTENCE_FRAME_TEXT: Record<SentenceFrameId, string> = {
  'output-differs-at-cycle': 'does the output differ at cycle',
  'output-settles-at-cycle': 'does the output settle at cycle',
};

/** Render one token to its plain-text form; the only text any token kind can emit. */
function renderToken(token: QuestionToken): string {
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
}

/** Render a `BehaviourQuestion` to a plain-text sentence, from its tokens alone. */
export function renderQuestion(question: BehaviourQuestion): string {
  return question.tokens.map(renderToken).join(' ');
}

/** The regression check: "Mealy" and "handshake latency" are its two named test cases (Req 13.3). */
const JARGON_TERMS = [
  'mealy',
  'moore',
  'registered',
  'combinational',
  'blocking assignment',
  'clock domain',
  'handshake latency',
];

/** Every jargon term found in `rendered`, case-insensitively; empty when none are present. */
export function containsJargon(rendered: string): readonly string[] {
  const lowered = rendered.toLowerCase();
  return JARGON_TERMS.filter((term) => lowered.includes(term));
}

/** The minimum cardinality that separates a genuine disagreement from a singleton outlier. */
const MIN_DISAGREEING_CLUSTER_SIZE = 2;
/** The minimum count of qualifying clusters that makes a disagreement, not just one outlier. */
const MIN_DISAGREEING_CLUSTER_COUNT = 2;

/**
 * Whether the Design_Pool's clustering is a genuine disagreement warranting an
 * escalation (Req 13.1): spans at least `MIN_MODEL_FAMILIES`, forms no
 * Strict_Majority, and at least two clusters each hold at least two designs.
 */
export function isDisagreementEscalation(
  clusters: readonly AgreementCluster[],
  poolSize: number,
  distinctFamilyCount: number,
): boolean {
  if (distinctFamilyCount < MIN_MODEL_FAMILIES) {
    return false;
  }
  if (strictMajority(clusters, poolSize) !== null) {
    return false;
  }
  const qualifyingClusters = clusters.filter(
    (cluster) => cluster.designIds.length >= MIN_DISAGREEING_CLUSTER_SIZE,
  );
  return qualifyingClusters.length >= MIN_DISAGREEING_CLUSTER_COUNT;
}
