# Acts and projections

This page is for builders. It explains how to put a feature on the
**acts kernel**: how to declare the events your room records, how to
record them, and how to derive the lists, boards, and counters your
users actually look at. You should already know how to write verbs
([programming-verbs.md](programming-verbs.md)) and package a catalog
([catalogs.md](catalogs.md)).

The kernel itself is the `acts` catalog
([`../../catalogs/acts/`](../../catalogs/acts/README.md)). The worked
example through this page is the task board from
[`../../catalogs/casework/`](../../catalogs/casework/manifest.json) —
a room where tasks are opened, claimed, and closed, with a kanban-style
board and per-kind lane counts derived from the record.

## 1. The idea

Every room has a sequenced log: an ordered, durable record of the
turns applied to it. The acts kernel adds one discipline on top:

> The room's log of typed, schema-validated **acts** is the one
> authoritative record of coordination state. Every list, board,
> counter, or timeline is a **projection**: a fold over that log.

Concretely, when someone claims a task, the room records one act —
`tasks.claimed` with its payload — in the same sequenced turn that
performed the claim. The board's row for that task is written by the
board's fold as part of the same turn. Nothing else ever writes it. A
reader asks the projection for a page; nobody scans the room's
contents and recomputes.

Why this is worth the ceremony: every coordination bug this codebase
has actually shipped — a list that disagrees with reality, a repair
loop that never converges, a peer who never sees an update — came from
**two writers for one fact**. A verb wrote a status property here, a
tracking list there, and the two drifted. With the acts model there is
exactly one write path per fact, so that entire bug class cannot occur:
if the fold ran, the row is right; if it didn't, the act isn't in the
log either.

Two kinds of state deliberately stay **outside** the record, and your
projections must never copy them into rows:

1. **Artifact content** — a `$note`'s name, description, and text.
   Acts carry a *reference* to the note; the row stores the reference.
2. **Physical location** — where an object actually is (who is holding
   the task). The substrate `moveto` relation is the only holder fact.

Both are **joined at view time**: when a page of rows is rendered, the
view reads `task.name` and `location(task)` right then. There is no
"keep the row's copy of the name in sync" problem because there is no
copy.

## 2. Declaring your vocabulary

Acts are typed, and every type has a declared payload shape. You
declare both in your catalog manifest's `schemas` block:

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

- `on` is the class the schema is declared for. Lookup follows verb
  dispatch: the emitting room's class chain first, then its features in
  declared order.
- `type` is `namespace.name` — pick a namespace for your domain and
  keep it.
- `shape` is a flat map of key to type tag.

The type tags are a small closed vocabulary: `obj`, `str`, `bool`,
`int`, `float`, `num`, `list`, `map`, `null`, and unions written as
alternatives — `"obj|null"` means "an object ref or null".

Validation is strict in both directions. **Every declared key is
required** in the payload, and **any undeclared key is refused**.
There are no optional fields; if a field can be absent, declare it
`"...|null"` and pass `null`.

One tag deserves special attention: `"str"` refuses live object
refs. Object refs are strings at the VM level, so without this rule an
object could slip into a field meant for a label. The consequence for
your design: **string fields are for bounded codes and labels, not
prose**. If users or external systems supply free text, put it in a
`$note` and let the act carry the note's ref (`"obj"`). That keeps
attacker-controlled prose out of the authoritative record and inside
the artifact-content carve-out where it belongs.

## 3. Emitting acts

Your room emits acts by calling `this:act(type, payload)` from its own
verbs. The primitive comes from the `$acts` feature; mount it on each
room instance before the first emission. The standard idiom is a lazy,
idempotent helper (room instances start with an empty `features` list,
so a class-level attach does not reach them):

```
verb :_ensure_acts() rx {
  for f in this.features { if (f == $acts) { return true; } }
  this.features = this.features + [$acts];
  this.features_version = this.features_version + 1;
  return true;
}
```

Then a domain verb performs its physical effect and records the fact,
in the same turn:

```
verb :claim(task) rxd {
  let row = this:_board_row(task);
  if (row == null || row["phase"] != "active") {
    raise { code: "E_TRANSITION", message: "task is not claimable", value: task };
  }
  moveto(task, actor);                 /* the move IS the lease */
  this:_ensure_acts();
  this:act("tasks.claimed", { "task": task, "holder": actor });
  return task;
}
```

Three rules are enforced by `:act` itself, and refusal raises:

- **Sequenced turn only.** `:act` requires a real entry on the room's
  own log (`seq >= 1` and `space == this`). A direct (unsequenced)
  call is refused — there is no log entry to be the record.
- **Your room's own verbs only.** `caller == this` must hold. A
  contained object that wants a fact recorded delegates to a room
  verb — `$task:claim()` calls `this.registry:_claim_task(this)` — so
  the room verb validates and emits. Objects never get a general
  emission capability.
- **Valid payload only.** The type must be declared (section 2) and
  the payload must match its shape exactly.

**Don't duplicate the envelope.** The log entry already records the
sequence number, the acting actor, the timestamp, and the verb that
ran. Your payload carries only the domain fact. A payload with a
`"when"` or a duplicated `"who"` is a design smell: two copies of one
fact is exactly what this model exists to eliminate.

**What refusal looks like.** If `:act` refuses — or a projection's
fold raises (section 4) — the *entire turn* rolls back: the act, all
fold writes, and every physical effect the verb performed, including a
freshly minted artifact or a `moveto`. The log keeps a failed entry
whose only observation is the `$error`. This is deliberate and it is
called **fail-closed**: the system never commits a physical change
whose coordination fact was not recorded. You do not need recovery
code; you need to accept that a refused turn did nothing.

**Hard rule: never call `:act` from `enterfunc`, `exitfunc`, or any
movement/lifecycle hook.** Two independent reasons, either fatal:
hooks run with their errors swallowed (a failed hook must not fail the
move, per the substrate's moveto contract), so a refused emission
disappears silently — the move commits and the fact is simply lost,
the exact failure mode the kernel exists to prevent. And a hook can
run inside *another* room's sequenced turn, where `space != this`
refuses your emission anyway. Emit only from your room's own verbs, in
turns your room owns. If a hook needs to leave a trace, use a plain
`observe(...)` — visible, but never authoritative.

## 4. Writing a projection

A projection is a small object, subclassed from `$projection` (from
the `acts` catalog), that lives in the room and turns acts into rows.
Declare which types it consumes, write one fold, and seed it into the
room's `projections` list (the casework `$case:initialize` verb shows
the seeding).

```json
{ "local_name": "$task_board",
  "parent": "$projection",
  "properties": [
    { "name": "consumes", "type": "list", "perms": "",
      "default": ["tasks.opened", "tasks.claimed", "tasks.released",
                   "tasks.passed", "tasks.closed"] }
  ] }
```

When the room's `:act` accepts an act, it calls `:fold(act)` on every
attached projection whose `consumes` includes the type — inside the
same turn.

### The fold contract

Your `:fold(act)` is the heart of the feature. Hold it to this
checklist:

- **You are the sole writer of all your projection state** — `rows`
  and any auxiliary index you keep beside it. No other verb, ever,
  writes these properties (they are declared `perms ""` so only
  catalog-author code can).
- **Deterministic from (state, act).** Same state, same act, same
  result — no clock, no randomness, no reads of other objects.
- **Use `act["seq"]`, never `now()` and never the `seq` frame
  global.** The kernel injects the envelope's sequence number into the
  fold input precisely so your fold can also run *outside* a live turn
  during rebuild. Rows store seqs (`opened_seq`, `last_change_seq`),
  never timestamps; views resolve times from the log when asked.
- **O(payload) work.** A fold runs on every consumed act on a possibly
  hot room; it must not scan the world.
