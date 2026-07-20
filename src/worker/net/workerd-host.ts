/**
 * WorkerdHost — the Cloudflare Durable Object binding of the coherence
 * layer's Host seam (src/net/host.ts; Plan 002 Phase 3 step 2).
 *
 * One composition, three hosts: the pipeline under src/net/ never touches
 * DO primitives directly — this file is where `now`/`defer`/`setAlarm`/
 * `rpc` become Date.now / waitUntil / the DO storage alarm / signed
 * cross-DO fetches. In particular `rpc` is THE single cross-DO choke
 * point, which is what turns fault injection into a one-place seam
 * instead of v2's scattered patch points (rpc-fault-inject.ts had to
 * enumerate three separate route seams; here there is exactly one).
 *
 * Layering: this file lives in src/worker/net/ and may know about DO
 * stubs, env shapes, and internal-auth. src/net/ must never import it.
 */
import type { Host } from "../../net/host";
import { netError } from "../../net/errors";
import { signInternalRequest, type InternalAuthEnv } from "../internal-auth";
import type { AnalyticsMetric, MetricsAnalyticsBinding } from "../metrics-sink";

/**
 * Test-only fault configuration, read from WOO_NET_FAULTS (Phase-3
 * kickoff: "no new flags" — fault config is test-env-only, applied at
 * the Host.rpc seam, CO7). Shape:
 *
 *   { "<routeSuffix>": { "latency_ms"?: number, "timeout"?: boolean,
 *                        "error"?: string | true,
 *                        "kill_after_commit"?: boolean } }
 *
 * A spec matches when the rpc route equals or ends with the suffix.
 * - latency_ms: sleep before the call (models cross-colo latency);
 * - timeout: park until the configured RPC deadline aborts the call;
 * - error: throw before the call ever leaves (models a dead peer);
 * - kill_after_commit: perform the call — the destination commits
 *   durably — then throw before the reply reaches the caller (models
 *   the DO dying in the reply window; the CO2.5 idempotent-replay gate).
 */
export type NetFaultSpec = {
  latency_ms?: number;
  timeout?: boolean;
  error?: string | boolean;
  kill_after_commit?: boolean;
  /** Let the first N matching calls through unfaulted — how a lane arms a
   * fault for the repair path while sparing setup calls on the same route
   * (e.g. one clean /closure pull, then every refresh faults). */
  skip_first?: number;
};

export type NetFaults = Record<string, NetFaultSpec>;

export type WorkerdHostEnv = InternalAuthEnv & {
  WOO_NET_FAULTS?: string;
  /** Hard deadline for every coherence-layer cross-DO call. */
  NET_RPC_TIMEOUT_MS?: string;
  // Deployed-environment marker: WOO_AE_DATASET is set only by the
  // deploy configs (guard:smoke-wrangler lists it PROD_ONLY; the local
  // workerd lanes strip the Analytics Engine surface entirely). Fault
  // injection refuses to arm when it is present — same posture as
  // WOO_FAULT_INJECT's "never set in production", but enforced at
  // runtime instead of by convention alone.
  WOO_AE_DATASET?: string;
  METRICS?: MetricsAnalyticsBinding;
};

/** The narrow stub surface rpc needs — satisfied by a real
 * DurableObjectStub and by the fake namespace's stubs alike. */
export type NetStub = { fetch(request: Request): Promise<Response> | Response };

/** Structural slice of a DurableObjectNamespace — enough to resolve a
 * name to a stub; satisfied by real bindings and the fake namespace. */
export type NetNamespace = {
  idFromName(name: string): unknown;
  get(id: unknown): NetStub;
};

/** The env bindings both net DO classes resolve rpc destinations from.
 * NET_RESOLVE is the test override (the fake harness wires stubs
 * directly); without it, `scope:<name>` → SCOPE_NET and
 * `gateway:<name>` → GATEWAY_NET (the kickoff RPC surface). */
export type NetBindingsEnv = WorkerdHostEnv & {
  NET_RESOLVE?: (destination: string) => NetStub;
  SCOPE_NET?: NetNamespace;
  GATEWAY_NET?: NetNamespace;
  /** Audit shard namespace (audit.md AU6; `audit:<shard>` destinations). */
  AUDIT_NET?: NetNamespace;
  /** Bounded audit shard count. Absent/0 → the audit lane is disabled
   * (scopes enqueue nothing) — lanes without the binding stay green. */
  NET_AUDIT_SHARDS?: string;
  /** AU8 span export (span-export.ts): OTLP/HTTP traces endpoint and
   * the 1-in-N sample rate for minted traces. Both optional; absent =
   * woo.span logging only / minted traces unsampled. */
  WOO_OTLP_ENDPOINT?: string;
  NET_SPAN_SAMPLE?: string;
};

/** destination = "<kind>:<name>". Shared by NetGatewayDO and NetScopeDO
 * (the scope needs it for outbox fanout/adoption drains) so the two
 * shells cannot drift on how a destination name resolves. */
