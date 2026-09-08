---
type: gotcha
title: typescript-eslint's no-unused-vars defaults ignoreRestSiblings to FALSE, so the omit-a-key destructure is an error
status: candidate
provenance: eval sweep lint repair (app/eval/sweep/results-log.test.ts)
tags: [eslint, typescript, testing]
timestamp: 2026-09-05
---

# What happened

The standard "same object minus one key" idiom, used to build a malformed record for a decoder test:

```ts
const { armName: _dropped, ...rest } = record();
expect(decodeSampleRecord(rest)).toBeNull();
```

failed lint with `@typescript-eslint/no-unused-vars`: `'_dropped' is assigned a value but never used`.
This surprises anyone who has used the core ESLint rule, where a variable destructured alongside a rest element is exempt by default.

# Root cause

Core `eslint/no-unused-vars` defaults `ignoreRestSiblings: true`.
`@typescript-eslint/no-unused-vars` (v8.62.1) defaults it to **`false`** - verified in the installed rule's default options.
The repo config uses `tseslint.configs.recommendedTypeChecked` with no rule options, so the stricter default is in force.
The `_` prefix does not help either: this config sets no `varsIgnorePattern`.

# Fix / rule

Do not fight it with a disable comment or a filler assertion on the discarded value.
Express the intent with a named helper that never binds the omitted value:

```ts
function recordWithout(omitted: keyof SweepSampleRecord): Record<string, unknown> {
  return Object.fromEntries(Object.entries(record()).filter(([field]) => field !== omitted));
}
```

The call site then reads as what it means - `decodeSampleRecord(recordWithout('armName'))` - and the test body contains only assertions.
Same trap class as the `args: "after-used"` note: prefer restructuring the code over an ignore pattern, because the underscore convention is not load-bearing under this config.

# Links

- app/eval/sweep/results-log.test.ts (the helper)
- chipAgent/_inbox/gotcha-eslint-after-used-unused-args.md (sibling trap in the same rule)
