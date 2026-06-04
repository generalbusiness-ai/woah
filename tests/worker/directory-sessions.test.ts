import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi, afterEach } from "vitest";
import { DirectoryDO } from "../../src/worker/directory-do";
import { signInternalRequest, type InternalAuthEnv } from "../../src/worker/internal-auth";

// Tiny shim around node:sqlite that satisfies the slice of the
// DurableObjectState API DirectoryDO touches. Mirrors the harness in
// directory-tombstones.test.ts; kept inline here so this file can be read
// stand-alone.
class FakeSqlCursor {
  constructor(private readonly rows: Record<string, unknown>[]) {}
  toArray(): Record<string, unknown>[] { return this.rows; }
  [Symbol.iterator](): Iterator<Record<string, unknown>> { return this.rows[Symbol.iterator](); }
}

class FakeSqlStorage {
  constructor(private readonly db: DatabaseSync) {}
  exec(query: string, ...params: unknown[]): FakeSqlCursor {
    const stmt = this.db.prepare(query);
    const head = query.trim().split(/\s+/, 1)[0]?.toUpperCase();
    if (head === "SELECT" || head === "PRAGMA") {
      return new FakeSqlCursor(stmt.all(...(params as any[])) as Record<string, unknown>[]);
    }
    stmt.run(...(params as any[]));
    return new FakeSqlCursor([]);
  }
}

class FakeDirectoryState {
  readonly id = { name: "directory" };
  private readonly db = new DatabaseSync(":memory:");
  readonly storage = {
    sql: new FakeSqlStorage(this.db),
    transactionSync: <T>(fn: () => T): T => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const r = fn();
        this.db.exec("COMMIT");
        return r;
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    }
  };
  close(): void { this.db.close(); }
}

const SECRET = "test-secret";
const env: InternalAuthEnv = { WOO_INTERNAL_SECRET: SECRET };

