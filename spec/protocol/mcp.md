---
date: 2026-05-02
updated: 2026-07-27
status: implemented
---

# MCP protocol

> Part of the [woo specification](../../SPEC.md). Layer: **protocol**.

MCP lets one model inhabit one woo actor. The primary surface is a dynamic
tool list derived from the actor's current structural context. Moving between
spaces or moving an object into inventory changes which object verbs are
available; the gateway does not encode catalog names or command words.

This document specifies the initial Net MCP profile. The classic MCP host is a
rollback implementation and is not the reference for new behavior.

## M1. Connection and authentication

The Streamable HTTP endpoint is `POST /net-api/mcp`. `initialize` carries an
API-key credential in `Mcp-Token`, using the normal woo form
`apikey:<id>:<secret>`. The gateway authenticates the key, creates a Net
session, and returns its bearer in `Mcp-Session-Id`. Every later request must
carry that session id and is authorized as the session actor.

The initial Net profile accepts API keys only. Guest, account-bearer, and
wizard-bootstrap initialization are future credential carriers; adding one
must reuse the normal Net authentication path rather than add MCP-only
identity semantics.

`DELETE /net-api/mcp` with `Mcp-Session-Id` closes the Net session and drops
its local observation queue. A missing or already-expired session makes delete
an idempotent success.

One MCP session binds to one actor. MCP never changes `actor`, `progr`, verb
permissions, or the normal Net turn authority rules.

The `initialize` result's `instructions` string is an agent's entire
orientation — many MCP clients read nothing else unprompted — so it must name
the actor, state that the dynamic tool list tracks structural context and must
be re-listed on `notifications/tools/list_changed`, and point at the three
entry moves: the actor's own `help` tool, `woo_wait` for hearing other actors,
and `woo_list_reachable_tools` for paging the dynamic surface.

The stdio entry is a transport bridge. It forwards JSON-RPC messages to this
HTTP surface, retains the returned session id, and closes the session when
stdin closes. A pipelined pre-session prefix is ordered behind `initialize` so
every later request carries the returned session id. Once initialized,
independent requests are forwarded concurrently: a long `woo_wait` must not
head-of-line-block calls or MCP keepalive traffic. The bridge must not create an
in-process world or dispatch verbs through a second host. After forwarding
`notifications/initialized`, it opens the session's Streamable HTTP GET/SSE
channel and forwards each server notification as one newline-delimited stdio
message. Either successful empty acknowledgement (`202` or `204`) starts the
channel. Closing stdio aborts that channel before deleting the Net session.

## M2. Tool surface

Standard `tools/list` returns stable protocol controls followed by dynamic
object tools. It uses MCP cursor pagination and returns at most 128 tools per
page.

### M2.1 Stable controls

| Tool | Contract |
|---|---|
| `woo_list_reachable_tools(scope?, object?, query?, limit?, cursor?, include_schema?)` | Pages and filters descriptors from the same resolver used by `tools/list` and invocation. |
| `woo_call(object, verb, args?)` | Calls any verb on a reachable object by canonical object and verb. `args` is a positional JSON list. |
| `woo_wait(timeout_ms?, limit?)` | Long-polls the session observation queue. Returns `{observations, gap}`. |

These are protocol controls, not world verbs.

`woo_call` is the escape hatch for clients with stale dynamic metadata, and it
is deliberately **wider than the listing**. Its gates are exactly two:

1. the target object is in the session's structural context (§M3); and
2. the verb name resolves on the target's dispatch chain to a bytecode page
   the actor passes the generic execute prefilter for.

Name resolution is **the world dispatcher's rule, unmodified**. Aliases are
patterns, not literals: `l@ook` and `@exam*ine` mark an abbreviation point, a
trailing `*` is a prefix wildcard, and `|` separates alternatives within one
alias.

Precedence is a **total order with two keys**, and both are normative:

1. **Definer order.** Walking the chain (instance, ancestors, then each
   declared feature chain), the first definer that answers wins.
2. **Slot order within a definer.** A definer's verbs are scanned in
   definition order — the slot array — for an exact name match, and then
   scanned again in that same order for an alias-pattern match. The first hit
   of each scan wins.

