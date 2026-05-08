import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { DirectoryDO } from "../../src/worker/directory-do";
import { signInternalRequest, type InternalAuthEnv } from "../../src/worker/internal-auth";

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
  private depth = 0;

  readonly storage = {
    sql: new FakeSqlStorage(this.db),
    transactionSync: <T>(fn: () => T): T => {
      if (this.depth > 0) {
        const sp = `sp_${this.depth}`;
        this.db.exec(`SAVEPOINT ${sp}`);
        try {
          this.depth += 1;
          const result = fn();
          this.db.exec(`RELEASE SAVEPOINT ${sp}`);
          return result;
        } catch (err) {
          this.db.exec(`ROLLBACK TO SAVEPOINT ${sp}`);
          this.db.exec(`RELEASE SAVEPOINT ${sp}`);
          throw err;
        } finally {
          this.depth -= 1;
        }
      }
      this.db.exec("BEGIN IMMEDIATE");
      this.depth = 1;
      try {
        const r = fn();
        this.db.exec("COMMIT");
        return r;
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      } finally {
        this.depth = 0;
      }
    }
  };

  close(): void { this.db.close(); }
}

const SECRET = "test-secret";
const env: InternalAuthEnv = { WOO_INTERNAL_SECRET: SECRET };

async function signed(host: string, path: string, body: unknown, method = "POST"): Promise<Request> {
  const url = `https://woo.test${path}`;
  const init: RequestInit = method === "GET"
    ? { method }
    : { method, headers: { "content-type": "application/json", "x-woo-host-key": host }, body: JSON.stringify(body) };
  return await signInternalRequest(env, new Request(url, init));
}

async function registerObjectRoute(directory: DirectoryDO, id: string, host: string): Promise<void> {
  const req = await signed(host, "/register-objects", { routes: [{ id, host, anchor: null }] });
  const resp = await directory.fetch(req);
  expect(resp.ok).toBe(true);
}

async function inheritTombstones(
  directory: DirectoryDO,
  host: string,
  payload: { batch_seq?: number; final?: boolean; tombstones: Array<{ id: string; recycled_at: number; reason?: string }> }
): Promise<{ status: number; body: any }> {
  const req = await signed(host, "/__internal/inherit-tombstones", {
    host,
    batch_seq: payload.batch_seq ?? 0,
    final: payload.final ?? true,
    tombstones: payload.tombstones
  });
  const resp = await directory.fetch(req);
  return { status: resp.status, body: await resp.json() as any };
}

async function lookup(directory: DirectoryDO, host: string, id: string): Promise<any> {
  const req = await signed(host, "/__internal/lookup-inherited-tombstone", { id });
  const resp = await directory.fetch(req);
  return await resp.json();
}

async function resolveObject(directory: DirectoryDO, host: string, id: string): Promise<any> {
  const req = await signed(host, "/resolve-object", { id, fallback_host: "world" });
  const resp = await directory.fetch(req);
  return await resp.json();
}

function makeDirectory(): { directory: DirectoryDO; cleanup: () => void } {
  const state = new FakeDirectoryState();
  const directory = new DirectoryDO(state as unknown as DurableObjectState, env);
  return { directory, cleanup: () => state.close() };
}

