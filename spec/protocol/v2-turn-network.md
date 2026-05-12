---
date: 2026-05-12
status: draft
---

# V2 turn network protocol

> Part of the [woo specification](../../SPEC.md). Layer: **protocol**.

This document specifies the first buildable protocol draft for the v2 node
network sketched in [notes/2026-05-12-woo-v2-actor-local-vm-turns.md](../../notes/2026-05-12-woo-v2-actor-local-vm-turns.md).

It is **not** a compatibility revision of the v1 host-per-object deployment.
The v2 goal is functional parity with the current chat, pinboard/kanban, and
dubspace workloads while changing the distribution strategy:

- object placement is not the semantic authority boundary;
- deterministic VM turns are the atomic execution units;
- actor-local shards are execution caches;
- remote execution is whole-turn placement;
- remote execution normally returns state transfer;
- browser-hosted nodes are real nodes with narrow authority.

This document is draft, but it is intended to constrain prototype
implementation. The final byte encoding may change. The state machines and
validation rules should not change casually once implemented.

---

## VTN1. Scope and compatibility

The v2 protocol defines node-to-node and browser-node-to-relay messages for a
network of Woo nodes. A node may hold any combination of:

- actor-local execution cache;
- durable commit-scope state;
- stable anchor pages;
- projection-only display state;
- browser-local UI/audio state;
- live-only session state.

The protocol deliberately avoids a global object-location oracle. It routes
turns by advertised executable capability and validates authority at commit.

The v2 protocol does not require:

- one host per object;
- a global total order;
- compatibility with v1 Cloudflare Durable Object placement;
- exposing node device class in routing messages;
- advertising execution capability from every node.

The protocol does require:

- one clear commit scope for every committed turn;
- deterministic transcripts for committed VM turns;
- authenticated envelopes on authority-bearing paths;
- verifiable state transfer before cache install;
- explicit separation between durable committed frames and live-only events.

## VTN2. Protocol planes

The protocol has four logical planes. One physical WebSocket, HTTP/2 stream, or
DO RPC channel may carry all of them, but implementations MUST preserve the
semantic separation.

| Plane | Purpose | Durable? | Authority-bearing? |
| --- | --- | --- | --- |
| Execution | Ask a capable node to run a whole VM turn. | No, except returned transcript/receipt. | Indirectly. |
| Commit | Submit, validate, order, and acknowledge transcripts. | Yes. | Yes. |
| State | Transfer projections, deltas, closures, and snapshot pages. | Cache fill. | Receive authority is checked. |
| Live | Chat lines, gesture previews, cursors, presence hints, subscription control. | No. | Only within live/session policy. |

Messages MUST NOT smuggle durable world mutation through the live plane. Live
verbs may emit observations and update ephemeral session/browser state, but
durable object cells change only through an accepted commit frame.

## VTN3. References, hashes, and positions

The prototype uses canonical JSON values unless a message field explicitly names
binary bytes. Hashes are over canonical bytes with the type name included in the
preimage.

This document reuses the substrate value and event vocabulary: `WooValue` is
defined by [values.md](../semantics/values.md), `WooError` by the runtime error
shape in [failures.md](../semantics/failures.md), and `WooObservation` by
[events.md](../semantics/events.md). Protocol messages may carry these values,
but protocol validation is separate from catalog event-schema validation.

```ts
type NodeRef = string;       // "node:<deployment>:<id>"
type ScopeRef = string;      // "scope:<id>"
type ObjRef = string;        // stable Woo object id
type ActorRef = ObjRef;
type SessionRef = string;    // authenticated live/session connection
type TurnId = string;        // client or node chosen idempotency key
type Hash = string;          // multihash or "sha256:<base64url>"
type Epoch = number;
type Seq = number;

type ScopeHead = {
  scope: ScopeRef;
  epoch: Epoch;
  seq: Seq;
  hash: Hash;
};

type CommitPosition = ScopeHead;
```

A `ScopeHead` names a commit-scope epoch and the last accepted transcript in
that epoch. Epochs fence sequencer/commit-scope migration. Messages that carry
an epoch MUST be rejected if the receiver knows that epoch is stale.

`ScopeRef` is a v2 protocol identifier. During the shadow prototype, the
runtime may store the scope as the existing `ObjRef` directly, with
`scope:<objRef>` as the canonical wire spelling. This is a prototype shortcut,
not a different authority model.

## VTN4. Message envelope

Every v2 protocol message is carried in an envelope:

```ts
type Envelope<T> = {
  v: 2;
  type: string;
  id: string;
  from: NodeRef;
  to?: NodeRef | ScopeRef | SessionRef;
  actor?: ActorRef;
  session?: SessionRef;
  reply_to?: string;
  sent_at?: number;
  expires_at?: number;
  auth: AuthContext;
  trace?: string;
  body: T;
};

type AuthContext = {
  mode: "same_deployment_mac" | "signature" | "session" | "anonymous_advisory";
  key_id?: string;
  signature?: string;
  mac?: string;
  claims?: Record<string, unknown>;
};
```

`sent_at` and `expires_at` are routing metadata. They are not deterministic VM
inputs. A turn that needs time receives it through `LogicalInputs`.

Authority-bearing messages MUST use `same_deployment_mac`, `signature`, or
`session` authentication. Advisory gossip MAY use `anonymous_advisory` only on
trusted local links where spoofing is not load-bearing.

