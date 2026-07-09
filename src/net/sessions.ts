/**
 * Sessions — authority, minting, and the CO4 step-1 authorize story
 * (coherence.md CO14; Plan 002 Phase 3.5 item 4).
 *
 * **A session is a cell** (`session:<id>`), authoritative at the ACTOR's
 * cluster scope: minting, refresh, transition, and expiry are ordinary
 * commits there — one write path, no separate session store and no
 * separate presence write path (presence derives from the committed cell
 * via CO13's applier).
 *
 * Shape rule (ONE shape): the session cell value is the bridge's
 * `SerializedSession` row — exactly what `cellsFromSerialized` already
 * emits and `serializedFromCells` consumes — so a minted cell, a
 * bridge-seeded cell, and a plan-time-folded cell all content-address
 * identically for the same logical state. The fields this module reads:
 * `id`, `actor` (authority binding), `started` (created-at), `expiresAt`
 * (expiry), `activeScope` (the CO13 presence scope).
 *
 * Classification rule (documented here, applied in route.ts and the
 * gateway): a transcript's session cells classify by the transcript's
 * CALLING actor. The only session cells transcripts carry are the calling
 * session's — enforced by the two producers (mintSessionSubmit and the
 * plan.ts transition fold) — and a session's authority is its actor's
 * cluster scope, mirroring partitionCells' "a session partitions with the
 * actor the row names" (topology.ts).
 *
 * Trust posture (stated, not implied): authorize runs on the
 * internal-auth'd /net surface where the gateway is trusted infrastructure
 * (CO14 "the gateway authenticates; scopes authorize"). Foreign-session
 * validation composes the CO2.3 attestation machinery — session cells are
 * just cells: the attested VERSION is the owner's current content address,
 * and versions are content addresses of values (cells.ts cellVersion), so
 * an attestation matching the submitted read's version proves the read's
 * VALUE is the owner's current value. Semantic checks (expiry, actor
 * binding) then run on that proven value. Credential authentication
 * against identity cells is the Phase-4 transport story.
 */
import type { SerializedSession } from "../core/repository";
import { CellStore, cellKey, cellVersion, type Cell, type EpochStamp } from "./cells";
import type { CommitSubmit, ScopeHead } from "./scope";
import { applyTranscript, type EffectTranscript, type TranscriptWrite } from "./transcript";

/** The session cell value IS the bridge's SerializedSession row (see the
 * header shape rule). Task-vocabulary mapping: created_at → `started`,
 * expires_at → `expiresAt`, scope → `activeScope`. */
export type SessionCellValue = SerializedSession;

/** Canonical authority-cell key for a session id. */
export function sessionCellKey(session: string): string {
  return cellKey("session", session);
}

export type SessionVerdict = "ok" | "expired" | "missing" | "actor_mismatch";

/**
 * Semantic validation of one session cell (CO14 authorize inputs:
 * presence, expiry, actor binding). Freshness of the VALUE is the
 * caller's problem — pass an authoritative store's cell, a mint write's
 * value, or an attestation-proven read value (header trust posture).
 *
 * - no cell / no value / value.actor missing → "missing"
 * - `actor` provided and value.actor differs → "actor_mismatch"
 * - numeric expiresAt at or before `now`     → "expired" (a session with
 *   no expiresAt never expires — SerializedSession's optionality)
 */
export function validateSessionCell(
  cell: Pick<Cell, "value"> | undefined | null,
  now: number,
  actor?: string
): SessionVerdict {
  const value = cell?.value as Partial<SessionCellValue> | null | undefined;
  if (!value || typeof value !== "object" || typeof value.actor !== "string") return "missing";
  if (actor !== undefined && value.actor !== actor) return "actor_mismatch";
  if (typeof value.expiresAt === "number" && value.expiresAt <= now) return "expired";
  return "ok";
}

/** The actor's own VM frame for session-cell writes (CO3: every mutation
 * names the frame whose programmer authority performed it — for a session
 * write that authority is the actor itself; there is no verb owner to
 * launder through). */
export function sessionWriter(actor: string, verb: string): NonNullable<TranscriptWrite["writer"]> {
  return { progr: actor, thisObj: actor, verb, definer: actor, caller: actor, callerPerms: actor };
}

export type MintSessionInput = {
  session: string;
  actor: string;
  ttl_ms: number;
  /** Wall clock at mint (the authority's acceptance timestamp discipline,
   * CO2.5: the caller stamps once; retries reuse the same value). */
  now: number;
  /** The cluster scope's current head the submit is planned against. */
  base: ScopeHead;
  epoch: string;
  /** The actor's cluster scope name (CO14: the session's authority). */
  clusterScope: string;
  /** Where the session starts (client-shell phase i): v2 sessions are
   * born PLACED at the actor's location, and cross-actor delivery routes
   * by session presence — a placeless mint would miss every observation
   * until the first move. The client path passes the actor's live
   * location; internal/lane callers omit it (null — the pre-existing
   * behavior; their explicit enter turns place the session). */
  activeScope?: string | null;
};

