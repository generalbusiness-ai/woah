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

function makeDirectory(): { directory: DirectoryDO; cleanup: () => void } {
  const state = new FakeDirectoryState();
  const directory = new DirectoryDO(state as unknown as DurableObjectState, env);
  return { directory, cleanup: () => state.close() };
}

const T0 = 1_700_000_000_000;
const FAR_FUTURE = T0 + 60 * 60 * 1000;

describe("DirectoryDO register-session dedup", () => {
  afterEach(() => { vi.useRealTimers(); });

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
});
