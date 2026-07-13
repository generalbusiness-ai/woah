# Net cutover — installation, activation, and migration of a live world (NC1–NC8)

Status: **implemented** (state machine, freeze, export watermark, activation
barrier, verification rules). NC8's local half — instrumentation, budgets,
skewed-load lane, bounded growth, report tooling — is **built**. Its initial
single-region Cloudflare stability envelope has passed; geographically
separated cold-start and sustained-rate evidence remains a **pre-cutover
requirement**.

This section is normative for moving a live v2 world into a net namespace
(the coherence layer of [spec/protocol/coherence.md](../protocol/coherence.md))
and for every future from-scratch net installation. The working plan and
runbook live in `notes/2026-07-08-net-cutover-tooling-plan.md`; where they
disagree with this section, this section wins.

## NC1. The namespace state machine

A net namespace is in exactly one of four states, and the transition
points are explicit:

```
FRESH ──seed──▶ INSTALLING(epoch) ──verify──▶ ACTIVE(epoch)
                      │  ▲                        │
                      │  └── re-seed (idempotent) │
                      └──────── deactivate ◀──────┘  (pre-traffic only)
```

- **FRESH** — the catalog scope holds no durable state. Every
  authenticated client request refuses `503 E_NOT_INSTALLED`
  (`reason: not_installed`).
- **INSTALLING(epoch)** — one or more scopes hold cells stamped with the
  install epoch, but the catalog authority has not published an active
  epoch. Client traffic still refuses `503 E_NOT_INSTALLED`
  (`reason: not_active`). A partially seeded or crashed install rests
  here indefinitely and safely: while no scope has COMMITTED turns,
  re-running the installer is the whole recovery story (same-epoch
  re-seed of install cells; the M9 guard refuses a different epoch with
  `E_EPOCH_MISMATCH`). Once any turn commits, seeds refuse
  `E_SEED_COMMITTED` and the recovery is a fresh namespace — a
  committed scope is never reseeded.
- **ACTIVE(epoch)** — the catalog authority publishes the fully verified
  epoch in `property_cell:$system:net_active_epoch`. Client traffic is
  admitted. A mixed state (activation epoch ≠ identity-cell epoch)
  refuses `503 E_NOT_INSTALLED` (`reason: epoch_mismatch`) — an operator
  error to surface, never to serve through.
- **DEACTIVATED** — the activation cell holds `null`. The installer's
  compensation when post-activation verification fails, and the
  operator's retirement lever.

**Activation state changes ride a DEDICATED operator op** —
`POST /net/activate` at the catalog scope (doorway:
`/net-install/scope/<name>/activate`) — never a seed: `/net/seed`
refuses `E_SEED_COMMITTED` once a scope has committed turns (a
same-epoch re-seed would silently reset authoritative state under an
unchanged head), while activation legitimately changes around
verification traffic.

Activation writes are CAS'd (`expected_active_epoch`): a replayed or
reordered activation within the signature skew window is refused
`E_STALE_HEAD`, so a captured activation cannot restore a revoked grant
(a same-value write is idempotent).

**The barrier is enforced at the gateway's identity gate** (the one code
path every authenticated client request already passes). The cached
verdict is RE-VERIFIED against the catalog authority — a targeted
one-key closure — whenever the cell is absent or the cached ACTIVE
verdict is older than `NET_ACTIVATION_TTL_MS` (default 30 s). A grant
whose last SUCCESSFUL re-verification is older than the grace window
(3×TTL) FAILS CLOSED (`503 activation_unverifiable`) — a partitioned
gateway that cannot reach the authority stops serving rather than
honoring a possibly-revoked namespace indefinitely.

**Every install runs this machine**, including test lanes: fixtures and
lane installs seed the activation cell together with the catalog
partition (they install pre-verified worlds); the production installer
(`scripts/net-install.ts`) seeds it as a separate final step, strictly
after NC4 verification.

## NC2. The write-freeze (v2 side)

`WOO_WRITE_FREEZE` freezes the v2 surfaces at both the edge and the DO
(defense in depth): every mutating request — plus the WS upgrade and the
session mint, which open mutation channels even as GETs — refuses
`503 E_MAINTENANCE`. GET reads continue. The NET namespace (`/net-api`,
`/net-install`) and `/admin` stay fully usable: installing and proving
the new world is *why* the old one is frozen.

