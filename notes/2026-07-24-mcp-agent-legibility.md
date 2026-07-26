# MCP agent legibility: does an agent understand what it is wearing?

Status: plan. Written 2026-07-24 after an empirical review of the Net MCP
surface. Complements — does not replace —
[`2026-07-23-programmer-environment-mcp-remediation-plan.md`](2026-07-23-programmer-environment-mcp-remediation-plan.md)
(hereafter "the programmer plan").

## 1. Question asked

Is the woo MCP surface usable by an agent? Specifically:

1. Are the tools and navigation presented clearly?
2. Is it clear that the agent acts in the world *via the player-class* — that
   it is wearing a suit of tools?
3. Is it clear that the suit is programmable, as well as the in-world objects?

## 2. Method

The literal bytes an agent receives were dumped end-to-end: a temporary harness
modelled on `tests/worker/net-mcp.test.ts` drove `initialize`,
`notifications/initialized`, paginated `tools/list`, and `tools/call` against
`NetGatewayDO` + `NetScopeDO` over the fake-DO lane, on the installed bundled
world. Two actor shapes were dumped: a plain `$player` guest, and the same actor
reparented to `$programmer` with `flags.programmer` set.

The harness was deliberately not kept. §8 specifies the permanent test that
should replace it.

## 3. Findings

### 3.1 The mechanism is sound; the content is not

The tool-surface *shape* is good and does not need redesign: three stable
controls, dynamic `<object>__<verb>` tools over a bounded structural context
(actor + active space + its visible contents + inventory), `listChanged:true`,
cursor pagination, one resolver shared by listing and invocation
(`gateway-do.ts` `mcpContextTools`). Discovery and authorization cannot
disagree. That is the hard part and it is already right.

What an agent cannot do is *understand* the surface it is given.

### 3.2 The suit is real and completely invisible

Reparenting the actor `$player` → `$programmer` changed its self-tool count
from 7 to 23, with no other change to the world. The class chain *is* the suit,
exactly as intended.

Nothing in the MCP surface says so. The entire in-band orientation an agent
receives is one sentence from `initialize` (`gateway-do.ts:4527`):

> You are woo actor guest_1. Dynamic tools track your current space, its
> contextual objects, and your inventory. Re-list tools when
> notifications/tools/list_changed arrives.

In the resulting flat list of 165 tools, `guest_1__create` is typographically
indistinguishable from `the_mug__write`. Nothing marks `guest_1__*` as *you*;
nothing says those tools derive from a class chain; nothing says the chain can
change. `docs/agents/*` explains this well and an MCP client never sees it.

The programmer plan §6.3 (stable `self__` names) partly addresses the naming.
It does not state the model, and it is scoped to the programmer surface. The
framing gap is general and is owned here.

### 3.3 The suit is not, today, programmable over MCP

Probed as a `$programmer` actor with `flags.programmer` set:

```
guest_1__install_verb(id: "guest_1", ...)
  → E_PERM: guest_1 cannot author guest_1
```

`canAuthorObject` (`world.ts:1646`) requires `target.owner === actor`; a minted
actor is owned by `$wiz`. An agent cannot extend its own body's verb surface.
Whether it should be able to is a design question — see §7.

The indirect path — create an object you own, program it, carry it — is also
closed:

```
guest_1__create(parent: "$thing")
  → ok  {id: "obj_thing_1", owner: "guest_1", location: null}
guest_1__install_verb(id: "obj_thing_1", ...)
  → E_CATALOG_MUTATION: ordinary turns cannot mutate installed catalog
    class definitions
the_chatroom__take(object: "obj_thing_1")
  → E_INVARG: I don't see "obj_thing_1" here.
```

Root cause confirmed, not inferred: `create` leaves the object anchorless with
`location: null`. `scopeNameOf` (`src/net/topology.ts:95`) walks the anchor to a
root, finds no anchor, finds neither `$actor` nor `$space` on the parent chain,
and falls through step 4 to `CATALOG_SCOPE`.
`assertNoCatalogClassMutation` (`gateway-do.ts:6901`) then refuses every
`verb`/`prop`/`lifecycle` write against any object the classifier places in the
catalog scope.

**This is already known and owned.** It is the explicitly deferred Phase C item
in the programmer plan: "full create→install→invoke over Net (`install_verb`
refuses `E_CATALOG_MUTATION` — created object lands in catalog-adjacent scope
not actor's durable authoring cluster = plan §7 workspace boundary)". The
programmer plan §6.4 already prescribes `create(..., {location: actor})`, which
also closes the unreachable-object half.

