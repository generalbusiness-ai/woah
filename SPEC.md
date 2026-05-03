# woo — specification

Programmable persistent objects, single-parent inheritance, modernized types, structured event messaging. A globally distributed successor to LambdaMOO. v1 runs on a single machine or a single vendor's edge (Cloudflare); cross-operator federation is reserved for v2.

> Status: working draft. Section numbers in headers are stable references for conversation.

---

## 1. Vision

**woo** is a multi-user, persistent, programmable world. Every object is independently addressable and stateful. Users (human or agent) connect over websockets, inhabit a player object, and interact by emitting events and invoking verbs on other objects. Objects can be edited and reprogrammed at runtime by sufficiently privileged users; all code is sandboxed in a custom bytecode VM with tick metering and per-task memory caps.

The system is **globally distributed** — every object is its own actor, hosted at the edge, with no single process or node carrying the whole world. v1 runs within one vendor's namespace. Cross-operator federation (the broader sense of "decentralized") is designed but deferred to v2.

The system is **infrastructure, not UI**. The chat-text interface is one renderer. The wire protocol is structured events. Browser-hosted "transient" objects participate in the same execution model as server-hosted persistent ones.

---

## 2. Concepts and terminology

| Term | Meaning |
|---|---|
| **Object** | A persistent, individually addressable entity. Holds properties, verbs, location, parent, owner. |
| **Persistent object** | Server-hosted; one persistent host per woo object. Identifier prefix `#`. |
| **Transient object** | Client-hosted (typically browser); lifetime bounded by the connection. Identifier prefix `~`. |
| **Verb** | Callable code attached to an object. Dispatched by name through the standard lookup rule: parent chain, then feature lookup where applicable. |
| **Property** | Named slot on an object. *Defined* on an ancestor (with default + perms); *value* per object. |
| **Player** | An object that has an attached client connection. Just an object, not a separate type. |
| **Task** (VM) | A serializable activation stack; the unit of execution. Migrates between hosts on verb dispatch. Also called a *VM activation* when distinguishing from a taskspace's work-item "task" (see `catalogs/taskspace/DESIGN.md`). |
| **Host** | Anything that can run a VM: an edge worker, a persistent host, or a transient host. |
| **Event** / **Observation** | A structured map (`{type, ...}`) emitted from one object to one or more listeners. The two terms are synonyms: `core.md` says "observation" to distinguish from messages and mutations; `events.md` and the wire/API say "event" by historical naming. |
| **Renderer** | Code that turns events into a presentation. Usually a transient object. |
| **Wizard** | A flag on an object granting elevated permissions. |

---

## Profiles

Spec scope is organized into four progressive profiles. See [profiles.md](spec/profiles.md) for the per-doc map.

| Profile | Scope | Status |
|---|---|---|
| **first-light** | Runnable dubspace + taskspace demos, minimal IDE, local dev runtime; T0 fixtures plus v0.5 VM/persistence slices | reference impl in `src/` (v0.5 local; not a v1-core claim) |
| **v1-core** | Full semantics + protocol + Cloudflare reference; durable, multi-actor, recoverable | spec ready; impl partial |
| **v1-ops** | Worktrees, migrations, backups, deployments, observability, debugging, teams, credentialed auth, catalogs, conformance | spec ready |
| **v2-federation** | Cross-world calls (mTLS), peer trust, federated identity | reserved; designs in `spec/deferred/` |

Each profile is a superset of the one above.

## Layers

The spec is split into layers, mostly orthogonal to profiles. Implementation references in semantics and protocol layers are explicit pointers to reference; you can read semantics + protocol without committing to Cloudflare.

| Path | Layer | Contents |
|---|---|---|
| [spec/semantics/](spec/semantics/) | **semantics** | Language and object model. Implementation-neutral. |
| [spec/protocol/](spec/protocol/) | **protocol** | Host classes, wire format, browser bootstrap. |
| [spec/reference/](spec/reference/) | **reference** | Concrete Cloudflare mapping. v1 only. |
| [spec/deferred/](spec/deferred/) | **deferred** | Not in v1. Federation, capabilities, audio. |

### Semantics
- [core.md](spec/semantics/core.md) — woo-core: objects, messages, spaces, actors, observations
- [values.md](spec/semantics/values.md) — value contract, equality, canonical serialization (V1–V11)
- [objects.md](spec/semantics/objects.md) — object model, identity, verb dispatch, properties (§4, §5, §9, §10)
- [sequenced-log.md](spec/semantics/sequenced-log.md) — `$sequenced_log` primitive: atomic seq allocation, durable append-only log (SL1–SL10)
- [space.md](spec/semantics/space.md) — `$space` (a `$sequenced_log` subclass): call lifecycle, failure rules, snapshots (S1–S10)
- [identity.md](spec/semantics/identity.md) — actor, session, auth lifecycle (I1–I8)
- [bootstrap.md](spec/semantics/bootstrap.md) — seed object graph: universal classes plus first-light local-catalog bootstrapping (B1–B9)
- [introspection.md](spec/semantics/introspection.md) — `:describe()` convention and discovery surface (N1–N6)
- [language.md](spec/semantics/language.md) — types, DSL syntax (§6, §7)
- [vm.md](spec/semantics/vm.md) — bytecode, opcodes, scheduling, metering (§8)
- [tiny-vm.md](spec/semantics/tiny-vm.md) — T0 VM profile for the first demo, with concrete fixtures
- [permissions.md](spec/semantics/permissions.md) — perms, wizard, trust, quotas (§11)
- [events.md](spec/semantics/events.md) — emit, schemas (§12, §13)
- [tasks.md](spec/semantics/tasks.md) — lifecycle, suspend, fork, read (§16)
- [builtins.md](spec/semantics/builtins.md) — builtins, errors (§19, §20)
- [recycle.md](spec/semantics/recycle.md) — `recycle()` semantics: cleanup, handlers, dangling refs (RC1–RC9)
- [moveto.md](spec/semantics/moveto.md) — receiver-driven container moves with acceptable/enter/exit hooks (M1–M10)
- [match.md](spec/semantics/match.md) — `$match` scaffolding for chat-shaped text → object/verb resolution (MA1–MA7)
- [features.md](spec/semantics/features.md) — feature objects: composition without multiple inheritance (FT1–FT10)
- [failures.md](spec/semantics/failures.md) — consolidated failure model (F1–F11)

