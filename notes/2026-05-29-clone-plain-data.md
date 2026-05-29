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

## Result (measured, in-memory)

| path | before (structuredClone) | after (clonePlainData) |
|---|---:|---:|
| cold `createWorld()` | 2801 ms | **1341 ms** (−52%) |
| `exportWorld()` | 15.3 ms | **5.8 ms** (−62%) |
| warm `createWorld()` | 10.7 ms | 10.1 ms (unchanged — snapshot-clone path) |

The exportWorld win also lands on the prod cold-load (`init/world` /
host-seed / snapshot paths all serialize through it).

## Tests

`tests/clone-plain-data.test.ts` (added to the default `npm test` gate, since
`cloneValue` is engine-core): deep-clone isolation, primitive/undefined/null/
bigint passthrough, null-proto allowed, cycle rejection, shared-non-cyclic
sub-object allowed, rejection of Date/Map/Set/RegExp/class/function/symbol
(incl. nested), and the freeze→fresh-mutable contract the VM relies on.

Validated with the full `test:full` sweep because `cloneValue`'s blast radius is
the whole engine.

## Follow-up (not done here)

`cloneImportedPlainData` (world.ts) is a second, tolerant recursive clone for the
import path. It could converge onto `clonePlainData` for one shared guarded
helper, but it's not the hotspot and converging widens scope — left as a
follow-up.
