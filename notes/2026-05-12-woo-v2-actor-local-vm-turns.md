---
date: 2026-05-12
status: draft
---

# Woo v2: actor-local VM turns

Exploratory design note. This is not a compatibility plan for the current
Durable Object architecture. The goal is to test a different distribution
strategy for a very large Woo network while keeping the user-visible behavior
close to the MOO-shaped object/verb world.

The first build-facing protocol draft from this exploration is
[spec/protocol/v2-turn-network.md](../spec/protocol/v2-turn-network.md).

## Thesis

Woo v2 should not make object placement the semantic authority boundary.

Instead:

- The semantic authority is the ordered stream of deterministic VM turn effects.
- The execution locality is an actor-centered working set that forms around what
  the actor can currently interact with.
- Nodes route whole VM turns to the node most likely to execute them cheaply and
  correctly.
- Remote turn execution returns state transfer by default, so the caller's local
  shard learns from every miss.

The slogan:

```
deterministic VM turns over a mobile, actor-local object heap
```

Objects keep stable identities. Nodes cache and materialize object state. The
system is allowed to move, copy, evict, split, and merge materialized state
without changing object identity or user-level semantics.

## Why this direction

The current v1 reference architecture gives each persistent object or anchor
cluster a fixed host route. That makes routing simple and gives clear authority,
but it also makes locality rigid. If an actor starts interacting with objects
hosted elsewhere, every command can become a burst of cold remote reads and
calls.

The v2 user-visible goal is different:

- Things near the actor should feel local.
- The actor's current room, inventory, focus objects, command metadata, and
  recently touched objects should collect into a hot execution set.
- A cold miss should usually warm the actor's node for future turns.
- Shared contention should be handled explicitly rather than by pretending every
  object has one natural home forever.

This suggests execution should be placed near the actor by default, but not
forced to stay there when another node can execute the full turn better.

## Core terms

### Actor-local shard

A materialized working set maintained by the actor's current node. It normally
contains:

- the actor object;
- inventory and carried/passive objects;
- current room projection and visible contents;
- focused or selected objects;
- parent chain, feature, verb, property-definition, and permission metadata
  needed for command planning and execution;
- recent log tails and snapshots for the domains it has touched.

This shard is an execution cache, not the source of semantic truth.

### VM turn

An atomic deterministic execution segment.

A turn starts from a call request and runs the VM until it returns, raises,
explicitly parks, or reaches a coordination boundary that cannot be included in
the same atomic commit.

For the common case, one user-visible verb call is one turn. For hard cases, a
single task may be represented as several turns once suspend/fork/parked
continuations exist.

### Effect transcript

The ordered, canonical record of the VM-visible effects of one committed turn.
It is more precise than "object mutation" and smaller than "every bytecode
instruction."

Expected contents:

- call identity: actor, target, verb, args, bytecode hashes, caller context;
- logical inputs: assigned sequence, logical time, entropy, external results
  admitted into the turn;
- read set: object/property versions read for semantic decisions;
- write set: property changes, create/recycle, parent/location changes;
- emitted observations;
- result or error;
- before/after state hashes for the touched shard/domain.

The transcript is what replicas replay, audit, validate, and use for catch-up.

### Capable executor

A node capable of executing the whole turn without splitting the atomic segment.
It has enough state, bytecode, metadata, permission facts, log tail, and write
authority or leases to run and commit the turn.

### Commit scope

The ordering authority for a committed effect transcript.

This is not a synonym for object, actor, room, node, or shard. It is the smallest
ordering scope that can make the touched write set atomic for this turn.

Examples:

- an actor's private state;
- a quiet room currently collocated with one actor-local shard;
- a busy room or document with its own contested executor;
- a service/catalog/identity scope;
- a temporary scope created because one object or small set of cells became hot
  and contested.

There does not need to be a global total order. There only needs to be one clear
commit scope for each atomic turn, plus explicit rules for turns that would need
more than one scope. Those turns either acquire a combined scope, route to a
contested executor, or are rewritten as multiple async turns.

## Atomicity model

Atomicity belongs to the VM turn, not to "the object" and not necessarily to the
entire end-to-end user task.

Inside one turn:

- root verb execution;
- synchronous nested calls that remain inside the same execution closure;
- deterministic property reads and writes;
- create/recycle;
- movement/containment updates that are part of the closure;
- observations;
- logical time and entropy captured as sequencer-provided inputs.

All of this commits or rolls back together.

Outside one turn:

- external IO;
- user input waits;
- timers;
- long sleeps;
- high-latency state acquisition;
- contested cross-shard coordination that cannot be folded into this commit.

Without VM suspend/fork, v2 can still get far by treating state misses as
pre-execution failures and retrying the whole turn after acquiring state.

## Turn execution flow

Fast local path:

```
client command
  -> actor node predicts execution closure
  -> actor-local shard already has it
  -> run deterministic VM turn
  -> produce effect transcript
  -> sequence/validate/commit transcript
  -> show/confirm result
```

Warm remote path:

```
client command
  -> actor node predicts closure
  -> local shard is missing important state
  -> actor node selects a likely capable executor from local ads
  -> remote node executes the whole turn
  -> remote node returns outcome + transcript + state transfer
  -> actor node installs transcript/state and warms its shard
```

Cold path:

```
client command
  -> no nearby capable executor
  -> stable anchor or archival node provides snapshot/log tail
  -> actor node hydrates enough state
  -> retry turn locally
```

Contended path:

```
client command touches contested state
  -> route to contested executor/sequencer
  -> execute whole turn there
  -> return transcript + state transfer
  -> actor node updates local shard
```

