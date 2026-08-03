/**
 * Physical SQLite write accounting for NetGatewayDO.
 *
 * Cloudflare bills `SqlStorageCursor.rowsWritten`, including rows changed in
 * secondary indexes.  SQLite's logical `changes()` count is therefore not a
 * safe proxy.  Keeping the wrapper here makes every gateway statement pass
 * through the same meter and prevents a new table family from silently
 * escaping the storage-cost envelope.
 */

export type GatewaySqlExecutor = {
  exec(query: string, ...params: unknown[]): unknown;
};

export type GatewayStorageWriteMetric = {
  kind: "net_gateway_storage_write";
  /** Durable row family, without the `net_gateway_` prefix. */
  what: string;
  /** SQL operation (`insert`, `update`, `delete`, schema DDL, ...). */
  phase: string;
  /** Physical base + index rows reported by Cloudflare. */
  rows: number;
  status: "written";
};

const MUTATING_SQL = new Set(["alter", "create", "delete", "drop", "insert", "replace", "update"]);

/** Identify the durable family touched by a statement without logging SQL or
 * bind values.  The latter may contain credentials or user-authored text. */
export function gatewaySqlFamily(query: string): string {
  const normalized = query.replace(/\s+/g, " ").trim();
  // CREATE INDEX names usually begin with the table name; prefer the table
  // following ON so the metric does not invent one family per index.
  const createIndexTable = /^CREATE\s+(?:UNIQUE\s+)?INDEX\b.*?\bON\s+(net_gateway_[a-z0-9_]+)/i.exec(normalized)?.[1];
  const target = createIndexTable
    ?? /\b(?:INTO|UPDATE|FROM|JOIN|TABLE(?:\s+IF\s+NOT\s+EXISTS)?)\s+(net_gateway_[a-z0-9_]+)/i.exec(normalized)?.[1]
    ?? /\btable_info\s*\(\s*(net_gateway_[a-z0-9_]+)\s*\)/i.exec(normalized)?.[1];
  return target ? target.replace(/^net_gateway_/, "") : "unknown";
}

export function gatewaySqlOperation(query: string): string {
  return query.trim().split(/\s+/, 1)[0]?.toLowerCase() || "unknown";
}

function cursorRowsWritten(cursor: unknown): number {
  const value = Number((cursor as { rowsWritten?: unknown } | null)?.rowsWritten);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
}

/** Wrap the complete gateway SQL surface. Reads still pass through the meter;
 * only mutation attempts emit because a read's physical write count is always
 * zero and emitting it would turn observability into its own high-volume cost. */
export function instrumentGatewaySql(
  sql: GatewaySqlExecutor,
  emit: (metric: GatewayStorageWriteMetric) => void
): GatewaySqlExecutor {
  const pending = new Map<string, Omit<GatewayStorageWriteMetric, "rows"> & { rows: number }>();
  let flushScheduled = false;
  const flush = (): void => {
    flushScheduled = false;
    for (const metric of pending.values()) emit(metric);
    pending.clear();
  };
  return {
    exec(query: string, ...params: unknown[]): unknown {
      const cursor = sql.exec(query, ...params);
      const phase = gatewaySqlOperation(query);
      if (MUTATING_SQL.has(phase)) {
        const rows = cursorRowsWritten(cursor);
        // Zero-row attempts are the desired result for duplicate fanout and
        // do not affect the bill. Tests assert those directly against the SQL
        // cursor. Production telemetry stays proportional to actual writes.
        if (rows > 0) {
          const what = gatewaySqlFamily(query);
          const key = `${what}\0${phase}`;
          const existing = pending.get(key);
          if (existing) existing.rows += rows;
          else pending.set(key, { kind: "net_gateway_storage_write", what, phase, rows, status: "written" });
          // One synchronous fanout can execute hundreds of statements. Flush
          // once at the microtask boundary so measuring the fix does not add
          // one log/AE event per row operation.
          if (!flushScheduled) {
            flushScheduled = true;
            queueMicrotask(flush);
          }
        }
      }
      return cursor;
    }
  };
}
