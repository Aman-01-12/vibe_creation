---
type: gotcha
title: Legacy .kiro.hook files never fire, and an empty MOC makes the whole vault invisible
status: candidate
provenance: session on vault utilisation - founder reported the capture hook was not being invoked
tags: [kiro, hooks, steering, knowledge-vault, retrieval, tooling]
timestamp: 2026-09-05T00:00:00Z
---

# What happened

The vault capture hook had been configured but never ran, and 37 of 40 vault notes were
never read back by any session, so the same facts kept getting re-derived from the codebase.

Two independent failures, one visible and one silent:

1. `.kiro/hooks/vault-learning-capture.kiro.hook` used the retired IDE 0.x schema
   (`"when": {"type": "postTaskExecution"}`, `"then": {"type": "askAgent"}`). It never fired
   and produced no error. `askAgent` was never a valid action type in either schema.
2. Navigating the vault the documented way dead-ended. `chipAgent/index.md` said "follow the
   relevant links", but `patterns/index.md` and `verification/index.md` said "(none yet)" and
   `_inbox/index.md` linked nothing at all - while 37 real notes sat in `_inbox/`. An agent
   that obediently followed the MOC concluded the vault was empty and moved on.

# Root cause

1. Hooks moved to `.kiro/hooks/<id>.json` with `version: "v1"` and `trigger`/`matcher`/`action`
   (PascalCase triggers: `PostTaskExec`, `SessionStart`, `PostFileSave`, ...). Legacy files are
   not executed; the IDE only offers an in-place upgrade badge. `postTaskExecution` maps to
   `PostTaskExec`. Exception: legacy `userTriggered` hooks DO still run via the play button and
   have no v1 equivalent, so those are worth keeping.
2. Hand-maintained MOCs drift. Retrieval was gated on a human keeping index files current, and
   capture wrote to `_inbox/` while retrieval read from the section maps - so capture and
   retrieval were pointed at different places. The vault got fuller and less usable at once.
3. Steering said `candidate` notes are "hints, not authority" while 37 of 40 notes were
   `candidate`, which told agents to discount exactly where all the knowledge lived. The design
   doc had only ever scoped that to "does not steer generation"; continuity value was always
   meant to be authoritative.

# Fix / rule

- Never hand-write hook JSON; use the `createHook` tool so the current schema is emitted.
- Any generated index must be generated. `scripts/vault-manifest.mjs` derives
  `chipAgent/MANIFEST.md` from the notes themselves; `npm run vault:check` fails the build when
  it drifts, and `PostFileCreate`/`PostFileSave` hooks regenerate it.
- Point capture and retrieval at the SAME artifact. Both now go through the manifest.
- A hook cannot guarantee a read; `inclusion: always` steering is the mechanism for always-on
  context. Hooks are for event-driven work and for content computed at runtime (a `SessionStart`
  command hook injects the vault digest, since its stdout is added to context).
- Loop guard on file-triggered hooks that write files: scope the matcher to authoring
  directories (`chipAgent/(_inbox|gotchas|...)/.*\.md$`) so regenerating the root-level
  `MANIFEST.md` cannot retrigger the hook. Avoids needing regex lookahead.
- When distinguishing trust levels, say what the status gates. "Not a correctness claim" and
  "not worth reading" are very different instructions, and collapsing them cost us the vault.

# Links

- `.kiro/steering/knowledge-memory.md` (the always-on rule)
- `scripts/vault-manifest.mjs`, `chipAgent/MANIFEST.md`
- `product-ece/ECE-OBSIDIAN-KNOWLEDGE-MEMORY.md` (design; the flywheel this restores)
- kiro.dev docs: hooks, hooks/types, hooks/actions, ide/whats-new-v1/hooks
