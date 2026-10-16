// Feature: formal-gate-first-light, Property 20: The credential value influences no emitted text
// (task 7.3).
//
// WHY NON-INTERFERENCE AND NOT CONTAINMENT
//   "the value appears in no emitted text" is tempting to write as
//   `expect(text).not.toContain(credential)`, and that check is both too weak and unsound.
//   Too weak: over randomly generated tokens it passes by luck, because a random string
//   never collides with fixed diagnostic prose, so it would also pass on a renderer that
//   leaked a TRANSFORMED credential. Unsound: a short credential that is itself a substring
//   of ordinary diagnostic text ('credential', 'fix', 'HTTP 401') makes it fail with no leak
//   at all. So the credentials generated here are deliberately drawn from that colliding
//   family, and the claim is stated the way the design states it: two different credential
//   values, everything else held fixed, must produce IDENTICAL text. A leak of any kind -
//   whole, truncated, or re-worded - makes the two renderings differ.
//
// THE PAIR VARIES THE CONTENTS AND HOLDS THE PATH FIXED
//   The Credential_File PATH may be named in a message; its contents may not. So the path is
//   one constant for both halves of every pair, and the second `it` below asserts the refusal
//   message does name it - otherwise "identical text" could be satisfied by text that says
//   nothing.
//
// THE TWO EMITTERS
//   The Credential_Probe (`checkCredential` + `renderPreflightFailure`, `app/eval/sweep/preflight.ts`)
//   and the Credential_Provider (`RefreshingSecretManager`'s `SecretResolutionError.reason`).
//   Both are driven here from one fake `ReadTextFile`: no real `.env`, no real Credential_File,
//   and every credential value in this file is obviously fake.
//
// This lives in `app/test/` rather than beside either subject, because it needs `@app/agent`
// and `@app/eval` together and neither may import the other. The tag is a literal string, not
// `propertyTag(...)`, whose `FEATURE_TAG` is hardcoded to a different spec's numbering.
//
// Validates: Requirements 7.3, 7.12

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_CREDENTIAL_FILE,
  RefreshingSecretManager,
  providerCredentialRef,
} from '@app/agent';
import { checkCredential, renderPreflightFailure, type ModelListAnswer } from '@app/eval';

import { propertyParameters } from './property.js';

const PROPERTY =
  'formal-gate-first-light, Property 20: The credential value influences no emitted text';

/** The Credential_File path, held fixed across both halves of every generated pair. */
const CREDENTIAL_FILE_PATH = DEFAULT_CREDENTIAL_FILE;

/** The one ref the Credential_File serves. */
const SWEEP_CREDENTIAL_REF = providerCredentialRef('bedrock-mantle');

/** A ref the Credential_File never serves, so the provider always emits one diagnostic. */
const UNSERVED_REF = 'secret://provider/not-the-sweep-provider/api-key';

const HTTP_OK = 200;
const HTTP_NO_CONTENT = 204;
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;
const HTTP_SERVER_ERROR = 500;

/** Every answer shape the probe classifies, as a closed union the property exhausts. */
const PROVIDER_ANSWERS: readonly ModelListAnswer[] = [
  { kind: 'reply', status: HTTP_OK },
  { kind: 'reply', status: HTTP_NO_CONTENT },
  { kind: 'reply', status: HTTP_UNAUTHORIZED },
  { kind: 'reply', status: HTTP_FORBIDDEN },
  { kind: 'reply', status: HTTP_SERVER_ERROR },
  { kind: 'unreachable' },
];

/**
 * Obviously fake credential values that resolve, all but the last a SUBSTRING of the
 * diagnostics these emitters produce. That collision is the point: it is what stops this
 * property from being a containment check that passes by luck.
 */
const RESOLVABLE_CREDENTIALS: readonly string[] = [
  'credential',
  'bedrock-mantle',
  'fix',
  'refused the credential',
  CREDENTIAL_FILE_PATH,
  'HTTP 401',
  're-run',
  'fake-token-not-a-real-key',
];

/** Contents that resolve to nothing: unreadable, empty, or whitespace-only (Req 7.16). */
const UNRESOLVABLE_CONTENTS: readonly (string | null)[] = [null, '', '   ', '\n\t\n'];

