// Cited-vs-Unverified derivation for external facts (Req 13.7, 13.11, 13.12).
//
// This is the single place the presentation treatment of an external fact is
// decided, and it decides it from ONE input: whether a citation exists. It never
// takes usefulness, influence-on-a-proposal, or any oracle signal as an argument,
// so "usefulness never suppresses the Unverified label" (Req 13.11) holds by
// construction, and a cited fact is never presented as oracle-`Verified`
// (Req 13.10) because the only two outcomes are `Cited` and `Unverified`.

import type { Citation } from '@app/core';

import type { ExternalFact } from './contract.js';

/**
 * Present an external fact from its citation status alone.
 *
 * A fact with a citation is `Cited`; a fact without one is `Unverified`, even
 * when it improved a proposal. Usefulness is deliberately not a parameter.
 */
export function presentExternalFact(claim: string, citation?: Citation): ExternalFact {
  if (citation === undefined) {
    return { presentation: 'Unverified', claim };
  }
  return { presentation: 'Cited', claim, citation };
}
