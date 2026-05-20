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

Production v2 protocol names use the `woo.*.v1` message namespace defined in
this document. Earlier implementation-only names from the simulator and
transport bring-up are not protocol names. New protocol text, tests, and
client/server APIs MUST NOT add new interim-named message kinds, proof schemes,
diagnostics, metrics, or process steps; implementation adapters may translate
old local names at module boundaries while the code is being renamed.

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

The initial head for an epoch MAY include a full-state digest, but an accepted
commit position is a chain position, not a request to rehash the whole serialized
world. Its `hash` MUST change with the prior head, `seq`, accepted transcript,
and accepted `post_state_hash`; implementations SHOULD derive it from those
commit-position inputs so ordinary turns remain proportional to the touched
state, not to total world size.

`ScopeRef` is a v2 protocol identifier. An implementation may store the scope
as the existing `ObjRef` directly while local storage is being migrated, with
`scope:<objRef>` as the canonical wire spelling. This is a storage shortcut, not
a different authority model.

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
  token?: string;          // present only for mode:"session"
};
```

`sent_at` and `expires_at` are routing metadata. They are not deterministic VM
inputs. A turn that needs time receives it through `LogicalInputs`.

### VTN4.1 Wire encoding

The first browser-relay transport profile uses **JSON-per-WebSocket-message**;
see VTN19 for the M4 WebSocket binding that carries this profile:

- every WebSocket data frame contains exactly one UTF-8 JSON object;
- the JSON object MUST be an `Envelope<T>`;
- `v` MUST be exactly `2`;
- `type` MUST be a registered v2 message type;
- `body.kind`, when present, MUST match the envelope `type`;
- binary page content MUST be base64url-encoded inside JSON fields until a
  later binary profile is specified.

Receivers MUST reject a frame before dispatch when JSON parse fails, the parsed
value is not an object, `v !== 2`, required envelope fields are missing, or
`type` is unknown for the negotiated transport profile. Unknown envelope fields
MAY be ignored only after `v` and `type` are accepted; unknown message types
MUST NOT be treated as advisory no-ops.

The M4 browser-relay profile caps a single WebSocket message at 1 MiB after
UTF-8 decoding. A receiver that sees a larger message MUST close the socket
with WebSocket close code `1009` ("message too big"). Senders MUST chunk large
state pages through `StatePageRef`/`StatePage` transfer rather than exceeding
this cap. A relay MAY enforce a smaller deployment-local cap during overload,
but MUST report it in the open handshake.

### VTN4.2 Session authentication

M4 browser-relay envelopes use `auth.mode:"session"`. The
`same_deployment_mac` and `signature` modes remain reserved for M5 node-node
and cross-deployment work; M4 implementations MUST NOT accept them on the
browser-relay WebSocket.

Session tokens are minted by the existing v1-authenticated HTTP gateway before
the v2 WebSocket opens. The reserved mint path is:

```text
POST /v2/session/mint
```

The full HTTP request/response contract is specified by the gateway profile,
but the gateway MUST issue a token whose claims are the canonical projection of
the v1-authenticated session state at mint time. The resulting token MUST be a
bearer credential scoped to:

- `session`: session id;
- `actor`: actor object id;
- `deployment`: deployment id or local development profile id;
- `issued_at`: Unix milliseconds;
- `expires_at`: Unix milliseconds;
- `scopes`: commit scopes or spaces the session may initially subscribe to;
- `features`: negotiated prototype feature flags;
- `rev`: session revocation/version counter.

On the wire, the browser sends the token in the opening handshake and repeats
it in `auth.token` on every envelope. `auth.claims` is the relay-validated,
canonical subset of the token claims: `session`, `actor`, `deployment`,
`issued_at`, `expires_at`, `scopes`, `features`, and `rev`. Browsers MUST NOT
invent or modify `auth.claims`; relays either fill it before internal dispatch
or reject the envelope.

Relays MUST reject a session token whose `deployment` claim does not match the
relay's own deployment id. Relays MUST also reject a token whose `rev` does not
match the current revocation/version counter in the relay or gateway session
store.

Session tokens MUST expire no later than 15 minutes after minting. A relay MAY
issue a refreshed token on an authenticated control message before expiry.
Revocation is checked by `(session, rev)` against the relay/gateway session
store on connect and at least once every 60 seconds while the socket is open.
If the token expires or is revoked, the relay MUST reject authority-bearing
messages and close the socket with an auth failure close reason.

Authority-bearing browser-relay messages MUST use `session` authentication.
Advisory gossip MAY use `anonymous_advisory` only on trusted local links where
spoofing is not load-bearing; browser-originated live messages are not
anonymous advisory messages.

The tuple `(from, id)` is the envelope idempotency key unless a body-level
`turn.id` or `submit.id` narrows the key further. Receivers MUST make retry of
the same authority-bearing message idempotent for the configured retention
window. In the M4 browser-relay profile, the relay advertises that window in
`TransportHello.idempotency_window_ms`; it MUST be at least 300000 ms.

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

Implementations derive versions for `location`, `contents`, `lifecycle`, and
`owner` reads from deterministic cell-content hashes. These versions MUST NOT
depend on wall-clock object metadata such as `modified`, because replaying the
same turn against the same pre-state must produce the same transcript and
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
| `directCall` that may mutate durable cells | `"committed"` | Transitional code may still call this path `direct`; protocol turns use `"committed"`. |
| `$space:call` / `$sequenced_log` applied call | `"committed"` | The existing space sequence is the prototype commit order. |
| Explicit preview/chat/presence-only path | `"live"` | Must not write durable object cells or create durable applied frames. |

Existing `$space` and `$sequenced_log` objects are valid prototype commit
scopes. A v1 sequenced space maps to the v2 `ScopeRef` for that space object.
Not every future commit scope must be a `$space`, but the prototype uses spaces
as the bridge because they already provide ordered applied frames.

The production `LogicalInputs` shape groups inputs by validation role. Existing
recorders may internally emit an ordered flat list of named inputs
(`Array<{name,value}>`) as a replay mechanism. The protocol mapping is:

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
  writer: RecordedWriteAuthority;
};

type TranscriptCreate = {
  object: ObjRef;
  parent: ObjRef;
  owner: ObjRef;
  initial_cells: TranscriptWrite[];
  writer: RecordedWriteAuthority;
};

type TranscriptMove = {
  object: ObjRef;
  from: ObjRef | null;
  to: ObjRef;
  writer: RecordedWriteAuthority;
};

type TranscriptRecycle = {
  object: ObjRef;
  final_version?: string;
};

type RecordedWriteAuthority = {
  progr: ObjRef;
  this_obj: ObjRef;
  verb: string;
  definer: ObjRef;
  caller: ObjRef;
  caller_perms: ObjRef;
};
```

`move` is used for location-cell replacement when containment movement is the
semantic operation. `add` and `remove` are used for contents-cell membership
updates. `create` is allowed only for lifecycle cells and SHOULD also be
represented in `creates` when the created object identity is visible.

