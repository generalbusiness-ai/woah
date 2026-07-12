/**
 * Repeatable deployed-net acceptance load.
 *
 * Claims more guests than the seed pool, then drives two concurrent turns per
 * guest into one hot room. Session shard hints route each request back to its
 * owning gateway, so the run exercises real gateway distribution and
 * cross-shard authority contention. Every response is decoded and classified;
 * HTTP failures can no longer disappear behind a sampled tail.
 */

type Guest = { actor: string; session: string; elastic: boolean };
type Outcome = { status: number; ms: number; code: string; accepted: boolean; detail: string };

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
  const room = value("--room", "the_chatroom");
  const run = `canary-${Date.now().toString(36)}`;
  const guests: Guest[] = [];
  const outcomes: Outcome[] = [];
  const closeFailures: Array<{ actor: string; status: number; detail: string }> = [];

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
      const requests = guests.flatMap((guest, actorIndex) => [
        { guest, verb: "say", args: [`${run} round ${round} actor ${actorIndex}`] },
        { guest, verb: "look", args: [] }
      ]);
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
    }
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
    }
  };
  console.log(JSON.stringify(report, null, 2));
  if (failures.length > 0 || closeFailures.length > 0) process.exitCode = 2;
}

void main().catch((err) => {
  console.error(String(err));
  process.exitCode = 1;
});
