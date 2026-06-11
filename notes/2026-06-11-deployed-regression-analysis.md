# Deployed regression analysis — main e573626 on woah1 (2026-06-11)

Constrained direct analysis after two walkthrough runs (4/11 failing, stable).
Evidence: /tmp/woo-deploy-smoke.log (run 1, full error payloads), /tmp/walk2.log
(run 2). No server-side tail was capturable (wrangler tails API auth error
10000 — the deploy credential lacks tail scope; ADMIN_PASSWORD not available
locally) — verdicts below are from client error payloads + code reads, with
the one remaining unknown named explicitly.

## Failure attribution (corrected)

### 1+2. Outliner steps — NOT a code regression: old-world catalog state
Both `outliner roster after movement` and `outliner:add_item reaches peer`
fail identically:

    E_OBJNF "object not found: exit_living_room_outline"
    trace: obj=the_chatroom verb=go definer=$room progr=guest_* pc=26 version=2

`$room:go` (verb VERSION 2 — i.e. updated in place by catalog bundle repair)
resolves the exit instance `exit_living_room_outline`, which does not exist
in the deployed long-lived world. Catalog upgrade repaired the VERB but never
created the INSTANCE. Every fresh lane auto-installs current catalogs, so the
exit always exists there; these walkthrough steps are new coverage (tool-space
movement model), so they never ran against prod before. Users were not
regressed by this deploy — the walkthrough grew eyes for a pre-existing
old-world gap.

**Fix**: idempotent bootstrap local-boot migration (AGENTS.md migration table,
"cold-init repair of seed or bundled-catalog state") that creates missing seed
exit instances (and audits other catalog seed instances) recorded in
`$system.applied_migrations`. Test-run on local SQLite per the rules.

### 3. tasks cross-room `entered` — A2a verified working; next-layer defect
Pre-deploy this step died in PLANNING (E_VERBNF, the lineage gap). Now:

    E_RETRY "v2 commit accepted but object-host projection write-through
             failed: object not found: guest_111"  (value.scope=the_chatroom)

The commit is ACCEPTED — the A2a lineage fix demonstrably works in prod. The
failure moved downstream: the synchronous write-through fan-out
(`writeThroughProjectionWritesToObjectHosts` → `/__internal/apply-v2-commit`)
hits a receiving host whose world strictly resolves `guest_111`
(world.ts:1140 `object()`) and lacks the actor's object ROW. A2a delivers
CLASS lineage closure, not ACTOR INSTANCE rows; fresh worlds always seed the
actor row before any such apply, old sparse host worlds may never have
received it. Code reads show the obvious receive paths are tolerant
(`applyProjectionWrites` contents repair, `applyCommittedShadowTranscriptToHost`
— both use `objects.get`), so the strict resolve is in a subpath
(candidates: live routing `acceptRemoteV2Live → routeLiveEvents` audience
resolution; gateway projection-cache apply; tool-surface upsert).
**Unknown**: the exact throw site — needs ONE server-side stack.

**Fix direction** (after the stack pins it): either include moved/affected
actor instance rows in the forward for hosts that lack them (mirroring the
A2a lineage rule, one level up: instance completeness), or make the receiving
strict path a repairable tolerate+async-fetch (consistent with the B-ii rule:
no hard failure on rows the host can repair out-of-band). The write-through's
E_RETRY contract must stay (durability), so receiving-side tolerance is the
likelier principled shape.

### 4. pinboard:add_note reaches peer — 20s MCP timeout, pre-existing
Uncharacterized this round (requires tail/metrics). Hypotheses (untested):
cold tool-space DO first-touch exceeding the budget chain; or the same
missing-instance class as #1/#2 manifesting as a hang rather than a throw.

## Evidence-channel gaps (operational findings)
- `wrangler tail` fails auth (code 10000) with the deploy credential —
  tail scope missing. Fix the token scope or `wrangler login`; without it,
  deployed analysis is client-payload-only.
- `/admin/series` (AE metrics) requires ADMIN_PASSWORD, not available in this
  environment. Either provision locally or this channel stays closed.

## The fidelity-ladder gap (the lesson that prevents recurrence)
Every pre-deploy lane installs FRESH current catalogs. Both deployed-only
failure classes here are old-world interactions: (a) catalog-upgraded verbs
referencing instances that old worlds lack; (b) sparse host worlds lacking
actor instance rows that fresh worlds always have. A **stale-world lane** —
boot workerd from a snapshot of the production world image (or: install
catalogs@previous, upgrade to current, then run the scenario) — would have
caught both before upload. This is the highest-value new gate identified by
this deploy cycle.

## Recommended order
1. Fix tail auth (small, unblocks everything else).
2. Bootstrap migration for missing seed instances (fixes outliner pair;
   test-run on SQLite; idempotent).
3. One tailed walkthrough run → pin the guest_111 throw site → receiving-side
   tolerance fix for actor-instance gaps.
