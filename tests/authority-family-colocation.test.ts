// The local-boot repair that co-locates legacy anchorless authority families
// (account + owned agents) into the human's cluster, so a promote/demote quota
// transition stays single-scope. New provisioning already anchors them; this
// repairs families provisioned before authority-root anchoring landed. Support
// boundary: local-boot / single-host only (Net placement comes from cutover).
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createWorld, createWorldFromSerialized } from "../src/core/bootstrap";
import { runHostScopedDataMigrations } from "../src/core/local-catalogs";
import { LocalSQLiteRepository } from "../src/server/sqlite-repository";

async function legacyFamily() {
  const world = createWorld();
  const start = await world.beginSignup("legacy@example.com", "password123");
  const human = world.verifySignup(start.verification_token).actor as string;
  const account = world.propOrNull(human, "account") as string;
  world.setProp(account, "programmer_grant_quota", 10);
  const prov = (await world.directCall("prov", human, human, "create_agent", ["Bot", "", false])) as unknown as {
    result: { actor_id: string };
  };
  const agent = prov.result.actor_id;
  // Simulate a PRE-anchoring family: strip the anchors new provisioning sets.
  world.migrationSetObjectAnchor(account, null);
  world.migrationSetObjectAnchor(agent, null);
  return { world, human, account, agent };
}

describe("authority-family co-location repair (local-boot)", () => {
  it("anchors a legacy anchorless account and its owned agents to the human root", async () => {
    const { world, human, account, agent } = await legacyFamily();
    expect(world.object(account).anchor).toBeNull();
    expect(world.object(agent).anchor).toBeNull();

    const repaired = world.repairAuthorityFamilyColocation();
    expect(repaired).toBe(2); // the account and the one agent
    expect(world.object(account).anchor).toBe(human);
    expect(world.object(agent).anchor).toBe(human);
  });

  it("is idempotent: a second run re-anchors nothing", async () => {
    const { world } = await legacyFamily();
    expect(world.repairAuthorityFamilyColocation()).toBe(2);
    expect(world.repairAuthorityFamilyColocation()).toBe(0);
    expect(world.repairAuthorityFamilyColocation()).toBe(0);
  });

  it("leaves an already-anchored family untouched (new provisioning path)", async () => {
    const world = createWorld();
    const start = await world.beginSignup("fresh@example.com", "password123");
    const human = world.verifySignup(start.verification_token).actor as string;
    const account = world.propOrNull(human, "account") as string;
    world.setProp(account, "programmer_grant_quota", 10);
    const prov = (await world.directCall("prov", human, human, "create_agent", ["Bot", "", false])) as unknown as {
      result: { actor_id: string };
    };
    // New provisioning already anchored both — nothing to repair.
    expect(world.object(account).anchor).toBe(human);
    expect(world.object(prov.result.actor_id).anchor).toBe(human);
    expect(world.repairAuthorityFamilyColocation()).toBe(0);
  });

  it("runs once through the host-scoped migration ledger", async () => {
    const { world, human, account, agent } = await legacyFamily();
    // First cold-init pass repairs and records the ledger entry.
    runHostScopedDataMigrations(world);
    expect(world.object(account).anchor).toBe(human);
    expect(world.object(agent).anchor).toBe(human);
    const ledger = world.propOrNull("$system", "applied_migrations") as string[];
    expect(ledger).toContain("2026-07-25-authority-family-colocation");

    // A re-introduced legacy family is NOT re-walked once the ledger is applied
    // (run-once semantics; the direct repair remains available for an explicit
    // re-repair). This documents the ledger gate.
    world.migrationSetObjectAnchor(account, null);
    runHostScopedDataMigrations(world);
    expect(world.object(account).anchor).toBeNull();
  });

  it("persists across a local-SQLite reboot and does not re-run (finding #6)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "woo-colocation-"));
    const path = join(dir, "world.sqlite");
    try {
      // Seed a LEGACY anchorless family and persist it to SQLite.
      const { world, human, account, agent } = await legacyFamily();
      new LocalSQLiteRepository(path).save(world.exportWorld());

      // Reboot 1 (cold-init): load from SQLite, run the migration; the repository
      // auto-persists the re-anchored family.
      const repo1 = new LocalSQLiteRepository(path);
      const boot1 = createWorldFromSerialized(repo1.load()!, { repository: repo1 });
      runHostScopedDataMigrations(boot1);
      expect(boot1.object(account).anchor).toBe(human);
      expect(boot1.object(agent).anchor).toBe(human);

      // Reboot 2: a fresh load from the SAME file proves the repair was durable
      // (anchors persisted) AND the ledger recorded it.
      const repo2 = new LocalSQLiteRepository(path);
      const seed2 = repo2.load()!;
      const boot2 = createWorldFromSerialized(seed2, { repository: repo2 });
      expect(boot2.object(account).anchor, "anchor did not persist to SQLite").toBe(human);
      expect(boot2.object(agent).anchor).toBe(human);
      expect(boot2.propOrNull("$system", "applied_migrations") as string[]).toContain("2026-07-25-authority-family-colocation");

      // Re-running on reboot 2 is a no-op (idempotent + ledger-gated): nothing changes.
      runHostScopedDataMigrations(boot2);
      expect(boot2.object(account).anchor).toBe(human);
      expect(boot2.repairAuthorityFamilyColocation()).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
