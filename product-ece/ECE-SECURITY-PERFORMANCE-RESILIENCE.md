# Security, Performance & Network Resilience

Status: living standard; must be satisfied before anything is called production-ready
Applies to: our web app and backend AND the code/artifacts the agent generates for students.
Mindset: assume a savvy, motivated attacker with full knowledge of our client (the JS bundle is downloadable), the ability to call our APIs directly (curl/Postman), and the ability to throttle or manipulate their own network. The client is untrusted; the server trusts nothing it did not verify.
Related: `ECE-CODE-QUALITY-STANDARDS.md`, `ECE-KNOWLEDGE-ARCHITECTURE.md` (untrusted-web handling), `ECE-RELIABILITY-SELFHEALING.md` (idempotency/self-heal), and the team `network-resilience` reference doc (source of the resilience threats below).

## 1. Threat model (think like the attacker)

Trust boundaries (every one is an attack surface):
- Browser to API (any request can be forged, replayed, reordered, or throttled).
- API to agent/tool-runners (internal, but treat as hostile if the API is compromised).
- Agent to model providers and to the web (model output and web content are untrusted data).
- Tool-runners executing generated HDL/testbenches/firmware (arbitrary code execution surface).
- Data at rest (student projects, PII, secrets).

Core stance: zero-trust. Authenticate and authorize on the server for every request, validate every input at every boundary, never let client state or model output act as a security control.

## 2. OWASP Top 10 (2025) mapped to us

The 2025 list keeps Broken Access Control at #1, moves Security Misconfiguration to #2, adds Software Supply Chain Failures and Mishandling of Exceptional Conditions, and folds SSRF into Broken Access Control. Rephrased from [OWASP Top 10:2025](https://owasp.org/Top10/2025/0x00_2025-Introduction/).

| Risk | Our exposure | Mitigation |
|---|---|---|
| A01 Broken Access Control (incl. SSRF, IDOR) | students accessing other students' projects/designs; agent fetching internal URLs | server-side authorization on every endpoint and every object (see IDOR, §3); allowlist outbound fetch targets; no client-side access control |
| A02 Security Misconfiguration | default creds, verbose errors, open CORS, exposed admin/debug | hardened defaults, least-privilege, locked CORS, no stack traces to clients, security headers (CSP, HSTS, X-Content-Type-Options) |
| A03 Software Supply Chain Failures (new) | npm/pip packages, model weights, EDA tool images, MCP servers | pin exact versions, lockfiles, provenance/signature checks, dependency + image scanning, minimal base images, review new deps for typosquatting |
| A04 Injection | SQL, command, template, and prompt injection; generated-code sinks | parameterized queries/ORM only, no string-built SQL, no shell string interpolation (use arg arrays), validate/escape at boundaries, treat prompts as data (§6) |
| A05 Insecure Design | missing rate limits, no abuse modeling, trusting the client | threat-model each feature, design abuse cases, rate-limit and budget-cap by default |
| A06 Vulnerable/Outdated Components | old libraries with known CVEs | automated CVE scanning (dependabot-style), scheduled upgrades, block builds on critical CVEs |
| A07 Authentication Failures | weak sessions, no rotation, credential stuffing | strong auth provider, short-lived access + refresh tokens, rotation, MFA option, lockout/backoff, secure cookies |
| A08 Software/Data Integrity Failures | unsigned artifacts, insecure deserialization, CI tampering | signed builds, integrity checks on artifacts, safe deserialization, protected CI with the no-mistakes gate |
| A09 Logging & Monitoring Failures | blind to attacks, PII in logs | structured audit logs (authz decisions, security events), no secrets/PII in logs, alerting, the action-recorder trace |
| A10 Mishandling of Exceptional Conditions (new) | error paths that leak info or fail open | fail closed/safe, sanitized errors (§ resilience Threat 3), handle every failure path explicitly (matches code-quality error handling) |

## 3. IDOR / Broken Object Level Authorization (the #1 API risk, called out explicitly)

BOLA/IDOR is the top API vulnerability: an endpoint identifies the target by an ID in the request but fails to verify the caller owns/may access that object; changing the ID returns someone else's data. Rephrased from [OWASP API1:2023](https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/).

Rules (non-negotiable):
- Every endpoint that takes an object ID re-checks, on the server, that the authenticated user is authorized for that specific object, on every request.
- Authorization is by ownership/role from a validated token claim, never by "the UI only showed them their own IDs."
- Use unguessable IDs (UUID/ULID) as defense-in-depth, but never as the only control (obscurity is not authorization).
- Also enforce object-property-level authorization (API3/BOPLA): never mass-assign request fields onto a model; whitelist writable properties, and never return properties the caller may not see.
- Enforce function-level authorization (API5/BFLA): admin/moderation routes check role server-side.

## 4. PII and student-data protection

