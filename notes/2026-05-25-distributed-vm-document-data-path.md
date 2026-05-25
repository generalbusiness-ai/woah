# Distributed VM data path

Updated 2026-05-25.

Status: design note, simplified after review. This note replaces the expanded
"emit many documents" design with a sequence-first model.

## Goal

The distributed VM model is simple:

1. A node executes only when it has sufficient VM state.
2. Execution produces an `EffectTranscript`.
3. The authority scope accepts the transcript in sequence.
4. Other holders catch up from accepted frames or from a checkpoint.

The implementation should be equally simple. The authoritative durable path is
not a per-row document factory. It is:

```text
accepted frame log + materialized projection rows + bounded checkpoint/tail transfer
```

The prior design hid cost inside "during the same application, emit many
documents." That is not acceptable. The applier may update rows and report what
it touched, but there is no second semantic data model on the hot path.

## Ground Truth

Current VM and storage data already define the contract:

- `RecordedTurn` and `EffectTranscript`: what execution did.
- `ShadowCommitAccepted` and `ShadowScopeHead`: what the sequencer accepted.
- `ShadowCommitScopeState`: indexed authority state used by the applier.
- `SerializedObject`, `SerializedSession`, `SpaceLogEntry`,
  `SpaceSnapshotRecord`, `ParkedTaskRecord`, tombstones, and counters:
  materialized projection rows.
- `SerializedAuthoritySlice` and `ShadowStatePage`: transfer/cache formats,
  not semantic authority.

Important limitation: `EffectTranscript` does not yet capture every possible
durable side effect. `RecordedCell` covers `prop`, `verb`, `location`,
`contents`, and `lifecycle`, and the transcript also carries `creates`,
`moves`, observations, logical inputs, and untracked effects. Session writes,
counter allocation, snapshots, parked tasks, and some schema/verb-body changes
still arrive through runtime/applier side channels. The simplified design does
not pretend otherwise.

## Measurement Basis

The current analyzer is `scripts/analyze-data-path-costs.mjs`. It classifies
all observed metric kinds and fails on unknown kinds. The guard is covered by
`tests/analyze-data-path-costs.test.ts`.

The two 2026-05-25 smoke tails used for this note contain 2,486 metrics and 36
metric kinds. They showed:

| Surface | Observed cost |
|---|---:|
| `/v2/open` request JSON | 23.20 MiB |
| executable seed transfer | 8.11 MiB, 5,746 inline pages |
| executable transfer misses | 9/9 opens |
| `storage_full_save` | 17 saves, 27,012 rows |
| direct storage writes | 7,636 rows |
| gateway cache apply | 2,685 objects and 13,608 properties scanned for 164 writes |
| remote tool enumeration | 27 RPCs, 5 timeouts |
| authority-slice RPC | 29 RPCs, 1 timeout |

These tails predate or do not prove the current deployed KV baseline. The next
implementation decision must use fresh tail data. The numbers above explain
the shape of waste; they are not a license to ignore newer KV behavior.

Fresh production measurement was captured on 2026-05-25 at 18:11Z against
`woah.generalbusiness.ai`, Worker version
`d29fdd42-9dc9-4d6a-95a6-dfc229d8eede`, with
`scripts/smoke-with-tail.sh` after extending it to preserve raw smoke output,
Cloudflare invocation wall/cpu summaries, and the data-path analysis. Artifacts:

- `.woo/smoke-measurements/20260525T181122Z-6379/tail.log`
- `.woo/smoke-measurements/20260525T181122Z-6379/smoke.log`
- `.woo/smoke-measurements/20260525T181122Z-6379/analyze-smoke-tail.txt`
- `.woo/smoke-measurements/20260525T181122Z-6379/analyze-data-path-costs.txt`

The fresh three-run smoke failed 1/9, 1/9, and 0/9. The tail contains 5,247
metrics and 39 metric kinds; the analyzer classified all of them.

| Surface | Fresh observed cost |
|---|---:|
| `/v2/open` request JSON | 38.71 MiB |
| executable seed transfer | 12.52 MiB, 9,237 inline pages |
| executable transfer misses | 15/15 opens |
| `storage_full_save` | 34 saves, 53,716 rows |
| direct storage writes | 15,355 rows |
| gateway cache apply | 9,000 objects and 45,631 properties scanned for 328 writes |
| remote tool enumeration | 58 RPCs, 12 timeouts |
| authority-slice RPC | 69 RPCs, 3 timeouts |
| `CommitScopeDO /v2/open` invocation wall/cpu | p95 12.0s wall, p95 10.6s CPU |
| `CommitScopeDO /v2/envelope` invocation wall/cpu | p95 12.4s wall, p95 2.5s CPU |
| `PersistentObjectDO /mcp` invocation wall/cpu | p95 24.2s wall, max 40.3s wall |

KV seed delivery was not the primary blocker in this run:
`mcp_gateway_snapshot_fetch/kv` had 39 samples, mean 87ms, p95 256ms, max
686ms; `host_seed_fetch/kv` had 33 samples, mean 171ms, p95 356ms, max 424ms.
There was one `host_seed_fetch_kv_miss` and one DO fallback fetch at 400ms.

`the_horoscope` no longer appeared as a slow WORLD route. It was hosted on
`the_horoscope`, where one `set_properties` still took 36.2s inside its own DO.
WORLD was not the smoke bottleneck: `world` `do_handler` p95 was 92ms and max
929ms. The current bottleneck is the combination of executable `/v2/open`,
gateway compatibility apply, full saves, authority-slice fetches, and tool
enumeration.

## Current Hotspots

The simplified model must remove the existing implementation costs, not merely
rename them.

1. Eager `SerializedWorld` materialization after indexed apply.
   `applyShadowTranscriptToIndexedState` keeps objects, sessions, and logs in
   maps, but `commitShadowCommitScopeState` immediately calls
   `serializedWorldFromCommitScopeState`. That allocates and sorts all objects,
   sessions, and log scopes on every accepted commit. For a populated scope this
   is `O(N log N)` work after an otherwise touched-row apply. End state:
   `scope.serialized` is a dirty lazy cache, materialized only at explicit
   `SerializedWorld` boundaries: diagnostics, fallback export, checkpoint
   build, or legacy `saveFull`.

2. `saveFull` rewrites append-mostly tails.
   `saveFull` writes world rows, accepted frames, transcript tails, seen keys,
   and reply envelopes in one transaction. `saveAcceptedFrames` and
   `saveTranscriptTail` rewrite the whole retained tail and then select rows to
   delete. With a 1,000-frame retention SLO, a cold full save can rewrite up to
   2,000 tail rows even when only one frame is new. End state: world/checkpoint
   rows and authority tails are separate persistence surfaces. Frames and
   transcripts are appended by sequence/hash with a persisted high-water mark;
   pruning deletes only rows older than the retention horizon.

3. The gateway keeps a `WooWorld` alive for projection work.
   Gateway fanout and tool listing currently apply accepted transcripts through
   `runShadowApply` and `buildGatewayApplyTarget` to keep a mirror world fresh.
   The gateway does not execute VM turns. It needs session routes, object
   projection rows, and tool-surface rows. End state: the gateway is a
   projection-row cache, not a VM substrate. `ProjectionDeltaSummary` is its
   input; `WooWorld` construction, seed merge, and gateway-side
   `runShadowApply` are removed from the normal accepted-fanout path.

4. Cross-host RPC timeout, not byte volume alone, drives smoke flake.
   The fresh smoke tail showed `/__internal/enumerate-tools` at 58 calls with
   12 timeouts, and `/__internal/authority-slice` at 69 calls with 3 timeouts.
   Lever B made seed fetches fast, but cold target DOs can still time out while
   reconstructing enough state to answer descriptor and authority reads. End
   state: every hot-path cross-host RPC has a same-host last-known fallback. A
   cold remote target makes projection data stale, not unavailable; fanout
   reconciles it later.

5. Cold-open save/checkpoint work must not become a head-of-line lock.
   `saveFullIfNeeded` is single-flight per `CommitScopeDO`. Concurrent cold
   opens of the same scope wait behind the same full-save transaction. The
   checkpoint/tail replacement must not inherit that shape unless checkpoint
   build is measurably cheap. End state: open responses can return retained
   tails or last complete checkpoints while a new checkpoint is built
   asynchronously, or the synchronous checkpoint build reports a bounded wait
   budget.