The tuple `(from, id)` is the envelope idempotency key unless a body-level
`turn.id` or `submit.id` narrows the key further. Receivers MUST make retry of
the same authority-bearing message idempotent for the configured retention
window.

## VTN5. Cells and atoms

The protocol reasons about object state as cells.

```ts
type CellRef =
  | { kind: "prop"; object: ObjRef; name: string }
  | { kind: "verb"; object: ObjRef; name: string; version?: string }
  | { kind: "parent"; object: ObjRef }
  | { kind: "features"; object: ObjRef }
  | { kind: "owner"; object: ObjRef }
  | { kind: "perms"; object: ObjRef; name?: string }
  | { kind: "location"; object: ObjRef }
  | { kind: "contents"; object: ObjRef }
  | { kind: "lifecycle"; object: ObjRef }
  | { kind: "catalog"; name: string; version?: string };

type CellVersion = {
  cell: CellRef;
  version: string;
  hash?: Hash;
};
```

An implementation MAY store cells differently internally. On the wire, reads,
writes, validation, and transfer proofs use this vocabulary.

The shadow prototype derives versions for `location`, `contents`, `lifecycle`,
and `owner` reads from deterministic cell-content hashes. These versions MUST
NOT depend on wall-clock object metadata such as `modified`, because replaying
the same turn against the same pre-state must produce the same transcript and
post-state hash.

Routing atoms are compact hashes of typed preimages. The preimage MUST include
the atom kind. For private scopes, the preimage MUST also include a
scope/epoch-specific salt known only to authorized participants.

Examples:

```text
obj:#123
cell:prop:#123.location
verb:#note.read@17
parent:#thing
actor:#alice
scope:#living-room
effect:write
route:live
```

Atom hashes route work. They do not prove authority or state correctness.

## VTN6. VM turn

A VM turn is one atomic deterministic execution segment. A turn starts from a
call request and ends when the VM returns, raises, or parks at an explicit
coordination boundary.

```ts
type TurnCall = {
  id: TurnId;
  actor: ActorRef;
  target: ObjRef;
  verb: string;
  args: WooValue[];
  caller?: ObjRef;
  route: "committed" | "live";
};

type LogicalInputs = {
  assigned_seq?: Seq;
  logical_time?: number;
  entropy?: Array<{ id: string; bytes: string }>;
  external?: Array<{ id: string; value_hash: Hash; value?: WooValue }>;
};
```

Prototype route mapping:

| v1 runtime path | v2 `TurnCall.route` | Notes |
| --- | --- | --- |
| `directCall` that may mutate durable cells | `"committed"` | Shadow recorders may label this as `"direct"` until the commit plane exists. |
| `$space:call` / `$sequenced_log` applied call | `"committed"` | The existing space sequence is the prototype commit order. |
| Explicit preview/chat/presence-only path | `"live"` | Must not write durable object cells or create durable applied frames. |

Existing `$space` and `$sequenced_log` objects are valid prototype commit
scopes. A v1 sequenced space maps to the v2 `ScopeRef` for that space object.
Not every future commit scope must be a `$space`, but the prototype uses spaces
as the bridge because they already provide ordered applied frames.

The production `LogicalInputs` shape groups inputs by validation role. The
shadow recorder currently emits an ordered flat list of named inputs
(`Array<{name,value}>`) because that is the smallest replay mechanism. The
mapping is:

- `now`, `idle_seconds.now`, and substrate timestamp sites become
  `logical_time` inputs or named time entries under a future structured form;
- `random` becomes an `entropy` entry;
- admitted service or IO results become `external` entries.

Commit-plane implementations MUST preserve input order for replay even when
they also expose the grouped production form.

Committed turns MUST be deterministic given:

- the turn call;
- bytecode/source hashes;
- logical inputs;
- the validated read-set cell values;
- the selected commit-scope rules.

Committed turns MUST NOT read wall-clock time, host RNG, unsequenced external
IO, host-local enumeration order, or ambient state unless the input is admitted
through `LogicalInputs` or the read set.

Live turns are not replayed as durable history. They SHOULD still use the same
VM recorder in diagnostic mode so live/durable boundary mistakes are visible.

## VTN7. Effect transcript

An effect transcript is the canonical record submitted for commit validation
and replay.

```ts
type EffectTranscript = {
  kind: "woo.effect_transcript.v1";
  id: TurnId;
  scope: ScopeRef;
  base: ScopeHead;
  call: TurnCall;
  vm: {
    engine: string;
    catalog_hashes: Record<string, Hash>;
    verb_hashes: Record<string, Hash>;
  };
  inputs: LogicalInputs;
  reads: TranscriptRead[];
  writes: TranscriptWrite[];
  creates?: TranscriptCreate[];
  moves?: TranscriptMove[];
  recycles?: TranscriptRecycle[];
  schedules?: ScheduledTurnRequest[];      // defined in VTN18
  cancellations?: string[];                // schedule ids to cancel; defined in VTN18
  observations: WooObservation[];
  result?: WooValue;
  error?: WooError;
  complete: boolean;
  incomplete_reasons?: string[];
  pre_state_hash?: Hash;
  post_state_hash: Hash;
};

type TranscriptRead = {
  cell: CellRef;
  version: string;
  value_hash?: Hash;
  purpose?: "dispatch" | "permission" | "user" | "builtin" | "projection";
};

type TranscriptWrite = {
  cell: CellRef;
  prior?: string;
  value_hash: Hash;
  value?: WooValue;
  op: "set" | "delete" | "append" | "add" | "remove" | "move" | "replace" | "create";
};

type TranscriptCreate = {
  object: ObjRef;
  parent: ObjRef;
  owner: ObjRef;
  initial_cells: TranscriptWrite[];
};

type TranscriptMove = {
  object: ObjRef;
  from: ObjRef | null;
  to: ObjRef;
};

type TranscriptRecycle = {
  object: ObjRef;
  final_version?: string;
};
```

