import type { ShadowScopeHead } from "../core/shadow-commit-scope";

export function isShadowScopeHead(value: unknown): value is ShadowScopeHead {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const head = value as Partial<ShadowScopeHead>;
  return head.kind === "woo.scope_head.shadow.v1"
    && typeof head.scope === "string"
    && typeof head.epoch === "number"
    && Number.isInteger(head.epoch)
    && typeof head.seq === "number"
    && Number.isInteger(head.seq)
    && typeof head.hash === "string";
}

export function v2BrowserWebSocketUrl(input: {
  location: Pick<Location, "protocol" | "host">;
  token: string;
  node: string;
  scope?: string;
  last_known_head?: ShadowScopeHead;
}): string {
  const protocol = input.location.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams({ token: input.token, node: input.node });
  if (input.scope) params.set("scope", input.scope);
  if (input.last_known_head) {
    // The head is an advisory catch-up cursor. The relay validates the shape
    // and falls back to projection if the retained delta tail cannot satisfy it.
    params.set("last_known_head", JSON.stringify(input.last_known_head));
  }
  return `${protocol}//${input.location.host}/v2/turn-network/ws?${params}`;
}
