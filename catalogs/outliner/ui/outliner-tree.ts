import {
  escapeHtml,
  preserveAmbientCompanionPanel,
  renderToolFrame,
  restoreAmbientCompanionPanel,
  type ChatFormatterRegistry,
  type ObservationRegistry,
  type WooComponentRegistry,
  type WooContext
} from "../../../src/client/framework";

// Inline SVG icons for the row controls. Kept here (rather than as
// classes referencing background-image rules in styles.css) so they
// stroke in `currentColor` and follow the row's text colour — including
// the muted look the row picks up when `.is-hidden` strikes the text
// through. Same lucide vocabulary used by other catalog UIs.
const ICON_TRASH =
  `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`
  + `<path d="M3 6h18"/>`
  + `<path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>`
  + `<path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>`
  + `<path d="M10 11v6"/>`
  + `<path d="M14 11v6"/>`
  + `</svg>`;
const ICON_PLUS_SQUARE =
  `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`
  + `<rect x="3" y="3" width="18" height="18" rx="2"/>`
  + `<path d="M12 8v8"/>`
  + `<path d="M8 12h8"/>`
  + `</svg>`;
// Twistie chevrons render larger and bolder than the secondary
// trash/add-child icons — they're the row's primary structural
// affordance, so they want visual weight.
const ICON_CHEVRON_RIGHT =
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`
  + `<path d="M9 6l6 6-6 6"/>`
  + `</svg>`;
const ICON_CHEVRON_DOWN =
  `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">`
  + `<path d="M6 9l6 6 6-6"/>`
  + `</svg>`;

// Single row delivered by $outliner:list_items. Shape mirrors the joined
// view; positions are server-internal and not exposed here.
export type OutlinerItem = {
  id: string;
  name: string;
  text: string;
  parent_id: string | null;
  index: number;
  hidden: boolean;
  owner: string;
  writers: string[];
  has_children: boolean;
};

// One row delivered by $outliner:room_roster — the same shape chat/dubspace
// use. `presence` ("online" / "idle" / "offline") drives the dot class.
export type OutlinerRosterRow = {
  id: string;
  name?: string;
  presence?: string;
  idle_seconds?: number;
};

export type OutlinerData = {
  outlinerId: string;
  outlinerName: string;
  items: OutlinerItem[];
  focus: string | null;
  actor: string | null;
  roster: OutlinerRosterRow[];
};

// Component-local UI state lives on the element itself (collapse, edit,
// show-hidden). The server is the source of truth for everything in
// OutlinerData; whenever it changes, the element re-renders.
export class WooOutlinerTreeElement extends HTMLElement {
  woo?: WooContext;
  subject?: string;

  private model: OutlinerData = { outlinerId: "", outlinerName: "Outline", items: [], focus: null, actor: null, roster: [] };
  private companionVisible = false;
  private collapsed = new Set<string>();
  private showHidden = false;
  private editing: { id: string; original: string } | null = null;
  // Client-local selection. The row the user has clicked on; drives the
  // is-focused highlight, the inline `+` add-child affordance, and the
  // click-again-to-edit gesture. NOT round-tripped through the server —
  // server-side $outliner.focus_by_actor is a separate capability for
  // chat/MCP users who don't have a live selection state of their own.
  // Clears automatically if the selected item disappears from the tree.
  private selectedId: string | null = null;
  // True while the inline new-child editor (anchored below the selected
  // row) is open. Always paired with a non-null `selectedId`.
  private addingChild = false;
  private dragSourceId: string | null = null;
  private hydrating = false;
  private hydratePending = false;
  private hydrateAttempted = false;
  private bound = false;

  set data(value: OutlinerData) {
    this.model = value;
    this.render();
  }

  set showCompanion(value: boolean) {
    const next = Boolean(value);
    if (this.companionVisible === next) return;
    this.companionVisible = next;
    this.render();
  }

