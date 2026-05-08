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

**Implementation status (2026-05-07).** The host-local path is implemented
as a single `recycle(obj, opts?)` builtin (replacing the earlier
`builder_recycle` / `wiz_force_recycle` pair). The builtin does pre-flight
A1–A4 checks, `:recycle` dispatch (§RC4), parked-task kill (RC3 step 2),
child grafting (RC3 step 3), contents displacement to `$nowhere`
(RC3 step 4), parent/location chain bookkeeping (steps 5, 6), lazy
verb/ancestor cache invalidation on dispatch-time tombstone hits (step 7),
storage-row deletion (step 8), and ULID tombstoning persisted across hosts
(step 9). The §RC3a empty-children safety check rides on the builtin as
the `force` opt; §RC6.1 wizard-only behavior rides as the `force_reserved`
opt. The non-LambdaMOO `obj.flags.recyclable` gate has been removed.
Status remains `partial` because `$system.recycle_tick_budget` and the
cross-host steps in §RC3.1 / §RC10 (cluster co-location enforcement when
the cluster spans hosts, fire-after-commit Directory reconciliation, and
remote tombstone gossip) are deferred to the post-v1 multi-host pass. The
in-host bridge wired in v1 returns `false` for unreachable peers, so a
stale ref to an object on an offline host currently dereferences as live
until that host is reachable again.

---

## RC1. Contract

`recycle(obj)` is a builtin that destroys a persistent object. It is irreversible. After `recycle` returns successfully, `obj`:

- Has its ULID tombstoned in the owning host's `tombstone` table (per [persistence.md §14.2.1](../reference/persistence.md#1421-tombstones)). The ULID is not reused or reassigned. Calls and property reads on the ULID raise `E_OBJNF` (per [failures.md §F7](failures.md#f7-lifecycle-failures)); equality comparison still works (§RC5).
- Has its parent and location chains broken (cleared as described in §RC3).
- Has its host-local storage rows for the object deleted.
- Has its corename binding (if any) removed from the Directory, *eventually*: this is a post-commit best-effort cross-DO operation — see §RC3 step 10. Until that completes, `$foo` resolves to the tombstoned ULID, which surfaces as `E_OBJNF` on dereference.

The corename and ULID-tombstone changes are *two distinct state changes on different DOs*. A caller holding only a corename eventually sees `E_PROPNF` from `$system`; until reconciliation runs, they see the tombstoned ULID and `E_OBJNF` on dereference. A caller holding the ULID directly always sees `E_OBJNF`.

`recycle` runs as part of a sequenced call. The host-side destruction is one atomic transaction on `obj`'s host (§RC3.1); the Directory corename removal is a fire-after-commit cross-DO operation (§RC3 step 10).

If the recycle leaves the host with zero live (non-tombstoned) payload objects, the host enters teardown — it migrates its tombstone roster to the Directory and calls `state.storage.deleteAll()`, deallocating its storage. The DO id remains reachable; any reactivation hits the cold-load guard. See §RC11.

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

### RC3a Empty-children safety: the `force` opt

`recycle(obj, {force: true})` bypasses the empty-children safety check and
permits recycling a non-empty class or container. Without `force`, the
builtin refuses with `E_RECMOVE` if `obj` has children or contents. The
substrate always grafts/displaces; the check exists as a guard against
fat-finger destruction of populated classes or containers, available to
any caller with §RC2 authority.

The `@recycle` command on `$builder` (catalog `prog`) is a thin wrapper
around the builtin that may also add:

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

### RC6.1 Wizard reserved-list bypass: the `force_reserved` opt

`recycle(obj, {force_reserved: true})` is a wizard-only opt that bypasses
**most** of §RC6's reserved-object list, with a small hard floor and explicit
teardown semantics for the cases it does relax:

- Caller must be a wizard (the substrate raises `E_PERM` otherwise).
  The §RC2 authority check (wizard or owner) still applies as well.
