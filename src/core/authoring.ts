import { compileWooSource } from "./dsl-compiler";
import { hashSource } from "./source-hash";
import { BUILTIN_NAMES } from "./tiny-vm";
import type { CompileResult, InstallResult, ObjRef, TinyBytecode, TinyOp, VerbCallSite, VerbDef, WooValue } from "./types";
import { isErrorValue, wooError } from "./types";
import { normalizeVerbPerms } from "./verb-perms";
import type { WooWorld } from "./world";

// Builtins whose execution definitively mutates world or session state, or
// has externally-visible side effects (broadcasts, scheduled tasks, presence
// changes, cross-host dispatch into possibly-impure verbs). Any verb that
// invokes one of these CANNOT be pure.
const IMPURE_BUILTIN_NAMES: ReadonlySet<string> = new Set([
  "create", "recycle", "move", "moveto", "chparent",
  "directory_reconcile_corenames",
  "set_task_perms", "set_presence", "observe_to_space", "tell",
  "builder_create_object", "builder_chparent", "builder_set_property",
  "programmer_install_verb", "programmer_set_verb_info", "programmer_set_property_info",
  // eval can do anything the actor's progr permits; treat as conservatively impure.
  "programmer_eval",
  "editor_invoke", "editor_replace", "editor_insert", "editor_delete",
  "editor_save", "editor_pause", "editor_abort",
  "add_verb", "delete_verb", "set_verb_info", "set_verb_code",
  "add_property", "delete_property", "set_property_info", "clear_property",
  // dispatch/execute_command_plan call into other verbs whose purity we
  // can't classify from this verb's bytecode alone — conservatively impure.
  "dispatch", "execute_command_plan"
]);

const IMPURE_OPCODES: ReadonlySet<string> = new Set([
  "SET_PROP", "SET_PROP_INFO",
  "DEFINE_PROP", "UNDEFINE_PROP",
  "OBSERVE", "EMIT",
  "FORK", "SUSPEND", "READ"
]);

// Static purity classification for a bytecode verb. Returns:
//  - "impure":  contains an opcode or builtin that definitely mutates state
//               or broadcasts. The verb cannot be marked pure.
//  - "pure":    contains no impure opcodes/builtins AND no CALL_VERB/PASS.
//               Safe to mark pure on its own.
//  - "unknown": calls another verb (CALL_VERB) — purity depends on
//               transitively-called verbs. Catalog author may assert
//               `"pure": true` to override; we trust the manual claim.
export function analyzeBytecodePurity(bytecode: TinyBytecode | null | undefined): "pure" | "impure" | "unknown" {
  if (!bytecode || !Array.isArray(bytecode.ops)) return "unknown";
  let unknown = false;
  for (const op of bytecode.ops) {
    if (!Array.isArray(op)) continue;
    const name = op[0];
    if (typeof name !== "string") continue;
    if (IMPURE_OPCODES.has(name)) return "impure";
    if (name === "CALL_VERB" || name === "PASS") { unknown = true; continue; }
    if (name === "BUILTIN") {
      const operand = op[1];
      const builtinName = typeof operand === "number" ? BUILTIN_NAMES[operand] : typeof operand === "string" ? operand : undefined;
      if (!builtinName) { unknown = true; continue; }
      if (IMPURE_BUILTIN_NAMES.has(builtinName)) return "impure";
    }
  }
  return unknown ? "unknown" : "pure";
}

// Whether the bytecode contains a PASS opcode. PASS dispatches to the
// parent class's verb of the same name as the current verb, which the call
// extractor does not record in `calls` metadata. Propagation treats PASS as
// an opaque dispatch — the caller must be catalog-declared pure (the author
// is asserting the parent-chain remains pure) for the verb to stay pure.
function bytecodeHasPass(bytecode: TinyBytecode | null | undefined): boolean {
  if (!bytecode || !Array.isArray(bytecode.ops)) return false;
  for (const op of bytecode.ops) {
    if (Array.isArray(op) && op[0] === "PASS") return true;
  }
  return false;
}

// Combine static analysis with an optional manifest claim. Analysis wins on
// "impure" — a `"pure": true` declaration that contradicts the bytecode is a
// catalog bug and we throw so it surfaces at install time. For "pure" the
// claim is unnecessary; the verb is auto-pure. For "unknown" (verb dispatches
// to other verbs) we trust the catalog author's declaration — but only as
// a fallback after the call-graph propagation pass; see `propagateVerbPurity`.
export function combineVerbPurity(analyzed: "pure" | "impure" | "unknown", declared: boolean | undefined, verbLabel: string): boolean {
  if (analyzed === "impure" && declared === true) {
    throw wooError("E_CATALOG", `verb declared pure but bytecode is impure: ${verbLabel}`, { verb: verbLabel });
  }
  if (analyzed === "impure") return false;
  if (analyzed === "pure") return true;
  return declared === true;
}