Every mutation record MUST name the VM frame whose effective programmer
authority performed it. The commit scope validates that frame against recorded
dispatch/verb metadata reads, then checks property, movement, creation, and
lease authority for that single frame. It MUST NOT authorize a write by taking
the union of all verb owners mentioned anywhere in the transcript.

`complete: false` means the recorder observed an untracked native effect or an
execution boundary that cannot be validated. A commit scope MUST NOT accept an
incomplete transcript as a durable turn. It MAY store incomplete transcripts as
diagnostics. `incomplete_reasons` is a diagnostic annotation and is only
meaningful when `complete` is false.

V2 does not accept partial cross-host bridge transcripts. When execution hits a
runtime host bridge such as dispatch, remote property access, movement, or
remote contents lookup, the recorder marks the caller transcript incomplete and
attaches a `woo.remote_bridge_transcript_policy.v1` diagnostic policy value
saying that sub-transcripts are deferred and the commit result is `reject`. This
is intentional: the protocol either executes a whole turn on one capable node,
or refuses to commit the partial local transcript. A later execution-plane
milestone may replace this diagnostic boundary with a signed callee transcript
that can be merged and validated by the caller's commit scope.

Production commits MUST submit `kind: "woo.effect_transcript.v1"`. A transcript
is not commit-eligible unless it includes `base`, `vm`, logical inputs,
pre/post state hashes, complete read/write facts, and all diagnostics required
to prove no untracked native or bridge effect occurred. Implementation-local
recorder objects that omit these fields MUST be normalized to this shape before
commit submission.

Dispatch reads SHOULD contribute to `vm.verb_hashes`. The recorder MUST record
the resolved definer, owner, version, `source_hash`, direct-callability, native
handler name when the verb is native, and the handler's native primitive
contract when one exists. It records both top-level dispatches and local
bytecode-to-bytecode calls so write-frame validation can prove which verb frame
performed each mutation. Production transcripts fold that data into both the
read set and the `vm` block.

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

The in-process v2 commit scope accepts `woo.commit.submit.v1` messages from the
execution helper, owns the authoritative serialized state and `ScopeHead`,
validates expected head, scope, completeness, session/actor shape, read
versions, per-write VM-frame authority, lifecycle/move post-state, and
touched-cell post-state hashes, then returns `woo.commit.accepted.v1` or
`woo.commit.conflict.v1`. The submit message does not carry executor
post-state. The commit scope constructs authoritative post-state from
transcript creates, writes, moves, and sequenced-log outcome. Accepted frames
carry commit position, transcript hash, receipt, and observations; current
projection state is derived from the commit scope's authoritative serialized
state or from explicit state transfers, never from a per-frame full-world
snapshot. Accepted frames also carry the authority's acceptance timestamp so
transport-specific frame projections can be reply-idempotent without minting a
fresh wall-clock value on retry.

The current transcript applier materializes object creation, property writes,
location writes, contents writes, session-location side effects, and sequenced
log entries. Lifecycle deletes and verb edits remain recorded/validated
transcript cells but are not yet materialized by the shared applier; callers
that need those effects must still treat the commit scope's serialized state as
authoritative until the applier grows those cell kinds.

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
  state_transfer?: StateTransfer; // projection fallback when delta tail is gone
};

type TransportError = {
  kind: "woo.transport.error.v1";
  code: string;
  message: string;
  envelope_id?: string;
};
```

`AppliedFrame` is the durable successor of the v1 `op:"applied"` frame. It is
the canonical subscription frame for committed observations and materialized
state changes. Clients MUST treat missing positions as gaps and use catch-up.
`Subscribe.wants` uses `"both"` because a subscription can stream applied
frames and projection updates together. `CatchupRequest.wants` uses
`"transcript"` instead because catch-up may explicitly ask for audit/replay
material rather than display projection.

Browser-local optimistic turn results MAY be reduced into temporary projection
layers before the corresponding `AppliedFrame` arrives. These layers are keyed
by the pending call id, are not durable protocol state, and MUST be removed
when the call fails, expires, or is superseded by catch-up. When the accepted
applied frame arrives, the client reduces the frame through the same catalog
observation rules and drops the optimistic layer so canonical or sequenced
projection owns the display. A catalog UI that uses optimistic projection MUST
keep its optimistic projection reducer aligned with the reducer used for
accepted frames.

After a browser reconnects, it MUST NOT assume the relay buffered frames while
the socket was absent. For every subscribed scope, the browser sends
`CatchupRequest { from: last_known_scope_head, wants: "applied" }` or
`wants:"projection"` when it only needs display state. If the relay still has a
contiguous applied-frame tail after `from`, it returns frames and the new
`to` head. If the relay no longer has the tail, or `from.epoch` is stale, the
relay replies with `frames: []`, `has_more: false`, and `state_transfer` in
projection mode. The browser then replaces its display projection for that
scope and treats the returned `to` head as the new catch-up base.

Relays MAY buffer accepted frames for connected sockets to smooth short
network stalls, but browser correctness MUST come from catch-up plus state
transfer. A reconnecting browser therefore follows this order:

1. reopen the WebSocket and authenticate the session;
2. resubscribe to desired scopes with its last known `ScopeHead`s;
3. request deltas from those heads;
4. fall back to projection state transfer when a delta tail is unavailable;
5. discard optimistic browser-local state that cannot be reconciled to the new
   head.

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
  persistence?: "durable" | "live";
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

The default `persistence` is `durable`. A successful default reply
MUST include an accepted commit receipt. `live` is for turns whose
transcript is useful to the caller but must not advance committed state: local
simulation, diagnostic deployments, and live-only interactions such as ephemeral
speech/tells. Clients MUST NOT treat a `live` result as authoritative
state, and any observations it emits remain live-only.

Turn-exec replies and accepted frames MUST NOT carry a full serialized
post-state. Current committed state is owned by the commit scope, and browser
state reaches clients through state-plane projection/delta transfers. Wire
replies carry commit position, transcript hash, receipt, and observations.

`atoms` are the state/code/metadata closure that a candidate must probably
cover before execution. `write_atoms` identify write-authority-sensitive cells
so routing can avoid projection-only nodes before commit. `accept_atoms` are
the compact turn-shape atoms, typically scope/target/call, checked against an
ad's `accepts` filter.

An executor SHOULD refuse before running the VM if required atoms are obviously
missing. If missing state is discovered during execution, the executor MUST
abort without commit and return `missing_state`. Partial transcripts from such
runs are diagnostics only.

The v2 execution implementation covers this for fresh `TurnCall` execution in
two places: a predicted TurnKey is compared with a local atom cache before
running, and the turn recorder enforces an `E_NEED_STATE` guard when dispatch,
property, or structural cell events touch an atom outside the materialized set.
Recorded-turn replay helpers remain diagnostic preflight harnesses only.

The production execution helper receives a `TurnCall`, executes it fresh on the
selected node, returns a `TurnExecReply`, and can submit the fresh transcript to
the in-process commit scope for accept/conflict handling. Replay of a previously
recorded turn is useful for debugging, but it is not the browser-edge optimistic
path.

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

During the browser migration, a relay MAY also accept, behind an explicit
compatibility flag,
`woo.turn.intent.request.v1` from a browser node. The intent contains `id`,
`route`, `scope`, `target`, `verb`, `args`, optional `persistence`, and optional
`selected_ad`, but not a `TurnKey`. It is a transitional server-assisted
planning message: the CommitScopeDO plans the deterministic transcript against
its authoritative scope state, derives the `TurnKey`, preserves `selected_ad`
onto the derived `TurnExecRequest`, and then processes the turn through the same
`TurnExecRequest`/`TurnExecReply` path. Browsers MUST treat this as
server-assisted planning, not as proof that local closure execution is complete.
Production v2 uses browser-built keys and browser-submitted `TurnExecRequest`
messages once the worker can reconstruct executable state from verified pages.
Normal durable browser surfaces MUST NOT use selected-ad intents; when the
browser is cold it first installs the open executable seed, plans locally, and
then repairs exact missing atoms or delegates a complete `TurnExecRequest`.

A scope open SHOULD emit at least one standalone `ExecCapabilityAd` envelope for
the opened scope when the relay has an executor route it is willing to serve.
Such a scope-level cold-start ad MAY have empty `covers` and `accepts` filters.
The browser can use it only after it has derived an exact `TurnKey`; the empty
filters advertise executor reachability for the opened scope, not proof of atom
coverage. Reply-bundled ads MAY continue to carry exact coverage for later
local-planned turns.

Every internal open/envelope forwarded to a CommitScopeDO SHOULD carry an
authority slice:

```ts
type AuthorityObjectSlice = {
  kind: "woo.authority_slice.v1"; // legacy compatibility
  sessions: SerializedSession[];
  objects: SerializedObject[];
};