async function signed(path: string, body: unknown): Promise<Request> {
  return await signInternalRequest(env, new Request(`https://woo.test${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-woo-host-key": "world" },
    body: JSON.stringify(body)
  }));
}

async function postRegister(directory: DirectoryDO, payload: Record<string, unknown>): Promise<{ ok: boolean; wrote: boolean }> {
  const resp = await directory.fetch(await signed("/register-session", payload));
  expect(resp.ok).toBe(true);
  return await resp.json() as { ok: boolean; wrote: boolean };
}

async function resolve(directory: DirectoryDO, sessionId: string): Promise<Record<string, unknown> | null> {
  const resp = await directory.fetch(await signed("/resolve-session", { session_id: sessionId }));
  expect(resp.ok).toBe(true);
  const body = await resp.json() as Record<string, unknown>;
  return (body.session as Record<string, unknown>) ?? null;
}

async function mcpShardsForScopes(directory: DirectoryDO, scopes: unknown[]): Promise<string[]> {
  const resp = await directory.fetch(await signed("/mcp-shards-for-scopes", { scopes }));
  expect(resp.ok).toBe(true);
  const body = await resp.json() as Record<string, unknown>;
  return body.shards as string[];
}

function makeDirectory(): { directory: DirectoryDO; cleanup: () => void } {
  const state = new FakeDirectoryState();
  const directory = new DirectoryDO(state as unknown as DurableObjectState, env);
  return { directory, cleanup: () => state.close() };
}

function sessionRouteColumns(state: FakeDirectoryState): string[] {
  return state.storage.sql.exec("PRAGMA table_info(session_route)")
    .toArray()
    .map((row) => String(row.name ?? ""))
    .filter(Boolean)
    .sort();
}

const T0 = 1_700_000_000_000;
const FAR_FUTURE = T0 + 60 * 60 * 1000;

describe("DirectoryDO register-session dedup", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("migrates legacy session_route columns idempotently", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const state = new FakeDirectoryState();
    state.storage.sql.exec(`CREATE TABLE session_route (
      session_id TEXT PRIMARY KEY,
      actor TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      token_class TEXT NOT NULL,
      current_location TEXT,
      apikey_id TEXT,
      mcp_shard TEXT,
      updated_at INTEGER NOT NULL
    )`);
    try {
      expect(sessionRouteColumns(state)).not.toContain("started");
      expect(sessionRouteColumns(state)).not.toContain("display_name");
      expect(sessionRouteColumns(state)).not.toContain("focus_list");
      expect(sessionRouteColumns(state)).not.toContain("actor_props");

      const directory = new DirectoryDO(state as unknown as DurableObjectState, env);
      const payload = {
        session_id: "legacy_sess",
        actor: "$legacy_actor",
        started: T0 - 10_000,
        display_name: "Legacy Actor",
        expires_at: FAR_FUTURE,
        token_class: "guest",
        active_scope: "$lobby",
        mcp_shard: "mcp-gateway-7",
        focus_list: ["$pinboard"],
        actor_props: [{ name: "home", value: "$nowhere", version: 1 }]
      };
      expect(await postRegister(directory, payload)).toEqual({ ok: true, wrote: true });

      const migratedColumns = sessionRouteColumns(state);
      expect(migratedColumns).toEqual(expect.arrayContaining(["started", "display_name", "focus_list", "actor_props"]));
      const resolved = await resolve(directory, "legacy_sess");
      expect(resolved).toMatchObject({
        session_id: "legacy_sess",
        actor: "$legacy_actor",
        started: T0 - 10_000,
        display_name: "Legacy Actor",
        active_scope: "$lobby",
        current_location: "$lobby",
        mcp_shard: "mcp-gateway-7",
        focus_list: ["$pinboard"],
        actor_props: [{ name: "home", value: "$nowhere", version: 1 }]
      });

      const directoryAfterEviction = new DirectoryDO(state as unknown as DurableObjectState, env);
      expect(await postRegister(directoryAfterEviction, payload)).toEqual({ ok: true, wrote: false });
      expect(sessionRouteColumns(state)).toEqual(migratedColumns);
    } finally {
      state.close();
    }
  });

  it("skips the row write when every persisted column matches", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { directory, cleanup } = makeDirectory();
    try {
      const payload = {
        session_id: "sess_a",
        actor: "$alice",
        expires_at: FAR_FUTURE,
        token_class: "guest",
        active_scope: "$lobby",
        current_location: "$lobby",
        apikey_id: null
      };

      const first = await postRegister(directory, payload);
      expect(first.wrote).toBe(true);
      const initialUpdatedAt = Number((await resolve(directory, "sess_a"))?.updated_at);
      expect(initialUpdatedAt).toBe(T0);

      vi.setSystemTime(T0 + 5_000);
      const second = await postRegister(directory, payload);
      expect(second.wrote).toBe(false);

      // updated_at unchanged is the user-visible signal that no write happened.
      const after = await resolve(directory, "sess_a");
      expect(Number(after?.updated_at)).toBe(initialUpdatedAt);
    } finally {
      cleanup();
    }
  });

  it("writes when active_scope changes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { directory, cleanup } = makeDirectory();
    try {
      const base = {
        session_id: "sess_b",
        actor: "$bob",
        expires_at: FAR_FUTURE,
        token_class: "bearer",
        active_scope: "$lobby",
        apikey_id: null
      };
      await postRegister(directory, base);

      vi.setSystemTime(T0 + 5_000);
      const moved = await postRegister(directory, { ...base, active_scope: "$garden" });
      expect(moved.wrote).toBe(true);

      const after = await resolve(directory, "sess_b");
      expect(after?.active_scope).toBe("$garden");
      expect(after?.current_location).toBe("$garden");
      expect(Number(after?.updated_at)).toBe(T0 + 5_000);
    } finally {
      cleanup();
    }
  });

  it("writes when expires_at advances (session extension)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { directory, cleanup } = makeDirectory();
    try {
      const base = {
        session_id: "sess_c",
        actor: "$carol",
        expires_at: T0 + 5 * 60 * 1000,
        token_class: "guest",
        current_location: null,
        apikey_id: null
      };
      await postRegister(directory, base);

      vi.setSystemTime(T0 + 60_000);
      const extended = await postRegister(directory, { ...base, expires_at: T0 + 10 * 60 * 1000 });
      expect(extended.wrote).toBe(true);

      const after = await resolve(directory, "sess_c");
      expect(Number(after?.expires_at)).toBe(T0 + 10 * 60 * 1000);
    } finally {
      cleanup();
    }
  });

  it("writes when apikey_id transitions null → set", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { directory, cleanup } = makeDirectory();
    try {
      const base = {
        session_id: "sess_d",
        actor: "$dave",
        expires_at: FAR_FUTURE,
        token_class: "bearer",
        current_location: null,
        apikey_id: null
      };
      await postRegister(directory, base);

      vi.setSystemTime(T0 + 1_000);
      const upgraded = await postRegister(directory, { ...base, token_class: "apikey", apikey_id: "key_xyz" });
      expect(upgraded.wrote).toBe(true);
    } finally {
      cleanup();
    }
  });

  it("resolves active MCP shards by session active scope", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { directory, cleanup } = makeDirectory();
    try {
      await postRegister(directory, {
        session_id: "sess_lobby",
        actor: "$alice",
        expires_at: FAR_FUTURE,
        token_class: "guest",
        active_scope: "$lobby",
        mcp_shard: "mcp-gateway-1"
      });
      await postRegister(directory, {
        session_id: "sess_garden",
        actor: "$bob",
        expires_at: FAR_FUTURE,
        token_class: "guest",
        active_scope: "$garden",
        mcp_shard: "mcp-gateway-2"
      });
      await postRegister(directory, {
        session_id: "sess_expired",
        actor: "$carol",
        expires_at: T0 - 1,
        token_class: "guest",
        active_scope: "$garden",
        mcp_shard: "mcp-gateway-3"
      });

      await postRegister(directory, {
        session_id: "sess_other_garden",
        actor: "$dave",
        expires_at: FAR_FUTURE,
        token_class: "guest",
        active_scope: "$garden",
        mcp_shard: "mcp-gateway-2"
      });

      expect(await mcpShardsForScopes(directory, ["$garden", "$missing", "$garden"])).toEqual(["mcp-gateway-2"]);
      expect(await mcpShardsForScopes(directory, ["$lobby", "$garden"])).toEqual(["mcp-gateway-1", "mcp-gateway-2"]);
    } finally {
      cleanup();
    }
  });

  it("purges expired session routes in one signed cleanup call", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { directory, cleanup } = makeDirectory();
    try {
      await postRegister(directory, {
        session_id: "sess_expired",
        actor: "$expired",
        expires_at: T0 - 1,
        token_class: "guest",
        active_scope: "$lobby"
      });
      await postRegister(directory, {
        session_id: "sess_live",
        actor: "$live",
        expires_at: FAR_FUTURE,
        token_class: "guest",
        active_scope: "$lobby"
      });

      const purged = await directory.fetch(await signed("/purge-expired-sessions", {}));
      expect(purged.ok).toBe(true);
      expect(await purged.json()).toMatchObject({ ok: true, removed: 1 });
      expect(await resolve(directory, "sess_expired")).toBeNull();
      expect(await resolve(directory, "sess_live")).toMatchObject({ actor: "$live" });
    } finally {
      cleanup();
    }
  });

  it("purges stale guest routes across transports without deleting fresh or non-guest sessions", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { directory, cleanup } = makeDirectory();
    try {
      await postRegister(directory, {
        session_id: "sess_old_mcp_guest",
        actor: "$old_guest",
        expires_at: FAR_FUTURE,
        token_class: "guest",
        active_scope: "$lobby",
        mcp_shard: "mcp-gateway-1"
      });
      await postRegister(directory, {
        session_id: "sess_old_rest_guest",
        actor: "$old_rest_guest",
        expires_at: FAR_FUTURE,
        token_class: "guest",
        active_scope: "$lobby"
      });
      await postRegister(directory, {
        session_id: "sess_old_mcp_bearer",
        actor: "$old_bearer",
        expires_at: FAR_FUTURE,
        token_class: "bearer",
        active_scope: "$lobby",
        mcp_shard: "mcp-gateway-1"
      });
      vi.setSystemTime(T0 + 120_000);
      await postRegister(directory, {
        session_id: "sess_fresh_mcp_guest",
        actor: "$fresh_guest",
        expires_at: FAR_FUTURE,
        token_class: "guest",
        active_scope: "$lobby",
        mcp_shard: "mcp-gateway-2"
      });

      const purged = await directory.fetch(await signed("/purge-stale-guest-sessions", { updated_before: T0 + 60_000 }));
      expect(purged.ok).toBe(true);
      expect(await purged.json()).toMatchObject({ ok: true, removed: 2 });
      expect(await resolve(directory, "sess_old_mcp_guest")).toBeNull();
      expect(await resolve(directory, "sess_old_rest_guest")).toBeNull();
      expect(await resolve(directory, "sess_old_mcp_bearer")).toMatchObject({ actor: "$old_bearer" });
      expect(await resolve(directory, "sess_fresh_mcp_guest")).toMatchObject({ actor: "$fresh_guest" });
    } finally {
      cleanup();
    }
  });
});
