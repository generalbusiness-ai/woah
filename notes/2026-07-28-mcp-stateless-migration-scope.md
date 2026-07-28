# Migrating woo to the 2026-07-28 stateless MCP specification

Date: 2026-07-28. **Revision 2** — incorporates a review that corrected nine
protocol details and three implementation assumptions, and raised one issue
more urgent than the migration itself (§5). Every correction was verified
against the primary source before being accepted; the two places where the
first draft was simply wrong are marked **[was wrong]**.

Companion bookmark: the **durable observation queue**, deferred 2026-07-27 when
the deployed world proved that an MCP session which stops polling for ~10s
stops hearing. This note argues that bookmark and this migration are one job.

Status: proposal. Nothing here is ratified.

---

## 1. Protocol facts

From the normative changelog, the versioning page, and SEP-2243/2567/2575
(all Final). Secondary coverage was unreliable on three of these.

**Identity and versioning**
- `initialize`/`notifications/initialized` removed. Every request carries
  `io.modelcontextprotocol/protocolVersion` and `…/clientCapabilities` in
  `_meta` (**required**); `…/clientInfo` is **SHOULD**, not required.
- HTTP additionally requires an `MCP-Protocol-Version` header **matching the
  `_meta` value**.
- Servers **MUST** implement `server/discover`. `DiscoverResult` carries
  `supportedVersions`, `resultType`, `cacheScope`, and `ttlMs` — not merely a
  version list.
- Servers **SHOULD** put `io.modelcontextprotocol/serverInfo` in every result's
  `_meta`.
- Version rejection is `UnsupportedProtocolVersionError` (`-32022`) carrying
  `supported`/`requested`.

**Sessions**
- `Mcp-Session-Id` and the protocol session are gone (SEP-2567). List endpoints
  must be determined by *deployment and authenticated principal* — never by a
  prior call or a connection. Cross-call state uses explicit server-minted
  handles passed as ordinary arguments, **authorized on every request**.
- **[was wrong]** Dual-era serving is **MAY**, not required, and session removal
  carries **no twelve-month window**. That window belongs to the separately
  deprecated features (Roots/Sampling/Logging). A dual-era server may serve both
  eras concurrently on one endpoint; it selects era by whether the request
  carries modern `_meta` or is an `initialize`.

**Streaming**
- **[was wrong in the popular coverage]** Server→client push survives as
  `subscriptions/listen`: one long-lived POST-response stream, opt-in to
  `toolsListChanged`, `promptsListChanged`, `resourcesListChanged`,
  `resourceSubscriptions`. The *core* filter set is closed, but servers may
  support multiple concurrent subscriptions and extensions may add filtering.
- SSE resumability removed (`Last-Event-ID`, event ids): "A broken response
  stream loses the in-flight request; clients **MUST** re-issue it as a new
  request with a new request ID." **This clause drives §4.**
- Request-scoped notifications (`notifications/progress`, `…/message`) still
  flow on their own request's response stream.

**Headers** (SEP-2243)
- `Mcp-Method` — required on **all requests and notifications**.
- `Mcp-Name` — **conditional**: `tools/call`, `resources/read`, `prompts/get`
  (from `params.name` or `params.uri`).
