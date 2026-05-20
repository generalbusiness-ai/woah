# Accepted Projection Fan-Out

Origin: 2026-05-20 performance follow-up.

Accepted-frame delivery rebuilt a full scope projection separately for every
subscribed browser. That made each committed interaction pay for a full visible
neighborhood walk, full summary cloning, and full projection serialization work
per recipient, even when the commit touched one object and every recipient had
the immediately previous projection.

The hot fan-out path now builds a projection patch directly from the accepted
transcript when the receiver has the previous scope head. The patch recomputes
only scalar projection fields and object-summary list changes that can be
affected by the transcript's touched objects. Unchanged summaries are reused
inside the local cache; only patch upserts are cloned at the trust boundary.
The touched-object set deliberately includes every written transcript cell,
because object summaries also depend on metadata and inherited definitions.
When the receiver has no matching base, history is not contiguous, or the delta
would exceed the transfer budget, the relay still falls back to the existing
full-projection transfer.

Worker state-transfer fan-out now carries the socket's last delivered
`ShadowScopeHead` to `CommitScopeDO`, so hibernated Cloudflare sockets can
receive the same retained patch instead of a full projection. The DO keeps the
server-side browser shim cache in step after state-transfer responses, while
defensively tolerating test WebSocket doubles that do not implement
`serializeAttachment`.

While testing this path, the existing live-persistence regression exposed that
live sequenced turns were still being rejected by durable read-version
validation even though their post-state is intentionally discarded. Live
receipts now validate transcript completeness without treating ephemeral
sequencer bookkeeping as authority-bearing committed state.

Regression coverage:

- a focused shadow-browser-node test fans one accepted `set_control` commit to
  four subscribed browsers with a larger visible object set, verifies the
  transfer is a projection patch without a full projection, verifies the patch
  upserts only the changed object, and guards clone count against the old
  per-recipient full-neighborhood behavior.
- a Worker state-transfer test opens a browser at head N, commits a turn to N+1,
  asks `/v2/state-transfer` with the socket's last known head, and verifies a
  signed patch transfer instead of a projection transfer.
- the live-persistence test verifies a live sequenced turn does not dirty or
  block the following durable commit.
- a commit-scope test covers every current write-cell kind so summary patches do
  not silently miss metadata-affecting writes.

No schema migration is needed. Projection patches were already part of the v2
state-transfer contract; this change makes accepted-frame fan-out use that
contract on the hot path.