Neither key may be substituted. Both select a *different verb* rather than a
refusal, so getting either wrong silently runs code the caller did not ask
for: flattening key 1 runs an ancestor's exactly-named verb where the world
runs a nearer class's aliased one, and ordering a definer's verbs
alphabetically instead of by slot resolves an overlapping alias to the wrong
one of two sibling verbs. A transport must therefore share this rule with the
dispatcher rather than restate it. (Exact names cannot collide within one
definer — the authoring door refuses a duplicate — so key 2 only ever breaks
alias ties, but it is ordered for both scans because the ordering is the rule.)

**Unorderable candidates are refused, never guessed.** A gateway resolving
from a sparse view can only apply key 2 when the tied candidates carry
distinct, known slots. When two or more candidates at one definer match and
that condition does not hold, the call is refused with `E_MISSING_STATE` and
`detail.reason: "verb_order_unavailable"`, listing the candidate verb names;
naming a verb exactly remains unambiguous and still resolves. Falling back to
any other ordering would reintroduce the wrong-verb bug in the one case where
it cannot be detected.

`tool_exposed` is a **listing** flag (§M2.2) and has no bearing on `woo_call`.
Gating the escape hatch on an advertising flag made an author unable to invoke
a verb they had just installed on an object in their own inventory. The
routing and authority rules are unchanged: routing still comes from the
descriptor's command contract (§M4), a `direct`-route call still requires
`direct_callable`, and every world authority check still runs inside the
authoritative turn. Exposure remains a discoverability decision, never an
authority grant — and now never an authority *denial* either.

`$me` and `$here` are session aliases accepted in `woo_call`'s `object`
position, resolving to the session actor and the session's active space. They
are transport-level conveniences; no world object bears either id, and they are
not accepted anywhere else in the protocol.

**A session has an active space only when its actor is placed.** `$nowhere` is
the substrate's spelling of "no location", so it is not an active space: it
answers the same as an absent session `activeScope` or a missing live cell.
`$here` for such a session is refused (`no_active_scope`), never silently
retargeted at `$nowhere`, and §M3's structural context reduces to the actor and
its inventory — `$nowhere`'s own verbs are not that actor's affordances. A
freshly provisioned agent is placeless until its first move, so this is the
first state every agent is in, not an edge case.

#### M2.1.1 Refusal vocabulary

A refused `woo_call` names one condition, because each has a different
remediation. `detail.reason` carries the machine-readable form:

| Condition | Code | `detail.reason` |
|---|---|---|
| Target is not in structural context | `E_PERM` | `target_not_reachable` |
| `$here` used with no active space | `E_PERM` | `no_active_scope` |
| Verb resolves nowhere on the chain | `E_VERBNF` | `verb_not_defined` |
| Several verbs match and their order is undecidable | `E_MISSING_STATE` | `verb_order_unavailable` |
| Verb resolves to a native page | `E_PERM` | `native_verb` |
| Verb fails the execute prefilter | `E_PERM` | `verb_not_executable` |
| `direct` route, verb lacks `direct_callable` | `E_DIRECT_DENIED` | `not_direct_callable` |

`E_VERBNF` uses the engine's `{obj, name}` detail shape. Each refusal also
carries a `remediation` string naming the action that would change the answer.
A world-level refusal from the turn itself carries no gateway `reason` — that
is how a client distinguishes "the gateway would not send it" from "the world
said no".

Refusals shaped by the gateway for a client's benefit never weaken a rule. In
particular an `E_SCOPE_SPLIT` (CO2.3) raised for a mounted tool-space the
actor has not entered stays terminal; the gateway only adds `active_scope`,
`target`, and a `remediation` naming the space to enter.

`woo_list_reachable_tools` returns:

```json
{
  "scope": "active",
  "active_scope": "the_chatroom",
  "object": null,
  "query": null,
  "limit": 64,
  "cursor": null,
  "next_cursor": null,
  "total": 12,
  "tools": []
}
```

`active_scope` always names the authenticated session's current command focus
(or `null` when it has none), independently of the requested presentation
`scope`. A client can therefore interpret or navigate the returned descriptors
without guessing focus from contextual objects that may include mounted spaces.
`query` is a case-insensitive match over name, object, verb, aliases, and
description. `include_schema:true` adds `input_schema` to descriptor summaries.
Limits default to 64 and cap at 256.

`total` counts **dynamic descriptors only** and is not capped. Standard
`tools/list` returns at most 128 entries per page **including** the stable
`woo_*` controls. The two numbers are therefore not comparable — a client
comparing `tools/list` page 1 against `total` is comparing a page to a total,
not observing a filter disagreement. The identity that does hold, for the same
session and `scope:"active"`, is:

    (every tools/list page, concatenated).length
      == total + (number of stable controls)

