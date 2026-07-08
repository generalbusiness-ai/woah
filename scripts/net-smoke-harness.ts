// net-smoke-harness — the LIGHT half of the shared net-lane fixture
// (Plan 002 Phase 4 item 5): scenario constants, workerd lifecycle, and
// /net-smoke doorway helpers, with NO runtime import of the engine.
//
// Why the split: the world-building half (scripts/net-smoke-fixture.ts)
// imports src/core/bootstrap → src/generated/bundled-catalogs.ts, whose
// JSON manifest imports carry no import attributes — fine under tsx/vite/
// vitest, refused by Node's ESM loader as Playwright drives it. The
// Playwright spec (e2e/net-feed.spec.ts) therefore imports THIS module
// only and obtains the world fixture through dumpLaneFixture(), which
// runs the fixture module under tsx in a subprocess — the SAME code path
// the smoke:net-dev lane executes, so there is still exactly ONE fixture.
//
// Consumers:
//   - scripts/net-smoke-workerd.ts (tsx lane): imports this + the heavy
//     fixture module directly.
//   - e2e/net-feed.spec.ts (Playwright): imports this only.

import { spawn, execFile, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { signInternalRequest } from "../src/worker/internal-auth";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** H1(b): the /net-smoke doorway now REQUIRES a signed internal request
 * (worker index handleNetSmoke), so it can never be an unauthenticated
 * seeding surface on a reachable deploy. The lane holds the same secret
 * wrangler.smoke.toml sets and signs every doorway call. Kept in lockstep
 * with wrangler.smoke.toml's WOO_INTERNAL_SECRET var. */
const NET_SMOKE_INTERNAL_SECRET = "local-smoke-internal-secret";
const signEnv = { WOO_INTERNAL_SECRET: NET_SMOKE_INTERNAL_SECRET };

/** Sign a doorway Request with the lane's internal secret and fetch it. */
async function signedFetch(url: string, init: RequestInit): Promise<Response> {
  const signed = await signInternalRequest(signEnv, new Request(url, init));
  return fetch(signed);
}

export const EPOCH = "cat-net-lane-1";
// CO15 derived scope names: the DO namespace key IS the scope name.
export const ROOM = "room:net_lane_room";
// The CO14 session turn transitions INTO this second room: a freshly
// minted session hydrates with activeScope = the actor's current location
// (world.ts hydrateSession), so entering the room the actor already
// occupies records no transition — the fold needs a real scope change.
export const ANNEX = "room:net_lane_annex";

// The two client credentials the fixture mints into $system.api_keys
// (the full `apikey:<id>:<secret>` form client-auth.ts parses). A is the
// lane's original identity; B exists for the cross-user e2e — a second
// browser context authenticating as a DIFFERENT actor in the same room.
export const CLIENT_KEY_A = "apikey:lane-key:lane-secret";
export const CLIENT_KEY_B = "apikey:lane-key-b:lane-secret-b";

/** The serializable part of the lane fixture (what --dump prints; the
 * closures — turnRequest and the hand-built submits — exist only in the
 * in-process LaneFixture the tsx lane uses). Cells are opaque here: the
 * harness just ferries them to the /net-smoke seed doorway. */
export type FixtureDump = {
  partitions: Array<[string, unknown[]]>;
  actor: string;
  actorB: string;
  cluster: string;
  clusterB: string;
};

/** Build the shared world fixture in a tsx SUBPROCESS and return its
 * serializable dump — the Playwright-safe way to run the engine-real
 * fixture (see the header). ~seconds: it boots an in-memory world. */
export function dumpLaneFixture(): Promise<FixtureDump> {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(
      "npx",
      ["--no-install", "tsx", join(ROOT, "scripts", "net-smoke-fixture.ts"), "--dump"],
      { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout, stderr) => {
        if (error) {
          rejectPromise(new Error(`fixture dump failed: ${error.message}\n${stderr}`));
          return;
        }
        try {
          resolvePromise(JSON.parse(stdout) as FixtureDump);
        } catch (parseError) {
          rejectPromise(new Error(`fixture dump was not JSON: ${String(parseError)}\n${stdout.slice(0, 500)}`));
        }
      }
    );
  });
}

/** Seed every fixture partition into its scope DO via the /net-smoke
 * doorway (each consumer then makes its own subscribe/pull calls — the
 * lane pulls into its internal gateway, the e2e subscribes the client
 * shard). Idempotent: re-seeding an already-seeded scope is a no-op. */
