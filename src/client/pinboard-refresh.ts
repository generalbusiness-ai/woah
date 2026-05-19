const PINBOARD_OBSERVATION_TYPES = new Set([
  "pinboard_entered",
  "pinboard_left",
  "pinboard_activity",
  "pin_added",
  "pin_removed",
  "pin_moved",
  "pin_resized",
  "pin_recolored",
  "note_added",
  "note_moved",
  "note_resized",
  "note_edited",
  "note_color_changed",
  "note_deleted",
  "notes_cleared"
]);

export function isPinboardObservation(observation: any): boolean {
  return PINBOARD_OBSERVATION_TYPES.has(String(observation?.type ?? ""));
}

export function pinboardObservationNeedsNotesRefresh(type: string): boolean {
  // `pin_added` comes from posting/dropping an existing note and carries only
  // the pin id, so the board still needs list_notes hydration. The note_*
  // observations already carry the fields their reducers apply; refreshing
  // after every edit/add re-renders the composer and can swallow the next Add
  // click if the user is working quickly.
  return type === "pin_added";
}

export function pinboardObservationsNeedNotesRefresh(observations: any[]): boolean {
  const hydratedPins = new Set<string>();
  for (const observation of Array.isArray(observations) ? observations : []) {
    if (String(observation?.type ?? "") !== "note_added") continue;
    const note = observation?.note;
    const id = String((note && typeof note === "object" && !Array.isArray(note) ? note.id : undefined) ?? observation?.pin ?? "");
    if (id) hydratedPins.add(id);
  }
  for (const observation of Array.isArray(observations) ? observations : []) {
    if (!isPinboardObservation(observation) || !pinboardObservationNeedsNotesRefresh(String(observation?.type ?? ""))) continue;
    const pin = String(observation?.pin ?? observation?.note ?? observation?.id ?? "");
    if (!pin || !hydratedPins.has(pin)) return true;
  }
  return false;
}