The common property is that a turn is never half-local, half-remote. If it is
remote, it is remote as a whole atomic execution segment.

## RPC as turn placement

RPC in this model does not mean "call the object's home host." It means:

```
please execute this whole VM turn, because local routing heuristics predict
that you are the best capable executor
```

Request shape, conceptually:

```ts
type TurnExecRequest = {
  kind: "woo.turn.exec.v1";
  id: string;
  turn: {
    actor: ObjRef;
    target: ObjRef;
    verb: string;
    args: WooValue[];
    caller?: ObjRef;
  };
  scope: CommitScopeRef;
  caller_head: { epoch: number; seq: number; hash: string };
  predicted: {
    atoms: string[];      // typed atom hashes, usually small
    write_atoms?: string[];
    effects: number;     // read/write/create/recycle/observe/etc. bitmask
  };
  required_consistency: "presentation" | "semantic" | "write";
  requested_transfer: "closure" | "delta" | "projection";
  max_transfer_bytes?: number;
  selected_ad?: string;
};
```

Response shape:

```ts
type TurnExecReply =
  | {
      ok: true;
      outcome: TurnOutcome;
      transcript: EffectTranscript;
      commit_position: CommitPosition;
      state_transfer: StateTransfer;
      ads?: ExecCapabilityAd[];
    }
  | {
      ok: false;
      reason: "missing_state" | "stale_head" | "scope_mismatch" | "busy" | "policy_denied";
      missing_atoms?: string[];
      better_ad?: ExecCapabilityAd;
    };
```

`requested_transfer` defaults to `"delta"` or `"closure"`. If a node needed
remote execution, it probably needs the state anyway.

## Capability gossip

There should not be a global "where is this object?" oracle on the hot path.
A node does not advertise its device class, reachability, power budget, or
durability as separate categories. It advertises only concrete execution
capability:

```
for turns matching this selector, against this scope/head, I am a plausible
executor; here is my opaque ranking factor
```

Nodes that are too weak, too temporary, too expensive, or not reachable enough
simply advertise nothing for that turn class. Nodes that are marginal can
advertise with a worse `factor`. The routing layer does not need to know why.

```ts
type ExecCapabilityAd = {
  kind: "woo.exec.ad.v1";
  ad: string;            // short content id or random id for this ad
  node: NodeRef;
  expires_at: number;

  scope: CommitScopeRef;
  epoch: number;
  head: { seq: number; hash: string };

  // Bloom filters over typed atom hashes. False positives are allowed.
  covers: Bloom;         // "I probably have this state/code/metadata"
  accepts: Bloom;        // "I am willing to run this target/verb/scope shape"
  effects: number;       // effect bitmask accepted by this ad

  factor: number;        // opaque scalar, lower is better
  max_transfer_bytes?: number;
};
```

A typed atom is hashed with its kind in the preimage:

```
obj:#123
cell:#123.location
verb:#note.read@17
parent:#thing
actor:#alice
scope:#living-room
effect:write
```

Use two filters first:

- `covers`: can the node probably execute because it has the state, code, and
  metadata?
- `accepts`: will the node probably execute this class of turn?

More filters can be added only if measurements show that matching needs them.
False positives are cheap because the target can refuse before executing.

The actor node compiles a compact `TurnKey` from local command planning:

```ts
type TurnKey = {
  scope: CommitScopeRef;
  epoch: number;
  atoms: string[];       // typed atom hashes
  write_atoms: string[];
  effects: number;
};
```

Candidate matching:

```
ad not expired
ad.scope and ad.epoch are compatible
all key.atoms are probably in ad.covers
turn shape atoms are probably in ad.accepts
key.effects is a subset of ad.effects
```

Then the local node ranks matches:

```
score =
  observed_latency_to_node
+ ad.factor
+ estimated_transfer_cost
+ recent_failure_penalty
- recent_success_bonus
```

Ads route work; they do not prove authority. The executor still validates state
and commits through the selected commit scope. Ads should be scoped gossip: a
browser-like node may advertise only to its session relay; an infrastructure node
may gossip more broadly; a tiny or intermittent node may advertise nothing.

## State transfer

Remote execution should normally warm the caller. The reply should include the
state required for future nearby turns, subject to policy and byte limits.

Transfer forms:

- **projection**: enough for display and command planning, not execution;
- **delta**: log/effect entries since the caller's known head;
- **closure**: executable bundle for the touched turn, including object state,
  property definitions, parent/feature/verb metadata, bytecode hashes, and
  relevant permission facts;
- **snapshot page**: content-addressed chunk of materialized state plus proof.

Transfers must be verifiable:

- content hash for every snapshot page;
- transcript hash chain or state hash after each committed turn;
- bytecode/source hash for executable code;
- sequencer epoch and position;
- signature or same-deployment authenticated envelope from trusted anchors or
  executors.

State transfer is cache fill. It does not by itself grant write authority.

## Runtime sequence checks

These are concrete enough to expose gaps in the protocol without committing to a
wire encoding.

### 1. Actor-local private read

Alice reads a note in her inventory.

```
client -> actor node: command "read note"
actor node: command planner builds TurnKey
actor node: local shard covers all atoms
actor node: run VM turn locally
actor node -> commit scope: submit transcript
commit scope -> actor node: accepted(seq, state_hash)
actor node -> client: result + observations
```

No capability gossip or remote execution is needed. The transcript records the
semantic reads and emitted observation. If validation fails because Alice's shard
was stale, the node catches up and reruns the whole turn.