export type MintSessionResult = {
  submit: CommitSubmit;
  /** The row the accepted cell will hold (callers install/inspect it). */
  value: SessionCellValue;
};

/**
 * Build the CommitSubmit that mints (or refreshes) a session cell as an
 * ordinary commit at the actor's cluster scope — the fixtures' twin
 * pattern as a real library function.
 *
 * Post-state parity by construction: the transcript's one write is the
 * session cell, whose applied version is the content address of the write
 * VALUE alone (applyTranscript's session case never merges prior state),
 * so deriving `post_state_version` through the SAME applyTranscript over
 * an EMPTY authority scratch yields exactly the digest the committing
 * scope derives at CO4 step 10 — no pre-state closure needed.
 *
 * The transcript names its session (`transcript.session`) AND writes it:
 * authorizeSessionSubmit's mint rule validates the WRITTEN value's actor
 * binding instead of demanding the cell pre-exist (a presence check would
 * make minting impossible). Route is "direct": the mint is a substrate
 * commit built by trusted tooling/the gateway, not a VM turn.
 *
 * Idempotency: the key binds (session, expiry), so a retried open replays
 * the recorded reply while a later REFRESH (new expiry) is a fresh turn.
 */
export function mintSessionSubmit(input: MintSessionInput): MintSessionResult {
  // Phase 5 (ready-to-scale): no-expiry session cells are forbidden at
  // mint. The reaper arms only on a numeric expiry and there is no
  // external GC, so a session minted with a zero/NaN/negative TTL would
  // be immortal state (sessionLiveness treats a missing expiresAt as
  // never-expiring by SerializedSession's optionality).
  if (!Number.isFinite(input.ttl_ms) || input.ttl_ms <= 0) {
    // A caller bug (the misplan class — plain Error, never a CO6 code):
    // every mint site owns its TTL (clampClientTtl on the client route),
    // so an invalid one reaching here means a broken caller, not a
    // divergence to repair.
    throw new Error(
      `session mint requires a positive finite ttl_ms (no-expiry sessions are forbidden): session=${input.session} ttl_ms=${input.ttl_ms}`
    );
  }
  const value: SessionCellValue = {
    id: input.session,
    actor: input.actor,
    started: input.now,
    expiresAt: input.now + input.ttl_ms,
    activeScope: input.activeScope ?? null
  };
  const body: Omit<EffectTranscript, "hash"> = {
    kind: "woo.effect_transcript.shadow.v1",
    id: `session-mint:${input.session}`,
    route: "direct",
    scope: input.clusterScope,
    seq: 0,
    session: input.session,
    call: { actor: input.actor, target: input.actor, verb: "session_mint", args: [], body: undefined },
    // A placed mint IS a presence transition (null → the birth room):
    // CO13 derives session_presence rows exclusively from the recorded
    // transition, so without this a born-present session would hold an
    // activeScope no roster ever learned about. Post-state parity is
    // unaffected — transitions drive projections, never authority cells.
    ...(input.activeScope
      ? { sessionScopeTransition: { session: input.session, actor: input.actor, from: null, to: input.activeScope } }
      : {}),
    reads: [],
    writes: [
      {
        cell: { kind: "session", object: input.session },
        value: value as unknown as TranscriptWrite["value"],
        op: "set",
        writer: sessionWriter(input.actor, "session_mint")
      }
    ],
    creates: [],
    moves: [],
    observations: [],
    logicalInputs: [],
    untrackedEffects: [],
    complete: true,
    incompleteReasons: []
  };
  const transcript: EffectTranscript = { ...body, hash: cellVersion(body) };
  const stamp: EpochStamp = { scope_head: "planner", catalog_epoch: input.epoch };
  const applied = applyTranscript(new CellStore("authority"), transcript, stamp);
  return {
    submit: {
      kind: "woo.net.commit_submit.v1",
      scope: input.clusterScope,
      base: input.base,
      idempotency_key: `session-mint:${input.session}:${value.expiresAt}`,
      transcript,
      post_state_version: applied.postStateVersion,
      stamp
    },
    value
  };
}

/** Thrown by authorizeSessionSubmit; ScopeSequencer folds `detail` into
 * the `unauthorized` reject reply so the refusal names itself (a plain
 * Error subclass, deliberately NOT a NetError: authorize failures are
 * verdicts, never taxonomy divergence — CO6/CO12.7). */
