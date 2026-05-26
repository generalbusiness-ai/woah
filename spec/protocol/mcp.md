---
date: 2026-05-02
status: implemented
---

# MCP protocol

> Part of the [woo specification](../../SPEC.md). Layer: **protocol**.

Model Context Protocol surface that lets an LLM agent inhabit a woo world. The agent connects, gets an actor, and from then on its tool list tracks the session's active scope: in `the_chatroom` it sees `say`/`look`/`take`; if it enters `the_dubspace` the toolset shifts to `set_control`/`save_scene`. The wire shape is standard MCP (tools, notifications); the woo-specific behavior is which tools materialize for which actor at which moment.

The two existing inbound surfaces — [v2-turn-network.md](v2-turn-network.md) (browser turn network) and [rest.md](rest.md) (HTTP) — target browser clients and HTTP integrations respectively. MCP is the third, oriented at LLM agents that need affordances they can introspect, dry-run, and call without prior knowledge of the world's object graph. All three protocols hit the same call/applied/observe semantics; they differ only in framing and discovery.

This spec assumes the MCP client supports dynamic tool lists (`notifications/tools/list_changed`). Clients that cache tool metadata or require a static manifest at connect time can still drive woo through the stable control tools in §M2.0, or through whatever room verb the catalog provides as a parser entry point (e.g., `the_chatroom:command(text)`). They lose some of the per-location affordance, but they do not lose access to the world.

---

## M1. Connection model

```
agent ──(MCP)──► woo MCP gateway ──(internal)──► gateway DO / actor's host
```

One MCP connection binds to one woo session, which binds to one actor. The session is established the same way a REST or WS session is ([../identity/auth.md](../identity/auth.md)): the agent presents a token (`guest:<...>`, `bearer:<...>`, `apikey:<...>`, or — for development — `wizard:<bootstrap-token>`), the gateway resolves it to a session and an actor, and that pair is the trust boundary for the duration of the connection.

For Streamable HTTP, the first request carries that woo token in `Mcp-Token`. Clients that only expose bearer-token configuration may instead send `Authorization: Bearer <woo-token>`; the bearer envelope is transport syntax, not a separate woo token class. Subsequent requests carry `Mcp-Session-Id`.

