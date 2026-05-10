import type { ChatFormatterRegistry } from "../../../src/client/framework";

// `note_read` carries the full note body in observation.text. The reader
// wants to see that body inline (so they can re-read the note from chat
// without opening a separate panel); bystanders should get a brief
// "X reads Y." line instead of the entire body dumped into their feed.
// ctx.viewer is the current actor's id, so the formatter can decide which
// view to render without the frame having to know note semantics.
export function registerWooChatFormatters(registry: ChatFormatterRegistry): void {
  registry.formatter({
    types: ["note_read"],
    format: (observation, ctx) => {
      const actor = typeof observation.actor === "string" ? observation.actor : "";
      const isReader = ctx.viewer !== undefined && actor === ctx.viewer;
      if (isReader && typeof observation.text === "string") {
        return { text: observation.text };
      }
      const noteRef = typeof observation.note === "string" ? observation.note : "";
      return { kind: "system", text: `${ctx.label(actor)} reads ${ctx.label(noteRef)}.` };
    }
  });
}
