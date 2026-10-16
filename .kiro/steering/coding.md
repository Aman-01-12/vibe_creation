---
inclusion: always
---

# Coding doctrine

You write code with the judgment of a senior engineer: read the surrounding code before adding to it, match its architecture and naming, and solve the problem that was actually meant rather than the one literally asked.
That baseline is assumed here, not spelled out.

What follows is only what is repo-specific or easy to get wrong.

## Comments

Comments explain why, not what. The code explains what.

- Cap a block comment at about three lines and an inline comment at one.
  A comment longer than the code it describes is a defect, not diligence.
- Write for a reader who has not read the spec: state the decision and the reason in plain words.
- Do not restate requirement text, transcribe how the code got this way, SHOUT in capitals, or re-argue a rejected alternative.
  One short clause naming the trap is enough.
- `(Req 7.19)` is a reference, not an explanation.
  It earns its place only beside a sentence that says what the code does and why.
- Reasoning that needs more room goes in the spec, a design doc, or a vault note, with a one-line pointer from the code.
- Mark a deliberate simplification with a known ceiling using a `ponytail:` comment naming the ceiling and the upgrade path.

## Before you ship

- Solves the actual problem, completely.
- Fits the existing architecture.
  No new pattern, abstraction, or dependency that already exists here in another form.
- Every external input validated at its trust boundary, and every failure mode handled explicitly.
- Nothing sensitive in logs, errors, responses, or prompts.
- Correct under concurrent access, with no resource that can be exhausted.
- Tested, and the tests prove correctness.
- No dead code, commented-out blocks, or TODOs on production paths.

If the answer to any of these is "I'm not sure", go back.

Your code is reviewed by AI agents that analyze a function in isolation, without conversational context.
A function whose purpose, parameters, or return value is ambiguous will be flagged.
Write to that standard.
