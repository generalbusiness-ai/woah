# The Simplest Deployable System — Implementation Plan

Date: 2026-07-04
Status: proposed (ready for review; no code has been written)
Revision: 3 — rev 2 after an adversarial verification pass, rev 3 after
owner review + approval of all §8 decisions (2026-07-05); see §9.
Registered for execution as `plans/002-simplest-deployable-system.md`.
Inputs: `2026-07-04-architecture-review-handoff.md` and the staged analysis
`2026-07-04-simplest-system-0{0,1,2,3,4}-*.md`. Claims below are argued and
cited in those notes; this document states decisions and steps.

---

## 1. The decision

**Keep the world engine wholesale. New-build the distribution layer. Delete
the old one at cutover. Do not migrate deployed world state — reinstall it
from catalogs, with an explicit identity/credential carry-over (§4 Phase 5).**

Per the stage-0 criteria (C1–C4), applied per layer:

| Layer | Verdict |
|---|---|
| Substrate: `tiny-vm`, `dsl-compiler`, `catalog-installer`, `bootstrap`, `executor` core, `authoring` (~13.5k LOC) | **Keep as-is.** Zero or type-only coupling to v2/CF (stage 4 §4.2). |
| `world.ts` object model (~88% of 12.4k) | **Keep**; unthread ~1.5k LOC of v2 hooks behind one seam (Phase 1). |
| v1 persistence (`repository.ts`, SQLite, JSON) + local/dev modes | **Keep.** A complete non-distributed runtime already exists under the turn layer. |
| Catalogs + conformance corpus (12.4k assets) | **Keep wholesale.** Confirmed host-agnostic. |
| Base client UI (~7.5k) | **Keep**; re-point its data feed. |
| **v2 turn network + CF worker layer + client v2 plumbing (~34k LOC, 12 flags, 3 DO classes)** | **Replace with a fresh implementation of the already-ratified semantics** (~one page of invariants — stage 2 §2.1), then delete. |
| `DirectoryDO` (955) | **Evolve** (already bounded/leased; stays a routing-hint service). |

Why new-build and not convergence (the honest fork in the prior plans —
stage 3 §3.5 contradiction 1): the v2 layer is ~24k LOC carrying ~500 lines
of semantics; its own headers document retired designs; 12 flags hold two
architectures in superposition; the CA12 cell-first representation is
half-migrated with `SerializedWorld` still on hot paths; and the B10
end-state ("no compensating mechanisms") is *blocked* precisely because
convergence requires proving each deletion against production while the
scaffolding is load-bearing. Building the end-state directly, beside the old
path, converts B10 from a blocked convergence program into a cutover event.
The world being installable-from-catalogs makes fresh deployment cheap.
**One correction from the verification pass:** prod state is *not* purely
catalog-reconstructible — accounts, apikey records, the actor objects those
records point at, and the credentials external plugs authenticate with live
in world state under `$system` and the object graph (`world.ts:2515-2605`;
`DEPLOY.md:217-252` — the wizard bootstrap token is single-use and the
backup wizard is an in-world apikey). Fresh install therefore requires the
bounded identity export/import defined in Phase 5; "reset everything" is not
an acceptable default. (Bearer tokens are the one exception: 60-minute TTL
session records, dropped by design — Phase 5.)

Why not a bigger rewrite: every diagnosis in the record is anti-rewrite for
the substrate ("four root causes, not forty bugs"), and the coupling audit
confirms the substrate is clean. The rewrite boundary is exactly the layer
whose accident dominates its essence.

**Name.** The new layer is `src/net/` — "the coherence layer." Not "v3": the
version-suffix habit is how the current superposition happened. One
implementation, no versioned siblings.

---

## 2. Ratified goals (the plan's success criteria)

Adopted from stage 1 §1.7 — the existing consensus numbers made falsifiable,
promoted into spec in Phase 0. Headline SLOs for the deployed system:

- Warm same-scope turn **p50 < 500 ms, p95 < 2 s**; cross-scope (movement)
  **p50 < 1 s, p95 < 4 s**; peer-visible delivery **< 1 s**, independent of
  audience size; cold session open **< 3 s**.
