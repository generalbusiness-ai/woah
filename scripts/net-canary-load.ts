/**
 * Repeatable deployed-net acceptance load.
 *
 * Claims more guests than the seed pool, then drives two concurrent turns per
 * guest into one hot room. Session shard hints route each request back to its
 * owning gateway, so the run exercises real gateway distribution and
 * cross-shard authority contention. Every response is decoded and classified;
 * HTTP failures can no longer disappear behind a sampled tail.
 *
 * It also runs a `who_all` roster-completeness check. `who_all` is now
 * presence-scoped (`active_actors` of the caller's room; the global
 * `connected_players` enumeration was retired), so a guest's `@who` must
 * return the COMPLETE co-present roster read from the room's owner-anchored
 * presence rows — the same answer on every gateway shard. This check enters
 * all guests into one room, then has each run `@who` and cross-references the
 * rosters: any shard that returns a partial roster means the room's presence
 * is not being read completely across shards (a distributed-presence
 * regression the workerd-local lanes STRUCTURALLY cannot catch — they collapse
 * every DO into one world image). Only a deployed canary with guests spread
 * across >=2 real shards exercises it. Pass `--enforce-who` to require
 * conclusive, complete-roster evidence (fails on partial OR inconclusive).
 * The catalog intentionally caps one roster at 100 actors; larger capacity
 * runs therefore pass `--skip-who` and use a separate <=100-actor
 * completeness run.
 */

import { CLIENT_SESSION_TTL_DEFAULT_MS } from "../src/net/client-session-policy";
import { sessionShardHint } from "../src/net/session-id";

export type CanaryGuest = { actor: string; session: string; elastic: boolean; activeScope: string | null };
type Outcome = { phase: "enter" | "load"; status: number; ms: number; code: string; accepted: boolean; detail: string };

/** A mint may already be present in the requested room. Re-entering that room
 * is not setup, so only sessions whose authoritative scope differs move. */
export function guestsNeedingEnter(guests: readonly CanaryGuest[], room: string): CanaryGuest[] {
  return guests.filter((guest) => guest.activeScope !== room);
}

/** One responder's `who_all` reply, reduced to what the summary needs. */
export type WhoRosterInput = {
  actor: string;
  shard: string | null;
  reachable: boolean;
  /** Serialized reply (result + observations), scanned for guest actor ids. */
  haystack: string;
};

export type WhoCheckSummary = {
  ran: boolean;
  reason?: string;
  distinct_shards: number;
  shards: Record<string, number>;
  responders: number;
  unreachable: number;
  expected: number;
  min_seen: number;
  max_missing: number;
  partial: boolean;
  examples: Array<{ actor: string; shard: string | null; seen: number; missing: string[]; detail?: string }>;
};

// A canary is an acceptance gate, so a lost edge reply must become evidence,
// not an indefinitely hung process that also skips session cleanup. Keep this
// comfortably above the Worker's 5s internal RPC deadline while still bounding
// the 512-responder roster phase.
export const DEFAULT_CANARY_FETCH_TIMEOUT_MS = 30_000;
let canaryFetchTimeoutMs = DEFAULT_CANARY_FETCH_TIMEOUT_MS;

/** Enforcement requires both a conclusive run and a complete roster. */
export function whoCheckFailsAcceptance(summary: WhoCheckSummary): boolean {
  return !summary.ran || summary.partial;
}

/**
 * Pure partial-view summary. A responder "sees" a guest when that guest's
 * (globally-unique) actor id appears anywhere in its serialized `who_all`
 * reply — robust to whatever field names the `who` roster uses. The check is
 * only meaningful with >=2 guests spread across >=2 shards; otherwise it
 * returns `ran: false` with a reason rather than a misleading pass.
 */
