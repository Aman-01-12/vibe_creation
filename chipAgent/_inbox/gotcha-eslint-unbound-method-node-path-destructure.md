---
type: gotcha
title: Destructuring dirname/resolve from a dynamic import('node:path') trips @typescript-eslint/unbound-method
status: candidate
provenance: eval sweep lint repair (app/eval/sweep/config-parse.test.ts)
tags: [eslint, typescript, testing, node-api]
timestamp: 2026-09-05
---

# What happened

A test that reads a committed fixture file pulled its Node helpers in lazily inside the test body:

```ts
const { dirname, resolve } = await import('node:path');
```

`eslint app --max-warnings=0` reported TWO `@typescript-eslint/unbound-method` errors on that one line, one per binding.
The sibling `await import('node:fs/promises')` and `await import('node:url')` on the lines around it were clean.

# Root cause

`node:path` types its members as METHODS on the `PlatformPath` interface (`dirname(p: string): string;`), and the module's default export is an object satisfying that interface.
Destructuring pulls those methods off their receiver, which is exactly what `unbound-method` exists to catch.
`node:fs/promises` and `node:url` declare their members as standalone `function`s, so the same idiom is fine there - which is why only one of the three lines was flagged and the error looked arbitrary.

A STATIC named import of the same helpers is not flagged: the rule targets member access and destructuring of a value, not an import specifier.

# Fix / rule

Hoist Node built-ins to static top-level imports, which is already the repo convention in every sibling
(`app/eval/sweep/cli.test.ts`, `app/eval/gate/baseline-config.test.ts`, `app/eval/sweep/host-facts.ts`):

```ts
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
```

Do not reach for `.bind()` or an eslint-disable.
If a lazy import is genuinely wanted, keep the namespace and call through it (`const path = await import('node:path'); path.dirname(...)`) so the methods stay attached to their receiver.

# Links

- app/eval/sweep/config-parse.test.ts (the fix)
- app/eval/sweep/cli.test.ts (the convention it now matches)