- Structure per warm turn: **1 attempt, 1 envelope (< 64 KB; cross-scope
  < 256 KB), ≤ 3 cross-host RPCs on the synchronous reply path, ≤ 8
  scope-row writes, 0 authority reconstructions**. Post-reply durable-outbox
  fanout is excluded from the RPC budget — it is O(distinct occupant shards)
  by design (CA13) and bounded by the delivery SLO instead.
- Asymptotics: CA13 as written — never O(world), O(objects_in_scope),
  O(occupants²), O(active_sessions).
- Convergence: **zero unnamed divergence** — every divergence event carries a
  taxonomy code (§4.6); `dangling_parent_ref` is structurally impossible
  (§4.4), not merely zero.
- Scale posture stated explicitly: one sequencer per scope ⇒ **tens of
  concurrent actors per room** is the committed ceiling; CA13
  sharding/migration is the named growth path, deferred behind the C4
  load-gate tripwire. "Millions of nodes" remains the design discipline
  (no global enumeration), not a numeric SLO.

---

## 3. Target architecture

### 3.1 Roles

Three runtime roles, one turn pipeline, five named state copies.

```
client (projection consumer + optimistic echo)
   │ observations / projections        │ intents
   ▼                                   ▼
GATEWAY  — session edge: auth, planning, derived cache (incl. tool-surface
           projection), fanout delivery
   │ envelope = transcript + read-closure (only shape; <64/256 KB)
   ▼
SCOPE    — the authority: one sequencer per commit scope; validates,
           commits, owns the cells anchored to it; durable outbox;
           scheduled-turn alarms and parked-task resumption
   │ routing hints + leased presence projection
DIRECTORY — routing hints + a leased session/presence projection (never authority)
KV        — epoch-stamped cold-start seeds (read-only fallback)
```