The tool's own description states this, so an agent does not need the spec to
reconcile the two.

The supported scopes change presentation, never authority:

| Scope | Selection |
|---|---|
| `active` | Actor, active space, active-space contents, and inventory. This is the default. |
| `here` | Active space and its direct contents. |
| `object` | One named object, only if it is already in structural context. |
| `space` | One contextual space (or the active space) and its direct contents that are themselves in structural context. |

There is deliberately no `all` scope. `active` already returns the complete
structural context; a separate `all` had no distinct selection (it resolved to
the same local closure) and wrongly implied a global tool enumeration, which
Big-World forbids ([distribution.md](../semantics/distribution.md)). A request
for `scope: "all"` is rejected.

### M2.2 Verb mapping

For each contextual object, the gateway walks the instance, parent chain, and
explicit feature chains in normal dispatch order. The first page for a verb
name wins; an unexposed override therefore hides an exposed inherited page.
Aliases do not become duplicate tools.

A page is advertised only when all of these hold:

- it is bytecode-backed; a native page has no portable Net execution body;
- `tool_exposed` is true, or the object is the active command surface (or one
  of its visible contents) and the verb has non-empty command metadata; and
- the actor passes the gateway's generic execute-permission prefilter.

The authoritative Net turn performs the permission check again. Exposure is a
discoverability decision, never an authority grant. The second bullet is a
**listing** condition only: `woo_call` (§M2.1) reaches an unadvertised page on
a reachable object.

The description is the verb doc-comment's first **paragraph** followed by the
canonical call form. The doc-comment is whichever comment appears **first in
the source**, whatever its style: preferring one style over the other makes a
verb advertise an incidental aside from deep in its body instead of its opening
documentation. A paragraph is that block comment's first paragraph, or the
contiguous run of `//` lines beginning at the first one, ending at a bare `//`
or at the first non-comment line. It is collapsed to a single line and clamped
to 500 characters on a word boundary with a trailing ellipsis. Taking the first
*line* instead truncates wrapped doc-comments mid-sentence, which is what an
agent then reads as the verb's whole contract.

`inputSchema` is derived from `arg_spec.args`/`params` and optional type
hints. When explicit hints are absent, the gateway preserves the stable JSON
shape implied by aligned `arg_spec.command.args_from` entries: parser text is a
string, resolved object slots are object-id strings, and `cmd` is an object.

Named invocation maps JSON object properties to positional verb arguments in
the declared order. Missing properties become `null`. `woo_call` accepts the
positional list directly.

### M2.3 Tool naming

The base form is `<sanitized-object>__<sanitized-verb>`, where sanitizing
strips one leading `$` and replaces every character outside `[A-Za-z0-9_]`
with `_`; a numeric suffix (`_2`, `_3`, …) resolves collisions. Tools are
sorted by canonical object then verb before collision assignment, except that
**the session actor's own object sorts ahead of the alphabetical remainder**.
The actor's own verbs are how it acts at all, so they must never be displaced
past the page cap by objects that merely happen to share its space: the
actor's tools occupy the first dynamic slots of the first page, after the
stable controls.

That ordering is a guarantee of **precedence, not completeness**. Nothing
bounds how many verbs a class chain and its features can contribute, so a suit
larger than one page still spans pages; what the ordering guarantees is that
the overflow is the actor's own tail rather than an arbitrary subset displaced
by unrelated objects. A client that pages only once therefore sees the actor's
tools first and, while the suit fits, all of them. This is the only privileged
position in the listing; it changes rank, not membership or authority.

**Names are assigned canonically, over the session's complete reachable
context, and neither filtering nor paging ever changes one.** Whatever a
client asks for — standard `tools/list`, any `woo_list_reachable_tools`
`scope`, an `object` or `query` filter, any page of any of them — a given
`(object, verb)` pair in that session's context is advertised under one and
only one name, and invoking that name reaches that object. This is the
property an agent relies on when it calls what it was told to call, so it is a
protocol guarantee rather than an implementation detail.

The reason it needs stating is that sanitizing is **lossy**: `$a-b`, `a+b`,
`a b`, and `$a_b` all render `a_b`, so distinct objects genuinely do compete
for one base name and the numeric suffix is the only thing separating them. A
suffix is meaningful only relative to the set it was computed over, so a name
computed over a *subset* is not the same name — a filtered view that
disambiguated among only the objects it kept would hand out the unsuffixed
name for one of them while invocation, resolving over the whole context, bound
that name to another. Discovery therefore computes one canonical descriptor
set, names included, and every scope, filter, and page is a projection of it.