type AuthorityCellSlice = {
  kind: "woo.authority_slice.cells.v1";
  sessions: SerializedSession[];
  page_refs: AuthorityStatePageRef[];
  inline_pages: AuthorityStatePage[];
  counters: Pick<SerializedWorld, "objectCounter" | "parkedTaskCounter" | "sessionCounter">;
  tombstones: ObjRef[];
  source_object_count: number;
};
```

The slice is not a full-world snapshot. It is the gateway/owner-provided
working set that is authoritative for planning this message: live session
rows, the session actors, the sessions' active rooms, and any explicit
turn-scope/target rows the gateway knows are relevant, plus owner, class,
feature, property-reference, and catalog/helper support cells needed to execute
that working set. A CommitScopeDO MUST refresh these cells before planning an
intent. When an authority slice is present, its `sessions[*].activeScope`
replaces any older per-scope value in the CommitScopeDO snapshot; otherwise a
cross-scope move accepted in one scope can leave another scope planning against
stale presence. `session_objects` is a compatibility request field for older
callers that do not send `authority`; authority-bearing requests MUST leave it
empty, including when the authority itself is a legacy object-row slice.

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
  projection_patch?: ProjectionPatch;
  proof?: StateProof;
};

type ProjectionPatch = {
  kind: "woo.scope_projection_patch.v1";
  scope: ScopeRef;
  base: ScopeHead;
  to: ScopeHead;
  fields: Record<string, WooValue>;
  objects: ProjectionListPatch;
  inventory?: ProjectionListPatch;
};

type ProjectionListPatch = {
  order: ObjRef[];
  upsert: WooValue[];
  remove: ObjRef[];
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

State transfers use `kind: "woo.state.transfer.v1"`. The default fresh-call
network path uses `mode: "closure"` with content-addressed cell pages, selected
from missing TurnKey atom preimages:

- `object_lineage`: object identity, parent, owner, flags, anchor, and schemas;
- `object_live`: location, children, and contents cells;
- `property_cell`: one property definition/value/version cell;
- `verb_bytecode`: one verb implementation cell.

The transfer also carries the session/log/counter envelope data needed to
execute the turn in a small shard. Page refs can be advertised from cache; only
unknown pages are inlined. Install verifies inline pages against their
advertised page hashes and verifies a state-transfer proof scoped to an anchor
authority and recipient node. State transfer is driven by exact post-selection
inventory gaps instead of copying the whole world or whole object records.

Browser relays also implement `mode: "projection"` and `mode: "delta"` for
display/cache catch-up. Opening a scope installs a projection transfer instead
of directly mutating the browser projection cache. After an accepted commit,
browser delivery is routed by the gateway's live session/socket table, not by
volatile subscriber maps inside a commit-scope relay. The gateway computes the
transcript's affected scopes from the commit scope, move endpoints, create
locations, contents writes, and subscriber writes; then it delivers only
observations whose per-observation audience contains the recipient session or
actor. A recipient attached to the commit scope also receives a recipient-bound
projection transfer for that scope, built and signed by the commit-scope/state
authority. Recipients attached to other affected scopes receive live
observations only; a state transfer for those scopes MUST be served by that
scope's own state authority, never by the origin commit scope, because the
transfer head and projection scope have to name the same scope. A non-empty
delta transfer carries the accepted frame, a transcript tail, and exactly one
display-state update: either a full refreshed projection or a projection patch
against the receiver's previous projection head. Relays SHOULD send a
projection patch for hot subscribed fan-out when they know the receiver's cached
base projection, and MUST fall back to a full projection when the base is
unknown, the patch would be larger than replacement, or the receiver reports a
missing/mismatched base. A relay MAY send an empty signed delta with no
projection, no projection patch, no applied frames, and no transcript tail only
when the receiver's `last_known_head` exactly matches the current scope head;
this is a freshness marker for an already-cached projection, not replacement
display state. The first patch shape updates scalar projection fields plus
ordered object-summary lists. Patch base comparison MUST match scope, epoch, and
sequence; when both sides have a non-empty head hash, it MUST match too.

The projection body is `kind: "woo.scope_projection.v1"`. It is catalog-neutral
display/cache state, not executable authority. It MUST name the `scope`, current
`seq`, a `cursor.spaces[scope].next_seq`, the visible `subject` summary when
available, and an `objects` array containing only the generic neighborhood the
browser can display or use for command planning: subject, subject contents,
viewer actor, viewer inventory, and viewer current location contents. When
viewer context is available, it also carries generic `self`, `session`, and
`inventory` fields shaped like the scoped HTTP projection. Object summaries use
the same generic fields as the scoped HTTP projection (`id`, `name`, `parent`,
`ancestors`, `owner`, `location`, and readable `props`) and MUST NOT depend on
bundled catalog object identities. Catalog-specific UI state is derived by
catalog UI code from readable props and observation schemas; the browser worker
stores the projection opaquely.

Browser projection/delta transfers use proof scheme `woo.state.relay_mac.v1`.
The proof root is a canonical hash over mode, scope, recipient, target head,
projection or projection patch, accepted-frame ids/positions/transcript
hashes/post-state hashes, and transcript-tail hashes. The proof also carries
authority, key id, recipient, and a MAC signature over the root. Receivers MUST
verify the recipient binding, trusted relay authority, MAC signature,
transcript body-to-hash equality, and projection-patch base before installing
projection/delta cache. A receiver that cannot apply a projection patch MUST
request or await a full projection transfer instead of guessing. Execution
closures use proof scheme `woo.state.anchor_mac.v1`; projection proofs never
authorize VM execution.

Latency profiles SHOULD report bytes for cell-page closure transfer and
projection/delta transfer so page/cell-bounded work has concrete performance
targets. A warm profile SHOULD include a two-turn case: after one dubspace
control turn installs lineage pages, a second control turn for the same object
can transfer page refs with no inline records. A node preseeded with
catalog/class pages can likewise materialize those records from cache and inline
only live instance pages on its first turn.

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

On the wire, `LiveEvent` is carried in an `Envelope<LiveEvent>` with
`type:"woo.live.event.v1"`, `v:2`, and `auth.mode:"session"` for
browser-originated events. Live events are not commit authority, but they are
still session-authenticated because they can affect other users' displays,
audio engines, or presence views.

When a relay converts live/direct turn transcript observations into live
events, it MUST preserve the observation's private or directed audience in
`LiveEvent.audience`. Actor/session-private transcript hints such as
`_audience_override` are internal routing data: they MUST be translated into
the live event audience and MUST NOT be emitted inside `LiveEvent.observation`.
An event with an explicit `actors` or `sessions` audience is not also delivered
to its `scope` unless `audience.scope` is explicitly present.

`coalesce` is a sender-chosen ASCII key with grammar:

```text
coalesce-key = scope "/" source "/" channel [ "/" field ]
```

Each segment is a URL-safe token (`[A-Za-z0-9._~-]+`) after object ids or field
names are escaped. The key is scoped to `(session or actor, scope)` by the
relay. Relays MAY keep only the newest live event for the same coalesce key
under backpressure.

Live event decoders MUST reject payloads that attempt to carry durable writes.
The **durability-reserved envelope fields** are `writes`, `creates`, `moves`,
`transcript`, `commit`, `receipt`, `state_transfer`, `applied`, `schedule`, and
`cancellations`. In the M4 JSON profile, a live event body MUST NOT contain any
durability-reserved envelope field. Future durable payload shapes MUST either
extend this named set or explain why the field is safe on the live plane. Live
observations also MUST NOT use catalog observation types reserved for committed
durable changes unless the catalog marks that observation schema
`live: true`, as defined in catalogs CT5.5. A rejected live event is dropped
and MAY be reported to the sender as a protocol error; it MUST NOT be converted
into a commit request.

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

### VTN14.1 Browser cache ownership

Browser IndexedDB is an execution cache and pending-turn journal. It is not
durable world authority. A browser cache contains several layers with different
rights:

| Store | Contents | May drive VM reads? | May overwrite UI projection? | Authority |
|---|---|---:|---:|---|
| `meta` | node id, session, current scope, scope heads, cache epoch | No | No | relay/session claims |
| `pending` | outbound envelopes retained for idempotent reconnect/retry | No | No | browser-local |
| `projections` | `woo.scope_projection.v1` rows and patches | No | Yes, for the named scope/head | state authority proof |
| `applied_frames` | accepted commit frames by `(scope, seq)` | No | Yes, via reducer | commit receipt |
| `transcript_tail` | recent accepted transcripts | Only after page verification | Indirectly | commit receipt |
| `tentative_turns` | pending local committed transcripts with base head, actor/session, and transcript hash | Yes, as an overlay for later local plans | Only through optimistic layer | browser-local until accepted |
| `execution_checkpoints` | per-scope materialized executable snapshots through an accepted seq | Yes, as a replay base | No | derived from state proofs and commit receipts |
| `object_pages` | verified object-record pages | Yes | No | state proof |
| `state_pages` | verified cell/bytecode/metadata pages | Yes | No | state proof |

Projection rows are deliberately excluded from VM execution. They may be stale,
redacted, or display-shaped. A browser-local turn may read only verified
executable pages and session/scope metadata whose proof chain is valid for the
authenticated actor. UI code may render projection rows immediately, but those
rows do not satisfy `TurnKey` atoms.

Accepted frame delivery is keyed by `(scope, seq)`. A browser may receive the
same accepted frame from the direct reply and from catch-up/state transfers, but
the UI reducer must see it once. Duplicate receipts may refresh cache metadata
or transcript tails, but they must not trigger another page-level
`applied_frame` delivery.

Each executable page installed into IndexedDB MUST record:

- page hash and codec;
- page kind (`object_lineage`, `object_live`, `property_cell`,
  `verb_bytecode`, or future registered page kind);
- object id and optional property/verb name;
- source scope/head or owner host identity;
- proof root, authority, key id, recipient, and verification status;
- insertion time and last-used time for eviction.

Executable page transfers may contain hundreds of verified state pages. Browser
workers should install the pages from one transfer in a single store transaction
where the local storage API permits it, and report the batch size in
diagnostics, rather than emitting one transaction and one metric per page.

A browser MUST discard executable pages whose proof recipient does not match
the browser node, whose session/actor authorization no longer matches
`TransportHello.actor`, or whose epoch is known stale.

### VTN14.2 Reconstructing an execution node

Before optimistic execution, the worker builds an in-memory execution node from
IndexedDB:

```text
load current scope head and session claims
load verified executable pages referenced by local page index
materialize the minimal SerializedWorld needed by the VM
install atom hashes/page hashes into the execution node
run command planning if the UI supplied text rather than a direct target/verb
```

The materialized world is disposable. It is rebuilt from verified pages after a
cache miss, reconnect, conflict, or actor/session change. The worker MUST NOT
persist VM-mutated post-state as authoritative executable pages until the turn
is accepted or a verified state transfer supplies the matching pages. Tentative
post-state lives only in the pending-turn/optimistic layer.

Accepted transcripts may be replayed over the executable seed, but this replay
tail MUST be bounded. A browser worker SHOULD periodically materialize a
per-scope execution checkpoint through an accepted sequence number, then prune
older transcript-tail rows covered by that checkpoint. A later local execution
view starts from the checkpoint, installs only executable transfers received
after the checkpoint's transfer high-watermark, and replays only accepted
transcripts newer than the checkpoint plus current tentative turns. A full
projection/open fallback is a new authoritative snapshot boundary and MUST
discard the prior checkpoint and committed transcript tail for that scope.
Implementations SHOULD expose compose-view timing and replay counts so local
execution cost regressions are visible before they become user-visible.

The current browser worker checkpoints a scope after a bounded batch of accepted
transcripts, stores the checkpointed serialized execution view and transfer
high-watermark, then prunes transcript-tail rows whose accepted sequence is
covered by the checkpoint. This keeps each later local plan from replaying an
unbounded commit history.

The browser execution node has narrow authority:

- it may execute for `TransportHello.actor`;
- it may submit a transcript for scopes allowed by the session token;
- it may not advertise broad capability to unrelated nodes;
- it may not execute turns requiring native handlers that lack a deterministic
  `woo.native_primitive_contract.v1`;
- it may not satisfy a VM read from display projection or from an unverified
  IndexedDB row.

### VTN14.3 Optimistic local turn flow

The completed browser path for a committed UI action is:

```text
UI -> worker: TurnIntent or direct TurnCall
relay -> worker: open projection/catch-up transfer and executable seed transfer
worker: reconstruct execution node from verified executable pages
worker: build or reuse TurnCall
worker: run command planning if needed
worker: if local cache covers the TurnKey, execute VM turn locally in transcript mode
worker: otherwise rank gossiped ExecCapabilityAds and delegate the whole turn
executor: return outcome, transcript, and state transfer, or missing_state/better_ad
worker: install verified state transfer so the local execution cache advances
worker: derive or receive TurnKey and tentative EffectTranscript
worker -> UI: optimistic result/observations/projection patch when a transcript exists
worker -> relay/commit scope: Envelope<TurnExecRequest or CommitSubmit>
commit scope: validate, rerun or receipt-check, then accept/conflict
worker -> UI: confirm, rollback, rebase, or retry
```

For live/direct turns, a locally executed transcript may produce an optimistic
`turn_result` for immediate UI feedback, but that result is not canonical unless
the verb is explicitly marked safe for local-only finalization. Catalog verbs
that return canonical lists of durable objects, such as board or outline item
hydration reads, MUST be confirmed by an authoritative relay response before the
UI treats their result as a replacement for existing canonical state. The
current implementation has no local-only finalization opt-ins: successful local
live reads are emitted only as optimistic results, then the worker sends the
browser-built `TurnExecRequest` and publishes the relay reply as the final
result.

The browser may send `woo.turn.intent.request.v1` only for live turns or for a
cold durable delegation that names a selected scope-level `ExecCapabilityAd`.
It MUST NOT submit an unselected durable intent as a silent server-assisted
planning fallback. A v2 implementation is not complete until ordinary chat
movement, pinboard edits, kanban edits, and dubspace committed controls use
browser-built `TurnExecRequest` messages by default.

Delegation is whole-turn execution, not remote object RPC. If local execution
cannot proceed after bounded state repair, the browser chooses the best
currently advertised capable executor using VTN11 candidate selection, sends
the full `TurnExecRequest`, and treats the returned transcript as the tentative
turn result. The remote executor SHOULD include a closure or delta transfer for
the material it used, subject to authorization and byte limits. The browser MUST
verify and install that transfer before it marks the delegated attempt complete,
so delegation moves the actor-local cache forward and increases the likelihood
that the next related turn executes locally.

The first production browser execution milestone MAY let the server rerun the
transcript before commit. That still qualifies as browser-edge optimistic
execution because local UI state comes from the browser VM transcript and the
server response is authoritative reconciliation. A later milestone MAY validate
a client transcript without full rerun when the transcript has complete VM
hashes, read versions, write facts, and state hashes.

### VTN14.4 Missing-state repair

Missing state is a cache miss, not a semantic fallback. When local execution
cannot prove it has the required atoms, the browser first tries to learn enough
state to execute locally:

```text
worker -> relay: StateTransferRequest(mode:"closure", atoms:[...], base:head)
relay/authority: select pages from owner/commit-scope state
relay -> worker: StateTransfer(mode:"closure", pages, inline_pages, proof)
worker: verify proof, page hashes, recipient, scope/epoch, authorization
worker: install executable pages into IndexedDB
worker: rebuild execution node and retry the same turn id
```

The browser worker SHOULD request executable state with an authenticated
`woo.state.transfer.request.v1` envelope keyed by the planned `TurnKey`. The
relay replies with a recipient-bound `StateTransfer`; this repair request MUST
NOT commit or execute the turn. If repair succeeds, the worker retries local
planning before selecting a delegated executor.

The worker MUST cap retries and transferred bytes. A turn that still cannot be
executed locally after the negotiated retry/byte budget MUST be delegated to
the best suitable gossiped executor when one exists. If no suitable executor is
available, the worker returns a visible `missing_state`/`no_executor` error or
uses a measured server-assisted planning fallback while compatibility remains
enabled. It MUST NOT silently submit an optimistic success based on partial
state.

Every successful delegated execution is also a cache-warming operation. The
delegated reply MUST either include state transfer for the execution material or
name why transfer was withheld. The browser may display the delegated outcome
optimistically after it has a transcript, but it MUST NOT claim its local
execution capability advanced until the returned pages or deltas are verified
and installed. If transfer is withheld, the next related turn may delegate again;
that is correct but should be visible in metrics.

State-transfer authorities MUST obey ownership:

- object-host state supplies hosted object pages;
- commit scope supplies scope heads, accepted-frame tails, and scope-owned
  sequenced state;
- gateway/session authority supplies current session rows and actor/session
  objects;
- projection authority supplies only projection and projection-patch rows.

A cache fill from one authority MUST NOT overwrite rows owned by another
authority unless the transfer proof explicitly names that owner and the row kind
is in the owner's authority set.

### VTN14.5 Optimistic UI and reconciliation

The UI applies browser-local execution through an optimistic layer keyed by
turn id. The optimistic layer may include:

- emitted observations;
- direct result or error;
- projection patches derived from the tentative transcript;
- local audio/control state for dubspace;
- pending status for controls that should show confirmation.

The authoritative reconciliation rules are:

- `CommitAccepted` for the same turn id confirms the optimistic layer and
  collapses it into canonical projection/applied-frame state.
- `CommitAccepted` for another turn at an earlier sequence is applied first; if
  it changes any cell read by a pending optimistic turn, the worker rebases by
  discarding that tentative layer, rebuilding from verified pages, and retrying
  the same turn id against the new head.
- `CommitConflict` rolls back the optimistic layer, installs any returned state
  transfer, and either retries automatically when the reason is `stale_head` or
  reports the conflict to the UI.
- Projection fallback replaces only the canonical projection layer for its
  named scope/head. It MUST NOT erase pending optimistic layers until those
  layers are either reconciled or explicitly invalidated by changed read cells.
- Live events never confirm or reject committed optimistic state.

The browser MUST retain enough pending-turn metadata to decide whether an
accepted frame confirms, invalidates, or is independent of each optimistic turn:
turn id, base head, predicted atoms, read cells, write cells, transcript hash,
and UI patch id.

#### VTN14.5.1 Phase 1 tentative journal

The current browser worker implements the dependency-chain model locally before
wire-level dependency metadata exists. For each durable local transcript it
stores a `tentative_turns` row keyed by turn id and scoped by actor/session. A
later local plan materializes:

```text
verified executable seed or checkpoint
+ executable transfers newer than the checkpoint
+ accepted transcripts newer than the checkpoint
+ pending tentative transcripts for the same actor/session/scope
```

This means a same-actor chain such as `enter` followed immediately by
`add_note` or `add` can execute locally against the tentative post-state of
`enter` without waiting for the authoritative `enter` frame. The authoritative
network still sequences both turns; the journal is a local composed read view,
not a commit authority.

When the authoritative reply accepts a turn, the browser removes the matching
tentative row by turn id or transcript hash, stores the accepted frame and
accepted transcript, and lets future plans compose from the committed tail or a
new checkpoint. A `stale_head` conflict is a convergence signal and MUST NOT
invalidate the tentative row by itself; an authoritative executor may re-run the
turn against the newer head, while a non-authoritative delegated executor may
surface the conflict for a later browser re-plan.

Permanent conflicts are narrower in Phase 1 than in the final dependency-wire
model. Because `depends_on` is not yet carried on the wire, the server treats
later locally planned turns as independent submissions. The browser therefore
invalidates only the directly rejected tentative turn and reports
`E_V2_TENTATIVE_INVALIDATED` to the optimistic UI. Cascading invalidation or
automatic downstream replay is reserved for the dependency metadata milestone;
failing an entire local suffix before the server understands that suffix as a
dependency chain would create client/server divergence.

### VTN14.6 Reconnect and cold-open behavior

On startup or reconnect, the worker posts cached projection to the UI only as
cached display state, then opens the v2 transport and waits for
`TransportHello` plus projection/delta catch-up before replaying pending
authority-bearing envelopes. It then:

1. validates that `TransportHello.actor` matches the cached actor;
2. discards executable pages bound to stale actor/session/epoch authority;
3. installs the initial projection/delta transfer for the opened scope;
4. replays pending envelopes whose auth token and actor/session still match;
5. rebuilds execution nodes lazily for the next local turn.

If a pending optimistic turn predates a projection fallback, the worker MUST
compare the fallback head and pending base head. If the fallback skipped over
the pending turn without an accepted frame for that turn id, the worker treats
the pending turn as unresolved and resubmits or fails it through the idempotent
turn path; it does not assume success from display projection.

### VTN14.7 Completion test gates

An implementation does not claim browser-edge v2 completion until tests cover:

- browser-local transcript equals server transcript for representative chat,
  pinboard, kanban, and dubspace committed turns;
- partial IndexedDB cache triggers missing-state transfer, installs pages, and
  retries locally before submit;
- tampered projection rows cannot satisfy VM execution reads;
- tampered executable pages fail hash/proof verification;
- two browsers editing the same scope reconcile accepted/conflict frames without
  losing durable state;
- fresh browser open with host-owned durable rows cannot clear pinboard or
  outliner contents through a gateway/cache-only projection;
- reconnect from a stale head falls back to projection without confirming or
  deleting unresolved optimistic turns;
- durable `woo.turn.intent.request.v1` usage is disabled for normal browser
  surfaces; remaining server-assisted intents are limited to live turns and
  explicit compatibility-mode selected cold delegation.

Implementation status: the in-process v2 simulator includes a browser-shaped
node/relay shim with an object-page cache, scope projection cache, pending-turn
table, accepted/conflict frame queues, and transfer tracking. Scope open uses a
projection transfer, accepted commits fan out through the Worker gateway's live
socket table. CommitScopeDO remains the scope-head and state-transfer authority;
it serves recipient-bound projection transfers for commit-scope gateway fan-out,
while the gateway routes committed observations by per-observation session/actor
audience across affected scopes. Relay MAC proofs are verified before cache
install. The shim also includes scope subscriptions and best-effort live-event
fan-out with coalescing, without advancing the commit-scope head. Relay and
browser diagnostic tails are bounded; if a browser reconnects from a head older
than the retained tail, it receives a projection fallback rather than an
unbounded replay. The browser-side M4 worker opens the v2 WebSocket, persists
hello/reply/pending-frame state in IndexedDB, applies received projection/delta
state transfers into projection, applied-frame, and transcript-tail stores,
persists executable object/state pages from closure transfers, replays pending
envelopes after reconnect, and marks reset/catch-up-needed state when the relay
reports reset. The browser worker bundles into the SPA on every deployment and
the UI consumes applied frames that arrive from the v2 worker. Catalogs can move
their own controls to v2 by submitting `woo.turn.intent.request.v1` through the
shared browser helper. The SPA sends generic sequenced UI calls through the same
v2 helper whenever a browser-session token is available; the legacy `/ws`
fallback has been removed.
The default browser chat surface uses the same helper:
it asks the catalog `command_plan` verb to parse text, executes speech/tells as
direct `live` turns, and executes room movement/carrying commands as
direct `durable` turns when the catalog marks them with
`arg_spec.command.persistence`.

M4 wire-slice status: local dev and the Cloudflare Worker expose the reserved
`POST /v2/session/mint` path and `GET /v2/turn-network/ws` WebSocket endpoint.
The endpoint validates the `woo-v2.turn-network.json` subprotocol, sends a v2
`TransportHello` envelope followed by an initial projection/delta state-transfer
envelope, decodes subsequent frames through the shared v2 envelope codec, and
can return v2 execution replies. Reconnect opens may include the browser's
cached `last_known_head` so `CommitScopeDO` can return a retained delta instead
of a full projection when the tail is still available; they may also include
`executable_seed_digest` so an unchanged open executable seed can be
acknowledged with a compact signed marker instead of resending cached page
bodies. The Worker gateway
forwards authority-bearing v2 envelopes to `CommitScopeDO`, which persists the
commit scope in row-shaped storage: one row per serialized object plus small
rows for sessions, log entries, counters, accepted-frame tail, transcript tail,
seen idempotency keys, and cached replies. Fresh accepted envelopes write only
the new idempotency key/reply, accepted-frame/transcript tail rows, updated
counters/head, and the object rows touched by the accepted transcript; duplicate
envelopes replay the cached reply without another durable write. Gateway isolate
hibernation no longer resets v2 commit authority; browsers still resubscribe
and run VTN9 catch-up after any transport reconnect because live socket
subscriptions remain connection-local. The local dev server keeps the earlier
socket-lifetime in-process relay shim.

The first production deployment of this wire path targets a separate
namespace where v1 compatibility is not maintained. On that namespace, MCP is
the first v2 consumer: McpGateway is a pure v2 client for world/object verb
calls (live versus durable persistence follows `arg_spec.command.persistence`,
with both modes submitted through `/v2/envelope`), while MCP queue/focus
controls remain local protocol state.
The legacy production namespace stays on v1 unchanged; browsers and v1 MCP
clients continue to use it. See
[notes/2026-05-13-mcp-first-v2.md](../../notes/2026-05-13-mcp-first-v2.md)
for the migration plan and namespace strategy.

Browser-node dubspace preview flow:

```text
UI -> local audio: apply preview immediately
UI -> worker: TurnIntent(route=direct, persistence=live, preview_control(target, name, value))
worker -> relay: v2 envelope on the browser socket
relay -> browser: direct result envelope with gesture_progress observations
```

Browser-node dubspace commit flow:

```text
UI -> worker: TurnIntent(route=sequenced, set_control(target, name, value))
relay: plans the deterministic turn and records the transcript
relay -> commit scope: CommitSubmit
commit scope -> browser: AppliedFrame(control_changed)
browser UI/audio engines apply the committed frame
```

Browser-node pinboard flow:

```text
UI -> worker: TurnIntent(route=sequenced, enter())
commit scope -> browser: AppliedFrame(pinboard_entered)
UI -> worker: TurnIntent(route=sequenced, add_note/move_pin/resize_pin/set_text/...)
commit scope -> browser: AppliedFrame(note_added/pin_moved/pin_resized/note_edited/...)
UI -> worker: TurnIntent(route=direct, persistence=live, viewport/list_notes)
relay -> browser: direct result envelope or live pinboard_viewport observation
```

Pinboard enter/leave are committed turns because the board's durable presence
is the authorization precondition for layout and note edits. Viewport telemetry
and projection hydration are direct live-persistence calls; they MUST NOT carry
durable writes. Pinboard embedded chat uses the catalog `command_plan` verb over
v2 so aliases and object matching remain catalog-owned.

Browser-node outliner flow:

```text
UI -> worker: TurnIntent(route=sequenced, enter())
commit scope -> browser: AppliedFrame(outliner_entered)
UI -> worker: TurnIntent(route=sequenced, add/add_item/hide/move_item/...)
commit scope -> browser: AppliedFrame(outline_item_added/outline_item_hidden/...)
UI selection/collapse/create-in-place state remains browser-local
```

Outliner items are durable first-class objects under the `$outliner` scope.
Server-side focus remains a catalog feature for chat and agent workflows, but
the browser UI's selected row is local-only: clicking a row selects it without a
network call, and create-in-place passes the selected parent id explicitly to
`add_item`. The browser worker must therefore support the same same-actor
dependency chain as pinboard: `enter` can be tentative while `add` or
`add_item` plans against the local journal, then both turns reconcile against
authoritative accepted frames.

Browser-node chat flow:

```text
UI -> worker: TurnIntent(route=direct, command_plan(text), persistence=live)
worker -> UI: direct plan result
UI -> worker: TurnIntent(route=direct, say/tell/..., persistence=live)
relay -> browser: direct result and live chat observation