The **scope is the object home**. v2's separate "per-host object home" world
image (one of the ~8 copies) is eliminated: an object's cells live in exactly
one scope at a time (anchor-cluster model, actor-anchored movement per CA6).
The gateway holds only derived state. The scope, as the anchor of its
objects, also owns their **durable continuations**: parked SUSPEND/FORK
tasks and scheduled turns anchor at the scope sequencer, which sets its
alarm to the earliest due logical time and wakes itself (per VTN
§scheduled-turns, `v2-turn-network.md:2677-2838`) — an obligation the
current worker never finished (`persistent-object-do.ts:22` "Alarms for
parked tasks (Phase 4)"), so the new layer implements it rather than
inheriting the gap silently.

### 3.2 The five named copies (the whole divergence surface)

This registry is normative spec (Phase 0). Any state materialization not in
this table is a bug by definition — the enforcement of "enumerable copies."

| # | Copy | Provenance | Freshness bound | Reseed path |
|---|---|---|---|---|
| 1 | Scope authority (ScopeDO SQLite; includes parked-task rows) | `authoritative` | is the truth | — |
| 2 | Gateway cache (GatewayDO SQLite; includes the MCP tool-surface projection; in-memory views are reads of it, not copies) | `derived` | stamped `(scope_head, catalog_epoch)` | `E_STALE_EPOCH` → refetch closure from scope |
| 3 | KV seed | `seed` | stamped epoch; may lag | overwritten on checkpoint; consumers must head-check with scope |
| 4 | Browser cache (IDB/localStorage) | `derived` + `echo` overlay | stamped like #2 | epoch mismatch → drop and rehydrate |
| 5 | Directory session/presence projection (`session_route`: activeScope, focus, display fields) | `derived`, leased | presence-lease TTL | lease expiry drops the row; session re-announce rewrites it |

Down from ~8 unmanaged copies (stage 2 §2.4). v2's checkpoint-page tables,
accepted-frame tail replay, in-memory relay cache-as-separate-copy, and the
whole-world host image do not exist in the new layer. (The scope keeps a
bounded transcript tail *as its own recovery log*, not as a copy others
read.) Copy #5 exists because the current `DirectoryDO.session_route`
already materializes presence/display state (`directory-do.ts:285-297`), not
mere route hints; the registry names it rather than pretending otherwise.
The MCP tool-surface projection (`spec/semantics/projection-cache.md` PC1,
`gateway_tool_surface*`) is folded into copy #2 under the same epoch
discipline — it is a real cross-host read subsystem, not an adapter detail.

### 3.3 The turn pipeline (one implementation, three hosts)

`submitTurn(intent) → plan → commit → fanout → project`, written
host-agnostically in `src/net/` against a small `Host` interface
(`rpc`, `storage`, `deferred`, `clock`). Three bindings:

- **InProcessHost** — dev server, tests, and the browser echo (same TS).
- **WorkerdHost** — GatewayDO/ScopeDO/DirectoryDO.
- **SqliteHost** — local single-process deployment (wraps InProcessHost with
  `LocalSQLiteRepository`-backed stores).

This single decision resolves three standing defects at once: transport
triplication (MCP/REST/WS become thin adapters over one `submitTurn`),
dev-path divergence (the dev server runs the *same* pipeline), and most of
the fake-DO fidelity gap (the fake tested a different composition; here the
composition is identical and only the Host differs).

### 3.4 Module map for `src/net/` (target ~9.3k LOC vs 24k replaced)

| Module | Contents | ~LOC |
|---|---|---|
| `cells.ts` | CellStore: typed pages, mandatory provenance, content addressing, epoch stamps | 900 |
| `transcript.ts` | EffectTranscript schema (ported unchanged from VTN §453-480) + apply | 700 |
| `validate.ts` | VTN8 validation order (ported semantics): auth → epoch → idempotency → completeness → hashes → read-versions → write-authority → post-state re-derivation | 900 |
| `scope.ts` | Sequencer: head, commit, reply/seen idempotency tables, bounded recovery tail, scheduled-turn alarm queue + parked-task resumption | 1,300 |
| `plan.ts` | Gateway planner: run TurnEngine against CellStore view, produce transcript + read-closure | 800 |
| `route.ts` | ScopeRouter: write-set → scope selection; fixed assignment behind an interface so CA10 migration slots in later | 300 |
| `outbox.ts` | Durable fanout: lineage-closed bodies, at-least-once, per-scope ordered, receiver no-op by head | 700 |
| `seeds.ts` | KV seed write/read, epoch-stamped | 400 |
| `errors.ts` | The divergence taxonomy (E2) as *the* error enum of the layer | 200 |
| `host.ts` + 3 bindings | Host interface; in-process / workerd / sqlite | 1,200 |
| `client-feed.ts` | Browser: projection consumer + echo overlay (replaces 4.8k of v2-browser-*) | 800 |
| `tool-surface.ts` | MCP tool-surface projection rows + cross-host merge (PC1), epoch-stamped in copy #2 | 500 |
| DO shells (`src/worker/`) | GatewayDO, ScopeDO thin wrappers over net modules | 1,600 |

### 3.5 Design rules carried from the evidence (each kills a v2 defect class)

1. **CI by construction.** Every page has `source` provenance at the type
   level from the first seed; there is no un-provenanced state, so CA11's
   presentation-stub refusal scaffolding is unnecessary.
2. **One envelope shape.** Transcript + read-closure, always. No authority
   slices, no capsule, no slim/full flag. A cold scope replies
   `E_STALE_HEAD` (taxonomy code, retryable); the gateway seeds from KV/scope
   and retries. The 256 KB ceiling holds by construction because read-closure
   is the only thing that can be sent. `line_map` never ships — debug info is
   fetched on demand.
3. **Lineage closure is part of the transfer type.** A page transfer that
   does not close over `object_lineage` does not serialize.
   `dangling_parent_ref` becomes unrepresentable, not merely gated to zero.
4. **Epochs first-class** (E1 generalized): every durable artifact stamps
   `(catalog_epoch, scope_head)`; every consumer checks; mismatch is a named
   self-healing reseed. This is the layer's *normal* cold path, not a repair
   add-on.
5. **One write path per fact** (E5 by construction): relations (`contents`,
   session/audience rosters, future indexes) are derived rows produced by a
   single projection applier consuming committed transcripts — never
   independently written list properties. Audience-from-projection (the D2a
   deferral) becomes sound automatically.
6. **Cold-start physics is designed, not patched.** KV seeds, head-freshness
   retry, and the durable outbox are first-class components (copy #3, rule 2,
   `outbox.ts`) — the mechanisms survive from v2 because the *constraint* is
   real; the flags and dual paths around them do not.
7. **Movement is CA3/CA4 as ratified — including the ride-along rule.**
   Location cell authoritative at the moved object's home scope; `contents`
   a derived projection outside commit validation; actor-anchored scope
   selection (CA6). Pure movement (the common case) writes only
   actor-anchored cells → single scope. A turn that *also* writes a
   room-owned cell (capacity counters, arrival logs — the normal
   `acceptable`/`enterfunc` pattern) **commits at the planning scope, which
   serializes the shared cell, and the actor-location write rides along
   atomically** — CA3 verbatim (`cell-authority.md:108-110`). `E_SCOPE_SPLIT`
   is reserved for the genuinely disjoint case CA3 does not cover (writes to
   two *different shared* scopes in one turn) — named rejection rather than
   v2's metric-only silent commit — an honest limitation until CA10 route
   migration is built (explicitly out of scope, §7).

### 3.6 The browser

The client is a **projection consumer with an optimistic echo overlay** —
B9's "narrow node" conclusion, taken seriously. On submit, the client applies
the intent's *predicted* transcript writes to a `source:"echo"` overlay
(reusing `transcript.ts` apply — same TS in the browser); commit fanout
replaces echo with derived truth; rejection drops the overlay. No parallel
VM, no divergent holder protocol, no 3.3k `shadow-browser-node`. If richer
offline planning is wanted later, it reuses `plan.ts` in-browser via
InProcessHost — same pipeline, not a sibling.

---

## 4. Phases

Each phase has deliverables, exit gates, and lands on main behind the
existing guard regime. v2 is **frozen** for the duration: bugfix-only, and —
consistent with the 2026-06-16 verdict — **no further v2 state-path
deploys**. Prod stays where it is until Phase 5 cutover.

### Phase 0 — Ratify the contract (spec only, no code)

- Write **`spec/protocol/coherence.md`** (status: the normative contract for
  `src/net/`): the invariant page (stage 2 §2.1 — CI, turn atomicity,
  scope-by-write-set **with the CA3 ride-along rule**, read-version
  validation, idempotency, materialization-miss rule, fanout guarantee,
  **and durable continuations**: parked SUSPEND/FORK tasks + scheduled-turn
  alarms anchored at the scope sequencer), the EffectTranscript schema
  and validation order (ported from VTN, corrected: post-state re-derivation,
  not re-execution), the **named-copy registry** (§3.2, five copies incl.
  the Directory presence projection and the tool-surface projection), the
  **divergence taxonomy** (§4.6 below), the SLO table (§2), and the stated
  limitations (single/ride-along commits only, tens-per-room ceiling,
  CA10/CA13 as growth path).
- Mark `v2-turn-network.md` and `cell-authority.md` as **superseded-by**
  `coherence.md` for the parts carried over; they remain the historical
  record. Carry `spec/semantics/projection-cache.md` PC1 (tool-surface
  projection) into the copy-#2 contract. (Correction: that spec lives under
  `spec/semantics/`, not `spec/protocol/` — stage 2's "does not exist" claim
  was a mis-path.)
