# Net cutover — installation, activation, and migration of a live world (NC1–NC8)

Status: **implemented** (state machine, freeze, export watermark, activation
barrier, verification rules). NC8's local half — instrumentation, budgets,
skewed-load lane, bounded growth, report tooling — is **built**; its
deploy-only half (canary numbers, cross-colo tails, sustained-rate
envelope) remains a **pre-deploy requirement**.

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

## NC6. The rollback contract

Rollback points, in cutover order. "Traffic" means the public route
(DNS) targeting the namespace — the route switch is always the LAST step
and is always DNS-based (never a 308: WS clients cannot follow it).

| Phase | State | Rollback |
|---|---|---|
| Before freeze | v2 serving | Freely abort; nothing happened. |
| After freeze, before export | v2 frozen | Unfreeze (config deploy). Full reversal. |
| After export, before ACTIVE | net INSTALLING | Unfreeze v2; discard the namespace (it never served). Full reversal. |
| ACTIVE, before route switch | net proven, no traffic | Deactivate + unfreeze v2; or simply never switch. Full reversal. |
| After route switch, before first net write | net serving reads | Reverse the route, unfreeze v2. The export identity is a superset of anything read. |
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
  retry with named verdicts and exact serialization — a per-scope turn
  serializer at the gateway removes the self-inflicted herd the lane
  originally measured at 3/10 first-wave survivors), large-audience
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
- **Gateway envelope — MEASUREMENT TOOLING BUILT; numbers deploy-only.**
  `scripts/net-metrics-report.ts` aggregates the metric series
  (turn percentiles, retry/reconstruction rates, hottest scopes, fanout
  audience, outbox health, scheduler lag, incident counters) from any
  log stream (`wrangler tail --format json | tsx
  scripts/net-metrics-report.ts`). Sustained turns/s, per-connection
  memory, and tenant limits still require the deployed canary.
- **Gateway sharding — BUILT after the first deployed canary.** Public
  `/net-api` routing uses `NET_API_GATEWAY_SHARDS` named shards. A session
  or WebSocket ticket carries its minting shard; MCP headers, bearer/body/
  query sessions, and ticket upgrades therefore return to the durable
  cache that owns them without a global directory. Sessionless login and
  apikey requests hash a stable credential key; anonymous guest/bootstrap
  requests distribute using edge entropy. Hints outside the configured set
  are ignored so untrusted ids cannot instantiate arbitrary named DOs.
- **Second-review scale caps — RECORDED, NOT BUILT** (accepted findings
  9/11/12 residuals, required before public traffic beyond the bake):
  each `/net-api` gateway durably accumulates every cell visited by its
  sessions
  and cold-hydrates its whole store (shard by session/actor, bound the
  derived cache, evict unsubscribed scopes with revision-safe re-pull);
  identity is centralized (one `api_keys` cell, O(accounts) email scan,
  the 8 MiB seed partition as an eventual ceiling — hashed
  credential/account index authorities are the design); RPCs have no
  deadline/cancellation (the per-turn budget is checked between calls,
  not during one); guest capacity is the fixed installed pool
  (owner-sequenced guest CREATION is the follow-up; close/release and
  named exhaustion exist).
- **Deployed canary — DIAGNOSTIC RUN COMPLETE; ACCEPTANCE RERUN
  REQUIRED.** The isolated 2026-07-11 canary proved install, session mint,
  turn commit, and named refusals on real Cloudflare DOs. It also measured
  42 % HTTP 500 responses at 6 guests and 12 concurrent turns, a 2.24 s
  gateway p99, 1.1 s scope queue wait, fixed-pool guest exhaustion, and
  inadequate `wrangler tail` sampling. The public route remains closed.
  After the recorded scale caps are built, rerun with geographic
  separation, cold starts, a nonsampling metrics sink, and the abort
  criteria below. Abort signals (the report tool exits 2 on them): any
  outbox abandonment (named divergence), any fanout gap, turn retry rate
  > 20 % over a meaningful sample; plus operator judgment on p95
  `wall_ms` regressions and `install_degraded` / `adopt_conflict`
  counters.