  connectedCallback(): void {
    // If the host hasn't pre-populated `data`, hydrate ourselves from the
    // outliner. This keeps the component runnable without any host-side
    // integration code in main.ts. Guard with `hydrateAttempted` so a
    // genuinely empty outliner doesn't loop hydrate → applied-frame →
    // rerender → connectedCallback → hydrate when the SPA preserves the
    // element across renders.
    if (!this.hydrateAttempted && this.subject && this.woo) {
      this.hydrate().catch(() => undefined);
    }
    this.render();
  }

  async hydrate(): Promise<void> {
    if (!this.woo || !this.subject) return;
    if (this.hydrating) {
      // Coalesce a concurrent caller — typical race: observation reducer
      // fires `outline_item_added` while the initial hydrate is still
      // resolving list_items. Dropping the second hydrate would freeze the
      // UI on the pre-mutation snapshot.
      this.hydratePending = true;
      return;
    }
    this.hydrating = true;
    this.hydrateAttempted = true;
    try {
      do {
        this.hydratePending = false;
        // Read-side query: directCall resolves with the verb's actual return
        // value. (`woo.call` is fire-and-forget and resolves with the request
        // id — the reply lands via the observation reducer, not this promise.)
        // Roster fetched in parallel with list_items — both are independent
        // RX verbs on the outliner space.
        const [items, roster] = await Promise.all([
          this.woo.directCall(this.subject, "list_items", []),
          this.woo.directCall(this.subject, "room_roster", []).catch(() => [])
        ]);
        const projection = this.woo.observe(this.subject);
        const focusMap = (projection?.props?.focus_by_actor ?? {}) as Record<string, string | null>;
        const actor = this.woo.actor;
        const focus = actor ? focusMap[actor] ?? null : null;
        // The display title is the object's own name (e.g. "Outline" from the
        // seed). `props.name` is not the same field — for inherited classes it
        // can surface the parent class's own name (e.g. "$space") and produce
        // the wrong title in the header.
        const objectName = projection?.name;
        this.model = {
          outlinerId: this.subject,
          outlinerName: typeof objectName === "string" && objectName ? objectName : "Outline",
          items: Array.isArray(items) ? (items as OutlinerItem[]) : [],
          focus,
          actor,
          roster: Array.isArray(roster) ? (roster as OutlinerRosterRow[]) : []
        };
        this.render();
      } while (this.hydratePending);
    } finally {
      this.hydrating = false;
    }
  }