- Promote `spec/semantics/moveto.md` and `spec/semantics/distribution.md`
  out of draft for their implemented cores (handoff §6.2).
- **Exit gate:** spec review against the stage notes; every §3.5 rule
  traceable to a coherence.md clause. (This satisfies AGENTS.md:
  implementation begins only after the spec constrains it.)

### Phase 1 — The engine seam (lands independently; valuable regardless)

- Extract **`TurnEngine`** from `world.ts`: `plan(intent, view) →
  EffectTranscript` and `apply(state, transcript)` — the interface
  `shadow-turn-call.ts` (which already accepts only a `PlanningWorld`)
  points at. Honest scope (verified): world.ts runtime-imports **nine** v2
  modules (`world.ts:31-58`), and the recorder/transcript hooks are threaded
  **inline** at ~100 call sites (51 `turnRecorder`/`activeTurn`, 26
  `shadow-commit-scope` calls, 19 `recordProjectionWrite`) — so the seam is
  an **injected `TurnEffects` interface** the mutation paths call, not a
  wrapper file around imports. v2 supplies today's implementation of that
  interface and keeps running unchanged; `src/net/` supplies the other.
- Do **not** extract the ~90-method VM builtin surface (stage 4 §4.5): the
  VM + world object model travel together as the engine. E4 decomposition of
  world.ts into modules continues later, off this critical path.