- **Hard floor:** `$system`, `$root`, and `$nowhere`. Even with
  `force_reserved`, the substrate refuses these with `E_INVARG`. `$system`
  and `$root` are removed only by an offline tool because the running world
  cannot recover from their absence. `$nowhere` is on the floor because
  RC3 step 4 displaces contents into it; recycling `$nowhere` from inside
  the running world would orphan that step and any concurrent recycle on
  another cluster.
- **Other universal classes** (`$actor`, `$player`, `$wiz`,
  `$sequenced_log`, `$space`, `$thing`) are bypassed. The recycle proceeds
  through normal §RC3 apply.
- **Live actors** are bypassed, but `force_reserved` terminates the actor's
  live sessions before invoking the apply phase: each session is closed with
  a `session_terminated` reason, the connection registry is updated, and any
  in-flight `host_call`s on the session return `E_GONE` per
  [failures.md §F7](failures.md#f7-lifecycle-failures). After session
  teardown, recycle proceeds.
- **Pre-flight A4 (cluster collocation) still applies** — even a wizard
  cannot atomically recycle across clusters in v1.

The substrate records a `{type: "wiz_force_recycle", actor, obj, reason,
sessions_killed, ts}` audit observation to the wizard log space
(`sessions_killed` is the count of live sessions terminated, zero for
non-actor objects). The accompanying `recordWizardAction` entry is keyed
`force_recycle`.

The `prog` catalog ships a wizard-only `:force_recycle(id, opts)` verb on
`$wiz` that thinly wraps the builtin with `force_reserved: true` and
`force: true` for convenience. It is for irreversible world-teardown and
migration; it must not appear in normal authoring flows.

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
| `E_HOST_RECYCLED` | Request reached a DO whose `host_state == tearing_down`, or a cold-loaded DO whose id is recorded in Directory's `inherited_tombstone` table. Treat as "object gone"; equivalent to `E_OBJNF` for callers that don't distinguish (§RC11). |

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
- Host teardown trigger: a recycle that drops the host's live-payload count to zero (host-scoped support copies excluded — §RC11.1) starts the §RC11 teardown.
- Host teardown idempotency: a crash between any two §RC11 steps recovers to the same outcome on next wake.
- Concurrent dispatch during `tearing_down` raises `E_HOST_RECYCLED`.
- Cold-load guard: a fresh DO instantiated against a torn-down host id observes its id in Directory's `inherited_tombstone`, refuses inbound requests, and writes nothing.
- After teardown: dispatching to any tombstoned ULID raises `E_OBJNF` via the Directory's inherited-tombstone authority without waking a productive DO; `is_recycled()` returns true.
- `DEFAULT_OBJECT_HOST` never tears down even when its hosted payload transiently contains only the bootstrap floor.

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

---

## RC11. Host teardown after recycle

When a recycle leaves a DO with no live (non-tombstoned) hosted payload
objects, the DO migrates its tombstone roster to the Directory and tears
itself down. This is the only mechanism by which a DO's storage is fully
deallocated. Without it, every recycled self-hosted root leaves behind a
DO whose storage holds only tombstones and meta rows — non-empty, billed
indefinitely.

After teardown, `state.storage.deleteAll()` deallocates the DO's stored
data (atomically, per Cloudflare SQLite-DO semantics) and the in-memory
instance is evicted on the next idle. The **id is not unreachable**: a
caller holding a stale stub from `idFromName(host)` can still activate a
fresh empty instance under the same id. Such activations are caught by
the cold-load guard (§RC11.6), so observable behavior is correct, but the
spec deliberately does not claim "the DO ceases to exist" — only that its
storage is gone and any reactivation answers `E_HOST_RECYCLED`.

**Status: deferred.** Specified here to constrain the destruction story for
self-hosted spaces (catalog removal, owner-initiated room destruction,
factory cleanup of decommissioned instances). Until this lands, deleting a
self-hosted root leaves a present-but-empty DO.

### RC11.1 Trigger

After every successful recycle commit on a host (§RC3 step 9), the host
evaluates its hosted-payload count:

```
livePayloadCount := count of non-tombstoned hosted payload objects
```

A **hosted payload object** is one whose canonical Directory `id_route`
points to this host: the self-hosted root and its anchored co-resident
descendants (per [objects.md §4.1](objects.md#41-anchor-and-atomicity-scope)).

**Host-scoped support copies are excluded.** Each object-owning DO carries
copies of class, verb, and property-def rows merged in by
`mergeHostScopedSeed` ([cloudflare.md §R9.1](../reference/cloudflare.md#r91-first-request-path))
so that local dispatch can resolve through the inheritance chain without
cross-host RPCs. These rows live in the same SQLite tables as payload, but
their canonical id resolves to a different host (the gateway or another
self-hosted root). They are caches, not hosted live objects, and do not
count toward `livePayloadCount`. `state.storage.deleteAll()` (§RC11.3 step 4)
discards them along with everything else.

If `livePayloadCount == 0`, the host enters teardown. The trigger is
defined on the count, not on "is the recycled object the self-hosted
root?" — so the contract remains correct under future placement rules
where a non-root could plausibly be the last live payload row.

Anchor pinning (pre-flight A3, §RC3) ensures co-resident anchored
descendants are recycled before their self-hosted root, so in practice
the trigger fires on the recycle that destroys the root.

`DEFAULT_OBJECT_HOST` (the world DO that holds `$wiz`, `$system`,
`$catalog_registry`, …) is exempt: its hosted payload set always contains
the bootstrap floor and the trigger never fires. The Directory DO is also
exempt — it never tears itself down.

### RC11.2 Host state

The DO persists a `host_state` value in its `meta` table:

| Value | Meaning |
|---|---|
| `live` | Default. Writes proceed normally. |
| `tearing_down` | Teardown in progress. New writes raise `E_HOST_RECYCLED`. Reads on tombstoned ULIDs continue to answer "recycled" until §RC11.3 step 4. |

The flag is set in the same SQLite transaction as the final recycle's
tombstone insert (§RC3 step 9). A crash with `host_state = tearing_down`
persisted is recoverable: on next wake the DO repeats §RC11.3 from step 2.
Steps 2 and 4 are idempotent; step 3 is best-effort.

### RC11.3 Teardown sequence

1. **Mark.** `host_state = tearing_down`. Persisted within the recycle
   transaction that drained `livePayloadCount` to zero.
2. **Hand tombstones to the Directory.** The host POSTs *one or more*
   inherit-tombstones requests covering its full tombstone roster. A
   long-lived host can accumulate more tombstones than fit in a single
   request, so the protocol is batched.

   ```
   POST /__internal/inherit-tombstones
   Headers: signed via internal-auth (x-woo-host-key, x-woo-internal-ts, x-woo-internal-body-sha256, x-woo-internal-signature)
   Body: {
     host: <self-hosted-root-ULID>,
     batch_seq: <0-based monotonic int>,
     final: <bool>,                                  // true on the last batch
     tombstones: [{id, recycled_at, reason}, …]      // chunked subset of the host's roster
   }
   ```

   The host chunks its roster so each request body stays well under the
   Directory's body cap (Directory enforces ≤512 KiB JSON per request to
   leave headroom under the 1 MiB Worker limit). `batch_seq` starts at 0
   and increments per request; `final: true` marks the last batch. Batches
   may be retried on transport failure with the same `(host, batch_seq)`
   pair; the Directory is idempotent on `id`.

   The Directory enforces three authorization invariants before any write:

   - **Signature.** The request passes `verifyInternalRequest` against
     `WOO_INTERNAL_SECRET` (per existing internal-auth canonical, see
     [`src/worker/internal-auth.ts`](../../src/worker/internal-auth.ts)).
     Otherwise `E_PERM`.
   - **Host self-consistency.** The body's `host` field equals the
     authenticated `x-woo-host-key` header. Otherwise `E_PERM`. A host can
     only declare its own teardown.
   - **Roster ownership.** For each tombstone `id` in the body, the
     Directory verifies `id_route(id).host == host` (or that an
     inherited-tombstone row for `id` already exists with
     `former_host == host`, to keep retried batches idempotent). Any id
     whose current route points at a different host is rejected; the
     entire batch is refused with `E_PERM` and no rows are written.

   These invariants protect against public clients and buggy honest
   callers. They do *not* defend against a compromised worker that holds
   `WOO_INTERNAL_SECRET`, because the v1 internal-auth model uses a single
   shared secret and the `x-woo-host-key` header is asserted by the
   caller. Per-host signing keys are out of scope for v1; see §RC11.7.

   On a clean batch, the Directory:

   - Inserts each row into its `inherited_tombstone` table (idempotent on
     `id`); see [persistence.md §14.2.2](../reference/persistence.md#1422-inherited-tombstones-after-host-teardown).
   - Removes the `id_route` row for each tombstone *accepted in this
     batch*. This is the one documented exception to the §14.2.1
     route-immutability invariant: it applies *only* to ULIDs that are
     already tombstoned **and** routed to the authenticated caller, so the
     observable behavior for callers does not change (`E_OBJNF` was raised
     by the host before; it is now raised by the Directory).
   - Returns 200 only after both writes commit.

   **Teardown advances only when all batches are accepted.** The host
   tracks ack of each `batch_seq` and proceeds to step 3 only after the
   `final: true` batch has been acknowledged. A crash mid-handoff is
   recoverable: on next wake, the DO observes `host_state == tearing_down`
   and replays unacknowledged batches. The Directory's batch idempotency
   means re-sending an already-applied batch is a no-op and re-sending
   with a fresh body sha (e.g. after a chunking-policy change) is still
   safe because the per-`id` insert is idempotent.

3. **Drop alarms and outbox** (best-effort). Cancel any
   `state.storage.setAlarm()`. Drain or abandon outbox entries — their
   receivers will see this host as gone after step 4 anyway. This step is
   belt-and-suspenders: at the runtime's current `compatibility_date`,
   `state.storage.deleteAll()` (step 4) also clears alarms, so the explicit
   cancel here only narrows the window of partial alarm fires during the
   teardown gap. If the compatibility date later changes such that
   `deleteAll` no longer clears alarms, this step becomes load-bearing.

4. **`state.storage.deleteAll()`.** Atomically deallocates the DO's
   stored data, including `meta` (so `host_state` is gone), `tombstone`,
   and per-object tables. The in-memory instance is evicted on the next
   idle. The DO id remains reachable: a stale stub can re-activate an
   empty instance under the same id; that path is governed by the
   §RC11.6 cold-load guard. This call is the only place in woo's
   substrate that uses `deleteAll`.

5. **Return.** No further messages on this DO.

### RC11.4 Tombstone authority handoff

After §RC11.3 step 2 commits, the Directory is the authority on liveness
for the tombstoned ULIDs that lived on the torn-down host. The lookup
contract from [persistence.md §14.2.1](../reference/persistence.md#1421-tombstones)
gains a new branch — see [§14.2.2](../reference/persistence.md#1422-inherited-tombstones-after-host-teardown):

1. Caller resolves the ULID via Directory `id_route`.
2. **(new)** If `id_route` has no row, the Directory checks
   `inherited_tombstone`. A hit returns "recycled" → `E_OBJNF`. A miss
   returns "never existed" (`is_recycled()` distinguishes the two).
3. Otherwise dispatch to the host as before.

The Directory's authority is bounded: it answers for ULIDs whose host has
been torn down. Live hosts retain authority over their own tombstones
(§14.2.1), and the Directory does not mirror those.

### RC11.5 Concurrent operations during teardown (pre-deleteAll)

While `host_state == tearing_down` is persisted (between §RC11.3 step 1 and
step 4), a request arriving at the DO is rejected with `E_HOST_RECYCLED`.
This window covers three paths:

- A direct dispatch that races with teardown (rare: pre-flight A3 prevents
  the obvious case).
- A cross-DO RPC that targets a now-empty cluster (e.g. an outbox flush from
  another host). Caller treats `E_HOST_RECYCLED` as "tombstoned" and stops
  retrying.
- A reawaken caused by a stale alarm. The DO sees `tearing_down`, resumes
  the §RC11.3 sequence, and exits without doing user-visible work.

`E_HOST_RECYCLED` is normative — see [failures.md §F7](failures.md#f7-lifecycle-failures)
and §RC8. Code that already handles `E_OBJNF` for tombstoned dispatches
needs no change; code that wants to distinguish "racing teardown" from
"long-since recycled" checks the code.

### RC11.6 Post-deleteAll behavior (cold-load guard)

After §RC11.3 step 4, the DO's storage is empty. The persisted
`host_state` flag is gone with it. The post-delete safety relies on two
mechanisms working together:

1. **Routing layer.** The Directory removed this host's `id_route` entry
   for every tombstoned ULID in step 2. Future `idFromName(...)` lookups
   that go through Directory either route to a different host (impossible
   since payload is gone) or are answered directly by Directory's
   `inherited_tombstone` table with `E_OBJNF` (per
   [persistence.md §14.2.2](../reference/persistence.md#1422-inherited-tombstones-after-host-teardown)).
   Callers that always re-resolve via Directory never reach the dead DO.

2. **Cold-load guard at the DO.** A caller holding a stub from
   `env.WOO.idFromName(host)` can still reach the dead DO directly,
   bypassing Directory. Cloudflare may instantiate a fresh DO for that
   stub. Before any cold-load seed runs (§R9.1), a DO whose storage is
   empty MUST RPC the Directory to ask whether its own id appears as
   `former_host` in `inherited_tombstone`. If it does, the DO refuses all
   inbound requests with `E_HOST_RECYCLED` and writes nothing — its
   in-memory instance is evicted again on the next idle. If it does not,
   the DO is a legitimate first-time instance and proceeds with normal
   cold-load.

Mechanism (2) is the safety net for any caller that didn't go through
Directory, and is the only correct way to handle stale stubs after
teardown without re-using the torn-down host's id. It costs one Directory
RPC per cold-load — acceptable because cold-load is already not on any
hot path.

**A torn-down host's id is never reused for a new payload object.** The
Directory's `inherited_tombstone` row is permanent (subject to the same
offline-vacuum caveat as §14.2.1). Catalog re-installs that need the same
human-readable name use a fresh ULID for the new self-hosted root, and a
fresh `id_route` entry.

### RC11.7 Out of scope for v1

- **Teardown of multi-cluster hosts.** v1 anchor clusters are single-host
  by construction (§RC3.1, §RC10). The §RC11 trigger fires on the host
  whose `livePayloadCount` reaches zero, period; cross-host coordination
  is part of the §RC10 deferred work.
- **Per-host signing keys.** v1 internal-auth uses a single shared
  `WOO_INTERNAL_SECRET`; `x-woo-host-key` is asserted by the caller and
  not bound to any host-specific credential. The §RC11.3 step 2 ownership
  checks therefore protect against public clients and honest-but-buggy
  internal callers, but not against a compromised worker that has the
  shared secret. A future revision may bind each DO to a per-host signing
  key (e.g. derived from its id at first cold-load) so the Directory can
  reject `x-woo-host-key` values forged by other DOs.
- **Resurrection.** A torn-down host's ULID is permanently recorded in
  the Directory's `inherited_tombstone` table; there is no path that
  re-creates a DO under the same root ULID. Catalog re-installs that need
  the same human-readable name use a fresh ULID.
- **Vacuum of `inherited_tombstone`.** The table grows monotonically.
  An offline tool may sweep entries past a configurable horizon, with the
  same backup/restore caveat as §14.2.1.
