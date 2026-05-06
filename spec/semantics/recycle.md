---
date: 2026-05-06
status: partial
---

# Recycle

> Part of the [woo specification](../../SPEC.md). Layer: **semantics**.

The normative semantics for destroying an object via the `recycle(obj)` builtin. LambdaMOO's `recycle()` had subtle load-bearing behavior — child tasks killed, parent bookkeeping cleared, ULID retired — that needs to be specified explicitly so implementations don't diverge.

**Heritage.** This spec follows LambdaMOO's `bf_recycle` (`objects.c`) closely:
the verb name (`:recycle`), the handler-then-walk order, the silent fall-through
on handler errors, the wizard-or-owner authority, the auto-graft of children,
and the contents-displacement pattern are all LambdaMOO precedent and match the
core catalog conventions in LambdaCore (`$root_object:recycle`,
`$room:recycle`, `$player:recycle`, all chaining with `pass(@args)`). Two
deliberate woo changes are flagged inline:

- **ULID tombstoning** (§RC1, RC3 step 9): LambdaMOO frees the OID slot and may
  reuse it via `renumber()`. Woo uses ULIDs in an open address space, so
  retaining a tombstone marker is free and removes a class of replay-determinism
  bugs.
- **`$nowhere` instead of `#-1`** (RC3 step 4): LambdaMOO has only `#-1` as the
  null location sentinel. Woo's universal seed `$nowhere` is a real object that
  can carry recycled-content semantics (see `bootstrap.md §B2.15`).

**Implementation status (2026-05-06).** The current runtime implements only the
parent/location bookkeeping (RC3 steps 5, 6) and storage row deletion (RC3 step
8), with a hard refusal of non-empty objects in the builder wrapper (§RC3a).
The `:recycle` dispatch (§RC4), parked-task kill (RC3 step 2), child grafting
(RC3 step 3), contents displacement (RC3 step 4), verb-cache invalidation
(RC3 step 7), ULID tombstoning (RC3 step 9), `$system.recycle_tick_budget`, and
`wiz:force_recycle` (§RC6.1) are not yet implemented. The current code also
gates `recycle()` on a non-LambdaMOO `obj.flags.recyclable` flag; this spec
removes that gate (§RC2), and the implementation pass will drop the flag.

---

## RC1. Contract

`recycle(obj)` is a builtin that destroys a persistent object. It is irreversible. After `recycle` returns successfully, `obj`:

- Has its ULID tombstoned in the owning host's `tombstone` table (per [persistence.md §14.2.1](../reference/persistence.md#1421-tombstones)). The ULID is not reused or reassigned. Calls and property reads on the ULID raise `E_OBJNF` (per [failures.md §F7](failures.md#f7-lifecycle-failures)); equality comparison still works (§RC5).
- Has its parent and location chains broken (cleared as described in §RC3).
- Has its host-local storage rows for the object deleted.
- Has its corename binding (if any) removed from the Directory, *eventually*: this is a post-commit best-effort cross-DO operation — see §RC3 step 10. Until that completes, `$foo` resolves to the tombstoned ULID, which surfaces as `E_OBJNF` on dereference.

The corename and ULID-tombstone changes are *two distinct state changes on different DOs*. A caller holding only a corename eventually sees `E_PROPNF` from `$system`; until reconciliation runs, they see the tombstoned ULID and `E_OBJNF` on dereference. A caller holding the ULID directly always sees `E_OBJNF`.

`recycle` runs as part of a sequenced call. The host-side destruction is one atomic transaction on `obj`'s host (§RC3.1); the Directory corename removal is a fire-after-commit cross-DO operation (§RC3 step 10).

---

## RC2. Permissions

`recycle(obj)` succeeds iff the calling `progr` is a wizard or the owner of
`obj`. Otherwise raises `E_PERM`. This is LambdaMOO's `controls(progr, oid)`
gate verbatim.

`:recycle` (§RC4) is a notification, not a veto: a handler raise or return
value cannot abort the destruction. Authors who want a specific object
protected against accidental destruction by their own code should either
transfer ownership to `$wiz` or wrap `recycle()` in a verb that performs the
extra check.

The reserved-object list in §RC6 is the engine's only opt-out mechanism beyond
authority. There is no per-object recyclability flag.

