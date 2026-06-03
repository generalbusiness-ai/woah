// Holder-neutral serialize/hydrate of a relay's durable TAIL state.
//
// A `ShadowRelayCache` keeps four pieces of state that must survive the relay
// being evicted and rebuilt (a CommitScopeDO hibernating and rehydrating in
// Cloudflare; a relay dropped from the per-scope map and recreated in localdev):
//
//   - `recently_seen`    — idempotency keys → seen-at, the replay window;
//   - `recent_replies`   — idempotency key → the cached reply envelope, so a
//                          client retrying because it missed the first reply
//                          gets the SAME answer without re-running the turn;
//   - `accepted_frames`  — the retained accepted-commit tail used for reconnect
//                          frame-replay (the checkpoint-tail catch-up path);
//   - `transcript_tail`  — the matching effect transcripts for those frames.
//
// The IN-MEMORY maintenance of these (window pruning, entry caps, sort order)
// already lives in `shadow-browser-node` and is shared by every holder. What was
// NOT shared is the persist↔rehydrate cycle: Cloudflare's CommitScopeDO mirrors
// the four fields into SQL rows and rebuilds them on cold load, while localdev
// kept them purely in process memory and lost them on restart — so a bug in the
// serialize/rehydrate of relay tail state could only surface in a Cloudflare
// smoke test, never locally.
//
// This module owns the runtime-identical part of that cycle: the storable shape
// and the assignment back onto a freshly created relay. Each runtime keeps its
// own transport (SQL rows per CommitScopeDO; a dedicated table in the localdev
// SQLite repository) and converts to/from this shape. Following the
// object-host-write-through seam: the decision is shared in core, the transport
// stays in the caller.

import type { EffectTranscript } from "./effect-transcript";
import type { ShadowCommitAccepted, ShadowScopeHead } from "./shadow-commit-scope";
import type { ShadowEnvelope } from "./shadow-envelope";
import type { ShadowRelayCache } from "./shadow-relay-cache";
import type { WooValue } from "./types";

// The storable projection of a relay's durable tail. Plain JSON: the fields a
// holder must reconstruct after eviction. Maps are carried as entry arrays so the
// shape round-trips through `JSON.stringify`/`JSON.parse` unchanged.
//
// `head` is OPTIONAL because the two runtimes split persistence differently. The
// CommitScopeDO stores the commit head in its `meta` row (alongside the world
// version/counters) and restores it BEFORE calling hydrate, so it omits `head`
// here. localdev persists one self-contained tail blob per scope, so it carries
// the head with the frames — and the reconnect frame-replay catch-up needs the
// rebuilt relay's head/epoch to MATCH the persisted accepted-frame tail, or the
// transfer falls back to a full projection on an epoch mismatch.
export interface SerializedShadowRelayTail {
  head?: ShadowScopeHead;
  recently_seen: [string, number][];
  recent_replies: [string, ShadowEnvelope<WooValue>][];
  accepted_frames: ShadowCommitAccepted[];
  transcript_tail: EffectTranscript[];
}

// Snapshot the relay's durable tail for storage. The relay maintains these
// fields already pruned (window + cap) and sorted on the hot path, so this is a
// faithful copy of the current state — no re-pruning here, mirroring the
// CommitScopeDO, which persists exactly what the in-memory relay holds. The
// commit head is included so a single-blob store (localdev) is self-contained.
export function serializeShadowRelayTail(relay: ShadowRelayCache): SerializedShadowRelayTail {
  return {
    head: structuredClone(relay.commit_scope.head),
    recently_seen: Array.from(relay.recently_seen.entries()),
    recent_replies: Array.from(relay.recent_replies.entries()) as [string, ShadowEnvelope<WooValue>][],
    accepted_frames: relay.accepted_frames.map((frame) => structuredClone(frame)),
    transcript_tail: relay.transcript_tail.map((transcript) => structuredClone(transcript))
  };
}

// Populate a freshly created relay's durable tail from a stored snapshot. This is
// a direct assignment of the fields — identical to the CommitScopeDO's cold-load
// reconstruction, so both runtimes share one definition of "what the relay tail
// is" and update together when the shape changes. The stored data preserves the
// relay's own sort + cap, so no re-ordering is applied (matching the
// CommitScopeDO, which relies on its SQL `ORDER BY`). The head is restored only
// when present: the CommitScopeDO already restored it from `meta` and omits it
// here, so its head is left untouched.
export function hydrateShadowRelayTail(relay: ShadowRelayCache, tail: SerializedShadowRelayTail): void {
  if (tail.head) relay.commit_scope.head = tail.head;
  relay.recently_seen = new Map(tail.recently_seen);
  relay.recent_replies = new Map(tail.recent_replies);
  relay.accepted_frames = tail.accepted_frames;
  relay.transcript_tail = tail.transcript_tail;
}