export function summarizeWhoCheck(
  guestActors: string[],
  guestShards: Array<string | null>,
  responders: WhoRosterInput[]
): WhoCheckSummary {
  const shards = new Map<string, number>();
  for (const hint of guestShards) {
    const key = hint ?? "(none)";
    shards.set(key, (shards.get(key) ?? 0) + 1);
  }
  const distinct = new Set(guestShards).size;
  const shardsObj = Object.fromEntries([...shards].sort());
  const base = {
    distinct_shards: distinct,
    shards: shardsObj,
    responders: 0,
    unreachable: 0,
    expected: guestActors.length,
    min_seen: 0,
    max_missing: 0,
    partial: false,
    examples: [] as WhoCheckSummary["examples"]
  };
  if (guestActors.length < 2) return { ran: false, reason: "need >=2 guests to measure a partial view", ...base };
  if (distinct < 2) return { ran: false, reason: "guests landed on a single shard (need >=2 for a partial-view signal)", ...base };

  const examples: WhoCheckSummary["examples"] = [];
  let unreachable = 0;
  let responderCount = 0;
  let minSeen = guestActors.length;
  let maxMissing = 0;
  for (const responder of responders) {
    if (!responder.reachable) {
      unreachable += 1;
      if (examples.length < 12) {
        examples.push({
          actor: responder.actor,
          shard: responder.shard,
          seen: -1,
          missing: ["UNREACHABLE"],
          detail: responder.haystack.slice(0, 500)
        });
      }
      continue;
    }
    responderCount += 1;
    const seen = guestActors.filter((actor) => responder.haystack.includes(actor));
    const missing = guestActors.filter((actor) => !seen.includes(actor));
    minSeen = Math.min(minSeen, seen.length);
    maxMissing = Math.max(maxMissing, missing.length);
    if (missing.length > 0 && examples.length < 12) {
      examples.push({ actor: responder.actor, shard: responder.shard, seen: seen.length, missing: missing.slice(0, 8) });
    }
  }
  return {
    ran: true,
    distinct_shards: distinct,
    shards: shardsObj,
    responders: responderCount,
    unreachable,
    expected: guestActors.length,
    min_seen: responderCount > 0 ? minSeen : 0,
    max_missing: maxMissing,
    partial: maxMissing > 0 || unreachable > 0,
    examples
  };
}

function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
}

export async function jsonFetch(
  url: string,
  init: RequestInit,
  timeoutMs = canaryFetchTimeoutMs
): Promise<{ response: Response; body: Record<string, unknown>; ms: number }> {
  const started = performance.now();
  const deadline = AbortSignal.timeout(timeoutMs);
  const signal = init.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  const response = await fetch(url, { ...init, signal });
  const ms = Math.round(performance.now() - started);
  const text = await response.text();
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    body = { error: { code: "E_NON_JSON", message: text.slice(0, 500) } };
  }
  return { response, body, ms };
}

type JsonFetchResult = Awaited<ReturnType<typeof jsonFetch>>;
type JsonFetcher = (url: string, init: RequestInit) => Promise<JsonFetchResult>;

/**
 * Bounded, order-preserving async map.
 *
 * Large canaries must neither serialize 512 session mints past their TTL nor
 * dump 1,024 turns into a gateway's deliberate queue-depth refusal. On the
 * first error, already-started work settles but no new item starts; callers'
 * finally blocks can therefore clean every resource they recorded.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const concurrency = Math.max(1, Math.min(items.length || 1, Math.floor(limit)));
  const results = new Array<R>(items.length);
  let cursor = 0;
  let firstError: unknown;
  const run = async (): Promise<void> => {
    while (firstError === undefined) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index]!, index);
      } catch (error) {
        firstError = error;
      }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, () => run()));
  if (firstError !== undefined) throw firstError;
  return results;
}

/**
 * Claim one deterministic guest across ambiguous transport failures.
 *
 * The claim_id is an idempotency bearer: every attempt must replay the exact
 * body. A platform-lost internal connection can surface either as a rejected
 * `fetch` or as a 500/502/503/504 edge response after the authority accepted
 * the claim. Both are ambiguous dropped replies, so retry the same bearer;
 * deterministic 4xx refusals remain immediate evidence.
 */
