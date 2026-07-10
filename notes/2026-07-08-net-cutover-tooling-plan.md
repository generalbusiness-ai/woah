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
NORMATIVE contract: spec/operations/net-cutover.md (NC1 state machine,
NC3 watermark, NC4 verification, **NC6 rollback points** — know which
phase you are in before touching anything; the point of no return is
the FIRST NET WRITE after the route switch, forward-recovery-only from
there).

0. **Pre-deploy**: merge `net-cutover`; `./scripts/deploy.sh` (ships the
   export route + freeze flag support + install doorway). Verify the
   walkthrough gate as usual.
1. **Announce the window. Freeze old prod — BOTH halves** (NC2, the
   acknowledged distributed fence): set the env flag AND persist the
   generation. `npx wrangler secret put WOO_WRITE_FREEZE` (value `1`),
   then `WOO_INTERNAL_SECRET=... curl -sX POST
   $BASE/net-install/freeze -d '{"generation":"cutover-<date>",
   "expected_generation":null}'` (signed; CAS from unfrozen — finding
   5). The env flag is instant per isolate; the persisted generation
   reaches every host (edge + satellites) within ~15s (finding 1).
   Probe: POST /api/auth → 503 E_MAINTENANCE; GET /healthz → 200.
2. **Final export from frozen prod** (the export REQUIRES the
   acknowledged fence — NC3):
   `WOO_INTERNAL_SECRET=... npx tsx scripts/identity-export.ts
   --base-url https://woah1.generalbusiness.ai
   --acknowledge-freeze cutover-<date> --out identity-export.json`
   (`--acknowledge-freeze` re-asserts the SAME generation from step 1 —
   omitting it makes the export refuse 409). The tool exports TWICE and
   requires equal
   watermarks (the NC3 quiescence proof; a benign one-time mismatch can
   come from cold-DO housekeeping — re-run; a PERSISTENT mismatch means
   the freeze is not holding: stop). Record the watermark line in the
   cutover receipt (NC7).
3. **Install into the net namespace, verify, ACTIVATE** (the namespace
   refuses ALL client traffic until the installer's final CAS'd
   /net/activate — NC1; PRE-COMMIT re-runs are safe, but once the
   credential probe commits a re-run refuses E_SEED_COMMITTED and the
   recovery is a fresh namespace — finding 1):
   `WOO_INTERNAL_SECRET=... npx tsx scripts/net-install.ts
   --base-url https://woah1.generalbusiness.ai
   --identity identity-export.json
   --verify-apikey apikey:<id>:<secret>`
   `--verify-apikey` is MANDATORY with `--identity`; a failed mint probe
   deactivates the namespace before aborting. Add
   `--verify-password email:password` for a carried account — the §8
   step-3 second half (also deactivate-on-failure).
4. **Route switch**: set `WOO_NET_DEFAULT=1` on the net worker (so
   `/client-config` returns net:true — first-time browsers at bare `/`
   boot the net client, finding 4/9; the response is no-store so a
   rollback un-pins clients), then move the public hostname — DNS/route
   change, NEVER a 308 (WS clients cannot follow redirects; the
   woah→woah1 incident).
5. **Postflight + bake**: deployed walkthrough + tail thresholds; old
   prod stays deployed AND FROZEN through the bake. Canary dashboard
   (STREAMING — evaluates during the bake, finding 6):
   `wrangler tail --format json | npx tsx scripts/net-metrics-report.ts
   --watch --min-turns 50 --min-seconds 120` — exits 2 the MOMENT an
   abort signal fires (any outbox abandonment, any fanout gap, sustained
   retry > 20%) and on insufficient evidence at stream end; watch p95
   wall_ms and the incident counters besides. Rollback = switch the
   route back, then unfreeze BOTH halves — delete WOO_WRITE_FREEZE AND
   clear the persisted generation (`POST /net-install/freeze
   {"generation":null,"expected_generation":"cutover-<date>"}`) — but
   ONLY until the first net write (NC6; after that, forward recovery
   only).
6. **After the bake**: retire old prod; the §8 deletion commits.