6. Measurement noise is a design risk.
   `session_reap` accounted for 1,082 of 5,247 fresh observed metrics. That
   can mean a real session retention bug, or merely noisy per-session/per-sweep
   logging. End state: reap metrics are emitted once per sweep only when at
   least one session is actually reaped, with inspected/reaped counts. Analyzer
   output must not use raw metric count as a proxy for step cost until this is
   fixed.

7. Two appliers and four `runShadowApply` sites can drift.
   The map-based `applyShadowTranscriptToIndexedState` and array-based
   `applyShadowTranscriptToCommittedState` both apply transcripts. Separately,
   REST, gateway, local host write-through, and satellite write-through all
   call `runShadowApply` with different targets. End state: there is one
   indexed applier producing `ApplyResult`; array-based apply is removed or
   retained only as a legacy test oracle, and the four target shapes consume
   the same typed delta instead of each rediscovering side effects.

## Current Sequences

### MCP Open And Tool List

Current sequence:

```text
client initialize
-> gateway authenticates or resumes session
-> Directory registers session route
-> client calls woo_list_reachable_tools scope:all
-> McpHost reads actor/session/object graph
-> remote enumerate-tools RPCs read other holders
-> gateway mirror WooWorld is kept warm enough to answer projection reads
-> cold holders may run host seed/open paths before any user turn
```

Data moved:

- session route rows;
- actor object row and active scope;
- reachable object rows and verb definitions;
- remote tool descriptors.

Problem:

Tool listing is a projection read, but it can trigger executable/cold holder
work. It should not open a VM scope, reconstruct a world, or depend on a cold
remote holder returning before the smoke timeout.

### First Call On A Scope

Current sequence:

```text
woo_call
-> resolve tool
-> submitTurnIntent
-> ensureV2ScopeClient
-> build authority slice
-> serializedWorldFromAuthoritySlice
-> POST /v2/open
-> open executable seed, maybe saveFull
-> POST /v2/envelope
```

Data moved:

- authority slice;
- executable seed/projection pages;
- full or near-full serialized world on cold paths;
- then the actual envelope.

Problem:

Open currently does two jobs: prepares an execution view and repairs/persists
receiver state. The user action is small; the cold-open compatibility path is
large.

### Accepted Turn

Current sequence inside `CommitScopeDO`:

```text
/v2/envelope
-> execute or plan turn
-> RecordedTurn
-> EffectTranscript
-> validate transcript against indexed state
-> apply transcript to ShadowCommitScopeState
-> commitShadowCommitScopeState materializes and sorts full SerializedWorld
-> save accepted frame/reply/idempotency rows
-> saveTranscriptDelta touched object/session/log rows
-> fan out accepted/live observations
```

Data moved:

- transcript and accepted frame;
- touched projection rows;
- full `SerializedWorld` arrays when `scope.serialized` is kept in sync;
- observation payloads;
- reply/idempotency rows.

This is the good part of the system. The design should keep this shape and
make the touched delta explicit. It should not add an extra per-row document
emission layer. It must also stop materializing `SerializedWorld` on the normal
commit path.

### Fanout And Receiver Catch-Up

Current sequence:

```text
accepted frame
-> mcp fanout / apply-v2-commit RPC
-> receiver/gateway applies frame through compatibility helpers
-> gateway runShadowApply updates mirror WooWorld
-> shadow_gateway_apply_step may scan many objects/properties
-> observations are routed to queues
```

Problem:

The receiver often re-discovers the changed data by applying/exporting/importing
state. The authority already knew the changed rows when it applied the
transcript.

### Cold Holder Boot

Current sequence:

```text
load local SQL
-> fetch host seed, often from KV
-> mergeHostScopedSeedWithStatus
-> createWorldFromSerialized
-> run local catalog lifecycle
-> export/import/merge again
-> saveFullIfNeeded may single-flight concurrent opens behind saveFull
-> saveFull rewrites world rows plus accepted/transcript tails
-> persist full snapshot if changed
```

Problem:

The seed path is a repair and bootstrap path, but it is on cold user-visible
operations. Even when KV makes the bytes fast, receiver-side reconstruction and
merge remain expensive and error-prone.

## Simplified End State

There are only four durable concepts. The extra types below are either
projection rows inside that model (`ToolSurfaceProjectionRow`) or transport
envelopes (`FanoutEnvelope`), not a fifth authority store.

```ts
type AcceptedTurnFrame = {
  kind: "woo.accepted_turn_frame.v1";
  position: ShadowScopeHead;
  prior: ShadowScopeHead;
  transcript: EffectTranscript;
  receipt: ShadowCommitAccepted["receipt"];
  projection_delta?: ProjectionDeltaSummary;
};

type ProjectionDeltaSummary = {
  objects?: RowOp<ObjRef>[];
  sessions?: RowOp<string>[];
  logs?: RowOp<{ space: ObjRef; seq: number }>[];
  counters?: RowOp<CounterKey>[];
  snapshots?: RowOp<{ space: ObjRef; seq: number }>[];
  parked_tasks?: RowOp<string>[];
  tombstones?: RowOp<ObjRef>[];
  tool_surfaces?: RowOp<{ scope: ObjRef; object: ObjRef }>[];
  tool_surface_sources?: RowOp<{ table: "objects"; authority_scope: ObjRef; key: ObjRef }>[];
  projection_bytes: number;
};

type RowOp<Key> = { key: Key; op: "upsert" | "delete"; bytes: number };
type CounterKey = "objectCounter" | "sessionCounter" | "parkedTaskCounter";

type ScopeCheckpoint = {
  kind: "woo.scope_checkpoint.v1";
  scope: ObjRef;
  head: ShadowScopeHead;
  checkpoint_hash: string;
  pages: ProjectionPage[];
  frame_tail: AcceptedTurnFrame[];
};

type ProjectionPage =
  | {
      kind: "woo.projection_page.v1";
      table: "objects";
      page: string;
      hash: string;
      rows: SerializedObject[];
    }
  | {
      kind: "woo.projection_page.v1";
      table: "sessions";
      page: string;
      hash: string;
      rows: SerializedSession[];
    }
  | {
      kind: "woo.projection_page.v1";
      table: "logs";
      page: string;
      hash: string;
      rows: Array<{ space: ObjRef; entry: SpaceLogEntry }>;
    }
  | {
      kind: "woo.projection_page.v1";
      table: "snapshots";
      page: string;
      hash: string;
      rows: SpaceSnapshotRecord[];
    }
  | {
      kind: "woo.projection_page.v1";
      table: "parked_tasks";
      page: string;
      hash: string;
      rows: ParkedTaskRecord[];
    }
  | {
      kind: "woo.projection_page.v1";
      table: "tombstones";
      page: string;
      hash: string;
      rows: Array<{ id: ObjRef }>;
    }
  | {
      kind: "woo.projection_page.v1";
      table: "tool_surfaces";
      page: string;
      hash: string;
      rows: ToolSurfaceProjectionRow[];
    };

type ToolSurfaceProjectionRow = {
  kind: "woo.tool_surface_projection.v1";
  scope: ObjRef;
  object: ObjRef;
  head: ShadowScopeHead;
  verbs: Array<{
    name: string;
    owner: ObjRef;
    perms: string;
    args?: unknown[];
    help?: string;
  }>;
  source_rows: Array<{ table: "objects"; authority_scope: ObjRef; key: ObjRef }>;
};

type FanoutEnvelope = {
  frame: AcceptedTurnFrame;
  fanout_observations: EffectTranscript["observations"];
  projection_delta: ProjectionDeltaSummary;
  projection_writes: ProjectionWrite[];
};

type AcceptedFrameTransfer = {
  frame: AcceptedTurnFrame;
  projection_writes: ProjectionWrite[];
};

type SessionToolManifest = {
  kind: "woo.session_tool_manifest.v1";
  session_id: string;
  actor: ObjRef;
  active_scope: ObjRef;
  tools: RemoteToolDescriptor[];
  source_surfaces: Array<{ scope: ObjRef; object: ObjRef; head: ShadowScopeHead }>;
  last_apply_seq: number;
  last_apply_hash: string;
  updated_at_ms: number;
  expires_at_ms: number;
  stale?: boolean;
  stale_reason?: "owner_timeout" | "retention_gap" | "cache_miss" | "disabled";
};

type ExecutionCapsule = {
  kind: "woo.execution_capsule.v1";
  scope: ObjRef;
  head: ShadowScopeHead;
  actor: ObjRef;
  session: string;
  target: ObjRef;
  verb: string;
  authority: SerializedAuthorityCellSlice;
  expires_at_ms: number;
};
```

