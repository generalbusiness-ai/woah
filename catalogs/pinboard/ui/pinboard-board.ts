import {
  escapeHtml,
  type ChatFormatterRegistry,
  type ObservationRegistry,
  type WooComponentRegistry,
  type WooContext
} from "../../../src/client/framework";

export type PinboardNote = Record<string, unknown> & {
  id?: string;
  text?: unknown;
  x?: unknown;
  y?: unknown;
  w?: unknown;
  h?: unknown;
  z?: unknown;
  color?: unknown;
  owner?: unknown;
  author?: unknown;
  writers?: unknown;
  created_at?: unknown;
  updated_at?: unknown;
  updated_by?: unknown;
};

export type PinboardView = {
  x: number;
  y: number;
  scale: number;
};

export type PinboardViewportPresence = {
  actor: string;
  x: number;
  y: number;
  w: number;
  h: number;
  scale: number;
  at: number;
};

export type PinboardData = {
  boardId: string;
  boardName: string;
  boardOwner?: string;
  notes: PinboardNote[];
  present: string[];
  palette: string[];
  viewport: { w?: unknown; h?: unknown };
  view: PinboardView;
  actor: string | null;
  inBoard: boolean;
  canSend: boolean;
  newText: string;
  newColor: string;
  viewports: Record<string, PinboardViewportPresence>;
};

type PinNoteBox = { x: number; y: number; w: number; h: number };
type PinboardMapModel = { minX: number; minY: number; spanX: number; spanY: number };

const PINBOARD_GRID_SIZE = 32;
const PINBOARD_MAP_DEFAULT_ASPECT = 1.35;

export class WooPinboardBoardElement extends HTMLElement {
  woo?: WooContext;
  subject?: string;
  private model: PinboardData = {
    boardId: "",
    boardName: "Pinboard",
    notes: [],
    present: [],
    palette: ["yellow", "blue", "green", "pink", "white"],
    viewport: { w: 960, h: 560 },
    view: { x: 0, y: 0, scale: 1 },
    actor: null,
    inBoard: false,
    canSend: false,
    newText: "",
    newColor: "yellow",
    viewports: {}
  };

  set data(value: PinboardData) {
    this.model = value;
    this.render();
  }

  connectedCallback(): void {
    this.render();
  }

  private render(): void {
    const boardId = this.model.boardId || this.subject || "";
    if (!boardId) {
      this.innerHTML = `
        <section class="toolbar"><h1>Pinboard</h1></section>
        <section class="panel"><p class="empty-state">No pinboard catalog instance is installed.</p></section>
      `;
      return;
    }
    const viewport = this.model.viewport ?? { w: 960, h: 560 };
    const width = pinNumber(viewport.w, 960);
    const height = pinNumber(viewport.h, 560);
    const toolbar = `
      <section class="toolbar pinboard-toolbar">
        <h1>${escapeHtml(this.model.boardName || "Pinboard")}</h1>
        ${this.model.inBoard ? "" : `<button data-pinboard-enter ${this.model.canSend ? "" : "disabled"}>Enter</button>`}
      </section>
    `;
    const layout = `
      <section class="split split--side-fixed pinboard-layout ${this.model.inBoard ? "has-space-chat" : ""}" data-space-chat-layout="${escapeHtml(boardId)}">
        <div class="pinboard-work">
          ${this.model.inBoard ? this.renderCreate() : `<div class="panel pinboard-create pinboard-create-placeholder" aria-hidden="true"></div>`}
          <div class="panel pinboard-stage-panel">
            <div class="pinboard-stage" data-pinboard-stage style="${pinboardStageStyle(width, height, this.model.view)}">
              <div class="card card--pre pinboard-zoom-controls" aria-label="Pinboard zoom controls">
                <button data-pinboard-zoom="out" aria-label="Zoom out">-</button>
                <span data-pinboard-zoom-label>${Math.round(this.model.view.scale * 100)}%</span>
                <button data-pinboard-zoom="in" aria-label="Zoom in">+</button>
              </div>
              <div class="pinboard-canvas" data-pinboard-canvas style="${pinboardViewStyle(this.model.view)}">
                ${this.model.notes.map((note) => this.renderNote(note)).join("") || `<div class="pinboard-empty">${escapeHtml(this.model.inBoard ? "Add a note to start." : "Enter the pinboard to add or move notes.")}</div>`}
              </div>
            </div>
          </div>
        </div>
        <aside class="panel pinboard-presence">
          <h2>Presence</h2>
          <div data-pinboard-map-shell>${this.renderMap(width, height)}</div>
        </aside>
      </section>
    `;
    this.innerHTML = this.model.inBoard
      ? `${toolbar}<section class="space-chat-shell" data-space-chat-shell="${escapeHtml(boardId)}">${layout}<div data-tool-space-chat></div></section>`
      : `${toolbar}${layout}`;
    this.bind();
  }

