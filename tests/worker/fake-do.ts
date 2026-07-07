import { DatabaseSync } from "node:sqlite";

export type FakeSqlExecLogEntry = {
  query: string;
  changes: number;
};

export class FakeSqlCursor {
  constructor(private readonly rows: Record<string, unknown>[]) {}

  toArray(): Record<string, unknown>[] {
    return this.rows;
  }

  [Symbol.iterator](): Iterator<Record<string, unknown>> {
    return this.rows[Symbol.iterator]();
  }
}

export class FakeSqlStorage {
  readonly execLog: FakeSqlExecLogEntry[] = [];

  constructor(private readonly db: DatabaseSync) {}

  exec(query: string, ...params: unknown[]): FakeSqlCursor {
    const stmt = this.db.prepare(query);
    const head = query.trim().split(/\s+/, 1)[0]?.toUpperCase();
    if (head === "SELECT" || head === "PRAGMA") {
      this.execLog.push({ query, changes: 0 });
      return new FakeSqlCursor(stmt.all(...(params as any[])) as Record<string, unknown>[]);
    }
    const result = stmt.run(...(params as any[])) as { changes?: number };
    this.execLog.push({ query, changes: Number(result.changes ?? 0) });
    return new FakeSqlCursor([]);
  }
}

/**
 * Minimal server-side WebSocket fake for the DO hibernation API surface
 * (state.acceptWebSocket + tags, serializeAttachment). `sent` records
 * every frame for assertions; `close()` moves readyState to CLOSED so
 * tag lookups drop the socket like workerd does after a close.
 */
export class FakeWebSocket {
  /** 1 = OPEN, 3 = CLOSED — the two states the fake distinguishes. */
  readyState = 1;
  readonly sent: string[] = [];
  private attachment: unknown = null;

  send(data: string | ArrayBuffer): void {
    if (this.readyState !== 1) throw new Error("fake websocket is not open");
    this.sent.push(typeof data === "string" ? data : new TextDecoder().decode(data));
  }

  close(_code?: number, _reason?: string): void {
    this.readyState = 3;
  }

  serializeAttachment(value: unknown): void {
    // JSON round-trip mirrors workerd's structured-clone persistence:
    // attaching something non-serializable should fail in tests too.
    this.attachment = JSON.parse(JSON.stringify(value));
  }

  deserializeAttachment(): unknown {
    return this.attachment;
  }
}

/** The `new WebSocketPair()` global shape (workerd): index 0 is the
 * client end, index 1 the server end. Tests stub this onto globalThis
 * (the established cf-repository.test.ts idiom). */
export class FakeWebSocketPair {
  readonly 0 = new FakeWebSocket() as unknown as WebSocket;
  readonly 1 = new FakeWebSocket() as unknown as WebSocket;
}

export class FakeDurableObjectState {
  readonly id: { name: string };
  readonly acceptedWebSockets: WebSocket[] = [];
  private readonly webSocketTags = new Map<WebSocket, string[]>();
  private readonly db = new DatabaseSync(":memory:");
  private transactionDepth = 0;
  private savepointCounter = 0;

  constructor(name = "world") {
    this.id = { name };
  }

  readonly storage = {
    sql: new FakeSqlStorage(this.db),
    transactionSync: <T>(fn: () => T): T => this.transactionSync(fn)
  };

  async blockConcurrencyWhile<T>(fn: () => T | Promise<T>): Promise<T> {
    return await fn();
  }

  acceptWebSocket(ws: WebSocket, tags?: string[]): void {
    this.acceptedWebSockets.push(ws);
    this.webSocketTags.set(ws, tags ?? []);
  }

  /** Accepted sockets, optionally filtered by tag; CLOSED sockets are
   * dropped, matching workerd's post-close behavior. (Some test files
   * subclass and override this with their own registry — the base now
   * honestly reflects acceptWebSocket instead of returning [].) */
  getWebSockets(tag?: string): WebSocket[] {
    return this.acceptedWebSockets.filter((ws) => {
      const state = (ws as unknown as { readyState?: number }).readyState;
      if (state !== undefined && state !== 1) return false;
      return tag === undefined || (this.webSocketTags.get(ws) ?? []).includes(tag);
    });
  }

  close(): void {
    this.db.close();
  }

  private transactionSync<T>(fn: () => T): T {
    if (this.transactionDepth > 0) {
      const name = `fake_do_sp_${++this.savepointCounter}`;
      this.db.exec(`SAVEPOINT ${name}`);
      try {
        const result = fn();
        this.db.exec(`RELEASE SAVEPOINT ${name}`);
        return result;
      } catch (err) {
        this.db.exec(`ROLLBACK TO SAVEPOINT ${name}`);
        this.db.exec(`RELEASE SAVEPOINT ${name}`);
        throw err;
      }
    }

    this.db.exec("BEGIN IMMEDIATE");
    this.transactionDepth = 1;
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    } finally {
      this.transactionDepth = 0;
    }
  }
}

export class FakeDurableObjectNamespace {
  fetchCallCount = 0;

  constructor(private readonly factory: (name: string) => { fetch(request: Request): Promise<Response> | Response }) {}

  idFromName(name: string): { name: string } {
    return { name };
  }

  get(id: { name: string }): { fetch(request: Request): Promise<Response> | Response } {
    const target = this.factory(id.name);
    return {
      fetch: async (request: Request): Promise<Response> => {
        this.fetchCallCount += 1;
        return await target.fetch(request);
      }
    };
  }
}

