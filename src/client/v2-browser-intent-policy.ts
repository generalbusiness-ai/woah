export type V2BrowserCallRoute = "direct" | "sequenced";
export type V2BrowserCallPersistence = "durable" | "live";

export type V2ServerAssistedIntentPolicy =
  | {
      ok: true;
      reason: "live_turn" | "scope_ad" | "server_authoritative";
      selected_ad?: string;
    }
  | {
      ok: false;
      reason: "server_assisted_durable_disabled";
    };

export function v2ServerAssistedIntentPolicy(input: {
  route: V2BrowserCallRoute;
  persistence?: V2BrowserCallPersistence;
  selectedScopeAd?: string | null;
  serverAuthoritative?: boolean;
}): V2ServerAssistedIntentPolicy {
  // Durable turns must not drift back to opaque server-side planning. They need
  // browser-built execution, a scope executor selected by gossip, or an
  // explicit serverAuthoritative call for lifecycle state owned by the runtime.
  const persistence = input.persistence ?? (input.route === "direct" ? "live" : "durable");
  if (persistence === "live") return { ok: true, reason: "live_turn" };
  if (input.selectedScopeAd) return { ok: true, reason: "scope_ad", selected_ad: input.selectedScopeAd };
  if (input.serverAuthoritative) return { ok: true, reason: "server_authoritative" };
  return { ok: false, reason: "server_assisted_durable_disabled" };
}