`AcceptedTurnFrame` is the authoritative append. Projection rows are the
materialized state. A checkpoint is a batched export of projection rows at one
head plus the retained frame tail. There is no general `doc(hash, body)` store
in the first implementation.

`ProjectionDeltaSummary` is the compact index of what changed. It is not enough
by itself for normal receiver updates. `projection_writes` carry the touched
upsert row bodies and delete keys from the same `ApplyResult` pass that updated
SQL. Fanout and tail transfer co-ship those row bodies so receivers do not
replace compatibility scans with per-row fetches. If a transfer cannot fit the
row bodies within its byte budget, it must fall back to a checkpoint or mark the
projection refresh incomplete; it must not issue an unbounded sequence of row
pulls on the hot path.

`SerializedWorld` is no longer a hot-path invariant. It is a boundary export
format and a lazy cache derived from indexed state or projection rows when a
legacy boundary requires it. Keeping `scope.serialized` eagerly in sync after
each accepted turn is explicitly out of design.

The gateway's local state is the same projection-row model: object rows,
session rows, tool-surface rows, and scope heads keyed in SQL or maps. The
gateway does not hold an executable `WooWorld` for normal tool listing,
routing, or accepted fanout.

`SessionToolManifest` is the availability boundary for MCP tool listing. Once a
session has received a descriptor, owner timeouts and cache misses cannot make
that descriptor disappear from the same session's manifest. A stale descriptor
may be marked stale and refreshed asynchronously; it is removed only when an
accepted projection delta says the object or verb is gone, the active scope
changes, or the manifest expires. This directly addresses the observed
`E_VERBNF` smoke failures where reachable tools disappeared during a cold
descriptor refresh.

`ExecutionCapsule` is the one-turn VM sufficiency transfer. It is not a
checkpoint and not a descriptor cache. It contains the minimum authority cells
needed to execute one requested verb: actor row, session row, target row,
location/contents rows needed by the call, resolved inheritance/verb rows,
permission rows, and counter/version cells required by create/recycle. A node
that only lists tools should never request an execution capsule; a node that is
catching up durable state should use checkpoint/tail instead.

The transcript is the only durable observation body in the accepted frame.
`fanout_observations` belongs to the transport envelope, not the frame. It is
derived from `frame.transcript.observations` after audience/routing filters and
must never be persisted as a second authority copy.

Hashes are fixed now: every `ProjectionPage` carries a `hash`, and every
`ScopeCheckpoint` carries a `checkpoint_hash`. Both are
`sha256(stableShadowJson(...))` integrity hashes over the payload being
installed. They are not content-addressed storage keys and are not used for
per-hash document pull in this iteration.

The applier has one hot-path return value:

```ts
type ApplyResult = {
  accepted_frame: AcceptedTurnFrame;
  projection_delta: ProjectionDeltaSummary;
  projection_writes: ProjectionWrite[];
  fanout_observations: EffectTranscript["observations"];
  reply_rows: ShadowEnvelope<ShadowEnvelopeReplyBody>[];
  idempotency_rows: Array<{ idempotency_key: string; seen_at: number }>;
};

type ProjectionWrite =
  | { table: "objects"; key: ObjRef; op: "upsert"; row: SerializedObject; bytes: number }
  | { table: "objects"; key: ObjRef; op: "delete"; bytes: 0 }
  | { table: "sessions"; key: string; op: "upsert"; row: SerializedSession; bytes: number }
  | { table: "sessions"; key: string; op: "delete"; bytes: 0 }
  | { table: "logs"; key: { space: ObjRef; seq: number }; op: "upsert"; row: SpaceLogEntry; bytes: number }
  | { table: "logs"; key: { space: ObjRef; seq: number }; op: "delete"; bytes: 0 }
  | { table: "snapshots"; key: { space: ObjRef; seq: number }; op: "upsert"; row: SpaceSnapshotRecord; bytes: number }
  | { table: "snapshots"; key: { space: ObjRef; seq: number }; op: "delete"; bytes: 0 }
  | { table: "parked_tasks"; key: string; op: "upsert"; row: ParkedTaskRecord; bytes: number }
  | { table: "parked_tasks"; key: string; op: "delete"; bytes: 0 }
  | { table: "counters"; key: CounterKey; op: "upsert"; value: number; bytes: number }
  | { table: "tombstones"; key: ObjRef; op: "upsert"; row: { id: ObjRef }; bytes: number }
  | { table: "tombstones"; key: ObjRef; op: "delete"; bytes: 0 }
  | { table: "tool_surfaces"; key: { scope: ObjRef; object: ObjRef }; op: "upsert"; row: ToolSurfaceProjectionRow; bytes: number }
  | { table: "tool_surfaces"; key: { scope: ObjRef; object: ObjRef }; op: "delete"; bytes: 0 };
```

This is not a hidden emitter. `projection_writes` are the rows already being
changed by applying the transcript and known runtime side channels. If building
this result requires exporting a `SerializedWorld`, scanning all objects after
apply, or reconstructing an authority slice, the implementation is off-design.

The `op` field is required. Receivers must be able to update or evict cache
entries without refetching every named row to discover deletion. Within one
delta, entries are coalesced to at most one `{ table, key }` operation. Recycle
therefore becomes `objects/delete` plus `tombstones/upsert`; an object upsert
and delete for the same id in the same table is invalid.

## End-State Sequences

### Durable Commit

Target sequence:

```text
/v2/envelope
-> execute or plan turn
-> build EffectTranscript
-> validate against ShadowCommitScopeState
-> apply transcript once
-> collect applier-local row ops
-> caller folds named side-channel row ops
-> mark SerializedWorld cache dirty, do not materialize it
-> SQL transaction:
     insert accepted frame
     update touched projection rows
     append new tail rows only
     update scope head
     write reply/idempotency rows
-> route fanout_observations
```

The key requirement is the delta source. If producing `ProjectionDeltaSummary`
requires scanning the world after apply, the design has failed. It is built from
two explicit inputs:

- Applier output from `applyShadowTranscriptToIndexedState`: object
  creates/writes/deletes known through `objectsById`, session active-scope
  updates known through `sessionsById`, log entries known through `logsByScope`,
  and counter bumps known from transcript creates.
- Caller side channels that do not currently live inside
  `applyShadowTranscriptToIndexedState`: snapshot writes, parked-task
  upserts/deletes, tombstone upserts/deletes, tool-surface projection
  invalidations, reply rows, and idempotency rows. Snapshot/task/tombstone/tool
  changes are folded into `ProjectionDeltaSummary`; reply and idempotency rows
  stay in `ApplyResult` but are not projection state.

For today, the delta may be coarse:

```text
touched object rows, touched session row, log row, counter flag, named
side-channel rows, projection_bytes
```

That is enough to remove receiver rediscovery. Row-level property/verb/edge
deltas can come later only if measurements show whole-object row writes remain
material.

The normal commit path must not call `serializedWorldFromCommitScopeState`.
That call is allowed only inside explicit export/checkpoint/diagnostic
boundaries, and those boundaries must emit their own metrics.

Reply envelopes are not projection state. Persisting every recent reply in SQL
buys post-hibernate idempotent retry, but costs one hot-path row per committed
envelope. Step 4 must measure replay-hit rate. If post-hibernate retry is rare,
move replies to TTL KV or accept a higher-layer `woo_wait`/idempotency recovery
path; do not leave an unmeasured SQL write in the steady-state commit path.

### Remote Fanout

Target sequence:

