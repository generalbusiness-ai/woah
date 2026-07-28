# Verb slots over Net — every authored verb landed on slot 1

Worktree `worktree-net-verb-slot`, branched from `worktree-integration-trial`.

Found by a sibling agent probing the raw gateway view while fixing MCP verb
resolution: two verbs authored on one object through the Net authoring path both
carried `slot: 1`. That agent contained the blast radius with a fail-closed MCP
refusal (`E_MISSING_STATE` / `verb_order_unavailable`) and reported the
substrate defect rather than fixing it. This note records the investigation and
the fix.

## What the probe actually showed

Instrumenting `addVerbForActor` and driving the fake-DO Net lane against a
PRE-INSTALLED object whose verbs carried real slots 1/2/3:

```
PROBE pre-install slots        [["alpha",1],["bravo",2],["charlie",3]]
PROBE seeded view slots        [["alpha",1],["bravo",2],["charlie",3]]
PROBE addVerbForActor delta    residentVerbs= []
PROBE set_verb_info charlie -> slot 1          (authoritative slot was 3)
PROBE after set_verb_info      [["alpha",1],["bravo",2],["charlie",1]]
PROBE install delta ->         slot 1
PROBE after install            [["alpha",1],["bravo",2],["charlie",3→1],["delta",1]]
PROBE verbs(#widget) ->        []
PROBE list_verb charlie ->     slot 1
```

Three things are worse than the reported symptom:

- **Editing metadata DEMOTED a live verb.** `set_verb_info(obj, "charlie",
  {aliases})` committed charlie's slot as 1, colliding with `alpha`. For a pair
  like `zulu`@1 / `alpha`@2, demoting `alpha` inverts their resolution order.
- **`verbs(obj)` answered `[]`** for a three-verb object.
- **`list_verb` reported slot 1** for a verb whose authority held slot 3, so a
  slot descriptor an agent read back addressed a different verb.

The gateway VIEW held all three pages the whole time. The problem was never the
view.

## Root cause: three independent mechanisms

**1. Hydration.** `importWorld` → `cloneImportedVerb(verb, index + 1)`
(world.ts, three call sites) OVERWROTE each page's stored slot with its position
in the array being hydrated. `serializedFromCells` sorts by stored slot
precisely so order survives the wire (bridge.ts:271, with a comment saying
"importWorld reassigns slots from array order") — and then the importer threw
the value away. On a full world index+1 == slot, so this was invisible. Under
Net the array is the turn's SLICE, so a one-page slice reported the object's
third verb as its first. Because every authoring write re-serializes the page it
touched (`recordAuthoredVerbWrite` sends the whole VerbDef minus line_map), the
lie was committed back as authority.

**2. Allocation.** `addVerb({append:true})` pushed at `obj.verbs.length` and
`selectOwnVerbForInstall` projected `obj.verbs.length + 1`, both over that same
slice. For an object reached as a call ARGUMENT the slice held ZERO verb pages,
so every append computed 1.

Why zero, precisely — this is the part worth remembering. `buildSeedSlice`
(plan.ts) seeds the full cell set of the actor's and target's class chains and
of refs found inside seeded cell VALUES, and the growth loop then adds only keys
a miss NAMES. `sparseMissingKeys` can name `object_lineage`/`object_live` for an
unmaterialized subject and ONE `verb_bytecode:<obj>:<name>` for an E_VERBNF. **No
cell's absence means "this object has other verbs."** So a turn that appends to,
or enumerates, an argument object's verb list sees an empty list and cannot tell
that apart from an object with no verbs. Miss-driven repair structurally cannot
close that gap.

**3. Authority.** Nothing validated the proposal. The committed cell took
whatever slot the planner computed.

`reindexVerbs` compounded 1 and 2: it renumbered every RESIDENT verb after each
write, so a write to any page re-derived that page's ordinal from the slice.

## The fix

**Slot becomes a durable ordinal.** Stored, never recomputed from position.
`importedVerbs` preserves it (a slotless legacy page still numbers by position,
so pre-slot worlds hydrate exactly as before). `orderVerbs` sorts by
`(slot, name)` without renumbering. `removeVerb` leaves the gap. An explicit
slot binds by VALUE. Numeric descriptors resolve by value too — with gaps that
is the only coherent reading, and it matches the `PRIMARY KEY (object_id, slot)`
the persistence schema always declared.

**Allocation is `max(slot) + 1`,** and `buildSeedSlice` now seeds the full cell
set of objects named in the call's ARGUMENTS — the same treatment `expandObjRefs`
already gives refs found inside cell values, bounded by (args × that object's own
cells). That makes the common path right in one round, and it is the only thing
that can fix a PURE READ (`verbs(id)`, a dry-run slot projection), which has no
write for an authority to refuse.