A corollary: presentation scopes select from that canonical set by object and
can never widen it. `space` names one *contextual* space and its direct
contents; contents that are not themselves in structural context (M3) are not
advertised, because a descriptor neither dynamic-name invocation nor
`woo_call` would accept is not an advertisement.

Prose that names a tool — refusal remediations, `instructions` — must read the
name from the canonical assignment for the same reason. Re-deriving one by
sanitizing an id ignores the suffix and can name a different object's tool.
The single exception is the session actor's own tools: the actor sorts first,
so its descriptors are never the ones that carry a suffix.

Names are stable for as long as the context is. Context changes (moving,
taking, an object arriving) can re-rank a collision, which is exactly what
`notifications/tools/list_changed` (M6) exists to announce; a client that
re-lists on the hint never observes a shifted name.

## M3. Structural context and navigation

The dynamic context is exactly the union of:

1. the session actor;
2. the session's active space;
3. direct members of that space's `contents` relation; and
4. direct members of the actor's `contents` relation (inventory).

Expansion is one level only. It does not recursively traverse containers or
catalog registries and it never performs global enumeration.

Another live presence actor in the active space is social context, not an
object-tool target. Agents interact with people through the space's social
verbs. A self-hosted object marked by the generic
`host_placement: "self"` role remains an ordinary tool target even when it has
a live session. This distinction is structural and contains no catalog or
class-name special case.

The in-world `$actor:focus`, `$actor:unfocus`, and `$actor:focus_list` behavior
is not an MCP control plane. It does not broaden this context. Navigation is
therefore a single clean path: call an available movement verb, then re-list.
A task in the current task board exposes `claim`; once claimed into inventory,
its lifecycle verbs follow the actor without a focus/re-list/unfocus sequence.

Woo object references are runtime strings and verbs do not yet declare result
schemas. A gateway must not infer capabilities from returned string shapes or
field names. A future returned-reference extension requires explicit typed
result metadata and a separately bounded session context.

### M3.1 Cold contextual objects

The relation mirror can know that an object is contextual before the gateway
holds that object's lineage and verb pages. A `contents` relation row therefore
carries optional `member_scope`, the member object's immutable authority
scope. This is routing metadata, not object truth and not a client-visible
field. Install planning, relation derivation, and bounded relation rebuilds
populate it.

Before listing or invoking, the gateway groups contextual members by
`member_scope` and performs one full targeted object pull. A lineage row alone
does not prove that a sparse transfer included the object's own verb pages.
Completed pulls have a bounded success memo; missing or dangling members use
exponential retry backoff capped at 30 seconds and a bounded failure memo. The
gateway considers at most 128 members per request. Repeated model renders or
`tools/list` calls must not create a read storm.

Legacy rows without `member_scope` fall back to the relation owner's scope.
That is exact for ordinary room-owned contents and actor-owned inventory. A
foreign-anchored legacy inventory row becomes fully routable when its next
normal relation mutation refreshes the row. Operators upgrading an aged world
that requires immediate completeness for such inventory must refresh those
derived rows before declaring MCP parity; runtime global lookup is forbidden.

## M4. Invocation and results

Dynamic-name calls and `woo_call` resolve through the same current descriptor
producer, over the same structural context, and differ only in the listing
gate (§M2.1): a dynamic name can only exist for an advertised page, while
`woo_call` also reaches unadvertised ones. A globally known but non-contextual
object is refused for both. A canonical target must also pass the concrete
runtime-object-id validator before it can consume turn planning or repair
budget.

Every accepted invocation enters the normal Net client-turn path; MCP never
runs a private VM. The turn's idempotency key comes from the client's
operation id when one is supplied (§M4.2) and is otherwise freshly minted.
Routing comes from the descriptor's
command contract: `persistence:"live"` selects `direct` (and therefore still
requires `direct_callable:true` at ingress), while `persistence:"durable"`
selects `sequenced`. A tool-exposed verb without either declaration defaults to
`sequenced`. Thus chat reads and speech do not contend on a space log merely
because they arrived over MCP, while durable domain operations retain their
ordering boundary.

Successful `tools/call` results use:

```json
{
  "content": [{"type": "text", "text": "<JSON result>"}],
  "structuredContent": {"result": null, "observations": []},
  "isError": false
}
```

