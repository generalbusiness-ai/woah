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

Execution is **speculative**. The transcript is a proposal until a sequencer accepts it (§DT3).

### Sequence

For each **scope** — that is, for each [`$space`](space.md) instance — exactly one node is the **scope sequencer** at any time. The sequencer accepts envelope submissions, decides the total order in which transcripts apply, and emits accepted frames to subscribers.

`$space` is the spec object that makes a sequencer addressable. `$space` is itself a [`$sequenced_log`](sequenced-log.md) subclass — the log is the primitive that owns `next_seq` allocation atomicity (§SL1–§SL2); `$space` adds the subscription, presence, and observation-audience machinery a scope needs to be *participated in*. A bare `$sequenced_log` instance that is not also a `$space` is a log, not a scope.

The sequencer is the **only** authority on order. Two changes to the same scope have a total order if and only if the sequencer assigned one. The model does not preclude later sequencer election or migration; it only requires that there be exactly one sequencer at any moment, known to participants. See §DT2 for the membership and identity rules.

The sequencer is **not** an executor. The sequencer's job is to *order* transcript proposals it receives. It may also be a state holder (the reference implementation is), but that combination is incidental.

### Hold

Any node may hold a cache of cell versions for objects it cares about. State holders maintain currency by playing the agreed sequence forward — applying accepted frames from a scope's sequencer in order. A state holder is **never authoritative** for changes; cell version is the only authority on freshness (§DT4).

State holders include hosted PersistentObjectDOs (durable replicas, `host_placement` directs which objects are likely to be held where), browsers (volatile replicas of the open scope), and MCP shards (per-session replicas).

`host_placement`, `instances_self_host`, and similar object properties are **cache hints**, not authority claims. A node holding an object's cells at a given version may serve reads; "the host" is the node most likely to have those cells warm, not the node that owns them.

---

## DT2. Scope membership and sequencer identity

### Membership: which objects belong to a scope

An object `O` belongs to scope `S` (a `$space` instance) when any of the following holds:

1. `O` *is* `S`.
2. `O.anchor` resolves transitively to `S`. The `anchor` field is an explicit declaration that `O`'s state lives in the same atomicity cluster as `S` (per [objects.md §4.1](objects.md#41-anchor-and-atomicity-scope)).
3. `O.location` resolves transitively to `S` (i.e., `O` is contained in `S` or in something `S` contains). This covers actors who have entered a room and items they carry.

If none of (1)–(3) hold, `O` is **outside the scope system**. Objects in this category include bootstrap and class objects (`$wiz`, `$system`, `$root`, `$thing`, catalog class definitions, etc.). Changes to those objects do not pass through any scope sequencer — they are sequenced by the world host directly under different rules (see [bootstrap.md](bootstrap.md) and [reference/cloudflare.md](../reference/cloudflare.md)). They are durable but globally rare; ordinary game-world objects always belong to some scope.

Membership is **single-valued**: an object belongs to at most one scope at any time. Moving an object across scopes (e.g., a player walking from one room to another) changes the membership atomically as part of the move; cross-scope moves require sequencer-to-sequencer coordination ([v2-turn-network.md](../protocol/v2-turn-network.md)).

### Identity: which sequencer node handles which scope

Each scope has exactly one **sequencer identity** at any time. The identity is derived from the scope's ObjRef: `sequencer_id = derive(scope_id)`. This makes the mapping deterministic — any node holding a scope's ObjRef can compute, without consulting any registry, which node sequences that scope.

In the v1 Cloudflare reference (§[cloudflare.md R8](../reference/cloudflare.md)), `derive` is `env.COMMIT_SCOPE.idFromName(String(scope))` — the scope's ObjRef *is* the CommitScopeDO instance's name. There is exactly one CommitScopeDO per scope, instantiated lazily on first use; later requests reach the same instance because the derivation is deterministic.

The model permits the derivation function to change in future versions (e.g., to support sequencer migration or election) but requires it to be:

- **Deterministic**: same scope id always maps to the same sequencer at the same point in time.
- **Single-valued**: at any moment, at most one sequencer is current for a given scope.
- **Discoverable without enumeration**: a node holding only the scope id can locate the sequencer.