describe("DirectoryDO inherit-tombstones", () => {
  it("accepts a batch and inserts inherited rows + removes id_route entries", async () => {
    const { directory, cleanup } = makeDirectory();
    try {
      await registerObjectRoute(directory, "task_1", "host_a");
      await registerObjectRoute(directory, "task_2", "host_a");

      const result = await inheritTombstones(directory, "host_a", {
        tombstones: [
          { id: "task_1", recycled_at: 1_000, reason: "recycle" },
          { id: "task_2", recycled_at: 2_000, reason: "force_recycle" }
        ]
      });
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        ok: true, accepted: 2, inserted: 2, routes_removed: 2, batch_seq: 0, final: true
      });

      // id_route rows are gone
      const r1 = await resolveObject(directory, "host_a", "task_1");
      expect(r1.host).toBe("world"); // fallback, no route, no in-table row

      // inherited_tombstone is queryable
      const t1 = await lookup(directory, "host_a", "task_1");
      expect(t1).toMatchObject({ id: "task_1", tombstoned: true, former_host: "host_a", recycled_at: 1_000, reason: "recycle" });
      const t2 = await lookup(directory, "host_a", "task_2");
      expect(t2).toMatchObject({ id: "task_2", tombstoned: true, former_host: "host_a", reason: "force_recycle" });
    } finally {
      cleanup();
    }
  });

  it("is idempotent on retry with the same batch", async () => {
    const { directory, cleanup } = makeDirectory();
    try {
      await registerObjectRoute(directory, "task_x", "host_b");

      const first = await inheritTombstones(directory, "host_b", {
        tombstones: [{ id: "task_x", recycled_at: 100 }]
      });
      expect(first.body.inserted).toBe(1);
      expect(first.body.routes_removed).toBe(1);

      // Replay the same batch — route is already gone, row already inserted.
      const second = await inheritTombstones(directory, "host_b", {
        tombstones: [{ id: "task_x", recycled_at: 100 }]
      });
      expect(second.status).toBe(200);
      expect(second.body).toMatchObject({ accepted: 1, inserted: 0, routes_removed: 0 });
    } finally {
      cleanup();
    }
  });

  it("rejects when body.host does not match x-woo-host-key", async () => {
    const { directory, cleanup } = makeDirectory();
    try {
      await registerObjectRoute(directory, "task_y", "host_c");
      // Sign as host_c but claim host_d in the body.
      const req = await signInternalRequest(env, new Request("https://woo.test/__internal/inherit-tombstones", {
        method: "POST",
        headers: { "content-type": "application/json", "x-woo-host-key": "host_c" },
        body: JSON.stringify({ host: "host_d", batch_seq: 0, final: true, tombstones: [{ id: "task_y", recycled_at: 0 }] })
      }));
      const resp = await directory.fetch(req);
      expect(resp.status).toBe(403);
      const body = await resp.json() as any;
      expect(body.error.code).toBe("E_PERM");
    } finally {
      cleanup();
    }
  });

  it("rejects ids whose current id_route points at a different host", async () => {
    const { directory, cleanup } = makeDirectory();
    try {
      await registerObjectRoute(directory, "victim_obj", "host_e");
      // host_attacker tries to inherit victim_obj, which routes to host_e.
      const result = await inheritTombstones(directory, "host_attacker", {
        tombstones: [{ id: "victim_obj", recycled_at: 0 }]
      });
      expect(result.status).toBe(403);
      expect(result.body.error.code).toBe("E_PERM");

      // victim_obj's route is intact.
      const r = await resolveObject(directory, "host_e", "victim_obj");
      expect(r.host).toBe("host_e");
    } finally {
      cleanup();
    }
  });

  it("rejects ids already inherited under a different former_host", async () => {
    const { directory, cleanup } = makeDirectory();
    try {
      await registerObjectRoute(directory, "obj_z", "host_f");
      const first = await inheritTombstones(directory, "host_f", {
        tombstones: [{ id: "obj_z", recycled_at: 1 }]
      });
      expect(first.status).toBe(200);

      // Now host_g tries to inherit the same id.
      const second = await inheritTombstones(directory, "host_g", {
        tombstones: [{ id: "obj_z", recycled_at: 2 }]
      });
      expect(second.status).toBe(403);
      expect(second.body.error.code).toBe("E_PERM");
    } finally {
      cleanup();
    }
  });

  it("rejects an unsigned request", async () => {
    const { directory, cleanup } = makeDirectory();
    try {
      const resp = await directory.fetch(new Request("https://woo.test/__internal/inherit-tombstones", {
        method: "POST",
        headers: { "content-type": "application/json", "x-woo-host-key": "host_h" },
        body: JSON.stringify({ host: "host_h", batch_seq: 0, final: true, tombstones: [] })
      }));
      expect(resp.ok).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("supports multi-batch handoff with monotonic batch_seq", async () => {
    const { directory, cleanup } = makeDirectory();
    try {
      const ids = ["t_a", "t_b", "t_c", "t_d"];
      for (const id of ids) await registerObjectRoute(directory, id, "host_i");

      const b0 = await inheritTombstones(directory, "host_i", {
        batch_seq: 0, final: false,
        tombstones: [{ id: "t_a", recycled_at: 1 }, { id: "t_b", recycled_at: 2 }]
      });
      expect(b0.body).toMatchObject({ accepted: 2, inserted: 2, routes_removed: 2, batch_seq: 0, final: false });

      const b1 = await inheritTombstones(directory, "host_i", {
        batch_seq: 1, final: true,
        tombstones: [{ id: "t_c", recycled_at: 3 }, { id: "t_d", recycled_at: 4 }]
      });
      expect(b1.body).toMatchObject({ accepted: 2, inserted: 2, routes_removed: 2, batch_seq: 1, final: true });

      for (const id of ids) {
        const t = await lookup(directory, "host_i", id);
        expect(t.tombstoned).toBe(true);
      }
    } finally {
      cleanup();
    }
  });

  it("lookup returns tombstoned: false for never-inherited ids", async () => {
    const { directory, cleanup } = makeDirectory();
    try {
      const t = await lookup(directory, "host_j", "ghost_id");
      expect(t).toMatchObject({ id: "ghost_id", tombstoned: false, former_host: null });
    } finally {
      cleanup();
    }
  });

  it("resolveObject reports tombstoned: true when id is in inherited_tombstone", async () => {
    const { directory, cleanup } = makeDirectory();
    try {
      await registerObjectRoute(directory, "vanished", "host_m");
      const inh = await inheritTombstones(directory, "host_m", {
        tombstones: [{ id: "vanished", recycled_at: 42, reason: "recycle" }]
      });
      expect(inh.status).toBe(200);
      expect(inh.body.routes_removed).toBe(1);

      const r = await resolveObject(directory, "host_m", "vanished");
      expect(r).toMatchObject({
        id: "vanished",
        tombstoned: true,
        former_host: "host_m",
        recycled_at: 42
      });

      // For an id that was never registered or inherited, no tombstoned flag.
      const ghost = await resolveObject(directory, "host_m", "never_existed");
      expect(ghost.tombstoned).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("rejects ids that have no route and no prior inherited row", async () => {
    const { directory, cleanup } = makeDirectory();
    try {
      // No routes registered, no inherited rows. host_l tries to inherit
      // a tombstone for a totally unknown id.
      const result = await inheritTombstones(directory, "host_l", {
        tombstones: [{ id: "ghost_id", recycled_at: 1 }]
      });
      expect(result.status).toBe(403);
      expect(result.body.error.code).toBe("E_PERM");
    } finally {
      cleanup();
    }
  });

  it("rejects malformed batch_seq", async () => {
    const { directory, cleanup } = makeDirectory();
    try {
      const req = await signInternalRequest(env, new Request("https://woo.test/__internal/inherit-tombstones", {
        method: "POST",
        headers: { "content-type": "application/json", "x-woo-host-key": "host_k" },
        body: JSON.stringify({ host: "host_k", batch_seq: -1, final: true, tombstones: [] })
      }));
      const resp = await directory.fetch(req);
      expect(resp.status).toBe(400);
      const body = await resp.json() as any;
      expect(body.error.code).toBe("E_INVARG");
    } finally {
      cleanup();
    }
  });
});