World or Net failures use the same MCP tool-result envelope with
`isError:true` and `structuredContent.error`. When the failure is a verb that
THREW on an accepted commit, the envelope also carries that turn's
`observations` (§M4.1) and, on a replay, `replayed`/`replay_outcome` (§M4.2) —
an error the client cannot distinguish from a fresh one is a retry hazard.
JSON-RPC protocol errors such as an unknown tool name use a JSON-RPC error
object. A missing, expired, or malformed MCP session is rejected before
discovery or invocation.

### M4.1 The submitter's own observations

**The reply is the seat for the submitting session's own turn observations.**
A verb invocation's accepted reply carries `structuredContent.observations`:
the turn's transcript observations, minus any line directed at a different
actor. The stable `woo_*` protocol controls carry no such field — a `woo_wait`
reply holding both its drained queue and an always-empty sibling would be
misleading.

This is not new policy; it is the rule the transport layer already assumed. The
gateway records the submitting turn echo id and suppresses the actor's own
committed echo from `woo_wait` *because* the reply is supposed to carry it.
Honouring only one half — the suppression — left an MCP actor unable to observe
its own action at all: it could move between rooms and never read its own
arrival line, while everyone else did.

The field is a **sibling of `result`, never nested inside it**: `result` is the
verb's own return value and may be any JSON, including a scalar or `null`, so
it has no room for transport metadata. A client that reads only text content
sees the same rows in a second content block; the first block keeps the
payload shape it has always had.

Exactly one seat. `observations` on the reply and the queue's echo dedupe are
two halves of one rule, so a client that reads both never receives an event
twice, and delivery to every other session is unaffected.

**The seat survives failure.** A verb that emits and then throws still commits
its transcript, so those lines happened — and because the echo dedupe has
already suppressed them from `woo_wait`, the error envelope is their only
carrier. An `isError:true` result for an accepted commit therefore carries
`structuredContent.observations` under the same filtering rule as a successful
one. Transport failures and rejected commits ran no verb and carry none.

A detected idempotent replay (§M4.2) commits nothing this round. It carries
the observations RECORDED with the committed execution, never the retry's own
re-planned ones.

### M4.2 Retry safety: the operation id

A `tools/call` that changes the world MUST be safe to retry. HTTP responses
are lost — network drops, Durable Object eviction, client timeouts — and a
client that cannot distinguish "never committed" from "committed, reply lost"
has only two options, both wrong: retry and risk a second execution, or give
up and risk none.

**The id.** A client MAY supply a client-chosen, client-stable `operation_id`
for a `tools/call`, in either of two carriers:

- `params._meta["woo.net/operation_id"]` — the protocol carrier. It cannot
  collide with a verb's argument names and it survives the stateless protocol
  revision, in which sessions are removed but `_meta` is required on every
  request. It takes precedence when both are present.
- `arguments.operation_id` — the advertised carrier, present in the input
  schema of `woo_call` and of every dynamic tool. It is what makes the
  mechanism visible to a model, which will never populate an unadvertised
  `_meta` field. It is NOT advertised, and NOT read, for a verb that declares
  its own parameter of that name: that verb owns the name, and its callers
  use `_meta`.

The value MUST match `[A-Za-z0-9._:-]{1,128}`. A malformed value is refused
with `E_INVARG` (`detail.reason:"invalid_operation_id"`) and commits nothing;
it is never silently downgraded to a minted key, which would leave the client
believing it was protected.

**Who mints it.** The client, never the server. The server namespaces it per
authenticated actor before it becomes the turn's idempotency key, so two
agents that independently choose the same string do not collide.

**Optionality and the read/write split.** The id is OPTIONAL everywhere, and
absence preserves the prior behaviour exactly: a fresh key per call. It is
not required for mutating verbs either. Requiring it would break every
existing client on a live surface, and the server cannot decide reliably in
advance which calls mutate — the descriptor's `persistence` contract declares
a durability intent, not a write set, and a `sequenced` verb may write
nothing. So the server accepts the id universally and lets the authority's
keyed reply cache decide, and the tool schema tells clients where it matters:
**supply one for any call that changes the world; omit it for reads, which
are safe to re-issue.**

**What a retry is promised.** A retry under the same operation id, from the
same actor, within the retention window (below):

1. does not execute a second time — the authority returns the reply recorded
   for that key (§CO2.5); and
