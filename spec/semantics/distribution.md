---
date: 2026-05-20
status: draft
---

# Distribution: Execute, Sequence, Hold

> Part of the [woo specification](../../SPEC.md). Layer: **semantics**.

woah is a distributed system. Many nodes participate in the same world. This section defines *which* nodes are allowed to do *what*, and what counts as the authoritative answer when nodes disagree.

The model has three roles. Any node implements one or more. The same node can fill different roles for different objects or different scopes.

---

## DT1. The three roles

### Execute

Any node holding sufficient state to step a verb may execute it. Execution produces a *transcript proposal*: an ordered record of property reads, property writes, observations, and moves, together with the head the proposal was computed against.

Execution is **symmetric** across all node kinds. A hosted Durable Object, a browser, an MCP shard, and an in-process worker are equivalent peers for the purpose of execution. No node has privileged execution rights for any object.

Execution is **speculative**. The transcript is a proposal until a sequencer accepts it (§DT2).

### Sequence

For each [scope](space.md) — that is, for each `$sequenced_log` instance — exactly one node is the **scope sequencer** at any time. The sequencer accepts envelope submissions, decides the total order in which transcripts apply, and emits accepted frames to subscribers.

The sequencer is the **only** authority on order. Two changes to the same scope have a total order if and only if the sequencer assigned one. The current implementation maps scope sequencer to `CommitScopeDO` (§[cloudflare.md R8](../reference/cloudflare.md)). The model does not preclude later sequencer election or migration; it only requires that there be exactly one at any moment, known to participants.

The sequencer is **not** an executor. The sequencer's job is to *order* transcript proposals it receives. It may also be a state holder (the reference implementation is), but that combination is incidental.

### Hold

Any node may hold a cache of cell versions for objects it cares about. State holders maintain currency by playing the agreed sequence forward — applying accepted frames from a scope's sequencer in order. A state holder is **never authoritative** for changes; cell version is the only authority on freshness (§DT3).

State holders include hosted PersistentObjectDOs (durable replicas, `host_placement` directs which objects are likely to be held where), browsers (volatile replicas of the open scope), and MCP shards (per-session replicas).

`host_placement`, `instances_self_host`, and similar object properties are **cache hints**, not authority claims. A node holding an object's cells at a given version may serve reads; "the host" is the node most likely to have those cells warm, not the node that owns them.

---

## DT2. Commit lifecycle

```
[ executor ]                       [ sequencer ]                  [ holders ]
     |                                   |                              |
     | head_executed_against = H         |                              |
     | transcript = T                    |                              |
     | signed_envelope = sign(H, T) -----> verify signature             |
     |                                   | check head matches current   |
     |                                   | assign seq = N+1             |
     |                                   | commit (H+1 = seq, T)        |
     |                                   |--- accepted frame ---------->|
     |<------ accepted/rejected ---------|                              |
```

A commit succeeds when (a) the proposer's signature verifies against a registered signer, (b) the proposal's `head_executed_against` matches the sequencer's current head (or the proposal supplies a verifiable rebase), and (c) the transcript applies cleanly against the post-head state. If any check fails, the sequencer rejects and the executor may rebase and resubmit.

Executors are **anonymous to the model**. The signature identifies who proposed the change; the sequencer accepts proposals from any registered signer regardless of which executor produced them or where it runs. There is no privileged executor identity associated with object ownership.

---

## DT3. Cell versions are freshness

Every property read returns a value *and* a cell version. A read whose version matches the sequencer's current cell version for that (object, property) is **fresh**. Any other read is **possibly stale** — the reader must either play forward to a current version or accept the staleness for read-only operations that tolerate it.

The cell version, not the source node, is what makes a read trustworthy. Two nodes returning the same value at the same version are interchangeable.

The substrate boundary for cell-versioned reads is defined in [objects.md](objects.md). State pages (§[state-pages](../protocol/v2-turn-network.md)) are the unit of transfer; cell versions are the unit of validity.

---

## DT4. Big-world consequences

The three-role model is what makes woah's big-world stance tractable.

- **No global enumeration.** A node never asks "what is the state of the world." It asks "what is the head of scope S" — which has one well-known sequencer — and "what cells do I need at that head."
- **No singletons with global authority.** There are many sequencers (one per scope), many executors, many holders. No node knows about all objects.
- **Intermittent peers are first-class.** A browser, mobile client, or IoT device that participates only when reachable is fully a peer: it executes when it has state, proposes when it has changes, plays forward when it reconnects. The model has no "primary versus secondary" tier.
- **Cross-scope work is sequencer-to-sequencer.** Changes that span scopes are coordinated by the involved sequencers, not by any external authority. (Cross-scope protocol details: [v2-turn-network.md](../protocol/v2-turn-network.md).)

---

## DT5. Anti-patterns

These patterns indicate code is conflating execution with sequencing, or holding with ownership, and should be revised:

| Anti-pattern | Correct framing |
|---|---|
| "Object X lives on host H." | "Scope S sequences changes to X. Cell cache hints point to H." |
| "Primary host with backstop." | "Sequencer accepts proposals from any signer. Holders cache opportunistically." |
| "Browser is a shadow of the host." | "Executors are peers. Cache fidelity comes from playing the sequence forward." |
| "Authority refresh" implying executable state at a node is *made authoritative*. | "Play forward to head H." |
| "Who owns object X?" | "Which scope sequences X? Which holders have it cached?" |
| `remoteHostForObject` presupposing 1:1 object→host. | Resolve via cell-version cache hints; multiple holders may serve. |
| Relay translating a browser proposal into its own envelope. | Relay forwards the browser's signed envelope verbatim to the sequencer. |

The lint guard `npm run guard:vocabulary` checks new source code against this vocabulary; legacy uses are tolerated via a baseline allowlist but new occurrences require justification or a model fix.

---

## DT6. What this section does **not** specify

- **Sequencer placement and election.** v1 places the sequencer at a known DO (`CommitScopeDO`) per scope. Election, migration, and recovery are deferred. The semantics in §DT1–§DT3 hold regardless of how a scope's sequencer is chosen.
- **Persistence of state holders.** Whether a holder uses SQLite, IndexedDB, or in-memory storage is a deployment concern. The model requires only that holders play forward from accepted frames.
- **Cross-scope ordering.** Two scopes have no shared order. Cross-scope coordination protocols are specified in [v2-turn-network.md](../protocol/v2-turn-network.md).
- **Conflict resolution beyond head-match.** v1 rejects out-of-head proposals and asks the executor to rebase. CRDT-style merge across concurrent executors is deferred.

---

## DT7. Mapping to the implementation

| Role | Implementation surface |
|---|---|
| Execute | `src/core/executor.ts` (the `Executor` interface and `submitTurnIntent` protocol). Implementations: hosted DO, browser, MCP. |
| Sequence | `src/worker/commit-scope-do.ts` (`CommitScopeDO`). One per scope. |
| Hold | `src/worker/persistent-object-do.ts` (durable holder), `src/client/` (browser holder), `src/mcp/host.ts` (MCP-shard holder). |

Code surface naming should reinforce these roles, not contradict them. Renames in flight to match: `HostBridge` → `ExecutorContext`, `v2-turn-gateway.ts` → `executor.ts`. Several legacy names still suggest the older "host owns object" framing and are being retired; see the vocabulary guard for the migration list.
