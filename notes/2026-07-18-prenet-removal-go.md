# Pre-Net removal — go decision

Date: 2026-07-18. Status: authorized to remove the classic/v2 stack, gated by
the NC9 operational sequence (this note does not authorize deploy or class
deletion). Builds on `notes/2026-07-17-pre-net-stack-retirement-plan.md` and the
NC9 order in `spec/operations/net-cutover.md`.

## Decisions taken

1. **Residual MCP capabilities: `list_changed` PORTED; `focus`/`unfocus` and inline
   fields RETIRED.** Net MCP carries dynamic context tools + schema-rich discovery
   (a9b9288) and concurrent stdio (4b4665a).
   - `notifications/tools/list_changed` — **implemented** on Net (branch
     net-mcp-list-changed, 942f05c + 4253945): `listChanged: true` with an
     authenticated Streamable-HTTP GET/SSE carrier, per-session coalesced hints,
     stdio-bridge forwarding. Reviewed security-clean. So `tests/mcp.test.ts`'s
     list-changed contract has a Net equivalent (`net-mcp.test.ts`), not a retirement.
   - `woo_focus` / `woo_unfocus` — RETIRED; no Net equivalent (the dynamic
     context-tool set already tracks the actor's space/objects/inventory).
   - Classic inline `observations` / `applied` result fields on tool calls — RETIRED.
   Consequence: the classic MCP host (`src/mcp/server.ts`, `src/mcp/gateway.ts`)
   and the focus/unfocus + inline-field assertions in `tests/mcp.test.ts` /
   `mcp-warm-authority` become deletable — those specific contracts are retired.

2. **v2 rollback is renounced.** NC6's rollback contract is given up. This clears
   the NC9 precondition ("rollback to the v2 stack formally renounced"). The
   `dev:classic` / `mcp:stdio:classic` commands and the `/api/*`, `/connect`,
   `/v2/*` rollback routes are no longer contractually retained; they are removed
   as part of this work, not kept for a bake.

## Deletion set and order

Two waves, because the classic path is not monolithic. `CommitScopeDO` is a clean
wholesale replacement; `PersistentObjectDO` + `DirectoryDO` also host auth and
Directory routing, gated on confirming Net owns those (investigation in flight).

- **Code (reversible, this worktree):** classic client paths (`v2-browser-*`,
  `/api/me` ingest, scoped-projection), classic dev/stdio hosts (`dev-server.ts`,
  `mcp/stdio.ts`, `mcp/gateway.ts`, `mcp/server.ts`, `shadow-browser-node.ts`,
  `dev-v2-helpers`, `sqlite-repository`/`json-folder-repository` if dev-only),
  the dual-stack `src/worker/index.ts` classic routing, and `commit-scope-do.ts`.
  Switch deployed entry to `src/worker/net-only-index.ts`. Delete the
  `test:classic` / `test:worker:classic` files whose contract the matrix marks
  covered-or-retired. Keep `src/core` substrate and the signed-HTTP internal
  surface + `WOO_INTERNAL_SECRET` (Net uses it).

- **Operational (NOT in this worktree — operator, irreversible):** per-class
  zero-traffic bake via AE, code-removal deploy + re-run gate, verified restorable
  backup, then `deleted_classes` wrangler migration one class per deploy —
  `CommitScopeDO` first, then `PersistentObjectDO`/`DirectoryDO` once their auth/
  Directory consumers are confirmed zero.

## Guardrails

- `src/core` (WooWorld, Tiny VM, DSL, ~80 substrate tests) STAYS.
- Signed-HTTP internal surface + `WOO_INTERNAL_SECRET` STAY (Net signs every
  gateway→DO hop).
- No merge to main, no deploy, no `deleted_classes` run from this worktree.
