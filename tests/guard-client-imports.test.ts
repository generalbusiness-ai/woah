import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const guardScript = resolve("scripts/guard-client-imports.mjs");
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function makeProject(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "woo-client-imports-"));
  roots.push(root);
  for (const [path, source] of Object.entries(files)) {
    const target = join(root, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, source);
  }
  if (!files["src/client/v2-browser-worker.ts"]) writeFileSync(join(root, "src/client/v2-browser-worker.ts"), "");
  return root;
}

function runGuard(root: string) {
  return spawnSync(process.execPath, [guardScript], { cwd: root, encoding: "utf8" });
}

describe("guard-client-imports", () => {
  it("passes when the reachable client graph has no Node builtins", () => {
    const root = makeProject({
      "src/client/main.ts": "import { ok } from './safe';\nconsole.log(ok);\n",
      "src/client/safe.ts": "export const ok = true;\n"
    });

    const result = runGuard(root);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("guard-client-imports: ok");
  });

  it("rejects bare Node builtin imports reachable from the client graph", () => {
    const root = makeProject({
      "src/client/main.ts": "import '../core/uses-node';\n",
      "src/core/uses-node.ts": "import { createHash } from 'crypto';\nexport const hash = createHash;\n"
    });

    const result = runGuard(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('src/core/uses-node.ts:1: import from "crypto"');
  });

  it("rejects node-prefixed builtin imports reachable from the client graph", () => {
    const root = makeProject({
      "src/client/main.ts": "import '../core/uses-node';\n",
      "src/core/uses-node.ts": "import { createHash } from 'node:crypto';\nexport const hash = createHash;\n"
    });

    const result = runGuard(root);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain('src/core/uses-node.ts:1: import from "node:crypto"');
  });
});