---

## RC3. Bookkeeping

`recycle(obj)` runs in two phases. **Pre-flight** validates without mutating;
if it fails, no handler runs and no state changes. **Apply** runs the handler
and the structural steps within `obj`'s anchor cluster transaction (see §RC3.1
for the rollback scope).

### Pre-flight (before handler)

A1. **Authority.** Caller is wizard or `obj.owner`; otherwise `E_PERM`.
A2. **Reserved.** `obj` is not in §RC6's forbidden list; otherwise `E_INVARG` (or `E_PERM` for live actors).
A3. **No anchored descendants.** No object has `obj` as its (transitive) `anchor`; otherwise `E_NACC` (per [failures.md §F7](failures.md#f7-lifecycle-failures); the wizard recycles bottom-up). The check is bounded to `obj`'s own host. Two interlocking placement invariants make the local query sufficient:

- Anchor relationships place objects co-resident on the anchor root's host ([objects.md §4.1](objects.md#41-anchor-and-atomicity-scope)).
- Self-hosted instances reject non-null `anchor` at create time ([objects.md §4.1](objects.md#41-anchor-and-atomicity-scope), enforced by `create()`), so the routing-precedence rule that puts self-hosted ahead of anchored ([objects.md §4.2](objects.md#42-host-placement)) cannot produce an off-host descendant.

Together these guarantee that every object transitively anchored on `obj` lives on `obj`'s host. The implementation is a local recursive query over the host's `objects.anchor` rows; no global registry walk is needed (consistent with [objects.md §5.6](objects.md#56-the-directory)). Hosts may maintain a reverse-anchor index for O(1) lookup; that is an implementation detail.
A4. **Cluster collocation.** `obj.parent`, `obj.location`, and every object in `obj.children` and `obj.contents` either share `obj`'s anchor cluster or are the well-known sink `$nowhere`. Otherwise `E_CROSS_HOST_WRITE` (cross-host recycle is §RC10, deferred).

If any pre-flight check fails, `recycle` raises and `obj` is unchanged.

### Apply (one transaction)

1. **Fire `:recycle`** on `obj` (see §RC4). Failures are caught and surfaced as a `$recycle_handler_error` observation; they do not abort the recycle. (Catalogs that need cascade work — clear `owner.owned_objects`, remove features, spill room contents to enclosing space, drain cross-cluster contents/children — define `:recycle` and chain with `pass(@args)`, matching LambdaCore's `$root_object`/`$player`/`$room` convention.)
1a. **Re-verify A4 (post-handler cluster collocation).** A handler may have moved an object into `obj.contents`, reparented a child, or otherwise altered the graph since pre-flight. Re-check that `obj.parent`, `obj.location`, and every member of `obj.children` and `obj.contents` is still in `obj`'s anchor cluster (or is `$nowhere`). If the re-check fails, abort: roll back the handler's intra-cluster mutations and raise `E_CROSS_HOST_WRITE`. The handler's cross-cluster effects are *not* in the rollback scope and may have leaked (§RC3.1); this is a documented risk of writing handlers that touch other clusters.
2. **Kill parked tasks anchored to `obj`.** Any task in the `task` table with `target == obj`, `parked_on == obj`, or where the suspended frame's `this_ == obj` is removed and abandoned. The task is marked `state: 'killed'` if any consumer is watching for completion. Per [failures.md §F7](failures.md#f7-lifecycle-failures), `E_INTRPT` is delivered to handlers awaiting these tasks.
3. **Walk `children`.** For each child `c` whose `parent == obj`, set `c.parent = obj.parent` (graft up). All children are collocated with `obj` (or `$nowhere`) by A4. `obj.parent` is always non-null because `$system` is forbidden by §RC6.
4. **Walk `contents`.** For each contained `c` whose `location == obj`, set `c.location = $nowhere`. All contents are collocated with `obj` (or `$nowhere`) by A4. The `:recycle` handler usually drains contents to a more polite destination first, so this catches only objects the handler did not relocate. (`$nowhere` is the universal default-home location — see [bootstrap.md §B2.15](bootstrap.md#b215-nowhere). It is the documented exception to bidirectional containment ([objects.md §4.3](objects.md#43-containment-and-cross-host-invariants)): `$nowhere.contents` is **not maintained**, so this step writes only `c.location` and never RPCs the `$nowhere` host. `$nowhere` is itself unrecyclable per §RC6.)
5. **Walk parent-side bookkeeping.** Remove `obj` from `obj.parent.children`.
6. **Walk container-side bookkeeping.** Remove `obj` from `obj.location.contents` if applicable.
7. **Invalidate verb-lookup caches.** The recycle transaction does *not* fan out a synchronous purge to remote hosts. Cache invalidation is lazy at dispatch time on each host: when a host attempts to dispatch through a cached `(class, verb_name) → (definer, slot, version)` entry whose `definer` ULID is now tombstoned, the host purges the entry and re-resolves verb lookup from the class chain. The re-lookup either finds an inherited verb (one level up) or raises `E_VERBNF`. There is no "stale cache returns wrong answer" window: dispatching to a tombstoned definer fails with `E_OBJNF` at frame setup before any user code runs, which the host treats as the same purge-and-retry signal. ([persistence.md §15](../reference/persistence.md#15-caching-and-invalidation) covers the cache mechanics; this step adds the tombstone-driven purge.)
8. **Delete storage.** All object-owned rows for `obj` are deleted: the `objects` row and the per-object tables keyed by `object_id == obj` (`property_def`, `property_value`, `verb`, `child`, `content`, `event_schema`, `ancestor_chain`) per [persistence.md §14.1](../reference/persistence.md#141-per-mooobject-schema). Per-host coordination tables (sessions, sockets) are *not* in this set — they are not scoped to a hosted object — and live-actor session teardown happens at the wrapper layer (§RC6.1).
9. **Tombstone the ULID** (host-local). A row is inserted into the owning host's `tombstone` table (per [persistence.md §14.2.1](../reference/persistence.md#1421-tombstones)) within the same SQLite transaction as steps 5–8. ULID lookups on that host thereafter return "tombstoned," and dereference (call, property read) raises `E_OBJNF`. The Directory's `id_route` row is **not** touched (preserves `is_recycled()` distinguishability — see RC3.1). The ULID is never reused.

If any apply step (other than the handler) fails, the host transaction rolls back and `obj` is not recycled; `recycle` raises the underlying error. The handler's intra-cluster mutations *are* inside the rollback scope; handler errors are *not* a rollback trigger.

### Apply (post-commit, best-effort)

After the host transaction commits, the runtime issues one cross-DO operation:

10. **Remove the corename binding** (Directory). The Directory's `corename` row (if any, per [persistence.md §14.2](../reference/persistence.md#142-singleton-dos-and-directory-schema)) is removed: `$foo` no longer resolves to this ULID. This is fired *after* the host commit and is **not** in the host transaction's atomicity scope — Directory is a separate singleton DO ([cloudflare.md §R1.1](../reference/cloudflare.md#r11-routing)) so v1 cannot make this one SQLite transaction.

The cross-DO operation is **best-effort and idempotent**:

- The host commit is the success point. `recycle()` returns success once step 9 commits, even if step 10 has not yet been acknowledged.
- If step 10 fails or the runtime crashes between steps 9 and 10, the world remains semantically consistent: a stale `corename` row resolves `$foo` to the tombstoned ULID, dereference of which raises `E_OBJNF` per step 9. The corename is effectively unbound from the user's point of view; only the Directory row is dangling.
- A janitor verb (run on Directory boot and periodically) reconciles: for each `corename` row, it asks the target ULID's host whether the ULID is tombstoned; if so, the row is removed. This is `O(corenames)` and runs off the hot path.
- The operation is idempotent: replaying step 10 on an already-removed corename is a no-op.

The reverse failure mode — corename removed before tombstone insert — is impossible by construction: step 10 runs only after step 9 has committed.

### RC3.1 Atomicity scope

The atomic core of `recycle` is the host-side transaction (steps 1–9), which
runs within `obj`'s anchor cluster (per
[objects.md §4.1](objects.md#41-anchor-and-atomicity-scope)). Pre-flight check
A4 ensures these steps do not need cross-cluster writes. The `$nowhere`
displacement in step 4 writes only the local `c.location` field — it does not
update `$nowhere.contents`, which is not maintained
([bootstrap.md §B2.15](bootstrap.md#b215-nowhere)) — so it stays inside the
local transaction.

Step 10 (corename removal in Directory) is **outside** the host transaction:
the Directory is a separate singleton DO and v1 has no cross-DO transaction
primitive. Step 10 is fired after the host commit, is idempotent, and has a
janitor for stale rows (see §RC3 step 10 for the full failure-mode analysis).
This is the only cross-DO mutation in the recycle pipeline.

What is and isn't in the rollback scope:

- **In scope:** all property and structural mutations on objects in `obj`'s
  anchor cluster, observations emitted on spaces in that cluster, and the
  storage-row deletions in step 8.
- **Out of scope:** any mutations the handler performs in another anchor
  cluster (the handler should not do this — see §RC4), and any
  externally-visible side effects (network sends to non-host services). If the
  handler emits an observation on a remote space and the apply phase later
  fails, that observation will not be retracted.

Cross-host recycle (lifting the A4 restriction) is deferred to a later spec
revision; see §RC10.

### RC3a Builder-surface safety wrapper

The `@recycle` command on `$builder` (catalog `prog`) is a thin wrapper around
`recycle()`. It adds three things on top of the builtin:

- **Empty-children safety check.** If `obj` has children or contents, the
  wrapper refuses with `E_RECMOVE` unless the caller passes `{force: true}`.
  The underlying builtin always grafts; the check exists only at the authoring
  surface where casually destroying a populated class or container is almost
  always a mistake.
- **Self-recycle refusal.** Builders cannot recycle their own actor object
  through `@recycle`. (LambdaCore's `@recycle` does the same check; LambdaMOO's
  builtin does not, so the engine layer leaves it to the wrapper.)
- **Pool-vs-destroy choice.** Catalogs may treat `@recycle` as a request to
  *park* the object (reparent into an internal pool) rather than truly destroy
  it, à la LambdaCore's `$recycler` reparenting under `$garbage`. The engine
  builtin is unaware of pooling; pooling is a wrapper-level policy.

Catalogs may layer their own wrappers with the same conventions.

---

## RC4. The `:recycle` handler

`:recycle()` is the LambdaMOO-precedent handler verb. It resolves through
ordinary inherited verb-lookup ([objects.md §9.1](objects.md#91-lookup)), so a
handler defined on a superclass fires for descendants. The catalog convention,
matching LambdaCore, is for each level to do its own work and then call
`pass(@args)` so the chain composes (`$thing` → `$container` → `$room`,
`$thing` → `$player`, etc.). If lookup yields no verb, step 1 of §RC3 is a
no-op.

When the handler is found, it is called with no arguments. The frame is set up
just like any other dispatched call, by the standard programmer-discipline:

- `this = obj`
- `caller = obj`
- `progr = ` the resolved `:recycle` verb's *owner* (per [permissions.md §11.4](permissions.md#114-effective-permission)). For an inherited handler defined on `$root_object` and owned by `$wiz`, the handler runs as wizard regardless of `obj.owner`. This matches LambdaMOO's `call_verb` behavior in `bf_recycle`.
- Tick budget from `$system.recycle_tick_budget` (default `1000`). If the property is missing or non-integer, the runtime uses `1000` and logs a configuration warning.

The handler may:

- Emit observations (e.g., `{type: "recycled", source: this}` so subscribers can clear dangling refs — see §RC5).
- Clean up its own state and cascade to objects it can reach (drain contents to a sensible destination, clear `owner.owned_objects`, remove features, etc.).
- Call `recycle()` on other objects, subject to the same authority rules. Recursion is bounded only by the ordinary task tick/recursion budget; there is no special "nested recycle" error code. (LambdaMOO's `bf_recycle` lets `E_MAXREC` from the handler call fall through and proceeds with destruction; woo follows that.)

The handler may **not**:

- Veto the recycle. Any return value is discarded; any raise is caught.
- Mutate state in objects outside its anchor cluster. Cross-cluster mutations are not in the rollback scope and may leak if recycle later fails. The runtime does not enforce this — authors are responsible for keeping handler effects local.

If `:recycle` raises, the error is caught. Two things happen, in order:

1. The runtime emits a `$recycle_handler_error` observation on `obj`'s space
   (or, for a direct call, on the calling actor's session):

   ```
   {type: "$recycle_handler_error", obj, code, message}
   ```

   The schema is declared on `$root` so it is reachable from every anchor
   cluster. (LambdaMOO swallows this error silently; surfacing it as an
   observation is a deliberate woo improvement — silent destruction errors are
   one of the harder LambdaCore bugs to debug.)

2. Recycle continues with step 2.

---

## RC5. Dangling references

After `recycle(obj)`:

- Other objects holding `obj` as a property value retain the ULID. The objref is now a *dangling reference*: it points to a tombstoned ULID.
- Verb calls on a dangling reference raise `E_OBJNF` (per [failures.md §F7](failures.md#f7-lifecycle-failures)).
- Property reads on a dangling reference raise `E_OBJNF`.
- Equality comparison still works: two dangling refs to the same ULID are still equal per [values.md §V3](values.md#v3-equality). This is required for replay determinism.
- Storing a dangling ref in a property is allowed; staleness is observable only at use. Best practice: callers that hold long-lived refs check `is_recycled(obj)` before use.

Cleanup of dangling references is **not** automatic, and `:recycle` fires on
the *recycled* object, not on objects that reference it. Catalogs that care use
one of:

- Subscribe to the `recycled` observation that the recycled object's
  `:recycle` handler emits (§RC4), and clear the field in the subscriber.
- Sweep periodically with a wizard verb that probes refs and discards dangling
  ones.
- Defer the check: tolerate `E_OBJNF` on first use of the field and clear it
  there.

The runtime does not GC for you.

---

## RC6. Forbidden recycles

The following objects must not be recycled:

- `$system` (`#0`).
- `$nowhere` (the default-home location used by RC3 step 4).
- The universal classes `$root`, `$actor`, `$player`, `$wiz`, `$sequenced_log`, `$space`, `$thing`.
- A universal class that has a non-empty descendant chain. (Non-universal classes graft their children up per RC3.3.)
- Any actor (descendant of `$actor`) that has at least one live session. The session-binding layer enforces this.

Attempts raise `E_INVARG` ("cannot recycle reserved object") for the
universal-class and seed cases, or `E_PERM` for the live-actor case.

### RC6.1 `wiz:force_recycle`

`wiz:force_recycle(obj)` is a wizard-only verb shipped with the `prog`
catalog. It bypasses **most** of §RC6's reserved-object list, with a small
hard floor and explicit teardown semantics for the cases it does relax:

- Caller must be a wizard (the §RC2 authority check still applies; ownership
  is not enough).
- **Hard floor:** `$system`, `$root`, and `$nowhere`. Even `force_recycle`
  refuses these with `E_INVARG`. `$system` and `$root` are removed only by an
  offline tool because the running world cannot recover from their absence.
  `$nowhere` is on the floor because RC3 step 4 displaces contents into it;
  recycling `$nowhere` from inside the running world would orphan that step
  and any concurrent recycle on another cluster.
- **Other universal classes** (`$actor`, `$player`, `$wiz`,
  `$sequenced_log`, `$space`, `$thing`) are bypassed. `force_recycle` proceeds
  through normal §RC3 apply.
- **Live actors** are bypassed, but force_recycle terminates the actor's live
  sessions before invoking the apply phase: each session is closed with a
  `session_terminated` reason, the connection registry is updated, and any
  in-flight `host_call`s on the session return `E_GONE` per
  [failures.md §F7](failures.md#f7-lifecycle-failures). After session
  teardown, recycle proceeds.
- **Pre-flight A4 (cluster collocation) still applies** — even a wizard
  cannot atomically recycle across clusters in v1.

It records a `{type: "wiz_force_recycle", actor, obj, reason, sessions_killed, ts}`
audit observation to the wizard log space (`sessions_killed` is the count of
live sessions terminated, zero for non-actor objects).

`wiz:force_recycle` is for irreversible world-teardown and migration; it must
not appear in normal authoring flows.

---

## RC7. Recycle vs. unanchor

Recycle destroys the object. **Unanchoring** (changing an object's anchor cluster) is a separate operation and is not in v1 — anchors are immutable per [objects.md §4.1](objects.md#41-anchor-and-atomicity-scope). To "move" an object, recycle and recreate it under the new anchor, which is a deliberate operation an author chooses, not an implicit migration.

---

## RC8. Errors

| Code | Meaning |
|---|---|
| `E_PERM` | Caller lacks wizard authority and is not the owner, or the target is a live actor (§RC6, pre-flight A1). |
| `E_INVARG` | Object is reserved (§RC6, pre-flight A2). |
| `E_OBJNF` | Object already recycled or never existed; or post-recycle dereference of a dangling ref (§RC5). Aligned with [failures.md §F7](failures.md#f7-lifecycle-failures). |
| `E_NACC` | Some object's `anchor` is `obj` (transitively): recycle bottom-up first (§RC6, pre-flight A3, [failures.md §F7](failures.md#f7-lifecycle-failures)). |
| `E_RECMOVE` | Builder-surface refusal: target has children or contents and `force: true` was not supplied (§RC3a). |
| `E_CROSS_HOST_WRITE` | `obj.parent`, `obj.location`, or any child/content lives in a different anchor cluster (pre-flight A4, §RC10). |
| `E_STORAGE` | Storage layer failed during the apply phase. The object is not recycled. |

---

## RC9. Conformance

The conformance suite ([conformance.md §CF3](../tooling/conformance.md#cf3-required-categories)) will cover:

- Recycle of a leaf object (no children, no contents, no parked tasks).
- Recycle that triggers same-cluster child reparenting (graft up).
- Recycle that displaces same-cluster contents to `$nowhere`.
- Recycle that kills parked tasks (`E_INTRPT` delivered to handlers).
- Recycle of a forbidden object (must raise `E_INVARG`).
- Recycle of a live actor (must raise `E_PERM`).
- Recycle blocked by an anchored descendant (must raise `E_NACC`).
- Recycle blocked by a cross-cluster child/content/parent/location at pre-flight A4 (must raise `E_CROSS_HOST_WRITE`, no handler invocation).
- Recycle blocked by a handler-introduced cross-cluster reference at the post-handler A4 re-check (must raise `E_CROSS_HOST_WRITE`, intra-cluster handler mutations rolled back).
- Stale-ref dereference after recycle: route survives, host reports `E_OBJNF`, and `is_recycled()` distinguishes recycled from never-existed.
- `:recycle` handler dispatch, including inherited `pass(@args)` chaining and verb-owner-as-`progr` semantics.
- `:recycle` raising — recycle proceeds, `$recycle_handler_error` observed; intra-cluster handler mutations roll back if a later apply step fails.
- `:recycle` recursing into another `recycle()`, and the case where the inner call exhausts the task tick budget (handler error caught, outer recycle proceeds).
- Builder-surface refusal of non-empty objects without `force: true` (§RC3a).
- Corename removal: after `recycle()` returns and the post-commit step 10 runs, `$foo` no longer resolves; `is_recycled(obj)` returns true.
- Crash between step 9 and step 10: replay/recovery shows `$foo` resolving to the tombstoned ULID; dereference raises `E_OBJNF`. The Directory janitor on next boot removes the stale corename row.
- Dangling reference behavior (`E_OBJNF` on call/read; equality preserved).
- ULID tombstoning: a recycled ULID never resolves and is never reused (per [persistence.md §14.2.1](../reference/persistence.md#1421-tombstones)).
- Lazy cache invalidation: a host with a cached lookup entry whose definer was tombstoned by a recycle on another host purges and re-resolves on next dispatch; no stale dispatch is observable.
- `$nowhere` sink: `obj.location = $nowhere` writes only the local field; reads of `$nowhere.contents` return `[]`.

Of these, only the leaf-object case currently has automated coverage.
The remaining cases are deferred until the corresponding implementation lands.

---

## RC10. Cross-host recycle (deferred)

A v2 spec revision will define cross-host recycle. The protocol must address:

- Two-phase prepare/commit across the anchor clusters touched by `obj.parent`,
  `obj.location`, and grafted children/contents.
- Cache invalidation fan-out and acknowledgement (§RC3.7).
- Tombstone visibility: until all participating hosts have committed, the
  Directory must not advertise the ULID as either live or tombstoned.
- Failure recovery if a participating host is unreachable mid-commit.

Until then, `recycle()` rejects cross-anchor cases with `E_CROSS_HOST_WRITE`
(§RC3.1).
