---
type: moc
title: Verification recipes - map of content
tags: [verification, testbench, verilog]
status: trusted
provenance: founding seed (task 10.1)
timestamp: 2026-07-05T00:00:00Z
---

# Verification recipes

How an independently derived, spec-derived Verilog testbench proves an acceptance criterion under the Icarus oracle.
The canonical method is `product-ece/ECE-VERIFICATION-METHODOLOGY.md`: the model proposes, the deterministic oracle decides, and the testbench is derived from the Spec, never from the generated RTL.

## Concepts
- [[verification-recipes/check-line-signalling|Per-check signalling (CHECK <name> PASS|FAIL)]] - `trusted` authority; the contract generated testbenches must emit.
- [[verification-recipes/self-checking-testbench|Self-checking spec-derived testbench structure]] - `candidate` hint.
- [[verification-recipes/boundary-and-known-answer-checks|Boundary, error, and known-answer checks]] - `candidate` hint.

## Note on authority
The per-check signalling format is the one `trusted` note in this bundle because its ground truth is our own tested parser (`app/tools/simulator/check-signalling.ts`) exercised by the real `iverilog` + `vvp` oracle-path integration test.
The other recipes are hints until the eval harness validates them.
