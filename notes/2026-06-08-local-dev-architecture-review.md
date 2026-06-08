# Local dev/browser architecture review

Date: 2026-06-08
Branch: `local-dev-carry-drop`
Status: active task list

## Summary

The branch is converging on the intended architecture in one important way:
server text-command planning no longer bypasses catalog verb dispatch. The
server convenience path now invokes the active space's `:command_plan` wrapper,
and the native parser helper remains behind that catalog entry point.

The remaining risks are not the same class as the fixed bypass, but they are
real. Browser open-seed construction and the native command helper still encode
catalog/command knowledge inside core substrate code. Some of this is currently
needed to make first-turn browser-local execution fast, but it must be treated
as bounded transitional debt, not as a pattern to extend.

## Architecture drift tasks

- [x] Route server command planning through catalog dispatch.
  `WooWorld.planCommandNow` calls `space:command_plan` instead of directly
  invoking `planCommandForSpace`, and a guard prevents the old bypass.

- [x] Replace regex-only command-planning guard with a stronger structural
  assertion. `scripts/guard-command-planning.mjs` catches the specific bypass
  that was fixed, but it is string-shaped. Add a unit or AST-level guard that
  proves server/client convenience APIs dispatch the catalog wrapper, and that
  only the native primitive implementation calls the parser helper.
  The guard now parses `world.ts` and `main.ts` with the TypeScript AST. It
  locates `planCommandNow` independent of formatting, verifies the active-space
  `:command_plan` wrapper is used, and allows `planCommandForSpace` only under
  `nativeHandlers.set("plan_command", ...)`.

- [ ] Make browser open executable seed metadata-driven. The open seed in
  `src/core/shadow-browser-node.ts` currently names `command_plan`,
  `acceptable`, `enterfunc`, `exitfunc`, and several catalog/user-facing
  properties. The direction should be declared executable dependencies from
  bytecode, native primitive contracts, verb metadata, or catalog metadata,
  with the current hand list only as a temporary compatibility surface.

- [ ] Keep command grammar conventions out of ordinary runtime paths.
  `planCommandForSpace` is a transitional native-backed parser helper. Its
  command syntax knowledge is acceptable only while invoked through
  `$conversational:command_plan` or another catalog wrapper. Do not add new
  server/client direct callers or new catalog-specific branches here.

- [ ] Generalize core comments and type descriptions that name bundled verbs or
  objects where the behavior is actually substrate-level. Specific examples in
  `src/core/types.ts` and related comments should describe movement,
  possession, or directed observation semantics rather than particular demo
  objects or command words unless the comment is documenting a compatibility
  exception.

- [ ] Verify bundled catalog install/migration helpers remain outside normal
  runtime semantics. `src/core/local-catalogs.ts` can know bundled catalog
  object ids for installation repair, but generic runtime code must not branch
  on those ids.

## Functional stability tasks

- [x] Re-run the previous cf-local walkthrough hang under tightened timeouts.
  The isolated cross-shard walkthrough now passes in 31s, and the full
  `smoke:cf-local` file passes 4/4 in 32s. The old late `the_garden:south`
  hang is not currently reproducible.

- [ ] Attribute the hidden wall time before changing behavior. Existing
  `turn_phase_timing.retry_ms` and `retry_detail_ms` should be inspected first;
  if they do not explain the gap, add instrumentation at the missing boundary.

- [x] Restore a trustworthy local worker lane. Isolated tests pass, but broad
  worker runs have shown order/parallel harness instability. The goal is a
  cheap local signal that catches deployed-shape failures without becoming a
  slow prod-smoke substitute.
  `npm run test:worker` now passes on this branch: 16 files passed, 1 skipped,
  236 tests passed, 5 skipped, in 65s.

- [x] Validate browser-local execution evidence end to end. The browser must
  show local VM planning/execution first, then server sequencing/confirmation,
  without the local dev server becoming the performance limiter.
  The targeted Playwright gate `two browser agents execute locally and are
  sequenced by the devserver` passes. It covers two agents using say, take,
  move, and drop; local `local_turn_planned` events precede server
  confirmations; no local fallback/delegation is allowed; per-action local and
  server budgets are enforced.

- [x] Validate unconstrained multi-agent local interaction. At minimum, two
  agents should move, carry, drop, observe peer actions, and continue after
  cross-scope movement without stale-cache or serialization failures.
  The same two-browser Playwright gate covers this minimum: both agents speak,
  one actor takes and drops the mug after moving to the deck, the peer observes
  cross-room movement, and the second actor then takes and drops the mug in the
  new room without v2 errors or browser-local fallback.

## Validation on 2026-06-08

- `npm run test:files -- tests/worker/cf-local-walkthrough.test.ts -t "covers cross-shard MCP movement and tool-space fanout" --reporter=verbose`
  passed in 31s.
- `npm run task:time -- test --task "architecture review and local dev stabilization" -- npx playwright test e2e/smoke.spec.ts -g "two browser agents execute locally and are sequenced by the devserver"`
  passed in 24s.
- `npm run task:time -- test --task "architecture review and local dev stabilization" -- npm run smoke:cf-local`
  passed 4/4 in 33s.
- `npm run task:time -- test --task "worker lane stability audit" -- npm run test:worker`
  passed in 1m 07s.
- `npm run task:time -- test --task "command planning guard hardening" -- npm run guard:command-planning`
  passed.
- `npm run task:time -- test --task "command planning guard hardening" -- npm run test:files -- tests/catalogs.test.ts -t "server text-command planning dispatches the room command_plan verb"`
  passed.
- No major serialization-weight regression was visible in these runs. Browser
  cold open executable seeds were about 410 KB / 434 pages per browser in the
  sampled e2e output, and local turn cache work stayed under the existing
  responsiveness budgets.

## Working rule

When a functional investigation exposes another direct bypass, hardcoded
catalog dependency in core, or parallel semantic path, it goes onto the
architecture drift list immediately. If it affects verb execution consistency,
it takes priority over ordinary performance work.
