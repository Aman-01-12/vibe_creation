# Reliability, Self-Healing & the Action Recorder

## Standing dev principle
For every tool/harness/agent we build: **study a proven implementation first, then build the
comprehensive version** (failure paths, retries, timeouts, self-diagnosis) — never happy-path only.
The failure handling IS the product. Reference established architectures + reason from them.

## Action Recorder (trace layer)
Record every step as a structured span: tool, inputs, outputs, exit code, stdout/stderr, timing,
retry #, token cost. The full session = a **replayable trace**. (LLM spans à la Langfuse/OpenTelemetry
+ tool-execution spans.)

## Self-Healing loop (ref: "Self-Healing Agentic Orchestrators," arXiv 2606.01416)
detect failure signal → **classify** failure (syntax err / sim timeout / tool crash / malformed LLM
output) → **select targeted recovery** (fix-retry / backoff / fallback model / re-plan / escalate)
→ **under explicit budget** (max iterations, tokens, time) → **verify** via the oracle → **record** trajectory.
Budget caps prevent the "burn 50k tokens looping on a malformed response" failure.

## Reliability primitives (per tool)
- Per-tool **timeouts** (not per-system).
- **Retries with backoff**, **circuit breakers**, **budget caps**.
- **Approval gates** before irreversible actions.
- **Checkpoints / durable state** so a crash mid-run doesn't lose progress.

## Idempotency (critical)
Classify tools by side-effect (the "uncertain" third state on timeout is the danger):
- **Pure/idempotent** — compile, simulate, lint, synthesize → retry freely.
- **Side-effectful** — Tiny Tapeout submit, PCB order, payments → **idempotency keys + approval gate + no blind retry on timeout** (tool may have already fired the effect).

## Uses of the recorder (one layer, four wins)
1. **Runtime self-healing** — agent reads trace to diagnose + recover.
2. **Our debugging** — deterministic replay of an incident (record/replay, turned inward).
3. **Eval/regression** — golden traces in CI catch regressions.
4. **Teaching** — optionally show the student "what failed & how it was fixed."

## Reference reading
- Self-Healing Agentic Orchestrators (arXiv 2606.01416) — detect→classify→recover→verify→record.
- Harness Engineering / Agent Runtime Layer (agentic-architectures series).
- Reliable Tool-Using Agents: state classification, idempotency keys, per-tool timeouts, approval gates (adaline).
- Idempotency in agentic tool calling / "sends the email twice" (tianpan) — the uncertain-state problem.
- Fault-tolerant agent flows: checkpoints, idempotency, retries, approvals, observability (breyta).
- Agentic workflow resilience audit (bounded execution, compensating actions, replayable trace).

## Full circle
The record-and-replay product we explored early becomes our **internal reliability + self-healing + debugging + teaching** layer.
