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
