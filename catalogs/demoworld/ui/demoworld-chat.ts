import type { ChatFormatterRegistry, ChatFormatterResult } from "../../../src/client/framework";

const COCKATOO_TYPES = [
  "cockatoo_squawk",
  "cockatoo_muffled",
  "cockatoo_taught",
  "cockatoo_gagged",
  "cockatoo_ungagged",
  "cockatoo_fed",
  "cockatoo_pluck",
  "cockatoo_shake",
  "cockatoo_seen"
];

// All cockatoo_* observations render as system lines. Most carry their
// own text on the wire (squawk / muffled echo the heard phrase) and only
// need the kind override; the rest synthesize narrative text from the
// observation fields here.
export function registerWooChatFormatters(registry: ChatFormatterRegistry): void {
  registry.formatter({
    types: COCKATOO_TYPES,
    format: (observation) => {
      const result: ChatFormatterResult = { kind: "system" };
      const type = String(observation.type ?? "");
      if (type === "cockatoo_seen") result.text = `The cockatoo seems ${String(observation.mood ?? "alert")}.`;
      else if (type === "cockatoo_taught") result.text = `The cockatoo learned "${String(observation.phrase ?? "")}".`;
      else if (type === "cockatoo_gagged") result.text = "The cockatoo is gagged.";
      else if (type === "cockatoo_ungagged") result.text = "The cockatoo is ungagged.";
      else if (type === "cockatoo_fed") result.text = `The cockatoo eats ${String(observation.food ?? "something")}.`;
      else if (type === "cockatoo_pluck") result.text = "*EEEEEEK!*";
      else if (type === "cockatoo_shake") result.text = `The cockatoo ${String(observation.reaction ?? "reacts")}.`;
      // cockatoo_squawk / cockatoo_muffled carry text on the observation;
      // returning kind only lets the frame fall through to observation.text.
      return result;
    }
  });
}
