import { configDefaults, defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const netOnly = process.env.WOO_NET_ONLY_BUILD === "1";

export default defineConfig({
  root: ".",
  publicDir: "public",
  // The net-only deletion gate compiles the same SPA entry with its v2 Worker
  // construction erased. Dual-stack builds leave the flag false.
  define: {
    __WOO_NET_ONLY__: JSON.stringify(netOnly)
  },
  resolve: {
    alias: {
      "#v2-browser-worker-factory": fileURLToPath(new URL(
        netOnly ? "./src/client/v2-browser-worker-factory.net-only.ts" : "./src/client/v2-browser-worker-factory.ts",
        import.meta.url
      ))
    }
  },
  build: {
    outDir: "dist",
    emptyOutDir: true
  },
  server: {
    port: 5173
  },
  test: {
    include: ["tests/**/*.test.ts"],
    exclude: [...configDefaults.exclude, "**/.claude/**"],
    // The Worker and browser shims are CPU-heavy under the deploy gate. Keep
    // enough parallelism for coverage while avoiding scheduler stalls that make
    // otherwise short integration tests hit their wall-clock timeout.
    pool: "threads",
    maxWorkers: 4,
    isolate: false,
    testTimeout: 60_000
  }
});
