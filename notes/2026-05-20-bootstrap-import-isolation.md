# Bootstrap Import Isolation

Origin: 2026-05-20 performance follow-up.

The cached boot snapshot path used to do two whole-world isolation passes before
a usable `WooWorld` existed:

1. `createWorld()` fetched `cachedBootSnapshot(...)`.
2. `bootstrap.ts` cloned it with `JSON.parse(JSON.stringify(...))`.
3. `WooWorld.importWorld()` cloned selected fields again while hydrating maps.

The outer JSON clone was protecting the cached snapshot from `importWorld`
aliasing. `importWorld` now owns that isolation contract directly: flags, verbs
including bytecode/metadata, event schemas, property defaults/values, logs,
snapshots, and parked tasks are copied into the live world. The cached snapshot
can therefore be passed directly to `importWorld()`.

Because serialized worlds are JSON-shaped data, import-only copying uses a tight
plain-data recursive clone instead of `structuredClone` for the large import
cells. A local cached-default boot loop improved from about 11.06 ms/world to
about 5.31 ms/world on this workstation after the change.

Regression coverage:

- `importWorld` isolation test mutates the serialized input after import and the
  hydrated world after import, covering flags, property defaults/values, native
  verb metadata, bytecode verb ops/literals, event schemas, logs, snapshots, and
  parked tasks.
- cached boot snapshot test mutates direct `world.object(...)` cells on one
  world and verifies the next `createWorld({ catalogs: false })` is clean.

No spec change was needed; this is an internal performance/isolation contract
for the existing serialized import behavior.