export async function fetchCanaryGuestClaim(
  base: string,
  claimBody: Record<string, unknown>,
  guestIndex: number,
  fetcher: JsonFetcher = jsonFetch,
  retryDelayMs = 250
): Promise<JsonFetchResult> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const result = await fetcher(`${base}/net-api/guest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(claimBody)
      });
      if (![500, 502, 503, 504].includes(result.response.status) || attempt === 3) return result;
    } catch (error) {
      if (attempt === 3) {
        throw new Error(`guest ${guestIndex} claim transport failed after ${attempt} attempts: ${String(error)}`, {
          cause: error
        });
      }
    }
    if (retryDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, attempt * retryDelayMs));
  }
  throw new Error(`guest ${guestIndex} claim retry loop exhausted`);
}

/** Drive one `who_all` turn per guest and summarize roster completeness.
 * `who_all` is a direct self-verb on $player (target = the caller's own
 * actor). The gate remains necessary after retiring connected_players:
 * sparse planning must consume the room authority's session_presence rows,
 * not merely whatever session cells the routed gateway already holds. A
 * rejected turn or incomplete owner-scoped planning view counts as
 * unreachable/partial. */
async function runWhoCheck(base: string, guests: CanaryGuest[], run: string): Promise<WhoCheckSummary> {
  const guestActors = guests.map((guest) => guest.actor);
  const guestShards = guests.map((guest) => sessionShardHint(guest.session));
  // No network round-trips when the input structurally can't produce a signal.
  if (guests.length < 2 || new Set(guestShards).size < 2) {
    return summarizeWhoCheck(guestActors, guestShards, []);
  }
  const responders: WhoRosterInput[] = [];
  for (const [index, responder] of guests.entries()) {
    try {
      const { response, body } = await jsonFetch(`${base}/net-api/turn`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer session:${responder.session}` },
        body: JSON.stringify({
          target: responder.actor,
          verb: "who_all",
          args: [],
          route: "direct",
          idempotency_key: `${run}-who-${responder.actor}`
        })
      });
      const reply = body.reply as { status?: unknown } | undefined;
      const reachable = response.ok && reply?.status === "accepted";
      responders.push({
        actor: responder.actor,
        shard: sessionShardHint(responder.session),
        reachable,
        haystack: reachable
          ? JSON.stringify({ result: body.result ?? null, observations: body.observations ?? [] })
          : JSON.stringify({ status: response.status, error: body.error ?? reply ?? null })
      });
    } catch (error) {
      // A timed-out roster read is an unreachable responder, not a reason to
      // lose the remaining cross-shard evidence or skip session cleanup.
      responders.push({
        actor: responder.actor,
        shard: sessionShardHint(responder.session),
        reachable: false,
        haystack: JSON.stringify({ error: String(error) })
      });
    }
    if ((index + 1) % 64 === 0 || index + 1 === guests.length) {
      console.error(`canary progress: who_all ${index + 1}/${guests.length}`);
    }
  }
  return summarizeWhoCheck(guestActors, guestShards, responders);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const value = (name: string, fallback: string): string => {
    const at = args.indexOf(name);
    return at === -1 ? fallback : (args[at + 1] ?? fallback);
  };
  const base = value("--base-url", "").replace(/\/$/, "");
  if (!/^https:\/\//.test(base)) throw new Error("--base-url https://... is required");
  const actors = Math.max(1, Number(value("--actors", "10")));
  const rounds = Math.max(1, Number(value("--rounds", "50")));
  const requestsPerActor = Math.max(1, Math.min(2, Number(value("--requests-per-actor", "2"))));
  const roundDelayMs = Math.max(0, Number(value("--round-delay-ms", "0")));
  const claimConcurrency = Math.max(1, Number(value("--claim-concurrency", "16")));
  const turnConcurrency = Math.max(1, Number(value("--turn-concurrency", "64")));
  canaryFetchTimeoutMs = Math.max(1_000, Number(value("--fetch-timeout-ms", String(DEFAULT_CANARY_FETCH_TIMEOUT_MS))));
  const room = value("--room", "the_chatroom");
  const enforceWho = args.includes("--enforce-who");
  const skipWho = args.includes("--skip-who");
  if (enforceWho && skipWho) throw new Error("--enforce-who and --skip-who are mutually exclusive");
  if (actors > 100 && !skipWho) {
    throw new Error("--actors >100 exceeds the catalog's bounded who_all listing; pass --skip-who and run a separate <=100 actor --enforce-who lane");
  }
  const run = `canary-${Date.now().toString(36)}`;
  const guests: CanaryGuest[] = [];
  const outcomes: Outcome[] = [];
  const closeFailures: Array<{ actor: string; status: number; detail: string }> = [];
  let whoCheck: WhoCheckSummary | null = null;

  try {
    await mapWithConcurrency(Array.from({ length: actors }, (_, index) => index), claimConcurrency, async (i) => {
      // Keep one claim bearer across transport retries. The edge routes it to
      // one shard and the gateway derives the same actor/session submit, so a
      // timeout after commit cannot leak a second anonymous identity.
      const claimBody = {
        ttl_ms: CLIENT_SESSION_TTL_DEFAULT_MS,
        claim_id: `g1.${Date.now().toString(36)}.${CLIENT_SESSION_TTL_DEFAULT_MS.toString(36)}.${crypto.randomUUID()}`
      };
      const result = await fetchCanaryGuestClaim(base, claimBody, i);
      const { response, body } = result;
      if (!response.ok || typeof body.actor !== "string" || typeof body.session !== "string") {
        throw new Error(`guest ${i} failed: ${response.status} ${JSON.stringify(body)}`);
      }
      const guest = {
        actor: body.actor,
        session: body.session,
        elastic: body.elastic === true,
        activeScope: typeof body.active_scope === "string" ? body.active_scope : null
      } satisfies CanaryGuest;
      // Record each accepted resource before the worker resolves so a later
      // sibling failure cannot hide it from the outer finally cleanup.
      guests.push(guest);
      if (guests.length % 64 === 0 || guests.length === actors) {
        console.error(`canary progress: claimed ${guests.length}/${actors} guests`);
      }
      return guest;
    });

    // Establish co-presence: every guest enters the shared room so its session
    // activeScope is that room. The who_all check below is presence-scoped
    // (active_actors of the caller's room), so guests must actually be present
    // in one room for a complete roster to be the correct answer — otherwise a
    // guest sitting in its own cluster would correctly see only itself and the
    // completeness assertion would be meaningless. Failures here are recorded
    // like any other turn outcome.
    const enterGuests = guestsNeedingEnter(guests, room);
    const enterBatch = await mapWithConcurrency(enterGuests, turnConcurrency, async (guest, index): Promise<Outcome> => {
      const started = performance.now();
      try {
        const { response, body, ms } = await jsonFetch(`${base}/net-api/turn`, {
          method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer session:${guest.session}` },
          body: JSON.stringify({ target: room, verb: "enter", args: [], idempotency_key: `${run}-enter-${index}` })
        });
        const reply = body.reply as { status?: unknown } | undefined;
        const error = body.error as { code?: unknown } | string | undefined;
        const code = typeof error === "object" && error !== null && typeof error.code === "string"
          ? error.code
          : typeof error === "string" ? error : response.ok ? String(reply?.status ?? "ok") : `HTTP_${response.status}`;
        return { phase: "enter", status: response.status, ms, code, accepted: response.ok && reply?.status === "accepted", detail: JSON.stringify(body).slice(0, 1_000) };
      } catch (err) {
        return { phase: "enter", status: 0, ms: Math.round(performance.now() - started), code: "E_FETCH", accepted: false, detail: String(err).slice(0, 1_000) };
      }
    });
    outcomes.push(...enterBatch);
    console.error(`canary progress: entered ${enterBatch.length}/${enterGuests.length} guests`);

    for (let round = 0; round < rounds; round += 1) {
      const requests = guests.flatMap((guest, actorIndex) =>
        Array.from({ length: requestsPerActor }, (_, slot) => {
          const say = requestsPerActor === 2 ? slot === 0 : round % 2 === 0;
          return say
            ? { guest, verb: "say", args: [`${run} round ${round} actor ${actorIndex}`] }
            : { guest, verb: "look", args: [] };
        })
      );
      const batch = await mapWithConcurrency(requests, turnConcurrency, async ({ guest, verb, args: turnArgs }, index): Promise<Outcome> => {
        const started = performance.now();
        try {
          const { response, body, ms } = await jsonFetch(`${base}/net-api/turn`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer session:${guest.session}`
            },
            body: JSON.stringify({
              target: room,
              verb,
              args: turnArgs,
              // Both load verbs declare live persistence. Exercise their
              // production route instead of manufacturing contention on the
              // room's durable sequence allocator.
              route: "direct",
              idempotency_key: `${run}-${round}-${index}`
            })
          });
          const reply = body.reply as { status?: unknown } | undefined;
          const error = body.error as { code?: unknown } | string | undefined;
          const code = typeof error === "object" && error !== null && typeof error.code === "string"
            ? error.code
            : typeof error === "string" ? error : response.ok ? String(reply?.status ?? "ok") : `HTTP_${response.status}`;
          return {
            phase: "load",
            status: response.status,
            ms,
            code,
            accepted: response.ok && reply?.status === "accepted",
            detail: JSON.stringify(body).slice(0, 1_000)
          };
        } catch (err) {
          const cause = err instanceof Error && err.cause !== undefined ? ` cause=${String(err.cause)}` : "";
          return {
            phase: "load",
            status: 0,
            ms: Math.round(performance.now() - started),
            code: "E_FETCH",
            accepted: false,
            detail: `${String(err)}${cause}`.slice(0, 1_000)
          };
        }
      });
      outcomes.push(...batch);
      console.error(`canary progress: load round ${round + 1}/${rounds} completed (${batch.length} turns)`);
      if (roundDelayMs > 0 && round + 1 < rounds) {
        await new Promise((resolve) => setTimeout(resolve, roundDelayMs));
      }
    }

    // Guests are co-present in the room (entered above), so a correct scoped
    // who_all must return the COMPLETE co-present roster on every shard. This
    // check now verifies that completeness (a regression gate) rather than
    // documenting the old connected_players partial view; --enforce-who fails
    // the run on any partial or inconclusive result.
    if (!skipWho) whoCheck = await runWhoCheck(base, guests, run);
  } finally {
    await mapWithConcurrency(guests, turnConcurrency, async (guest) => {
      let last = { status: 0, detail: "close request did not run" };
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try {
          const { response, body } = await jsonFetch(`${base}/net-api/session`, {
            method: "DELETE",
            headers: { "content-type": "application/json", authorization: `Bearer session:${guest.session}` },
            body: "{}"
          });
          if (response.ok) return;
          last = { status: response.status, detail: JSON.stringify(body).slice(0, 1_000) };
        } catch (err) {
          last = { status: 0, detail: String(err).slice(0, 1_000) };
        }
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 250));
      }
      closeFailures.push({ actor: guest.actor, ...last });
    });
  }

  const failures = outcomes.filter((outcome) => !outcome.accepted);
  const byCode = new Map<string, number>();
  for (const failure of failures) byCode.set(failure.code, (byCode.get(failure.code) ?? 0) + 1);
  const latencies = outcomes.map((outcome) => outcome.ms);
  const serverErrors = failures.filter((outcome) => outcome.status >= 500);
  const statusCounts = new Map<number, number>();
  for (const outcome of outcomes) statusCounts.set(outcome.status, (statusCounts.get(outcome.status) ?? 0) + 1);
  // Keep setup joins distinct from the sustained say/look envelope. A join
  // storm and an ordinary-turn failure have different capacity implications;
  // aggregating them concealed that distinction during the roster canary.
  const phaseOutcomes = Object.fromEntries((["enter", "load"] as const).map((phase) => {
    const rows = outcomes.filter((outcome) => outcome.phase === phase);
    const failed = rows.filter((outcome) => !outcome.accepted);
    return [phase, { turns: rows.length, accepted: rows.length - failed.length, failures: failed.length }];
  }));
  const report = {
    run,
    actors: guests.length,
    elastic_guests: guests.filter((guest) => guest.elastic).length,
    sessions_closed: guests.length - closeFailures.length,
    close_failures: closeFailures,
    turns: outcomes.length,
    requests_per_actor: requestsPerActor,
    claim_concurrency: claimConcurrency,
    turn_concurrency: turnConcurrency,
    round_delay_ms: roundDelayMs,
    phase_outcomes: phaseOutcomes,
    accepted: outcomes.length - failures.length,
    failures: failures.length,
    error_rate: outcomes.length === 0 ? 1 : failures.length / outcomes.length,
    server_errors: serverErrors.length,
    server_error_rate: outcomes.length === 0 ? 1 : serverErrors.length / outcomes.length,
    status_counts: Object.fromEntries([...statusCounts].sort((a, b) => a[0] - b[0])),
    failure_codes: Object.fromEntries([...byCode].sort()),
    failure_examples: [...new Map(failures.map((failure) => [
      `${failure.status}:${failure.code}:${failure.detail}`,
      { status: failure.status, code: failure.code, detail: failure.detail }
    ])).values()].slice(0, 12),
    edge_ms: {
      p50: percentile(latencies, 50),
      p95: percentile(latencies, 95),
      p99: percentile(latencies, 99),
      max: Math.max(0, ...latencies)
    },
    who_partial_view: whoCheck
  };
  console.log(JSON.stringify(report, null, 2));
  if (whoCheck?.ran && whoCheck.partial) {
    console.error(
      `who_all partial view under sharding: max_missing=${whoCheck.max_missing} unreachable=${whoCheck.unreachable} ` +
      `across ${whoCheck.distinct_shards} shards — owner-scoped presence did not converge into every planning shard. ` +
      `${enforceWho ? "Failing (--enforce-who)." : "Reported (pass --enforce-who to gate)."}`
    );
    if (enforceWho && whoCheckFailsAcceptance(whoCheck)) process.exitCode = 3;
  } else if (whoCheck && !whoCheck.ran) {
    console.error(`who_all partial-view check inconclusive: ${whoCheck.reason}`);
    // Acceptance evidence is fail-closed: a one-shard run cannot establish
    // that the cross-shard roster is complete, so enforcement must not turn
    // an inconclusive sample into a pass.
    if (enforceWho && whoCheckFailsAcceptance(whoCheck)) process.exitCode = 3;
  }
  if (failures.length > 0 || closeFailures.length > 0) process.exitCode = 2;
}

if (process.argv[1]?.endsWith("net-canary-load.ts")) {
  void main().catch((err) => {
    console.error(String(err));
    process.exitCode = 1;
  });
}
