// The live pinboard vocabulary. Note-geometry/colour changes are carried by
// the pin_* types (pin_moved / pin_resized / pin_recolored); the older
// note_moved / note_resized / note_color_changed / note_deleted / notes_cleared
// names were emitted by nothing and declared in no schema (ghost vocabulary),
// so they are not part of the ledger.
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
  "note_edited"
]);

export function isPinboardObservation(observation: any): boolean {
  return PINBOARD_OBSERVATION_TYPES.has(String(observation?.type ?? ""));
}