### 2. Warm remote execution with state transfer

Alice examines a chess board in a room. Her actor shard has only the room
projection. The room executor recently advertised an ad whose `covers` and
`accepts` match the board/examine atoms.

```
actor node -> room node: TurnExecRequest(selected_ad, turn, TurnKey)
room node: verify ad is still true enough
room node: run whole VM turn
room node -> commit scope: submit transcript
commit scope -> room node: accepted(seq, state_hash)
room node -> actor node: TurnExecReply(outcome, transcript, delta/closure)
actor node: install transcript and state transfer
actor node -> client: result + observations
```

The actor node now has the board's executable closure, not just the result of the
one examine call. If Alice interacts again, the next turn is likely local.

Compact wire pressure:

- request sends one turn payload plus tens of typed atom hashes, not object
  state;
- reply sends transcript plus delta/closure bounded by `max_transfer_bytes`;
- future commands benefit from the transfer instead of repeating remote reads.

### 3. Stale or optimistic ad

Alice tries to move a shared piece. The selected ad was a false positive or has
gone stale.

```
actor node -> candidate: TurnExecRequest
candidate: preflight detects missing write atom or stale epoch
candidate -> actor node: { ok: false, reason, missing_atoms, better_ad? }
actor node: penalize ad, try next candidate or hydrate locally
```

The VM turn has not started, so no rollback or continuation machinery is needed.
False positives are a routing cost, not a correctness risk.

If the candidate discovers missing state during execution, it aborts the turn
without committing and returns the same refusal shape. A partial transcript is
diagnostic only and must not be accepted.

### 4. Contended room write

Alice drops a note in a busy room while Bob may take it. The actor node may have
the note state, but the room's contents and observation order are contested.

```
actor node: TurnKey includes room contents write + observe-to-room effect
actor node: local ads lose to busy room executor ad
actor node -> room executor: TurnExecRequest
room executor: runs full drop turn under room commit scope
room executor -> actor node: accepted transcript + room/note delta
actor node -> client: confirmed drop
```

This avoids an actor-local write that would later conflict with the room's
canonical ordering. The commit scope is selected by the write set, not by the
object's permanent home.

### 5. Cold anchor hydration

Alice opens an old object no warm node advertises.

```
actor node: no matching ExecCapabilityAd
actor node -> stable anchor: StateNeed(TurnKey atoms, caller_head)
stable anchor -> actor node: snapshot pages + log tail + proof
actor node: verify and install closure
actor node: run VM turn locally
actor node -> commit scope: submit transcript
```

The slow path hydrates before execution. There is still no mid-turn remote
property fetch.

### 6. Low-permanence node

A browser, phone, or small device may be able to run local speculative logic but
may not advertise any `ExecCapabilityAd`. It still benefits from state transfer
through its actor/session node, but other nodes do not route authoritative turns
to it.

If such a node does advertise, the ad is narrow and the factor is its only rank
signal. Device class never appears in the routing protocol.

## Compact wire checks

The wire surface stays compact if each message carries only the information
needed for its layer.

### Capability ad

An `ExecCapabilityAd` is a routing object, not a state object. A normal ad is:

- fixed header: kind, ad id, node, expiry;
- scope/head: scope ref, epoch, seq, hash;
- two Bloom filters: `covers` and `accepts`;
- one effect mask;
- one opaque `factor`;
- optional `max_transfer_bytes`.

It does not carry object state, node profile fields, queue details, battery
state, or a list of every object covered. The Bloom filters compress that into a
lossy reachability claim.

### Turn request

A `TurnExecRequest` carries:

- the user/program call payload;
- selected commit scope and caller head;
- predicted typed atom hashes;
- requested transfer mode and byte budget;
- selected ad id when applicable.

It does not include the actor's shard state. The candidate either has enough
state already, refuses, or separately serves/requests state transfer.

### Turn reply

A successful `TurnExecReply` carries:

- outcome/result;
- effect transcript or transcript reference plus hash;
- commit position;
- state transfer bounded by the request budget;
- optional fresh ads.

A refusal carries only reason, missing atom hashes, and possibly one better ad.

### State transfer

State transfer is chunked and content-addressed. Small deltas can be inline.
Large closures should be references plus pages:

```ts
type StateTransfer = {
  mode: "projection" | "delta" | "closure";
  base: { epoch: number; seq: number; hash: string };
  pages?: Array<{ hash: string; bytes?: Uint8Array; uri?: string }>;
  transcript_tail?: EffectTranscript[];
};
```

The transfer does not need to repeat data already named by content hash and
known to the receiver.

## Hardening constraints

The integrity and authorization rules belong on different artifacts.

### Ads route, receipts prove

`ExecCapabilityAd` messages are advisory. They should be authenticated enough to
prevent cheap spoofing in their gossip scope, but they do not prove state
correctness or write authority.

Load-bearing proof belongs on:

- commit receipts: scope, epoch, seq, transcript hash, and post-state hash;
- state pages: content hashes anchored in a signed/MACed committed root;
- leases/fences: scoped tokens from the commit scope;
- transcript links: previous head and resulting head.

Same-deployment nodes can use MACed envelopes. Cross-operator, relay-heavy, or
less trusted paths need signatures on the receipts/roots/tokens, not on every
individual page when a Merkle or content-addressed root already covers them.

Private scopes should not publish raw atom membership. Hash typed atoms with a
scope/epoch salt known only to authorized participants, so Bloom filters are not
a cheap object-membership oracle.

### Execute, commit, receive

Authorization splits into three questions:

