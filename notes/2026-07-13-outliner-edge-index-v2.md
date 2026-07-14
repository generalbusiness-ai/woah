# Outliner v2 — normalized room-owned ordered-edge index

Origin: post-cutover, the outliner is non-functional over the net path. The
root loop (sparse repairs not surviving re-plan) is fixed by the `seedObjects`
substrate change (64f6ba5), but that only changes the failure mode: because
`add_item` reads **every** sibling's `parent`/`position` (`object_siblings_ordered`
→ `collectObjectTreeRecords`) and rewrites **every** sibling's `position`
(`_renumber_siblings`), the repaired read+write closure is O(N-siblings) and blows
the hard 64 KiB warm-envelope limit at ~30 siblings (`E_INTERNAL`). A 120-item
production outline is structurally unsupported. The limit must NOT be raised
("shrink the read closure, do not raise the ceiling"). This note specifies the
bounded replacement.

## Model: ordered-edge index, room-authoritative

One authored cell per item edge, owned by the outliner room:

```
edge(child) = { parent: <ref|null>, rank: <fractional-rank-string> }
```

- **Dual index** (authority-side): by `child` (an item's own edge → its parent
  and rank in O(1)); by `(parent, rank)` ordered (siblings of a parent in rank
  order; neighbor lookup for insertion in O(1) via the index, not an O(N) scan).
- **Fractional ranks** (lexical, e.g. base-62 midpoint keys): insert between
  neighbors a and b = one rank strictly between `rank(a)` and `rank(b)`; append =
  one rank after the current max. Mutation writes exactly ONE edge cell and reads
  only the bounding neighbor(s). No renumber.
- **Sole authority.** The `$outline_item` `parent`/`position` properties are
  REMOVED. The edge index is the only structural source; there is no second write
  path. `contents(room)` still lists the item objects (membership), but ORDER and
  HIERARCHY come only from edges.

## Bounded reads: owner-computed projection (the room_roster pattern)

Listing a parent's ordered children is an **owner-computed bounded projection**,
fetched by the gateway from the room authority (mirror `POST /net/room-roster` →
add `POST /net/outline-order` or fold into a generic ordered-edge projection) and
installed ONLY in the ephemeral planning world — never O(N) edge cells in the
turn's attestable read closure. A verb reads the ordered children as one projection
value, exactly as chat reads `room_roster`. Mutation neighbor lookups are the same
bounded owner query parameterized by `(parent, target-index)`.

This keeps BOTH the display read (list children) and the mutation read (find
neighbors) off the O(N)-cells path; the only authored write is the single new/moved
edge.

## Verbs (rewritten; no behavior change to users)

- `add_item(text, parent, index)`: owner query for the neighbor ranks at `index`
  under `parent` → fractional rank; create item; write ONE edge. O(1) cells.
- `move_item` / reparent / reorder: compute one new rank; rewrite ONE edge.
- `remove_item`: recycle item; delete its edge; re-home children by rewriting
  THEIR edges' `parent` (bounded to the direct children moved, each one edge).
- `_siblings_ordered(parent)`: the owner-computed ordered projection. No contents
  scan, no per-item property reads.

## Migration v1.0.1 → v2.0.0 (`catalogs/outliner/migration-v1-to-v2.json`)

- For each outliner, walk existing items; derive edges deterministically from
  `(parent, position)`, **tie-breaking by item id** so the order is total and
  reproducible; assign initial fractional ranks by that order.
- Make edges authoritative; DROP the legacy `parent`/`position` item fields so no
  second write path remains.
- Idempotent (re-run yields identical edges). Test-run on a local SQLite woo.

### Migration validations (must assert)
- No duplicate edges (one edge per child).
- No dangling parents (every edge parent is an item in the same outliner or null).
- No cycles (walk child→parent terminates).
- Stable ordering (re-deriving from the same input yields identical ranks).

## Gates (permanent)

1. **Generic monotonic-repair gate** (substrate): a successfully refreshed
   `(cell, version)` MUST NOT recur as the same read_version_mismatch on the next
   re-plan (locks in `seedObjects`; independent of the outliner).
2. **Catalog-scale gate**: at a realistic outline size (>= the supported target,
   e.g. 120 children), a cold `add`/reorder asserts BOUNDED: attempts <= small
   constant, envelope bytes < 64 KiB with margin, read count O(1) in sibling count,
   write count O(1). This is the gate that fails today and forces the bounded model.

## Retained from this branch

- `seedObjects` sticky-repair (64f6ba5) — general substrate fix, keep.
- `E_NONCONVERGENT_READ` detector — the by-construction backstop, keep.

## Staging

1. Fractional-rank helper + edge cell representation + owner-computed ordered
   projection (substrate/native), with unit tests.
2. Outliner verbs rewritten to edges; catalog → v2.0.0.
3. Migration + validations; SQLite test-run.
4. Both gates green; `test:worker` + `npm test` clean; spec (`spec/` outliner/
   projection sections) aligned.