export function resolveNetDestination(env: NetBindingsEnv, destination: string): NetStub {
  if (env.NET_RESOLVE) return env.NET_RESOLVE(destination);
  const split = destination.indexOf(":");
  const kind = split === -1 ? destination : destination.slice(0, split);
  const name = split === -1 ? "" : destination.slice(split + 1);
  const namespace =
    kind === "scope" ? env.SCOPE_NET : kind === "gateway" ? env.GATEWAY_NET : kind === "audit" ? env.AUDIT_NET : undefined;
  if (!namespace || !name) {
    throw new Error(`cannot resolve rpc destination ${destination}`);
  }
  return namespace.get(namespace.idFromName(name));
}

/** The alarm slice of DO storage. Real `ctx.storage` satisfies this;
 * the fake-DO test harness supplies a recording equivalent. */
export type AlarmStorage = {
  setAlarm(at: number): void | Promise<void>;
  deleteAlarm(): void | Promise<void>;
};

export type WorkerdHostOptions = {
  /** Resolve a destination name (`scope:<name>`, `gateway:<name>`) to a
   * DO stub. Constructor-injected so the host stays namespace-agnostic
   * and tests can wire fake stubs. */
  resolve: (destination: string) => NetStub;
  env: WorkerdHostEnv;
  /** ctx.waitUntil — keeps deferred drains alive past the reply. When
   * absent (some test harnesses), deferred tasks still run, detached. */
  waitUntil?: (promise: Promise<unknown>) => void;
  /** The DO's alarm storage. Optional because a gateway that never
   * schedules can run without one; setAlarm then throws loudly. */
  alarmStorage?: AlarmStorage;
  /** Owning DO's log+AE emitter. The host owns transport failures but not
   * the DO identity used as the Analytics Engine index. */
  metric?: (event: AnalyticsMetric) => void;
};

/** Parse WOO_NET_FAULTS exactly once per host (one host per DO lifetime).
 * Throws on malformed JSON — a misconfigured test must fail loudly — and
 * REFUSES to arm in a deployed environment (see WorkerdHostEnv). */
export function parseNetFaults(env: WorkerdHostEnv): NetFaults | null {
  if (!env.WOO_NET_FAULTS) return null;
  if (env.WOO_AE_DATASET !== undefined) {
    throw new Error(
      "WOO_NET_FAULTS refused: WOO_AE_DATASET marks a deployed environment; fault injection is test-lane-only"
    );
  }
  const parsed = JSON.parse(env.WOO_NET_FAULTS) as unknown;
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("WOO_NET_FAULTS must be a JSON object of {routeSuffix: fault spec}");
  }
  return parsed as NetFaults;
}

export class WorkerdHost implements Host {
  private readonly options: WorkerdHostOptions;
  private readonly faults: NetFaults | null;
  /** Matching-call counts per fault suffix, for skip_first. Per-host
   * (per DO lifetime) — a lane that needs cross-eviction counting should
   * use distinct routes instead. */
  private readonly faultMatches = new Map<string, number>();
  /** Armed wake-ups by key. The DO alarm API is a single alarm per DO,
   * so the key exists for documentation/bookkeeping: the storage alarm
   * is always armed to the EARLIEST pending `at` across keys.
   *
   * Post-eviction caveat (fix 8d): this map is per-DO-lifetime memory —
   * after an eviction it starts EMPTY, so the earliest-of-keys
   * computation only spans keys re-registered in the new lifetime. A
   * fresh lifetime's first setAlarm can therefore re-arm the durable
   * storage alarm LATER than a wake an earlier lifetime had armed for
   * another key (delay, never loss: the DO's alarm() handler re-derives
   * every wake source — scheduled rows, outbox retries — from durable
   * state and re-arms all keys). Correctness never depends on this map;
   * it only prevents a later-key arm from clobbering an earlier one
   * within a single lifetime. */
  private readonly alarms = new Map<string, number>();

  constructor(options: WorkerdHostOptions) {
    this.options = options;
    this.faults = parseNetFaults(options.env);
  }

  now(): number {
    return Date.now();
  }

  defer(task: () => Promise<void>): void {
    // Never block the reply path (CO2.7). Failures are logged, not
    // thrown: a deferred drain retries via the durable outbox, so an
    // exception here has nowhere useful to go.
    const promise = task().catch((err) => {
      this.metric({ kind: "net_deferred_task_error", error: String(err) });
    });
    this.options.waitUntil?.(promise);
  }