  private renderCreate(): string {
    const selected = normalizeColor(this.model.newColor, this.model.palette);
    return `
      <form class="panel pinboard-create" data-pinboard-create>
        <textarea data-pinboard-new-text placeholder="New note">${escapeHtml(this.model.newText)}</textarea>
        <select data-pinboard-new-color>${pinboardPalette(this.model.palette).map((color) => `<option value="${escapeHtml(color)}" ${color === selected ? "selected" : ""}>${escapeHtml(color)}</option>`).join("")}</select>
        <button>Add Note</button>
      </form>
    `;
  }

  private renderNote(note: PinboardNote): string {
    const id = String(note?.id ?? "");
    const box = pinNoteRecordBox(note);
    const z = pinNumber(note?.z, 1);
    const color = pinNoteColor(note, this.model.palette);
    const text = pinNoteText(note?.text);
    const meta = this.pinNoteMeta(note);
    const aria = [text || "Pinboard note", meta.replace(/\n/g, "; ")].filter(Boolean).join("; ");
    const action = this.pinNoteAction(note);
    const writable = this.pinNoteWritable(note);
    return `
      <article class="pin-note pin-note-${escapeHtml(color)}" data-pin-note="${escapeHtml(id)}" data-note-meta="${escapeHtml(meta)}" title="${escapeHtml(meta)}" aria-label="${escapeHtml(aria)}" data-x="${box.x}" data-y="${box.y}" data-w="${box.w}" data-h="${box.h}" style="left:${box.x}px; top:${box.y}px; width:${box.w}px; height:${box.h}px; z-index:${z}">
        <div class="pin-note-head">
          <button class="pin-note-drag" data-pin-note-drag ${this.model.inBoard ? "" : "disabled"} aria-label="Move note">::</button>
          <select data-pin-note-color="${escapeHtml(id)}" ${writable ? "" : "disabled"}>${pinboardPalette(this.model.palette).map((item) => `<option value="${escapeHtml(item)}" ${item === color ? "selected" : ""}>${escapeHtml(item)}</option>`).join("")}</select>
          ${action ? `<button data-pin-note-action="${escapeHtml(action.verb)}" data-pin-note-id="${escapeHtml(id)}" aria-label="${escapeHtml(action.label)}">${escapeHtml(action.text)}</button>` : ""}
        </div>
        <textarea data-pin-note-text="${escapeHtml(id)}" data-original="${escapeHtml(text)}" ${writable ? "" : "readonly"}>${escapeHtml(text)}</textarea>
        <button class="pin-note-resize" data-pin-note-resize ${this.model.inBoard ? "" : "disabled"} aria-label="Resize note"></button>
      </article>
    `;
  }

