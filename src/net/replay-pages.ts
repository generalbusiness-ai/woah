/**
 * Replay-page input — the owner-attested committed-log read for sparse
 * planning (coherence.md CO2.3 "replay-page reads"; sequenced-log.md SL4).
 *
 * The exact structural analogue of the ordered-children projection
 * (ordered-edges.ts), but for the sequenced LOG rather than an ordering:
 *
 * - The scope authority durably retains every committed SEQUENCED entry
 *   (ScopeStore's log row family, appended inside the accept transaction),
 *   keyed by the entry's SEMANTIC space id and space-log seq.
 * - A planning-world `space:replay(from, limit)` read misses as repairable
 *   `E_NEED_REPLAY_PAGE`; the gateway fetches the page from the log's
 *   OWNING authority (`POST /net/replay-page`, routed by
 *   `classifier.scopeOf(space)` — the authority ADDRESS), installs it in
 *   the ephemeral planning world under the SEMANTIC query key, and
 *   re-plans.
 * - The plan attests each page it was given at its content `version` in
 *   the transcript's `replayReads`; the committing scope re-derives pages
 *   it owns (an append inside the window between plan and submit rejects
 *   `read_version_mismatch` with `replay_conflicts`), and FOREIGN pages
 *   validate against the owner's `replays` attestation exactly like
 *   foreign cell/ordering reads (R3).
 *
 * Identity rule: `space` in every query, entry, and attestation is the
 * SEMANTIC space id; only the RPC destination uses the authority address.
 */
import {
  REPLAY_PAGE_DEFAULT_LIMIT,
  REPLAY_PAGE_MAX_LIMIT,
  replayPageQueryKey,
  validReplayPageBounds,
  type ReplayPageQuery
} from "../core/replay-page";
import { cellVersion } from "./cells";

export {
  REPLAY_PAGE_DEFAULT_LIMIT,
  REPLAY_PAGE_MAX_LIMIT,
  replayPageQueryKey,
  validReplayPageBounds,
  type ReplayPageQuery
};

/** One committed sequenced-log entry as the authority retains and serves
 * it — the native replay wrapper's shape plus the semantic `space` key.
 * `ts` is the authority's acceptance timestamp (CO2.5), minted once at
 * commit and durable thereafter, so page versions are stable. */
export type ReplayLogEntry = {
  /** SEMANTIC space id (never the scope address). */
  space: string;
  seq: number;
  ts: number;
  actor: string;
  message: unknown;
  observations: unknown[];
  applied_ok: boolean;
  error?: unknown;
};

/** Content version of one exact page (P1.1 discipline): the address of the
 * served entries. Append-only log ⇒ the version of a window changes only
 * when a new committed entry lands inside it, which is precisely the
 * staleness the committing scope must reject. */
export function replayPageVersion(entries: readonly ReplayLogEntry[]): string {
  return cellVersion(entries as unknown[]);
}

/** Strict authority-reply guard. The page version authenticates these exact
 * rows, so the gateway must reject malformed identity/order rather than
 * stripping fields and attesting a different semantic page. Gaps are legal
 * (snapshot truncation and off-space Net turns need not consume a seq), but
 * returned rows are strictly increasing and inside the requested window. */
export function validReplayLogPage(value: unknown, query: ReplayPageQuery): value is ReplayLogEntry[] {
  if (!Array.isArray(value) || value.length > query.limit) return false;
  let priorSeq = query.from - 1;
  for (const candidate of value) {
    const entry = candidate as Partial<ReplayLogEntry> | null;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)
      || entry.space !== query.space
      || typeof entry.seq !== "number" || !Number.isInteger(entry.seq) || entry.seq < query.from || entry.seq <= priorSeq
      || typeof entry.ts !== "number" || !Number.isFinite(entry.ts)
      || typeof entry.actor !== "string" || entry.actor.length === 0
      || !Array.isArray(entry.observations)
      || typeof entry.applied_ok !== "boolean") {
      return false;
    }
    priorSeq = entry.seq;
  }
  return true;
}

/** Shape guard for a replay-page query carried in a miss/repair detail. */
export function validReplayPageQuery(value: unknown): value is ReplayPageQuery {
  const query = value as { space?: unknown; from?: unknown; limit?: unknown } | null;
  return Boolean(
    query && typeof query === "object" &&
    typeof query.space === "string" && query.space.length > 0 &&
    typeof query.from === "number" && typeof query.limit === "number" &&
    validReplayPageBounds(query.from, query.limit)
  );
}
