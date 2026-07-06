/**
 * The divergence taxonomy — spec/protocol/coherence.md CO6.
 *
 * Every retryable or terminal condition the coherence layer can emit is
 * one of this closed enum, each with a defined recovery action. The layer
 * cannot emit unnamed divergence: code in `src/net/` must throw
 * NetError (or a plain programming-error TypeError for genuine bugs) and
 * nothing else — the taxonomy gate (CO12.7) enforces it.
 *
 * Retryable codes are turn mechanics and never surface to callers as
 * failures; terminal codes surface with their attempt trace.
 */

/** CO6 codes, verbatim. */
export type NetErrorCode =
  | "E_STALE_HEAD"     // submitted base behind scope head (incl. cold/evicted-scope reseed)
  | "E_STALE_EPOCH"    // consumer copy stamped with an old (scope_head, catalog_epoch)
  | "E_MISSING_STATE"  // materialization miss under sparse execution (CO2.6)
  | "E_READ_VERSION"   // read set conflicts with current authority
  | "E_SCOPE_SPLIT"    // write set spans two distinct shared scopes (CO2.3)
  | "E_LINEAGE"        // transfer lacking lineage closure — cannot occur by construction; assert
  | "E_BUDGET"         // repair budget exhausted; carries the attempt trace
  | "E_SEED_LAG";      // KV seed behind scope head; informational

/** Recovery action per code (CO6 table). Kept as data so tail metrics and
 * operator tooling can render the defined recovery without a lookup table
 * of their own. */
export const NET_ERROR_RECOVERY: Record<NetErrorCode, string> = {
  E_STALE_HEAD: "refetch head/closure, retry",
  E_STALE_EPOCH: "reseed that copy, retry",
  E_MISSING_STATE: "acquire read-closure transfer, retry",
  E_READ_VERSION: "re-plan against refreshed cells",
  E_SCOPE_SPLIT: "terminal; named limitation until CA10",
  E_LINEAGE: "cannot occur by construction (CO7); assert/alarm",
  E_BUDGET: "terminal; reply carries the attempt trace",
  E_SEED_LAG: "informational; consumer proceeds via head-check"
};

const RETRYABLE: ReadonlySet<NetErrorCode> = new Set([
  "E_STALE_HEAD",
  "E_STALE_EPOCH",
  "E_MISSING_STATE",
  "E_READ_VERSION"
]);

/** One entry per failed attempt, so an E_BUDGET reply explains itself:
 * which taxonomy code each round hit and what it was missing. */
export type AttemptTraceEntry = {
  attempt: number;
  code: NetErrorCode;
  /** Cell keys / object refs the attempt could not satisfy, if any. */
  missing?: string[];
  elapsed_ms: number;
};

export class NetError extends Error {
  readonly code: NetErrorCode;
  /** Structured context: scope, cell keys, heads — never free-form prose
   * needed for recovery decisions. */
  readonly detail: Record<string, unknown>;
  /** Present on E_BUDGET: the per-attempt taxonomy trail. */
  readonly attempts?: AttemptTraceEntry[];

  constructor(code: NetErrorCode, message: string, detail: Record<string, unknown> = {}, attempts?: AttemptTraceEntry[]) {
    super(`${code}: ${message}`);
    this.name = "NetError";
    this.code = code;
    this.detail = detail;
    if (attempts) this.attempts = attempts;
  }
}

export function netError(code: NetErrorCode, message: string, detail: Record<string, unknown> = {}): NetError {
  return new NetError(code, message, detail);
}

/** E_BUDGET constructor: terminal, requires the trace (CO6). */
export function budgetExhausted(message: string, attempts: AttemptTraceEntry[], detail: Record<string, unknown> = {}): NetError {
  return new NetError("E_BUDGET", message, detail, attempts);
}

export function isNetError(value: unknown): value is NetError {
  return value instanceof NetError;
}

/** Retryable codes are turn mechanics (the gateway repairs and retries
 * within repair_budget_ms); terminal codes surface to the caller. */
export function isRetryable(error: NetError): boolean {
  return RETRYABLE.has(error.code);
}