Freeze properties:

- **Deploy-configured, therefore durable and global.** The flag is
  worker configuration; enabling it is a config deploy, which Cloudflare
  applies atomically per isolate. There is no in-storage flag to race.
- **In-flight requests** accepted before the flip may still land. The
  freeze is therefore *not* the consistency boundary by itself — the
  export watermark (NC3) is.
- **The acknowledged, DISTRIBUTED fence** (persisted half): `POST
  /net-install/freeze {generation, expected_generation}` records a
  freeze GENERATION in the world authority's durable meta (CAS'd on
  `expected_generation` — a replayed set/clear within the signature
  skew window is refused 409, so a captured transition cannot restore an
  old state). EITHER half freezes — the env flag or the persisted
  generation. The persisted half reaches EVERY host: the edge (every
  public mutation crosses it) and each satellite DO consult the world
  authority's generation, TTL-cached (~15s), so removing the env flag
  while the generation is held cannot reopen satellite writes. The
  export requires and echoes the generation (the receipt binds to it).
- **Unfreeze = rollback**: removing the env flag AND clearing the
  persisted generation (`{generation: null, expected_generation: <the
  held value>}`) restores v2 service unchanged. This is the abort path
  for every pre-activation rollback point (NC6).
- **Housekeeping is not frozen.** Deterministic convergence work (e.g.
  the one-time derived-contents repair on a cold world DO's first warm
  fetch) may still mutate the image exactly once. The watermark
  discipline absorbs this: re-export until stable.

## NC3. The consistency boundary: export watermark

`GET /net-install/identity-export` (signed; forwards to the world host's
internal export route) is the ONE read the cutover takes from old prod.
Its contract:

- **Refuses without the acknowledged fence** (`409`) — both the env
  freeze AND the persisted generation — unless the caller passes the
  explicit rehearsal override (`?allow-unfrozen=1`). A cutover export
  taken while writes still land can silently lose the mutations that
  follow it; the echoed `freeze_generation` binds the export file to
  the acknowledged fence in the receipt.
- Returns `{frozen, watermark, exported_at, identity}` where `watermark`
  is a SHA-256 digest of the **full serialized world** — not just the
  identity slice — so any accepted mutation anywhere moves it.
- **Quiescence proof**: the operator tool exports twice and requires
  equal watermarks before writing the export file. Equal watermarks
  prove no in-flight write landed between the reads. A mismatch aborts
  with wait-and-re-run guidance; a mismatch that *persists* across
  re-runs means the freeze is not holding — stop the cutover.
- The final watermark is recorded in the cutover receipt (NC7).

## NC4. Fail-closed verification

Activation requires ALL of, in order:

1. **Catalog health.** The install plan itself fails on any catalog
   version-migration or schema-plan failure
   (`installLocalCatalogs(..., {failClosed: true})`). Warn-only catalog
   repair is a *boot* posture (a deployed world must come up); an
   *install* must never declare a half-migrated world ready.
2. **Scope heads.** Every seeded scope answers `/head` at the install
   epoch.
3. **Carried credential** (when an identity export rode along). A
   carried apikey must mint a session through the real `/net-api/session`
   surface. `--verify-apikey` is **mandatory** with `--identity`; the
   `--skip-identity-verify` override exists for credential-less
   rehearsals and is loud. Because the client surface is barred until
   ACTIVE, this probe runs immediately *after* activation; a failure
   deactivates (NC1) before aborting, and no traffic can race the
   window because the route switch (NC6) is a later, separate step.
   The §8 prove step's second half — a carried account **password**
   login through the identity door (`/net-api/login`) — rides
   `--verify-password email:password` with the same
   deactivate-on-failure rule. The door itself: password login verifies
   PBKDF2-SHA256 against carried `$account` cells in the catalog-scope
   view (import rebuilds `primary_actor` from the actor-side bindings);
   guest entry claims a seat from the install-seeded
   `$system.guest_pool` with an EXCLUSIVE session mint (the cluster
   sequencer refuses `actor_occupied`, so concurrent claims serialize
   and two humans never share a guest); minted sessions are bearers
   (`Bearer session:<id>`) for the whole `/net-api` surface.

