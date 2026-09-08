---
type: gotcha
title: bedrock-mantle reasoning models return empty `content` with the answer in `reasoning_content`
status: candidate
provenance: bedrock-mantle transport task; mirrors the working reference client (vbench.py) against the same endpoint
tags: [models, bedrock, model-router, api-shape, bake-off]
timestamp: 2026-07-16
---

# What happened

Amazon Bedrock's OpenAI-compatible host (`https://bedrock-mantle.{region}.api.aws/v1/chat/completions`) is Chat-Completions shaped, so the obvious client reads `choices[0].message.content` and stops there.
Several reasoning-class models in that catalog return an EMPTY `content` and put the actual answer in a sibling field, `message.reasoning_content`.
A client that reads only `content` gets a blank reply that looks like a valid, successful, empty generation.

# Root cause

`reasoning_content` is a vendor extension to the OpenAI schema, not part of it, so it is invisible to anything typed against the standard shape.
The failure is silent rather than loud: the HTTP call is a 200, the JSON parses, the shape validates, and only the text is missing.

# Fix / rule

Read the message text as `content` first and fall back to `reasoning_content` when `content` is blank, and treat "blank in both" as a malformed reply (`invalid-response`) rather than a successful empty result.
This matters most for a per-role model bake-off: without the fallback, an entire model class scores 0 on Cost per Verified Artifact for a client-side reason, and the wrong model gets certified.
Same-family rule for the metering block: an absent or mis-shaped `usage` is UNREPORTED, and a model missing from the injected price table has an UNKNOWN price - neither is zero spend, so never let a 0 flow into a cost metric as if it were measured.

# Links

- app/agent/model-router/chat-completions-reply.ts (`messageText`, `readUsage`)
- app/agent/model-router/bedrock-mantle-transport.ts (`costCentsFor`)
- Gotchas: [[gotchas/model-access-and-pricing-traps]]