`move` is used for location-cell replacement when containment movement is the
semantic operation. `add` and `remove` are used for contents-cell membership
updates. `create` is allowed only for lifecycle cells and SHOULD also be
represented in `creates` when the created object identity is visible.

`complete: false` means the recorder observed an untracked native effect or an
execution boundary that cannot be validated. A commit scope MUST NOT accept an
incomplete transcript as a durable turn. It MAY store incomplete transcripts as
diagnostics. `incomplete_reasons` is a diagnostic annotation and is only
meaningful when `complete` is false.

The current implementation emits `kind: "woo.effect_transcript.shadow.v1"`.
That shadow shape is intentionally not wire-compatible with the production
`woo.effect_transcript.v1`: it may omit `base`, `vm`, `pre_state_hash`, and
`post_state_hash`, and it records logical inputs as a flat ordered list. Shadow
transcripts MUST NOT be submitted as production commits. They may be converted
by a later milestone once a `ScopeHead`, accepted VM/catalog hashes, and
pre/post state hashes are available.

Dispatch reads SHOULD contribute to `vm.verb_hashes`. The shadow recorder
currently records the resolved definer, owner, version, `source_hash`, and
direct-callability on each dispatch event; production transcripts fold that data
into both the read set and the `vm` block.

Transcript values MAY be omitted when the receiver already has the matching
content-addressed state page. Validation still needs either the value or a
trusted way to retrieve it by `value_hash`.

Observation payloads are part of the transcript for committed turns. Live-only
events are not.

## VTN8. Commit plane

The commit plane orders accepted transcripts within one commit scope.

```ts
type LeaseToken = {
  kind: "woo.lease.v1";
  id: string;
  scope: ScopeRef;
  epoch: Epoch;
  holder: NodeRef | ActorRef;
  cells: CellRef[];
  mode: "write" | "sequence" | "migration";
  issued_at: number;
  expires_at: number;
  fence: string;
  signer: NodeRef | ScopeRef;
  signature?: string;
  mac?: string;
};

type ValidationRule = {
  id: string;
  scope: ScopeRef;
  epoch: Epoch;
  cells: CellRef[];
  purpose: "projection";
  max_staleness_seq?: number;
  max_staleness_ms?: number;
  verbs?: string[];
};

type CommitSubmit = {
  kind: "woo.commit.submit.v1";
  id: string;
  scope: ScopeRef;
  expected: ScopeHead;
  transcript: EffectTranscript;
  leases?: LeaseToken[];
  requested_transfer?: TransferRequest; // defined in VTN12
};

type CommitAccepted = {
  kind: "woo.commit.accepted.v1";
  id: string;
  position: CommitPosition;
  transcript_hash: Hash;
  post_state_hash: Hash;
  observations: WooObservation[];
  state_transfer?: StateTransfer;
  receipt: CommitReceipt;
};

type CommitConflict = {
  kind: "woo.commit.conflict.v1";
  id: string;
  scope: ScopeRef;
  current: ScopeHead;
  reason:
    | "stale_head"
    | "read_version_mismatch"
    | "write_fence_missing"
    | "permission_denied"
    | "bytecode_mismatch"
    | "nondeterministic"
    | "incomplete_transcript"
    | "scope_mismatch";
  conflicting_cells?: CellRef[];
  state_transfer?: StateTransfer;
};

type CommitReceipt = {
  scope: ScopeRef;
  epoch: Epoch;
  seq: Seq;
  prev_hash: Hash;
  transcript_hash: Hash;
  post_state_hash: Hash;
  signer: NodeRef | ScopeRef;
  signature?: string;
  mac?: string;
};
```

A commit scope validates a `CommitSubmit` in this order:

1. Envelope authentication and actor/session authority.
2. Scope and epoch match.
3. Idempotency key replay check.
4. Transcript is complete and targets this scope.
5. VM/catalog/verb hashes are accepted for the scope epoch.
6. Logical inputs are valid and not duplicated.
7. Read versions match current state, unless a declared validation rule allows
   the read to be stale projection data.
8. Permission reads and policy checks are included in the read set.
9. Writes are authorized by actor/session and any required lease/fence token.
10. Applying writes yields the transcript `post_state_hash`.
11. The receipt is recorded and returned.

If validation fails, no write from the transcript is committed. The executor may
catch up and retry the whole turn.

Lease acquisition is intentionally minimal in this draft: a commit scope or its
sequencer issues `LeaseToken`s for cells whose writes require fencing before the
turn runs. The token is not authority by itself; it is valid only with envelope
authentication and normal actor/session authorization.

Validation rules are scope-epoch policy, not caller hints. Until a
`ValidationRule` is installed for a scope epoch, projection reads are validated
with the same exact-version rule as semantic reads. The first implementation may
reject all stale projection reads while still carrying the type above for the
future relaxed path.