All build items are complete; every runbook step is executable. What
remains before a PUBLIC route switch is the NC8 enforceable-envelope
work (gateway sharding, identity index authorities, RPC deadlines,
owner-sequenced guest creation) plus a valid deployed-canary envelope —
the parallel-path deploy and `--watch` canary produce the latter.

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

## Review response: deployment-readiness findings (2026-07-09)

An external review (of snapshot 409331c — pre-dating d306338's freeze +
export and 19b5e51's parity gate) found the functional substrate
credible but the operational envelope unready. Verdict accepted; the
four blockers are now CLOSED on this branch, and the normative contract
moved out of this note into **spec/operations/net-cutover.md (NC1–NC8)**.

**Blockers → closed:**
1. *No consistent snapshot boundary* — partially stale (freeze + signed
   export landed at d306338); the REAL residuals are now built: the
   export route refuses unfrozen worlds (rehearsal override explicit),
   returns a full-world SHA-256 WATERMARK, and the operator tool
   exports twice requiring equal watermarks (quiescence/fence proof).
   Race-tested: a write arriving mid-window refuses E_MAINTENANCE and
   the watermark holds (net-cutover-freeze.test.ts). Root-caused a real
   instability the race test caught: the one-time derived-contents
   repair on a world DO's first warm fetch legitimately moves the image
   once ($nowhere sink cleanup, §B2.15); the tool's re-run semantics
   absorb it and the message names it.
2. *No atomic activation barrier* — built (NC1): namespace state
   machine FRESH → INSTALLING(epoch) → ACTIVE(epoch), enforced at the
   gateway identity gate via `property_cell:$system:net_active_epoch`;
   partial/mixed-epoch namespaces refuse E_NOT_INSTALLED
   (not_active/epoch_mismatch) on EVERY client request; installer seeds
   the activation cell strictly last; fixtures self-activate (they
   install pre-verified worlds).
3. *Unproven carried credential* — `--verify-apikey` now MANDATORY with
   `--identity` (loud `--skip-identity-verify` override for
   credential-less rehearsals); probe failure DEACTIVATES before
   aborting (safe pre-traffic; NC4). Also fail-closed catalog health:
   the install plan throws on any catalog version-migration/schema-plan
   failure (boot repair keeps warn-only).
4. *Doorway under-tested* — tests/worker/net-install-doorway.test.ts
   pins the ROUTE: signature gate (unsigned/tampered/wrong-secret/
   header-injection; secret never echoed), replay boundary (skew window
   + idempotent in-window replay), method/path allow-list, 8MiB body
   cap, seed/head forwarding, E_EPOCH_MISMATCH surfaced unwrapped,
   malformed-body refusal. In curated npm test.

**Items 5–11 → dispositioned honestly:**
- 5/6/7 (gateway envelope, cross-authority latency budget, hot-scope
  skew) — recorded as NC8 pre-deploy REQUIREMENTS; not provable in
  workerd lanes (fidelity-ladder rule), need instrumented measurement +
  skewed-load lanes + deployed canary. NOT yet built.
- 8 (bounded exactly-once storage) — partial: bounded drain passes,
  backoff, abandonment, lane directory exist from ready-to-scale;
  retention/compaction limits + poison quarantine recorded in NC8.
- 9 (catalog health warning-only) — CLOSED (fail-closed install, above).
- 10 (rollback contract) — CLOSED as NC6 (six phases, point of no
  return = first net write); runbook now names the phase per step.
- 11 (spec normativity) — CLOSED: spec/operations/net-cutover.md is
  normative; this note is the working log.

**Deployment decision unchanged**: no production deploy until NC8's
measurement items (skewed load, gateway envelope, canary + dashboards)
have evidence. Steps 0–3 of the runbook remain executable today.

## NC8 build (2026-07-09): the capacity program's local half

- **Instrumentation (NC8a)**: net_turn_structure gained wall_ms / rpc_ms
  / rpc_max_ms / rpc_depth (critical-path steps: a parallel group counts
  once — depth < sync_rpc measures paid parallelism); net_scope_submit
  (per-submit ms + outbox_enqueued delta at the authority — the
  hot-scope cost meter; depth derivable from enqueue/drain counters, no
  per-pass COUNT scan); net_push (audience, delivered_members, frames);
  scheduled dispatch lag_ms. pushObservations' per-member body re-read
  (an N+1 scaling with audience) folded into the one indexed query.
- **Budgets + parallel reads (NC8b)**: hard per-turn caps (32 sync RPCs
  / 30s RPC time) refuse namedly as E_BUDGET, checked BEFORE issuing;
  mandatory steps exempt (CO2.5 disambiguation resubmit, post-accept
  warm fill); a budget refusal never triggers the resubmit (nothing was
  issued). Foreign attests and multi-owner refresh closures now fetch in
  PARALLEL (installs after all resolve, transactional per destination).
- **Hot-scope serializer**: the skew lane's first honest run measured
  the thundering herd — 10 concurrent same-cell writers through one
  gateway, only 3 landed inside MAX_TURN_ATTEMPTS=6 (each retryable
  round re-races the herd; real DOs interleave at subrequest awaits the
  same way). Fix: per-planning-scope turn queues at the gateway — a
  shard's own concurrent turns run in arrival order, each planning
  against the previous turn's installed post-state (first-attempt
  accepts; wave 1 now converges 10/10). Cross-shard contention still
  converges through the retry loop; the serializer removes only the
  self-inflicted share.
