# Decomposed KV Seed Cache (Step 3b)

Design doc for the planned successor to the monolithic-per-host KV cache
that was rolled back on 2026-05-22 after stale-key poisoning corrupted
the_chatroom and the_outline satellites. Captured as a checkpoint before
implementation begins.

## Why the v1 design failed

The v1 KV cache (commit `71e41a5`, rolled back at `45d9e83`) wrote one
KV value per host: `seed:${host}` → `{ digest, seed }`. Key was not
versioned. When deploy N+1 changed verb metadata, the satellite cold-
load picked up the deploy-N bytes from KV, merged them over local SQL,
and persisted the corrupted merge. Two compounding bugs:

1. **No deploy discriminator on the key.** Same key across deploys.
2. **`persistFullSnapshot` on every `seedMergeChanged === true`.** Any
   merge — including ones from stale KV — got written to local SQL.

Recovery required `/api/admin/force-rebuild-host` on the two
poisoned satellites (commit `b75aaa8`).

Two further observations from the incident:

- the_chatroom and the_outline have seeds larger than the 1MB Worker
  subrequest body limit. `refresh-host-seeds` (which pushes the seed
  to the satellite) can't reach them. The pull path
  (`/__internal/host-seed`) works because Worker response bodies
  aren't subject to the same limit.
- A satellite seed today is dominated by `verb.bytecode` and
  `verb.line_map`. Earlier breakdown: 996KB for the_deck, verbs 67%
  of bytes. Multiple satellite seeds carry the same $-class verbs
  (e.g., `$weather` appears in both the_chatroom and the_outline).

## Goals for v2

1. **Cold-load latency under 500 ms** when KV has hot entries.
2. **No satellite size limits.** Each KV value <100KB.
3. **Stale KV cannot poison local SQL.**
4. **Cache hits survive across deploys** when content didn't change.
5. **No deploy-version coupling required** in the key.

## Approach

Two orthogonal levers:

### Lever A — source-only seeds

Strip `verb.bytecode` and `verb.line_map` from delivered seeds. Wire
format carries `verb.source` (the DSL string) only. Receiver
recompiles via the existing DSL compiler at load time. Native verbs
have no source — encode as a tiny `{ native: name }` shape and keep
the native registry on the receiver.

Cost: ~10 ms per catalog install on the receiver (DSL compile is
cheap; bootstrap measurements show ~250 ms for 59 catalog objects
which includes a lot of object/property work, not just verb
compile).

Win: ~85% reduction in seed bytes. the_chatroom drops well under
the 1MB limit; the_deck drops from ~1MB to ~150KB.

### Lever B — class-decomposed KV

Replace the monolithic `seed:${host}` value with three layers:

| Key | Value | Updated by | Read by |
|---|---|---|---|
| `class:${classId}:${classDigest}` | one class's serialized form (source-only verbs, propertyDefs, eventSchemas, ancestry chain) | catalog install/upgrade on WORLD | every cold satellite that needs that class |
| `host-objects:${host}:${objectsDigest}` | non-class objects owned by host | host's writes | that host's cold-load |
| `host-manifest:${host}` | `{ classes_used: { id, digest }[], objects_digest, schema_version }` | gateway after any host write or class change | cold satellite as first probe |

A satellite cold-loading `the_chatroom` does:

1. **Read `host-manifest:the_chatroom`** (one tiny KV read).
2. **Parallel-read** every `class:${id}:${digest}` and `host-objects:the_chatroom:${digest}` listed in the manifest. Each is small; CF KV reads at edge are <50 ms typical.
3. **Assemble** the world from the pieces.
4. **Recompile** verbs from source (lever A).
5. **Hand off** to the existing world materializer.

The digest in each class/host-objects key means stale values are
unreachable — a new digest is a new key. No deploy versioning
needed; content-addressing handles it.

### Why this together

- Each KV read is small and edge-cacheable.
- Shared classes (`$weather`, `$room`, `$thing`) read from a single
  KV value across many satellites; the read is hot at the edge.
- Class changes only invalidate the affected class entry; host
  changes only invalidate that host's `host-objects`. Cross-deploy
  no-op changes naturally hit the same digest.
- No persistFullSnapshot from KV (see safety below) so even if
  some inconsistency slips through, local SQL is unaffected.

## Safety

KV remains a cold-load accelerator, not durable state. The cold-load
flow:

```
in-memory world ← assemble(KV reads) [used for the current request]
local SQL       ← persistFullSnapshot ONLY when seed came from DO
                  (authoritative) AND the merge ran clean
```

