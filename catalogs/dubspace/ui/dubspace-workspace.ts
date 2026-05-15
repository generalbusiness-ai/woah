import {
  escapeHtml,
  type ChatFormatterRegistry,
  type ObservationRegistry,
  type WooComponentRegistry,
  type WooContext
} from "../../../src/client/framework";

export type DubspaceControlMap = Record<string, { id?: string; name?: string; props?: Record<string, unknown> }>;

export type DubspaceData = {
  spaceId: string;
  spaceName: string;
  spaceDescription: string;
  controls: DubspaceControlMap;
  slots: string[];
  filter: string;
  delay: string;
  drum: string;
  operators: string[];
  actor: string | null;
  inSpace: boolean;
  canSend: boolean;
  audioOn: boolean;
  cueSlots: Record<string, boolean>;
  cuePlaying: Record<string, boolean>;
};

type DrumVoice = { id: string; label: string };

const DRUM_VOICES: DrumVoice[] = [
  { id: "kick", label: "Kick" },
  { id: "snare", label: "Snare" },
  { id: "hat", label: "Hat" },
  { id: "tone", label: "Tone" }
];

const PITCH_ROOT_FREQ = 110;
const PITCH_ROOT_MIDI = 45;
const PITCH_MIN_SEMITONE = -12;
const PITCH_MAX_SEMITONE = 36;
const LOOP_DEFAULT_SEMITONES = [0, 5, 10, 15];
const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export class WooDubspaceWorkspaceElement extends HTMLElement {
  woo?: WooContext;
  subject?: string;
  private model: DubspaceData = {
    spaceId: "",
    spaceName: "Dubspace",
    spaceDescription: "",
    controls: {},
    slots: [],
    filter: "",
    delay: "",
    drum: "",
    operators: [],
    actor: null,
    inSpace: false,
    canSend: false,
    audioOn: false,
    cueSlots: {},
    cuePlaying: {}
  };

  set data(value: DubspaceData) {
    this.model = value;
    this.render();
  }

  connectedCallback(): void {
    this.render();
  }

  private render(): void {
    const data = this.model;
    const spaceId = data.spaceId || this.subject || "";
    if (!spaceId) {
      this.innerHTML = `
        <section class="toolbar"><h1>Dubspace</h1></section>
        <section class="card"><p class="empty-state">No dubspace catalog instance is installed.</p></section>
      `;
      return;
    }
    if (!data.inSpace) {
      this.innerHTML = `
        <section class="toolbar">
          <h1>${escapeHtml(data.spaceName || "Dubspace")}</h1>
          <button data-dubspace-enter ${data.canSend ? "" : "disabled"}>Enter</button>
        </section>
        <section class="split split--side-fixed dubspace-layout">
          <div class="card">
            <p>${escapeHtml(data.spaceDescription || "Enter the dubspace to work at the controls.")}</p>
          </div>
          ${this.renderPresence()}
        </section>
      `;
      this.bind();
      return;
    }
    const delay = props(data.controls[data.delay]);
    const drum = props(data.controls[data.drum]);
    const pattern = normalizePattern(drum.pattern);
    this.innerHTML = `
      <section class="toolbar dubspace-toolbar">
        <h1>${escapeHtml(data.spaceName || "Dubspace")}</h1>
        <button class="${data.audioOn ? "active" : ""}" data-audio aria-pressed="${data.audioOn}">Audio ${data.audioOn ? "On" : "Off"}</button>
        <button data-save-scene>Save Scene</button>
        <button data-recall-scene>Recall Scene</button>
      </section>
      <section class="ambient-companion-shell" data-ambient-companion-shell="${escapeHtml(spaceId)}">
        <section class="split split--side-fixed dubspace-layout has-ambient-companion" data-space-chat-layout="${escapeHtml(spaceId)}">
          <div class="dubspace-work">
            <div class="grid">
              <article class="card sequencer">
                <div class="card-head">
                  <h2>Percussion</h2>
                  <button data-transport="${drum.playing ? "stop" : "start"}">${drum.playing ? "Stop" : "Start"}</button>
                </div>
                <label>BPM <input data-tempo type="range" min="60" max="200" step="1" value="${escapeHtml(String(numberProp(drum.bpm, 118)))}"><span>${escapeHtml(String(numberProp(drum.bpm, 118)))}</span></label>
                <div class="steps">
                  ${DRUM_VOICES.map((voice) => renderStepRow(voice.id, voice.label, pattern[voice.id])).join("")}
                </div>
              </article>
              <article class="card loop-console-panel">
                <div class="card-head"><h2>Loops</h2></div>
                <div class="loop-console">${data.slots.map((id, index) => this.renderLoopStrip(id, index + 1)).join("")}${this.renderFilterStrip()}</div>
              </article>
              <article class="card">
                <h2>Delay</h2>
                ${slider(data.delay, "send", numberProp(delay.send, 0.3))}
                ${slider(data.delay, "time", numberProp(delay.time, 0.25))}
                ${slider(data.delay, "feedback", numberProp(delay.feedback, 0.35))}
                ${slider(data.delay, "wet", numberProp(delay.wet, 0.4))}
              </article>
            </div>
          </div>
          ${this.renderPresence()}
        </section>
        <div data-ambient-companion></div>
      </section>
    `;
    this.bind();
  }

  private renderPresence(): string {
    const operators = this.model.operators;
    return `
      <aside class="card dubspace-presence">
        <h2>At the controls</h2>
        <div class="presence-list">
          ${operators.map((id) => `<button disabled>${escapeHtml(this.actorLabel(id))}<span>${escapeHtml(id)}</span></button>`).join("") || "<p>No one is at the controls.</p>"}
        </div>
      </aside>
    `;
  }

  private renderFilterStrip(): string {
    const cutoff = numberProp(props(this.model.controls[this.model.filter]).cutoff, 1000);
    return `
      <div class="card card--raised filter-strip">
        <div class="loop-strip-head">
          <strong>F</strong>
          <span>Filter</span>
        </div>
        <input class="vertical-fader" aria-label="Filter cutoff" data-control data-target="${escapeHtml(this.model.filter)}" data-name="cutoff" type="range" min="80" max="5000" step="1" value="${escapeHtml(String(cutoff))}">
        <span class="fader-readout" data-control-readout>${escapeHtml(String(Math.round(cutoff)))} Hz</span>
      </div>
    `;
  }

  private renderLoopStrip(id: string, index: number): string {
    const slot = props(this.model.controls[id]);
    const cue = this.model.cueSlots[id] === true;
    const serverPlaying = slot.playing === true;
    const buttonPlaying = cue ? this.model.cuePlaying[id] === true : serverPlaying;
    const freq = numberProp(slot.freq, defaultLoopFreq(index));
    const pitch = loopPitch(freq);
    return `
      <div class="card card--raised loop-strip ${slot.playing ? "playing" : ""} ${cue ? "cue-active" : ""}">
        <div class="loop-strip-head">
          <strong>${index}</strong>
          <span>${escapeHtml(String(this.model.controls[id]?.name ?? id))}</span>
        </div>
        <button data-loop="${escapeHtml(id)}" data-playing="${buttonPlaying ? "true" : "false"}">${buttonPlaying ? "Stop" : "Start"}</button>
        <input class="vertical-fader" aria-label="Loop ${index} gain" data-control data-target="${escapeHtml(id)}" data-name="gain" type="range" min="0" max="1" step="0.01" value="${escapeHtml(String(numberProp(slot.gain, 0.75)))}">
        <div class="pitch-switch" style="--pitch-angle: ${pitch.angle}deg">
          <div class="pitch-dial" data-pitch-dial aria-hidden="true"><span class="pitch-pointer"></span></div>
          <input class="pitch-switch-input" aria-label="Loop ${index} pitch" data-control data-pitch-input data-target="${escapeHtml(id)}" data-name="freq" type="range" min="${PITCH_MIN_SEMITONE}" max="${PITCH_MAX_SEMITONE}" step="1" value="${pitch.semitone}">
          <div class="pitch-readout"><strong data-pitch-note>${escapeHtml(pitch.note)}</strong><span data-pitch-hz>${escapeHtml(String(Math.round(pitch.freq)))} Hz</span></div>
        </div>
        <button class="cue-button ${cue ? "active" : ""}" data-cue-slot="${escapeHtml(id)}" aria-pressed="${cue}">CUE</button>
      </div>
    `;
  }

  private bind(): void {
    this.querySelector<HTMLButtonElement>("[data-dubspace-enter]")?.addEventListener("click", () => this.dispatch("enter"));
    this.querySelector<HTMLButtonElement>("[data-audio]")?.addEventListener("click", () => this.dispatch("audio"));
    this.querySelectorAll<HTMLButtonElement>("[data-loop]").forEach((button) => {
      button.addEventListener("click", () => this.dispatch("loop", { slot: button.dataset.loop ?? "", playing: button.dataset.playing === "true" }));
    });
    this.querySelectorAll<HTMLButtonElement>("[data-cue-slot]").forEach((button) => {
      button.addEventListener("click", () => this.dispatch("cue", { slot: button.dataset.cueSlot ?? "" }));
    });
    this.querySelectorAll<HTMLInputElement>("[data-control]").forEach((input) => {
      input.addEventListener("input", () => this.dispatch("control-preview", controlDetail(input)));
      input.addEventListener("change", () => this.dispatch("control-commit", controlDetail(input)));
    });
    this.querySelector<HTMLButtonElement>("[data-transport]")?.addEventListener("click", (event) => {
      this.dispatch("transport", { mode: (event.currentTarget as HTMLButtonElement).dataset.transport ?? "" });
    });
    this.querySelector<HTMLInputElement>("[data-tempo]")?.addEventListener("change", (event) => {
      this.dispatch("tempo", { bpm: Number((event.currentTarget as HTMLInputElement).value) });
    });
    this.querySelectorAll<HTMLButtonElement>("[data-step]").forEach((button) => {
      button.addEventListener("click", () => {
        const [voice, step] = String(button.dataset.step ?? "").split(":");
        this.dispatch("step", { voice, step: Number(step), enabled: button.dataset.enabled !== "true" });
      });
    });
    this.querySelector<HTMLButtonElement>("[data-save-scene]")?.addEventListener("click", () => this.dispatch("save-scene"));
    this.querySelector<HTMLButtonElement>("[data-recall-scene]")?.addEventListener("click", () => this.dispatch("recall-scene"));
  }

  private dispatch(kind: string, detail: Record<string, unknown> = {}): void {
    this.dispatchEvent(new CustomEvent(`woo-dubspace-${kind}`, { bubbles: true, detail }));
  }

  private actorLabel(id: string | undefined): string {
    if (!id) return "unknown";
    return String(this.woo?.observe(id)?.name ?? id);
  }
}

