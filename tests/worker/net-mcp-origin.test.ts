// MCP `Origin` admission (mcp.md §M7.1), driven THROUGH THE EDGE ENTRY.
//
// The defect this pins: `handleNetApi` rewrites the forwarded URL to
// `https://do/<path>` before dispatching into the gateway DO, while preserving
// the public `Origin` header. The DO's origin check compared the browser's
// origin against that internal URL, so it refused EVERY browser (403 E_PERM)
// and admitted every headless client — the exact inversion of the property it
// was meant to enforce. Confirmed live against production before the fix.
//
// Every request below goes through `worker.fetch` so the URL rewrite is in the
// path. A test that pokes `gateway.fetch("https://do/net-api/mcp")` directly
// cannot see this class of bug at all — which is why it survived.
import { describe, expect, it } from "vitest";
import worker, { sanitizePublicHeaders, type NetOnlyEnv } from "../../src/worker/net-only-index";
import { FakeDurableObjectState } from "./fake-do";
import { createWorld } from "../../src/core/bootstrap";
import { exportIdentity, importIdentity } from "../../src/net/identity";
import { planNetInstall } from "../../src/net/install";
import { NetGatewayDO, type NetGatewayDurableState, type NetGatewayEnv } from "../../src/worker/net/gateway-do";
import { NetScopeDO, type NetScopeDurableState, type NetScopeEnv } from "../../src/worker/net/scope-do";
import { signInternalRequest } from "../../src/worker/internal-auth";
import { mcpOriginDecision, withPublicOrigin, PUBLIC_ORIGIN_HEADER } from "../../src/worker/public-origin";

const SECRET = "net-mcp-origin-secret";
const TOKEN = "apikey:origin-key-a:origin-secret-a";

function netState(name: string) {
  const fake = new FakeDurableObjectState(name);
  const deferred: Array<Promise<unknown>> = [];
  const state: NetScopeDurableState & NetGatewayDurableState = {
    id: fake.id,
    waitUntil: (promise: Promise<unknown>) => {
      deferred.push(promise);
    },
    storage: {
      sql: fake.storage.sql,
      transactionSync: fake.storage.transactionSync,
      setAlarm: () => {},
      deleteAlarm: () => {}
    }
  };
  return {
    state,
    pending: () => deferred.length,
    settle: async () => {
      while (deferred.length > 0) await deferred.shift();
    },
    close: () => fake.close()
  };
}

type Rpc = { jsonrpc: "2.0"; id?: number; method: string; params?: unknown };

type EdgeRequest = {
  /** Public URL the browser addressed — the edge's own origin comes from here. */
  url?: string;
  method?: "POST" | "GET" | "DELETE";
  /** Omitted entirely when undefined, so "no Origin header" is testable. */
  origin?: string;
  headers?: Record<string, string>;
  body?: Rpc;
};

