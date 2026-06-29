# Plan 001: Establish a functional performant baseline

> **Executor instructions**: Follow this plan step by step. Run every
> verification command and confirm the expected result before moving to the next
> step. If a STOP condition occurs, stop and report; do not improvise.
>
> **Drift check (run first)**:
>
> ```sh
> git status --short --branch
> git diff --stat
> git diff --check
> ```
>
> This plan was written against commit `7264d93` on `main`, with an existing
> dirty runtime/test patch in the files listed under "Current state". If those
> snippets no longer match, compare the live code before proceeding. Treat a
> semantic mismatch as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: L
- **Risk**: MED
- **Depends on**: none
- **Category**: bug, perf, tests, docs
- **Planned at**: commit `7264d93`, 2026-06-28, with dirty working-tree changes

## Why this matters

Recent work has converged on one central problem: the deployed world can pass
local lanes while aged Cloudflare state, stale relay auth, and high MCP turn
latency still make the live baseline unreliable. Several important fixes have
landed since the older stable-baseline note, but the current auth/session patch
is uncommitted, unmeasured, and mixed with a test-harness stabilization. A
baseline is only real when local gates, workerd smoke, deployed smoke, and
data-path metrics all agree that users can enter rooms, talk, move, share tools,
and keep active MCP sessions alive without timeout cascades.

## Current state

Repository shape:

- Language/runtime: TypeScript, Vite, Vitest, Playwright, Cloudflare Workers and
  Durable Objects.
- Package manager: npm.
- Main branch: `7264d93` (`Repair anchored host seed snapshots`), matching
  `origin/main` at review time.
- Dirty files at review time:
  - `src/core/authority-slice.ts`
  - `src/core/shadow-browser-node.ts`
  - `src/core/world.ts`
  - `src/mcp/gateway.ts`
  - `src/server/dev-v2-helpers.ts`
  - `tests/authority-slice-shape.test.ts`
  - `tests/conformance.test.ts`
  - `tests/mcp-warm-authority.test.ts`
  - `tests/shadow-browser-node.test.ts`
  - `vite.config.ts`

Recent committed baseline work:

- `47e1e67` moved Worker tool refresh off the reply path.
- `801e31b` stabilized deployed turn routing and cache epochs.
- `8da599d` added terminal state-path divergence metrics.
- `7264d93` repaired anchored host seed snapshots.

The current dirty patch addresses active-session auth expiry:

- `src/core/world.ts:3261` adds sliding renewal in `touchSessionInput`. It
  updates `lastInputAt` on authenticated ingress and persists `expiresAt` only
  when the remaining lease is at or below half the session TTL.
- `src/mcp/gateway.ts:636` already calls `world.touchSessionInput` for MCP
  requests. The dirty patch additionally refreshes cached scope relay auth in
  `ensureV2ScopeSessionOpen` before cached-open returns, and before
  `submitEnvelope` uses a long-lived scope client.
- `src/core/shadow-browser-node.ts:681` refreshes all relay auth tokens for the
  same session id, not only the presented token, preserving already-known scopes.
- `src/core/authority-slice.ts:588` keeps active session expiry monotonic while
  merging stale authority slices for the same session and actor.
- `src/server/dev-v2-helpers.ts:296` applies the same touch/refresh behavior to
  the in-process local-dev durable-turn path.
- `vite.config.ts:13` changes the Vitest full-gate configuration to
  `maxWorkers: 4` and `testTimeout: 60_000`, separating scheduler pressure from
  product behavior.

Existing validation ladder:

- `npm run test:files -- <files>` runs targeted Vitest files.
- `npm test` runs guards plus the curated fast local Vitest gate.
- `npm run test:worker` runs slow Worker/Cloudflare-shape tests.
- `npm run smoke:cf-local` runs the fake-DO smoke lane.
- `npm run smoke:cf-dev` runs the shared scenario through real local workerd.
- `npm run smoke:cf-dev -- --measure --passes=3` prints cold/warm turn metrics.
- `npm run deploy` runs deployment preflight, including typecheck, `npm test`,
  `smoke:cf-dev`, build, upload, and deployed postflight checks.

Important caveat from `spec/operations/deployments.md:50`: local workerd still
runs every Durable Object in one process with fast RPC, so cross-colo latency
and cold-owner timeout gaps remain deployed-only until fault injection or an
aged-state lane catches them locally.