The shadow implementation now includes an in-process commit scope. It accepts
`woo.commit.submit.shadow.v1` messages from the execution helper, owns the
authoritative serialized state and shadow `ScopeHead`, validates expected head,
scope, completeness, session/actor shape, read versions, coarse write
authority, lifecycle/move post-state, and touched-cell post-state hashes, then
returns `woo.commit.accepted.shadow.v1` or `woo.commit.conflict.shadow.v1`.
The shadow submit still carries an executor `serialized_after` so the prototype
can merge transcript-touched object records from a partial shard into the full
authoritative state. That field is a prototype crutch, not the production commit
encoding.

## VTN9. Catch-up and applied frames

Subscribers consume committed state through applied frames.

```ts
type Subscribe = {
  kind: "woo.subscribe.v1";
  scopes: ScopeRef[];
  from?: Record<ScopeRef, ScopeHead>;
  wants: "applied" | "projection" | "both";
};

type AppliedFrame = {
  kind: "woo.applied.v1";
  scope: ScopeRef;
  position: CommitPosition;
  transcript_hash: Hash;
  call?: TurnCall;
  observations: WooObservation[];
  result?: WooValue;       // only for authorized originator
  state_transfer?: StateTransfer;
};

type CatchupRequest = {
  kind: "woo.catchup.request.v1";
  scope: ScopeRef;
  from: ScopeHead;
  limit?: number;
  wants?: "transcript" | "applied" | "projection";
};

type CatchupReply = {
  kind: "woo.catchup.reply.v1";
  scope: ScopeRef;
  from: ScopeHead;
  to: ScopeHead;
  frames: AppliedFrame[];
  has_more: boolean;
};
```

`AppliedFrame` is the durable successor of the v1 `op:"applied"` frame. It is
the canonical subscription frame for committed observations and materialized
state changes. Clients MUST treat missing positions as gaps and use catch-up.

## VTN10. Execution plane

Execution RPC asks another node to execute a whole turn. The request target is a
node believed to be a capable executor, not an object's permanent home.

```ts
type TurnKey = {
  scope: ScopeRef;
  epoch: Epoch;
  atoms: string[];
  write_atoms?: string[];
  accept_atoms?: string[];
  effects: number;
};

type TurnExecRequest = {
  kind: "woo.turn.exec.v1";
  id: TurnId;
  turn: TurnCall & { route: "committed" };
  scope: ScopeRef;
  caller_head: ScopeHead;
  predicted: TurnKey;
  required_consistency: "presentation" | "semantic" | "write";
  requested_transfer?: TransferRequest; // defined in VTN12
  max_transfer_bytes?: number;
  selected_ad?: string;
  commit_policy?: "execute_and_commit" | "execute_only";
};

type TurnExecReply =
  | {
      kind: "woo.turn.exec.reply.v1";
      ok: true;
      id: TurnId;
      outcome: { result?: WooValue; error?: WooError };
      transcript: EffectTranscript;
      commit?: CommitAccepted;
      state_transfer?: StateTransfer;
      ads?: ExecCapabilityAd[];
    }
  | {
      kind: "woo.turn.exec.reply.v1";
      ok: false;
      id: TurnId;
      reason:
        | "missing_state"
        | "stale_head"
        | "scope_mismatch"
        | "busy"
        | "policy_denied"
        | "ad_expired"
        | "transfer_too_large"
        | "not_deterministic";
      missing_atoms?: string[];
      current?: ScopeHead;
      better_ad?: ExecCapabilityAd;
      state_transfer?: StateTransfer;
    };
```

The default `commit_policy` is `execute_and_commit`. A successful default reply
MUST include an accepted commit receipt. `execute_only` is reserved for local
simulation and diagnostic deployments; clients MUST NOT treat an `execute_only`
result as authoritative state.

`atoms` are the state/code/metadata closure that a candidate must probably
cover before execution. `write_atoms` identify write-authority-sensitive cells
so routing can avoid projection-only nodes before commit. `accept_atoms` are
the compact turn-shape atoms, typically scope/target/call, checked against an
ad's `accepts` filter.

An executor SHOULD refuse before running the VM if required atoms are obviously
missing. If missing state is discovered during execution, the executor MUST
abort without commit and return `missing_state`. Partial transcripts from such
runs are diagnostics only.

The shadow implementation covers this for fresh `TurnCall` execution in two
places: a predicted TurnKey is compared with a local atom cache before running,
and the turn recorder enforces an `E_NEED_STATE` guard when dispatch, property,
or structural cell events touch an atom outside the materialized set. The
recorded-turn replay helper remains a diagnostic preflight harness only.

The `executeShadowRecordedTurnOrNeedState` helper is a diagnostic replay
harness: it accepts an already recorded turn and replays it with recorded
logical inputs. The newer `executeShadowTurnCallOrNeedState` helper follows the
target protocol shape more closely: it receives a `TurnCall`, executes it fresh
on the selected node, returns a shadow `TurnExecReply`, and can submit the fresh
transcript to the in-process shadow commit scope for accept/conflict handling.

## VTN11. Capability gossip

Capability ads are compact routing hints.

```ts
type Bloom = {
  m: number;              // number of bits
  k: number;              // number of hash functions
  salt_id?: string;
  bits: string;           // base64url bitset
};

type ExecCapabilityAd = {
  kind: "woo.exec.ad.v1";
  ad: string;
  node: NodeRef;
  expires_at: number;
  scope: ScopeRef;
  epoch: Epoch;
  head: ScopeHead;
  covers: Bloom;
  accepts: Bloom;
  effects: number;
  factor: number;
  max_transfer_bytes?: number;
  auth?: AuthContext;
};
```