UI -> worker: TurnIntent(route=direct, go/take/drop/give, persistence=durable)
commit scope -> browser: AppliedFrame(room/object move)
browser -> gateway: refresh scoped projection when the accepted result asks for a deferred look
```

The default chat catalog is intentionally ephemeral for messages. Durable,
scrollback-style chat is a future catalog concern; it should share parser and UI
machinery with default chat but opt into its own storage and conversation model.

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

### Outliner

- outline rows are first-class `$outline_item` objects contained by an
  `$outliner`;
- entering the outliner, adding items, editing text, hiding/unhiding, moving,
  reordering, removing, and undoing are committed turns;
- row selection, collapse state, and create-in-place editor state are
  browser-local affordances and do not update server-side focus;
- server-side focus remains available for chat/MCP commands and ordinary
  `add <text>` workflows;
- a fresh open or reload must reconstruct the item tree from durable contents
  and item properties, not from a stale projection-only cache.

Prototype status: current in-process and browser-worker coverage commits pinboard
`add_note`, `move_pin`, `resize_pin`, pin `set_color`, `set_text`, `take`,
and `drop`, outliner `enter` and `add`/`add_item`, plus taskspace
`create_task`, task `claim`, and task `set_status`. Same-turn object creation
is validated against transcript create/write facts rather than the pre-turn
world. Deterministic native helpers are admitted only when a
`woo.native_primitive_contract.v1` contract declares the handler
transcript-tracked and deterministic, including the state families it reads,
writes, and emits. Native dispatches without such a contract make the
transcript incomplete. Runtime cross-host bridge boundaries are also explicitly
incomplete in the v2 protocol; mergeable remote sub-transcripts are deferred
until the execution plane exists.

### Dubspace

- high-rate slider/cursor previews use the live plane;
- final control changes, transport, tempo, patterns, and scene operations commit
  through the commit plane;
- browser audio engines apply both live previews and accepted committed frames;
- logical time replaces wall-clock reads for persistent transport state.

## VTN16. Completion milestones

The v2 completion path SHOULD land in this order. Each milestone MUST either
remove an interim server-assisted path or add a guard that prevents it from
spreading.

1. **Protocol namespace cleanup.** Public v2 specs, wire messages, and tests use
   only `woo.*.v1` protocol names. Interim local names remain behind adapters
   while code is renamed.
2. **Commit-eligible transcripts.** Browser and server recorders emit
   `woo.effect_transcript.v1` with `base`, `vm`, logical inputs, complete read
   and write facts, and pre/post state hashes.
3. **IndexedDB execution cache.** The browser worker persists verified
   executable pages with proof metadata, installs an open-time executable seed
   for the current scope, reconstructs an execution node from IndexedDB, and
   refuses to use projection rows for VM reads. Accepted transcript replay is
   bounded by per-scope execution checkpoints.
4. **Missing-state repair.** Browser local execution requests closure
   transfers on `E_NEED_STATE`, verifies and installs pages, then retries the
   same turn id locally before delegation.
5. **Browser-planned committed turns.** Chat movement/carrying, pinboard,
   kanban, and dubspace committed controls submit browser-built
   `TurnExecRequest` messages by default. `woo.turn.intent.request.v1` remains
   only behind an explicit compatibility flag for durable turns.
6. **Gossiped whole-turn delegation.** When the browser cannot execute locally,
   it ranks `ExecCapabilityAd`s, delegates the whole turn to the best suitable
   executor, verifies the returned transcript/state transfer, and installs the
   returned execution material so future local execution advances.
7. **Optimistic projection reconciliation.** The UI applies tentative
   transcript effects immediately, confirms them on `CommitAccepted`, rebases on
   intervening accepted frames, and rolls back or retries on `CommitConflict`.
8. **Owner-authoritative state transfer.** Object-host, gateway/session,
   commit-scope, and projection authorities are enforced at every merge
   boundary. Cache-only rows cannot clear host-owned durable state.
9. **Transcript validation without routine rerun.** Commit scopes can validate
   complete client transcripts by read/write/state hashes and VM contracts for
   the common deterministic path, while retaining rerun as an audit/fallback
   mode.
10. **Interim path removal.** Server-assisted browser planning can be disabled in
   tests and production. New browser feature work must use local execution or
   explicitly fail when executable state is unavailable.
11. **Operational hardening.** Eviction, cold activation, transcript
    compaction, chaos tests, and metrics prove the browser recovers from stale
    heads, lost sockets, bad pages, and conflicting edits without data loss.

Milestones 2-7 are the minimum bar for a real distributed VM: the browser edge
must execute optimistic committed turns from verified local state and reconcile
against authoritative sequencing. Milestones 8-11 are the durability and
operational bar for retiring server-assisted planning as the ordinary browser
path.

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

## VTN19. Transport bindings

VTN19 defines the M4 browser-to-relay transport binding. It is intentionally
narrow: one browser node, one relay, one WebSocket, JSON envelopes only.
Node-node transport, binary page transfer, `same_deployment_mac`, and
cross-deployment signatures are deferred to M5.
Transport is foundational to all four planes, but this section lives after the
turn/state/live definitions so its message names can refer to those sections.

### VTN19.1 WebSocket endpoint and open handshake

Authority-bearing v2 browser-relay connections MUST use `wss://`. `ws://` is
permitted only for `localhost`, `127.0.0.1`, or `[::1]` development endpoints.