No new plan is written here for that. It is recorded so the legibility work
does not promise a capability the runtime does not yet have: **until the
programmer plan's workspace boundary lands, the honest statement to an agent is
that it can program objects it owns in a workspace, not that it can program
anything it can see.**

### 3.4 Advertised tools that can never succeed

Class membership exposes the programmer tools; `flags.programmer` gates them. A
`$programmer`-classed actor *without* the bit sees all 12 and gets
`E_PERM: programmer flag required` from every one, with no description warning
and no remedy in the error.

The programmer plan §6.2 handles two instances of this (`trace`,
`force_recycle`) via `availability`/`authority` metadata. The general case —
"the class advertises, the bit gates" — is not covered and is owned here.

### 3.5 Descriptions are truncated maintainer comments

`mcpFirstParagraph` (`gateway-do.ts:8177`) takes the first `/* */` block
*anywhere in the verb body*, else the first `//` line, then keeps only up to the
first blank line. Shipped verbatim to agents:

| Tool | Description received |
|---|---|
| `guest_1__install_verb` | `Programmer surface check.` |
| `guest_1__home` | `LambdaCore $player:home calls this:moveto(this.home) so the destination's` |
| `guest_1__ways` | `authority.prefetch materializes valid structural refs before this` |
| `guest_1__recycle` | `Surface gate. The wrapper is direct_callable for MCP/REST tool use,` |

Dangling mid-sentence clauses addressed to maintainers.

More significant: **roughly 80% of all 165 tools have no description at all** —
only `Call: the_cockatoo:pluck()`. The programmer plan §3.3/§6.2 diagnoses this
for the programmer surface. The gap is catalog-wide: `the_outline` (43 tools),
`the_dubspace` (37), `the_chatroom` (28), `the_cockatoo` (9) are almost entirely
undescribed. An agent cannot tell whether `the_outline__hide` hides an item or
the outline.

### 3.6 The in-world help database is wrong

`<actor>__help` is a tool, so agents will read it. `catalogs/help/manifest.json`
seeds `$help` with:

- topic **`focus`**: instructs the agent to use `woo_focus(<object>)`,
  `woo_unfocus(<object>)`, and `focus_list`. **None of these exist on the MCP
  surface.** `docs/agents/tools-and-actions.md:93` states Net deliberately
  publishes no focus wrappers. (`$actor:focus/unfocus/focus_list` do exist as
  native verbs — `bootstrap.ts:1367–1379`. **Correction, established while
  implementing L1.3:** all three *are* `toolExposed: true`, so they appear as
  `<actor>__focus`/`__unfocus`/`__focus_list`. The earlier claim here that they
  are not tool-exposed was wrong. The topic is still misleading, but for a
  sharper reason: the tools exist under different names, and calling them
  changes nothing an agent cares about, because `mcpContextObjects`
  (`gateway-do.ts:5101`) never consults `focus_list` when building structural
  context. Per `spec/protocol/mcp.md` §152 focus "is not an MCP control plane".)
- topic **`wait`**: calls the tool `wait(<timeout_ms>, <limit>)`. It is
  `woo_wait`.
- topic **`building`**: "Use the programmer MCP tools or enter the verb editor
  when you have the appropriate class and progbit" — names no tool and no way to
  obtain the progbit.

No topic covers the actor/class model, `<object>__<verb>` naming,
`woo_list_reachable_tools`, or re-listing on `list_changed`. The one
discoverable in-band guidance surface actively misdirects.

### 3.7 Page ordering can strand the actor's own tools

`mcpToolsForObjects` sorts context objects by plain `localeCompare`;
`tools/list` slices at `MCP_STANDARD_TOOL_PAGE = 128` and returns a cursor. The
demo world produces 165 tools over 2 pages.

`guest_1` landed on page 1 by alphabetical luck. An actor whose id sorts after
`the_outline` would have its own body's tools stranded on page 2 — invisible to
any client that does not page. The actor is not privileged in the ordering.

## 4. What this plan owns

Everything in §5–§8. Explicitly **out of scope**, owned by the programmer plan:

| Concern | Owner |
|---|---|
| `arg_spec` → real `input_schema`/`output_schema` | programmer plan §6.1 |
| `tool.title`/`description`/`effects`/`authority`/`availability` metadata | programmer plan §6.2 |
| `self__<verb>` stable naming | programmer plan §6.3 |
| `create(..., {location: actor})`; workspace scope for authored objects | programmer plan §6.4, §7 |
| `E_CATALOG_MUTATION` on created objects | programmer plan Phase C (deferred) |
| `trace` / `force_recycle` availability | programmer plan §6.2 |

This plan assumes §6.2's `tool` metadata block lands and *builds on it* in §6.
Where sequencing matters it is stated.

## 4a. Status (2026-07-25)

**L1.2 and L1.3 are implemented** on `worktree-mcp-legibility-l1`. L1.1 remains
blocked on self-ownership (§9), L2 on the programmer plan's metadata block, and
L4 is partially delivered — the two assertions those phases needed now exist in
`tests/worker/net-mcp-agent-surface.test.ts`; the description-quality and
`flags.programmer` assertions still trail their decisions.

Two things were learned in the doing, both recorded inline below:

1. §3.6's claim that the focus verbs are not tool-exposed was wrong (corrected
   in place).
2. **A manifest edit alone does not reach a deployed world.** Seed-hook
   properties are *initial* values — `reconcileSeedObject`
   (`catalog-installer.ts:1167`) skips any property the object already owns, by
   design, so seeded runtime state is never clobbered on cold init. L1.3's
   "it's a catalog-data edit and nothing blocks it" was therefore true of the
   fix but not of its delivery: fresh worlds got the corrected topics, and every
   already-installed world would have kept serving the wrong ones. Closing it
   needed a boot migration (`2026-07-25-help-mcp-topics`, §CT5.4.1) that
   replaces a topic only where its stored value still matches the shipped
   default byte-for-byte, so operator edits survive. **Any future L2.3
   description or topic-text change inherits this constraint.**

## 5. Phase L1 — orientation (independent, do first)

Cheapest and highest leverage. No dependency on the programmer plan.

### L1.1 Rewrite the `initialize` instructions

`gateway-do.ts:4527` is the only guaranteed-delivered orientation. It must state
the model, not just the refresh rule. Target content:

- you *are* object `<actor>`; you act in the world as that object;
- tools named `<actor>__*` (or `self__*` once §6.3 lands) are verbs on your own
  body — your suit — and they come from your class chain, not from this
  protocol;
- other tools are the space you are in, the objects visible in it, and what you
  carry; moving or taking changes the list;
- your suit changes when your class or features change, and you will receive
  `notifications/tools/list_changed`;
- `woo_list_reachable_tools` for compact/filtered discovery; `woo_wait` to hear
  what others do; `woo_call` when your cached list is stale.

Constraints: keep it short enough that clients render it; it is a *map*, not a
manual — point at `<actor>__help` for depth. Must not name catalogs or command
words (layering discipline). Must be generated, not hardcoded per catalog.

**It must not claim the suit is self-programmable until §3.3 is resolved.**

### L1.2 Privilege the actor in tool ordering

Sort the session actor's object first in `mcpToolsForObjects`, ahead of the
alphabetical remainder, so the suit can never fall off page 1. Cheap, local,
removes a silent failure mode.

### L1.3 Fix the help database

`catalogs/help/manifest.json`:

- rewrite `focus` — either delete it or restate it as the in-world
  `$actor:focus` verbs, explicitly noting MCP does not use a focus protocol;
- fix `wait` → `woo_wait`, with the actual argument names;
- rewrite `building` to name the real path to authoring authority;
- add a topic (`self`, aliased `suit`, `me`) covering the actor/class model,
  `<object>__<verb>` naming, and where tools come from;
- add a topic (`tools`) covering `woo_list_reachable_tools`, `woo_call`,
  `woo_wait`, and `list_changed`.

Version bump on the `help` catalog. Per the migration decision table this is a
seeded-property value change, not a class shape change — a minor version is
sufficient and no `migration-v*.json` is required. Confirm against
`spec/discovery/catalogs.md §CT14` before landing.

## 6. Phase L2 — description quality catalog-wide

Depends on the programmer plan §6.2 `tool` metadata block for the *mechanism*;
the *coverage* work is owned here.

### L2.1 Retire comment-scraping as the primary description source

