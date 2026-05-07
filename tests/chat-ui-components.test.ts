// @vitest-environment jsdom
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { renderChatLineHtml, WooChatSpaceElement, WooSpaceChatPanelElement, type ChatSpaceData, type SpaceChatPanelData } from "../catalogs/chat/ui/chat-space";
import type { WooContext } from "../src/client/framework";

function context(): WooContext {
  return {
    actor: "guest_1",
    frame: {
      id: "test-frame",
      subject: "the_chatroom",
      view: "default",
      get: () => undefined,
      set: () => true
    },
    neighborhood: {
      subject: "the_chatroom",
      refs: ["the_chatroom", "guest_1", "guest_2"],
      related: {},
      has: (ref) => ["the_chatroom", "guest_1", "guest_2", "guest_3"].includes(ref)
    },
    observe: (ref) => ({ id: ref, name: ref === "guest_2" ? "Guest Two" : ref === "guest_3" ? "Guest Three" : ref, props: {}, catalogState: {} }),
    call: async () => null,
    send: async () => null,
    directCall: async () => null,
    emit: () => true
  };
}

describe("chat catalog UI components", () => {
  beforeAll(() => {
    if (!customElements.get("woo-chat-space")) customElements.define("woo-chat-space", WooChatSpaceElement);
    if (!customElements.get("woo-space-chat-panel")) customElements.define("woo-space-chat-panel", WooSpaceChatPanelElement);
  });

  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("renders WooChatSpaceElement data and emits submit events", () => {
    const element = document.createElement("woo-chat-space") as WooChatSpaceElement & { data: ChatSpaceData };
    element.woo = context();
    document.body.append(element);
    element.data = {
      roomName: "Living Room",
      roomDescription: "A room.",
      titleBadges: [],
      lines: [{ kind: "said", actor: "guest_2", text: "hello <there>", ts: 1 }],
      present: ["guest_2"],
      draft: "wave",
      inRoom: true,
      canSend: true
    };

    expect(element.querySelector("h1")?.textContent).toBe("Living Room");
    expect(element.querySelector(".chat-feed")?.textContent).toContain("Guest Two");
    expect(element.querySelector(".chat-feed")?.innerHTML).toContain("hello &lt;there&gt;");
    expect(element.querySelector<HTMLInputElement>("[data-chat-input]")?.value).toBe("wave");

    let detail: Record<string, unknown> | undefined;
    element.addEventListener("woo-chat-submit", (event) => {
      detail = (event as CustomEvent<Record<string, unknown>>).detail;
    });
    const input = element.querySelector<HTMLInputElement>("[data-chat-input]")!;
    input.value = "send this";
    element.querySelector<HTMLFormElement>("[data-chat-form]")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    expect(detail).toMatchObject({ text: "send this" });
    expect(detail?.input).toBe(input);
  });

  it("mounts title badge components next to the room name", () => {
    class TestTitleBadgeElement extends HTMLElement {
      set data(value: any) {
        this.textContent = String(value?.props?.current?.value ?? "");
      }
    }
    if (!customElements.get("woo-test-title-badge")) customElements.define("woo-test-title-badge", TestTitleBadgeElement);
    const element = document.createElement("woo-chat-space") as WooChatSpaceElement & { data: ChatSpaceData };
    element.woo = context();
    document.body.append(element);

    element.data = {
      roomName: "Living Room",
      roomDescription: "A room.",
      titleBadges: [{
        id: "weather:weather.badge:the_weather",
        tag: "woo-test-title-badge",
        subject: "the_weather",
        data: { id: "the_weather", props: { current: { value: 72 } } }
      }],
      lines: [],
      present: [],
      draft: "",
      inRoom: true,
      canSend: true
    };

    const title = element.querySelector(".chat-room-title");
    expect(title?.querySelector("h1")?.textContent).toBe("Living Room");
    expect(title?.querySelector("woo-test-title-badge")?.textContent).toBe("72");
  });

  it("renders WooSpaceChatPanelElement data and emits submit events", () => {
    const element = document.createElement("woo-space-chat-panel") as WooSpaceChatPanelElement & { data: SpaceChatPanelData };
    element.woo = context();
    element.subject = "the_pinboard";
    document.body.append(element);
    element.data = {
      space: "the_pinboard",
      spaceName: "Pinboard",
      lines: [{ kind: "emoted", actor: "guest_2", text: "waves" }],
      draft: "mini",
      height: 160
    };

    expect(element.dataset.spaceChatSpace).toBe("the_pinboard");
    expect(element.querySelector(".space-chat-head")?.textContent).toContain("Pinboard");
    expect(element.querySelector(".space-chat-head")?.textContent).not.toContain("the_pinboard");
    expect(element.querySelector(".space-chat-feed")?.textContent).toContain("Guest Two waves");
    expect(element.querySelector<HTMLInputElement>("[data-space-chat-input]")?.value).toBe("mini");

    let detail: Record<string, unknown> | undefined;
    element.addEventListener("woo-chat-submit", (event) => {
      detail = (event as CustomEvent<Record<string, unknown>>).detail;
    });
    const input = element.querySelector<HTMLInputElement>("[data-space-chat-input]")!;
    input.value = "mini send";
    element.querySelector<HTMLFormElement>("[data-space-chat-form]")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    expect(detail).toMatchObject({ text: "mini send", space: "the_pinboard" });
    expect(detail?.input).toBe(input);
  });

  it("preserves declarative mini-chat space before host data binding", () => {
    const element = document.createElement("woo-space-chat-panel") as WooSpaceChatPanelElement;
    element.dataset.spaceChatSpace = "the_pinboard";
    document.body.append(element);

    expect(element.dataset.spaceChatSpace).toBe("the_pinboard");
    expect(element.style.height).toBe("280px");
    expect(element.querySelector<HTMLInputElement>("[data-space-chat-input]")?.dataset.spaceChatSpace).toBe("the_pinboard");

    let detail: Record<string, unknown> | undefined;
    element.addEventListener("woo-chat-submit", (event) => {
      detail = (event as CustomEvent<Record<string, unknown>>).detail;
    });
    const input = element.querySelector<HTMLInputElement>("[data-space-chat-input]")!;
    input.value = "look";
    element.querySelector<HTMLFormElement>("[data-space-chat-form]")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    expect(detail).toMatchObject({ text: "look", space: "the_pinboard" });
  });

  it("renders huh output as private system text without a room prefix", () => {
    const html = renderChatLineHtml(
      { kind: "huh", source: "the_dubspace", actor: "guest_1", text: "zzzz", reason: "I don't understand that.", ts: 1 },
      (id) => id || "unknown"
    );

    const container = document.createElement("div");
    container.innerHTML = html;
    expect(container.textContent).toContain("I don't understand that.");
    expect(container.textContent).not.toContain("the_dubspace");
    expect(container.textContent).not.toContain("zzzz");
  });
});