**The authority validates the proposal** (scope.ts, spec CO4.7). A sparse
planner can only propose — the same position the object-id allocator is in, and
resolved the same way. A write to an existing page must keep that page's slot; a
new page must take exactly the allocation floor; a rename may take an ordinal the
same transcript vacates. Refusals are retryable `read_version_mismatch` naming
the object's verb pages, so one repair round converges.

Rule 2 is also the **concurrency proof**: two turns planned against one
pre-state necessarily propose the same ordinal, so the second is refused and
replans one higher. Proved directly at the sequencer
(`tests/net/verb-slot-allocation.test.ts`).

### Residual, stated plainly

`verbs(obj)` is a COMPLETE-ENUMERATION read, and no cell miss can repair one. It
is now correct for an object the call names as an argument or reaches through an
object-valued property — which is how the programmer surface actually reaches
objects — but an object reached only by literal inside `eval` can still answer
short. Fixing that properly needs an owner-computed, version-attested projection
in the shape of `planningOrderedChildren` (a "verb roster" read the commit
validates). That is a larger change and was not made here. What matters for
correctness is that ALLOCATION no longer depends on the enumeration: it is
authority-checked. The limitation is now stated in
`spec/semantics/introspection.md` N3 rather than left implicit.

## Aged worlds

Deployed worlds contain objects whose pages share an ordinal — every verb
authored over Net, plus every verb whose metadata was edited over Net.

**The true insertion order is UNRECOVERABLE.** A verb page carries no timestamp
(the bridge zeroes `created`/`modified`; they would churn content addresses) and
`version` counts edits to one verb, not global writes. Nothing in the committed
state records which of two slot-1 verbs was authored first.

`repair:net-verb-slots` therefore does not guess it. It renumbers such an object
into the `(slot, name)` order every node ALREADY resolves in — the tie-break
`serializedFromCells`, `shadowVerbBytecodePages` and `world.orderVerbs` all
apply today — so it is behaviour-preserving by construction: no name resolves to
a different verb afterwards. For an object whose pages all collapsed onto slot 1
that order is alphabetical, which is NOT the authoring order; the tests say so
rather than implying otherwise.

An already-healthy object is declined, GAPS INCLUDED — distinct ascending
ordinals are correct even when not dense — which is also what makes replays
no-ops.

### A second invariant this makes load-bearing

`PRIMARY KEY (object_id, slot)` in the SQLite verb table has always declared
slot uniqueness; nothing enforced it above the storage layer, because
`cloneImportedVerb`'s renumbering guaranteed it by accident. It is now an
explicit invariant that `addVerb` maintains. Hydration deliberately does NOT
enforce it — the planning world hydrates a SLICE through the same
`importWorld` path, so renumbering there would rewrite ordinals the authority
then refuses (`verb_slot_moved`), and the turn would oscillate to
E_NONCONVERGENT_READ. An aged duplicate-slot image is therefore repaired by the
operator op, not silently by a loader, and `saveWorld`'s plain INSERT fails
loudly on the constraint if one is ever pointed at a SQLite host.

## Deploy-day checklist addition

After deploying this runtime, and before treating verb authoring on the deployed
world as sound:

```bash
# size it first
npm run repair:net-verb-slots -- https://woah1.generalbusiness.ai --all-seeded --dry-run
npm run repair:net-verb-slots -- https://woah1.generalbusiness.ai --all-seeded
# scopes created after install are not enumerable by the driver — name them
npm run repair:net-verb-slots -- https://woah1.generalbusiness.ai cluster:<actor> room:<space>
```

Needs the currently deployed `WOO_INTERNAL_SECRET`. Re-run any scope whose reply
reports a non-zero `remaining` (objects are capped per request). Until it runs,
MCP refuses ambiguous alias matches on affected objects
(`verb_order_unavailable`) and `list_verb` reports ordinals that address
nothing; both are safe, loud states, not data loss.

This joins the existing post-deploy operator runs:
`repair:net-definitions -- <worker> '$programmer:edit_verb'`,
`repair:net-seed-properties -- <worker>`, and `provision:net-wizard`.

## Sibling coordination

`tests/worker/net-mcp-legibility.test.ts` (branch
`worktree-mcp-gateway-legibility`, commit 999adc1f) asserted the duplicated
slots and the refusal for Net-authored verbs, deliberately so that fixing
authoring would fail loudly. It did. That case now asserts the FIXED behaviour —
distinct ordinals, and `x` resolving to `z_first` in both arrangements so no
alphabetical rule satisfies it.

The refusal was NOT weakened. It moved to a new case built on an AGED cell image
whose two pages really do share slot 1, which is what deployed worlds contain
until the repair runs. That case also carries the end-to-end deploy proof:
refusal → signed repair → the same call resolves.

That branch's commit 999adc1f was not yet in `worktree-integration-trial` when
this work started, so it was merged into this worktree first; the integration
merge will see one copy.