- **Skewed-load lane (NC8c)**: tests/worker/net-load-skew.test.ts
  (`npm run load:net-skew`, in curated npm test): hot room, large
  audience (scan/push track occupancy, 3x off-room sessions invisible),
  high-degree owner isolation (200-member annex adds 0 to another
  scope's turn), 40-turn alarm backlog vs foreground (attempt=1,
  sync_rpc≤3), slow authority (injected 60ms lands in rpc_ms), dead
  authority (bounded amplification to the named budget).
- **Bounded growth (NC8d)**: audit found reply-cache cap + tail rule,
  abandoned-row 256 tail, delivered-row deletion, bounded drain passes /
  scheduled batches, capped dedupe/pin LRUs all already built; the gap
  was JITTER — defaultBackoffMs now spreads retries ±25% via a
  deterministic per-row FNV hash (herds de-synchronize; drains stay
  replayable; no Math.random).
- **Canary equipment (NC8e)**: scripts/net-metrics-report.ts aggregates
  woo.metric streams (raw logs or wrangler-tail JSON; balanced-brace
  extraction) into the dashboard series + inline abort signals (exit 2:
  abandonment > 0, fanout gap > 0, retry rate > 20%). Proven against
  real lane output.

REMAINING deploy-only (unchanged): canary numbers (sustained turns/s,
per-connection memory, cross-colo tails, cold-start stalls), tenant
capacity limits if one shard is the ceiling.

## Phase iii COMPLETE (2026-07-09, f48ad04): tool-space panels over net

