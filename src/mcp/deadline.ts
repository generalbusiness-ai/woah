/**
 * One shared wall-clock bound for the stdio bridge's shutdown steps.
 *
 * Shutdown is the only place this belongs: on a teardown path a step that
 * never finishes is strictly worse than a step that is skipped, because the
 * process is on a supervisor's grace-period clock. Ordinary request paths must
 * not use it — `woo_wait` legitimately blocks for tens of seconds.
 */

/** Resolve when `work` settles or `ms` elapses, whichever comes first.
 * Rejections are swallowed; callers that care attach their own handler first. */
export async function withDeadline(work: Promise<unknown> | undefined, ms: number): Promise<void> {
  if (!work) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, ms);
    // Node keeps the event loop alive for pending timers. A shutdown deadline
    // must never be the last handle holding the process open, so unref it.
    // `unref` is absent on workerd/browser timers, hence the optional call.
    (timer as { unref?: () => void }).unref?.();
  });
  try {
    await Promise.race([work.then(() => undefined, () => undefined), expiry]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
