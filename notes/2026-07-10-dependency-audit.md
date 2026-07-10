# Dependency audit — risk acceptance (2026-07-10)

`npm audit --audit-level=high` reports **3 high-severity advisories, all
in `undici`**, reached transitively through the dev/test/deploy tooling:

```
undici  (WebSocket DoS, SOCKS5 pool reuse, keep-alive queue poisoning,
         SameSite downgrade, shared-cache whitespace bypass)
  └─ miniflare@4.x        (wrangler dev's local runtime)
       └─ wrangler@4.97.0 (devDependency)
```

## Why not fixed by upgrade (yet)

`npm audit fix --force` installs `wrangler@4.110.0`, whose first
undici-clean release **requires `@cloudflare/workers-types@^5`** — a
major bump from this repo's pinned `^4`. There is no v4-compatible
wrangler that resolves the undici chain (the audit marks everything
`4.75.0–4.101.0` vulnerable; the fix is `4.110.0`). Taking it now would
force a workers-types major across the whole Worker type surface as part
of a security-tooling patch — a change with its own regression risk,
deliberately kept out of the review-response batch.

## Why the risk is accepted for now

- **Not in the deployed Worker bundle.** undici is a Node HTTP client;
  the Cloudflare Workers runtime uses its own `fetch`. `wrangler` and
  `miniflare` run only in local dev (`wrangler dev`), the smoke/e2e
  lanes, and the deploy toolchain — never in production request handling.
- **No untrusted network input to the vulnerable paths in our use.**
  The advisories are exploited by a malicious *server/proxy* an undici
  client talks to (WS fragment counts, SOCKS5 proxies, keep-alive
  response poisoning, cache/cookie parsing). Our tooling talks to
  `localhost` workerd and the operator's own Cloudflare endpoints, not
  attacker-controlled hosts.

## The plan

Bundle the `wrangler@4.110.0` + `@cloudflare/workers-types@^5` upgrade as
its own change (typecheck both tsconfigs, run the worker + smoke lanes),
NOT folded into a cutover-hardening batch. Re-audit after; this
acceptance is provisional until then. Tracked here so the audit result
is a decision, not a silent skip.