```text
authority FanoutEnvelope
-> remote holder/gateway projection cache
-> enqueue observations
-> if holder maintains a projection cache:
     apply inline projection_writes
     evict named delete rows
```

No gateway export/apply/import boundary. No object/property scan to learn what
changed. The authority tells receivers the row keys touched by the accepted
turn.

Normal fanout is row-body complete: every upsert named by
`projection_delta` has a corresponding `projection_writes` row body in the same
`FanoutEnvelope`, and every delete has a delete op. This is the lower-bound data
path: the authority already serialized the touched row for local persistence, so
the receiver should install that same payload. Fetch-by-key is allowed only for
repair, explicit refresh, or oversized exceptional deltas; it is not the normal
fanout protocol.

Cutover is deliberately non-atomic. A receiver uses `projection_delta` when the
sender includes it. If it is absent, it falls back to the current compatibility
scan. Step 2 can therefore ship before every gateway and holder is upgraded;
Step 5 is complete only when fresh smoke shows the fallback path is no longer
used for normal accepted fanout.

When `projection_delta` is present, the gateway must not call `runShadowApply`
or `buildGatewayApplyTarget` for accepted fanout. It consumes the delta into its
projection-row cache. Keeping both paths alive "for safety" preserves the
write amplification this design is removing.

Every hot-path cross-host request that feeds tool listing, routing, or fanout
must have a same-host fallback. If a target DO is cold or times out, the caller
returns last-known projection rows from the gateway cache, Directory, or KV and
marks the data stale for later fanout reconciliation. A cold target is a
freshness problem, not an availability failure for descriptor reads.

### Cold Open

Target sequence:

```text
receiver: open(scope, known_head)
authority:
  if known_head within retained tail and response fits the transfer budget:
      return accepted frame transfers after known_head
  else:
      return last complete ScopeCheckpoint, or build one within budget
receiver:
  install tail projection writes, route only new observations, or install checkpoint pages
  rehydrate execution view only if this node will execute
```

There is no per-hash missing-doc protocol in the first design. Cold open is a
bounded batch:

- Retain accepted frames and transcripts per the Cloudflare bounds above:
  newest-first up to 1,000 entries, 16 MiB, and 7 days, with pruning allowed only
  after a complete checkpoint covers the pruned prefix.
- Use a tail response only when the receiver is missing at most 200 frames, the
  accepted frame transfers include all projection row bodies, and the encoded
  response is at most 512 KiB.
- Otherwise return the last complete `ScopeCheckpoint`, paged by table with a
  continuation cursor only when the checkpoint response would exceed 512 KiB.

Tail frame transfers are still-to-install and include `projection_writes`.
`ScopeCheckpoint.pages` are already complete at `ScopeCheckpoint.head`;
`ScopeCheckpoint.frame_tail` is already applied into those pages and exists only
to seed the receiver's future catch-up cache. A receiver that installs a
checkpoint must not replay `frame_tail` or route its historical observations.

Checkpoint build is the successor to `saveFull`, but it is not an open-request
primitive. A commit may mark the checkpoint stale and an alarm or post-commit
maintenance slice builds the next checkpoint incrementally. Concurrent opens use
the last complete checkpoint plus tail frames; they do not wait for a large scan,
serialize, and hash pass.

This avoids replacing 5,746 inline pages with many small round trips. It also
keeps checkpoint sizing visible: `checkpoint_bytes`, `projection_page_count`,
`frame_tail_count`, and `round_trips`.

### Tool List

Target sequence:

```text
woo_list_reachable_tools
-> read session/actor projection rows
-> read SessionToolManifest for monotonic session-visible descriptors
-> read reachable object projection rows
-> read or request ToolSurfaceProjectionRow rows
-> return descriptors
```

Tool listing does not open a VM execution scope. The persisted projection is
`ToolSurfaceProjectionRow`, keyed by `{ scope, object }`. It contains the
resolved callable verb descriptors for that object plus `source_rows`, the
object rows whose parent/verb/feature state contributed to the projection.
Actor/session reachability remains a read-time filter; the row is not keyed by
actor. Receivers invalidate cached rows from source-row markers or small
per-object deltas. Until the persisted table lands, a holder may compute the row
once per request from local projection rows, but that fallback must report
bytes/time and must not open executable state.

`ToolSurfaceProjectionRow` must live somewhere the caller can read without
waking the owner DO on the hot path. The initial home is the gateway projection
cache; Directory or KV can be added later if the cache needs cross-gateway
sharing. Remote owner computation is a refresh path, not the normal list-tools
path.

The gateway maintains a `SessionToolManifest` per active MCP session. Tool-list
responses are monotonic within that session: a remote owner timeout may mark a
descriptor stale, but it cannot turn a previously listed reachable tool into
`E_VERBNF`. A `woo_call` using a stale descriptor carries the descriptor's
surface head/version. If the authority rejects it as stale, the gateway refreshes
the relevant surface and retries once; only an authoritative delete or verb
removal becomes a user-visible not-found error.

Cold-cold tool list is intentionally not claimed as fixed by this design. The
first tool list for a session/scope with no manifest and no local projection rows
may still pay a bounded owner refresh. The win is warm and stale-warm stability:
after the first manifest exists, owner unavailability degrades freshness rather
than tool existence.

### Host Seed

Target sequence for now:

```text
keep bytecode-free KV seed as bootstrap/cache
remove user-visible receiver merge/persist work from normal cold operations
use checkpoint/open path for scope state once implemented
```

Do not retire KV seed cache as part of this note. It is already a measured
optimization. The simplified design only says that normal user operations
should not rely on seed merge as their state-transfer mechanism.

## Observed Operation Sequences

Every observed smoke `direct_call` should reduce to one accepted frame plus the
projection rows named below. Current cold-open/setup costs may happen before
the call today, but they are not part of the operation's lower bound.

| Trace | Current dataflow shape | Simplified dataflow shape |
|---|---|---|
| `the_chatroom:enter` | resolve tool, cold-open or reuse chatroom execution view, execute enter/move, apply transcript, save touched object/session rows, fan out, receiver may compatibility-apply and scan | accepted frame; `fanout_observations`; actor object upsert; room contents object upsert; session active-scope upsert; fanout carries frame plus those row ops |
| `the_chatroom:say` | resolve tool, execute say, route observation, maybe fan out live/accepted payload | accepted frame plus `fanout_observations` only unless chat is made durable by catalog data; no projection write is required for ordinary live chat |
| `the_chatroom:southeast` | execute move chain, transcript records move plus write facts, save rows, fan out, receiver may rediscover changed rows | accepted frame; actor object row; source contents row; destination contents row; session active-scope row; move/write facts coalesce to one projection update set |
| `the_deck:west` | same as chatroom move under deck authority, with deck cold-open and fanout costs when not warm | same move projection delta under deck authority; no authority-slice reconstruction |
| `the_outline:enter` | enter outline, subscriber/session state changes, observations, possible remote descriptor refresh | accepted frame; actor/session rows; subscriber or contents row only if changed; tool-surface refresh consumes projection delta |
| `the_outline:add_item` | create item, write object/properties/container state, observations, fanout/receiver apply | accepted frame; created item object row; outline container row; observations; split property rows later only if whole-object row size remains material |
| `the_outline:leave` | leave outline, session/subscriber updates, observations, possible compatibility apply | accepted frame; actor/session rows; subscriber or contents row only if changed |
| `the_horoscope:next_pending` | execute block queue check; observed trace has no observations | accepted frame only unless queue/session projection state changes |
| `the_horoscope:set_properties` | self-hosted block sets object properties; current row model can rewrite the object row | accepted frame plus touched object upsert now; record `projection_bytes` for the object row; introduce row-level property projection only if this trace or its successor remains byte-heavy after broad transforms are gone |

This is intentionally coarse. The first win is removing broad transformations,
not forcing every operation into a fine-grained document vocabulary.

The same rule covers non-verb metric surfaces observed in the smoke logs:

