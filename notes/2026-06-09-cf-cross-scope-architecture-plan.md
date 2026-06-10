# Cross-scope turn architecture — the plan to make deployed CF functional

Origin: 2026-06-09, post-B7 deploy analysis. Continues
[2026-06-09-stable-baseline-plan.md](2026-06-09-stable-baseline-plan.md):
its Phase 0 (validation gates) and Phase 1 (line_map + B7 + slim warm
envelope) are landed and deployed (prod 779ef147 / main `9e7edba`). This plan
replaces Phase 1's "re-attribute the remaining wall" step and re-aims Phase 2
with what the post-deploy measurements actually show.

## What the B7 deploy proved

Measurement run `deploy-779ef147-9e7edba-b7-tail-20260609T205833Z`
(history: `.woo/smoke-metrics-history/deploy-history-through-b7-20260609T205833Z`):

- The levers worked where they aimed: warm same-scope turns no longer
  reconstruct (`turn_commit` recon = 0, `warm_turn_refresh` 75 → 10), MCP
  POST p95 −49%, request bytes p95 2.6 MB → 1.76 MB, turn p95 −26%.
- The system is still not usable: turn p50 **5.8 s**, p95 **13.9 s**,
  smoke 8/10 with the same two standing failures, 21% of turns still pay
  repair attempts (avg 1.36, max 4).
- Phase attribution: **submit = 65.8%** of turn wall; inside submit,
  `worker.commit_scope_envelope_rpc` = **80%** (mean 3.8 s, p95 7.2 s per
  call). Authority assembly (the previous target) is down to 15%.

## Diagnosis: one architectural debt, five faces

Warm **same-scope** turns are now near the designed shape (cached authority,
slim envelope, zero reconstructions). Everything still broken concentrates on
**cross-scope turns** — movement and cross-room observation — where the system
still uses the old consistency mechanism: *ship a world snapshot, validate by
re-execution, repair on failure*. The cell-authority model (versioned cells +
provenance + projections, spec/protocol/cell-authority.md) was built around it
but the cross-scope hot path never moved onto it.

The five faces, all measured on the b7-tail run:

1. **Cross-scope commits still haul full authority.**
   `slimMcpEnvelopeBody` (gateway.ts ~955) deliberately excludes
   planned-transcript commits, because the commit scope "validates a
   transcript planned elsewhere" — so every movement turn ships ~1.7 MB and
   pays the 3.8–7.2 s envelope RPC. The five slowest turns are all movement
   verbs; the worst (`the_deck:south`) took 4 attempts / 26.4 s, paying the
   RPC each time.

2. **Derived-scope fanout installs rows without lineage closure.**
   `propagateTranscriptToOtherScopes` (gateway.ts ~1533) applies only the
   transcript delta via `applyAcceptedFrameToDerivedRelayCache`; the moved
   object's class chain ($portable, $note, $chatroom ancestors) never reaches
   the destination shard. Result: `dangling_parent_ref` (544/smoke),
   E_VERBNF/E_OBJNF on anything cross-room. **Smoke failure #1**
   (`the_pinboard:add_note` not reachable — tool surface has only 7 rows on
   the gateway shard) is this face surfacing through tool enumeration. The
   merge-side lineage fill (authority-slice.ts ~630) can't help because the
   fanout source never sends the lineage pages at all.

3. **Synchronous cold-owner RPC inside the turn deadline.**
   A repair pre-plan issued a live `/__internal/authority-slice` RPC to a
   cold `the_taskboard` DO; it timed out at 5 s, fell back to stale state,
   re-entered repair, and the step died at the 20 s MCP timeout. **Smoke
   failure #2** is this cascade. Big-world discipline says a turn must never
   block on synchronously waking a remote DO.

4. **Closed sessions are never pruned from the Directory.**
   `primarySessionForActor` (world.ts ~3394) picks the *oldest* non-expired
   session; closed pooled-guest sessions linger, get picked, and
   `moveto_actor` with `is_primary:false` skips the physical move →
   location/activeScope diverge (the E_PERM warm-pass flake, 5/11
   nondeterministic). The same stale rows inflate write-turn audiences
   (directory lookups average 2.7 sessions for a 2-actor run) and fanout.

