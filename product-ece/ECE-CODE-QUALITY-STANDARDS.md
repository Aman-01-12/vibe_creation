# Code Quality Standards (stack-adapted)

Status: living standard for the build
Applies to: all code we write (frontend, API, agent service, tool-runners) AND all code the product's agent generates that ships to a student.
Origin: distilled from the team's C++/C# coding-standards doc, generalized to our stack (TypeScript/React frontend, Node/TypeScript + Python backend/agent, Postgres, containers), plus rules specific to AI-generated code.
Related: the always-on `.kiro/steering/coding.md` (senior-SWE mindset), `ECE-SECURITY-PERFORMANCE-RESILIENCE.md` (security/perf/resilience), and the `no-mistakes` gate + CI that enforce this.

## 1. Foundational philosophy (language-agnostic, carried over)

- Code is read far more than written; optimize for the reader six months from now with no context.
- Correctness first, optimization second; make it work, make it correct under all inputs, profile, then optimize the measured bottleneck.
- Explicit over implicit; name the condition, make the side effect visible at the call site.
- Consistency over personal preference; follow the existing pattern, resolve to one in refactor.
- Rule of least surprise; a function does what its name says and nothing else.
- Leave it better than you found it, without unilaterally introducing new patterns.

## 2. Naming

- The name is the documentation; rename freely when a better name appears.
- Names must be unambiguous at the call site, reflect intent not implementation, and contain a verb for functions.
- Booleans read as assertions (`isMutedByHost`, `hasWritePermission`).
- No type-encoding, no non-domain abbreviations; symmetric operations get symmetric names (connect/disconnect).

Conventions for our stack:

| Construct | TypeScript | Python |
|---|---|---|
| Types/classes/interfaces | `PascalCase` (no `I` prefix) | `PascalCase` |
| Functions/methods | `camelCase` | `snake_case` |
| Variables/params | `camelCase` | `snake_case` |
| Constants | `UPPER_SNAKE_CASE` | `UPPER_SNAKE_CASE` |
| Files | `kebab-case.ts` / `PascalCase.tsx` for components | `snake_case.py` |
| React components/hooks | `PascalCase` / `useCamelCase` | n/a |
| Async functions | plain `camelCase` (types say Promise) | `async def snake_case` |

## 3. Structure and architecture

- One primary responsibility per file; file name matches its primary concept.
- Folder structure mirrors architectural layers; dependencies flow inward only (from the PRD system diagram):
  - `core` (domain, pure logic, no external deps) knows nothing.
  - `knowledge` (OKF/RAG/retrieve), `tools` (sim/synth/checks runners), `agent` (orchestrator), `api` (HTTP layer), `web` (React UI).
  - No inner layer imports an outer layer; no circular dependencies.
- Program to interfaces; inject dependencies through the constructor/params, never `new` a dependency or reach a global inside a unit.
- Isolate every vendor SDK (model providers, EDA tools, Firecrawl, Neon) behind our own interface, so a vendor change touches only the adapter.

## 4. Functions and methods

- One function, one job (describe it in one sentence without "and").
- Length target 40 lines, hard limit 60; max 4 parameters (group into an object/dataclass beyond that).
- Guard clauses over nested conditionals; happy-path nesting depth <= 2.
- Command-query separation; a function either changes state or returns information, not both.
- No boolean parameters at call sites; use named options/enums.
- Return values over output parameters; return a typed object for multiple values.

## 5. Types and state

- Single Responsibility Principle is not optional; one reason to change per class/module.
- Compose over inherit; use interfaces for polymorphism, composition for reuse.
- Immutability by default (`readonly`, `as const`, frozen; Python `@dataclass(frozen=True)` / tuples); prefer pure functions.
- State has exactly one owner; when state is wrong you must answer "who wrote this?" in O(1).
- Derive, do not store, derived state (compute `isMuted` from its causes; never keep two copies of one truth).
- No mutable global state; the only exception is read-after-init config.
- Null/undefined/None means absence, not error; use result types or exceptions for errors; make optionality explicit in types.
- Any state synchronized across the network carries a sequence number; stale updates (seq <= current) are silently discarded.

## 6. Error handling

- Never silently swallow an error; handle, transform, or log-with-context and rethrow. An empty catch is always wrong.
- Right mechanism for the situation: exceptions for truly exceptional/unrecoverable; typed result/error values for expected failures (validation, not-found, permission-denied); assertions for programmer errors in dev only.
- Error messages include actionable context internally, but sanitized messages externally (see security doc, Threat: information disclosure).
- Do not use exceptions for control flow.
- Every async operation has a failure path; no unobserved promise rejections.
- Fail fast on unrecoverable/corrupt state rather than limping forward.

## 7. Async, concurrency, cancellation