- **Exit gates:** `npm test`, `npm run test:full`, `test:worker` green;
  new guard: `world.ts` has **zero direct imports of any of the nine v2
  modules** (`shadow-*`, `authority-slice`, `projection-delta`,
  `turn-recorder`, `turn-key`, `effect-transcript`, `planning-world`,
  `remote-bridge-transcript-policy`) — all effect flow goes through the
  injected `TurnEffects` interface (guard added to `npm test` per the
  curated-gate rule).

### Phase 2 — The coherence layer, host-agnostic (the core build)

- Implement `src/net/` per §3.4 with **InProcessHost only**.
- **Port the v2 validation test corpus first** (the tests under
  `tests/worker/` that encode VTN8 semantics, cost budgets, idempotency,
  supersede) — they are the most valuable salvage from the old layer; the
  new modules are built red-to-green against them.
- **Differential gate:** run the shared smoke scenario
  (`scripts/smoke/scenario.ts` — unchanged, per smoke discipline) through
  both v2 (fake lane) and `src/net/` (InProcessHost) and compare committed
  world states and observation streams turn-by-turn.
- Enforce as unit gates from day one: envelope < 64/256 KB, ≤ 8 scope-row
  writes, ≤ 3 host RPCs, 0 reconstructions, lineage-closure
  serialization property, named-copy registry (a test that greps/introspects
  for storage writes outside the four stores).
- **Exit gates:** scenario green in-process; differential parity; budget
  gates green; conformance corpus untouched and green.

### Phase 3 — CF hosts + the proving harness (before any deploy)

- `GatewayDO`, `ScopeDO` as thin shells over `src/net/` (WorkerdHost);
  evolve `DirectoryDO` in place; wire KV seeds. New wrangler bindings
  (`GATEWAY`, `SCOPE`) added alongside the old classes via
  `npm run cf:migrations` (a Cloudflare-DO-class migration per the AGENTS.md
  table; old classes are *not* removed yet).
- Build the **multi-DO workerd harness** (CA14.15, finally): real workerd
  via `wrangler.smoke.toml`, plus **fault injection at the Host seam**
  (reusing `rpc-fault-inject.ts` patterns): injected RPC latency (100 ms,
  1 s), DO eviction between turns, cold-owner timeout, fanout redelivery.
- Build the **aged-world lane** (E3): construct a world *through history*
  (install catalogs vN, play the scenario, upgrade to vN+1, replay), then
  run the scenario. This is the gate class that would have caught every
  deploy-only failure on record (stage 3 §3.4).
- **Exit gates:** all lanes green *including* fault and aged-world lanes;
  SLO structure gates met in workerd under 100 ms injected RPC latency;
  a parked task survives DO eviction and resumes via the scope alarm in the
  fault lane; `smoke:cf-dev` runs the new path.

### Phase 4 — Transports and client cutover

- MCP/REST/WS adapters onto `submitTurn` (one primitive; `dev-v2-helpers.ts`
  and the three drifting call sites retire). `mcp/host.ts`/`mcp/server.ts`
  shells kept; `mcp/gateway.ts` planning content moves into `plan.ts`; the
  MCP tool-surface projection moves onto `tool-surface.ts` (copy #2) — it is
  a read subsystem in its own right, not part of the turn adapter.
- `client-feed.ts` + echo overlay replaces the `v2-browser-*` stack; the
  framework's observation reducers are re-pointed (chat dual-list stays,
  gains the guard from handoff §6.6).
- **Exit gates:** e2e (Playwright) green including the cross-user
  pinboard/outliner sharing case (the known browser-side gap — fix it here,
  in the new feed, not in the old code); localdev/browser parity gates.

### Phase 5 — Deploy, prove, delete

