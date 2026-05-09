import { escapeHtml, type WooComponentRegistry, type WooContext } from "../../../src/client/framework";

export type ChatLine = {
  kind: string;
  actor?: string;
  from?: string;
  to?: string;
  style?: string;
  reason?: string;
  source?: string;
  text?: string;
  ts?: number;
};

export type ChatTitleBadge = {
  id: string;
  tag: string;
  subject: string;
  data?: unknown;
};

export type ChatSpaceData = {
  roomName: string;
  roomDescription: string;
  titleBadges: ChatTitleBadge[];
  lines: ChatLine[];
  present: string[];
  draft: string;
  inRoom: boolean;
  canSend: boolean;
};

export type SpaceChatPanelData = {
  space: string;
  spaceName?: string;
  lines: ChatLine[];
  draft: string;
  height: number;
};

type ActorLabeler = (id: string | undefined) => string;

export class WooChatSpaceElement extends HTMLElement {
  woo?: WooContext;
  subject?: string;
  private model: ChatSpaceData = {
    roomName: "Room",
    roomDescription: "",
    titleBadges: [],
    lines: [],
    present: [],
    draft: "",
    inRoom: false,
    canSend: false
  };

  set data(value: ChatSpaceData) {
    this.model = { ...value, titleBadges: value.titleBadges ?? [] };
    this.render();
  }

  connectedCallback() {
    this.render();
  }

  focusComposer() {
    const input = this.querySelector<HTMLInputElement>("[data-chat-input]");
    input?.focus();
    if (input) input.setSelectionRange(input.value.length, input.value.length);
  }

  scrollFeedToEnd() {
    const feed = this.querySelector<HTMLElement>(".chat-feed");
    if (feed) feed.scrollTop = feed.scrollHeight;
  }

  private render() {
    const room = this.model.roomName || "Room";
    if (!this.model.inRoom) {
      this.innerHTML = `
        <section class="toolbar">
          ${this.renderRoomTitle(room)}
          <button data-chat-enter ${this.model.canSend ? "" : "disabled"}>Enter</button>
        </section>
        <section class="chat-layout solo">
          <div class="panel chat-empty-panel">
            <p>${escapeHtml(this.model.canSend ? this.model.roomDescription || "Enter the room to chat." : "Connecting...")}</p>
          </div>
        </section>
      `;
      this.mountTitleBadges();
      this.bind();
      return;
    }
    this.innerHTML = `
      <section class="toolbar">
        ${this.renderRoomTitle(room)}
      </section>
      <section class="chat-layout">
        <div class="panel chat-panel">
          <div class="chat-feed" aria-live="polite">
            ${this.model.lines.map((line) => renderChatLineHtml(line, (id) => this.actorLabel(id))).join("") || `<div class="chat-empty">${escapeHtml(this.model.roomDescription || "No chat events yet.")}</div>`}
          </div>
          <form class="chat-form" data-chat-form>
            <input data-chat-input autocomplete="off" placeholder="say something - or :waves, look cockatoo, tell guest_2 hi" value="${escapeHtml(this.model.draft)}" />
            <button>Send</button>
          </form>
        </div>
        <aside class="panel chat-presence">
          <h2>Present</h2>
          <div class="presence-list">
            ${this.model.present.map((id) => `<button data-chat-recipient="${escapeHtml(id)}">${escapeHtml(this.actorLabel(id))}<span>${escapeHtml(id)}</span></button>`).join("") || "<p>No actors present.</p>"}
          </div>
        </aside>
      </section>
    `;
    this.mountTitleBadges();
    this.bind();
  }

  private renderRoomTitle(room: string): string {
    const badges = this.model.titleBadges.map((badge) => `<${badge.tag} data-chat-title-badge="${escapeHtml(badge.id)}"></${badge.tag}>`).join("");
    return `<div class="chat-room-title"><h1>${escapeHtml(room)}</h1>${badges}</div>`;
  }

  private mountTitleBadges(): void {
    for (const badge of this.model.titleBadges) {
      const element = this.querySelector<HTMLElement & { subject?: string; woo?: WooContext; data?: unknown }>(`[data-chat-title-badge="${cssAttrValue(badge.id)}"]`);
      if (!element) continue;
      element.subject = badge.subject;
      element.woo = this.woo;
      const assign = () => {
        element.data = badge.data;
      };
      if (customElements.get(element.localName)) assign();
      else void customElements.whenDefined(element.localName).then(assign);
    }
  }

