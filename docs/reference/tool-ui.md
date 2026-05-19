# Tool UI

Tool catalogs should use the same workspace shape unless they have a
documented reason not to. This keeps new tools easy to build and keeps the
client from growing one-off behavior for every catalog.

## Default Pattern

A normal interactive tool is a `$space` descendant with a `space-workspace`
frame:

```json
{
  "id": "example.workspace",
  "subject": "$example_tool",
  "view": "default",
  "layout": "space-workspace",
  "regions": {
    "main": [{ "component": "example.workspace", "subject": "this" }],
    "chat": [{ "component": "chat:chat.space-mini", "subject": "this" }]
  }
}
```

The tool's main component owns only the tool-specific work area. The host owns
the shared mini-chat behavior: routing messages to the tool space, refreshing
chat lines, focus handling, resize/collapse state, and preserving the mounted
chat panel across rerenders.

## Main Component

The host renders any object whose catalog resolves to a `space-workspace` frame
through the generic tool path. A new catalog should not need a new `main.ts`
tab branch: its component receives `element.subject` and `element.woo`, then
hydrates itself by calling or observing its subject through `WooContext`.

The main component routes its HTML through `renderToolFrame` from
`src/client/framework.ts`. That single helper owns the toolbar + chat-slot
pairing — the shape that keeps the mini-chat panel anchored identically
across pinboard, dubspace, tasks, and outliner. **Do not call
`renderAmbientCompanionShell` directly from a tool catalog**; `renderToolFrame`
wraps it and bundles the `.toolbar` envelope assumption the
`.ambient-companion-shell` height budget depends on.

```ts
import {
  escapeHtml,
  preserveAmbientCompanionPanel,
  renderToolFrame,
  restoreAmbientCompanionPanel
} from "../../../src/client/framework";

const preservedPanel = preserveAmbientCompanionPanel(this, toolId);
this.innerHTML = renderToolFrame({
  subject: toolId,
  toolbar: `
    <section class="toolbar example-toolbar">
      <h1>${escapeHtml(toolName)}</h1>
      ${actorIsPresent
        ? `<button data-example-leave>Leave</button>`
        : `<button data-example-enter>Enter</button>`}
    </section>
  `,
  layoutClass: "example-layout",
  layoutBody: `
    <div class="example-work">${workspaceHtml}</div>
    ${this.renderPresence()}
  `,
  showChat: actorIsPresent
});
restoreAmbientCompanionPanel(this, preservedPanel);
```

Contract:

- **Toolbar** must be a `<section class="toolbar TOOL-toolbar">` with an
  `<h1>` title — the shell's `height: calc(100dvh - 5.25rem)` budget is
  tuned to the shared `.toolbar` envelope (~2.125rem min-height + 1rem
  margin-bottom). Bespoke headers drift the chat panel; use the shared
  class.
- **Layout class** is the tool-specific split modifier
  (e.g. `pinboard-layout`, `outliner-layout`); `renderToolFrame` adds
  `split split--side-fixed` and toggles `has-ambient-companion`.
- **Layout body** is the inner HTML of the split: the work area on the
  left, the presence aside on the right.
- **Chat slot** is provisioned by `renderToolFrame` itself; the host
  later calls `mountAmbientCompanion` to drop the live mini-chat panel
  into the slot.
- Avoid `white-space: normal` inline content in the toolbar; labels with
  multi-token content (checkbox + text) should set
  `display: inline-flex; white-space: nowrap` so they can't wrap and
  blow the 2.125rem envelope.

Enter/Leave controls call the tool space's normal `enter` and `leave`
verbs through `this.woo.call(this.subject, "enter", [])` or
`this.woo.call(this.subject, "leave", [])`; they do not invent a parallel
presence model.

## Do Not

- Do not hand-roll a second chat panel for a normal tool space.
- Do not omit `regions.chat` from an interactive `space-workspace` frame.
- Do not call `renderAmbientCompanionShell` directly — go through
  `renderToolFrame` so the toolbar/shell pairing stays centralized.
- Do not introduce a per-tool wrapper around the split (e.g. the
  retired `.woo-tasks-workspace` / `.outliner-workspace` wrappers).
  The `.split.has-ambient-companion` rule supplies the workspace
  envelope for every tool.
- Do not use a bespoke header element (e.g. `<header class="X-header">`
  with `<h2>`); the `.toolbar`/`<h1>` pattern is what the
  `.ambient-companion-shell` height budget is tuned to.
- Do not put mini-chat mounting logic in a catalog-specific branch unless the
  shared host path cannot express the tool.
- Do not add a new `main.ts` render/bind branch for a tool whose main
  component can hydrate from `WooContext`.
- Do not store presence only in client-local state.
- Do not copy a tool's domain UI as the pattern. Copy the frame shape and
  workspace shell contract; the domain UI should remain catalog-specific.

## Current Examples

Use these as examples of the shared contract:

- `catalogs/pinboard/manifest.json` + `catalogs/pinboard/ui/pinboard-board.ts`
- `catalogs/dubspace/manifest.json` + `catalogs/dubspace/ui/dubspace-workspace.ts`
- `catalogs/tasks/manifest.json` + `catalogs/tasks/ui/kanban-board.ts`
- `catalogs/outliner/manifest.json` + `catalogs/outliner/ui/outliner-tree.ts`

The guard `npm run guard:tool-workspace-ui` checks bundled
`space-workspace` tool frames for the required `main` and shared mini-chat
regions.
