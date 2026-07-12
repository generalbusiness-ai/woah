import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const assets = readdirSync("dist/assets").sort();
const forbiddenNames = assets.filter((name) => name.includes("v2-browser-worker"));
if (forbiddenNames.length > 0) {
  throw new Error(`net-only build emitted legacy browser worker assets: ${forbiddenNames.join(", ")}`);
}

// Vite may change chunk naming; inspect emitted JavaScript too so a renamed
// worker cannot make the filename check pass accidentally.
const forbiddenMarker = "woo-v2.turn-network.json";
const markerFiles = assets.filter((name) => name.endsWith(".js") && readFileSync(join("dist/assets", name), "utf8").includes(forbiddenMarker));
if (markerFiles.length > 0) {
  throw new Error(`net-only build still contains the v2 browser transport marker: ${markerFiles.join(", ")}`);
}

console.log(`net-only client deletion gate: ${assets.length} assets, no v2 browser worker`);