- may this node execute a proposed turn?
- may this transcript commit to the selected scope?
- may this receiver get this state transfer?

An executor may be allowed to run a turn without being trusted to authorize it.
The commit scope validates actor/session identity, effective permissions, read
versions, write authority, lease/fence tokens, bytecode hashes, and deterministic
inputs.

Permission checks performed by VM code are semantic reads. If `note:read()`
depends on `note:is_readable_by(actor)` or a room owner field, those facts appear
in the read set and are validated with the transcript.

State transfer is separately filtered. A node may receive the projection or
closure it is authorized to use; remote execution does not imply access to every
private cell the executor happened to hold.

### Storage roles

Storage has three roles:

- executor cache: purgeable, no authority;
- commit scope storage: durable head, log/transcript refs, leases, idempotency;
- anchor storage: durable snapshots, pages, compacted tails, repair material.

A capable executor should remain disposable. If it loses cache, correctness is
recovered from commit scopes and anchors.

### Aggressively disposed nodes

DO-like nodes with high activation churn should advertise only while warm and
with short TTLs. A cold activation should load a small scope head/index, then
either refuse quickly with missing atoms or hydrate only when the request
explicitly tolerates slow execution.

Activation cost is part of the ad decision and `factor`. The routing protocol
does not need a special DO category.

## Sequencing and validation

There are two plausible implementation strategies.

### Sequencer-run VM

The sequencer executes the VM turn, commits the transcript, and replicas replay.

Benefits:

- simpler correctness;
- no separate validation phase;
- one authority for execution and order.

Costs:

- sequencer becomes hot;
- less benefit from actor-local execution;
- harder to use capable nearby nodes as cheap executors.

### Node-run VM with sequencer validation

A capable node runs the VM turn against its local replica, produces a transcript,
and submits it for ordering/validation. The sequencer validates the read set,
write leases, bytecode hashes, and state heads before assigning commit position.
If validation fails, the executor catches up and retries or returns a conflict.

Benefits:

- actor-local and nearby execution are useful;
- sequencer can remain closer to ordering/fencing than full execution;
- good fit for optimistic low-latency UI.

Costs:

- more complex validation;
- replay/diff tooling becomes mandatory;
- conflicts need explicit repair UX and retry rules.

The second strategy better matches the actor-local goal.

## Determinism requirements

The VM must be stricter than v1.

Inside deterministic turns:

- no wall-clock reads;
- no host RNG;
- no unsequenced external IO;
- no host-local enumeration whose order depends on runtime data structures;
- no ambient state reads unless they are in the read set;
- no remote call that mutates independently outside the turn transcript.

Logical time, entropy, and external results become inputs assigned by the
sequencer or admitted into the transcript.

This does not mean every verb is deterministic forever. It means every committed
turn has enough recorded inputs to replay deterministically.

## Heap and shard model

Object state can be thought of as cells:

```
(object, property)
(object, verb metadata)
(object, parent/features)
(object lifecycle)
```

Shards are materialized sets of cells plus indexes and projections. They are not
necessarily semantic ownership units.

Useful shard types:

- actor-local shard;
- room/surface shard;
- contested-object shard;
- archival/stable anchor shard;
- service shard for catalog/identity/system data;
- projection-only shard.

Shards may split or merge based on access patterns. Object identity does not
change when this happens.

## Containment and rooms

Containment must be carefully separated into semantic state and projection.

A room can be:

- a passive object inside some actor-local shard when it is private and
  uncontended;
- a room/surface actor or contested shard when it coordinates shared state;
- a projection assembled from multiple actor shards when it is only a display
  surface.

Classic room behavior needs a sequenced coordination point for:

- canonical speech order;
- admission/presence decisions;
- take/drop conflict resolution;
- room-local observations;
- locks or other shared state.

The v2 model should allow quiet rooms to collect into the present actors'
locality, but busy rooms should naturally become capable executors or contested
sequencing centers.

## Comparison to per-object sequencers

Per-object logical history can be useful, but per-object physical authority is
too fine-grained for default Woo semantics.

Many ordinary verbs are multi-object transitions. If every object has an
independent sequencer, simple commands become distributed transactions or sagas.

VM-turn sequencing avoids making the object the atomicity boundary. The turn
touches whatever cells are in its execution closure, and the validation layer
decides whether that set can commit atomically at the chosen position.

## Layering implications

### Semantics layer

Needs new or revised concepts:

- VM turn as the atomic execution segment;
- effect transcript as replay/audit unit;
- deterministic input discipline;
- task vs turn distinction;
- state transfer as non-semantic cache fill;
- projections as explicitly weaker than semantic reads.

The object model can remain object/verb/property shaped. The key change is that
object placement is no longer semantic.

### Protocol layer

Needs new surfaces:

- turn execution RPC;
- capability/refusal response;
- execution-capability ads and scoped gossip;
- state transfer formats;
- transcript replay/read;
- lease/fence acquisition for writable cells or domains;
- proof formats for snapshots and log tails.

Cross-node RPCs should be classified by whether they can execute a turn, transfer
state, grant/fence write authority, or only provide projection data.

### Reference/runtime layer

Needs implementation choices:

- how actor-local shards are stored and evicted;
- how stable anchors retain snapshots/logs;
- how sequencers are assigned, migrated, and fenced;
- how nodes advertise execution capability without global enumeration;
- how commit validation is implemented;
- how much state is transferred on a miss;
- how conflicts are surfaced and retried.

Cloudflare DOs can still be one deployment substrate, but not as "one object
equals one DO." They become possible node roles: actor node, stable anchor,
sequencer, room executor, service, or gateway.

