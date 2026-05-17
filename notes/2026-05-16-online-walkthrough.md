# Online walkthrough: woah.generalbusiness.ai

Initial walkthrough deploy: `c6077880` (112 objects)
Triage re-probed against:    `b9d44d19` (115 objects)
Tester: guest MCP sessions via HTTP transport
Date: 2026-05-16

## Catalogs auto-installed
`chat, demoworld, dubspace, help, note, pinboard, prog, tasks, blocks-demo`

## Status legend
- **FIXED** — re-probed against `b9d44d19`, no longer reproduces.
- **OPEN** — re-probed against `b9d44d19`, still reproduces.
- **WONTFIX-WORLD** — depends on transient multi-user world state, not a code defect.

## Bugs

### 1. `actor.location` stale on return move — **FIXED** (`d4de930`, `fd881d3`)

Original repro: `the_chatroom → southeast → the_deck → west → the_chatroom`, then any actor verb (e.g. `ways`) reads back `room=the_deck`. Subsequent moves left the actor in a state where deck-side verbs hit `E_PERM: <actor> is not present in the_deck`.

Root cause: each `CommitScopeDO` keeps its own long-lived planning snapshot. The gateway only refreshed `session_objects` (the actor record) per envelope; the destination scope's snapshot never saw the room's *current* contents/subscribers. So `actor.location` could be correct in the gateway's main world while the receiving scope's room still thought the actor wasn't present there.

Fix landed via the v2-authority-slice work. Every `/v2/open` and `/v2/envelope` carries a typed `woo.authority_slice.shadow.v1` containing live sessions, session actors, the sessions' active rooms, the actor's current room, and each item the actor holds. The `CommitScopeDO` refreshes those rows before planning. Companion fix (`fd881d3`) added `actor.contents` items to the slice so `drop` after a cross-scope move stops failing with `"You are not carrying X"`.

Repro now (b9d44d19):
```
ways baseline    OK   room=the_chatroom
→ deck           OK   room=the_deck  obs=[left,entered]
ways on deck     OK   room=the_deck
→ chatroom       OK   room=the_chatroom obs=[left,entered]
ways back        OK   room=the_chatroom   ← correct, previously stale=the_deck
```
Also verified: three-leg `chatroom→deck→hot_tub→deck→chatroom`, rapid 4-move sequence, `take-southeast-drop` round-trip, cross-actor `say`/`who` visibility per room.

### 2. Error message prefix doubled in tool-error text — **OPEN** (partial improvement)

Original: `E_INVARG: E_INVARG: E_INVARG: I don't see "the_lamp" here.` — triple wrapped.
Now: `E_INVARG: E_INVARG: I don't see "no_such_object_for_sure" here.` — doubled (one wrap layer dropped, probably by the v2 commit-error path).

Still one wrap too many. Worth a single pass through `formatToolError` in `src/mcp/server.ts` and the JSON-RPC error → MCP isError serialization to find the duplicate prefix.

### 3. `focus(unreachable)` returned `E_INTERNAL` — **FIXED**

`woo_focus(the_pinboard)` from the chatroom returns `E_PERM` now (was `E_INTERNAL`). The reachability gate behaves consistently regardless of whether the missing target is local or cross-host.

### 4. `the_lamp__look` returned `commit_rejected` — **WONTFIX-WORLD**

This was multi-user contention: another guest had taken the lamp between baseline and the probe. Not a code defect; the gateway's stale-stub error surfaces as a generic `commit_rejected`. UX could improve (a `stale_stub` reason would be more debuggable), but that's separate work.

### 5. `dubspace__say`/`emote` emit DOUBLE observations — **OPEN**

A single `the_dubspace__say` still returns `obs=[said, said]`. Same for `emote`. The chatroom equivalent emits one. Likely dubspace re-broadcasts to itself in addition to the standard space fanout; `catalogs/dubspace/manifest.json :say` and the observation-routing in `world.observationAudienceActors` would be the places to check.

### 6. `dubspace__set_tempo(-50)` accepts invalid input — **OPEN**

Returns `OK obs=[tempo_changed]` with the bogus value. No clamp/validation on the verb. Trivial catalog fix.

### 7. `scope=all` retained destination room after return — **FIXED**

Side effect of the authority-slice fix (Bug 1). `scope=all` now correctly returns the actor's current-room neighbors:
```
scope=all after chat→deck→chat:
  objects=[guest_*, the_chatroom, the_cockatoo, the_couch, the_dubspace, the_mug, the_weather, the_lamp]
```

## Inconsistencies / rough edges

### 1. Help DB is sparse — **OPEN**

Only 1 of 7 probed topics (`look, say, focus, wait, ways, movement, speech`) resolves; the rest return `No help available for "X"`. The `help` verb works; the catalog data is the gap.

### 2. `cockatoo teach(word)` schema/verb arg mismatch — **OPEN**

Stable wrapper sends `{word: "hi"}`, verb body raises `E_TYPE: teach requires a string phrase`. The verb's internal arg name is `phrase` and the arg_spec apparently exposes a different param name. Catalog fix in `catalogs/chat/manifest.json` `the_cockatoo:teach`.

