---
type: pattern
title: Digest a string in a no-ambient-Node-types project via structural-cast host globals (crypto.subtle, TextEncoder)
status: candidate
provenance: task 9.2 (eval-campaign-readiness spec), spec-task-execution subagent
tags: [typescript, tsconfig, node-types, hashing, model-router, testbench, pattern-reuse]
timestamp: 2026-09-19T13:07:34Z
verifiedBy: 
---

# Pattern

`app/agent`'s tsconfig deliberately carries no ambient `types` (root `tsconfig.base.json`
sets `"types": []` repo-wide; each project opts in individually). That means `node:crypto`'s
type declarations are not visible inside `app/agent`, so a test file there needing a SHA-256
digest (e.g. to pin a prompt-version digest) cannot just `import { createHash } from 'node:crypto'`
the way `app/eval`'s `cli.ts` / `manifest.test.ts` do.

The fix is NOT to widen `app/agent`'s tsconfig with `"types": ["node"]`. That was tried and
reverted: it pulls in `@types/node`'s ambient global `fetch`/`RequestInit` declarations, which
collide with `fetch-json-http-port.ts`'s existing structural cast of the host `fetch` global
(`(globalThis as { fetch?: HostFetch }).fetch`), breaking `tsc -b` for the whole project.

Instead, reuse the codebase's own established idiom for reading untyped host globals - the
same structural-cast pattern `fetch-json-http-port.ts` already uses for `fetch` and
`TextDecoder` - applied to `crypto.subtle` and `TextEncoder`. Both are real Node/Web-standard
globals present at runtime; they are just not ambiently typed in this project. The resulting
digest is byte-identical to `node:crypto`'s `createHash('sha256')` output.

# When to use

Any `app/agent`-scoped file (or any other project in this monorepo with `"types": []`) that
needs a host runtime capability (crypto, encoding, fetch, timers, etc.) that would normally
come from `@types/node` or `lib.dom.d.ts`, but where turning on ambient types would collide
with an existing narrow-cast pattern elsewhere in the same project.

# Recipe / example

```ts
interface HostSubtleCrypto {
  digest(algorithm: 'SHA-256', data: Uint8Array): Promise<ArrayBuffer>;
}
interface HostTextEncoder {
  encode(input: string): Uint8Array;
}
type HostTextEncoderCtor = new () => HostTextEncoder;

function hostSubtleCrypto(): HostSubtleCrypto {
  const subtle = (globalThis as { crypto?: { subtle: HostSubtleCrypto } }).crypto?.subtle;
  if (subtle === undefined) throw new Error('no Web Crypto subtle digest is available in this runtime');
  return subtle;
}
function newHostTextEncoder(): HostTextEncoder {
  const ctor = (globalThis as { TextEncoder?: HostTextEncoderCtor }).TextEncoder;
  if (typeof ctor !== 'function') throw new Error('no TextEncoder is available in this runtime');
  return new ctor();
}

async function sha256Hex(text: string): Promise<string> {
  const bytes = newHostTextEncoder().encode(text);
  const hashed = await hostSubtleCrypto().digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hashed), (b) => b.toString(16).padStart(2, '0')).join('');
}
```

Used in `app/agent/roles/testbench/prompt-version.test.ts` (task 9.2) to pin a SHA-256 digest
of the assembled Testbench_Agent prompt for a canonical fixture Spec, against a literal
constant - not a self-recomputed value, which would make the test tautological.

# Pitfalls

- Do not widen a project's `tsconfig.json` `types` array to reach a Node API when that
  project already has structural casts for host globals elsewhere - check for the collision
  first (`tsc -b` will surface it as a duplicate/incompatible global declaration).
- `sha256Hex` here is async (Web Crypto `subtle.digest` is Promise-based) where `node:crypto`'s
  `createHash` is sync - callers must `await`, unlike the `app/eval` helpers.
- This is a test-only need so far; if a non-test file in a no-ambient-types project needs
  hashing, prefer this same structural-cast idiom over adding a new shared dependency.

# Links

- `app/agent/model-router/fetch-json-http-port.ts` - origin of the structural-cast idiom for
  `fetch` and `TextDecoder`.
- `app/agent/roles/testbench/prompt-version.test.ts` - the concrete usage (task 9.2).
- `chipAgent/_inbox/gotcha-prompt-version-absent-from-experiment-identity.md` - the related
  task 9.1 gotcha this test's fixture protects (prompt-version pinning).
