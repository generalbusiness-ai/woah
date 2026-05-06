import { createWorld } from "../src/core/bootstrap";
import type { CallContext, HostBridge, HostObjectSummary, HostOperationMemo, MoveObjectResult, RoomSnapshot, ScopedObjectSummary, WooWorld } from "../src/core/world";
import type { AppliedFrame, DirectResultFrame, ErrorFrame, Message, ObjRef, TinyBytecode, VerbDef, WooValue } from "../src/core/types";

export function message(actor: string, target: string, verb: string, args: unknown[] = []): Message {
  return { actor, target, verb, args: args as any[] };
}

export function authedWorld() {
  const world = createWorld();
  const session = world.auth("guest:test");
  return { world, session, actor: session.actor };
}

export async function callInDubspace(
  world: ReturnType<typeof createWorld>,
  sessionId: string,
  requestId: string,
  request: Message
): Promise<AppliedFrame | DirectResultFrame | ErrorFrame> {
  const sessionActor = world.sessions.get(sessionId)?.actor;
  if (sessionActor !== request.actor) {
    return world.call(requestId, sessionId, "the_dubspace", request);
  }
  if (!world.hasPresence(sessionActor, "the_dubspace")) {
    const entered = await world.directCall(`enter-${requestId}`, sessionActor, "the_dubspace", "enter", []);
    if (entered.op === "error") return entered;
  }

  let verb;
  try {
    ({ verb } = world.resolveVerb(request.target, request.verb));
  } catch {
    return world.call(requestId, sessionId, "the_dubspace", request);
  }
  if (request.target === "the_dubspace" && verb.direct_callable === true && typeof verb.perms === "string" && verb.perms.includes("x")) {
    return world.directCall(requestId, request.actor, request.target, request.verb, request.args);
  }

  return world.call(requestId, sessionId, "the_dubspace", request);
}

export async function callInTaskspace(
  world: ReturnType<typeof createWorld>,
  sessionId: string,
  requestId: string,
  request: Message
): Promise<AppliedFrame | DirectResultFrame | ErrorFrame> {
  const sessionActor = world.sessions.get(sessionId)?.actor;
  if (sessionActor !== request.actor) {
    return world.call(requestId, sessionId, "the_taskspace", request);
  }
  if (!world.hasPresence(sessionActor, "the_taskspace")) {
    const entered = await world.directCall(`enter-${requestId}`, sessionActor, "the_taskspace", "enter", []);
    if (entered.op === "error") return entered;
  }

  let verb;
  try {
    ({ verb } = world.resolveVerb(request.target, request.verb));
  } catch {
    return world.call(requestId, sessionId, "the_taskspace", request);
  }
  if (verb.direct_callable === true && typeof verb.perms === "string" && verb.perms.includes("x")) {
    const direct = await world.directCall(requestId, request.actor, request.target, request.verb, request.args);
    return direct;
  }

  return world.call(requestId, sessionId, "the_taskspace", request);
}

export function nativeVerb(name: string, native = "describe", owner = "$wiz"): VerbDef {
  return {
    kind: "native",
    name,
    aliases: [],
    owner,
    perms: "rx",
    arg_spec: {},
    source: `verb :${name}() rx { ... }`,
    source_hash: `test-${name}`,
    version: 1,
    line_map: {},
    native
  };
}

function memoizeTestOperation<T>(cache: Map<string, Promise<unknown>>, key: string, load: () => Promise<T>): Promise<T> {
  const existing = cache.get(key);
  if (existing) return existing as Promise<T>;
  const promise = load();
  cache.set(key, promise as Promise<unknown>);
  return promise;
}

export function bytecodeVerb(name: string, bytecode: TinyBytecode, owner = "$wiz", perms = "rxd"): VerbDef {
  return {
    kind: "bytecode",
    name,
    aliases: [],
    owner,
    perms,
    arg_spec: {},
    source: `test ${name}`,
    source_hash: `test-${name}`,
    version: 1,
    line_map: {},
    bytecode
  };
}

