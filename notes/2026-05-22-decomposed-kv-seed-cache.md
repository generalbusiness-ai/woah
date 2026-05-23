# Decomposed KV Seed Cache (Step 3b)

Status and decision note for the Cloudflare host-seed KV cache. This
started as the planned successor to the monolithic per-host cache that
was rolled back on 2026-05-22 after stale-key poisoning corrupted
the_chatroom and the_outline. It is now updated to reflect the actual
implemented path.

## Why the v1 design failed

The v1 KV cache (commit `71e41a5`, rolled back at `45d9e83`) wrote one
KV value per host: `seed:${host}` -> `{ digest, seed }`. The key was
not versioned. When deploy N+1 changed verb metadata, a satellite
cold-load picked up deploy-N bytes from KV, merged them over local SQL,
and persisted the corrupted merge.

Two issues compounded:

1. **No content discriminator on the key.** The same key survived
   across deploys and content changes.
2. **Durable persistence after any merge.** `persistFullSnapshot` ran
   after `seedMergeChanged === true`, including merges sourced from
   stale KV.

Recovery required `/api/admin/force-rebuild-host` on the two poisoned
satellites (commit `b75aaa8`).

Two observations from the incident still matter:

- Some satellite seeds exceeded the 1 MB Worker subrequest body limit
  on the push path (`refresh-host-seeds`). The pull path
  (`/__internal/host-seed`) works because Worker response bodies are
  not subject to the same limit.
- Seed bytes are dominated by `verb.bytecode` and `verb.line_map`.
  Earlier breakdown: 996 KB for the_deck, with verbs at 67% of bytes.
  Multiple satellite seeds carry identical bundled class verbs.

## Goals

1. **Cold-load latency under 500 ms** when KV has hot entries.
2. **Stale KV cannot poison local SQL.**
3. **Cache hits survive across deploys** when content is unchanged.
4. **No deploy-version coupling** in KV keys.
5. **Reduced KV serialization/storage cost** by removing bytecode from
   cache bytes.

The original "<100 KB per KV value" target belongs to the deferred
class-decomposed design. It is no longer the active acceptance gate for
this step because measured whole-seed KV reads are already below the
cold-load latency target.

## Current Implementation

The live Lever B shape is content-addressed whole-seed KV:

| Key | Value |
|---|---|
| `seed-current:${host}` | digest pointer |
| `seed:${host}:${digest}` | bytecode-free host seed payload |
| `mcp-gateway-world-current` | digest pointer |
| `mcp-gateway-world:${digest}` | bytecode-free gateway snapshot payload |

The digest is computed from the full authoritative serialized world or
seed, including bytecode. Bytecode changes therefore move the pointer
even though the cached payload omits bytecode.

Authoritative DO responses still carry executable `verb.bytecode`. KV
is a cache encoding only:

- KV payloads use explicit version kinds:
  `woo.host_seed.kv.bytecode_free.v1` and
  `woo.mcp_gateway_world.kv.bytecode_free.v1`.
- KV payloads strip `verb.bytecode`, clear `line_map`, and carry
  per-verb bytecode hashes.
- Cold readers restore exact bytecode from trusted reservoirs:
  local SQL first, then bundled catalogs compiled by the same runtime.
- If any bytecode body is missing or hash-mismatched, the KV entry is a
  miss and the reader falls back to the signed authoritative DO
  response.

This keeps cold-loads fast when the cache is valid without reintroducing
the Lever A regression.

## Safety

The safety boundary is now content addressing plus bytecode hash
verification, not provisional non-persistence.

KV-sourced merges may persist to local SQL because the bytes are
self-consistent under a content-addressed key. A stale value may remain
in KV until TTL, but it is unreachable after the pointer moves. A
mismatched or incomplete bytecode-free payload is never imported; it is
treated as a cache miss.

Two metrics are specifically for drift detection:

- `host_seed_kv_restore_miss` distinguishes ordinary cache absence
  (`no_pointer`, `no_entry`) from restore drift (`hash_mismatch`,
  `inline_hash_mismatch`, `reservoir_miss`, etc.).
- `kv_catalog_reservoir_build` records the one-time per-isolate cost of
  building the bundled-catalog bytecode reservoir.