5. **CommitScopeDO per-turn waste and unbounded tails.**
   Every envelope merge calls `markShadowBrowserRelaySerializedChanged`
   unconditionally → full O(n) world re-index per turn (known from the
   warm-turn-bounded-commit review, still deployed). Checkpoints run on
   *every* commit — `WOO_V2_CHECKPOINT_BOUNDED` exists but was never enabled.
   `the_chatroom` tail retained 17.6 MB this run (prior baseline ~5 MB).

Faces 1–3 are also why the repair loop persists: 5 `missing_state` repairs
(planning lacked rows fanout should have installed) and 5
`read_version_mismatch` repairs (divergent projections) per 28-turn run.
Repair is not a bug to squash; it is the symptom of cross-scope state not
being delivered by construction.

## Target invariants (gates, not aspirations)

Promote the warm-turn invariants from
[2026-06-09-warm-turn-bounded-commit.md](2026-06-09-warm-turn-bounded-commit.md)
to enforced structural gates, extended to cross-scope:

- Any turn (same- or cross-scope) on warmed shards: `attempts == 1`,
  ≤1 authority call, exactly one envelope, zero
  `authority_slice_reconstructed` with reason `warm_turn_refresh` /
  `missing_state_repair`.
- Envelope request bytes: warm same-scope < 64 KB; cross-scope < 256 KB
  (read-set + transcript + write-set, never authority pages).
- `dangling_parent_ref == 0` across the full smoke scenario.
- No synchronous cross-DO RPC with an unbounded (5 s) timeout inside a turn.
- Sessions in the Directory for a scope ≤ live actors + 1.
- Deployed: smoke 10/10, turn p50 < 2 s, p95 < 4 s.

## Plan

Three tracks. A = correctness (fixes both standing failures), B = the
cross-scope commit redesign (fixes the 66%), C = local provability. Ordering
within and across tracks is the commitment; estimates are rough.

### Track A — Coherent distributed state

**A1. Session lifecycle as first-class state** (small, do first — it is the
prerequisite for trusting any warm-pass measurement).
- Add an explicit `closedAt` marker; prune closed sessions from the Directory
  and shard relay caches on close/expiry (not only on recycle).
- `primarySessionForActor` filters closed sessions; decide and spec the move
  semantics: the session that commits the move is authoritative for the
  physical move (CA8 already made scope transition a first-class transcript
  effect — the `is_primary` skip predates it and should go).
- Gate: 2-actor scenario asserts session count ≤ actors+1 and shard fanout
  bound; warm pass becomes deterministic (kills the 5/11 flake).

**A2. Lineage-closed row installation, one primitive.**
- This is baseline-plan Phase 2.3 (unify appliers) with a sharper contract:
  there is exactly one way to install rows into any relay/projection cache
  (gateway fanout, browser holder-install, state transfer), and that
  primitive *enforces* lineage closure — installing a row whose parent chain
  is absent either carries the closure pages or fetches them, never silently
  dangles.
- Fix at the fanout source: `propagateTranscriptToOtherScopes` includes the
  lineage closure of moved/created objects in what it delivers to affected
  scopes (CA4 durable owner delivery), idempotent on (member,
  location_version); prune membership on session end (joins A1).
- Gate: `dangling_parent_ref == 0` in cf-local and cf-dev smoke; the shared
  scenario gains a **carry-across-rooms** step (scenario.ts line ~160
  currently *deliberately omits* carry — that omission has been hiding face
  2 from every pre-deploy lane) and a tool-surface-after-move assertion
  (pinboard `add_note` reachable from the new room).

**A3. Verify the two deployed failures die.** Deploy after A1+A2 through the
smoke ladder; expect 10/10. If `add_note` reachability needs more than A2
(tool-surface enumeration has its own path), fix it inside the same projection
pipeline, not as a gateway special case.

### Track B — Bounded cross-scope commit (the structural perf fix)