// Returns the names of `this:name(...)` call targets in `calls` that don't
// resolve to any verb on `definer`'s lineage. Used at install time to fail
// loudly on dead call references — typos and stale renames that would
// otherwise surface as `E_VERBNF` only at runtime.
//
// Polymorphic template calls — a parent verb that calls a method only
// implemented on subclasses — are accepted. The check only fails if NO class
// reachable as a possible runtime receiver of `this` (definer + ancestors +
// features + descendants) defines a verb of that name.
//
// Non-`this` calls (`obj:name()` where the object is not the literal `this`)
// are skipped: the receiver class isn't statically knowable.
export function findUnresolvedThisCalls(world: WooWorld, definer: ObjRef, calls: ReadonlyArray<VerbCallSite> | undefined): string[] {
  if (!calls || calls.length === 0) return [];
  const missing: string[] = [];
  const seen = new Set<string>();
  for (const site of calls) {
    if (!site.this_call) continue;
    if (seen.has(site.name)) continue;
    seen.add(site.name);
    if (collectThisCallTargets(world, definer, site.name).length === 0) {
      missing.push(site.name);
    }
  }
  return missing;
}

// All classes reachable as possible runtime receivers of `this` from a verb
// defined on `definer` that have a verb named `name`: the inherited resolution
// from the definer's chain (ancestors + features), plus every descendant that
// overrides `name`. Native verbs and bytecode verbs are returned uniformly.
function collectThisCallTargets(world: WooWorld, definer: ObjRef, name: string): Array<{ definer: ObjRef; verb: VerbDef }> {
  const seen = new Map<string, { definer: ObjRef; verb: VerbDef }>();
  const keyOf = (obj: ObjRef, vname: string) => `${obj}\x00${vname}`;
  try {
    const inherited = world.resolveVerb(definer, name);
    if (inherited) seen.set(keyOf(inherited.definer, inherited.verb.name), inherited);
  } catch { /* not on definer chain — descendants may still have it */ }
  for (const descendant of descendantsOf(world, definer)) {
    const obj = world.objects.get(descendant);
    if (!obj) continue; // tolerate transient holes (e.g. mid-install state)
    const own = obj.verbs.find((v) => v.name === name);
    if (own) seen.set(keyOf(descendant, own.name), { definer: descendant, verb: own });
  }
  return Array.from(seen.values());
}

// `pass(...)` from a verb defined on `definer` dispatches to the closest
// ancestor of `definer` that defines a verb of the same name. Returns the
// resolution or null if the inheritance chain has no such verb. Tolerates
// transient holes (deleted ancestor mid-install) by returning null instead
// of throwing.
function resolvePassTarget(world: WooWorld, definer: ObjRef, name: string): { definer: ObjRef; verb: VerbDef } | null {
  const start = world.objects.get(definer);
  if (!start) return null;
  let cursor: ObjRef | null = start.parent;
  const seen = new Set<ObjRef>();
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    const obj = world.objects.get(cursor);
    if (!obj) return null;
    const verb = world.ownVerbExact(cursor, name);
    if (verb) return { definer: cursor, verb };
    cursor = obj.parent;
  }
  return null;
}

function descendantsOf(world: WooWorld, root: ObjRef): ObjRef[] {
  const result: ObjRef[] = [];
  const visited = new Set<ObjRef>([root]);
  const stack: ObjRef[] = [];
  const rootObj = world.objects.get(root);
  if (rootObj) for (const child of rootObj.children) stack.push(child);
  while (stack.length) {
    const id = stack.pop()!;
    if (visited.has(id)) continue;
    visited.add(id);
    result.push(id);
    const obj = world.objects.get(id);
    if (!obj) continue;
    for (const child of obj.children) stack.push(child);
  }
  return result;
}

