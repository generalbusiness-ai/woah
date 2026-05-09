import { defineConfig } from "vitest/config";

// The repo root vite.config.ts declares `include: ["tests/**/*.test.ts"]`
// (plural) and excludes `.claude/`. The plug keeps its tests under `test/`
// (singular), so `npm test` inside this package needs a local override.
export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"]
  }
});