  /**
   * Map the keyed multi-alarm contract onto the DO's single storage
   * alarm: track the requested `at` per key, arm storage to the minimum.
   * The `fire` callback is deliberately NOT retained: in-memory
   * callbacks cannot survive eviction, so the durable wake path is the
   * DO class's own `alarm()` handler, which re-derives due work from
   * durable scope state (scheduled rows, outbox retries) and re-arms
   * every key (CO2.8 — exactly why a parked task survives eviction).
   */
  setAlarm(key: string, at: number | null, _fire: () => Promise<void>): void {
    const storage = this.options.alarmStorage;
    if (!storage) throw new Error("WorkerdHost.setAlarm: no alarmStorage wired for this DO");
    if (at === null) this.alarms.delete(key);
    else this.alarms.set(key, at);
    let earliest: number | null = null;
    for (const pending of this.alarms.values()) {
      if (earliest === null || pending < earliest) earliest = pending;
    }
    // Fire-and-forget: the storage alarm API is async but arming has no
    // caller-visible result. A failed arm is a LIVENESS hazard (a quiet
    // scope's retry/wake never fires), so capture both sync throws and
    // async rejections as a named metric (fix 8b) — the next request's
    // drain-on-reactivation / re-arm is the recovery.
    const logArmFailure = (err: unknown): void => {
      this.metric({ kind: "net_alarm_arm_failed", key, at: earliest, error: String(err) });
    };
    try {
      void Promise.resolve(earliest === null ? storage.deleteAlarm() : storage.setAlarm(earliest)).catch(logArmFailure);
    } catch (err) {
      logArmFailure(err);
    }
  }

  /**
   * The single cross-DO seam. Resolve the destination stub, sign the
   * request with internal auth (the same HMAC surface every existing
   * internal DO route verifies), fetch, decode JSON. `body === undefined`
   * sends a body-less GET (the /net/head shape); anything else POSTs
   * JSON. Faults (test lanes only — see parseNetFaults) apply here and
   * only here.
   */
  async rpc(destination: string, route: string, body?: unknown): Promise<unknown> {
    const fault = this.faultFor(route);
    if (fault?.error) {
      throw new Error(`injected fault: ${typeof fault.error === "string" ? fault.error : `rpc error on ${route}`}`);
    }
    const timeoutMs = this.rpcTimeoutMs();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const started = Date.now();
    try {
      if (fault?.latency_ms) await waitForAbortableDelay(fault.latency_ms, controller.signal);
      if (fault?.timeout) await waitForAbort(controller.signal);

      const stub = this.options.resolve(destination);
      // The hostname is a placeholder — DO stubs ignore it; internal-auth
      // signs method + path + headers, not the origin.
      const url = `https://do/net${route}`;
      const request =
        body === undefined
          ? new Request(url)
          : new Request(url, {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify(body)
            });
      const signed = await signInternalRequest(this.options.env, request);
      // Real fetch observes the signal and cancels its subrequest. The
      // explicit race also makes fake stubs and pre-call faults settle at
      // the same deadline instead of leaving the caller parked forever.
      const response = await raceAbort(stub.fetch(new Request(signed, { signal: controller.signal })), controller.signal);

      if (fault?.kill_after_commit) {
        // The destination has durably committed; the caller "dies" before
        // seeing the reply. Recovery is the CO2.5 idempotent resubmit.
        throw new Error(`injected fault: kill_after_commit after ${route}`);
      }
      if (!response.ok) {
        const text = await response.text().catch(() => "");
        throw new Error(`rpc ${destination}${route} failed: ${response.status} ${text}`.trim());
      }
      return await raceAbort(response.json(), controller.signal);
    } catch (err) {
      if (controller.signal.aborted) {
        this.metric({
          kind: "net_rpc",
          destination,
          route,
          status: "timeout",
          error: "E_RPC_TIMEOUT",
          ms: Date.now() - started,
          timeout_ms: timeoutMs
        });
        throw netError("E_RPC_TIMEOUT", `rpc timed out: ${destination}${route}`, {
          destination,
          route,
          timeout_ms: timeoutMs
        });
      }
      throw err;
    } finally {
      clearTimeout(timeout);
    }
  }

  private rpcTimeoutMs(): number {
    const configured = Number(this.options.env.NET_RPC_TIMEOUT_MS);
    if (!Number.isFinite(configured) || configured <= 0) return 5_000;
    return Math.min(30_000, Math.max(10, Math.floor(configured)));
  }

  private metric(event: AnalyticsMetric): void {
    if (this.options.metric) {
      this.options.metric(event);
      return;
    }
    console.log("woo.metric", JSON.stringify({ ...event, ts: Date.now() }));
  }

  private faultFor(route: string): NetFaultSpec | null {
    if (!this.faults) return null;
    for (const [suffix, spec] of Object.entries(this.faults)) {
      if (route === suffix || route.endsWith(suffix)) {
        const seen = (this.faultMatches.get(suffix) ?? 0) + 1;
        this.faultMatches.set(suffix, seen);
        if (spec.skip_first !== undefined && seen <= spec.skip_first) return null;
        return spec;
      }
    }
    return null;
  }
}

function waitForAbort(signal: AbortSignal): Promise<never> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
}

async function waitForAbortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      new Promise<void>((resolve) => { timer = setTimeout(resolve, ms); }),
      waitForAbort(signal)
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function raceAbort<T>(value: Promise<T> | T, signal: AbortSignal): Promise<T> {
  return await Promise.race([Promise.resolve(value), waitForAbort(signal)]);
}
