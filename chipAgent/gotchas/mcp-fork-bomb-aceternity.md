---
type: gotcha
title: aceternity-mcp postinstall fork-bombed the process table
status: trusted
provenance: observed directly during MCP setup (real incident)
tags: [mcp, tooling, setup, supply-chain]
timestamp: 2026-07-03T00:00:00Z
verifiedBy: direct observation (ps showed a runaway aceternity-mcp-server chain; ulimit -u 1333 exhausted)
---

# What happened
Smoke-testing the `aceternity-mcp` (devinoldenburg) package spawned a runaway chain of `aceternity-mcp-server --help` processes (its postinstall auto-config wizard), exhausting the user-process limit (~1341 vs ulimit 1333) and causing `fork: resource temporarily unavailable` across the shell.

# Root cause
That package runs a side-effecty postinstall that auto-configures other tools and misbehaved. It also silently rewrites other tools' MCP configs.

# Fix / rule
- Use the clean `aceternityui-mcp` (rudra016) package instead - no postinstall, pure stdio server.
- Do NOT smoke-test MCP servers by launching them in the shell; let the MCP runtime manage them.
- Prefer packages with no postinstall side effects; pin versions.

# Links
- [[decisions/index|Decisions]] (aceternity package choice)
