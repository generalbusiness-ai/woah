export type DubspaceControlRoles = {
  slots?: unknown;
  channel?: unknown;
  filter?: unknown;
  delay?: unknown;
  drum?: unknown;
  scene?: unknown;
  space?: unknown;
};

export const DUBSPACE_DRUM_VOICES = [
  { id: "kick", label: "Kick" },
  { id: "snare", label: "Snare" },
  { id: "hat", label: "Hat" },
  { id: "tone", label: "Tone" }
] as const;

export const PITCH_ROOT_FREQ = 110;
export const PITCH_ROOT_MIDI = 45;
export const PITCH_MIN_SEMITONE = -12;
export const PITCH_MAX_SEMITONE = 36;
export const LOOP_DEFAULT_SEMITONES = [0, 5, 10, 15] as const;
export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"] as const;

const FALLBACK_CONTROL_PROPERTIES = {
  slot: ["loop_id", "playing", "gain", "freq"],
  channel: ["gain"],
  filter: ["cutoff"],
  delay: ["send", "time", "feedback", "wet"],
  drum: ["bpm", "playing", "started_at", "step_count", "pattern"]
} as const;

/** The catalog UI's one control vocabulary. Frame defaults are authoritative
 * when present; fallbacks keep compatibility tests and incomplete third-party
 * frame declarations explicit rather than teaching the substrate any catalog. */
export function dubspaceControlDefinitions(
  roles: DubspaceControlRoles,
  defaults: Record<string, Record<string, unknown>> = {}
): Array<[string, string[]]> {
  const names = (id: string, fallback: readonly string[]): string[] => {
    const declared = defaults[id];
    return declared && typeof declared === "object" && !Array.isArray(declared)
      ? [...new Set([...fallback, ...Object.keys(declared)])]
      : [...fallback];
  };
  return ([
    ...(Array.isArray(roles.slots)
      ? roles.slots.map((value) => {
          const id = String(value ?? "");
          return [id, names(id, FALLBACK_CONTROL_PROPERTIES.slot)] as [string, string[]];
        })
      : []),
    [String(roles.channel ?? ""), names(String(roles.channel ?? ""), FALLBACK_CONTROL_PROPERTIES.channel)],
    [String(roles.filter ?? ""), names(String(roles.filter ?? ""), FALLBACK_CONTROL_PROPERTIES.filter)],
    [String(roles.delay ?? ""), names(String(roles.delay ?? ""), FALLBACK_CONTROL_PROPERTIES.delay)],
    [String(roles.drum ?? ""), names(String(roles.drum ?? ""), FALLBACK_CONTROL_PROPERTIES.drum)]
  ] as Array<[string, string[]]>).filter(([id]) => Boolean(id));
}