## Baseline definition

The baseline is functional when all of these hold:

- Targeted auth/session tests pass.
- `npm run typecheck` passes.
- `npm test` passes without relying on skipped product failures.
- `npm run smoke:cf-dev` passes all enforced steps with no unexpected tracked
  failures.
- A deployed walkthrough passes all enforced steps after an approved deploy.
- No deployed smoke step times out and causes secondary session-reset failures.
- `state_path_divergence` metrics are zero during the accepted deployed
  walkthrough, or any nonzero count has a named, bounded, understood cause with
  a follow-up plan.

The baseline is performant when all of these hold:

- In `smoke:cf-dev -- --measure --passes=3`, warm passes have zero repair turns
  where `attempts != 1`.
- Warm-pass `authority_calls`, slice reconstructions, and request bytes do not
  regress against the previous accepted measurement unless the increase is
  explained by a new enforced scenario step.
- In deployed smoke, no MCP request reaches the stuck-request guard, warm turn
  p50 is at or below 5s, and warm turn p95 is at or below 12s.
- If those deployed latency thresholds are missed, the run is not accepted as a
  performant baseline. The next action must be a measured root-cause pass, not a
  broad timeout increase.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Dirty-state check | `git status --short --branch` | Shows the expected worktree before edits |
| Whitespace check | `git diff --check` | Exit 0 |
| Targeted auth/session tests | `npm run test:files -- tests/conformance.test.ts tests/authority-slice-shape.test.ts tests/mcp-warm-authority.test.ts tests/shadow-browser-node.test.ts` | Exit 0, all tests pass |
| Typecheck | `npm run typecheck` | Exit 0, no TypeScript errors |
| Fast guarded gate | `npm test` | Exit 0 |
| Worker gate | `npm run test:worker` | Exit 0 when Worker/Cloudflare-shape behavior changed |
| Workerd smoke | `npm run smoke:cf-dev` | Exit 0, no unexpected failures |
| Workerd measurement | `npm run smoke:cf-dev -- --measure --passes=3` | Exit 0 and prints cold/warm metrics |
| Deploy | `npm run deploy` | Only after explicit operator approval; exit 0 |
| Deployed walkthrough | `npm run smoke:walkthrough:tail` | Exit 0 or a captured failure with tail artifacts |

## Scope

In scope:

- Finish and validate the current auth/session relay-refresh patch.
- Keep the Vitest full-gate stabilization if isolated tests prove product
  behavior is correct and the broad failures are scheduler pressure.
- Capture a fresh local and deployed measurement.
- Add the missing aged-state/fault-injection validation plan before the next
  behavior-changing deploy if deployed measurement still exposes state skew.
- Update specs/docs when behavior or deployment gates change.

Out of scope:

- Browser UI polish that does not affect baseline functionality.
- Large applier unification or megafile decomposition before the current patch
  is proven.
- Merging the abandoned `gateway-session-presence` patch.
- Deploying or committing directly to `main` without explicit instruction.
- Increasing deployed timeouts as a substitute for lower latency.

## Git workflow

- Start from a worktree or branch dedicated to this baseline task. Preserve the
  current dirty patch before making additional edits.
- Commit after each major completed task if implementation is authorized.
- Commit messages must include a title plus a body describing motivation and key
  implementation details.
- Do not push, merge, or deploy unless explicitly instructed.

## Steps

### Step 1: Freeze the current auth/session patch

Review the dirty runtime changes and keep them narrowly scoped to session
liveness and relay auth refresh. Confirm these invariants in the live code:

- `world.touchSessionInput` is only called from authenticated protocol ingress
  and not from generic internal `world.call`/`world.directCall`.
- Closed or already-expired sessions do not get renewed.
- Expiry renewal is persisted only near half-life, not on every request.
- Stale authority merges cannot shorten an active live session's expiry for the
  same session id and actor.
- Relay auth refresh updates every token already known for the same session id,
  so reconnect/local bearer swaps do not leave stale claims behind.

Verify:

```sh
git diff --check
npm run test:files -- tests/conformance.test.ts tests/authority-slice-shape.test.ts tests/mcp-warm-authority.test.ts tests/shadow-browser-node.test.ts
```