function props(obj: { props?: Record<string, unknown> } | undefined): Record<string, unknown> {
  return obj?.props ?? {};
}

function numberProp(value: unknown, fallback: number): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function slider(obj: string, prop: string, value: number): string {
  return `<label>${escapeHtml(prop)} <input data-control data-target="${escapeHtml(obj)}" data-name="${escapeHtml(prop)}" type="range" min="0" max="1" step="0.01" value="${escapeHtml(String(value))}"></label>`;
}

function controlDetail(input: HTMLInputElement): Record<string, unknown> {
  return {
    target: input.dataset.target ?? "",
    name: input.dataset.name ?? "",
    value: controlInputValue(input),
    pitch: input.hasAttribute("data-pitch-input")
  };
}

function controlInputValue(input: HTMLInputElement): number {
  if (input.hasAttribute("data-pitch-input")) {
    return semitoneToFreq(Number(input.value));
  }
  return Number(input.value);
}

function normalizePattern(value: unknown): Record<string, boolean[]> {
  const input = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const out: Record<string, boolean[]> = {};
  for (const voice of DRUM_VOICES) {
    const raw = input[voice.id];
    out[voice.id] = Array.isArray(raw) ? raw.map(Boolean) : new Array(8).fill(false);
  }
  return out;
}

function renderStepRow(voice: string, label: string, steps: boolean[]): string {
  return `
    <div class="step-row">
      <span>${escapeHtml(label)}</span>
      ${steps.map((enabled, index) => `<button class="step ${enabled ? "active" : ""}" data-step="${escapeHtml(`${voice}:${index}`)}" data-enabled="${enabled ? "true" : "false"}" aria-label="${escapeHtml(`${label} step ${index + 1}`)}"></button>`).join("")}
    </div>
  `;
}

