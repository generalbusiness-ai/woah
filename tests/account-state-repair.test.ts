import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createWorld } from "../src/core/bootstrap";
import type { SerializedProperty } from "../src/core/repository";
import type { WooWorld } from "../src/core/world";
import { LocalSQLiteRepository } from "../src/server/sqlite-repository";
import {
  ACCOUNT_REPAIR_MEMBER_LIMIT,
} from "../src/core/account-state-repair";
import {
  parseLocalAccountRepairArgs,
  repairLocalAccountState
} from "../scripts/local-repair-account-state";
import { parseAccountRepairArgs } from "../scripts/net-repair-account-state";

async function provisionHuman(world: WooWorld, email: string): Promise<{ human: string; account: string }> {
  const started = await world.beginSignup(email, "password123");
  const verified = world.verifySignup(started.verification_token);
  const human = verified.actor as string;
  const account = world.propOrNull(human, "account") as string;
  world.setProp(account, "programmer_grant_quota", 10);
  return { human, account };
}

async function createProgrammer(world: WooWorld, human: string, name: string): Promise<string> {
  const frame = await world.directCall(
    `account-repair-create-${name}`,
    human,
    human,
    "create_agent",
    [name, "", true]
  );
  if (frame.op !== "result") throw new Error(JSON.stringify(frame));
  return (frame.result as Record<string, unknown>).actor_id as string;
}

class FailingRepairRepository extends LocalSQLiteRepository {
  failProperty: string | null = null;

  override saveProperty(id: string, prop: SerializedProperty): void {
    super.saveProperty(id, prop);
    if (prop.name === this.failProperty) {
      throw new Error(`injected repair write failure at ${id}.${prop.name}`);
    }
  }
}

