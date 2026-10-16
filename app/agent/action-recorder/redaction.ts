// Redaction transform for Trace spans (Requirements 3.2, 3.3).
//
// This is the security boundary of the Action_Recorder: it runs on every value
// that will ever be persisted, BEFORE persistence, so a secret or PII value can
// never be written even if a caller passes one in. Provider credentials are
// primarily confined to their vendor adapters (Model_Router, task 9) and are not
// meant to reach the recorder at all; this transform is defense-in-depth for the
// case where one leaks into an input or output payload anyway.
//
// The transform is pure and total: it walks an immutable `Json` value and returns
// a new immutable `Json` value with secret-shaped tokens and PII replaced by
// fixed placeholders. It NEVER logs, prints, or otherwise emits the raw value on
// any path, and it never throws.

import { SECRET_PATTERN_SOURCES, type Json } from '@app/core';

/** Replacement written in place of a detected secret or credential. */
export const SECRET_PLACEHOLDER = '[REDACTED_SECRET]';

/** Replacement written in place of detected personally identifiable information. */
export const PII_PLACEHOLDER = '[REDACTED_PII]';

// `SECRET_PATTERN_SOURCES` is NOT declared here. It moved down into `@app/core`
// (`app/core/redaction/index.ts`) when `sanitizeDiagnostic` in `app/tools/formal/interpret.ts`
// became its second reader, so the Action_Recorder and the Formal_Oracle's diagnostic
// sanitizer apply one Secret_Pattern_Set rather than two copies that can drift
// (formal-property-oracle Req 11.20). Import it; never restate the shapes here.

/** Regex source for an email address, the one PII shape detected by value. */
const EMAIL_PATTERN_SOURCE = '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}';

/**
 * Object keys whose value is a secret regardless of its shape.
 *
 * Keys are compared after normalization (lowercased, non-alphanumerics removed),
 * so `API_KEY`, `api-key`, and `apiKey` all match `apikey`.
 */
const SECRET_KEYS: ReadonlySet<string> = new Set([
  'password',
  'passwd',
  'secret',
  'token',
  'apikey',
  'accesskey',
  'secretkey',
  'authorization',
  'auth',
  'credential',
  'credentials',
  'privatekey',
  'bearer',
  'sessiontoken',
  'refreshtoken',
  'accesstoken',
  'clientsecret',
]);

/** Object keys whose value is PII regardless of its shape. */
const PII_KEYS: ReadonlySet<string> = new Set([
  'email',
  'emailaddress',
  'phone',
  'phonenumber',
  'firstname',
  'lastname',
  'fullname',
  'address',
  'streetaddress',
  'ssn',
  'dob',
  'dateofbirth',
  'ipaddress',
]);

/** Normalize a key for case- and separator-insensitive matching. */
function normalizeKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** Replace every occurrence of each source pattern with the placeholder. */
function replaceAll(value: string, sources: readonly string[], placeholder: string): string {
  return sources.reduce((acc, source) => acc.replace(new RegExp(source, 'g'), placeholder), value);
}

/** Redact secret-shaped tokens, then email PII, from a free-text string value. */
function redactString(value: string): string {
  const withoutSecrets = replaceAll(value, SECRET_PATTERN_SOURCES, SECRET_PLACEHOLDER);
  return replaceAll(withoutSecrets, [EMAIL_PATTERN_SOURCE], PII_PLACEHOLDER);
}

/** Narrow a non-null, non-array `Json` to its object shape. */
function isJsonObject(value: Json): value is { readonly [key: string]: Json } {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Redact one object, honoring sensitive-key rules before recursing into values. */
function redactObject(value: { readonly [key: string]: Json }): Json {
  const redacted: { [key: string]: Json } = {};
  for (const [key, child] of Object.entries(value)) {
    const normalized = normalizeKey(key);
    if (SECRET_KEYS.has(normalized)) {
      redacted[key] = SECRET_PLACEHOLDER;
    } else if (PII_KEYS.has(normalized)) {
      redacted[key] = PII_PLACEHOLDER;
    } else {
      redacted[key] = redactJson(child);
    }
  }
  return redacted;
}

/**
 * Return a redacted deep copy of an immutable `Json` value.
 *
 * Strings are scrubbed of secret-shaped tokens and email PII; a value under a
 * sensitive key is replaced wholesale without inspecting it; arrays and objects
 * are rebuilt from redacted children; numbers, booleans, and `null` pass through
 * unchanged (a numeric value under a sensitive key is still redacted by the key
 * rule above). The input is never mutated.
 */
export function redactJson(value: Json): Json {
  if (typeof value === 'string') {
    return redactString(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) {
    return value;
  }
  if (isJsonObject(value)) {
    return redactObject(value);
  }
  return value.map((item) => redactJson(item));
}

/** Whether a string still contains a secret-shaped token (for tests and audits). */
export function containsSecret(text: string): boolean {
  return SECRET_PATTERN_SOURCES.some((source) => new RegExp(source).test(text));
}

/** Whether a string still contains an email address (for tests and audits). */
export function containsEmail(text: string): boolean {
  return new RegExp(EMAIL_PATTERN_SOURCE).test(text);
}
