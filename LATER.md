# later

Open items, sketches, gaps. Not commitments.
New items go at the top.  Move to the bottom when final.

---

## random stuff to do

- tasks: presence panel: height should be full available (like pinboard and dubspace).  Another instance of feature drift between catalog tools, we need to build a system that prevents this sort of drift, not just fix the issue.

- Outliner chat panel dimensions are still significantly broken, and different from the other tools.  We need to prevent this sort of drift.

- Perf in browser.  Entering the outline tool see wait cursor for many minutes.



syntax for @-someone

want to integrate this as a hermes plugin
- run locally (with ability to switch to cloud just by providing a URL in config)
- local runtime has:
    - one running woo instance, shared across hermes profiles
    - each hermes profile *automatically gets a programmer actor*
    - each hermes profile gets their own instance of the MCP

- hermes localhost interface:

- onboarding:
    - create a user *from a hermes profile*

- edges, or reverse-objref indexes

    thing about our object model is, it's not really a graph
    and we don't have indexed collections (traversable in both directions)
    which means sequential-scan-of-things is our default behavior
    but that's silly, we should just build an actual "edge table"
    and make objref-type properties trivially traversable in either direction
    (automagic "a.owner=b" ==> "b.inverse_owners=[a,...]")
    and we should do that the ~same way that keep does
    by a metaproperty on the `foo` property `_inverse: bar` that says:
    "a.foo is an objref, so b.bar is a collection of `a`"

    maybe declare that on 'b' where it belongs, as
    `b.bar: inverse_of(a.foo)`
    which requires that a.foo is an object reference iff targeting 'b'

- oh by the way: split out the "delete taskspace" from the "add tasks"
    - they should share nothing

- workflow conditions/gates with xstate-style rule definitions?
    - just with whatever properties the state defines!
    - just a state machine.

- push to talk

- multi-instance data blocks (e.g. one per claude session, one per slack channel)
    - single auth, single websocket
    - just exposes multiple objects on the focus list
        - each object has its "canonical identifier"
    - who controls the duplication? (anyone!!)

- port block for claude-code or hermes or pi or something
    - enter -> directly in its tui
    - or: say, get responses
    (block is an agent, but can have a room within)

- user identity (MCP) for hermes
    - make sure it can do the dynamic tool list like claude
    - one per profile
    - so, your hermes is "tester" -> in a loop
    - websockets would be better actually!

- port block for github (just runs as a python or ts process)
    "say https://github/issues/1234" -> grab it
    "say ...pull/1234"
    list all the things

- Who can create a task?

- github: copy their workflow (dynamically) into our policy layer

- new workflow:
    - "Saved policy" -> should be "Saved workflow"

- shell script to create a builder
- shell script to create a programmer
- Separate "demo" from just "tasks and inline chat"
    - make them work in the same ui
- onboarding for local (just tasks)
- tasks usability
    - "santa's workshop" should be an actual room, for multi-project doors
    - use a "picker" for: the steps, in the workflow editing dialog, not freetext
    - CLI command "list tasks", "list roles", "list workflows", "list steps"
    - from "new workflow" need to be able to add "new step"
    - are steps strictly within-workdlows?  (not necessarily)
    - step id: is this literall the id? want a step *name*
    - draw a graphical view of an item's workflow (and its history, and possible next steps)
- build an ops dashboard
- easy onboarding for cloud
- tasks room plug - sync with git repo
  (just using the whole regular commands, not a special authority)
- $wiz name/description
- a small agentic pet that wanders around (plug/block), interested, sleeps some
- structured review process
- get the elves to build santa's workshop (using the kanban)
- chat transparency isn't really working
- better enter/leave messages; and for dubspace/pinboard/etc
- djspace
- dubspace bpm
- make the couch a transparent room; "sit", "up"/off/out
- LM couch shows your location as LR, right?
- dm (outside of a room), chats and channels
- flesh out the help, make it the default platform-docs
    - help is markdown notes
