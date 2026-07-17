/**
 * Interactive Net development composition.
 *
 * The browser still gets Vite HMR, while every stateful/public operation is
 * proxied to the same Net-only Worker entry used by the deletion-readiness
 * build. Local workerd supplies persistent Durable Object SQLite and real
 * WebSocket/RPC boundaries; this wrapper owns only lifecycle, first install,
 * and the Vite proxy. It contains no turn or catalog behavior.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { createServer as createTcpServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer, loadEnv, type ProxyOptions, type ViteDevServer } from "vite";
import { createWorld } from "../core/bootstrap";
import { parseAutoInstallCatalogs } from "../core/local-catalogs";
import type { WooWorld } from "../core/world";
import { exportIdentity, importIdentity } from "../net/identity";
import { netInstallEpoch } from "../net/install";
import { runNetInstall } from "../../scripts/net-install";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_INTERNAL_SECRET = "local-net-dev-internal-secret";
const DEFAULT_API_KEY = "apikey:local-dev:local-dev-secret";

/** Exact public routes Vite delegates. Prefix matching is intentional for the
 * two path families; all other paths remain Vite's SPA/assets/HMR surface. */
export const NET_DEV_PROXY_ROUTES = [
  "/client-config",
  "/healthz",
  "/mcp",
  "/net-api",
  "/net-install"
] as const;

export type ParsedNetDevApiKey = { token: string; id: string; secret: string };

export function parseNetDevApiKey(value: string): ParsedNetDevApiKey {
  const match = /^apikey:([^:]+):(.+)$/.exec(value.trim());
  if (!match) throw new Error("WOO_NET_DEV_APIKEY must use apikey:<id>:<secret>");
  return { token: value.trim(), id: match[1]!, secret: match[2]! };
}

/** A persisted local namespace is deliberately not auto-migrated when the
 * checked-out catalog bundle changes. Mixing epochs is invalid on Net and an
 * implicit reset would destroy developer state, so startup names the required
 * operator choice instead. */
export function assertNetDevCatalogEpoch(actual: unknown, expected: string): void {
  if (actual === expected) return;
  const found = typeof actual === "string" && actual ? actual : "missing";
  throw new Error(
    `the persisted Net dev world has catalog epoch ${found}, but this checkout expects ${expected}; ` +
    "export/migrate it or run `npm run dev -- --reset`"
  );
}

/** Install-only local identity. Use the same identity export/import contract as
 * a live cutover: bootstrap objects such as $wiz are catalog-scoped, whereas
 * client sessions are owned by an actor cluster. Binding the key to $wiz would
 * make session mint probe a nonexistent `cluster:$wiz`. A carried guest actor
 * has an honest cluster partition and starts at the installed guest-template
 * room, without teaching the Worker any dev identity. */
export function netDevCredentialGraft(apiKey: ParsedNetDevApiKey): (world: WooWorld) => void {
  const donor = createWorld();
  const actor = donor.auth("guest:net-local-dev").actor;
  donor.ensureApiKey("$wiz", actor, apiKey.id, apiKey.secret, "local Net development");
  const identity = exportIdentity(donor.exportWorld());
  return (world) => {
    importIdentity(world, identity);
  };
}

export type NetDevBackend = {
  baseUrl: string;
  apiKey: string;
  child: ChildProcess;
  stop(): Promise<void>;
};

export type StartNetDevBackendOptions = {
  persistDir: string;
  apiKey?: string;
  internalSecret?: string;
  catalogs?: string[];
  quiet?: boolean;
};

/** Start the persistent Net-only backend and ensure a fresh namespace is fully
 * installed before returning. Exported for the stdio/browser smoke lanes. */
export async function startNetDevBackend(options: StartNetDevBackendOptions): Promise<NetDevBackend> {
  const port = await findFreePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const secret = options.internalSecret ?? DEFAULT_INTERNAL_SECRET;
  const apiKey = parseNetDevApiKey(options.apiKey ?? DEFAULT_API_KEY);
  mkdirSync(options.persistDir, { recursive: true });
  const child = spawn(
    "npx",
    [
      "--no-install",
      "wrangler",
      "dev",
      "--config",
      "wrangler.net-dev.toml",
      "--ip",
      "127.0.0.1",
      "--port",
      String(port),
      "--persist-to",
      options.persistDir,
      "--var",
      `WOO_INTERNAL_SECRET:${secret}`
    ],
    { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"], detached: true }
  );
  const prefixOutput = (stream: NodeJS.ReadableStream | null, prefix: string): void => {
    if (!stream) return;
    stream.on("data", (chunk) => {
      if (!options.quiet) process.stderr.write(`${prefix}${String(chunk)}`);
    });
  };
  prefixOutput(child.stdout, "[net] ");
  prefixOutput(child.stderr, "[net] ");

  const stop = async (): Promise<void> => stopChild(child);
  try {
    await waitForWorker(baseUrl, child);
    await ensureNetDevInstalled(baseUrl, secret, apiKey, options.catalogs);
    return { baseUrl, apiKey: apiKey.token, child, stop };
  } catch (error) {
    await stop();
    throw error;
  }
}

async function ensureNetDevInstalled(
  baseUrl: string,
  internalSecret: string,
  apiKey: ParsedNetDevApiKey,
  catalogs: string[] | undefined
): Promise<void> {
  const health = await fetch(`${baseUrl}/healthz`);
  if (health.ok) {
    const body = (await health.json().catch(() => ({}))) as { catalog?: { catalog_epoch?: unknown } };
    assertNetDevCatalogEpoch(body.catalog?.catalog_epoch, netInstallEpoch(catalogs));
    const verified = await verifyDevCredential(baseUrl, apiKey.token);
    if (!verified) {
      throw new Error(
        "the persisted Net dev world is active but does not accept WOO_NET_DEV_APIKEY; " +
        "use the original key or run `npm run dev -- --reset`"
      );
    }
    return;
  }

  const body = (await health.json().catch(() => ({}))) as { reason?: string };
  if (body.reason !== "catalog_unavailable" && body.reason !== "not_active") {
    throw new Error(`Net dev backend is unhealthy: ${health.status} ${JSON.stringify(body)}`);
  }
  await runNetInstall(
    {
      baseUrl,
      dryRun: false,
      verifyApikey: apiKey.token,
      ...(catalogs ? { catalogs } : {}),
      graft: netDevCredentialGraft(apiKey)
    },
    { WOO_INTERNAL_SECRET: internalSecret }
  );
}

async function verifyDevCredential(baseUrl: string, token: string): Promise<boolean> {
  const response = await fetch(`${baseUrl}/net-api/session`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ ttl_ms: 60_000 })
  });
  const body = (await response.json().catch(() => ({}))) as { session?: string };
  if (!response.ok || !body.session) return false;
  await fetch(`${baseUrl}/net-api/session`, {
    method: "DELETE",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ session: body.session })
  }).catch(() => undefined);
  return true;
}

