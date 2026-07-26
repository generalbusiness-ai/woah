import { configDefaults, defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

const TEST_INCLUDE = ["tests/**/*.test.ts"];
const TEST_EXCLUDE = [...configDefaults.exclude, "**/.claude/**"];

// Test files that rewrite the module registry — `vi.resetModules()`,
// `vi.doMock()`, `vi.mock()`. Under the shared-registry default those calls
// reach every other file running in the same worker, and which files those are
// varies per run with thread scheduling, so the resulting breakage is
// intermittent and lands in whichever innocent file happened to be a
// neighbour. Any new file that mocks a module must be listed here.
// Enforced by scripts/guard-module-mocking-tests.mjs.
const MODULE_MOCKING_TESTS = ["tests/catalogs.test.ts"];

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
    // include/exclude deliberately live on the projects below, never here:
    // `extends: true` CONCATENATES arrays rather than replacing them, so a root
    // `include` would leak into the isolated project and make it run the whole
    // suite a second time.
    // The Worker and browser shims are CPU-heavy under the deploy gate. Keep
    // enough parallelism for coverage while avoiding scheduler stalls that make
    // otherwise short integration tests hit their wall-clock timeout.
    pool: "threads",
    maxWorkers: 4,
    isolate: false,
    testTimeout: 60_000,
    // Two projects, differing only in isolation. `isolate: false` shares one
    // module registry across every file a worker runs, which is where the speed
    // comes from — but it also means a file that rewrites the registry rewrites
    // it for its neighbours. MODULE_MOCKING_TESTS runs isolated so that cannot
    // happen; everything else keeps the fast shared path.
    // Measured over the full sweep (139 files / 1726 tests, 2026-07-26):
    // all-shared 76.5s, this split 86.7s, all-isolated 104.3s. The split buys
    // the isolation that matters for a third of the cost of isolating
    // everything.
    // `extends: true` inherits root vite config (notably resolve.alias) and the
    // test defaults above, so each project overrides only what it names.
    projects: [
      {
        extends: true,
        test: {
          name: "isolated",
          include: MODULE_MOCKING_TESTS,
          exclude: TEST_EXCLUDE,
          isolate: true
        }
      },
      {
        extends: true,
        test: {
          name: "shared",
          include: TEST_INCLUDE,
          exclude: [...TEST_EXCLUDE, ...MODULE_MOCKING_TESTS],
          isolate: false
        }
      }
    ]
  }
});