### Catalog/superstructure layer

Catalog code should mostly continue to see objects and verbs.

New catalog-visible distinctions may be needed:

- verbs that are deterministic turn handlers;
- verbs that intentionally perform external IO and therefore run outside a
  deterministic turn or admit external results;
- projection-only reads that may be stale;
- explicit coordination surfaces for busy shared rooms/documents/games.

The default author experience should not require thinking about shards.

## Failure modes

### Wrong executor prediction

The chosen node refuses quickly with missing state, stale head, scope mismatch,
policy denial, or overload. The actor node retries another candidate or hydrates
locally.

### Transcript validation failure

The executor ran against stale state or lost a race. The result is not committed.
Actor UI must either retry transparently or patch back from the accepted stream.

### State transfer too large

Executor returns transcript plus a bounded projection and ads or page refs for
follow-up hydration. The actor node may still accept the committed result
without becoming fully warm.

### Sequencer migration race

Epoch fencing is mandatory. Events, leases, transcripts, and snapshots carry the
sequencer epoch. Old epoch writes are rejected.

### Malicious or buggy executor

Validation catches read/write/version/hash mismatches. Same-deployment auth or
signatures identify the node. Replay-and-diff tooling catches deterministic
divergence.

### Split-brain ads

Ads are advisory. They may be stale. Authority comes only from commit validation
and lease/fence checks.

## Open questions

- What is the smallest useful transcript format?
- Are transcripts stored forever, compacted into snapshots, or both?
- What cells require write leases versus optimistic version validation?
- Can command planning predict enough of the execution closure to avoid frequent
  first-run misses?
- What Bloom profile is small enough for frequent gossip but selective enough to
  avoid noisy false positives?
- How does a room become contested, and how does it become quiet again?
- Does the sequencer validate transcripts only, or sometimes run the VM itself?
- What is the operator-facing model for stable anchors?
- How are bytecode/catalog updates sequenced relative to ordinary turns?
- What are the consistency levels exposed to clients and agents?
- How much speculative UI is acceptable for conflicts?

## Current-runtime pressure test

The first implementation should be a shadow recorder in the current runtime, not
a network feature.

Good existing funnels:

- VM property reads/writes already pass through `getPropChecked` and
  `setPropChecked`.
- VM observations already pass through `ctx.observe`.
- Sequenced calls already have a clear commit point in `applyCallRepository`.
- Direct calls already run inside a behavior savepoint and can be wrapped the
  same way.
- Nested bytecode calls already go through `dispatch`.

Known gaps:

- Native handlers and core helpers can call `getProp`, `setPropLocal`,
  `createRuntimeObject`, `moveObjectChecked`, placement helpers, and `Date.now()`
  directly. A shadow transcript must either instrument those helpers or mark the
  turn as "untracked native effect."
- `now()` and `random()` in the VM are currently host inputs. The prototype needs
  a logical input provider before replay can be meaningful.
- Some observations are built in TypeScript with wall-clock timestamps. Those
  must become transcript inputs or deterministic derived values.
- Read validation needs stable cell versions. If existing property/object
  versions are insufficient, the prototype can start with a per-cell shadow
  version map.
- Direct calls are not durable in v1, but they still need turn transcripts in the
  prototype so replay/diff exercises the same machinery.

Prototype rule: record only what can be validated. If a turn touches an
uninstrumented effect, the recorder should flag it explicitly rather than
pretending the transcript is complete.

## Near-term prototype path

This can be tested without replacing the whole runtime:

1. Add a `TurnRecorder` interface with a no-op default.
2. Define the smallest in-memory `EffectTranscript`: call identity, logical
   inputs, read set, write set, observations, result/error.
3. Instrument the central VM-visible effects: `getPropChecked`,
   `setPropChecked`, `ctx.observe`, `dispatch`, `createRuntimeObject`,
   `moveObjectChecked`, and VM `now()`/`random()`.
4. Run existing direct/sequenced calls in shadow mode and emit "complete" versus
   "untracked native effect" diagnostics.
5. Add deterministic logical input injection for `now()` and `random()`.
6. Add replay-and-diff for complete transcripts against a cloned world.
7. Add a local commit receipt shape: pre-head, transcript hash, post-head.
8. Add authorization validation for transcript commit: actor/session, read set,
   write set, bytecode hashes, and deterministic inputs.
9. Simulate actor-local shards by copying only vicinity state into a small
   in-memory executor.
10. Add `E_NEED_STATE` and whole-turn retry when the executor reads a missing
    cell.
11. Define one `ExecCapabilityAd` Bloom profile and test false-positive rates
    against generated TurnKeys.
12. Add a local ad-matching executor chooser over two in-process worlds.
13. Add content-addressed state-transfer pages and receiver-side authorization
    filtering.
14. Only then explore network turn-exec RPC and signed/MACed envelopes.

The first milestone is not distribution. It is proving that Woo VM turns can be
captured, replayed, validated, and retried as deterministic units.

## Prototype slice landed

The first runtime slice now exists as a shadow recorder, not a network feature:

- `src/core/turn-recorder.ts` defines `TurnRecorder`, `ActiveTurnRecorder`,
  event shapes, and an `InMemoryTurnRecorder` test implementation.
- `WooWorld` can install a recorder with `setTurnRecorder(...)`.
- Direct calls and sequenced `$space:call` applications open a recorded turn at
  the verb-execution boundary.
- The central recorder events currently include dispatch, property reads,
  property writes, object creation, object movement, explicit
  cell reads/writes, observations, and logical inputs for VM `now()`, VM
  `random(n)`, `idle_seconds`, and substrate `tell()` timestamps.