  private bind() {
    this.querySelector<HTMLButtonElement>("[data-chat-enter]")?.addEventListener("click", () => this.dispatch("enter"));
    const input = this.querySelector<HTMLInputElement>("[data-chat-input]");
    input?.addEventListener("input", () => this.dispatch("draft", { value: input.value }));
    input?.addEventListener("keydown", (event) => {
      if (event.key === "ArrowUp" || event.key === "ArrowDown") this.dispatch("history", { event, input });
    });
    this.querySelector<HTMLFormElement>("[data-chat-form]")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = input?.value.trim() ?? "";
      if (text) this.dispatch("submit", { text, input });
    });
    this.querySelectorAll<HTMLButtonElement>("[data-chat-recipient]").forEach((button) => {
      button.addEventListener("click", () => this.dispatch("recipient", { actor: button.dataset.chatRecipient ?? "" }));
    });
  }

  private dispatch(kind: string, detail: Record<string, unknown> = {}) {
    this.dispatchEvent(new CustomEvent(`woo-chat-${kind}`, { bubbles: true, detail }));
  }

  private actorLabel(id: string | undefined) {
    if (!id) return "unknown";
    return String(this.woo?.observe(id)?.name ?? id);
  }
}

function cssAttrValue(value: string): string {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}

export class WooSpaceChatPanelElement extends HTMLElement {
  woo?: WooContext;
  subject?: string;
  private model: SpaceChatPanelData = {
    space: "",
    lines: [],
    draft: "",
    height: 280
  };
  private collapsed = false;

  set data(value: SpaceChatPanelData) {
    this.model = value;
    this.render();
  }

  connectedCallback() {
    this.render();
  }

  focusComposer() {
    const input = this.querySelector<HTMLInputElement>("[data-space-chat-input]");
    input?.focus();
    if (input) input.setSelectionRange(input.value.length, input.value.length);
  }

  scrollFeedToEnd() {
    const feed = this.querySelector<HTMLElement>("[data-space-chat-feed]");
    if (feed) feed.scrollTop = feed.scrollHeight;
  }

  private render() {
    const space = this.model.space || this.subject || this.dataset.spaceChatSpace || "";
    const spaceName = this.model.spaceName || this.woo?.observe(space)?.name || space;
    this.dataset.spaceChatSpace = space;
    this.classList.toggle("is-collapsed", this.collapsed);
    if (this.collapsed) this.style.removeProperty("height");
    else this.style.height = `${Math.round(this.model.height)}px`;
    const toggleLabel = this.collapsed ? "Expand chat" : "Collapse chat";
    const toggleGlyph = this.collapsed ? "&#9650;" : "&#9660;";
    const head = `
      <div class="space-chat-head">
        <h2>Chat</h2>
        <span>${escapeHtml(spaceName)}</span>
        <button type="button" class="space-chat-toggle" data-space-chat-toggle aria-label="${toggleLabel}" title="${toggleLabel}" aria-expanded="${this.collapsed ? "false" : "true"}">${toggleGlyph}</button>
      </div>
    `;
    if (this.collapsed) {
      this.innerHTML = head;
    } else {
      this.innerHTML = `
        <div class="space-chat-resizer" data-space-chat-resizer role="separator" aria-orientation="horizontal" aria-label="Resize space chat"></div>
        ${head}
        <div class="chat-feed space-chat-feed" data-space-chat-feed aria-live="polite">
          ${this.model.lines.map((line) => renderChatLineHtml(line, (id) => this.actorLabel(id))).join("") || `<div class="chat-empty">No chat events yet.</div>`}
        </div>
        <form class="chat-form space-chat-form" data-space-chat-form data-space-chat-space="${escapeHtml(space)}">
          <input data-space-chat-input data-space-chat-space="${escapeHtml(space)}" autocomplete="off" placeholder="say something, /me waves, look, drop note" value="${escapeHtml(this.model.draft)}" />
          <button>Send</button>
        </form>
      `;
    }
    this.bind();
  }

  private bind() {
    const space = this.model.space || this.subject || this.dataset.spaceChatSpace || "";
    this.querySelector<HTMLButtonElement>("[data-space-chat-toggle]")?.addEventListener("click", () => {
      this.collapsed = !this.collapsed;
      this.render();
    });
    if (this.collapsed) return;
    const input = this.querySelector<HTMLInputElement>("[data-space-chat-input]");
    input?.addEventListener("input", () => this.dispatch("draft", { space, value: input.value }));
    input?.addEventListener("keydown", (event) => {
      if (event.key === "ArrowUp" || event.key === "ArrowDown") this.dispatch("history", { event, input, space });
    });
    this.querySelector<HTMLFormElement>("[data-space-chat-form]")?.addEventListener("submit", (event) => {
      event.preventDefault();
      const text = input?.value.trim() ?? "";
      if (text) this.dispatch("submit", { text, input, space });
    });
  }

