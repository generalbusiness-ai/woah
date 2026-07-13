/**
 * topology.ts — anchor-derived scope classification (coherence.md CO15;
 * Plan 002 Phase 3.5 item 2).
 *
 * CO15 rule: **anchor derivation is a pure function of lineage cells.**
 * `scopeNameOf(object)` walks `lineage.anchor` to its root; the root's
 * class decides the scope:
 *
 *   - actor-classed root  → `cluster:<rootId>` (an actor and what it
 *                           carries — the private anchor cluster);
 *   - space-classed root  → `room:<rootId>` (a shared sequencer scope);
 *   - everything else     → `"catalog"` (the shared substrate).
 *
 * **Class detection is a lineage `parent`-chain walk**, verified against
 * the bootstrap seed graph (src/core/bootstrap.ts:992-1003): `$actor`
 * sits under `$root` and `$space` under `$sequenced_log` under `$root`,
 * so a chain reaches at most ONE of the two markers — first hit decides.
 * The bridge's `object_lineage` payloads (bridge.ts cellsFromSerialized)
 * carry exactly `parent` and `anchor`, which is all this walk consumes.
 *
 * **The `$`-prefix check runs before the class walk.** `$`-prefixed ids
 * are catalog-delivered seed identity (`npm run guard:object-names`
 * enforces the convention; every bootstrap.ts seed object is
 * `$`-prefixed), and CO15 assigns the shared substrate — `$system`,
 * `$root`, class lineage, verb bytecode, identity maps — to the catalog
 * scope. Without the ordering, `$guest`/`$player`/`$wiz` (actor-classed
 * seeds) would each mint a phantom cluster and `$chatroom`/`$room` a
 * phantom room.
 *
 * Honest limitation, stated: an ANCHORLESS non-actor non-space instance
 * (e.g. the bundled `the_lamp`, seeded without an anchor) classifies to
 * the catalog scope. That is CO15's rule as written ("anchorless → the
 * catalog scope"); properly-anchored worlds do not hit it, and the seed
 * catalogs' missing anchors are seed-data debt, not a topology gap.
 *
 * The catalog scope is NOT shared in route.ts's room-sequencer sense
 * (`isShared` is false for it). Class-definition cells change only through
 * the install pipeline — a sequenced catalog commit plus a `catalog_epoch`
 * bump (CO15). Compatibility identities, sessions, and still-anchorless
 * instances can nevertheless have catalog as their current owner; those
 * mutable cells are live-attested and are never covered by the class cache.
 *
 * The gateway refuses ordinary-turn class-definition writes before submit;
 * the install pipeline is the only sanctioned updater. This file remains the
 * pure ownership function used by both installation and ordinary routing.
 */
import type { Cell, CellKind } from "./cells";
import { netError } from "./errors";
import type { ScopeClassifier } from "./route";

/** The distinguished shared-substrate scope name (CO15). */
export const CATALOG_SCOPE = "catalog";

/** The slice of the bridge's `object_lineage` payload the anchor walk
 * consumes (bridge.ts LineagePayload is structurally assignable). */
export type AnchorLineage = { parent: string | null; anchor: string | null };

/** Lineage lookup: `null` means the object has no lineage payload in the
 * consulted set — for `scopeNameOf` that is an unclosed input (E_LINEAGE,
 * assert class); `classifierFromLineage` can soften it to a fallback. */
export type LineageLookup = (object: string) => AnchorLineage | null;

/**
 * The CO15 anchor walk. Pure: consults nothing but `lineage`.
 *
 * Throws E_LINEAGE (assert class — a bug in the caller's cell set, never
 * an operational condition) when the walk leaves the lineage set or
 * cycles: classifying from an unclosed set would silently misroute
 * authority writes, which is exactly the divergence class CO7's closure
 * discipline exists to make unrepresentable.
 */
export function scopeNameOf(object: string, lineage: LineageLookup): string {
  // ---- 1. Walk `anchor` to its root.
  const walked = new Set<string>();
  let root = object;
  let payload = lineage(root);
  if (payload === null) {
    throw netError("E_LINEAGE", "cannot classify: object has no lineage payload", { object });
  }
  while (payload.anchor !== null && payload.anchor !== undefined) {
    walked.add(root);
    root = payload.anchor;
    if (walked.has(root)) {
      throw netError("E_LINEAGE", "anchor walk cycles", { object, cycle: [...walked].sort() });
    }
    payload = lineage(root);
    if (payload === null) {
      throw netError("E_LINEAGE", "anchor walk leaves the lineage set", { object, anchor: root });
    }
  }

  // ---- 2. Catalog identity beats the class walk (see the header: a
  // `$`-prefixed root is catalog-delivered seed substrate even when it is
  // itself actor- or space-classed, e.g. $guest or $chatroom).
  if (root.startsWith("$")) return CATALOG_SCOPE;

  // ---- 3. Class walk on the root's parent chain: first marker wins.
  // (The seed graph guarantees at most one marker per chain — cited in
  // the header.)
  const chain = new Set<string>([root]);
  let cursor = payload.parent;
  while (cursor !== null && cursor !== undefined) {
    if (cursor === "$actor") return `cluster:${root}`;
    if (cursor === "$space") return `room:${root}`;
    if (chain.has(cursor)) {
      throw netError("E_LINEAGE", "parent chain cycles", { object, root, cycle: [...chain].sort() });
    }
    chain.add(cursor);
    const parent = lineage(cursor);
    if (parent === null) {
      throw netError("E_LINEAGE", "parent chain leaves the lineage set", { object, root, parent: cursor });
    }
    cursor = parent.parent;
  }

  // ---- 4. Anchorless, neither actor- nor space-classed → catalog
  // (CO15 "anchorless → the catalog scope"; see the header's honest
  // limitation about unanchored seed instances).
  return CATALOG_SCOPE;
}