// Fixed-point purity propagation across the verb call graph. Walks every
// bytecode verb in the world. A verb stays pure iff:
//   - its bytecode contains no impure opcodes/builtins (analyzer = pure or
//     unknown), AND
//   - every `this:name(...)` site resolves to verb(s) that are themselves
//     pure across all possible runtime receivers (definer chain + descendant
//     overrides — `this` dispatches polymorphically), AND
//   - every non-`this` call site has a target whose purity we can vouch for.
//
// Convergence model: monotonic *decrease*. Every analyzable verb is seeded
// optimistically; iterations only flip `pure → impure` when a dependency
// fails to verify. Once a callee is poisoned, every transitive caller is
// poisoned too. (The previous "pure || previous" monotonic-increase pinned
// callers pure even after a callee was demoted.)
//
// Manifest-declared `pure: true` is a hint, not authority. It is honored
// for verbs the analyzer cannot decide AND whose dependencies it cannot
// verify (typically `obj:name()` opaque dispatch into another catalog), but
// a demonstrable bytecode impurity still wins — `combineVerbPurity` rejects
// declaration-vs-analysis conflicts at install time. Native targets without
// an explicit `pure` flag are treated as opaque; pure-marked natives are
// trusted.
//
// Should be called after a catalog install or any batch of verb edits.
export function propagateVerbPurity(world: WooWorld): { changed: number } {
  // Snapshot every bytecode verb's identity + analysis. `calls === null`
  // means the verb was compiled before the call-graph extractor existed; we
  // can't reason about it (treat as opaque-impure unless catalog-declared).
  // `declared` records a catalog `pure: true` assertion that lets non-this
  // dispatch survive when the rest of the call graph checks out.
  type Entry = {
    object: ObjRef;
    name: string;
    analyzed: "pure" | "impure" | "unknown";
    hasPass: boolean;
    calls: ReadonlyArray<VerbCallSite> | null;
    declared: boolean;
  };
  const entries: Entry[] = [];
  const pureMap = new Map<string, boolean>();
  const key = (obj: ObjRef, name: string) => `${obj}\x00${name}`;
  for (const [objRef, obj] of world.objects) {
    for (const verb of obj.verbs) {
      if (verb.kind !== "bytecode") continue;
      const analyzed = analyzeBytecodePurity(verb.bytecode);
      entries.push({
        object: objRef,
        name: verb.name,
        analyzed,
        hasPass: bytecodeHasPass(verb.bytecode),
        calls: verb.calls ?? null,
        // The catalog's manifest assertion. Stays in sync with the manifest
        // via drift detection — distinct from `pure`, which is the derived
        // flag that propagation writes back.
        declared: verb.pure_declared === true
      });
      // Optimistic seed: pure unless the bytecode is definitively impure.
      pureMap.set(key(objRef, verb.name), analyzed !== "impure");
    }
  }
  // Cache per-call-site resolution across iterations — neither the world's
  // class graph nor the call sites change during propagation, so the set of
  // possible targets for `this:name()` is invariant.
  const targetCache = new Map<string, Array<{ definer: ObjRef; verb: VerbDef }>>();
  const targetsFor = (definer: ObjRef, name: string) => {
    const k = key(definer, name);
    let cached = targetCache.get(k);
    if (!cached) {
      cached = collectThisCallTargets(world, definer, name);
      targetCache.set(k, cached);
    }
    return cached;
  };
  // A target is pure iff: native with explicit pure flag, OR bytecode whose
  // current pureMap entry says pure. The caller may inherit from its own
  // manifest declaration: a declared-pure caller trusts unmarked-native
  // callees (the catalog author accepted responsibility for the chain) —
  // bytecode callees are still required to verify, since we have the data.
  const targetIsPure = (target: { definer: ObjRef; verb: VerbDef }, callerDeclared: boolean) => {
    if (target.verb.kind === "native") {
      if (target.verb.pure === true) return true;
      return callerDeclared;
    }
    return pureMap.get(key(target.definer, target.verb.name)) === true;
  };
  let iter = true;
  while (iter) {
    iter = false;
    for (const entry of entries) {
      const k = key(entry.object, entry.name);
      if (pureMap.get(k) !== true) continue; // already poisoned
      if (entry.analyzed === "pure") continue; // no calls in bytecode
      // analyzed === "unknown": verb has CALL_VERB or PASS, must verify graph.
      // Without call metadata we can't reason — old worlds compiled before
      // the extractor. Conservatively poison; the catalog drift detector
      // will repair the missing field on the next install/sync, after which
      // a subsequent propagation pass can derive the correct flag. We do not
      // honor a stored `pure: true` on a calls-less verb, because that flag
      // could equally be a stale fossil from the buggy monotonic-increase
      // pass and we have no way to tell.
      if (entry.calls === null) {
        pureMap.set(k, false);
        iter = true;
        continue;
      }
      // PASS dispatches to the parent class's verb of the same name. We can
      // resolve this by walking up from the definer to find the next ancestor
      // that defines the verb, and require that verb to be pure.
      if (entry.hasPass) {
        const parentTarget = resolvePassTarget(world, entry.object, entry.name);
        if (!parentTarget || !targetIsPure(parentTarget, entry.declared)) {
          pureMap.set(k, false);
          iter = true;
          continue;
        }
      }
      let stillPure = true;
      for (const site of entry.calls) {
        if (!site.this_call) {
          // Opaque receiver — only the manifest claim can keep us pure.
          if (!entry.declared) { stillPure = false; break; }
          continue;
        }
        const targets = targetsFor(entry.object, site.name);
        if (targets.length === 0) { stillPure = false; break; }
        for (const target of targets) {
          if (!targetIsPure(target, entry.declared)) { stillPure = false; break; }
        }
        if (!stillPure) break;
      }
      if (!stillPure) {
        pureMap.set(k, false);
        iter = true;
      }
    }
  }
  // Commit final purity to the world for verbs whose flag actually changed.
  let changed = 0;
  for (const entry of entries) {
    const finalPure = pureMap.get(key(entry.object, entry.name)) === true;
    const obj = world.objects.get(entry.object);
    if (!obj) continue;
    const verb = obj.verbs.find((v) => v.name === entry.name);
    if (!verb || verb.kind !== "bytecode") continue;
    if ((verb.pure === true) !== finalPure) {
      world.addVerb(entry.object, { ...verb, pure: finalPure ? true : undefined });
      changed += 1;
    }
  }
  return { changed };
}

type AuthoringOptions = {
  format?: "t0-source" | "woo-source" | "t0-json-bytecode";
  argSpec?: Record<string, WooValue>;
};

type StackEffect = { requires: number; delta: number; exits?: boolean };

const BYTECODE_LIMITS = {
  ops: 10_000,
  literals: 4_096,
  literalBytes: 512 * 1024,
  locals: 1_024,
  stack: 4_096,
  ticks: 1_000_000,
  memory: 16 * 1024 * 1024,
  wallMs: 10_000
};

