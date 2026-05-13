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

export class FakeDurableObjectState {
  readonly id: { name: string };
  readonly acceptedWebSockets: WebSocket[] = [];
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

  acceptWebSocket(ws: WebSocket): void {
    this.acceptedWebSockets.push(ws);
  }

  getWebSockets(): WebSocket[] {
    return [];
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

