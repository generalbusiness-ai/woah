# Projection Executable Deltas

Origin: 2026-05-20 performance-architecture follow-up for items 5 and 6.

The accepted-projection fan-out work made display catch-up patch-based once a
browser has a projection base. The remaining warm-open boundary was
`/v2/open`: Worker and MCP gateways still sent a whole `SerializedWorld` with
the open request even when CommitScopeDO already had a durable row snapshot for
that scope.

This slice makes `/v2/open` authority-slice-first. Gateways open with current
session/object authority but without `serialized`. If the CommitScopeDO has no
durable snapshot it rejects the open with `E_SNAPSHOT_REQUIRED`; the gateway
then retries with the seed snapshot. The first successful cold open still
materializes row storage from a full snapshot, but warm session opens and stale
relay repairs no longer put the full serialized world on the wire.

REST relay repair reuses the local serialized seed it already needs for
planning, so the fallback does not build a second snapshot. Worker WebSocket
opens avoid `world.exportWorld()` entirely on warm scopes. MCP scope
initialization still builds a local relay snapshot for accepted-frame cache
updates, but it only posts that snapshot if CommitScopeDO explicitly asks for a
seed.

No schema migration is needed. This changes the internal open/retry protocol
only; the persisted CommitScopeDO row layout and v2 transfer shapes are
unchanged.
