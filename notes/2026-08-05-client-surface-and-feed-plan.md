# Plan: single client-surface owner + durable per-presence observation feed

Origin: 2026-08-05. Supersedes earlier drafts of the same date (the design
went through four review rounds; only the resulting design is recorded
here). Companion assessment: `notes/2026-08-05-capnweb-assessment.md`.

## Purpose

Two structural changes to the Net client layer:

1. **One client-surface operation owner.** `gateway-do.ts` implements three
   client dialects (REST, MCP, WebSocket) as siblings, each with its own
   copy of error rendering, session validation, admission, and rate
   limiting. Extract the shared operations into one module; dialects become
   parse → surface call → render.

2. **Delivery becomes durable data.** Observation delivery today is two
   transport-specific behaviors: an in-memory MCP queue that dies on
   eviction (with a continuity *proof* that cannot say what was missed) and
   an at-most-once WS push with no reconnect recovery. Replace both with
   the system's own standard shape — authoritative fact → derived rows →
   view: one durable, monotonically sequenced feed per presence, read by
   cursor, shared by every dialect. This is also the primitive the
   2026-07-28 stateless-MCP migration declares mandatory
   (`notes/2026-07-28-mcp-stateless-migration-scope.md` §4).

Phase order (spec strictly precedes the implementation it constrains):

```
S1 (surface spec) → A1 → A2 → A3 → S2 (feed spec) → B2 → B3 → B4/A4
```

## 1. The client surface (WS-A)

New module `src/worker/net/client-surface.ts`, instantiated per gateway
DO. All operations throw `SurfaceFault` (`{code, message, detail?,
retryable?}`, codes from the closed CO6 vocabulary plus auth/session
verdicts); none render. `surface-render.ts` holds three pure renderers
(REST status+body, MCP JSON-RPC/tool envelope, WS frame) over one mapping
table.

```ts
class ClientSurface {
  // Admission stays per-door: login owns its PBKDF2 concurrency/window
  // caps, timing equalization, and pre-auth email rate key; guest owns
  // pool allocation. Both compose one private mint (today's sessionOpen).
  admitLogin(email, password, opts): Promise<SessionInfo>
  admitGuest(claim, opts): Promise<SessionInfo>
  resumeOrOpenSession(principal, opts): Promise<SessionInfo>

  authenticate(cred): Promise<Principal>
  rateGate(principal|key, class): void          // post-auth; the one implementation
  resolveSession / closeSession(...)
  submitTurn(principal, session, req): Promise<TurnResult>   // wraps the existing clientTurn chain unchanged
  readCell / readRelation(...)
  enrollFeed / readFeed / waitFeed / cancelWait(...)         // §2
}
```

Rules:

- **Audit is a surface effect.** AU1.2 edge audit emits inside surface
  operations, not in renderers. Wire fixtures cannot prove a side effect
  survived, so the extraction gate includes audit-row assertions per fault
  path.
- **Guard.** `guard:client-surface` (wired into `npm test`): dialect
  regions of `gateway-do.ts` may not call rate limiting, session mint,
  session SQL, or construct error bodies directly.
- The MCP tool projection is not moved (its canonical naming is a §M2.3
  protocol guarantee; its future belongs to the stateless-MCP plan). The
  MCP control-plane state — tool-list digests, `list_changed`
  bookkeeping, SSE listeners — is retained (renamed `mcpControlState`);
  only observation delivery moves to the feed.

## 2. The feed (WS-B)

One durable, monotonically sequenced feed per presence, containing exactly
what today's delivery would push after audience filtering, plus the
submitter's own-turn rows (needed for echo suppression once delivery is
durable — see §2.3).

### 2.1 Identity, cursors, determinism

- Enrollment (at session mint) stores a non-secret `feed_id` and a random
  `incarnation` token. Session/presence ids never appear in client-visible
  state — a session id is a credential. Re-enrollment of a reused presence
  identity (guest pool) replaces both, so stale cursors can never read
  another presence's events. Incarnation is a token, not a counter: a
  counter lost with the database cannot be safely "bumped"; a fresh random
  token is always detectably foreign.
