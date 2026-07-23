# Acts and projections

You have a room full of objects — tasks, notes, items — and you want a
collection view over them: a board, lane counters, an ordered tree.
The acts kernel ([`../../catalogs/acts/`](../../catalogs/acts/README.md))
gives you one way to build every such view:

1. The room records typed, schema-validated **acts** on its sequenced log.
2. Each view is a **projection**: an object in the room whose `:fold(act)`
   turns acts into rows, in the same turn that emitted the act.
3. Readers page the projection's `:view(opts)` — nobody scans the room's
   contents and recomputes.

One fact, one writer: the domain verb emits, the fold writes, the view
reads. You should already know how to write verbs
([programming-verbs.md](programming-verbs.md)) and package a catalog
([catalogs.md](catalogs.md)).

The normative rules are [Acts and projections](../../spec/semantics/acts.md).

## Choosing a pattern

| You want | Pattern | Shipped example |
|---|---|---|
| A row per object with phase/status (a board, a task list) | [Tracked collection](#pattern-tracked-collection) | `$task_board` (casework) |
| Counts per category (lanes, tallies, dashboards) | [Lanes & counters](#pattern-lanes--counters) | `$kind_lanes` (casework) |
| A view over structure that already lives on the objects (a tree, an ordered list) | [Relation checkpoint](#pattern-relation-checkpoint) | `$outline_meta` + `tree_view` (outliner) |

Every pattern follows the same four steps: **declare** the event types,
**emit** them from domain verbs, **fold** them into projection state,
**read** through a view. The first two steps are shared; the patterns
differ in what the fold keeps.

## Step 1: declare the events

Declare each act type and its payload shape in your manifest's
`schemas` block (from `catalogs/casework/manifest.json`):

```json
"schemas": [
  { "on": "$case", "type": "tasks.opened",
    "shape": { "task": "obj", "kind": "str", "labels": "list",
               "obligations": "list" } },
  { "on": "$case", "type": "tasks.claimed",
    "shape": { "task": "obj", "holder": "obj" } },
  { "on": "$case", "type": "tasks.closed",
    "shape": { "task": "obj", "outcome_code": "str" } }
]
```

**Rules**

- Namespace your types (`tasks.opened`) and keep them stable.
- Use the closed tag set: `obj`, `str`, `bool`, `int`, `float`, `num`,
  `list`, `map`, `null`, and unions like `"obj|null"`.
- Declare every key — validation requires each declared key and refuses
  any undeclared key.
- There are no optional fields — declare `"...|null"` and pass `null`.
- Keep `"str"` fields for bounded codes and labels; put prose in a
  `$note` and carry its ref as `"obj"` (`"str"` refuses object refs).

## Step 2: emit from a domain verb

Mount the `$acts` feature on each room instance once — at seed time
(casework `$case:initialize` calls `this:add_feature($acts)` and seeds
`this.projections = [board]`) or lazily on first use (outliner
`_ensure_acts`, shown under [Relation checkpoint](#pattern-relation-checkpoint)).

Then a domain verb performs its physical effect and records the fact in
the same turn (`$case:claim`):

```
verb :claim(task) rxd {
  let row = this:_board_row(task);
  if (row == null || row["phase"] != "active") { raise { code: "E_TRANSITION", message: "task is not claimable", value: task }; }
  if (!valid(task) || location(task) != this) { raise { code: "E_INVARG", message: "task not open here", value: task }; }
  moveto(task, actor);                 /* the move IS the lease */
  this:act("tasks.claimed", { "task": task, "holder": actor });
  return task;
}
```

**Rules**

- Emit only from the room's own verbs in sequenced turns (`:act`
  refuses direct calls and `caller != this`).
- Never emit from `enterfunc`/`exitfunc` or any movement/lifecycle hook
  (hook errors are swallowed, so a refused act is silently lost); a
  hook that needs a trace uses plain `observe(...)` and MUST NOT mutate a
  relation adopted by the Act model. Route the transition through a normal
  room domain verb or refuse it.
- Let contained objects delegate to a room verb; never hand an object a
  general emission capability.
- Carry only the domain fact in the payload — the log envelope already
  has space, seq, actor, timestamp, and verb (no duplicate outliner/room,
  `"when"`, or `"who"`). Artifact name/text/description stay on the artifact.
- Validate lifecycle transitions against fold state (`_board_row`),
  never against contents scans or location alone.
- Write no recovery code — if `:act` or any fold raises, the whole turn
  rolls back, physical effects included (fail-closed).
- If an operation destroys an object, emit and fold before calling a
  non-vetoable lifecycle primitive such as `recycle()`. Never catch an inverse
  operation that can reach `:act`.

## Pattern: tracked collection

**Use when** you want one row per object, keyed by the object, carrying
the phase/status the acts drive — a kanban board, a task list.

Declare the projection class and what it consumes:

```json
{ "local_name": "$task_board", "parent": "$projection",
  "properties": [
    { "name": "consumes", "type": "list", "perms": "",
      "default": ["tasks.opened", "tasks.claimed", "tasks.released",
                  "tasks.passed", "tasks.closed"] } ] }
```

Write the fold (`$task_board:fold`, trimmed — the shipped fold also
seeds `waits`/`links` and folds `tasks.passed` into obligations):

```
verb :fold(act) rx {
  let ty = act["type"];
  let p = act["payload"];
  let rows = this.rows;
  if (ty == "tasks.opened") {
    if (length(rows) >= this.row_cap) { raise { code: "E_QUOTA", message: "board row cap", value: this.row_cap }; }
    rows[to_string(p["task"])] = { "task": p["task"], "kind": p["kind"], "labels": p["labels"],
      "obligations": p["obligations"], "phase": "active",
      "opened_seq": act["seq"], "last_change_seq": act["seq"] };
  } else {
    let key = to_string(p["task"]);
    if (!(key in rows)) { raise { code: "E_INVARG", message: "act for unknown task", value: key }; }
    let row = rows[key];
    if (ty == "tasks.closed") { row["phase"] = "closed"; }
    row["last_change_seq"] = act["seq"];
    rows[key] = row;
  }
  this.rows = rows;
  this.at_seq = act["seq"];
}
```

Join names and holders at view time by overriding `:view_row`
(`$task_board:view_row`, trimmed):

```
verb :view_row(key, row) rx {
  let t = row["task"];
  let name = null;
  let holder = null;
  if (valid(t)) {
    name = t.name;                     /* artifact content: joined per page row */
    let loc = location(t);             /* the move is the one holder fact */
    if (loc != location(this)) { holder = loc; }
  }
  return { "task": t, "name": name, "holder": holder,
           "kind": row["kind"], "phase": row["phase"],
           "opened_seq": row["opened_seq"] };
}
```

Read through the view — `:view(opts)` pages `rows` in key order
(`limit` 1–200, default 50) and returns
`{ page, at_seq, cursor, has_more }`:

```
let page = board:view({ "limit": 50 });
let next = board:view({ "limit": 50, "after": page["cursor"] });
```

**Rules**

- Key rows by `to_string(object_ref)`.
- Rows store refs and seqs, never names, holders, or timestamps (join
  those in `:view_row`, per page row, never stored).
- Use `act["seq"]`, never `now()` and never the frame global `seq`
  (rebuild runs your fold outside a live turn).
- Be the sole writer of `this.rows` — no other verb ever writes it.
- Do O(payload) work per fold — never scan the room or the world.
- Raise `E_QUOTA` at `row_cap` — raising is the overflow policy.
- End every fold with `this.at_seq = act["seq"]`.
- Treat `at_seq` in view results as this projection's completeness
  watermark, not the room's head seq.

## Pattern: lanes & counters

**Use when** you want derived counts per category and later acts don't
carry the category (`tasks.closed` has no `kind`). Keep a small
per-object index beside the lane rows — never widen every payload to
carry every projection's needs.

Declare the aux index and its cap next to `consumes`:

```json
{ "name": "task_states", "type": "map", "default": {}, "perms": "" },
{ "name": "aux_cap", "type": "int", "default": 1000, "perms": "" }
```

The fold (`$kind_lanes:fold`, trimmed — `tasks.claimed`/`tasks.released`
move counts between lanes the same way):

```
verb :fold(act) rx {
  let ty = act["type"];
  let p = act["payload"];
  let key = to_string(p["task"]);
  let rows = this.rows;
  let states = this.task_states;       /* aux index: task -> { kind, state } */
  if (ty == "tasks.opened") {
    let kind = p["kind"];
    if (!(kind in rows)) {
      if (length(rows) >= this.row_cap) { raise { code: "E_QUOTA", message: "kind lane cap", value: this.row_cap }; }
      rows[kind] = { "kind": kind, "open": 0, "claimed": 0, "closed": 0 };
    }
    if (length(states) >= this.aux_cap) { raise { code: "E_QUOTA", message: "kind lane aux cap", value: this.aux_cap }; }
    let opened = rows[kind];
    opened["open"] = opened["open"] + 1;
    rows[kind] = opened;
    states[key] = { "kind": kind, "state": "open" };
  } else {
    if (!(key in states)) { raise { code: "E_INVARG", message: "act for unknown task", value: key }; }
    let st = states[key];
    let lk = st["kind"];
    let lane = rows[lk];
    if (ty == "tasks.closed") {
      if (st["state"] == "open") { lane["open"] = lane["open"] - 1; lane["closed"] = lane["closed"] + 1; }
      else if (st["state"] == "claimed") { lane["claimed"] = lane["claimed"] - 1; lane["closed"] = lane["closed"] + 1; }
      let kept = {};                   /* terminal eviction keeps the index bounded */
      for sk, sv in states {
        if (sk != key) { kept[sk] = sv; }
      }
      states = kept;
    }
    rows[lk] = lane;
  }
  this.rows = rows;
  this.task_states = states;
  this.at_seq = act["seq"];
}
```

**Rules**

- Be the sole writer of the aux index, same as the rows.
- Give every auxiliary structure its own cap and raise `E_QUOTA` at it.
- Evict aux entries only on terminal transitions, and only when the
  domain verbs refuse transitions out of terminal states (otherwise a
  later act could need the evicted entry).
- Keep the fold deterministic from (state, act) — no clock, no
  randomness, no reads of other objects.
- Make rebuild reproduce the rows *and* the aux index — test both.

## Pattern: relation checkpoint

**Use when** the structure already lives on the objects themselves.
The outliner's tree is `__ordered_edge` cells (parent + rank) read by
owner-computed builtins — that relation is already the single writer
per fact. Never fold it into rows (mirroring creates two authorities
for one structure); publish only a watermark.

The whole fold (`$outline_meta:fold`):

```
verb :fold(act) rx {
  this.at_seq = act["seq"];
}
```

`consumes` names exactly the structural act types:

```json
{ "name": "consumes", "type": "list", "perms": "",
  "default": ["outline_item_added", "outline_item_removed",
              "outline_item_moved", "outline_item_reordered",
              "outline_item_hidden"] }
```

Look up the projection by validation, never by position
(`$outliner:_acts_meta` — a stale ref can make `isa()`/`location()`
raise, so a throwing entry is skipped, never trusted):

```
verb :_acts_meta() rx {
  for p in this.projections {
    let ok = false;
    try { ok = valid(p) && isa(p, $outline_meta) && location(p) == this; } except err { ok = false; }
    if (ok) { return p; }
  }
  return null;
}
```

Mount lazily and self-heal (`$outliner:_ensure_acts` — call it before
each `this:act(...)`):

```
verb :_ensure_acts() rx {
  let meta = this:_acts_meta();
  let kept = [];
  let changed = false;
  for p in this.projections {          /* prune dead/foreign entries */
    let ok = false;
    try { ok = valid(p) && isa(p, $projection) && location(p) == this; } except err { ok = false; }
    if (ok) { kept = kept + [p]; } else { changed = true; }
  }
  if (meta == null) {
    meta = create($outline_meta, { owner: this.owner, name: "outline_meta", location: this });
    kept = kept + [meta];
    changed = true;
  }
  if (changed) { this.projections = kept; }
  for f in this.features { if (f == $acts) { return true; } }
  this.features = this.features + [$acts];
  this.features_version = this.features_version + 1;
  return true;
}
```

The authoritative read joins the substrate structure with the watermark
(`$outliner:tree_view`):

```
verb :tree_view() rxd {
  let meta = this:_acts_meta();
  let ws = 0;
  if (meta != null) { ws = meta.at_seq; }
  return { "items": this:list_items(), "structure_at_seq": ws };
}
```

**Rules**

- Never fold structure the substrate already owns — checkpoint it.
- Still emit one act per structural change (validated, refusable,
  replayable), guarded exactly like any other emission.
- Return the watermark under a domain name (`structure_at_seq`); it
  advances only when a consumed structural act folds on this room's log.
- Track non-acted changes (item text and writer grants) with a separate
  read-generation — the structural watermark
  does not cover them.
- In browser UI, put that read-generation in the generic semantic-view facade,
  not in a component-owned hydrator. Outliner registers `outliner.tree`, reads
  `tree_view`, and invalidates for both structural acts and the non-acted
  changes above.
- Prune `this.projections` when you touch it — the kernel reads
  `consumes` on every entry, so one dead ref breaks every emission.
- Wrap `isa()`/`location()` on stored refs in try/except and treat
  "threw" as invalid.

## DSL survival notes for fold authors

| Gotcha | Do this |
|---|---|
| Locals are function-scoped; a second `let x` anywhere is a compile error | Declare once, assign thereafter |
| `args`, `seq`, `space`, `caller`, `this`, `actor`, `player`, `progr`, `message`, `verb` are reserved | Never use them as names; read `act["seq"]`, never `seq` |
| Nested writes don't persist (`this.rows[k] = v` is lost) | `let rows = this.rows; rows[k] = v; this.rows = rows;` — same one level down for a row |
| Map keys and coercions | `to_string(x)` (the catalogs never use the `tostr` alias) |
| Raising | `raise { code: "E_QUOTA", message: "board row cap", value: this.row_cap };` — `code` and `message` always, `value` for the datum |
| Membership | `x in some_list` for lists, `"key" in some_map` for keys |
| Everyday toolkit | `keys(m)`, `length(x)`, `typeof(x)`, `has(m, k)`, `valid(ref)`, `isa(obj, $class)`, `floor(n)` |

## Before you ship

- Write the rebuild test: run a scripted lifecycle, then on a fresh
  projection loop `rebuild_from(room, budget)` until `done`, and assert
  `rows` *and* every auxiliary property equal the live projection's;
  run it again and assert nothing changed. See
  [`../../tests/acts-kernel.test.ts`](../../tests/acts-kernel.test.ts).
- Test the refusals: drive one turn past a cap and assert the turn
  failed closed — no row, no surviving physical effect.
- If you changed an observation's wire shape, make the browser client
  tolerate both shapes (old worlds replay old recorded entries).
- Audit every property write in your manifest: one writer per
  coordination fact, and that writer is a fold.

## Where the examples live

- [`../../catalogs/acts/`](../../catalogs/acts/README.md) — the kernel:
  `$acts` (emission) and `$projection` (fold/view/rebuild), with
  [DESIGN.md](../../catalogs/acts/DESIGN.md) for the contracts and
  rationale.
- [`../../catalogs/casework/manifest.json`](../../catalogs/casework/manifest.json)
  — `$case`, `$task_board`, `$kind_lanes`.
- [`../../catalogs/outliner/manifest.json`](../../catalogs/outliner/manifest.json)
  — guarded emission on real verbs, and the `$outline_meta` /
  `tree_view` relation checkpoint.