- guest "it is awake and looks alert"
- subscriptions (to anything) (grouped??)
- help policy in DSL — first-light help is native-backed with explicit source stubs. Move `$player:help`, help search-path policy, directive rendering, and miss recording into woocode once the DSL has actor-ancestry and actor-aware verb-source primitives; then drop the native help handlers.
- ~~multiple rooms, and furniture and exits~~ — first chat slice landed with Living Room, Deck, Hot Tub, exits, fixed furniture, and portables.
- migrate `the_dubspace`, `the_taskboard`, and `the_chatroom` manifests to declare `instances_self_host: true` on `$dubspace` / `$task_registry` / `$chatroom` (or `$room`) at the class, instead of stamping `host_placement: "self"` on each instance. Wire `create()` to compute `host_placement` from the parent chain. Keep `host_placement` as the runtime projection. Manifest-migration story per `spec/semantics/objects.md §4.2`.
- mid-RPC origin-host crash drops the awaiting task: the v1 `awaiting_call` removal trades a real durability story for simplicity (`spec/semantics/tasks.md §16.3`). If a verb does many cross-host RPCs and the origin host evicts mid-flight, the in-memory task is lost. Revisit if the workload makes this hurt.
- ~~cross-host session-record propagation~~ — call envelopes and Directory session routes now carry `current_location`; receiving hosts upsert forwarded session state before dispatch. Worker-routed smoke covers chatroom → deck → hot tub with coherent `/api/state.session.current_location` and `entered.origin`.
- native demo mechanics remain in `WooWorld.registerNativeHandlers()` (`room_take`, `room_drop`, command parsing, match helpers). Movement (`:enter`, `:leave`, directions, `:go`) has moved back into chat woocode; keep shrinking the native list as the DSL can express object matching and portable checks cleanly.
- ~~cross-host containment primitive~~ — `moveObjectChecked()` now routes to the object's host, writes `location` there, and mirrors old/new container `contents` through the host bridge. Worker-routed fake-DO smoke now covers room enter/go, inventory take/drop, and pinboard add/move/edit/list through Directory-resolved host objects. Remaining work: live-deploy or Miniflare smoke against real workerd APIs, plus broader route stamping for runtime-created non-anchored objects.
- deferred host effect batching — cross-host source verbs currently return generic effects (`actor_presence`, `space_subscriber`, `move_object`) and the origin host applies each one as a separate host-bridge operation. A single room move can be four fetches. Fine for first-light; batch by target host into one `apply_effects` RPC if movement or mounted-space activity gets hot.
- MCP catalog discovery (CT11) — `catalogs/<name>/agent_manifest.json` and the `/.well-known/mcp.json` route are spec-only today (`spec/discovery/catalogs.md §CT11`). Runtime tool discovery just consults `tool_exposed` + reachability. Wire the manifest path once first-light agents start consuming it.
- catalog uninstall — the runtime now supports catalog install/list/update/migration_state, but not safe uninstall. Implement only after the §CT9 checks can prove no live instances, references, feature attachments, or log/snapshot dependencies would be broken.
- catalog custom/transform migrations — structural migration steps exist; `rename_class`, `transform_property`, and `custom` are still rejected with `E_NOT_IMPLEMENTED`. Land these when object-reference migration and typed/metered migration verbs are real.
- alias-scoped catalog class allocation — aliases currently disambiguate registry/source references but do not allocate separate concrete objrefs for two catalogs that both define `$same_name`; the runtime rejects that as `E_NAME_COLLISION`.
- MCP queue retention — observation queues are session-scoped and reaped at DELETE; we don't yet enforce the session-grace TTL or drop observations older than the spec's ~1 hour TTL (`spec/protocol/mcp.md §M4.1`). Currently the only ceiling is the hard cap (4096 entries). Add age-based eviction once it shows up in profiling.
- internal-auth replay cache — HMAC-signed Worker/Directory/cluster requests currently have timestamp freshness only. A captured signed internal request can replay inside the 5-minute skew window if internal traffic or logs leak. v1's same-deployment trust assumes attackers cannot observe internal traffic; if that assumption weakens, reuse the host-RPC `correlation_id`/recent-replies cache pattern for nonce replay protection.
- verb alias wildcard lint/deprecation — `literal*` is currently a broad wildcard while `literal@` is LambdaCore-style abbreviation. First-party catalogs now use `@`, but the engine still accepts trailing `*` for compatibility. Add catalog/install warnings for aliases with a single trailing `*` and no `@`; later decide whether to reserve `*` or keep it as explicit glob syntax.
- host-scoped local catalog repair retry state — host repair currently logs and defers when a partial slice cannot resolve a manifest reference. That is correct for transient stale seeds, but a permanently broken manifest can warn on every cold init. Add per-host backoff or "skip until manifest version changes" state if this gets noisy.
- `collect_prop` host-grouped batching — the builtin currently shares the frame memo and can run direct-call reads in parallel, but it still issues one RPC per remote object. Group by resolved host and add a bulk property-read host RPC if profiling shows large remote lists (task summaries, room rosters) getting hot.
- cross-host value-level predicates — builtins that read like pure predicates (`isa`, `parent`, and adjacent ancestry/introspection helpers) still assume host-local object records in places. A remote-but-valid objref can therefore surface as `E_OBJNF` from inside an ordinary guard. Either make these host-transparent, or fail with a typed remote/indeterminate error so woocode authors can produce useful user-facing messages.

