// Prompt-injection filter efficacy (task 5.4).
//
// This is a targeted efficacy suite against the already-complete API_Gateway
// injection filter (task 5.1). It is deliberately NOT one of the 32 numbered
// design properties: it drives the shared injection-marker generators (task 1.3)
// through the filter the tRPC router relies on and asserts, over 100+ inputs,
// that injected control content is neutralized before it can reach the
// Orchestrator (Design: Components and Interfaces, API_Gateway; Req 1.6).
//
// "Neutralized" here has a precise, observable meaning (see injection-filter.ts):
//   - every recognized control span is replaced by the inert NEUTRALIZED_PLACEHOLDER,
//   - `neutralized` is true exactly when at least one span was replaced,
//   - `markersFound` lists the distinct raw spans that were replaced (for the Trace),
//   - unmatched (benign) text is returned byte-for-byte unchanged.
//
// The router (app/api/trpc/router.ts) applies `filterInjection` to the free-text
// fields bound for the Orchestrator (submitIntent.description, requestIteration.change),
// so this suite exercises `filterInjection` exactly as the router calls it, plus
// `sanitizeDeep` for the payload-wide walk, on the same generated attack space.

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  NEUTRALIZED_PLACEHOLDER,
  filterInjection,
  sanitizeDeep,
  type InjectionReport,
} from '@app/api';
import {
  INJECTION_MARKERS,
  injectionMarkerArbitrary,
  injectionMarkerHtmlArbitrary,
  propertyParameters,
} from '@app/test';

// This suite intentionally lives outside the numbered-property namespace: it is a
// focused efficacy check, not a design property, so it uses a descriptive tag.
const EFFICACY_TAG = 'Feature: hdl-creation-loop, injection-filter efficacy';

/**
 * Assert the four observable guarantees of "neutralized" hold for one filtered
 * string: the report flags neutralization, names at least one marker, the output
 * carries the inert placeholder, and no raw injection marker survives verbatim.
 */
function expectNeutralized(report: InjectionReport, sanitized: string): void {
  expect(report.neutralized).toBe(true);
  expect(report.markersFound.length).toBeGreaterThan(0);
  expect(sanitized).toContain(NEUTRALIZED_PLACEHOLDER);
  for (const marker of INJECTION_MARKERS) {
    expect(sanitized).not.toContain(marker);
  }
}

/**
 * Clearly-benign hardware-description words that contain none of the filter's
 * trigger tokens (no override verbs, role labels, delimiter spoofs, or the
 * literal phrases "system prompt" / "developer mode"). Joined with single spaces
 * and never introducing `:` `<` `>` `|` `[` `]`, so benign text can never
 * accidentally match a control pattern - which lets the non-destruction claim be
 * deterministic rather than probabilistic.
 */
const BENIGN_WORDS: readonly string[] = [
  'a',
  'four',
  'bit',
  'binary',
  'counter',
  'with',
  'synchronous',
  'active',
  'high',
  'reset',
  'and',
  'clock',
  'enable',
  'the',
  'module',
  'adds',
  'two',
  'operands',
  'output',
  'ready',
  'when',
  'done',
  'rising',
  'edge',
  'load',
  'value',
  'into',
  'register',
  'increments',
  'on',
  'each',
  'cycle',
];

/** Benign free text: one-to-twelve benign words separated by single spaces. */
function benignTextArbitrary(): fc.Arbitrary<string> {
  const [first, ...rest] = BENIGN_WORDS;
  if (first === undefined) {
    throw new Error('BENIGN_WORDS must be non-empty');
  }
  return fc
    .array(fc.constantFrom(first, ...rest), { minLength: 1, maxLength: 12 })
    .map((words) => words.join(' '));
}

describe(EFFICACY_TAG, () => {
  it('neutralizes injected control content embedded in benign filler (router description path)', () => {
    fc.assert(
      fc.property(injectionMarkerArbitrary(), (input) => {
        // Exactly how the router sanitizes submitIntent.description before forwarding.
        const result = filterInjection(input);
        expectNeutralized(result, result.sanitized);
      }),
      propertyParameters(),
    );
  });

  it('neutralizes injected control content delivered as HTML web content', () => {
    fc.assert(
      fc.property(injectionMarkerHtmlArbitrary(), (input) => {
        const result = filterInjection(input);
        expectNeutralized(result, result.sanitized);
      }),
      propertyParameters(),
    );
  });

  it('neutralizes injected control content in nested payload fields via sanitizeDeep', () => {
    // Mirrors the requestIteration payload shape the gateway walks before the
    // handler runs: string leaves at several depths must all be neutralized.
    fc.assert(
      fc.property(
        injectionMarkerArbitrary(),
        injectionMarkerHtmlArbitrary(),
        fc.string({ maxLength: 24 }),
        (change, webContent, projectId) => {
          const payload = {
            projectId,
            change,
            context: { retrieved: [webContent], notes: change },
          };
          const { value, report } = sanitizeDeep(payload);

          expect(report.neutralized).toBe(true);
          expect(report.markersFound.length).toBeGreaterThan(0);
          for (const marker of INJECTION_MARKERS) {
            expect(value.change).not.toContain(marker);
            expect(value.context.notes).not.toContain(marker);
            expect(value.context.retrieved[0]).not.toContain(marker);
          }
          expect(value.change).toContain(NEUTRALIZED_PLACEHOLDER);
          expect(value.context.retrieved[0]).toContain(NEUTRALIZED_PLACEHOLDER);
        },
      ),
      propertyParameters(),
    );
  });

  it('leaves clearly-benign text unchanged and unflagged (no false positives, non-destruction)', () => {
    fc.assert(
      fc.property(benignTextArbitrary(), (input) => {
        const result = filterInjection(input);
        // The filter only rewrites matched spans, so benign text round-trips exactly.
        expect(result.neutralized).toBe(false);
        expect(result.markersFound).toHaveLength(0);
        expect(result.sanitized).toBe(input);
      }),
      propertyParameters(),
    );
  });

  it('is deterministic: the same input always yields the same sanitized output', () => {
    fc.assert(
      fc.property(injectionMarkerArbitrary(), (input) => {
        expect(filterInjection(input).sanitized).toBe(filterInjection(input).sanitized);
      }),
      propertyParameters(),
    );
  });
});
