// Production-shaped Outliner Acts read/fanout gate.
//
// This is deliberately a real-workerd lane: the fixture goes through the
// production Net installer, Durable Object SQLite/RPC boundaries, the public
// /net-api session/turn surface, and JSON serialization. It measures the
// whole-tree read that follows a structural Act for eight independent viewers;
// the in-memory acts microbenchmark cannot establish any of those costs.
import { createWorld } from "../src/core/bootstrap";
import { withWorkerd } from "./net-smoke-harness";
import { runNetInstall } from "./net-install";

const SECRET = "local-smoke-internal-secret"; // wrangler.smoke.toml lane secret
const ROWS = 1_000;
const VIEWERS = 8;
const WAVES = 3;

// These are acceptance bounds for the current whole-tree pilot envelope, not
// an unbounded scalability claim. A larger product envelope requires paging.
const MAX_VIEW_BYTES = 512 * 1024;
const MAX_WARM_VIEW_P95_MS = 1_500;
const MAX_REFRESH_WAVE_P95_MS = 5_000;

type Viewer = { token: string; session: string };
type TurnResult = { ms: number; bytes: number; body: Record<string, unknown> };
type SocketFrame = { body: Record<string, unknown>; bytes: number };
type ViewerSocket = { ws: WebSocket; frames: SocketFrame[] };

function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = performance.now() + timeoutMs;
  while (performance.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`condition did not become true within ${timeoutMs}ms`);
}

