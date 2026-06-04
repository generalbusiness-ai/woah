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

async function sessionsForScopes(directory: DirectoryDO, scopes: unknown[]): Promise<Record<string, unknown>[]> {
  const resp = await directory.fetch(await signed("/sessions-for-scopes", { scopes, limit: 1024 }));
  expect(resp.ok).toBe(true);
  const body = await resp.json() as Record<string, unknown>;
  return (body.sessions as Record<string, unknown>[]) ?? [];
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
      expect(migratedColumns).toEqual(expect.arrayContaining(["started", "display_name", "focus_list", "actor_props", "last_seen_at"]));
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

// W = PRESENCE_LIVE_WINDOW_MS (5 min) and W/2 throttle, mirrored from
// directory-do.ts. Kept as literals so the test fails loudly if the window is
// retuned without revisiting these expectations.
const PRESENCE_WINDOW_MS = 5 * 60 * 1000;
const PRESENCE_THROTTLE_MS = PRESENCE_WINDOW_MS / 2;

describe("DirectoryDO presence lease", () => {
  afterEach(() => { vi.useRealTimers(); });

  it("backfills last_seen_at from updated_at when migrating an existing row", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const state = new FakeDirectoryState();
    // A legacy row written before the column existed: updated_at is its only
    // recency signal. The migration must seed last_seen_at from it.
    state.storage.sql.exec(`CREATE TABLE session_route (
      session_id TEXT PRIMARY KEY,
      actor TEXT NOT NULL,
      started INTEGER,
      display_name TEXT,
      expires_at INTEGER NOT NULL,
      token_class TEXT NOT NULL,
      current_location TEXT,
      apikey_id TEXT,
      mcp_shard TEXT,
      focus_list TEXT,
      actor_props TEXT,
      updated_at INTEGER NOT NULL
    )`);
    state.storage.sql.exec(
      "INSERT INTO session_route(session_id, actor, expires_at, token_class, current_location, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      "legacy_live", "$leg", FAR_FUTURE, "apikey", "$lobby", T0 - 30_000
    );
    try {
      // Constructing the DO runs the idempotent column migration + backfill.
      const directory = new DirectoryDO(state as unknown as DurableObjectState, env);
      const resolved = await resolve(directory, "legacy_live");
      expect(Number(resolved?.last_seen_at)).toBe(T0 - 30_000);
    } finally {
      state.close();
    }
  });

  it("excludes stale-but-unexpired routes from scope/shard presence, keeps recent ones", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { directory, cleanup } = makeDirectory();
    try {
      // An apikey route registered long ago: unexpired (24h-class lease) but its
      // client is gone — exactly the stale row that inflated fanout to 26.
      await postRegister(directory, {
        session_id: "sess_stale",
        actor: "$stale",
        expires_at: FAR_FUTURE,
        token_class: "apikey",
        active_scope: "$lobby",
        mcp_shard: "mcp-gateway-9"
      });

      // Advance past the presence window, then register a fresh client at the
      // same scope (default touch_presence=true).
      vi.setSystemTime(T0 + PRESENCE_WINDOW_MS + 60_000);
      await postRegister(directory, {
        session_id: "sess_fresh",
        actor: "$fresh",
        expires_at: FAR_FUTURE,
        token_class: "apikey",
        active_scope: "$lobby",
        mcp_shard: "mcp-gateway-3"
      });

      // The stale route still RESOLVES (auth validity is unchanged)...
      expect(await resolve(directory, "sess_stale")).toMatchObject({ actor: "$stale" });
      // ...but is no longer part of the live presence audience or shard set.
      const sessions = await sessionsForScopes(directory, ["$lobby"]);
      expect(sessions.map((s) => s.session_id)).toEqual(["sess_fresh"]);
      expect(await mcpShardsForScopes(directory, ["$lobby"])).toEqual(["mcp-gateway-3"]);
    } finally {
      cleanup();
    }
  });

  it("throttles the presence touch to ~W/2 on unchanged client ingress", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { directory, cleanup } = makeDirectory();
    try {
      const payload = {
        session_id: "sess_touch",
        actor: "$touch",
        expires_at: FAR_FUTURE,
        token_class: "apikey",
        active_scope: "$lobby"
      };
      expect((await postRegister(directory, payload)).wrote).toBe(true);
      expect(Number((await resolve(directory, "sess_touch"))?.last_seen_at)).toBe(T0);

      // Within the throttle: identical ingress is a no-op, lease unchanged.
      vi.setSystemTime(T0 + PRESENCE_THROTTLE_MS - 1_000);
      expect((await postRegister(directory, payload)).wrote).toBe(false);
      expect(Number((await resolve(directory, "sess_touch"))?.last_seen_at)).toBe(T0);

      // Past the throttle: the lease is refreshed by a targeted touch write.
      const touchedAt = T0 + PRESENCE_THROTTLE_MS + 1_000;
      vi.setSystemTime(touchedAt);
      expect((await postRegister(directory, payload)).wrote).toBe(true);
      expect(Number((await resolve(directory, "sess_touch"))?.last_seen_at)).toBe(touchedAt);
    } finally {
      cleanup();
    }
  });

  it("backfills a NULL last_seen_at even when the column already exists (P2: unconditional)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const state = new FakeDirectoryState();
    try {
      // Simulate a partial/interrupted migration: the column exists but a row
      // was left with NULL last_seen_at (e.g. crash between ALTER and backfill,
      // or a direct write). Such a row must not be hidden from presence forever.
      const d1 = new DirectoryDO(state as unknown as DurableObjectState, env);
      // First fetch runs ensureSchema, creating session_route WITH last_seen_at.
      expect(await resolve(d1, "warm_up_missing")).toBeNull();
      state.storage.sql.exec(
        "INSERT INTO session_route(session_id, actor, expires_at, token_class, current_location, updated_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, NULL)",
        "null_lease", "$leg", FAR_FUTURE, "apikey", "$lobby", T0
      );
      // Before re-migration the NULL row is absent from presence.
      expect(await sessionsForScopes(d1, ["$lobby"])).toEqual([]);

      // A fresh DO over the same storage re-runs ensureSchema; the unconditional
      // backfill must seed last_seen_at = updated_at and restore presence.
      const d2 = new DirectoryDO(state as unknown as DurableObjectState, env);
      const sessions = await sessionsForScopes(d2, ["$lobby"]);
      expect(sessions.map((s) => s.session_id)).toEqual(["null_lease"]);
      expect(Number((await resolve(d2, "null_lease"))?.last_seen_at)).toBe(T0);
    } finally {
      state.close();
    }
  });

  it("does not grant presence to a brand-new route registered with touch_presence:false (P3)", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { directory, cleanup } = makeDirectory();
    try {
      // An internal (non-ingress) creator registers a NEW route. It must not
      // enter the live fanout audience until real client ingress touches it.
      const created = await postRegister(directory, {
        session_id: "sess_internal_new",
        actor: "$internal",
        expires_at: FAR_FUTURE,
        token_class: "apikey",
        active_scope: "$lobby",
        mcp_shard: "mcp-gateway-5",
        touch_presence: false
      });
      expect(created.wrote).toBe(true); // the route row is persisted...
      expect(await resolve(directory, "sess_internal_new")).toMatchObject({ actor: "$internal" }); // ...and resolves for auth
      // ...but it is NOT present for fanout/roster until a client touches it.
      expect(await sessionsForScopes(directory, ["$lobby"])).toEqual([]);
      expect(await mcpShardsForScopes(directory, ["$lobby"])).toEqual([]);

      // First real client ingress (default touch_presence) makes it present.
      vi.setSystemTime(T0 + 1_000);
      await postRegister(directory, {
        session_id: "sess_internal_new",
        actor: "$internal",
        expires_at: FAR_FUTURE,
        token_class: "apikey",
        active_scope: "$lobby",
        mcp_shard: "mcp-gateway-5"
      });
      expect((await sessionsForScopes(directory, ["$lobby"])).map((s) => s.session_id)).toEqual(["sess_internal_new"]);
    } finally {
      cleanup();
    }
  });

  it("does not let an internal re-registration (touch_presence:false) refresh a stale lease", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { directory, cleanup } = makeDirectory();
    try {
      await postRegister(directory, {
        session_id: "sess_int",
        actor: "$int",
        expires_at: FAR_FUTURE,
        token_class: "apikey",
        active_scope: "$lobby",
        mcp_shard: "mcp-gateway-1"
      });

      // Past the window, an INTERNAL re-registration rewrites a routing column
      // (active_scope) but must NOT extend presence.
      vi.setSystemTime(T0 + PRESENCE_WINDOW_MS + 60_000);
      const moved = await postRegister(directory, {
        session_id: "sess_int",
        actor: "$int",
        expires_at: FAR_FUTURE,
        token_class: "apikey",
        active_scope: "$garden",
        mcp_shard: "mcp-gateway-1",
        touch_presence: false
      });
      expect(moved.wrote).toBe(true); // routing column did change
      // Lease preserved at the original time, so the row stays stale...
      expect(Number((await resolve(directory, "sess_int"))?.last_seen_at)).toBe(T0);
      // ...and is therefore absent from the live presence set at its new scope.
      expect(await sessionsForScopes(directory, ["$garden"])).toEqual([]);
    } finally {
      cleanup();
    }
  });

  // Regression gate for the smoke finding: two live actors must not yield the
  // 26-session / 16-17-shard fanout blowup that stale apikey routes caused.
  it("bounds a two-actor scope to its two live sessions despite many stale routes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
    const { directory, cleanup } = makeDirectory();
    try {
      // 24 stale apikey routes accumulated at the room across prior runs: each
      // on its own gateway shard, unexpired but long past the presence window.
      for (let i = 0; i < 24; i += 1) {
        await postRegister(directory, {
          session_id: `stale_${i}`,
          actor: `$stale_${i}`,
          expires_at: FAR_FUTURE,
          token_class: "apikey",
          active_scope: "$the_chatroom",
          mcp_shard: `mcp-gateway-${i}`
        });
      }

      // Two real actors arrive now, well after those routes went stale.
      vi.setSystemTime(T0 + PRESENCE_WINDOW_MS + 120_000);
      await postRegister(directory, {
        session_id: "alice",
        actor: "$alice",
        expires_at: FAR_FUTURE,
        token_class: "apikey",
        active_scope: "$the_chatroom",
        mcp_shard: "mcp-gateway-30"
      });
      await postRegister(directory, {
        session_id: "bob",
        actor: "$bob",
        expires_at: FAR_FUTURE,
        token_class: "apikey",
        active_scope: "$the_chatroom",
        mcp_shard: "mcp-gateway-31"
      });

      const sessions = await sessionsForScopes(directory, ["$the_chatroom"]);
      expect(sessions.map((s) => s.session_id).sort()).toEqual(["alice", "bob"]);
      const shards = await mcpShardsForScopes(directory, ["$the_chatroom"]);
      expect(shards.sort()).toEqual(["mcp-gateway-30", "mcp-gateway-31"]);
    } finally {
      cleanup();
    }
  });
});
