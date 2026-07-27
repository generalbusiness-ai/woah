# Closing create → install → invoke (2026-07-26)

Working notes for the two commits on `worktree-programmer-environment-plan`
above main `0d6b0a52`. Not a spec; the normative statements landed in
`spec/protocol/coherence.md` (CO2.3, CO2.6, CO13).

## The ask, and what it actually cost

Default `$builder:create`'s `opts.location` to the author, so a freshly created
object is in the author's inventory and its new verb can become an MCP tool.
LambdaMOO's `@create` does exactly this, and the programmer plan §6.4 already
prescribed it.

The one-line change was correct. It was also the first thing that had ever
driven a runtime object into a container over Net and then read it back, so it
uncovered three substrate bugs that stood between "the verb is in the database"
and "an agent can call it".

## Two gates, not one

Reachability is the conjunction of two independent conditions. Both are now
asserted in `tests/worker/net-mcp-programmer.test.ts`.

1. **Placement.** The object must be in structural context —
   `mcpContextObjects` = self + active space + its contents + inventory. An
   object in no container is reachable only through its returned id.
2. **Exposure.** `mcpActiveCommandContext` grants command-shaped affordances to
   the ROOM and its contents, deliberately not to self or inventory. So an
   inventory object advertises only verbs marked `tool_exposed`, and the author
   opts in through `set_verb_info`. `install_verb` refuses metadata options (the
   source header is canonical for perms), which is why exposure is always a
   separate, visible act.

The user's framing assumed gate 1 was the whole story. It isn't, and the
distinction is worth keeping: gate 1 is about where the object *is*, gate 2 is
about what its owner *intends to publish*.

## The three substrate bugs

Each has a regression test verified to fail without its fix.

### 1. E_VERBNF value-shape divergence

`ownVerbResolve` raised `{obj, descriptor}`. `src/net/plan.ts sparseMissingKeys`
reads `{obj, name}` to derive the `verb_bytecode:<obj>:<name>` cell to grow the
turn's slice. The spelling mismatch made the miss underivable, so the planner
treated a slice-absent verb page as *semantic absence* and the turn died
terminally — with the page sitting resident in the gateway view.

Blast radius was much wider than this feature: **any** verb-metadata read on an
object that is not the call target. The planning seed holds the actor's and
target's class chains, so a verb page belonging to an ARGUMENT is never covered
by construction. `set_verb_info(other, "hi", …)` was simply broken over Net.
`list_verb` worked only by accident — its own hand-written `raise` happens to
spell the key `name`, so its first miss repaired the slice and the later
`verb_info` call found the page.

This retires an earlier note that called it "a general Net mechanic: over Net
`verb_info` doesn't pull-on-miss the arg's verb page". It was a bug.

Fixed at the raiser (one shape) plus `descriptor`/`verb` tolerance in the
derivation, so a future divergence degrades to a repairable miss instead of a
terminal error.

### 2. No create-time contents relation

`object_create` records placement inline, so a create-with-location produces
neither an entry in `transcript.moves` nor a contents projection write.
`deriveRelationDeltas` read only those two sources, so the membership row never
existed — and the object was absent from every contents-derived surface (MCP
structural context, room presentation, roster hydration) while its
`object_live.location` was perfectly correct.

Now derived from `transcript.creates`. Set semantics per `(op, row)` collapse a
create-then-move within one turn to a single destination row.

Note both the create and move paths emit rows owned by `$nowhere` when that is
the destination. That is pre-existing and inert (nothing queries `$nowhere`'s
contents), and the two paths are left consistent rather than special-cased in
one place only.

### 3. `owns` read rider residue as ownership

A create whose new object anchors to another scope still commits at the
shared/planning scope — that scope serializes the mint — and rides the object's
cells to its anchor. The committing scope keeps a lineage COPY, by design
("WRITES are never filtered": that is what makes CA3 atomic).

