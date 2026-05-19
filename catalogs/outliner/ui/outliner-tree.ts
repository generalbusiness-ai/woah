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
  // True while the inline new-child editor (anchored below the focus row) is
  // open. Always paired with a non-null `model.focus`; render() resets this
  // whenever focus shifts so the placeholder can't drift onto an unrelated row.
  private addingChild = false;
  // Last focus value handed to render(). Lets render() detect focus changes
  // (from a chat `focus` command, a remote `outline_focus_changed`, or a
  // local `focus_on` call) and clear the pending add-child surface.
  private lastRenderedFocus: string | null | undefined = undefined;
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
    // Focus shifted out from under any pending add-child surface — close it
    // so the inline editor can't drift onto an unrelated row after a chat
    // `focus` command or a directed `outline_focus_changed`.
    if (this.lastRenderedFocus !== undefined && this.lastRenderedFocus !== data.focus) {
      this.addingChild = false;
    }
    this.lastRenderedFocus = data.focus;
    const outlinerId = data.outlinerId || this.subject || "";
    const visibleItems = this.computeVisibleItems(data.items);
    const focusLabel = data.focus
      ? data.items.find((it) => it.id === data.focus)?.text ?? data.focus
      : "(root)";
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
    const focusChip = data.focus
      ? `<button type="button" class="outliner-focus" data-outliner-action="clear-focus" title="back to root">focus: ${escapeHtml(focusLabel)} ✕</button>`
      : `<span class="outliner-focus">focus: ${escapeHtml(focusLabel)}</span>`;
    const toolbar = `
      <section class="toolbar outliner-toolbar">
        <h1>${escapeHtml(data.outlinerName)}</h1>
        <button type="button" data-outliner-presence="${this.companionVisible ? "leave" : "enter"}">${this.companionVisible ? "Leave" : "Enter"}</button>
        <label class="outliner-toggle">
          <input type="checkbox" data-outliner-show-hidden ${this.showHidden ? "checked" : ""}>
          show hidden
        </label>
        <button type="button" data-outliner-action="undo">Undo</button>
        ${focusChip}
      </section>
    `;
    // Top add form is only useful at root. When focus is on an item, the
    // user creates new children "in place" via the + button on the focus
    // row, so hiding the top form removes the ambiguity about which parent
    // a new item lands under.
    const topAdd = data.focus == null
      ? `<form class="outliner-add" data-outliner-add>
          <input type="text" name="text" placeholder="add an item…" autocomplete="off" value="${escapeHtml(addInputValue)}">
          <button type="submit">Add</button>
        </form>`
      : "";
    // Walk visibleItems once and splice the add-child placeholder in right
    // after the focus row. Building this inline (rather than overriding
    // computeVisibleItems) keeps the placeholder a UI-only concern.
    const rowsHtml: string[] = [];
    for (const item of visibleItems) {
      rowsHtml.push(this.renderRow(item, data));
      if (this.addingChild && data.focus && item.id === data.focus) {
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

  private renderRow(item: OutlinerItem & { depth: number }, data: OutlinerData): string {
    const id = item.id;
    const isFocused = data.focus === id;
    const isEditing = this.editing?.id === id;
    const collapsed = this.collapsed.has(id);
    const indent = item.depth * 20;
    const twistie = item.has_children
      ? `<button type="button" class="outliner-twistie" data-outliner-action="toggle-collapse" data-id="${escapeHtml(id)}" aria-label="${collapsed ? "expand" : "collapse"}">${collapsed ? "▸" : "▾"}</button>`
      : `<span class="outliner-twistie outliner-twistie-empty">·</span>`;
    // The row itself is the focus/edit affordance now — clicking the text
    // span bubbles up to the row-level handler, which focuses an unfocused
    // row or starts editing an already-focused row. No data-outliner-action
    // on the span so it can't double-fire with the row click.
    const textCell = isEditing
      ? `<form class="outliner-edit" data-outliner-edit data-id="${escapeHtml(id)}"><input type="text" name="text" value="${escapeHtml(item.text)}" autofocus></form>`
      : `<span class="outliner-text">${escapeHtml(item.text || "(empty)")}</span>`;
    // The + button only sits on the focus row. Add-in-place means "add a
    // child of the focus row," so showing the button anywhere else would
    // be confusing — to add under a different row you focus it first.
    const addChildBtn = isFocused
      ? `<button type="button" class="outliner-add-child-btn" data-outliner-action="add-child" data-id="${escapeHtml(id)}" title="add child">+</button>`
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
          <button type="button" class="outliner-remove-btn" data-outliner-action="remove" data-id="${escapeHtml(id)}" title="remove">×</button>
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
      if (action === "clear-focus") {
        // Closes any pending add-child surface synchronously so it doesn't
        // briefly render against a stale focus before the hydrate completes.
        this.addingChild = false;
        await this.callVerb("focus_on", [null]);
        return;
      }
      if (action === "add-child" && id) {
        // Only the focus row carries this button; refuse to open the
        // placeholder against a stale id in case the focus moved between
        // render and click.
        if (this.model.focus !== id) return;
        this.addingChild = !this.addingChild;
        // Expand the focus row when opening, so the new child is visible
        // when it arrives. Closing leaves the collapse state alone.
        if (this.addingChild) this.collapsed.delete(id);
        this.render();
        return;
      }
      return;
    }
    // Row click — focus an unfocused row, edit an already-focused row.
    // Skip interactive descendants (buttons, the hide checkbox, any open
    // form) so clicking those keeps their own behavior.
    if (target.closest("button, input, form")) return;
    const row = target.closest<HTMLElement>("[data-outliner-row]");
    if (!row) return;
    const id = row.dataset.id;
    if (!id) return;
    event.preventDefault();
    if (this.model.focus === id) {
      // Already focused: enter edit mode. Bail if we're already editing
      // this row so a stray click on the row doesn't restart the editor.
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
    // Not focused: focus it. Drop any pending add-child surface up front
    // so a fast hydrate doesn't briefly render the placeholder under the
    // old focus row.
    this.addingChild = false;
    await this.callVerb("focus_on", [id]);
  };

  // Component-level Escape handler. Closes the active inline editor — the
  // existing edit form keeps its own per-click blur binding for commit, but
  // routing Escape through one place lets the new add-child surface share
  // the same cancel gesture without re-binding on every render.
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
        // than calling `add` (which would just raise E_INVARG).
        this.addingChild = false;
        this.render();
        return;
      }
      // Close the surface first so the post-add hydrate doesn't briefly
      // re-render the placeholder with the just-submitted text.
      this.addingChild = false;
      // `add(text)` defaults the parent to the actor's current focus on
      // the server, which is exactly the row this placeholder hangs under.
      await this.callVerb("add", [text]);
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
