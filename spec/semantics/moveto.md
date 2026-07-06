---
date: 2026-05-02
status: implemented (core M1–M5, M7; see status table)
---

# Moveto pipeline

> **Status (audited 2026-07-05):** the receiver-driven move chain is
> implemented and is a documented hot path; this spec is its reference.
>
> | Section | Verdict | Evidence |
> |---|---|---|
> | M1–M3 (two primitives, hook chain, authority) | implemented | `movetoChecked` `src/core/world.ts:5816`, `assertCanMoveto` `:5817`, re-entry marker `movetoStack` `:5840` |
> | M4 (cross-host moves) | implemented | deferred owner write via `ctx.deferHostEffect` in `movetoChecked` |
> | M5 (builtin surface) | implemented | `"moveto"` in `tiny-vm.ts:112` (op `:964`), `dsl-compiler.ts:139`, `authoring.ts:14,906` |
> | M6 (diagnostic `moveto_failed` schema) | not implemented — optional by its own text ("Skip if it adds noise") | no emitter in `world.ts` |
> | M7 (caller migration) | implemented | `moveto(` in `catalogs/chat/manifest.json`, `catalogs/pinboard/manifest.json` |
> | M8 (tests) | covered | moveto chain + cross-host cases in `tests/core.test.ts` (e.g. `:681,:837,:961`) |
> | M9 | descriptive (enabled outcomes) | — |
> | M10 | open questions — still open, non-normative | — |

The LambdaMOO container model — `note:moveto(board)` triggers
`board:acceptable(note)`, then `current.location:exitfunc(note)`, then
the actual move, then `board:enterfunc(note)` — is the missing primitive
that bulletin boards, paste-into-chest mechanics, and other receiver-
driven container patterns need. Today's `move()` builtin is the
authoring primitive: a forced move requiring programmer/wizard authority,
no hooks. We add a separate `moveto()` path that respects the
LambdaMOO chain and is callable by ordinary actors who control the
moving object.

## M1. Two move primitives

| Builtin | Authority | Hooks | Use |
| --- | --- | --- | --- |
| `move(obj, target)` | Programmer ownership of `obj` *or* wizard | None | Authoring / catalog install / forced relocations |
| `moveto(obj, target)` | Caller controls `obj` (owner/wizard) *or* the verb running it has appropriate perms | Full chain (see M2) | Ordinary actor-level container moves |

`move()` keeps its current implementation. `moveto()` is the verb-friendly
path. Chat room exits and room `:take`/`:drop` use it from catalog woocode;
the substrate supplies the move primitive while room command policy remains
catalog-authored.

## M2. The hook chain

```
moveto(obj, target)
  ↓
1. obj:moveto(target)                 — virtual; default impl on $thing
  ↓
2. target:acceptable(obj)             — must return truthy; else E_PERM
  ↓
3. host coordination                  — local move or deferred owner write
  ↓
4. obj.location:exitfunc(obj)         — fired if prior location defines :exitfunc
  ↓
5. core: relocate                     — update .location and .contents
  ↓
6. target:enterfunc(obj)              — fired if target defines :enterfunc
```

### M2.1. Default `:moveto` on `$thing`

The default `$thing:moveto` is the no-op that just delegates back to the
core. Catalogs override on specialized classes when they need
non-standard behavior (e.g. `$portable` already exists; pinned-down
furniture overrides to reject moves).

```moo
verb :moveto(target) rxd {
  // default — let the core run the hook chain
  return moveto(this, target);
}
```

This recursion is broken at the core level: if the calling frame is
already inside the moveto pipeline for this `(obj, target)` pair, the
core skips re-dispatching the verb and proceeds to step 2 directly.

### M2.2. `:acceptable` semantics

If `target` has an `:acceptable` verb, call it with `(obj)`. A truthy
return permits the move; falsy returns raise `E_PERM` with
`{ obj, target, reason: "rejected by acceptable" }`. Errors thrown
inside `:acceptable` propagate.

If `target` has no `:acceptable` verb, the move is permitted.

### M2.3. `:exitfunc` and `:enterfunc`