/** A one-actor installed world reachable only through the Worker entry. */
async function fixture(options: { allowedOrigins?: string } = {}) {
  const old = createWorld();
  const alice = old.auth("guest:origin-alice").actor;
  old.ensureApiKey("$wiz", alice, "origin-key-a", "origin-secret-a", "alice");
  const identity = exportIdentity(old.exportWorld());
  const plan = await planNetInstall({
    graft: async (fresh) => {
      importIdentity(fresh, identity);
    }
  });

  const states: Array<ReturnType<typeof netState>> = [];
  const scopeDOs = new Map<string, NetScopeDO>();
  let gateway: NetGatewayDO;
  const resolve = (destination: string) => {
    // One shard, so routeNetGateway always names the legacy shard.
    if (destination === "gateway:net-api") return gateway;
    if (destination.startsWith("scope:")) {
      const instance = scopeDOs.get(destination.slice("scope:".length));
      if (instance) return instance;
    }
    throw new Error(`unresolvable destination ${destination}`);
  };
  const scopeEnv: NetScopeEnv = { WOO_INTERNAL_SECRET: SECRET, NET_RESOLVE: resolve };
  for (const [scope, cells] of plan.partitions) {
    const st = netState(`scope-${scope}`);
    const instance = new NetScopeDO(st.state, scopeEnv);
    const seeded = await instance.fetch(await signInternalRequest(scopeEnv, new Request("https://do/net/seed", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ scope, catalog_epoch: plan.epoch, cells, relations: plan.relations.get(scope) ?? [] })
    })));
    expect(seeded.ok, `seed ${scope}`).toBe(true);
    states.push(st);
    scopeDOs.set(scope, instance);
  }
  const gatewayState = netState("gateway-net-api");
  states.push(gatewayState);
  const gatewayEnv = {
    WOO_INTERNAL_SECRET: SECRET,
    NET_RESOLVE: resolve,
    NET_GATEWAY_SELF: "gateway:net-api",
    ...(options.allowedOrigins === undefined ? {} : { WOO_MCP_ALLOWED_ORIGINS: options.allowedOrigins })
  } as NetGatewayEnv;
  gateway = new NetGatewayDO(gatewayState.state, gatewayEnv);

  const env = {
    WOO_INTERNAL_SECRET: SECRET,
    NET_API_GATEWAY_SHARDS: "1",
    NET_RESOLVE: resolve
  } as NetOnlyEnv;

  /** One MCP request through the real public entry. */
  const edge = async (request: EdgeRequest) => {
    const method = request.method ?? "POST";
    const headers: Record<string, string> = {
      "content-type": "application/json",
      ...(request.origin === undefined ? {} : { origin: request.origin }),
      ...request.headers
    };
    const response = await worker.fetch(new Request(request.url ?? "https://woah1.generalbusiness.ai/net-api/mcp", {
      method,
      headers,
      ...(method === "POST" ? { body: JSON.stringify(request.body ?? initialize()) } : {})
    }), env);
    const text = await response.text();
    return {
      status: response.status,
      session: response.headers.get("mcp-session-id"),
      body: text ? JSON.parse(text) as Record<string, any> : null
    };
  };

  const close = async () => {
    // Session creation can enqueue relation/fanout work after the HTTP reply.
    // Drain every fake DO to a fixed point before closing SQLite so a failure
    // belongs to this test instead of leaking into the next Origin case.
    while (states.some((state) => state.pending() > 0)) {
      for (const st of states) await st.settle();
    }
    for (const st of states) st.close();
  };
  return { edge, close };
}

function initialize(): Rpc {
  return { jsonrpc: "2.0", id: 1, method: "initialize", params: {} };
}

/** An `initialize` that actually minted a session — the only proof that the
 * request reached the MCP surface rather than being refused at the gate. */
function expectInitialized(result: { status: number; session: string | null; body: Record<string, any> | null }) {
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  expect(result.session).toBeTruthy();
  expect(result.body?.result?.capabilities?.tools?.listChanged).toBe(true);
}

function expectForeignOriginRefusal(result: { status: number; body: Record<string, any> | null }) {
  expect(result.status).toBe(403);
  expect(result.body?.error?.code).toBe("E_PERM");
  expect(result.body?.error?.message).toBe("foreign MCP Origin is not allowed");
}