## NC5. The installation doorway

`POST /net-install/scope/<name>/seed`, `GET /net-install/scope/<name>/head`,
`POST /net-install/scope/<name>/activate`, `POST /net-install/freeze`,
and `GET /net-install/identity-export` are the entire surface. Trust
model and enforced properties (pinned at the route level by
`tests/worker/net-install-doorway.test.ts`):

- **Signature-gated, not dataset-gated**: the inbound internal HMAC
  (method + path + body-sha + timestamp, ±5 min skew) is the gate; the
  operator holds `WOO_INTERNAL_SECRET`. Unsigned, tampered,
  wrong-secret, and header-injected callers refuse without echoing any
  secret material.
- **Replay boundary**: outside the skew window a captured request is
  dead; within it, a byte-identical seed replay is idempotent by the
  M9 same-epoch guard and confers nothing.
- **Allow-list**: exactly seed (POST), head (GET), activate (POST), the
  freeze acknowledgment (POST), and the export read; anything else
  404s. Seeds additionally refuse `E_SEED_COMMITTED` on any scope with
  committed turns (NC1). The forward is freshly built and freshly signed —
  no inbound header propagates.
- **Bounded**: seed bodies cap at 8 MiB (a seed is a state transfer,
  not a turn envelope); oversized and malformed bodies refuse without
  reaching a scope.
- **Faithful**: scope verdicts (notably `E_EPOCH_MISMATCH` on a
  downgrade/mix attempt) surface through the doorway unwrapped.

## NC6. Public selection and rollback

The production topology is one dual-stack Worker with v2 and net Durable
Object bindings. Public selection is the deployment variable
`WOO_NET_DEFAULT`, parsed explicitly: only `1`, `true`, or `on` enables
net; `0`, `false`, an empty value, and absence select v2. Enabling it:

- makes `GET /client-config` answer `{net:true}` with `no-store`, so an
  unsignaled browser boot chooses `/net-api` and `/net-api/ws`;
- maps the compatibility endpoint `POST /mcp` to `/net-api/mcp`, preserving
  the public MCP URL while changing its implementation;
- leaves `/net-api/*` directly reachable for explicit probes.

This is a Worker configuration/version switch, not DNS and never a 308.
The public hostname already targets the dual-stack Worker. The v2 REST,
`/connect`, and `/v2/*` contracts are **not** compatibility-mapped; they
remain old-world endpoints and stay frozen. Every production consumer of
those surfaces must migrate to browser net, public MCP, or an explicit
`/net-api` client before selection. A successful browser or MCP session
mint is already a net write, so the practical rollback-only interval after
selection is intentionally very small.

Rollback points, in cutover order:

| Phase | State | Rollback |
|---|---|---|
| Before freeze | v2 serving | Freely abort; nothing happened. |
| After freeze, before export | v2 frozen | Unfreeze (config deploy). Full reversal. |
| After export, before ACTIVE | net INSTALLING | Unfreeze v2; discard the namespace (it never served). Full reversal. |
| ACTIVE, before public selection | net proven, no traffic | Deactivate + unfreeze v2; or simply never enable `WOO_NET_DEFAULT`. Full reversal. |
| After public selection, before first net write | net serving reads | Disable `WOO_NET_DEFAULT`, then unfreeze v2. The export identity is a superset of anything read. |
| **After first net write** | net is authoritative | **Forward recovery only.** No reverse replication exists; returning to v2 discards net-era writes. This is the point of no return and the runbook marks it. |

## NC7. The installation receipt

Every production install records: source worker version and export
watermark, target namespace and install epoch, scope count and head
digest set, identity actor/key counts, verification results (heads,
credential probe), operator, and timestamps. The receipt is the input to
the post-switch audit and the deletion decision at the end of the bake.
(Current form: the installer's logged transcript plus the watermark line
from the export tool, kept with the cutover notes; a structured
`receipt.json` emitted by `scripts/net-install.ts` is acceptable and
preferred as tooling matures.)

## NC8. Capacity and operations program (pre-deploy requirements)

