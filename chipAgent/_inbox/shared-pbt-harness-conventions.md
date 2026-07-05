---
type: pattern
title: Shared property-based test harness conventions (fast-check + Hypothesis)
status: candidate
provenance: hdl-creation-loop task 1.3 (property harness + shared generators)
tags: [testing, property-based, fast-check, hypothesis, conventions]
timestamp: 2025-05-27T00:00:00Z
verifiedBy: npm test + worker pytest (self-test properties pass on both sides)
---

# Pattern

Every numbered design property is tested through one shared harness rather than per-file re-rolled arbitraries and settings.
TypeScript uses fast-check via `@app/test`; the Python Tool_Runner worker uses Hypothesis.

# When to use

Any later property-test task in hdl-creation-loop (there is one property test per each of the 32 correctness properties).
Import from the shared harness instead of re-deciding iteration count, tag format, or edge-case generators.

# Recipe / example

TypeScript (`@app/test`):
- `propertyTag(n, text)` renders `Feature: hdl-creation-loop, Property {n}: {text}`; put it in a comment above the property.
- `propertyParameters(overrides?)` seeds `numRuns: 100` (the `DEFAULT_NUM_RUNS`) into `fc.assert`; raise but never lower it.
- Shared generators exported from `@app/test`: hostile identifiers, unsafe paths (traversal/absolute/encoded/symlink), non-positive port widths, empty/oversized payloads, injection markers, secret-shaped tokens, capture states.
- Runner is Vitest; `npm test` runs `vitest run` over `app/**/*.{test,spec}.ts`.

Python (worker `tests/`):
- `conftest.py` registers and loads a Hypothesis profile `hdl-creation-loop` at `max_examples = 100`.
- `property_harness.py` exposes `property_tag(n, text)` and shared strategies (`unsafe_path_strings()`, `non_positive_port_widths()`).

# Pitfalls

Secret-shaped token generators are fully synthetic (random bodies over known prefixes); never seed them with a real credential.
Generators are primitive/structural only (no I/O, no dependency on core domain types) so they stay independent of modeling tasks.
Keep the fast-check default at 100+; the design mandates the minimum.

# Links

- app/test/property.ts, app/test/generators/
- app/tools/sandbox/worker/tests/{conftest.py,property_harness.py}
- .kiro/specs/hdl-creation-loop/design.md (Testing Strategy)