  private render(): void {
    if (!this.bound) {
      this.bound = true;
      this.addEventListener("click", this.onClick);
      this.addEventListener("change", this.onChange);
      this.addEventListener("submit", this.onSubmit);
      this.addEventListener("keydown", this.onKeyDown);
      this.addEventListener("dragstart", this.onDragStart);
      this.addEventListener("dragover", this.onDragOver);
      this.addEventListener("drop", this.onDrop);
      this.addEventListener("dragend", this.onDragEnd);
    }
    const data = this.model;
    // If the selected item is no longer in the tree (someone deleted it,
    // or it moved to a different outliner) drop the selection so the
    // is-focused highlight and inline + don't dangle. Also closes any
    // pending add-child surface that was anchored to it.
    if (this.selectedId && !data.items.some((it) => it.id === this.selectedId)) {
      this.selectedId = null;
      this.addingChild = false;
    }
    const outlinerId = data.outlinerId || this.subject || "";
    const visibleItems = this.computeVisibleItems(data.items);
    const preservedPanel = preserveAmbientCompanionPanel(this, outlinerId);
    // Preserve in-flight form input across re-renders. Without this, a
    // hydrate (or any observation-triggered re-render) wipes the user's
    // typed text mid-keystroke and any submit afterwards fires with an
    // empty value. The renderRow path handles its own edit form because
    // the editing target id is tracked in `this.editing`; the add-child
    // form has its own snapshot below.
    const addInputValue = this.querySelector<HTMLInputElement>("[data-outliner-add] input[name=text]")?.value ?? "";
    const addChildInputValue = this.addingChild
      ? this.querySelector<HTMLInputElement>("[data-outliner-add-child] input[name=text]")?.value ?? ""
      : "";
    const focusedSelector = (() => {
      const active = document.activeElement;
      if (!active || !this.contains(active)) return null;
      if (active.matches("[data-outliner-add] input[name=text]")) return "add";
      if (active.matches("[data-outliner-add-child] input[name=text]")) return "add-child";
      return null;
    })();
    // Toolbar uses the shared `.toolbar` shape — same as
    // pinboard / dubspace / tasks. The ambient-companion-shell's height budget
    // (calc(100dvh - 5.25rem)) is tuned to the .toolbar envelope; any bespoke
    // header drifts the chat panel anchor, so route through renderToolFrame.
    // When something is selected, a small "clear selection" button gives
    // the user a discoverable way back to "nothing selected" (the keyboard
    // alternative is Escape). No reference to server-side focus appears
    // here — that's a separate capability used by chat/MCP, not by this UI.
    const clearSelection = this.selectedId
      ? `<button type="button" class="outliner-clear-selection" data-outliner-action="clear-selection" title="clear selection">clear selection ✕</button>`
      : "";
    const toolbar = `
      <section class="toolbar outliner-toolbar">
        <h1>${escapeHtml(data.outlinerName)}</h1>
        <button type="button" data-outliner-presence="${this.companionVisible ? "leave" : "enter"}">${this.companionVisible ? "Leave" : "Enter"}</button>
        <label class="outliner-toggle">
          <input type="checkbox" data-outliner-show-hidden ${this.showHidden ? "checked" : ""}>
          show hidden
        </label>
        <button type="button" data-outliner-action="undo">Undo</button>
        ${clearSelection}
      </section>
    `;
    // Top add form is only useful at root. When something is selected, the
    // user creates children "in place" via the + button on the selected
    // row, so hiding the top form removes ambiguity about which parent a
    // new item would land under.
    const topAdd = this.selectedId == null
      ? `<form class="outliner-add" data-outliner-add>
          <input type="text" name="text" placeholder="add an item…" autocomplete="off" value="${escapeHtml(addInputValue)}">
          <button type="submit">Add</button>
        </form>`
      : "";
    // Walk visibleItems once and splice the add-child placeholder in right
    // after the selected row. Building this inline (rather than overriding
    // computeVisibleItems) keeps the placeholder a UI-only concern.
    const rowsHtml: string[] = [];
    for (const item of visibleItems) {
      rowsHtml.push(this.renderRow(item, data));
      if (this.addingChild && this.selectedId && item.id === this.selectedId) {
        rowsHtml.push(this.renderAddChildRow(item.depth + 1, addChildInputValue));
      }
    }
    const tree = `
      <section class="outliner">
        ${topAdd}
        <ul class="outliner-rows" data-outliner-rows>
          ${rowsHtml.join("")}
        </ul>
      </section>
    `;
    this.innerHTML = renderToolFrame({
      subject: outlinerId,
      toolbar,
      layoutClass: "outliner-layout",
      layoutBody: `${tree}${this.renderPresence(data)}`,
      showChat: this.companionVisible
    });
    restoreAmbientCompanionPanel(this, preservedPanel);
    if (focusedSelector === "add") {
      const input = this.querySelector<HTMLInputElement>("[data-outliner-add] input[name=text]");
      if (input) {
        input.focus();
        // Restore caret to end so typing continues naturally.
        const end = input.value.length;
        input.setSelectionRange(end, end);
      }
    } else if (focusedSelector === "add-child" || this.addingChild) {
      const input = this.querySelector<HTMLInputElement>("[data-outliner-add-child] input[name=text]");
      if (input) {
        input.focus();
        const end = input.value.length;
        input.setSelectionRange(end, end);
      }
    }
  }

