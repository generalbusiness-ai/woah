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
7. **Object summary reads** — `/api/objects/:id/summary`
   (`fetchScopedObjectSummary`, `:1897`). PARTIAL: net uses `netFeed.cell` for
   live fields, but the summary path is not obviously `netMode()`-guarded at
   its callers (`:1537,1546,1620,1875`). **Needs per-call confirmation** that
   net mode never falls through to `/api/objects/*/summary`.

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

## Real bug found: stale `/api/state` deploy probe

`deploy.sh:331-340` probes `$WORKER_URL/api/state` and asserts the body "did
not return JSON" only — but **`/api/state` has no handler**, so it 404s with a
JSON error envelope that satisfies the check. The probe silently passes on a
dead route, and the cluster-route discovery at `:390` (which parses
`/api/state`'s objects) is therefore also dead. Fix independently of the
cutover: point the postflight at a real endpoint (`/healthz`, or a net cell/
relation read once net is selected) and rebuild the cluster-route check on a
live source. Not modified here — it is an operator script whose intended
probe target is the owner's call.

## Summary: what blocks removing v2

Removing v2 requires, for each GATES-item above, either a net port or an
explicit retirement decision:
- **Account lifecycle on net**: signup/onboarding + wizard-bootstrap claim
  have no net path — a fresh net world cannot self-serve new accounts or be
  wizard-claimed over net. This is the largest functional gap.
- **Agent provisioning**: `/connect` (Hermes) is v2-only.
- **Operator tooling**: taps + admin maintenance is v2-only.
- **Durable backfill**: `/log` replay has no client net contract.
- **UI reads**: ui-snapshot (cold-cache only) and the object-summary
  fall-through need confirmation/port.

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