export async function seedPartitions(base: string, partitions: Array<[string, unknown[]]>): Promise<void> {
  for (const [scope, cells] of partitions) {
    await post(base, "scope", scope, "seed", { scope, catalog_epoch: EPOCH, cells });
  }
}

// ---- workerd lifecycle ------------------------------------------------------

export type WorkerdOptions = {
  /** Extra `wrangler dev` CLI args (e.g. ["--assets", dir] — the e2e
   * lane serves its static test page from the same origin this way, so
   * the browser needs no CORS/proxy; wrangler.smoke.toml itself stays
   * untouched and in guard:smoke-wrangler lockstep). */
  extraArgs?: string[];
  /** Observer for each workerd stdout line (the lane's woo.metric
   * parser). Stdout is always drained through readline regardless. */
  onLine?: (line: string) => void;
};

/** Boot workerd, run `body(base)`, tear down, remove the persist dir. */
export async function withWorkerd(
  vars: Record<string, string>,
  body: (base: string) => Promise<void>,
  options: WorkerdOptions = {}
): Promise<void> {
  const port = await findFreePort();
  const base = `http://127.0.0.1:${port}`;
  const persistDir = mkdtempSync(join(tmpdir(), "woo-net-smoke-"));
  const child = startWorkerd(port, persistDir, vars, options);
  try {
    await waitReady(base);
    await body(base);
  } finally {
    await stopWorkerd(child);
    rmSync(persistDir, { recursive: true, force: true });
  }
}

export function startWorkerd(
  port: number,
  persistDir: string,
  vars: Record<string, string>,
  options: WorkerdOptions = {}
): ChildProcess {
  const varArgs = Object.entries(vars).flatMap(([key, value]) => ["--var", `${key}:${value}`]);
  const child = spawn(
    "npx",
    [
      "--no-install",
      "wrangler",
      "dev",
      "-c",
      "wrangler.smoke.toml",
      "--port",
      String(port),
      "--ip",
      "127.0.0.1",
      "--persist-to",
      persistDir,
      ...varArgs,
      ...(options.extraArgs ?? [])
    ],
    { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"], detached: true }
  );
  child.on("error", (err) => console.error("failed to spawn wrangler dev:", err));
  if (child.stdout) {
    // Always drain stdout (a full pipe would wedge wrangler); forward
    // each line to the consumer's observer when one is given.
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (line) => options.onLine?.(line));
  }
  return child;
}

export async function stopWorkerd(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      /* already gone */
    }
  }
  await Promise.race([exited, sleep(5000)]);
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    /* already gone */
  }
}

export async function waitReady(base: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    try {
      const response = await fetch(`${base}/healthz`);
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error("workerd never became ready");
    await sleep(500);
  }
}

// ---- /net-smoke doorway helpers ---------------------------------------------

export async function postRaw(
  base: string,
  kind: string,
  name: string,
  route: string,
  body: unknown
): Promise<{ status: number; body: unknown }> {
  const response = await signedFetch(`${base}/net-smoke/${kind}/${name}/${route}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { status: response.status, body: await response.json() };
}

export async function post<T>(base: string, kind: string, name: string, route: string, body: unknown): Promise<T> {
  const { status, body: decoded } = await postRaw(base, kind, name, route, body);
  if (status !== 200) throw new Error(`POST /net-smoke/${kind}/${name}/${route} failed: ${status} ${JSON.stringify(decoded)}`);
  return decoded as T;
}

export async function get<T>(base: string, kind: string, name: string, route: string): Promise<T> {
  const response = await signedFetch(`${base}/net-smoke/${kind}/${name}/${route}`, { method: "GET" });
  const decoded = (await response.json()) as T;
  if (!response.ok) throw new Error(`GET /net-smoke/${kind}/${name}/${route} failed: ${response.status}`);
  return decoded;
}

export async function poll<T>(probe: () => Promise<T | null>, timeoutMs = 10_000): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch(() => null);
    if (value !== null) return value;
    if (Date.now() > deadline) return null;
    await sleep(300);
  }
}

export function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address && typeof address === "object") {
        const port = address.port;
        server.close(() => resolve(port));
      } else {
        server.close(() => reject(new Error("no port")));
      }
    });
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
