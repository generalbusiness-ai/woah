// Authority-slice content contract:
//
// `WooWorld.exportAuthoritySlice` returns the executor's view of the world
// needed to validate and plan the next turn. The contract is "explicit roots
// plus their one-hop expansion plus their class chains" — NOT "every $-prefixed
// class object in the world".
//
// The catalog sweep version of this function (5b1f77c) tried to be safe by
// including every $-prefixed object on every refresh. In production that
// inflated the cross-host /__internal/authority-slice payload to ~3 MB / 1000
// page-refs and pushed cold-open round-trips past the 5s HOST_READ_RPC_TIMEOUT
// ceiling, hanging MCP turns. The fix trusts the reachability walk: parent
// classes, owners, contents, and property/argument value refs already cover
// the catalog dependencies that any legitimate turn needs. Catalog code that
// is NOT reachable from the explicit roots arrives via the first-open
// `serialized` seed (CommitScopeDO returns E_SNAPSHOT_REQUIRED and the gateway
// retries) — not via per-envelope authority refresh.

import { describe, expect, it } from "vitest";
import { authoritySliceObjectIds } from "../src/core/authority-slice";
import { createWorld } from "../src/core/bootstrap";

describe("WooWorld.exportAuthoritySlice content contract", () => {
  it("includes the explicit root plus its parent class chain", () => {
    const world = createWorld();
    const slice = world.exportAuthoritySlice([], ["the_chatroom"]);
    const ids = new Set(authoritySliceObjectIds(slice));
    expect(ids.has("the_chatroom")).toBe(true);
    expect(ids.has("$room")).toBe(true);
  });

  it("does NOT include unreferenced catalog classes (no $-prefix sweep)", () => {
    // Regression bait. Before the fix, exportAuthoritySlice ran a loop over
    // every $-prefixed object in the world and pushed each one. That inflated
    // the per-envelope cross-host RPC body and tripped cold-open timeouts in
    // production. `$dubspace` is part of the bundled boot graph but is not on
    // the_chatroom's class chain and not in its contents, so it must not
    // appear in a slice rooted at the chatroom alone.
    const world = createWorld();
    const slice = world.exportAuthoritySlice([], ["the_chatroom"]);
    const ids = new Set(authoritySliceObjectIds(slice));
    // $pinboard and $task_registry are catalog classes that are NOT on the
    // chatroom's class chain and NOT in its immediate contents, so they must
    // not appear in a chat-rooted slice. (Note: $dubspace and $outliner WILL
    // appear because the_dubspace and the_outline are physically in the
    // chatroom — that's correct one-hop reachability, not the sweep.)
    expect(ids.has("$pinboard")).toBe(false);
    expect(ids.has("$task_registry")).toBe(false);
  });

  it("keeps the slice payload bounded for a narrow root set", () => {
    // A two-root query (room + actor) should not return >50 objects on a
    // fresh bundled world. The previous sweep returned ~95 (every $-prefixed
    // class plus the actor's local graph). The contract is: only what dispatch
    // needs for verbs reachable from those roots.
    const world = createWorld();
    const session = world.auth("guest:slice-narrow");
    const slice = world.exportAuthoritySlice([], ["the_chatroom", session.actor]);
    const ids = new Set(authoritySliceObjectIds(slice));
    expect(ids.size).toBeLessThanOrEqual(50);
  });

  it("expands explicit roots monotonically regardless of order", () => {
    // Regression: if `the_dubspace` was first reached as a content of
    // `the_chatroom` (transitive push, no value-trace), a later explicit-root
    // push could not "upgrade" it to traceValues:"full" because `seen` had
    // already gated the property walk. So
    //   exportAuthoritySlice([], ["the_dubspace", "the_chatroom"])
    // omitted $exit, both living-room exits, and the_deck — while the SAME
    // roots in the reverse order surfaced them. executor.ts orders the roots
    // as [commitScope, scope, target, actor, …], so a turn whose target is
    // nested inside its commit scope would routinely lose exit/destination
    // refs and dispatch would fail with E_OBJNF.
    const world = createWorld();
    const a = world.exportAuthoritySlice([], ["the_dubspace", "the_chatroom"]);
    const b = world.exportAuthoritySlice([], ["the_chatroom", "the_dubspace"]);
    const aIds = new Set(authoritySliceObjectIds(a));
    const bIds = new Set(authoritySliceObjectIds(b));
    expect(aIds).toEqual(bIds);
    // And both orderings must include the_chatroom's full one-hop expansion.
    expect(aIds.has("the_deck")).toBe(true);
    expect(aIds.has("$exit")).toBe(true);
  });

  it("surfaces objects named by inherited propertyDef defaults", () => {
    // Regression bait: `getPropertyValue` falls through to the class
    // propertyDef's `defaultValue` when an instance does not store its own
    // value (src/core/property-read.ts). A verb body that reads
    // `instance.pointer` then gets back the class default's ref. If the
    // slice does not surface that ref, dispatch fails with E_OBJNF.
    // Tracing live property-cell values alone misses this case — we must
    // also follow `propertyDefs[*].defaultValue` refs on every class we
    // pull in.
    const world = createWorld();
    type WorldAny = { createObject: (input: { id: string; parent: string | null }) => unknown; defineProperty: (id: string, def: { name: string; defaultValue: unknown; owner: string; perms: string }) => unknown };
    const w = world as unknown as WorldAny;
    w.createObject({ id: "ref_target_obj", parent: "$thing" });
    w.createObject({ id: "ref_class", parent: "$thing" });
    w.defineProperty("ref_class", { name: "pointer", defaultValue: "ref_target_obj", owner: "$wiz", perms: "rc" });
    w.createObject({ id: "ref_instance", parent: "ref_class" });
    const slice = world.exportAuthoritySlice([], ["ref_instance"]);
    const ids = new Set(authoritySliceObjectIds(slice));
    expect(ids.has("ref_instance")).toBe(true);
    expect(ids.has("ref_class")).toBe(true);
    expect(ids.has("ref_target_obj")).toBe(true);
  });

  it("includes a $-class when the caller threads it as an explicit root", () => {
    // Native helpers can resolve an object named only as an argument. The
    // executor pre-walks args/body to surface those refs (executor.ts
    // §executorAuthorityObjectIds), and the slice's reachability walk then
    // expands them. This case keeps the cross-actor contract alive without
    // re-introducing the $-sweep — the catalog object appears only because
    // the caller named it.
    const world = createWorld();
    const slice = world.exportAuthoritySlice([], ["the_chatroom", "$dubspace"]);
    const ids = new Set(authoritySliceObjectIds(slice));
    expect(ids.has("$dubspace")).toBe(true);
  });
});