  // Right-side presence aside, same shape as chat-presence / dubspace-presence.
  // The roster comes from `room_roster()` on the outliner (server-authoritative
  // list of $actors currently in the space); we don't try to reconcile with
  // a client-side scoped projection here because the outliner is browsable
  // before the viewer enters, and the chat presence list is the wrong scope
  // in that case.
  private renderPresence(data: OutlinerData): string {
    const rows = Array.isArray(data.roster) ? data.roster : [];
    const buttons = rows.map((row) => {
      const id = typeof row?.id === "string" ? row.id : "";
      if (!id) return "";
      return `<button disabled>${escapeHtml(this.actorLabel(row))}<span>${escapeHtml(id)}</span></button>`;
    }).join("");
    return `
      <aside class="card outliner-presence">
        <h2>Presence</h2>
        <div class="presence-list">
          ${buttons || "<p>No one is here.</p>"}
        </div>
      </aside>
    `;
  }

  private actorLabel(row: OutlinerRosterRow): string {
    if (row?.name) return String(row.name);
    const projected = this.woo?.observe(row.id);
    if (projected?.name) return String(projected.name);
    return String(row?.id ?? "unknown");
  }

  private computeVisibleItems(items: OutlinerItem[]): Array<OutlinerItem & { depth: number }> {
    // The server returns depth-first order with each row's parent_id; we
    // compute the depth here and drop subtrees whose parent is collapsed
    // or hidden (when show-hidden is off).
    const childrenOf = new Map<string | null, OutlinerItem[]>();
    for (const item of items) {
      const key = item.parent_id;
      const list = childrenOf.get(key) ?? [];
      list.push(item);
      childrenOf.set(key, list);
    }
    const out: Array<OutlinerItem & { depth: number }> = [];
    const walk = (parent: string | null, depth: number, ancestorHidden: boolean) => {
      const kids = childrenOf.get(parent) ?? [];
      for (const kid of kids) {
        const isHidden = ancestorHidden || (kid.hidden && !this.showHidden);
        if (!isHidden) out.push({ ...kid, depth });
        if (!this.collapsed.has(kid.id)) {
          walk(kid.id, depth + 1, ancestorHidden || (kid.hidden && !this.showHidden));
        }
      }
    };
    walk(null, 0, false);
    return out;
  }

  private renderRow(item: OutlinerItem & { depth: number }, _data: OutlinerData): string {
    const id = item.id;
    const isFocused = this.selectedId === id;
    const isEditing = this.editing?.id === id;
    const collapsed = this.collapsed.has(id);
    const indent = item.depth * 20;
    // The three row controls (twistie, add-child, remove) are icon buttons:
    // flat by default, subtle background tint on hover. Markup uses the
    // shared `.icon-button` class so the global `button {…}` chrome
    // (border, padding, radius) is overridden in one place.
    const twistie = item.has_children
      ? `<button type="button" class="icon-button outliner-twistie" data-outliner-action="toggle-collapse" data-id="${escapeHtml(id)}" aria-label="${collapsed ? "expand" : "collapse"}">${collapsed ? ICON_CHEVRON_RIGHT : ICON_CHEVRON_DOWN}</button>`
      : `<span class="outliner-twistie outliner-twistie-empty" aria-hidden="true"></span>`;
    // The row itself is the focus/edit affordance now — clicking the text
    // span bubbles up to the row-level handler, which focuses an unfocused
    // row or starts editing an already-focused row. No data-outliner-action
    // on the span so it can't double-fire with the row click.
    const textCell = isEditing
      ? `<form class="outliner-edit" data-outliner-edit data-id="${escapeHtml(id)}"><input type="text" name="text" value="${escapeHtml(item.text)}" autofocus></form>`
      : `<span class="outliner-text">${escapeHtml(item.text || "(empty)")}</span>`;
    // The + (plus-square) button only sits on the selected row. Add-in-
    // place means "add a child of this row," so the button on any other
    // row would be ambiguous about the parent.
    const addChildBtn = isFocused
      ? `<button type="button" class="icon-button outliner-add-child-btn" data-outliner-action="add-child" data-id="${escapeHtml(id)}" aria-label="add child" title="add child">${ICON_PLUS_SQUARE}</button>`
      : "";
    const hiddenClass = item.hidden ? " is-hidden" : "";
    const focusClass = isFocused ? " is-focused" : "";
    return `
      <li class="outliner-row${hiddenClass}${focusClass}" data-outliner-row data-id="${escapeHtml(id)}" draggable="true" style="--indent: ${indent}px">
        <span class="outliner-row-inner">
          ${twistie}
          <input type="checkbox" data-outliner-hide data-id="${escapeHtml(id)}" ${item.hidden ? "checked" : ""} title="hide">
          ${textCell}
          ${addChildBtn}
          <button type="button" class="icon-button outliner-remove-btn" data-outliner-action="remove" data-id="${escapeHtml(id)}" aria-label="remove" title="remove">${ICON_TRASH}</button>
        </span>
      </li>
    `;
  }