**B-i. Read-closure envelopes for planned-transcript commits.**
Commit validation today is `validateTranscriptWithCellReader` against the
relay state the envelope's authority merge just built
(`shadow-commit-scope.ts` `submitShadowCommit` ~295) — the transcript
already carries the read-set (that is where `mismatched_read_cells` comes
from). So the validator does NOT need the scope-wide slice; it needs exactly
the cells the transcript touched. The change: the envelope's authority is
restricted to the **transcript's read/write closure plus lineage** — the id
set the executor already computes and merges into the payload
(`executor.ts` ~851) — and nothing else. The validation contract, repair
replies, and trust model are unchanged; only the unread bulk of the slice
stops shipping. (A version-only attestation envelope — no pages at all —
would change the trust model for foreign cells and is explicitly NOT this
step.) Flag-gated (`WOO_V2_READ_CLOSURE_ENVELOPE`), spec'd in
cell-authority.md (CA3/CA11) before code.
Validation gate: **shadow parity** — in cf-local and cf-dev, build both
envelope shapes per turn and assert the commit verdict (accept/reject +
reason + mismatched cells) is identical before the flag ever ships; plus the
byte ceiling (cross-scope envelope < 256 KB).
Expected effect: envelope RPC payload 1.7 MB → tens of KB; the DO-side merge
and O(n) re-index shrink proportionally.

**B-ii. No synchronous cold-owner wake inside a turn.**
Cold owner state comes from the durable checkpoint/KV seed (the cold-start
machinery that already solved gateway cold-open), not a live 5 s
authority-slice RPC mid-repair. Give the whole repair loop a turn deadline
budget so a slow dependency degrades to one clean retryable error instead of
a 20 s cascade. Gate: fault-injected cold owner (see C1) yields a bounded,
single-attempt failure, not a timeout cascade.

**B-iii. Incremental relay merge.** Stop the unconditional
`markShadowBrowserRelaySerializedChanged` O(n) rebuild; re-index only rows
the merge actually changed; no-op merges mark nothing. (Mostly subsumed by
B-i for the commit path, but the same call sites serve fanout receipt.)

**B-iv. Storage hygiene.** Enable `WOO_V2_CHECKPOINT_BOUNDED` once B-i/B-iii
make its effect measurable; add a tail size budget + prune policy (chatroom
17.6 MB retained is unbounded growth, not steady state).

### Track C — Make it provable before deploy

**C1. Fault injection, split to de-risk the schedule.**
- **C1a (required before the Track B deploy): RPC-seam fault injection** in
  the workerd lane — latency, timeout, and kill injection on the three
  routes that matter (`/__internal/authority-slice`, `/v2/envelope`,
  `/__internal/mcp-commit-fanout`). Fault-injection plumbing partially
  exists (the stable-baseline review found it built but the authority-slice
  path uninstrumented); this finishes that seam. It is enough to validate
  B-ii (cold-owner degradation is bounded) and D1 (crash-window
  convergence).
- **C1b (follows, not blocking): the full multi-DO harness** with per-DO
  storage isolation and cold-start simulation — the CA14.15/CA16
  prerequisite for the Phase-5 scale work.

**C2. Bounded-turn structural gate** in cf-local and cf-dev (the invariants
above, including the byte ceilings and `dangling_parent_ref == 0`), wired
into `npm test`'s guard set so a regression fails before any deploy.

**C3. Scenario coverage**: carry-across-rooms, verb-on-carried-object,
tool-surface-after-move, 2-actor session-count bound — all in the *shared*
scenario so all three lanes exercise them.

**C4. Load gate.** N actors (10–20) in one room issuing concurrent
chat/move turns in cf-dev, measuring commit conflict rate, retry storms, and
p95 under contention. Nothing today measures more than 2 actors. This gate
is also the *decision input* for CA12.1: OCC read-set commits over today's
coarse `object_live` cells will false-conflict (unrelated writes share a
cell version); if the load gate shows conflict storms, CA12.1 (cell split)
stops being deferred and becomes the next lever. Deferring it is correct
only while measurement says contention is low.

