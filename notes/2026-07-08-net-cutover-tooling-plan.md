# Net cutover tooling (plan §8 Phase 5 — the build before the op)

Date: 2026-07-08. Branch `net-cutover` (from main `084488f`, the first
net-path prod deploy `1822b220`). The net path is live as the PARALLEL
surface with a fresh empty namespace; this plan builds the tooling the
ratified §8 cutover protocol needs. The CUTOVER ITSELF (maintenance
window, freeze, route switch) remains an owner-run operation — nothing
here moves traffic.

Protocol source: notes/2026-07-04-simplest-system-plan.md "Phase 5 —
Deploy, prove, delete" (owner-approved 2026-07-05).

## D — named "not installed" verdict (rough edge from the deploy)

An authenticated /net-api request against the unseeded catalog scope
today surfaces as `500 E_INTERNAL` wrapping the scope's named
`E_MISSING_STATE has_meta:false`. Clients (and the cutover's own
verification probes) need a legible verdict: a named "world not
installed" refusal with a 503 shape. Smallest honest change in
`catalogIdentity`'s pull-failure path.

## A — install/seed pipeline (`scripts/net-install.ts`)

Install the world from catalogs into the net namespace — the same path
any environment uses (dev lane first, prod at cutover):

1. Build the world in-process: `createWorld()` (bundled catalogs via the
   boot snapshot) + `installLocalCatalogs(world, parseAutoInstallCatalogs)`
   to match the deployed catalog set.
2. Optional identity injection (item B's import) BEFORE export, so the
   carried actors/api_keys partition and seed like any other world state
   — no second seed pass, no ref rewriting.
3. `cellsFromSerialized(world.exportWorld())` → `partitionCells` (CO15)
   → one signed `/net/seed` per scope through the `/net-smoke/scope/...`
   doorway (H1b: internal-signed, works against wrangler dev AND the
   deployed worker; the doorway name is historical — it is the generic
   signed net-DO conduit).
4. Catalog epoch: one epoch stamp for the whole install (the M9 seed
   guard makes re-seeding at the same epoch a no-op-shaped success —
   idempotent per the migration rule; a DIFFERENT epoch refuses).
5. Post-install verification (abort on failure, per the import rule):
   every seeded scope answers `/net/head` at the install epoch; when an
   identity import rode along, a carried apikey MUST mint a session
   through the real `/net-api/session` surface.

Provable on the dev lane (`wrangler dev` via wrangler.smoke.toml) as a
vitest/smoke addition; the prod run is step 2 of the cutover op.

## B — identity export/import

Export schema (`identity-export.json`, exactly the §8-approved shape):
- `api_keys`: the `$system.api_keys` map verbatim (hashed records).
- `actors`: the reachable identity actor graph — every `$account`
  instance and every `$actor` descendant referenced by an apikey record
  or an account binding. Per object: original id (preserved), parent
  CLASS NAME (resolved against fresh catalogs at import), owner, flags,
  and a CLOSED allow-list of identity properties (name, account,
  created_via, profile_id, password/verifier props, last_seen_at).
- Bearer tokens dropped by design (60-min TTL).

Export source: a new internal-signed v2 route (`/__internal/identity-export`)
— rides the SAME v2-side deploy as item C's freeze (one pre-cutover v2
deploy, per the protocol's "final identity-export from FROZEN old prod").
Import: `importIdentity(world, export)` re-creates actors with preserved
ids against the freshly installed catalogs, then writes api_keys;
verification: every `api_keys[*].actor` resolves to a live `$actor`
descendant and every account binding resolves — dangling refs ABORT.
Idempotent; vitest coverage (export→fresh-install→import→verify→
authenticate round-trip, in-process).

## C — write-freeze

Flag-gated (env var read per-request, settable via `wrangler secret` /
vars without code change — no redeploy to freeze/unfreeze beyond the
flag flip): mutating turns and identity operations (mint/rotate/register)
refuse with a named maintenance error; reads continue. Same v2 deploy as
the export route.

## Order

D (small, unblocks legible verification) → A (dev-lane proven) →
B (in-process proven; the export route + C ride one v2 change) →
then the OWNER's cutover op: freeze → export → install+import to prod
net namespace → §8 steps 3-7 (prove, route switch, postflight, bake,
rollback rule, deletions).

## STATUS (2026-07-08)

**D COMPLETE**: unseeded-namespace requests refuse 503 `E_NOT_INSTALLED`
(reason: not_installed); any other catalog-pull failure stays E_INTERNAL.

**A + B (library/scripts) COMPLETE, dev-lane proven 4/4 over real
workerd** (`npm run install:net-dev`): identity export from an old world
→ `runNetInstall` seeds the FULL bundled world (20 scopes — the real
prod rooms) through the signed `/net-install` doorway → heads verified at
the fingerprint epoch (`cat-<bundle-fingerprint>`) → idempotent re-run
(same epoch, no-op-shaped) → carried apikey mints via `/net-api/session`
→ a real turn commits through inherited catalog dispatch (`title` on
the_chatroom → "Living Room"). Pieces: `src/net/install.ts`
(planNetInstall; guard-allow-listed as a lifecycle surface),
`src/net/identity.ts` (§8 export schema + import + abort-on-dangling
verification), `scripts/net-install.ts` (the operator CLI),
`scripts/net-install-dev.ts` (the workerd proof), `/net-install` worker
doorway (signature-gated, NOT dataset-gated — the production conduit;
allow-listed to seed+head only). In-process proofs:
tests/net/identity.test.ts (round-trip: an OLD key authenticates in the
NEW world; dangling refs abort) + tests/worker/net-install.test.ts.

Decisions/discoveries recorded while building:
- **`email` added to the §8 prop allow-list** (deliberate deviation,
  flagged): account lookup for password login is BY email; a carried
  account without it could never log in — defeating §8's own "humans
  re-authenticate by password".
- **Preserved-id collisions are real**: the boot snapshot ships stock
  actors (guest_1 sits at $nowhere in a fresh world). Import ADOPTS a
  same-class existing id (identity props overwrite; §8 rehome applies
  only when it sits nowhere) and ABORTS on a class mismatch.
- **Rehoming = `$system.guest_initial_room`** (the same catalog
  convention that places fresh guests); `world.moveObject` made public
  for exactly this one out-of-band consumer (documented at the method).
- **"Native verbs don't dispatch over net" — RETRACTED after
  investigation** (the actual cause was a bad probe target). The failing
  probe called `look` ON THE ACTOR (`guest_1:look`) — a verb NO world
  defines: it fails E_VERBNF identically on a full v2 world. `look` is a
  room-resolved command. Native seed-graph verbs are ordinary VerbDefs
  (handler ref, no program) and `cellsFromSerialized` ships EVERY
  VerbDef, so they ride as verb_bytecode cells and dispatch over the net
  planner fine — proven in-process: `the_chatroom:look`,
  `the_chatroom:say`, and the NATIVE `$system:list_api_keys` all commit
  accepted against the installed world, and the dev lane now runs `look`
  + `say` on the room over real workerd (5/5). Left standing from the
  same investigation: the net client surface takes {target, verb} — the
  bare-word COMMAND PARSE ("look" → room:look) is client/superstructure
  work the cutover's client shell must own (v2's parser does it today).