export function compileVerb(source: string, options: AuthoringOptions = {}): CompileResult {
  const format = options.format ?? inferFormat(source);
  if (format === "t0-json-bytecode") {
    try {
      const bytecode = JSON.parse(source) as TinyBytecode;
      verifyBytecode(bytecode);
      return { ok: true, diagnostics: [], bytecode, source_hash: hashSource(source) };
    } catch (err) {
      return {
        ok: false,
        diagnostics: [compileDiagnostic(err)]
      };
    }
  }
  const compiled = compileWooSource(source);
  if (!compiled.ok || !compiled.bytecode) return compiled;
  try {
    verifyBytecode(compiled.bytecode);
    return compiled;
  } catch (err) {
    return { ok: false, diagnostics: [compileDiagnostic(err)] };
  }
}

export function installVerb(world: WooWorld, obj: ObjRef, name: string, source: string, expectedVersion: number | null, options: AuthoringOptions = {}): InstallResult {
  const target = world.object(obj);
  return installVerbWithOwner(world, obj, name, source, expectedVersion, target.owner, options);
}

export function installVerbAs(world: WooWorld, actor: ObjRef, obj: ObjRef, name: string, source: string, expectedVersion: number | null, options: AuthoringOptions = {}): InstallResult {
  world.assertCanAuthorObject(actor, obj);
  return installVerbWithOwner(world, obj, name, source, expectedVersion, actor, options);
}

function installVerbWithOwner(world: WooWorld, obj: ObjRef, name: string, source: string, expectedVersion: number | null, owner: ObjRef, options: AuthoringOptions = {}): InstallResult {
  const target = world.object(obj);
  world.object(owner);
  const current = world.ownVerbExact(obj, name);
  if ((current?.version ?? null) !== expectedVersion) {
    throw wooError("E_VERSION", "verb version conflict", { expected: expectedVersion, actual: current?.version ?? null });
  }
  const compiled = compileVerb(source, options);
  if (!compiled.ok || !compiled.bytecode) return { ok: false, version: current?.version ?? 0, diagnostics: compiled.diagnostics };
  if (compiled.metadata?.name && compiled.metadata.name !== name) {
    return {
      ok: false,
      version: current?.version ?? 0,
      diagnostics: [{ severity: "error", code: "E_COMPILE", message: `verb header names :${compiled.metadata.name}, but install target is :${name}` }]
    };
  }
  const version = (current?.version ?? 0) + 1;
  const parsedPerms = normalizeVerbPerms(
    compiled.metadata?.perms ?? current?.perms ?? "rx",
    compiled.metadata?.perms ? false : current?.direct_callable === true
  );
  const compiledArgSpec = compiled.metadata?.arg_spec ?? {};
  const argSpec = options.argSpec ? { ...compiledArgSpec, ...options.argSpec } : (compiled.metadata?.arg_spec ?? current?.arg_spec ?? {});
  // Re-classify on every install — analyzer drives purity; never carry an
  // older install's `pure: true` over a freshly-compiled bytecode that the
  // analyzer can't confirm.
  const finalBytecode = { ...compiled.bytecode, version };
  const pure = combineVerbPurity(analyzeBytecodePurity(finalBytecode), undefined, `${obj}:${name}`);
  world.addVerb(obj, {
    kind: "bytecode",
    name,
    aliases: current?.aliases ?? [],
    owner,
    perms: parsedPerms.perms,
    arg_spec: argSpec,
    direct_callable: parsedPerms.directCallable,
    skip_presence_check: current?.skip_presence_check,
    tool_exposed: current?.tool_exposed,
    pure: pure || undefined,
    calls: compiled.metadata?.calls,
    source,
    source_hash: compiled.source_hash ?? hashSource(source),
    bytecode: finalBytecode,
    version,
    line_map: compiled.line_map ?? {}
  });
  // Propagate so a transitively-pure new verb (and any callers that reach it
  // through `this:name(...)`) get their flag updated to match the call graph.
  propagateVerbPurity(world);
  return { ok: true, version };
}

export function definePropertyVersioned(world: WooWorld, obj: ObjRef, name: string, defaultValue: WooValue, perms: string, expectedVersion: number | null, typeHint?: string) {
  const target = world.object(obj);
  return definePropertyVersionedWithOwner(world, obj, name, defaultValue, perms, expectedVersion, target.owner, typeHint);
}

export function definePropertyVersionedAs(world: WooWorld, actor: ObjRef, obj: ObjRef, name: string, defaultValue: WooValue, perms: string, expectedVersion: number | null, typeHint?: string) {
  world.assertCanAuthorObject(actor, obj);
  return definePropertyVersionedWithOwner(world, obj, name, defaultValue, perms, expectedVersion, actor, typeHint);
}

function definePropertyVersionedWithOwner(world: WooWorld, obj: ObjRef, name: string, defaultValue: WooValue, perms: string, expectedVersion: number | null, owner: ObjRef, typeHint?: string) {
  const target = world.object(obj);
  const current = target.propertyDefs.get(name);
  if ((current?.version ?? null) !== expectedVersion) {
    throw wooError("E_VERSION", "property definition version conflict", { expected: expectedVersion, actual: current?.version ?? null });
  }
  return world.defineProperty(obj, {
    name,
    defaultValue,
    perms,
    owner,
    typeHint,
    version: (current?.version ?? 0) + 1
  });
}

