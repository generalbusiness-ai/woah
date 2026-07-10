# woah — specification

Programmable persistent objects, single-parent inheritance, modernized types, structured event messaging. A globally distributed successor to LambdaMOO. Cross-operator federation is reserved for v2.

> Status: varies.  Some parts are implemented.  Others are draft.
> If the spec says "implemented", it becomes the reference for behavior.
> When developing, keep the spec aligned with the actual implementation.
> Section numbers in headers are stable references for conversation.

---

## 1. Vision

**woah** is a multi-user, persistent, programmable world. It is a modern successor to LambdaMOO: it preserves the expressive object/verb/room/player model while reconsidering the architecture, interfaces, safety model, and social expectations for a contemporary networked environment. Every object is independently addressable and stateful. Users (human or agent) connect over websockets, inhabit a player object, and interact by emitting events and invoking verbs on other objects. Objects can be edited and reprogrammed at runtime by sufficiently privileged users; all code is sandboxed in a custom bytecode VM with tick metering and per-task memory caps.

The system is **globally distributed** in the production profile. Every object is its own actor, hosted at the edge, with no single process or node carrying the whole world. v1 runs within one vendor's namespace per deployment. Cross-operator federation (the broader sense of "decentralized") is designed but deferred to v2.

## 1.1 Deployment modes

woah has three runtime modes:

- **In-memory (development/testing only).** Fast boot, no persistence guarantees, and no required cross-environment promotion workflow.
- **Local SQLite (testing and small self-contained deployments).** Durable process-local storage, simpler operations, and single-environment lifecycle.
- **Cloudflare (production).** Distributed host-per-object deployment with full identity flows, and the only mode that requires a dev/staging/prod pipeline and inter-environment promotion.

