/**
 * Host — the deployment seam of the coherence layer (coherence.md CO1).
 *
 * The pipeline is written against this interface; only the binding
 * differs per mode (the design decision that kills transport
 * triplication and the fake-DO fidelity gap — one composition, three
 * hosts):
 *
 * - InProcessHost (this file): dev server, tests, browser echo.
 *   Deterministic: manual clock, explicit flush, ordered alarms.
 * - WorkerdHost (Phase 3): DOs — `defer` maps to waitUntil, `setAlarm`
 *   to the DO alarm API, `now` to Date.now.
 * - SqliteHost (Phase 3): single-process durable deployment.
 *
 * Modules never read wall-clock or schedule work themselves; they take
 * `now` as a parameter (outbox, scope) or hand the Host a callback.
 * That is what makes drains replayable in tests and the aged-world lane
 * (CO12.6) constructible.
 */

export interface Host {
  /** Time source. In-process: a manual clock the test advances. */
  now(): number;
  /** Post-reply work (fanout drain) — never blocks the reply path
   * (CO2.7: actor reply time independent of audience size). */
  defer(task: () => Promise<void>): void;
  /** (Re)arm the wake-up for a scope's earliest scheduled work (CO2.8).
   * `at: null` clears the alarm. The Host guarantees `fire` runs once
   * per arming when now() reaches `at`. */
  setAlarm(key: string, at: number | null, fire: () => Promise<void>): void;
  /**
   * EVERY cross-node call in the coherence layer goes through this one
   * method — gateway→scope submit/closure/head, scope→gateway fanout,
   * scope→scope rider adoption. That single choke point is what makes
   * fault injection a one-place seam (Phase-3 kickoff: latency, error,
   * kill-after-commit are applied inside `rpc`, never scattered across
   * call sites the way v2's patch points were).
   *
   * `destination` names the remote node (e.g. `scope:the_room`,
   * `gateway:shard-3`); `route` is the path suffix under the node's
   * `/net` surface (e.g. `/submit`); `body` is the JSON payload —
   * `undefined` means a body-less GET. The result is the decoded JSON
   * reply. Failures are plain Errors (transport) or NetError (taxonomy)
   * — never a third shape.
   */
  rpc(destination: string, route: string, body?: unknown): Promise<unknown>;
}

/** Deterministic in-process binding. Nothing runs until the test drives
 * `flush()` (deferred work) or `advance()` (clock + due alarms). */
export class InProcessHost implements Host {
  private time: number;
  private readonly deferred: Array<() => Promise<void>> = [];
  private readonly alarms = new Map<string, { at: number; fire: () => Promise<void> }>();
  private readonly rpcHandlers = new Map<string, (route: string, body: unknown) => Promise<unknown>>();

  constructor(start = 0) {
    this.time = start;
  }

  now(): number {
    return this.time;
  }

  /** Register the in-process stand-in for a remote node. Tests wire the
   * destination directly to the receiving module (no transport), so the
   * same pipeline code runs under both hosts. */
  registerRpc(destination: string, handler: (route: string, body: unknown) => Promise<unknown>): void {
    this.rpcHandlers.set(destination, handler);
  }

  async rpc(destination: string, route: string, body?: unknown): Promise<unknown> {
    const handler = this.rpcHandlers.get(destination);
    if (!handler) {
      // Unknown destination is a wiring bug in the test/dev composition,
      // not a taxonomy divergence — plain Error by contract.
      throw new Error(`InProcessHost.rpc: no handler registered for destination ${destination}`);
    }
    return handler(route, body);
  }

  defer(task: () => Promise<void>): void {
    this.deferred.push(task);
  }

  setAlarm(key: string, at: number | null, fire: () => Promise<void>): void {
    if (at === null) {
      this.alarms.delete(key);
      return;
    }
    this.alarms.set(key, { at, fire });
  }

  /** Run all deferred tasks (in order, including ones deferred while
   * flushing — a drain may defer a follow-up). */
  async flush(): Promise<void> {
    while (this.deferred.length > 0) {
      const task = this.deferred.shift() as () => Promise<void>;
      await task();
    }
  }

  /** Advance the clock, firing due alarms in time order (ties by key so
   * runs are deterministic), then flushing deferred work each alarm may
   * have queued. An alarm fires once per arming; `fire` re-arms via
   * setAlarm if more work remains — same contract as DO alarms. */
  async advance(toTime: number): Promise<void> {
    while (true) {
      const due = [...this.alarms.entries()]
        .filter(([, alarm]) => alarm.at <= toTime)
        .sort((a, b) => a[1].at - b[1].at || a[0].localeCompare(b[0]));
      if (due.length === 0) break;
      const [key, alarm] = due[0];
      this.alarms.delete(key);
      this.time = Math.max(this.time, alarm.at);
      await alarm.fire();
      await this.flush();
    }
    this.time = Math.max(this.time, toTime);
    await this.flush();
  }

  /** Introspection for tests. */
  pendingAlarms(): Array<{ key: string; at: number }> {
    return [...this.alarms.entries()].map(([key, alarm]) => ({ key, at: alarm.at })).sort((a, b) => a.at - b.at);
  }
}