- Cursor = authenticated opaque token `{key_version, feed_id, incarnation,
  seq}`. HMAC keys form a small versioned ring derived
  (domain-separated, `woo-feed-cursor:v<N>`) from deployment-configured
  roots — never stored in the gateway database (must survive storage
  loss), never isolate-local (must survive eviction); rotation keeps the
  previous root through a grace window ≥ the maximum supported cursor idle
  age. Invalid/malformed token ⇒ fault; valid-but-stale ⇒ gap response.
- Every read binds to the authenticated actor and exact presence
  (session → enrollment → `feed_id` must match); possession grants
  nothing.
- **Determinism contract: prefix-stable.** Events are immutable and
  identified by `seq` within `(feed_id, incarnation)`. A repeated read
  from cursor C returns events strictly after C; any seq covered by both
  reads is byte-identical; the later read may extend further. `limit` and
  `include_own` are outside the promise — clients resume by `next` and
  dedupe by seq. (S2 amends the migration note's stricter "identical
  page" wording to this; safe broken-stream re-issue is exactly what
  prefix-stability provides, without per-read writes.)
- **Gap is a response, not a flag**: unknown feed, foreign incarnation, or
  pruned seq ⇒ `{gap: {incarnation, oldest_available, head,
  reset_cursor}}`. The current `gap: true` boolean and its
  continuity-proof machinery are deleted.
- **Exact verdicts** (part of the S2 contract, not just tests): a token
  with invalid HMAC, malformed shape, or — impossible under normal
  operation — a valid signature over a future seq for the current
  incarnation ⇒ fault (fail-closed refusal, distinct code). A valid token
  naming a feed the database **knows** belongs to a different presence ⇒
  authorization fault. A valid token naming a feed the database cannot
  attribute (after storage loss nothing proves whose it was, and the
  token carries no actor binding) ⇒ gap — honest staleness. So: *known
  foreign ⇒ authorization fault; unknown ⇒ gap*; the storage-loss and
  cross-session tests assert these two verdicts without conflict.
- **Upstream delivery discontinuities: a durable pending record plus a
  shard-wide discontinuity epoch.** Feed-local seqs are continuous by
  construction, so a missed committed body would otherwise become an
  invisible hole; coherence requires a `delivery_seq` jump to be
  diagnosed, and today the gateway only emits a metric. Per-feed marker
  appends are not implementable: the missed body may itself contain the
  movement that determined historical audience, so the conservative
  audience is *every* open enrollment — O(all shard sessions) inside the
  atomic transaction. Instead:
  - **Pending-gap record**: when a lane jump is observed, a durable
    pending-gap row (scope, lane positions) commits in the SAME
    transaction that advances `delivery_seen_seq` past the jump — the
    resubscription handshake that later decides whether the gap was real
    happens outside that transaction, and a crash in between must not
    lose the evidence.
  - **Resolution**: if the handshake proves the jump benign, the record
    is deleted. If real (or unresolved at a deadline), it converts into a
    bump of a durable **shard-wide feed-discontinuity epoch**.
  - **Read-time effect**: each enrollment records the epoch it has seen;
    a read from an enrollment behind the current epoch returns one gap
    response (naming the discontinuity) and advances its seen-epoch.
    O(1) to write, one honest re-orientation per feed per real gap,
    conservatively covering every feed whose audience membership cannot
    be reconstructed. Real unresolved lane gaps are rare (fanout is
    at-least-once with resubscription); paying rare shard-wide
    re-orientation for O(1) correctness is the right trade.
  Exact pulls repair state, never observations.

### 2.2 Reading

