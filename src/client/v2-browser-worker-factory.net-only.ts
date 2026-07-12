/** Net-only build replacement: there is no legacy browser transport. */
export function createV2BrowserWorker(): Worker | undefined {
  return undefined;
}
