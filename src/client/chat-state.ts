export type ChatPresenceUpdate = {
  present: string[];
  fromCurrentSpace: boolean;
  handledPresence: boolean;
  shouldPushChatLine: boolean;
};

export function chatObservationSpace(observation: any): string {
  for (const key of ["room", "space", "board", "source"]) {
    const value = observation?.[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
}

export function chatObservationFromCurrentSpace(observation: any, currentSpace: string): boolean {
  const space = chatObservationSpace(observation);
  return !space || space === currentSpace;
}

export function updateEnteredLeftChatPresence(
  present: readonly string[],
  observation: any,
  currentSpace: string
): ChatPresenceUpdate {
  const type = String(observation?.type ?? "");
  const handledPresence = type === "entered" || type === "left";
  const fromCurrentSpace = chatObservationFromCurrentSpace(observation, currentSpace);
  const actor = typeof observation?.actor === "string" ? observation.actor : "";
  let next = [...present];
  if (type === "entered" && fromCurrentSpace && actor && !next.includes(actor)) {
    next = [...next, actor];
  } else if (type === "left" && fromCurrentSpace && actor) {
    next = next.filter((id) => id !== actor);
  }
  return {
    present: next,
    fromCurrentSpace,
    handledPresence,
    shouldPushChatLine: !handledPresence || fromCurrentSpace
  };
}
