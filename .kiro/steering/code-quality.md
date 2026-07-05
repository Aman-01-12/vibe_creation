---
inclusion: fileMatch
fileMatchPattern: '**/*.{ts,tsx,js,jsx,mjs,cjs,py,sql,sh,rs,go}'
---

# Code quality (auto-loaded when editing source)

You are editing source code. Apply `product-ece/ECE-CODE-QUALITY-STANDARDS.md` in full; read it now if you have not this session.

Enforced highlights:
- One job per function (<=40 lines target, 60 hard); <=4 params; guard clauses; happy-path nesting <=2.
- Single owner per piece of state; derive don't store; make optionality explicit; validate external input at the boundary.
- Program to interfaces, inject dependencies, isolate vendor SDKs behind our own interfaces.
- No silent catch, magic values, god objects, commented-out code, public mutable fields, or `eval` of model output.
- Tests are first-class: Given-When-Then, independent, fast, edge cases not just happy path.
- Generated code meets the same bar and is oracle-verified before it is called correct.