For concrete deployment procedures for operators (including Cloudflare account setup and upgrade checks), use [DEPLOY.md](DEPLOY.md). Deployment lifecycle and environment behavior are specified in [spec/operations/deployments.md](spec/operations/deployments.md) and [spec/reference/cloudflare.md §R14](spec/reference/cloudflare.md#r14-deploying-your-own-world).

The system is **infrastructure, not UI**. The chat-text interface is one renderer. The wire protocol is structured events. Browser-hosted "transient" objects participate in the same execution model as server-hosted persistent ones.

The specification should be clear enough that independent implementations can be tested against it. Early implementation sketches are evidence and reference material, not substitutes for the normative spec.

---

## 2. Concepts and terminology

| Term | Meaning |
|---|---|
| **Object** | A persistent, individually addressable entity. Holds properties, verbs, location, parent, owner. |
| **Persistent object** | Server-hosted; one persistent host per woah object. Identifier prefix `#`. |
| **Transient object** | Client-hosted (typically browser); lifetime bounded by the connection. Identifier prefix `~`. |
| **Verb** | Callable code attached to an object. Dispatched by name through the standard lookup rule: parent chain, then feature lookup where applicable. |
| **Property** | Named slot on an object. *Defined* on an ancestor (with default + perms); *value* per object. |
| **Player** | An object that has an attached client connection. Just an object, not a separate type. |
| **Task** (VM) | A serializable activation stack; the unit of execution. Migrates between hosts on verb dispatch. Also called a *VM activation* when distinguishing from a task registry's work-item "task" (see `catalogs/tasks/DESIGN.md`). |
| **Host** | Anything that can run a VM: an edge worker, a persistent host, or a transient host. |
| **Event** / **Observation** | A structured map (`{type, ...}`) emitted from one object to one or more listeners. The two terms are synonyms: `core.md` says "observation" to distinguish from messages and mutations; `events.md` and the wire/API say "event" by historical naming. |
| **Renderer** | Code that turns events into a presentation. Usually a transient object. |
| **Wizard** | A flag on an object granting elevated permissions. |

---

## Layers

The spec is split into layers. Implementation references in semantics and protocol layers are explicit pointers to reference profiles; you can read semantics + protocol for all runtimes without committing to Cloudflare.

| Path | Layer | Contents |
|---|---|---|
| [spec/semantics/](spec/semantics/) | **semantics** | Language and object model. Implementation-neutral. |
| [spec/protocol/](spec/protocol/) | **protocol** | Host classes, wire format, browser bootstrap. |
| [spec/reference/](spec/reference/) | **reference** | Concrete Cloudflare mapping. v1 only. |
| [spec/deferred/](spec/deferred/) | **deferred** | Not in v1. Federation, capabilities, audio. |

### Semantics

Language and runtime foundations: object/verb/value semantics and execution behavior independent of host implementation.

- [core.md](spec/semantics/core.md) — woah core: objects, messages, spaces, actors, observations
- [distribution.md](spec/semantics/distribution.md) — Execute/Sequence/Hold roles; turn scope vs object host; sequencer keyed by scope ObjRef; cell version is freshness; no node owns objects (DT1–DT8, **implemented core**; DT3 partial)
- [projection-cache.md](spec/semantics/projection-cache.md) — accepted-frame projection rows, row-body-complete fanout, tool-surface rows, and session tool manifests (PC1–PC4, **draft**)
- [values.md](spec/semantics/values.md) — value contract, equality, canonical serialization (V1–V11)
- [objects.md](spec/semantics/objects.md) — object model, identity, verb dispatch, properties (§4, §5, §9, §10)
- [sequenced-log.md](spec/semantics/sequenced-log.md) — `$sequenced_log` primitive: atomic seq allocation, durable append-only log (SL1–SL10)
- [space.md](spec/semantics/space.md) — `$space` (a `$sequenced_log` subclass): call lifecycle, failure rules, snapshots (S1–S10)
- [identity.md](spec/semantics/identity.md) — actor, session, auth lifecycle (I1–I8)
- [bootstrap.md](spec/semantics/bootstrap.md) — seed object graph: universal classes plus bundled local-catalog bootstrapping (B1–B9)
- [introspection.md](spec/semantics/introspection.md) — `:describe()` convention and discovery surface (N1–N6)
- [language.md](spec/semantics/language.md) — types, DSL syntax (§6, §7)
- [vm.md](spec/semantics/vm.md) — bytecode, opcodes, scheduling, metering (§8)
- [tiny-vm.md](spec/semantics/tiny-vm.md) — T0 VM subset for early fixtures
- [permissions.md](spec/semantics/permissions.md) — perms, wizard, trust, quotas (§11)
- [events.md](spec/semantics/events.md) — emit, schemas (§12, §13)
- [tasks.md](spec/semantics/tasks.md) — lifecycle, suspend, fork, read (§16)
- [builtins.md](spec/semantics/builtins.md) — builtins, errors (§19, §20)
- [recycle.md](spec/semantics/recycle.md) — `recycle()` semantics: cleanup, handlers, dangling refs (RC1–RC9)
- [moveto.md](spec/semantics/moveto.md) — receiver-driven container moves with acceptable/enter/exit hooks (M1–M10, **implemented core**)
- [match.md](spec/semantics/match.md) — `$match` scaffolding for chat-shaped text → object/verb resolution (MA1–MA7)
- [features.md](spec/semantics/features.md) — feature objects: composition without multiple inheritance (FT1–FT10)
- [text-format.md](spec/semantics/text-format.md) — `.format` property convention for markdown / plain text content (TF1–TF10)
- [failures.md](spec/semantics/failures.md) — consolidated failure model (F1–F11)

### Protocol

Host-facing interfaces for runtime execution, transport, and client bootstrap across local and edge hosts.

- [coherence.md](spec/protocol/coherence.md) — **the coherence layer**: normative contract for the `src/net/` distribution layer (Plan 002) — invariants, effect transcript, validation order, named-copy registry, divergence taxonomy, SLOs, conformance gates, relations, sessions, topology, scheduled-turn execution (CO1–CO16, **adopted**; governs where it overlaps v2-turn-network.md / cell-authority.md)
- [hosts.md](spec/protocol/hosts.md) — three host classes, task migration, trust boundaries (§3)
- [host-seeds.md](spec/protocol/host-seeds.md) — host-seed contents and the per-subject merge rule for cross-host reconciliation (HS1–HS5, **draft**)
- [wire.md](spec/protocol/wire.md) — JSON WebSocket message format (§17)
- [rest.md](spec/protocol/rest.md) — HTTP+SSE REST API; six endpoints; `$me` (R1–R11)
- [mcp.md](spec/protocol/mcp.md) — Model Context Protocol surface for LLM agents; dynamic per-location tools (M1–M8)
- [browser-host.md](spec/protocol/browser-host.md) — transient host bootstrap (§18)
- [routing.md](spec/protocol/routing.md) — `/objects/<id>` URL form, class-driven renderer dispatch, browser navigation vs MCP focus, `:locate()` / `:open_in_<view>()` verb conventions (AR1–AR13)
- [ui-component-model.md](spec/protocol/ui-component-model.md) — client UI framework: catalog-owned browser modules, Web Component ABI, declarative frames, scoped neighborhoods, frame composition, consistent client projection, and observation normalization (UCM1–UCM30, **draft**)
- [v2-turn-network.md](spec/protocol/v2-turn-network.md) — draft v2 node-network protocol: deterministic VM turns, commit scopes, execution capability gossip, state transfer, live events, in-browser nodes, and scope-local scheduled turns (VTN1-VTN18, **draft**; carried parts superseded by coherence.md)
- [cell-authority.md](spec/protocol/cell-authority.md) — first-class cell authority, movement as `live:location` truth with per-member contents projection, hot-room scalability, and authority migration toward activity; supersedes VTN8.1 MV-A (CA1-CA16, **draft**; carried parts superseded by coherence.md)

### Reference (Cloudflare)

Concrete Cloudflare mappings for a v1 deployment target: storage, routing, quotas, and production constraints.

- [cloudflare.md](spec/reference/cloudflare.md) — host-class mapping, routing, hibernation (R1–R4)
- [persistence.md](spec/reference/persistence.md) — per-object SQLite schema, caching (§14, §15)
- [quotas.md](spec/reference/quotas.md) — QuotaAccountant DO (R5)

### Operations

Operationally visible procedures for lifecycle management: deploys, migrations, backups, and governance.

- [worktrees.md](spec/operations/worktrees.md) — staging changes, sandboxes, atomic promote (W1–W13)
- [migrations.md](spec/operations/migrations.md) — bytecode upgrades, schema changes, data migrations (M1–M9). Covers two of five migration kinds; for the decision tree across all of them see [AGENTS.md §Migrations](AGENTS.md#migrations).
- [backups.md](spec/operations/backups.md) — world export format, restore, disaster recovery (B1–B8)
- [deployments.md](spec/operations/deployments.md) — dev / staging / prod, version coordination, cross-environment sync (DP1–DP9)
- [observability.md](spec/operations/observability.md) — logs, metrics, traces, audit (O1–O9)
- [workflows.md](spec/operations/workflows.md) — state machines on `$space`s; role gating; transition rules (WF1–WF10)
- [net-cutover.md](spec/operations/net-cutover.md) — net namespace installation, activation barrier, write-freeze/export watermark, rollback contract (NC1–NC8)

### Identity

Trust and actor-governance contracts for authentication, teams, capabilities, and access boundaries.

- [auth.md](spec/identity/auth.md) — credentialed auth, account vs actor, multi-character, recovery, service accounts (A1–A11)
- [teams.md](spec/identity/teams.md) — team membership, role-based gating, team quotas, service accounts (TM1–TM10)
- [provisioning.md](spec/identity/provisioning.md) — human signup with humanness gate, in-world agent provisioning with per-account quota, Hermes deep-link onboarding, audited `$system` primitives (AP1–AP10)

### Discovery

Catalog authoring, installation, and migration behavior across worlds.

- [catalogs.md](spec/discovery/catalogs.md) — GitHub-tap-then-install model; sequenced installs through `$catalog_registry`; per-catalog tool manifests; authority and ownership; migration contract (CT1–CT14)

### Tooling

Diagnostics and verification surfaces for runtime behavior, testing, and operator workflows.

- [debugging.md](spec/tooling/debugging.md) — stepping, breakpoints, replay debugging in a sandbox (D1–D10)
- [conformance.md](spec/tooling/conformance.md) — behavioral test corpus (CF1–CF9)

### Authoring

Tools and in-world interfaces for making woah programmable by people and agents.

- [minimal-ide.md](spec/authoring/minimal-ide.md) — first Web IDE and authoring primitives (A1–A11)
- [editor-rooms.md](spec/authoring/editor-rooms.md) — LambdaCore-style editor rooms for collaborative in-world authoring (E1–E8)

### Catalogs

Normative class designs for bundled-catalog content that ships with this repo. These are class-level specs (verb shapes, perms, observation contracts) for individual catalog classes whose design is worth pinning across catalog versions; the catalog *install* contract lives in [discovery/catalogs.md](spec/discovery/catalogs.md).

- [persistent-conversation.md](spec/catalogs/persistent-conversation.md) — `$conversational` and `$persistent_conversational` as composable current-space chat features; `$chatroom` / `$persistent_chatroom` convenience classes; replay-derived `:history()` and public-only persistent transcripts (PC1–PC15)
- [channels.md](spec/catalogs/channels.md) — `$channel` hierarchy (`$dm_channel`, `$group_channel`, `$public_channel`); deterministic-corename DM uniqueness; per-member `joined_seq`; one-way promotion (dm → group → public) with sequenced log preserved (CH1–CH14, **draft**)

### Deferred

Designs intentionally deferred from v1 that reserve compatibility for later operator capabilities.

- [federation.md](spec/deferred/federation.md) — full cross-world interop design (§24)
- [federation-early.md](spec/deferred/federation-early.md) — earliest-buildable v2 subset: mTLS peers, cross-world calls gated by verb annotation (FE1–FE11)

---

See [LATER.md](LATER.md) for the informal todo list — open items, sketches, gaps, decisions still pending. Not commitments.

For what is *currently built* (as opposed to what the spec is building toward), see the implementation snapshots in [`notes/`](notes/). The current cut is documented in [notes/2026-04-29-impl-v0.5-rich-vm-persistence-compiler.md](notes/2026-04-29-impl-v0.5-rich-vm-persistence-compiler.md); older snapshots are historical.

Loose docs alongside the spec layers and bundled catalogs:
- [spec/README.md](spec/README.md) — author's working docs.
- Catalog-owned design docs for bundled catalogs (see [spec/discovery/catalogs.md §CT15](spec/discovery/catalogs.md#ct15-bundled-catalogs-in-this-repo) for the role of each):
  - **Foundational utilities** — [help](catalogs/help/DESIGN.md), [chat](catalogs/chat/DESIGN.md), [note](catalogs/note/DESIGN.md), [prog](catalogs/prog/DESIGN.md).
  - **Demo seed** — [demoworld](catalogs/demoworld/DESIGN.md).
  - **Demo applications** — [dubspace](catalogs/dubspace/DESIGN.md), [tasks](catalogs/tasks/DESIGN.md), [pinboard](catalogs/pinboard/DESIGN.md), [outliner](catalogs/outliner/DESIGN.md).