export type ClassifierOptions = {
  /** Scope for objects the lineage set does not know at all (same-turn
   * creates whose cells do not exist yet — route.ts consults the
   * classifier for their writes). Mirrors the request-override
   * classifier's `?? planningScope` fallback; without it an unknown
   * object throws E_LINEAGE like `scopeNameOf` itself. Objects the set
   * DOES know still classify strictly (a mid-walk gap stays a bug). */
  fallback?: string;
};

/**
 * A ScopeClassifier over a lineage lookup (the gateway passes its view
 * store's `object_lineage` cells; tests pass a map). Classification is
 * memoized per classifier — build one per plan attempt so a refreshed
 * view gets a fresh walk.
 *
 * `isShared`: room scopes are the shared sequencers; anchor clusters are
 * private; the catalog scope is deliberately NOT shared (writes belong to
 * the install pipeline alone — header note).
 */
export function classifierFromLineage(lineage: LineageLookup, options: ClassifierOptions = {}): ScopeClassifier {
  const memo = new Map<string, string>();
  return {
    scopeOf: (object) => {
      const cached = memo.get(object);
      if (cached !== undefined) return cached;
      const scope =
        lineage(object) === null && options.fallback !== undefined
          ? options.fallback
          : scopeNameOf(object, lineage);
      memo.set(object, scope);
      return scope;
    },
    isShared: (scope) => scope.startsWith("room:")
  };
}

/** The cell slice topology consumes: `Cell` and the bridge's seedable
 * `NetCellInput` both satisfy it. */
export type TopologyCell = { kind: CellKind; object: string; name?: string; value: unknown };

/** Build a lineage lookup from a cell set's `object_lineage` payloads. */
function lineageFromCells(cells: Iterable<TopologyCell>): LineageLookup {
  const byObject = new Map<string, AnchorLineage>();
  for (const cell of cells) {
    if (cell.kind === "object_lineage") byObject.set(cell.object, cell.value as AnchorLineage);
  }
  return (object) => byObject.get(object) ?? null;
}

/** ScopeClassifier from a cell set (CO15: "gateways build their
 * classifier from view lineage — never from request-supplied topology").
 * Strict: an object absent from the set throws E_LINEAGE; callers with a
 * planning fallback use `classifierFromLineage` directly. */
export function classifierFromCells(cells: Iterable<Cell>, options: ClassifierOptions = {}): ScopeClassifier {
  const materialized = [...cells];
  return classifierFromLineage(lineageFromCells(materialized), options);
}

/**
 * Partition a world image's cells by the anchor walk (CO15 install
 * pipeline: catalog cells → catalog scope; rooms + room-anchored → room
 * scopes; actors + carried → cluster scopes). Every cell of one object
 * lands in one scope, so partitions are per-object atomic.
 *
 * Special rows:
 * - `session` cells key on session ids (no lineage); a session is
 *   authoritative at its ACTOR's cluster scope (CO14 "a session is a
 *   cell ... at the ACTOR's cluster scope"), so it partitions with the
 *   actor the row names.
 * - `log` cells never partition: the sequenced-log tail is scope-local
 *   recovery state (CO5 copy #1) — same posture as bridge.ts
 *   serializedFromCells. Plain Error: feeding one here is a caller bug.
 */
export function partitionCells<C extends TopologyCell>(cells: Iterable<C>): Map<string, C[]> {
  const materialized = [...cells];
  const lineage = lineageFromCells(materialized);
  const scopeOf = (object: string): string => scopeNameOf(object, lineage);
  const partitions = new Map<string, C[]>();
  const put = (scope: string, cell: C): void => {
    const bucket = partitions.get(scope);
    if (bucket) bucket.push(cell);
    else partitions.set(scope, [cell]);
  };

  for (const cell of materialized) {
    if (cell.kind === "log") {
      throw new Error(`log cells are scope-local and never partition: ${cell.object}`);
    }
    if (cell.kind === "session") {
      const actor = (cell.value as { actor?: unknown } | null | undefined)?.actor;
      if (typeof actor !== "string") {
        throw netError("E_LINEAGE", "session cell names no actor to partition by", { session: cell.object });
      }
      put(scopeOf(actor), cell);
      continue;
    }
    put(scopeOf(cell.object), cell);
  }
  return partitions;
}