Expected result: both commands exit 0. The targeted tests must include coverage
for renewal persistence, monotonic expiry merge, cached MCP relay refresh, and
existing shadow-browser relay auth behavior.

### Step 2: Separate product failures from gate scheduler pressure

Run the broad local gate after targeted tests are green:

```sh
npm run typecheck
npm test
```

Expected result: both commands exit 0.

If `npm test` fails but the targeted tests pass:

- Identify whether every failure is a wall-clock timeout under full-suite
  pressure.
- Re-run the failing files alone with `npm run test:files -- <file...>`.
- If isolated runs pass and no product metric/error is present, keep the
  `vite.config.ts` scheduler stabilization (`maxWorkers: 4`,
  `testTimeout: 60_000`) and document it in the commit body.
- If any isolated run fails, fix that product behavior before touching the
  harness.

STOP if a broad failure includes `state_path_divergence`, `E_NOSESSION`,
`E_NEED_STATE`, `E_VERBNF`, or `E_OBJNF` and reproduces in isolation.

### Step 3: Run the Cloudflare-shape local ladder

Once the local gate is green, run:

```sh
npm run test:worker
npm run smoke:cf-dev
npm run smoke:cf-dev -- --measure --passes=3
```

Expected result:

- `test:worker` exits 0.
- `smoke:cf-dev` exits 0 with no unexpected failures.
- The measurement run exits 0 and prints cold/warm tables.
- Warm passes show zero repair turns where `attempts != 1`.
- Any remaining authority reconstruction or high `ensure_client_ms` cost is
  written down with the exact metric name before further optimization work.

If `smoke:cf-dev` passes but the measurement shows a major regression versus
the previous accepted run, stop and classify the regression before deploying.

### Step 4: Commit the baseline candidate

Only after Steps 1-3 pass, commit the implementation if authorized.

The commit body must include:

- Why the auth/session renewal exists.
- Why stale relay claims were the failure mode.
- Which targeted tests protect the behavior.
- Whether `vite.config.ts` was necessary for scheduler pressure.
- The `smoke:cf-dev -- --measure --passes=3` summary.

Do not deploy in the same step. The commit is the local baseline candidate.

### Step 5: Deploy and capture live evidence

Deploy only after explicit approval.

Run:

```sh
npm run deploy
npm run smoke:walkthrough:tail
```

Expected result:

- Deploy script exits 0.
- Deployed smoke passes all enforced steps.
- Tail capture produces artifacts under `.woo/smoke-measurements/...`.
- No MCP request hits the stuck-request guard.
- No reset-induced secondary failures are needed to complete the walkthrough.

After the run, analyze the tail and metrics history using the existing smoke
analysis scripts. Record at least:

- Deployed version and commit.
- Pass/fail count and failed step names, if any.
- Warm turn p50 and p95.
- Count of `state_path_divergence` metrics by cause.
- Count of repair turns where `attempts != 1`.
- Largest request bytes observed.
- Dominant phase from `turn_phase_timing` (`ensure_client`, `authority`,
  `submit`, `vm`, or serialization).

### Step 6: Make the baseline decision

Classify the deployed result:

- **Green baseline**: functional and performance definitions are both met.
  Update `plans/README.md` to DONE, update the relevant note/spec references,
  and capture the measurement in keep memory.
- **Functional but not performant**: all steps pass, but latency misses the
  thresholds. Do exactly one measured optimization pass on the dominant phase.
- **Not functional**: any enforced smoke step fails, any session expires while
  active, or state-path divergence is nonzero and unbounded. Do not tune
  performance; fix the named correctness cause first.
- **Inconclusive**: test harness failed, tail capture missing, or deployed
  measurement lacks enough metrics. Rerun only after improving the signal.

### Step 7: Add aged-state validation before the next behavior deploy

If the deployed result is not green, or if it passes but still depends on a
known deploy-only state-skew class, add an aged-state lane before the next
behavior-changing deploy.

Use existing building blocks:

- `scripts/smoke/scenario.ts` contains the shared cross-actor scenario.
- `scripts/smoke-cf-dev.ts` already has isolated workerd persistence and a
  `--measure` mode.
- `src/worker/rpc-fault-inject.ts` already supports authority-slice, envelope,
  and MCP fanout fault injection.
