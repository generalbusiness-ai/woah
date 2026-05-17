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

The main component should expose the shared companion slot when the current
actor is present in the tool space. Use the shared helpers from
`src/client/framework.ts` so the shell shape and chat-panel preservation stay
the same across catalogs:

```ts
import {
  preserveAmbientCompanionPanel,
  renderAmbientCompanionShell,
  restoreAmbientCompanionPanel
} from "../../../src/client/framework";

const preservedPanel = preserveAmbientCompanionPanel(this, toolId);
this.innerHTML = actorIsPresent
  ? renderAmbientCompanionShell(
      toolId,
      `<section class="tool-workspace has-ambient-companion"
                data-space-chat-layout="${escapeHtml(toolId)}">
         ${workspaceHtml}
       </section>`
    )
  : enterPromptHtml;
restoreAmbientCompanionPanel(this, preservedPanel);
```

If the actor is not present, the component should still render an obvious
Enter control. Enter/Leave controls call the tool space's normal `enter` and
`leave` verbs; they do not invent a parallel presence model.

## Do Not

- Do not hand-roll a second chat panel for a normal tool space.
- Do not omit `regions.chat` from an interactive `space-workspace` frame.
- Do not put mini-chat mounting logic in a catalog-specific branch unless the
  shared host path cannot express the tool.
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