2. learns the outcome of the execution that DID commit. The reply carries
   `structuredContent.replayed:true`, `replay_outcome`, the recorded
   `result`, the recorded `observations`, and — if the verb threw — the
   recorded error as a normal `isError` result. A verb that threw still
   commits its transcript, so replaying that as an empty success would be
   worse than the double execution this mechanism prevents.

The retry's own re-plan is NEVER presented as the outcome. It describes an
execution that committed nothing, and for a turn reading `now()` or `random()`
it would be a plausible wrong answer.

**Effect-free but visible turns are covered too.** A turn that touches no
authority cell is an authority-validated READ and the scope does not cache its
reply (§CO4) — that is what keeps concurrent view refreshes from becoming
storage writes on an unchanged scope. But such a turn can still be externally
VISIBLE: a `persistence:"live"` verb like room speech emits to every peer while
writing nothing. Deduplicating only durable mutations would make the advertised
promise false for exactly that case, since speech changes what peers perceive.

So a submit carrying a client-named key records a **receipt** — the reply, and
nothing else. The head does not advance, no sequence number is consumed, and
nothing is ordered, so speech still never contends. A retry then replays the
receipt, and the live carrier is not re-run: the peer hears the line once.

The receipt is the client's explicit opt-in, never inferred from the presence
of a key. An MCP `operation_id` sets it; on `/net-api/turn` and the WebSocket
turn frame it is `retry_safe:true` alongside the key. Clients that mint a fresh
key per turn and never reuse it — the browser does — keep the write-free path
they have always had.

`replay_outcome` names how much survived:

| value | meaning |
|---|---|
| `full` | result, error, and observations are the recorded ones |
| `partial` | some part existed and was not retained; `replay_omitted` lists which of `result`, `error`, `observations` |
| `none` | no outcome was retained for this key |

When the result was not retained, `structuredContent.result` is ABSENT rather
than `null`: a client must be able to tell "the verb returned nothing" from
"the verb returned something I cannot show you". Every non-`full` replay also
carries a prose content block stating that the operation ran exactly once and
that the client must re-read state rather than retry under a new id.

An outcome is retained up to 4 KiB serialized. Over that, observations are
dropped first (the client can re-orient with a read) and the loss is named.
Return values are retained for MUTATING turns only — a turn that wrote
nothing is safe to re-issue under a fresh id, and read results are the large
ones, which must not grow the CO7 commit envelope.

**One key answers one request.** A recorded reply carries a canonical
fingerprint of the request it answered: a hash over `{actor, target, verb,
args, route}`. Reusing an operation id for a **different** call is refused with
`E_IDEMPOTENCY_CONFLICT` (`detail.reason:"operation_id_reused"`) and commits
nothing. This is not an argument-validation error and must not be reported as
one — the client's arguments are fine; what is wrong is the id, and only a
distinct code tells the client which of the two to change. The refusal never
echoes the original call: the holder of a colliding key must not learn what it
collided with.

The fingerprint canonicalisation is normative:

- object keys are sorted before hashing, so structurally equal argument maps
  agree regardless of property order on the wire;
- the call is the **resolved** one — `$me`/`$here` and verb **aliases** are
  resolved before the turn is built, so two spellings of one call agree and
  MUST NOT conflict;
- `session` is excluded: the same actor retrying from another session is the
  same operation;
- the planning anchor is excluded: a turn that MOVED the actor re-plans from
  the new room and must still replay cleanly.

The fingerprint is stored with the reply at the authority, so the check holds
across gateway eviction and scope restart. A conflict never overwrites the
recorded reply — the original caller's receipt must survive another client's
mistake. A submit or a recorded reply from before this field existed skips the
check rather than guessing.

**Binding.** The retained outcome belongs to the actor whose turn committed
it. A submit from a different actor under the same key still learns that its
own submit committed nothing — that is the safety property — but receives
`replay_outcome:"none"`, never the first actor's return value or directed
lines. Idempotency keys are client-chosen on `/net-api/turn` and the
WebSocket turn frame too, so identical strings from different clients are
possible and must never become a read channel.

**Past the retention window.** Idempotency is a bounded-window guarantee, not
an eternal one. The committing scope retains recorded replies for **at least
its most recent 256 commits** (the recovery-tail window, never pruned) and at
most 1024 total; the gateway's scope pin has the same posture. A retry
arriving after its reply has pruned is a NEW turn by every observable
measure: it validates fresh against the current head and current read
versions, and it will execute. Clients MUST NOT treat an operation id as a
durable receipt. Operations needing a durable, long-lived outcome record are
domain state (an order id, a task) and belong in the world, not in this
cache.