4. Characterize the pinboard timeout with the same tail.
5. Build the stale-world lane (catalogs@N-1 → upgrade → scenario) as a
   pre-deploy gate.

## UPDATE (same day): tailed run pins the remaining mechanisms

Tail auth root-caused (not scope: smoke-with-tail.sh required pre-exported
CF env while deploy.sh self-sources ~/.config/generalbusiness/cloudflare_woo.env;
script now self-sources too — commit 0a37712 on main). Tailed run
.woo/smoke-measurements/20260611T112824Z-7428 (3594 metric events):

- **pinboard:add_note PASSED this run (48s)** — the timeout is marginal
  cold-latency, not deterministic. Watch, don't chase yet.
- **outliner pair: deterministic, identical E_OBJNF exit_living_room_outline**
  — old-world missing seed instance confirmed. Fix unchanged: bootstrap
  local-boot migration.
- **tasks cross-room: PINNED.** Client error is now `E_REPAIR_BUDGET` (B-ii's
  bounded error — the 20s transport cascade is gone, working as designed).
  The tail shows the non-converging loop precisely (364 guest_111 events):
  relocation commits at scope=guest_111 rejected `read_version_mismatch` with
  `$exit:invoke` / `$exit:move` read at version **1** while actual is **2**,
  on EVERY attempt. The deployed catalog repair bumped $exit verbs to v2; the
  gateway's planning keeps re-reading v1. Code-level cause: the B-ii KV-seed
  serve decision (persistent-object-do.ts ~5670) gates only on
  owner-required — it does NOT honor the B7 rule "never serve cached
  authority on a repair attempt" (implemented for the relay warm cache in
  gateway.ts, absent from the new KV path). Stale pre-repair KV seed pages
  ($exit v1) re-enter planning on each retry, displacing the repair install,
  until E_REPAIR_BUDGET. A `host_seed_kv_restore_miss reason=hash_mismatch`
  event (the_horoscope) shows the KV layer validates payload integrity but
  nothing invalidates seeds that are merely OLD.

### Fix items (precise)
1. **B-ii follow-up (code defect, small)**: thread the repair-attempt context
   into the KV-seed serve decision; `attempt > 0` (or missing_state_repair /
   post-conflict refresh) must skip KV exactly as the warm relay cache does.
   Test: forced read_version_mismatch with a stale KV seed converges in ≤2
   attempts instead of exhausting the budget.
2. **Seed hygiene (old-world)**: invalidate/regenerate host-seed KV when a
   catalog bundle repair bumps verb versions (invalidateHostSeed exists);
   otherwise long-lived worlds serve pre-repair pages indefinitely on cold
   paths even outside repair loops.
3. **Bootstrap migration** for missing seed instances (outliner pair),
   unchanged from the original recommendation.

## UPDATE 2 (post-fix deploy #3): the unified root cause

Deploy #3 shipped the three fixes; walkthrough still 6/10. Live probes
(wizard MCP + tailed reproduction of a single `look exit_living_room_outline`)
pin the real mechanism:

- Prod HOST_SEED_KV is EMPTY (0 keys) — the KV-stale-seed theory was wrong;
  Fix 1's gate is correct but irrelevant to this incident.
- The migration RAN: the world host now has exit_living_room_outline
  (planning resolves it). But the look loops `missing_state` on
  `read:cell:lifecycle:exit_living_room_outline` at commit scope
  the_chatroom: **the chatroom CommitScopeDO's durable world predates the
  migration and lacks the instance**; commit validation (correctly, per its
  own state) rejects every attempt; the conflict reply repairs the PLANNER,
  never the commit scope's own state → loop → E_REPAIR_BUDGET.
- The earlier $exit v1/v2 read_version_mismatch loop is the same divergence
  in the other direction (verb pages).

**Architectural finding: CommitScopeDO-resident scope worlds are a third
durable copy of the world that catalog repairs and bootstrap migrations
never update.** World host: repaired. Scope DOs: frozen at their snapshot
epoch. Fresh-world lanes can never see this (scopes seed from the current
world at first open) — the stale-world lane recommendation stands, now with
its precise target.

**The fix (small, uses existing machinery)**: stamp CommitScopeDO durable
snapshots/checkpoints with the catalog bundle hash (or world catalog
version); on open/rehydrate, a stamp mismatch with the current bundle is
treated exactly like E_SNAPSHOT_REQUIRED — discard the stale scope state and
reseed from the world via the existing reseed + full-body retry flow. This
heals every diverged scope DO on next touch, now and after any future
catalog change. (An operational alternative — manually nuking scope DO
storage — is neither available via API nor principled.)

Status of the three shipped fixes: Fix 1 (KV B7 rule) correct,
prod-irrelevant here, keep. Fix 2 (seed invalidation on repair) correct for
its class, keep. Fix 3 (missing-instances migration) WORKED on the world
host — necessary but not sufficient without the scope-stamp fix.
