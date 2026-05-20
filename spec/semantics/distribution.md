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

The sequencer is the **only** authority on order. Two changes to the same scope have a total order if and only if the sequencer assigned one. The model does not preclude later sequencer election or migration; it only requires that there be exactly one sequencer at any moment, known to participants. See §DT2 for the relationship between turn scope, object host, and sequencer identity.

The sequencer is **not** an executor. The sequencer's job is to *order* transcript proposals it receives. It may also be a state holder (the reference implementation is), but that combination is incidental.

### Hold

Any node may hold a cache of cell versions for objects it cares about. State holders maintain currency by playing the agreed sequence forward — applying accepted frames from a scope's sequencer in order. A state holder is **never authoritative** for changes; cell version is the only authority on freshness (§DT4).

State holders include hosted PersistentObjectDOs (durable replicas, `host_placement` directs which objects are likely to be held where), browsers (volatile replicas of the open scope), and MCP shards (per-session replicas).

`host_placement`, `instances_self_host`, and similar object properties are **cache hints**, not authority claims. A node holding an object's cells at a given version may serve reads; "the host" is the node most likely to have those cells warm, not the node that owns them.

---

## DT2. Turn scope, object host, and sequencer identity

The model has two distinct assignment questions that earlier drafts conflated. Distinguish them.

### Turn scope: which sequencer orders a turn

A turn is submitted with an explicit `scope` field naming a `$space` instance. The sequencer for that scope orders the turn, and assigns cell versions for any properties the turn writes. The scope is declared by the executor at submission, not derived from any object's properties.

By convention, executors set the turn's scope to the actor's active scope — typically the `$space` the actor is currently operating in (often their `location` if that resolves to a `$space`). This is a convention of how callers choose, not a derivation rule the substrate enforces; the wire-level `scope` field is authoritative.

Each scope has its own total order of turns. There is no shared order *between* scopes; concurrent turns in different scopes are unordered with respect to each other unless an explicit cross-scope mechanism (§DT2 cross-scope, below) orders them.

### Object host: which node holds an object's rows

Independent of the turn scope, every object has a **host** — the node that holds its persistent rows. Host placement is decided at object creation per [objects.md §4.2](objects.md#42-host-placement):

1. **Self-hosted** instances (`host_placement = "self"`, derived from the class's `instances_self_host`). The object *is* its own host.
2. **Anchored** instances. The object lives on the host root that its `anchor` chain resolves to.
3. **Co-resident** instances (no anchor, not self-hosted). The object lives on the host that ran the `create` call.

`location` does **not** participate in host placement (objects.md §4.2). A book carried from one room to another stays on its original host; only `location` updates.

Anchor and location are independent axes (objects.md §4.1). An actor whose home anchor points at their `$player` (self-hosted) but whose `location` is `$room42` has rows on the `$player` host and a position inside `$room42`; those two facts are orthogonal.

### Bootstrap objects: outside the scope-per-turn model

A small set of objects (`$wiz`, `$system`, `$root`, `$thing`, catalog class definitions, etc.) are mutated outside the turn-scope model — bootstrap and catalog-install paths sequence changes to them under different rules (see [bootstrap.md](bootstrap.md) and [reference/cloudflare.md](../reference/cloudflare.md)). At runtime these objects are read but rarely written; their changes do not pass through a `$space` sequencer.

### Sequencer identity: how to find the sequencer for a scope

Each scope has exactly one **sequencer identity** at any time. The identity is derived from the scope's ObjRef: `sequencer_id = derive(scope_id)`. The mapping is deterministic — any node holding a scope's ObjRef can compute, without consulting any registry, which node sequences that scope.

In the v1 Cloudflare reference (§[cloudflare.md R8](../reference/cloudflare.md)), `derive` is `env.COMMIT_SCOPE.idFromName(String(scope))` — the scope's ObjRef *is* the CommitScopeDO instance's name. There is exactly one CommitScopeDO per scope, instantiated lazily on first use; later requests reach the same instance because the derivation is deterministic.

The model permits the derivation function to change in future versions (e.g., to support sequencer migration or election) but requires it to be:

- **Deterministic**: same scope id always maps to the same sequencer at the same point in time.
- **Single-valued**: at any moment, at most one sequencer is current for a given scope.
- **Discoverable without enumeration**: a node holding only the scope id can locate the sequencer.

### Cross-scope work

A turn ordered by scope `A`'s sequencer may write properties on objects whose host is elsewhere. In v1 those effects propagate via host-to-host RPC during commit fan-out — the originating scope orders the turn, and the remote host applies the resulting writes. Effects in a remote host may themselves trigger follow-up turns sequenced by *that* host's scope (if it is a `$space`); the model does not promise a global total order across the two scopes.

A turn that needs to *atomically* span two scopes is harder. The full protocol for **mergeable remote sub-transcripts** — sub-turns that execute in another scope and merge their transcripts back into the originating turn — is **deferred** (see [v2-turn-network.md §VTN15](../protocol/v2-turn-network.md), "runtime cross-host bridge boundaries are also explicitly incomplete in the v2 protocol; mergeable remote sub-transcripts are deferred until the execution plane exists"). v1 code that needs cross-scope atomicity either restructures the work to live in one scope or accepts non-atomic propagation.

### Reading the table

The three questions the §DT2 model separates, and where each is answered:

| Question | Where answered | Where it lives |
|---|---|---|
| Which sequencer *orders this turn*? | Turn's `scope` field at submission. | Wire-level, per turn. |
| Which node *holds the rows* for object `O`? | Object's `anchor` chain plus `host_placement` (objects.md §4.2). | Object data, stamped at create. |
| Which DO *executes turns* against object `O`? | Any executor with sufficient state to step the verb. | Not pinned anywhere. |

Anchor is durable object data; the turn's scope is a wire-level decision; execution is symmetric across nodes. Code that resolves "where is this object" by reading anchor or host placement is correct; code that derives "what scope sequences changes to this object" is asking a malformed question — scope is a property of turns, not of objects.

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
