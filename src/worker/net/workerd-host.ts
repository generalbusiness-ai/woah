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
import { signInternalRequest, type InternalAuthEnv } from "../internal-auth";

/**
 * Test-only fault configuration, read from WOO_NET_FAULTS (Phase-3
 * kickoff: "no new flags" — fault config is test-env-only, applied at
 * the Host.rpc seam, CO7). Shape:
 *
 *   { "<routeSuffix>": { "latency_ms"?: number, "error"?: string | true,
 *                        "kill_after_commit"?: boolean } }
 *
 * A spec matches when the rpc route equals or ends with the suffix.
 * - latency_ms: sleep before the call (models cross-colo latency);
 * - error: throw before the call ever leaves (models a dead peer);
 * - kill_after_commit: perform the call — the destination commits
 *   durably — then throw before the reply reaches the caller (models
 *   the DO dying in the reply window; the CO2.5 idempotent-replay gate).
 */
export type NetFaultSpec = {
  latency_ms?: number;
  error?: string | boolean;
  kill_after_commit?: boolean;
};

export type NetFaults = Record<string, NetFaultSpec>;

export type WorkerdHostEnv = InternalAuthEnv & {
  WOO_NET_FAULTS?: string;
  // Deployed-environment marker: WOO_AE_DATASET is set only by the
  // deploy configs (guard:smoke-wrangler lists it PROD_ONLY; the local
  // workerd lanes strip the Analytics Engine surface entirely). Fault
  // injection refuses to arm when it is present — same posture as
  // WOO_FAULT_INJECT's "never set in production", but enforced at
  // runtime instead of by convention alone.
  WOO_AE_DATASET?: string;
};

/** The narrow stub surface rpc needs — satisfied by a real
 * DurableObjectStub and by the fake namespace's stubs alike. */
export type NetStub = { fetch(request: Request): Promise<Response> | Response };

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
  /** Armed wake-ups by key. The DO alarm API is a single alarm per DO,
   * so the key exists for documentation/bookkeeping: the storage alarm
   * is always armed to the EARLIEST pending `at` across keys. */
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
      console.log(
        "woo.metric",
        JSON.stringify({ kind: "net_deferred_task_error", error: String(err), ts: Date.now() })
      );
    });
    this.options.waitUntil?.(promise);
  }

  /**
   * Map the keyed multi-alarm contract onto the DO's single storage
   * alarm: track the requested `at` per key, arm storage to the minimum.
   * The `fire` callback is deliberately NOT retained: in-memory
   * callbacks cannot survive eviction, so the durable wake path is the
   * DO class's own `alarm()` handler, which re-derives due work from
   * hydrated scope state and re-arms from `nextAlarmAt()` (CO2.8 —
   * exactly why a parked task survives eviction).
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
    // caller-visible result; a failed arm surfaces on the next request.
    void (earliest === null ? storage.deleteAlarm() : storage.setAlarm(earliest));
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
    if (fault?.latency_ms) {
      await new Promise((resolve) => setTimeout(resolve, fault.latency_ms));
    }

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
    const response = await stub.fetch(signed);

    if (fault?.kill_after_commit) {
      // The destination has durably committed; the caller "dies" before
      // seeing the reply. Recovery is the CO2.5 idempotent resubmit.
      throw new Error(`injected fault: kill_after_commit after ${route}`);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`rpc ${destination}${route} failed: ${response.status} ${text}`.trim());
    }
    return response.json();
  }

  private faultFor(route: string): NetFaultSpec | null {
    if (!this.faults) return null;
    for (const [suffix, spec] of Object.entries(this.faults)) {
      if (route === suffix || route.endsWith(suffix)) return spec;
    }
    return null;
  }
}
