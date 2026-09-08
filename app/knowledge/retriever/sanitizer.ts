// Knowledge-layer prompt-injection sanitizer for retrieved web content.
//
// Retrieved web content is untrusted (Req 13.4): a fetched page may carry control
// text that tries to hijack the Orchestrator's model calls. This sanitizer is a
// pure, deterministic transform that NEUTRALIZES recognized injection-control
// phrases and delimiter spoofs, replacing each matched span with an inert
// placeholder, before any web content leaves the retriever.
//
// `@app/knowledge` cannot import the API gateway's `filterInjection` (that would
// cross the import boundary into `@app/api`), so the same category-based defense
// is implemented here as a knowledge-layer concern. The gateway continues to
// filter inbound free-text at the outer boundary; applying it again here is
// defense in depth for content that enters through the web-fetch adapter rather
// than through the gateway.

import type { KnowledgeSanitizer, SanitizedContent } from './contract.js';

/** The inert token that replaces any neutralized control span. */
export const NEUTRALIZED_PLACEHOLDER = '[filtered]';

/**
 * Injection-control patterns grouped by attack category, applied case-insensitively
 * and globally. Mirrors the gateway filter's categories (imperative overrides, role
 * spoofs, delimiter spoofs) so the two boundaries neutralize the same attack space.
 */
const INJECTION_PATTERNS: readonly RegExp[] = [
  // Imperative overrides.
  /ignore\s+(?:all\s+|any\s+)?(?:previous|prior|earlier)\s+instructions/gi,
  /disregard\s+(?:the\s+)?(?:above|previous|prior)[^.\n]*/gi,
  /forget\s+(?:everything|all)\s+(?:above|before)/gi,
  // Role / identity reassignment.
  /you\s+are\s+now\b[^.\n]*/gi,
  /developer\s+mode/gi,
  // System-prompt exfiltration.
  /reveal\s+your\s+system\s+prompt/gi,
  /system\s+prompt/gi,
  // Chat role labels at a segment boundary (not inside a larger word like "subsystem:").
  /(?<![A-Za-z])(?:system|assistant|user)\s*:/gi,
  // Chat/section delimiter spoofs.
  /<\|im_(?:start|end)\|>/gi,
  /<\/?\s*system\s*>/gi,
  /\[\[[^\]]*\]\]/g,
];

/**
 * Neutralize injection-control content in a single string.
 *
 * Pure and deterministic: the same input always yields the same output, and
 * benign text round-trips unchanged.
 */
export function sanitizeWebContent(input: string): SanitizedContent {
  const markersFound: string[] = [];
  let text = input;
  for (const pattern of INJECTION_PATTERNS) {
    text = text.replace(pattern, (match) => {
      markersFound.push(match.trim());
      return NEUTRALIZED_PLACEHOLDER;
    });
  }
  return { text, neutralized: markersFound.length > 0, markersFound };
}

/** The default knowledge-layer sanitizer, injected unless a test overrides it. */
export const defaultKnowledgeSanitizer: KnowledgeSanitizer = {
  sanitize: sanitizeWebContent,
};