- **Declare your bounds.** `row_cap` is inherited (default 1000);
  every auxiliary structure declares its own cap too. On overflow,
  `raise { code: "E_QUOTA", ... }` — that *is* the overflow policy.
  Evict auxiliary entries only on terminal states, and only when the
  domain verbs refuse transitions out of terminal states (otherwise a
  later act could need the evicted entry).
- **Raising aborts the caller's whole turn.** That is the refusal
  mechanism, not an accident — there is no catch around your fold. A
  fold must either apply completely or raise before writing.
- **Advance the watermark.** End by setting
  `this.at_seq = act["seq"]`.

The casework board fold, trimmed to the pattern:

```
verb :fold(act) rx {
  let ty = act["type"];
  let p = act["payload"];
  let rows = this.rows;
  if (ty == "tasks.opened") {
    if (length(rows) >= this.row_cap) {
      raise { code: "E_QUOTA", message: "board row cap", value: this.row_cap };
    }
    rows[to_string(p["task"])] = {
      "task": p["task"], "kind": p["kind"], "labels": p["labels"],
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

Notice what the row does *not* contain: no task name, no holder, no
timestamp. Also notice `tasks.claimed` barely folds at all — the move
is the authoritative claim fact; the row only bumps
`last_change_seq`.

Sometimes the consumed payloads don't carry the dimension your rows
are keyed by. The `$kind_lanes` projection (per-kind open/claimed/
closed counts) hits this: `tasks.closed` doesn't say what kind the
task was. The answer is **auxiliary fold state** — it keeps a private
`task_states` map from task to kind beside its lane rows. That is
allowed, with the same contract: the fold is the sole writer of it,
it has its own cap (`aux_cap`), it is evicted on the terminal
transition, and the rebuild invariant covers it too. What is *not*
allowed is widening every payload to carry every projection's needs —
payload shapes serve the domain fact.

### Views

`$projection` gives you `:view(opts)` — the one authoritative bounded
read. It pages `rows` in key order and returns
`{ page, at_seq, cursor, has_more }`. Callers page with a continuation
cursor: pass `opts["after"] = previous page's cursor` for the next
page. `at_seq` is the seq of the last act *this projection* consumed —
a conservative completeness watermark ("correct at least as of here"),
not the room's head seq; two projections on one room can legitimately
report different values.

You customize rendering by overriding `:view_row(key, row)`. This is
where the carve-outs are joined, per page row and never stored:

```
verb :view_row(key, row) rx {
  let t = row["task"];
  let name = null;
  let holder = null;
  if (valid(t)) {
    name = t.name;                       /* artifact content: view-time join */
    let loc = location(t);               /* the one lease fact */
    if (loc != location(this)) { holder = loc; }
  }
  return { "task": t, "name": name, "holder": holder,
           "kind": row["kind"], "phase": row["phase"],
           "opened_seq": row["opened_seq"] };
}
```

### Rebuild

`$projection:rebuild_from(source_space, page_budget)` re-folds the
*recorded* acts from the room's log — never re-executing verbs, and
skipping failed entries. It is incremental (resumes past what has
already been folded or scanned), idempotent (calling it again never
double-folds), and bounded (one replay page per call). Drive it in a
loop until the result's `done` is true. It exists for operators and
for your tests; the invariant it demonstrates is the model's whole
claim:

```
fold(recorded acts, in order) == the live projection state
```

## 5. The watermark pattern

Sometimes the structure you want to project **already has a substrate
authority**. The outliner's tree is the example: each item carries an
`__ordered_edge` cell (parent + fractional rank), and
`object_tree_rows(...)` derives the whole tree from those cells. That
relation *is* the tree's single writer-per-fact record.

Do not mirror it. A projection that folded `outline_item_added` into
its own tree rows would recreate two authorities for one structure —
the exact disease. Instead the outliner ships a **watermark-only
projection**, `$outline_meta`: it consumes the five structural act
types, keeps no rows at all, and its entire fold is one line:

```
verb :fold(act) rx {
  this.at_seq = act["seq"];
}
```

The authoritative read then joins the substrate read with the
watermark:

