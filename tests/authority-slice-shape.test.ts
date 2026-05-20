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
