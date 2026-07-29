// Guard: a worker test that defers Durable Object work must drain it.
//
// The unsafe pattern is a fake-DO fixture that collects `waitUntil` promises
// and closes storage without draining them. Work then runs on against a dead
// database AFTER the assertions have reported, so rejections are invisible to
// vitest: two suites reported 38 passing tests while emitting 24 `database is
// not open`, 8 fanout errors, 8 outbox-delivery failures and 8 deferred-task
// errors. A fixture that lets asynchronous regressions pass CI is how the next
// several get shipped — and this exact fixture was copied by hand into each
// new suite as it was written, which is why a review found it spreading.
//
// tests/worker/quiescent-do.ts is the one correct implementation: it drains to
// quiescence before closing and fails the owning test on a deferred rejection.
// This guard stops a NEW hand-rolled copy from appearing. Files still carrying
// their own copy are listed below as an explicit, shrinking debt register
// rather than silently tolerated — converting them is mechanical, but each one
// can surface real hidden failures, so they are done deliberately and not in
// one sweep.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const root = process.cwd();
const workerTests = join(root, "tests", "worker");
const SHARED = "quiescent-do";

/** A hand-rolled DO state that supplies its own `waitUntil` at all.
 *
 * The earlier detector looked for the promise being STORED (`.push(` inside
 * the arrow body) on the theory that `waitUntil: () => {}` "drops deferred
 * work entirely and has nothing to drain". That theory is wrong, and it let
 * two real offenders (net-install, net-install-doorway) off the register while
 * they emitted eight `net_scope_outbox_delivery_failed` between them.
 *
 * `WorkerdHost.defer` calls `task()` FIRST and only then hands the resulting
 * promise to `waitUntil`. The work is already running by the time the fixture
 * sees it. An empty `waitUntil` therefore does not cancel anything — it throws
 * away the only handle anyone had on live work, which is strictly worse than
 * storing it: the suite cannot drain what it cannot reference, so the work
 * lands on storage the suite has since closed.
 *
 * So the rule is simply: if a worker test defines `waitUntil`, it owns
 * deferred DO work and must use the shared quiescent fixture. There is no
 * safe hand-rolled form, which is the point.
 *
 * OMITTING `waitUntil` is not an escape either, and that hole was real too:
 * net-do.test.ts built its DO state without one, so `state.waitUntil?.(p)` was
 * a no-op that discarded the handle just as thoroughly — and the file matched
 * no `waitUntil` token, so no register entry could even have been written for
 * it. The trigger is therefore CONSTRUCTING the fake DO state at all. Anything
 * that owns a `FakeDurableObjectState` and drives a net DO owns its deferred
 * work; the shared fixture re-exports the raw fake as `host.fake` for the
 * handful of suites that need DO-state surface it does not model. */
const DEFERS_WORK = /waitUntil\s*:|new\s+FakeDurableObjectState\s*\(/;
/** Uses the shared fixture (under any local alias). */
const USES_SHARED = new RegExp(`from\\s+["'][./]*${SHARED}["']`);

// Not yet converted. Each still hand-rolls the fixture and may be hiding
// deferred failures. Remove entries as they are converted; do not add any.
const UNCONVERTED = new Set([
  "net-audit.test.ts",
  "net-client-api.test.ts",
  "net-demote-lifecycle.test.ts",
  "net-do.test.ts",
  "net-gateway-repair.test.ts",
  "net-identity-door.test.ts",
  "net-install-doorway.test.ts",
  "net-install.test.ts",
  "net-load-asymptote.test.ts",
  "net-only-entry.test.ts",
  "net-ordered-children.test.ts",
  "net-outliner-converge.test.ts",
  "net-turn-structure.test.ts",
  "net-wire-contract.test.ts",
  "net-help-migration-aged.test.ts",
  "net-help-topics-aged.test.ts",
  "net-kv-seed.test.ts",
  "net-legacy-split-refusal.test.ts",
  "net-load-skew.test.ts",
  "net-mcp-agent-surface.test.ts",
  "net-mcp-hardening.test.ts",
  "net-mcp-legibility.test.ts",
  "net-mcp-origin.test.ts",
  "net-mcp-programmer.test.ts",
  "net-mcp.test.ts",
  "net-operator-anchor.test.ts",
  "net-outbox-bounded.test.ts",
  "net-programmer-lifecycle.test.ts",
  "net-promote.test.ts",
  "net-provision-wizard.test.ts",
  "net-relations.test.ts",
  "net-repair-contents.test.ts",
  "net-scheduled.test.ts",
  "net-scope-fanout.test.ts",
  "net-session-leak.test.ts",
  "net-session-reap.test.ts",
  "net-topology-turn.test.ts",
  "net-verb-editor-aged.test.ts",
  "net-verb-editor.test.ts",
  "net-verb-slots.test.ts",
  "net-ws.test.ts"
]);

function testFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...testFiles(full));
    else if (entry.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const offenders = [];
const staleAllowances = [];

for (const file of testFiles(workerTests)) {
  const name = relative(workerTests, file).split(sep).join("/");
  const source = readFileSync(file, "utf8");
  const defers = DEFERS_WORK.test(source);
  const shared = USES_SHARED.test(source);
  if (defers && !shared && !UNCONVERTED.has(name)) offenders.push(name);
  // Keep the register honest in both directions, exactly as the
  // module-mocking guard does: a listed file that no longer hand-rolls the
  // fixture must leave the list, or it rots into permanent noise.
  if (UNCONVERTED.has(name) && (!defers || shared)) staleAllowances.push(name);
}

for (const name of UNCONVERTED) {
  if (!testFiles(workerTests).some((f) => relative(workerTests, f).split(sep).join("/") === name)) {
    staleAllowances.push(`${name} (no such file)`);
  }
}

if (offenders.length > 0 || staleAllowances.length > 0) {
  if (offenders.length > 0) {
    console.error(
      "guard:quiescent-fixtures — these worker tests defer Durable Object work with a hand-rolled fixture:\n" +
        offenders.map((n) => `  - tests/worker/${n}`).join("\n") +
        `\n\nUse tests/worker/${SHARED}.ts instead: it drains deferred work to quiescence before\n` +
        "closing storage, and fails the owning test on a deferred rejection. A fixture that\n" +
        "closes under live work reports green over `database is not open` and friends.\n"
    );
  }
  if (staleAllowances.length > 0) {
    console.error(
      "guard:quiescent-fixtures — these entries in UNCONVERTED are stale (converted or gone):\n" +
        staleAllowances.map((n) => `  - ${n}`).join("\n") +
        "\n\nRemove them from scripts/guard-quiescent-fixtures.mjs.\n"
    );
  }
  process.exit(1);
}

console.log(
  `guard:quiescent-fixtures ok (${UNCONVERTED.size} suite(s) still hand-rolling the fixture; do not add more)`
);