- One actor per connection. Multi-actor multiplexing is not part of this MCP contract.
- The connection's **caller authority** is the actor's identity. Inside the VM, a verb's `progr` ([../semantics/permissions.md](../semantics/permissions.md)) is the verb owner — set at compile time and carried in every frame. The MCP gateway does not invent `progr`; it dispatches calls under the actor's identity, and verb dispatch then derives `progr` from the verb being called per the standard rule. MCP does not elevate authority; an agent connected as `$guest_42` can do exactly what a browser-attached `$guest_42` can do.
- Disconnect drops the connection. Whether the session survives follows the standard session-grace rule from [identity.md §I6](../semantics/identity.md#i6-disconnect-and-reap-lifecycle).

---

## M2. Tool surface

**Dynamic object tools are the primary surface.** Every world-affordance tool the agent sees is a verb on some object in its reachable scope. The projection depends on how the object is reached. `self`, active scopes, inventory, and focused work objects expose explicit `tool_exposed` verbs. Visible room contents expose LambdaMOO-style **obvious verbs**: readable verbs with command metadata, not hidden implementation verbs or inherited self-control verbs. Common-feeling tools (`command`, room `look`, `say`, `wait`, `describe`, and object `look`) feel common because they come from common ancestors — `$space`, `$conversational`, `$actor`, and `$thing` — and those ancestors are in scope from any catalog. New ancestors (a `$dubspace` the actor enters, a `$cockatoo` in the room) bring new verb-tools as their classes define them. The protocol does not curate a baseline of world behavior; the world's class hierarchy does.

This means the MCP gateway is, mechanically, a thin shell around verb dispatch: enumerate reachable objects, filter their verbs, hand the list to the client.

### M2.0 Stable control tools

A small stable control plane exists for MCP clients whose tool metadata can lag the live world. These tools are not world behavior. `woo_call` does not bypass reachability, `tool_exposed`, or permissions; the actor-control wrappers (`woo_focus`, `woo_unfocus`, `woo_wait`) are explicitly part of the MCP protocol and dispatch to their corresponding `$actor` verbs under the actor's normal permissions.

| Tool | Purpose |
|---|---|
| `woo_list_reachable_tools(scope?, object?, query?, limit?, cursor?, include_schema?)` | Returns a paged, scoped listing of dynamic object-tool descriptors: name, canonical object, verb, route, args, and description. Defaults to the bounded `active` scope. |
| `woo_call(object, verb, args?)` | Finds the currently reachable dynamic tool for `<object>:<verb>` and invokes it through the normal direct/sequenced route. `args` is a positional list of arbitrary JSON woo values, not a string-only argv. |
| `woo_focus(target)` / `woo_unfocus(target)` | Stable protocol wrappers around the actor's `$actor:focus` / `$actor:unfocus` verbs. |
| `woo_wait(timeout_ms?, limit?)` | Stable protocol wrapper around the actor's `$actor:wait` verb. |

The wrappers exist because some MCP clients discover tools once, cache aggressively, or route calls through deferred metadata. A stale dynamic name like `the_pinboard__list_notes` may not be in the client's current cache even though `the_pinboard:list_notes` is reachable. `woo_call` gives the agent a canonical escape hatch without requiring the gateway to hardcode catalog objects or expose hidden verbs.

`woo_list_reachable_tools` is one discovery primitive, not a family of per-object helpers. Its `scope` is one of:

| Scope | Meaning |
|---|---|
| `active` | Bounded default: actor, current session active scope, other live actor scopes, inventory, and focused objects. Does not expand every room/space contents entry. |
| `here` | Active scope plus visible contents. Contents use the obvious-verb projection, so other actors and `$block` descendants can be visible without exposing their inherited actor-control surface. |
| `focus` | Focused objects only. |
| `object` | One reachable object named by `object`. |
| `space` | One reachable space named by `object`, or the active scope if omitted, plus visible contents using the obvious-verb projection. |
| `all` | All directly reachable categories: actor, current session active scope, active-scope contents, inventory, other live actor scopes, and focused objects. It does not expand every non-active scope or focus object's contents; use `space` for that deliberate scan. |

The result shape is `{scope, object, query, limit, cursor, next_cursor, total, tools}`. `query` is a case-insensitive filter over tool name, object, verb, aliases, and description. `include_schema` asks the server to include the JSON input schema in each summary; it is off by default to keep discovery compact.

### M2.1 Verb-to-tool mapping

For each object reachable from the actor (§M3), the gateway enumerates that object's verbs and exposes a tool for each verb satisfying **all** of:

- `tool_exposed: true` — the per-verb opt-in flag declaring "this verb is suitable as an agent affordance." A required runtime field on every verb (default `false`); it must round-trip through catalog install, persistent storage, and `verbInfo()`. Verbs without it are still callable via the room's parser if a parser verb routes there, but they don't get a dedicated tool.
- The actor passes `assertCanExecuteVerb` against the verb's perms ([../semantics/permissions.md](../semantics/permissions.md)).

The tool's shape:

| MCP field | Source |
|---|---|
| `name` | Server-assigned; unique within the current tool list. See §M2.4. |
| `description` | The verb's docstring (first paragraph of `source` block comment, or empty). Followed by the canonical call form `<object>:<verb>(args)` and the alias list. |
| `inputSchema` | JSON Schema generated from the verb's `arg_spec`. Optional args become optional schema properties. Type hints from `arg_spec.types` map to JSON Schema types when available; otherwise `unknown`. |

### M2.2 Invocation route — direct vs sequenced

**Tools are not direct-only.** The gateway picks the invocation route per call from the verb's metadata:

- If `verb.direct_callable === true`: the gateway invokes the verb as a **direct call** under the actor's authority. Live observations (per [events.md §12.6](../semantics/events.md#126-observation-durability-follows-invocation-route)) are returned in the result; no log row is written. Dubspace `set_control`, chat `say`/`look`, room `take`/`drop`, and the tasks-catalog lifecycle verbs (`create_task`, `claim`, `pass`, `release`, `handoff`, `reject`, `wait`, `yield`, `drop_terminal`) are direct.
- If `verb.direct_callable !== true` (the verb is `tool_exposed` but mutating-through-a-log): the gateway invokes the verb as a **sequenced call** through the verb's enclosing space. The log entry's `applied` frame becomes the tool result. Catalogs that need ordering across multiple writers (e.g. a queue with strict FIFO semantics) opt in by leaving the verb non-direct; the demo catalogs in this repo currently expose only direct verbs as tools.

The "enclosing space" is resolved by the runtime at dispatch time: the nearest ancestor of the verb's target that is `$space`-descended. For target `the_taskboard`, that's `the_taskboard` itself; for a task `t-7` whose anchor resolves to `the_taskboard`, that's `the_taskboard`. If no enclosing space is found, the tool errors with `E_INVARG` rather than silently routing direct.

**Common verbs by class hierarchy.** The "always-there" feeling of certain tools comes entirely from inheritance:

| Tool the agent sees | Where it lives | Route |
|---|---|---|
| `command(text)`, `command_plan(text)` | `$space` / `$conversational` | direct |
| `look()`, `who()`, `say(text)` | `$conversational` | direct |
| `describe()` | `$root_object` | direct |
| `wait(timeout_ms?, limit?)` | `$actor` (§M4) | direct |
| `enter(target)`, `go(exit)`, `take(item)`, `drop(item)` | `$chatroom` *(demo)* | direct |
| `set_control`, `save_scene`, `recall_scene` | `$dubspace` *(demo)* | direct |
| `create_task`, `listing`, `available_actions`, `set_role`, `set_obligation`, `set_policy` | `$task_registry` *(demo)* | direct |
| `claim`, `pass`, `release`, `handoff`, `reject`, `wait`, `yield`, `drop_terminal` | `$task` *(demo)* | direct |

The first four rows are foundational classes; the remaining rows illustrate verbs from the bundled **demo applications** ([catalogs.md §CT15](../discovery/catalogs.md#ct15-bundled-catalogs-in-this-repo)) — installed catalogs contribute their own verbs in the same shape. The gateway does not construct any of these; it reads the verb tables.

### M2.3 Result shape

Tool results map to the standard MCP `tools/call` response:

```
{
  "content": [{ "type": "text", "text": "<one-line summary>" }],
  "structuredContent": {
    "result": <verb return value>,
    "observations": [<observation>, ...],
    "applied": { "space": <obj>, "seq": <int>, "ts": <ms> }    // sequenced only
  },
  "isError": false
}
```

- `content` is a human-readable summary the client may display directly. Default summary is the rendered `text` field of the first observation, or a stringified form of `result`.
- `structuredContent` carries the machine-readable payload. `result` is the verb return; `observations` is the verb's emit list (filtered for the actor by §M5 audience rules); `applied` is present for sequenced calls and gives the seq/ts the caller can use for replay or gap recovery.
- `isError: true` for tool failures — see §M6.

The agent that prefers structure reads `structuredContent`; the agent that prefers prose reads `content`. Both are always present.

### M2.4 Tool naming and collisions

Tool names are server-assigned and **must be unique within the current tool list**. The recommended encoding is `<sanitized_object_id>__<verb_name>` where:

- `sanitized_object_id` is the object's id with `$` stripped from corenames (`cockatoo` for `$cockatoo`), unchanged for `the_*` ids, and ULIDs collapsed to their canonical 26-char base32 form.
- `verb_name` is the verb name verbatim.

When two reachable objects sanitize to the same name (e.g. a corename `$lamp` and a runtime instance also called `lamp` in scope), the server resolves with a numeric suffix (`lamp__take`, `lamp_2__take`) and emits stable suffixes within a session. Servers that want different encodings are free to choose — the canonical contract is that names are unique and stable for the life of the tool list.

The canonical `<object>:<verb>` form (with sigils) is in the tool's `description`, so the agent always has the full handle for parser-mediated calls.

### M2.5 Aliases

A verb's `aliases` list ([../semantics/space.md](../semantics/space.md)) is **not** rendered as separate tools — that would explode the tool list with duplicates. Aliases are documented in the tool description so agents that want to use them via the room's parser know what's available.

Ordered duplicate verb slots are also collapsed for the v1 dynamic tool list:
only the first tool-exposed slot for a given `(object, verb_name)` becomes a
dedicated MCP tool. Slot-precise authoring and inspection go through the
programmer surface inherited by actors whose class chain includes
`$programmer` (`actor:inspect`, `actor:resolve_verb`, `actor:list_verb`, and
descriptor-aware authoring tools). A future MCP revision may add
descriptor-aware invocation if a catalog has a real need to expose duplicate
same-name verbs as separate tools.

---

## M3. Reachability — what shows up where

The dynamic tool set at any moment is computed against the actor's **reachable scope**, the union of:

1. **Self.** The actor object — for actor-owned verbs (`@quit`, `@home`, `wait`, `focus`, etc.).
2. **Active scope.** The MCP session's `active_scope` and the verbs defined on it. In a chat room, this is where `:say`/`:look`/`:enter` come from. The scope remains reachable even when the location object is remote-hosted and absent from the gateway's local object table; the gateway uses the host route to enumerate it.
3. **Active-scope contents.** Visible objects in the session active scope's contents for which the actor has read access. This category is not filtered by actor-ness. Other actors and `$block` descendants can appear here, but they are projected through obvious command verbs only: readable verbs with command metadata, using the same rule as `$player:examine_detailed`. In `the_chatroom` this surfaces affordances such as `the_cockatoo:squawk`, `the_lamp:give`, or `the_weather:look` when those verbs are command-shaped. Inherited `$actor` controls (`wait`, `focus`, `unfocus`, `focus_list`) remain self tools, not tools on another actor or appliance.
4. **Inventory.** Non-actor objects in `actor.contents`. After `take lamp`, the lamp's verbs follow the actor between rooms.
5. **Other live scopes.** Spaces returned by `all_locations(actor)`, excluding this session's active scope. This lets an agent discover that the same actor has another live tab/tool session in `the_dubspace` without reading any actor-side presence mirror.
6. **Working set.** Objects the actor has explicitly added to its scope via `$actor:focus(target)` (§M3.1). This is how task refs returned from `the_taskboard:listing()` become callable: the agent calls `focus(t-7)` and `t-7`'s verbs (`claim`, `pass`, `release`, `handoff`, …) join the tool list. Bounded; capped per implementation policy (default 32 entries).
7. **Catalog-visible singletons.** Objects the catalog registry advertises as visible to this actor's class/role (per [discovery/catalogs.md](../discovery/catalogs.md)). Ordinary actors usually see nothing here; wizard actors get whatever wizard-discoverable singletons the catalog declares. There is no hardcoded list of "universal corenames" in the protocol — visibility is data-driven from the catalog registry, not from the MCP spec.

Full tool enumeration is **lazy** and **not the default**. Standard MCP `tools/list` returns stable control tools plus a bounded `active` dynamic projection. `woo_list_reachable_tools` uses the same bounded default unless the agent explicitly asks for `here`, `focus`, `object`, `space`, or `all`. A canonical `woo_call(object, verb, args?)` resolves only the requested reachable object/verb. Ordinary tool calls do not force a full cross-host enumeration after they run.

After a tool call, the gateway may compute a cheap local reachability signal (active scope, other live scopes, inventory, working set, local object versions). If that signal changes, it sends `notifications/tools/list_changed` only to MCP sessions bound to that actor. A change to Alice's tool list must not notify Bob's session; otherwise one actor's move/focus can force every connected agent to re-enumerate cross-host tools. The notification is a hint, not a freshness barrier: clients that tolerate stale tool lists for one turn can ignore it; clients that don't should re-list before their next decision or use `woo_list_reachable_tools` / `woo_call`.

Containment cycles and re-entrant rooms (a room as the contents of another room — see the chat catalog's hot tub) are walked once; the algorithm is a BFS bounded by the reachability set's natural boundary (objects not in any of the seven categories above).

Reachability spans hosts. When a selected scope entry resolves to a remote $space (per [hosts.md §3](hosts.md#3-hosts-and-execution-model)) the gateway first consults same-host projection cache rows and the session's last tool manifest, then refreshes from the owning host when needed. Scopes that expand space contents (`here`, `space`, `all`) include per-instance verbs on dynamically-created objects (a `$task` minted at runtime on a registry's host, a `$cockatoo` cloned into a chat room). The bounded `active` scope asks the same host but filters the response back to the selected objects, so a registry containing hundreds of tasks does not become hundreds of MCP tools by default. The same rule applies to `woo_call(object, verb, args?)`: targeted resolution must search the remote contribution for the actor's reachable spaces/focus set, not only the gateway's local object ids. The remote host is responsible for applying the actor's read-permission filter before returning its contribution; the gateway trusts that filter (same-deployment trust, [hosts.md §3.3](hosts.md#33-trust-model-across-hosts)).

Tool listing is monotonic within a live MCP session up to manifest expiry. Once
the gateway has returned a descriptor in a session's `SessionToolManifest`, an
owner timeout or cache miss may mark that descriptor stale but MUST NOT make it
disappear from `woo_call` resolution in the same session. A descriptor is
removed only when an accepted projection delta removes the object or verb, the
session's active scope changes in a way that makes it unreachable, or the
manifest expires. Persisted manifests record `stale:true` and `stale_reason`
when they are served because owner refresh failed or returned no descriptors;
that marker is freshness metadata, not a not-found result. Remote descriptor
refreshes should also include tool-surface `source_rows` when available so the
gateway can invalidate inherited and feature-provided verbs from accepted
projection updates without reopening executable state. Descriptor reads may use
stale projection rows; auth, permission checks, and VM execution may not.
During rollout, stale descriptor reads are enabled only when the gateway's
same-host stale-fallback flag is on; with the flag off, saved manifests are not
used to recover owner refresh failures.
When an MCP call executes through v2 and the gateway already holds a local
execution view for the commit scope, it may send a one-turn
`ExecutionCapsule` on `/v2/envelope` instead of reopening the scope. The capsule
does not make descriptor projection data authoritative; permission and VM
execution still go through the CommitScopeDO authority path.

### M3.1 Working set: `$actor:focus`

The working-set primitive lives on `$actor` (so it's always reachable via §M3.1):

```
$actor:focus(target: obj) -> { focus_list: [obj, ...] }
$actor:unfocus(target: obj) -> { focus_list: [obj, ...] }
$actor:focus_list() -> [obj, ...]
```

`focus(t)` adds `t` to the actor's `focus_list` property if the actor passes basic visibility checks (the target exists and the actor can `:describe` it). Focusing another actor is rejected; otherwise the target actor's inherited maintenance verbs would become callable by the focuser. The stable MCP wrapper `woo_focus(t)` is stricter: it is a reachability promotion, not a global object lookup, so `t` MUST already be in the actor's current reachable set (location, visible contents, inventory, ambient presence, or existing focus). Missing objects and readable-but-unreachable global/catalog objects are rejected. `unfocus(t)` removes. `focus_list()` reads. The list is capped server-side; on overflow, oldest entry is evicted.

The list persists with the actor across connections (it's a property on the actor object). Reconnect retains scope. `focus_list` is also visible via `actor:describe()` for agents that want to introspect their own context.

This is the explicit primitive the spec promises in §M2.2 — when an agent calls `the_taskboard:listing()` and gets back ten task summaries, it focuses the task refs it cares about and their per-task verbs (`claim`, `pass`, `release`, `handoff`, `reject`, `wait`, `yield`, `drop_terminal`) join the tool list. Tools alone do not implicitly grow the scope.

---

## M4. Observations: `$actor:wait`

External events (other actors moving, the cockatoo squawking on a fork, applied frames in subscribed spaces) reach the agent the same way they reach a browser — except agents act in turns, so push doesn't apply. The agent pulls.

`wait` is a verb on `$actor`, defined in core bootstrap so every actor inherits it. Because the actor is always in reachable scope (§M3.1), the tool is always available. Its shape:

```
$actor:wait(timeout_ms?: int, limit?: int)
  → { observations: [...], more: bool, queue_depth: int }
```

| Argument | Default | Notes |
|---|---|---|
| `timeout_ms` | `0` | Long-poll budget. If the queue is empty, blocks up to this many ms for the next observation. Returns immediately on first arrival. Capped at 30000. |
| `limit` | `64` | Maximum observations to return in one batch. Bounded by an implementation-defined hard ceiling (default 256). |

A `wait` with non-zero `timeout_ms` holds the worker request open for the duration of the budget when no observation arrives. Operationally this surfaces in `wrangler tail` as a `/mcp` request with `wallTime ≈ timeout_ms` and `cpuTime ≈ 0` — a pure idle hold, not CPU work. Investigators chasing warm-path p95 should subtract `wait`-shaped requests (cpu-near-zero) before concluding there is a perf problem; see [observability.md §long-poll requests](../operations/observability.md#long-poll-requests).

**Returns:**

- `observations`: up to `limit` queued observations, oldest first.
- `more`: `true` if the queue has additional observations waiting after this batch. The agent calls `wait` again (with `timeout_ms: 0`) to drain the next batch.
- `queue_depth`: number of observations remaining after this batch — informational, useful for the agent to size its next call.

The verb is defined on `$actor` with a native handler (`actor_wait`) that consults the per-actor queue maintained by the host. The bytecode form is a stub that raises `E_UNSUPPORTED` so editing it via the IDE doesn't accidentally clobber the host primitive.

### M4.1 The queue: session-scoped

The observation queue is **session-scoped**, not connection-scoped. It survives:

- Connection drops within the session-grace window (per [identity.md §I6](../semantics/identity.md#i6-disconnect-and-reap-lifecycle)).
- Reconnects: the agent reauthenticates with the same session token and resumes draining where it left off.

The queue is reaped when:

- The session expires (token TTL or explicit logout).
- The session is killed by an operator.
- The implementation's hard cap is exceeded for a session that has not drained in a long time (see overflow below).

Queue retention is bounded by both depth (default cap 4096 observations) and age (default TTL 1 hour per observation; older entries are evicted). The agent that wants stronger durability uses sequenced gap recovery via the affected space's `:replay` — live observations are explicitly best-effort ([events.md §12.6](../semantics/events.md#126-observation-durability-follows-invocation-route)).

### M4.2 What goes in the queue

The queue receives:

- **Applied frames** for spaces this MCP session is present in — same session-audience fan-out as WS clients.
- **Live direct events** for spaces this MCP session is present in — same live-observation fan-out as WS clients.
- **Direct events** addressed to the actor per the audience model ([events.md §12.7](../semantics/events.md#127-observation-audience-and-direct-message-routing)): `told`, `looked` to the actor, etc.
- **Self-observations** the actor's own calls emit are returned in the **call's own response**, not queued. The verb's body emits to `ctx.observations`; that array travels with the result.

This means the agent never sees its own actions twice (once in the call result, again in `wait`). It only sees external events via `wait`.

### M4.3 Overflow

If the queue exceeds its hard cap, the gateway inserts a single `{type: "observation_overflow", lost: N, since: <ts>}` observation in front of the queue and resumes appending. The agent treats this as a gap and may follow up with the appropriate space's `:replay(from, limit)` for true recovery on sequenced spaces. Live observations dropped to overflow are unrecoverable (consistent with [events.md §12.6](../semantics/events.md#126-observation-durability-follows-invocation-route) "live is best-effort").

### M4.4 Drain discipline

The agent decides when to drain:

- After each turn-shaping action, if it cares what others did meanwhile.
- Whenever it has nothing to do and wants to listen passively (`wait` with a non-zero `timeout_ms`).
- In batches when catching up after a long pause: repeated `wait(0, limit)` calls until `more: false`.

There is no implicit drain on other tool calls. Every observation the agent sees from someone else's action came from a `wait` call.

---

## M5. Trust and permissions

The MCP gateway is part of the woo deployment. Same-deployment trust ([../protocol/hosts.md §3.3](hosts.md#33-trust-model-across-hosts)) applies: the gateway has been authenticated to the cluster and forwards calls under the actor's identity.

- **Authentication.** Token-based, identical to wire and REST. Agent deployments typically use `apikey:<...>` for long-lived agents and `bearer:<...>` for short-lived OAuth flows.
- **Authorization.** Per-tool: `assertCanExecuteVerb(actor, target, verb)` runs on every tool invocation. Failure is `E_PERM` per §M6.
- **`tool_exposed` is an opt-in, not authority.** A verb with `tool_exposed: true` is *advertised* to MCP; the actual call still goes through verb-x perms. A verb with `tool_exposed: false` is hidden from the tool list but reachable via the room's parser if a parser verb (e.g. `:command_plan`) routes there — same as a human typing the command. The flag is a discoverability filter, not a permission.

Wizard-only tools (e.g., `set_verb_code`) are exposed to MCP only when the actor is wizard. There is no separate "wizard MCP namespace"; wizard verbs simply pass the same perm check that runs everywhere else.

---

## M6. Errors

woo's failure model ([../semantics/failures.md](../semantics/failures.md)) is preserved on the MCP wire:

- A tool that raises a woo error returns `isError: true` with `content: [{type: "text", text: "<error code>: <message>"}]` and `structuredContent: { error: { code, message, value, trace } }` — the same error shape as the WS `op:error` frame.
- Common codes the agent should expect: `E_PERM` (verb-x denied), `E_INVARG` (bad args), `E_VERBNF` (verb gone — the world changed mid-turn), `E_OBJNF` (object recycled), `E_QUOTA`, `E_TIMEOUT`.
- For sequenced calls that succeed-with-behavior-failure ([events.md §12.6](../semantics/events.md#126-observation-durability-follows-invocation-route)), the response is **not** `isError: true`. The applied frame committed at a real seq; `structuredContent.applied` carries the seq, and `structuredContent.observations` includes the `$error` observation. The tool succeeded; the verb body failed.
- Routing/transport errors (gateway unreachable, session expired) use MCP's standard error envelope with woo codes in `data` (`E_NOSESSION`, `E_GATEWAY`).

The gateway's robustness contract: if a dynamic tool name is missing from the server's current snapshot, the server first tries a targeted canonical resolution of names shaped like `<object>__<verb>` before returning `unknown tool`. It may fall back to one full `tools/list`-equivalent refresh for non-canonical or collision-suffixed names, but it must not make ordinary dispatch depend on full cross-host enumeration. This handles a client calling a newly reachable object immediately after focus or movement without turning every call into a remote tool-list fanout.

The agent's robustness contract: any tool may fail, including tools the agent saw seconds ago. The world is live; objects can be recycled and verbs rewritten between turns. The `tools/list_changed` notification is best-effort; the agent should treat `E_VERBNF` from a tool call as "re-list and try again" rather than as a fatal error. Clients with deferred or stale tool metadata should prefer `woo_call(object, verb, args)` for the retry.

---

## M7. Lifecycle

```
client → server: initialize { ... }
client ← server: initialize result, advertising tools
client → server: notifications/initialized

(later, repeated)
client → server: tools/list
client ← server: tools/list result (stable control tools plus verbs reachable from current location)
client → server: tools/call { name: "the_chatroom__say", arguments: { text: "hi" } }
client ← server: tools/call result { content, structuredContent }

(static/cached clients)
client → server: tools/call { name: "woo_call", arguments: { object: "the_chatroom", verb: "say", args: ["hi"] } }
client ← server: tools/call result { content, structuredContent }

(when actor moves or working set changes)
client ← server: notifications/tools/list_changed
client → server: tools/list (refresh)

(idle listening)
client → server: tools/call { name: "actor__wait", arguments: { timeout_ms: 10000 } }
client ← server: tools/call result { structuredContent: { result: { observations, more, queue_depth } } }
```

Disconnect: the MCP transport closes; the woo session may persist per session-grace rules ([identity.md §I6](../semantics/identity.md#i6-disconnect-and-reap-lifecycle)). Reconnect re-authenticates with the same token, refreshes `tools/list`, and drains `wait` to resync — the queue is session-scoped (§M4.1), so observations enqueued during the disconnect window are still there on reconnect within the grace period.

---

## M8. Deployment boundary

MCP is an agent-oriented deployment surface. The MCP gateway is separate from the worker that serves the SPA — they may co-locate, but the SPA must function without the MCP gateway running. Browser/runtime conformance does not require an MCP implementation.

A second-implementation conformance suite for MCP follows the broader conformance plan ([tooling/conformance.md](../tooling/conformance.md)) and is deferred until at least one alternative MCP gateway exists.

The MCP gateway is the first consumer of the v2 turn-network protocol ([v2-turn-network.md](v2-turn-network.md)). On a separate Cloudflare namespace that does not maintain v1 compatibility, the gateway is a pure v2 client for world/object verb invocation: it forwards calls as v2 turn-network envelopes through `CommitScopeDO`, so the authority plans each turn against the live commit head, and routes v2 accepted-frame and live observations to MCP queues rather than consuming v1 applied-frames. MCP is not a browser execution-cache node, so it currently uses the server-assisted intent profile defined by the v2 turn-network spec rather than browser-local optimistic execution. When the `WOO_V2_EXECUTION_CAPSULE` rollout flag is enabled, a warm MCP v2 scope client can skip executable `/v2/open` and submit a capsule-bearing `/v2/envelope`; cold-cold scopes still retry legacy seed bootstrap on `E_SNAPSHOT_REQUIRED`. MCP queue/focus controls remain gateway-local protocol controls because they manage session attention and observation drainage, not durable world commits. The MCP wire contract above (tools, notifications, queues) is unchanged; only the gateway's internal observation source and call path are rerouted. The legacy production namespace continues to drive MCP through the v1 path described in §M3–§M6. See [notes/2026-05-13-mcp-first-v2.md](../../notes/2026-05-13-mcp-first-v2.md) for the migration plan and implementation status.

---

## Open questions

- **Resources surface.** Skipped for now because MCP resource support across clients is uneven. The verb-tool surface plus `:describe` (a tool-exposed verb on every object) covers the main browse cases. If clients converge on resources later, add `woo://here`, `woo://me`, `woo://object/{id}` as a layered addition without changing the tool surface.
- **Multi-actor agents.** A single LLM driving multiple characters (a "puppeteer" pattern) wants several MCP sessions multiplexed over one transport. This contract keeps the model 1:1; revisit when there's a workload that demands it.
- **Streaming verbs.** Some verbs (a long compile, a multi-step task creation) emit progress observations. Today these flow through the per-actor queue alongside everything else, drained by `wait`. A future MCP revision could attach them to the originating tool call as a streamed result, matching MCP's `progressNotification` shape; this contract keeps it flat.
- **Coalescing dense streams.** Dubspace gesture progress at 60 Hz floods the observation queue if the agent isn't draining. This contract emits raw observations; a later revision could offer a per-actor coalescing rule (e.g., "keep only latest of `gesture_progress` per `(actor, target, name)` triple").