These are required **before inviting production workloads**. Status per
item; what remains is exactly what the workerd lanes cannot prove
(single-process, fast reliable RPC — the fidelity-ladder rule):

- **Cross-authority latency budget — BUILT.** Every turn reports
  `net_turn_structure {wall_ms, rpc_ms, rpc_max_ms, rpc_depth, sync_rpc,
  reconstructions, plan_cells, envelope_bytes}`; independent
  cross-authority reads (foreign attests, multi-owner refresh closures)
  fetch in parallel (one critical-path step, `rpc_depth < sync_rpc`
  measures the paid parallelism); hard per-turn budgets refuse namedly
  (`E_BUDGET`, 32 RPCs / 30 s RPC time — mandatory steps exempt: the
  CO2.5 disambiguation resubmit and the post-accept warm fill).
- **Skewed-load proof — BUILT (in-process bounds).** `load:net-skew`
  (curated gate): hot-room concurrent same-cell writers (converge under
  retry with named verdicts and exact serialization at the authority —
  each gateway shard admits twelve bounded per-scope lanes (the
  canary-proven `NET_TURN_SCOPE_CONCURRENCY` default), limiting the
  self-inflicted herd without serializing independent turns), large-audience
  fanout (scan and push track room occupancy, never total mirrored
  sessions), high-degree owner isolation (a 200-member scope adds
  nothing to another scope's turn), alarm backlog under foreground
  writes, slow authority (latency lands attributed in `rpc_ms`), dead
  authority (bounded amplification to the named budget). What it cannot
  prove: real cross-colo tails and cold-start stalls — canary-only.
- **Bounded growth — BUILT.** Reply cache capped (`REPLY_CACHE_CAP`
  1024, recovery-tail never pruned), delivered outbox rows deleted,
  abandoned rows keep a 256-row debugging tail, drain passes and
  scheduled batches bounded per invocation, dedupe/pin LRUs capped,
  session reaper armed; retry backoff carries deterministic per-row
  ±25 % jitter (herds de-synchronize; drains stay replayable). Poison
  rows halt only their own lane and abandon namedly after the attempt
  budget — never silent loss, never starvation of later work.
- **Gateway envelope — DATASET SINK + MEASUREMENT TOOLING BUILT;
  numbers deploy-only.**
  `scripts/net-metrics-report.ts` aggregates the metric series
  (turn percentiles, retry/reconstruction rates, hottest scopes, fanout
  audience, outbox health, scheduler lag, incident counters) from any
  log stream (`wrangler tail --format json | tsx
  scripts/net-metrics-report.ts`). Sustained turns/s, per-connection
  memory, and tenant limits still require the deployed canary. Every net DO
  now writes the same event to the `METRICS` Analytics Engine binding under
  a stable per-gateway/per-scope index; the additive 20-double schema keeps
  queue, wall, RPC, turn-shape, outbox, push, and presence dimensions intact.
  `metrics:net-ae` queries the canary dataset with AE sampling weights and
  fails closed on insufficient samples, turn errors/timeouts, queue tails,
  single-shard concentration, absent elastic provisioning, outbox
  abandonment, fanout gaps, and degraded install/adoption signals.
  The acceptance deployment uses `wrangler.net-canary.template.toml`: a
  standalone workers.dev-only Worker with no `routes`, independent DO
  namespaces, a newly created KV namespace, and `woo_v1_net_canary`. It MUST
  NOT be represented as `[env.canary]` under the production config.
  During a cutover bake, `metrics:net-ae --watch` polls a growing AE
  window, aborts immediately on integrity incidents, requires both a
  minimum duration and the full evidence envelope, and exits 2 if the
  maximum duration expires without sufficient healthy evidence. Sampled
  `wrangler tail` remains diagnostic only.
- **Presence is scoped, never globally enumerated — BUILT; deployed
  confirmation remains.** No public verb may enumerate all sessions or all
  objects: that returns a per-shard partial view under sharding and violates
  Big-World discipline. `who_all`/`@who` (no argument) is presence-scoped to
  the caller's room via the generic `room_roster(<scope>)` projection; the former
  `connected_players` global session scan is retired (tombstoned).
  `@join`/`join_player` resolves only an explicit `$player`
  reference — no global object scan and no cross-shard name directory (join by
  human name is not supported; a co-present player is already in the room).
  The room authority reduces its owner-anchored `session_presence` rows into
  one compact roster value (`POST /net/room-roster`). The gateway fetches that
  value directly before a roster-reading turn and installs it only in the
  ephemeral planning world; no per-occupant actor/session authority cells
  enter the turn's read closure. This is deliberately computed from the one
  relation family rather than persisted as a second roster authority. The
  result is one O(N)-byte RPC and O(1) planning inputs, with no per-occupant
  RPC. Chat's `$room:room_roster` adapts this generic value to the stable
  catalog row shape; `look_self`, `who`, and `enter` therefore share the
  compact path. Workspace catalogs retain their distinct focus/subscription
  roster semantics. For a roster-reading verb whose receiver anchors to a
  shared scope, the gateway reads that receiver's room authority (so `enter`
  returns the destination roster); actor receivers use the session's active
  scope (so `who_all` remains caller-room scoped). This decision is derived
  from topology, not catalog names or command words. The metadata lookup follows
  the VM's dispatch order: receiver parent chain first, then each declared
  feature chain. Feature-composed room verbs therefore cannot silently bypass
  their `reads_room_presence` declaration.

  Recorded actor movement does not read or mutate the legacy
  `session_subscribers`/`subscribers` object-property mirrors while planning.
  Those values are relation-derived projections, not authority cells; treating
  them as plan reads creates a repair loop because an owner closure can return
  the corresponding relation rows but correctly has no authority cell to
  attest. The accepted `sessionScopeTransition` is the sole planning output,
  and every materializer derives the compatibility mirrors from it. Direct
  local movement, which has no later transcript-application phase, continues
  to update the mirrors immediately.
  The same boundary applies to `observe_to_space`: recorded observations carry
  their space source and let that owner derive the audience from
  `session_presence`; only a direct cross-host observation eagerly reads the
  remote subscriber mirror to construct an audience override.
  For a roster-backed move result with `look_deferred: true`, planning omits the
  redundant `here` snapshot. The result's top-level roster is advanced by the
  pending session transition so it includes the caller, and the client performs
  the declared authoritative refresh. This avoids rebuilding presence from
  physical room contents: closed sessions may leave reusable player objects
  physically contained, but planning must not dereference those actor clusters.

  Presence transition acceptance includes a freshness fence: after the actor
  scope commits, the gateway delivers the same `(from_scope, seq)` relation
  fact synchronously to the room owner before returning success. The actor
  scope's durable outbox remains the crash-recovery path; its duplicate is an
  owner-sequenced no-op. Thus a dependent `who_all` cannot race an owner that
  has not learned the accepted enter. Gateway mirrors remain asynchronous and
  are not used as roster authority. Snapshot construction excludes expired
  session values, while explicit close and the session alarm retract durable
  local/foreign presence rows through the existing owner-sequenced path. A
  present actor's self-rename refreshes the same relation row in the rename
  commit, so compact labels do not remain frozen at entry time.

  A multi-gateway regression rehydrates a shard without a peer's cluster cells
  and, without draining deferred fanout, still commits `who_all` with the
  complete roster. A 30-occupant planner regression remains below the 64 KiB
  envelope limit and records no per-actor reads. Deployed confirmation:
  `load:net-canary -- --enforce-who` must return a
  complete co-present roster from every shard, failing on any partial or
  inconclusive result — a signal the single-image workerd-local lanes cannot
  produce. Guest/session mint responses include the owner-committed
  `active_scope`; the driver skips setup movement when a session is already
  born in the requested room, so the enter phase measures real transitions.
  Guest claims carry a high-entropy timestamped `claim_id`, treated as a
  temporary bearer. The edge routes retries by that key and the gateway
  deterministically derives the same actor/session and original mint time;
  an ambiguous fresh-scope timeout therefore replays one scope idempotency
  key instead of leaking another guest. Invalid, future, and expired claims
  fail closed; old clients without a claim retain additive compatibility.
