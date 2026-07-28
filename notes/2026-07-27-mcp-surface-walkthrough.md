# MCP surface walkthrough — prod + workerd programmer lane

Date: 2026-07-27. Investigator: agent walkthrough against the deployed world
(`woah1.generalbusiness.ai`, **during an active deploy** — transient effects
flagged where they matter) plus a workerd smoke-lane world for the
programmer-profile probes prod cannot host (see finding 1). Sessions used:
`$wiz` (fresh routed credential), `guest_1`/`guest_2` (the deployed smoke
actors), and on the lane `agent_3` (anchored agent under `human_2`,
promoted to programmer mid-walkthrough).

The target user profile for this review: **a mid-capability agent holding the
programmer flag but not wizard**.

## Headline: the target profile cannot exist on prod today

Two independent locks compose into a circularity:

1. **`$wiz` is bricked on the client surface.** The actor is unplaced
   (`active_scope: null`), and the planning anchor falls back to the actor
   itself (`gateway-do.ts` clientAnchorObject); a `$`-prefixed actor
   classifies as `catalog`, and catalog is refused
   (`E_INVARG unplannable_scope`, gateway-do.ts:4191). Every one of the 26
   listed wizard tools fails — including `wiz__home`, the only tool whose
   purpose is to fix placement, and `wiz__eval`. The code comment "a
   located-nowhere actor plans at its own cluster" is true only for non-`$`
   actors. Verified deterministic, not deploy flake.
2. **Programmer minting is quota-gated to zero.** `create_agent(programmer:
   true)` / `promote_agent_to_programmer` consume
   `$account.programmer_grant_quota`, default 0
   (`$system.default_programmer_grant_quota` = 0), and only a wizard can
   grant quota (`$system:set_actor_flag` / `set_object_flags` are
   wizard-only). With every wizard credential landing on a bricked `$wiz`,
   **no progbit agent can be created on the deployed world by any path.**
   `help building` even says "Ask the account owner" — the seeded guests'
   owner is `$wiz`.

Remediation options (pick one): an operator-signed placement/repair op that
can set an actor's `object_live` location (fourth repair-family shape); or
mint a non-`$` wizard-flagged actor at install time (a non-`$` actor plans at
its own cluster even when nowhere — verified with `agent_3` pre-placement);
or exempt `$`-actor self-cluster from the catalog classification for
planning. Until then every wizard/operator interaction with the live world
must ride signed HTTP ops, not MCP.

## (a) Awareness / observation scope

**Verdict: the default spatial scope is right — matching chat's narrow
social-adventure model — but delivery has one leak and one loss mode.**

- Correctly narrow: a `say` in a room the observer is not in was NOT
  delivered; `who_all` is a room snapshot; `left`/`entered` arrive only for
  the observer's room. No global feed, no cross-room noise. Good.
- **Leak (must-fix): directed second-person echoes reach bystanders.**
  When guest_2 moved out, guest_1's queue received
  `{"type":"text","target":"guest_2","text":"You slide the glass door open
  and step out onto the deck."}` alongside the correct third-person `left`.
  The browser client filters `text` by `target`; the raw MCP queue does not.
  An agent reads another actor's private line (and it reads as nonsense —
  "You slide..." addressed to someone else). Audience filtering must happen
  server-side at the session queue, not in the client.