- Deploy to a **fresh namespace** (staging env in `wrangler.toml`, then
  production worker). Install the world from catalogs. **No world-state
  migration, but a mandatory identity/credential carry-over** with the
  following export schema (`identity-export.json`, script + vitest coverage,
  idempotent per the migration rule):
  - **`api_keys`**: the `$system.api_keys` map verbatim — hashed records
    `{hash, salt, actor, label, created_at}` (`world.ts:2587,2613`),
    including the backup-wizard key and every key external plugs
    authenticate with.
  - **The reachable identity actor graph**, because apikey records point at
    actor *objects* that do not exist in a fresh catalog install: every
    `$account` instance, and every `$actor` descendant referenced by an
    apikey record or an account binding — including Hermes-provisioned
    agents (`connectHermes` → `createAgentForHuman`, `world.ts:2815`). Each
    exported object carries: **its original object id** (imports re-create
    with the same id so apikey `actor` refs stay valid — no ref rewriting),
    parent *class name* (resolved against the freshly installed catalogs at
    import), owner, permission/deactivation flags (`actorCanAuthenticate`
    inputs), and a **closed allow-list of identity properties** (`name`,
    `account`, `created_via`, `profile_id`, password/verifier props on
    accounts, `last_seen_at`). Nothing else — inventories, locations, and
    world furniture are deliberately not carried; imported actors rehome to
    the catalog-defined start location.
  - **Import verification**: after import, every `api_keys[*].actor`
    resolves to a live `$actor` descendant and every actor's `account`
    resolves; any dangling ref fails the import (abort, not warn).
  - **Bearer tokens are dropped — decided, not ambiguous**:
    `$system.bearer_tokens` records carry a 60-minute TTL
    (`issueBearerToken`, `world.ts:2836+`), so there is nothing durable to
    preserve; humans re-authenticate by password, agents/plugs by carried
    apikey. `$system.bearer_tokens` starts empty in the new namespace.
  - Anything else worth carrying goes through a one-off catalog export —
    otherwise explicitly reset, and the reset inventory is written down
    before the cutover is approved.
- **Cutover protocol** (the bake alone is not a plan; this is the sequence):
  1. Announce a maintenance window. **Write-freeze old prod** for the
     window: mutating turns and identity operations (mint/rotate/register)
     are refused with a named maintenance error; reads may continue. The
     freeze is what makes "no delta replay" sound — there is deliberately
     no delta-replay mechanism.
  2. Final `identity-export` from frozen old prod → import into the new
     namespace → import verification passes (counts reported, zero dangling
     refs).
  3. Prove the new namespace *before* any traffic moves: deployed
     walkthrough + an auth check that logs in with a carried apikey and a
     carried account password.
  4. **Route switch**: move the public hostname to the new worker. Switch
     the DNS/route itself — do not 308-redirect (WS clients cannot follow
     redirects; see the woah→woah1 incident).
  5. Postflight per the adopted rule (walkthrough + tail-metric thresholds
     over a defined window, §2 SLOs).
  6. **Rollback rule**: old prod stays deployed and frozen through the bake.
     Rollback = switch the route back and unfreeze — nothing else. Identity
     changes made on the new namespace after the switch are lost on
     rollback; accepted, and the window is kept short because of it.
  7. Freeze lifts on old prod only if rolled back; otherwise old prod is
     retired at the end of the bake and the deletion commits proceed.
- Postflight per the adopted rule: deployed walkthrough **+ tail-metric
  thresholds over a defined window** (thresholds now enumerated: turn p50/p95
  per §2, repair attempts = 0 warm, taxonomy-code counts, RPC timeouts = 0).
- Bake period with both workers live (old prod untouched as rollback).
- **The deletion commit(s):** remove `shadow-*`, `authority-slice`,
  `effect-transcript` (superseded by `transcript.ts`), `commit-scope-do.ts`,
  the v2 share of `persistent-object-do.ts` (remaining non-v2 utilities move
  to GatewayDO/admin), `v2-browser-*`, `dev-v2-helpers.ts`, all 12
  `WOO_V2_*` flags, the old DO classes (second `cf:migrations` tag), and the
  v2-only test files. Add a grep-guard forbidding the deleted vocabulary.