The module-global reservoir cache is Worker-isolate-local. It is not
shared across Cloudflare isolates.

## Deferred Alternatives

### Lever A: Source-Only Seeds

Attempted in commit `610f863`, reverted at `f6d13ff`. Smoke collapsed
from 6-7/9 to 0-3/9.

Root cause: on first cold-load after a wipe, the satellite has an empty
SQL slice, so the merged world is the placeholder-bytecode seed.
`cloneImportedVerb` then recompiles every verb synchronously during
`importWorld`. With roughly 70 verbs per satellite slice and about
50 ms per DSL compile, that puts seconds of CPU on the cold-load path
and pushes the 20 s smoke wall.

Decision: source-only seeds are not viable without a lazy-compile or
persistent compile-cache strategy. Missing bytecode on the cold path
must fall back to WORLD's authoritative response, not synchronously
recompile seed source.

### Class-Decomposed KV

The original class-decomposed plan split host seeds into:

| Key | Value |
|---|---|
| `class:${classId}:${classDigest}` | one class's serialized form |
| `host-objects:${host}:${objectsDigest}` | non-class objects owned by host |
| `host-manifest:${host}` | class digests and host object digest |

This remains a plausible future storage optimization because shared
classes (`$room`, `$thing`, `$weather`, etc.) would be edge-cached once
and reused by many hosts. It is not the immediate next step: measured
seed fetches are already under the latency target, and implementing this
now would add complexity before the next bottleneck is proven to be KV
value size or KV read time.

### Canonical JSON Consolidation

The bytecode hash path currently has a local canonical JSON helper.
Consolidate it with the existing canonical JSON logic in `world.ts` and
the bootstrap digest path before this area grows another variant.

## Measured Impact

From deploy `9a9e95c0` before the bytecode-free cache encoding:

| Metric | Before Step 1 v2 only | After content-addressed Lever B |
|---|---:|---:|
| `mcp_gateway_snapshot_fetch` avg | 1183 ms | 98 ms |
| `mcp_gateway_snapshot_fetch` max | 6647 ms | 351 ms |
| `host_seed_fetch` avg | ~500 ms | 138 ms |
| `host_seed_fetch` max | ~3 s | 358 ms |
| KV serve rate | 0% | 100% |

The seed-delivery paths were no longer the smoke bottleneck after
content-addressed KV. Bytecode-free KV should reduce KV bytes and
serialization/storage cost further while preserving the same fallback
semantics.

## Current Status

- Recovery: live (force-rebuild routes deployed at `23dc0c44`).
- Step 1: live (per-host invalidation, about 45% in-DO hit rate).
- Content-addressed Lever B: live for both seed paths.
- Bytecode-free KV payloads: implemented in branch
  `decomposed-kv-seed-cache`; authoritative DO responses still carry
  bytecode and remain the fallback for fresh, edited, or non-bundled
  verbs.
- Block self-hosting: implemented on `main` in `2e52f05`; `$block`
  instances such as `the_horoscope` route to their own DO in current
  code. Production still needs smoke/tail confirmation if that commit
  has not been deployed.

## Immediate Next Steps

1. Review and merge the bytecode-free KV branch.
2. Deploy the current main+branch state when approved, then run
   `scripts/smoke-with-tail.sh`.
3. Confirm the_horoscope no longer appears as
   `host_key:"world"` for `/api/objects/the_horoscope/calls/*`.
   Expected post-block-self-hosting shape: those calls route to
   `host_key:"the_horoscope"`.
4. Sort remaining `world` `do_handler` events by `ms` from the smoke
   tail. The next implementation priority should be the largest
   measured WORLD blocker, not another KV redesign.
5. If the next blocker is actor/session/fanin shaped, resume Step 2:
   move actors and their hot commit paths off WORLD.

## What This Does Not Fix

- WORLD's own cold-load. WORLD still reads its full SQL on rehydrate.
- WORLD as a coordination point for actor/session/fanin paths. KV helps
  satellites avoid waking WORLD for seed reads; it does not remove every
  request path that legitimately touches WORLD.
- The 1 MB push limit for explicit `refresh-host-seeds` of large hosts.
  The pull path remains the production cold-load path; revisit class
  decomposition if push refresh becomes operationally important.
