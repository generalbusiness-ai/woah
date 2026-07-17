# Classic-to-Net test contract matrix

Date: 2026-07-17. Status: active NC9 deletion-readiness record.

This matrix classifies behavior, not filenames or imports. Moving a test out of
the fast default gate does not retire its contract: classic-only tests remain in
`npm run test:classic` while rollback is supported, and `npm run test:full`
continues to discover both stacks. A classic implementation or test may be
deleted only after the corresponding row is **covered** or explicitly
**retired**, and after NC9's independent zero-traffic/backup/class-deletion
gates.

## Matrix

| Classic tests / subsystem | Contract protected | Net replacement evidence | Lane | Decision |
| --- | --- | --- | --- | --- |
| `executor`, `planning-world`, `command-utils`, `turn-recorder`, `movement-projection`, `conformance` | Object/VM/DSL execution, planning, moves, audience, transcript semantics | The same `src/core` code is invoked by Net planning; differential and worker Net tests add distributed coverage | `npm test` | **Keep unchanged.** These are substrate tests, not classic-stack tests. |
| `persistence.test.ts`, `object-host-write-through.test.ts` | Local SQLite/JSON repository durability and write-through | Local SQLite remains a supported non-Net host mode; Net durability is separately covered by `net/scope-store` and `worker/net-do` | `npm test` for repository semantics; classic lane for host-specific seams | **Keep repository coverage.** Do not confuse supported local persistence with the retired transport. |
| `v2-browser-journal`, `v2-browser-local-turn`, `v2-browser-worker.integration`, `v2-browser-intent-policy`, `v2-browser-holder-install`, `v2-browser-cache`, `v2-browser-execution-cache` | Browser-side VM planning, tentative journal, executable transfer/capsule cache, accepted-frame reconciliation, reconnect | `client/net-feed.test.ts` covers authoritative submission, echo overlay, same-key REST fallback, replay, reconnect, session re-mint, and cross-scope dedupe; `client/net-feed-adapter.test.ts` covers reducer parity; `e2e:net` is the real-browser path | `test:classic`; Net evidence in `npm test` + `e2e:net` | **Retire mechanism, preserve outcomes.** Net intentionally has no browser VM, tentative execution chain, or executable-transfer cache. Those exact mechanism assertions disappear only with the v2 client. |
| `shadow-browser-node`, `shadow-commit-scope`, `shadow-relay-cache`, `shadow-turn-exec`, `v2-state-transfer-warmfill`, `v2-capability-gossip-routing`, `v2-browser-delegation` | v2 relay/cache authority, state transfer proofs, commit-scope selection, executor gossip/delegation | Net scope ownership and conflict rules: `net/scope`, `net/scope-store`, `worker/net-do`, `worker/net-topology-turn`, `worker/net-turn-structure`; durable delivery: `worker/net-scope-fanout`, `worker/net-outbox-bounded` | `test:classic`; Net evidence in default/worker lanes | **Retire v2 mechanisms.** Net does not route by executor gossip or accept browser-signed execution capsules. Keep classic tests until rollback ends. |
| `dev-v2-durable-turn-parity`, `dev-v2-fanout`, `dev-v2-commit`, `v2-fanout-projection`, `v2-reply-predicates`, `v2-turn-network-spec` | Local dev parity with CF commit/reply/fanout, cross-room audience, SQLite restart, v2 wire predicates | Default `npm run dev` now runs the Net-only Worker under workerd; `worker/net-do`, `worker/net-scope-fanout`, `worker/net-ws`, `client/net-feed`, `smoke:net-dev`, and the stdio smoke exercise the replacement path | `test:classic`; Net fake-DO + workerd | **Covered for Net outcomes; classic wire retired.** Keep rollback tests until NC9. |
| `session-lifecycle.test.ts` and classic Directory/session cases | Close/reap, bounded session count, stale sessions excluded from movement/location | `net/sessions`, `net/client-session-policy`, `worker/net-session-reap`, `worker/net-client-api`, `client/net-feed` re-mint/close/reconnect | `test:classic`; Net default/worker | **Covered.** Net session cells and presence rows replace classic socket/Directory attachment state; the storage shapes are intentionally different. |
| `mcp.test.ts`, `mcp-warm-authority`, `smoke/v2-mcp-smoke`, `v2-mcp-e2e` | MCP handshake/session, tool discovery and schemas, direct/sequenced calls, focus, dynamic list-change, observations, HTTP transport | `worker/net-mcp.test.ts` covers initialize, SDK-valid `tools/list`, carried actor discovery, call/error envelopes, command planning, cross-actor wait, movement, take/drop, and close; `net-stdio-proxy` unit tests plus `smoke:mcp:stdio` cover the real SDK over workerd/stdio | Net default + worker + workerd; classic rollback | **Partially covered; deletion blocked.** Net still lacks dynamic named tools, `woo_focus`/`woo_unfocus`, schema-rich paging/filtering, `notifications/tools/list_changed`, and classic inline `observations`/`applied` result fields. |
| `scope-executor-garden-probe`, `a2-fanout-lineage-closure`, `b-i-read-closure-parity`, `b-iii-incremental-merge`, classic portions of `worker/rpc-fault-inject` and `worker/cf-local-structural` | v2 sparse repair, authority slices, reconstruction, crash windows, tail delivery and structural budgets | Net repair/conflict/budget/fault coverage lives in `worker/net-gateway-repair`, `worker/net-turn-structure`, `worker/net-outbox-bounded`, `worker/net-scope-fanout`, and Net load/workerd lanes | classic rollback; Net worker/workerd | **Mechanism-specific tests remain rollback-only.** Port any user-visible guarantee found missing; do not port authority-slice vocabulary into Net. |
| `cf-do-migrations.test.ts`, classic Worker binding/route tests | Wrangler migration history and ability to address rollback DO classes | No replacement until class deletion; Net-only build proves the replacement bundle excludes classic classes | `npm test`, deploy preflight | **Keep through deletion migration.** This is an operator safety gate, not stale behavior coverage. |

## Default-lane policy

`npm test` is Net-first: shared substrate/repository tests plus client Net,
protocol Net, fake-DO Net, guards, and operator migration checks. Tests whose
subject is the v2 browser, shadow relay, CommitScope transport, classic MCP
host, or classic session lifecycle run under `npm run test:classic` instead.
`npm run test:full` remains the explicit all-files sweep.

The slower Worker gates are also explicit: `npm run test:worker` is Net-first,
`npm run test:worker:classic` retains classic DO/MCP rollback coverage, and
`npm run test:worker:all` is the deliberate combined sweep. Passing the
combined lane is not evidence that a classic contract has a Net replacement;
the named replacement column above is the evidence.

## Open deletion blockers discovered by the matrix

1. **Full MCP discovery/control parity.** Net's three stable envelope tools are
   sufficient for current browser-independent agent loops but do not satisfy
   the implemented MCP specification's dynamic-tool and focus contracts.
2. **Default-localdev browser coverage.** The existing `e2e:net` lane targets a
   configured Net Worker. Add and run a first-run/install/persisted-restart
   scenario against `npm run dev`; HTTP, SDK stdio, fake-DO, and workerd
   results do not substitute for a real browser.

## Next port order

1. Implement Net MCP focus/unfocus and schema-rich discovery, then dynamic
   named tools/list-change if the protocol remains normative; port the exact
   `mcp.test.ts` cases as each contract lands.
2. Run `e2e:net` against the new default local composition and add a dedicated
   first-run/install/persisted-restart browser scenario.
3. Only after the NC9 traffic and backup gates, delete v2 client/host/DO tests
   in the same commits that delete their implementations.
