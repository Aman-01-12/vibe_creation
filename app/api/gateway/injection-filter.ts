// Prompt-injection filtering at the gateway.
//
// Inbound free-text (intent descriptions, iteration requests) is untrusted and
// may carry control content that tries to hijack the Orchestrator's model calls
// (Req 1.6). This filter is a pure, deterministic transform that NEUTRALIZES
// recognized injection control phrases and delimiter spoofs before the content
// can reach the Orchestrator. It runs as the final inbound pipeline step, on
// already-authenticated, rate-limited requests.
//
// Detection is pattern-based over categories, not an exact denylist, so it
// generalizes across the shared injection-marker generators used by the task 5.4
// efficacy test: imperative overrides, role-label spoofs, and chat/section
// delimiter spoofs. Matched spans are replaced with a fixed, inert placeholder.

/** The inert token that replaces any neutralized control span. */
export const NEUTRALIZED_PLACEHOLDER = '[filtered]';

/**
 * Injection control patterns, grouped by attack category. Each is applied
 * case-insensitively and globally. Kept narrow enough to avoid mangling benign
 * text while covering override phrasing, role spoofs, and delimiter spoofs.
 */
const INJECTION_PATTERNS: readonly RegExp[] = [
  // Imperative overrides ("ignore all previous instructions", "disregard the above").
  /ignore\s+(?:all\s+|any\s+)?(?:previous|prior|earlier)\s+instructions/gi,
  /disregard\s+(?:the\s+)?(?:above|previous|prior)[^.\n]*/gi,
  /forget\s+(?:everything|all)\s+(?:above|before)/gi,
  // Role / identity reassignment ("you are now ...", "developer mode").
  /you\s+are\s+now\b[^.\n]*/gi,
  /developer\s+mode/gi,
  // Attempts to exfiltrate the system prompt.
  /reveal\s+your\s+system\s+prompt/gi,
  /system\s+prompt/gi,
  // Chat role labels at a segment boundary ("system:", "assistant:", "user:").
  // The boundary is "not preceded by a letter" so the spoof is caught after
  // whitespace, a newline, start-of-string, OR an adjacent delimiter such as an
  // HTML tag (`<p>assistant:`) or quote, while still refusing to match inside a
  // larger word like "subsystem:".
  /(?<![A-Za-z])(?:system|assistant|user)\s*:/gi,
  // Chat/section delimiter spoofs.
  /<\|im_(?:start|end)\|>/gi,
  /<\/?\s*system\s*>/gi,
  /\[\[[^\]]*\]\]/g,
];

/** The result of filtering one string. */
export interface InjectionFilterResult {
  /** The input with every recognized control span replaced by the placeholder. */
  readonly sanitized: string;
  /** Whether any control content was found and neutralized. */
  readonly neutralized: boolean;
  /** The distinct raw spans that were neutralized, for the Trace. */
  readonly markersFound: readonly string[];
}

/**
 * Neutralize injection control content in a single string.
 *
 * Pure and deterministic: the same input always yields the same output.
 */
export function filterInjection(input: string): InjectionFilterResult {
  const markersFound: string[] = [];
  let sanitized = input;
  for (const pattern of INJECTION_PATTERNS) {
    sanitized = sanitized.replace(pattern, (match) => {
      markersFound.push(match.trim());
      return NEUTRALIZED_PLACEHOLDER;
    });
  }
  return { sanitized, neutralized: markersFound.length > 0, markersFound };
}

/** The aggregate report for a whole payload after deep sanitization. */
export interface InjectionReport {
  readonly neutralized: boolean;
  readonly markersFound: readonly string[];
}

/**
 * Deep-sanitize every string leaf of a JSON-derived value.
 *
 * Because the pipeline runs this on the output of schema validation, the value
 * is a plain JSON structure (objects, arrays, primitives) with no functions or
 * exotic prototypes, so a structural walk fully covers it. Returns a new value;
 * the input is not mutated.
 */
export function sanitizeDeep<T>(value: T): { value: T; report: InjectionReport } {
  const markers: string[] = [];
  const sanitized = walk(value, markers) as T;
  return { value: sanitized, report: { neutralized: markers.length > 0, markersFound: markers } };
}

/** Recursively rebuild `value`, filtering every string leaf. Works over `unknown`. */
function walk(value: unknown, markers: string[]): unknown {
  if (typeof value === 'string') {
    const result = filterInjection(value);
    if (result.neutralized) {
      markers.push(...result.markersFound);
    }
    return result.sanitized;
  }
  if (Array.isArray(value)) {
    return (value as readonly unknown[]).map((item) => walk(item, markers));
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const entries = Object.entries(record).map(
      ([key, item]) => [key, walk(item, markers)] as const,
    );
    return Object.fromEntries(entries);
  }
  return value;
}