### Track D — Perceived latency (what "performant" needs beyond Track B)

Track B bounds the commit; these bound what users actually *feel*: the
actor's reply, the peer's view, and the browser's room switch.

**D1. Take peer delivery off the caller's reply path.**
The envelope hook awaits `deliverV2Fanout` before returning the actor's
reply (`persistent-object-do.ts` ~1755): mean 533 ms, p95 2.3 s of every
turn is spent delivering observations to *other* shards before the actor
hears their own result. Commit durability must precede the reply; peer
fanout must not. Move delivery after the reply, with ordering preserved by
the existing sequenced drain (`durableProjectionHeadSeq` fallback already
sequences out-of-order arrival). Durability requirement: reply-then-deliver
opens a crash window (DO eviction between reply and fanout), so delivery
must be **tail-driven** — an outbox drained from the persisted relay tail
(the `v2_relay_tail` persist-before-ack machinery from e7b3daa), redelivered
idempotently on rehydrate — not a best-effort `waitUntil`. This also
decouples actor latency from audience size — a CA13 prerequisite.
Gates: peer-visible latency in the scenario (observation arrival at the
second actor) < 1 s while actor reply time stops varying with audience; and
a C1a kill-injection between commit and delivery showing peers still
converge after the DO rehydrates.

**D2. Per-turn cross-host RPC budget.**
The b7-tail run spends ~8 cross-host RPCs per turn (225/28: ~2.3 directory
session lookups, ~1.1 enumerate-tools tool-surface refreshes, envelope,
fanout). After B-i the envelope is cheap but the chatter remains, and each
RPC is a potential cross-colo round trip. Directory session lookups should
ride the presence relation rows the projection pipeline already delivers
(A2), and tool-surface refreshes ride fanout deltas instead of polled
enumerate-tools. Gate metric: warm-turn cross-host RPC count ≤ 3.

**D3a. Browser optimistic execution is OFF on CF — enable and validate it.**
The B9 holder machinery is fully implemented (local plan/execute in
`v2-browser-worker.ts:1219` `sendLocalTurnExec`, optimistic frame render in
`main.ts:716` `receiveOptimisticResultFrame`) and is why localdev feels
responsive: the dev server sends browser-profile replies unconditionally
(`dev-v2-helpers.ts:596`). On CF, `receiver_profile: "browser"` is gated by
`WOO_BROWSER_PROJECTION_HOLDER` (`persistent-object-do.ts:4588/4742`), which
is set in NO deployed or smoke config — only `cf-repository.test.ts:1834`
exercises it. Without it the open/state transfer carries no cell provenance;
the local planner (`v2-browser-local-turn.ts:84`,
`enforceMissingProvenance: true`) rejects every cell, and each turn silently
posts `local_turn_fallback` (`v2-browser-worker.ts:1298`) and waits on the
server round trip. So the deployed browser shows zero optimism by
configuration, not by breakage — but flipping the flag is NOT the whole fix:
1. the CF browser-profile path has never been validated end-to-end (the
   parity fix in f86a2b0 covered the dev server; cf-dev smoke runs with the
   flag off) — enable it in `wrangler.smoke.toml` first and add a
   browser-against-workerd lane assertion that an optimistic frame renders
   before the committed reply. That lane does not exist today (e2e runs
   Playwright against the vite dev server only) — building
   Playwright-against-`wrangler dev` is part of this item, not assumed;
2. once on, cross-scope state will still hit the A2 lineage/provenance gap
   (the same root as the smoke failures) and fall back for exactly the turns
   that are already slowest;
3. durable cross-room moves stay commit-confirmed by design
   (`v2TranscriptSupportsProposalProjectionOverlay` requires moves to stay
   in scope) — acceptable, but it means movement feel depends on Track B,
   not on optimism.
Gate: deployed browser shows optimistic render for same-scope live + durable
verbs; `local_turn_fallback` rate is a tracked metric, near-zero warm.

