import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-ignore - the deploy helper is a plain Node ESM script.
import { analyzeDoMigrations, syncWranglerDoMigrations } from "../scripts/sync-wrangler-do-migrations.mjs";

const currentWrangler = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");

describe("Cloudflare Durable Object migration management", () => {
  it("verifies current Wrangler bindings against the applied class history", () => {
    const analysis = analyzeDoMigrations(currentWrangler);

    expect(analysis.ok).toBe(true);
    expect(analysis.boundClasses).toEqual(["DirectoryDO", "PersistentObjectDO"]);
    expect(analysis.activeClasses).toEqual(["DirectoryDO", "PersistentObjectDO"]);
    expect(analysis.duplicateTags).toEqual([]);
  });

  it("appends a deterministic create migration for newly-bound classes", () => {
    const withBinding = `${currentWrangler}

[[durable_objects.bindings]]
name = "AUDIT"
class_name = "AuditDO"
`;

    const result = syncWranglerDoMigrations(withBinding);

    expect(result.changed).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.text).toContain('tag = "cf-do-0006"');
    expect(result.text).toContain('new_sqlite_classes = [ "AuditDO" ]');
    expect(analyzeDoMigrations(result.text).ok).toBe(true);
  });

  it("refuses destructive delete migrations unless explicitly allowed", () => {
    const withoutDirectoryBinding = currentWrangler.replace(/\n\[\[durable_objects\.bindings\]\]\nname = "DIRECTORY"\nclass_name = "DirectoryDO"\n/, "\n");

    const blocked = syncWranglerDoMigrations(withoutDirectoryBinding);
    expect(blocked.changed).toBe(false);
    expect(blocked.errors).toEqual(["unbound Durable Object classes would need a delete migration: DirectoryDO"]);

    const allowed = syncWranglerDoMigrations(withoutDirectoryBinding, { allowDelete: true });
    expect(allowed.changed).toBe(true);
    expect(allowed.text).toContain('deleted_classes = [ "DirectoryDO" ]');
    expect(analyzeDoMigrations(allowed.text).ok).toBe(true);
  });
});