describe("MCP Origin admission through the Worker edge", () => {
  it("admits a same-origin browser on either public hostname and on workers.dev", async () => {
    const { edge, close } = await fixture();
    try {
      // The regression: before the fix every one of these was a 403, because
      // the DO compared the browser origin against the rewritten `https://do`.
      expectInitialized(await edge({
        url: "https://woah1.generalbusiness.ai/net-api/mcp",
        origin: "https://woah1.generalbusiness.ai",
        headers: { "mcp-token": TOKEN }
      }));
      // The landing host serves the protocol routes itself (no 308 for /mcp),
      // and /mcp aliases onto /net-api/mcp inside the same entry.
      expectInitialized(await edge({
        url: "https://woah.generalbusiness.ai/mcp",
        origin: "https://woah.generalbusiness.ai",
        headers: { "mcp-token": TOKEN }
      }));
      // Nothing is compiled in: the rule is "the origin this edge was
      // addressed at", so a workers.dev deployment passes with no config.
      expectInitialized(await edge({
        url: "https://woo.example-account.workers.dev/net-api/mcp",
        origin: "https://woo.example-account.workers.dev",
        headers: { "mcp-token": TOKEN }
      }));
    } finally {
      await close();
    }
  });

  it("refuses a genuinely foreign browser origin on POST, GET and DELETE", async () => {
    const { edge, close } = await fixture();
    try {
      expectForeignOriginRefusal(await edge({
        origin: "https://evil.example",
        headers: { "mcp-token": TOKEN }
      }));
      // A sibling hostname is foreign too — same registrable domain is not
      // same origin.
      expectForeignOriginRefusal(await edge({
        url: "https://woah1.generalbusiness.ai/net-api/mcp",
        origin: "https://woah.generalbusiness.ai",
        headers: { "mcp-token": TOKEN }
      }));
      // The gate covers the whole Streamable HTTP triple, not just POST.
      expectForeignOriginRefusal(await edge({ method: "GET", origin: "https://evil.example" }));
      expectForeignOriginRefusal(await edge({ method: "DELETE", origin: "https://evil.example" }));
      // An opaque origin (sandboxed iframe, cross-origin redirect) is a
      // browser request that cannot prove same-origin, so it is refused
      // rather than treated as absent.
      expectForeignOriginRefusal(await edge({ origin: "null", headers: { "mcp-token": TOKEN } }));
    } finally {
      await close();
    }
  });

  it("ignores a forged inbound copy of the trusted public-origin header", async () => {
    const { edge, close } = await fixture();
    try {
      // The attack the header design must survive: a client asserts that the
      // endpoint's public origin is its own, so its foreign Origin matches.
      // sanitizePublicHeaders strips `x-woo-internal-*` inbound, and
      // handleNetApi deletes it again before setting the real value.
      expectForeignOriginRefusal(await edge({
        url: "https://woah1.generalbusiness.ai/net-api/mcp",
        origin: "https://evil.example",
        headers: { "mcp-token": TOKEN, [PUBLIC_ORIGIN_HEADER]: "https://evil.example" }
      }));
      // Nor can a forged header make a legitimate endpoint look foreign, or
      // otherwise perturb the decision for a real same-origin browser.
      expectInitialized(await edge({
        url: "https://woah1.generalbusiness.ai/net-api/mcp",
        origin: "https://woah1.generalbusiness.ai",
        headers: { "mcp-token": TOKEN, [PUBLIC_ORIGIN_HEADER]: "https://evil.example" }
      }));
    } finally {
      await close();
    }
  });

  it("DECISION: an absent Origin is admitted, because non-browser MCP clients omit it", async () => {
    const { edge, close } = await fixture();
    try {
      // Named explicitly so the choice is reviewable rather than incidental:
      // stdio bridges, CLI agents and server runtimes send no Origin, and
      // refusing them would break every legitimate headless client while
      // stopping no attacker (anyone who can omit a header can send any
      // header). Credentials authorize the call; Origin only constrains
      // browsers, which cannot lie about it.
      expectInitialized(await edge({ headers: { "mcp-token": TOKEN } }));
    } finally {
      await close();
    }
  });

  it("admits the `npm run dev` loopback proxy, where the page port and the worker port differ", async () => {
    const { edge, close } = await fixture();
    try {
      // Vite serves the SPA on :5173 and proxies /net-api to workerd on
      // another loopback port with changeOrigin, so the browser's Origin and
      // the Worker's Host legitimately disagree. Allowed only because the
      // endpoint is itself loopback; a deployed endpoint never is.
      expectInitialized(await edge({
        url: "http://127.0.0.1:8787/net-api/mcp",
        origin: "http://localhost:5173",
        headers: { "mcp-token": TOKEN }
      }));
      // A rebinding page's Origin is its own routable name, never a loopback
      // literal, so the loopback clause cannot launder it.
      expectForeignOriginRefusal(await edge({
        url: "http://127.0.0.1:8787/net-api/mcp",
        origin: "http://evil.example",
        headers: { "mcp-token": TOKEN }
      }));
    } finally {
      await close();
    }
  });

  it("refuses a DNS-rebinding shape: plain http on a routable name is not a same-origin reference", async () => {
    const { edge, close } = await fixture();
    try {
      // Under rebinding the browser sends a self-consistent Host AND Origin
      // for the attacker's own name, so deriving same-origin from the request
      // alone would admit it. Only https (TLS-authenticated hostname) or a
      // loopback literal counts, so this fails closed.
      expectForeignOriginRefusal(await edge({
        url: "http://evil.example/net-api/mcp",
        origin: "http://evil.example",
        headers: { "mcp-token": TOKEN }
      }));
    } finally {
      await close();
    }
  });

  it("admits an operator-configured extra origin, and nothing else", async () => {
    const { edge, close } = await fixture({ allowedOrigins: "https://console.example, https://ops.example" });
    try {
      expectInitialized(await edge({
        url: "https://woah1.generalbusiness.ai/net-api/mcp",
        origin: "https://console.example",
        headers: { "mcp-token": TOKEN }
      }));
      expectForeignOriginRefusal(await edge({
        url: "https://woah1.generalbusiness.ai/net-api/mcp",
        origin: "https://other.example",
        headers: { "mcp-token": TOKEN }
      }));
    } finally {
      await close();
    }
  });
});