  // Pseudo-row rendered directly below the focus row when addingChild is
  // true. The submit handler reads `add` (which defaults parent to the
  // actor's focus on the server), so we don't need to thread the parent id
  // through the form.
  private renderAddChildRow(depth: number, value: string): string {
    const indent = depth * 20;
    return `
      <li class="outliner-row outliner-row-pending" data-outliner-add-child-row style="--indent: ${indent}px">
        <span class="outliner-row-inner">
          <span class="outliner-twistie outliner-twistie-empty">·</span>
          <form class="outliner-edit outliner-add-child" data-outliner-add-child>
            <input type="text" name="text" placeholder="new child…" autocomplete="off" value="${escapeHtml(value)}">
          </form>
        </span>
      </li>
    `;
  }

  private onClick = async (event: Event): Promise<void> => {
    const target = event.target as HTMLElement;
    const presence = target.closest<HTMLElement>("[data-outliner-presence]");
    if (presence) {
      event.preventDefault();
      const action = presence.dataset.outlinerPresence === "leave" ? "leave" : "enter";
      await this.callVerb(action, []);
      return;
    }
    const btn = target.closest<HTMLElement>("[data-outliner-action]");
    if (btn) {
      event.preventDefault();
      const action = btn.dataset.outlinerAction;
      const id = btn.dataset.id ?? null;
      if (action === "toggle-collapse" && id) {
        if (this.collapsed.has(id)) this.collapsed.delete(id);
        else this.collapsed.add(id);
        this.render();
        return;
      }
      if (action === "remove" && id) {
        await this.callVerb("remove_item", [id]);
        return;
      }
      if (action === "undo") {
        await this.callVerb("undo", []);
        return;
      }
      if (action === "clear-selection") {
        // Pure client-side state reset — no server call, no round trip.
        this.selectedId = null;
        this.addingChild = false;
        this.render();
        return;
      }
      if (action === "add-child" && id) {
        // Only the selected row carries this button; refuse to open the
        // placeholder against a stale id in case selection changed between
        // render and click.
        if (this.selectedId !== id) return;
        this.addingChild = !this.addingChild;
        // Expand the selected row when opening, so the new child is
        // visible when it arrives. Closing leaves collapse state alone.
        if (this.addingChild) this.collapsed.delete(id);
        this.render();
        return;
      }
      return;
    }
    // Row click — select an unselected row, edit an already-selected row.
    // Skip interactive descendants (buttons, the hide checkbox, any open
    // form) so clicking those keeps their own behavior.
    if (target.closest("button, input, form")) return;
    const row = target.closest<HTMLElement>("[data-outliner-row]");
    if (!row) return;
    const id = row.dataset.id;
    if (!id) return;
    event.preventDefault();
    if (this.selectedId === id) {
      // Already selected: enter edit mode. Bail if we're already editing
      // this row so a stray click doesn't restart the editor.
      if (this.editing?.id === id) return;
      const item = this.model.items.find((it) => it.id === id);
      if (!item) return;
      this.editing = { id, original: item.text };
      this.addingChild = false;
      this.render();
      // Only one row carries data-outliner-edit at a time (this.editing is
      // a single record), so a plain selector is enough — no need to encode
      // the id into the selector and reach for CSS.escape.
      const input = this.querySelector<HTMLInputElement>("[data-outliner-edit] input[name='text']");
      input?.focus();
      input?.select();
      input?.addEventListener("blur", () => this.commitEdit(input.value, id), { once: true });
      return;
    }
    // Not selected: select it (client-local). No server call, no waiting
    // for a hydrate — the highlight and the + button appear immediately.
    this.selectedId = id;
    this.addingChild = false;
    this.render();
  };