`owns(object)` was "this store holds `object_lineage:<object>`", so the room
claimed an object it does not sequence. Any later turn committing there that
read a cell of that object living only at the anchor took the LOCAL branch,
found "absent", and rejected `read_version_mismatch` — with no possible repair,
because no refresh can move a foreign cell into that store. The gateway loop
escalated to terminal `E_NONCONVERGENT_READ`.

The rider residue ledger already existed for exactly this, and its own comment
already said "`owns` never claims them" — only the CO14 session case had been
wired. Generalized to `ownsCellLocally`.

## Separately: the shared MCP walkthrough was broken on main

`smoke:net-mcp` failed at its first step. **Baselined on the predecessor commit
before attributing** — it failed identically there, so it was not caused by this
work.

`f0edc163` removed the misleading tool scope `"all"` (never a global
enumeration; it fell through to the same closure as `"active"`), updated two
agent docs and one test, and missed four callers in the smoke scripts. The lane
then died with `cannot establish alice current room from reachable tools`, which
reads as a movement or presence fault — that is why it went undiagnosed.

Three fixes: move the callers to `"active"`; make `ensureInChatroom` report a
refused tool call verbatim instead of letting it fall through the "no page"
branch; and add `guard:smoke-mcp-args`, which parses the accepted literals out
of `mcpToolScope()` itself and fails if a smoke caller passes anything else. No
allowlist. The smoke scripts are the only place these arguments are written by
hand, so nothing else covers that seam.

`smoke:net-mcp` 0/1 → 14/14. This also unblocks the deployed
`smoke:walkthrough`, which shares the scenario.

## Closed: deployed worlds are repairable (`repair-contents`)

Bug 2 is fixed going forward. It does **not** repair existing state, and the gap
is not hypothetical: several bundled catalogs create with an explicit location
at runtime —

- `catalogs/outliner` — `$outline_item`, `$outline_meta`
- `catalogs/tasks` — `$task`
- `catalogs/dispenser` — `$dispensed_note`, `$dispenser_queue`
- `catalogs/casework` — `$note`, `$task_board`

so every such object created over Net since the cutover has no `contents`
relation row at its container. Consumers are the contents-relation surfaces
listed above; the affected catalogs largely read their own ordered-edge and
projection state instead, which is why nothing has visibly failed.

`ScopeSequencer.rebuildRelations()` is the CO13 bounded repair and it is
implemented and unit-tested — but it has **no production caller**, and it could
not simply be wired up: it DELETES contents rows absent from its local
derivation, and a row this scope owns whose member is anchored elsewhere
arrived by `/net/relate` and is invisible to a local cell scan. Wiring it would
have traded missing rows for deleted ones. The fixture-scoped
`scripts/net-repair-relations.ts` cannot substitute either; it deliberately
refuses any id that is not in a bundled image, precisely so user objects are
never inferred from bootstrap state.

`POST /net-install/scope/<name>/repair-contents` (`npm run repair:net-contents`)
is the answer, and it is **add-only** for exactly the reason above. Design notes
worth keeping:

- Each scope derives candidates from its OWN `object_live` cells. That is the
  O(scope size) bound CO13 already sanctions; the operator names SCOPES, which
  is namespace knowledge, not world knowledge. Nothing enumerates objects.
- Add-only buys idempotence for free: an identical row reports no change, so a
  second run advances no head and refans nothing.
- Ownership uses the same `ownsCellLocally` predicate read validation uses, so
  the repair cannot mint rows for an object the scope does not sequence.
- Cross-scope membership rides the ordinary `/net/relate` lane. Anchor topology
  is caller knowledge, so an unmapped owner is reported, never guessed.
- **Repair deliveries need their own `(from_scope, seq)` lane.** The receiver
  gate is `seq <= last` with `last` defaulting to 0, so a repair borrowing the
  commit seq stream is suppressed outright at head 0 — and worse, borrowing a
  seq the commit stream has not reached yet would make the receiver DROP the
  real delta that later lands on it. This was found by the cross-scope test
  failing, not by inspection.

Proven on real workerd as well as the fake-DO lane: seed an aged scope, repair,
re-repair, and read the membership back through a cold gateway's own pull.