### Protocol
- [hosts.md](spec/protocol/hosts.md) — three host classes, task migration, trust boundaries (§3)
- [wire.md](spec/protocol/wire.md) — JSON WebSocket message format (§17)
- [rest.md](spec/protocol/rest.md) — HTTP+SSE REST API; six endpoints; `$me` (R1–R11)
- [mcp.md](spec/protocol/mcp.md) — Model Context Protocol surface for LLM agents; dynamic per-location tools (M1–M8)
- [browser-host.md](spec/protocol/browser-host.md) — transient host bootstrap (§18)

### Reference (Cloudflare)
- [cloudflare.md](spec/reference/cloudflare.md) — host-class mapping, routing, hibernation (R1–R4)
- [persistence.md](spec/reference/persistence.md) — per-object SQLite schema, caching (§14, §15)
- [quotas.md](spec/reference/quotas.md) — QuotaAccountant DO (R5)

### Operations
- [worktrees.md](spec/operations/worktrees.md) — staging changes, sandboxes, atomic promote (W1–W13)
- [migrations.md](spec/operations/migrations.md) — bytecode upgrades, schema changes, data migrations (M1–M9)
- [backups.md](spec/operations/backups.md) — world export format, restore, disaster recovery (B1–B8)
- [deployments.md](spec/operations/deployments.md) — dev / staging / prod, version coordination, cross-environment sync (DP1–DP9)
- [observability.md](spec/operations/observability.md) — logs, metrics, traces, audit (O1–O9)
- [workflows.md](spec/operations/workflows.md) — state machines on `$space`s; role gating; transition rules (WF1–WF10)

### Identity
- [auth.md](spec/identity/auth.md) — credentialed auth, account vs actor, multi-character, recovery, service accounts (A1–A11)
- [teams.md](spec/identity/teams.md) — team membership, role-based gating, team quotas, service accounts (TM1–TM10)
- [provisioning.md](spec/identity/provisioning.md) — actor creation, class assignment, capability granting, directory sync (AP1–AP7) — **placeholder**

### Discovery
- [catalogs.md](spec/discovery/catalogs.md) — GitHub-tap-then-install model; sequenced installs through `$catalog_registry`; per-catalog tool manifests; authority and ownership; migration contract (CT1–CT14)

### Tooling
- [debugging.md](spec/tooling/debugging.md) — stepping, breakpoints, replay debugging in a sandbox (D1–D10)
- [conformance.md](spec/tooling/conformance.md) — behavioral test corpus (CF1–CF9)

### Authoring
- [minimal-ide.md](spec/authoring/minimal-ide.md) — first Web IDE and authoring primitives (A1–A11)
- [editor-rooms.md](spec/authoring/editor-rooms.md) — LambdaCore-style editor rooms for collaborative in-world authoring (E1–E8)

### Deferred
- [federation.md](spec/deferred/federation.md) — full cross-world interop design (§24)
- [federation-early.md](spec/deferred/federation-early.md) — earliest-buildable v2 subset: mTLS peers, cross-world calls gated by verb annotation (FE1–FE11)

---

See [LATER.md](LATER.md) for the informal todo list — open items, sketches, gaps, decisions still pending. Not commitments.

For what is *currently built* (as opposed to what the spec is building toward), see the implementation snapshots in [`notes/`](notes/). The current cut is documented in [notes/impl-v0.5-rich-vm-persistence-compiler.md](notes/impl-v0.5-rich-vm-persistence-compiler.md); the older [notes/impl-v0-first-light.md](notes/impl-v0-first-light.md) is historical. Current debt and spec/impl drift is in [TECH_DEBT_AUDIT.md](TECH_DEBT_AUDIT.md).

Loose docs alongside the spec layers and bundled catalogs:
- [spec/vision.md](spec/vision.md), [spec/README.md](spec/README.md) — author's working docs.
- [catalogs/chat/DESIGN.md](catalogs/chat/DESIGN.md), [catalogs/dubspace/DESIGN.md](catalogs/dubspace/DESIGN.md), [catalogs/help/DESIGN.md](catalogs/help/DESIGN.md), [catalogs/pinboard/DESIGN.md](catalogs/pinboard/DESIGN.md), [catalogs/taskspace/DESIGN.md](catalogs/taskspace/DESIGN.md) — catalog-owned design docs (what each bundled catalog provides; first-light profile).