| Metric surface | Simplified sequence |
|---|---|
| `v2_open` / `v2_open_step` / `shadow_open_executable_seed_bytes` | negotiate `known_head`; return tail frames or one checkpoint batch; continuation only when over byte budget; checkpoint build cannot block concurrent opens beyond the measured wait budget |
| `shadow_apply_step` | apply transcript once and return `ApplyResult`; do not run a second export/emit pass; do not materialize full `SerializedWorld` |
| `shadow_gateway_apply_step` | removed from normal fanout; receiver consumes accepted frame and `ProjectionDeltaSummary`; no gateway `WooWorld` apply |
| `storage_full_save` | removed from `/v2/envelope` and warm `/v2/open`; retained for one-time bootstrap, checkpoint build, diagnostics, or migration only; never rewrites append-mostly tails |
| `cross_host_rpc /__internal/enumerate-tools` | read tool-surface projection rows from same-host cache first; cold owner timeout returns last-known stale data instead of failing the smoke path |
| `cross_host_rpc /__internal/authority-slice` | split by purpose: descriptor reads use projection rows/manifests, execution sufficiency uses `ExecutionCapsule`, and cold state install uses checkpoint/tail |
| `cross_host_rpc /__internal/apply-v2-commit` | send accepted frame, projection delta, and touched rows needed by the receiver; gateway consumes rows directly |
| `session_reap` | measurement hygiene: one metric per sweep with reaped count, emitted only when count is nonzero |

## What Gets Removed

The simplified design removes these costs directly:

- `/v2/open` as an executable seed transfer for normal catch-up;
- cold-open `saveFull`;
- eager `SerializedWorld` materialization on every accepted commit;
- gateway `shadow_gateway_apply_step` scans;
- gateway-side executable `WooWorld` mirrors for projection reads;
- receiver state rediscovery after fanout;
- tool-list cold opens for descriptor-only work;
- full-tail rewrites for append-only accepted frames/transcripts;
- host seed merge as a normal user-operation state transfer.

It does not require:

- a generic immutable `doc` table;
- row-level content addressing;
- per-property documents on day one;
- missing-doc pull by individual hash;
- replacing current SQL projection rows before the transforms are gone.

## Cross-Cutting Gates

Every implementation step has four gates before it is considered complete:

1. A rollback flag, named in the step, defaults off in production until the
   step's tests pass and the smoke tail is clean. The flag must disable only
   that step.
2. Vitest coverage lands with the code. The test must fail if the old
   user-visible or data-path behavior returns.
3. Spec alignment lands with the code. The step names the normative spec files
   it changes before implementation starts.
4. Migration assessment is explicit. Each step says either "no Cloudflare DO
   class migration" or names the `cf-do-NNNN` class-binding migration. SQL
   schema additions inside an existing DO use idempotent `CREATE TABLE IF NOT
   EXISTS` / `ALTER TABLE` guards and are tested separately; they do not by
   themselves require a Cloudflare DO class migration tag.

Each behavior-changing step also gets a rollback invariant before flag-on code
is removed: a vitest and a smoke-tail invariant that pass with the flag off and
fail if the flag-on path leaks through. A rollback flag that leaves partial
state active is a failed step, even if the forward path works.

Freshness is also explicit. Every projection cache row carries:

```ts
type ProjectionFreshness = {
  scope: ObjRef;
  last_apply_seq: number;
  last_apply_hash: string;
  updated_at_ms: number;
  stale: boolean;
  stale_reason?: "owner_timeout" | "retention_gap" | "cache_miss" | "disabled";
};
```

Read sites define budgets:

| Read site | Freshness budget |
|---|---|
| Tool listing/descriptors | May return stale rows up to 5 minutes old with `stale:true`; must schedule refresh; must preserve the session's existing manifest until authoritative removal or expiry. |
| Session routing/fanout queues | May use stale session/object rows only for delivery hints; authoritative scope head still comes from accepted frame or Directory. |
| Auth, permissions, account binding | Must not use stale projection rows. These stay on existing authoritative paths until a separate identity projection spec exists. |
| VM execution/planning | Must not use gateway projection cache. It uses `CommitScopeDO` state or an explicit checkpoint/tail execution view. |

Tail retention is per scope and bounded by count, bytes, and age. High-volume
scopes may fall to checkpoint more often; that is acceptable if checkpoint
transfer stays bounded and opens do not build checkpoints synchronously.

## Cloudflare Durable Object Bounds

The production shape is constrained by the platform, so these are design rules,
not implementation tunables:

| Constraint | Design rule |
|---|---|
| SQLite-backed DO storage is finite per object; SQL row/string/blob values are capped. | One commit scope maps to one `CommitScopeDO`. Tail, checkpoint, reply, and projection storage are byte-budgeted per scope and per DO. Any later multi-scope DO must prove the same budgets before it lands. |
| Worker memory is finite and DO hibernation clears memory. | Gateway projection cache and session tool manifests are persisted in gateway DO SQL. In-memory maps are read-through accelerators only. |
| CPU is active time and defaults to a bounded per-request budget; alarms have longer wall time. | `/v2/open` packages an existing checkpoint/tail only. Checkpoints are built incrementally after commits or by alarm, never by scanning and hashing a large scope inside the open request. |
| Paid Workers allow many subrequests, but KV and free/internal-service limits are tighter. | Hot descriptor paths are local-first, host-batched, and capped. Overflow returns stale manifest rows and schedules refresh; it does not fan out one request per object. |
| KV is eventually consistent and rate-limited per key. | KV remains bootstrap/cache only. Authority, tool surfaces, session manifests, and checkpoints live in DO SQL; KV can hold immutable/content-addressed artifacts or slow-changing shared hints only. |

Concrete budgets:

- Tail retention per scope is bounded by count, bytes, and age: retain at most
  1,000 accepted frames/transcripts, at most 16 MiB encoded tail bytes, and at
  most 7 days. Prune only after a complete checkpoint exists for the pruned
  prefix. A hot scope may fall to checkpoint more often; an idle scope does not
  keep ancient tails forever.
- Checkpoint and projection pages are byte-bounded. Target page body size is
  512 KiB; a single row larger than that becomes its own page. A serialized
  projection row approaching the SQL row limit is non-conforming and must be
  split or moved to an external blob-style storage contract before it can be
  written.
- `/v2/open` has a packaging budget, not a build budget: it may spend at most
  250ms wall time assembling already persisted checkpoint/tail rows. If no
  usable checkpoint exists, it schedules checkpoint build and returns
  `E_CHECKPOINT_PENDING`; rollout may retry legacy fallback, but the end state
  treats missing checkpoint as a bootstrap violation.
- Tool-list owner refresh is capped per request by host count and byte budget.
  The initial cap is 32 remote owners or 256 KiB of descriptor-refresh payload,
  whichever comes first.
- Tool-surface reverse indexes are capped because source-row fanout is
  multiplicative in visible objects and inherited classes. Step 8 must measure
  `gateway_tool_surface_source_rows` per active room before it is complete. The
  initial guard is 10,000 source rows per active scope or 40,000 per gateway
  shard. On cap hit, the gateway marks the scope saturated, stops persisting new
  source-index rows for that scope, serves the session manifest, and recomputes
  tool surfaces on read from local projection rows or owner refresh.

## Gateway Projection Cache

Step 5 replaces the gateway's accepted-fanout mirror world with a projection
cache. The cache lives in the existing gateway `PersistentObjectDO` SQLite
database so it survives hibernation; in-memory maps are optional accelerators
rebuilt from SQL. No new Cloudflare DO class is required for the initial
version. This deliberately moves accepted-fanout maintenance into gateway SQL
writes; those writes are the replacement for `runShadowApply` and must be
reported as `gateway_projection_rows_written` and `gateway_projection_bytes`.

Initial tables:

```sql
CREATE TABLE IF NOT EXISTS gateway_projection_scope (
  scope TEXT PRIMARY KEY,
  head_seq INTEGER NOT NULL,
  head_hash TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0,
  stale_reason TEXT
);

CREATE TABLE IF NOT EXISTS gateway_projection_object (
  id TEXT NOT NULL,
  authority_scope TEXT NOT NULL,
  body TEXT NOT NULL,
  last_apply_seq INTEGER NOT NULL,
  last_apply_hash TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0,
  stale_reason TEXT,
  PRIMARY KEY(authority_scope, id)
);

CREATE TABLE IF NOT EXISTS gateway_scope_member (
  scope TEXT NOT NULL,
  id TEXT NOT NULL,
  authority_scope TEXT NOT NULL,
  role TEXT NOT NULL,
  last_apply_seq INTEGER NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  PRIMARY KEY(scope, id, role)
);

CREATE TABLE IF NOT EXISTS gateway_projection_session (
  session_id TEXT PRIMARY KEY,
  scope TEXT,
  actor TEXT NOT NULL,
  body TEXT NOT NULL,
  last_apply_seq INTEGER NOT NULL,
  last_apply_hash TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0,
  stale_reason TEXT
);

CREATE TABLE IF NOT EXISTS gateway_tool_surface (
  scope TEXT NOT NULL,
  object TEXT NOT NULL,
  object_authority_scope TEXT NOT NULL,
  body TEXT NOT NULL,
  last_apply_seq INTEGER NOT NULL,
  last_apply_hash TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0,
  stale_reason TEXT,
  PRIMARY KEY(scope, object)
);

CREATE TABLE IF NOT EXISTS gateway_session_tool_manifest (
  session_id TEXT PRIMARY KEY,
  actor TEXT NOT NULL,
  active_scope TEXT NOT NULL,
  body TEXT NOT NULL,
  last_apply_seq INTEGER NOT NULL,
  last_apply_hash TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL,
  expires_at_ms INTEGER NOT NULL,
  stale INTEGER NOT NULL DEFAULT 0,
  stale_reason TEXT
);

CREATE TABLE IF NOT EXISTS gateway_tool_surface_source (
  scope TEXT NOT NULL,
  source_table TEXT NOT NULL,
  source_authority_scope TEXT NOT NULL,
  source_key TEXT NOT NULL,
  object TEXT NOT NULL,
  PRIMARY KEY(scope, source_table, source_authority_scope, source_key, object)
);
```

Object rows are keyed by their authority scope, not by the observer scope that
happened to need them. `gateway_scope_member` records why a row is relevant to a
scope or session. This avoids minting multiple gateway copies of the same object
when it moves between scopes or is visible through more than one projection.

Lifecycle:

- On accepted fanout with `projection_delta`, the gateway upserts/deletes the
  named projection rows, updates `gateway_projection_scope`, invalidates any
  tool-surface rows whose `source_rows` mention changed source rows, and routes
  `fanout_observations`.
- On hibernation, SQL rows survive. On rehydrate, the gateway does not rebuild
  a `WooWorld`; it reads projection rows lazily.
- On cache miss, the gateway first returns any bounded-stale data it has for
  descriptor reads, marks the result stale, and schedules owner refresh. If the
  session has a `gateway_session_tool_manifest`, it returns that manifest rather
  than an empty list. Stale-empty descriptor results are allowed only before a
  session has ever received a manifest. Auth/permission/execution reads must
  escalate to authoritative paths.
- Eviction is LRU by `updated_at_ms`, capped initially at 32 MiB encoded row
  bytes or 50,000 rows per gateway shard, whichever comes first. Rows for
  attached sessions, their manifests, and their active scopes are pinned for the
  session grace window.
- If pinned active-scope rows would exceed the reverse-index cap, the active
  scope stays pinned but its source index becomes saturated. Saturated scopes use
  read-time recompute and owner refresh; they do not grow the reverse index until
  rows fall below the cap.

Current gateway `WooWorld` consumers and disposition:

| Consumer | Disposition |
|---|---|
| MCP tool listing and tool resolve | Projection cache only. No owner DO cold-open on the hot path. |
| Accepted fanout and observation routing | Consume `FanoutEnvelope` plus projection cache/session rows. No gateway `runShadowApply`. |
| Session route registration/rebind | Directory remains authoritative; gateway mirrors session projection rows for local reads. |
| Gateway cache refresh/list-changed decisions | Use `ProjectionDeltaSummary` and `ToolSurfaceProjectionRow.source_rows`. |
| Auth, account binding, API-key revocation, wizard operations | Stay on existing authoritative gateway-world paths until a separate identity projection spec exists. They must not use stale projection rows. |
| VM execution/planning | Never uses gateway projection cache. It uses `CommitScopeDO` state or an explicit execution checkpoint/tail. |
| REST legacy/in-process fallback | Remains behind legacy flags until replaced by the v2 path; it is not allowed to justify keeping gateway fanout mirror apply. |

Step 5 is not complete while any normal accepted-fanout path keeps a gateway
mirror `WooWorld` current "just in case." Legacy auth/world-host state may still
exist, but it must not be fed by accepted fanout for projection maintenance.

## Checkpoint/Tail Open Schema

Step 7 replaces normal `/v2/open` executable seed transfer with an explicit
checkpoint/tail protocol. The new request extends the existing authenticated
CommitScopeDO open body; the existing session/auth fields remain unchanged.

```ts
type CommitScopeOpenCheckpointTailRequest = CommitScopeBaseRequest & {
  open_protocol: "checkpoint_tail.v1";
  known_head?: ShadowScopeHead | null;
  transfer_budget_bytes?: number; // default 512 KiB, max 1 MiB
  max_tail_frames?: number;       // default 200, max 200
};

type CommitScopeOpenCheckpointTailResponse = {
  ok: true;
  open_protocol: "checkpoint_tail.v1";
  relay: string;
  head: ShadowScopeHead;
  transfer: OpenTransfer;
};

type OpenTransfer =
  | {
      kind: "frames";
      from: ShadowScopeHead;
      to: ShadowScopeHead;
      frames: AcceptedFrameTransfer[];
      continuation?: OpenContinuation;
    }
  | {
      kind: "checkpoint";
      checkpoint: ScopeCheckpoint;
      continuation?: OpenContinuation;
    };

type OpenContinuation = {
  token: string; // opaque, expires quickly, bound to scope/head/protocol/export
  export_id: string;
  head: ShadowScopeHead;
  checkpoint_hash?: string;
  expires_at_ms: number;
};
```

Negotiation and cutover:

- A caller opts in with `open_protocol:"checkpoint_tail.v1"`. If absent,
  `CommitScopeDO` returns the current legacy `/v2/open` response.
- The rollout flag `WOO_V2_CHECKPOINT_TAIL_OPEN` controls whether the gateway
  sends the new field. A per-client or per-scope allow-list may sit behind that
  flag; the server contract is body-field negotiation.
- A frames response is returned only if `known_head` is within retained tail,
  the missing tail is at most 200 frames, every returned frame includes its
  `projection_writes`, and encoded response size is within
  `transfer_budget_bytes`.
- A checkpoint response is returned otherwise. Checkpoint pages are complete at
  `checkpoint.head`; included `frame_tail` is already applied and must not be
  replayed.
- `/v2/open` does not build checkpoints synchronously. If the last complete
  checkpoint is stale but still covered by retained tail, the response returns
  that checkpoint plus tail. If no usable checkpoint exists, the server schedules
  a checkpoint build and returns `E_CHECKPOINT_PENDING`; the gateway may retry
  legacy fallback only while the rollout flag allows it.
- Continuations are for byte budget only, not per-hash missing documents. A
  continuation resumes the same checkpoint export or frame batch. The
  `export_id`, `head`, and optional `checkpoint_hash` pin snapshot identity; if
  that export is unavailable, the server returns `E_CHECKPOINT_CONTINUATION_STALE`
  and the receiver retries without `known_head`.

Backward compatibility:

- Legacy `SerializedWorld` export remains for diagnostics and fallback while
  the flag is off.
- A receiver that cannot parse `checkpoint_tail.v1` must not receive it.
- A receiver that gets `E_CHECKPOINT_TOO_OLD` or an expired continuation retries
  with no `known_head` and receives a fresh checkpoint.

## Tool-Surface Invalidation

Step 8 stores `ToolSurfaceProjectionRow` as a projection row, but invalidation
is observed-side in the gateway cache, not sender-side in `CommitScopeDO`.
`CommitScopeDO` does not know which tool surfaces a gateway has read.

Rule:

1. When the gateway computes or refreshes a `ToolSurfaceProjectionRow`, it
   records every contributing object row in `source_rows` and writes reverse
   index rows to `gateway_tool_surface_source`.
