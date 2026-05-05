import { defineConfig } from "vitest/config";

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
    pool: "threads"
  }
});