- **Loss: at-most-once with silent gaps.** `woo_wait` drains a per-session
  in-memory gateway queue (gateway-do.ts ~4558: "an eviction drops
  undelivered items; the client's next wait simply re-arms"). During the
  walkthrough (deploy in flight, DOs restarting) same-room `said` events
  emitted between polls were dropped with no gap marker; only an
  already-parked long-poll received events reliably. For a WS browser
  client at-most-once is livable; for a turn-based polling agent, chat is
  its *only* ear, and silent loss between polls means missed conversation
  with no way to know. Recommend at minimum a gap/epoch marker in the wait
  reply (the tools path already has the "conservative re-list hint"
  concept); ideally a short durable tail per session.
- **Focus/unfocus:** `help focus` now honestly documents deliberate absence
  ("a working set does not widen [your reachable set]"). For *awareness* I
  agree — nothing needs reinstating; the room scope is not too broad. But
  see (b): the place a focus concept would genuinely help is **tool
  callability**, not observation.

## (b) Tool granularity / visibility layer

**Verdict: the granularity is wrong in both directions — too many tools
listed, and the listed set is not the callable set.**

- guest_1 standing in the_chatroom gets **128 tools**, of which 69 belong to
  the_outline and the_dubspace — tool-spaces *mounted as objects in the
  room*. Calling one (`the_outline__add_item`) refuses
  `E_SCOPE_SPLIT: write set spans two distinct shared scopes` — the
  coherence layer enforces "move to use", so **more than half the surface
  is advertisement for tools that cannot be called from where the agent
  stands**, and the refusal names internals, not the remediation ("enter
  the_outline first").
- Massive structural duplication: every space repeats ~25 identical verbs
  (8 compass directions each — including directions with no exit, which
  exist and answer "You can't go that way" — say/pose/emote/quote/say_as/
  self/announce/tell/who/take/drop/enter/leave/look/look_at/go/out/
  command_plan/set_description). For an LLM agent this is real context cost
  and choice noise. The verb *vocabulary* is catalog behavior, but the
  *tool projection* could collapse it: movement = `go(exit)` + `ways`;
  speech registers = one say tool with a style arg; per-space duplicates
  suppressed in favor of the active space.
- The tension worth a design decision: **social presence and working set
  are conflated in the space model.** An agent in the chatroom cannot add
  an outline item without physically leaving the conversation. This is
  faithful MUD fiction and fine for the cockatoo; it is awkward for work
  surfaces (outliner/taskboard/pinboard). If focus/unfocus returns, it
  should return *here*: a focused tool-space whose verbs become legally
  callable (sequenced at the focused scope) without moving presence —
  i.e., decouple "where I am seen" from "what I may operate". That is a
  coherence-layer feature (multi-scope write sets or auto-scoped routing),
  not just a listing change. The cheap interim: list mounted-space tools
  under an explicit "requires enter" partition, or expose only
  `<space>__enter` + a directory line per mounted space.
- Unplaced actors are offered `nowhere__look` / `nowhere__set_description`
  (`$nowhere`'s verbs) — harmless but symptomatic of "project every
  contextual object's verb set" with no curation.
- Count mismatch: `woo_list_reachable_tools` reported `total: 142` while
  `tools/list` returned 128 — the two layers disagree about the surface.

## (c) Permissions / capabilities fit

**Verdict: the two-gate model (surface supplies tools, flag supplies
authority) is coherent and now well documented (`help building`), but the
surface deliberately lists tools that can never succeed, which is a trap
for agents.**

- `agent_3__force_recycle` is listed for a plain programmer (wizard-only
  authority). Pre-promotion, the whole programmer toolset would also list
  (help says so explicitly: "still listed but every one raises E_PERM").
  The repeated-defect pattern from the tooling reviews ("tool_exposed is
  not sufficient — verify from live tools/list") now has a sibling:
  *listed is not callable*. Either filter by authority at listing time or
  stamp the gate into the description ("requires the programmer flag").
- Refusal messages conflate three cases behind one string — "tool is not
  available in this session context" is used for not-tool-exposed,
  wrong-scope, and unauthorized. Three different remediations
  (set_verb_info / move / get promoted) deserve three messages.
- What works well: fail-closed everywhere probed; `E_PERM` traces carry
  `{obj, verb, definer, progr, pc, version}` frames (genuinely useful);
  ownership answers are honest (`guest_1 is owned by $wiz`); the promote
  turn's touched-cells receipt shows the quota decrement and features
  write. Note the self-authoring consequence: actors not owning themselves
  means even a progbit agent cannot author on its own body — the L3
  "players own themselves" decision is still unlanded.

## (d) Programmer experience

**Verdict: the core authoring loop is functional and pleasant on a healthy
world; four discoverability/contract defects stand between an agent and
it.** (Probed on the workerd lane; prod cannot host the profile — see
headline.)

The good path: promotion live-updated the session's tool surface 12→27
without reconnect; `install_verb` with a syntax error returned a precise
diagnostic (`E_COMPILE, expected expression, line 1 col 29` + span);
correct install returned slot/version/metadata; `list_verb` reads back
exact source with lineage walk; `inspect` gives owner/flags/parent-chain
with per-class verb counts; `set_verb_info {tool_exposed:true}` immediately
surfaced the authored verb as a callable tool.

The defects:

1. **`woo_call` violates its documented contract.** `help tools`: "calls
   any verb you may reach, and still works when your cached tool list is
   stale." Reality: it enforces the same tool-context filter as the
   dynamic tools — the agent's freshly authored `:ping` on a widget *in
   its own inventory* refused E_PERM until `tool_exposed` was set. Nothing
   tells the author that `tool_exposed` is the gate. Either widen
   `woo_call` to reachability+perms (my read: this is what the help text
   promises and what agents need) or fix the doc and make the refusal say
   "verb exists but is not tool-exposed; set_verb_info(...,
   {tool_exposed:true})".
2. **`eval` cannot name created objects — and the fix is undocumented.**
   `obj_human_2_1:ping()` → `E_COMPILE unknown identifier`. The working
   syntax `#obj_human_2_1:ping()` (objref literal) appears in no help
   topic, no eval docstring, no diagnostic hint. One line in the eval doc
   and a "did you mean #id" hint in the compiler message would fix this.
   Until then the B4 workaround "invoke authored verbs via eval" is itself
   blocked for anyone who doesn't read the compiler source.
3. **`edit_verb` fails with an internals dump when the editor space is
   absent/misseeded** (`E_TYPE: editor must be space-like and define a
   private sessions property`). On the lane fixture that's a fixture gap;
   on prod the editor needs the post-deploy
   `repair:net-definitions '$programmer:edit_verb'` operator run (deploy
   checklist). Both worlds agree on the symptom: the door's failure mode
   is not agent-legible. The editor-room flow itself remains unvalidated
   over MCP — worth a dedicated pass once prod is repaired.
4. **No trace on the programmer surface.** `$wiz` lists `trace`; `agent_3`
   does not (`$programmer:trace` is not tool-exposed). A programmer who
   can install verbs but not trace them debugs blind.

Smaller notes: `create` returning `{id, owner, location}` is good;
truncated descriptions (below) hit the authoring tools hardest —
`create`'s description cuts off at "There is intentionally no".

## (e) Other usability observations

- **Tool descriptions truncate mid-sentence** wherever the source
  doc-comment's first line breaks: `wiz__create` = "Creates an object owned
  by the invoking actor. There is intentionally no", `ways` = "Do not turn
  an", `home` = "so the destination's". And the majority of tools carry
  only the synthesized `Call: obj:verb(args)` line. The extraction should
  take the first paragraph, not the first line, and the walkthrough L1 work
  on descriptions should be extended to the seeded natives.
- **Raw engine errors reach end users.** `help <unknown topic>` crashes
  with `E_CATALOG_MUTATION ... property_cell:$help:missed_topics` — the
  missed-topics tracker writes to an installed catalog object, which the
  post-cutover write rules refuse; a guest asking for help gets an
  invariant dump (and the telemetry silently never works). Same genus as
  the E_SCOPE_SPLIT and editor E_TYPE messages: engine-true,
  agent-useless. Every client-reachable refusal needs a remediation
  sentence.
- `initialize` instructions are one sentence and do not mention `help`,
  which is now actually good; "Call `<you>__help` for orientation" would
  pay for itself.
- Structured outputs are strong throughout: `look` returns typed
  roster/contents JSON; `who_all` rows are rich; move results carry
  `{room, from, exit}` — though also undocumented flags
  (`here_request`, `look_deferred`) an agent can't interpret.
- The three static tools have near-empty schemas (`woo_call.args` is an
  untyped array; `woo_wait` params undescribed in the schema itself) —
  cheap wins for agent ergonomics.
- `tools/list_changed` arrives only on the SSE GET stream; a pure
  POST-polling MCP client (like this walkthrough, or any minimal
  integration) never sees it despite the instructions telling them to
  re-list on it. The stale-list fallback (`woo_call`) therefore matters —
  which is another reason its contract (d.1) must be the wide one.
- Prod-hygiene note: this walkthrough left no durable residue (the outline
  add and mug write were refused; chat lines are ephemeral; guest_2 was
  returned to the_chatroom; the ProbeWidget lives only on the torn-down
  lane). The one durable change is the intended new `$wiz` Net credential.

## Priority order (my recommendation)

1. Un-brick wizard/operator MCP access on prod (headline) — everything
   else about the programmer story is theoretical until then.
2. `help` missed-topics crash (user-facing error on the most-recommended
   discovery verb).
3. Directed-echo leak to bystander queues (correctness of the audience
   model at the MCP layer).
4. `woo_call` contract + refusal-message split (unblocks self-serve
   authoring; one-line remediation strings).
5. Listing honesty: authority-filter or gate-annotate; scope-partition the
   mounted-space tools; collapse structural duplicates.
6. Observation gap signal for polling agents.
7. eval `#objref` documentation + compiler hint; trace exposure; editor
   failure legibility.