2. When accepted fanout changes a small set of object rows, the gateway looks up
   `gateway_tool_surface_source(scope, "objects", authority_scope, changed_id,
   *)`, deletes or marks stale those `gateway_tool_surface` rows, and removes
   their reverse index entries.
3. When a class, feature, or ancestor edit would invalidate more than 256 tool
   surfaces or more than 64 KiB of `tool_surfaces` delta, the authority emits one
   `tool_surface_sources` invalidation marker keyed by the changed source row
   instead of per-descendant row ops. Each gateway expands that marker against
   its local reverse index and marks only locally cached surfaces stale.
4. The next tool-list read recomputes the row from local projection rows if all
   source rows are present and fresh enough. If not, it returns bounded-stale
   data and schedules owner refresh.

`source_rows` must include the resolved method-resolution path: the object row,
its class/parent rows that contribute inherited verbs, and any feature rows
used by tool exposure. A descendant override is naturally stable: if a parent
verb row changes but the descendant's resolved tool surface did not include
that parent row because of an override, the reverse index does not invalidate
the descendant row. If a class/parent link changes, every cached row whose
`source_rows` references the changed object row is invalidated; recomputation
re-walks the inheritance chain and records the new source set.

## Implementation Plan

The first stability milestone is not Step 1 alone. Lazy `SerializedWorld`
materialization removes real CPU work, but the fresh production failures are
dominated by MCP wall time, missing reachable tools, RPC timeouts, full saves,
and cold open transfer. The first milestone therefore ships the smallest
availability-safe slice across steps: measurement hygiene, row-body-complete
fanout/tail transfer, session-monotonic tool manifests, append-only tails, and
checkpoint/tail open. Step 1 may land independently, but it is not a sufficient
success criterion for smoke stability. Step 4 reply persistence is explicitly
outside the first milestone.

| Step | Rollback flag | Spec files | Migration |
|---:|---|---|---|
| 0 | `WOO_V2_METRIC_HYGIENE` | `spec/operations/observability.md` | No Cloudflare DO class migration. |
| 1 | `WOO_V2_LAZY_SERIALIZED_WORLD` | `spec/semantics/distribution.md`; `spec/protocol/v2-turn-network.md`; `spec/reference/persistence.md` | No Cloudflare DO class migration; no SQL migration. |
| 2 | `WOO_V2_APPLY_RESULT` | `spec/semantics/distribution.md`; `spec/protocol/v2-turn-network.md` | No Cloudflare DO class migration; no SQL migration. |
| 3 | `WOO_V2_APPEND_ONLY_TAIL` | `spec/reference/persistence.md`; `spec/protocol/v2-turn-network.md`; `spec/reference/cloudflare.md` | No Cloudflare DO class migration; idempotent meta/high-water SQL if needed. |
| 4 | `WOO_V2_REPLY_REPLAY_METRICS`; `WOO_V2_REPLY_KV` | `spec/protocol/v2-turn-network.md`; `spec/operations/observability.md` | No Cloudflare DO class migration; no SQL migration unless reply metadata columns are added. |
| 5 | `WOO_GATEWAY_PROJECTION_CACHE` | `spec/protocol/mcp.md`; `spec/protocol/v2-turn-network.md`; `spec/reference/persistence.md`; `spec/semantics/projection-cache.md` | No new Cloudflare DO class unless a later ProjectionCacheDO is introduced; initial tables are existing-DO SQL. |
| 6 | `WOO_V2_SAME_HOST_STALE_FALLBACK` | `spec/semantics/projection-cache.md`; `spec/protocol/mcp.md`; `spec/protocol/routing.md` | No Cloudflare DO class migration; uses Step 5 cache tables. |
| 7 | `WOO_V2_CHECKPOINT_TAIL_OPEN` | `spec/protocol/v2-turn-network.md`; `spec/reference/cloudflare.md`; `spec/reference/persistence.md` | No Cloudflare DO class migration; checkpoint SQL tables are idempotent if persisted separately. |
| 8 | `WOO_TOOL_SURFACE_PROJECTION_ROWS` | `spec/semantics/projection-cache.md`; `spec/protocol/mcp.md`; `spec/semantics/introspection.md` | No Cloudflare DO class migration; uses Step 5 cache tables. |
| 9 | `WOO_V2_ROW_LEVEL_PROJECTION_DELTAS` | `spec/reference/persistence.md`; `spec/semantics/projection-cache.md` | No Cloudflare DO class migration unless a new DO class is added; SQL changes are idempotent existing-DO schema changes. |
| 10 | `WOO_V2_TRANSCRIPT_VOCAB_EXTENSIONS` plus narrower per-addition flags | `spec/semantics/events.md`; `spec/protocol/v2-turn-network.md` | No Cloudflare DO class migration unless a new DO class is added. |

0. Clean measurement noise before using metric counts as design evidence.
   `session_reap` emits one metric per sweep only when `reaped > 0`, with
   `inspected` and `reaped` counts. Add `projection_bytes`, `tail_rows_written`,
   `tail_bytes_retained`, `gateway_projection_rows_written`,
   `gateway_projection_bytes`, `serialized_world_materialized`,
   `checkpoint_build_ms`, `checkpoint_packaging_ms`, and `same_host_fallback`
   fields before judging steps 1-8. The smoke-tail
   analyzer must count `status:"timeout"` as a failed RPC, and the smoke wrapper
   must fail a run that captures zero tail metrics.
   Tests: add vitest coverage asserting `session_reap` is emitted only when
   `reaped > 0`, analyzer coverage for `commit_reply_replay`, timeout counting
   in `analyze-smoke-tail`, and empty-tail rejection in `smoke-with-tail`.

1. Make `SerializedWorld` materialization lazy.
   `applyShadowTranscriptToIndexedState` remains the hot applier. Accepted
   commits update indexed state and row projections, mark the serialized cache
   dirty, and do not call `serializedWorldFromCommitScopeState`. Materialize
   only at `saveFull`, checkpoint build, `/v2/open` legacy fallback, and
   diagnostics, each with a metric.
   Introduce `serializedFor(scope)` as the only materialization accessor.
   Direct `scope.serialized` access is grep-banned outside the accessor and the
   constructor/legacy import boundary.
   Tests: add a vitest that executes a normal accepted commit and asserts the
   materialization counter remains zero; add a boundary test that
   `serializedFor(scope)` materializes exactly once when dirty.

2. Collapse to one applier contract.
   Make the commit path report `ApplyResult`. The applier returns only
   object/session/log/counter row ops. The caller folds in snapshot,
   parked-task, tombstone, tool-surface, reply, and idempotency side-channel
   ops. `projection_writes` include row bodies for every touched upsert so
   fanout and tail transfer do not fetch rows after receiving keys. Neither side
   may scan a post-apply world. The array-based
   `applyShadowTranscriptToCommittedState` is deleted or retained only as a
   temporary equivalence test oracle; it must not grow a second `ApplyResult`
   path.
   Call-site migration:

   | Current site | End state |
   |---|---|
   | `CommitScopeDO` `/v2/envelope` | Produces authoritative `ApplyResult` and persists accepted frame + projection writes. |
   | `persistent-object-do.ts` REST fallback around `runShadowApply` | Consumes `ApplyResult` for session housekeeping only; no independent transcript apply semantics. |
   | `persistent-object-do.ts` local gateway apply around `runShadowApply` | Removed after Step 5; before then it is legacy fallback when `projection_delta` absent. |
   | `persistent-object-do.ts` `applyV2CommittedTranscript` | Decodes `ApplyResult`/projection delta plus row bodies; does not reapply to a gateway mirror when delta present. |
   | `persistent-object-do.ts` `/__internal/apply-v2-commit` and host write-through | Consumes projection writes for local host rows; no receiver rediscovery or row-body fetch. |
   | `applyShadowTranscriptToCommittedState` | Deleted from production paths or retained only under an equivalence-test helper. |

   Tests: add equivalence tests for object/session/log/counter row ops, and a
   call-site test that each legacy `runShadowApply` path either consumes
   `ApplyResult` or is disabled when the flag is on.