- **Gateway sharding — BUILT after the first deployed canary.** Public
  `/net-api` routing uses `NET_API_GATEWAY_SHARDS` named shards. A session
  or WebSocket ticket carries its minting shard; MCP headers, bearer/body/
  query sessions, and ticket upgrades therefore return to the durable
  cache that owns them without a global directory. Sessionless login and
  apikey requests hash a stable credential key; anonymous guest/bootstrap
  requests distribute using edge entropy. Hints outside the configured set
  are ignored so untrusted ids cannot instantiate arbitrary named DOs.
- **RPC and queue deadlines — BUILT after the first deployed canary.**
  Every coherence-layer cross-DO fetch is aborted after
  `NET_RPC_TIMEOUT_MS` (5 s in the deployment profile) and surfaces as
  `503 E_RPC_TIMEOUT`. A timed-out submit remains ambiguous: the gateway
  performs exactly one same-key replay before surfacing the timeout, so a
  lost accepted reply cannot cause a second commit. Each gateway shard
  runs twelve bounded concurrent lanes per planning scope (configurable by
  `NET_TURN_SCOPE_CONCURRENCY`, clamped 1–16); turns waiting behind a lane
  refuse as `503 E_BUDGET` after
  `NET_TURN_QUEUE_WAIT_MS` (1.5 s) and are skipped before execution; depth
  and aggregate caps remain in force while expired entries drain.
