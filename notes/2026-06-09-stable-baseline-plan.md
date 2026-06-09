# Stable performant baseline — consolidated review and plan

Origin: 2026-06-09, full-project review (architecture, browser, local-dev,
Cloudflare) on main @ 10f6505. Prod is deployed at b7915524 (cell-authority
merge), ~17–35s per warm turn, 4/9 deployed smoke. Goal: a stable, performant
baseline suitable for active usage locally and on Cloudflare.

Status note, later 2026-06-09: Phase 0 validation expansion and the CA12.2
line_map byte lever have landed on main. B7 gateway install was reviewed as the
next Phase 1.2 deploy candidate on branch `b7-gateway-install`, rebased onto
main `45244cb`; see
[2026-06-09-b7-gateway-install.md](2026-06-09-b7-gateway-install.md) for the
current scoped implementation and deploy-measurement expectations. The diagnosis
below is intentionally preserved as the baseline that motivated the sequence.

## Diagnosis: four root causes, not forty bugs

The instability is concentrated. Almost every user-visible failure traces to
one of these:

### RC1 — Three projection appliers over one dataset (correctness backbone)

The same authoritative facts (location, contents, presence, sessions) are
materialized by three independent paths with divergent invalidation:

1. server full-world serialization (`world.ts` `exportHostScope`, sorted
   canonical contents),
2. gateway projection-delta cache (`persistent-object-do.ts`
   `applyGatewayProjectionWrites` ~724) — receives row ops only, **never the
   transcript**, so cross-host moves never patch a cached container's
   contents; session end never prunes membership (departed-actor bloat,
   missing seed fixtures like `the_mug`),
3. browser relay snapshot + proposal overlay (`shadow-browser-node.ts`),
   which still carries a legacy transcript-replay materializer alongside the
   newer holder-install path, and appends contents unsorted.

Symptoms attributed to this one cause: `take` failing "I don't see mug here",
ghost occupants, contents order/read_version_mismatch retries, stale gateway
tool resolution, and the dual-path debugging tax on every browser fix.
CA4 "durable owner delivery" is designed in spec/protocol/cell-authority.md
but not wired.

### RC2 — Cloudflare warm-turn cost: per-turn authority assembly × repair loop

Turn wall on prod = 62% submit + 37% authority; local compute ≈ 0. The
gateway rebuilds a 3–4 MB authority slice from world state per envelope
(`gateway.ts` buildSerializedAuthorityCellSlice ~1268,
`executor.ts` executorAuthorityPayload ~236), fanning to up to 16–17 hosts,
and the repair loop (`executor.ts` ~650) takes a second attempt on ~50% of
turns (attempts p95=2), re-paying authority+submit. Cold start is solved
(host-seed KV; cold load ~583ms): warm turns are the problem.

The fixes are **already built but not landed/deployed**:
- B7 warm-fill (first-attempt authority from CommitScopeDO head) — mechanics
  on main, prod gateway-install deferred; collapses repair attempts → 1.
- CA12 line_map-blind page hashing + delivery strip — worktree
  `authority-warm-assembly` (5 commits, based on 3213f31): measured −41%
  authority bytes, −36% per-turn ms. Two pre-merge defects from review:
  absent-`line_map` pages hash differently from `line_map: {}` (CA12.2
  contract gap in shadow-state-pages.ts:193) and one stale test comment.
- Checkpoint bounding probe (WOO_V2_CHECKPOINT_BOUNDED) — lands −10–15%
  CommitScopeDO CPU once the repair loop stops masking it.

### RC3 — The validation system cannot see the failures

- `npm test` curated gate excludes the core-mechanics files:
  movement-projection, object-host-write-through, conformance, core,
  mcp, persistence, dev-v2 parity tests. Regressions in the exact areas
  above pass the fast gate.
- Browser multi-user smoke (`tests/smoke/v2-mcp-smoke.test.ts`) is entirely
  `.skip`'d. The cross-user pinboard/outliner share fix (5fa898a) has no
  gate holding it.
- The pinboard e2e suite is ungated and partially red (smoke.spec.ts:579
  input wiped on re-render, :670 zoom, :774 reload-hydration).
- No multi-DO harness: cross-DO authority gaps are a deploy-only signal
  (cell-authority.md CA16 calls this a prerequisite). Fault-injection
  plumbing exists but the authority-slice path isn't instrumented.

### RC4 — Local-dev and browser have known load-bearing defects

- `world.ts:7071` `applyProjectionWrites("sessions")` calls
  `hydrateSession` unconditionally, which resets `attachedSockets` — a live
  WS session that receives a projection write freezes. This blocks
  projection-mode parity and multi-user tool spaces in dev.
- Projection-mode branching is not wired into `devRestV2Turn` /
  `materializeDevV2CommitLocally` (transcript-mode only), so the CF
  projection codepath is unexercised locally.
- REST vs WS reply divergence: WS shapes browser-profile projection rows
  (`devV2BrowserProfileTurnReply`), REST returns raw authority rows; REST
  also has no reply-idempotency cache.
- Browser failure UX is silent: an invalidated optimistic turn
  (v2-browser-optimistic-lifecycle.ts:37–46) vanishes with no error line or
  retry; no worker heartbeat, so a stalled projection worker hangs the UI
  indefinitely.

What is NOT broken (verified on main, contrary to stale memory): cross-user
pinboard/outliner live sharing (5fa898a), the `se` toolbar bug and
peer-departure fanout (f86a2b0/CA8), turn-path command planning (converged
on `space:command_plan` with a guard), cold-start (KV host seed), note-text
cold-paint (display cache, principal-isolated).

