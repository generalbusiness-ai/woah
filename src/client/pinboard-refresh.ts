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
