import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  root: ".",
  publicDir: "public",
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