## Plan

Ordering principle: make red visible first, then ship the built perf work,
then fix the one structural correctness problem, then parity and UX. Each
phase has its own gate and is independently shippable.

### Phase 0 — Re-baseline validation (~1 week)

The cheapest leverage; everything later lands against it.

1. Promote into the `npm test` curated gate: movement-projection,
   object-host-write-through, conformance, dev-v2-commit,
   dev-v2-durable-turn-parity, mcp, persistence (keep slow UI/e2e out;
   target ≤ ~1 min wall).
2. Un-skip `tests/smoke/v2-mcp-smoke.test.ts`; fix what falls out.
3. Gate the two cross-user e2e tests (pinboard :738 live assertion,
   outliner :782) — they pass now; hold the line.
4. Quarantine-gate the known-red pinboard e2e (579/670/774) as expected-fail
   so new failures are distinguishable from old ones.

Exit: a commit that breaks projection idempotency, cross-host write-through,
or peer visibility fails CI locally.

### Phase 1 — Land + deploy the built CF perf work (~1–2 weeks)

Sequence, each step through the smoke ladder (cf-local → cf-dev →
deploy → walkthrough):

1. Finish `authority-warm-assembly`: fix the CA12.2 absent-line_map
   canonicalization gap + stale test, rebase onto current main, merge.
2. Complete the B7 gateway install so first-attempt authority comes from
   CommitScopeDO head → repair attempts collapse to 1.
3. Enable checkpoint bounding after 1+2 confirm.
4. One deploy per step or paired (1+2 together is acceptable; they're
   independent levers). Expected progression from existing measurements:
   17–35s → roughly 5–12s warm turn, deployed smoke 4/9 → ~9/9 (the
   E_VERBNF/E_OBJNF failures were lineage-closure issues already fixed on
   main but undeployed).
5. Re-measure with `smoke:cf-dev --measure` and the deployed walkthrough;
   re-attribute the remaining wall before any further optimization
   (per the commit-apply lesson: instrument first).

Exit: deployed walkthrough 9/9; warm turn p50 under ~5s with the next
bottleneck identified by measurement, not inference.

### Phase 2 — One projection pipeline (~2–4 weeks, the structural fix)

1. Interim (can start immediately, ~1 week): sparse owner-refresh before
   gateway tool/visibility resolution — fetch the authoritative row for the
   named member when the cached row is stale/missing. Kills the live
   "take mug" class on prod without waiting for the rewrite.
2. CA4 durable owner delivery: give the gateway projection applier
   transcript context (moves), fan accepted moves to both source and
   destination container owners, idempotent on (member, location_version);
   prune membership on session end/expiry, not only recycle.
3. Unify appliers: browser and gateway both install rows through the
   holder-install semantics (v2-browser-holder-install.ts); retire the
   legacy `applyShadowTranscriptToCommitScopeCache` hot path; one canonical
   contents ordering (sorted) at every producer.
4. Specs updated in the same PRs (CA4/CA8/CA11 status lines; remove the
   stale CA11.1 checkpoint-cache text).

Exit: movement-projection + conformance tests cover cross-host move repair,
seed-fixture visibility, and departed-actor pruning; the browser has one
row-install path.

### Phase 3 — Local-dev parity (~1–2 weeks, parallelizable with Phase 2)

1. `world.ts:7071`: preserve `attachedSockets`/`lastInputAt` when a
   projection write lands on a live session (small fix, test first).
2. Wire projection-mode branching into `devRestV2Turn` and
   `materializeDevV2CommitLocally`; add a REST+WS projection-mode parity
   test.
3. Factor browser-profile reply construction into one shared post-execute
   step for REST/WS/legacy.
4. REST reply-idempotency cache (match WS/MCP semantics).
5. Multi-user SQLite durable test: two actors, carry/drop across rooms,
   tool-space create, restart, verify.

Exit: local-dev exercises the same projection codepath as CF; `npm run dev`
is a trustworthy multi-user daily driver.

### Phase 4 — Browser failure UX (~1–2 weeks)

1. Error surface in the chat feed when an optimistic turn is invalidated or
   a commit is rejected, with retry where transient.
2. Worker heartbeat (~5s) + "Reconnecting…" banner + projection resync on
   recovery.
3. Pinboard component triage: re-render wiping the new-note input (:579),
   zoom (:670), reload-hydration (:774); then gate the suite green.

Exit: no silent failures; a killed worker recovers visibly; pinboard e2e
fully gated.

### Phase 5 — Post-baseline roadmap (explicitly out of scope for "stable")

Scale machinery, scheduled but not part of the baseline: CA7 room-anchored
sequencing, CA10 authority migration, CA12.1 cell-keyed storage split,
CA13 hot-room fanout sharding, the multi-DO fault-injection harness
(CA16 prerequisite), and the main.ts/world.ts decomposition
(12.2k-line world.ts with 9 hand-invalidated indices; 5.6k-line main.ts).
The fault-injection harness is the first of these to pull forward — it
converts today's deploy-only failure class into a local signal.

## Risks and rules

- Worktree isolation per task, smoke ladder before every deploy, no deploy
  without explicit instruction (per AGENTS.md).
- Agent/report time estimates are rough; the ordering and the exit gates
  are the commitments, not the week counts.
- Phase 1 deploys change prod behavior; rollback target is the previously
  deployed image (currently b7915524; prior known-good 99fb37df — do not
  roll back without asking).
- Phase 2 step 3 (applier unification) is the highest-regression-risk item;
  it must land after Phase 0 gates exist, never before.