`covers` means "this node probably has the state, code, metadata, and log tail."
`accepts` means "this node is willing to run this target/verb/scope shape."

Nodes MUST NOT encode device class, battery state, permanence tier, or platform
kind as protocol categories. Low-capability or low-permanence nodes simply do
not advertise, or they advertise narrowly with a worse opaque `factor`.

Candidate selection:

```text
ad not expired
ad.scope and ad.epoch match the TurnKey
all TurnKey atoms are probably in ad.covers
turn-shape atoms are probably in ad.accepts
TurnKey effects are a subset of ad.effects
rank by observed latency + ad.factor + estimated transfer cost + failure penalty
```

Lower rank scores are better. `factor` is an opaque cost contribution, not a
quality score; a larger factor makes an otherwise equivalent candidate less
preferred.

Ads are advisory. Commit receipts and state proofs are authoritative.

When an ad is carried inside an `Envelope`, omitted `ExecCapabilityAd.auth`
means the ad inherits `Envelope.auth`. When an ad is relayed or stored outside
its original envelope, `auth` MUST be present unless the ad is explicitly
`anonymous_advisory` and confined to a trusted local link. An absent `auth`
never upgrades an ad to same-deployment authority.

Prototype profiling SHOULD treat stale ads and Bloom false positives as normal
events, not exceptional failures. A failed execution attempt that returns
`missing_state` contributes observed latency and a failure penalty to future
ranking, then the caller falls back to another ad or state transfer. The ad
plane remains advisory; correctness still comes from transcript validation and
commit receipts.

## VTN12. State plane

State transfer fills execution and display caches. It does not grant write
authority.

```ts
type TransferRequest = {
  mode: "projection" | "delta" | "closure";
  base?: ScopeHead;
  max_bytes?: number;
  atoms?: string[];
};

type StateTransfer = {
  kind: "woo.state.transfer.v1";
  mode: "projection" | "delta" | "closure";
  scope?: ScopeRef;
  base?: ScopeHead;
  to?: ScopeHead;
  pages?: StatePageRef[];
  inline_pages?: StatePage[];
  transcript_tail?: EffectTranscript[];
  applied?: AppliedFrame[];
  projection?: WooValue;
  proof?: StateProof;
};

type StatePageRef = {
  hash: Hash;
  bytes?: number;
  uri?: string;
};

type StatePage = {
  hash: Hash;
  codec: "canonical-json" | "cbor";
  bytes: string;          // base64url
};

type StateProof = {
  root: Hash;
  scope?: ScopeRef;
  epoch?: Epoch;
  seq?: Seq;
  receipt?: CommitReceipt;
};
```

Transfer modes:

- `projection`: enough for display and command planning, not authoritative
  execution unless marked as a semantic read by a later committed turn;
- `delta`: applied frames or transcript tail since a known head;
- `closure`: executable state bundle for a predicted turn, including cells,
  parent/feature/verb metadata, bytecode hashes, and permission facts.

The shadow transfer implementation uses
`kind: "woo.state.transfer.shadow.v1"`. It still supports `mode: "closure"`
with a full serialized pre-turn world for diagnostic replay, but the default
fresh-call network path now uses `mode: "object_records"`: a bounded set of
serialized object records selected from missing TurnKey atom preimages, plus
session/log/counter envelope data needed to execute the turn in a small shard.
Each object record is named by a content hash in `object_pages`; receivers can
advertise/cache those hashes and omit already-known records from later
transfers. Install verifies inline object records against their advertised page
hash and verifies a shadow MAC proof scoped to an anchor authority and
recipient node. This is not production authorization yet, but it proves that
state transfer can be driven by exact post-selection inventory gaps instead of
copying the whole world.

Shadow latency profiles report bytes for the object-record closure so later
page/cell-bounded work has a concrete performance target. The current profile
also reports a two-turn warmup: after one dubspace control turn installs
lineage pages, a second control turn for the same object can transfer page refs
with no inline object records. A node preseeded with catalog/class object pages
can likewise materialize those records from cache and transfer only live object
records on its first turn.

Receivers MUST verify page hashes and proofs before installing cache. Receivers
MUST apply authorization filtering before exposing transferred values to a
browser, actor, or agent.

## VTN13. Live plane

Live events are low-latency, non-durable messages. They are not replayed through
catch-up and they do not advance a commit-scope sequence.

```ts
type LiveEvent = {
  kind: "woo.live.event.v1";
  id: string;
  source: ObjRef;
  actor?: ActorRef;
  scope?: ScopeRef;
  audience?: {
    actors?: ActorRef[];
    sessions?: SessionRef[];
    scope?: ScopeRef;
  };
  observation: WooObservation;
  coalesce?: string;
};
```

Live events cover:

- direct chat lines and tells that are intentionally not durable;
- dubspace slider/cursor/gesture previews;
- transient presence hints;
- UI-specific ephemeral signals.

Live event delivery is best-effort. Relays MAY drop or coalesce live events
under backpressure. Durable changes MUST use the commit plane instead.

Catalog verbs that are callable through the live plane MUST be declared as
live/direct safe. A live/direct-safe verb:

- may emit live observations;
- may read authorized projection or semantic state;
- may update ephemeral session/browser-local state;
- MUST NOT write durable object cells;
- MUST NOT create, recycle, or move durable objects;
- MUST NOT rely on its live execution for future replay.