  private renderMap(width: number, height: number): string {
    const viewports = this.mapViewports(width, height);
    const model = pinboardMapModel(this.model.notes, viewports, width, height);
    return `
      <div class="pinboard-map" data-pinboard-map data-min-x="${roundCss(model.minX)}" data-min-y="${roundCss(model.minY)}" data-span-x="${roundCss(model.spanX)}" data-span-y="${roundCss(model.spanY)}" aria-label="Pinboard overview">
        ${this.model.notes.map((note) => `<div class="pinboard-map-note pin-note-${escapeHtml(pinNoteColor(note, this.model.palette))}" data-pinboard-map-note="${escapeHtml(String(note?.id ?? ""))}" style="${pinboardMapBoxStyle(pinNoteRecordBox(note), model)}"></div>`).join("")}
        ${viewports.map((viewport) => `<button class="pinboard-map-viewport ${viewport.actor === this.model.actor ? "self" : ""}" data-pinboard-viewport="${escapeHtml(viewport.actor)}" title="${escapeHtml(this.actorLabel(viewport.actor))}" aria-label="${escapeHtml(this.actorLabel(viewport.actor))}" style="${pinboardMapBoxStyle(viewport, model)}"></button>`).join("")}
        ${this.model.present.length === 0 ? `<p class="pinboard-map-empty">No one is here.</p>` : ""}
      </div>
    `;
  }

  private mapViewports(width: number, height: number): PinboardViewportPresence[] {
    const presentActors = new Set(this.model.present.map(String));
    const viewports = Object.values(this.model.viewports).filter((viewport) => presentActors.has(viewport.actor));
    if (this.model.actor && presentActors.has(this.model.actor)) {
      viewports.push({ actor: this.model.actor, ...estimatedPinboardViewport(width, height, this.model.view), at: Date.now() });
    }
    return viewports;
  }

  private pinNoteWritable(note: PinboardNote): boolean {
    if (!this.model.inBoard || !this.model.actor) return false;
    const owner = typeof note?.owner === "string" ? note.owner : typeof note?.author === "string" ? note.author : "";
    const writers = Array.isArray(note?.writers) ? note.writers.map(String) : [];
    return owner === this.model.actor || writers.includes(this.model.actor);
  }

  private pinNoteAction(note: PinboardNote): { verb: "take" | "eject"; label: string; text: string } | null {
    if (!this.model.inBoard || !this.model.actor) return null;
    const owner = typeof note?.owner === "string" ? note.owner : typeof note?.author === "string" ? note.author : "";
    if (owner === this.model.actor) return { verb: "take", label: "Take note", text: "x" };
    if (this.model.boardOwner === this.model.actor) return { verb: "eject", label: "Eject note", text: "x" };
    return null;
  }

  private pinNoteMeta(note: PinboardNote): string {
    const author = typeof note?.author === "string" ? this.actorLabel(note.author) : "unknown";
    const created = pinTimestamp(note?.created_at);
    const updatedBy = typeof note?.updated_by === "string" ? this.actorLabel(note.updated_by) : "";
    const updated = pinTimestamp(note?.updated_at);
    const lines = [`Created by ${author}${created ? ` at ${created}` : ""}`];
    if (updatedBy && (note?.updated_by !== note?.author || note?.updated_at !== note?.created_at)) {
      lines.push(`Last edited by ${updatedBy}${updated ? ` at ${updated}` : ""}`);
    }
    return lines.join("\n");
  }

