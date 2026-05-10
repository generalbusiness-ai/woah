import type { ChatFormatterRegistry } from "../../../src/client/framework";

// `note_dispersed` is emitted when a dispensed note is dropped into a
// space and recycles. The verb (in catalogs/dispenser/manifest.json's
// $dispensed_note:moveto) puts a fully-formed sentence into observation.text;
// the formatter here just supplies the missing fallback for cases where
// the verb couldn't compute a label (e.g. anonymous drop) and tags the
// line as a system event.
export function registerWooChatFormatters(registry: ChatFormatterRegistry): void {
  registry.formatter({
    types: ["note_dispersed"],
    format: (observation, ctx) => ({
      kind: "system",
      text: typeof observation.text === "string"
        ? observation.text
        : `${ctx.label(typeof observation.note === "string" ? observation.note : undefined)} disperses in a puff of smoke.`
    })
  });
}
