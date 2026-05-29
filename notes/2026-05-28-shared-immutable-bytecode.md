# 2026-05-28 — share immutable bytecode by reference (Cause A2)

## Why

Cause A of the post-deploy MCP smoke failure is the 12–18s cold-load on the
gateway shard / satellite DO (`mcp_gateway_snapshot_fetch`, `host_seed_fetch`),
which blocks `notifications/initialized` past the 20s budget. Prior KV work made
the *fetch* fast (~127ms); the residual is **CPU in restore**, dominated by
cloning every verb's bytecode body — twice on the cold path:

1. KV restore rehydrates from the (bytecode-free) wire payload and
   `structuredClone`s each verb's bytecode out of the reservoir
   (`persistent-object-do.ts` `restoreBytecodeFreeWorldFromReservoirs`).
2. `importWorld` then deep-clones ops+literals again per verb
   (`world.ts` `cloneImportedBytecode`).

## Key finding

`VerbDef.bytecode` is **effectively immutable after compilation**. A verb edit
builds a fresh bytecode object (`{...compiled.bytecode, version}`); the VM reads
ops/literals strictly read-only and keeps run state on the `VmFrame`; `PUSH_LIT`
deep-clones each literal via `cloneValue` before it reaches the stack; `pure`
and `line_map` live on the `VerbDef`, not the bytecode. So both deep-clones are
**defensive, not load-bearing** — chosen over true lazy hydration because it
*eliminates* the cost rather than deferring it, keeps the full `world.objects`
model, and leaves `literals` materialized so the authority-slice `$helper`
literal scan (`world.ts` ~6279 / ~7149) is unaffected.

## What changed

- `src/core/types.ts`: `deepFreezePlainValue` and `freezeTinyBytecode` — freeze
  a bytecode object all the way down. `Object.isFrozen` is the recursion stop
  (frozen ⇒ deep-frozen by contract).
- `src/worker/persistent-object-do.ts`:
  - `bytecodeReservoirFromSerializedWorld` freezes each bytecode **once** when
    building the module-global reservoir.
  - `restoreBytecodeFreeWorldFromReservoirs` hands back the frozen reservoir
    reference directly (no clone); inline bytecode is frozen-in-place and shared.
- `src/core/world.ts`: `cloneImportedBytecode` → `importBytecode` — if the input
  is already frozen (reservoir path), share it by reference; if unfrozen
  (arbitrary serialized input a caller may still hold), clone once for isolation
  then freeze the copy. Mutable VerbDef wrapper fields (aliases, arg_spec,
  line_map, calls) are still cloned per import by `cloneImportedVerb`.

Net: a shard/satellite cold-load shares one frozen bytecode object per verb
across every world in the isolate — zero bytecode copying on the hot path.
Freezing turns any accidental future in-place mutation into a thrown error
instead of silent cross-world corruption.

## Tests

- `tests/core.test.ts`:
  - "deep-freezes bytecode so a shared copy cannot be mutated in place" — the
    freeze helper, incl. nested ops/literals.
  - "shares frozen bytecode by reference across imported worlds without cloning
    or cross-world corruption" — two worlds restored from one frozen bytecode
    share it by identity; an in-place mutation throws and the peer world is
    unchanged. (Mimics the reservoir-sharing semantic.)
  - existing import-isolation test updated: live bytecode is now frozen/shared
    (mutation throws), while mutable verb wrapper fields stay per-world isolated.
- `tests/vm.test.ts`: "executes on frozen (shared) bytecode without mutating its
  literal source" — a verb that LIST_APPENDs onto a list built from a literal
  runs without throwing and leaves the frozen literal intact, pinning the
  PUSH_LIT/`cloneValue` invariant the sharing depends on.

Green: `npm test` (229), `npm run test:worker` (183 + 5 pre-existing skips),
core+vm (108), catalogs/tap/turn-recorder (132), both typechecks.

## Not in scope / follow-ups

- WORLD-side publish still does `exportWorld()` / `serializeObject()` with full
  verb cloning before `stripBytecodeForKv`. This change fixes the **restore**
  (shard/satellite cold-load) CPU; a bytecode-free export/digest path on the
  WORLD publish side is a separate later optimization.
- Cause A also includes O(world) tool enumeration during init and the
  whole-world (vs gateway-slice) snapshot shape — separate items.

## Spec

Behavior is unchanged (an internal isolation/perf invariant); no normative spec
edit. Verify spec alignment before any merge to main.