`mcpFirstParagraph` must stop shipping arbitrary body comments. Order of
preference: explicit `tool.description` metadata → a leading doc comment on the
verb → nothing. Never a comment from the middle of a body, never a fragment
truncated mid-sentence.

If a doc-comment fallback is kept, it must require the comment to be the first
token of the verb body and must not truncate at the first blank line mid-clause.

### L2.2 Guard: no undescribed tool-exposed verb

New `scripts/guard-*.mjs`, wired into `npm run test:guards`: every verb with
`tool_exposed: true` (or reachable as command-shaped from a space) in every
bundled catalog must carry a `tool.description` or a leading doc comment. Fail
the build otherwise.

Run it first in report-only mode to size the backlog — expect ~130 verbs across
`outliner`, `dubspace`, `chat`, `tasks`, `mug`, `cockatoo`.

### L2.3 Write the descriptions

Mechanical but not trivial: each needs to say what the verb does and what its
arguments mean, from the caller's point of view. Sequence by tool count:
`the_outline`, `the_dubspace`, `the_chatroom`, then the rest. Best done per
catalog, alongside that catalog's `DESIGN.md`.

## 7. Phase L3 — a truthful answer to "can I program my suit?"

This is a design decision, not a mechanical fix, and it should be taken
explicitly rather than left as an accident of `canAuthorObject`.

The current answer is no: an actor does not own itself
(`target.owner === actor` fails), so `install_verb` on self returns
`E_PERM: guest_1 cannot author guest_1`.

Three candidate positions, to be decided before L1.1's wording is finalized:

1. **The suit is class-granted only.** Capability arrives by promotion,
   feature attachment, or carried objects — never by self-authoring. Simplest,
   matches the LambdaCore split, and is what the code does today. L1.1 then says
   so plainly, and directs an agent that wants new capability to acquire a
   feature or carry a programmed object.
2. **An agent may own and program its own body.** Requires deciding whether a
   provisioned agent owns itself, with real consequences for authority,
   recycling, and the `$account` quota model. Powerful, and the most literal
   reading of "the suit is programmable".
3. **Personal workspace, not personal body.** The agent owns a workspace object
   and programs objects there, carrying them to gain tools. This is what the
   programmer plan's §7 workspace boundary already builds toward, and it makes
   option 1's wording honest while delivering the capability.

Initial recommendation was 3. **DECIDED 2026-07-25: option 2**, on the
maintainer's call to stay aligned with the LambdaMOO experience, where
self-authoring and installing features on yourself are both ordinary. §7.1
records the field evidence; §7.2 the resulting requirements. Option 3 is not
discarded — it remains the right home for *scratch* authoring, and the
programmer plan §7 continues to own it. The two compose.

### 7.1 Field evidence from LambdaMOO

Observed live on LambdaMOO (1.8.3+47) against a real character, read-only apart
from one accident (§7.3). The suit there has **three** independently
player-controlled layers, not one:

1. **Player class — the parent chain.** The observed character's chain runs
   eight classes deep before reaching `$player` (#6), each a separate
   community-authored class owned by a *different* person:

   ```
   tty (#112104)  owner: itself
    └ #49900  Sick's Sick Player Class              owner #57140   (44 verbs: morphing, possessions, notifications)
      └ #40099  Sick's Slightly Sick Player Class
        └ #59900  Sick's Sick of Spam player class
          └ #6225  Global Positioning Player Class  owner #54879
            └ #6669  Detailed Player Class          owner #33119
              └ #26026  Generic Super_Huh Player
                └ #33337  Politically Correct Featureful Player Class …
                  └ #8855  Player Class hacked with eval that does substitutions …
                    └ #5803 → #7069 → … → $player (#6)
   ```

   The classes are fertile (`f=1`), so adopting one is self-service. Capability
   arrives by *choosing an ancestor*, and the ancestors are a community
   ecosystem, not a fixed pair of `$player`/`$programmer`.

2. **Features — a self-service list on the player.** The character carries 30
   feature objects (`player.features`), e.g. "Pasting Feature", "Stage-Talk
   Feature", "Multi-communications feature", "Clubs Feature Object". They are
   attached by `$player:@add-feature` (#6), which is plainly self-service —
   `set_task_perms(player)`, then `player:add_feature(dobj)`.

   Discovery is **spatial**: `@add-feature` with no argument falls back to
   `$feature.warehouse` — a room (#23777, "Feature Warehouse") holding 168
   browsable feature objects, with a `(*)` marker on ones you already have. You
   find new capability by going somewhere and looking at it.

3. **Verbs authored directly on yourself.** The character defines its own
   `:type` verb with a full command arg-spec
   (`any on top of/on/onto/upon this`), owner and perms its own. Ordinary,
   unremarkable, and the thing woo currently refuses.

The mechanism that makes layer 3 legal is a single fact:

```
;player.owner == player   =>  1
```

**In LambdaMOO a player object owns itself.** That is the entire difference
from woo, where a minted actor is owned by `$wiz` and `canAuthorObject`
(`world.ts:1646`) therefore refuses `install_verb` on self. The programmer bit
is a *separate* gate and behaves exactly as woo's does
(`player.programmer => 1`, `player.wizard => 0`): owning yourself lets you
author on yourself; the bit decides whether you may write code at all.

### 7.2 Requirements this creates for woo

- **Actors own themselves.** The minimal enabling change; everything else
  follows. Needs a decision on what that means for recycling, quota
  attribution, and `$account` — an actor that owns itself cannot be reclaimed
  by owner-identity alone. Not a blocker, but not a one-liner either.
- **The progbit stays the code-writing gate.** Unchanged from today, and
  unchanged from LambdaMOO. Self-ownership is not self-promotion.
- **Features become self-service.** woo already has most of this: the MCP tool
  resolver in `mcpObjectToolDrafts` (`gateway-do.ts`) already walks a
  `features` property chain when building an object's tool list, and the
  merged programmer-surface work composes capability through exactly that
  mechanism (`has_surface`, `$system.programmer_surface`). What is missing is
  the LambdaMOO-style *self-service attach* — an `add_feature` an ordinary
  actor may call on itself — plus a policy for which features are
  self-attachable (LambdaMOO's `can_be_attached_by` analogue already exists in
  the programmer work).
- **A discovery surface.** The Feature Warehouse is the piece with no woo
  equivalent and it is the answer to "how would an agent ever know?". A
  browsable in-world place beats protocol metadata: it needs no MCP extension,
  it is catalog data rather than core, and it is reachable by the ordinary
  structural-context rules an agent already understands. This is a strong
  candidate for its own catalog.
- **L1.1 wording changes.** The instructions may now honestly say the suit is
  extensible by the agent itself — via features, via class, and (with the
  progbit) via authoring verbs on itself. It must not say so until actors
  actually own themselves.

### 7.3 Incident during this investigation

While inspecting the live character, the `moo` MCP's `moo_verb_info` tool —
documented as *"Run `@verb <object>:<verb>` — show verb owner, perms, and args.
Useful for inspecting permissions before reading source"* — added an empty
second `type` verb to the character. `@verb` **creates** a verb in LambdaMOO;
the read command is `@display`. The tool description states the opposite of the
tool's effect.

Repaired immediately: `delete_verb(#112104, 2)` removed the empty verb by
index (unambiguous between two same-named verbs), and the original was verified
byte-identical afterwards — code, args `{any, on top of/on/onto/upon, this}`,
`verb_info` `{#112104, "rd", "type"}`.

This is worth recording because it is the review's own thesis landing on the
reviewer. A wrong tool description is not merely an efficiency problem for an
agent; it is a **safety** problem, because an agent selects tools by their
stated effects and cannot see the implementation. It raises the priority of two
things in §6:

- L2.1 must cover **effects**, not just prose quality. The programmer plan's
  §6.2 `effects` field (`authoring_write` etc.) is the right seat, and the
  L2.2 guard should require it on every mutating tool-exposed verb — a verb
  whose bytecode writes must not be describable as read-only.
- Any woo tool whose description understates its effects should be treated as a
  defect of the same severity as a permission bug.

### 7.4 Field notes: the LambdaMOO programming surface (2026-07-25)

A second live session exercised the *authoring* experience end to end on
LambdaMOO: created `#79242` (`$thing`), added a verb, programmed it three
different ways, drove the verb editor, forced a compile error, and recycled the
object. Findings are directly applicable to woo's programmer surface.

#### 7.4.1 Three authoring paths, and only two survive a request/response client

| Path | Where the in-progress state lives | Under MCP |
|---|---|---|
| `@program obj:verb` | **the connection** (line-input mode until a lone `.`) | **fatal** |
| `set_verb_code(obj, verb, lines)` | nowhere — atomic single call | perfect |
| `@edit obj:verb` (editor room) | **the world**, on `$verb_editor` keyed by player | works, and survives |

`@program` is a *connection mode change*: it takes over the input stream for an
unbounded number of subsequent lines. A request/response bridge cannot represent
that. The call timed out, and **the timeout dropped and re-established the
connection**, silently destroying the state. Any lines already typed would have
been lost with no error.

`set_verb_code` is the opposite and is the shape woo's `install_verb` should
aim at: one call, no mode, and a structured result — an empty list means
compiled, otherwise a list of error strings. It worked first time.

`@edit` is stateful but keeps its state *in the world*. This was tested
properly: I inserted a line, ran `pause` (which walked me back to Happy Trails
Camping Area), did other things, then `@edit` with no arguments — and the buffer
came back intact, my inserted line included.

**The rule this yields for woo: editor state in the connection dies; editor
state in the world survives.** woo's `$verb_editor` as a `$space` with a
per-actor buffer is already the right architecture, and this is direct evidence
for it. The corollary is a prohibition: woo must never add a connection-mode
authoring path, however convenient it looks for a TUI. Two silent reconnects
happened during this session alone.

#### 7.4.2 What being a *room* actually buys

The editor is `#5443`, parent `#5400 Generic Editor`, and it is a real,
*shared* room. Consequences observed, all of which woo inherits for free by
making the editor a `$space`:

- **`look` is the help.** The room's description *is* its command list
  (`list`, `insert`, `del`, `find`, `subst`, `move`, `join`, `fill`,
  `compile`, `abort`, `pause`). Affordances are discovered by looking at where
  you are — no out-of-band documentation, and it maps straight onto
  `look_self`.
- **You have not left the world.** `say` and `emote` are in the editor's own
  command set. Other programmers can be in the room with you; it is one shared
  editor, not a private modal overlay.
- **Ordinary commands still work.** I ran evals against the live world from
  inside the editor, including reading the live verb while its buffer was
  dirty. Being in the editor restricts nothing.
- **Presence semantics apply uniformly.** While in the editor I received no
  chatter from my origin room — correct, because I was genuinely elsewhere.
  Player-directed traffic (mail) still arrived. woo gets this consistency
  automatically; a modal editor would have to reinvent it and would get it
  subtly wrong.
- **`pause` is first-class.** Leaving with state intact is a named, supported
  operation, not an accident.
- **Uncommitted state is framed socially, not technically.** Pausing prints
  *"Please come back and COMPILE or ABORT … Keep Our MOO Clean! No
  Littering!"* There is no lock and no timeout — just a norm about leaving
  litter in a shared world. Worth copying: woo's instinct would be a lease or a
  lock, and a norm may serve better.

#### 7.4.3 Compile is non-destructive, and diagnostics are line-anchored

Inserting a deliberately broken line and compiling produced:

```
#79242:poke not compiled because:
  Line 4:  syntax error
```

Verified immediately afterwards: the **live verb was untouched** — still the
original two lines — while the buffer retained all four including the broken
one. So the model is two-phase and safe by construction: the buffer is durable
and freely mutable; the live verb changes only on a compile that succeeds.

Note what this implies for woo's `dry_run`: LambdaMOO needs no separate
preview call, because *compile itself is the preview* when it fails. `dry_run`
remains useful for "tell me what would change on success", but a failing
`install_verb` must never be able to leave a half-written verb, and should
return line-anchored diagnostics in the same envelope.

#### 7.4.4 Smaller observations

- **The arg-spec is the tool surface.** `@verb #79242:poke this none none`
  followed by `poke probe` worked because the object was in my inventory —
  the command spec is what makes a verb reachable, exactly as
  `arg_spec.command` gates woo's command-shaped exposure. The parallel is
  close enough that woo's model needs no change here.
- **Self-ownership is not total self-control.** I own my player object, yet
  `player.ownership_quota` is a wizard-owned property *on* me and reading it
  is refused. Object-level self-ownership coexists with property-level policy
  owned by someone else. This matters for §7.2: "actors own themselves" does
  not have to mean an actor controls every property on itself, which defuses
  much of the quota/recycling objection.
- **The editor's `insert` has a fragile text syntax.** `insert $ "…` takes the
  rest of the line literally, so embedded quotes break it. Fine for a human
  typing prose, poor for programmatic use. woo's editor verbs should take text
  as a proper argument rather than a line-tail convention.

#### 7.4.5 Consequences for woo

1. Keep `$verb_editor` as a `$space`; never add a connection-mode path (§7.4.1).
2. Make the editor room's `look_self` the authoritative command list, so the
   editor is self-documenting the way the rest of the world is (§7.4.2). This
   is the same principle as the Feature Warehouse in §7.1: **discovery is
   spatial**.
3. Ensure a failed `install_verb`/`save` is atomic and returns line-anchored
   diagnostics, leaving both buffer and live verb intact (§7.4.3).
4. Keep the direct path primary. `install_verb` with a full source string is
   the common case for an agent; the editor is for *iteration*, not for the
   basic write. An agent should never be forced through the editor.
5. Prefer a norm plus visibility over a lock for abandoned buffers (§7.4.2).

## 8. Phase L4 — permanent coverage

The temporary harness proved these findings and was discarded. The finding class
must not be able to regress silently.

Add `tests/worker/net-mcp-agent-surface.test.ts` asserting, over the fake-DO
gateway lane against the installed world:

- `initialize` instructions are non-empty and name the session actor;
- the session actor's own tools appear on the first `tools/list` page,
  regardless of how the actor id sorts (drive it with an actor id sorting after
  `the_outline`);
- no `tool_exposed` verb reachable in the default context has an empty or
  fragment description (pairs with the L2.2 guard, at the transport boundary);
- the `focus` and `wait` help topics do not name tools absent from the MCP
  surface — assert against the live `tools/list` names, so the test cannot rot
  the way the current topics did;
- a `$programmer`-classed actor *without* `flags.programmer` either does not see
  authority-gated tools, or sees them with an `authority` marker (per whichever
  §3.4 resolution is chosen).

The last item's exact assertion depends on the §3.4 decision; write the test
with the decision, not before it.

## 9. Sequencing

```
L1.3 help fixes ─┐
L1.2 ordering  ─┼─ independent, land now
L3 DECIDED     ─┘        │  (option 2; actors own themselves — §7.2)
                         ▼
                    L1.1 instructions  (blocked on self-ownership landing,
                                        not on the decision)
                         │
programmer plan §6.2 ────┼──► L2.1 description source
                         │         │
                         │         ▼
                         │    L2.2 guard ──► L2.3 backlog
                         ▼
                    L4 tests (needs §3.4 decision)
```

L1.2 and L1.3 are landable immediately and independently. L1.1 is now blocked
on self-ownership actually landing (§7.2), not on the decision. L2 is blocked on
the programmer plan's metadata block. L4 trails the decisions it asserts.

§7.2 adds a work item the original plan did not have — a self-service feature
attach plus a discovery surface (the Feature Warehouse analogue). That is
catalog work, independent of L1/L2, and can proceed in parallel.

## 10. Honest limitations of this review

- Everything above was observed on the **fake-DO lane** against the bundled
  demo world. Per the smoke-test ladder in `AGENTS.md`, that lane lacks cold
  starts, real RPC isolation, and serialization boundaries. Nothing in these
  findings depends on those — they are surface-content findings, and the tool
  list is computed in-gateway — but the `E_CATALOG_MUTATION` and `take`
  failures in §3.3 should be reconfirmed on `smoke:net-mcp` (real workerd)
  before anyone treats the reproduction as canonical.
- Tool counts (165 / 2 pages) are specific to the bundled demo world with
  `the_outline` and `the_dubspace` present in the chatroom. A minimal world
  produces a far smaller list; the ordering risk in §3.7 is independent of size.
- The §7.4 authoring session ran as an ordinary programmer, not a wizard, on a
  single object that was recycled afterwards. The `@program` finding is a
  property of *this MCP bridge's* request/response model, not of LambdaMOO — a
  human at a telnet client uses `@program` happily. The transferable claim is
  about connection-held state versus world-held state, and that one is general.
- The LambdaMOO observations in §7.1 are from **one** character on one server.
  The three-layer model and self-ownership are core-DB facts and generalize;
  the specific eight-deep class stack and 30 features are that player's
  choices, and should not be read as typical.
- The `$programmer` actor was constructed by direct `chparentAuthoredObject` +
  `setObjectFlags`, not through the supported provisioning path. That is
  adequate for observing the resulting tool surface and not adequate for any
  claim about promotion mechanics — see the programmer plan and the Net
  promote/demote work for those.
