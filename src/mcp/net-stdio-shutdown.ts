/**
 * Bounded shutdown for the Net MCP stdio bridge.
 *
 * The bridge is how a local agent (including Claude Code) reaches woo, so it
 * is spawned and killed as a child process constantly. A child that ignores
 * SIGTERM is a bad citizen: the supervisor waits out its grace period and then
 * SIGKILLs, which loses the courtesy session DELETE entirely.
 *
 * The hang this module removes: shutdown used to `await dispatcher.idle()` —
 * every dispatched request — while forwarded POSTs had no abort signal and no
 * deadline. One request the Net endpoint never answers (a hung gateway, a
 * dropped connection that never resets) therefore made stdin EOF and SIGTERM
 * both unable to reach the abort/close steps at all.
 *
 * Every step below is bounded, and the ordering intent of the original is
 * preserved: drain first so a healthy in-flight request still completes and
 * still gets its reply, abort only what is actually stuck, and treat the
 * session DELETE as a courtesy that may be skipped rather than a blocker.
 */

import { withDeadline } from "./deadline";

/** How long an already-accepted request may keep running once shutdown starts.
 * Long enough that a normal in-flight call finishes untouched; short enough
 * that a stuck one does not eat a supervisor's grace period. */
export const NET_MCP_STDIO_DRAIN_MS = 2_000;

/** Per-step bound for the teardown steps after the drain. */
export const NET_MCP_STDIO_TEARDOWN_MS = 500;

/** Last resort: if shutdown itself wedges, leave anyway. Must exceed the sum
 * of the bounds above (2000 + 3 x 500 = 3500) so it only fires on a real
 * defect, never on a slow-but-working teardown. */
export const NET_MCP_STDIO_HARD_EXIT_MS = 6_000;

export type NetMcpStdioShutdownDeps = {
  /** Serialising front half of the bridge. */
  dispatcher: { close(): void; idle(): Promise<void> };
  /** HTTP half of the bridge. */
  proxy: { abortRequests(): void; close(timeoutMs?: number): Promise<void> };
  /** Stdio half of the bridge. */
  transport: { close(): Promise<void> };
  onError?: (error: unknown) => void;
  /** Overridable so tests can assert promptness against a known budget. */
  drainMs?: number;
  teardownMs?: number;
};

/**
 * Build the bridge's idempotent shutdown.
 *
 * Repeat calls (EOF then SIGTERM, or SIGINT then SIGTERM) return the same
 * promise, so a second signal waits for the first teardown instead of racing
 * a half-closed transport.
 */
export function createNetMcpStdioShutdown(deps: NetMcpStdioShutdownDeps): () => Promise<void> {
  const drainMs = deps.drainMs ?? NET_MCP_STDIO_DRAIN_MS;
  const teardownMs = deps.teardownMs ?? NET_MCP_STDIO_TEARDOWN_MS;
  const onError = deps.onError ?? (() => {});
  let running: Promise<void> | null = null;

  const run = async (): Promise<void> => {
    // 1. Stop admitting work, so the set drained in step 2 cannot keep growing.
    deps.dispatcher.close();
    // 2. Bounded drain. The healthy path ends here: in-flight requests finish,
    //    their replies are written, and nothing below has anything to cancel.
    await deadline(deps.dispatcher.idle(), drainMs, onError);
    // 3. Whatever survived the drain is stuck. Cut its socket; each cancelled
    //    forward resolves into a correlated JSON-RPC error for the client.
    deps.proxy.abortRequests();
    // 4. Give those error replies a bounded moment to reach stdout before the
    //    transport that carries them is closed.
    await deadline(deps.dispatcher.idle(), teardownMs, onError);
    // 5. Courtesy DELETE of the Net session; bounded internally as well.
    await deadline(deps.proxy.close(teardownMs), teardownMs, onError);
    // 6. Release stdin/stdout.
    await deadline(deps.transport.close(), teardownMs, onError);
  };

  return () => (running ??= run());
}

/** Await `work` but never longer than `ms`; report, do not rethrow, failures.
 * A shutdown step that throws must not prevent the remaining steps. */
async function deadline(work: Promise<unknown>, ms: number, onError: (error: unknown) => void): Promise<void> {
  await withDeadline(work.then(() => undefined, onError), ms);
}