- Mismatch between header and body ⇒ reject `400` with `HeaderMismatch`,
  **`-32020`** (reassigned from `-32001` by PR #2907).
- `x-mcp-header` lets a server mirror chosen *tool parameters* into
  `Mcp-Param-{Name}` headers. Clients **MUST** support it; servers MAY use it.
  Security rules: never mark sensitive parameters; intermediaries **MUST NOT**
  treat the values as trusted, and servers **MUST** independently verify them
  against the authenticated principal. See §3 — this is a gift.

**Other**
- Tasks moved to extension `io.modelcontextprotocol/tasks`: handle from
  `tools/call`, poll `tasks/get`, `tasks/update` for input, no `tasks/list`,
  handles may be returned unsolicited.
- MRTR replaces server-initiated requests: `InputRequiredResult` +
  `requestState` echoed on retry.
- All results carry `resultType` (`"complete"` | `"input_required"`).
- `ttlMs` + `cacheScope` required on list/read results (`CacheableResult`).
- Roots, Sampling, Logging deprecated; `ping` and `logging/setLevel` removed.
  We use none: our `ping` is a WebSocket frame, unrelated.
- Error codes: we emit `-32000` (implementation-defined, grandfathered) plus
  standard JSON-RPC codes such as `-32700`/`-32601`. The revision adds
  MCP-specific codes in `-32020…-32099`.

**Artifact pinning.** At time of checking, the dated `2026-07-28` schema was not
yet published at its final path and the official TypeScript migration guide
still targeted the draft schema. **The implementation plan must pin an exact
schema or specification commit** and re-point when the final artifact lands.

## 2. The real question: whose session?

`initialize` currently mints a **woo net session** and returns its id *as* the
`mcp-session-id`. Two different things wear one identifier:

- **MCP's session** — transport convenience. Deleted by the revision.
- **woo's session** — a world fact: presence in a room, roster visibility,
  active scope, seat claim, session-keyed presence cells, `session_subscribers`,
  `sessionOpen`/`sessionClose`. Nothing in MCP deletes this, and a MUD without
  presence is not a MUD.

The migration does not remove our need for session liveness; it withdraws the
protocol's willingness to carry it. We have been getting presence free from a
transport artifact and the bill is due.

## 3. Proposal S (revised): the handle is identity/routing data, not a credential

The spec's remedy — mint a handle, pass it as an ordinary argument — fits us,
**but our session id is today a bearer** (`Authorization: Bearer session:<id>`).
Putting a live credential into model context, transcripts and logs would repeat
the P0 leak family (resolved 4992a0f). So:

1. **Authorization stays in the API key.** Every request authenticates with
   `Authorization: Bearer apikey:<id>:<secret>`. `/net-api/turn` already accepts
   this; MCP is the only surface that insists on a session bearer.
2. **The presence handle is an opaque non-secret.** It names *which presence*,
   not *who*. **Every request re-checks the `(handle, authenticated actor)`
   binding** — possession alone grants nothing. This is also exactly what
   SEP-2567 requires ("handles must be authorized on every request").
3. **Explicit lifecycle**: create, renew, close, TTL. Not ambient.
4. **[revised]** An omitted handle **MUST NOT** mean "ambient current presence."
   Instead: one **stable canonical/default presence per actor**, plus explicitly
   named secondary presences. Multi-presence is preserved because existing
   editor behaviour depends on it (`spec/semantics/moveto.md` §153). Ambient
   resolution would reintroduce exactly the connection-dependent state the
   revision forbids.

**New: use `x-mcp-header` for the handle.** Mark the presence-handle parameter
with `x-mcp-header`, so conforming clients mirror it into `Mcp-Param-Presence`.
That gives edge routing without a session — and SEP-2243's security rules
*mandate* the binding check we want anyway. It also settles the shard question:
**do not commit to removing the shard hint.** Protocol statelessness forbids
protocol-level session affinity; it does not forbid application-level routing,
and a routable handle is the spec-sanctioned way to keep it.

## 4. Why the durable feed is mandatory, and what it actually costs

Two clauses make the current in-memory queue unworkable rather than merely lossy:

- **No affinity.** A `woo_wait` may land on any instance; a queue in one gateway
  DO's memory cannot be read from another. Today the session id smuggles a shard
  hint — a mechanism the revision deletes from the protocol layer.
- **Mandated retry without resumability.** A broken stream loses the in-flight
  request and the client **MUST** re-issue. Against an at-most-once queue the
  re-issue re-reads nothing and silently drops the interval.

**So the primitive changes: a cursor, not a queue.**

### 4.1 What we do *not* already have [corrected]

The first draft claimed we could build this from existing structures. Review
corrected all three; verified in source:

| Assumed | Reality |
|---|---|
| `net_gateway_mcp_watermark` is a cursor we can read from | It is a **bounded, gateway-local continuity proof** (gateway-do.ts ~7942, `SELECT DISTINCT scope FROM net_gateway_mcp_watermark` in the DO's own SQL). Not a source-log cursor. |
| Scope replay contains the observations we deliver | It records **sequenced transcripts** (`ReplayLogEntry{space, seq, ts, actor, message, observations, applied_ok}`, src/net/replay-pages.ts). Direct/live observations — `tell()`, cluster-scope lines — are **not** in it. |
| `E_RETENTION_GAP` exists | **It does not exist anywhere.** Scope replay is currently **unbounded**; the `retention_gap` string in types.ts is a *projection staleness reason*, unrelated. Pruning **and** the gap contract are both new work. |

Room-only replay is therefore **insufficient**: it would silently lose direct
`tell`, cluster and other live observations — the precise failure class we just
spent a review round eliminating from the audience model.

### 4.2 The feed [adopted from review]

Build **one durable, monotonically sequenced feed per presence**, containing
exactly the observations the current MCP queue would deliver *after audience
filtering*. Cursor bound to `(actor, presence, feed generation)`, exposing
`next`, `head`, `oldest_available`. **Repeating a cursor MUST return the same
page.**

Open sub-decision to make explicitly: whether the actor's **own turn's**
observations are also appended. Including them with stable event ids gives
better response-loss recovery — which interacts directly with §5, since a
retried mutation wants to discover whether its effects already landed.

Consequence worth stating: **the `gap` boolean we shipped 2026-07-27 disappears.**
A cursor cannot hide a gap. Its honest successor is a gap *response* naming
feed generation, requested position, `oldest_available`, `head`, and an explicit
reset cursor.

### 4.3 Retention

Promise **"no silent loss"**, not a fixed window. Bound retention by **both age
and storage volume**, after measuring real event rates. **Implement and test
pruning before claiming bounded retention** — today there is none.

### 4.4 Waiting

**Keep bounded long polling (~20–25s).** It remains an ordinary stateless HTTP
request, and cursor-based re-issue is safe. `timeout=0` stays a pure read.
Client-paced polling would add latency and request volume for no benefit.

`subscriptions/listen` does **not** serve the observation feed — its core filter
set is closed to list-changed types. It *is* the right home for our existing
`notifications/tools/list_changed`, which today rides the GET stream we must
retire.

## 5. More urgent than the migration: mutation retry safety

**Verified defect in the deployed system, not a design question.**

`gateway-do.ts:5387` mints `const turnId = \`mcp:${crypto.randomUUID()}\`` per
HTTP request and passes it as the turn's `idempotency_key`. If a mutation
commits and its HTTP response is lost, a retry executes it **twice**. Observation
cursors do not fix this.

The fix is small because every other surface already does it right:
- `/net-api/turn` honours a client-supplied `idempotency_key` (source comment:
  "Client retries reuse their supplied idempotency key (CO2.5)").
- The WebSocket turn frame accepts `idempotency_key?`.
- The scope keeps a keyed reply cache with a bounded recovery tail
  (`this.replies.get(submit.idempotency_key)`, src/net/scope.ts) — a replay of
  the same key returns the recorded reply.

**MCP is the only client surface that cannot be retried safely.** Every mutating
control needs a client-stable `operation_id` (or `_meta` equivalent) threaded to
the existing key; operations wanting durable async results may instead use Tasks.
Required test: **fault injection where the commit succeeds, the response is
dropped, and the retry produces the outcome exactly once.** This is being fixed
now, ahead of the migration.

## 5b. The current wire profile is only partially enforced — fold into the migration

A review of the shipped MCP surface found the claimed `2025-06-18` profile
enforced only in part: `initialize` parameters are ignored; protocol-version
headers are not validated; a malformed pagination cursor silently becomes page
zero; a missing or expired session answers with a JSON-RPC error at HTTP 200;
and dynamic tool arguments are not validated against their advertised schema
before invocation. Each diverges from the 2025-06-18 lifecycle, transport,
pagination, and tools requirements.

**Deliberate decision: do not harden the existing parser.** The 2026-07-28
revision changes every one of those surfaces — the handshake disappears, the
version moves into `_meta` plus a matching header, results gain `resultType`,
and list results gain `ttlMs`/`cacheScope`. Hardening a parser we are about to
retire spends the work twice and leaves two divergent code paths during the
dual-era window.

Instead this becomes a **first-class requirement of the migration**: a shared
**versioned codec / state-machine layer** that owns wire validation for both
profiles — one place that knows which fields are required in which revision,
validates headers against body and `_meta`, rejects malformed cursors, maps
protocol faults to correct HTTP status and error codes, and validates tool
arguments against the advertised schema before dispatch. Dual-era conformance
(§8 step 4) is then a property of that layer rather than of two parsers.

Argument validation deserves its own note, and a second reviewer independently
reached the same conclusion: it is the one item on that list that is **not
merely conformance**. An unvalidated argument reaches verb dispatch, so the
`inputSchema` we advertise to models is decorative. That is a *current
correctness exposure*, not future conformance work, and the honest consequence
is that it should not wait for the codec if the codec slips. Tracked
separately from this note's deferral.

**LANDED EARLY, 2026-07-28 — argument validation is no longer deferred.** It
was taken out of this bundle and shipped ahead of the codec, for the reason
above: malformed input reaching the VM is a correctness matter independent of
which protocol revision we speak, and the fix does not depend on any
2026-07-28 wire change. It is specified in
[spec/protocol/mcp.md §M4.3](../spec/protocol/mcp.md) and covered by
`tests/worker/net-mcp-arg-validation.test.ts`. Both doors are validated
against the object that was advertised — dynamic tools against the published
protocol schema, `woo_call`'s positional list against the resolved verb's own
`arg_spec` — so there is no second derivation for the codec to reconcile
later.

The **other four** §5b items remain deferred to the versioned codec exactly as
described above: ignored `initialize` parameters, unvalidated protocol-version
headers, a malformed `tools/list` cursor silently becoming page zero, and
protocol faults answering at HTTP 200. When the codec lands it should ABSORB
the argument validator rather than reimplement it — a second implementation
would recreate the advertisement/validator drift this fix exists to prevent.

**Do not describe MCP mutation retries — or this migration — as exactly-once
safe until the routing-pin invariant is resolved.** A 2026-07-28 review
disproved the pin ⊇ receipt claim with two persistence probes (a shard-wide
ceiling that deletes by global rowid ignoring scope, and same-scope abandoned
submissions evicting a live-receipt pin). The guarantee is real only within a
window whose boundary the two stores do not currently share.

## 6. Tool-list policy [revised]

SEP-2567 requires list endpoints to depend on *deployment and authenticated
principal*, not prior calls. Our per-actor dynamic projection currently varies
with movement and presence — non-conforming.

Adopted answer: **make `tools/list` stable for the authenticated principal.**
Expose only stable woo controls there — `woo_call`, `woo_wait`,
`woo_list_reachable_tools`. Contextual verbs stay discoverable *through* those
controls rather than by mutating the list. Two constraints: avoid global
enumeration (Big-World), and **do not disguise presence state as a different
authentication principal** to sneak variation back in.

This is also the strongest argument yet for the deferred tool-granularity
redesign (walkthrough note §b): the protocol now *requires* what that redesign
independently wanted.

## 7. Native vs SDK [revised]

**Keep the existing native business logic.** Surface is six SDK import sites and
`/net-api/mcp` is already hand-written; the revision makes a compliant server
*simpler* (no handshake, no session store, no resumability, no server-initiated
requests). `createMcpHandler` expects to own a request lifecycle our Durable
Object owns (auth, authority prefetch, turn planning, tracing, metrics), and the
v1→v2 codemod targets `.tool()`, an API we never adopted.

**But run a small Phase-4 spike** comparing the official v2 handler *at the wire
edge* against native handling validated by the pinned schema. And note the
review's correction: **SDK public result types omit wire-only fields, so
importing types alone is not an adequate conformance test.** Conformance must be
schema-driven, with the SDK client in the smoke lane voting independently on our
wire format.

## 8. Sequence [revised]

1. **Ratify** presence lifecycle, feed semantics, stable tool-list policy,
   retention contract, and mutation idempotency. **Pin the protocol artifact.**
2. **Durable feed + cursor behind the legacy surface**, including response-loss
   and retention-gap tests. Independently valuable; fixes the ~10s eviction loss.
3. **Stabilize `tools/list`** under the legacy protocol.
4. **Add the modern wire format** and dual-era conformance.
5. **Retire legacy handling only after observing actual client use** — dual-era
   is permitted, not required, and there is no compatibility window obliging us.

Out of scope: Roots/Sampling/Logging (deprecated, unused). Tasks remains
optional for us; revisit if long-running in-world jobs should be first-class to
agents (the scheduling catalog covers the in-world half).

## 9. Sources

Primary: [changelog](https://modelcontextprotocol.io/specification/draft/changelog) ·
[versioning](https://modelcontextprotocol.io/specification/draft/basic/versioning) ·
[SEP-2567 sessionless](https://modelcontextprotocol.io/seps/2567-sessionless-mcp) ·
[SEP-2575 stateless](https://modelcontextprotocol.io/seps/2575-stateless-mcp) ·
[SEP-2243 HTTP standardization](https://modelcontextprotocol.io/seps/2243-http-standardization) ·
[TS migration guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/migration/support-2026-07-28.md).

Corroborating, non-normative: the
[maintainer discussion](https://github.com/modelcontextprotocol/modelcontextprotocol/discussions/2547)
documents the transport-vs-application session confusion this note is about;
[Microsoft App Service](https://techcommunity.microsoft.com/blog/appsonazureblog/mcp-just-went-stateless-%E2%80%94-what-the-2026-spec-changes-about-scaling-on-app-servic/4530222)
independently reaches the same conclusion that removing affinity pushes handle
state into durable shared storage. Practitioner commentary is anecdotal only and
drives no claim here.