After the actual relocation, the core invokes `target:enterfunc(obj)`
if the verb is defined. Before, it invokes `obj.location:exitfunc(obj)`
on the prior container if defined. Both are best-effort: errors are
observed but do not roll back the move (matching LambdaMOO's "post-move
hooks must not fail the move" pattern).

Hooks may emit observations, mutate the container's audit-log
properties (e.g. `pinboard.dates`, `pinboard.layout`), or trigger side
effects on paired objects (e.g. `pinboard.mail_recipient:contents_added`).

## M3. Authority

`moveto(obj, target)` requires:

- `caller_perms()` controls `obj` (i.e. is `obj.owner`, `wizard`, or
  acting through a wizard-owned verb that's running with task perms),
  *or*
- `caller_perms()` is the catalog actor for the in-flight install
  (catalog seeding moves objects into seeded containers).

If neither holds, raise `E_PERM` before invoking `:acceptable`.

This is intentionally *less* restrictive than `move()`'s
"programmer-on-obj-or-wizard" rule: `moveto` is the user-level path,
gated by who controls the moving object. The `:acceptable` verb is the
*receiver's* policy point.

## M4. Cross-host moves

Direct `moveto` may cross hosts. The host running the verb performs the
receiver-side checks and container hooks it can observe, then coordinates the
source-of-truth owner-location write through the host bridge. If the moving
object is remote and the current request is already executing inside a host
queue, the owner write is deferred as a host effect and applied after the
outer dispatch returns. This avoids the re-entrant deadlock shape:

```
room host -> actor host -> same room host
```

Sequenced `$space:call` bodies still should not use cross-host `moveto` as a
deterministic state primitive. If a sequenced behavior needs to move remote
objects, it should delegate to a direct/catalog operation that owns the
cross-host effects, or fail with `E_CROSS_HOST_WRITE` until a stronger
multi-host transaction contract exists.

## M5. Implementation surface

### M5.1. New core method

```ts
// world.ts
async movetoChecked(ctx: CallContext, objRef: ObjRef, targetRef: ObjRef): Promise<WooValue> {
  this.assertCanMoveto(ctx.actor, objRef);
  const objRemote = await this.remoteHostForObject(objRef, ctx.hostMemo);
  if (objRemote && ctx.deferHostEffect) {
    await this.invokeAcceptableOrTrue(ctx, targetRef, objRef);
    const oldLoc = await this.objectLocationChecked(objRef, ctx.hostMemo);
    if (oldLoc) await this.invokeHookOrIgnore(ctx, oldLoc, "exitfunc", [objRef]);
    ctx.deferHostEffect({ kind: "move_object", obj: objRef, target: targetRef });
    await this.invokeHookOrIgnore(ctx, targetRef, "enterfunc", [objRef]);
    return targetRef;
  }

  // 1. Virtual dispatch through obj:moveto(target) once per (obj, target).
  if (!ctx.movetoStack?.has(`${objRef}->${targetRef}`)) {
    const verb = this.findVerbOrNull(objRef, "moveto");
    if (verb) return this.callVerbVia(ctx, objRef, "moveto", [targetRef], { movetoMarker: `${objRef}->${targetRef}` });
  }

  // 2. acceptable
  const accepted = await this.invokeAcceptableOrTrue(ctx, targetRef, objRef);
  if (!accepted) throw wooError("E_PERM", "rejected by :acceptable", { obj: objRef, target: targetRef });

  // 3-5. hooks + actual move
  const oldLoc = this.object(objRef).location;
  if (oldLoc && this.objects.has(oldLoc)) {
    await this.invokeHookOrIgnore(ctx, oldLoc, "exitfunc", [objRef]);
  }
  this.relocateObject(objRef, targetRef);
  await this.invokeHookOrIgnore(ctx, targetRef, "enterfunc", [objRef]);

  return targetRef;
}
```

### M5.2. New VM builtin

```ts
// tiny-vm.ts
case "moveto":
  if (builtinArgs.length !== 2) throw wooError("E_INVARG", "moveto expects obj and target");
  return await frame.ctx.world.movetoChecked(frame.ctx, assertObj(builtinArgs[0]), assertObj(builtinArgs[1]));
```

Plus `"moveto"` in `BUILTIN_NAMES` in `tiny-vm.ts`, `dsl-compiler.ts`,
and `authoring.ts`.

### M5.3. Re-entry guard

The dispatcher uses a per-call set (carried on `CallContext`) of
`<obj>-><target>` markers to ensure `obj:moveto(target)` is only called
once per move; if the verb itself calls `moveto(this, t)`, the second
call skips the verb dispatch and goes straight to `:acceptable`.

### M5.4. `:acceptable` / `:exitfunc` / `:enterfunc` resolution

These verbs may be defined directly on the target/old-location, or
inherited via the parent chain. The lookup uses the standard verb
resolution (`resolveVerbWithWalk`).

## M6. Schemas

The pipeline doesn't emit observations of its own — those come from the
hooks that user catalogs install. But for diagnostics, the core may emit
a debug-level event:

```
{ on: "$thing", type: "moveto_failed",
  shape: { obj: "obj", target: "obj", reason: "str", ts: "int" } }
```

…fired when `moveto` raises (:acceptable rejection, permission failure, or
unsupported sequenced cross-host use).
Optional. Skip if it adds noise.

## M7. Migration of existing callers

After landing:

- room exits, `:take`, and `:drop` in chat use `moveto()` in source woocode.
  Matching remains a runtime primitive, but portable checks, English messages,
  inventory moves, and observations are catalog behavior.
- `pinboard v0.2` (`catalogs/pinboard/manifest.draft.json`) becomes
  installable: `:post(pin) → move(pin, this)` becomes `moveto(pin, this)`,
  triggering `:acceptable`/`:enterfunc` automatically.
- `note` catalog's `$note < $portable` already inherits `:moveto` from
  `$thing`'s default — no per-class verb needed.

`builder_create_object`'s `location` option can switch from a direct
location-set to a post-create `moveto()` so creation respects the
hook chain. This makes "create with location" do the right thing
without a separate code path.

## M8. Tests to add

In `tests/core.test.ts`, a new `describe` block:

- moveto runs the full chain (verb fires, acceptable fires, exit/enter
  fire) — observable via test-installed counter verbs on a synthetic
  container.
- acceptable returning falsy rejects with `E_PERM` and doesn't relocate.
- acceptable throwing an error propagates (does not relocate).
- exitfunc/enterfunc errors do not roll back the move (assertion: object
  is at target after the throwing hook).
- recursive moveto (verb calls `moveto(this, t)`) doesn't re-dispatch
  verb — the (obj, target) marker prevents infinite recursion.
- direct cross-host actor movement defers the owner-location write and avoids
  re-entering the origin host.
- non-controller caller raises `E_PERM` before invoking `:acceptable`.
- objects without a `:moveto` override inherit `$thing:moveto` (just hits
  acceptable + relocate + enterfunc).

## M9. What this enables

Once landed:

1. **Pinboard v0.2 install** — `:post`, `:take`, `:eject` become thin
   `moveto()` wrappers; `:enterfunc`/`:exitfunc` maintain the layout
   map and audit log.
2. **Generalized container patterns** — chests with capacity limits,
   private rooms with key checks, locked drawers, suggestion boxes,
   recipe walls. Each just installs `:acceptable`/`:enterfunc`.
3. **`builder_create_object` with location** — can route through
   `moveto` so creation respects receiver-side rules.
4. **Cross-tree mirror hooks** — bulletin board's `:enterfunc` calls
   `mail_recipient:contents_added` which sends the mail. Composes
   without coordination through core.

## M10. Open questions

- Should `obj:moveto(target)` be allowed to reject the move (returning
  falsy or raising)? Probably yes — it's the *sender's* policy point,
  symmetric to `:acceptable`.
- Should `:acceptable` be allowed to suspend (await across a frame)?
  v1: no, must be synchronous per-frame; revisit if a real use case
  emerges.
- Should `:enterfunc`/`:exitfunc` errors emit observations or be
  swallowed? Suggest `moveto_hook_failed` observation, log + continue.
- Does `moveto` create a new sequenced call boundary, or extend the
  current one? Extend the current one — it's a synchronous primitive
  from the caller's perspective. Sub-verbs invoked inside still get
  their own frames.