**B (route) + C COMPLETE (2026-07-09):** the one v2-side change.
- Export: `GET /net-install/identity-export` (signed, edge doorway) →
  freshly-signed forward to the world host's
  `POST /__internal/identity-export` → `exportIdentity(world.exportWorld())`.
  Operator CLI: `scripts/identity-export.ts` (shape-checks before
  writing the file).
- Freeze: `WOO_WRITE_FREEZE` (any non-empty value; vars/secret flip, no
  code deploy) enforced at BOTH the edge and the DO (defense in depth —
  a request reaching a host by any path still refuses), plus the WS
  frame handler (sockets accepted before the flip would otherwise keep
  mutating; frames refuse with the named error, the socket survives).
  Named verdict: 503 `E_MAINTENANCE {frozen:true}`. GET reads continue;
  WS upgrade + session mint refuse even as GETs; internal-signed routes
  stay open (the export runs against the FROZEN world — the §8
  sequence); /net-api + /net-install + /admin are never frozen (the NEW
  namespace must stay usable during the window).
- Tests (deploy-gated in curated npm test):
  tests/worker/net-cutover-freeze.test.ts — frozen mutations 503,
  reads 200, signed export 200 under freeze, unsigned 401, unfrozen
  normal. Gates: npm test 782; worker 383; smoke:cf-dev 13/13 (v2
  walkthrough — freeze inert when unfrozen); smoke:net-dev 24/24;
  install:net-dev 5/5; load 3/3.

## The cutover runbook (§8 steps → commands)

Owner-run, in order; every step idempotent or read-only unless marked.

0. **Pre-deploy**: merge `net-cutover`; `./scripts/deploy.sh` (ships the
   export route + freeze flag support + install doorway). Verify the
   walkthrough gate as usual.
1. **Announce the window. Freeze old prod**:
   `npx wrangler secret put WOO_WRITE_FREEZE` (value `1`) — or a vars
   deploy. Probe: POST /api/auth → 503 E_MAINTENANCE; GET /healthz →
   200.
2. **Final export from frozen prod**:
   `WOO_INTERNAL_SECRET=... npx tsx scripts/identity-export.ts
   --base-url https://woah1.generalbusiness.ai --out identity-export.json`