export class SessionAuthError extends Error {
  constructor(
    message: string,
    readonly detail: Record<string, unknown>
  ) {
    super(message);
    this.name = "SessionAuthError";
  }
}

export type SessionAuthDeps = {
  /** Does THIS scope hold authority for the session cell? Must exclude
   * rider-residue copies (a session cell that rode along in a CA3 commit
   * is a cache of the owner's fact, never an ownership witness). */
  ownsSession(session: string): boolean;
  /** The scope's own authoritative cell for a session it owns. */
  readSession(session: string): Pick<Cell, "value"> | undefined;
  now(): number;
};

/**
 * The CO4 step-1 `authorize` story (CO14), as a library function the
 * scope shell wires into ScopeSequencer's authorize hook.
 *
 * Which sessions a submit must answer for: every session-kind READ in the
 * transcript plus the transcript's own `session` field. With none:
 * allowed ONLY for direct-route turns (lane/tooling submits and substrate
 * commits like the mint itself); a sequenced turn without a session is
 * refused — and Phase-4 transports will require sessions on ALL
 * client-originated turns, tightening the direct-route allowance to
 * internal surfaces only.
 *
 * Per session, in order:
 * 1. **Mint/refresh rule** — the transcript WRITES this session cell
 *    (op != remove): the turn IS the session write path, so demanding
 *    pre-existence would forbid minting. Validate the WRITTEN value
 *    instead: actor binding to the calling actor, and not born expired.
 *    Transition-folded turns pass through here too — their value merges
 *    the prior row (plan.ts), whose freshness CO4 step 7 pins via the
 *    folded session read.
 * 2. **Owned session** — this scope holds the cell: validate the
 *    authoritative value (presence, expiry, actor binding).
 * 3. **Foreign session** — the CO2.3 composition (session cells are just
 *    cells): require a session READ plus an owner attestation covering
 *    it. Attested version == read version proves the read VALUE is the
 *    owner's current value (content addressing — header note); validate
 *    that value. Attested version != read version is NOT an auth verdict:
 *    return and let CO4 step 7 reject `read_version_mismatch` (retryable
 *    repair) — a stale view must never terminal-reject as unauthorized.
 *    No read or no attestation → refused (`session_unattested`): the
 *    submitter skipped the protocol, not a repairable state.
 */
export function authorizeSessionSubmit(submit: CommitSubmit, deps: SessionAuthDeps): void {
  const transcript = submit.transcript;
  const sessionReads = transcript.reads.filter((read) => read.cell.kind === "session");
  const ids = new Set<string>(sessionReads.map((read) => read.cell.object));
  if (typeof transcript.session === "string" && transcript.session.length > 0) ids.add(transcript.session);

  if (ids.size === 0) {
    if (transcript.route === "direct") return;
    throw new SessionAuthError("sequenced turn names no session", {
      session_verdict: "session_required",
      route: transcript.route
    });
  }

  const mintWrites = new Map<string, TranscriptWrite>();
  for (const write of transcript.writes) {
    if (write.cell.kind === "session" && write.op !== "remove") mintWrites.set(write.cell.object, write);
  }
  const attested = new Map<string, string>();
  for (const entry of Object.values(submit.attestations ?? {})) {
    for (const cell of entry.cells) attested.set(cell.key, cell.version);
  }
  const now = deps.now();
  const refuse = (session: string, verdict: string, extra: Record<string, unknown> = {}): never => {
    throw new SessionAuthError(`session ${session}: ${verdict}`, { session, session_verdict: verdict, ...extra });
  };

  for (const id of [...ids].sort()) {
    const mint = mintWrites.get(id);
    if (mint) {
      const verdict = validateSessionCell({ value: mint.value }, now, transcript.call.actor);
      if (verdict !== "ok") refuse(id, verdict, { source: "mint_write" });
      continue;
    }
    if (deps.ownsSession(id)) {
      const verdict = validateSessionCell(deps.readSession(id), now, transcript.call.actor);
      if (verdict !== "ok") refuse(id, verdict, { source: "owned_cell" });
      continue;
    }
    const read = sessionReads.find((r) => r.cell.object === id);
    const attestedVersion = attested.get(sessionCellKey(id));
    if (!read || attestedVersion === undefined) {
      refuse(id, "session_unattested", { has_read: Boolean(read), has_attestation: attestedVersion !== undefined });
      continue;
    }
    if (read.version === undefined || attestedVersion !== String(read.version)) {
      // Stale foreign view: step 7 rejects read_version_mismatch
      // (retryable) — never a terminal auth verdict (rule 3 above).
      continue;
    }
    const verdict = validateSessionCell({ value: read.value }, now, transcript.call.actor);
    if (verdict !== "ok") refuse(id, verdict, { source: "attested_read" });
  }
}
