# v2 compatibility inventory (net-cutover gate #4)

Date: 2026-07-12. Answers "which callers still require the v2 surface
(`/api/*`, `/connect`, `/v2/*`) after public net selection?" — the inventory
that gates freezing/removing the v2 legacy implementations.

## Corrected framing (verified in-tree)

- **`WOO_NET_DEFAULT` selection exists.** `src/worker/index.ts:43`
  `netDefaultEnabled` (true only for `1`/`true`/`on`, else v2). When set: the
  browser `/config` returns `net:true` (`:102`) and public `/mcp` is rewritten
  to `/net-api/mcp` (`:197`). It is a same-Worker selector, not DNS.
- **The browser partially switches.** `main.ts` gates on `netMode()`
  (`:585`): in net mode it uses `NetFeed` for turns/observations/cell reads/
  session (`openNetFeed`/`connectNetFeed`, `:663`), skips the v2 boot snapshot
  (`:1647 if (netMode()) return`), routes logout through `netFeed.closeSession`
  (`:1335`), and tracks the room via net (`:2577`). So the agent claim
  "browser is 100% v2 / NetFeed unused" is **false**.
- **Net client surface = 9 endpoints** (`gateway-do.ts`): `/net-api/guest`,
  `/net-api/login` (email/password — `:1861`), `/net-api/session` (apikey),
  `/net-api/turn`, `/net-api/cell`, `/net-api/relation`, `/net-api/ws` +
  `/net-api/ws-ticket`, `/net-api/mcp` (+ DELETE close). So net auth is guest
  **and** password **and** apikey — not "apikey-only".

## Classification

**MAPPED — net equivalent exists and the browser/MCP switch to it:**
- Turn submission / verb calls → `/net-api/turn` (browser via NetFeed;
  public `/mcp` → `/net-api/mcp`).
- Live observations / WS → `/net-api/ws` (+ ticket).
- Cell reads (e.g. live location `object_live:<actor>`) → `/net-api/cell`.
- Session mint / login / logout → `/net-api/{guest,login,session}` + DELETE.
- Relation reads → `/net-api/relation`.

**GATES v2 REMOVAL — no net equivalent; a caller depends on it (must migrate
or be explicitly retired before freeze):**
1. **Signup / onboarding** — `/api/signup`, `/api/signup/verify` + Turnstile
   (`protocol.ts:82-99`, `verifyTurnstile`). Account *creation* has no net
   path. Callers: signup UI, `scripts/smoke-onboarding.ts`, `tests/onboarding`.
2. **`/connect` + `/api/connect`** — Hermes agent provisioning + signup-return
   redirect (`protocol.ts:108/117`, `connectHermes`). No net path.
3. **Wizard first-boot claim** — `WOO_INITIAL_WIZARD_TOKEN` flows only through
   `/api/auth` `wizard:` (`claimWizardBootstrapSession`). Net login is
   password/apikey/guest, **not** wizard-token — a fresh net namespace cannot
   be wizard-claimed over net today. DEPLOY.md:243.
4. **Operator surfaces** — `/api/tap/{install,update}`, `/api/taps` (catalog
   management), `/api/admin/{refresh-host-seeds,force-rebuild-host,
   repair-derived-contents,purge-inactive-guests}`. No net equivalents;
   DEPLOY.md documents them as the maintenance path.
5. **Sequenced `/log` replay** — `/api/objects/:id/log` (`protocol.ts:299`),
   durable backfill. `/net/pull`/`/net/head` are *internal* `/net/*`, not a
   client `/net-api/*` contract.
6. **UI reads** — `/api/objects/:id/ui-snapshot` has **no** net path (main.ts
   comment `:1715` "net mode has no /api ui-snapshot" — it falls back to a
   localStorage cold cache). `/api/catalogs/ui` (third-party catalog UI) has
   only partial net handling (`:1721`).