3. Make accepted-frame and transcript tails append-only.
   Keep current projection row tables. Add only the frame/tail indexes needed
   for catch-up. Retain tails per the count/byte/age budget: at most 1,000
   frames/transcripts, 16 MiB encoded tail bytes, and 7 days per scope. Transfer
   at most 200 frames or 512 KiB in one tail response. Persist new
   frames/transcripts by sequence/hash with a high-water mark, and prune by
   retention horizon only after a complete checkpoint covers the prefix.
   `saveFull` and checkpoint build must not rewrite the retained tail.
   Delete `saveAcceptedFrames` and `saveTranscriptTail` plural forms. Keep the
   singular append helpers. Introduce `pruneAcceptedFramesByHorizon()` and
   `pruneTranscriptTailByHorizon()` called lazily after append.
   Tests: add a `CommitScopeDO` storage vitest proving `saveFull` writes only
   new tail rows and pruning deletes only rows older than the horizon.

4. Decide reply-envelope persistence by measurement.
   Step 4a emits `commit_reply_replay` with `mode:"fresh" | "cached_sql" |
   "cached_kv" | "miss_after_hibernate"`. Measure for one week of production
   data. Step 4b decides: if cached reply hit rate is low, move reply bodies out
   of hot SQL writes into TTL KV or rely on higher-layer retry/wait. If SQL
   replies stay, they must be counted as deliberate hot-path writes.
   Tests: add replay tests for fresh, cached SQL, hibernated reload, and
   miss-after-retention cases.

5. Replace the gateway mirror world with a projection-row cache.
   The gateway stores authority-keyed object rows, scope membership rows,
   session rows, `SessionToolManifest` rows, scope heads, and
   `ToolSurfaceProjectionRow` rows. During cutover, it uses `projection_delta`
   plus `projection_writes` when present and falls back to the existing scan when
   absent. When delta is present it must not call `runShadowApply`,
   `buildGatewayApplyTarget`, or `applyV2CommittedTranscript` for projection
   maintenance. The cache is durable SQL first; in-memory maps are optional and
   must be correct after hibernation with no owner cold-open.
   This step is blocked until §Gateway Projection Cache is implemented.
   Tests: add vitests for fanout consuming projection deltas without gateway
   `runShadowApply`, hibernate/rehydrate cache load, cache miss fallback, stale
   row return, session-manifest monotonicity, and tool-list parity against the
   legacy gateway world.

6. Add same-host stale fallbacks for hot cross-host RPCs.
   Tool listing, routing, and projection reads first use gateway-local cache and
   the session's manifest. A remote owner RPC refreshes that cache but cannot
   make descriptor reads unavailable. On timeout, return last-known rows with a
   stale marker and reconcile on the next fanout. Previously listed session
   tools must not disappear as `E_VERBNF` unless an authoritative projection
   delta removed them.
   This step is blocked until projection freshness fields and read-site budgets
   from §Cross-Cutting Gates are implemented.
   Tests: add vitests where `/__internal/enumerate-tools` times out and
   `woo_list_reachable_tools` returns bounded-stale manifest rows with
   `stale:true`; add tests that stale descriptor calls refresh/retry once instead
   of returning `E_VERBNF`; add tests that auth/permission reads reject stale
   rows.

7. Replace `/v2/open` normal path with checkpoint-or-tail.
   Start with coarse projection pages built from existing rows. Tail responses
   carry `AcceptedFrameTransfer` entries with row bodies. Checkpoint pages are
   bytes-bounded, with rows larger than a target page becoming one-row pages and
   rows near the SQL size limit rejected for splitting. Checkpoint build runs as
   post-commit/alarm maintenance, not inside `/v2/open`; open only packages a
   complete checkpoint/tail. Continuations are pinned to a fixed export
   id/head/hash. Keep `SerializedWorld` export for diagnostics and fallback.
   This step is blocked until §Checkpoint/Tail Open Schema is implemented.
   Tests: add vitests for frames response with row bodies, checkpoint response,
   byte-bounded pages and one-row oversized pages, continuation snapshot pinning,
   legacy fallback negotiation, checkpoint `frame_tail` not replayed, and open
   not triggering checkpoint build.

8. Split tool-surface projection from executable state.
   Add `ToolSurfaceProjectionRow` keyed by `{ scope, object }`, invalidated by
   contributing object rows. Store it in the gateway projection cache first;
   Directory/KV can become a sharing layer later. `woo_list_reachable_tools
   scope:"all"` must not open executable scopes.
   This step is blocked until §Tool-Surface Invalidation is implemented.
   Tests: add vitests for local verb edit, inherited parent verb edit,
   descendant override stability, parent/class chain changes, gateway
   self-eviction on a changed `source_rows` member, and bulk ancestor edit
   collapsing to one `tool_surface_sources` marker instead of descendant row ops.
   Completion also requires a smoke-tail sizing report for
   `gateway_tool_surface_source_rows` per active room and a cap-hit test proving a
   saturated scope serves the session manifest without adding reverse-index rows.

9. Only after those steps, decide whether row-level deltas are worth it.
   This decision is gated on `projection_bytes`, specifically the
   `the_horoscope:set_properties` trace or its successor. If whole-object row
   bytes remain material, split rows along the existing `ObjectRepository`
   boundaries. Do not do this before the broad transforms are gone.
   Tests: add vitests comparing whole-object and row-level deltas for
   `set_properties` plus migration/fallback compatibility tests.

10. Grow transcript vocabulary only for side effects that still need native
    side channels after the sequence is simplified.
    Tests: each new transcript cell/event has a replay/equivalence vitest and a
    smoke-tail analyzer classification.

## Success Criteria

- Fresh smoke tail shows no normal `/v2/envelope` call to
  `serializedWorldFromCommitScopeState` or equivalent full world
  materialization.
- The indexed applier is the only normal accepted-commit applier. Array-based
  apply is absent from production paths or covered only by an equivalence test.
- Accepted-frame and transcript tail persistence is append/prune only:
  `tail_rows_written <= new_frames + new_transcripts + pruned_rows`, not full
  retained-tail rewrites; `tail_bytes_retained` stays under the per-scope
  retention budget.
- Fresh quiescent smoke tail shows no `storage_full_save` on `/v2/envelope` or
  warm `/v2/open`. One-time bootstrap/checkpoint/migration saves are reported
  separately by scope-state class.
- Fresh smoke tail shows no gateway compatibility scan and no gateway
  `runShadowApply`/mirror-world apply for accepted fanout when
  `projection_delta` is present.
- Gateway projection cache survives hibernation from SQL and does not cold-open
  owner executable state to rebuild ordinary tool descriptors.
- A class/ancestor verb edit emits bounded `tool_surface_sources` invalidation,
  not per-descendant `tool_surfaces` row ops multiplied by fanout shards.
- Accepted fanout and tail catch-up are row-body complete: every upsert in
  `projection_delta` has a co-shipped `projection_writes` row body, with no
  normal-path per-row fetch after receiving the frame.
- `/v2/open` transfers checkpoint/tail batches, not full executable seeds, for
  normal catch-up; continuations resume the same export id/head/hash; open does
  not build checkpoints synchronously.
- Checkpoint/projection pages stay under the byte cap; oversized individual rows
  are one-row pages, and rows near the SQL value limit are rejected or split
  before storage.
- `woo_list_reachable_tools scope:"all"` does not cold-open remote executable
  state for descriptor work. Owner timeout returns stale same-host projection
  rows or the session's last `SessionToolManifest` instead of failing the
  tool-list path.
- Smoke failures do not include `E_VERBNF` for a tool previously listed in the
  same session unless an authoritative projection delta removed that tool.
- Durable commits report `ProjectionDeltaSummary` without a post-apply world
  scan.
- `session_reap` metric volume reflects actual reap work, not sweep noise.
- Reply-envelope persistence is either moved off hot SQL or justified by a
  measured retry-hit rate.
- The analyzer classifies every metric kind; timeout statuses count as failures;
  the smoke wrapper fails if the tail contains zero metrics; the vitest guards
  fail for unclassified metric kinds and analyzer timeout regressions.
- Per-operation cost is reported for the smoke traces above: frame bytes,
  projection rows touched, projection bytes, fanout rows touched, checkpoint
  bytes, tail rows written, tail bytes retained, checkpoint build/packaging
  time, same-host fallback count, remote owner refresh count, and round trips.
