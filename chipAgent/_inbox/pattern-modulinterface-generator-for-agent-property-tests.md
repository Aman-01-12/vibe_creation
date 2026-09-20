---
type: pattern
title: Generating an arbitrary ModuleInterface for app/agent property tests
status: candidate
provenance: task 3.2 (instrument-precheck-and-attribution spec), spec-task-execution subagent
tags: [testing, property-based, fast-check, module-interface, spec-view, app-agent, app-test]
timestamp: 2026-09-20T00:15:00Z
verifiedBy:
---

# Pattern

`interface-exact.property.test.ts` (hdl-creation-loop, Property 17) already builds
an arbitrary `Spec` from an arbitrary `ModuleInterface`, but nothing in `app/test/`
generated a bare `ModuleInterface` on its own until task 3.2 needed one to drive
`buildInterfaceStub` directly (no `Spec` wrapper required - the stub reads only
`moduleInterface`). The recipe is the same shape, minus the `Spec` envelope:

1. Generate a raw shape: `moduleName` (identifier), a list of `(direction, width)`
   pairs for declared ports, and `hasClock` / `hasReset` / `resetActiveLow` booleans.
2. `.chain()` into a `fc.uniqueArray(identifierArbitrary(), { minLength: needed })`
   sized to `declaredCount + hasClock + hasReset`, then slice off names for
   declared ports, then clock, then reset - uniqueness across ALL of them is
   required because a real module cannot declare two ports with the same name,
   and `expectedInterfacePorts` indexes by name.
3. Build each declared `Port` through `makePort` (never construct the interface
   literal by hand), throwing loudly if the validating constructor ever rejects a
   generated shape - that would mean the generator produced an invalid case, not
   that the code under test is wrong.
4. Assemble the `ModuleInterface` literal directly (`{ moduleName, ports, clocking
   : { clockName, resetName, resetActiveLow } }`); no `Spec` fields are needed
   when the function under test takes `ModuleInterface` alone.

Reused the exact identifier-generation helpers (`identifierArbitrary`,
`RESERVED` keyword set, `fromChars`) from `interface-exact.property.test.ts`
verbatim rather than re-deriving them, and added `initial`/`always` to the
reserved set since this generator's consumer (`buildInterfaceStub`) is checked
for the ABSENCE of those tokens - a generated port or module name accidentally
containing one as a substring would make that assertion vacuous in rare cases.

# When to use

Any later `app/agent` property test that needs an arbitrary `ModuleInterface`
(or a `Spec` wrapping one) - e.g. a future property over `buildCompileHarness`,
the interface-exactness checker, or another Spec-interface-derived module.

# Pitfalls

- `fc.array` for `directions` and `fc.array` for `widths` are independent
  arbitraries with independently-chosen lengths; pairing them by index requires
  trimming both to the shorter length BEFORE generating names, or the port count
  used to size the unique-name array will disagree with the port count actually
  built.
- Width-1 ports must render with no bit-range suffix (`reg x;`, not `reg
  [0:0] x;`); assert against the exact rendered line, not just a substring
  match on the port name, or a width/direction mismatch reads as a pass.
- Do not use `propertyTag()` for a non-hdl-creation-loop property - see the
  existing gotcha note on that hardcoded feature slug. Use a literal tag string
  instead, matching the pattern this task's file and
  `failure-attribution-precedence.property.test.ts` both use.

# Links

- `app/test/interface-stub-shape.property.test.ts` (this task's file)
- `app/test/interface-exact.property.test.ts` (the `Spec`-wrapped precedent)
- `app/agent/roles/generation/spec-view.ts` (`expectedInterfacePorts`)
- `app/agent/orchestrator/testbench-precheck.ts` (`buildInterfaceStub`)
- `chipAgent/_inbox/gotcha-property-tag-feature-slug-is-hardcoded-to-hdl-creation-loop.md`