async function postJson(url: string, token: string, body: unknown): Promise<TurnResult> {
  const started = performance.now();
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body)
  });
  const text = await response.text();
  const ms = Math.round(performance.now() - started);
  let decoded: Record<string, unknown>;
  try {
    decoded = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`non-JSON response (${response.status}): ${text.slice(0, 500)}`);
  }
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(decoded).slice(0, 1_000)}`);
  return { ms, bytes: Buffer.byteLength(text), body: decoded };
}

function requireAccepted(result: TurnResult, label: string): void {
  const reply = result.body.reply as { status?: unknown } | undefined;
  if (reply?.status !== "accepted") {
    throw new Error(`${label} was not accepted: ${JSON.stringify(result.body).slice(0, 1_000)}`);
  }
}

function requireTree(result: TurnResult, expectedRows: number): void {
  requireAccepted(result, "tree_view");
  const view = result.body.result as { items?: unknown[] } | undefined;
  if (!Array.isArray(view?.items) || view.items.length !== expectedRows) {
    throw new Error(`tree_view returned ${view?.items?.length ?? "no"} rows; expected ${expectedRows}`);
  }
}

async function main(): Promise<void> {
  const keys = Array.from({ length: VIEWERS }, (_, index) => ({
    id: `outliner-bench-${index + 1}`,
    secret: `outliner-bench-secret-${index + 1}`
  }));
  let toggledItem = "";

  await withWorkerd({}, async (base) => {
    await runNetInstall({
      baseUrl: base,
      verifyApikey: `apikey:${keys[0]!.id}:${keys[0]!.secret}`,
      dryRun: false,
      graft: async (world) => {
        const actors: string[] = [];
        for (const [index, key] of keys.entries()) {
          const actor = world.auth(`guest:outliner-bench-${index + 1}`).actor;
          actors.push(actor);
          world.ensureApiKey("$wiz", actor, key.id, key.secret, "outliner workerd scale gate");
        }
        for (let index = 0; index < ROWS; index += 1) {
          const item = world.createRuntimeObject("$outline_item", actors[0]!, "the_outline", {
            progr: "$wiz",
            location: "the_outline",
            name: ""
          });
          world.setProp(item, "__ordered_edge", {
            parent: null,
            rank: `${String(index).padStart(6, "0")}1`
          });
          world.setProp(item, "text", `bench row ${index + 1}`);
          if (index === 0) toggledItem = item;
        }
      }
    }, { WOO_INTERNAL_SECRET: SECRET });

    const viewers: Viewer[] = [];
    for (const key of keys) {
      const token = `apikey:${key.id}:${key.secret}`;
      const minted = await postJson(`${base}/net-api/session`, token, { ttl_ms: 600_000 });
      const session = minted.body.session;
      if (typeof session !== "string") throw new Error(`session mint omitted id: ${JSON.stringify(minted.body)}`);
      viewers.push({ token, session });
    }

    // Presence is the authoritative fanout audience. Session mint alone does
    // not create it, so enter through the same sequenced transition a browser
    // uses rather than relying on seed placement.
    for (const [index, viewer] of viewers.entries()) {
      const entered = await postJson(`${base}/net-api/turn`, viewer.token, {
        target: "the_outline",
        verb: "enter",
        args: [],
        session: viewer.session,
        idempotency_key: `outliner-bench-enter-${index}`
      });
      requireAccepted(entered, "outliner enter");
    }

    const wsBase = base.replace(/^http/, "ws");
    const openSocket = async (viewer: Viewer): Promise<ViewerSocket> => {
      const ticket = await postJson(`${base}/net-api/ws-ticket`, viewer.token, { session: viewer.session });
      const id = ticket.body.ticket;
      if (typeof id !== "string") throw new Error(`ticket mint omitted id: ${JSON.stringify(ticket.body)}`);
      return await new Promise((resolve, reject) => {
        const frames: SocketFrame[] = [];
        const ws = new WebSocket(`${wsBase}/net-api/ws?ticket=${encodeURIComponent(id)}`);
        ws.addEventListener("message", (event) => {
          const raw = String((event as MessageEvent).data);
          try {
            frames.push({ body: JSON.parse(raw) as Record<string, unknown>, bytes: Buffer.byteLength(raw) });
          } catch {
            /* The protocol is JSON-only; an invalid frame cannot satisfy a gate. */
          }
        });
        ws.addEventListener("open", () => resolve({ ws, frames }));
        ws.addEventListener("error", () => reject(new Error(`socket open failed for ${viewer.session}`)));
      });
    };
    const sockets = await Promise.all(viewers.map(openSocket));

    const read = async (viewer: Viewer, key: string): Promise<TurnResult> => {
      const result = await postJson(`${base}/net-api/turn`, viewer.token, {
        target: "the_outline",
        verb: "tree_view",
        args: [],
        route: "direct",
        session: viewer.session,
        idempotency_key: key
      });
      requireTree(result, ROWS);
      return result;
    };

    try {
      // Prime every gateway shard. Reported latency is warm steady state; cold
      // closure repair is a separate Net concern and would dominate this signal.
      await Promise.all(viewers.map((viewer, index) => read(viewer, `outliner-bench-prime-${index}`)));

      const warm: TurnResult[] = [];
      for (let sample = 0; sample < 5; sample += 1) {
        warm.push(await read(viewers[0]!, `outliner-bench-warm-${sample}`));
      }

      const fanoutWallMs: number[] = [];
      const fanoutFrameBytes: number[] = [];
      const waveWallMs: number[] = [];
      const waveReads: TurnResult[] = [];
      for (let wave = 0; wave < WAVES; wave += 1) {
        const offsets = sockets.map((socket) => socket.frames.length);
        const waveStarted = performance.now();
        const mutation = await postJson(`${base}/net-api/turn`, viewers[0]!.token, {
          target: "the_outline",
          verb: "hide",
          args: [toggledItem, wave % 2 === 0],
          session: viewers[0]!.session,
          idempotency_key: `outliner-bench-mutation-${wave}`
        });
        requireAccepted(mutation, "hide");
        const ownActs = (mutation.body.observations as Array<{ type?: unknown }> | undefined) ?? [];
        if (!ownActs.some((observation) => observation.type === "outline_item_hidden")) {
          throw new Error("hide reply omitted the submitter's structural Act");
        }

        const peerActFrame = (index: number): SocketFrame | undefined => sockets[index]!.frames
          .slice(offsets[index])
          .find((frame) => frame.body.type === "observations" &&
            ((frame.body.observations as Array<{ type?: unknown }> | undefined) ?? [])
              .some((observation) => observation.type === "outline_item_hidden"));
        // The submitting session receives the Act on its REST reply (echo
        // dedupe); the other seven active principals must receive peer push.
        await waitUntil(() => sockets.slice(1).every((_socket, peer) => peerActFrame(peer + 1) !== undefined));
        // Start at mutation submission: a peer push may legitimately beat the
        // submitter's HTTP response, so response-to-push would collapse to a
        // misleading zero rather than measuring the full authority+fanout path.
        fanoutWallMs.push(Math.round(performance.now() - waveStarted));
        for (let peer = 1; peer < sockets.length; peer += 1) {
          fanoutFrameBytes.push(peerActFrame(peer)!.bytes);
        }

        const reads = await Promise.all(viewers.map((viewer, index) =>
          read(viewer, `outliner-bench-wave-${wave}-${index}`)
        ));
        waveWallMs.push(Math.round(performance.now() - waveStarted));
        waveReads.push(...reads);
      }

      const summary = {
        runtime: "workerd/net-api+ws",
        rows: ROWS,
        viewers: VIEWERS,
        peer_pushes_per_wave: VIEWERS - 1,
        waves: WAVES,
        warm_view_ms: {
          p50: percentile(warm.map((sample) => sample.ms), 50),
          p95: percentile(warm.map((sample) => sample.ms), 95)
        },
        view_bytes: {
          min: Math.min(...waveReads.map((sample) => sample.bytes)),
          max: Math.max(...waveReads.map((sample) => sample.bytes))
        },
        mutation_to_all_peer_push_wall_ms: {
          values: fanoutWallMs,
          p95: percentile(fanoutWallMs, 95)
        },
        fanout_frame_bytes: {
          min: Math.min(...fanoutFrameBytes),
          max: Math.max(...fanoutFrameBytes)
        },
        invalidation_to_current_wall_ms: {
          values: waveWallMs,
          p95: percentile(waveWallMs, 95)
        },
        budgets: {
          max_view_bytes: MAX_VIEW_BYTES,
          max_warm_view_p95_ms: MAX_WARM_VIEW_P95_MS,
          max_invalidation_to_current_p95_ms: MAX_REFRESH_WAVE_P95_MS
        }
      };
      console.log(`OUTLINER_ACTS_SCALE ${JSON.stringify(summary)}`);

      if (summary.view_bytes.max > MAX_VIEW_BYTES) throw new Error(`view bytes exceeded budget: ${summary.view_bytes.max}`);
      if (summary.warm_view_ms.p95 > MAX_WARM_VIEW_P95_MS) throw new Error(`warm p95 exceeded budget: ${summary.warm_view_ms.p95}`);
      if (summary.invalidation_to_current_wall_ms.p95 > MAX_REFRESH_WAVE_P95_MS) {
        throw new Error(`invalidation-to-current p95 exceeded budget: ${summary.invalidation_to_current_wall_ms.p95}`);
      }
    } finally {
      for (const socket of sockets) socket.ws.close();
    }
  });
}

main().catch((error) => {
  console.error(String(error));
  process.exit(1);
});