- `waitFeed` = bounded long-poll (~25 s) as wait-on-append; `timeout=0` is
  a pure read; bounded waiter registry (today's cap discipline).
- **Cursorless legacy `woo_wait`** keeps its current contract via a
  durable `implicit_seq` per enrollment: read from it, advance it in the
  read's transaction — at-most-once per drain exactly as today's
  splice-on-read, but eviction-proof. Cursor-supplying clients get the
  stronger contract.
- **Drain bounds**: a visible-result limit and a scanned-row limit; a scan
  exhausted on filtered rows returns a short page whose
  `next`/`implicit_seq` advance past everything scanned — bounded work,
  guaranteed progress.
- **Cancellation** serializes with the claim on the DO event loop: before
  the claim transaction commits it wins (no advance); after, the page is
  delivered.
- Default reads exclude `own` rows — `woo_wait` keeps meaning "what OTHER
  actors did"; the submitter's view of their own turn stays on the turn
  reply. `include_own` exists for response-loss recovery.

### 2.3 Writing: the append

Four tables:

```sql
CREATE TABLE net_feed_event(
  event_id INTEGER PRIMARY KEY,
  ts INTEGER NOT NULL,
  source_scope TEXT NOT NULL,
  source_kind TEXT NOT NULL,      -- 'committed' | 'committed_unstamped' | 'live'
  source_key INTEGER NOT NULL,    -- delivery_seq | authority seq | local counter
  source_ordinal INTEGER NOT NULL,
  payload TEXT NOT NULL,
  UNIQUE (source_scope, source_kind, source_key, source_ordinal)
);
CREATE INDEX net_feed_event_ts ON net_feed_event (ts);

CREATE TABLE net_feed_index(
  feed_id TEXT NOT NULL, incarnation TEXT NOT NULL, seq INTEGER NOT NULL,
  event_id INTEGER NOT NULL, own INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (feed_id, incarnation, seq)
);

CREATE TABLE net_feed_presence(
  presence_id TEXT PRIMARY KEY,   -- server-side only
  actor TEXT NOT NULL,
  feed_id TEXT NOT NULL UNIQUE,
  incarnation TEXT NOT NULL,
  active_scope TEXT,
  head_seq INTEGER NOT NULL, oldest_seq INTEGER NOT NULL,
  implicit_seq INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,    -- the session's exact expiry; authoritative
  closed_at INTEGER,
  updated_ts INTEGER NOT NULL     -- diagnostics only
);
CREATE INDEX net_feed_presence_scope ON net_feed_presence (active_scope, presence_id);
CREATE INDEX net_feed_presence_expiry ON net_feed_presence (expires_at);

CREATE TABLE net_feed_origin(
  origin_id TEXT PRIMARY KEY,     -- random, per pin generation; internal, trusted
  feed_id TEXT NOT NULL, incarnation TEXT NOT NULL,
  echo_digest TEXT,               -- public client-dedupe id only
  state TEXT NOT NULL,            -- 'pending' | 'consumed'
  created_ts INTEGER NOT NULL
);
```

**Atomicity.** The fanout receive path commits mirror application and both
high-waters in one `transactionSync`, and pushes to carriers only
afterward — with redeliveries gated off before the push. A durable feed
that appended post-transaction would lose the interval on a crash after
high-water commit. So all feed writes — payload rows, both audience
paths' index rows, `head_seq`, origin-binding consumption — commit inside
that same transaction. Carrier push stays post-transaction and unchanged.

**Keyed on the delivery clock.** Coherence (CO3 area, ~392) defines two
monotonic positions: authority `seq` gates derived-state application;
`delivery_seq` proves subscriber-lane delivery; loss must never be
inferred across them. An exact pull can install newer authority state so
that a later fanout body no-ops in `applyFanout` — yet that body is still
the lane's only carrier of its observations. The feed therefore appends
on **every new delivery body** (advancing `delivery_seq`, or
unstamped/live), regardless of whether authority state advanced. Dedupe
keys are NOT-NULL by construction (`source_kind` + `source_key`; SQLite
UNIQUE never conflicts on NULL): stamped bodies dedupe on `delivery_seq`,
rolling-upgrade unstamped bodies on authority seq, live events on a local
counter (that leg is at-most-once by design and stays so — the feed makes
delivered live events re-readable, nothing more).

**Two audience paths.** The peer path cannot produce the submitter's
rows: the reply seat is a different contract (outbound `tell`s belong in
the submitter's view although the fanout predicate gives senders no
echo), and movement removes the departing submitter's presence row inside
the same transaction before delivery. So:

1. **Peer rows**: durable audience join — `net_feed_presence.active_scope`
   (indexed) selects enrolled local presences for the fanout's scope in
   O(enrolled occupants in this scope on this shard); each observation
   filtered by `observationReachesActor`. `active_scope` is maintained in
   the same transaction as *both* relation-mirror writers — the delta
   path (`applyRelationDelta`) and the exact-replacement path
   (`replaceScopeRelations`, used by pulls, whose deletions bypass the
   delta path and advance the high-water that would otherwise deliver the
   repairing removal). The existing O(1) no-carrier short-circuit remains
   for the carrier push; the feed short-circuits independently on "no
   enrolled presences in this scope".
2. **Origin-seat row**: matched by `origin_id` (below), filtered by the
   existing reply-seat predicate, tagged `own`. This provenance is what
   permits deleting both in-memory echo-dedupe mechanisms: once delivery
   is durable, echo suppression must be too.

**Origin provenance.** Constraints that force the shape: the idempotency
pin is written durably before the submit RPC leaves, so no commit
metadata exists at binding time; recorded outcomes expire, after which
the same idempotency key (and echo digest) legitimately names a new
turn; and fanout has no wall-clock delivery bound. Therefore:

- At pin-write time, mint a random `origin_id` per pin generation;
  insert the binding `pending` in the pin's transaction. **The winner's
  `origin_id` must be recoverable by a same-key retry**: first-writer-wins
  alone is not enough, because the losing round must resend the winner's
  id, not mint another. So `net_gateway_pin` gains a nullable `origin_id`
  column, populated atomically with first-writer insertion; the pin
  lookup returns it, and a conflicting writer adopts the stored value.
  Legacy pins keep NULL and fall into the rollout fallback (origin-seat
  skip). The column ships in the resumable v3→v4 step,
  independently-probed like the existing lease columns.
- `origin_id` rides the submit envelope and is echoed by the scope in
  outbox fanout and live bodies as trusted internal metadata (a
  data-only, TR3-conforming envelope field; never client-visible — the
  public `echo_id` remains client dedupe only). Rolling upgrade: bodies
  without it simply skip the origin-seat append.
- Consumption is **receipt-driven**: an arriving body carrying a known
  `origin_id` appends the `own` rows and marks the binding consumed.
  Pure-direct (non-advancing) turns have no commit sequence at all;
  their observations already flow through the local
  `pushLiveObservations` branch after acceptance, which consumes the
  binding the same way. Authority high-water is never used as evidence
  of delivery. On the live/pure-direct path, the live-seen counter
  advance, feed append, `head_seq` update, and origin consumption form
  one `transactionSync` before any carrier push (today the counter
  advances separately from delivery; durable capture must not repeat
  that split).
- Pruning: consumed bindings immediately; pending bindings on definitive
  terminal refusal or when the enrollment closes past its grace window —
  never by independent wall-clock TTL while the enrollment lives (a late
  delivery must still classify).
- **Bounding**: pending bindings cannot safely be evicted, so the bound
  is a per-enrollment **pending cap with fail-closed admission** — at the
  cap, a NEW pin admission is refused (the same shape as existing pin
  capacity refusal), which throttles the submitter rather than corrupting
  classification. Index `(feed_id, incarnation, state, created_ts)` so
  cap checks and close-pruning never scan the table.

### 2.4 Retention and scheduling

- Sweep: row-capped, piggybacked on append (every N) plus a low-frequency
  alarm for quiet shards. Strict order: advance `oldest_seq` + delete
  index rows behind it → prune origin bindings → delete payload rows
  older than the global maximum horizon (via the `ts` index). No
  ref-count, no dangling index, no full-table scan.
- Enrollment validity is `expires_at`/`closed_at`, sourced from the
  session's exact expiry — never inferred from update times.
- The gateway has one alarm handler (currently audit). Keyed alarm
  bookkeeping is isolate-local, so every wake durably re-derives BOTH the
  audit and feed-retention schedules from SQL and re-arms
  `min(next_audit, next_sweep)`.

### 2.5 Schema versioning

Gateway derived-schema ladder (exact-version steps, resumable from any
halfway state — the codebase's standing rule):

- **v3→v4** (ships with B2, additive): create the four feed tables +
  indexes, and add the nullable `origin_id` column to `net_gateway_pin`;
  legacy queue state keeps serving. Fresh databases in this release
  create at v4.
- **v4→v5** (ships with B3, destructive): **backfill enrollment rows for
  every live session known to the shard** (session-presence mirror +
  session state), then drop `net_gateway_mcp_watermark` in the release
  that deletes its readers. Sessions live up to 24 h, so without this a
  session minted before B2 reaches B3 with no enrollment and silently
  loses delivery; a deployment-timing gate (wait one TTL) was rejected
  as fragile. Two requirements on the backfill itself:
  - **Translate the watermark, don't discard it.** Today, after queue
    loss, a session gets `gap` unless the watermark proves nothing
    happened. The backfill preserves exactly that: continuity proven by
    the watermark ⇒ clean enrollment at head (current seen-epoch);
    proof absent or failed ⇒ the enrollment starts gap-pending, so its
    first read returns a synthetic gap. Starting everyone silently "at
    head" would erase the one honest signal the old model had.
  - **Row-batched and resumable** — durable progress marker, bounded
    batches, never one shard-sized constructor transaction (the
    standing resumable-migration rule).
  Fresh databases then create at v5.
- **B3 readiness for unstamped bodies**: a quiet-window heuristic is not
  proof — a silent scope can hold an old unstamped outbox row through
  any window. B3 instead requires a **per-scope handshake** for every
  scope serving a live enrollment on the shard: the scope attests it has
  no unstamped pending outbox rows (surfaced through the existing
  resubscription handshake). Any scope that cannot attest converts,
  conservatively, into a discontinuity-epoch bump at cutover — uncertain
  history becomes an honest gap, never silent loss.

## 3. Phases and gates

**S1 — surface spec** (`spec/protocol/client-surface.md` part one:
operation inventory, fault taxonomy + renderer mapping, audit ownership,
guard contract).

**A1 — faults + renderers.** Snapshot current per-dialect error bodies
first; convert the three catch-sites. Exit: `npm test`, `test:worker`,
fixture parity, audit-row assertions.

**A2 — auth + admission + sessions.** Doors move whole with their
pre-auth controls; PBKDF2 refusal-threshold regression test. Exit: gates +
`smoke:net-dev` + `smoke:net-mcp`.

**A3 — turn + reads.** Wrap, don't touch, the plan/submit chain. Exit:
gates + walkthrough smokes + guard enforced.

**S2 — feed spec** (part two: everything in §2; amends mcp.md §M5 —
gap-flag text removed with B3).

**B2 — feed writes, dark (v3→v4).** Append on the delivery clock inside
the fanout transaction; origin binding at pin time; envelope/outbox
carry; `active_scope` on both mirror writer paths; retention + alarm
composition; enrollment with `expires_at`. Legacy queues keep serving
reads. Exit: unit tests below + feed load lane + workerd storage
sampling within the provisional budget.

**B3 — MCP reads from the feed (v4→v5).** `woo_wait` → `waitFeed` with
the durable implicit cursor; delete the observation half of the queue
machinery and the watermark table; split out `mcpControlState`. Exit:
gates + `smoke:net-mcp` + fault-injection tests; deployed evidence run.

**B4/A4 — WS/REST convergence.** WS reconnect accepts a cursor (additive
frame field); REST gains a cursor read; delete `recentClientTurns` +
`ownEchoIds`.

## 4. Validation

Evidence lanes (each matched to what it can actually measure):

- **New `load:net-feed` workerd lane** — enrolled presences × rooms,
  observation-heavy; reports append-transaction time, wake latency, rows
  per fanout batch; gates p95/p99 against the NC8 envelope. (The existing
  `load:net-dev` measures planner asymptotics, not delivery.)
- **Physical rowsWritten budget** — deployed acceptance canary:
  `install:net-canary` → `load:net-canary` → `gate:net-storage` with
  feed-table attribution, window captured at load start/end. S2 defines
  the budget *methodology* and a provisional bound; the numerical budget
  is **ratified at the B2 exit gate** from the first workerd measurement
  (S2 precedes B2, so it cannot contain a number that only exists after
  B2 runs), and confirmed on the canary.
- "No deploy step" means no DO-class wrangler migration; the v4/v5 steps
  ship in code. A canary deployment is required for the budget evidence,
  and only deployed smoke exercises real eviction.

Required tests (every file placed in a curated lane):

1. Prefix-stable reads — overlap byte-identical by seq; extension allowed.
2. Response-loss recovery — cursor re-issue: no loss, no duplicate.
3. Eviction survival — cursored and cursorless (`implicit_seq`) resume.
4. Crash-window atomicity — kill between fanout transaction and carrier
   push: feed complete, high-water consistent.
5. Exact-pull-overtakes-fanout — authority no-op body still appends peer
   and origin rows exactly once.
5a. **Delivery discontinuity** — an actual `delivery_seq` jump (dropped
   body): the pending-gap record survives a crash between high-water
   advance and handshake resolution; a real gap bumps the epoch and
   every behind-epoch read returns one gap response; a benign jump
   (resolved by resubscription) clears without an epoch bump.
5b. **Aged-session cutover** — sessions minted on aged v4 before any
   dark-write reach B3: watermark-proven sessions start clean at head;
   unproven sessions' first read returns a synthetic gap; the backfill
   resumes correctly from a mid-batch crash.
5c. **Unstamped-scope readiness** — a quiet scope holding an old
   unstamped outbox row: B3 cutover converts it to an epoch bump; the
   row's observations are never silently unrepresented.
6. Origin seat — outbound tell and room departure, each across eviction
   and response loss.
7. Origin lifecycle — pure-direct consume with no commit seq; delayed
   fanout after pin-lease expiry still classified; same key reused after
   outcome expiry yields two generations, both classified correctly;
   terminal refusal prunes the pending binding; **same-key retry recovers
   the winner's `origin_id` from the pin** and never mints a second;
   pending-cap admission refuses fail-closed at the bound.
8. Exact-replacement projection — a closure that removes a presence row
   via `replaceScopeRelations` and advances the high-water: the
   enrollment still leaves the scope.
9. Dedupe — replayed stamped body no-ops; unstamped body dedupes on
   authority seq.
10. Incarnation + cursor security — storage loss / reused session ⇒ gap
    with fresh incarnation; cross-actor, cross-session, tampered,
    future-seq, malformed, stale-incarnation, ring-rotation grace,
    invalid-HMAC vs valid-but-stale.
11. Drain bounds + cancellation — own-only interval progresses under the
    scan cap; concurrent waiters never duplicate; cancel-before-claim
    never advances.
12. Retention-gap honesty — prune past a parked cursor ⇒ structured gap.
13. Alarm composition — audit-first and sweep-first wake orders across
    isolate reconstruction.
14. Schema ladder — aged v3→v4, aged v4→v5, partial-resume mid-step,
    fresh-create per phase.
15. Surface extraction — fault-fixture parity, audit-row assertions,
    PBKDF2 threshold regression.
16. Feed load lane within envelope; canary storage gate within budget.

## 5. Deletion ledger

Deleted: two of three error renderings; two of three session validations;
duplicated post-auth rate shapes; the observation half of the MCP queue
(`buffer`/`gapPending`/waiters), the continuity-proof machinery and
watermark table; both echo-dedupe mechanisms; the `gap: true` boolean and
its spec text.

Retained deliberately: MCP control-plane state (for the stateless-MCP
plan), pre-auth admission controls, the O(1) no-carrier short-circuit,
the whole plan/replan/commit chain untouched.

## 6. Risks

- Write amplification — payload/index split; measured budget (workerd
  provisional, canary authoritative); fallback is per-presence-class
  enrollment (schema already supports partial rollout).
- Fanout-transaction growth — measured by the feed lane; mitigation is
  statement batching; moving writes outside the transaction is forbidden
  (recreates the crash window).
- Envelope change (`origin_id`) — rolling-upgrade tolerant (absent field
  ⇒ origin-seat skip), same pattern as unstamped `delivery_seq`.
- Refactor risk — fixture-pinned phases, separate worktree commits,
  lane-gated.

## 7. Non-goals

No Cap'n Web dependency or new dialect (that decision is step 3 of the
assessment note, contingent on this landing). No change to plan/replan/
commit mechanics, `Host.rpc` transport, scope validation, or transcript
shape. No MCP tool-projection or tools/list change. No promise upgrade
for the live path.
