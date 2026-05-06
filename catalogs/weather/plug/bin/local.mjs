#!/usr/bin/env -S npx tsx
// Local-runnable weather plug.
//
// Reuses runLoggedWeatherTick from src/index.ts so the production CF Worker
// and a laptop run share one implementation: same fetch path, same logging
// shape, same error breadcrumbs. Only the trigger surface differs — Cloud
// Worker has cron + fetch; this script has setInterval + a single --once
// mode for manual smoke.
//
// Usage:
//   tsx bin/local.mjs            # loop on PLUG_INTERVAL_SEC (default 60s)
//   tsx bin/local.mjs --once     # one tick, then exit (exit code reflects ok)
//
// Env vars (or .env in the plug dir, loaded via `node --env-file`):
//   WOO_BASE_URL          required, e.g. http://localhost:5173 or https://woo.example
//   WOO_APIKEY            required, "apikey:<id>:<secret>" minted from $block:mint_apikey
//   TOMORROW_IO_API_KEY   required, your tomorrow.io key
//   BLOCK_ID              required, the weather block's object id
//   FORECAST_HOURS        optional, default 12
//   PLUG_INTERVAL_SEC     optional, default 60
//
// Run from this dir as: `npm run plug` or `npm run plug:once`.

import { runLoggedWeatherTick } from "../src/index.ts";

const REQUIRED = ["WOO_BASE_URL", "WOO_APIKEY", "TOMORROW_IO_API_KEY", "BLOCK_ID"];

function readEnv() {
  const env = {};
  const missing = [];
  for (const key of REQUIRED) {
    const value = process.env[key];
    if (!value) missing.push(key);
    else env[key] = value;
  }
  if (missing.length > 0) {
    console.error(`local plug: missing env vars: ${missing.join(", ")}`);
    console.error(`set them in the shell, or pass --env-file=.env to node/tsx`);
    process.exit(2);
  }
  if (process.env.FORECAST_HOURS) env.FORECAST_HOURS = process.env.FORECAST_HOURS;
  return env;
}

async function tick(env, label) {
  try {
    return await runLoggedWeatherTick(env, label);
  } catch {
    // runLoggedWeatherTick already emitted a tick_error breadcrumb. Swallow
    // here so the loop survives transient upstream failures; --once mode
    // surfaces failure as a non-zero exit code from the caller.
    return null;
  }
}

const args = new Set(process.argv.slice(2));
const once = args.has("--once");
const env = readEnv();
const intervalSec = Math.max(5, Number(process.env.PLUG_INTERVAL_SEC ?? 60));

const first = await tick(env, "fetch");
if (once) {
  process.exit(first ? 0 : 1);
}

console.log(JSON.stringify({ ts: new Date().toISOString(), event: "loop_start", interval_sec: intervalSec, block: env.BLOCK_ID }));
const handle = setInterval(() => { tick(env, "cron"); }, intervalSec * 1000);

function shutdown(signal) {
  console.log(JSON.stringify({ ts: new Date().toISOString(), event: "loop_stop", signal }));
  clearInterval(handle);
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
