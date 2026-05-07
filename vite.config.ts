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
    // The threads pool avoids Vitest fork/birpc RPC timeouts; no single-worker
    // cap is needed now that per-test timeout is high enough for heavy files.
    pool: "threads",
    isolate: false,
    testTimeout: 30_000
  }
});