Concretely: when `fetchHostSeed`'s KV read assembles a world, mark
it `provisional: true`. Skip `persistFullSnapshot` until a future
authoritative refresh confirms (e.g., a fanned-out
`apply-v2-commit` that touches the host, or an explicit refresh).

This way: a poisoned KV value affects one DO instance until next
hibernation; never enters durable storage. The dominant cost — first
cold-load — is still accelerated; the persistence is bounded behind
a known-good signal.

## Migration path

1. Land Lever A (source-only seeds) first. No KV changes; just
   reduces the host_seed_fetch body size to under 1MB everywhere.
   Removes the immediate `the_chatroom` / `the_outline` push limit.
2. Land Lever B with the three new KV key shapes. Keep the v1
   `seed:${host}` key writes for backward compatibility during the
   rollout; read v2 first, fall back to v1, fall back to DO RPC.
3. Verify v2 hit rate and cold-start cost. Drop v1 write/read once
   verified.

Step 2 needs WORLD to compute manifests on catalog install/upgrade
and on commit fanout — that's the same hook points that already
manage `hostSeedCache` invalidation per Step 1.

## What this doesn't fix

- WORLD's cold-load itself. WORLD still reads its full SQL on
  rehydrate. The lift here is for SATELLITES being faster when
  WORLD is awake.
- Step 2 (actors off WORLD). That's still the structural fix for
  WORLD-as-bottleneck under apply-v2-commit load. Independent of
  Step 3b.

## Lever A regression (2026-05-22)

Attempted Lever A (commit `610f863`, reverted at `f6d13ff`). Smoke
collapsed from 6–7/9 to 0–3/9. Root cause: on the first cold-load
after a wipe, the satellite has an empty SQL slice, so the merged
world IS the (placeholder-bytecode) seed. cloneImportedVerb then
recompiles every verb synchronously during importWorld. With ~70
verbs per satellite slice and ~50 ms per DSL compile, that's ~3.5 s
of synchronous CPU on the cold-load path — pushes past the 20 s
smoke wall.

Subsequent cold-loads should have been fast (local SQL has full
bytecode from `persistFullSnapshot`), but the regression was visible
across 4 consecutive smokes. Hypothesis: the first cold-load hard-
fail leaves the satellite in a degraded state (request queues,
unhealthy mark, etc.) that cascades.

Conclusion: source-only seeds are not viable without a lazy-compile
or persistent-compile-cache strategy. Defer Lever A; pursue Lever B
on its own.

### Lever B without Lever A

Lever B's wins are independent of size:
- Edge-cached KV reads avoid waking WORLD on satellite cold-load.
- Content-addressed keys prevent stale-data poisoning across deploys.
- Decomposition lets each class be cached separately by every
  satellite that uses it.

The size concern that drove Lever A (`apply-host-seed` 1 MB
subrequest-body limit) doesn't apply to KV: KV value limit is 25 MB,
KV writes go via `env.HOST_SEED_KV.put` which bypasses subrequest
constraints. So we can keep verb.bytecode in the wire format and
still get the KV distribution benefits.

If size becomes the actual bottleneck later (e.g., 1 MB satellite
boots that take >500 ms over the wire), revisit Lever A with a
lazy-compile design.

## Status

- Recovery: ✅ live (force-rebuild routes deployed `23dc0c44`)
- Step 1: ✅ live (per-host invalidation, ~45% in-DO hit rate)
- Lever A (source-only seeds): ⛔ reverted (cold-load regression)
- v1 KV: replaced by Lever B
- Lever B (content-addressed KV, both seed paths): ✅ live (commit
  `03fa936`, deploy `9a9e95c0`)
- Next: horoscope polling off WORLD — see
  `notes/2026-05-22-horoscope-blocking-world.md`

## Lever B measured impact (deploy `9a9e95c0`)

| Metric | Before (Step 1 v2 only) | After Lever B |
|---|---|---|
| `mcp_gateway_snapshot_fetch` avg | 1183 ms | 98 ms |
| `mcp_gateway_snapshot_fetch` max | 6647 ms | 351 ms |
| `host_seed_fetch` avg | ~500 ms | 138 ms |
| `host_seed_fetch` max | ~3 s | 358 ms |
| KV serve rate | 0% | 100% |

Both seed-delivery paths are ~10x faster and no longer the smoke
bottleneck. Cold satellite cold-load now consults KV first, falls
back to DO RPC on miss/error. KV-sourced merges persist to local
SQL (content-addressed keys ⇒ no stale-poisoning risk).

Smoke pass rate didn't fully recover because the remaining MCP POST
timeouts come from horoscope polling blocking WORLD's single-
threaded execution. Resolving that is the next milestone.