## VTN14. Browser node

A browser node is a v2 node running inside a browser, normally as a Web Worker.
It is not just a renderer.

Required browser-node components:

- worker-hosted VM/runtime subset;
- IndexedDB cache for state pages, projections, transcript tails, and pending
  turns;
- WebSocket connection to a session relay;
- subscription client for applied frames and projections;
- live-plane sender/receiver for chat, cursors, and gesture previews;
- commit submitter for tentative local transcripts;
- reconciliation layer for accepted/conflicted turns;
- state-page and receipt verifier.

Initial browser-node authority:

- MAY execute deterministic committed turns locally for the authenticated actor
  when it has an authorized closure;
- MAY submit transcripts to a server-side commit scope;
- MAY emit live events allowed by session policy;
- MAY receive only authorized projections/closures;
- MUST NOT commit without server-side validation;
- MUST NOT advertise broad `ExecCapabilityAd`s;
- MAY advertise a narrow session-local capability to its relay in later
  milestones.

Browser-node board edit flow:

```text
UI -> worker: move_pin(pin, x, y)
worker: build TurnKey and verify local closure
worker: run tentative VM turn and record transcript
worker -> relay/commit scope: CommitSubmit
commit scope -> worker: CommitAccepted or CommitConflict
worker -> UI: confirm, patch-forward, or report conflict
```

Browser-node dubspace preview flow:

```text
UI -> worker: preview_control(target, name, value)
worker -> local audio: apply preview immediately
worker -> relay live plane: LiveEvent(gesture_progress)
relay -> subscribers: best-effort LiveEvent
```

Browser-node dubspace commit flow:

```text
UI -> worker: set_control(target, name, value)
worker: run deterministic turn and record transcript
worker -> commit scope: CommitSubmit
commit scope -> subscribers: AppliedFrame(control_changed)
browser audio engines apply the committed frame
```

## VTN15. Functional parity requirements

The first implementation that claims v2 protocol support MUST pass parity
scenarios for the existing bundled workloads.

### Chat

- actors enter, leave, move, take, drop, and observe room activity;
- direct speech/tells are low-latency live events;
- containment changes and take/drop conflicts are committed in canonical order;
- transparent chat embedded in pinboard/dubspace forwards as specified by the
  catalog.

### Pinboard and kanban

- notes/cards remain first-class objects;
- board layout, z-order, columns, and card order are durable committed state;
- composite verbs such as `add_note` and `add_card` are atomic turns;
- viewers receive applied frames for durable board changes;
- board mini-chat remains live-only unless a durable chat feature is installed;
- large boards can be opened through projection before full closure transfer.

### Dubspace

- high-rate slider/cursor previews use the live plane;
- final control changes, transport, tempo, patterns, and scene operations commit
  through the commit plane;
- browser audio engines apply both live previews and accepted committed frames;
- logical time replaces wall-clock reads for persistent transport state.

## VTN16. Prototype milestones

The prototype SHOULD land in this order:

1. Turn recorder and replay/diff in the current runtime.
2. In-process multi-node simulator with execution, commit, state, and live
   planes.
3. Content-addressed state transfer and fixed Bloom ad profile.
4. Browser-node worker with IndexedDB cache and relay transport.
5. Networked infrastructure nodes, anchors, and disposable executors.
6. Eviction, cold activation, transcript compaction, and chaos tests.

The first milestone is successful when chat, pinboard, and dubspace committed
turns produce complete replayable transcripts, and live-only interactions are
classified as live rather than smuggled durable mutation.

## VTN17. Open decisions before production

Prototype implementation may proceed before these are fully settled, but a
production v2 spec needs decisions on:

- final binary encoding and compression;
- transcript retention and compaction policy;
- exact lease/fence requirements by cell kind;
- Bloom sizing and salt rotation;
- cross-operator signature policy;
- contested-scope promotion/demotion rules;
- browser optimistic-conflict UX;
- catalog update sequencing relative to ordinary turns;
- privacy profile for projection/state transfer to agents.

## VTN18. Scheduled turns (draft/proposed)

> Status: **proposed**. This section describes how catalog code arranges for
> periodic committed turns without a global clock. It extends the `EffectTranscript`
> from VTN7 with `schedules` and `cancellations` arrays, defines a
> `ScopeTimeAdvance` control frame for the commit plane, and specifies the
> logical-time advancement rule precisely. Not yet implemented.

### VTN18.1 Motivation

Most Woo verbs are reactive — they run when a user or agent calls them. Some
catalog behavior is inherently time-driven: a dubspace transport advancing its
playhead, a game loop advancing physics, a timer firing after a delay. In
Croquet this is expressed as `this.future(16).step()`, which the reflector
delivers to all peers at the correct logical time. Woo v2 has no global
reflector, but the commit scope for a space already owns a sequenced log and a
logical time. A scope-local equivalent of `future()` can be built from that
without a global dependency.

A scheduled turn is a committed turn that will happen later. It is recorded in
the scheduling transcript as a first-class output (parallel to `creates` and
`observations`), stored in the scope's durable pending queue, and fired by the
scope's infrastructure when the scope's logical time reaches the target.

### VTN18.2 ScheduledTurnRequest and transcript extension

`ScheduledTurnRequest` carries a full authority context so the commit scope can
validate the scheduled turn exactly as it would validate a live-submitted one.