export class LocalHostBridge implements HostBridge {
  readonly getPropCalls = new Map<string, number>();
  readonly describeCalls = new Map<string, number>();
  readonly describeManyCalls: ObjRef[][] = [];
  readonly objectSummaryManyCalls: ObjRef[][] = [];
  readonly isaCalls = new Map<string, number>();

  constructor(
    readonly localHost: string,
    private readonly worlds: Map<string, WooWorld>,
    private readonly routes: Map<ObjRef, string>
  ) {}

  hostForObject(id: ObjRef): string | null {
    return this.routes.get(id) ?? null;
  }

  async getPropChecked(progr: ObjRef, objRef: ObjRef, name: string, memo?: HostOperationMemo): Promise<WooValue> {
    const key = `prop:${progr}:${objRef}:${name}`;
    const read = async () => {
      this.getPropCalls.set(key, (this.getPropCalls.get(key) ?? 0) + 1);
      return await this.worldFor(objRef).getPropChecked(progr, objRef, name, memo);
    };
    if (!memo) return await read();
    return await memoizeTestOperation(memo.reads, key, read);
  }

  async objectSummary(readActor: ObjRef, objRef: ObjRef, memo?: HostOperationMemo): Promise<ScopedObjectSummary> {
    const key = `summary:${readActor}:${objRef}`;
    const read = async () => await this.worldFor(objRef).scopedObjectSummary(readActor, objRef, memo);
    if (!memo) return await read();
    return await memoizeTestOperation(memo.reads, key, read);
  }

  async objectSummaries(readActor: ObjRef, objRefs: ObjRef[], memo?: HostOperationMemo): Promise<Record<ObjRef, ScopedObjectSummary>> {
    this.objectSummaryManyCalls.push([...objRefs]);
    const out: Record<ObjRef, ScopedObjectSummary> = {};
    for (const objRef of objRefs) out[objRef] = await this.objectSummary(readActor, objRef, memo);
    return out;
  }

  async roomSnapshot(readActor: ObjRef, room: ObjRef, sessionId?: string | null, memo?: HostOperationMemo): Promise<RoomSnapshot> {
    const key = `room-snapshot:${readActor}:${room}:${sessionId ?? ""}`;
    const read = async () => await this.worldFor(room).roomSnapshotForActor(readActor, room, sessionId ?? null, memo);
    if (!memo) return await read();
    return await memoizeTestOperation(memo.reads, key, read);
  }

  async describeObject(nameActor: ObjRef, readActor: ObjRef, objRef: ObjRef, memo?: HostOperationMemo): Promise<HostObjectSummary> {
    const key = `describe:${nameActor}:${readActor}:${objRef}`;
    const read = async () => {
      this.describeCalls.set(key, (this.describeCalls.get(key) ?? 0) + 1);
      const world = this.worldFor(objRef);
      return {
        name: world.object(objRef).name,
        description: world.propOrNullForActor(readActor, objRef, "description"),
        aliases: world.propOrNullForActor(readActor, objRef, "aliases")
      };
    };
    if (!memo) return await read();
    return await memoizeTestOperation(memo.reads, key, read);
  }

  async describeObjects(nameActor: ObjRef, readActor: ObjRef, objRefs: ObjRef[], memo?: HostOperationMemo): Promise<Record<ObjRef, HostObjectSummary>> {
    this.describeManyCalls.push([...objRefs]);
    const out: Record<ObjRef, HostObjectSummary> = {};
    for (const objRef of objRefs) {
      const key = `describe:${nameActor}:${readActor}:${objRef}`;
      const read = async () => {
        const world = this.worldFor(objRef);
        return {
          name: world.object(objRef).name,
          description: world.propOrNullForActor(readActor, objRef, "description"),
          aliases: world.propOrNullForActor(readActor, objRef, "aliases")
        };
      };
      out[objRef] = memo ? await memoizeTestOperation(memo.reads, key, read) : await read();
    }
    return out;
  }

