import { type ChatFormatterRegistry } from "../../../src/client/framework";

// Plug state changes are deliberately sparse (transition-only), so they belong
// in the room's system feed rather than the generic observation inspector.
// Catalog ownership keeps the core client unaware of block-specific vocabulary.
export function registerWooChatFormatters(registry: ChatFormatterRegistry): void {
  registry.formatter({
    types: ["plug_status_changed"],
    format: (observation) => {
      const state = typeof observation.to === "string" ? observation.to : "changed";
      const text = typeof observation.text === "string" && observation.text
        ? observation.text
        : `Plug status changed to ${state}.`;
      return { kind: "system", text };
    }
  });
}