### 3. `scope=active` shows lingering focused object across rooms — **WORKS-AS-DESIGNED**

`woo_focus(the_lamp)` while in chatroom then `southeast → deck` correctly keeps `the_lamp` in `scope=active`. Focused objects follow the actor across rooms; this is documented intent and the previous "surprise" was a misread. Closing.

### 4. Cross-host move observations have inconsistent shape — **OPEN, by design?**

Different verb paths emit different observation vocabularies:
- `the_chatroom__southeast → the_deck`: `obs=[left, entered]`
- `the_deck__east → the_hot_tub`: `obs=[text, left, entered]` (extra flavor text)
- `the_dubspace__enter`: `obs=[dubspace_entered, dubspace_activity]` (catalog-specific)

Client must already handle catalog-specific observation types. Worth a spec note that movement events do NOT have a uniform shape — catalogs can extend.

### 5. `focus(weather)` exposes different verbs than `here` listing — **WORKS-AS-DESIGNED** (but undocumented)

```
here projection:  [ask, look, open]                                       (obvious / command shape)
focus projection: [get_data, set_description, set_location, set_units]   (tool_exposed)
```

This policy is enforced by `tests/mcp.test.ts > "does not broaden focused remote objects to obvious-only verbs"` — the projections are intentionally strict. Room contents expose only command-shape affordances; focus exposes only `tool_exposed` admin verbs. The gap: there's no listing that shows the union, and the policy is undocumented in the spec.

### 6. `go(unknown)` returns text instead of E_INVARG — **WORKS-AS-DESIGNED**

`go("moon")` returns `"You can't go that way (moon)."` as a text observation, not an error. Catalog idiom: bad navigation isn't an error condition, it's flavor text. Consistent with `the_chatroom__south` returning the "plate-glass windows" joke.

### 7. `say("")` raises E_INVARG — **WORKS-AS-DESIGNED**

Empty-text rejection on the catalog side is correct.

## Confirmed working

- All 25 chatroom language verbs (say/say_as/say_to/emote/pose/quote/self/tell + look/who).
- Movement: `the_chatroom__southeast → the_deck`; `the_deck__east → the_hot_tub`; `the_hot_tub__west → the_deck`; all return `[left, entered]` correctly.
- Tool-list refresh after cross-scope move (post `d7ff1a5`): destination's verbs appear within ~250ms.
- `woo_focus`/`woo_unfocus` properly mutate `focus_list`; `scope=focus` returns the focused objects' tools.
- `woo_focus` validation: rejects missing targets with `E_OBJNF`; allows focusing self; rejects unreachable with `E_PERM`.
- Dubspace entry; 23 tools surface; `set_tempo`, `start_transport`/`stop_transport`, `save_scene`, `start_loop`(missing) all commit (or err) cleanly.
- Take/drop mug; inventory updates; cockatoo correctly resists being taken (`E_PERM`); cockatoo `squawk` returns `"Squawk!"`.
- Weather `open` (emits `weather_open`), `ask("today"|"tomorrow"|"monday")` (returns descriptive text — plug not connected on this deploy).
- Pinboard 22 verbs when focused.
- Horoscope 9 verbs when focused, including admin `set_system_prompt`/`set_rate_limits`/`set_queue_limits`.
- `wait(0, N)` drains empty queue; longer-timeout wait holds the request open.
- Cross-scope return + `say` no longer hits `E_PERM "not present in X"` (was the prior blocker).
- Inventory survives cross-scope moves: take in chatroom, southeast to deck, drop on deck — all succeed.
- Two-actor presence: A in chat + B on deck → each room's `who` correctly excludes the other.

## Open follow-ups not from the original walkthrough

### Two-shard concurrent moves: `who()` doesn't see actors that moved on another shard

When A (on shard-A) and B (on shard-B) both call `the_chatroom__southeast` concurrently and then A calls `the_deck__who`, only A appears — even after 5s settle. Probe:
```
A landed: room=the_deck
B landed: room=the_deck
after +5000ms: deck.who = []   (caller alone, sometimes neither)
```

Mechanism: `chatroom__southeast` commits on the chatroom `CommitScopeDO`. The accepted-frame fanout (`deliverMcpCommitFanout` in `persistent-object-do.ts`) targets MCP gateway shards subscribed to the *commit scope* (chatroom). Once A has left chatroom, A's shard may no longer be in chatroom's subscriber set, so B's later chatroom commit's transcript doesn't propagate to A's shard. A's gateway main world then has `deck.contents=[A]` only, the authority slice sent to deck's `CommitScopeDO` carries that, and `deck.who` returns just A.

The right place to extend fanout is `deliverMcpCommitFanout`: include shards with sessions in the *destination* room from any actor-move write in the transcript, not just those subscribed to the commit scope. Separate from the authority-slice fix; doesn't block normal single-actor workflows.

### Postflight WS check fails (410)

`scripts/deploy.sh` postflight tries the legacy `/v2/turn-network/ws`. The endpoint correctly returns 410 per the SSE→shadow migration. The check itself should be retired or repointed at the live shadow path.