## M5. Observation queue

`woo_wait` drains a gateway-local, per-session FIFO fed by the same
presence-routed fanout as WebSocket clients. It accepts `timeout_ms` from 0 to
25,000 and `limit` from 1 to 256 (default 64). It returns
`{observations:[...], gap:<bool>}`.

The queue holds at most 256 observations and drops the oldest on overflow.
It is intentionally live and at-most-once: Durable Object eviction or session
close drops undelivered observations. Durable observation recovery is a
separate protocol feature and must not be implied by this queue.

**Parking is bounded and cancellable.** Each parked `woo_wait` holds a
continuation and a live timer for up to 25 seconds, so the set of outstanding
waits per session is capped (currently 4 — one in flight is the well-behaved
shape, with slack for a retry). A call beyond the cap is refused as a tool
result with `E_WAIT_LIMIT` and `detail.reason:"wait_concurrency"`; it is never
a transport error, because a client must be able to read it.

`notifications/cancelled` naming a parked request releases that request
promptly. A cancelled wait **drains nothing**: it returns no observations and
does not advance the continuity watermark, because the client is no longer
reading that response and consuming rows into it would turn at-most-once
delivery into none. Cancellation is advisory — an unknown or already-completed
request id is not an error — and can only ever release a wait parked under the
same session. Without honouring it, a bounded waiter set would let a client's
own abandoned polls refuse its next legitimate one until they timed out.

**Eviction is not rare, and a silent client goes deaf.** The queue lives in
the gateway shard's memory, and on Cloudflare an idle shard is evicted within
roughly ten seconds. A session that stops asking therefore stops hearing:
measured against the deployed worker, a co-present peer that slept 15s missed
its partner's room line entirely (and its next reply carried `gap:true`),
while the same peer holding a parked `woo_wait` across the same window
received it. An in-flight request is what keeps the shard — and the queue —
alive.

A client that wants to hear everything MUST keep a wait in flight rather than
poll on a duty cycle longer than the eviction window. This is a real limit on
the current design, not an incidental one: it is the direct consequence of a
live, gateway-local, at-most-once queue, and the `gap` marker below exists to
make its consequences legible rather than to remove them. Removing the limit
means durable observation recovery, which this section explicitly does not
promise.

Multiple parked waits may wake together, but draining uses prefix removal so
an observation is returned to at most one waiter.

**Client obligation.** A reply is the client's only copy: the rows it carries
are already removed from the queue, and no later `woo_wait` will return them.
A client that filters a reply — waiting for one kind of observation and
keeping only the match — therefore *destroys* every other row in that batch.
Batch composition is a server-side timing artifact and carries no meaning: the
same two facts arrive in one reply or two depending only on how close together
they committed and how warm the gateway is. Clients that assert over a
sequence of observations MUST buffer the rows they did not consume, or they
will fail intermittently, on exactly the fast paths where the server is
working best.

### M5.1 Continuity marker

Every `woo_wait` reply carries `gap`. It is a **continuity claim about the
queue, not a count of lost observations**: `gap:false` means this gateway can
prove the session's queue has been continuous since the client's previous
drain; `gap:true` means it cannot, so observations may have been lost and the
client should re-orient (look/who) rather than assume it heard everything.

Delivery semantics are unchanged — still in-memory, still at-most-once, still
no durable storage. `gap` only reports what the transport already knew and
previously discarded silently. A browser WebSocket client can live with silent
at-most-once loss; a turn-based polling agent, for which the observation queue
is its only ear, cannot.

`gap` is set when:

- a bounded-buffer overflow discards undelivered rows; or
- the gateway reconstructs live session state for a session whose durable cell
  already exists — a Durable Object restart or a capacity eviction — **and
  cannot prove that nothing was delivered to the session's scope while that
  state was missing**.