- The first explicit non-property cells are resolved verb metadata,
  `location(object)`, and `contents(object)`. VM `contents()` and local
  `location()` reads now produce transcript cells; movement and contents mirror
  updates produce coarse placement writes.
- Native dispatch is now visible as resolved verb metadata and marks the
  transcript incomplete. That keeps the dispatch dependency auditable without
  pretending the native handler's internals have been proven deterministic.
- `tests/turn-recorder.test.ts` covers one direct bytecode mutator, one
  sequenced dubspace control mutation, bytecode verb/location/contents reads,
  native dispatch incompleteness, placement writes for an authored move, and
  replay of a deterministic recorded turn.
- `src/core/turn-replay.ts` can replay a recorded turn against a serialized
  pre-turn world and return the fresh recording. Replay feeds recorded logical
  inputs back into the cloned world, so `now()` / `random(n)` sites can replay
  with the same values.
- `src/core/effect-transcript.ts` normalizes recorder events into a first
  in-memory shadow `EffectTranscript`: cell reads/writes, creates, moves,
  observations, logical inputs, result/error, completeness flag, and stable
  transcript hash. The replay test compares both recorder event arrays and
  normalized transcripts. It also includes a first read/prior-write version
  validator against a serialized pre-turn world. It can also compute a shadow
  touched-state hash from the transcript's read/write cells against any
  serialized world, giving tests a pre/post hash bridge toward commit receipts.
- `src/core/turn-commit.ts` adds a local shadow commit receipt: transcript hash,
  pre/post touched-state hashes, validation errors, and an `accepted` bit.
  Incomplete native transcripts now produce a concrete refused receipt shape.
- `src/core/turn-key.ts` derives a shadow `TurnKey` from the transcript's call,
  read, and write surface. The test shape keeps debug preimages while also
  producing compact 64-hex atom hashes, matching the future capability-gossip
  and Bloom-filter path.
- `src/core/capability-ad.ts` adds a shadow `ExecCapabilityAd` with a concrete
  Bloom-style `covers` filter over TurnKey atom hashes. This gives local tests a
  real "probably covers this turn" predicate and a factor-based ranking helper
  before any network transport exists.
- `src/core/shadow-turn-exec.ts` adds the first missing-state retry simulator.
  A shadow execution node refuses before VM replay when its atom cache does not
  cover the predicted TurnKey, returns `missing_state`, installs a closure
  transfer, then retries the whole recorded turn. The current transfer carries a
  full serialized pre-turn world; it is deliberately a diagnostic stand-in for
  future page-level closure export.
- `tests/shadow-turn-exec.test.ts` covers the high-latency path: actor node
  starts cold, refuses without attempting execution, receives closure transfer,
  retries, accepts the receipt, and ends with warmed state.
- `src/core/shadow-gossip-profile.ts` adds a deterministic profiling harness
  over the shadow executor. It runs the same recorded turn through four network
  shapes: warm actor-local execution, cold actor-to-anchor transfer, near remote
  executor, and stale-ad fallback. The harness executes the turn and computes
  latency from explicit link/transfer costs, so different shapes can be compared
  repeatably.
- `scripts/profile-shadow-turn-network.ts` exposes the first CLI profile via
  `npm run v2:profile`.

This is intentionally diagnostic. It now produces a shadow transcript and has a
small replay/diff foothold, but it is not yet a semantic verifier.

Implementation learning:

- The current host task queue makes a world-local active recorder workable for
  a first shadow mode. The `HostOperationMemo.turnRecorder` field is also in
  place so future distributed paths can carry recorder state explicitly.
- The central funnels are good enough for a first pass, but native handlers
  remain the correctness risk. Many native handlers call the same instrumented
  helpers and will be partially captured, but the recorder does not yet prove
  that a native handler avoided direct mutation or host nondeterminism.
- Behavior-failure observations currently come from the surrounding
  `$space:call` failure path rather than `ctx.observe`, so the next transcript
  layer must capture result/error and synthetic `$error` observations as one
  outcome record.
- The current recorder records property values and local property-version
  counters. Validation now also checks verb metadata plus local
  location/contents cells against a serialized pre-turn world.
- `object.modified` is a usable shadow version for location and contents, but
  it is too coarse for the real protocol. It can false-conflict when unrelated
  object metadata changes, and it relies on every placement writer bumping the
  container object. A network implementation should give location and contents
  their own per-cell versions.
- Dispatch as a verb-metadata read is a helpful pressure test: the commit
  validator must know not just which object properties were read, but which
  executable definition, owner, source hash, direct-callability, and version the
  VM actually ran.
- Post-write reads need explicit handling. The current shadow validator accepts
  a read that matches a same-turn write even when the write has no deterministic
  `next` version. That is adequate for diagnostics, but a real commit protocol
  should assign deterministic per-cell next versions at commit time.
- The missing-state path is now explicit at the TurnKey/atom layer, but not yet
  at the VM read layer. Today the shadow executor refuses before replay if the
  predicted atoms are absent. The harder production behavior is detecting a
  previously unpredicted missing cell during VM execution, aborting without
  commit, and returning enough cell identity for transfer.
- Full-world shadow transfer is useful for proving retry control flow, but it
  does not test compactness or authorization filtering. The next state-plane
  slice should export per-cell or page-level closures and install them into a
  small serialized shard.
- The first profile run makes the cost of full-world shadow transfer visible:
  even a tiny turn transfers the entire bootstrapped world, so cold anchor and
  remote-executor shapes are dominated by transfer bytes. That is useful as a
  baseline, but the next meaningful profile must compare it with bounded
  closure pages.
