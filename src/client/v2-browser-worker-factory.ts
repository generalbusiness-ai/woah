/** Dual-stack factory. The net-only Vite profile aliases this entire module to
 * the stub, preventing the worker URL from entering that build graph. */
export function createV2BrowserWorker(): Worker {
  return new Worker(new URL("./v2-browser-worker.ts", import.meta.url), { type: "module" });
}
