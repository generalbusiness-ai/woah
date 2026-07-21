import { configDefaults, defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

export default defineConfig({
  root: ".",
  publicDir: "public",
  // Net-only is the ONLY build since the classic/v2 stack deletion (NC9):
  // the dual-stack factory file no longer exists, so the former
  // WOO_NET_ONLY_BUILD flag has nothing to select between. The flag is
  // ignored; every build compiles the SPA with v2 Worker construction
  // erased.
  define: {
    __WOO_NET_ONLY__: JSON.stringify(true)
  },
  resolve: {
    alias: {
      "#v2-browser-worker-factory": fileURLToPath(new URL(
        "./src/client/v2-browser-worker-factory.net-only.ts",
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
