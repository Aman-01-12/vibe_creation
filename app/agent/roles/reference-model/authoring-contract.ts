// The Authoring_Contract checker (C7, Req 5.1-5.3).
//
// This is the SECOND line, not the first: a construct it misses is still refused
// by the compiler, and a $display it misses is still discarded by the nonce.
// Checks happen before any Consensus_Run, so a rejection costs no simulation.

import { isEntirelyCode, scanSource, type SourceMask } from '@app/tools';

import type { ReferenceModelDraft } from './types.js';

export const AUTHORING_CONTRACT_VERSION = 2;

/** The eight constructs a Reference_Model body must not contain (Req 5.2). */
export type ExcludedConstruct =
  | 'delay-control'
  | 'event-control'
  | 'clock-generation'
  | 'width-declaration'
  | 'waveform-dump'
  | 'display-task'
  | 'module-declaration'
  | 'assignment-to-harness-signal';

export type AuthoringCheck =
  | { readonly kind: 'accepted'; readonly bodies: ReferenceModelDraft }
  | { readonly kind: 'rejected'; readonly excluded: readonly ExcludedConstruct[] };

/** One pattern-to-construct rule, matched only against code offsets of a mask. */
interface ExcludedRule {
  readonly construct: ExcludedConstruct;
  readonly pattern: RegExp;
}

const RULES: readonly ExcludedRule[] = [
  { construct: 'delay-control', pattern: /#\s*[\w(]/g },
  { construct: 'event-control', pattern: /@\s*[\w(*]/g },
  { construct: 'clock-generation', pattern: /\bforever\b|\balways\b/g },
  { construct: 'width-declaration', pattern: /\binput\b|\boutput\b|\binout\b/g },
  { construct: 'waveform-dump', pattern: /\$dumpfile\b|\$dumpvars\b/g },
  { construct: 'display-task', pattern: /\$display\b/g },
  { construct: 'module-declaration', pattern: /\bmodule\b|\bendmodule\b/g },
  {
    construct: 'assignment-to-harness-signal',
    pattern: /\bece_(?!reset_state|next_state|expect)\w*\s*=/g,
  },
];

/** Whether `pattern` matches any CODE offset (never a comment or string literal) of `body`. */
function matchesInCode(body: string, mask: SourceMask, pattern: RegExp): boolean {
  for (const match of body.matchAll(pattern)) {
    if (isEntirelyCode(mask, match.index, match.index + match[0].length)) {
      return true;
    }
  }
  return false;
}

/** The excluded constructs found in one function body, in `RULES` order. */
function excludedIn(body: string): readonly ExcludedConstruct[] {
  const mask = scanSource(body);
  return RULES.filter((rule) => matchesInCode(body, mask, rule.pattern)).map(
    (rule) => rule.construct,
  );
}

/**
 * Check all three Reference_Model bodies against the Authoring_Contract, returning
 * every excluded construct found across all three rather than only the first.
 */
export function checkAuthoringContract(draft: ReferenceModelDraft): AuthoringCheck {
  const excluded = [
    ...excludedIn(draft.resetStateBody),
    ...excludedIn(draft.nextStateBody),
    ...excludedIn(draft.expectBody),
  ];
  const distinct = [...new Set(excluded)];
  return distinct.length === 0
    ? { kind: 'accepted', bodies: draft }
    : { kind: 'rejected', excluded: distinct };
}