The browser opens:

```text
GET /v2/turn-network/ws?token=<session-token>&node=<browser-node-id>&scope=<scope-ref?>&last_known_head=<json-scope-head?>&executable_seed_digest=<digest?>&resume=<resume-token?>
Upgrade: websocket
Sec-WebSocket-Protocol: woo-v2.turn-network.json
```

The token in the query string is allowed only for the opening handshake. After
the socket is established, every envelope repeats the bearer token in
`auth.token` as specified in VTN4.2. Deployments that log URLs MUST redact the
`token` query parameter.

`scope` and `last_known_head` are the M4 open-handshake catch-up shortcut for a
single scope. When present, `last_known_head` is a JSON encoded `ScopeHead` for
`scope`; the relay validates the shape, treats malformed or stale values as
absent, and sends the state transfer that VTN9 would have returned for that
cursor. If `last_known_head` exactly equals the current scope head, the relay
MAY send an empty signed delta freshness marker instead of rebuilding the full
projection. Relays with retained contiguous history SHOULD send a non-empty
delta transfer when it fits within the advertised message-size budget;
otherwise they send a projection transfer. This shortcut does not replace explicit
`Subscribe`/`CatchupRequest` for multi-scope clients.

`executable_seed_digest` is an advisory cache validator for the open-time
executable seed. The digest is computed from normalized executable
state-transfer metadata: mode, scope, purpose, selected atoms/preimages, page
or object refs without inline body bytes, session/log/snapshot/counter tail,
and source counts; relay proof material and inline page bodies are excluded. A
browser MUST send this digest only when it can reconstruct the opened scope's
execution node from verified IndexedDB pages and/or a verified execution
checkpoint. If the relay computes the same digest for the current open seed, it
MAY send a compact signed executable state-transfer marker instead of resending
the seed pages. The client-supplied digest is never authoritative: the relay
MUST recompute the current digest from relay-owned serialized state and compare
it against a generation-scoped server-side cache entry. Relays MUST invalidate
or generation-advance that cache whenever their serialized seed state changes,
and MUST bound retained digest entries. If the digest is absent, malformed, or
stale, the relay sends the normal executable seed. This optimization is cache
negotiation only; it does not weaken proof verification or authorize execution
from unverified client state.

