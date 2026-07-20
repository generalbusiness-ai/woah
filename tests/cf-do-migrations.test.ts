import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
// @ts-ignore - the deploy helper is a plain Node ESM script.
import { analyzeDoMigrations, syncWranglerDoMigrations } from "../scripts/sync-wrangler-do-migrations.mjs";

const currentWrangler = readFileSync(new URL("../wrangler.toml", import.meta.url), "utf8");

describe("Cloudflare Durable Object migration management", () => {
  it("verifies current Wrangler bindings against the applied class history", () => {
    const analysis = analyzeDoMigrations(currentWrangler);

    expect(analysis.ok).toBe(true);
    // The v2 classes (PersistentObjectDO, DirectoryDO, CommitScopeDO) are
    // retired: unbound and reclaimed by the cf-do-0005 deleted_classes
    // migration. Only the net classes remain bound and active.
    expect(analysis.boundClasses).toEqual(["NetGatewayDO", "NetScopeDO"]);
    expect(analysis.activeClasses).toEqual(["NetGatewayDO", "NetScopeDO"]);
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
    // cf-do-0004/0005/0006 are taken; the next free append tag is 0007.
    expect(result.text).toContain('tag = "cf-do-0007"');
    expect(result.text).toContain('new_sqlite_classes = [ "AuditDO" ]');
    expect(analyzeDoMigrations(result.text).ok).toBe(true);
  });

  it("refuses destructive delete migrations unless explicitly allowed", () => {
    const withoutScopeBinding = currentWrangler.replace(/\n\[\[durable_objects\.bindings\]\]\nname = "SCOPE_NET"\nclass_name = "NetScopeDO"\n/, "\n");

    const blocked = syncWranglerDoMigrations(withoutScopeBinding);
    expect(blocked.changed).toBe(false);
    expect(blocked.errors).toEqual(["unbound Durable Object classes would need a delete migration: NetScopeDO"]);

    const allowed = syncWranglerDoMigrations(withoutScopeBinding, { allowDelete: true });
    expect(allowed.changed).toBe(true);
    expect(allowed.text).toContain('deleted_classes = [ "NetScopeDO" ]');
    expect(analyzeDoMigrations(allowed.text).ok).toBe(true);
  });
});
