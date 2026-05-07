---
date: 2026-05-02
status: implemented
---

# Match

> Part of the [woo specification](../../SPEC.md). Layer: **semantics**.

LambdaMOO's `parse_command` did three things at once: tokenize text, resolve direct/indirect objects, and dispatch a verb with parser globals (`dobj`, `iobj`, `prepstr`, `argstr`, etc.). woo's runtime does **none** of these — verb invocations are structured messages, not parsed text. This is correct for dubspace (UI controls) and taskspace (REST/agent calls), but a chat-shaped surface (rooms with conversational text) needs the equivalent.

`$match` is a **bootstrap class**, not a runtime primitive. It scaffolds the text-to-action pipeline as ordinary verbs on a seed object, so chat surfaces don't each invent their own. Some bundled `$match` verbs are native-backed for cross-host object/verb lookup and command planning, but they remain ordinary verbs at the woocode boundary.

This doc is the convention. An implementation that doesn't ship a chat surface may skip it entirely. An implementation that does ship one should use these verb names so the pattern is portable.

---

## MA1. The `$match` class

A seed object with these verbs. Lives with the chat classes and scaffolding ([bootstrap.md §B5](bootstrap.md#b5-chat-classes-and-scaffolding)) for any world that needs chat-shaped lookups; world boots that don't can omit it.

| Verb | Returns | Purpose |
|---|---|---|
| `:match_object(name, location?)` rxd | obj \| `$failed_match` \| `$ambiguous_match` | Resolve a string to an object visible from `location` (defaults to `actor.location`). |
| `:match_verb(name, target)` rxd | verb \| null | Resolve a verb name (with alias patterns per [objects.md §9.1](objects.md#91-lookup)) on `target` using runtime lookup, including features where applicable. |
| `:parse_command(text, actor, location?)` rxd | map | Full pipeline: tokenize, identify verb + dobj + iobj, return a structured `command` map. `location` defaults to `actor.location`. |
| `:match_command_verb(cmd, target)` rxd | map \| `$failed_match` | Resolve a command-pattern verb on `target`, using the same ancestry/feature lookup as `:match_verb` but filtering by command metadata. |
| `:plan_command(text, space)` rxd | map | Shared command planner used by `$conversational:command_plan`; returns `{ok, route, space?, target, verb, args, cmd}` or a huh plan. |

Returned by `:match_object`:
- A successful objref.
- `$failed_match` (a sentinel object) when nothing matched.
- `$ambiguous_match` (another sentinel) when more than one candidate matched.

Sentinels are seeded at boot; their identity is stable across reboots so user code can pattern-match against them.

---

## MA2. Object matching

`$match:match_object(name, location?)` resolves `name` to an object via:

1. **Direct objref.** If `name` starts with `#` and parses as a ULID, look it up in the Directory. If found and visible to the caller, return it.
2. **Corename.** If `name` starts with `$`, resolve via `$system.<name>`. If found, return it.
3. **Location search.** Walk `location.contents`, even when `location` lives on another host. For each candidate `c`:
   - If `c.name == name` (case-insensitive), it's an exact match.
   - Else if any of `c.aliases` matches `name` per [objects.md §9.1](objects.md#91-lookup) alias grammar, it's an alias match.
   - Else if `c.name` starts with `name` (case-insensitive) and `name` is at least 2 characters, it's a prefix match.
4. **Carrying-actor search.** Walk `actor.contents` (things the actor holds). Same matching as step 3.

Matching is scoped, not local-only. A command parser running on an actor's home
host must still resolve objects in the actor's current room when that room is
self-hosted elsewhere, and a room-hosted parser must still resolve a carryable
object whose storage host differs from the room. Remote lookup uses read-class
host RPCs for `contents`, display `name`, and `aliases`; it does not dispatch
object behavior.

Resolution:
- If exactly one exact match → return it.
- If exact matches are 0 and exactly one alias match → return it.
- If alias matches are 0 and exactly one prefix match → return it.
- If multiple candidates at the highest-priority tier → `$ambiguous_match`.
- If no candidates at any tier → `$failed_match`.

The "me" and "here" pseudo-names resolve to `actor` and `actor.location` respectively. These are conventions, not runtime-bound; `here` still resolves when the current location is remote and absent from the caller's local object map.

---

## MA3. Verb matching

`$match:match_verb(name, target)` mirrors the runtime's `CALL_VERB` lookup, including features:

1. Walk `target`'s parent chain from `target` up to `$root`. For each ancestor `a`:
   - If `a` has a verb whose canonical `name` equals the lookup name, return it.
   - Else if any of the verb's alias patterns match (per [objects.md §9.1](objects.md#91-lookup) alias grammar), return it.
2. If no parent-chain match **and** `target` is `$actor`- or `$space`-descended, walk `target.features` in list order per [features.md §FT2](features.md#ft2-verb-lookup-with-features). For each feature `f`, search `f`'s parent chain by the same rule. First match wins.
3. If still no match, return null.

This is the *same* lookup the runtime performs on `CALL_VERB`. Surfacing it as a user-callable verb lets the chat parser (and any other text-shaped UI) preview verb resolution before dispatching, so command interpretation matches what dispatch will actually do — feature-attached verbs included.

---

## MA4. Command parsing

`$match:parse_command(text, actor, location?)` is the full pipeline. `location`
defaults to `actor.location`. Returns a map shaped:

```
{
  verb:    str,         // the verb name
  dobj:    obj | null,  // direct object, resolved
  dobjstr: str,         // the original string for the direct object
  prep:    str | null,  // preposition (one of a fixed set; see MA5)
  iobj:    obj | null,  // indirect object, resolved
  iobjstr: str,         // the original string
  args:    list<str>,   // remaining tokens
  argstr:  str          // original text minus the verb
}
```

Pipeline:

1. **Tokenize.** Split `text` on whitespace, respecting quotes (`"hello world"` is one token). Preserve original substrings for `argstr`/`dobjstr`/`iobjstr`.
2. **Verb extraction.** First token is the verb name.
3. **Preposition split.** Scan remaining tokens for the first preposition from §MA5, preferring the longest matching preposition when two entries begin at the same token (`in front of` before `in`). Tokens before it form the direct-object phrase; tokens after form the indirect-object phrase.
4. **Object resolution.** Run `:match_object(dobjstr, location)` and `:match_object(iobjstr, location)` if present.
5. **Return** the structured map.

User code dispatches by:

```woo
let cmd = $match:parse_command(text, actor);
let v = $match:match_command_verb(cmd, cmd.dobj);
if (typeof(v) == "map") {
  dispatch(v["target"], v["verb"], v["args"]);
}
```

The verb body receives ordinary declared arguments, not parser globals. This is the deliberate departure from MOO: parser state is data used by the planner, not implicit task globals.

---

## MA4.1 Command verb metadata

Catalog verbs may declare command-pattern metadata inside `arg_spec.command`:

```json
{
  "arg_spec": {
    "args": ["recipient"],
    "command": {
      "dobj": "this",
      "prep": ["to", "at"],
      "iobj": "string",
      "args_from": ["iobjstr"]
    }
  }
}
```

Pattern values for `dobj` and `iobj` are:

| Value | Meaning |
|---|---|
| `none` | The slot must be empty. |
| `this` | The slot must resolve to the command receiver. |
| `any` | The slot may be empty or non-empty. |
| `object` | The slot must resolve to an object. |
| `player` | The slot must resolve to a `$player` descendant. |
| `string` | The slot source text must be present. |

`dobj` and `iobj` may also be a list of these values; the slot matches if any
listed value matches. Use this for deliberately small overloads such as
`["none", "this"]`, not as a replacement for separate verbs with distinct
behavior.

`prep` is `none`, `any`, an exact normalized preposition string, or a list of exact normalized preposition strings.

`args_from` is an ordered list drawn from: `text`, `verb`, `argstr`, `prep`, `dobj`, `dobjstr`, `dobj_prefix`, `dobj_prefix_rest`, `iobj`, `iobjstr`, and `cmd`. These become the actual verb arguments. The parsed command map is available as `cmd` only as an escape hatch.

Command metadata is per verb definition. Aliases share the same command pattern; a different pattern requires a separate verb.
Source-install authoring APIs MAY attach the same metadata out-of-band as
`argSpec.command` while the source language lacks first-class `args_from`
syntax. The stored verb definition is still the source of truth after install.

`$match:plan_command(text, space)` uses this normative target order: direct object, indirect object, command space, actor. Within each target it uses the existing runtime verb lookup rule, including parent chains and features.

When no command-pattern verb matches a slash-prefixed command, the planner
consults optional huh hooks in this order: `actor:my_huh(cmd)`,
`space:here_huh(cmd)`, then `actor:last_huh(cmd)`. A missing hook is ignored. A
hook that returns a map with an `ok` field supplies the returned plan; returning
`true` marks the input handled without a follow-on route. The command-plan route
vocabulary is closed for v1: `direct`, `sequenced`, `huh`, and `handled`.
Hooks fire only for slash-prefixed misses. Bare text without a command match is
also a miss, not implicit speech; it returns the actor-owned `:huh` plan with
the LambdaMOO-style default message `I don't understand that.` Explicit speech
uses command metadata such as `say hello` or one of the speech-prefix lowerings
above, such as `"hello`. Missing hooks (`E_VERBNF`) are ignored; any other hook
error is surfaced as a planner failure so broken catalog hooks are visible.

The bundled default `:huh` is actor-owned: the planner dispatches
`actor:huh(text, reason, space)`. This follows LambdaMOO's player-rooted
default-miss shape while preserving Woo's explicit command surface; the space is
passed as context, not as the owner of the private output. `$conversational:huh`
is only a compatibility wrapper for older space-level callers and delegates back
to the actor.

---

## MA5. Preposition vocabulary

The parser recognizes a fixed list of prepositions. Multi-word prepositions (`in front of`, `out of`) are matched as units:

```
with using
at to
in inside into
on on top of upon
from out of
over through under underneath
behind beside
for about
is
as
off off of
```

Aliases are part of the vocabulary; `into` collapses to `in` for grammar purposes (the original substring is preserved in the parsed output if the verb cares).

Custom worlds can extend this list by overriding `$match.prepositions` (a list property on `$match`). The default seed list is the LambdaCore set, lightly modernized.

---

## MA6. The `:match_names()` extension hook

Static `aliases` is enough for most catalogs — a list of strings on the
object, world-readable, exposed via the same property convention LambdaMOO
uses. When a class needs match keywords that vary by *who is matching*
(text-line aliases gated on `:is_readable_by`, color variants on a pin, an
encrypted note exposing different keywords per reader), it can override
the optional verb hook:

```
verb :match_names() rxd { ... return list<str> ... }
```

For candidates local to the matching host, the substrate calls this verb
when the candidate defines it at any level of the parent chain during
`:match_object`'s alias-tier walk. Returned strings join the per-candidate
match pool alongside the `name` property and the `aliases` list. Remote
candidates remain read-only for matching per §MA2: the matcher uses their
summary `name` and `aliases`, and does not dispatch object behavior on the
remote host. The result is bounded by `dispatch(... max_chars=4096)` — see
[builtins.md §19.4](builtins.md#194-object); a verb that exceeds the bound
contributes no match names from this hook on that call.

### MA6.1 Protocol

The verb takes **no arguments**. The acting principal is read from the
verb-frame `actor` global (the session-bound real actor; substrate-supplied
and unspoofable). Authoring `:match_names(actor_obj)` and reading the
parameter is a footgun: the substrate calls the verb with no arguments, so
`actor_obj` would arrive as `null`, and an external caller invoking the
verb directly could otherwise pass any object id to bypass an
`is_readable_by(actor_obj)` gate.

Because the verb is `direct_callable: true` so the substrate can dispatch it
through the normal verb-perm path, every implementation must gate its
returned keywords on the same `actor` it would gate `:text()` on, and must
not trust any caller-supplied principal.

### MA6.2 Bound and timing

`:match_names()` runs synchronously for each local candidate, inside the
parallel fanout that already enriches match candidates. The 4096-character
total bound is the substrate's protection against a single hostile or
accidentally-large note brick-walling a chat utterance; it is a hard cap and
the substrate silently drops the contribution from any candidate that
overshoots. Catalog implementations should keep the verb cheap (no
cross-host RPC, no logging) — the matcher fires on every unhandled chat
utterance.

---

## MA7. Substrate-hardcoded conventions

A small vocabulary is wired into the substrate's command-resolution path
rather than into a catalog: the pseudo-names `me` and `here`, the sentinel
corerefs `$failed_match` / `$ambiguous_match` / `$nothing`, and the `#<id>`
direct-object syntax. These are not catalog-extensible; any chat-shaped
surface inherits them, and an alternate world cannot redefine them locally.

This is intentional and follows LambdaMOO's `match.c`, where the same
identifiers are baked into the C-level matcher. They are part of the
universal command-parsing protocol, not policy: changing them would break
the meaning of every command pattern in every catalog. Catalog authors who
want a different word for "the actor" or "this room" should add an alias on
the relevant object's `aliases` property; they should not try to redefine
`me` or `here`.

If a future surface needs richer parser globals (a tabletop or roguelike
might want `north`, `up`, `target`), those are catalog-defined verbs/aliases
on `$match` or on the room — not new substrate sentinels.

---

## MA8. What's not in `$match`

- **Sentence parsing.** `$match` parses one verb-shaped command per call. Multi-clause input (`get the book and read it`) is the caller's responsibility.
- **Spell correction or fuzzy matching.** Prefix matching is the only forgiveness offered. Worlds that want Damerau-Levenshtein or phonetic matching layer it on top.
- **Verb suggestion UX.** The bundled planner has the small `my_huh` /
  `here_huh` / `last_huh` hook chain above, but richer suggestion or typo
  correction is catalog policy.
- **Cross-room search.** `:match_object` only walks `location.contents` and `actor.contents`, even when those containers are remote. A world that wants global search adds a verb that walks an index.
- **Same-name overload authoring.** The bundled command planner filters verbs by command metadata, but the authoring UI still does not make same-name overload sets pleasant to manage. Prefer one command pattern per verb definition until the editor grows explicit support.

These deferrals keep `$match` small. The pattern is "scaffolding for the 80% case"; the 20% extends it.

---

## MA9. Errors

| Code | Meaning |
|---|---|
| `E_INVARG` | Empty `text` to `:parse_command`, or `name` to `:match_object` is not a string. |

`$failed_match` and `$ambiguous_match` are returned values, not raised errors — they signal "no resolution" without forcing the caller into a try/catch. User code handles them with equality checks: `if (result == $ambiguous_match) { ... }`.