7. **Object summary reads — CLOSED 2026-07-12.** Net mode now builds bounded
   summaries from exact presence-authorized `object_lineage`, `object_live`,
   and component-declared `property_cell` reads. The net browser e2e records
   every request and fails if `/api/*`, `/v2/*`, or `/connect` is touched; all
   six browser scenarios pass with zero legacy requests.

**RETIRE-WITH-v2 (only tests/dev/legacy use them):**
- `/api/objects/:id/stream` — already returns 410 GONE.
- `/api/state` — **no handler exists** (returns 404). See the deploy.sh bug
  below.
- `/v2/session/mint` — only `tests/worker/cf-repository.test.ts` found.
- `/api/browser-metrics` — browser telemetry only.
- `/api/catalogs`, `/api/object`, `/api/objects/:id` (bare describe) — no
  `src/client` caller; verify no external/CLI user before retiring.
- `/v2/open`, `/v2/envelope`, `/v2/state-transfer` — INTERNAL gateway→
  CommitScopeDO RPC (not a public contract); retire with the v2 substrate.

## The `/v2/turn-network/ws` case

The browser live WS is `/v2/turn-network/ws` in v2; net mode uses
`/net-api/ws` (+ ticket) instead — MAPPED for the browser. But `deploy.sh:421`
and any external live client on `/v2/turn-network/ws` must move to the net WS.

## Stale `/api/state` deploy probe — FIXED 2026-07-12

Postflight now requires HTTP 200 from the real `/api/me` browser projection,
validates `session.actor`, and derives bounded warm/cluster-route targets from
its scoped self/inventory/here projection. A regression test forbids the dead
route and global `state.objects` enumeration.

## Executable deletion boundary

`npm run build:net-only` is the structural removal gate. It:

- builds the SPA with the v2 browser-worker factory replaced at compile time
  and fails if a v2 worker asset or transport marker remains;
- dry-runs `src/worker/net-only-index.ts`, which exports only `NetScopeDO` and
  `NetGatewayDO` and explicitly returns 410 for `/api/*`, `/v2/*`, `/connect`,
  and the post-cutover v2 identity/freeze doorway;
- probes health through the catalog NetScopeDO rather than a legacy world DO,
  and reports healthy only when the authority's activation cell matches the
  catalog epoch (a merely seeded or mixed-epoch namespace fails closed).

This proves the large v2 client worker and server DO implementations are not
bundle dependencies of the replacement surface. It does not yet authorize
production removal: the remaining functional gates below still need ports or
explicit retirement decisions.

## Summary: what blocks removing v2

Removing v2 requires, for each GATES-item above, either a net port or an
explicit retirement decision:
- **Account lifecycle on net**: signup/onboarding + wizard-bootstrap claim
  have no net path — a fresh net world cannot self-serve new accounts or be
  wizard-claimed over net. This is the largest functional gap.
- **Agent provisioning**: `/connect` (Hermes) is v2-only.
- **Operator tooling**: taps + admin maintenance is v2-only.
- **Durable backfill**: `/log` replay has no client net contract.
- **UI reads**: bundled net panels have direct authoritative hydrators and
  object-summary fall-through is closed; dynamic third-party catalog UI
  discovery still needs a net contract or an explicit retirement decision.

Apikey agents are the good case: net verifies against the *same*
`property_cell:$system:api_keys` with the same salt/hash as core
(`src/worker/net/client-auth.ts`), so an existing agent key works on both
surfaces. Public `/mcp` agents move transparently via the `WOO_NET_DEFAULT`
`/mcp`→`/net-api/mcp` rewrite.

**Recommendation:** treat the GATES list as the v2-removal backlog. Public net
*selection* (browser + MCP) can ship with v2 *frozen-but-present* (the current
dual-stack model); v2 *removal* waits until each GATES item is ported or its
callers are confirmed retired. The account-lifecycle gap (signup + wizard
claim) is the first to resolve since it blocks a net-only world from
onboarding anyone.
