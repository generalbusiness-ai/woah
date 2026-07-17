# Net MCP contextual tools

## Decision

The initial Net MCP surface uses **structural context**, not an MCP-managed
`focus` list, to decide which dynamic tools are available.

An MCP session's context is bounded and deterministic:

- the session actor;
- the session's active space;
- visible members of that active space; and
- the actor's inventory.

Executable `tool_exposed` verbs on those objects are eligible. The active space
and its visible contents also contribute command-shaped verbs, so command
planning and object affordances remain available even when they are not
dedicated agent tools. Other
live presence actors are social context, not object invocation targets; agents
interact with them through the room's say/tell surface. Self-hosted objects, including
catalog blocks and workspaces, retain their ordinary tool projection even if
they also have a live session.

Movement and containment changes therefore change `tools/list`. A task on a
task board is callable while the actor is at that board; after `claim` moves it
to the actor, it remains callable as inventory. The agent does not need to
perform `focus -> re-list -> call -> unfocus` choreography.

The existing in-world `$actor:focus`, `$actor:unfocus`, and
`$actor:focus_list` behavior is not removed. It may still be useful to chat or
catalog workflows, but it is not part of the initial Net MCP control plane and
does not broaden Net MCP reachability.

## Why not infer context from return values

Woo object references are represented as strings at runtime, and verb results
do not yet have declared result schemas. Recursively treating result strings as
object capabilities would be heuristic, could accidentally broaden the tool
surface, and would require remote existence checks proportional to arbitrary
result size.

A future returned-reference extension must be explicit. The likely shape is a
typed verb result contract that identifies object-reference positions. Such
refs can then enter a bounded, session-local context LRU and be resolved lazily.
No string-shape or field-name guessing belongs in the gateway.

## Invocation and discovery

`tools/list` returns the three stable Net controls plus dynamic tools from the
current structural context. Dynamic names are deterministic
`<sanitized-object>__<verb>` names with collision suffixes. Descriptions and
JSON input schemas come from verb source and `arg_spec`; aligned command-parser
sources retain their known string/object shapes when no explicit type hint is
present.

`woo_list_reachable_tools` exposes the same resolver with filtering and paging.
`woo_call`, and calls by dynamic name, resolve through that same context before
submitting an authoritative Net turn. Neither path is an object-id escape
hatch. Execution still performs the normal authoritative permission checks.

Only bytecode verbs are advertised by Net. A native page has no portable Net
execution body and advertising it would produce a tool that fails through the
planner.

## Initial boundary

This work keeps API-key-only initialization. Bearer and guest credential
carriers are not an initial parity condition.

Durable observation queues and Streamable HTTP server notifications remain
separate MCP lifecycle work. Until `notifications/tools/list_changed` lands,
clients must re-list after a successful navigation or containment-changing
call. No temporary result field substitutes for the normative MCP
notification.

Cold gateways also need enough information to fetch contextual object cells.
The generic `contents` relation therefore carries the member's immutable
authority scope as internal routing metadata. Discovery groups cold members by
that scope and uses bounded full-object closure reads with success memoization
and failure retry backoff; a sparse lineage row is not treated as proof that
the instance's own verb pages arrived. This is
required for dynamically-created tasks and for inventory that remains anchored
at its creation scope; relation membership alone cannot locate authority in a
big world.

## Navigation acceptance scenarios

The implementation is not complete until tests demonstrate:

1. a newly connected agent sees room tools and contextual fixture tools;
2. a task on the active task board exposes `claim` without a focus call;
3. claiming the task keeps its lifecycle tools available through inventory;
4. moving away removes tools left behind and adds destination tools;
5. another present actor does not become an object-tool target;
6. a dynamic-name call and `woo_call` use the same reachability decision; and
7. an unreachable but globally known object cannot be invoked through either
   path.