```ts
type ScheduledTurnRequest = {
  kind:            "woo.scheduled_turn_request.v1";
  id:              string;       // caller-chosen stable key; see VTN18.3
  scope:           ScopeRef;     // MUST match the current commit scope
  epoch:           Epoch;        // MUST match scope epoch; stale entries cancelled
  at_logical_time: number;       // absolute delivery target; > turn's logical_time
  call: {
    actor:        ActorRef;      // actor on whose behalf the turn fires
    target:       ObjRef;
    verb:         string;
    args:         WooValue[];
    caller_perms: ObjRef;        // progr at schedule time; bounds permission checks
    route:        "committed";
  };
  authority:
    | { kind: "scheduling_actor" }
    // actor and caller_perms above are sufficient; commit scope validates
    // permissions against live actor state at delivery time.
    | { kind: "service_actor"; actor: ActorRef }
    // Fire as a declared service actor regardless of who scheduled it.
    // Requires the scheduling turn's actor to hold the delegation capability.
};
```

`ScheduledTurnRequest` entries appear in the `schedules` array of
`EffectTranscript` (VTN7 fields added here):

```ts
// Extension to EffectTranscript (VTN7):
schedules?:     ScheduledTurnRequest[];
cancellations?: string[];   // schedule ids to remove from pending queue
```

`schedules` and `cancellations` are **not** `TranscriptWrite` entries. They
MUST NOT be represented with a fabricated `op` value. They are parallel to
`creates` and `recycles`: named, typed arrays with their own validation path.
Both arrays are included in the `post_state_hash` preimage because the pending
queue is durable scope state.

Commit scope validation for `schedules`:

- `scope` MUST match the current commit scope; reject otherwise.
- `epoch` MUST match the current scope epoch.
- `at_logical_time` MUST be strictly greater than the scheduling turn's
  assigned `logical_time`.
- `id` is an **upsert key**: if a pending entry with the same `id` already
  exists it is replaced atomically; otherwise the new entry is inserted. This
  allows `start_ticking` to re-arm an existing chain without explicit
  cancellation (see VTN18.7).
- For `authority.kind = "service_actor"`: the scheduling actor MUST hold the
  delegation capability for the named service actor.

Commit scope validation for `cancellations`:

- Each `id` removes the matching pending entry if one exists; cancelling a
  non-existent id is a no-op.
- `cancellations` and `schedules` are applied atomically. An `id` that appears
  in both arrays in the same transcript is rejected.

### VTN18.3 DSL builtin: `schedule` and `cancel_schedule`

```
schedule(target, verb, args, delay_ms)           // turn-unique id
schedule(target, verb, args, delay_ms, id: key)  // stable caller-supplied id

cancel_schedule(id)                              // appends id to cancellations[]
```

The two forms of `schedule()` differ only in id derivation:

- **Turn-unique**: `id = deterministic_hash(turn_id, per_turn_counter)`. Each
  call within one turn gets a distinct id; stable across replays. Use for
  one-shot deferred calls.
- **Stable-key**: `id = key` as supplied. The commit scope upserts: an existing
  pending entry with this id is replaced. Use for periodic self-rescheduling
  chains (see VTN18.7).

`at_logical_time` is computed before recording:

```
at_logical_time = current_logical_time + delay_ms
```

No floor adjustment is performed by the builtin. The minimum-interval floor is
enforced by the commit scope at delivery time (see VTN18.5). The transcript
records exactly what the verb requested; the scope decides when it is safe to
deliver.

`schedule()` is same-scope only. It MUST NOT target a different scope. Cross-scope
scheduling requires a separate committed turn submitted through normal channels.

### VTN18.4 Logical-time advancement and due-turn delivery

The commit scope maintains two durable state fields:

```
scope.logical_time:  number
scope.pending_queue: ScheduledTurnRequest[]   // sorted by (at_logical_time, id)
```

Both contribute to `post_state_hash`.

**Assignment rule for all committed turns:**

```
scope.logical_time ← max(scope.logical_time + 1, inputs.logical_time)
```

The commit scope assigns `inputs.logical_time` for each turn it accepts. For
interactive turns the scope assigns `scope.logical_time + 1`. The monotonic
increment ensures that no two accepted turns share a `logical_time`.

**Due-turn delivery order:**

After advancing `scope.logical_time`, the commit scope fires all pending entries
with `at_logical_time <= scope.logical_time`, in order `(at_logical_time ASC,
id ASC)`. Each fired turn advances `scope.logical_time` by at least 1 before the
next one fires. Turns sharing an `at_logical_time` are therefore delivered in `id`
order with consecutive sequence numbers.

**Heartbeat via ScopeTimeAdvance:**

When the pending queue is non-empty and no interactive turns arrive, the scope's
infrastructure node sends a `ScopeTimeAdvance` control frame to trigger delivery:

```ts
type ScopeTimeAdvance = {
  kind:       "woo.scope.time_advance.v1";
  scope:      ScopeRef;
  epoch:      Epoch;
  expected:   ScopeHead;   // MUST match current scope head; prevents races
  advance_to: number;      // MUST be > scope.logical_time
};

type ScopeTimeAdvanced = {
  kind:     "woo.scope.time_advanced.v1";
  scope:    ScopeRef;
  position: CommitPosition;  // scope head after advancing and firing due turns
  fired:    TurnId[];        // ids of scheduled turns submitted as a result
};
```

