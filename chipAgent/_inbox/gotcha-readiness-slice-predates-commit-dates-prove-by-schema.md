---
type: gotcha
title: readiness-slice ran BEFORE the hardening commits were dated - prove code version by schemaVersion 9 fields, not by git dates
status: candidate
provenance: cross-checking .eval-runs/readiness-slice/manifest.json against git log while writing the interview docs
tags: [eval, measurement, provenance, integrity, git, readiness-slice]
timestamp: 2026-09-12T07:13:10Z
---
# The trap

`.eval-runs/readiness-slice/manifest.json` says `startedAt 2026-09-07T14:06:12Z`.
The oracle fix `7b0777f` is dated `2026-09-08 15:03 +0530`.
Read naively, this says the measurement was taken with the KNOWN-BROKEN oracle (the one that
could turn a FAIL into a PASS), which would invalidate every number in the slice.

# Why it is not actually invalid

The fixes were in the WORKING TREE when the run executed; they were committed the next day.
Committing after measuring is the normal order, and git commit dates do not record when code
was written.

# How to PROVE it from the artifact (do this instead of arguing from dates)

`results.jsonl` records carry `schemaVersion: 9` and these fields, which exist ONLY in the
post-hardening code:
- `goldenVerdict`, `goldenFailureCount`  (independent-judge metric, commit d1416dc)
- `instrumentValidity`, `instrumentDefect` (positive/negative controls, d1416dc)
- `unreportedUsageCalls` (three-state token accounting, c5829d8)
- `noVerdictCause`, `failureNote` (deferral semantics)
A pre-fix binary could not emit those keys. The artifact carries proof of its own code version.

# Generalisable lesson

Every run records `configHash`, `schemaVersion`, and a `toolchain` block. That is what makes
"which code produced this number" answerable rather than an argument. A measurement that cannot
identify the code that produced it is not a measurement. Keep that property.

# Second finding from the same slice (product-relevant)

Summary says: GOLDEN pass@1 = 0.800 (12/15 correct per the independent judge), but our own flow
`verified: 8`, and `instrument: 6/15 testbenches pass their reference design`.
=> The MODEL is producing better hardware than our INSTRUMENT can certify.
The bottleneck is the TESTBENCH generator, not the RTL generator. Next prompt-tuning effort
belongs on the grader role, not the designer role. Do NOT "fix" this by loosening the
instrument gate - that is exactly how the MISSED BUG shape returns.

# Links

- `product-ece/ECE-INTERVIEW-DEEPDIVE.md` 12.12 (defending the date discrepancy), 12.10 (the bottleneck finding)
- `.eval-runs/readiness-slice/summary.txt`
