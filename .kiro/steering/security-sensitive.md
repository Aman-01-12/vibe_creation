---
inclusion: fileMatch
fileMatchPattern: '**/*{api,route,router,auth,login,signup,session,token,cookie,cors,server,db,database,sql,query,orm,model,tool,runner,network,middleware,handler,payment,billing,checkout,upload,file,user,account,admin,permission,role,crypto,secret,webhook,sandbox}*'
---

# Security / performance / resilience (auto-loaded on sensitive surfaces)

You are editing a security-, data-, or network-sensitive surface. Apply `product-ece/ECE-SECURITY-PERFORMANCE-RESILIENCE.md` in full; read it now if you have not this session.

Enforced highlights:
- Server-side authN + per-object authZ (IDOR/BOLA) on every endpoint; never trust client/UI/model output as a control.
- Parameterized queries only; no string-built SQL/shell; validate every input; whitelist writable/returnable fields (no mass assignment).
- Secrets from the environment or a dedicated gitignored credential file, one source per credential and no fallback chain; never in code, logs, errors, prompts, or traces; sanitize errors to the client.
- Run agent-generated code only in a sandbox (isolated, no secrets, no default network, resource-capped).
- Performance: index filters/joins; no N+1, `SELECT *`, or OFFSET pagination (use keyset); measure p95/p99; bound/paginate lists; stream long agent runs (resumable).
- Resilience: idempotency keys + approval gate for side-effectful actions; 3-state circuit breaker with backoff+jitter; AbortController lifecycle cleanup; transparent 401 token refresh; role-based (not connectivity-based) rendering.