- **Exit gates:** deployed SLO table measured green; old worker retired;
  **B10 is done** — the compensating-mechanism ladder no longer exists.

---

## 4.6 The divergence taxonomy (E2, shipped as `errors.ts` in Phase 2)

Every retryable/terminal condition in the layer is one of a closed enum, each
with a defined recovery action; "unnamed divergence" cannot be emitted:

`E_STALE_HEAD` (refetch head, retry) · `E_STALE_EPOCH` (reseed copy, retry) ·
`E_MISSING_STATE` (acquire closure, retry — VTN10.1) · `E_READ_VERSION`
(re-plan) · `E_SCOPE_SPLIT` (two distinct *shared* scopes in one write set —
named limitation, terminal; the CA3 ride-along case is NOT this) · `E_LINEAGE`
(cannot occur post-§3.5.3; assert) · `E_BUDGET` (repair budget exhausted,
terminal, carries the attempt trace) · `E_SEED_LAG` (KV behind scope head;
informational). Terminal codes are user-visible; retryable codes are turn
mechanics. Tail metrics count by code.

---

## 5. What is explicitly kept from v2 (salvage list)

- The **EffectTranscript schema** and **VTN8 validation order** — as spec,
  re-implemented.
- The **validation/cost/idempotency test corpus** — ported first (Phase 2).
- **KV seed, durable outbox, head-freshness retry** — as designed components.
- The **shared smoke scenario** and three-lane ladder — as process, with two
  new lanes (fault, aged-world).
- `DirectoryDO` — evolved in place.
- The **C4 load gate** — kept as the CA12.1/CA13 tripwire.

## 6. Risk register

| # | Risk | Mitigation |
|---|---|---|
| R1 | Subtle validated behavior hiding in `shadow-turn-exec`/`shadow-commit-scope` (4.3k) beyond the test corpus | Port corpus first; **differential gate** in Phase 2 runs old and new side-by-side on the scenario + property-fuzzed turns and diffs verdicts/state |
| R2 | Phase-1 unthreading destabilizes local modes | Phase 1 lands alone, full gates; it is an E4 down payment with standalone value |
| R3 | Two-system window drags | v2 frozen (no state-path deploys — already the standing verdict); phases are independently landable; the differential gate keeps drift visible |
| R4 | Cold-start physics reasserts itself as new band-aids | Cold path is *designed* (§3.5.4/.6): named copies, named codes, KV seed first-class; cold SLO (<3 s) measured in the fault lane |
| R5 | Scope=home conflation breaks for some object class | It is the existing anchor-cluster/CA6 model; `route.ts` isolates selection so CA10 migration slots in without pipeline change |
| R6 | Echo overlay under-delivers vs the old optimistic VM | The old optimistic path was never enabled on CF and had a known silent-drop defect — there is no working baseline to regress; echo is strictly simpler and rebased on truth |
| R7 | New-namespace deploy loses identity/credential or other non-catalog state | **Confirmed real, not hypothetical**: accounts/apikeys/plug credentials live under `$system`. Mitigated by the mandatory Phase-5 identity export/import (scripted, idempotent, vitest-covered); remaining reset inventory written down and approved before cutover |
| R8 | Scheduled/parked-task semantics regress at cutover (the old worker never implemented alarms, so no production baseline exists) | Scope-anchored alarms are a Phase-2 module with fault-lane coverage (eviction + resume); local modes exercise parked tasks today, so `test:full` guards the semantics |

## 7. Explicitly out of scope (named, not silently dropped)

- **CA10 per-cell authority migration / route-home shards** and **CA13
  hot-room sharding** — the growth path past tens-per-room; `route.ts` is
  shaped for them; C4 tripwire decides when.
- **E4 full decomposition of `world.ts`** beyond the TurnEngine seam.
- **Catalog authoring on-ramp** (`.woo` files, export/publish) — handoff
  Tier 3; unchanged priority, different track.
- `$player:join_player` woocode migration, layering-guard ratchet, curated
  test-list promotion mechanism — Tier-3 ratchets; the new-layer guards added
  here don't replace that work.

