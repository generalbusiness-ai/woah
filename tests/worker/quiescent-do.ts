// One quiescent fake-DO host, shared by every worker test that defers work.
//
// The pattern this replaces looked harmless and was not: a fixture collected
// `waitUntil` promises, `close()` shut the storage down synchronously without
// draining them, and rejections raised after the assertions had already run
// were invisible to vitest. A focused suite reported 116 passing tests while
// logging `database is not open`, `net_gateway_fanout_applied status:error`,
// `net_scope_outbox_delivery_failed` and `net_deferred_task_error`. Every one
// of those is an asynchronous regression that CI would have waved through —
// and the pattern was copied into each new suite as it was written.
//
// Two rules make the difference, and both live here so no suite has to
// remember them:
//
//   1. teardown DRAINS to quiescence before the storage closes, so deferred
//      work never runs against a dead database;
//   2. a deferred rejection FAILS its owning test instead of scrolling past.
import { FakeDurableObjectState } from "./fake-do";
import type { NetGatewayDurableState } from "../../src/worker/net/gateway-do";
import type { NetScopeDurableState } from "../../src/worker/net/scope-do";

export type QuiescentHost = {
  state: NetScopeDurableState & NetGatewayDurableState;
  /** The underlying fake, for suites that need DO-state surface this
   * fixture does not model (WebSocket hibernation) or that read the
   * storage directly. Do NOT call `fake.close()` — use `close()`, which
   * drains first. */
  readonly fake: FakeDurableObjectState;
  /** Deferred work that threw. Raised by `closeQuiescent`. */
  readonly failures: unknown[];
  /** Deferred promises not yet awaited. `settleAll` loops on this so a
   * cross-DO chain (scope drain enqueues a gateway fanout, which enqueues
   * a scope reply) is drained to GLOBAL quiescence, not per-host. */
  pending: () => number;
  /** Drain this host's deferred work to quiescence without closing. */
  settle: () => Promise<void>;
  /** Drain, then close the underlying storage. */
  close: () => Promise<void>;
};

export type QuiescentOptions = {
  /** Alarm hooks, for suites that assert on scheduling. Default: no-ops. */
  setAlarm?: (at: number) => void;
  deleteAlarm?: () => void;
};

/** Deferred passes allowed before we call it a self-feeding loop. Bounded so a
 * genuinely non-terminating drain FAILS the test rather than hanging it. */
const MAX_DRAIN_PASSES = 64;

export function quiescentNetState(name: string, options: QuiescentOptions = {}): QuiescentHost {
  const fake = new FakeDurableObjectState(name);
  const deferred: Array<Promise<unknown>> = [];
  const failures: unknown[] = [];
  const state: NetScopeDurableState & NetGatewayDurableState = {
    id: fake.id,
    waitUntil: (promise: Promise<unknown>) => {
      // Attach the handler HERE, at hand-off. Waiting until the drain to
      // `await` a rejected promise would already have produced an unhandled
      // rejection, which is reported against whichever test happens to be
      // running rather than the one that caused it.
      deferred.push(promise.catch((err) => {
        failures.push(err);
      }));
    },
    storage: {
      sql: fake.storage.sql,
      transactionSync: fake.storage.transactionSync,
      setAlarm: options.setAlarm ?? (() => {}),
      deleteAlarm: options.deleteAlarm ?? (() => {})
    }
  };
  const drain = async () => {
    // Deferred work enqueues more deferred work — a drain pass schedules the
    // next one — so a single sweep is not quiescence.
    for (let pass = 0; pass < MAX_DRAIN_PASSES; pass += 1) {
      if (deferred.length === 0) {
        // Let anything already scheduled on the microtask/timer queue enqueue.
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (deferred.length === 0) return;
      }
      while (deferred.length > 0) await deferred.shift();
    }
    throw new Error(`deferred work for ${name} never reached quiescence`);
  };
  return {
    state,
    fake,
    failures,
    pending: () => deferred.length,
    settle: drain,
    close: async () => {
      await drain();
      fake.close();
    }
  };
}

/**
 * Drain a WHOLE fixture to quiescence without closing anything.
 *
 * Per-host draining is not enough once DOs talk to each other: host A's
 * drain enqueues a fanout on host B, and if B was drained first its queue
 * refills after it was declared quiet. So sweep every host repeatedly
 * until no host has anything pending.
 */
export async function settleAll(hosts: readonly QuiescentHost[]): Promise<void> {
  for (let pass = 0; pass < MAX_DRAIN_PASSES; pass += 1) {
    for (const host of hosts) await host.settle();
    if (hosts.every((host) => host.pending() === 0)) return;
  }
  throw new Error(`deferred work across ${hosts.length} host(s) never reached quiescence`);
}

/**
 * Teardown for a whole fixture: drain and close every host, then raise
 * anything the deferred lanes threw.
 *
 * Callers `await` this from a `finally`, so a deferred failure REPLACES a body
 * failure rather than adding to it. That is deliberate — the message names
 * every deferred error, and the alternative on offer was continuing to drop
 * them silently.
 */
export async function closeQuiescent(hosts: readonly QuiescentHost[]): Promise<void> {
  // Drain the WHOLE fixture before closing ANY of it. Closing host-by-host
  // reintroduces the very bug this fixture exists to kill: host[1]'s drain
  // can call back into host[0], whose storage is by then already shut.
  await settleAll(hosts);
  for (const host of hosts) await host.close();
  const failures = hosts.flatMap((host) => [...host.failures]);
  if (failures.length === 0) return;
  throw new Error(
    `${failures.length} deferred task(s) failed after the test body:\n` +
      failures
        .map((err, i) => `  [${i}] ${err instanceof Error ? err.stack ?? err.message : String(err)}`)
        .join("\n")
  );
}
