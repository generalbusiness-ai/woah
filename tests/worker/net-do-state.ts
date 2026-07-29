// Shared fake-DO durable state for the Net worker fixtures.
//
// Extracted from net-mcp-idempotency.test.ts, which is where the quiescent
// teardown was first built. Two files now need it, and a copied fixture is a
// fixture that drifts: the copy that does NOT drain would go back to
// reporting green over `database is not open`, which is exactly the failure
// this exists to make visible. One implementation, both callers.
//
// The problem it solves: a DO's `waitUntil` work (fanout, outbox delivery,
// scheduled tasks) keeps running after the test body's assertions have
// reported. Closing storage synchronously underneath it produced a stream of
// post-assertion errors that vitest never attributed to anything, and
// dropped rejections meant a genuinely broken deferred lane still exited 0.
import { FakeDurableObjectState } from "./fake-do";
import type { NetGatewayDurableState } from "../../src/worker/net/gateway-do";
import type { NetScopeDurableState } from "../../src/worker/net/scope-do";

/** How many drain passes before we call a deferred lane self-feeding. */
const QUIESCENCE_PASSES = 64;

export type NetFakeDoState = {
  state: NetScopeDurableState & NetGatewayDurableState;
  /** Deferred work that FAILED, in arrival order. */
  failures: unknown[];
  /** Drain deferred work to quiescence. Safe to call mid-test. */
  settle: () => Promise<void>;
  /** Drain, then close storage. Never closes under live deferred work. */
  close: () => Promise<void>;
};

/**
 * One fake DO's durable state, with deferred work tracked rather than
 * dropped.
 *
 * `waitUntil` records rejections instead of letting them escape as unhandled
 * — a rejection raised after the assertions have run is invisible to vitest,
 * so the file reports green while the errors scroll past. `close()` raises
 * them so they land in the test result.
 */
export function netState(name: string): NetFakeDoState {
  const fake = new FakeDurableObjectState(name);
  const deferred: Array<Promise<unknown>> = [];
  const failures: unknown[] = [];
  const state: NetScopeDurableState & NetGatewayDurableState = {
    id: fake.id,
    waitUntil: (promise: Promise<unknown>) => {
      deferred.push(promise.catch((err) => {
        failures.push(err);
      }));
    },
    storage: {
      sql: fake.storage.sql,
      transactionSync: fake.storage.transactionSync,
      setAlarm: () => {},
      deleteAlarm: () => {}
    }
  };
  const drain = async () => {
    // Deferred work enqueues more deferred work (a drain pass schedules the
    // next one), so one sweep is not quiescence. Bounded so a genuinely
    // self-feeding loop fails the test instead of hanging it.
    for (let pass = 0; pass < QUIESCENCE_PASSES; pass += 1) {
      if (deferred.length === 0) {
        // Give any already-scheduled microtask/timer a turn to enqueue.
        await new Promise((resolve) => setTimeout(resolve, 0));
        if (deferred.length === 0) return;
      }
      while (deferred.length > 0) await deferred.shift();
    }
    throw new Error(`deferred work for ${name} never reached quiescence`);
  };
  return {
    state,
    failures,
    settle: drain,
    /** Drain to quiescence BEFORE the storage goes away. Closing under live
     * deferred work is what produced the post-assertion error noise. */
    close: async () => {
      await drain();
      fake.close();
    }
  };
}

/**
 * Tear down every host, then surface anything the deferred lanes threw.
 *
 * Callers `await` this in a `finally`. If the body ALSO failed, the deferred
 * error replaces it — accepted deliberately, because a deferred rejection is
 * a real defect and the message names every one of them. The alternative was
 * continuing to drop them silently.
 */
export async function closeNetStates(states: NetFakeDoState[]): Promise<void> {
  for (const st of states) await st.close();
  const failures = states.flatMap((st) => st.failures);
  if (failures.length > 0) {
    throw new Error(
      `${failures.length} deferred task(s) failed after the test body:\n` +
        failures.map((err, i) => `  [${i}] ${err instanceof Error ? err.stack ?? err.message : String(err)}`).join("\n")
    );
  }
}