export function setPropertyValueVersionedAs(world: WooWorld, actor: ObjRef, obj: ObjRef, name: string, value: WooValue, expectedVersion: number | null = null) {
  world.assertCanAuthorObject(actor, obj);
  const current = world.object(obj).propertyVersions.get(name) ?? null;
  if (expectedVersion !== null && current !== expectedVersion) {
    throw wooError("E_VERSION", "property value version conflict", { expected: expectedVersion, actual: current });
  }
  world.setProp(obj, name, value);
  return world.propertyInfo(obj, name);
}

function inferFormat(source: string): "t0-source" | "t0-json-bytecode" {
  return source.trim().startsWith("{") ? "t0-json-bytecode" : "t0-source";
}

function verifyBytecode(bytecode: TinyBytecode): void {
  if (!bytecode || !Array.isArray(bytecode.ops) || !Array.isArray(bytecode.literals)) {
    throw wooError("E_COMPILE", "invalid TinyBytecode shape");
  }
  if (!isIntegerInRange(bytecode.version, 0, Number.MAX_SAFE_INTEGER)) throw wooError("E_COMPILE", "bytecode version must be a non-negative integer");
  if (!isIntegerInRange(bytecode.num_locals, 0, BYTECODE_LIMITS.locals)) throw wooError("E_COMPILE", `bytecode num_locals exceeds limit ${BYTECODE_LIMITS.locals}`);
  if (!isIntegerInRange(bytecode.max_stack, 0, BYTECODE_LIMITS.stack)) throw wooError("E_COMPILE", `bytecode max_stack exceeds limit ${BYTECODE_LIMITS.stack}`);
  if (bytecode.ops.length > BYTECODE_LIMITS.ops) throw wooError("E_COMPILE", `bytecode op count exceeds limit ${BYTECODE_LIMITS.ops}`);
  if (bytecode.ops.length === 0) throw wooError("E_COMPILE", "bytecode must contain at least one opcode");
  if (bytecode.literals.length > BYTECODE_LIMITS.literals) throw wooError("E_COMPILE", `bytecode literal count exceeds limit ${BYTECODE_LIMITS.literals}`);
  if (bytecode.max_ticks !== undefined && !isIntegerInRange(bytecode.max_ticks, 1, BYTECODE_LIMITS.ticks)) throw wooError("E_COMPILE", `bytecode max_ticks exceeds limit ${BYTECODE_LIMITS.ticks}`);
  if (bytecode.max_memory !== undefined && !isIntegerInRange(bytecode.max_memory, 1, BYTECODE_LIMITS.memory)) throw wooError("E_COMPILE", `bytecode max_memory exceeds limit ${BYTECODE_LIMITS.memory}`);
  if (bytecode.max_wall_ms !== undefined && !isIntegerInRange(bytecode.max_wall_ms, 1, BYTECODE_LIMITS.wallMs)) throw wooError("E_COMPILE", `bytecode max_wall_ms exceeds limit ${BYTECODE_LIMITS.wallMs}`);
  const literalBytes = new TextEncoder().encode(JSON.stringify(bytecode.literals)).byteLength;
  if (literalBytes > BYTECODE_LIMITS.literalBytes) throw wooError("E_COMPILE", `bytecode literals exceed ${BYTECODE_LIMITS.literalBytes} bytes`);
  for (let pc = 0; pc < bytecode.ops.length; pc++) {
    const item = bytecode.ops[pc];
    if (!Array.isArray(item) || typeof item[0] !== "string") throw wooError("E_COMPILE", "invalid opcode shape");
    const [op] = item;
    if (!VALID_OPS.has(op)) throw wooError("E_COMPILE", `unknown opcode ${op}`);
    verifyOpcodeShape(bytecode, pc, item);
  }
  verifyStackGraph(bytecode);
}

function isIntegerInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

function compileDiagnostic(err: unknown): CompileResult["diagnostics"][number] {
  if (isErrorValue(err)) return { severity: "error", code: err.code, message: err.message ?? err.code };
  return { severity: "error", code: "E_COMPILE", message: err instanceof Error ? err.message : String(err) };
}

function verifyOpcodeShape(bytecode: TinyBytecode, pc: number, item: TinyOp): void {
  const [op] = item;
  expectArity(pc, item, opcodeArity(op));
  switch (op) {
    case "PUSH_LIT":
    case "TRY_PUSH":
      expectLiteral(bytecode, pc, item[op === "TRY_PUSH" ? 2 : 1]);
      if (op === "TRY_PUSH") {
        const errors = bytecode.literals[expectInteger(pc, item[2], "TRY_PUSH error literal")];
        if (!Array.isArray(errors) || !errors.every((value) => typeof value === "string")) {
          throw compileErrorAt(pc, "TRY_PUSH error literal must be a list of error-code strings");
        }
      }
      break;
    case "PUSH_LOCAL":
    case "POP_LOCAL":
    case "FOR_LIST_INIT":
    case "FOR_RANGE_INIT":
      expectLocal(bytecode, pc, item[1]);
      break;
    case "FOR_LIST_NEXT":
    case "FOR_RANGE_NEXT":
      expectLocal(bytecode, pc, item[1]);
      expectJumpTarget(bytecode, pc, item[2]);
      break;
    case "FOR_MAP_NEXT":
      expectLocal(bytecode, pc, item[1]);
      expectLocal(bytecode, pc, item[2]);
      expectJumpTarget(bytecode, pc, item[3]);
      break;
    case "PUSH_INT":
    case "PUSH_ARG":
    case "CALL_VERB":
    case "PASS":
    case "MAKE_MAP":
    case "MAKE_LIST":
    case "STR_CONCAT":
    case "STR_INTERP":
    case "FORK":
      expectNonNegativeInteger(pc, item[1], `${op} operand`);
      break;
    case "BUILTIN":
      if (typeof item[1] !== "string" || !VALID_BUILTINS.has(item[1])) throw compileErrorAt(pc, `unknown builtin ${String(item[1])}`);
      expectNonNegativeInteger(pc, item[2], "BUILTIN argc");
      break;
    case "JUMP":
    case "JUMP_IF_TRUE":
    case "JUMP_IF_FALSE":
    case "JUMP_IF_TRUE_KEEP":
    case "JUMP_IF_FALSE_KEEP":
      expectJumpTarget(bytecode, pc, item[1]);
      break;
    case "SPLAT":
      throw compileErrorAt(pc, "SPLAT is not accepted in installable bytecode until static stack verification supports variable stack effects");
  }
}

