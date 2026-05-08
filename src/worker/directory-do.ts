import { wooError, type MetricEvent, type ObjRef, type Session } from "../core/types";
import { verifyInternalRequest, type InternalAuthEnv } from "./internal-auth";

type ObjectRoute = {
  id: ObjRef;
  host: string;
  anchor: ObjRef | null;
  updated_at: number;
};

type SessionRoute = {
  session_id: string;
  actor: ObjRef;
  expires_at: number;
  token_class: Session["tokenClass"];
  current_location: ObjRef | null;
  /** apikey record id when this session was minted from an apikey. Threaded
   * through Directory so cross-host routed copies can learn the apikey id
   * (and so revokeApiKey on a sibling host can tear them down). null for
   * guest/bearer-class sessions. */
  apikey_id: string | null;
  updated_at: number;
};

const WORLD_HOST = "world";
const MAX_JSON_BODY_BYTES = 1 * 1024 * 1024;
// Per spec/semantics/recycle.md §RC11.3 step 2: inherit-tombstones batches are
// capped at 512 KiB to leave headroom under the 1 MiB worker limit. Hosts
// chunk a long roster into multiple batches.
const MAX_INHERIT_BODY_BYTES = 512 * 1024;

export class DirectoryDO {
  private state: DurableObjectState;
  private env: InternalAuthEnv;
  private schemaEnsured = false;