## structure

- spec/README.md, spec/vision.md, spec/dubspace-demo.md, spec/taskspace-demo.md exist alongside the layered spec — decide whether they roll into the spec layers or stay as author working docs.
- residual "DO" / "SQLite" mentions in some semantic sections (mostly in code-snippet context) still drift toward implementation; ok for now.
- maybe full event→observation rename (file, API names, wire op) — currently only a synonym note bridges core.md and events.md.

## spec gaps

- broader authoring system: schema editor, history/replay viewer, version/rollback UI, package import/export
- catalog migration step kinds for ownership transfer: extend `spec/discovery/catalogs.md §CT14.2` with `drop_seed` and `drop_class` (or a single `transfer_to: <other_catalog>` step) so a publisher splitting a catalog can declare the cleanup explicitly in `migration-vN-to-v(N+1).json` rather than relying on the runtime's auto-prune at adopt time. Today `installLocalCatalog` prunes adopted ids from prior owners' registry records as a side-effect of `adoptExisting`; the migration-declarative path is more honest and would become the primary mechanism once that vocabulary lands.
- woo-flavoured rewrite of [yduj's duck tutorial](https://www.hayseed.net/MOO/yduj-duck-tutorial.text) — the canonical "build your first verb on a duck" walkthrough, ported to woo's DSL, dispatch model, and authoring surface. Aimed at first-time programmers (the original audience), not engineers porting from MOO.
- chat UI: improve per-object discovery so a browser user can find e.g. `the_cockatoo:squawk()` without prior knowledge. `look` now exposes room contents, but there is still no object selection/verb affordance.
- cockatoo mobility: it is deliberately anchored in the Living Room today, so it disappears from most of the three-room path. Later, make it roam/roost via a presence-gated scheduled verb once fork/scheduler authoring is comfortable.

## deferred specs (placeholder docs to write)

- audio / streamed media (`spec/deferred/audio.md`)
- capabilities (`spec/deferred/capabilities.md`)
- conformance suite (`spec/deferred/conformance.md`) — when there's a second implementation

## not in v1, deliberately

- **re-anchoring** (`reanchor(obj, new_anchor)`). Anchor is set at create time and immutable. Atomicity scope changes are deliberate and rare; if someone needs the effect, they can create-copy-recycle. Re-anchoring as a runtime operation would require recursive subtree migration with task drain and routing redirects — too much machinery for the value at v1.
- **durable `awaiting_call` continuations for cross-host RPC**. v1 keeps one async path but does not park an in-flight remote call in storage. If an origin host crashes or evicts while a verb is awaiting remote work, that in-memory task is lost and the caller retries. Durable remote-call continuations would improve robustness for chatty cross-host verbs, but they bring back callback/continuation machinery that v1 is explicitly avoiding.
- **object-defined UI components** (e.g., a `$ui_renderable` feature class with a `:ui_hint()` verb returning A2UI-shaped payloads). The object model can absorb this whenever it earns its keep — `:describe()`, declared event schemas, and verb metadata already give an agent ~70% of what it needs to generate a useful UI. The missing piece is layout/archetype intent ("control surface" vs. "feed" vs. "form"), which is one optional verb on one feature class away. Not building yet because (a) the chat surface hasn't yet proven what hint shape carries weight, and (b) A2UI itself isn't a stable target. Worth keeping the option open and revisiting when either of those unblocks.

## decisions still open

- cross-host reentrancy: reentrant lock by task-id vs explicit `with_lock` (currently leaning explicit; revisit after measurements)
- multi-session per player: fan-out vs first-wins (currently leaning fan-out)
- `chparent` orphan property values: drop vs preserve (currently dropping) - check with LM
- strict vs dynamic verb compile: dynamic for v1; opt-in strict later

## ops / infra

- empirical validation that suspend-across-hibernate actually works for 24h+ on CF
- wizard audit log (`WizAudit` DO): bypass events, set_verb_code on others' objects, set_quota overrides
- DSL grammar (EBNF) — once parser is stable
- real cost numbers in `spec/reference/cloudflare.md` once the implementation exists
- real-time approximation for quota accounting via per-DO delta pushes

---

Done:

. per-value size cap: 256 KiB
- ~~value model~~ — done (`spec/semantics/values.md`)
- ~~$space normative behavior~~ — done (`spec/semantics/space.md`)
- ~~identity / session (lite)~~ — done (`spec/semantics/identity.md`); full account/credential/recovery flows still deferred
- ~~failure model consolidation~~ — done (`spec/semantics/failures.md`)
- ~~worktrees / sandbox / promote~~ — done (`spec/operations/worktrees.md`)
- ~~migrations (bytecode, schema, data)~~ — done (`spec/operations/migrations.md`)
- ~~credentialed auth (account vs actor, OAuth, multi-character)~~ — done (`spec/identity/auth.md`)
- ~~debugging (step / breakpoint / replay)~~ — done (`spec/tooling/debugging.md`)
- ~~backups + restore + cross-environment migration~~ — done (`spec/operations/backups.md`)
- ~~deployments (dev/staging/prod, spec versions, blue-green)~~ — done (`spec/operations/deployments.md`)
- ~~observability (logs, metrics, traces, audit)~~ — done (`spec/operations/observability.md`)
- ~~conformance suite (behavioral test corpus)~~ — done (`spec/tooling/conformance.md`)
- ~~catalogs (named reusable object sets)~~ — done (`spec/discovery/catalogs.md`)
- ~~teams (team membership, role-based gating, team quotas)~~ — done (`spec/identity/teams.md`)
- ~~federation v1 (minimum cross-world surface)~~ — done (`spec/discovery/federation-v1.md`)
- ~~bootstrap world contract~~ — done (`spec/semantics/bootstrap.md`); concrete T0 bytecode fixtures in `spec/semantics/tiny-vm.md` "Concrete fixtures"
- ~~discovery / introspection surface~~ — done (`spec/semantics/introspection.md`)
- ~~observation schemas for the demos~~ — done (sections in dubspace-demo.md and taskspace-demo.md)
- ~~taskspace domain invariants~~ — done (Domain Invariants section in `spec/taskspace-demo.md`)
- ~~minimal authoring on-ramp~~ — first draft in `spec/authoring/minimal-ide.md`
. docs rewrite for clarity
. chat resize-bar stopped working
. woah
