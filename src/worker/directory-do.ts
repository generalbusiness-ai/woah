import { sessionActiveScopeFromRecord, wooError, type MetricEvent, type ObjRef, type Session } from "../core/types";
import { verifyInternalRequest, type InternalAuthEnv } from "./internal-auth";

type ObjectRoute = {
  id: ObjRef;
  host: string;
  anchor: ObjRef | null;
  updated_at: number;
  /** Set when the id has no `id_route` row but appears in
   * `inherited_tombstone`. Per spec/semantics/recycle.md §RC11.4 +
   * spec/reference/persistence.md §14.2.2, Directory is the tombstone
   * authority for ids whose host has been torn down. Callers that need
   * to distinguish "recycled" from "never existed" check this flag;
   * `host` is set to the fallback so legacy callers that ignore the
   * flag continue routing as before. */
  tombstoned?: boolean;
  former_host?: string | null;
  recycled_at?: number | null;
};

type SessionRoute = {
  session_id: string;
  actor: ObjRef;
  expires_at: number;
  token_class: Session["tokenClass"];
  active_scope: ObjRef | null;
  /** Legacy storage/wire alias; persisted in `current_location` until a DB migration exists. */
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
    const constructorStartedAt = Date.now();
    this.state = state;
    this.env = env;
    console.log("woo.metric", JSON.stringify({ kind: "do_constructor", class: "DirectoryDO", ms: Date.now() - constructorStartedAt, ts: Date.now(), host_key: "directory" }));
  }

  async fetch(request: Request): Promise<Response> {
    const handlerStartedAt = Date.now();
    const url = new URL(request.url);
    let handlerStatus: "ok" | "error" = "ok";
    let handlerError: string | undefined;
    try {
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
        const startedAt = Date.now();
        let wrote = false;
        try {
          wrote = this.registerSession({
            session_id: String(body.session_id ?? ""),
            actor: String(body.actor ?? "") as ObjRef,
            expires_at: Number(body.expires_at ?? 0),
            token_class: body.token_class === "guest" || body.token_class === "apikey" ? body.token_class : "bearer",
            active_scope: sessionActiveScope(body),
            current_location: sessionActiveScope(body),
            apikey_id: typeof body.apikey_id === "string" && body.apikey_id.length > 0 ? body.apikey_id : null,
            updated_at: Date.now()
          });
          this.emitMetric({ kind: "startup_storage", phase: "directory_register_session", ms: Date.now() - startedAt, status: "ok", writes: wrote ? 1 : 0 });
        } catch (err) {
          this.emitMetric({ kind: "startup_storage", phase: "directory_register_session", ms: Date.now() - startedAt, status: "error", error: metricErrorCode(err) });
          throw err;
        }
        return json({ ok: true, wrote });
      }

      if (request.method === "POST" && url.pathname === "/unregister-session") {
        const body = await readJson(request);
        this.unregisterSession(String(body.session_id ?? ""));
        return json({ ok: true });
      }

      if (request.method === "POST" && url.pathname === "/unregister-apikey-sessions") {
        const body = await readJson(request);
        const removed = this.unregisterApiKeySessions(String(body.apikey_id ?? ""));
        return json({ ok: true, removed });
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
      handlerStatus = "error";
      handlerError = String((error as { code?: unknown }).code ?? "E_INTERNAL");
      return json({ error }, 500);
    } finally {
      this.emitMetric({
        kind: "do_handler",
        class: "DirectoryDO",
        method: request.method,
        route: url.pathname,
        ms: Date.now() - handlerStartedAt,
        status: handlerStatus,
        ...(handlerError ? { error: handlerError } : {})
      });
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
    // §RC11.4 step 2: no id_route — fall through to inherited_tombstone
    // before answering with a generic fallback. A hit means the id was
    // tombstoned on a host that has since been torn down; Directory is
    // the authority on liveness for those ids.
    const inherited = firstRow(this.state.storage.sql.exec(
      "SELECT former_host, recycled_at FROM inherited_tombstone WHERE id = ?",
      id
    ));
    const host = id.startsWith("$") ? WORLD_HOST : fallbackHost;
    if (inherited) {
      return {
        id,
        host,
        anchor: null,
        updated_at: Date.now(),
        tombstoned: true,
        former_host: String(inherited.former_host),
        recycled_at: Number(inherited.recycled_at)
      };
    }
    return { id, host, anchor: null, updated_at: Date.now() };
  }

  private registerSession(session: SessionRoute): boolean {
    if (!session.session_id || !session.actor || !Number.isFinite(session.expires_at)) return false;
    // Mirror registerObject's dedup: SELECT-then-skip when every persisted
    // column matches. Without this, callers like the worker entry's
    // registerSessionLocationFromCall (re-run on every successful call POST)
    // and the per-cron auth path turn into a row write per RPC even when
    // nothing changed — observed at ~488 row writes/hour on an idle
    // singleton. Compare every column except updated_at; an unchanged row
    // is a no-op.
    const existing = firstRow(this.state.storage.sql.exec(
      "SELECT actor, expires_at, token_class, current_location, apikey_id FROM session_route WHERE session_id = ?",
      session.session_id
    ));
    if (existing
      && String(existing.actor) === session.actor
      && Number(existing.expires_at) === session.expires_at
      && String(existing.token_class) === session.token_class
      && (existing.current_location === null ? null : String(existing.current_location)) === session.active_scope
      && (existing.apikey_id === null ? null : String(existing.apikey_id)) === session.apikey_id) {
      return false;
    }
    this.state.storage.sql.exec(
      "INSERT OR REPLACE INTO session_route(session_id, actor, expires_at, token_class, current_location, apikey_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
      session.session_id,
      session.actor,
      session.expires_at,
      session.token_class,
      session.active_scope,
      session.apikey_id,
      Date.now()
    );
    return true;
  }

  private unregisterSession(sessionId: string): void {
    if (!sessionId) return;
    this.state.storage.sql.exec("DELETE FROM session_route WHERE session_id = ?", sessionId);
  }

  private unregisterApiKeySessions(apikeyId: string): number {
    if (!apikeyId) return 0;
    const before = this.state.storage.sql.exec(
      "SELECT COUNT(*) AS count FROM session_route WHERE apikey_id = ?",
      apikeyId
    ).toArray()[0] as { count?: number } | undefined;
    this.state.storage.sql.exec("DELETE FROM session_route WHERE apikey_id = ?", apikeyId);
    return Number(before?.count ?? 0);
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
      active_scope: typeof row.current_location === "string" ? row.current_location as ObjRef : null,
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
      if (inheritedRow) {
        if (String(inheritedRow.former_host) !== authedHost) {
          return json({ error: {
            code: "E_PERM",
            message: `id ${entry.id} already inherited from ${String(inheritedRow.former_host)}`
          } }, 403);
        }
        continue;
      }
      // Per spec/semantics/recycle.md §RC11.3 step 2: an id qualifies for
      // inheritance only if it currently routes to the caller OR is
      // already inherited under the caller. An id with no route and no
      // inherited row is treated as not owned by the caller — reject
      // rather than recording a vacuous tombstone.
      return json({ error: {
        code: "E_PERM",
        message: `id ${entry.id} has no route and no prior inherited row; ${authedHost} cannot claim it`
      } }, 403);
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

function sessionActiveScope(record: Record<string, unknown>): ObjRef | null {
  return sessionActiveScopeFromRecord(record) as ObjRef | null;
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