  private bind(): void {
    this.querySelector<HTMLButtonElement>("[data-pinboard-enter]")?.addEventListener("click", () => this.dispatch("enter"));
    this.querySelector<HTMLFormElement>("[data-pinboard-create]")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = this.querySelector<HTMLTextAreaElement>("[data-pinboard-new-text]")?.value ?? "";
      const color = this.querySelector<HTMLSelectElement>("[data-pinboard-new-color]")?.value ?? "";
      this.dispatch("create", { text, color });
    });
    this.querySelector<HTMLTextAreaElement>("[data-pinboard-new-text]")?.addEventListener("input", (event) => this.dispatch("draft", { value: (event.currentTarget as HTMLTextAreaElement).value }));
    this.querySelector<HTMLSelectElement>("[data-pinboard-new-color]")?.addEventListener("change", (event) => this.dispatch("new-color", { color: (event.currentTarget as HTMLSelectElement).value }));
    this.querySelectorAll<HTMLTextAreaElement>("[data-pin-note-text]").forEach((input) => {
      input.addEventListener("blur", () => this.dispatch("note-text", { id: input.dataset.pinNoteText ?? "", text: input.value, original: input.dataset.original ?? "" }));
    });
    this.querySelectorAll<HTMLSelectElement>("[data-pin-note-color]").forEach((select) => {
      select.addEventListener("change", () => this.dispatch("note-color", { id: select.dataset.pinNoteColor ?? "", color: select.value }));
    });
    this.querySelectorAll<HTMLButtonElement>("[data-pin-note-action]").forEach((button) => {
      button.addEventListener("click", () => this.dispatch("note-action", { id: button.dataset.pinNoteId ?? "", verb: button.dataset.pinNoteAction ?? "" }));
    });
  }

  private dispatch(kind: string, detail: Record<string, unknown> = {}): void {
    this.dispatchEvent(new CustomEvent(`woo-pinboard-${kind}`, { bubbles: true, detail }));
  }

  private actorLabel(id: string | undefined): string {
    if (!id) return "unknown";
    return String(this.woo?.observe(id)?.name ?? id);
  }
}

function pinNumber(value: unknown, fallback: number): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function pinboardPalette(palette: unknown): string[] {
  const colors = Array.isArray(palette) ? palette.map(String).filter(Boolean) : [];
  return colors.length > 0 ? colors : ["yellow", "blue", "green", "pink", "white"];
}

function normalizeColor(value: unknown, palette: unknown): string {
  const colors = pinboardPalette(palette);
  return typeof value === "string" && colors.includes(value) ? value : colors[0] ?? "white";
}

function pinNoteColor(note: PinboardNote, palette: unknown): string {
  const colors = pinboardPalette(palette);
  if (typeof note?.color === "string" && colors.includes(note.color)) return note.color;
  if (note?.color == null) return "white";
  return colors[0] ?? "white";
}

function pinNoteText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function pinNoteRecordBox(note: PinboardNote): PinNoteBox {
  return {
    x: pinNumber(note?.x, 40),
    y: pinNumber(note?.y, 40),
    w: pinNumber(note?.w, 180),
    h: pinNumber(note?.h, 110)
  };
}

function pinboardStageStyle(width: number, height: number, view: PinboardView): string {
  return `--pinboard-w:${width}px; --pinboard-h:${height}px; ${pinboardGridStyle(view)}`;
}

function pinboardGridStyle(view: PinboardView): string {
  const grid = PINBOARD_GRID_SIZE * view.scale;
  return `--pinboard-grid-size:${roundCss(grid)}px; --pinboard-grid-x:${roundCss(mod(view.x, grid))}px; --pinboard-grid-y:${roundCss(mod(view.y, grid))}px;`;
}

function pinboardViewStyle(view: PinboardView): string {
  return `transform: translate(${roundCss(view.x)}px, ${roundCss(view.y)}px) scale(${roundCss(view.scale)});`;
}

function mod(value: number, base: number): number {
  return ((value % base) + base) % base;
}

function roundCss(value: number): string {
  return Number.isFinite(value) ? (Math.round(value * 1000) / 1000).toString() : "0";
}

