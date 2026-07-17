---
date: 2026-05-04
status: draft
---

# Client UI framework

> Part of the [woo specification](../../SPEC.md). Layer: **protocol**.

Catalog-owned browser UI for woo objects: how catalogs declare executable
client modules, how those modules register components, how the browser
assembles object-specific frames, and how observations flow from the wire into
component-local rendering.

This document builds on object addressing in [routing.md](routing.md),
browser transport in [browser-host.md](browser-host.md), catalog installation
in [discovery/catalogs.md](../discovery/catalogs.md), and the object model in
[semantics/objects.md](../semantics/objects.md).

---

## UCM1. Scope and status

This is a **draft** design for the browser client framework. An initial
implementation slice exists in `src/client/framework.ts`: catalog UI
registration, frame resolution, frame-local state/actions, observation
normalization, scoped snapshot ingestion, projection subscriptions, consistent
projection layers, and call-bound optimistic reconciliation. The bundled chat,
dubspace, pinboard, and tasks surfaces now mount catalog-shipped custom
elements; the host client still supplies transport, audio, routing, and gesture
service adapters while the frame-action layer matures.

The model has six goals:

- Let catalogs ship the UI code for the objects they define.
- Be honest about where the model lives: the woo world is the model; catalog
  UI is view plus thin controller. See [UCM4](#ucm4-the-server-is-the-model).
- Keep frame assembly declarative enough that object navigation, embedding,
  and fallback rendering are discoverable.
- Route observations through a principled local bus instead of global
  type-specific client branches.
- Use a stable browser-native ABI rather than binding the world to one SPA
  framework.
- Be honest about trust: executable catalog UI is trusted client code, not
  sandboxed user content.

The substrate remains UI-agnostic. UI declarations do not change object
semantics, verb dispatch, property permissions, server-side observation
delivery, or storage rules. They define how one browser client presents
objects and dispatches already-delivered observations to components.

---

## UCM2. Terms

| Term | Meaning |
|---|---|
| **UI module** | An ECMAScript module shipped by a catalog and loaded by the browser client. |
| **UI component** | A manifest-declared custom element implemented by a UI module. |
| **Component id** | Stable catalog-qualified identifier such as `pinboard.board` or `core.presence`. |
| **Tag name** | Browser custom element name such as `woo-pinboard-board`. |
| **Frame** | Declarative tree of regions and component nodes chosen for a subject object. |
| **Frame controller** | Host-provided handler that resolves UI actions emitted by components in a mounted frame. Defined in [UCM16](#ucm16-frame-state-and-ui-actions). |
| **Region** | Named slot in a frame layout: `main`, `presence`, `chat`, `inspector`, `overlay`, etc. |
| **Surface** | Reusable rendering role for an object, such as `main`, `presence`, `chat`, `detail`, `item`, or `item-list`. |
| **Subject** | The woo object being rendered by a component node. |
| **Item renderer** | Container-scoped rule selecting a component for an object contained in, referenced by, or otherwise presented inside another object. |
| **Delivered observation** | Wire-level observation after server-side audience filtering, carried by `op:"applied"` or `op:"event"`. |
| **Observation envelope** | Browser-normalized wrapper around a delivered observation, with route, subject, surface, and sequencing metadata. |
| **Observation handler** | Catalog-provided trusted client code that extracts observation subjects/surfaces and may project the observation into client state. |
| **Observation bus** | Browser-local dispatch surface that components subscribe to by subject, surface, type, and route. |
| **Client projection** | Framework-owned merged view of a component neighborhood, combining canonical snapshots, sequenced observation reducers, pending optimistic patches, and live previews. |
| **Neighborhood** | The bounded set of object refs a component may observe from the client projection. Derived from the frame node, the component declaration, and host policy. |
| **Frame state** | Browser-local key/value state owned by one mounted frame, used for selection, focus, pane state, and other UI facts that are neither world state nor observation payloads. |
| **UI action** | Component-emitted request to the frame controller, such as selecting an object, setting frame state, focusing a pane, navigating, or starting a drag/drop operation. |
| **Optimistic patch** | Component-requested temporary projection update tied to a call id or gesture stream and reconciled by the framework. |
| **Woo UI ABI** | The browser-side contract between the host client and catalog UI modules. |

The word **subject** appears in three related positions:

- on a component declaration, `subject` is a constraint describing what the
  component is meant to render;
- on a frame declaration, `subject` is the object/class selection key for
  choosing that frame;
- on a frame node, `subject` is an expression that resolves to the concrete
  object passed to the mounted component.

---

## UCM3. Design center

Woo catalogs are allowed to contain executable UI code. A catalog may define
objects, verbs, properties, seed hooks, agent tools, and browser UI in one
versioned package.

The browser ABI is **custom elements**. Catalog components are ordinary Web
Components registered with `customElements.define()`. The v1 first-party
components use vanilla custom elements; Lit or another framework is valid if
the component obeys this spec's runtime contract.

The host client owns:

- routing and frame resolution,
- module loading and integrity checks,
- consistent client projection, observation normalization, and bus dispatch,
- component lifecycle and context injection,
- transport to the woo world,
- fallback rendering when UI is missing or fails.

The catalog owns:

- UI module source,
- custom element implementation,
- component declarations,
- frame declarations for its classes or seed instances,
- observation handlers for its emitted observation types,
- item-renderer rules for container-specific presentation.

---

## UCM4. The server is the model

The woo world is the application model. Woocode-defined classes, verbs,
properties, persisted object state, sequenced logs, and server-emitted
observations are the durable facts of the system.

Catalog UI components are views plus thin controllers:

- views render the framework projection of objects in their declared
  neighborhood;
- controllers issue verb calls, direct calls, text commands, or UI actions;
- all durable domain mutations go through server verbs;
- projection reducers materialize server-derived state for latency and
  continuity, not client-original state.

The test for projection state is replay: if the world reset to a snapshot and
replayed the same sequenced observations, the projection value should
reproduce. Values that would not reproduce belong in component-local UI state,
frame-local UI state, or live-preview state with an explicit TTL. They do not
belong in the canonical or sequenced projection layers.

Components MUST NOT directly manipulate projection state. The only temporary
client-side mutation path is a framework-owned optimistic patch or live preview
as defined in [UCM21](#ucm21-consistent-client-projection). Those patches are
reconciled, superseded, or expired by the framework.

Frame-local state is for UI facts: which pane is focused, whether an inspector
is collapsed, which item is highlighted for a transient drag operation, or
which overlay is open. Frame-local state is not for durable domain facts. A
"selected pin for editing" may be frame-local only if it is explicitly
ephemeral UI state; if selection matters to other actors, persists across
sessions, or affects server behavior, it belongs on the server.

Anti-patterns:

- keeping a separate sorted pin list in a component because the server order is
  inconvenient;
- caching rendered HTML or object-shaped data in a client store and treating it
  as authoritative;
- shadowing `actor.focus_list`, room presence, deck routing, or task selection
  in frame state when those facts are meant to be shared or persistent;
- deriving a parallel domain model from browser-only inputs and then allowing
  server state to lag behind it.

Client-derived values are allowed when they are explicitly presentation data.
For example, a beat-matcher component may render BPMs computed from server
properties as a pure view. If it derives BPMs from browser-only audio analysis,
that value is ephemeral live-preview or component-local state until a verb call
stores it in the world.

Private per-actor streams, such as headphone cue data, remain server-modeled:
the server routes directed observations to the actor, and UI handlers project
them only into that actor's scoped component neighborhoods.

---

## UCM5. Trust model

Executable catalog UI is trusted client code. It runs in the same JavaScript
realm as the woo browser client unless a future sandbox profile explicitly
changes that.

Consequences:

- Installing or enabling a catalog that contains UI modules is wizard-only.
- Side-loaded GitHub catalogs without signatures are allowed for wizard and
  development workflows.
- A UI module can read any client state exposed to loaded UI, make network
  requests allowed by browser policy, and initiate calls as the connected
  actor through the provided client context.
- Server-side permissions remain authoritative for server state. Client UI
  code must not be trusted to enforce object permissions.
- Catalog UI should be pinned by content hash at install/update time so the
  loaded code is reproducible; see [UCM7](#ucm7-ui-modules).

This is a trust boundary, not a sandbox boundary: "do not load catalogs you do
not trust" is the v1 rule. Future signature or capability systems may add
provenance and finer-grained authority, but they are not prerequisites for
this model.

---

## UCM6. Manifest extension

A catalog manifest MAY include a top-level `ui` object.

```json
{
  "ui": {
    "abi": "woo-ui/v1",
    "modules": [
      {
        "id": "pinboard-ui",
        "entry": "ui/pinboard.js",
        "sha256": "sha256:0123..."
      }
    ],
    "components": [
      {
        "id": "pinboard.board",
        "module": "pinboard-ui",
        "tag": "woo-pinboard-board",
        "surface": "main",
        "subject": "$pinboard",
        "neighborhood": {
          "include": ["subject", "contents", "subscribers"]
        }
      },
      {
        "id": "pinboard.presence",
        "module": "pinboard-ui",
        "tag": "woo-pinboard-presence",
        "surface": "presence",
        "subject": "$pinboard"
      }
    ],
    "frames": [
      {
        "id": "pinboard.workspace",
        "subject": "$pinboard",
        "view": "default",
        "layout": "space-workspace",
        "hydration": { "module": "pinboard-ui", "id": "board" },
        "regions": {
          "main": [
            {
              "component": "pinboard.board",
              "subject": "this",
              "state": ["selected_pin"]
            }
          ],
          "presence": [{ "component": "pinboard.presence", "subject": "this" }],
          "chat": [{ "component": "chat.space", "subject": "this" }],
          "inspector": [
            {
              "component": "core.object-detail",
              "subject": { "frame_state": "selected_pin" },
              "when": { "frame_state": "selected_pin" }
            }
          ]
        }
      }
    ],
    "item_renderers": [
      {
        "container": "$pinboard",
        "match": { "is_a": "note:$note" },
        "component": "pinboard.note-card"
      }
    ],
    "observation_handlers": [
      {
        "module": "pinboard-ui",
        "types": ["note_added", "note_edited", "pin_moved", "pin_resized"]
      }
    ],
    "chat_formatters": [
      {
        "module": "pinboard-ui",
        "types": ["pinboard_entered", "pinboard_left", "pinboard_activity"]
      }
    ]
  }
}
```

The `ui.abi` field is required when `ui` is present. Clients that do not
support the declared ABI MUST ignore the catalog's UI declarations and use
fallback rendering.

`ui.observation_handlers[]` declares which modules contain observation handler
registration for the listed types. Each entry has:

| Field | Required | Meaning |
|---|---|---|
| `module` | yes | `ui.modules[].id` exporting `registerWooObservationHandlers()`. |
| `types` | yes | Observation `type` strings the module handles. |

The type list is an install-time and preload hint. The module's registration
hook is still the normative source of handler behavior.

`ui.chat_formatters[]` declares which modules contribute chat-display
formatting for observations the catalog emits. Same shape as
`observation_handlers`: each entry names a module and the observation
types it formats. The host uses the type list at install time to decide
whether an observation is chat-eligible (so it can route the event to
the chat panel before invoking any code) and dispatches the formatter
when rendering the line.

The formatter contract:

```ts
type ChatFormatterContext = {
  // Resolve a subject id to its display label.
  label(id: string | undefined): string;
  // The viewing actor's id (or undefined). Lets formatters distinguish
  // doer-vs-bystander views (e.g. note_read shows the body to the
  // reader and a short line to others).
  viewer: string | undefined;
};

type ChatFormatterResult = {
  kind?: string;     // ChatLine.kind for rendering
  text?: string;     // override for the rendered line
  actor?: string;
  style?: string;
  reason?: string;
};

type ChatFormatter = {
  types: readonly string[];
  format: (
    observation: Record<string, unknown>,
    ctx: ChatFormatterContext
  ) => ChatFormatterResult | undefined;
};
```

`ui.frames[].hydration` optionally declares a catalog-owned cold-view read.
`module` names a `ui.modules[]` entry and `id` is local to that module. The
module MUST register the same id through `registerWooViewHydrations()` (UCM7).
The declaration belongs to the frame rather than a client tab: any host that
resolves that frame can run the same semantic hydration without recognizing a
catalog alias, command word, or catalog-specific projection shape.
When a host has selected a manifest-declared component but a sparse remote
projection does not yet carry enough subject lineage to repeat frame matching,
the host MUST use the default frame in that component's declaring catalog that
mounts the selected component. Rendering and hydration therefore use one
declaration; missing projection metadata cannot silently suppress the cold read.

Returning `undefined` means "this observation is not a chat line right
now"; the host drops it. Returning `{}` accepts the line with no
overrides, so kind defaults to the observation type and text falls back
to `observation.text`. Frame-level routing (presence updates,
self-suppression of doer-broadcasts) keys on `observation.type`, not on
the formatter-supplied `kind` — so a formatter changing `kind` for
display does not affect routing.

When multiple catalogs claim the same type, registration order wins;
registration order is install order, which matches manifest dependency
order. Override semantics are intentionally not part of this contract;
if a use case appears, an explicit priority field can be added later.

---

## UCM7. UI modules

Each `ui.modules[]` entry declares a loadable JavaScript module.

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Catalog-local module id. |
| `entry` | yes | Relative path inside the catalog package. |
| `sha256` | yes for remote/catalog-installed UI; optional for trusted local dev | Content hash of the fetched module artifact. |

Module paths are resolved relative to the installed catalog root. They MUST
NOT escape the catalog root.

The install/update path SHOULD fetch and pin UI module content alongside the
manifest. Browser clients SHOULD load the pinned artifact from the woo host by
catalog alias and digest, not from a mutable upstream URL at page-render time.

When a module is imported, it MUST register the custom element tags declared
for that module, or export a registration hook that the host calls before
mounting:

```ts
type WooComponentRegistry = {
  defineTag(tag: string, ctor: CustomElementConstructor): void;
};

export function registerWooComponents(registry: WooComponentRegistry): void;
```

The host validates the tag against the manifest's `components[]` declarations:
a registered tag MUST appear in this catalog's manifest, MUST not collide with
a tag from another loaded catalog (UCM8), and MUST resolve to a constructor
that extends `HTMLElement`. A client MAY also support pure side-effect modules
that call `customElements.define()` directly; the registration hook is
preferred because it gives the host a point for those checks.

A module MAY also export observation registration:

```ts
type WooObservationRegistry = {
  observation(handler: WooObservationHandler): void;
};

export function registerWooObservationHandlers(
  registry: WooObservationRegistry
): void;
```

`WooObservationHandler` is defined in [UCM20](#ucm20-observation-handlers-and-projection).
The host calls this hook before dispatching observations for component frames
that depend on the module, and MAY call it earlier during module preload.

A module MAY also export chat-formatter registration:

```ts
type ChatFormatterRegistry = {
  formatter(entry: ChatFormatter): void;
};

export function registerWooChatFormatters(
  registry: ChatFormatterRegistry
): void;
```

`ChatFormatter` is defined in UCM6 alongside the `chat_formatters`
manifest declaration. The host calls this hook at module load time so
chat-eligibility lookups for the declared types resolve as soon as
observations begin to flow.

A module MAY also implement a frame-declared cold-view hydration:

```ts
type WooViewHydrationContext = {
  subject: string;
  frameState: Readonly<Record<string, unknown>>;
  present: boolean;
  installedCatalogs: readonly unknown[];
  observe(ref: string): ObjectProjection | null;
  call(target: string, verb: string, args?: unknown[], options?: { serverRead?: boolean }): Promise<unknown>;
  readCell(key: string): Promise<unknown>;
  nameOf(ref: string): string;
};

type WooViewHydration = {
  complete(context: WooViewHydrationContext): boolean;
  read(context: WooViewHydrationContext): Promise<ProjectionPatch[]>;
};

export function registerWooViewHydrations(registry: {
  define(id: string, hydration: WooViewHydration): void;
}): void;
```

The catalog owns the read vocabulary, compatibility fallbacks, completeness
predicate, and translation to generic `ProjectionPatch[]`. The host owns
transport capabilities, coalescing, retry backoff, canonical patch application,
and active-frame error reporting. A hydration MUST validate its result before
returning; malformed or incomplete results reject and remain retryable. The host
MUST reject registration not named by a frame declaration for that module.

---

## UCM8. Component declarations

Each `ui.components[]` entry declares a component id and the browser tag that
implements it.

| Field | Required | Meaning |
|---|---|---|
| `id` | yes | Stable component id, unique within the installed catalog alias. |
| `module` | yes | `ui.modules[].id` that provides the element. |
| `tag` | yes | Custom element tag name. MUST contain a hyphen. |
| `surface` | yes | Primary rendering role: `main`, `presence`, `chat`, `detail`, `item`, `item-list`, `frame`, or catalog-defined string. The `frame` surface is reserved for nested-frame mounts via `core.frame` ([UCM27](#ucm27-bundled-core-components)). |
| `subject` | optional | Class/object constraint for subjects this component expects. |
| `neighborhood` | optional | Default object relations this component may observe. See [UCM13](#ucm13-component-neighborhood). |
| `requires` | optional | Property names the component needs from its subject's projection. The host fills them into the canonical layer when the component binds (see [UCM21](#ucm21-consistent-client-projection)). |
| `props_schema` | optional | JSON-schema-like declaration for frame props. |

Component ids are referenced by frames and item renderers. A component id
without an installed-catalog qualifier resolves first within the declaring
catalog, then through explicit dependency aliases. Ambiguous component ids are
an install error.

The fully qualified form is `<catalog-alias>:<component-id>`, for example
`pinboard:pinboard.board` or `chat:chat.space`. The unqualified dotted id is
allowed inside the declaring catalog and in contexts where dependency
resolution is unambiguous. Component ids use dots; catalog and class
references keep the existing catalog-reference colon syntax from
[catalogs.md §CT3.1](../discovery/catalogs.md#ct31-reference-resolution-precedence),
such as `note:$note`.

Tag names are global in the browser page. A client MUST reject or namespace a
catalog UI load that attempts to redefine a tag already registered by another
loaded catalog unless the existing definition is byte-for-byte the same module
artifact.

`surface` names what the component renders, not where it is mounted. A frame
may mount a component in any region — a `presence` component can sit in the
`inspector` region. The node's observation-dispatch surface defaults to the
component's declared surface. A node that overrides the surface is invalid
unless the component declaration lists the override; declarations may grow
multiple supported surfaces in a future ABI.

Region names are a layout concern; surfaces are a dispatch concern. They
intentionally share some labels (`main`, `presence`, `chat`) for readability
when a layout's region matches the typical component surface placed there.

### UCM8.1 Draft: container title badges

`title-badge` is a draft first-party surface for compact status components
mounted by a container UI near that container's title. A title badge renders a
contained object's state without taking over that object's detail view. The
container chooses the mount location; the badge component remains owned by the
contained object's catalog.

The initial browser client supports this only for the chat room title bar:
when the current room's contents include an object with a registered
`title-badge` component whose `subject` constraint matches that object, the
chat UI may mount the component to the right of the room name. The mounted
component receives the contained object as its `subject` and the current
projection summary as `data`.

Title badges are observational UI. They MUST NOT be the only way to inspect or
control the object. Missing, unsupported, or failed title-badge UI degrades to
no badge; the room title and ordinary object look/tool surfaces remain
authoritative.

The optional `subject` constraint is enforced at frame-mount time. Before
mounting a component on a node whose resolved subject is `S`, the host MUST
verify that `S.is_a(component.subject)` (or that `S` equals the constraint
when it is a concrete ref). A failed check renders the node's component-
missing fallback and records a diagnostic; it does not unmount sibling
nodes or the rest of the frame.

---

## UCM9. Frame declarations

A frame declaration chooses a layout and a set of components for a subject
object.

```ts
type UiFrame = {
  id?: string;
  subject: ObjRefOrCatalogName;
  view?: string;
  layout: string;
  state?: Record<string, unknown>;
  regions: Record<string, UiNode[]>;
};

type UiSubjectExpr =
  | "this"
  | ObjRefOrCatalogName
  | { prop: string }
  | { related: string }
  | { frame_state: string };

type UiPredicate =
  | { frame_state: string }
  | { has_prop: string }
  | { is_a: ObjRefOrCatalogName }
  | { feature: ObjRefOrCatalogName }
  | { all: UiPredicate[] }
  | { any: UiPredicate[] }
  | { not: UiPredicate };

type UiNode = {
  component: string;
  subject: UiSubjectExpr;
  surface?: string;
  related?: Record<string, UiSubjectExpr>;
  neighborhood?: UiNeighborhoodDecl;
  state?: string[];
  props?: Record<string, unknown>;
  when?: UiPredicate;
};
```

`ObjRefOrCatalogName` means either a concrete object reference or a catalog
reference resolved by the catalog rules in
[catalogs.md §CT3.1](../discovery/catalogs.md#ct31-reference-resolution-precedence).
Examples include `#01H...`, `the_pinboard`, `$space`, `chat:$chatroom`, and
`note:$note`.

Subject expressions resolve against the frame's currently mounted state:

- `"this"` — the frame's resolved subject (or the parent node's subject when
  resolving inside a `related` map).
- `ObjRefOrCatalogName` — a concrete or catalog-named ref.
- `{ "prop": "owner" }` — the value of the named property on the current frame
  subject. Valid only when the property holds an object reference visible to
  the actor; otherwise the node is omitted and a diagnostic is recorded.
- `{ "frame_state": "selected_pin" }` — the value stored at that key in
  frame-local state ([UCM16](#ucm16-frame-state-and-ui-actions)).
- `{ "related": "name" }` — the value resolved into the node's own `related`
  map for that name. This is sugar so an expression that feeds both `subject`
  and a `related` slot is written once.

`UiPredicate` gates whether a node mounts. The host evaluates predicates at
mount time and re-evaluates them when their inputs change; affected nodes are
mounted, unmounted, or re-rendered accordingly. Predicate semantics:

- `{ "frame_state": key }` — true when frame state has a non-null value at
  `key`.
- `{ "has_prop": key }` — true when the subject's named property is set and
  visible to the actor.
- `{ "is_a": class }` — true when the subject `is_a` the named class.
- `{ "feature": ref }` — true when the subject has the named feature attached.
- `{ "all": [...] }` / `{ "any": [...] }` / `{ "not": p }` — logical
  composition.

Predicates run with the actor's read permissions; if a permission check fails,
the predicate is false and a diagnostic is recorded.

`related` provides named refs as component inputs. The host resolves each
entry once at mount time (and re-resolves on input change) and exposes the
results via `WooContext` so the component reads `context.related.<name>`
without scanning the world. `state` lists frame-local state keys the
component may read or set; see [UCM16](#ucm16-frame-state-and-ui-actions).
`neighborhood` may widen or narrow the component declaration's default
neighborhood for this node.

`UiFrame.state` is an optional initial frame-state map applied when the frame
mounts. Subsequent updates flow through UI actions or component `set()`
calls per [UCM16](#ucm16-frame-state-and-ui-actions); a frame's declared
initial values are not re-applied on remount within the same route unless the
frame instance changes (UCM24).

Node mounting is driven by `when`. The host MUST re-evaluate each `when`
predicate when its inputs change (frame state, subject snapshot, referenced
refs) and mount or unmount affected nodes accordingly. A node that becomes
mounted gets a fresh component instance unless the host explicitly preserves
the prior one (UCM24). Region order in the resulting DOM follows the array
order of nodes within a region; nodes whose `when` is false are skipped.

The built-in layouts for v1 are:

| Layout | Required/known regions | Purpose |
|---|---|---|
| `space-workspace` | `main`, `presence`, `chat`, `inspector`, `overlay` | Shared spaces and tools with live presence and conversation. |
| `object-detail` | `main`, `inspector`, `overlay` | Generic object view. |
| `tool` | `main`, `inspector`, `overlay` | Single-tool view without required presence/chat. |

Layouts MAY ignore unknown regions. Components MUST NOT assume their region is
visible; responsive clients may collapse, reorder, or hide regions.

For an interactive tool whose subject is a `$space` descendant, the
`space-workspace` frame is the default shape. Such frames MUST declare a
non-empty `main` region for the tool-specific surface and a `chat` region using
`chat:chat.space-mini` with `subject: "this"`, unless the catalog documents why
the shared mini-chat region cannot express the tool. Bundled first-party tool
catalogs MUST use that mini-chat region unless the catalog is the chatroom
renderer itself. The main-region component should expose the standard ambient
companion slot (`data-ambient-companion`) when the actor is present in the tool
space, leaving message routing, focus, resize/collapse state, and chat panel
preservation to the host.

The `view` field corresponds to the `?view=` hint in
[routing.md §AR3](routing.md#ar3-view-hint). Omitted or `"default"` frames are
the default renderer for their subject.

---

## UCM10. Frame resolution

Given a subject object and an optional view hint, the client resolves a frame
in this order:

1. Exact object or seed-instance frame matching the requested view.
2. Exact object or seed-instance default frame.
3. Nearest class frame matching the requested view, using the subject's parent
   chain.
4. Nearest class default frame.
5. Core fallback frame.

Unknown view hints fall back to the selected subject's default frame. Missing,
unsupported, or failed catalog UI MUST NOT make an addressable object
unrenderable; the browser falls back to `object-detail`.

The core fallback frame renders permission-filtered object description,
location, contents, visible properties, visible verbs, and recent observations
when available. It may call conventional verbs such as `:describe()` and
`:locate()` according to [routing.md](routing.md).

---

## UCM11. Surfaces and presence

A surface is a named role for rendering the same subject object in different
contexts.

For spaces, `presence` is a surface over the space object itself. A default
presence component for `$space` reads the subject space's current occupants or
subscribers and renders actor presence. A catalog may override presence by
selecting a different component in its frame:

```json
{
  "regions": {
    "presence": [{ "component": "pinboard.presence", "subject": "this" }]
  }
}
```

This means "render this same `$pinboard` object using the pinboard catalog's
presence surface," not "render a separate presence object."

Chat is similarly a surface over a conversation-bearing space. A room, a
pinboard's below-board chat panel, and a tasks discussion panel may all
mount the same `chat.space` component with different subject objects.

---

## UCM12. Composition surfaces

Multi-surface rendering is not composition. A frame that mounts
`pinboard.board`, `pinboard.presence`, and `chat.space` over the same
`$pinboard` subject is rendering one subject through several independent
surfaces. Reusing `chat.space` in chat, pinboard, and tasks frames is also
not composition; it is component dependency reuse.

Real composition exists where one mounted UI relationship coordinates multiple
subjects, multiple frame nodes, or nested frames. v1 recognizes these surfaces:

| Surface | v1 posture |
|---|---|
| Container → item delegation | Defined by [UCM14](#ucm14-item-renderer-delegation). Containers choose item renderers for contained or associated objects. |
| Cross-subject regions in one frame | Defined by frame-local state, `related`, and subject expressions. Example: a board node sets `selected_pin`; an inspector node resolves its subject from `{ "frame_state": "selected_pin" }`. |
| Frame embedding (in-region) | Supported through the host-provided `core.frame` component, or by emitting `open_frame` ([UCM16](#ucm16-frame-state-and-ui-actions)). The child frame gets its own subject, frame state, and neighborhood. Components MUST NOT resolve and mount arbitrary frames internally. |
| Overlay and modal frames | Defined by [UCM12.1](#ucm121-overlay-and-modal-frames). Floating frames mounted above the base frame, addressable via route state. |
| Component-emitted UI actions | Defined by [UCM16](#ucm16-frame-state-and-ui-actions). Actions go to the mounted frame controller, not directly to sibling components. |
| Drag/drop, focus follow, selection mirroring | Expressed as UI actions plus frame-local state updates. Catalogs MUST NOT couple sibling components through private DOM events or global variables. |

This keeps composition at the frame/controller layer. Components render their
declared subject and neighborhood; frames assemble components and decide which
state and related subjects are shared.

### UCM12.1 Overlay and modal frames

Overlays are frames mounted above another frame. They are the framework answer
for edit popups, confirm dialogs, pickers, lightboxes, property sheets,
drag-source previews, and other focused UI that should not replace or shove
aside the base frame.

An overlay request names a subject and optional view:

```ts
type OverlayFrameRequest = {
  id?: string;
  subject: string;
  view?: string;
  mode?: "modal" | "popover" | "sheet";
  dismissible?: boolean;
  position?:
    | "center"
    | "anchor"
    | "pointer"
    | { x: number; y: number };
  props?: Record<string, unknown>;
};
```

If `id` is omitted, the host assigns one and stores it in the reserved overlay
stack for the owning frame. `close_overlay` with an id closes the matching
overlay in the current frame stack. `close_overlay` without an id closes the
topmost overlay owned by the current frame.

Components request overlays with UI actions, not by appending DOM to
`document.body`:

```ts
emit({
  type: "open_overlay",
  overlay: {
    subject: noteId,
    view: "editor",
    mode: "modal",
    dismissible: true
  }
});
```

The host resolves the requested frame using the same frame-resolution rules as
normal navigation. The overlay frame receives its own `WooContext`, frame
state, lifecycle, neighborhood, projection subscriptions, failure handling, and
component tree. Closing the overlay unmounts that frame and disposes its
subscriptions.

Overlay state is addressable. The host MUST provide a route representation for
modal overlays. One permissible encoding carries URL-encoded modal frame
addresses in repeated query parameters:

```text
/objects/the_pinboard?modal=%2Fobjects%2Fobj_pin_3%3Fview%3Deditor
```

The exact URL encoding for multiple overlays is a host-shell detail, but the
semantics are normative: a shared modal route reconstructs the base frame plus
the overlay stack when the actor has permission to view the referenced
objects. Closing an addressable overlay removes it from route state.

First-party catalog UI MUST use overlay frames for popup editors and dialogs
that need woo context. Component-local DOM popups are acceptable only for
purely visual affordances that require no object projection, no verb calls, no
frame state, and no lifecycle beyond the owning component.

---

## UCM13. Component neighborhood

A component's **neighborhood** is the bounded set of refs it may read from the
client projection. This is an encapsulation boundary, not the server privacy
boundary. Server permission filtering still applies, but permission alone does
not make an object in-scope for a component.

Neighborhoods are declared by component manifests and widened by frame nodes:

```ts
type UiNeighborhoodDecl = {
  include?: (
    | "subject"
    | "location"
    | "contents"
    | "subscribers"
    | "actor"
  )[];
  props?: string[];
  related?: string[];
  depth?: 0 | 1;
};
```

At runtime the host exposes the resolved neighborhood:

```ts
type WooNeighborhood = {
  subject: string;
  refs: readonly string[];
  related: Readonly<Record<string, string | null>>;
  has(ref: string): boolean;
};
```

Rules:

- `subject` is always included, even when omitted.
- `location`, `contents`, and `subscribers` include those refs for the node's
  subject when visible to the actor.
- `actor` adds the current actor object to the observable neighborhood. The
  scalar actor ref is always available on `WooContext.actor`; the include flag
  controls only whether `observe(context.actor)` returns a snapshot.
- `props` lists object-valued properties the host may follow from the subject;
  the resulting refs become observable.
- `related` lists named refs supplied by the frame node's `related` map; the
  resulting refs become observable.
- `depth` defaults to `0` (subject and the directly named refs only). v1
  permits only `0` or `1`; with `depth: 1`, the host follows one additional
  hop along `props` and `related` refs. Unbounded graph walking is not part
  of the client framework.

`observe(ref)` and `subscribe(refs, ...)` are scoped to this neighborhood. For
out-of-neighborhood refs, `observe()` MUST return `null` and the host SHOULD
record a diagnostic in development builds. Components that need an
out-of-scope object must ask the frame to include it, navigate to it, or call a
verb that returns the data through a server-mediated API.

The frame is the normal place to widen scope. For example, a pinboard frame can
give the board component a `selected` related ref, or can mount an inspector
node whose subject is `{ "frame_state": "selected_pin" }`. The component does
not discover those refs by scanning the world.

This is the UI-framework counterpart of the informal vicinity-projection
design in [notes/2026-05-04-sprawl-scale.md](../../notes/2026-05-04-sprawl-scale.md):
vicinity determines projection scope; projection scope determines what
`observe()` can return.

---

## UCM14. Item renderer delegation

Objects do not have exactly one UI. Containers choose how contained or
associated objects are rendered in context.

An item-renderer rule has this shape:

```ts
type UiItemRenderer = {
  container: ObjRefOrCatalogName;
  match: {
    is_a?: ObjRefOrCatalogName;
    feature?: ObjRefOrCatalogName;
    prop?: string;
    view?: string;
  };
  component: string;
  props?: Record<string, unknown>;
};
```

Example: a `$note` may render as a sticky card inside a pinboard, a compact
row inside tasks, and a plain object chip inside inventory. The note class
may provide a generic detail frame, but the container decides item-level
presentation.

When multiple item-renderer rules match, precedence is:

1. Exact container object rule.
2. Nearest container class rule.
3. Most specific matched item class for `is_a`, by parent-chain distance.
4. Feature matches.
5. Property/view matches.
6. Catalog dependency order.
7. Install order as a final deterministic tie-breaker.

Feature matches have no parent-chain distance unless a later feature hierarchy
spec defines one. If two feature-only rules match the same item, catalog
dependency order and then install order decide. A rule with both `is_a` and
`feature` is ordered first by `is_a` distance, then by the feature rule.
Ambiguous rules that cannot be ordered deterministically are an install error.

---

## UCM15. Runtime component contract

The host creates the custom element, injects context, sets its subject, and
connects it to frame node metadata before insertion:

```ts
interface WooElement extends HTMLElement {
  woo?: WooContext;
  subject?: string;
  related?: Record<string, string | null>;
  node?: UiNode;
}
```

The host MUST set these properties before the element's first render whenever
the component framework permits it. Components MUST tolerate receiving or
updating them after construction.

The `WooContext` is the component's authority surface:

```ts
type WooContext = {
  actor: string | null;
  frame: WooFrameContext;
  neighborhood: WooNeighborhood;

  observe(ref: string): ObjectSnapshot | null;
  subscribe(refs: string[], listener: () => void): () => void;
  subscribeObservations(
    query: ObservationQuery,
    listener: (items: ObservationEnvelope[]) => void
  ): () => void;

  call(
    target: string,
    verb: string,
    args?: unknown[],
    options?: CallOptions
  ): Promise<CallResult>;
  directCall(
    target: string,
    verb: string,
    args?: unknown[],
    options?: DirectCallOptions
  ): Promise<CallResult>;
  send(command: string, space?: string, options?: SendOptions): Promise<CallResult>;

  navigate(target: string, options?: { view?: string }): void;
  emit(action: WooUiAction): void;
};
```

`ObjectSnapshot` is the permission-filtered, replay-merged client-projection
view of a single object. Its shape mirrors the REST `/api/objects/<id>`
response (id, parents, owner, visible properties, item summaries) plus any
`catalog_state` keys that observation reducers have populated for the
projection. `CallResult` is the corresponding REST/wire result shape: a
result value (or error), and any returned object refs that the host may have
projected before resolving the promise (UCM21).

Catalog UI SHOULD use `WooContext` instead of importing host client internals.
The host may evolve its private SPA implementation without breaking the ABI as
long as this context remains compatible.

`actor` is the current actor ref as a scalar identity. It does not imply that
the actor object is observable; `observe(actor)` succeeds only when the actor
is in the component neighborhood. Route details are not part of component
context. Components receive subject, related refs, frame state, and navigation
operations; URL interpretation belongs to the frame resolver and host shell.

`observe()` returns object snapshots from the framework projection, applying
the same permission filtering and missing-object behavior as other client
projection reads. It is also neighborhood-scoped: refs outside
`context.neighborhood` return `null`. `subscribe()` notifies when requested
in-neighborhood object projections change or are invalidated; it is not a
separate cache.

`call()` sends a sequenced call through the current route's space when the
host can infer one, or through an explicitly selected space in a future
overload. `directCall()` invokes direct-callable verbs without sequencing,
following [wire.md §17.1](wire.md#171-client--server). `send()` is the
text-command path: it submits a human command string to the command parser for
the given space, or the current route's command space if omitted. Command
parsing follows the `$match` and chat-shaped command conventions in
[match.md](../semantics/match.md).

`CallOptions`, `DirectCallOptions`, and `SendOptions` may carry optimistic
projection patches as specified in [UCM21](#ucm21-consistent-client-projection).

---

## UCM16. Frame state and UI actions

Frame-local state is browser-local state owned by one mounted frame. It is for
UI coordination facts such as selected object, active pane, collapsed panels,
dense mode, drag target, and focus-follow mode. It is not persisted world
state, and it is not delivered as an observation.

```ts
type WooFrameContext = {
  id: string;
  subject: string;
  view?: string;
  get(key: string): unknown;
  set(key: string, value: unknown): FrameStateResult;
  subscribe(keys: string[], listener: () => void): () => void;
};

type FrameStateResult =
  | { ok: true }
  | { ok: false; diagnostic: string };
```

`id` is a stable identifier for the mounted frame instance; it survives
re-renders and route reuse but changes when the frame unmounts and a new
frame mounts. `subject` and `view` are the frame's resolved subject ref and
view hint. Each overlay or nested-frame mount produces its own
`WooFrameContext` with its own id, frame state, and lifecycle.

A component may read or set only the frame-state keys listed on its frame
node or granted by the host. `get()` and `set()` on a key the node has not
declared MUST return `undefined` and `{ ok: false, diagnostic }`,
respectively, without mutating state. Reserved keys (see below) MUST be
written through `emit()`, not `set()`. Sibling components coordinate by
subscribing to the same frame-state keys, not by directly calling each other.

`emit(action)` sends a UI action to the mounted frame controller. It does not
emit a woo observation and does not call a server verb by itself.

```ts
type WooUiAction =
  | { type: "select"; key?: string; subject: string | null }
  | { type: "focus_pane"; pane: string; subject?: string | null }
  | { type: "set_frame_state"; key: string; value: unknown }
  | { type: "navigate"; target: string; view?: string }
  | { type: "open_frame"; region: string; subject: string; view?: string }
  | { type: "open_overlay"; overlay: OverlayFrameRequest }
  | { type: "close_overlay"; id?: string }
  | { type: "drag_start"; subject: string; data?: Record<string, unknown> }
  | { type: "drag_drop"; target: string; data?: Record<string, unknown> };
```

The default frame controller handles:

- `select` writes the action's `subject` to frame state under
  `key ?? "selected"`. `select` is sugar for `set_frame_state`; using it
  signals selection intent so other components can subscribe to the same key.
- `set_frame_state` writes the named key; the value MAY be `null` to clear.
- `focus_pane` writes the focused pane name to the reserved key
  `focus_pane`. Components that care about pane focus subscribe to that key.
- `navigate` delegates to `navigate()`.
- `open_frame` resolves a frame for the requested subject and mounts it in
  the named region, when the layout supports it. The opened frame replaces
  the region's declared content for its lifetime; on unmount, the declared
  content is restored. Only one open frame per region is supported in v1.
- `open_overlay` and `close_overlay` maintain the overlay frame stack and
  route state described in [UCM12.1](#ucm121-overlay-and-modal-frames).
- `drag_start` writes a `WooDragData` value to the reserved frame-state key
  `drag`. `drag_drop` writes a `WooDropData` value to the reserved key
  `drop`, notifies subscribers for `drag` and `drop`, then clears `drag` on
  the next browser task. Components that may host drop targets subscribe to
  `drag` and `drop` to know whether a drag is in flight and whether a drop
  targeted them.

```ts
type WooDragData = {
  kind: string;
  subject?: string;
  payload?: Record<string, unknown>;
};

type WooDropData = {
  target: string;
  drag: WooDragData;
  accepted?: boolean;
};
```

Drag/drop actions carry declarative data, not DOM event objects. Drop targets
decide whether they accept a drag by inspecting `kind`, `subject`, and their
own component/frame state. Cross-catalog drag/drop interoperability requires
shared `kind` strings and payload conventions; private DOM drag events are
not a framework composition surface.

Reserved frame-state keys (`selected`, `focus_pane`, `drag`, `drop`, and the
overlay stack) are owned by the default frame controller. Components MUST NOT
overwrite them through `set_frame_state`; the controller does the writes in
response to the matching action.

Catalogs may provide a custom frame controller in a later ABI. In v1,
component-emitted actions target the host frame controller only. There is no
component-to-component action delivery.

---

## UCM17. Observation delivery vs client dispatch

Server-side observation delivery and browser-side observation dispatch are
separate steps.

The server decides which actors receive an observation. That decision is
audience-based and follows [events.md §12.6](../semantics/events.md#126-observation-durability-follows-invocation-route)
and [events.md §12.7](../semantics/events.md#127-observation-audience-and-direct-message-routing).
The browser MUST NOT treat client-side component subscriptions as authority
or privacy boundaries.

After a browser receives an observation, the host client normalizes it and
dispatches it to components by subject, surface, type, and route. Observation
payload fields are not themselves dispatch rules. A field named `pin`, `room`,
`target`, or `actor` affects dispatch only if a registered observation handler
or core fallback normalizer maps it into an observation envelope.

This rule is the client-framework boundary:

> Server delivery is audience-based. Browser dispatch is subject/surface-based.

---

## UCM18. Delivered observations

The browser receives observations through two baseline wire shapes:

- `op:"applied"` frames, whose `observations[]` are sequenced and
  replay-visible;
- `op:"event"` frames, whose single `observation` is live-only and lossy.

The host converts both into delivered observations before normalization:

```ts
type DeliveredObservation = {
  route: "sequenced" | "live";
  space?: string;
  seq?: number;
  index?: number;
  callId?: string;
  message?: Record<string, unknown>;
  observation: Record<string, unknown>;
};
```

For `op:"applied"`, `route` is `"sequenced"`, `space` and `seq` come from the
applied frame, `index` is the observation's array index, and `callId` is the
frame's `id` when present. For `op:"event"`, `route` is `"live"` and no `seq`
is present.

The delivered-observation layer preserves the wire distinction but gives the
rest of the client a single input shape.

---

## UCM19. Observation normalization

Every delivered observation becomes an observation envelope:

```ts
type ObservationEnvelope = {
  route: "sequenced" | "live";
  space?: string;
  seq?: number;
  index?: number;
  callId?: string;
  type: string;
  source?: string;
  subjects: string[];
  surfaces: string[];
  observation: Record<string, unknown>;
  receivedAt: number;
};

type ObservationQuery = {
  subject?: string;
  surface?: string;
  type?: string | string[];
  route?: "sequenced" | "live" | ("sequenced" | "live")[];
  debug?: boolean;
};
```

Normalization is performed by registered observation handlers. A handler may
extract affected subjects, name surfaces, and provide a projection reducer.
If no handler matches, the core fallback normalizer uses only:

- `observation.type` as `type`, when it is a string;
- `observation.source` as `source` and as a subject, when it is an object ref;
- the delivered `space` as a subject, when present.

The fallback normalizer intentionally does not interpret arbitrary payload
field names. Bundled catalogs that need fields such as `pin`, `note`, `board`,
`room`, `to`, or `target` to affect dispatch must register handlers.

---

## UCM20. Observation handlers and projection

Catalog UI modules may register trusted observation handlers:

```ts
type WooObservationHandler = {
  types: string[];
  subjects?: (
    observation: Record<string, unknown>,
    delivered: DeliveredObservation
  ) => string[];
  surfaces?:
    | string[]
    | ((
        observation: Record<string, unknown>,
        delivered: DeliveredObservation
      ) => string[]);
  live_ttl_ms?:
    | number
    | ((
        observation: Record<string, unknown>,
        delivered: DeliveredObservation
      ) => number | undefined);
  liveProjection?: "preview" | "canonical";
  reduce?: (
    draft: ClientProjectionDraft,
    envelope: ObservationEnvelope
  ) => void;
};

type ClientProjectionDraft = {
  patchObject(ref: string, fields: Record<string, unknown>): void;
  patchObjectProps(ref: string, props: Record<string, unknown>): void;
  patchCatalogState(ref: string, key: string, fields: Record<string, unknown>): void;
  clearCatalogState(ref: string, key: string): void;
  clearAuthoritative(ref: string): void;
};
```

The draft is the only API a reducer may use to update projection state. Its
operations are idempotent and write-only; the draft does not expose reads.
`clearAuthoritative(ref)` removes server-confirmed direct-result patches for a
subject that has been removed from the current scope, preventing stale
authoritative entries from resurrecting objects after a scoped snapshot or
sequenced removal.
Reducers that need a prior value require the observation to carry it
explicitly.

The framework owns reducers for the generic property-change observations that
substrate fixtures and generic catalogs use:

- `{type:"property_changed", source|target|object, name, value}` patches
  `observe(ref).props[name]`.
- `{type:"value_changed", source|target|object, value}` patches
  `observe(ref).props.value`.
- `{type:"block_data", block|target|source, name, value}` patches
  `observe(block).props[name]`.

These generic property-change reducers declare `liveProjection:"canonical"`.
When delivered on the live route, their reductions are folded into the
authoritative canonical layer instead of the expiring live-preview layer. This
is reserved for observations that represent committed state changes; transient
gestures and previews keep the default `liveProjection:"preview"` behavior.

Catalog-specific observations may still carry richer domain facts, but any
observation intended to keep object props coherent MUST carry enough data for a
pure reducer to update the projection without rereading `/api/me`.

Example:

```ts
export function registerWooObservationHandlers(registry) {
  registry.observation({
    types: ["pin_moved", "pin_resized"],
    subjects: (obs, delivered) => [
      String(obs.board ?? delivered.space ?? ""),
      String(obs.pin ?? "")
    ].filter(Boolean),
    surfaces: ["pinboard.board"],
    reduce: (draft, envelope) => {
      const obs = envelope.observation;
      draft.patchObject(String(obs.pin), {
        x: obs.x,
        y: obs.y,
        w: obs.w,
        h: obs.h
      });
    }
  });
}
```

Handlers run in the trusted catalog UI module realm. They MUST be synchronous
and deterministic with respect to their inputs. They MUST NOT perform network
I/O, call verbs, mutate DOM, schedule timers, read from `observe()`, or mutate
the immutable client projection. Side effects belong in components after
subscription delivery, not in projection reducers. If a reducer needs to
compare versions or decide whether a payload is newer, the observation must
carry the required version or causal data.

Projection reducers update the host's client projection: cached object
snapshots, derived catalog state, and optimistic reconciliation state. The
server remains the source of truth. A projection is a latency and continuity
mechanism for the client, not a server-state mutation.

A handler whose `reduce` function patches the live-preview layer for live
observations SHOULD supply `live_ttl_ms`, either as a constant or computed per
observation. If `live_ttl_ms` is omitted, the host applies a conservative
default (1500ms in v1). Sequenced handlers do not need a TTL; their reductions
land in the sequenced layer and are reconciled by replay rather than expiry.
Live handlers that set `liveProjection:"canonical"` also do not need a TTL,
because their reductions represent committed state rather than previews.

When multiple handlers match the same observation, the host applies them in
catalog dependency order and then install order. Reducers that touch the same
projection field should be treated as a diagnostic; catalogs should avoid
overlapping ownership of projection state.

---

## UCM21. Consistent client projection

The client framework MUST provide a consistent projected view of each
component's neighborhood. Components read through `observe()`; they SHOULD NOT
fetch full-world snapshots, read raw wire frames, or maintain duplicate canonical
object models for objects the framework has in scope.

The projection has ordered layers:

1. **Canonical snapshot layer** — the latest permission-filtered object
   snapshots fetched from REST, replay, browser-profile projection rows, or an
   equivalent host snapshot source.
2. **Sequenced observation layer** — deterministic reductions from
   `op:"applied"` observations, applied in `(space, seq, index)` order.
3. **Live preview layer** — lossy direct-call observations and gesture previews
   with bounded TTL.
4. **Pending optimistic layer** — local patches requested by components when
   issuing calls, keyed by call id or explicit optimistic id.

`observe(ref)` returns the merged value of these layers. Higher-numbered
layers take precedence for fields they patch. Unpatched fields continue to
come from lower layers. A component that moves a pinboard note or drags a
dubspace control therefore sees the new position/value immediately through
the same `observe()` path it uses after the server reply arrives.

Browser-profile projection rows are canonical display input only. They may
carry thin object/session/log/tool summaries and MUST NOT be treated as
executable VM state. A pending local turn record (`tentative_turns` in Phase 1,
the `TurnProposal` model in the final dependency-wire design) contributes only
to layer 4 until the authority accepts the matching transcript hash and the
accepted projection writes are installed in the canonical layer.

Refreshing the canonical snapshot layer MUST NOT by itself overwrite a higher
layer. A stale scoped snapshot response can update the canonical base, but
active live-preview or pending optimistic patches continue to win until they
are reconciled, superseded, or expired.

Room snapshots and other neighborhood payloads MAY ship thin object summaries
that omit `props` to keep the projection wire small. When a component declares
`requires` ([UCM8](#ucm8-component-declarations)) and the projection lacks any
of those fields at bind time, the host MUST trigger a one-shot fill that folds
a full object summary into the canonical layer (typically via the same
authoritative-direct-result path used for navigation summaries). The fill is
de-duplicated per subject and is not retried beyond a single round-trip; if
the field is genuinely absent on the server, subsequent `block_data` /
`property_changed` / catalog-specific observations remain the source of truth.
Components render a skeleton from whatever projection state is available and
re-render when the fill resolves.

Some direct calls return server-confirmed state without writing a sequenced log
entry. The framework may fold those authoritative direct results into the
canonical snapshot layer with an explicit canonical patch operation. That
operation is not an optimistic or live-preview update: it is treated as
server-confirmed state, persists across later scoped-snapshot ingestion, and
clears overlapping live or optimistic fields. The operation MAY be a merge or a
per-key replacement. Replacement is scoped to the keys present in the patch: a
replacement of `catalogState.pinboard_note` for one note replaces that note's
authoritative entry without deleting unrelated catalog-state keys on the same
subject. The framework MUST also provide a way to clear authoritative entries
for recycled or removed subjects so a direct-result patch cannot resurrect an
object that has left the current scope.

Optimistic patches use this shape:

```ts
type ProjectionPatch = {
  subject: string;
  fields?: Record<string, unknown>;
  props?: Record<string, unknown>;
  catalogState?: Record<string, Record<string, unknown>>;
};

type OptimisticPatch = {
  id?: string;
  patches: ProjectionPatch[];
  ttlMs?: number;
  reconcile?: "drop_on_applied" | "drop_on_error" | "keep_until_changed";
};

type CallOptions = {
  space?: string;
  optimistic?: OptimisticPatch;
};

type DirectCallOptions = {
  optimistic?: OptimisticPatch;
};

type SendOptions = {
  optimistic?: OptimisticPatch;
};
```

When a component supplies `options.optimistic`, the host applies the patch to
the pending optimistic layer before the call leaves the browser. The host
assigns or records the optimistic id, associates it with the outgoing call id
when one exists, and notifies `subscribe()` listeners for the patched subjects.

Reconciliation rules:

- When the matching `op:"applied"` frame arrives, the host first applies
  sequenced observation reducers to the canonical/projection base, then
  reconciles pending optimistic patches for that call.
- Default `drop_on_applied` removes the optimistic patch after reducers run.
  If the server accepted the predicted value, the merged projection does not
  visibly change. If the server produced a different value, the projection
  moves once to the canonical result.
- `keep_until_changed` keeps the optimistic patch until a later sequenced
  observation or snapshot changes one of the same patched fields. This is for
  continuous gestures where multiple in-flight calls may overlap.
- `drop_on_error` keeps the optimistic patch after an applied/direct success
  and removes it only if the associated call fails. This is for call paths
  where a later observation or explicit component action will reconcile the
  visible state.
- Expired optimistic patches are removed and subscribers are notified. The
  default expiry is implementation-defined but SHOULD be short enough to avoid
  stale UI after a lost call id; 10 seconds is a reasonable default for v1.

Before resolving a `call()`, `directCall()`, or `send()` promise, the host
MUST apply any delivered observations and projection reducers already attached
to that result. If the result contains object refs that are in the component's
neighborhood, `observe(ref)` should return the projected object by the time the
promise resolves, unless the object is unreadable or missing. Returned refs do
not automatically widen the neighborhood; out-of-neighborhood result refs
remain unobservable until the frame includes them, navigates to them, or a
server verb returns the needed data directly.

Live previews are framework-owned as well. Direct live observations may
project into the live preview layer through observation handlers. Live preview
reducers MUST set or inherit a TTL; after expiry, the framework removes the
preview and reveals the lower-layer projection.

This projection contract is the fix for "snap back then catch up" behavior.
Pinboard note motion, dubspace control gestures, and similar interactions
must be modeled as optimistic or live-preview projection updates in the
framework, not as component-local state that competes with later REST refresh
or applied-frame reducers.

---

## UCM22. Component observation subscriptions

Components receive observations through `WooContext.subscribeObservations()`.
Queries are matched against normalized envelopes:

```ts
const unsubscribe = woo.subscribeObservations(
  { subject: this.subject, surface: "pinboard.board" },
  (items) => this.applyObservationBatch(items)
);
```

The host MAY batch envelopes that arrive in the same browser task or animation
frame. Listeners MUST tolerate duplicate delivery after reconnect and MUST use
`route`, `space`, `seq`, and `index` when they need idempotency.

For sequenced observations, components should prefer projection state from
`observe()` after the reducer has run. For live observations, components may
render directly from the envelope because there is no replay path.

Observation queries are scoped to the component's neighborhood and dispatch
surface. By default, a query without `subject` and without `surface` is
rejected. Global debug subscriptions require `debug: true`, a wizard actor,
and host debug policy allowing the subscription.

Components that care about call-origin reconciliation may filter by `callId`.

---

## UCM23. Data flow and local state

Catalog components render from four sources:

- immutable frame/node props,
- current object projections supplied by `WooContext`,
- normalized observation envelopes delivered by `subscribeObservations()`,
- component-local transient UI state.

The host owns world-state synchronization and projection reconciliation.
Components that need immediate feedback should provide optimistic patches or
issue direct calls whose live observations project through registered handlers;
they should not maintain a second canonical object model that can diverge from
`observe()`. The source of truth remains server state and sequenced applied
observations.

Components MUST NOT mutate projected snapshots in place. Derived presentation
values — sort orders, formatted labels, computed positions — are computed
locally as pure functions of the four sources above; see
[UCM4](#ucm4-the-server-is-the-model) on the line between presentation and
model state. To request a state change beyond the component's own scope,
components emit UI actions through `emit()`.

---

## UCM24. Lifecycle

The host MUST dispose subscriptions and event listeners associated with a
component when its frame node is unmounted.

Components SHOULD use standard custom-element lifecycle methods:

- `connectedCallback()` to start DOM-local work,
- `disconnectedCallback()` to stop timers, subscriptions, and observers,
- property setters or reactive fields for `woo`, `subject`, and `node`.

Component hydration or semantic-fill reads that can be requested from render
MUST coalesce identical in-flight work and MUST apply bounded retry backoff
after failure. A persistent permission, missing-object, or transport failure
must not turn observation-driven renders into a request-per-render loop.
Frame-declared hydrations use the host's shared coalescing/backoff policy; a
component that performs its own semantic read remains responsible for the same
bounds.

The host MAY preserve component instances across route changes when subject,
component id, and stable frame-node identity are unchanged. Components MUST
not depend on instance preservation for correctness.

---

## UCM25. Failure behavior

UI loading and rendering failures degrade locally; they do not affect world
execution.

Required behavior:

- If a module fails integrity validation, the host refuses to import it and
  records a diagnostic.
- If a module import throws, the host marks that module failed for the current
  page lifetime and falls back for affected components.
- If a component tag is not registered after module load, affected nodes render
  a component-missing fallback.
- If a component throws during render or lifecycle, the host replaces that
  node with an error fallback and keeps the rest of the frame mounted when
  practical.
- If an observation handler throws, the host records a diagnostic, skips that
  handler for the delivered observation, and continues dispatching through
  other handlers and fallback normalization where practical.
- If an optimistic patch expires or its associated call fails, the host removes
  it from the projection and notifies affected subscribers.
- If a frame cannot be resolved, the host uses `object-detail`.

Diagnostics SHOULD include catalog alias, component id, module id, digest,
subject, route, and error category. Diagnostics MUST NOT include property
values the actor is not allowed to read.

---

## UCM26. Versioning and compatibility

`woo-ui/v1` is the first browser UI ABI. A client declares the ABI versions it
supports. A catalog may declare exactly one ABI per manifest version.

Breaking changes require a new ABI string, such as `woo-ui/v2`. Compatible
additions may be made within `woo-ui/v1` when older clients can ignore them.

A catalog update that changes UI module code, component declarations, frame
resolution behavior, item-renderer rules, observation handlers, or projection
behavior is a catalog behavior change. The catalog versioning and migration
rules in
[discovery/catalogs.md](../discovery/catalogs.md) apply. If the UI change also
changes persisted object property shapes or value conventions, the relevant
catalog or world migration rules apply.

---

## UCM27. Bundled core components

A conforming browser client SHOULD provide these core component ids:

| Component id | Subject | Surface | Purpose |
|---|---|---|---|
| `core.object-detail` | `$root` descendants | `detail` | Generic object fallback. |
| `core.presence` | `$space` descendants | `presence` | Default occupants/subscribers view. |
| `chat.space` | conversation-bearing `$space` descendants | `chat` | Shared chat/event log panel. |
| `core.contents` | containers | `item-list` | Generic contained-object list. |
| `core.frame` | any renderable object | `frame` | Host-controlled nested frame mount. |

Bundled catalogs may depend on these ids unless their manifest declares a
different dependency or replacement.

---

## UCM28. Relationship to transient browser hosts

This model does not replace transient objects from
[browser-host.md](browser-host.md). Transient objects are woo objects hosted by
the browser VM and callable from the world. UI components are browser DOM
elements loaded from catalog JavaScript.

The two may interoperate:

- A component may call verbs on transient objects if the host exposes them.
- A transient object may emit observations that a component renders.
- A future catalog may ship both browser-host bytecode and UI modules.

They remain distinct contracts. UI component failures are presentation
failures; transient-host failures are host/runtime failures.

---

## UCM29. Implementation profile for the first client

The first implementation should proceed in this order:

1. Add the `woo-ui/v1` manifest schema and component registry.
2. Introduce the server-is-model discipline in the client store: no component
   global world object, no component-owned canonical object model.
3. Introduce `WooContext` as the stable boundary around scoped projection
   reads, frame state, UI actions, and call paths.
4. Add component neighborhoods for `observe()`, `subscribe()`, and
   `subscribeObservations()`.
5. Add the framework-owned client projection with canonical, sequenced,
   optimistic, and live-preview layers.
6. Add the delivered-observation normalizer, observation handler registry,
   projection reducer pass, and `subscribeObservations()` bus.
7. Add frame-local state, UI actions, drag/drop action payloads, and overlay
   frame stack support.
8. Provide core Web Components for `core.object-detail`, `core.presence`, and
   `chat.space`. Components are ordinary custom elements; Lit or another
   helper library is optional and not part of the ABI.
9. Implement a frame resolver that reproduces the current tab UI while using
   catalog frame declarations when available.
10. Move bundled frame declarations into catalog manifests.
11. Move bundled UI components and observation handlers into catalog-local ESM
   modules.
12. Enforce module hashing for non-local catalog UI.
13. Remove legacy tab-specific render scaffolding and global observation
    branches once frames, projection, and observation handlers cover the
    shipped UI. Host-owned service adapters may remain for transport, audio,
    routing, and gestures that are not yet expressible as frame actions.

This staged profile is non-normative, but implementations that follow it will
preserve behavior while moving authority from the monolithic SPA into
catalog-owned UI.

---

## UCM30. Conditions of satisfaction and migration concerns

The first implementation of `woo-ui/v1` is complete only when the observable
client behavior satisfies the checks below. These checks are normative for the
framework contract; the exact automated test shape is implementation-specific.

### UCM30.1 Catalog loading and registration

- A catalog with a valid `ui` manifest loads its declared modules from pinned
  artifacts, registers only the component tags listed in `components[]`, and
  refuses or diagnoses tag collisions.
- A catalog whose `ui.abi` is unsupported is still installable as a behavior
  catalog; its UI declarations are ignored and affected objects use fallback
  frames.
- Before a frame subscribes to a space's live tail or replays that space's
  applied frames, the host has registered all observation handlers required by
  the frame, its mounted component modules, and the item renderers reachable
  from those components.
- A module import, tag registration, or handler registration failure degrades
  only the affected component/frame and records a diagnostic; it does not
  make the addressed object unrenderable.

### UCM30.2 Server-as-model and projection

- No catalog component receives a full world snapshot or route object through
  `WooContext`.
- `observe(ref)` returns snapshots only for refs in the component's resolved
  neighborhood. Out-of-neighborhood refs return `null` and produce a
  development diagnostic.
- Projection reducers cannot read projection state, call verbs, mutate DOM,
  or schedule side effects. Reducers write only through `ClientProjectionDraft`.
- Refreshing the canonical snapshot layer with stale REST state does not
  overwrite active live-preview or optimistic layers.
- Returned refs from successful calls are projected before promise resolution
  when the refs are in-neighborhood and readable; otherwise the result makes
  the unreadable/missing/out-of-neighborhood condition explicit.

### UCM30.3 Frames, composition, and overlays

- Frame resolution supports exact object, exact object default, nearest class
  view, nearest class default, and core fallback in the order in [UCM10](#ucm10-frame-resolution).
- `when` predicates are re-evaluated when frame state or referenced snapshots
  change, mounting and unmounting nodes without rebuilding unrelated nodes.
- Frame-local state is scoped to the mounted frame instance. Sibling
  components coordinate through declared frame-state keys and UI actions, not
  through private DOM events or direct component references.
- `open_frame` mounts one nested frame in the requested region and restores
  the declared region content when the nested frame closes.
- `open_overlay` mounts an overlay frame with its own `WooContext`,
  neighborhood, frame state, lifecycle, and subscriptions. `close_overlay`
  closes by id or closes the current frame's topmost overlay when no id is
  supplied.
- Modal overlay stacks are reconstructable from route state. A shared modal
  route restores the base frame and readable overlays for the actor.
- Drag/drop uses `WooDragData` and `WooDropData` through frame state and UI
  actions. Cross-component drag/drop does not require private DOM coupling.

### UCM30.4 Observation dispatch

- Sequenced `op:"applied"` observations and live `op:"event"` observations are
  normalized into the same `ObservationEnvelope` shape before component
  dispatch.
- Browser dispatch is subject/surface/type/route based. Payload fields such as
  `pin`, `room`, `target`, or `actor` affect dispatch only through registered
  handlers or the core fallback normalizer.
- `subscribeObservations()` is scoped to the component neighborhood and
  dispatch surface. Queries with neither `subject` nor `surface` are rejected
  unless `debug: true` is set and the actor plus host policy allow a wizard
  debug stream.
- Live reducers have a TTL and expire cleanly. Sequenced reducers are replayed
  in `(space, seq, index)` order and produce the same projection from the same
  inputs.

### UCM30.5 Interaction smoke tests

The first client should pass at least these end-to-end checks:

- **Pinboard edit overlay.** A note card opens an editor overlay for the note.
  The overlay has woo context, can save through verbs, closes cleanly, and is
  reconstructable from modal route state.
- **Pinboard move.** Moving a note updates the projection immediately and does
  not snap back when a stale canonical snapshot refresh arrives before the
  applied frame.
- **Dubspace gesture.** Dragging a control updates through optimistic or live
  preview projection immediately; applied results reconcile without visible
  snap-back.
- **Dubspace workstation coordination.** Queue selection, deck focus, and
  cross-component drag/drop use frame state and UI actions rather than
  component-private shared stores or DOM coupling.
- **Room projection.** A room can render a contained dubspace through an item
  renderer or alternate surface without giving that component global read
  access.
- **Observation privacy.** A non-wizard component cannot subscribe to the
  actor's global observation firehose.
- **Fallback resilience.** Removing or breaking one catalog UI module leaves
  the addressed object renderable through fallback frames.

### UCM30.6 Migration concerns

Moving bundled UI out of `src/client/` and into catalog `ui` declarations is
normally a client/catalog packaging change, not a world-state migration:

- No worktree schema/data migration is required when the change only adds
  `ui` sections, UI modules, frame declarations, item renderers, or
  observation handlers to a catalog manifest.
- No catalog version migration is required for a backward-compatible UI-only
  update that does not rename classes, change property shapes, change persisted
  value conventions, or alter seed object identities. It should be a normal
  catalog version bump according to [catalogs.md §CT14](../discovery/catalogs.md#ct14-versioning-and-migrations).
- Existing installed catalogs without `ui` declarations remain valid. Clients
  use core fallback frames until the catalog is updated.
- Existing worlds whose client bundle still contains legacy tab renderers can
  run during the transition. The host may prefer catalog frames when available
  and fall back to legacy adapters only for bundled demos not yet migrated.
- The bundled chat, dubspace, pinboard, and tasks catalogs ship
  catalog-local custom element modules and frame declarations in v1. The first
  client mounts those surfaces through catalog UI declarations; the host still
  supplies service adapters for WebSocket calls, audio, route state, and
  pinboard drag/resize gestures.

A migration is required if the UI refactor changes persisted world state, not
because it changes presentation. Examples that do require migration handling:

- adding, renaming, removing, or retyping live catalog properties that UI
  components read;
- moving frame-local UI facts into persisted actor/object properties;
- changing seed object names, locations, or class parentage;
- changing observation payload conventions in a way that existing logs,
  replay, or snapshots can no longer feed the new handlers;
- publishing a major catalog version bump.

When a bundled catalog gains UI declarations as part of the first migration
out of `src/client/`, the implementation should include a smoke test for the
catalog's old SPA behavior and new catalog-frame behavior before removing the
legacy renderer. This is a compatibility check, not a data migration.
