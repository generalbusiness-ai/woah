#!/usr/bin/env node
// guard-command-planning — text-command planning must enter the normal catalog
// verb-dispatch path. Server/client conveniences may call `:command_plan`; only
// the native `$match:plan_command` primitive may call the parser helper itself.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const worldPath = "src/core/world.ts";
const clientPath = "src/client/main.ts";
const world = readFileSync(worldPath, "utf8");
const client = readFileSync(clientPath, "utf8");
const failures = [];

const worldAst = ts.createSourceFile(worldPath, world, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
const clientAst = ts.createSourceFile(clientPath, client, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function visit(node, fn) {
  fn(node);
  ts.forEachChild(node, (child) => visit(child, fn));
}

function location(source, node) {
  const { line, character } = source.getLineAndCharacterOfPosition(node.getStart(source));
  return `${source.fileName}:${line + 1}:${character + 1}`;
}

function methodNamed(source, name) {
  let found = null;
  visit(source, (node) => {
    if (found || !ts.isMethodDeclaration(node)) return;
    if (ts.isIdentifier(node.name) && node.name.text === name) found = node;
  });
  return found;
}

function calledFunctionName(node) {
  if (!ts.isCallExpression(node)) return null;
  const expression = node.expression;
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

function stringLiterals(source, root) {
  const out = [];
  visit(root, (node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      out.push({ text: node.text, node });
    }
  });
  return out;
}

function ancestor(node, predicate) {
  let current = node.parent;
  while (current) {
    if (predicate(current)) return current;
    current = current.parent;
  }
  return null;
}

function isNativePlanCommandRegistration(node) {
  if (!ts.isCallExpression(node)) return false;
  const expression = node.expression;
  if (!ts.isPropertyAccessExpression(expression) || expression.name.text !== "set") return false;
  if (!ts.isPropertyAccessExpression(expression.expression) || expression.expression.name.text !== "nativeHandlers") return false;
  const firstArg = node.arguments[0];
  return Boolean(firstArg && ts.isStringLiteral(firstArg) && firstArg.text === "plan_command");
}

const planCommandNow = methodNamed(worldAst, "planCommandNow");
if (!planCommandNow?.body) {
  failures.push(`${worldPath}: could not locate planCommandNow for command-planning guard`);
} else {
  let directHelperCalls = 0;
  visit(planCommandNow.body, (node) => {
    if (calledFunctionName(node) === "planCommandForSpace") directHelperCalls += 1;
  });
  if (directHelperCalls > 0) {
    failures.push(`${worldPath}: planCommandNow must dispatch :command_plan, not call planCommandForSpace directly`);
  }
  const literals = stringLiterals(worldAst, planCommandNow.body).map((entry) => entry.text);
  if (literals.includes("$match") || literals.includes("plan_command")) {
    failures.push(`${worldPath}: planCommandNow must not target $match:plan_command directly`);
  }
  if (!literals.includes("command_plan")) {
    failures.push(`${worldPath}: planCommandNow must dispatch the active space :command_plan wrapper`);
  }
}

const planRemoteCommandNow = methodNamed(worldAst, "planRemoteCommandNow");
if (!planRemoteCommandNow?.body) {
  failures.push(`${worldPath}: could not locate planRemoteCommandNow for command-planning guard`);
} else {
  const literals = stringLiterals(worldAst, planRemoteCommandNow.body).map((entry) => entry.text);
  if (literals.includes("$match") || literals.includes("plan_command")) {
    failures.push(`${worldPath}: planRemoteCommandNow must not target $match:plan_command directly`);
  }
  if (!literals.includes("command_plan")) {
    failures.push(`${worldPath}: planRemoteCommandNow must resolve the active space :command_plan wrapper`);
  }
  let directDispatches = 0;
  let sharedFrameCalls = 0;
  let directHelperCalls = 0;
  let parserCalls = 0;
  let remoteMetadataLookups = 0;
  visit(planRemoteCommandNow.body, (node) => {
    const called = calledFunctionName(node);
    if (called === "dispatch") directDispatches += 1;
    if (called === "dispatchDirectCallFrame") sharedFrameCalls += 1;
    if (called === "planCommandForSpace") directHelperCalls += 1;
    if (called === "parseCommandMap") parserCalls += 1;
    if (called === "resolveVerb") remoteMetadataLookups += 1;
  });
  if (directDispatches > 0) {
    failures.push(`${worldPath}: planRemoteCommandNow must use dispatchDirectCallFrame instead of constructing its own dispatch frame`);
  }
  if (sharedFrameCalls !== 1) {
    failures.push(`${worldPath}: planRemoteCommandNow must delegate exactly once to dispatchDirectCallFrame, saw ${sharedFrameCalls}`);
  }
  if (directHelperCalls > 0 || parserCalls > 0) {
    failures.push(`${worldPath}: planRemoteCommandNow must stay metadata-driven and must not call parser helpers directly`);
  }
  if (remoteMetadataLookups < 1) {
    failures.push(`${worldPath}: planRemoteCommandNow must resolve remote command_plan metadata before dispatch`);
  }
}

const helperCalls = [];
visit(worldAst, (node) => {
  if (calledFunctionName(node) === "planCommandForSpace") helperCalls.push(node);
});
if (helperCalls.length !== 1) {
  failures.push(`${worldPath}: expected planCommandForSpace to be called only by the native plan_command primitive, saw ${helperCalls.length} call sites`);
}
for (const call of helperCalls) {
  if (!ancestor(call, isNativePlanCommandRegistration)) {
    failures.push(`${location(worldAst, call)}: planCommandForSpace may only be called inside nativeHandlers.set("plan_command", ...)`);
  }
}

for (const literal of stringLiterals(clientAst, clientAst)) {
  if (literal.text === "$match" || literal.text === "plan_command") {
    failures.push(`${location(clientAst, literal.node)}: browser command planning must call the room :command_plan wrapper, not $match:plan_command`);
  }
}

// Durable-presence drift guard. COMMAND_PLAN_DEFAULT_DURABLE_VERBS in world.ts
// is a *substrate fallback* that stamps `persistence: "durable"` on canonical
// movement/handling verbs when a (possibly stale) deployed slice is missing the
// verb's arg_spec.command.persistence hint. That fallback must never be what a
// BUNDLED catalog relies on: the manifest cell is the source of truth. This
// check fails if any verb named in the fallback set is defined in the chat
// manifest without self-declaring command.persistence — so authoring drift is
// caught at build time and the runtime list is only ever a genuine stale-slice
// net. See spec/semantics/match.md §MA7.
function durableFallbackVerbs(source) {
  let names = null;
  visit(source, (node) => {
    if (names || !ts.isVariableDeclaration(node)) return;
    if (!ts.isIdentifier(node.name) || node.name.text !== "COMMAND_PLAN_DEFAULT_DURABLE_VERBS") return;
    const init = node.initializer;
    if (!init || !ts.isNewExpression(init)) return;
    const arg = init.arguments?.[0];
    if (!arg || !ts.isArrayLiteralExpression(arg)) return;
    names = arg.elements
      .filter((el) => ts.isStringLiteral(el))
      .map((el) => el.text);
  });
  return names;
}

const fallbackVerbs = durableFallbackVerbs(worldAst);
if (!fallbackVerbs) {
  failures.push(`${worldPath}: could not parse COMMAND_PLAN_DEFAULT_DURABLE_VERBS for durable-presence drift guard`);
} else {
  const declaredPersistence = new Map(); // verb name -> definitions carrying command.persistence
  // Any bundled catalog can override a canonical movement verb. Scan every
  // manifest so a tool catalog (for example pinboard take/drop) cannot rely on
  // the substrate fallback while the chat catalog happens to be correct.
  for (const entry of readdirSync("catalogs")) {
    const manifestPath = join("catalogs", entry, "manifest.json");
    try {
      if (!statSync(manifestPath).isFile()) continue;
    } catch {
      continue;
    }
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    for (const holder of [...(manifest.classes ?? []), ...(manifest.features ?? [])]) {
      for (const verb of holder.verbs ?? []) {
        if (!verb?.name) continue;
        if (!declaredPersistence.has(verb.name)) declaredPersistence.set(verb.name, []);
        declaredPersistence.get(verb.name).push({
          manifestPath,
          persistence: verb.arg_spec?.command?.persistence ?? null
        });
      }
    }
  }
  const listOnly = [];
  for (const name of fallbackVerbs) {
    if (!declaredPersistence.has(name)) {
      listOnly.push(name); // in the fallback set but no chat verb resolves it (dead entry)
      continue;
    }
    for (const definition of declaredPersistence.get(name)) {
      if (definition.persistence !== "durable" && definition.persistence !== "live") {
        failures.push(`${definition.manifestPath}: movement/handling verb "${name}" is in COMMAND_PLAN_DEFAULT_DURABLE_VERBS but does not self-declare arg_spec.command.persistence — stamp it so the cell, not the substrate fallback, carries routing`);
      }
    }
  }
  if (listOnly.length > 0) {
    // Not a failure: these names cannot rely on the fallback because no verb
    // resolves them. Surface them so the dead list entries stay visible.
    console.log(`guard-command-planning: note — fallback verbs with no bundled definition (list-only): ${listOnly.join(", ")}`);
  }
}

// Room-roster-presence guard. A verb that invokes the compact owner roster
// (the `room_roster(this)` builtin or a `this:room_roster()` verb call) forces
// net planning to require the room-roster projection (plan.ts
// require_room_roster_projection). The gateway seeds that projection ONLY when
// the DISPATCHED verb declares `reads_room_presence: true`
// (callReadsRoomPresence resolves the dispatched verb's flag). A DISPATCHABLE
// verb (direct_callable or tool_exposed) that calls room_roster without the
// flag therefore hard-fails over the net path with a non-repairable
// E_INTERNAL "room roster projection missing" — a break invisible to
// in-process tests. Sub-dispatched internal verbs (not directly dispatchable)
// are exempt: they run inside a turn whose dispatched verb already seeded the
// projection.
for (const entry of readdirSync("catalogs")) {
  const manifestPath = join("catalogs", entry, "manifest.json");
  let manifest;
  try {
    if (!statSync(manifestPath).isFile()) continue;
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    continue;
  }
  for (const holder of [...(manifest.classes ?? []), ...(manifest.features ?? [])]) {
    for (const verb of holder.verbs ?? []) {
      const source = typeof verb?.source === "string" ? verb.source : "";
      // Strip the `verb :<name>(...)` signature so a verb NAMED room_roster is
      // not a false positive; check only the body for an invocation.
      const brace = source.indexOf("{");
      const body = brace === -1 ? "" : source.slice(brace);
      const dispatchable = verb.direct_callable === true || verb.tool_exposed === true;
      if (/room_roster\s*\(/.test(body) && dispatchable && verb.reads_room_presence !== true) {
        failures.push(`${manifestPath}: verb "${verb.name}" invokes room_roster but is dispatchable without reads_room_presence:true — the gateway will not seed the compact owner roster and the turn hard-fails E_INTERNAL "room roster projection missing" over the net path (set reads_room_presence:true, like chat :who/:enter/:say_to/:leave)`);
      }
      // The ordering analogue: a dispatchable verb that reads sibling order
      // (the `ordered_children(...)` builtin) forces net planning to require
      // the ordered-children projection; the gateway seeds it only when the
      // dispatched verb declares `reads_ordered_children: true`.
      if (/ordered_children\s*\(/.test(body) && dispatchable && verb.reads_ordered_children !== true) {
        failures.push(`${manifestPath}: verb "${verb.name}" invokes ordered_children but is dispatchable without reads_ordered_children:true — the gateway will not seed the ordered-children projection and the turn hard-fails E_INTERNAL "ordered-children projection missing" over the net path (set reads_ordered_children:true)`);
      }
    }
  }
}

if (failures.length > 0) {
  console.error("guard-command-planning failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("guard-command-planning: ok");
