#!/usr/bin/env node
// guard-command-planning — text-command planning must enter the normal catalog
// verb-dispatch path. Server/client conveniences may call `:command_plan`; only
// the native `$match:plan_command` primitive may call the parser helper itself.

import { readFileSync } from "node:fs";
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

if (failures.length > 0) {
  console.error("guard-command-planning failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("guard-command-planning: ok");
