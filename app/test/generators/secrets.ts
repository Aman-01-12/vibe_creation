// Secret-shaped token generators (task 1.3).
//
// Feed the redaction and leak-prevention properties (Property 11, task 4.x/9.x):
// secrets must never appear in traces, logs, errors, prompts, or inter-service
// payloads, so tests need inputs that LOOK like credentials to confirm they are
// redacted. Every value here is SYNTHETIC - random suffixes over well-known
// prefixes - and is never a real credential.

import fc from 'fast-check';

import { stringFromChars } from './chars.js';

/** Base62 alphabet, the usual body charset for API keys and tokens. */
const BASE62: readonly string[] =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'.split('');

/** Base32 alphabet (RFC 4648), used by AWS-style access key ids. */
const BASE32: readonly string[] = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.split('');

/** Lowercase hexadecimal, used by hex-style API keys. */
const HEX: readonly string[] = '0123456789abcdef'.split('');

/**
 * A synthetic string shaped like a real credential (OpenAI-style, AWS-style,
 * GitHub PAT, bearer token, JWT, or hex API key). Purely for redaction tests;
 * the body is random, so no value is ever a usable secret.
 */
export function secretShapedTokenArbitrary(): fc.Arbitrary<string> {
  const openAiLike = stringFromChars(BASE62, 32, 48).map((body) => `sk-${body}`);
  const awsAccessKeyLike = stringFromChars(BASE32, 16, 16).map((body) => `AKIA${body}`);
  const githubPatLike = stringFromChars(BASE62, 36, 36).map((body) => `ghp_${body}`);
  const bearerLike = stringFromChars(BASE62, 24, 40).map((body) => `Bearer ${body}`);
  const jwtLike = fc
    .tuple(
      stringFromChars(BASE62, 10, 20),
      stringFromChars(BASE62, 10, 30),
      stringFromChars(BASE62, 20, 43),
    )
    .map(([header, payload, signature]) => `${header}.${payload}.${signature}`);
  const hexApiKeyLike = stringFromChars(HEX, 32, 64).map((body) => `api_${body}`);
  return fc.oneof(openAiLike, awsAccessKeyLike, githubPatLike, bearerLike, jwtLike, hexApiKeyLike);
}

/** A secret-shaped token embedded in benign filler, as it would appear in text. */
export function secretEmbeddedInTextArbitrary(): fc.Arbitrary<string> {
  const filler = stringFromChars('abcdefghijklmnopqrstuvwxyz '.split(''), 0, 30);
  return fc
    .tuple(filler, secretShapedTokenArbitrary(), filler)
    .map(([lead, token, trail]) => `${lead} ${token} ${trail}`.trim());
}