- `tests/worker/rpc-fault-inject.test.ts` already proves fault injection and
  warm-path authority behavior.
- `spec/operations/deployments.md` already documents that aged/cross-colo gaps
  are not covered until fault injection lands.

Implementation target:

- Add a local lane that boots a persisted workerd world, runs traffic, simulates
  stale gateway/commit-scope/host-seed relationships with either versioned
  setup or targeted fault injection, then runs the shared smoke scenario after
  the upgrade/fault.
- The lane must fail on at least one known stale-state reproduction before the
  fix and pass after the fix.
- Wire the lane into deploy preflight only after it is deterministic. Until
  then, keep it as an explicit command and document when it must be run.

Verification:

```sh
npm run test:files -- tests/worker/rpc-fault-inject.test.ts
npm run smoke:cf-dev
npm run smoke:cf-dev -- --measure --passes=3
```

Expected result: exit 0, no unexpected failures, and the new lane names stale
state failures instead of timing out.

### Step 8: Iterate only from measurements

If more optimization is needed, choose exactly one next lever based on the
accepted measurement:

- If `state_path_divergence` is nonzero: fix the named cause first.
- If repair turns are nonzero: inspect commit conflict/retry metrics before any
  payload-size work.
- If `ensure_client_ms` dominates: reduce first-touch authority assembly or
  prefetch cost.
- If `submit_ms` dominates: inspect CommitScopeDO envelope/serialization cost.
- If request bytes regress: inspect authority slice shape and page hashing.
- If fanout dominates: inspect tail-driven delivery and pending-row drains.

Every optimization must have a before/after `smoke:cf-dev -- --measure` table
and a deployed measurement if it targets deployed latency.

## Test plan

Required tests for the current dirty patch:

- `tests/conformance.test.ts`: active stateless session expiry is renewed and
  persists across restart.
- `tests/authority-slice-shape.test.ts`: stale authority merge cannot shorten
  current session expiry.
- `tests/mcp-warm-authority.test.ts`: cached MCP scope relays refresh expired
  local claims before warm turns.
- `tests/shadow-browser-node.test.ts`: existing relay auth token behavior stays
  intact when synthetic sessions are long-lived.

Required gates before deploy:

- `npm run typecheck`
- `npm test`
- `npm run test:worker`
- `npm run smoke:cf-dev`
- `npm run smoke:cf-dev -- --measure --passes=3`

Required gates after deploy approval:

- `npm run deploy`
- `npm run smoke:walkthrough:tail`
- Tail and metrics-history analysis captured in notes or keep memory.

## Done criteria

All must hold:

- [ ] Dirty auth/session patch is either committed as a baseline candidate or
      intentionally abandoned with reasons.
- [ ] Targeted auth/session tests pass.
- [ ] `npm run typecheck` exits 0.
- [ ] `npm test` exits 0.
- [ ] `npm run test:worker` exits 0.
- [ ] `npm run smoke:cf-dev` exits 0.
- [ ] `npm run smoke:cf-dev -- --measure --passes=3` exits 0 and has no warm
      repair turns.
- [ ] No deploy occurs without explicit approval.
- [ ] If deployed, the deployed smoke result is classified green, functional
      but not performant, not functional, or inconclusive.
- [ ] Any changed runtime behavior is reflected in the relevant spec/docs.
- [ ] `plans/README.md` status row is updated.

## STOP conditions

Stop and report if:

- The code no longer matches the current-state snippets.
- A targeted auth/session test fails after one reasonable fix attempt.
- A broad gate failure reproduces in isolation.
- A deployed failure lacks tail/metric evidence.
- Fixing the issue appears to require merging the abandoned
  `gateway-session-presence` worktree.
- The work appears to require deploy, push, or merge without explicit approval.

## Maintenance notes

- Active session expiry is a liveness lease. Future authority-merge code must
  not shorten a newer live lease from an older serialized slice.
- Cached relay auth belongs to transport validation, not world authority. Future
  long-lived relay caches must refresh claims from the live session row before
  cached-open shortcuts.
- Harness timeouts are not performance work. If a timeout increase is retained,
  it must be paired with a measurement showing the product path is not wedged.
- The first follow-up after a green baseline should be the aged-state lane, not
  UI polish or broad applier refactoring.