  constructor(state: DurableObjectState, env: InternalAuthEnv) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request): Promise<Response> {
    if (!this.schemaEnsured) {
      const schemaStartedAt = Date.now();
      try {
        this.ensureSchema();
        this.schemaEnsured = true;
        this.emitMetric({ kind: "startup_storage", phase: "directory_schema", ms: Date.now() - schemaStartedAt, status: "ok", statements: 5 });
      } catch (err) {
        this.emitMetric({ kind: "startup_storage", phase: "directory_schema", ms: Date.now() - schemaStartedAt, status: "error", statements: 5, error: metricErrorCode(err) });
        throw err;
      }
    }
    const url = new URL(request.url);
    try {
      await verifyInternalRequest(this.env, request);

      if (request.method === "GET" && url.pathname === "/healthz") {
        return json({ ok: true, routes: this.countRows("object_route"), sessions: this.countRows("session_route") });
      }

      if (request.method === "POST" && url.pathname === "/resolve-object") {
        const body = await readJson(request);
        const id = String(body.id ?? "");
        const fallbackHost = typeof body.fallback_host === "string" ? body.fallback_host : WORLD_HOST;
        return json(this.resolveObject(id, fallbackHost));
      }

      if (request.method === "POST" && url.pathname === "/register-objects") {
        const body = await readJson(request);
        const routes = Array.isArray(body.routes) ? body.routes : [];
        const startedAt = Date.now();
        try {
          let writes = 0;
          this.state.storage.transactionSync(() => {
            for (const route of routes) {
              if (!route || typeof route !== "object") continue;
              const record = route as Record<string, unknown>;
              const id = typeof record.id === "string" ? record.id : "";
              const host = typeof record.host === "string" ? record.host : "";
              if (!id || !host) continue;
              if (this.registerObject(id, host, typeof record.anchor === "string" ? record.anchor : null)) writes += 1;
            }
          });
          this.emitMetric({ kind: "startup_storage", phase: "directory_register_objects", ms: Date.now() - startedAt, status: "ok", routes: routes.length, writes });
        } catch (err) {
          this.emitMetric({ kind: "startup_storage", phase: "directory_register_objects", ms: Date.now() - startedAt, status: "error", routes: routes.length, error: metricErrorCode(err) });
          throw err;
        }
        return json({ ok: true });
      }

      if (request.method === "POST" && url.pathname === "/register-session") {
        const body = await readJson(request);
        this.registerSession({
          session_id: String(body.session_id ?? ""),
          actor: String(body.actor ?? "") as ObjRef,
          expires_at: Number(body.expires_at ?? 0),
          token_class: body.token_class === "guest" || body.token_class === "apikey" ? body.token_class : "bearer",
          current_location: typeof body.current_location === "string" ? body.current_location as ObjRef : null,
          apikey_id: typeof body.apikey_id === "string" && body.apikey_id.length > 0 ? body.apikey_id : null,
          updated_at: Date.now()
        });
        return json({ ok: true });
      }

      if (request.method === "POST" && url.pathname === "/unregister-session") {
        const body = await readJson(request);
        this.unregisterSession(String(body.session_id ?? ""));
        return json({ ok: true });
      }

      if (request.method === "POST" && url.pathname === "/resolve-session") {
        const body = await readJson(request);
        return json({ session: this.resolveSession(String(body.session_id ?? "")) });
      }

      if (request.method === "POST" && url.pathname === "/__internal/inherit-tombstones") {
        return await this.handleInheritTombstones(request);
      }

      if (request.method === "POST" && url.pathname === "/__internal/lookup-inherited-tombstone") {
        const body = await readJson(request);
        const id = String(body.id ?? "");
        return json(this.lookupInheritedTombstone(id));
      }

      return json({ error: { code: "E_OBJNF", message: `no Directory route for ${request.method} ${url.pathname}` } }, 404);
    } catch (err) {
      const error = err && typeof err === "object" && "code" in err
        ? err
        : { code: "E_INTERNAL", message: err instanceof Error ? err.message : String(err) };
      return json({ error }, 500);
    }
  }

  private ensureSchema(): void {
    for (const stmt of [
      `CREATE TABLE IF NOT EXISTS object_route (
        id TEXT PRIMARY KEY,
        host TEXT NOT NULL,
        anchor TEXT,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS session_route (
        session_id TEXT PRIMARY KEY,
        actor TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        token_class TEXT NOT NULL,
        current_location TEXT,
        apikey_id TEXT,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS directory_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS inherited_tombstone (
        id TEXT PRIMARY KEY,
        former_host TEXT NOT NULL,
        recycled_at INTEGER NOT NULL,
        reason TEXT
      )`,
      `CREATE INDEX IF NOT EXISTS inherited_tombstone_former_host
        ON inherited_tombstone(former_host)`
    ]) {
      this.state.storage.sql.exec(stmt);
    }
    this.ensureColumn("session_route", "current_location", "TEXT");
    this.ensureColumn("session_route", "apikey_id", "TEXT");
  }

  private registerObject(id: ObjRef, host: string, anchor: ObjRef | null): boolean {
    const existing = firstRow(this.state.storage.sql.exec("SELECT host, anchor FROM object_route WHERE id = ?", id));
    if (existing && String(existing.host) === host && (existing.anchor === null ? null : String(existing.anchor)) === anchor) {
      return false;
    }
    this.state.storage.sql.exec(
      "INSERT OR REPLACE INTO object_route(id, host, anchor, updated_at) VALUES (?, ?, ?, ?)",
      id,
      host,
      anchor,
      Date.now()
    );
    return true;
  }

  private resolveObject(id: string, fallbackHost: string): ObjectRoute {
    if (!id) return { id, host: fallbackHost, anchor: null, updated_at: Date.now() };
    const row = firstRow(this.state.storage.sql.exec("SELECT id, host, anchor, updated_at FROM object_route WHERE id = ?", id));
    if (row) {
      return {
        id: String(row.id),
        host: String(row.host),
        anchor: row.anchor === null ? null : String(row.anchor),
        updated_at: Number(row.updated_at)
      };
    }
    const host = id.startsWith("$") ? WORLD_HOST : fallbackHost;
    return { id, host, anchor: null, updated_at: Date.now() };
  }

  private registerSession(session: SessionRoute): void {
    if (!session.session_id || !session.actor || !Number.isFinite(session.expires_at)) return;
    this.state.storage.sql.exec(
      "INSERT OR REPLACE INTO session_route(session_id, actor, expires_at, token_class, current_location, apikey_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      session.session_id,
      session.actor,
      session.expires_at,
      session.token_class,
      session.current_location,
      session.apikey_id,
      Date.now()
    );
  }

  private unregisterSession(sessionId: string): void {
    if (!sessionId) return;
    this.state.storage.sql.exec("DELETE FROM session_route WHERE session_id = ?", sessionId);
  }

  private resolveSession(sessionId: string): SessionRoute | null {
    if (!sessionId) return null;
    const row = firstRow(this.state.storage.sql.exec(
      "SELECT session_id, actor, expires_at, token_class, current_location, apikey_id, updated_at FROM session_route WHERE session_id = ?",
      sessionId
    ));
    if (!row) return null;
    const expiresAt = Number(row.expires_at);
    if (expiresAt <= Date.now()) {
      this.state.storage.sql.exec("DELETE FROM session_route WHERE session_id = ?", sessionId);
      return null;
    }
    return {
      session_id: String(row.session_id),
      actor: String(row.actor),
      expires_at: expiresAt,
      token_class: row.token_class === "guest" || row.token_class === "apikey" ? row.token_class : "bearer",
      current_location: typeof row.current_location === "string" ? row.current_location as ObjRef : null,
      apikey_id: typeof row.apikey_id === "string" && row.apikey_id.length > 0 ? row.apikey_id : null,
      updated_at: Number(row.updated_at)
    };
  }

  private async handleInheritTombstones(request: Request): Promise<Response> {
    // verifyInternalRequest already ran in the outer fetch handler. After
    // that, x-woo-host-key is HMAC-bound to the request body, so we can
    // trust its value as the authenticated caller. Per spec/semantics/recycle.md
    // §RC11.3 step 2 + §RC11.7: the v1 single-shared-secret model means
    // these checks defend against public clients and honest-but-buggy
    // internal callers, not against a compromised worker.
    const authedHost = request.headers.get("x-woo-host-key") || "";
    if (!authedHost) {
      return json({ error: { code: "E_PERM", message: "missing x-woo-host-key" } }, 403);
    }

    const startedAt = Date.now();
    const body = await readJson(request, MAX_INHERIT_BODY_BYTES);
    const declaredHost = typeof body.host === "string" ? body.host : "";
    const batchSeq = Number(body.batch_seq);
    const final = body.final === true;
    const tombstones = Array.isArray(body.tombstones) ? body.tombstones : [];

    if (declaredHost !== authedHost) {
      return json({ error: { code: "E_PERM", message: "body.host does not match authenticated host" } }, 403);
    }
    if (!Number.isFinite(batchSeq) || batchSeq < 0) {
      return json({ error: { code: "E_INVARG", message: "batch_seq must be a non-negative integer" } }, 400);
    }

    type Entry = { id: string; recycled_at: number; reason: string | null };
    const accepted: Entry[] = [];
    for (const raw of tombstones) {
      if (!raw || typeof raw !== "object") continue;
      const r = raw as Record<string, unknown>;
      const id = typeof r.id === "string" ? r.id : "";
      const recycledAt = Number(r.recycled_at);
      const reason = typeof r.reason === "string" ? r.reason : null;
      if (!id || !Number.isFinite(recycledAt)) {
        return json({ error: { code: "E_INVARG", message: `invalid tombstone entry for id ${id}` } }, 400);
      }
      accepted.push({ id, recycled_at: recycledAt, reason });
    }

    // Roster ownership: every id must currently route to this host, OR be
    // already-inherited under this same former_host (idempotent retries).
    // Reject the whole batch on any mismatch — partial application would
    // leave the host's teardown bookkeeping inconsistent.
    for (const entry of accepted) {
      const routeRow = firstRow(this.state.storage.sql.exec(
        "SELECT host FROM object_route WHERE id = ?",
        entry.id
      ));
      if (routeRow) {
        if (String(routeRow.host) !== authedHost) {
          this.emitMetric({
            kind: "startup_storage", phase: "directory_inherit_tombstones",
            ms: Date.now() - startedAt, status: "error",
            error: "route_mismatch", count: accepted.length
          });
          return json({ error: {
            code: "E_PERM",
            message: `id ${entry.id} routed to ${String(routeRow.host)}, not ${authedHost}`
          } }, 403);
        }
        continue;
      }
      const inheritedRow = firstRow(this.state.storage.sql.exec(
        "SELECT former_host FROM inherited_tombstone WHERE id = ?",
        entry.id
      ));
      if (inheritedRow && String(inheritedRow.former_host) !== authedHost) {
        return json({ error: {
          code: "E_PERM",
          message: `id ${entry.id} already inherited from ${String(inheritedRow.former_host)}`
        } }, 403);
      }
      // No route, no inherited row → never existed. Spec doesn't forbid
      // inheriting an unknown id from a host that claims it; treat as a
      // no-op for the route-deletion side and still record the tombstone.
    }

    let inserted = 0;
    let routesRemoved = 0;
    this.state.storage.transactionSync(() => {
      for (const entry of accepted) {
        const inheritedBefore = this.countRows("inherited_tombstone");
        this.state.storage.sql.exec(
          "INSERT OR IGNORE INTO inherited_tombstone(id, former_host, recycled_at, reason) VALUES (?, ?, ?, ?)",
          entry.id, authedHost, entry.recycled_at, entry.reason
        );
        if (this.countRows("inherited_tombstone") > inheritedBefore) inserted += 1;
        const hadRoute = firstRow(this.state.storage.sql.exec(
          "SELECT 1 FROM object_route WHERE id = ? AND host = ?",
          entry.id, authedHost
        )) !== null;
        if (hadRoute) {
          this.state.storage.sql.exec(
            "DELETE FROM object_route WHERE id = ? AND host = ?",
            entry.id, authedHost
          );
          routesRemoved += 1;
        }
      }
    });

    this.emitMetric({
      kind: "startup_storage", phase: "directory_inherit_tombstones",
      ms: Date.now() - startedAt, status: "ok",
      count: accepted.length, inserted, routes_removed: routesRemoved,
      batch_seq: batchSeq, final
    });

    return json({
      ok: true,
      accepted: accepted.length,
      inserted,
      routes_removed: routesRemoved,
      batch_seq: batchSeq,
      final
    });
  }

  private lookupInheritedTombstone(id: string): { id: string; tombstoned: boolean; former_host: string | null; recycled_at: number | null; reason: string | null } {
    if (!id) return { id, tombstoned: false, former_host: null, recycled_at: null, reason: null };
    const row = firstRow(this.state.storage.sql.exec(
      "SELECT former_host, recycled_at, reason FROM inherited_tombstone WHERE id = ?",
      id
    ));
    if (!row) return { id, tombstoned: false, former_host: null, recycled_at: null, reason: null };
    return {
      id,
      tombstoned: true,
      former_host: String(row.former_host),
      recycled_at: Number(row.recycled_at),
      reason: row.reason === null ? null : String(row.reason)
    };
  }

  private ensureColumn(table: string, column: string, definition: string): void {
    if (this.tableColumns(table).has(column)) return;
    this.state.storage.sql.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  private tableColumns(table: string): Set<string> {
    return new Set([...this.state.storage.sql.exec(`PRAGMA table_info(${table})`)].map((row) => String(row.name)));
  }

  private countRows(table: string): number {
    return Number(firstValue(this.state.storage.sql.exec(`SELECT COUNT(*) AS count FROM ${table}`)) ?? 0);
  }

  private emitMetric(event: MetricEvent): void {
    console.log("woo.metric", JSON.stringify({ ...event, ts: Date.now(), host_key: "directory" }));
  }
}

