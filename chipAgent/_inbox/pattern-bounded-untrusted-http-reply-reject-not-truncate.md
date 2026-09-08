---
type: pattern
title: Bound an untrusted HTTP reply by streamed bytes, and reject rather than truncate
status: candidate
provenance: production JsonHttpPort implementation - app/agent/model-router/fetch-json-http-port.ts
tags: [security, http, untrusted-input, ports, dos, model-router]
timestamp: 2026-09-05
verifiedBy: tsc -b (exit 0); eslint app --max-warnings=0; vitest run (700 passed / 6 skipped, incl. 14 new port examples)
---

# Pattern

A port that reads a reply from a remote host bounds the read by counting bytes off the response STREAM, checking the running total before each chunk is decoded.
When the cap is exceeded the read is abandoned, the stream is cancelled, and the call REJECTS with a coded, detail-free error.
It never resolves with what fitted.

# When to use

Any boundary that pulls a body of caller-uncontrolled size from an untrusted host: model providers, datasheet fetches, retrieved web content, webhook payloads.

# Recipe / example

- Read incrementally (`stream.getReader()`), add `chunk.length` to a running count, and compare BEFORE decoding. `await response.text()` then `slice()` is not a bound: the whole reply is already resident.
- Do not trust `Content-Length` as the bound - a hostile host controls it. Keep one enforcement point: the streamed count.
- Decode incrementally (`decode(chunk, { stream: true })`) and construct a FRESH decoder per call. A hoisted decoder holds the partial multi-byte character between chunks, so sharing one across concurrent calls lets one reply's trailing bytes corrupt another's body.
- Cap is named and injectable (`DEFAULT_MAX_REPLY_BYTES`, `deps.maxReplyBytes`); an illegal cap throws at composition time, not per call.
- Reach host primitives (`fetch`, `TextDecoder`) through a narrow `globalThis` accessor with a structural interface, so a layer compiled with `types: []` and `lib: ES2022` needs no DOM/node typings - and inject the client so tests need no network.

# Pitfalls

- TRUNCATING IS THE TRAP. A clipped JSON prefix can still parse as a plausible reply, so a caller would read a fabricated answer as the provider's. Returning `{status, body: ''}` is the same trap one step removed: a caller that checks only a 2xx status reads it as success-with-no-content.
- A rejection must be information-free. A raw `fetch` rejection names the host, IP, port, and TLS chain, so replace it with your own coded error; the surrounding guard (`exchangeJson`) drops it anyway, but a direct caller or an unhandled-rejection logger would not.
- Cap plus deadline are BOTH needed: the cap stops a huge body, the deadline stops a slow one. A stalled stream is bounded only by aborting the controller whose signal `fetch` received.
- Tension left open: an over-cap reply collapses into the seam's `unreachable` outcome, so a transport cannot distinguish "reply unusable" from "host unreachable". Acceptable because both are non-passes, but it costs diagnosability - a dedicated outcome variant would fix it.

# Links

- app/agent/model-router/fetch-json-http-port.ts, fetch-json-http-port.test.ts
- app/agent/model-router/json-http-port.ts (the seam: raw strings, never-rejects `exchangeJson`, redacted outcomes)
- product-ece/ECE-SECURITY-PERFORMANCE-RESILIENCE.md (untrusted input at every trust boundary; resource bounds)