Wave-1 findings recorded for this item (2026-06-09, D3a lane build):
- **Confirmed silent-drop defect**: `sendEncoded()` in
  `src/client/v2-browser-worker.ts` (~1945) is a silent NO-OP when the WS is
  not OPEN — the turn persists to IDB but no pending-turn timer starts, no
  error surfaces, and recovery waits for the next reconnect + state transfer
  (15–120 s cold). This is the concrete mechanism behind "commands vanish";
  fixing it (queue-with-timer + user-visible failure line) is the first
  Phase-4/failure-UX work item and is independent of the holder flag.
- **Flag-off optimism observed**: two optimistic `render_frame` events fire
  per turn on CF without the holder (planning-step frames, no id-matched
  committed counterpart). Wave-3 flag-enable starts by identifying which
  path admits these (self-certified session stubs vs a provenance-gate
  bypass) before trusting the holder.

**D3. Browser scope hydration.**
The browser's perceived performance is optimistic echo (already instant)
plus scope-open hydration — and opening a scope against CF pays a
multi-second state-transfer seed (the note-text investigation measured
~4.9 s live-read lag capped by relay scope-open; the localStorage display
cache fixed notes only). Structure-first hydration: lineage + listing rows
render immediately, payload cells (note text, board content) stream on
demand; cached seeds revalidate by cell version instead of re-transferring.
Gate: browser room/tab switch perceived < 1 s; cold app open < 3 s.

### Sequencing

1. **A1 + C2 skeleton** — small, unblocks deterministic measurement.
2. **A2 + C3** → smoke ladder → deploy → expect 10/10. (Correctness first;
   it also removes the `missing_state` half of the repair loop.)
3. **B-i + B-ii** behind flags → shadow-parity gate + C1a fault seams
   validate → smoke ladder → deploy → measure. This is the latency headline.
4. **D1 + D2** — D1 is independent of B-i and can land in parallel with
   step 3; D2's directory/tool-surface consolidation depends on A2's
   pipeline.
5. **B-iii + B-iv** after re-measurement (instrument-first rule: confirm the
   envelope RPC residue before optimizing DO CPU).
6. **C1a** starts in parallel with step 2; must be in place before step 3
   deploys. C1b follows without blocking. **C4** runs once steps 3–4 are
   deployed; its result decides whether CA12.1 gets pulled forward.
7. **D3** is browser-lane work, parallelizable with all of the above.

### Is the result performant and scalable? — honest bounds

What the architecture supports after this plan, and where the ceilings are:

- **Actor-visible latency floor** (warm): planning is local to the gateway
  shard (≈0), one slim envelope RPC to the CommitScopeDO, bounded directory
  reads — low hundreds of ms, cross-colo RTT included. The p50 < 2 s target
  is the *functional* milestone; nothing structural prevents
  same-scope < 500 ms and cross-scope < 1 s once B-i + D1 + D2 land. If
  measurement after step 4 shows otherwise, the residue is a new diagnosis,
  not a tuning pass.
- **Peer-visible latency**: post-D1 it is fanout-only (sequenced drain,
  shard-count bounded per CA13.1), target < 1 s.
- **Scale across rooms**: DO-per-scope with no global enumeration — this is
  the big-world shape and it scales horizontally. Cold scopes are KV-seeded,
  not synchronously woken (B-ii).
- **Scale within a room** is the known ceiling: one CommitScopeDO
  serializes a room's commits. That is the MOO consistency model, and it is
  fine for tens of concurrent users per room; the levers when a room runs
  hot are CA12.1 (stop false conflicts), CA7 (room-anchored sequencing for
  set invariants only), and CA13.2/13.3 (speech off the sequencer, fanout
  sharding). C4 is the tripwire that says when those stop being deferred.
- **Browser**: optimistic echo already makes own-actions instant; D3 makes
  room entry/tab switch instant-feeling; commit confirmation and peer
  updates ride the same Track B/D path as MCP, so the browser inherits
  every server-side win.

### Explicitly out of scope (unchanged from baseline Phase 5)

CA10 route migration, CA7 room-anchored sequencing, CA12.1 cell-keyed
storage split, CA13 full hot-room sharding, browser failure-UX (baseline
Phase 4) — scheduled after the above; none of them block "functional".