function verifyStackGraph(bytecode: TinyBytecode): void {
  const heights = new Map<number, number>();
  const work: Array<{ pc: number; height: number }> = [];
  const enqueue = (pc: number, height: number): void => {
    if (pc === bytecode.ops.length) return;
    if (pc < 0 || pc > bytecode.ops.length) throw compileErrorAt(pc, "control flow leaves bytecode bounds");
    const previous = heights.get(pc);
    if (previous !== undefined) {
      if (previous !== height) throw compileErrorAt(pc, `inconsistent stack height at control-flow join: ${previous} vs ${height}`);
      return;
    }
    heights.set(pc, height);
    work.push({ pc, height });
  };

  enqueue(0, 0);
  while (work.length > 0) {
    const { pc, height } = work.shift()!;
    const item = bytecode.ops[pc];
    const effect = stackEffect(pc, item);
    if (height < effect.requires) throw compileErrorAt(pc, `stack underflow for ${item[0]}`);
    const nextHeight = height + effect.delta;
    if (nextHeight < 0) throw compileErrorAt(pc, `stack underflow for ${item[0]}`);
    if (nextHeight > bytecode.max_stack) throw compileErrorAt(pc, `max_stack ${bytecode.max_stack} is too small for ${item[0]}`);

    if (item[0] === "TRY_PUSH") {
      const handlerHeight = nextHeight + 1;
      if (handlerHeight > bytecode.max_stack) throw compileErrorAt(pc, `max_stack ${bytecode.max_stack} cannot catch errors at this handler depth`);
      enqueue(jumpTarget(pc, item[1]), handlerHeight);
    }
    if (effect.exits) continue;
    for (const target of successors(bytecode, pc, item)) enqueue(target, nextHeight);
  }
}

function successors(bytecode: TinyBytecode, pc: number, item: TinyOp): number[] {
  const next = pc + 1;
  switch (item[0]) {
    case "JUMP":
      return [jumpTarget(pc, item[1])];
    case "JUMP_IF_TRUE":
    case "JUMP_IF_FALSE":
    case "JUMP_IF_TRUE_KEEP":
    case "JUMP_IF_FALSE_KEEP":
    case "FOR_LIST_NEXT":
    case "FOR_RANGE_NEXT":
      return [next, jumpTarget(pc, item[0].startsWith("FOR_") ? item[2] : item[1])];
    case "FOR_MAP_NEXT":
      return [next, jumpTarget(pc, item[3])];
    default:
      return next <= bytecode.ops.length ? [next] : [];
  }
}