async function main(): Promise<void> {
  const loaded = loadEnv("development", ROOT, "");
  for (const [key, value] of Object.entries(loaded)) {
    if (process.env[key] === undefined) process.env[key] = value;
  }
  const reset = process.argv.slice(2).includes("--reset");
  const unknown = process.argv.slice(2).filter((arg) => arg !== "--reset");
  if (unknown.length > 0) throw new Error(`unknown argument(s): ${unknown.join(", ")}`);
  const persistDir = resolve(ROOT, process.env.WOO_NET_DEV_PERSIST ?? ".woo/net-dev");
  if (reset) rmSync(persistDir, { recursive: true, force: true });
  const catalogs = parseAutoInstallCatalogs(process.env.WOO_AUTO_INSTALL_CATALOGS);
  const backend = await startNetDevBackend({
    persistDir,
    apiKey: process.env.WOO_NET_DEV_APIKEY,
    internalSecret: process.env.WOO_INTERNAL_SECRET,
    catalogs
  });
  let vite: ViteDevServer | null = null;
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    await vite?.close().catch(() => undefined);
    await backend.stop();
  };
  try {
    const proxy = Object.fromEntries(NET_DEV_PROXY_ROUTES.map((route) => [
      route,
      {
        target: backend.baseUrl,
        changeOrigin: true,
        ws: route === "/net-api"
      } satisfies ProxyOptions
    ]));
    vite = await createViteServer({
      root: ROOT,
      configFile: resolve(ROOT, "vite.config.ts"),
      server: {
        host: "127.0.0.1",
        port: Number(process.env.PORT ?? 5173),
        strictPort: true,
        proxy
      }
    });
    process.once("SIGINT", () => void shutdown().finally(() => process.exit(130)));
    process.once("SIGTERM", () => void shutdown().finally(() => process.exit(143)));
    await vite.listen();
    vite.printUrls();
    process.stderr.write(`Net dev MCP: WOO_MCP_URL=http://127.0.0.1:${Number(process.env.PORT ?? 5173)}/net-api/mcp\n`);
    process.stderr.write(`Net dev API key: ${backend.apiKey}\n`);
    await new Promise<void>((resolvePromise, rejectPromise) => {
      backend.child.once("exit", (code) => rejectPromise(new Error(`Net dev backend exited unexpectedly (${code ?? "signal"})`)));
      vite?.httpServer?.once("close", resolvePromise);
    });
  } finally {
    await shutdown();
  }
}

async function waitForWorker(baseUrl: string, child: ChildProcess): Promise<void> {
  const deadline = Date.now() + 60_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited before readiness (${child.exitCode})`);
    try {
      const response = await fetch(`${baseUrl}/client-config`);
      if (response.ok) return;
    } catch {
      // Startup connection refusal is expected until workerd binds the port.
    }
    if (Date.now() >= deadline) throw new Error("wrangler Net dev backend did not become ready within 60s");
    await delay(250);
  }
}

function findFreePort(): Promise<number> {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createTcpServer();
    server.once("error", rejectPromise);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        rejectPromise(new Error("could not allocate a Net dev backend port"));
        return;
      }
      server.close(() => resolvePromise(address.port));
    });
  });
}

async function stopChild(child: ChildProcess): Promise<void> {
  if (child.pid === undefined || child.exitCode !== null) return;
  const exited = new Promise<void>((resolvePromise) => child.once("exit", () => resolvePromise()));
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    child.kill("SIGTERM");
  }
  await Promise.race([exited, delay(5_000)]);
  if (child.exitCode === null) {
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      child.kill("SIGKILL");
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((error) => {
    process.stderr.write(`Net dev failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exit(1);
  });
}