## Execution model: parallel implementation pieces

The per-item gates make most of this plan implementable as parallel,
worktree-isolated pieces by smaller-model agents: acceptance is mechanical
(a gate passes or it doesn't), not judgment-based. Three rules govern the
split:

1. **Design-first items**: B-i (the CA3/CA11 envelope spec + parity-harness
   shape), D1 (the tail-driven delivery/redelivery contract), and A2 (the
   unified install-primitive contract) each need their spec/contract
   authored and reviewed *before* implementation is delegated. The design is
   senior work; the implementation against a written contract with a
   mechanical gate is not.
2. **Not for autonomous delegation**: A2b (applier unification — structural
   surgery on the highest-regression surface; implement under close review,
   small steps) and the debug-what-falls-out half of D3a (first-ever
   validation of the CF browser-profile path is open-ended diagnosis, not a
   scoped task).
3. **Partition by file surface** to keep worktree merges trivial; integration
   is serialized through the smoke ladder anyway (deploys are one at a time).

| Wave | Piece | Surface | Delegable? |
|---|---|---|---|
| 1 | A1 sessions | `world.ts` session paths | yes |
| 1 | C1a fault seams | test infra, RPC seam hooks | yes |
| 1 | C2+C3 gates + scenario (one piece — same files) | scenario, guards | yes |
| 1 | D3a lane build (Playwright vs `wrangler dev`) | e2e infra | yes |
| 1 | B-i spec + parity harness design | spec/ | design-first |
| 2 | B-i implementation vs spec | executor, gateway, commit-scope-do | yes (parity gate) |
| 2 | A2a fanout lineage closure | gateway fanout, relay merge | yes (dangling gate) |
| 2 | D1 design, then implementation | persistent-object-do, relay tail | design-first |
| 3 | B-ii deadline budget + cold-seed reads | executor repair loop | yes (C1a gate) |
| 3 | B-iii incremental merge | commit-scope-do (after B-i — same files) | yes |
| 3 | A2b applier unification | relay-cache/holder-install | close review |
| 3 | D2, B-iv, C4 | metrics, config, scenario | yes |
| 3 | D3a flag-enable + diagnosis | browser + worker | diagnosis: no |

Standing rules for every delegated piece: work in
`.claude/worktrees/<task>/`, test-first against the piece's gate, register
the gate in the curated `npm test` list, and a senior review pass before
merge (per the project quality bar, code is not ready until reviewed).

## Risks and rules

- **B-i narrows the envelope payload, deliberately NOT the validation
  contract** — the read-closure scoping keeps `validateTranscriptWithCellReader`
  semantics byte-identical, and the shadow-parity gate proves it per turn
  before the flag ships. It still lands spec-first, flag-gated; rollback is
  the flag.
- **A2 touches the applier-unification area** the baseline plan marked
  highest-regression-risk; it lands only after the Phase 0 gates (already on
  main) plus C2/C3, never before.
- **Every new gate must be registered in the curated `npm test` list** (or
  a guard script it runs). The curated gate is a fixed file list; a gate
  that only exists under `test:full` does not hold the line (this has bitten
  twice: dev-v2-commit staleness, shadow-browser-node changes).
- **Deploy postflight is part of every deploy step**: after each prod
  deploy, run the walkthrough, then watch tail metrics against explicit
  thresholds (turn p95, repair attempts, reconstruction count, RPC
  timeouts) for a defined window before calling it good. The 555f9935
  regression shipped because postflight was a smoke pass alone.
- A2's receiver-side lineage fetch fallback must be async/bounded repair,
  never a synchronous in-turn RPC (consistent with B-ii).
- Worktree isolation per task; smoke ladder before every deploy; no deploy
  without explicit instruction. Current prod rollback target: 779ef147.
- Honest-measurement rule stands: after each deploy, re-attribute before
  pulling the next lever (the per-deploy comparison tooling,
  `scripts/smoke-metrics-history.mjs`, is on main); do not claim a lane
  catches a failure it demonstrably passes.