The relay MUST select `Sec-WebSocket-Protocol: woo-v2.turn-network.json` or
reject the upgrade with HTTP 400. A server that accepts the WebSocket without
selecting that subprotocol is not a conforming M4 v2 relay.

The relay's first message MUST be:

```ts
type TransportHello = {
  kind: "woo.transport.hello.v1";
  relay: NodeRef;
  session: SessionRef;
  actor: ActorRef;
  server_time: number;
  max_message_bytes: number;
  idempotency_window_ms: number;
  planes: Array<"execution" | "commit" | "state" | "live">;
  resume_token?: string;
  features: string[];
};
```

The browser MUST NOT send authority-bearing envelopes until it receives
`TransportHello`. If authentication fails before `TransportHello`, the relay
MUST close the WebSocket with a policy/auth failure reason. The relay MAY accept
idempotent `ping` control frames before hello only to keep intermediaries from
closing a slow-auth connection.

After `TransportHello`, an M4 relay SHOULD immediately send the projection or
delta `woo.state.transfer.v1` for the opened `scope` before
processing authority-bearing browser envelopes. This preserves hello-first
transport semantics while ensuring browser caches install verified state before
pending turns are replayed.

For browser-local execution, the relay SHOULD then send either the open-time
executable seed transfer or the compact executable-seed cache-hit marker
described above. Both are ordinary signed executable state transfers. A browser
that receives a cache-hit marker MUST use only its previously verified cached
pages/checkpoint to reconstruct executable state; the marker is a readiness and
freshness acknowledgement, not executable material by itself.

