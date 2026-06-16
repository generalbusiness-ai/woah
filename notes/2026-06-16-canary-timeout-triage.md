# Canary Timeout Triage

Date: 2026-06-16
Run reviewed: `woah-canary` 27584452208
Head: `a873063`
Status: timeout budget fixed locally; performance debt remains

## Evidence

Latest scheduled canary on `main` failed in the deployed MCP smoke job:

- `tests/smoke/v2-mcp-smoke.test.ts:25` timed out at Vitest's default 30s
  budget.
- `tests/smoke/v2-mcp-smoke.test.ts:70` also timed out at the same default
  budget.
- Three other MCP smoke tests passed; browser smoke was skipped because the MCP
  job failed first.

Local deployed reproduction against `https://woah.generalbusiness.ai` after a
clean install passed all five MCP smoke tests, but it was close enough to the
old budget to explain the canary flake:

```text
initializes/lists/tools/say/wait: 27849ms
bad credentials: 116ms
SSE list_changed: 15232ms
reconnect: 12942ms
total suite duration: 56.64s
```

The canary failure is therefore best classified as "deployed smoke budget too
tight for current live latency", not as proof that the tested MCP path is
permanently wedged. The latency is still high enough to stay a stabilization
target.

## Change Made

`tests/smoke/v2-mcp-smoke.test.ts` now gives deployed runs a 75s per-test
budget while leaving local in-process runs at 30s. The same helper also adds a
45s `/mcp` fetch timeout for deployed requests, so future failures should name
the stuck request rather than collapsing into a generic Vitest timeout.

## Remaining Work

This does not close the deployed stabilization work. The next state-path fix
still needs:

- E2 named divergence taxonomy, so live tails classify stale session, stale
  relation, stale lineage, and stale capsule-head failures explicitly.
- E3 aged-world validation, so the gateway/commit-scope state skew seen in
  deployed tails can be reproduced before deploying another narrow fix.
- Continued performance pressure on deployed MCP open/turn latency; a pass near
  30s is too close to the smoke guardrail to treat as healthy.
