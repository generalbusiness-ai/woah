// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";

import {
  createWooClientFramework,
  WooViewController,
  type WooContext,
  type WooViewDefinition,
  type WooViewRequest
} from "../src/client/framework";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function flush(turns = 8): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve();
}

function semanticFixture<T>(definition: WooViewDefinition<T>) {
  const ui = createWooClientFramework();
  ui.catalogUi.installCatalogUi({ alias: "test", catalog: "test", ui: { abi: "woo-ui/v1" } });
  ui.catalogUi.defineView("test", definition);
  const context = (actor: string | null = "alice"): WooContext => {
    const woo: WooContext = {
      actor,
      frame: { id: "frame", subject: "subject", get: () => undefined, set: () => true },
      neighborhood: { subject: "subject", refs: [], related: {}, has: () => true },
      observe: (ref) => ui.observe(ref) ?? null,
      call: async () => undefined,
      send: async () => undefined,
      directCall: async () => undefined,
      view: (request) => ui.view(actor, woo, request),
      emit: () => true
    };
    return woo;
  };
  return { ui, context };
}

describe("reactive semantic-view facade", () => {
  it("publishes a partial seed, shares one read, and distinguishes complete empty", async () => {
    const result = deferred<unknown>();
    const read = vi.fn(() => result.promise);
    const { ui, context } = semanticFixture<string[]>({
      id: "items",
      seed: () => ["seed"],
      read,
      parse: (value) => {
        if (!Array.isArray(value)) throw new Error("not rows");
        return value.map(String);
      }
    });
    const woo = context();
    const view = ui.view<string[]>("alice", woo, { view: "items", subject: "one" });
    const initial = view.getSnapshot();
    expect(initial).toMatchObject({ data: ["seed"], completeness: "partial", freshness: "current", fetchStatus: "idle" });
    expect(view.getSnapshot()).toBe(initial);

    const stopA = view.subscribe(() => undefined);
    const stopB = view.subscribe(() => undefined);
    expect(read).toHaveBeenCalledTimes(1);
    expect(view.getSnapshot().fetchStatus).toBe("loading");
    result.resolve([]);
    await flush();
    expect(view.getSnapshot()).toMatchObject({ data: [], completeness: "complete", freshness: "current", fetchStatus: "idle" });
    stopA();
    stopB();
  });

  it("batches a frame's invalidations and rejects the overtaken in-flight result", async () => {
    const first = deferred<unknown>();
    const second = deferred<unknown>();
    const reads = [first, second];
    const read = vi.fn(() => reads.shift()!.promise);
    const { ui, context } = semanticFixture<string[]>({
      id: "items",
      read,
      parse: (value) => value as string[],
      invalidateOn: ["changed"]
    });
    const view = ui.view<string[]>("alice", context(), { view: "items", subject: "one" });
    view.subscribe(() => undefined);
    ui.ingestAppliedFrame({ seq: 1, space: "one", observations: [{ type: "changed" }, { type: "changed" }] });
    expect(read).toHaveBeenCalledTimes(1);

    first.resolve(["obsolete"]);
    await flush();
    expect(read).toHaveBeenCalledTimes(2);
    expect(view.getSnapshot().data).toBeNull();
    second.resolve(["current"]);
    await flush();
    expect(view.getSnapshot()).toMatchObject({ data: ["current"], completeness: "complete", freshness: "current" });
  });

  it("keeps complete stale data when refresh parsing fails", async () => {
    let answer: unknown = ["v1"];
    const { ui, context } = semanticFixture<string[]>({
      id: "items",
      read: async () => answer,
      parse: (value) => {
        if (!Array.isArray(value)) throw new Error("malformed rows");
        return value as string[];
      },
      invalidateOn: ["changed"]
    });
    const view = ui.view<string[]>("alice", context(), { view: "items", subject: "one" });
    view.subscribe(() => undefined);
    await flush();
    answer = { wrong: true };
    ui.ingestAppliedFrame({ seq: 2, space: "one", observations: [{ type: "changed" }] });
    await flush();
    expect(view.getSnapshot()).toMatchObject({ data: ["v1"], completeness: "complete", freshness: "stale", fetchStatus: "error" });
    expect(view.getSnapshot().error).toBeInstanceOf(Error);
  });

  it("isolates principal, subject, view args, and anonymous contexts", () => {
    const { ui, context } = semanticFixture<unknown[]>({ id: "items", read: async () => [], parse: (value) => value as unknown[] });
    const alice = context("alice");
    const bob = context("bob");
    const anonymousA = context(null);
    const anonymousB = context(null);
    const request: WooViewRequest = { view: "items", subject: "one", args: [{ b: 2, a: 1 }] };
    expect(ui.view("alice", alice, request)).toBe(ui.view("alice", alice, { ...request, args: [{ a: 1, b: 2 }] }));
    expect(ui.view("alice", alice, request)).not.toBe(ui.view("bob", bob, request));
    expect(ui.view("alice", alice, request)).not.toBe(ui.view("alice", alice, { ...request, subject: "two" }));
    expect(ui.view(null, anonymousA, request)).not.toBe(ui.view(null, anonymousB, request));
  });

  it("detaches read arguments from caller mutation while retaining the canonical cache key", async () => {
    let seen: readonly unknown[] = [];
    const { ui, context } = semanticFixture<unknown[]>({
      id: "items",
      read: async ({ args }) => { seen = args; return []; },
      parse: (value) => value as unknown[]
    });
    const mutable = { filter: "open" };
    const woo = context();
    const view = ui.view("alice", woo, { view: "items", subject: "one", args: [mutable] });
    mutable.filter = "closed";
    view.subscribe(() => undefined);
    await flush();
    expect(seen).toEqual([{ filter: "open" }]);
    expect(ui.view("alice", woo, { view: "items", subject: "one", args: [{ filter: "open" }] })).toBe(view);
  });

  it("does not invalidate from lossy live preview and garbage-collects inactive entries", async () => {
    const read = vi.fn(async () => []);
    const { ui, context } = semanticFixture<unknown[]>({
      id: "items",
      read,
      parse: (value) => value as unknown[],
      invalidateOn: ["changed"]
    });
    const woo = context();
    const request = { view: "items", subject: "one" };
    const first = ui.view("alice", woo, request);
    const stop = first.subscribe(() => undefined);
    await flush();
    ui.ingestLiveObservation({ type: "changed", source: "one" });
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    stop();
    ui.views.prune(Date.now() + 30_001);
    expect(ui.view("alice", woo, request)).not.toBe(first);
  });

  it("controller handles late binding, disconnect, and reconnect without a duplicate complete read", async () => {
    const read = vi.fn(async () => ["row"]);
    const { ui, context } = semanticFixture<string[]>({ id: "items", read, parse: (value) => value as string[] });
    const woo = context();
    let subject = "";
    let renders = 0;
    const controller = new WooViewController<string[]>(document.createElement("div"), () => subject ? { view: "items", subject } : null, () => { renders += 1; });
    controller.connected();
    controller.bind(woo);
    expect(read).not.toHaveBeenCalled();
    subject = "one";
    controller.bind(woo);
    await flush();
    expect(controller.snapshot.data).toEqual(["row"]);
    expect(read).toHaveBeenCalledTimes(1);
    controller.disconnected();
    controller.connected();
    expect(read).toHaveBeenCalledTimes(1);
    expect(renders).toBeGreaterThan(0);
  });
});