If the relay emits an open-time `ExecCapabilityAd` for the scope, it SHOULD send
that ad immediately after the initial state transfer. A browser that disables
unselected durable intents MUST NOT release queued durable turns until the
initial display state transfer, executable state transfer or cache-hit marker,
and execution ad have all been installed.

`TransportHello.actor` is the relay-validated actor from the session token. If
it differs from the browser's cached actor, the browser MUST treat
`TransportHello.actor` as authoritative and discard local state bound to the
previous actor.

### VTN19.2 Plane multiplexing

The M4 browser-relay binding multiplexes all four protocol planes on the single
WebSocket. Plane is derived from the envelope `type`:

| Type prefix | Plane |
|---|---|
| `woo.turn.exec.` | Execution |
| `woo.commit.` | Commit |
| `woo.state.` and `woo.catchup.` | State |
| `woo.subscribe.` | State/control |
| `woo.live.` | Live |
| `woo.transport.` | Transport control |

Messages from different planes MAY be interleaved. Receivers MUST preserve
per-envelope idempotency by `(from, id)` and MUST preserve commit-scope order
by `ScopeHead`, not by WebSocket arrival order. A relay MUST NOT let a live
message overtake or rewrite durable committed state; if a live event and an
applied frame affect the same display field, the browser's projection rules
decide which layer is visible.

