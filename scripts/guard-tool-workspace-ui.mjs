// Tool workspace UI guard: keep first-party `$space` tools on the shared
// workspace/minichat path. A `space-workspace` frame whose subject is not the
// chatroom itself must declare a main region and the shared mini-chat region.
//
// Run via `npm run guard:tool-workspace-ui` or as part of `npm test`.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const catalogsRoot = join(root, "catalogs");
const mainTsPath = join(root, "src/client/main.ts");
const errors = [];
let auditedFrames = 0;
const movementManagedSubjects = new Set(["$pinboard", "$outliner", "$dubspace"]);
const movementForbiddenVerbs = new Set(["enter", "leave", "out"]);
const suppressedInheritedLifecycleTools = ["enter", "leave"];

const dirs = readdirSync(catalogsRoot)
  .map((name) => join(catalogsRoot, name))
  .filter((path) => {
    try {
      return statSync(join(path, "manifest.json")).isFile();
    } catch {
      return false;
    }
  })
  .sort();

function rel(path) {
  return relative(root, path).replaceAll("\\", "/");
}

function isChatroomFrame(frame) {
  return frame?.subject === "$chatroom";
}

function nodeComponent(node) {
  return typeof node?.component === "string" ? node.component : "";
}

function hasSharedMiniChat(frame) {
  const chat = Array.isArray(frame?.regions?.chat) ? frame.regions.chat : [];
  return chat.some((node) => nodeComponent(node) === "chat:chat.space-mini");
}

function hasMainRegion(frame) {
  return Array.isArray(frame?.regions?.main) && frame.regions.main.length > 0;
}

function classByLocalName(manifest, localName) {
  return (manifest.classes ?? []).find((cls) => cls?.local_name === localName);
}

for (const dir of dirs) {
  const manifestPath = join(dir, "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (err) {
    errors.push(`${rel(manifestPath)}: cannot parse JSON (${err.message})`);
    continue;
  }

  const frames = Array.isArray(manifest.ui?.frames) ? manifest.ui.frames : [];
  for (const frame of frames) {
    if (frame?.layout !== "space-workspace") continue;
    if (isChatroomFrame(frame)) continue;

    auditedFrames += 1;
    const where = `${rel(manifestPath)} frame ${JSON.stringify(frame.id ?? frame.subject ?? "<unnamed>")}`;
    if (!hasMainRegion(frame)) {
      errors.push(`${where}: space-workspace tool frames must declare regions.main`);
    }
    if (!hasSharedMiniChat(frame)) {
      errors.push(`${where}: space-workspace tool frames must declare regions.chat with chat:chat.space-mini`);
    }
  }

  for (const subject of movementManagedSubjects) {
    const cls = classByLocalName(manifest, subject);
    if (!cls) continue;
    const where = `${rel(manifestPath)} class ${subject}`;
    if (cls.parent !== "$room" && cls.parent !== "chat:$room") {
      errors.push(`${where}: movement-managed tool spaces must inherit $room for the exit graph`);
    }
    for (const verb of cls.verbs ?? []) {
      if (movementForbiddenVerbs.has(verb?.name)) {
        errors.push(`${where}: must not define public lifecycle verb ${JSON.stringify(verb.name)}`);
      }
    }
    let suppressedInheritedTools = null;
    for (const prop of cls.properties ?? []) {
      if (prop?.name === "suppressed_inherited_tools") suppressedInheritedTools = prop;
      if (subject === "$dubspace" && prop?.name === "operators") {
        errors.push(`${where}: dubspace authority must derive from presence, not an operators property`);
      }
    }
    const suppressedDefaults = Array.isArray(suppressedInheritedTools?.default) ? suppressedInheritedTools.default : [];
    for (const verb of suppressedInheritedLifecycleTools) {
      if (!suppressedDefaults.includes(verb)) {
        errors.push(`${where}: must suppress inherited ${JSON.stringify(verb)} from the MCP tool surface`);
      }
    }
  }
}

let mainTs = "";
try {
  mainTs = readFileSync(mainTsPath, "utf8");
} catch (err) {
  errors.push(`${rel(mainTsPath)}: cannot read app shell source (${err.message})`);
}

if (mainTs) {
  const requiredHostMarkers = [
    "function renderGenericToolWorkspace",
    "function mountGenericToolComponent",
    "data-generic-tool-workspace",
    "TOOL_TAB_DEFINITIONS"
  ];
  for (const marker of requiredHostMarkers) {
    if (!mainTs.includes(marker)) errors.push(`${rel(mainTsPath)}: missing generic tool host marker ${JSON.stringify(marker)}`);
  }
  const legacyRenderBranches = [
    "function renderDubspace(",
    "function renderPinboard(",
    "function renderTasks(",
    "function renderOutliner("
  ];
  for (const marker of legacyRenderBranches) {
    if (mainTs.includes(marker)) errors.push(`${rel(mainTsPath)}: catalog-specific workspace renderer ${JSON.stringify(marker)} must use the generic tool host`);
  }
  const legacyLifecycleMarkers = [
    "woo-pinboard-enter",
    "woo-pinboard-leave",
    "woo-dubspace-enter",
    "leavePinboard(",
    "leaveDubspace(",
    "leaveOutliner(",
    "dubspaceOperators("
  ];
  for (const marker of legacyLifecycleMarkers) {
    if (mainTs.includes(marker)) errors.push(`${rel(mainTsPath)}: stale tool lifecycle/operator marker ${JSON.stringify(marker)}`);
  }
}

if (errors.length > 0) {
  console.error("Tool workspace UI contract violation.");
  console.error("Interactive tool frames use layout: \"space-workspace\" and must");
  console.error("follow the shared workspace/minichat pattern. See docs/reference/tool-ui.md.");
  console.error("");
  for (const error of errors) console.error(`  ${error}`);
  process.exit(1);
}

console.log(`tool workspace UI: ok (${auditedFrames} space-workspace tool frames audited)`);