- Stale ads are not catastrophic when the retry path is cheap and bounded, but
  they add at least one failed RTT before fallback. This supports keeping ads
  advisory and investing in short TTLs, returned better-ads, and failure
  penalties rather than making gossip authoritative.

The next implementation step is to make the shadow `EffectTranscript`
load-bearing:

- include result/error and synthetic failure observations in one outcome record;
- promote touched-state hashes into explicit pre/post receipt fields;
- replace the shadow receipt with a real commit-submit/accept/conflict path;
- reject or mark transcripts that include native dispatch without a completeness
  proof;
- expand validation from read-set consistency to write permissions, lifecycle,
  inherited defaults, and post-state checks.

The next state-plane implementation step is compact closure transfer:

- map TurnKey atom preimages back to the cells and objects they require;
- export a bounded closure instead of a full serialized world;
- install the closure into a small actor shard;
- run the retry against that shard, not against the full anchor snapshot;
- add an actual `E_NEED_STATE` VM/read guard for cells the prediction missed.

The next profiling step is to add shape families rather than hard-coded cases:

- browser-to-relay-to-anchor with asymmetric upload/download;
- DO-like disposable executor with cold activation cost;
- regional executor mesh with returned ads;
- stable anchor under contention;
- multi-turn warmup where the first miss should make the second turn actor-local.

## Transport/protocol readiness

The design is clear enough at the architectural layer, but not yet at the
implementation-planning layer.

The clear pieces are:

- **turn placement**: route one whole VM turn to a capable executor;
- **capability ads**: compact, advisory gossip over executable turn classes;
- **state transfer**: remote execution normally returns cache-fill material;
- **deterministic transcript**: the transcript is the validation/replay unit;
- **commit scope**: ordering authority is chosen from the write/coordination
  need of the turn, not from an object's permanent home;
- **edge nodes**: weak or temporary nodes can consume state without advertising
  capability.

The unclear pieces are the exact wire contracts and state machines around those
ideas. Before implementation planning, v2 needs normative definitions for:

- message envelope, addressing, auth context, idempotency key, and retry rules;
- cell identity, cell version, object-page hash, verb/bytecode hash, and state
  page encoding;
- transcript schema precise enough to replay and validate;
- commit submission, validation failure, accepted receipt, and catch-up;
- subscription frames for committed observations and live-only observations;
- direct/live route restrictions: what a live-only verb may read, emit, or
  mutate;
- TurnKey extraction: how command planning predicts required atoms;
- Bloom profile: hash preimages, salt rules, filter size, false-positive budget,
  TTLs, and ad invalidation;
- transfer policy: projection vs delta vs closure, byte budgets, filtering by
  receiver authority, and cache install rules;
- conflict behavior visible to clients: retry, rollback, patch-forward, or
  user-visible failure.

The transport should be described as four planes, even if one physical
WebSocket or HTTP channel carries all of them:

1. **Execution plane**: `TurnExecRequest`, `TurnExecReply`, refusal.
2. **Commit plane**: transcript submit, receipt, conflict, catch-up.
3. **State plane**: projection, delta, closure, snapshot pages.
4. **Live plane**: non-durable observations, cursor/gesture previews, direct
   chat lines, subscription control.

Keeping these planes separate prevents the browser/mobile case from distorting
the authority model. A browser can be a node on the execution and live planes
without becoming a durable anchor or broadly advertised executor.

## Functional parity pressure

The first v2 implementation should prove parity against three existing
superstructure workloads.

### Chat

Required behavior:

- actors enter, leave, move, take, drop, and observe room activity;
- direct speech and tells remain low-latency live observations;
- sequenced room mutations keep canonical order for containment and conflict;
- transparent chat embedded in other spaces forwards public speech correctly.

Protocol pressure:

- live observations need a first-class route separate from committed frames;
- room/space writes must pick a commit scope that prevents take/drop conflicts;
- actor-local shards must include command metadata and nearby containment state.

### Pinboard and kanban

Required behavior:

- notes/cards remain first-class objects;
- board contents, layout, z-order, columns, and card order are persistent state;
- composite verbs such as `add_note` or `add_card` commit atomically;
- multiple viewers see applied board changes and presence changes;
- embedded mini-chat remains live-only unless a durable chat feature is used.

Protocol pressure:

- the board is the natural commit scope for layout/column/card-order writes;
- closures must include object state plus inherited note/space verbs and
  permission facts;
- state transfer needs joined projections for display and executable closures
  for edits;
- large boards require bounded projection and page-based closure transfer.

### Dubspace

Required behavior:

- high-rate slider/cursor gestures are live-only previews;
- final control changes, loop state, tempo, transport, patterns, and scenes are
  sequenced persistent state;
- browser audio engines apply committed frames and live previews quickly;
- `started_at` and other time-sensitive values use logical inputs.

Protocol pressure:

- live plane must tolerate high-rate, lossy-ish preview traffic;
- commit plane must stay low-rate and replayable;
- browser nodes are not optional here: the audio engine is local to the browser,
  and the browser must materialize enough state to render and hear the surface.

## In-browser node

The browser should be implemented as a real node, but with narrow authority.

Properties:

- runs in a Web Worker, with the main thread limited to UI/audio integration;
- stores cache pages, projections, and recent transcripts in IndexedDB;
- connects to a session gateway/relay over WebSocket first;
- executes deterministic VM turns locally when it has an authorized closure;
- submits transcripts to the relevant commit scope through the relay;
- applies accepted frames from subscriptions and reconciles tentative local
  results;
