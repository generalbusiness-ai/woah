# Browser as a holder node

Updated 2026-05-25 (rev 6: one receiver profile across the transfer family). Companion to
[2026-05-25-distributed-vm-document-data-path.md](2026-05-25-distributed-vm-document-data-path.md)
(the "data-path note"), which designs the server tiers and omits the browser.

Normative basis: `spec/protocol/v2-turn-network.md` §VTN14.* (spec:1189) and
`spec/protocol/ui-component-model.md` §UCM21 (spec:1297). Where this note
disagrees, the spec wins.

## Principle

> The browser is a normal holder plus a local proposal buffer. "Optimistic" is a
> view over pending proposals, not a separate protocol.

The browser must not have a structurally separate architecture. It consumes the
same `AcceptedTurnFrame`, the same `ProjectionDeltaSummary`, the same
receiver-profiled `ProjectionWrite`, the same `ScopeCheckpoint`/tail rules, the
same `ExecutionCapsuleTransfer`, and the same apply/install contract as every
cloud holder. It adds exactly one thing: a buffer of locally produced
`TurnProposal`s, rendered as an optimistic overlay until the authority sequences
them. The browser VM already exists (`planV2BrowserLocalTurn`,
`src/client/v2-browser-local-turn.ts:57`); the divergence to remove is its
parallel transcript-replay/`ShadowScopeProjectionPatch` reconcile and
per-mutation IndexedDB writes (`v2-browser-worker.ts:1145`), not its ability to
execute early.

## The four justified asymmetries

These are the *only* differences from a cloud holder. Everything else aligns.

| # | Browser | Cloud holder |
|---|---|---|
| A1 | MAY execute before sequencing (produces a `TurnProposal`) | normally consumes accepted frames only |
| A2 | projection rows are recipient-filtered (thinner payload) | authority/cache rows MAY be fuller |
| A3 | persistence is best-effort IDB + memory | DO storage is durable authority/cache |
| A4 | has a UI optimistic layer (UCM21 layer 4) | no UI layer |

VM-read separation is **not** an asymmetry: projection rows drive VM reads on no
holder (gateway included). VM reads come only from the authority DO's indexed
state or from execution cells installed with proof. A2 is about payload fullness,
not VM-read rights.

## Draft spec types (relocate to VTN14 when implementation starts)

The shared-spec changes the repositioning needs. They live **here only until
implementation begins**, then move verbatim into
`spec/protocol/v2-turn-network.md` §VTN14, reconciling with the data-path note's
`ProjectionWrite`/`ProjectionPage`/`ScopeCheckpoint`/`ProjectionDeltaSummary`
(data-path:328/353/523), and this note references them — normative-in-waiting,
not a second definition. All referenced types are real today: `TranscriptCell`
(= `RecordedCell`, `turn-recorder.ts:5`), `ShadowTurnKey` (`turn-key.ts:5`),
`ShadowTurnCall`, `EffectTranscript`, `ShadowScopeHead`, `Observation`,
`SerializedObject`/`SerializedSession`, `RemoteToolDescriptor`.

Implementation handoff delta, 2026-05-26: the distributed data-path branch
landed the first server-side refactor with concrete authority-shaped
`ProjectionWrite`, `ProjectionPage`, and `ScopeCheckpoint` types in
`src/core/projection-delta.ts`. Before browser-holder work starts, make those
types generic in the data-path layer itself, with defaults equivalent to the
current authority/gateway profile. That lets existing server call sites keep
using `ProjectionWrite` while browser code can later request
`ProjectionWrite<BrowserProfile>` and checkpoint/tail can share the same
receiver-profiled transfer family. Also reconcile the byte-accounting split
deliberately: the browser profile wants `ProjectionDeltaSummary`/`RowOp` to stay
common key/op metadata while `bytes`/`projection_bytes` become profile-specific
transfer metrics. If the server branch keeps bytes on the common delta for the
first landing, document that as a temporary measurement compatibility choice and
do not let browser security or payload-shaping depend on those common byte
fields.

### One receiver profile, applied across the whole transfer family

