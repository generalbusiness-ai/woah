# 2026-05-29 — replace structuredClone in cloneValue with a guarded plain-data clone

## Why

CPU-profiling the in-memory engine (the path `npm run dev`'s worker and the whole
test suite use) showed `structuredClone` is the dominant localdev hotspot:

- Cold `createWorld()` ≈ 2.8–3.0s, of which **~2.6s was inside `structuredClone`**
  (11.5k calls for a 118-object world). The DSL compile everyone assumes is the
  cost is only ~50ms.
- `exportWorld()` ≈ 15ms/call, also `structuredClone`-bound, and it recurs on
  every snapshot/seed/persist.
- Turn execution is NOT a hotspot (200 sequenced turns = 1.6ms).

`structuredClone` routes plain JSON through Node's worker-transfer serializer —
very slow. `cloneValue` (`src/core/types.ts`) was `structuredClone`, and it runs
on every property write, verb install, VM literal push, frame snapshot, and all
of bootstrap/import.

## What changed

`src/core/types.ts`: added `clonePlainData<T>` — a guarded recursive clone for
plain JSON-shaped data — and pointed `cloneValue` at it. The data `cloneValue`
clones is plain: `WooValue` plus structurally-plain records cast through it
(VerbDef, TinyBytecode, Message, observations, VM handlers, ParkedTaskRecord,
SpaceLogEntry). For that, a direct recursive copy is ~50x cheaper.

Guard semantics (per review guidance — don't silently accept bad inputs):
- Primitives (incl. `undefined`) pass through unchanged.
- Clones plain objects (`Object.prototype` or null prototype) and arrays only.
- THROWS on cycles (DFS path set; shared non-cyclic sub-objects are allowed and
  cloned, not flagged), on non-plain prototypes (Date/Map/Set/RegExp/class
  instances), and on functions/symbols — rather than emitting `{}` or looping.
- Result is always freshly mutable, so the VM's literal push still gets a mutable
  copy of A2's now-frozen bytecode literals. `cloneValue` is NOT special-cased
  for frozen bytecode.

Verified the one risky caller, `tiny-vm.ts:252 cloneValue(error as WooValue)`:
`error` is typed `ErrorValue` (plain `{code,message,value}`); native JS errors
are converted via `wooError()` before reaching it, so no native `Error` is ever
cloned here.

## Second change: share immutable bytecode on serialize (the A2 dual)

Re-profiling after the `cloneValue` swap showed `clonePlainData` was still the
cold-boot tentpole (982ms), because `serializeObject` (`world.ts`) and the
`cloneObject` savepoint path deep-cloned every verb's *bytecode* (ops+literals)
for ~900 verbs — yet bytecode is immutable (A2). Added `cloneVerbSharingBytecode`:
clone the mutable verb wrapper fields (aliases, arg_spec, source, line_map,
calls) but share `freezeTinyBytecode(verb.bytecode)` by reference. This is the
dual of A2's `importBytecode`: export, the boot-snapshot cache, and import now
reuse one frozen bytecode object per verb. (`addVerb` only shallow-spreads, so
install never deep-cloned bytecode — these two serializers were the only ones.)

Behavior note: `exportWorld` now deep-freezes (brands) the live world's bytecode
as a benign side effect — bytecode is immutable, nothing mutates it in place
(A2), and after the first export both re-export and import share with no clone.
The A2 "merely shallow-frozen" guard test was updated to build its shallow-frozen
input explicitly, since exportWorld no longer yields non-deep-frozen bytecode.

## Result (measured, in-memory)

| path | original (structuredClone) | + cloneValue swap | + share bytecode on serialize |
|---|---:|---:|---:|
| cold `createWorld()` | 2801 ms | 1341 ms (−52%) | **~1000 ms** (−64% total) |
| `exportWorld()` | 15.3 ms | 5.8 ms | **3.6 ms** (−76% total) |
| warm `createWorld()` | 10.7 ms | 10.1 ms | 10.1 ms (snapshot-clone path) |

The `exportWorld` win also lands on the prod cold-load (`init/world` /
host-seed / snapshot paths all serialize through it).

## Tests

`tests/clone-plain-data.test.ts` (added to the default `npm test` gate, since
`cloneValue` is engine-core): deep-clone isolation, primitive/undefined/null/
bigint passthrough, null-proto allowed, cycle rejection, shared-non-cyclic
sub-object allowed, rejection of Date/Map/Set/RegExp/class/function/symbol
(incl. nested), and the freeze→fresh-mutable contract the VM relies on.

`tests/core.test.ts` gains "exportWorld shares immutable bytecode by reference
but still clones mutable verb fields" (shared frozen bytecode by identity, second
export reuses it, wrapper fields still cloned, reload still executes); the A2
shallow-frozen guard test was updated for the new exportWorld behavior.

Validated with the full `test:full` sweep because `cloneValue` + the serialize
path's blast radius is the whole engine (export, host-seed, snapshot, persist).

## Follow-up (not done here)

`cloneImportedPlainData` (world.ts) is a second, tolerant recursive clone for the
import path. It could converge onto `clonePlainData` for one shared guarded
helper, but it's not the hotspot and converging widens scope — left as a
follow-up.