/** Everything one run emitted, plus the observable behaviour that must not vary either. */
interface Emission {
  /** Every message either emitter produced, in order. */
  readonly lines: readonly string[];
  /** How many model-list calls the probe made. */
  readonly calls: number;
  /** Which paths the provider read, so the pair can be shown to hold the path fixed. */
  readonly readPaths: readonly string[];
}

/**
 * Drive both emitters over one Credential_File contents and one fixed provider answer,
 * collecting every message they produce.
 *
 * The answer is fixed per call rather than derived from the credential, so the provider's
 * reply cannot smuggle the value back into the text and make the comparison below pass for
 * the wrong reason. The unserved ref is resolved as well so the collected text is never
 * empty, whatever the probe decided.
 */
async function emit(contents: string | null, answer: ModelListAnswer): Promise<Emission> {
  const readPaths: string[] = [];
  let calls = 0;
  const secretManager = new RefreshingSecretManager({
    path: CREDENTIAL_FILE_PATH,
    readFile: (path) => {
      readPaths.push(path);
      return Promise.resolve(contents);
    },
  });

  const failure = await checkCredential({
    secretManager,
    credentialFilePath: CREDENTIAL_FILE_PATH,
    modelList: () => {
      calls += 1;
      return Promise.resolve(answer);
    },
  });

  const lines = failure === null ? [] : [failure.code, ...renderPreflightFailure(failure)];
  for (const ref of [SWEEP_CREDENTIAL_REF, UNSERVED_REF]) {
    const resolved = await secretManager.resolveSecret(ref);
    if (!resolved.ok) {
      lines.push(resolved.error.code, resolved.error.reason);
    }
  }
  return { lines, calls, readPaths };
}

/**
 * Two DIFFERENT members of one pool.
 *
 * The second index is the first plus a non-zero step modulo the pool size, so the pair is
 * distinct by construction rather than by a filter that could shrink to an equal pair and
 * make the property vacuously true.
 */
function distinctPair(
  pool: readonly (string | null)[],
): fc.Arbitrary<readonly [string | null, string | null]> {
  return fc
    .tuple(
      fc.integer({ min: 0, max: pool.length - 1 }),
      fc.integer({ min: 1, max: pool.length - 1 }),
    )
    .map(([index, step]) => [pool[index]!, pool[(index + step) % pool.length]!] as const);
}

describe(PROPERTY, () => {
  it('emits identical text under two different credential values', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...PROVIDER_ANSWERS),
        fc.oneof(distinctPair(RESOLVABLE_CREDENTIALS), distinctPair(UNRESOLVABLE_CONTENTS)),
        async (answer, [first, second]) => {
          const under1 = await emit(first, answer);
          const under2 = await emit(second, answer);

          // The whole claim: the credential influenced nothing either emitter said, and
          // nothing either one did.
          expect(under2).toEqual(under1);

          // Non-vacuity: there was text to compare. The unserved ref guarantees it even
          // when the probe admitted the run.
          expect(under1.lines.length).toBeGreaterThan(0);

          // The path is what was held fixed; the contents are what varied.
          expect(under1.readPaths.every((path) => path === CREDENTIAL_FILE_PATH)).toBe(true);
        },
      ),
      propertyParameters(),
    );
  });

  it('names the Credential_File path in a refusal, which is the half that may appear', async () => {
    const refused = await emit('fake-token-not-a-real-key', {
      kind: 'reply',
      status: HTTP_UNAUTHORIZED,
    });
    expect(refused.lines.join('\n')).toContain(CREDENTIAL_FILE_PATH);
  });

  it('generates credentials a naive containment check would flag, so it cannot pass by luck', async () => {
    const refused = await emit('fake-token-not-a-real-key', {
      kind: 'reply',
      status: HTTP_UNAUTHORIZED,
    });
    const text = refused.lines.join('\n');
    const colliding = RESOLVABLE_CREDENTIALS.filter((value) => text.includes(value));

    // Several generated credentials occur verbatim in ordinary diagnostic prose, so
    // `not.toContain(credential)` would fail here with no leak - and at least one does not,
    // so the pool is not trivially all-colliding either.
    expect(colliding.length).toBeGreaterThan(1);
    expect(colliding.length).toBeLessThan(RESOLVABLE_CREDENTIALS.length);
  });
});