  private dispatch(kind: string, detail: Record<string, unknown> = {}) {
    this.dispatchEvent(new CustomEvent(`woo-chat-${kind}`, { bubbles: true, detail }));
  }

  private actorLabel(id: string | undefined) {
    if (!id) return "unknown";
    return String(this.woo?.observe(id)?.name ?? id);
  }
}

export function registerWooComponents(registry: WooComponentRegistry): void {
  registry.defineTag("woo-chat-space", WooChatSpaceElement);
  registry.defineTag("woo-space-chat-panel", WooSpaceChatPanelElement);
}

export function renderChatLineHtml(line: ChatLine, actorLabel: ActorLabeler): string {
  const time = line.ts ? new Date(line.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
  if (line.kind === "input") return `<div class="chat-line input"><span class="chat-time">${escapeHtml(time)}</span><span>${escapeHtml(line.text ?? "")}</span></div>`;
  if (line.kind === "separator") return `<div class="chat-line separator"></div>`;
  if (line.kind === "said") return `<div class="chat-line said"><span class="chat-time">${escapeHtml(time)}</span><strong>${escapeHtml(actorLabel(line.actor))}</strong><span>${escapeHtml(line.text ?? "")}</span></div>`;
  if (line.kind === "said_to") return `<div class="chat-line said"><span class="chat-time">${escapeHtml(time)}</span><strong>${escapeHtml(actorLabel(line.actor))} [to ${escapeHtml(actorLabel(line.to))}]</strong><span>${escapeHtml(line.text ?? "")}</span></div>`;
  if (line.kind === "said_as") return `<div class="chat-line said"><span class="chat-time">${escapeHtml(time)}</span><strong>${escapeHtml(actorLabel(line.actor))} [${escapeHtml(line.style ?? "says")}]</strong><span>${escapeHtml(line.text ?? "")}</span></div>`;
  if (line.kind === "emoted") return `<div class="chat-line emote"><span class="chat-time">${escapeHtml(time)}</span><span>${escapeHtml(actorLabel(line.actor))} ${escapeHtml(line.text ?? "")}</span></div>`;
  if (line.kind === "posed") return `<div class="chat-line emote"><span class="chat-time">${escapeHtml(time)}</span><span>[${escapeHtml(actorLabel(line.actor))} ${escapeHtml(line.text ?? "")}]</span></div>`;
  if (line.kind === "quoted") return `<div class="chat-line said"><span class="chat-time">${escapeHtml(time)}</span><strong>${escapeHtml(actorLabel(line.actor))} |</strong><span>${escapeHtml(line.text ?? "")}</span></div>`;
  if (line.kind === "self_pointed") return `<div class="chat-line emote"><span class="chat-time">${escapeHtml(time)}</span><span>${escapeHtml(actorLabel(line.actor))} &lt;- ${escapeHtml(line.text ?? "")}</span></div>`;
  if (line.kind === "told") return `<div class="chat-line told"><span class="chat-time">${escapeHtml(time)}</span><strong>${escapeHtml(actorLabel(line.from))} -> ${escapeHtml(actorLabel(line.to))}</strong><span>${escapeHtml(line.text ?? "")}</span></div>`;
  if (line.kind === "huh") {
    const detail = typeof line.reason === "string" && line.reason ? line.reason : "I don't understand that.";
    return `<div class="chat-line system"><span class="chat-time">${escapeHtml(time)}</span><span>${escapeHtml(detail)}</span></div>`;
  }
  if (line.kind === "error") return `<div class="chat-line error"><span class="chat-time">${escapeHtml(time)}</span><span>${escapeHtml(line.text ?? "That didn't work.")}</span></div>`;
  if (line.kind === "entered" || line.kind === "left") {
    const text = line.text ?? `${actorLabel(line.actor)} ${line.kind === "entered" ? "entered" : "left"}.`;
    return `<div class="chat-line system"><span class="chat-time">${escapeHtml(time)}</span><span>${escapeHtml(text)}</span></div>`;
  }
  return `<div class="chat-line system"><span class="chat-time">${escapeHtml(time)}</span><span>${escapeHtml(line.text ?? "")}</span></div>`;
}