function stackEffect(pc: number, item: TinyOp): StackEffect {
  const [op] = item;
  switch (op) {
    case "PUSH_LIT":
    case "PUSH_INT":
    case "PUSH_LOCAL":
    case "PUSH_THIS":
    case "PUSH_ACTOR":
    case "PUSH_PLAYER":
    case "PUSH_CALLER":
    case "PUSH_PROGR":
    case "PUSH_VERB":
    case "PUSH_ARGS":
    case "PUSH_SPACE":
    case "PUSH_SEQ":
    case "PUSH_MESSAGE":
    case "PUSH_ARG":
      return { requires: 0, delta: 1 };
    case "POP_LOCAL":
    case "POP":
    case "NEG":
    case "NOT":
      return { requires: 1, delta: op === "POP" || op === "POP_LOCAL" ? -1 : 0 };
    case "DUP":
      return { requires: 1, delta: 1 };
    case "SWAP":
      return { requires: 2, delta: 0 };
    case "ADD":
    case "SUB":
    case "MUL":
    case "DIV":
    case "MOD":
    case "EQ":
    case "NEQ":
    case "LT":
    case "LE":
    case "GT":
    case "GE":
    case "IN":
    case "GET_PROP":
    case "HAS_PROP":
    case "PROP_INFO":
    case "LIST_GET":
    case "LIST_APPEND":
    case "MAP_GET":
    case "INDEX_GET":
      return { requires: 2, delta: -1 };
    case "JUMP":
    case "YIELD":
    case "TRY_PUSH":
    case "TRY_POP":
      return { requires: 0, delta: 0 };
    case "JUMP_IF_TRUE":
    case "JUMP_IF_FALSE":
      return { requires: 1, delta: -1 };
    case "JUMP_IF_TRUE_KEEP":
    case "JUMP_IF_FALSE_KEEP":
      return { requires: 1, delta: 0 };
    case "FOR_LIST_INIT":
    case "FOR_MAP_INIT":
      return { requires: 1, delta: 1 };
    case "FOR_LIST_NEXT":
    case "FOR_RANGE_INIT":
    case "FOR_RANGE_NEXT":
    case "FOR_MAP_NEXT":
      return { requires: 2, delta: 0 };
    case "FOR_END":
    case "UNDEFINE_PROP":
    case "EMIT":
      return { requires: 2, delta: -2 };
    case "SET_PROP":
    case "SET_PROP_INFO":
    case "LIST_SET":
    case "MAP_SET":
    case "INDEX_SET":
      return { requires: 3, delta: op === "SET_PROP" || op === "SET_PROP_INFO" ? -3 : -2 };
    case "DEFINE_PROP":
      return { requires: 4, delta: -4 };
    case "CALL_VERB": {
      const argc = expectNonNegativeInteger(pc, item[1], "CALL_VERB argc");
      return { requires: argc + 2, delta: -argc - 1 };
    }
    case "PASS": {
      const argc = expectNonNegativeInteger(pc, item[1], "PASS argc");
      return { requires: argc, delta: -argc + 1 };
    }
    case "RETURN":
      return { requires: 1, delta: -1, exits: true };
    case "RAISE":
    case "FAIL":
      return { requires: 1, delta: -1, exits: true };
    case "BUILTIN": {
      const argc = expectNonNegativeInteger(pc, item[2], "BUILTIN argc");
      return { requires: argc, delta: -argc + 1 };
    }
    case "MAKE_MAP": {
      const count = expectNonNegativeInteger(pc, item[1], "MAKE_MAP count");
      return { requires: count * 2, delta: 1 - count * 2 };
    }
    case "MAKE_LIST":
    case "STR_CONCAT":
    case "STR_INTERP": {
      const count = expectNonNegativeInteger(pc, item[1], `${op} count`);
      return { requires: count, delta: 1 - count };
    }
    case "OBSERVE":
      return { requires: 1, delta: -1 };
    case "FORK": {
      const argc = expectNonNegativeInteger(pc, item[1], "FORK argc");
      return { requires: argc + 3, delta: -argc - 2 };
    }
    case "SUSPEND":
    case "READ":
      return { requires: 1, delta: 0 };
    default:
      throw compileErrorAt(pc, `unknown opcode ${op}`);
  }
}

function opcodeArity(op: string): number {
  if ([
    "PUSH_THIS", "PUSH_ACTOR", "PUSH_PLAYER", "PUSH_CALLER", "PUSH_PROGR", "PUSH_VERB", "PUSH_ARGS", "PUSH_SPACE", "PUSH_SEQ", "PUSH_MESSAGE",
    "POP", "DUP", "SWAP", "ADD", "SUB", "MUL", "DIV", "MOD", "NEG", "NOT", "EQ", "NEQ", "LT", "LE", "GT", "GE", "IN",
    "FOR_MAP_INIT", "FOR_END", "GET_PROP", "SET_PROP", "HAS_PROP", "DEFINE_PROP", "UNDEFINE_PROP", "PROP_INFO", "SET_PROP_INFO",
    "RETURN", "RAISE", "FAIL", "LIST_GET", "LIST_SET", "LIST_APPEND", "MAP_GET", "MAP_SET", "INDEX_GET", "INDEX_SET", "SPLAT",
    "OBSERVE", "EMIT", "YIELD", "SUSPEND", "READ", "TRY_POP"
  ].includes(op)) return 0;
  if ([
    "PUSH_LIT", "PUSH_INT", "PUSH_LOCAL", "POP_LOCAL", "PUSH_ARG", "JUMP", "JUMP_IF_TRUE", "JUMP_IF_FALSE", "JUMP_IF_TRUE_KEEP", "JUMP_IF_FALSE_KEEP",
    "FOR_LIST_INIT", "FOR_RANGE_INIT", "CALL_VERB", "PASS", "MAKE_MAP", "MAKE_LIST", "STR_CONCAT", "STR_INTERP", "FORK"
  ].includes(op)) return 1;
  if (["FOR_LIST_NEXT", "FOR_RANGE_NEXT", "BUILTIN", "TRY_PUSH"].includes(op)) return 2;
  if (op === "FOR_MAP_NEXT") return 3;
  throw wooError("E_COMPILE", `unknown opcode ${op}`);
}

function expectArity(pc: number, item: TinyOp, operands: number): void {
  if (item.length !== operands + 1) throw compileErrorAt(pc, `${item[0]} expects ${operands} operand(s), got ${item.length - 1}`);
}

function expectLiteral(bytecode: TinyBytecode, pc: number, value: WooValue | undefined): number {
  const index = expectNonNegativeInteger(pc, value, "literal index");
  if (index >= bytecode.literals.length) throw compileErrorAt(pc, `literal index out of range: ${index}`);
  return index;
}