The pinboard/outliner/tasks panels render over the net path, proven
cross-user in real browsers (e2e:net 4/4: alice adds a note through the
real board UI; it renders on bob's board). The reducer layer was
already transport-agnostic and wireNetFeed existed unwired — the build
was five client seams (wireNetFeed into connectNetFeed; v2Turn +
callWithError net branches carrying ALL tool moves/writes/reads;
pinboard cold hydration via list_notes; netMode LATCH at boot — tab
pushState dropped ?net=1 and flipped the shell to the v2 login;
/api/me net-gated — its 401 masqueraded as session expiry) plus ONE
real topology bug: normalizeAnchors anchored NESTED SPACES where they
sit, demoting the pinboard from its own room:the_pinboard sequencer to
a rider of room:the_deck — undiscoverable from anywhere but the deck
(E_MISSING_STATE → E_BUDGET on the SPA's tab teleport; the walkthrough
never saw it because it always enters from the deck). Spaces now stay
anchorless by design, like actors: actors → clusters, spaces → rooms.

Full-corpus npm test / test:worker rotate a 1–4 heavy-v2 timing flake
tonight; A/B on clean 86bab99 reproduces it identically (every failing
file passes in isolation on both trees) — pre-existing load-flake
class, recorded, not phase iii.

REMAINING before the §8 route switch: the PUBLIC identity door over
net (guest entry + account/password login — apikeys only today).

## IDENTITY DOOR COMPLETE (2026-07-10, 2f5ca7c): the LAST build item

Guest entry + account/password login over /net-api, proven in real
browsers with NO stored credential (e2e 5/5: guest claim → chat;
carol's real carried-password sign-in → chat; wrong password →
fail-closed card). Pieces: session-bearer credential class (the
documented Phase-5 hole — a door-minted session IS the bearer for the
whole surface; bearer-mint refused); /net-api/login (PBKDF2 verify
against carried $account cells in the catalog view, fail-closed v2
message parity, email-keyed amplifier rate bucket); /net-api/guest
(install-seeded $system.guest_pool — anonymous seats only: neither
account- nor apikey-bound; placed at install for born-present
sessions; EXCLUSIVE mint at the cluster sequencer refuses
actor_occupied so concurrent claims serialize — two humans never share
a guest; named exhaustion). §8 GAP FIXED: importIdentity now rebuilds
account.primary_actor/actors[] from the carried actor-side bindings —
password login resolves through primary_actor, which the allow-list
deliberately does not carry. Installer: --verify-password
email:password (step-3 second half, deactivate-on-failure). NetFeed
adoptSession (expiry terminal → shell shows the door); SPA login card
net-wired (Email label; woo:net:session persistence; logout → card).

Gates @ 2f5ca7c: npm test 809, e2e:net 5/5, install 5/5, net-mcp
13/13, net-dev 24/24, cf-dev 13/13, load 3/3 + skew 6/6; test:worker
rotates the documented pre-existing heavy-v2 parallel flake (all green
solo).

**NOTHING REMAINS BEFORE THE §8 OP.** Every build item is done: install
pipeline + activation barrier, identity carry (apikeys + passwords,
both prove-able), freeze + watermarked export, client shell (MCP + SPA
chat + panels + door), NC8 local half. The runbook's steps 0–6 are all
executable; the cutover itself stays owner-run.

## Second review response (2026-07-10, 4de8c73 + fd5c05b): findings 1-12

External review of 05913fb: "functionally strong, not cutover-ready."
Verdict accepted; findings 1-7 CLOSED with the reviewer's repros as
negative-path tests, 10-12's buildable halves CLOSED, 8/9 + residuals
RECORDED as NC8 scale caps (spec updated). Highlights:
- (1) /net/seed refuses E_SEED_COMMITTED once a scope commits (the
  reviewer's 1→2-under-unchanged-head repro is now a sequencer test);
  activation = dedicated /net/activate operator op; dev lane ASSERTS
  the rerun refusal; "rerunning is safe" docs corrected.
- (2) deactivated_at carries; mint-time eligibility gate (E_PERM
  identity_deactivated) on every credential path.
- (3) primary_actor/actors carry (export-filtered, import-verified);
  rebuild = fallback only. z_human/a_agent repro pinned.
- (4) GET /client-config (WOO_NET_DEFAULT) picks the transport for
  unsignaled boots; never persisted client-side (rollback = route
  back); bare-/ empty-storage e2e reaches the door.
- (5) activation TTL re-verification (NET_ACTIVATION_TTL_MS, 30s) —
  deactivation revokes the SAME gateway that served; same-gateway test.
- (6) acknowledged freeze fence: /__internal/freeze persists a
  generation; either half freezes; export requires + echoes it;
  identity-export --acknowledge-freeze; persisted-only + race tests.
- (7) metrics tool parses CF tail logs[].message[] structurally
  (recursively unwraps re-stringified events), unit-tested, FAILS
  CLOSED on zero data (exit 2).
- (10) dummy-hash timing equalization + isolate-wide PBKDF2 admission
  cap (4). (11-half) per-scope turn-queue depth cap (32, named
  E_BUDGET) + queue_ms in the structure metric. (12) DELETE
  /net-api/session releases the seat (250ms-grace close + presence
  retraction); SPA logout calls it; claim→close→SAME-seat-reclaim test.
- RECORDED (NC8): gateway sharding/eviction (8), identity index
  authorities (9), RPC deadlines/cancellation (11-rest),
  owner-sequenced guest creation (12-rest). Deploy order per review:
  parallel-path deploy → valid canary envelope → then these before the
  route switch.