- Async all the way; do not block on async (`.then().catch` fine, no sync-over-async deadlock patterns).
- Every long-running operation is cancellable: `AbortController`/signal (TS), `asyncio` cancellation or a stop flag (Python), and a `CancellationToken`-equivalent threaded through every downstream call.
- Name background workers/queues so they are identifiable in traces.
- Shared mutable state accessed from multiple contexts is synchronized or, better, avoided by single-ownership.

## 8. Comments and documentation

- Comments explain why, not what; delete comments that restate the code.
- Public interfaces document the contract: guarantees, preconditions, error conditions, valid ranges.
- TODOs must reference a tracked issue and the resolution condition.
- Delete commented-out code; version control has it.
- Document non-obvious invariants where established and where relied upon.

## 9. Testing

- Tests are first-class code and follow these standards.
- Naming: Given-When-Then (or `test_given_..._when_..._then_...`).
- One logical assertion per test; tests are independent and order-agnostic; no real network/file/hardware in unit tests (mock the interfaces).
- Coverage is a floor not a ceiling; test the edge cases (sequence-number boundary, null entity, permission interactions), not just the happy path.
- Unit tests run in well under a second each; slow tests are integration tests, labeled and run separately.
- Product-specific: the eval harness (VerilogEval/RTLLM regression, pass@k, iterations-to-pass, cost/session) and property-based tests for our own invariants run in CI and block merges on regression (see `ECE-VERIFICATION-METHODOLOGY.md`).

## 10. Version control and review (enforced by the no-mistakes gate)

- One logical change per commit; imperative title + a body explaining why.
- Never commit to main directly; every change goes through a PR and the `no-mistakes` pipeline (review -> test -> docs -> lint -> PR -> CI).
- PRs <= ~400 lines of changed production code; decompose larger changes.
- Every commit builds; main always builds and passes tests + eval.
- Reviewers check: correctness/edge cases, standards compliance, design/ownership/coupling, tests, security (new attack surface), and performance regressions.

## 11. Stack-specific rules

TypeScript:
- `strict` mode on; no implicit `any`; prefer `unknown` + narrowing over `any`.
- Model absence with `T | undefined` and exhaustive `switch` with a `never` default.
- Validate all external input at the boundary with a schema (e.g. Zod); never trust a parsed payload's shape.
- No floating promises (lint rule); handle or explicitly void with a comment.

Python:
- Type hints everywhere; run a type checker (mypy/pyright) in CI.
- Use `@dataclass`/`pydantic` models for structured data; validate external input with pydantic.
- Prefer `pathlib`, context managers for resources; never bare `except:`.
- Pin dependencies exactly; no wildcard versions (supply-chain, see security doc).

React:
- Components do one thing; lift state to a single owner; derive rather than duplicate.
- Every effect that starts async work cleans it up (`AbortController` + unmount cleanup) to avoid state-update-after-unmount (see resilience doc, Threat 8).
- Accessibility is a requirement, not a nicety (WCAG); keyboard + screen-reader paths work.

## 12. AI-generated code quality (product-specific, critical)

The code our agent produces for a student is held to the same bar as ours, and is checked by tools, not trusted:
- Generated code passes the same lint/type/format/security gates as our own before it is presented as trusted.
- Static analysis (SAST) and secret-scanning run on generated code; nothing with a hardcoded secret, an obvious injection sink, or an unsafe eval reaches a student unflagged.
- Generated code is verified by the deterministic oracle for its domain (simulator/ERC/DRC/tests) before any "this works" claim, per the prime directive.
- Generated code that we cannot verify is labeled as unverified (trust tier), never presented as correct.
- No generated artifact is executed outside a sandbox (see security doc, sandboxing).

## 13. Forbidden patterns (auto-block in review)

- Silent exception swallowing (empty catch / bare except).
- Magic numbers and magic strings (name them as constants; socket/event names in a constants module).
- God objects (a unit with too many responsibilities, >~300 lines, or >5 external deps).
- Commented-out code.
- Public mutable fields (expose via controlled accessors).
- Unvalidated external input crossing a trust boundary (payloads, files, API responses, model output, retrieved web content).
- `sleep()` as a synchronization mechanism in production logic.
- Returning null/None from a collection-returning function (return empty).
- Hardcoded credentials, endpoints, or secrets (use env/secret manager; enforced by `.gitignore` + secret scanning).

## Quick reference

| Rule | Standard |
|---|---|
| Max function length | 40 target / 60 hard |
| Max parameters | 4 |
| Max PR size | ~400 lines changed |
| Happy-path nesting | <= 2 |
| Unit test speed | < 1s each |
| Test naming | Given-When-Then |
| External input | validated at the boundary, always |
| Generated code | gated + oracle-verified before "trusted" |

Reference: full rationale and language examples in the team `coding-standards` document (C++/C# origin); this file is the stack-adapted, enforceable subset plus AI-code rules.