  // Component-level Escape handler. Closes the active inline editor — the
  // existing edit form keeps its own per-click blur binding for commit, but
  // routing Escape through one place lets the new add-child surface share
  // the same cancel gesture without re-binding on every render. When no
  // editor is open, Escape clears the row selection as a keyboard-only
  // alternative to the toolbar's "clear selection" button.
  private onKeyDown = (event: KeyboardEvent): void => {
    if (event.key !== "Escape") return;
    const target = event.target as HTMLElement;
    if (target.closest("[data-outliner-add-child]")) {
      this.addingChild = false;
      this.render();
      return;
    }
    if (target.closest("[data-outliner-edit]")) {
      this.editing = null;
      this.render();
      return;
    }
    if (this.selectedId) {
      this.selectedId = null;
      this.addingChild = false;
      this.render();
    }
  };

  private onChange = async (event: Event): Promise<void> => {
    const target = event.target as HTMLElement;
    if (target.matches?.("[data-outliner-show-hidden]")) {
      this.showHidden = (target as HTMLInputElement).checked;
      this.render();
      return;
    }
    if (target.matches?.("[data-outliner-hide]")) {
      const id = (target as HTMLInputElement).dataset.id;
      if (!id) return;
      const checked = (target as HTMLInputElement).checked;
      await this.callVerb("hide", [id, checked]);
    }
  };

  private onSubmit = async (event: Event): Promise<void> => {
    const form = event.target as HTMLFormElement;
    if (form.matches?.("[data-outliner-add]")) {
      event.preventDefault();
      const input = form.querySelector<HTMLInputElement>("input[name=text]");
      const text = input?.value.trim() ?? "";
      if (!text) return;
      if (input) input.value = "";
      await this.callVerb("add", [text]);
      return;
    }
    if (form.matches?.("[data-outliner-add-child]")) {
      event.preventDefault();
      const input = form.querySelector<HTMLInputElement>("input[name=text]");
      const text = input?.value.trim() ?? "";
      if (!text) {
        // Empty submit acts as cancel — closes the inline editor rather
        // than raising E_INVARG on the server.
        this.addingChild = false;
        this.render();
        return;
      }
      // The selected row is the new item's parent. Snapshot it and close
      // the surface up front so the post-add hydrate doesn't briefly
      // re-render the placeholder with the just-submitted text.
      const parentId = this.selectedId;
      this.addingChild = false;
      // Pass the parent explicitly so this doesn't depend on the actor's
      // server-side focus (which the browser UI no longer drives).
      await this.callVerb("add_item", [text, parentId]);
      return;
    }
    if (form.matches?.("[data-outliner-edit]")) {
      event.preventDefault();
      const id = (form as HTMLFormElement).dataset.id;
      const input = form.querySelector<HTMLInputElement>("input[name=text]");
      if (id && input) await this.commitEdit(input.value, id);
    }
  };