- **Elastic guest admission — BUILT after the first deployed canary.**
  The install-seeded pool remains the reuse-first path. Once occupied,
  the door reads the validated `$system.guest_template` catalog cell and
  commits a fresh actor, its initial placement, mutable guest properties,
  and its first exclusive session atomically at a previously unseen
  `cluster:<actor>` owner. Contents and session-presence deltas follow the
  normal owner outbox path. Random 128-bit actor ids select independent
  cluster DOs; the sequencer's create-collision guard remains fail-closed.
- **Second-review scale caps — RECORDED, NOT BUILT** (accepted findings
  9/11/12 residuals, required before public traffic beyond the bake):
  each `/net-api` gateway durably accumulates every cell visited by its
  sessions and cold-hydrates its whole store (bound the
  derived cache, evict unsubscribed scopes with revision-safe re-pull);
  identity is centralized (one `api_keys` cell, O(accounts) email scan,
  the 8 MiB seed partition as an eventual ceiling — hashed
  credential/account index authorities are the design). Elastic guest
  actors are durable identities; tenant-level creation quotas and
  lifecycle compaction remain policy work beyond the initial public bake.
- **Deployed canary — INITIAL STABILITY ENVELOPE PASSED.** The isolated
  2026-07-11 canary proved install, session mint,
  turn commit, and named refusals on real Cloudflare DOs. It also measured
  42 % HTTP 500 responses at 6 guests and 12 concurrent turns, a 2.24 s
  gateway p99, 1.1 s scope queue wait, fixed-pool guest exhaustion, and
  inadequate `wrangler tail` sampling. The resulting gateway sharding,
  bounded deadlines, elastic guests, alarm-bounded outbox, and
  per-subscriber delivery continuity were then exercised in two 30-guest,
  600-turn paced runs. Both completed 600/600 with 22 elastic guests and
  all sessions closed. The accepted window covered all eight gateway
  shards with zero errors, timeouts, queue wait, retries, reconstructions,
  outbox failures, abandonments, or delivery gaps; its AE-weighted global
  server envelope was p50 173 ms, p95 349 ms, p99 397 ms (max 1.78 s).
  Production and smoke profiles therefore carry the canary-proven twelve
  per-scope gateway lanes. The public route remains closed pending the
  owner-run cutover and geographically separated/cold-start/sustained-rate
  bake.
- **Global-presence commands — COMPACT OWNER SNAPSHOT BUILT; DEPLOY CONFIRMATION
  REQUIRED.** Global enumeration is removed and owner-scoped presence now
  enters sparse planning through the freshness fence described above. The load
  driver fails closed on a partial or inconclusive result; public selection still requires a passing
  deployed multi-shard `--enforce-who` canary.

The AE watch exits 2 on any RPC timeout, queue refusal, outbox delivery
failure/abandonment, fanout gap, degraded install/adoption signal,
threshold breach, or insufficient evidence at its deadline. Tail reports
may supplement diagnosis but cannot satisfy NC8 acceptance.