function defaultLoopFreq(index: number): number {
  const semitone = LOOP_DEFAULT_SEMITONES[(index - 1) % LOOP_DEFAULT_SEMITONES.length] ?? 0;
  return semitoneToFreq(semitone);
}

function semitoneToFreq(semitone: number): number {
  return PITCH_ROOT_FREQ * Math.pow(2, semitone / 12);
}

function loopPitch(freq: number): { freq: number; semitone: number; note: string; angle: number } {
  const semitone = Math.round(12 * Math.log2(Math.max(1, freq) / PITCH_ROOT_FREQ));
  const midi = PITCH_ROOT_MIDI + semitone;
  const note = `${NOTE_NAMES[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
  const range = PITCH_MAX_SEMITONE - PITCH_MIN_SEMITONE;
  const clamped = Math.max(PITCH_MIN_SEMITONE, Math.min(PITCH_MAX_SEMITONE, semitone));
  return { freq: semitoneToFreq(semitone), semitone, note, angle: -135 + ((clamped - PITCH_MIN_SEMITONE) / range) * 270 };
}

export function registerWooComponents(registry: WooComponentRegistry): void {
  registry.defineTag("woo-dubspace-workspace", WooDubspaceWorkspaceElement);
}

export function registerWooObservationHandlers(registry: ObservationRegistry): void {
  registry.observation({
    types: ["loop_started"],
    route: "both",
    reduce: (draft, envelope) => {
      const slot = String(envelope.observation.slot ?? "");
      if (slot) draft.patchObjectProps(slot, { playing: true });
    }
  });
  registry.observation({
    types: ["loop_stopped"],
    route: "both",
    reduce: (draft, envelope) => {
      const slot = String(envelope.observation.slot ?? "");
      if (slot) draft.patchObjectProps(slot, { playing: false });
    }
  });
  registry.observation({
    types: ["tempo_changed"],
    route: "both",
    reduce: (draft, envelope) => {
      const obs = envelope.observation;
      const target = String(obs.target ?? "");
      const bpm = Number(obs.bpm);
      if (target && Number.isFinite(bpm)) draft.patchObjectProps(target, { bpm });
    }
  });
  registry.observation({
    types: ["transport_started"],
    route: "both",
    reduce: (draft, envelope) => {
      const obs = envelope.observation;
      const target = String(obs.target ?? "");
      if (!target) return;
      const props: Record<string, unknown> = { playing: true };
      const startedAt = Number(obs.started_at);
      const bpm = Number(obs.bpm);
      if (Number.isFinite(startedAt)) props.started_at = startedAt;
      if (Number.isFinite(bpm)) props.bpm = bpm;
      draft.patchObjectProps(target, props);
    }
  });
  registry.observation({
    types: ["transport_stopped"],
    route: "both",
    reduce: (draft, envelope) => {
      const target = String(envelope.observation.target ?? "");
      if (target) draft.patchObjectProps(target, { playing: false });
    }
  });
  registry.observation({
    types: ["drum_step_changed"],
    route: "both",
    reduce: (draft, envelope) => {
      const obs = envelope.observation;
      const target = String(obs.target ?? "");
      const pattern = obs.pattern;
      // Dubspace 0.2.4 made the full pattern snapshot the observation
      // contract; older logs that only carry voice/step/enabled cannot be
      // safely reconstructed inside a deterministic reducer.
      if (target && pattern && typeof pattern === "object" && !Array.isArray(pattern)) draft.patchObjectProps(target, { pattern });
    }
  });
  registry.observation({
    types: ["scene_recalled"],
    route: "both",
    reduce: (draft, envelope) => {
      const controls = envelope.observation.controls;
      if (!controls || typeof controls !== "object" || Array.isArray(controls)) return;
      for (const [target, props] of Object.entries(controls)) {
        if (!props || typeof props !== "object" || Array.isArray(props)) continue;
        draft.patchObjectProps(target, props as Record<string, unknown>);
      }
    }
  });
}

// Dubspace chat lines are presence/activity events, mirroring pinboard's
// shape. The verbs supply observation.text when they have a sentence
// ready; the formatter supplies the fallback.
export function registerWooChatFormatters(registry: ChatFormatterRegistry): void {
  registry.formatter({
    types: ["dubspace_entered", "dubspace_left", "dubspace_activity"],
    format: (observation) => ({
      kind: "system",
      text: typeof observation.text === "string" ? observation.text : "The dubspace changes."
    })
  });
}