```
verb :tree_view() rxd {
  let ws = 0;
  if (length(this.projections) >= 1) { ws = this.projections[1].at_seq; }
  return { "items": this:list_items(), "at_seq": ws };
}
```

Clients get the tree from its real authority plus an `at_seq` that
tells them how current it is. Use this pattern whenever a substrate
relation already owns the shape: acts still record *that* changes
happened (validated, refusable, replayable), and the projection layer
adds only what the substrate doesn't have — the completeness
watermark, and any act-derived indexes the substrate can't provide.

## 6. DSL survival notes for fold authors

Woocode (spec:
[`../../spec/semantics/language.md`](../../spec/semantics/language.md))
has a few properties that reliably trip people writing their first
fold. Read these before you fight the compiler:

- **Locals are function-scoped and cannot shadow.** A second
  `let x = ...` anywhere in the verb — including inside a loop or an
  `if` branch — is a compile error (`duplicate local: x`). Declare
  once, assign thereafter.
- **`args`, `seq`, `space`, and `caller` are reserved frame
  globals** (along with `this`, `actor`, `player`, `progr`,
  `message`, `verb`). You cannot use them as local or parameter names,
  and inside a fold you must not *read* `seq` — use `act["seq"]`
  (section 4).
- **Mutate maps and lists through a local, then write the whole
  property back.** `this.rows[k] = v` does not persist a nested
  update. The working pattern is:
  `let rows = this.rows; rows[k] = v; this.rows = rows;` — and the
  same one level down for a row: read the row into a local, change it,
  assign it back into the map, then write the map back.
- **Use `to_string(x)`**, not `tostr(x)`, for map keys and coercions —
  `tostr` is accepted as an alias, but the catalogs consistently use
  `to_string`.
- **`raise` takes a map**: `raise { code: "E_QUOTA", message: "board
  row cap", value: this.row_cap };`. `code` and `message` always;
  `value` for the offending datum.
- **`in` does double duty**: `x in some_list` is membership,
  `"key" in some_map` is key presence. Both are ordinary boolean
  expressions.
- Your everyday toolkit is available: `keys(m)`, `length(x)`,
  `typeof(x)`, `has(m, k)`, `valid(ref)` (is this a live object?),
  `isa(obj, $class)`, `floor(n)`.

## 7. Before you ship

- **Write the rebuild test.** Run a scripted lifecycle, then create a
  fresh instance of your projection, loop `rebuild_from` to done, and
  assert its state — `rows` *and* every auxiliary property — equals
  the live projection's. Run rebuild a second time and assert nothing
  changed (idempotence). See
  [`../../tests/acts-kernel.test.ts`](../../tests/acts-kernel.test.ts)
  for the shape.
- **Test the refusals.** Drive one turn into your cap and assert the
  turn failed closed: a failed log entry with only the `$error`, no
  row, and no surviving physical effect.
- **If you changed any observation's wire shape**, the browser client
  must tolerate **both** shapes — old worlds replay old recorded
  entries, and aged deployed definitions keep emitting the old shape
  for a while. A reducer that only understands the new envelope breaks
  on real history.
- **Check every property write in your manifest.** Each coordination
  fact should have exactly one writer, and it should be a fold.

Where the examples live:

- [`../../catalogs/acts/`](../../catalogs/acts/README.md) — the
  kernel: `$acts` (emission) and `$projection` (fold/view/rebuild),
  with [DESIGN.md](../../catalogs/acts/DESIGN.md) for the contracts.
- [`../../catalogs/casework/manifest.json`](../../catalogs/casework/manifest.json)
  — the full worked example: `$case`, `$task_board`, `$kind_lanes`.
- [`../../catalogs/outliner/manifest.json`](../../catalogs/outliner/manifest.json)
  — guarded emission on real verbs, and the `$outline_meta` /
  `tree_view` watermark pattern.
- [`../../notes/2026-07-21-acts-projection-model.md`](../../notes/2026-07-21-acts-projection-model.md)
  — the design note behind all of it.