## 8. Decisions requiring the owner's veto before Phase 5

1. **Fresh-install with identity carry-over** (§4 Phase 5): world state is
   reinstalled from catalogs; the identity export (apikey map + reachable
   identity actor graph with preserved object ids) is imported and verified;
   **bearer tokens are dropped** (60-min TTL session records — humans
   re-login, agents/plugs use carried apikeys); everything else resets, per
   a written inventory approved before cutover; the cutover itself follows
   the write-freeze protocol (no delta replay by design).
   — **APPROVED 2026-07-05.**
2. **v2 freeze** including no further v2 state-path deploys during the
   build. — **APPROVED 2026-07-05.**
3. New DO bindings/classes and eventual removal of the old three.
   — **APPROVED 2026-07-05.**
4. Committed ceiling "tens of concurrent actors per room" stated in spec.
   — **APPROVED 2026-07-05.**

All four decisions were approved by the owner on 2026-07-05. This plan is
registered for execution as `plans/002-simplest-deployable-system.md`;
everything else follows the already-ratified record (stage 3).

## 9. Revision log

**Rev 2** — after an adversarial verification pass against the repo, which
refuted parts of rev 1 and confirmed the rest (the engine/distribution seam,
substrate portability, citations, and AGENTS.md-discipline compliance all
held). Fixes applied:
1. "Prod carries demo-grade state only" was **false** — identity/credential
   state lives under `$system`; Phase 5 now mandates a scripted identity
   export/import (was: optional escape hatch).
2. `E_SCOPE_SPLIT` as written **contradicted ratified CA3** — the plan now
   adopts CA3's planning-scope ride-along for room-writing movement and
   reserves `E_SCOPE_SPLIT` for the genuinely disjoint two-shared-scopes
   case.
3. Copy registry grew from four to **five** (Directory session/presence
   projection is a real materialization, not a route hint) and copy #2 now
   explicitly includes the MCP tool-surface projection (PC1).
4. **Durable continuations** (parked SUSPEND/FORK, scheduled-turn alarms at
   the scope sequencer) added to the essence, the ScopeDO role, `scope.ts`,
   Phase-3 gates, and the risk register — the old worker never implemented
   the alarms, so this is a new obligation, not a port.
5. Phase-1 scope corrected: nine v2 modules, ~100 inline hook sites; the
   seam is an injected `TurnEffects` interface, and the exit guard lists all
   nine modules.
6. The ≤3-RPC budget now explicitly excludes post-reply outbox fanout.
7. `projection-cache.md` mis-path corrected (it lives in `spec/semantics/`).
8. `src/net/` LOC target 8.5k → **9.3k** (alarms + tool-surface).

**Rev 3** — after owner review and approval of all §8 decisions
(2026-07-05). Fixes applied:
1. The identity carry-over is now an executable **export schema**: the
   `$system.api_keys` map verbatim *plus the reachable identity actor
   graph* (accounts, apikey-target actors incl. Hermes-provisioned agents)
   with preserved object ids, class-name parent resolution, flags, and a
   closed identity-property allow-list; import verification aborts on any
   dangling ref.
2. Bearer-token policy made unambiguous: **dropped by design** — the
   records carry a 60-minute TTL (`issueBearerToken`), so there is nothing
   durable to carry; §1 and §8 now say the same thing Phase 5 says.
3. Phase 5 gained a **cutover protocol**: maintenance window with a write
   freeze on old prod (which is what makes "no delta replay" sound), final
   export/import + verification, pre-switch auth proof, DNS/route switch
   (never a 308 redirect — WS clients), postflight, and a rollback rule
   (switch back + unfreeze; post-switch identity changes accepted as lost).
4. Registered for execution: `plans/002-simplest-deployable-system.md`
   added, `plans/README.md` updated (001 closed by supersession; the v2
   freeze recorded as a standing constraint).
5. The 07-04 handoff got a current-state addendum (main `b8e55f9`, deployed
   baseline passed post-cycle per owner review) and its §4 is labeled
   historical.
6. Stage-2's superseded "demo-grade state" conclusion now carries an inline
   SUPERSEDED marker at the conclusion itself, not only the top-of-file
   corrigendum.