function expectLocal(bytecode: TinyBytecode, pc: number, value: WooValue | undefined): number {
  const index = expectNonNegativeInteger(pc, value, "local index");
  if (index >= bytecode.num_locals) throw compileErrorAt(pc, `local index out of range: ${index}`);
  return index;
}

function expectJumpTarget(bytecode: TinyBytecode, pc: number, value: WooValue | undefined): number {
  const target = jumpTarget(pc, value);
  if (target < 0 || target > bytecode.ops.length) throw compileErrorAt(pc, `jump target out of range: ${target}`);
  return target;
}

function jumpTarget(pc: number, offset: WooValue | undefined): number {
  return pc + expectInteger(pc, offset, "jump offset") + 1;
}

function expectNonNegativeInteger(pc: number, value: WooValue | undefined, label: string): number {
  const number = expectInteger(pc, value, label);
  if (number < 0) throw compileErrorAt(pc, `${label} must be non-negative`);
  return number;
}

function expectInteger(pc: number, value: WooValue | undefined, label: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || !Number.isSafeInteger(value)) {
    throw compileErrorAt(pc, `${label} must be a safe integer`);
  }
  return value;
}

function compileErrorAt(pc: number, message: string): never {
  throw wooError("E_COMPILE", `bytecode pc ${pc}: ${message}`);
}

const VALID_OPS = new Set([
  "PUSH_LIT",
  "PUSH_INT",
  "PUSH_LOCAL",
  "POP_LOCAL",
  "PUSH_THIS",
  "PUSH_ACTOR",
  "PUSH_PLAYER",
  "PUSH_CALLER",
  "PUSH_PROGR",
  "PUSH_VERB",
  "PUSH_ARGS",
  "PUSH_SPACE",
  "PUSH_SEQ",
  "PUSH_MESSAGE",
  "PUSH_ARG",
  "POP",
  "DUP",
  "SWAP",
  "ADD",
  "SUB",
  "MUL",
  "DIV",
  "MOD",
  "NEG",
  "NOT",
  "EQ",
  "NEQ",
  "LT",
  "LE",
  "GT",
  "GE",
  "IN",
  "JUMP",
  "JUMP_IF_TRUE",
  "JUMP_IF_FALSE",
  "JUMP_IF_TRUE_KEEP",
  "JUMP_IF_FALSE_KEEP",
  "FOR_LIST_INIT",
  "FOR_LIST_NEXT",
  "FOR_RANGE_INIT",
  "FOR_RANGE_NEXT",
  "FOR_MAP_INIT",
  "FOR_MAP_NEXT",
  "FOR_END",
  "GET_PROP",
  "SET_PROP",
  "HAS_PROP",
  "DEFINE_PROP",
  "UNDEFINE_PROP",
  "PROP_INFO",
  "SET_PROP_INFO",
  "CALL_VERB",
  "PASS",
  "RETURN",
  "RAISE",
  "BUILTIN",
  "LIST_GET",
  "LIST_SET",
  "LIST_APPEND",
  "MAP_GET",
  "MAP_SET",
  "INDEX_GET",
  "INDEX_SET",
  "MAKE_MAP",
  "MAKE_LIST",
  "STR_CONCAT",
  "STR_INTERP",
  "SPLAT",
  "OBSERVE",
  "EMIT",
  "YIELD",
  "SUSPEND",
  "READ",
  "FORK",
  "TRY_PUSH",
  "TRY_POP",
  "FAIL"
]);

const VALID_BUILTINS = new Set([
  "length",
  "keys",
  "values",
  "has",
  "typeof",
  "to_string",
  "tostr",
  "to_int",
  "to_float",
  "min",
  "max",
  "floor",
  "ceil",
  "round",
  "abs",
  "str_trim",
  "str_lower",
  "str_starts",
  "str_index",
  "str_slice",
  "str_char",
  "str_join",
  "str_split",
  "now",
  "create",
  "recycle",
  "move",
  "moveto",
  "chparent",
  "has_flag",
  "isa",
  "is_recycled",
  "directory_reconcile_corenames",
  "random",
  "contents",
  "location",
  "task_perms",
  "caller_perms",
  "set_task_perms",
  "set_presence",
  "observe_to_space",
  "tell",
  "dispatch",
  "execute_command_plan",
  "collect_prop",
  "current_location",
  "current_session",
  "session_location",
  "all_locations",
  "primary_session",
  "is_connected",
  "idle_seconds",
  // builder_create_object and builder_chparent stay native; see
  // tiny-vm.ts BUILTIN_NAMES for the removal note on the other
  // builder_*/programmer_* surface builtins.
  "builder_create_object",
  "builder_chparent",
  "programmer_eval",
  "editor_invoke",
  "editor_what",
  "editor_view",
  "editor_replace",
  "editor_insert",
  "editor_delete",
  "editor_dry_run",
  "editor_save",
  "editor_pause",
  "editor_abort",
  "parents",
  "children",
  "valid",
  "verbs",
  "verb_info",
  "verb_code",
  "add_verb",
  "delete_verb",
  "set_verb_info",
  "set_verb_code",
  "compile_verb",
  "properties",
  "property_info",
  "add_property",
  "delete_property",
  "set_property_info",
  "clear_property",
  "is_clear_property",
  "authoring_inspect",
  "authoring_search",
  "set_object_name",
  "is_remote_object",
  "presence_status"
]);