`ScopeTimeAdvance` is a **commit-scope control frame**, not a `TurnCall`. It
has no `target`, no `verb`, no VM execution, and produces no `EffectTranscript`.
Processing: validate epoch and expected head; advance `scope.logical_time` to
`advance_to`; fire all due entries in order; return `ScopeTimeAdvanced`.

The heartbeat stops when the pending queue empties. For Cloudflare DO commit
scopes, the DO Durable Alarm replaces an external heartbeat driver: the DO sets
its alarm to the earliest `at_logical_time` in the queue and wakes itself to send
`ScopeTimeAdvance` when the alarm fires.

### VTN18.5 Minimum delivery interval

The commit scope enforces a minimum interval between consecutive deliveries of
the same `(target, verb)` pair. Default floor: 16 ms. The floor may be raised
per scope configuration; it may not be lowered below 1 ms.

The floor is applied at delivery time, not at recording time. The commit scope
tracks `last_delivered_at[(target, verb)]`. When a due entry would fire within
`last_delivered_at + min_tick_ms`, it is deferred to `last_delivered_at + min_tick_ms`
in the pending queue. The recorded `at_logical_time` in the transcript is not
changed; the `inputs.logical_time` assigned by the scope at actual delivery may
be later. Catalog code receives the floor rate when it requests faster ticks;
no error is returned.

### VTN18.6 Epoch migration

When the scope epoch is fenced:

- All pending entries with a stale `epoch` are cancelled.
- Any in-flight `ScopeTimeAdvance` carrying a stale epoch is rejected.
- Catalog code that needs periodic execution after epoch migration must
  re-register. The `$tick_source` pattern handles this through the
  `scope_resumed` observation described in VTN18.7.

### VTN18.7 Catalog pattern: `$tick_source`

Informative, not normative. `$tick_source` uses the stable-key form of
`schedule()` so that `start_ticking` is idempotent: calling it while a chain
is already running replaces the existing pending entry rather than creating a
duplicate.

```
feature $tick_source {
  prop tick_ms   default 100;
  prop ticking   default false;

  // Stable key derived from object identity, not turn id.
  prop _tick_key = hash("tick_source:" + this.id + ":_tick");

  verb :start_ticking(rate_ms) rxd {
    this.tick_ms = rate_ms;
    this.ticking = true;
    schedule(this, "_tick", [], rate_ms, id: this._tick_key);
  }

  verb :stop_ticking() rxd {
    this.ticking = false;
    cancel_schedule(this._tick_key);
  }

  // Delivered by commit scope infrastructure; do not call directly.
  verb :_tick() rxd {
    if !this.ticking { return; }
    call(this, "tick");
    schedule(this, "_tick", [], this.tick_ms, id: this._tick_key);
  }

  // Re-arm after epoch migration. Subscribe to scope_resumed observation
  // (type TBD in catalog model) and call this handler.
  verb :_on_scope_resumed() rxd {
    if this.ticking {
      schedule(this, "_tick", [], this.tick_ms, id: this._tick_key);
    }
  }
}
```

### VTN18.8 Authority at delivery time

The commit scope constructs a `TurnCall` from the `ScheduledTurnRequest.call`
fields at delivery and validates it as it would any actor-submitted turn:

```ts
{
  id:     scheduled_entry.id + "@" + String(scope.logical_time),
  actor:  scheduled_entry.call.actor,   // or service_actor for service authority
  target: scheduled_entry.call.target,
  verb:   scheduled_entry.call.verb,
  args:   scheduled_entry.call.args,
  caller: "$system",   // indicates infrastructure delivery
  route:  "committed"
}
```

Permission checks run against live world state at delivery time, not at
schedule time. If the actor no longer holds the required permission the turn
produces an error frame and the pending entry is removed. Failed scheduled turns
are not retried automatically; catalog code must re-register if it wants retry
behavior.

### VTN18.9 Queue storage

The pending schedule queue is **durable commit-scope state**:

- Stored alongside the sequenced log head in the scope's durable storage.
- Its serialized content is included in the `post_state_hash` preimage.
- On cold activation the queue is loaded from durable storage. Entries overdue
  at activation time fire on the next `ScopeTimeAdvance` or interactive turn.
- For Cloudflare DO commit scopes: serialized into DO storage alongside the log
  head; the DO Durable Alarm drives delivery, replacing any external heartbeat.

### VTN18.10 Live vs. committed ticks

| Behavior | Plane | Rationale |
|---|---|---|
| Dubspace slider/cursor previews | Live | High-rate, lossy-ok, display only |
| Pattern step advance, loop boundary | Committed | Must be ordered, reproducible |
| Transport `playing_since` / position write | Committed | Durable mutation, must replay |
| Visual animation interpolation in browser | Browser-local | Ephemeral display state |
| Presence heartbeat | Live | Best-effort |

A committed tick is a full transcript with a state hash and receipt. At 60 Hz
that is ~60 committed turns per second, appropriate only when state changes at
that rate and those changes must survive replay.

### VTN18.11 Open questions

- **Maximum queue depth.** A cap on pending entries per scope prevents
  queue-hoarding; 1000 entries per scope is a plausible default.
- **Scheduled turns and TurnKey routing.** Scheduled turns are submitted by the
  commit scope infrastructure, bypassing capability-ad routing. The scope node
  is always the executor; actor-node optimistic execution of scheduled turns is
  deferred.
- **`scope_resumed` observation.** The system observation type that `$tick_source`
  subscribes to for epoch-migration recovery is not yet defined in the catalog
  model.
