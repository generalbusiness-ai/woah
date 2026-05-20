import { describe, expect, it } from "vitest";
import type { ObjectRepository, ParkedTaskRecord, SerializedObject } from "../src/core/repository";
import type { ErrorValue, Message, VerbDef, WooValue } from "../src/core/types";
import { LocalSQLiteRepository } from "../src/server/sqlite-repository";

type RepoHandle = {
  repo: ObjectRepository;
  cleanup: () => void;
};

// SQLite is the only repository implementation tested here. None of these
// cases restart, so `:memory:` keeps the cleanup loop trivial.
const backends: { name: string; make: () => RepoHandle }[] = [
  {
    name: "sqlite",
    make: () => {
      const repo = new LocalSQLiteRepository(":memory:");
      return {
        repo,
        cleanup: () => {
          repo.close();
        }
      };
    }
  }
];

function object(id: string): SerializedObject {
  return {
    id,
    name: id,
    parent: "$thing",
    owner: "$wiz",
    location: null,
    anchor: id,
    flags: {},
    created: 1,
    modified: 1,
    propertyDefs: [],
    properties: [],
    propertyVersions: [],
    verbs: [],
    children: [],
    contents: [],
    eventSchemas: []
  };
}

function nativeVerb(name: string): VerbDef {
  return {
    kind: "native",
    name,
    aliases: [],
    owner: "$wiz",
    perms: "rxd",
    arg_spec: {},
    source: `verb :${name}() rxd {}`,
    source_hash: `hash-${name}`,
    version: 1,
    line_map: {},
    native: "player_on_disfunc"
  };
}

function msg(actor: string, target: string, verb: string, args: WooValue[] = []): Message {
  return { actor, target, verb, args };
}

function task(id: string, overrides: Partial<ParkedTaskRecord> = {}): ParkedTaskRecord {
  return {
    id,
    parked_on: "space",
    state: "suspended",
    resume_at: 100,
    awaiting_player: null,
    correlation_id: null,
    serialized: { kind: "test" },
    created: 1,
    origin: "space",
    ...overrides
  };
}

