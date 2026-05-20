# V2 Open Seed Cache

## Context

The v2 browser and MCP open path was still paying the cold executable-seed
transfer cost on reconnect. The expensive work was visible in `/v2/open`:
projection rebuilds, executable page-closure construction, JSON transfer
encoding, and catalog preseed installation all repeated even when the browser
already had verified IndexedDB pages for the current scope head.

## Changes

- Added open-time executable seed digest negotiation. The browser advertises an
  `executable_seed_digest` only after it can reconstruct the execution node
  from verified IndexedDB pages or a verified checkpoint. The relay recomputes
  its own generation-scoped digest and only returns a compact cache-hit marker
  when the server-side digest matches.
- Added an equal-head display freshness marker. If `last_known_head` exactly
  matches the relay head, the relay returns a signed empty delta instead of
  rebuilding a full projection.
- Removed redundant `structuredClone` calls from the open-seed projection.
  The projection is read-only and the page transfer builder clones outgoing
  payloads, so cloning each kept row before JSON encoding was duplicate work.
- Skipped catalog preseed installation on executable cache hits. This was the
  remaining server-side cost after the compact wire marker landed.
- Bounded the relay executable seed digest cache with an LRU cap and clear it
  whenever the relay serialized generation advances. MCP cross-scope accepted
  transcript propagation and MCP authority refresh now use the relay-level
  invalidation hook so stale digests cannot validate after serialized state
  changes.
- Extended `v2_open` metrics with executable cache status, transfer byte/page
  counts, preseeded object count, and full-save use. The cost-budget test uses
  these counters as a non-flaky regression guard.

## Verification

- `npm run typecheck`
- `npm test -- tests/worker/v2-cost-budget.test.ts tests/shadow-browser-node.test.ts tests/v2-browser-url.test.ts tests/v2-browser-cache.test.ts tests/v2-browser-execution-cache.test.ts`
- `npm test`
- `npm run cf:migrations:check`
- `git diff --check`

## Notes

The regression guard intentionally avoids a hard wall-clock threshold. CI
latency is noisy, but durable writes, preseed count, cache-hit status, page
counts, and transfer-size ratios directly identify the expensive work returning
to the cached open path.