function firstRow(cursor: SqlStorageCursor<Record<string, SqlStorageValue>>): Record<string, unknown> | null {
  const rows = [...cursor] as Record<string, unknown>[];
  return rows[0] ?? null;
}

function firstValue(cursor: SqlStorageCursor<Record<string, SqlStorageValue>>): unknown {
  const row = firstRow(cursor);
  if (!row) return null;
  return Object.values(row)[0] ?? null;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}

function metricErrorCode(err: unknown): string {
  if (err && typeof err === "object" && "code" in err) return String((err as { code: unknown }).code);
  return err instanceof Error ? err.name : "E_INTERNAL";
}

async function readJson(request: Request, maxBytes: number = MAX_JSON_BODY_BYTES): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(new TextDecoder().decode(await readLimitedBody(request, maxBytes)));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch (err) {
    if (err && typeof err === "object" && "code" in err) throw err;
    return {};
  }
}

async function readLimitedBody(request: Request, maxBytes: number): Promise<ArrayBuffer> {
  const declared = Number(request.headers.get("content-length") ?? 0);
  if (Number.isFinite(declared) && declared > maxBytes) throw wooError("E_RATE", `request body exceeds ${maxBytes} bytes`);
  const body = await request.arrayBuffer();
  if (body.byteLength > maxBytes) throw wooError("E_RATE", `request body exceeds ${maxBytes} bytes`);
  return body;
}