Losing the live queue is not by itself a continuity break. Losing it *across a
delivery* is. The gateway keeps two durable per-scope delivery counters — the
committed-fanout lane position and a count of applied live-fanout bodies — and
records both, together with the session's scope, on every `woo_wait` reply.
A reconstruction compares them: unchanged counters prove the session missed
nothing and the reply is gap-free; either counter advanced (or no watermark
survives, or the session's scope changed) means it cannot prove continuity and
the reply carries `gap:true`.

This distinction is load-bearing rather than cosmetic. On Cloudflare an idle
gateway shard is evicted within roughly ten seconds — measured against the
deployed worker, far inside a turn-based agent's think time — so an
unconditional gap-on-reconstruction fires on essentially every poll and teaches
agents to ignore the marker, which is the one outcome that makes it useless.

It remains **conservative** in the safe direction: an advanced counter reports
a gap even when the delivery in question would not have reached this session
(a peer-directed line, or the session's own echo). It reports what the gateway
can prove, never what it merely hopes. A session whose state was installed by
its own `initialize` and never lost starts gap-free without consulting a
watermark, so an ordinary first wait does not report a false gap.

The watermarks are derived gateway state, bounded like the selection pins: a
pruned or missing row degrades to `gap:true`, never to a false continuity
claim.

The marker is one-shot. It describes a discontinuity, not a state, and is
cleared by the reply that carries it. A pending gap also short-circuits the
long-poll park, so the signal reaches the client on its next call rather than
after a full `timeout_ms`.

## M6. Dynamic-list lifecycle

Net advertises `capabilities.tools.listChanged:true`. A successful standard
`tools/list` or `woo_list_reachable_tools` response records an exact baseline
digest for that session from the same bounded structural resolver used by
invocation. The digest includes the active space, contextual object set, and
complete dynamic protocol descriptors. It is not a catalog revision or a
global-world digest.

After a relevant authoritative fanout applies, the gateway compares that
resolver for only the affected live MCP sessions on the shard. Ordinary room
and actor-scope fanout selects sessions from that scope's presence rows and
the changed actor's own sessions; a verb-definition fanout may select all live
MCP sessions on that gateway because definition changes are rare and can alter
inherited descriptors in every context. Selection never enumerates world
objects or sessions on another gateway.

When a baseline changes, the gateway sends exactly the standard hint:

```json
{"jsonrpc":"2.0","method":"notifications/tools/list_changed"}
```

The hint is session-specific. Changes coalesce until that session re-lists:
after one hint is pending or delivered, further changes do not create a storm.
Re-listing atomically installs the current baseline and clears any undelivered
stale hint. A session with no baseline receives no hint; initialize followed by
the client's first list is not itself a change.

Per-session MCP queues, echo ids, list baselines, and SSE listeners are live
transport state, not durable session authority. A gateway retains at most 512
such states. On insertion pressure it first disposes entries whose mirrored
session cell is missing or expired, then evicts the least-recently client-used
live entry if necessary. Disposal wakes parked waits and closes listeners. It
does not close a still-valid Net session: that session may reconstruct an empty
transport state on its next request and receives the conservative post-eviction
re-list hint described above. Thus abandoned MCP clients cannot grow a hot
gateway without bound, while eviction costs only live at-most-once delivery.

Streamable HTTP clients receive unsolicited hints through `GET /net-api/mcp`
with `Accept: text/event-stream` and the normal `Mcp-Session-Id`. The gateway
returns a bounded SSE listen: a pending hint is delivered immediately;
otherwise the listen closes after at most 25 seconds and the client reconnects.
At most one open stream receives a given hint. A disconnect before delivery
leaves the hint pending, while delivery is live and not resumable. Missing,
expired, or malformed sessions are rejected before a stream is opened.

The notification is a freshness hint only. Clients re-run `tools/list`; the
current structural resolver remains the authorization boundary. No temporary
tool-result field substitutes for the standard notification, and a client may
re-list at any time even if it missed a live hint.

## M7. Security and scaling invariants

- API-key authentication happens before session creation.
- A present Streamable HTTP `Origin` must exactly match the MCP endpoint's
  request origin; headless clients may omit the header.
- Every non-initialize method validates `Mcp-Session-Id` and its expiry.
- Other actors' session bearers never appear in tools, relation results, or
  observations.
- Dynamic listing and dynamic invocation use one authoritative resolver.
- Tool exposure does not bypass execute permissions.
- Context work is proportional to the bounded actor/space context, never the
  installed world or all sessions.
- Catalog identities, command words, and UI shapes do not enter the gateway.

## M8. Deferred extensions

- durable observation delivery;
- additional credential carriers;
- explicit typed returned-object references;
- MCP resources such as `woo://here` or `woo://object/{id}`;
- multi-actor multiplexing and streaming progress.

Each is additive. None requires reviving MCP focus wrappers or a second
execution stack.