If a browser sends an envelope whose derived plane is not in
`TransportHello.planes`, the relay MUST reply with `woo.transport.error.v1` and
MAY close the socket. This is a protocol error, not an unknown-message no-op.

### VTN19.3 Ping, idle, and backpressure

Either endpoint MAY use WebSocket ping/pong frames. In addition, either endpoint
MAY send:

```ts
type TransportPing = {
  kind: "woo.transport.ping.v1";
  now: number;
};

type TransportPong = {
  kind: "woo.transport.pong.v1";
  ping_now: number;
  now: number;
};
```

If no frame is received for 25 seconds, an endpoint SHOULD send ping. If no
frame or pong is received for 60 seconds, it SHOULD close and reconnect. These
timers are transport health checks only and MUST NOT feed VM logical time.

Relays MAY drop live events under backpressure, preferring to keep the newest
event per coalesce key. Relays MUST NOT drop accepted commit frames on an open
socket silently; if an accepted-frame queue overflows, the relay MUST send a
transport gap/error and force the browser through VTN9 catch-up.

Close-code profile for M4:

- use `1002` for malformed envelopes, unknown types, unsupported planes, and
  other protocol violations;
- use `1008` for authentication, authorization, expiry, or revocation policy
  failures;
- use `1009` for message-too-big;
- deployment-specific `4000`-`4999` close codes MAY add detail, but clients
  MUST handle the standard code class above.

### VTN19.4 Reconnect and resume

`resume_token` is a transport convenience, not durable state authority. It lets
the relay identify a recently disconnected socket and may preserve subscriptions
for a short deployment-local window, recommended 30 seconds. It does not
guarantee replay of accepted frames.

On reconnect, the browser MUST:

1. open a new WebSocket with the current session token and optional
   `resume_token`;
2. wait for `TransportHello`;
3. resubmit `Subscribe` for desired scopes, including last-known heads;
4. run VTN9 catch-up for each scope;
5. re-send only idempotent pending turn requests whose `(from, id)` keys remain
   valid within `TransportHello.idempotency_window_ms`.

The relay MAY restore live subscriptions from `resume_token`, but the browser
still sends explicit `Subscribe` messages so reconnect is correct when the
relay forgot all socket state. Live events missed while disconnected are not
recoverable.
