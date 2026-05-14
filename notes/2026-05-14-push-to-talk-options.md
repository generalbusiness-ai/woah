# Push-to-talk audio in v2 — design options

Speculative notes from a 2026-05-13 conversation. Nothing implemented; nothing
committed. Captured here so it isn't lost.

## Goal

Two related capabilities:

1. **Push-to-talk into a space.** An actor holds a key (or taps a UI button),
   speaks, and present actors in the space hear it. Optional UI badge for
   "Alice is talking."
2. **Direct actor-to-actor audio.** Like a phone call: one actor opens an audio
   channel to another specific actor.

Both want soft real-time audio (≤200ms one-way), not strict ordering, not
durability, not idempotency replay.

## Where it fits in v2

The four-plane model gives a clean split:

- **Execution / commit planes** — *not* for audio packets. Audio bytes don't
  want to land in the transcript or get content-addressed. They should never
  enter the commit log.
- **State plane** — *not* for audio. State is for projection cache hydration,
  not ephemeral streams.
- **Live plane** — the natural home. The existing `live: { resumable: false }`
  marker on the projection cursor already signals "this stream is not durable
  and not replayable on reconnect." Audio belongs here.

What *does* belong on the commit plane: the **control events** around audio.
"Alice started speaking" / "Alice stopped speaking" / "Alice raised hand" are
sequenced observations — they drive UI badges, audit logs, and permission
checks. A catalog verb like `:start_speaking(scope)` runs through the normal
turn path; an observation falls out; the audio bytes flow over a separate
channel keyed by the same session.

## Fan-out topology — the one big decision

This is where the design splits.

### Option 1 — Live envelopes through `CommitScopeDO`

New envelope type, roughly `woo.live.audio.v1`, carrying ~20-60ms Opus frames
(a few KiB each). The browser captures with `MediaStream` → `AudioWorklet` →
Opus encoder → posts to the v2 worker → worker sends as a v2 envelope. The
relay does *not* SQL-write live envelopes; it fans out to subscribed sockets
in the target scope (or routes to `to: <actor>` for direct).

- **Pros:** Reuses existing auth, session routing, scope subscription bookkeeping,
  and socket index. No new DO classes. Wire-visible for debugging. Same envelope
  codec, same hello-first handshake, same reconnect semantics.
- **Cons:** Every audio packet hits a Cloudflare Durable Object. Even without
  SQL writes, that's DO CPU + CF egress at ~50 packets/sec/speaker. For small
  spaces it's fine; cost scales linearly with talker-seconds.
- **Required guardrails:** separate `LIVE_FRAME_MAX_BYTES` of ~32-64 KiB on the
  codec (well below the 1 MiB shadow ceiling); explicit drop-on-backpressure
  semantics — if a subscriber's socket is slow, drop frames silently rather than
  buffer (live ≠ durable).

### Option 2 — Separate `LiveRelayDO` class

A new DO class keyed by scope that holds *only* the present-actors' socket
refs and live subscriptions. No persistence. Audio fan-out detached from
commit fan-out.

- **Pros:** Audio cost decoupled from commit cost. Can scale and shed
  independently. Easier to reason about cost budget — commit DOs stay write-cheap
  by construction.
- **Cons:** New DO class binding (with the usual `wrangler.toml` migration
  ledger). Two subscription books to keep in sync. Session-token rotation
  affects two DOs instead of one.

### Option 3 — WebRTC with `CommitScopeDO` as signaling only

SDP offer/answer and trickled ICE candidates flow as v2 envelopes. Audio
flows peer-to-peer (mesh) or via an external SFU.

- **Pros:** Lowest latency, near-zero relay bandwidth, scales naturally for
  small spaces. Browsers already implement the codec and jitter buffer.
- **Cons:**
  - **TURN is mandatory.** STUN works for ~80% of connections; the remaining
    ~20% (symmetric NAT, corporate UDP blocking, mobile carrier-grade NAT)
    silently fail without a TURN relay. TURN is bandwidth-heavy and stateful;
    there are no free TURN servers at scale. Pay for managed TURN or run coturn.
  - **CF Workers cannot host an SFU.** Workers/DOs are HTTP+WebSocket only —
    no raw UDP, no DTLS termination, no long-lived RTP sessions. Once you
    outgrow full-mesh (~4-6 active speakers, after which laptop CPU and mobile
    battery die), the SFU must live somewhere else: fly.io / VPS / mediasoup /
    livekit / janus, or Cloudflare Calls (managed product, separate billing).
    **This splits your deployment topology in two.** That is the biggest
    architectural cost of WebRTC.
  - **Identity binding is custom work.** v2 has actor identity via session
    tokens; WebRTC has per-PeerConnection identity via DTLS fingerprints.
    Stitching them requires a small protocol: the signaling envelope carries
    the expected DTLS fingerprint signed by the v2 session, and peers refuse
    PCs whose fingerprint doesn't match.
  - **Reconnect doesn't align.** WebRTC PCs die on network change and need
    full renegotiation; v2 WS has its own reconnect/resume. Both state
    machines have to be sequenced under one UX.
  - **Recording disappears.** Audio is peer-to-peer; no observation tap sees
    it. "Save the conversation" becomes a separate problem (SFU-side
    recording, or a recording bot that joins as a peer and uploads to R2).
  - **Browser quirks:** `getUserMedia` permission UX; mobile Safari drops
    audio when backgrounded; echo cancellation quality varies. You'll end up
    pulling a wrapper library (simple-peer / livekit-client / mediasoup-client)
    — 30-100 KiB of bundle.

## Recommendation (instinct, not a decision)

**Start with Option 1.** It lets you ship push-to-talk without new DO classes
or non-CF infra, keeps the wire visible for debugging, and exercises the
live-plane envelope mechanism that v2 already half-promises. Move audio to
Option 2 (separate DO) only when measured cost says so. Reach for Option 3
(WebRTC) only when you have a concrete scale target that Option 1/2 can't
meet within budget — and accept at that point that you're committing to a
non-CF deployment surface.

Keep **recording out of the live plane entirely.** A tap subscribes to the
live stream, encodes to a blob in R2, and the resulting URL becomes a normal
committed property on a `$recording` object. That keeps recording on the
commit plane (where it belongs) and lets live stay ephemeral.

## Sub-questions to decide before implementation

- **Direct actor-to-actor routing.** Each actor has a `PersistentObjectDO`.
  An envelope with `to: <actor>` could route through that DO (audience of one)
  using the same fan-out primitive. Need to decide if actor-direct audio
  goes through the actor DO or through the speaking actor's commit scope.
- **Authorization.** "Can Alice speak into this space" is a catalog
  permission verb (`:can_speak_to(scope)` or similar). "Can Alice speak
  directly to Bob" is consent on Bob's side. Both express cleanly as catalog
  verbs; don't bake into the substrate.
- **Mute / deafen / raise-hand UI state.** All catalog territory. Properties
  on the actor or on a `$voice_channel` object, manipulated through verbs,
  observed via the normal projection.
- **Backpressure policy.** Live envelopes are droppable. Codec should mark
  `woo.live.*` types as drop-on-slow-subscriber and not retry. The applied-
  frame replay path must skip them entirely.
- **Codec choice.** Opus, ~24 kbps mono, 20-60ms frames. Royalty-free,
  mandated by WebRTC, supported by every browser since 2014. No real
  alternatives worth considering.

## Out of scope for this note

- Video (different bandwidth/scale problem, fundamentally needs SFU).
- Whole-world broadcast / one-to-many "stage" audio (different access
  pattern, probably needs SFU too).
- Spatial audio (would belong on the catalog rendering side, not the
  transport).
