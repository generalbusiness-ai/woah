/**
 * Repeatable deployed-net acceptance load.
 *
 * Claims more guests than the seed pool, then drives two concurrent turns per
 * guest into one hot room. Session shard hints route each request back to its
 * owning gateway, so the run exercises real gateway distribution and
 * cross-shard authority contention. Every response is decoded and classified;
 * HTTP failures can no longer disappear behind a sampled tail.
 *
 * It also runs a `who_all` partial-view check (item 6 of the net-cutover
 * layering work): `connected_players` is a GLOBAL session enumeration
 * (src/core/world.ts connectedPlayerRefs), so on the sharded /net-api surface
 * a single gateway shard only holds its own guests' session cells. Each guest
 * running `@who` therefore sees only the ~1/N of players routed to its shard —
 * a Big-World violation that the workerd-local lanes STRUCTURALLY cannot catch
 * (they collapse every DO into one world image, so `connected_players` returns
 * everyone). Only a deployed canary with guests spread across >=2 real shards
 * exposes it. This check measures and reports the partial view; pass
 * `--enforce-who` to require conclusive, complete-roster evidence.
 */

import { sessionShardHint } from "../src/net/session-id";

type Guest = { actor: string; session: string; elastic: boolean };
type Outcome = { status: number; ms: number; code: string; accepted: boolean; detail: string };

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
  examples: Array<{ actor: string; shard: string | null; seen: number; missing: string[] }>;
};

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
      if (examples.length < 12) examples.push({ actor: responder.actor, shard: responder.shard, seen: -1, missing: ["UNREACHABLE"] });
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

async function jsonFetch(url: string, init: RequestInit): Promise<{ response: Response; body: Record<string, unknown>; ms: number }> {
  const started = performance.now();
  const response = await fetch(url, init);
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

/** Drive one `who_all` turn per guest and summarize the partial view.
 * `who_all` is a direct self-verb on $player (target = the caller's own
 * actor); its `connected_players()` read is admitted with whatever session
 * cells the routed shard already holds, which IS the partial view we measure.
 * A rejected turn is itself a finding (the global builtin has no legible
 * read-set on the net path) and counts as unreachable. */
async function runWhoCheck(base: string, guests: Guest[], run: string): Promise<WhoCheckSummary> {
  const guestActors = guests.map((guest) => guest.actor);
  const guestShards = guests.map((guest) => sessionShardHint(guest.session));
  // No network round-trips when the input structurally can't produce a signal.
  if (guests.length < 2 || new Set(guestShards).size < 2) {
    return summarizeWhoCheck(guestActors, guestShards, []);
  }
  const responders: WhoRosterInput[] = [];
  for (const responder of guests) {
    const { response, body } = await jsonFetch(`${base}/net-api/turn`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer session:${responder.session}` },
      body: JSON.stringify({ target: responder.actor, verb: "who_all", args: [], idempotency_key: `${run}-who-${responder.actor}` })
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
  const room = value("--room", "the_chatroom");
  const enforceWho = args.includes("--enforce-who");
  const run = `canary-${Date.now().toString(36)}`;
  const guests: Guest[] = [];
  const outcomes: Outcome[] = [];
  const closeFailures: Array<{ actor: string; status: number; detail: string }> = [];
  let whoCheck: WhoCheckSummary | null = null;

  try {
    for (let i = 0; i < actors; i += 1) {
      const { response, body } = await jsonFetch(`${base}/net-api/guest`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ttl_ms: 10 * 60_000 })
      });
      if (!response.ok || typeof body.actor !== "string" || typeof body.session !== "string") {
        throw new Error(`guest ${i} failed: ${response.status} ${JSON.stringify(body)}`);
      }
      guests.push({ actor: body.actor, session: body.session, elastic: body.elastic === true });
    }

    for (let round = 0; round < rounds; round += 1) {
      const requests = guests.flatMap((guest, actorIndex) =>
        Array.from({ length: requestsPerActor }, (_, slot) => {
          const say = requestsPerActor === 2 ? slot === 0 : round % 2 === 0;
          return say
            ? { guest, verb: "say", args: [`${run} round ${round} actor ${actorIndex}`] }
            : { guest, verb: "look", args: [] };
        })
      );
      const batch = await Promise.all(requests.map(async ({ guest, verb, args: turnArgs }, index): Promise<Outcome> => {
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
              idempotency_key: `${run}-${round}-${index}`
            })
          });
          const reply = body.reply as { status?: unknown } | undefined;
          const error = body.error as { code?: unknown } | string | undefined;
          const code = typeof error === "object" && error !== null && typeof error.code === "string"
            ? error.code
            : typeof error === "string" ? error : response.ok ? String(reply?.status ?? "ok") : `HTTP_${response.status}`;
          return {
            status: response.status,
            ms,
            code,
            accepted: response.ok && reply?.status === "accepted",
            detail: JSON.stringify(body).slice(0, 1_000)
          };
        } catch (err) {
          const cause = err instanceof Error && err.cause !== undefined ? ` cause=${String(err.cause)}` : "";
          return {
            status: 0,
            ms: Math.round(performance.now() - started),
            code: "E_FETCH",
            accepted: false,
            detail: `${String(err)}${cause}`.slice(0, 1_000)
          };
        }
      }));
      outcomes.push(...batch);
      if (roundDelayMs > 0 && round + 1 < rounds) {
        await new Promise((resolve) => setTimeout(resolve, roundDelayMs));
      }
    }

    // Guests are now connected (the rounds above enter/act on the room), so
    // connected_players will count them. Measure the sharded partial view.
    whoCheck = await runWhoCheck(base, guests, run);
  } finally {
    await Promise.all(guests.map(async (guest) => {
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
    }));
  }

  const failures = outcomes.filter((outcome) => !outcome.accepted);
  const byCode = new Map<string, number>();
  for (const failure of failures) byCode.set(failure.code, (byCode.get(failure.code) ?? 0) + 1);
  const latencies = outcomes.map((outcome) => outcome.ms);
  const serverErrors = failures.filter((outcome) => outcome.status >= 500);
  const statusCounts = new Map<number, number>();
  for (const outcome of outcomes) statusCounts.set(outcome.status, (statusCounts.get(outcome.status) ?? 0) + 1);
  const report = {
    run,
    actors: guests.length,
    elastic_guests: guests.filter((guest) => guest.elastic).length,
    sessions_closed: guests.length - closeFailures.length,
    close_failures: closeFailures,
    turns: outcomes.length,
    requests_per_actor: requestsPerActor,
    round_delay_ms: roundDelayMs,
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
      `across ${whoCheck.distinct_shards} shards — connected_players is a global enumeration and returns a per-shard ` +
      `partial roster (Big-World violation). ${enforceWho ? "Failing (--enforce-who)." : "Reported (pass --enforce-who to gate)."}`
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