Generalize "receiver profile" once. A `ProjectionProfile` is a table→row-body
map; `ProjectionWrite`, `ProjectionPage`, and `ScopeCheckpoint` are all
parameterized by it — so cold open (checkpoint/tail) is browser-safe for the same
reason hot fanout is, and a browser can never receive an authority-shaped row
through either path. `table`/`key`/`op` are profile-independent; only row bodies
are profiled. Byte/cost accounting is profile-specific (browser and gateway rows
serialize to different sizes), so it moves out of the common
`ProjectionDeltaSummary` onto the profiled transfer.

```ts
type ProjectionProfile = {
  objects: unknown; sessions: unknown; logs: unknown; snapshots: unknown;
  parked_tasks: unknown; counters: unknown; tombstones: unknown; tool_surfaces: unknown;
};

// table-keyed: an `objects` upsert can only carry P["objects"] — closes the
// "objects row carrying a session body" hole.
type ProjectionWrite<P extends ProjectionProfile> = {
  [T in keyof P]:
    | { table: T; key: ProjectionKey<T>; op: "upsert"; row: P[T]; bytes: number }
    | { table: T; key: ProjectionKey<T>; op: "delete" };   // no body, profile-independent
}[keyof P];

type ProjectionPage<P extends ProjectionProfile> = {
  [T in keyof P]: { kind: "woo.projection_page.v1"; table: T; page: string; hash: string; rows: P[T][] };
}[keyof P];

type ScopeCheckpoint<P extends ProjectionProfile> = {
  kind: "woo.scope_checkpoint.v1"; scope: ObjRef; head: ShadowScopeHead;
  checkpoint_hash: string; pages: ProjectionPage<P>[]; frame_tail: AcceptedTurnFrame[];
};

// Common index keeps key/op only; byte fields removed (data-path:328/341 refinement).
type RowOp<Key> = { key: Key; op: "upsert" | "delete" };
```

