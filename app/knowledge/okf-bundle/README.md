# OKF bundle

Curated knowledge as markdown with frontmatter (HDL patterns, verification recipes, toolchain notes).

The M1 seed content is authored (task 10.1), drawn from the ECE decision docs and canonical HDL practice, consistent with the `chipAgent/` vault OKF schema (`chipAgent/_SCHEMA.md`).
Start at [[index]] (`index.md`): it is the root map of content the Knowledge_Retriever (task 10.2) traverses by progressive disclosure.

## Layout
- `index.md` - root map of content and authority rules.
- `hdl-patterns/` - standard-block HDL coding idioms (`type: pattern`).
- `verification-recipes/` - spec-derived testbench recipes, including the `CHECK <name> PASS|FAIL` signalling convention (`type: verification-recipe`).
- `toolchain-notes/` - Icarus Verilog and VCD basics (`type: domain-note`).

Each subdirectory has its own `index.md` map of content, and each concept note carries frontmatter plus a citations section.

## Rules
- Only `status: trusted` material may steer generation as authority; everything else is a hint.
- In this seed, only the per-check signalling contract is `trusted` (its ground truth is our tested parser plus the real oracle-path integration test); every other note is a `candidate` hint until the eval harness gates it.
- Knowledge improves the proposal only; the deterministic oracle (Icarus simulator plus an independent testbench) decides correctness and sets Trust_Tier.
- No secrets or PII ever land here.