- emits live-only events for chat lines, cursors, and gesture previews;
- verifies state-page hashes and commit receipts before installing cache;
- does not advertise broad `ExecCapabilityAd`s in the first implementation.

Initial browser-node authority should be:

- may execute turns for the logged-in actor and subscribed surfaces;
- may not commit without server-side scope validation;
- may receive only authorized projections/closures;
- may advertise no capability, or only a narrow session-local ad to its relay in
  later milestones.

This makes browser execution a latency optimization, not a trust assumption.

Browser-node flow for a board edit:

```
main thread UI -> browser worker: move_pin(pin, x, y)
worker: build TurnKey and check local closure
worker: run tentative VM turn
worker -> relay: CommitSubmit(transcript)
relay/commit scope -> worker: accepted receipt + applied frame
worker -> UI: confirm or patch-forward
```

Browser-node flow for dubspace preview:

```
main thread UI -> worker: preview_control(target, name, value)
worker -> relay live plane: LiveEvent(gesture_progress)
worker -> local audio: apply preview immediately
subscribers receive LiveEvent without durable transcript
```

Browser-node flow for dubspace commit:

```
main thread UI -> worker: set_control(target, name, value)
worker: run deterministic turn with logical inputs
worker -> relay: CommitSubmit(transcript)
commit scope -> subscribers: AppliedFrame(control_changed)
all browser audio engines apply the committed frame
```

## Buildable implementation plan

### Phase 0: Protocol spec freeze for the prototype

Write a small normative v2 protocol spec before changing runtime behavior:

- `Envelope`, `NodeRef`, `ScopeRef`, `ObjRef`, `CellRef`, `CellVersion`;
- `EffectTranscript`, `LogicalInputs`, `ReadSet`, `WriteSet`;
- `CommitSubmit`, `CommitReceipt`, `CommitConflict`, `CatchupRequest`;
- `StateTransfer`, `StatePage`, `ProjectionFrame`, `AppliedFrame`;
- `LiveEvent`, `Subscribe`, `Unsubscribe`;
- `ExecCapabilityAd`, `TurnKey`, `TurnExecRequest`, `TurnExecReply`.

The prototype can use JSON/CBOR-like encodings. The important part is the
state machine and validation semantics, not the final binary format.

### Phase 1: Deterministic turn recorder

Instrument the current VM/runtime in shadow mode:

- record complete transcripts for existing direct and sequenced calls;
- inject logical `now` and `random`;
- flag untracked native effects;
- replay complete transcripts against cloned worlds;
- run the chat, pinboard, and dubspace tests through the recorder.

Exit criterion: these workloads can produce complete replayable transcripts for
their committed state-changing turns, and intentionally live-only turns are
classified as live.

### Phase 2: Single-process v2 node simulator

Build several in-memory nodes in one process:

- actor-local node;
- room/board/dubspace commit scopes;
- stable anchor;
- disposable executor cache;
- browser-node shim with the same API the real browser worker will expose.

Implement local message passing for execution, commit, state, and live planes.
Use this to prove routing and retry behavior without real networking.

Exit criterion: functional parity scenarios pass with at least two nodes and
forced cache misses.

### Phase 3: State transfer and capability ads

Add content-addressed state pages and compact ads:

- generate typed atoms from command planning;
- implement two-filter ads (`covers`, `accepts`) with fixed prototype
  parameters;
- rank candidate executors locally;
- return closure/delta transfer by default after remote execution;
- enforce receiver-side authorization filtering.

Exit criterion: actor-local misses warm the caller and reduce subsequent remote
execution in the parity scenarios.

### Phase 4: Real browser node

Move the browser shim into a Web Worker:

- shared VM bundle compiled for browser use;
- IndexedDB cache for pages, projections, transcript tails, and pending turns;
- WebSocket relay connection;
- local tentative execution for subscribed actor/surface closures;
- subscription application for committed frames;
- live-only event send/receive for chat, cursors, and dubspace previews;
- reconciliation for accepted/conflicted turns.

Exit criterion: chat, pinboard, and dubspace can be driven from the browser node
with server-side commit validation.

### Phase 5: Networked infrastructure nodes

Replace in-process links with real transport:

- node-node execution RPC;
- relay/gateway for browser and mobile nodes;
- commit-scope service;
- stable anchor storage;
- short-TTL ads from disposable DO-like nodes;
- authentication envelopes and signed/MACed receipts.

Exit criterion: the parity workloads still pass with browser, relay, executor,
commit scope, and anchor in separate runtimes.

### Phase 6: Eviction, activation, and compaction

Make the system behave like the target deployment:

- LRU/pressure eviction for executor caches and browser caches;
- cold activation path for DO-like nodes;
- snapshot compaction and transcript-tail retention;
- ad expiry and failure penalties;
- chaos tests for stale ads, lost cache, reconnect, duplicate requests, and
  conflict retries.

Exit criterion: aggressive eviction changes latency but not semantics.

## Remaining planning risks

The biggest remaining risks are not the headline transport messages. They are:

- proving that command planning can predict enough closure atoms;
- making direct/live verbs explicit enough that they cannot accidentally become
  unvalidated state mutation;
- keeping browser-node optimistic execution understandable when conflicts happen;
- sizing state transfer so a board or rich room does not become a giant closure
  on every miss;
- deciding when a quiet shared surface becomes a contested commit scope;
- preserving catalog author ergonomics so ordinary verbs still look like Woo,
  not distributed-systems code.