function pinboardMapModel(notes: PinboardNote[], viewports: PinboardViewportPresence[], width: number, height: number): PinboardMapModel {
  const boxes: PinNoteBox[] = notes.map(pinNoteRecordBox);
  boxes.push(...viewports);
  if (boxes.length === 0) boxes.push({ x: 0, y: 0, w: width, h: height });
  const minX = Math.min(...boxes.map((box) => box.x));
  const minY = Math.min(...boxes.map((box) => box.y));
  const maxX = Math.max(...boxes.map((box) => box.x + box.w));
  const maxY = Math.max(...boxes.map((box) => box.y + box.h));
  const padding = Math.max(80, Math.min(240, Math.max(maxX - minX, maxY - minY) * 0.12));
  let spanX = Math.max(1, maxX - minX + padding * 2);
  let spanY = Math.max(1, maxY - minY + padding * 2);
  let paddedMinX = minX - padding;
  let paddedMinY = minY - padding;
  const modelAspect = spanX / spanY;
  if (modelAspect < PINBOARD_MAP_DEFAULT_ASPECT) {
    const nextSpanX = spanY * PINBOARD_MAP_DEFAULT_ASPECT;
    paddedMinX -= (nextSpanX - spanX) / 2;
    spanX = nextSpanX;
  } else if (modelAspect > PINBOARD_MAP_DEFAULT_ASPECT) {
    const nextSpanY = spanX / PINBOARD_MAP_DEFAULT_ASPECT;
    paddedMinY -= (nextSpanY - spanY) / 2;
    spanY = nextSpanY;
  }
  return { minX: paddedMinX, minY: paddedMinY, spanX, spanY };
}

function estimatedPinboardViewport(width: number, height: number, view: PinboardView): PinNoteBox & { scale: number } {
  return {
    x: (0 - view.x) / view.scale,
    y: (0 - view.y) / view.scale,
    w: width / view.scale,
    h: height / view.scale,
    scale: view.scale
  };
}

function pinboardMapBoxStyle(box: PinNoteBox, model: PinboardMapModel): string {
  const left = ((box.x - model.minX) / model.spanX) * 100;
  const top = ((box.y - model.minY) / model.spanY) * 100;
  const width = (box.w / model.spanX) * 100;
  const height = (box.h / model.spanY) * 100;
  return `left:${roundCss(left)}%; top:${roundCss(top)}%; width:${roundCss(width)}%; height:${roundCss(height)}%;`;
}

function pinTimestamp(value: unknown): string {
  return typeof value === "number" && Number.isFinite(value)
    ? new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "";
}

export function registerWooComponents(registry: WooComponentRegistry): void {
  registry.defineTag("woo-pinboard-board", WooPinboardBoardElement);
}

function pinboardNoteState(note: any): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const key of ["x", "y", "z", "w", "h", "text", "color", "author", "owner", "writers"]) {
    if (note?.[key] !== undefined) fields[key] = note[key];
  }
  return fields;
}

function pinboardLayoutState(note: any): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const key of ["x", "y", "z", "w", "h"]) {
    if (note?.[key] !== undefined) fields[key] = note[key];
  }
  return fields;
}

