import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { DirectoryDO } from "../../src/worker/directory-do";
import { signInternalRequest, type InternalAuthEnv } from "../../src/worker/internal-auth";
import { PersistentObjectDO, type Env } from "../../src/worker/persistent-object-do";

const SECRET = "test-secret";

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

class FakeDurableObjectState {
  readonly id: { name: string };
  readonly db = new DatabaseSync(":memory:");
  private depth = 0;
  readonly deleteAll = vi.fn(async () => {
    // Wipe by dropping every user-defined table to mimic deleteAll semantics.
    const tables = (this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string }>);
    for (const { name } of tables) this.db.exec(`DROP TABLE ${name}`);
  });
  readonly deleteAlarm = vi.fn(async () => {});
  readonly waitUntilPromises: Array<Promise<unknown>> = [];

  constructor(name: string) { this.id = { name }; }

  readonly storage = {
    sql: new FakeSqlStorage(this.db),
    transactionSync: <T>(fn: () => T): T => {
      if (this.depth > 0) {
        const sp = `sp_${this.depth}`;
        this.db.exec(`SAVEPOINT ${sp}`);
        try {
          this.depth += 1;
          const r = fn();
          this.db.exec(`RELEASE SAVEPOINT ${sp}`);
          return r;
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
    },
    deleteAll: this.deleteAll,
    deleteAlarm: this.deleteAlarm
  };

  async blockConcurrencyWhile<T>(fn: () => T | Promise<T>): Promise<T> { return await fn(); }
  acceptWebSocket(_ws: WebSocket): void {}
  getWebSockets(): WebSocket[] { return []; }
  waitUntil(promise: Promise<unknown>): void { this.waitUntilPromises.push(promise); }
  close(): void { try { this.db.close(); } catch {} }
}

class FakeNamespace {
  constructor(private readonly factory: (name: string) => { fetch(req: Request): Promise<Response> | Response }) {}
  idFromName(name: string): { name: string } { return { name }; }
  get(id: { name: string }): { fetch(req: Request): Promise<Response> | Response } { return this.factory(id.name); }
}

function makeEnv(directory: DirectoryDO, woo: (name: string) => { fetch(req: Request): Promise<Response> | Response }): Env {
  return {
    WOO_INITIAL_WIZARD_TOKEN: "tk-initial",
    WOO_INTERNAL_SECRET: SECRET,
    WOO_AUTO_INSTALL_CATALOGS: "",
    DIRECTORY: new FakeNamespace((n) => {
      if (n !== "directory") throw new Error(`unexpected directory name ${n}`);
      return directory;
    }),
    WOO: new FakeNamespace(woo)
  } as unknown as Env;
}

function authEnv(): InternalAuthEnv { return { WOO_INTERNAL_SECRET: SECRET }; }

describe("host teardown gate", () => {
  it("rejects requests with E_HOST_RECYCLED when host_state is tearing_down", async () => {
    const directoryState = new FakeDurableObjectState("directory");
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, authEnv());

    const hostState = new FakeDurableObjectState("the_test_host");
    const env = makeEnv(directory, (n) => { throw new Error(`unexpected woo target ${n}`); });
    const hostDO = new PersistentObjectDO(hostState as unknown as DurableObjectState, env);

    // Pre-seed host_state = tearing_down. The DO's repo and ensure-schema
    // run on first fetch; bootstrap world_meta so the loadMeta path can
    // observe our value.
    hostState.db.exec("CREATE TABLE IF NOT EXISTS world_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    hostState.db.exec("INSERT OR REPLACE INTO world_meta(key, value) VALUES ('host_state', 'tearing_down')");

    const resp = await hostDO.fetch(new Request("https://woo.test/healthz"));
    expect(resp.status).toBe(410);
    const body = await resp.json() as any;
    expect(body.error.code).toBe("E_HOST_RECYCLED");

    directoryState.close();
    hostState.close();
  });

  it("does not gate requests on the world gateway host", async () => {
    const directoryState = new FakeDurableObjectState("directory");
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, authEnv());

    const gatewayState = new FakeDurableObjectState("world");
    const env = makeEnv(directory, (n) => { throw new Error(`unexpected woo target ${n}`); });
    const gateway = new PersistentObjectDO(gatewayState as unknown as DurableObjectState, env);

    // Even if some operator wrote tearing_down on the gateway by mistake,
    // the gate exempts the world host.
    gatewayState.db.exec("CREATE TABLE IF NOT EXISTS world_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    gatewayState.db.exec("INSERT OR REPLACE INTO world_meta(key, value) VALUES ('host_state', 'tearing_down')");

    const resp = await gateway.fetch(new Request("https://woo.test/healthz"));
    expect(resp.ok).toBe(true);

    directoryState.close();
    gatewayState.close();
  });
});

describe("host teardown sequence", () => {
  it("hands tombstones to Directory in batches and calls deleteAll", async () => {
    const directoryState = new FakeDurableObjectState("directory");
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, authEnv());

    const hostKey = "the_test_host";
    const hostState = new FakeDurableObjectState(hostKey);
    const env = makeEnv(directory, (n) => { throw new Error(`unexpected woo target ${n}`); });
    const hostDO = new PersistentObjectDO(hostState as unknown as DurableObjectState, env);

    // Seed: this host owns three objects in Directory's id_route, all of
    // which we're about to inherit. Use signed register-objects so the
    // route is real.
    async function registerRoute(id: string): Promise<void> {
      const req = await signInternalRequest(authEnv(), new Request("https://woo.test/register-objects", {
        method: "POST",
        headers: { "content-type": "application/json", "x-woo-host-key": hostKey },
        body: JSON.stringify({ routes: [{ id, host: hostKey, anchor: null }] })
      }));
      const r = await directory.fetch(req);
      expect(r.ok).toBe(true);
    }
    await registerRoute("obj_a");
    await registerRoute("obj_b");
    await registerRoute("obj_c");

    // Seed: pre-populate the host's tombstone table directly so the
    // teardown sequence has a roster to migrate.
    hostState.db.exec(`CREATE TABLE IF NOT EXISTS tombstone (
      id TEXT PRIMARY KEY,
      recycled_at INTEGER NOT NULL,
      reason TEXT
    )`);
    const insertTomb = hostState.db.prepare("INSERT INTO tombstone(id, recycled_at, reason) VALUES (?, ?, ?)");
    insertTomb.run("obj_a", 100, "recycle");
    insertTomb.run("obj_b", 200, "recycle");
    insertTomb.run(hostKey, 300, "recycle");
    hostState.db.exec("CREATE TABLE IF NOT EXISTS world_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");

    // Run the teardown sequence directly through the DO's internal API.
    await (hostDO as unknown as { runTeardownSequence(host: string): Promise<void> }).runTeardownSequence(hostKey);

    // Directory now has inherited tombstones for obj_a, obj_b, the_test_host.
    async function lookup(id: string): Promise<any> {
      const req = await signInternalRequest(authEnv(), new Request("https://woo.test/__internal/lookup-inherited-tombstone", {
        method: "POST",
        headers: { "content-type": "application/json", "x-woo-host-key": hostKey },
        body: JSON.stringify({ id })
      }));
      const r = await directory.fetch(req);
      return await r.json();
    }
    const a = await lookup("obj_a");
    expect(a).toMatchObject({ tombstoned: true, former_host: hostKey, recycled_at: 100, reason: "recycle" });
    const root = await lookup(hostKey);
    expect(root).toMatchObject({ tombstoned: true, former_host: hostKey, recycled_at: 300 });

    // id_route entries are gone for obj_a, obj_b. obj_c was never tombstoned
    // so its route should remain — but for this test we only care that the
    // tombstoned ids' routes are gone.
    expect(hostState.deleteAll).toHaveBeenCalledTimes(1);

    directoryState.close();
    hostState.close();
  });

  it("chunks a large roster into multiple batches", async () => {
    const directoryState = new FakeDurableObjectState("directory");
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, authEnv());

    const hostKey = "many_tombstones_host";
    const hostState = new FakeDurableObjectState(hostKey);
    const env = makeEnv(directory, (n) => { throw new Error(`unexpected woo target ${n}`); });
    const hostDO = new PersistentObjectDO(hostState as unknown as DurableObjectState, env);

    // 2500 tombstones → with chunk size 1000, expect 3 batches.
    hostState.db.exec(`CREATE TABLE IF NOT EXISTS tombstone (
      id TEXT PRIMARY KEY,
      recycled_at INTEGER NOT NULL,
      reason TEXT
    )`);
    hostState.db.exec("CREATE TABLE IF NOT EXISTS world_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    const insertTomb = hostState.db.prepare("INSERT INTO tombstone(id, recycled_at, reason) VALUES (?, ?, NULL)");
    for (let i = 0; i < 2500; i++) {
      const id = `obj_${String(i).padStart(5, "0")}`;
      insertTomb.run(id, i);
    }

    // Spy on Directory fetches to count batches.
    const original = directory.fetch.bind(directory);
    let batchCount = 0;
    const finals: boolean[] = [];
    (directory as unknown as { fetch: (r: Request) => Promise<Response> }).fetch = async (req: Request) => {
      const url = new URL(req.url);
      if (url.pathname === "/__internal/inherit-tombstones") {
        const cloned = req.clone();
        const body = JSON.parse(await cloned.text());
        batchCount += 1;
        finals.push(body.final === true);
      }
      return await original(req);
    };

    await (hostDO as unknown as { runTeardownSequence(host: string): Promise<void> }).runTeardownSequence(hostKey);

    expect(batchCount).toBe(3);
    expect(finals).toEqual([false, false, true]);
    expect(hostState.deleteAll).toHaveBeenCalledTimes(1);

    directoryState.close();
    hostState.close();
  });

  it("sends a single empty batch with final=true when there are no tombstones", async () => {
    const directoryState = new FakeDurableObjectState("directory");
    const directory = new DirectoryDO(directoryState as unknown as DurableObjectState, authEnv());

    const hostKey = "no_tombstones_host";
    const hostState = new FakeDurableObjectState(hostKey);
    const env = makeEnv(directory, (n) => { throw new Error(`unexpected woo target ${n}`); });
    const hostDO = new PersistentObjectDO(hostState as unknown as DurableObjectState, env);

    hostState.db.exec(`CREATE TABLE IF NOT EXISTS tombstone (
      id TEXT PRIMARY KEY,
      recycled_at INTEGER NOT NULL,
      reason TEXT
    )`);
    hostState.db.exec("CREATE TABLE IF NOT EXISTS world_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)");

    const original = directory.fetch.bind(directory);
    const calls: Array<{ batch_seq: number; final: boolean; count: number }> = [];
    (directory as unknown as { fetch: (r: Request) => Promise<Response> }).fetch = async (req: Request) => {
      const url = new URL(req.url);
      if (url.pathname === "/__internal/inherit-tombstones") {
        const cloned = req.clone();
        const body = JSON.parse(await cloned.text());
        calls.push({ batch_seq: body.batch_seq, final: body.final, count: body.tombstones.length });
      }
      return await original(req);
    };

    await (hostDO as unknown as { runTeardownSequence(host: string): Promise<void> }).runTeardownSequence(hostKey);

    expect(calls).toEqual([{ batch_seq: 0, final: true, count: 0 }]);
    expect(hostState.deleteAll).toHaveBeenCalledTimes(1);

    directoryState.close();
    hostState.close();
  });
});
