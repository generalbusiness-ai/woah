/**
 * NetFeed e2e test page entry (Plan 002 Phase 4 item 5;
 * e2e/net-feed.spec.ts — see index.html for the serving mechanism).
 *
 * A deliberately MINIMAL page over the real NetFeed (src/client/net-feed.ts,
 * the surface under test — imported directly, not reimplemented):
 *   - boots a feed from the `?key=` apikey query param against
 *     location.origin (same origin as the worker, so the WS upgrade and
 *     /net-api fetches need no CORS);
 *   - renders feed STATE into #state data-attributes (connection/actor/
 *     session/pending) so the spec can await `data-connection="open"`;
 *   - renders every observation event into an #events <li> carrying
 *     data-source ("self"/"peer"), data-type, data-scope, data-seq and the
 *     observation JSON as text — the cross-user assertions read these;
 *   - renders every settled turn into a #results <li> (data-status +
 *     result JSON) so a committed turn is literally visible on the page;
 *   - exposes window.feed / window.wooTurn / window.wooCell /
 *     window.wooRelation for the spec to drive via page.evaluate.
 */
import { NetFeed } from "../../src/client/net-feed";

declare global {
  interface Window {
    feed: NetFeed;
    wooTurn: (target: string, verb: string, args?: unknown[]) => Promise<{
      status: string;
      result?: unknown;
      error?: unknown;
      observations: Record<string, unknown>[];
    }>;
    wooCell: (key: string) => Promise<unknown>;
    wooRelation: (relation: string, owner: string) => Promise<Array<{ member: string; body?: unknown }>>;
  }
}

document.body.innerHTML = `
  <h1>NetFeed e2e page</h1>
  <div id="state" data-connection="idle" data-actor="" data-session="" data-pending="0"></div>
  <div id="error"></div>
  <ol id="events"></ol>
  <ol id="results"></ol>
`;

const stateEl = document.getElementById("state") as HTMLElement;
const errorEl = document.getElementById("error") as HTMLElement;
const eventsEl = document.getElementById("events") as HTMLElement;
const resultsEl = document.getElementById("results") as HTMLElement;

const apiKey = new URLSearchParams(location.search).get("key") ?? "";
const feed = new NetFeed({ baseUrl: location.origin, apiKey });
window.feed = feed;

feed.onState((state) => {
  stateEl.dataset.connection = state.connection;
  stateEl.dataset.actor = state.actor ?? "";
  stateEl.dataset.session = state.session ?? "";
  stateEl.dataset.pending = String(state.pending.length);
  stateEl.textContent = `${state.connection} actor=${state.actor ?? "-"} pending=${state.pending.length}`;
});

feed.onObservation((event) => {
  const li = document.createElement("li");
  li.dataset.source = event.source;
  li.dataset.scope = event.scope;
  li.dataset.seq = event.seq === null ? "" : String(event.seq);
  li.dataset.type = typeof event.observation.type === "string" ? event.observation.type : "";
  li.textContent = JSON.stringify(event.observation);
  eventsEl.appendChild(li);
});

window.wooTurn = async (target, verb, args = []) => {
  const li = document.createElement("li");
  li.dataset.verb = verb;
  try {
    const outcome = await feed.turn({ target, verb, args });
    li.dataset.status = outcome.status;
    li.textContent = JSON.stringify({ result: outcome.result ?? null, observations: outcome.observations.length });
    // Only serializable fields cross the page.evaluate boundary (raw is
    // dropped: it can carry non-JSON-safe transcript internals).
    return {
      status: outcome.status,
      ...(outcome.result !== undefined ? { result: outcome.result } : {}),
      ...(outcome.error !== undefined ? { error: outcome.error } : {}),
      observations: outcome.observations
    };
  } catch (err) {
    li.dataset.status = "threw";
    li.textContent = String(err);
    throw err;
  } finally {
    resultsEl.appendChild(li);
  }
};

window.wooCell = (key) => feed.cell(key);
window.wooRelation = (relation, owner) => feed.relation(relation, owner);

feed.open().catch((err) => {
  errorEl.textContent = String(err);
});
