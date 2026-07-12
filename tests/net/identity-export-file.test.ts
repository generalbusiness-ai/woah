import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeIdentityExportFile } from "../../scripts/identity-export";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("identity export artifact", () => {
  it("writes new and existing targets with owner-only permissions", () => {
    const dir = mkdtempSync(join(tmpdir(), "woo-identity-export-"));
    dirs.push(dir);
    const path = join(dir, "identity-export.json");

    writeFileSync(path, "old", { mode: 0o644 });
    writeIdentityExportFile(path, { accounts: { alice: { password_hash: "secret-hash" } } });

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ accounts: { alice: { password_hash: "secret-hash" } } });
  });
});