- Data minimization: collect only what the feature needs; do not store what you do not need.
- Encrypt in transit (TLS everywhere) and at rest (DB encryption, encrypted backups).
- Never put PII or secrets in logs, error messages, traces, or the action-recorder; reference by opaque ID.
- Access to PII is authorized and audited; least privilege on the data store.
- Retention + deletion: define retention windows and honor deletion requests (India DPDP Act and GDPR-style expectations for a student product).
- Use generic placeholders for PII in examples/sample data; use real PII only where the student's own project legitimately requires it.
- Treat prompts/designs a student submits as their data; do not train on it without explicit consent, and keep per-project knowledge caches isolated per user.

## 5. AI/LLM-specific security (OWASP Top 10 for LLM Apps, 2025)

We inherit traditional web risks plus LLM-specific ones. Rephrased from [OWASP GenAI/LLM Top 10](https://genai.owasp.org/llm-top-10/).

- Prompt injection (direct and indirect). Direct: a student tries to make the agent misbehave. Indirect: hidden instructions embedded in fetched web pages, datasheets, PDFs, or RAG content seize the session. Mitigations: treat all retrieved/user content as untrusted data, never as instructions; strong system-prompt/tool-call boundaries; a trusted-source allowlist for fetches; strip/neutralize active content; the agent cannot be talked into calling a side-effectful tool or revealing secrets (see `ECE-KNOWLEDGE-ARCHITECTURE.md`).
- Insecure output handling. Model output (RTL, firmware, shell, SQL) is never executed or trusted directly; it runs only inside a sandbox and is judged only by the deterministic oracle. Never `eval` model output; never build a shell command by string-concatenating model output.
- Sensitive information disclosure. The model must not be able to leak secrets, other users' data, or internal infra; secrets are never in the prompt/context; outputs are scanned before display.
- Excessive agency. The agent has the minimum tools and permissions; side-effectful tools (fab submit, order, payment, deletes) require an approval gate and idempotency keys; no tool can exfiltrate data.
- Unbounded consumption (model DoS / cost). Hard caps on iterations, tokens, time, and spend per session; rate limits; this also protects our pennies-per-session economics.
- Supply chain (models/datasets). Pin and verify model versions and datasets; use copyright-safe corpora; validate integrity of downloaded weights/images.
- Misinformation / over-reliance. Because a wrong answer mis-teaches a student, correctness is always tool-verified and trust tiers are shown; teaching states its limits.

## 6. Sandboxing generated-code execution (existential for us)

We run agent-generated HDL, testbenches, firmware, and helper scripts; that is arbitrary code execution and must be contained:
- Execute only in ephemeral, isolated containers (or microVMs) with no secrets mounted, no access to our internal network, and no cloud credentials.
- Deny outbound network by default inside tool-runners; allowlist only what a tool genuinely needs.
- Enforce CPU, memory, wall-clock, process, and disk limits; kill on breach (this also prevents the fork-bomb class of failure).
- Treat container escape as the top-severity risk; keep runtimes patched, drop capabilities, run as non-root, read-only filesystem where possible.
- One tenancy boundary per run; never share a container across users; wipe artifacts after.

## 7. Secrets management

- No secrets in source, client bundles, prompts, or logs; enforced by `.gitignore` and automated secret scanning in CI.
- Secrets come from environment/secret manager; scoped and rotated; least privilege per service.
- Client never holds provider API keys; all model/tool calls proxy through our API layer (also enables rate limiting, cost tracking, and injection filtering).
- Rotate any credential that appears in a shared channel (the Firecrawl key discussion is a reminder to rotate before anything goes public).

## 8. Performance (must pass production/real-traffic metrics)

Implementing the feature is not enough; it must hold up under load. Targets and methods below are grounded in production guidance. Rephrased from [Fixing slow API endpoints](https://api.atatus.com/guides/fix-slow-api-endpoints/), [Cutting P99 latency](https://dzone.com/articles/cutting-p99-latency-policy-api), and [database optimization](https://middleware.io/blog/database-optimization/).

- Measure the tail, not the average: track p50, p95, and p99 per endpoint; a good p50 with a bad p99 is a real problem for a fraction of every user's requests. Optimize the measured bottleneck (EXPLAIN ANALYZE, flame graphs), never guesses.
- Database:
  - Index the columns you filter/join/sort on; verify with query plans; watch for sequential scans and row-estimate mismatches.
  - Avoid the anti-patterns: `SELECT *`, `OFFSET` pagination (use keyset/cursor pagination), N+1 queries (batch/join/eager-load), functions in `WHERE`, and unbounded joins.
  - Use connection pooling with warmup; parallelize independent I/O.
  - Add caching, read replicas, partitioning only after queries and indexes are clean.
- API:
  - Paginate and bound every list endpoint; never return unbounded result sets.
  - Compress responses; use edge/CDN and HTTP caching for static and cacheable content.
  - Cache expensive, infrequently-changing computations; for us, the CAG/prompt-cache and the OKF knowledge cache remove repeated cost/latency (see `ECE-KNOWLEDGE-ARCHITECTURE.md`).
  - Stream long agent runs (SSE/WebSocket) with progress rather than blocking a request; make them resumable via checkpoints (ties to the action-recorder).
- Frontend: budget Core Web Vitals; lazy-load heavy panels (waveform/diagram/WASM sim); keep the main thread free (run WASM sim in a worker).
- Load-test before launch (realistic concurrency and payloads); put performance benchmarks in CI and block merges that regress a critical path beyond an agreed threshold.

## 9. Network resilience (adapted from the team reference doc)

Slow/hostile networks are both a UX and a security problem; attackers throttle their own connection to exploit state machines. Controls (each maps to a threat in the `network-resilience` reference):

- Optimistic UI + explicit loading state; the action's control disables instantly at the state level (not just visually).
- Client-side timeouts + a three-state circuit breaker (closed -> open -> half-open) with exponential backoff and jitter, so a brief outage does not disable a feature permanently and a recovering server is not hammered.
- Idempotency keys (UUID per state-mutating action) sent as a header; the server caches the key and returns the original result on retry, preventing duplicate meetings/orders/submissions (Two Generals' problem). Side-effectful actions never blind-retry on timeout (matches `ECE-RELIABILITY-SELFHEALING.md`).
- Debounce + strict disable to prevent button-mashing from spawning a burst that self-DoSes the backend when the network recovers.
- Sanitized error mapping: never surface raw errors (no internal hostnames, IPs, ports, stack traces); map to safe user messages via one error-mapper utility.
- Role-based rendering, not connectivity-based rendering: show/hide UI from validated token claims, never by probing which backend hosts are reachable (that leaks topology).
- Server-side authorization on every endpoint regardless of what the UI renders; the server behaves as if the UI does not exist.
- Transparent token refresh via a single 401 interceptor (with a shared in-flight refresh promise and a hard timeout), replaying the original request once; only a failed refresh surfaces a clean "session expired" message.
- AbortController tied to component lifecycle: cancel in-flight requests on unmount/navigation/timeout; discard AbortErrors silently; distinguish a timeout-abort (show the toast) from an unmount-abort (silent).
- Do not queue secure/state-mutating actions offline (a local queue can be tampered with); hard-fail and ask to retry; only queue non-critical telemetry, encrypted.

## 10. How we verify security and performance (not just claim it)

- SAST on our code and on generated code; DAST against staging; dependency + container + secret scanning in CI; block on critical findings.
- Authorization tests: automated tests that a user cannot access another user's objects (IDOR regression suite).
- Load and soak tests with p95/p99 assertions; performance regression benchmarks in CI.
- The `no-mistakes` gate runs the review/test/lint pipeline on every change; security and performance are review checklist items, not afterthoughts.
- Periodic threat-model review per new feature; incident post-mortems are blameless and produce tracked action items.

## 11. Per-change checklist (security + performance)

- [ ] Server-side authN and authZ on every new endpoint, including per-object (IDOR) checks.
- [ ] All external input (client, file, API, model output, web content) validated at the boundary.
- [ ] No secrets/PII in code, logs, errors, prompts, or traces.
- [ ] Parameterized queries; no string-built SQL/shell; no `eval` of model output.
- [ ] Generated code runs only in a sandbox; side-effectful tools gated + idempotent.
- [ ] Dependencies pinned; no new critical CVEs; new deps reviewed.
- [ ] Errors sanitized to the client; failure paths handled explicitly (fail safe).
- [ ] Endpoints paginated/bounded; queries indexed; no N+1; p95/p99 measured on hot paths.
- [ ] Long operations streamed + cancellable (AbortController) + resumable.
- [ ] Rate limits and budget caps in place (requests, tokens, spend, time).

## Sources
- OWASP Top 10:2025 - https://owasp.org/Top10/2025/0x00_2025-Introduction/
- OWASP API Security Top 10:2023 (BOLA/IDOR) - https://owasp.org/API-Security/editions/2023/en/0xa1-broken-object-level-authorization/
- OWASP Top 10 for LLM Applications - https://genai.owasp.org/llm-top-10/
- Fixing slow API endpoints (p95/p99) - https://api.atatus.com/guides/fix-slow-api-endpoints/
- Cutting P99 latency in an authorization API - https://dzone.com/articles/cutting-p99-latency-policy-api
- Database optimization guide - https://middleware.io/blog/database-optimization/
- Team reference: `network-resilience` doc (idempotency, circuit breaker, abort, token refresh, role-based rendering).

External content was paraphrased and summarized per licensing compliance.
