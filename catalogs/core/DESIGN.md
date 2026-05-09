# core — design notes

## Why this catalog exists

Every chat-shaped command verb in woo grew the same five-line block:
match the noun via `$match:match_object`, then check `dobj == $nothing`,
`dobj == $failed_match`, `dobj == $ambiguous_match`, and tell the actor
the right line for each case. The block was inlined slightly differently
each time — divergent wording, divergent return shapes, a divergent
choice of `tell` versus `raise`. LambdaCore avoids that by giving every
command verb access to `$command_utils:object_match_failed`. This
catalog is the woo port of that helper plus enough scaffolding to add
the rest of `$command_utils` (and sibling `$string_utils` /
`$object_utils` / etc.) as command verbs need them.

## Naming

`core` was chosen over `utils` so the catalog reads as a cohesive
foundation rather than a junk-drawer of helpers. The conceptual link to
LambdaCore is intentional — every class here mirrors a sibling in a
live LambdaMOO, by handle and by verb shape, so a port from MOO source
is mostly mechanical.

The catalog name does *not* refer to `src/core/` (the substrate). The
substrate is woo's TypeScript runtime; this catalog is woocode that
runs *on* the substrate.

## Scope discipline

Every verb in this catalog is a port of a LambdaCore verb with the
same name. Divergence from the original is allowed but always
documented inline, with the original LambdaCore line numbers cited.
Verbs that are not ports — woo-only conveniences — go in some other
catalog, not here.

When a downstream catalog reaches for a `$command_utils` verb that
isn't yet ported, port it. The scope grows by demand, not speculation.

## Why `$utils` exists

`$utils` is a marker base that mirrors LambdaCore's #288 *Generic
Utilities Package*. It carries no behavior — just the optional
`help_msg` property — but it gives every helper singleton a
common-named parent so the structure is obvious to readers porting
from MOO.

## Dependency direction

`core` depends on `chat` because `$command_utils:object_match_failed`
references `$failed_match` and `$ambiguous_match` (defined in chat).
This means chat itself can't (yet) depend on core to refactor its own
inlined match-failure blocks — that change requires either moving the
sentinels to a new lower-layer catalog or accepting the cycle by
folding `core` into `chat`. Both options are deferred until the second
chat-side site that would benefit. For now, `core` serves
above-the-chat catalogs (`prog`, future authoring tooling).

## What's deliberately out of scope (for v0)

- Interactive prompts (`:read`, `:read_lines`, `:yes_or_no`). woo's
  input model differs from MOO's blocking `read()`; the right port
  shape isn't obvious yet.
- Task-budget helpers (`:running_out_of_time`, `:suspend_if_needed`,
  `:kill_if_laggy`, `:task_info`). woo's task surface lands separately.
- `:do_huh`. Already covered by `$match:plan_command`'s huh chain.
- `:player_match_failed` / `:player_match_result`. No `$player_db`
  equivalent yet.
- Sibling utility classes (`$string_utils`, `$object_utils`,
  `$list_utils`). Add them in this catalog when the first verb that
  belongs in them gets ported.