3. **Install into the net namespace + verify** (idempotent; abort =
   re-run): `WOO_INTERNAL_SECRET=... npx tsx scripts/net-install.ts
   --base-url https://woah1.generalbusiness.ai
   --identity identity-export.json
   --verify-apikey apikey:<id>:<secret>`
   (the mint probe is §8 step 3's auth check; add a carried-account
   password login check when the client shell lands).
4. **Route switch**: move the public hostname to the net-serving client
   — DNS/route change, NEVER a 308 (WS clients cannot follow redirects;
   the woah→woah1 incident). [Requires the net client shell — the
   remaining build item.]
5. **Postflight + bake**: deployed walkthrough + tail thresholds; old
   prod stays deployed AND FROZEN through the bake. Rollback = switch
   the route back + delete WOO_WRITE_FREEZE — nothing else.
6. **After the bake**: retire old prod; the §8 deletion commits.

REMAINING build item before step 4 can run: the net CLIENT SHELL — the
last piece between "namespace proven" and "traffic routed". Steps 0–3
are executable today.

## The client shell, scoped (2026-07-09 — grounded, not guessed)

**Foundation PROVEN and pinned** (tests/worker/net-install.test.ts):
the REAL v2 command parser runs over the net planner with ZERO new
engine machinery. The chat catalog's `$space:command_plan(text)` wraps
the `plan_command` native; over `/net-api` against the installed world
it returns executable plans for the whole vocabulary — bare verbs
(`look` → {target: room, verb: look}), speech (`say hello there` →
{verb: say, args: ["hello there"]}), rosters (`who`), and OBJECT
MATCHING against the room's contents in the slice (`look lamp` →
{verb: look_at, args: [the_lamp]}; `take mug` → persistence: durable).
The earlier "look at the fireplace" huh was an absent object, not a
gap. A thin client is therefore: `command_plan(text)` turn → execute
the returned plan — the SAME plan-then-dispatch discipline the v2
browser already follows (guard-command-planning).

STATUS (2026-07-09): **PHASES i AND ii COMPLETE.**
- Phase i @ 6d9223c: /net-api/mcp adapter; THE walkthrough scenario
  passes over the net path 10/10 on real workerd (`smoke:net-mcp`) —
  six root-caused fixes (creates counter + collision guard; objects-mode
  refresh; room-addressed observations riding the presence relate;
  to:-directed audience filter; CO15 anchor normalization at install;
  same-turn-created foreign reads bypass attestation) + the roster
  footprint (CellStore location index; members seeded minimally).
- Phase ii @ b79479f: the REAL SPA runs over the net path, flag-gated
  (?net=1 + localStorage woo:net:apikey): NetFeed → the same
  receiveLiveEvent dispatcher; command box → command_plan →
  plan-execute; room anchor from the actor's live cell + own movement
  observations; e2e/net-spa.spec.ts proves alice→bob chat in real
  browsers against the real bundle. v2 byte-identical flag-off
  (smoke:cf-dev 13/13).
REMAINING before the §8 route switch: the PUBLIC identity door over net
(guest entry + account/password login — today only apikeys
authenticate, which covers agents/plugs and the bake, not anonymous
humans); tool-space UIs over net (pinboard/outliner/tasks panels render
from v2 projections — phase iii); then the walkthrough-parity +
route-switch steps.

Phases, smallest-risk order:
1. **MCP adapter over /net-api** — the agent/plug surface AND the §8
   "prove" instrument (the deployed walkthrough is MCP). Re-back the
   MCP tool set (command/look/state) with /net-api session+turn+reads.
   Exit gate: the smoke walkthrough scenario passes against the net
   path end-to-end.
2. **Browser: chat-first transport flip** — NetFeed +
   net-feed-adapter (already built, e2e-proven) drive main.ts's chat
   loop (command box → command_plan → turn; observations → chat panel).
   Tool-space UIs (pinboard/outliner/tasks) follow on the framework
   adapter; the flip is per-surface, flag-gated, so the SPA can ship
   dual-transport during the bake.
3. **Walkthrough parity gate — MET (2026-07-09).** `smoke:net-mcp` now
   runs the IDENTICAL 13-step flag configuration as the v2 workerd lane
   (`smoke:cf-dev`): takeDrop + concurrentMove (B6) + carryAcrossRooms
   (C3) + toolSurfaceAfterMove (C3). Both lanes 13/13, fully enforced —
   one scenario, two transports, same steps, same green. The C3 gates
   passed on net FIRST RUN with no additional work (lineage-closed
   transfers are the net layer's construction, not a repair). Remaining
   before the §8 route switch (step 4): the PUBLIC identity door over
   net (guest entry + account/password login) and the phase-iii
   tool-space browser panels.
