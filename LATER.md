# later

Open items, sketches, gaps. Not commitments. Reorder freely. Style: keep / todo.txt — vibes, not roadmap.

The sections below distinguish three flavors of pending item:

- **Spec gaps** / **structure** / **ops/infra**: work that should happen when someone has cycles. Strike-throughs (`~~done~~`) mark closed items.
- **Not in v1, deliberately**: design choices the spec consciously declines, recorded so future readers see why the absence is intentional.
- **Decisions still open**: judgments deferred pending more information; the current leaning is documented but not locked.

## random stuff to do

- dm (outside of a room), chats and channels
- are lists-of-text ok? that's a mooism that we don't really need and might cause problems later
- flesh out the help, make it the default platform-docs
    - help is markdown notes
- guest "it is awake and looks alert"
- kanban
- subscriptions (to anything) (grouped??)
- help policy in DSL — first-light help is native-backed with explicit source stubs. Move `$player:help`, help search-path policy, directive rendering, and miss recording into woocode once the DSL has actor-ancestry and actor-aware verb-source primitives; then drop the native help handlers.
- ~~multiple rooms, and furniture and exits~~ — first chat slice landed with Living Room, Deck, Hot Tub, exits, fixed furniture, and portables.
- migrate `the_dubspace`, `the_taskspace`, and `the_chatroom` manifests to declare `instances_self_host: true` on `$dubspace` / `$taskspace` / `$chatroom` (or `$room`) at the class, instead of stamping `host_placement: "self"` on each instance. Wire `create()` to compute `host_placement` from the parent chain. Keep `host_placement` as the runtime projection. Manifest-migration story per `spec/semantics/objects.md §4.2`.
- mid-RPC origin-host crash drops the awaiting task: the v1 `awaiting_call` removal trades a real durability story for simplicity (`spec/semantics/tasks.md §16.3`). If a verb does many cross-host RPCs and the origin host evicts mid-flight, the in-memory task is lost. Revisit if the workload makes this hurt.
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

## structure

- spec/README.md, spec/vision.md, spec/dubspace-demo.md, spec/taskspace-demo.md exist alongside the layered spec — decide whether they roll into the spec layers or stay as author working docs.
- residual "DO" / "SQLite" mentions in some semantic sections (mostly in code-snippet context) still drift toward implementation; ok for now.
- maybe full event→observation rename (file, API names, wire op) — currently only a synonym note bridges core.md and events.md.

## spec gaps

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
- `chparent` orphan property values: drop vs preserve (currently dropping)
- per-value size cap: 256 KiB (proposal)
- strict vs dynamic verb compile: dynamic for v1; opt-in strict later

## ops / infra

- empirical validation that suspend-across-hibernate actually works for 24h+ on CF
- wizard audit log (`WizAudit` DO): bypass events, set_verb_code on others' objects, set_quota overrides
- DSL grammar (EBNF) — once parser is stable
- real cost numbers in `spec/reference/cloudflare.md` once the implementation exists
- real-time approximation for quota accounting via per-DO delta pushes

## first demo

The current direction is the dubspace sketch in [spec/dubspace-demo.md](spec/dubspace-demo.md): a shared persistent control surface for live sound gestures. It exercises the actor + log + emit/subscribe core without taking on cross-host migration depth, long-suspend tasks, or streamed media. A taskspace demo in [spec/taskspace-demo.md](spec/taskspace-demo.md) exercises async coordination for people and agents. A chat-shaped follow-up demo would later exercise the cross-host verb-dispatch and inheritance machinery the dubspace deliberately avoids.

## tools

- ollama serve (memory provider unavailable in current sessions)