describe.each(backends)("ObjectRepository contract: $name", ({ make }) => {
  it("round-trips object slices at object/property/verb granularity", async () => {
    const { repo, cleanup } = make();
    try {
      repo.saveObject(object("space"));
      repo.saveObject(object("child"));
      repo.saveProperty("space", {
        name: "title",
        def: { name: "title", defaultValue: "", owner: "$wiz", perms: "rwd", version: 1 },
        value: "hello",
        version: 2
      });
      repo.saveVerb("space", nativeVerb("look"));
      repo.addChild("space", "child");
      repo.addContent("space", "child");
      repo.saveEventSchema("space", "changed", { value: "num" });

      expect(repo.listHostedObjects()).toEqual(["child", "space"]);
      expect(repo.loadObject("space")?.properties).toEqual([["title", "hello"]]);
      expect(repo.loadProperty("space", "title")?.version).toBe(2);
      expect(repo.listPropertyNames("space")).toEqual(["title"]);
      expect(repo.loadVerb("space", "look")?.name).toBe("look");
      expect(repo.listVerbNames("space")).toEqual(["look"]);
      expect(repo.loadChildren("space")).toEqual(["child"]);
      expect(repo.loadContents("space")).toEqual(["child"]);
      expect(repo.loadEventSchemas("space")).toEqual([["changed", { value: "num" }]]);

      repo.deleteProperty("space", "title");
      repo.deleteVerb("space", "look");
      repo.removeChild("space", "child");
      repo.removeContent("space", "child");
      repo.deleteEventSchema("space", "changed");
      expect(repo.listPropertyNames("space")).toEqual([]);
      expect(repo.listVerbNames("space")).toEqual([]);
      expect(repo.loadChildren("space")).toEqual([]);
      expect(repo.loadContents("space")).toEqual([]);
      expect(repo.loadEventSchemas("space")).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("preserves ordered duplicate verb slots", async () => {
    const { repo, cleanup } = make();
    try {
      repo.saveObject(object("space"));
      repo.saveVerb("space", { ...nativeVerb("same"), slot: 1, source_hash: "first" });
      repo.saveVerb("space", { ...nativeVerb("same"), aliases: ["second"], slot: 2, source_hash: "second" });

      expect(repo.listVerbNames("space")).toEqual(["same", "same"]);
      expect(repo.loadVerb("space", "same")?.source_hash).toBe("first");
      expect(repo.loadObject("space")?.verbs.map((verb) => [verb.name, verb.slot, verb.source_hash])).toEqual([
        ["same", 1, "first"],
        ["same", 2, "second"]
      ]);
    } finally {
      cleanup();
    }
  });

  it("uses a savepoint to roll back behavior while preserving the accepted log row", async () => {
    const { repo, cleanup } = make();
    try {
      repo.saveObject(object("space"));
      const error: ErrorValue = { code: "E_TEST", message: "rolled back" };

      repo.transaction(() => {
        const { seq } = repo.appendLog("space", "$actor", msg("$actor", "space", "fail"));
        expect(seq).toBe(1);
        expect(() =>
          repo.savepoint(() => {
            repo.saveProperty("space", { name: "temporary", def: null, value: "discard", version: 1 });
            throw error;
          })
        ).toThrow();
        expect(repo.loadProperty("space", "temporary")).toBeNull();
        repo.recordLogOutcome("space", seq, false, [{ type: "$error", code: "E_TEST" }], error);
      });

      expect(repo.currentSeq("space")).toBe(2);
      const read = repo.readLog("space", 1, 10);
      expect(read.messages).toMatchObject([{ seq: 1, applied_ok: false, observations: [{ type: "$error", code: "E_TEST" }], error }]);
      expect(read.next_seq).toBe(2);
    } finally {
      cleanup();
    }
  });

  it("rejects a transaction that leaves a pending log outcome", async () => {
    const { repo, cleanup } = make();
    try {
      repo.saveObject(object("space"));
      expect(() =>
        repo.transaction(() => {
          repo.appendLog("space", "$actor", msg("$actor", "space", "unfinished"));
        })
      ).toThrow(/pending log outcome/);
      expect(repo.currentSeq("space")).toBe(1);
      expect(repo.readLog("space", 1, 10).messages).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("rejects divergent attempts to record a log outcome twice", async () => {
    const { repo, cleanup } = make();
    try {
      repo.saveObject(object("space"));
      const error: ErrorValue = { code: "E_TEST", message: "second outcome" };

      repo.transaction(() => {
        const { seq } = repo.appendLog("space", "$actor", msg("$actor", "space", "finish"));
        repo.recordLogOutcome("space", seq, true, [{ type: "finished" }]);
        expect(() => repo.recordLogOutcome("space", seq, false, [], error)).toThrow(/log outcome already recorded/);
      });

      expect(repo.readLog("space", 1, 10).messages).toMatchObject([{ seq: 1, applied_ok: true, observations: [{ type: "finished" }] }]);
    } finally {
      cleanup();
    }
  });

  it("persists sessions, tasks, snapshots, counters, and meta records", async () => {
    const { repo, cleanup } = make();
    try {
      repo.saveObject(object("space"));
      repo.saveSession({ id: "s1", actor: "$actor", started: 1, expiresAt: 50, lastDetachAt: null, tokenClass: "guest" });
      repo.saveSession({ id: "s2", actor: "$actor", started: 1, expiresAt: 500, lastDetachAt: null, tokenClass: "guest" });
      expect(repo.loadSession("s1")?.actor).toBe("$actor");
      expect(repo.loadExpiredSessions(100).map((session) => session.id)).toEqual(["s1"]);

      repo.saveTask(task("t1", { resume_at: 10 }));
      repo.saveTask(task("t2", { state: "awaiting_read", resume_at: null, awaiting_player: "$actor", created: 2 }));
      expect(repo.earliestResumeAt()).toBe(10);
      expect(repo.loadDueTasks(20).map((item) => item.id)).toEqual(["t1"]);
      expect(repo.loadAwaitingReadTasks("$actor").map((item) => item.id)).toEqual(["t2"]);
      repo.deleteTask("t1");
      expect(repo.loadTask("t1")).toBeNull();

      repo.saveSpaceSnapshot({ space_id: "space", seq: 1, ts: 1, state: { ok: true }, hash: "h1" });
      expect(repo.loadLatestSnapshot("space")?.hash).toBe("h1");
      expect(repo.nextCounter("ids")).toBe(1);
      expect(repo.nextCounter("ids")).toBe(2);
      repo.saveMeta("bootstrapped", "true");
      expect(repo.loadMeta("bootstrapped")).toBe("true");
    } finally {
      cleanup();
    }
  });
});