export function registerWooObservationHandlers(registry: ObservationRegistry): void {
  registry.observation({
    types: ["pin_moved", "note_moved", "pin_resized", "note_resized"],
    route: "sequenced",
    reduce: (draft, envelope) => {
      const obs = envelope.observation;
      const pin = String(obs.pin ?? obs.id ?? "");
      if (!pin) return;
      const fields: Record<string, unknown> = {};
      for (const key of ["x", "y", "z", "w", "h"]) {
        const value = Number(obs[key]);
        if (Number.isFinite(value)) fields[key] = value;
      }
      if (Object.keys(fields).length > 0) draft.patchCatalogState(pin, "pinboard_note", fields);
      const board = String(obs.board ?? "");
      // `pinboard_layout` is a sparse per-pin overlay, not a full layout map.
      // Readers must merge it with the board's authoritative props.layout.
      if (board && Object.keys(fields).length > 0) draft.patchCatalogState(board, "pinboard_layout", { [pin]: fields });
    }
  });
  registry.observation({
    types: ["pin_recolored", "note_color_changed"],
    route: "sequenced",
    reduce: (draft, envelope) => {
      const obs = envelope.observation;
      const pin = String(obs.pin ?? obs.note ?? obs.id ?? "");
      if (!pin) return;
      draft.patchCatalogState(pin, "pinboard_note", { color: obs.color });
    }
  });
  // `note_edited` / `note_writers_changed` are emitted by $note's generic write
  // path. The board overlay on a pin mirrors text/writers for fast component
  // access; the underlying obj.props patch happens in the framework's generic
  // handler so non-board surfaces also see the update.
  registry.observation({
    types: ["note_edited"],
    route: "sequenced",
    reduce: (draft, envelope) => {
      const note = String(envelope.observation.note ?? envelope.observation.pin ?? envelope.observation.id ?? "");
      if (note) draft.patchCatalogState(note, "pinboard_note", { text: envelope.observation.text });
    }
  });
  registry.observation({
    types: ["note_writers_changed"],
    route: "sequenced",
    reduce: (draft, envelope) => {
      const note = String(envelope.observation.note ?? envelope.observation.pin ?? envelope.observation.id ?? "");
      if (!note) return;
      const writers = Array.isArray(envelope.observation.writers)
        ? envelope.observation.writers.filter((item) => typeof item === "string")
        : [];
      draft.patchCatalogState(note, "pinboard_note", { writers });
    }
  });
  registry.observation({
    types: ["note_added"],
    route: "sequenced",
    reduce: (draft, envelope) => {
      const note = envelope.observation.note;
      if (!note || typeof note !== "object" || Array.isArray(note)) return;
      const id = String((note as any).id ?? envelope.observation.pin ?? "");
      if (!id) return;
      const board = String(envelope.observation.board ?? "");
      draft.patchObject(id, {
        name: typeof (note as any).name === "string" ? (note as any).name : undefined,
        owner: typeof (note as any).owner === "string" ? (note as any).owner : undefined
      });
      draft.patchCatalogState(id, "pinboard_note", pinboardNoteState(note));
      // `pinboard_layout` entries are sparse overlays keyed by pin id; merge
      // with props.layout before rendering.
      if (board) draft.patchCatalogState(board, "pinboard_layout", { [id]: pinboardLayoutState(note) });
    }
  });
  registry.observation({
    types: ["pin_removed", "note_deleted"],
    route: "sequenced",
    reduce: (draft, envelope) => {
      const id = String(envelope.observation.pin ?? envelope.observation.note ?? envelope.observation.id ?? "");
      if (id) {
        draft.clearAuthoritative(id);
        draft.clearCatalogState(id, "pinboard_note");
      }
      const board = String(envelope.observation.board ?? "");
      if (board && id) draft.patchCatalogState(board, "pinboard_layout", { [id]: null });
    }
  });
  registry.observation({
    types: ["pinboard_entered", "pinboard_left"],
    route: "sequenced",
    reduce: (draft, envelope) => {
      const board = String(envelope.observation.board ?? "");
      const actor = String(envelope.observation.actor ?? "");
      if (!board || !actor) return;
      draft.patchCatalogState(board, "pinboard_presence", {
        [actor]: envelope.observation.type === "pinboard_left" ? false : true
      });
    }
  });
  registry.observation({
    types: ["notes_cleared"],
    route: "sequenced",
    reduce: (draft, envelope) => {
      for (const id of Array.isArray(envelope.observation.notes) ? envelope.observation.notes : []) {
        if (typeof id === "string" && id) draft.clearCatalogState(id, "pinboard_note");
      }
    }
  });
}

// Pinboard chat lines are presence/activity events: who entered or left
// the board, and a generic "the pinboard changes" beat for unspecified
// activity. The verbs put a fully-formed sentence into observation.text
// when they have one (e.g. "<actor> joins the pinboard"); the formatter
// supplies the fallback.
export function registerWooChatFormatters(registry: ChatFormatterRegistry): void {
  registry.formatter({
    types: ["pinboard_entered", "pinboard_left", "pinboard_activity"],
    format: (observation) => ({
      kind: "system",
      text: typeof observation.text === "string" ? observation.text : "The pinboard changes."
    })
  });
}
