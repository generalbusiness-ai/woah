import type { ShadowScopeHead } from "../core/shadow-commit-scope";

export function v2BrowserWebSocketUrl(input: {
  location: Pick<Location, "protocol" | "host">;
  token: string;
  node: string;
  scope?: string;
  last_known_head?: ShadowScopeHead;
  executable_seed_digest?: string;
}): string {
  const protocol = input.location.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams({ token: input.token, node: input.node });
  if (input.scope) params.set("scope", input.scope);
  if (input.last_known_head) {
    // The head is an advisory catch-up cursor. The relay validates the shape
    // and falls back to projection if the retained delta tail cannot satisfy it.
    params.set("last_known_head", JSON.stringify(input.last_known_head));
  }
  if (input.executable_seed_digest) params.set("executable_seed_digest", input.executable_seed_digest);
  return `${protocol}//${input.location.host}/v2/turn-network/ws?${params}`;
}