describe("bounded historical account-state repair", () => {
  it("uses a real SQLite savepoint, persists the repair, and is idempotent after restart", async () => {
    const dir = mkdtempSync(join(tmpdir(), "woo-account-repair-"));
    const path = join(dir, "world.sqlite");
    try {
      const repo = new FailingRepairRepository(path);
      const world = createWorld({ repository: repo });
      const { human, account } = await provisionHuman(world, "account-repair@woo.dev");
      const agent = await createProgrammer(world, human, "retired-programmer");
      const keyId = world.propOrNull(agent, "api_key_id") as string;
      const actors = world.propOrNull(account, "actors") as string[];

      // Exact unambiguous residue: retirement is durable, but the auth
      // tombstone, programmer transition, current-key revocation, registry
      // dedupe, and both derived counters did not converge.
      world.setProp(agent, "retired_at", 1234);
      world.setProp(agent, "deactivated_at", null);
      world.setProp(account, "actors", [...actors, agent]);
      world.setProp(account, "agent_count", 9);
      world.setProp(account, "programmer_agent_count", 8);

      const dry = world.repairAccountState(account, { dryRun: true });
      expect(dry).toMatchObject({
        status: "would_apply",
        dry_run: true,
        conflicts: []
      });
      expect(dry.changed).toEqual(expect.arrayContaining([
        `property_cell:${agent}:deactivated_at`,
        `object_lineage:${agent}`,
        `property_cell:${agent}:features`,
        `property_cell:${agent}:api_keys`,
        `property_cell:${account}:actors`,
        `property_cell:${account}:agent_count`,
        `property_cell:${account}:programmer_agent_count`
      ]));
      expect(dry.patches).toEqual(expect.arrayContaining([
        {
          kind: "property",
          object: agent,
          name: "api_keys",
          reason: expect.any(String)
        }
      ]));
      expect(JSON.stringify(dry)).not.toContain(
        (world.propOrNull(agent, "api_keys") as Record<string, any>)[keyId].hash
      );
      expect(JSON.stringify(dry)).not.toContain(
        (world.propOrNull(agent, "api_keys") as Record<string, any>)[keyId].salt
      );
      expect(dry.patches.some((patch) => "before" in patch || "after" in patch)).toBe(false);
      expect((world.propOrNull(agent, "api_keys") as Record<string, any>)[keyId].revoked_at == null).toBe(true);

      // The lineage patch makes the agent a whole-object write, so fail on a
      // later account-property upsert. SQLite has already accepted the repaired
      // agent row and earlier account cells inside the SAVEPOINT; the injected
      // error must roll all of them back while withMutationSavepoint restores
      // the same in-memory journal.
      repo.failProperty = "agent_count";
      expect(() => world.repairAccountState(account, { apply: true })).toThrow(/injected repair write failure/);
      expect(world.propOrNull(agent, "deactivated_at")).toBeNull();
      expect(world.object(agent).flags.programmer).toBe(true);
      repo.close();

      const afterFailureRepo = new LocalSQLiteRepository(path);
      const afterFailure = createWorld({ repository: afterFailureRepo });
      expect(afterFailure.propOrNull(agent, "deactivated_at")).toBeNull();
      expect(afterFailure.object(agent).flags.programmer).toBe(true);
      expect(afterFailure.propOrNull(account, "agent_count")).toBe(9);

      // BEGIN IMMEDIATE alone cannot see that this live WooWorld owns newer
      // in-memory state. The CLI must refuse before loading or applying rather
      // than report success that `afterFailure` could overwrite later.
      expect(() => repairLocalAccountState([
        "--db", path,
        "--account", account,
        "--apply",
        "--review-token", dry.review_token!
      ], () => {})).toThrow(/requires a stopped server/);
      expect(afterFailure.propOrNull(agent, "deactivated_at")).toBeNull();
      expect(afterFailure.propOrNull(account, "agent_count")).toBe(9);
      afterFailureRepo.close();

      const cliDry = repairLocalAccountState([
        "--db", path,
        "--account", account
      ], () => {});
      expect(cliDry.review_token).toMatch(/^sha256:[0-9a-f]{64}$/);
      expect(() => repairLocalAccountState([
        "--db", path,
        "--account", account,
        "--apply",
        "--review-token", `sha256:${"0".repeat(64)}`
      ], () => {})).toThrow(/review token no longer matches/);
      const applied = repairLocalAccountState([
        "--db", path,
        "--account", account,
        "--apply",
        "--review-token", cliDry.review_token!
      ], () => {});
      expect(applied.status).toBe("applied");

      const verifyRepo = new LocalSQLiteRepository(path);
      const verify = createWorld({ repository: verifyRepo });
      expect(verify.propOrNull(agent, "deactivated_at")).toBe(1234);
      expect(verify.object(agent).flags.programmer).toBe(false);
      expect(verify.propOrNull(agent, "features")).not.toContain("$programmer");
      expect((verify.propOrNull(agent, "api_keys") as Record<string, any>)[keyId].revoked_at).toBe(1234);
      expect(verify.propOrNull(account, "actors")).toEqual([...new Set(actors)]);
      expect(verify.propOrNull(account, "agent_count")).toBe(0);
      expect(verify.propOrNull(account, "programmer_agent_count")).toBe(0);
      expect(verify.repairAccountState(account, { apply: true })).toMatchObject({
        status: "empty",
        changed: [],
        conflicts: []
      });
      verifyRepo.close();

      // The runnable local operator surface defaults to dry-run and opens the
      // explicit database path itself; no hidden global/default world exists.
      expect(repairLocalAccountState([
        "--db", path,
        "--account", account
      ], () => {})).toMatchObject({
        status: "empty",
        dry_run: true,
        changed: []
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps the local CLI value-free and requires an explicit apply", () => {
    expect(parseLocalAccountRepairArgs([
      "--db", "./world.sqlite",
      "--account", "account_2",
      "--candidate", "agent_9",
      "--candidate", "agent_9"
    ])).toMatchObject({
      account: "account_2",
      candidates: ["agent_9"],
      apply: false
    });
    expect(parseLocalAccountRepairArgs([
      "--db", "./world.sqlite",
      "--account", "account_2",
      "--apply",
      "--review-token", `sha256:${"a".repeat(64)}`
    ])).toMatchObject({ apply: true });
    expect(() => parseLocalAccountRepairArgs([
      "--db", "./world.sqlite",
      "--account", "account_2",
      "--apply"
    ])).toThrow(/requires --review-token/);
    expect(() => parseLocalAccountRepairArgs([
      "--db", "./world.sqlite",
      "--account", "account_2",
      "--dry-run",
      "--apply"
    ])).toThrow(/mutually exclusive/);
    expect(() => parseLocalAccountRepairArgs([
      "--db", "./world.sqlite",
      "--account", "account_2",
      "--agent-count", "4"
    ])).toThrow(/unknown account-repair argument/);

    const absentDir = mkdtempSync(join(tmpdir(), "woo-account-repair-absent-"));
    const absent = join(absentDir, "typo.sqlite");
    try {
      expect(() => repairLocalAccountState([
        "--db", absent,
        "--account", "account_2"
      ], () => {})).toThrow(/does not exist or is not a file/);
      expect(existsSync(absent)).toBe(false);
      const nested = join(absentDir, "must-not-create", "typo.sqlite");
      expect(() => repairLocalAccountState([
        "--db", nested,
        "--account", "account_2"
      ], () => {})).toThrow(/does not exist or is not a file/);
      expect(existsSync(join(absentDir, "must-not-create"))).toBe(false);

      const empty = join(absentDir, "empty.sqlite");
      new LocalSQLiteRepository(empty).close();
      const emptyBefore = readFileSync(empty);
      expect(() => repairLocalAccountState([
        "--db", empty,
        "--account", "account_2"
      ], () => {})).toThrow(/not a current persisted Woo world/);
      expect(readFileSync(empty)).toEqual(emptyBefore);

      const unrelated = join(absentDir, "unrelated.sqlite");
      const other = new DatabaseSync(unrelated);
      other.exec("CREATE TABLE precious (id INTEGER PRIMARY KEY, value TEXT NOT NULL)");
      other.prepare("INSERT INTO precious(value) VALUES (?)").run("keep me");
      other.close();
      const unrelatedBefore = readFileSync(unrelated);
      expect(() => repairLocalAccountState([
        "--db", unrelated,
        "--account", "account_2"
      ], () => {})).toThrow(/not a current persisted Woo world/);
      expect(readFileSync(unrelated)).toEqual(unrelatedBefore);
      const verifyOther = new DatabaseSync(unrelated, { readOnly: true });
      expect(verifyOther.prepare("SELECT value FROM precious").get()).toEqual({ value: "keep me" });
      verifyOther.close();

      const zero = join(absentDir, "zero.sqlite");
      writeFileSync(zero, new Uint8Array());
      const zeroBefore = readFileSync(zero);
      expect(() => repairLocalAccountState([
        "--db", zero,
        "--account", "account_2"
      ], () => {})).toThrow(/not a current persisted Woo world/);
      expect(readFileSync(zero)).toEqual(zeroBefore);
    } finally {
      rmSync(absentDir, { recursive: true, force: true });
    }
  });

  it("makes Net repair dry-run by default and requires explicit --apply", () => {
    const common = [
      "--base-url", "https://woo.test",
      "--authority-scope", "cluster:human_2",
      "--account", "account_2",
      "--human", "human_2"
    ];
    expect(parseAccountRepairArgs(common)).toMatchObject({ apply: false });
    expect(parseAccountRepairArgs([...common, "--candidate", "agent_4"]))
      .toMatchObject({ candidates: ["agent_4"] });
    expect(parseAccountRepairArgs([...common, "--dry-run"])).toMatchObject({ apply: false });
    expect(parseAccountRepairArgs([
      ...common,
      "--apply",
      "--review-token", `sha256:${"b".repeat(64)}`
    ])).toMatchObject({ apply: true });
    expect(() => parseAccountRepairArgs([...common, "--apply"]))
      .toThrow(/requires --review-token/);
    expect(() => parseAccountRepairArgs([...common, "--dry-run", "--apply"]))
      .toThrow(/mutually exclusive/);
    expect(() => parseAccountRepairArgs([...common, "--agent-count", "4"]))
      .toThrow(/unknown account-repair argument/);
  });

  it("reports an ordinary failed-create orphan as a conflict and never recycles or registers it", async () => {
    const world = createWorld();
    const { human, account } = await provisionHuman(world, "account-orphan@woo.dev");
    world.createObject({
      id: "failed_create_orphan",
      name: "Failed create orphan",
      parent: "$agent",
      owner: human,
      anchor: human,
      location: "$nowhere"
    });
    const actorsBefore = world.propOrNull(account, "actors");
    expect(() => world.repairAccountState(account, {})).toThrow(/exactly one/);
    expect(() => world.repairAccountState(account, {
      dryRun: true,
      candidateActors: Array.from({ length: 257 }, (_, index) => `candidate_${index}`)
    })).toThrow(/at most 256/);

    const result = world.repairAccountState(account, {
      apply: true,
      candidateActors: ["failed_create_orphan"]
    });

    expect(result).toMatchObject({
      status: "conflict",
      changed: [],
      patches: [],
      conflicts: [{
        code: "unregistered_agent_without_operation_evidence",
        object: "failed_create_orphan",
        field: "actors"
      }]
    });
    expect(world.objects.has("failed_create_orphan")).toBe(true);
    expect(world.propOrNull(account, "actors")).toEqual(actorsBefore);
    expect(world.repairAccountState(account, {
      dryRun: true,
      candidateActors: [human]
    })).toMatchObject({
      status: "conflict",
      conflicts: [{
        code: "explicit_candidate_is_not_account_actor",
        object: human
      }]
    });
  });

  it("refuses oversized authority sources before constructing the candidate set", async () => {
    const world = createWorld();
    const { account } = await provisionHuman(world, "account-bounds@woo.dev");
    const oversized = Array.from(
      { length: ACCOUNT_REPAIR_MEMBER_LIMIT + 1 },
      (_, index) => `actor_${index}`
    );

    world.setProp(account, "actors", oversized);
    expect(() => world.repairAccountState(account, { dryRun: true }))
      .toThrow(/authority exceeds 1024 members/);

    world.setProp(account, "actors", []);
    world.setProp(
      account,
      "operator_provisioned_agents",
      Object.fromEntries(oversized.map((actor, index) => [`provision_${index}`, actor]))
    );
    expect(() => world.repairAccountState(account, { dryRun: true }))
      .toThrow(/authority exceeds 1024 members/);
  });

  it("uses mutual AP11 ledger evidence to finish an unregistered operator agent", async () => {
    const world = createWorld();
    const { human, account } = await provisionHuman(world, "account-ledger@woo.dev");
    world.createObject({
      id: "operator_half_agent",
      name: "Operator half agent",
      parent: "$agent",
      owner: human,
      anchor: human,
      location: "$nowhere"
    });
    world.setProp("operator_half_agent", "provision_id", "repair-ledger-1");
    world.setProp(account, "operator_provisioned_agents", {
      "repair-ledger-1": "operator_half_agent"
    });

    const applied = world.repairAccountState(account, { apply: true });

    expect(applied.status).toBe("applied");
    expect(world.propOrNull(account, "actors")).toContain("operator_half_agent");
    expect(world.propOrNull(account, "agent_count")).toBe(1);
    expect(world.propOrNull(account, "programmer_agent_count")).toBe(1);
    expect(world.object("operator_half_agent").flags).toMatchObject({
      programmer: true,
      wizard: true
    });
    expect(world.propOrNull("operator_half_agent", "features")).toContain("$programmer");
    expect(world.repairAccountState(account, { apply: true }).status).toBe("empty");
  });

  it("never treats a stale AP11 ledger entry as authority to undo an explicit demotion", async () => {
    const world = createWorld();
    const { human, account } = await provisionHuman(world, "account-demoted-ledger@woo.dev");
    world.createObject({
      id: "demoted_operator_agent",
      name: "Explicitly demoted operator",
      parent: "$agent",
      owner: human,
      anchor: human,
      location: "$nowhere",
      // AP11 sets wizard only after programmer promotion. Demotion clears the
      // programmer bit and surface but deliberately preserves wizard.
      flags: { wizard: true, programmer: false }
    });
    world.setProp("demoted_operator_agent", "provision_id", "demoted-ledger-1");
    world.setProp("demoted_operator_agent", "features", []);
    world.createObject({
      id: "fully_stripped_operator_agent",
      name: "Fully stripped operator",
      parent: "$agent",
      owner: human,
      anchor: human,
      location: "$nowhere",
      flags: { wizard: false, programmer: false }
    });
    world.setProp("fully_stripped_operator_agent", "provision_id", "stripped-ledger-1");
    world.setProp("fully_stripped_operator_agent", "features", []);
    world.createObject({
      id: "suspended_operator_agent",
      name: "Suspended operator",
      parent: "$agent",
      owner: human,
      anchor: human,
      location: "$nowhere"
    });
    world.setProp("suspended_operator_agent", "provision_id", "suspended-ledger-1");
    world.setProp("suspended_operator_agent", "deactivated_at", 42);
    world.setProp(account, "operator_provisioned_agents", {
      "demoted-ledger-1": "demoted_operator_agent",
      "stripped-ledger-1": "fully_stripped_operator_agent",
      "suspended-ledger-1": "suspended_operator_agent"
    });
    world.setProp(account, "actors", [
      human,
      "demoted_operator_agent",
      "fully_stripped_operator_agent",
      "suspended_operator_agent"
    ]);
    world.setProp(account, "agent_count", 3);
    world.setProp(account, "programmer_agent_count", 0);

    const before = world.exportWorld();
    const result = world.repairAccountState(account, { apply: true });

    expect(result).toMatchObject({
      status: "conflict",
      changed: [],
      patches: []
    });
    expect(result.conflicts).toEqual(expect.arrayContaining([expect.objectContaining({
      code: "operator_agent_explicitly_demoted",
      object: "demoted_operator_agent",
      field: "object_lineage"
    }), expect.objectContaining({
      code: "operator_agent_programmer_intent_ambiguous",
      object: "fully_stripped_operator_agent",
      field: "object_lineage"
    }), expect.objectContaining({
      code: "operator_agent_deactivated",
      object: "suspended_operator_agent",
      field: "deactivated_at"
    })]));
    expect(world.exportWorld()).toEqual(before);
    expect(world.object("demoted_operator_agent").flags).toMatchObject({
      wizard: true,
      programmer: false
    });
    expect(world.propOrNull("demoted_operator_agent", "features")).toEqual([]);
    expect(world.object("fully_stripped_operator_agent").flags).toMatchObject({
      wizard: false,
      programmer: false
    });
    expect(world.propOrNull("fully_stripped_operator_agent", "features")).toEqual([]);
    expect(world.propOrNull(account, "programmer_agent_count")).toBe(0);
  });

  it("persists a lineage-only repair before returning applied", async () => {
    const dir = mkdtempSync(join(tmpdir(), "woo-account-lineage-repair-"));
    const path = join(dir, "world.sqlite");
    try {
      const repo = new LocalSQLiteRepository(path);
      const world = createWorld({ repository: repo });
      const { human, account } = await provisionHuman(world, "lineage-only@woo.dev");
      world.createObject({
        id: "lineage_only_agent",
        name: "Lineage only",
        parent: "$agent",
        owner: human,
        anchor: human,
        location: "$nowhere"
      });
      world.setProp("lineage_only_agent", "provision_id", "lineage-only-provision");
      world.setProp("lineage_only_agent", "features", ["$programmer"]);
      world.setProp(account, "operator_provisioned_agents", {
        "lineage-only-provision": "lineage_only_agent"
      });
      world.setProp(account, "actors", [human, "lineage_only_agent"]);
      world.setProp(account, "agent_count", 1);
      world.setProp(account, "programmer_agent_count", 1);

      const applied = world.repairAccountState(account, { apply: true });
      expect(applied.status).toBe("applied");
      expect(applied.changed).toEqual(["object_lineage:lineage_only_agent"]);
      repo.close();

      const reopenedRepo = new LocalSQLiteRepository(path);
      const reopened = createWorld({ repository: reopenedRepo });
      expect(reopened.object("lineage_only_agent").flags).toMatchObject({
        programmer: true,
        wizard: true
      });
      expect(reopened.repairAccountState(account, { apply: true }).status).toBe("empty");
      reopenedRepo.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("holds the SQLite writer lock across the repair snapshot boundary", () => {
    const dir = mkdtempSync(join(tmpdir(), "woo-account-repair-lock-"));
    const path = join(dir, "world.sqlite");
    try {
      const first = new LocalSQLiteRepository(path);
      createWorld({ repository: first });
      const second = new LocalSQLiteRepository(path);
      first.transaction(() => {
        expect(first.load()).not.toBeNull();
        expect(() => second.transaction(() => {})).toThrow(/locked/i);
      });
      expect(() => second.transaction(() => {})).not.toThrow();
      second.close();
      first.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reclaims dead shared owners but requires explicit recovery of an interrupted exclusive repair", () => {
    const dir = mkdtempSync(join(tmpdir(), "woo-account-repair-stale-lease-"));
    const path = join(dir, "world.sqlite");
    const access = `${path}.woo-access`;
    try {
      const seed = new LocalSQLiteRepository(path);
      createWorld({ repository: seed });
      seed.close();

      mkdirSync(access);
      writeFileSync(
        join(access, "owner-2147483647-dead"),
        JSON.stringify({ pid: 2147483647, mode: "shared" }),
        { mode: 0o600 }
      );
      const afterDeadOwner = new LocalSQLiteRepository(path, {
        exclusiveWorldAccess: true
      });
      expect(existsSync(join(access, "owner-2147483647-dead"))).toBe(false);
      afterDeadOwner.close();

      mkdirSync(access);
      const interrupted = join(access, "exclusive");
      writeFileSync(
        interrupted,
        JSON.stringify({ pid: 2147483647, mode: "exclusive" }),
        { mode: 0o600 }
      );
      expect(() => new LocalSQLiteRepository(path)).toThrow(
        /remove .*exclusive only after verifying its owner is stopped/
      );
      // The constructor refuses without guessing. This explicit deletion
      // represents the operator verifying the recorded process is gone.
      rmSync(interrupted);
      const recovered = new LocalSQLiteRepository(path);
      recovered.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