  async resolveVerb(target: ObjRef, verbName: string): Promise<{ name: string; direct_callable: boolean; arg_spec: Record<string, WooValue> } | null> {
    try {
      const { verb } = this.worldFor(target).resolveVerb(target, verbName);
      return { name: verb.name, direct_callable: verb.direct_callable === true, arg_spec: verb.arg_spec ?? {} };
    } catch {
      return null;
    }
  }

  async location(objRef: ObjRef): Promise<ObjRef | null> {
    return this.worldFor(objRef).object(objRef).location;
  }

  async isDescendantOf(objRef: ObjRef, ancestorRef: ObjRef, memo?: HostOperationMemo): Promise<boolean> {
    const key = `isa:${objRef}:${ancestorRef}`;
    const read = async () => {
      this.isaCalls.set(key, (this.isaCalls.get(key) ?? 0) + 1);
      return await this.worldFor(objRef).isDescendantOfChecked(objRef, ancestorRef, memo);
    };
    if (!memo) return await read();
    return await memoizeTestOperation(memo.reads, key, read);
  }

  async dispatch(ctx: CallContext, target: ObjRef, verbName: string, args: WooValue[], startAt?: ObjRef | null): Promise<WooValue> {
    const remote = this.worldFor(startAt ?? target);
    return await remote.hostDispatch({ ...ctx, world: remote }, target, verbName, args, startAt);
  }

  async moveObject(objRef: ObjRef, targetRef: ObjRef, options: { suppressMirrorHost?: string | null } = {}): Promise<MoveObjectResult> {
    const suppressMirrorHost = options.suppressMirrorHost ?? this.localHost;
    const result = await this.worldFor(objRef).moveObjectChecked(objRef, targetRef, { suppressMirrorHost });
    const localWorld = this.worlds.get(this.localHost);
    if (suppressMirrorHost === this.localHost && localWorld) {
      if (result.oldLocation && this.hostForObject(result.oldLocation) === this.localHost && localWorld.objects.has(result.oldLocation)) {
        localWorld.mirrorContents(result.oldLocation, objRef, false);
      }
      if (this.hostForObject(result.location) === this.localHost && localWorld.objects.has(result.location)) {
        localWorld.mirrorContents(result.location, objRef, true);
      }
    }
    return result;
  }

  async mirrorContents(containerRef: ObjRef, objRef: ObjRef, present: boolean): Promise<void> {
    this.worldFor(containerRef).mirrorContents(containerRef, objRef, present);
  }

  async setActorPresence(actor: ObjRef, space: ObjRef, present: boolean, sessionId?: string): Promise<void> {
    this.worldFor(actor).setActorPresence(actor, space, present, sessionId);
  }

  async setSpaceSubscriber(space: ObjRef, actor: ObjRef, present: boolean, sessionId?: string): Promise<void> {
    this.worldFor(space).setSpaceSubscriber(space, actor, present, sessionId);
  }

  async spaceAudienceSessions(space: ObjRef, actors?: ObjRef[]): Promise<string[]> {
    return this.worldFor(space).presenceSessionIdsIn(space, actors);
  }

  async actorSessionLocations(actor: ObjRef): Promise<ObjRef[]> {
    return this.worldFor(actor).allLocationsForActor(actor);
  }

  async contents(objRef: ObjRef): Promise<ObjRef[]> {
    return this.worldFor(objRef).contentsOf(objRef);
  }

  private worldFor(id: ObjRef): WooWorld {
    const host = this.routes.get(id);
    if (!host) throw new Error(`no route for ${id}`);
    const world = this.worlds.get(host);
    if (!world) throw new Error(`no world for ${host}`);
    return world;
  }
}
