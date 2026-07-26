#!/usr/bin/env node
// guard:smoke-mcp-args — the smoke scripts may only pass MCP tool arguments the
// gateway's validator still accepts.
//
// The smoke lanes are the only place these argument values are written by hand:
// everything else reaches the gateway through a typed call site. So when a
// validator drops an accepted value, TypeScript says nothing, `npm test` says
// nothing, and the break surfaces only when someone runs a workerd or deployed
// lane — where it reads as a world/movement failure rather than a rejected
// argument. That is exactly how `scope: "all"` survived its own removal commit
// (f0edc163 updated the docs and one test, not the four smoke callers) and left
// the shared MCP walkthrough failing on main.
//
// The check is deliberately narrow: parse the accepted literals straight out of
// the validator in gateway-do.ts, then assert every `scope: "..."` literal the
// smoke scripts pass to woo_list_reachable_tools is in that set. No allowlist —
// if the validator changes, this fails until the callers are updated with it.

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const GATEWAY = "src/worker/net/gateway-do.ts";
const SMOKE_ROOTS = ["scripts"];

/** The scope literals mcpToolScope() accepts, read from its own source so the
 * guard cannot drift from the validator it is guarding. */
function acceptedScopes(text) {
  const fn = /function mcpToolScope\([\s\S]*?\n}/.exec(text);
  if (!fn) throw new Error(`could not find mcpToolScope() in ${GATEWAY}`);
  const scopes = new Set();
  for (const m of fn[0].matchAll(/value === "([a-z_]+)"/g)) scopes.add(m[1]);
  // The default branch accepts absence; the returned default names itself.
  for (const m of fn[0].matchAll(/return "([a-z_]+)"/g)) scopes.add(m[1]);
  if (scopes.size === 0) throw new Error("mcpToolScope() exposed no accepted scope literals");
  return scopes;
}

function* walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (entry === "node_modules") continue;
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) yield* walk(path);
    // Guards quote the very literals they reject; scanning them finds only
    // their own error strings.
    else if (/\.(ts|mts|mjs|js)$/.test(entry) && !entry.startsWith("guard-")) yield path;
  }
}

function main() {
  const accepted = acceptedScopes(readFileSync(resolve(process.cwd(), GATEWAY), "utf8"));
  const problems = [];
  let checked = 0;

  for (const root of SMOKE_ROOTS) {
    for (const file of walk(resolve(process.cwd(), root))) {
      const text = readFileSync(file, "utf8");
      if (!text.includes("woo_list_reachable_tools")) continue;
      const lines = text.split("\n");
      lines.forEach((line, index) => {
        for (const m of line.matchAll(/\bscope:\s*"([^"]*)"/g)) {
          checked += 1;
          if (!accepted.has(m[1])) {
            problems.push(
              `${file}:${index + 1} passes scope: "${m[1]}" — mcpToolScope() accepts only ` +
              `${[...accepted].sort().map((s) => `"${s}"`).join(", ")}`
            );
          }
        }
      });
    }
  }

  if (problems.length > 0) {
    console.error(
      "guard:smoke-mcp-args: a smoke script passes an MCP tool argument the gateway rejects:\n" +
      problems.map((p) => `  ${p}`).join("\n") +
      "\nUpdate the caller to a currently accepted value (a retired scope's replacement is " +
      "whatever the removal commit says it was equivalent to)."
    );
    process.exitCode = 1;
    return;
  }
  console.log(
    `guard:smoke-mcp-args: ok — ${checked} scope literal(s) in the smoke scripts are accepted by ` +
    `mcpToolScope() (${[...accepted].sort().join(", ")})`
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (err) {
    console.error(`guard:smoke-mcp-args: ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
  }
}
