#!/usr/bin/env node
// guard-command-planning — text-command planning must enter the normal catalog
// verb-dispatch path. Server/client conveniences may call `:command_plan`; only
// the native `$match:plan_command` primitive may call the parser helper itself.

import { readFileSync } from "node:fs";

const worldPath = "src/core/world.ts";
const clientPath = "src/client/main.ts";
const world = readFileSync(worldPath, "utf8");
const client = readFileSync(clientPath, "utf8");
const failures = [];

const planCommandNow = world.match(/private async planCommandNow[\s\S]*?\n  private async [A-Za-z0-9_]+/);
if (!planCommandNow) {
  failures.push(`${worldPath}: could not locate planCommandNow for command-planning guard`);
} else {
  const body = planCommandNow[0];
  if (body.includes("planCommandForSpace(")) {
    failures.push(`${worldPath}: planCommandNow must dispatch :command_plan, not call planCommandForSpace directly`);
  }
  if (body.includes('"$match"') || body.includes('"plan_command"')) {
    failures.push(`${worldPath}: planCommandNow must not target $match:plan_command directly`);
  }
}

const helperCallCount = [...world.matchAll(/planCommandForSpace\(/g)].length;
if (helperCallCount !== 2) {
  failures.push(`${worldPath}: expected planCommandForSpace only at the native primitive call and its definition, saw ${helperCallCount} references`);
}

if (client.includes('target: "$match"') || client.includes('verb: "plan_command"')) {
  failures.push(`${clientPath}: browser command planning must call the room :command_plan wrapper, not $match:plan_command`);
}

if (failures.length > 0) {
  console.error("guard-command-planning failed:");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log("guard-command-planning: ok");