Two profiles. **Neither drives VM reads** — projection rows are a cache on every
holder; VM reads come only from the authority DO's indexed state or from
execution cells installed with proof (the gateway "does not hold an executable
`WooWorld`", data-path:478).

```ts
type AuthorityProfile = {              // gateway / DO holder cache (data-path:353/523)
  objects: SerializedObject; sessions: SerializedSession; logs: SpaceLogEntry;
  snapshots: SpaceSnapshotRecord; parked_tasks: ParkedTaskRecord;
  counters: { value: number }; tombstones: { id: ObjRef };
  tool_surfaces: ToolSurfaceProjectionRow;
};

type BrowserProfile = {                // recipient-filtered, display-only (A2)
  objects: BrowserObjectRow; sessions: BrowserSessionRow; logs: BrowserLogRow;
  tool_surfaces: BrowserToolRow; tombstones: { id: ObjRef };
  snapshots: never; parked_tasks: never; counters: never;   // not delivered to the browser
};

type BrowserObjectRow = {
  kind: "woo.browser_object_row.v1";
  id: ObjRef; scope: ObjRef; head: ShadowScopeHead;
  name?: string; display: Record<string, WooValue>;  // UCM21 thin summary; hidden props omitted
  location?: ObjRef; contents?: ObjRef[];
  // deliberately absent: verb bytecode, full property cells, lineage — structurally
  // unable to satisfy a TurnKey atom. This is the A2 / security invariant.
};
type BrowserSessionRow = { kind: "woo.browser_session_row.v1"; session_id: string; actor: ObjRef; active_scope: ObjRef | null; head: ShadowScopeHead; };
type BrowserLogRow = { kind: "woo.browser_log_row.v1"; scope: ObjRef; seq: number; observation: Observation; head: ShadowScopeHead; };
type BrowserToolRow = { kind: "woo.browser_tool_row.v1"; scope: ObjRef; object: ObjRef; verbs: RemoteToolDescriptor[]; head: ShadowScopeHead; };
```

Browser rows are produced server-side by the fanout recipient filter
`project<AuthorityProfile, BrowserProfile>(row, recipient)`; the browser never
receives an authority-profile row, in fanout *or* checkpoint/tail.

### `TurnProposal` and its overlay

`TurnProposal` is what any holder with sufficient execution cells produces when
executing ahead of sequencing; its wire submission is the existing
`ShadowTurnExecRequest`. Its overlay is **speculative and partial**, so it is
*not* a `ProjectionWrite` — that name stays reserved for row-body-complete
authoritative installs from accepted frames. Overlays are `ProposalProjectionOverlay`.
Replaces the Phase-1 `TentativeTurn` name; "tentative" survives only as a status.

```ts
type ProposalProjectionOverlay = {     // speculative, partial; never authoritative
  [T in keyof BrowserProfile]:
    | { table: T; key: ProjectionKey<T>; op: "patch"; partial: Partial<BrowserProfile[T]> }
    | { table: T; key: ProjectionKey<T>; op: "remove" };
}[keyof BrowserProfile];

type TurnProposal = {
  kind: "woo.turn_proposal.v1";
  id: string; proposer: string;
  expected_head: ShadowScopeHead;          // -> ShadowTurnExecRequest.expected
  call: ShadowTurnCall; turn_key: ShadowTurnKey;
  transcript: EffectTranscript;
  transcript_hash: string;                 // accept-match condition for write-cell promotion
  read_cells: TranscriptCell[];            // rebase decision (VTN14.5 spec:1453, spec:1441)
  write_cells: TranscriptCell[];           // promoted to store-2 only on a hash-matched accept
  predicted_overlay: ProposalProjectionOverlay[];
  ui_patch_ids: string[];                  // UCM21 layer-4 patches to retract on rollback
  created_at_ms: number; expires_at_ms: number;
  status: "pending" | "accepted" | "rejected" | "needs_replan";
};

// submit(p) = ShadowTurnExecRequest{ id: p.id, call: p.call, key: p.turn_key,
//             expected: p.expected_head, persistence, auth }
```

## Symmetrical flow

```text
1. holder has sufficient execution cells (ExecutionCapsuleTransfer; request only missing atoms)
2. holder executes -> TurnProposal (transcript + read/write cells)
3. browser only: render an optimistic view over the proposal (UCM21 layer 4),
   then journal the proposal fire-and-forget (A3/A4)
4. authority sequences -> AcceptedTurnFrame, or rejects
5. accepted response is AcceptedTurnFrame + ProjectionWrite[], identical to what
   every holder receives
6. the shared receiver path installs the accepted frame; the browser additionally
   resolves the matching proposal (drop) and rebuilds the overlay from survivors
```

Steps 1, 2, 4, 5 and the install in 6 are shared holder mechanics. Steps 3 and
the proposal-resolution half of 6 are the only browser-local additions.

## Stores

1. `projection_rows` — recipient-filtered display/tool/session rows, key
   `{scope, table, key}`, head/freshness. Shared row *contract*, browser-safe
   *payload* (A2). **No VM reads** (VTN14.1 spec:1230, 1242, 1317).
2. `execution_pages` — verified `cell_pages`/capsule pages + per-scope
   checkpoints with proof metadata. **May drive VM reads.** (Same as a cloud
   holder's execution cells.)
3. `proposal_buffer` — `TurnProposal`s. The one browser-specific store (A1).

Security invariant (one place to prove it, all holders): a store-1 row can never
satisfy a `TurnKey` atom; only store-2 pages can.

## Shared holder behavior (not browser-specific)

These are the same for gateway and browser; the browser inherits them.

- **Receiver-profiled transfer family.** `ProjectionWrite`, `ProjectionPage`,
  and `ScopeCheckpoint` are parameterized by `ProjectionProfile`; the gateway
  receives `AuthorityProfile`, the browser `BrowserProfile`, produced by
  recipient-filtering at the authority/fanout boundary (no browser-side
  transform). `ProjectionDeltaSummary` stays common (key/op only); byte
  accounting is profile-specific.
- **One installer.** Accepted frames install via the single `ApplyResult`
  applier. Delete the browser's `applyShadowTranscriptToCommitScopeCache`; no
  transcript replay, no `ShadowScopeProjectionPatch`.
- **Execution view advances from accepted frames** (projection rows cannot feed
  the VM). Promote a proposal's `write_cells` into store-2 under the accepted
  receipt **only when the accepted frame's transcript hash equals the proposal's
  `transcript_hash`**; if the authority re-executed differently under the same
  turn id, discard the local writes and fetch capsule/checkpoint instead. For an
  unrelated remote frame, invalidate capsule coverage for the touched atoms and
  fetch a capsule on the next local plan that needs them.
- **`ExecutionCapsuleTransfer` = `ShadowCellPageTransfer` + signed capsule
  metadata**, not a new primitive (`installShadowStateTransfer` already handles
  `cell_pages`, `shadow-turn-exec.ts:461`). Metadata (`head`, `actor`, `session`,
  `target`, `verb`, `turn_key`, `recipient`, `expires_at_ms`, page refs) MUST be
  covered by the signed proof — extend `ShadowStateProof` (today binds only
  scope/mode/root/recipient, `shadow-turn-exec.ts:119`); a sidecar is
  insufficient. `closure`/`object_records` are dropped from the hot path.
- **Checkpoint/tail.** `/v2/open` is display catch-up: a `checkpoint_tail.v1`
  projection batch into store 1. The browser receives `BrowserProfile`
  checkpoint pages, never authority rows. A checkpoint's `frame_tail` is already
  applied (data-path:682): it updates continuity metadata but MUST NOT re-route
  historical observations or re-apply row writes.
- **Conflict handling** (VTN14.5): `stale_head` is a convergence signal — do not
  invalidate by itself; permanent → reject the proposal.

## Browser-local mechanics

- **Optimistic view = UCM21 layer 4** (spec:1312): the proposal overlay is a
  view over pending proposals, keyed by proposal/call id. Observations are **not**
  row writes. A proposal's `predicted_overlay` (a partial
  `ProposalProjectionOverlay`, not a `ProjectionWrite`) is derived only from the
  transcript's **applier-local** cells the browser can build without side
  channels (data-path:580): object create/write/delete, session active-scope,
  log entries, counters. It cannot derive side-channel rows (snapshot,
  parked-task, tombstone, tool-surface, reply, idempotency) — those wait for
  authoritative fanout.
- **Optimistic projection predicate** (A1 bounded): a proposal shows
  authoritative-looking projection only when its transcript writes are all in the
  active scope, have no untracked effects, and the call is not a cross-scope
  move/enter. Otherwise the proposal shows pending UI only.
- **Memory-first, durability by connection state** (A3/A4): zero *awaited* IDB
  transactions before the optimistic render. On the **open-WebSocket** path,
  render then journal the proposal fire-and-forget (today it awaits the journal
  first, `v2-browser-worker.ts:813`); tab death pre-flush is repaired by authority
  catch-up and proposal retry is best-effort. On the **queued/offline/reconnect**
  path, the proposal MUST be persisted before it is enqueued — otherwise a socket
  loss or tab death drops a durable turn that was never submitted.
- **Two-phase accept** (IDB cannot run VM inside a transaction): phase 1 is one
  ordered, `(scope,seq)`+hash-idempotent transaction (VTN14.1 spec:1248) doing
  pure installs — accepted `ProjectionWrite<BrowserProfile>`s, head advance,
  hash-matched store-2 write-cell promotion, drop the matched proposal, mark
  survivors `needs_replan`.
  Phase 2, after the transaction, replans `needs_replan` survivors (may fetch a
  capsule, re-plan only if an accepted frame changed a cell it read, spec:1441)
  and installs each new overlay in a later atomic write.
- **`tool_surface_sources` fallback** (no browser reverse index yet): a received
  marker conservatively stales the current `SessionToolManifest` and active-scope
  tool surfaces, then schedules refresh.
- **IDB tier** (A3): writes behind the render; `durability: "relaxed"` (lost
  flush → cold open, not data loss); per-row 512 KiB cap;
  `navigator.storage.persist()`; eviction is a cold-open trigger. Safari/WebKit
  is the gating target — measure there.

## Data-path note: browser arm per step

| Data-path step | Browser arm |
|---|---|
| Step 2 — one `ApplyResult` applier | Parameterize the transfer family by `ProjectionProfile`; browser consumes `ProjectionWrite<BrowserProfile>` through the same installer; remove `applyShadowTranscriptToCommitScopeCache`. |
| Step 5 — projection-row cache | Store 1 = the holder cache, browser-safe payload (A2). |
| Step 6 — same-host stale fallback | Store 1 is the browser's same-host fallback; render at 0 ms, reconcile after. |
| Step 7 — checkpoint/tail open | Browser open = display catch-up into store 1. |
| `cell_pages` standardization | Promote to `ExecutionCapsuleTransfer`; drop `closure`/`object_records`. |
| `TurnProposal` | Define in shared VTN14, not browser-only; browser is the first/only proposal-buffering holder. |

## Gates

- Flag `WOO_BROWSER_PROJECTION_HOLDER`, default off; off = legacy
  `ShadowStateTransfer`/full-world-checkpoint/transcript-replay path. Disables
  only this path.
- Spec edits (at implementation start, relocate §Draft spec types into VTN14
  verbatim): VTN14 — `TurnProposal`, `ProposalProjectionOverlay`, the
  holder/proposal split, and the `ProjectionProfile`-parameterized family
  (`ProjectionWrite`/`ProjectionPage`/`ScopeCheckpoint`); data-path:328 — drop
  byte fields from the common `ProjectionDeltaSummary`/`RowOp` (profile-specific);
  VTN14.1 store-rights table; VTN14.3/14.5 (flow + proposal lifecycle); UCM21
  (layer-4 optimistic view); data-path Step 2/5/7 call-site tables.
- Migration: none (Cloudflare DO). IndexedDB schema versioned, idempotent.
- Metrics: accepted-frame install cost (`projection_rows_written`,
  `browser_checkpoint_bytes`, `browser_capsule_bytes`) vs proposal lifecycle
  (`proposal_hit`/`_miss`/`_replan`, `browser_rebase_ms`), plus existing
  `idb_tx`.
- Tests: shared installer parity (gateway vs browser apply of the same delta);
  **security** — no `BrowserProfile` row satisfies a `TurnKey` atom, and capsule
  metadata tamper (head/verb/turn_key) fails proof verification; receiver profile
  — browser receives `BrowserProfile` rows in both fanout *and* checkpoint/tail,
  never a `SerializedObject`/`SerializedSession` body; write-cell promotion —
  hash-matched accept promotes to store 2, hash-mismatch discards and fetches;
  two-phase accept — phase-1 transaction runs no VM/capsule fetch, survivors land
  `needs_replan`; durability — offline/reconnect path persists a durable proposal
  before enqueue; fake-IndexedDB duplicate-`(scope,seq)`/partial-failure
  idempotency; reload→cold-open→rebuild overlay from surviving proposals;
  predicate denies an out-of-scope proposal an authoritative-looking overlay.

## Success criteria

- The browser uses one shared installer with the gateway for accepted
  `ProjectionWrite[]`; no transcript replay or `ShadowScopeProjectionPatch` on the
  accepted path.
- The only browser-specific state is the `proposal_buffer`; "optimistic" is a
  view over it.
- No projection row (any profile) satisfies a `TurnKey` atom on any holder; VM
  reads come only from `execution_pages` / authority indexed state. Cold open
  delivers `BrowserProfile` checkpoint pages — never authority-shaped rows.
- The proposal overlay is a partial `ProposalProjectionOverlay`, never a
  `ProjectionWrite`; write-cell promotion to store 2 happens only on a
  transcript-hash-matched accept.
- The optimistic render path emits zero `idb_tx` on the open-socket path;
  offline/reconnect persists proposals before enqueue; accept is two-phase and
  `(scope,seq)`-idempotent with no flicker.
- Execution state arrives as `ExecutionCapsuleTransfer`; `closure`/
  `object_records` are gone from the browser hot path.
- `TurnProposal` is defined once in the shared spec and consumed by the browser
  buffer; there is no parallel browser reconcile model.