Cross-scope work is coordinated **sequencer-to-sequencer**, not through any central authority. A turn that touches objects in scopes `A` and `B` is planned by an executor and submitted to one of the two sequencers, which then talks to the other; the protocol for that conversation is in [v2-turn-network.md](../protocol/v2-turn-network.md).

### Why anchor, not host

A common confusion: in early Cloudflare-aware code, "scope" sometimes conflated with "which DO holds the object's rows." Those are different facts.

| Question | Answer | Where it lives |
|---|---|---|
| Which scope *sequences changes to* object `O`? | `O`'s anchor chain (DT2 §Membership). | Object data. |
| Which node currently *holds rows* for object `O`? | Cache hint, often `host_placement` or a Directory route. | Cache metadata. |
| Which DO *executes turns* against object `O`? | Any executor with current cell versions for the cells it needs. | Not pinned anywhere. |

Anchor is durable object data; cache hints are operational and can change. Code that resolves an object's sequencer by reading anchor is correct; code that resolves it by reading host placement may be looking at a stale cache.

---

## DT3. Commit lifecycle

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

## DT4. Cell versions are freshness

Every property read returns a value *and* a cell version. A read whose version matches the sequencer's current cell version for that (object, property) is **fresh**. Any other read is **possibly stale** — the reader must either play forward to a current version or accept the staleness for read-only operations that tolerate it.

The cell version, not the source node, is what makes a read trustworthy. Two nodes returning the same value at the same version are interchangeable.

The substrate boundary for cell-versioned reads is defined in [objects.md](objects.md). State pages (§[state-pages](../protocol/v2-turn-network.md)) are the unit of transfer; cell versions are the unit of validity.

---

## DT5. Big-world consequences

The three-role model is what makes woah's big-world stance tractable.

- **No global enumeration.** A node never asks "what is the state of the world." It asks "what is the head of scope S" — which has one well-known sequencer — and "what cells do I need at that head."
- **No singletons with global authority.** There are many sequencers (one per scope), many executors, many holders. No node knows about all objects.
- **Intermittent peers are first-class.** A browser, mobile client, or IoT device that participates only when reachable is fully a peer: it executes when it has state, proposes when it has changes, plays forward when it reconnects. The model has no "primary versus secondary" tier.
- **Cross-scope work is sequencer-to-sequencer.** Changes that span scopes are coordinated by the involved sequencers, not by any external authority. (Cross-scope protocol details: [v2-turn-network.md](../protocol/v2-turn-network.md).)

---

## DT6. Anti-patterns

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

## DT7. What this section does **not** specify

- **Sequencer placement and election.** v1 places the sequencer at a known DO (`CommitScopeDO`) per scope. Election, migration, and recovery are deferred. The semantics in §DT1–§DT4 hold regardless of how a scope's sequencer is chosen.
- **Persistence of state holders.** Whether a holder uses SQLite, IndexedDB, or in-memory storage is a deployment concern. The model requires only that holders play forward from accepted frames.
- **Cross-scope ordering.** Two scopes have no shared order. Cross-scope coordination protocols are specified in [v2-turn-network.md](../protocol/v2-turn-network.md).
- **Conflict resolution beyond head-match.** v1 rejects out-of-head proposals and asks the executor to rebase. CRDT-style merge across concurrent executors is deferred.

---

## DT8. Mapping to the implementation

| Role | Implementation surface |
|---|---|
| Execute | `src/core/executor.ts` (the `Executor` interface and `submitTurnIntent` protocol). Implementations: hosted DO, browser, MCP. |
| Sequence | `src/worker/commit-scope-do.ts` (`CommitScopeDO`). One per scope. |
| Hold | `src/worker/persistent-object-do.ts` (durable holder), `src/client/` (browser holder), `src/mcp/host.ts` (MCP-shard holder). |

Code surface naming should reinforce these roles, not contradict them. Renames in flight to match: `HostBridge` → `ExecutorContext`, `v2-turn-gateway.ts` → `executor.ts`. Several legacy names still suggest the older "host owns object" framing and are being retired; see the vocabulary guard for the migration list.