describe("public-origin header trust boundary", () => {
  it("keeps the header on the prefix sanitizePublicHeaders strips", () => {
    // The teeth of the forgery case: `Headers.set` in withPublicOrigin already
    // overwrites any inbound copy, so this asserts the SECOND layer — the one
    // that still holds if a future route forwards a public request without
    // going through handleNetApi. Renaming the header off `x-woo-internal-`
    // fails here.
    const cleaned = sanitizePublicHeaders(new Request("https://woah1.generalbusiness.ai/net-api/mcp", {
      method: "POST",
      headers: { [PUBLIC_ORIGIN_HEADER]: "https://evil.example" },
      body: "{}"
    })).headers;
    expect(PUBLIC_ORIGIN_HEADER.startsWith("x-woo-internal-")).toBe(true);
    expect(cleaned.has(PUBLIC_ORIGIN_HEADER)).toBe(false);
  });

  it("asserts exactly one value — the edge's own origin, with no path or query", () => {
    const headers = withPublicOrigin(
      new Headers({ [PUBLIC_ORIGIN_HEADER]: "https://evil.example" }),
      new URL("https://woah1.generalbusiness.ai/net-api/mcp?session=abc")
    );
    // Exact equality, not `toContain`: `set` REPLACES, whereas `append` would
    // leave the forged value in the list and `get` would return the two joined
    // by ", ". That joined string parses as no origin at all, which fails
    // closed for every browser — i.e. reintroduces the production bug. This
    // assertion is what catches a set→append edit.
    expect(headers.get(PUBLIC_ORIGIN_HEADER)).toBe("https://woah1.generalbusiness.ai");
    expect(mcpOriginDecision({
      origin: "https://woah1.generalbusiness.ai",
      publicOrigin: headers.get(PUBLIC_ORIGIN_HEADER)
    })).toBe("allow");
  });
});

describe("mcpOriginDecision", () => {
  const publicOrigin = "https://woah1.generalbusiness.ai";

  it("fails closed when the edge asserted no public origin", () => {
    // A request that did not pass through handleNetApi (a direct DO fetch, or
    // an older edge during a rolling deploy) has no trustworthy reference, so
    // a browser is refused rather than silently admitted.
    expect(mcpOriginDecision({ origin: "https://woah1.generalbusiness.ai", publicOrigin: null })).toBe("refuse");
    expect(mcpOriginDecision({ origin: null, publicOrigin: null })).toBe("allow");
  });

  it("rejects unparseable and opaque values on both sides", () => {
    expect(mcpOriginDecision({ origin: "not a url", publicOrigin })).toBe("refuse");
    expect(mcpOriginDecision({ origin: "null", publicOrigin })).toBe("refuse");
    expect(mcpOriginDecision({ origin: publicOrigin, publicOrigin: "not a url" })).toBe("refuse");
  });

  it("compares serialized origins, ignoring path, query and default ports", () => {
    expect(mcpOriginDecision({ origin: "https://woah1.generalbusiness.ai/some/page?q=1", publicOrigin })).toBe("allow");
    expect(mcpOriginDecision({ origin: "https://woah1.generalbusiness.ai:443", publicOrigin })).toBe("allow");
    // A differing explicit port is a different origin.
    expect(mcpOriginDecision({ origin: "https://woah1.generalbusiness.ai:8443", publicOrigin })).toBe("refuse");
    // Scheme is part of the origin.
    expect(mcpOriginDecision({ origin: "http://woah1.generalbusiness.ai", publicOrigin })).toBe("refuse");
  });

  it("treats every loopback spelling as loopback for a loopback endpoint", () => {
    for (const origin of ["http://localhost:5173", "http://127.0.0.1:5173", "http://[::1]:5173", "https://app.localhost"]) {
      expect(mcpOriginDecision({ origin, publicOrigin: "http://127.0.0.1:8787" }), origin).toBe("allow");
    }
    expect(mcpOriginDecision({ origin: "http://localhost:5173", publicOrigin })).toBe("refuse");
  });

  it("parses a configured allow-list on commas or whitespace and drops junk", () => {
    const configured = " https://a.example,,https://b.example\nnot-a-url  https://c.example ";
    for (const origin of ["https://a.example", "https://b.example", "https://c.example"]) {
      expect(mcpOriginDecision({ origin, publicOrigin, configured }), origin).toBe("allow");
    }
    expect(mcpOriginDecision({ origin: "https://d.example", publicOrigin, configured })).toBe("refuse");
    // A configured entry never rescues an unparseable Origin.
    expect(mcpOriginDecision({ origin: "not-a-url", publicOrigin, configured })).toBe("refuse");
  });
});