  private async commitEdit(value: string, id: string): Promise<void> {
    const editing = this.editing;
    this.editing = null;
    if (!editing || editing.original === value) {
      this.render();
      return;
    }
    await this.callVerb("set_item_text", [id, value]);
  }

  private onDragStart = (event: DragEvent): void => {
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-outliner-row]");
    if (!row) return;
    this.dragSourceId = row.dataset.id ?? null;
    if (event.dataTransfer && this.dragSourceId) {
      event.dataTransfer.setData("text/plain", this.dragSourceId);
      event.dataTransfer.effectAllowed = "move";
    }
  };

  private onDragOver = (event: DragEvent): void => {
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-outliner-row]");
    if (!row || !this.dragSourceId) return;
    event.preventDefault();
  };

  private onDrop = async (event: DragEvent): Promise<void> => {
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-outliner-row]");
    if (!row || !this.dragSourceId) return;
    event.preventDefault();
    const dropTarget = row.dataset.id;
    const sourceId = this.dragSourceId;
    this.dragSourceId = null;
    if (!dropTarget || sourceId === dropTarget) return;
    // Drop onto a node: move under that node at the end.
    await this.callVerb("move_item", [sourceId, dropTarget, null]);
  };

  private onDragEnd = (): void => {
    this.dragSourceId = null;
  };

  private async callVerb(verb: string, args: unknown[]): Promise<unknown> {
    if (!this.woo || !this.subject) return null;
    try {
      const result = await this.woo.call(this.subject, verb, args);
      // Re-hydrate after any mutation. Cheap enough for v0 — replace with
      // observation-driven patching once measurements demand it.
      void this.hydrate();
      return result;
    } catch (err) {
      // Surface the error to the user as inline status text rather than
      // throwing into the browser console.
      const banner = document.createElement("div");
      banner.className = "outliner-error";
      banner.textContent = `${verb}: ${(err as Error)?.message ?? String(err)}`;
      this.prepend(banner);
      setTimeout(() => banner.remove(), 4000);
      return null;
    }
  }
}

export function registerWooComponents(registry: WooComponentRegistry): void {
  registry.defineTag("woo-outliner-tree", WooOutlinerTreeElement);
}

// Incremental observations all re-trigger a hydrate on every live
// `<woo-outliner-tree>` whose subject matches. This is intentionally
// blunt — the v0 implementation is fetch-on-update; we can replace it
// with optimistic per-event reducers once the basic flow is measured.
export function registerWooObservationHandlers(registry: ObservationRegistry): void {
  const STRUCTURAL_TYPES = [
    "outline_item_added",
    "outline_item_removed",
    "outline_item_moved",
    "outline_item_reordered",
    "outline_item_hidden",
    "outline_focus_changed",
    "outline_undone",
    "note_edited",
    // Presence changes re-hydrate so the right-side aside (room_roster) stays
    // in sync. Hydrate already fans this out to every mounted tree.
    "outliner_entered",
    "outliner_left"
  ];
  registry.observation({
    types: STRUCTURAL_TYPES,
    route: "sequenced",
    reduce: (_draft, envelope) => {
      const outlinerId = String(envelope.observation.outliner ?? envelope.observation.source ?? "");
      if (!outlinerId) return;
      for (const el of document.querySelectorAll<WooOutlinerTreeElement>(`woo-outliner-tree`)) {
        if (el.subject === outlinerId) void el.hydrate();
      }
    }
  });
}

// Chat lines for outliner entry/exit and the umbrella activity event.
// Mirrors pinboard's compact system-line treatment.
export function registerWooChatFormatters(registry: ChatFormatterRegistry): void {
  registry.formatter({
    types: ["outliner_entered", "outliner_left", "outliner_activity"],
    format: (observation) => ({
      kind: "system",
      text: typeof observation.text === "string" ? observation.text : "The outline changes."
    })
  });
}
