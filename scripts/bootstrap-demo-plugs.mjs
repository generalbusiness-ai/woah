#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const PLUGS = {
  weather: {
    defaultBlock: "the_weather",
    defaultLabel: "weather-cf-worker-prod",
    dir: "catalogs/weather/plug",
    triggerUrlEnv: "WEATHER_PLUG_URL"
  },
  horoscope: {
    defaultBlock: "the_horoscope",
    defaultLabel: "horoscope-cf-worker-prod",
    dir: "catalogs/horoscope/plug",
    triggerUrlEnv: "HOROSCOPE_PLUG_URL"
  }
};

function usage() {
  return `Usage: npm run plugs:bootstrap -- [options]

Mints fresh woo apikeys bound to the demo weather/horoscope blocks, updates
public Wrangler vars, stores secrets, and optionally deploys/triggers the plug
Workers.

Environment:
  WOO_BASE_URL             Woo REST base URL.
  WOO_WIZARD_TOKEN         Preferred wizard REST token.
  WOO_APIKEY               Fallback wizard REST token.
  WOO_MCP_TOKEN            Fallback wizard REST token.
  TOMORROW_IO_API_KEY      Required for weather unless --only=horoscope.
  CLOUDFLARE_API_TOKEN     Optional; otherwise Wrangler's normal login is used.
  WEATHER_PLUG_URL         Optional; enables manual trigger after deploy.
  HOROSCOPE_PLUG_URL       Optional; enables manual trigger after deploy.
  WEATHER_TRIGGER_SECRET   Optional; otherwise generated for this run.
  HOROSCOPE_TRIGGER_SECRET Optional; otherwise generated for this run.

Options:
  --only=weather|horoscope|all   Select plugs. Default: all.
  --woo-base-url=<url>           Override WOO_BASE_URL.
  --wizard-token=<token>         Override wizard token env lookup.
  --tomorrow-io-api-key=<key>    Override TOMORROW_IO_API_KEY.
  --weather-block=<id>           Default: the_weather.
  --horoscope-block=<id>         Default: the_horoscope.
  --weather-label=<label>        Default: weather-cf-worker-prod.
  --horoscope-label=<label>      Default: horoscope-cf-worker-prod.
  --revoke-existing-labels       Revoke old unrevoked keys with matching actor+label after success.
  --no-deploy                    Store secrets but skip wrangler deploy.
  --no-trigger                   Skip manual POST trigger, even when URLs are set.
  --dry-run                      Print the plan without network or Wrangler writes.
  --help                         Show this help.
`;
}

function parseArgs(argv) {
  const opts = {
    only: "all",
    deploy: true,
    trigger: true,
    dryRun: false,
    revokeExistingLabels: false,
    weatherBlock: PLUGS.weather.defaultBlock,
    horoscopeBlock: PLUGS.horoscope.defaultBlock,
    weatherLabel: PLUGS.weather.defaultLabel,
    horoscopeLabel: PLUGS.horoscope.defaultLabel,
    wooBaseUrl: process.env.WOO_BASE_URL || "",
    wizardToken: process.env.WOO_WIZARD_TOKEN || process.env.WOO_APIKEY || process.env.WOO_MCP_TOKEN || "",
    tomorrowIoApiKey: process.env.TOMORROW_IO_API_KEY || "",
    weatherTriggerSecret: process.env.WEATHER_TRIGGER_SECRET || "",
    horoscopeTriggerSecret: process.env.HOROSCOPE_TRIGGER_SECRET || ""
  };

  for (const arg of argv) {
    if (arg === "--help" || arg === "-h") {
      console.log(usage());
      process.exit(0);
    } else if (arg === "--no-deploy") {
      opts.deploy = false;
    } else if (arg === "--no-trigger") {
      opts.trigger = false;
    } else if (arg === "--dry-run") {
      opts.dryRun = true;
    } else if (arg === "--revoke-existing-labels") {
      opts.revokeExistingLabels = true;
    } else if (arg.startsWith("--only=")) {
      opts.only = valueOf(arg);
    } else if (arg.startsWith("--woo-base-url=")) {
      opts.wooBaseUrl = valueOf(arg);
    } else if (arg.startsWith("--wizard-token=")) {
      opts.wizardToken = valueOf(arg);
    } else if (arg.startsWith("--tomorrow-io-api-key=")) {
      opts.tomorrowIoApiKey = valueOf(arg);
    } else if (arg.startsWith("--weather-block=")) {
      opts.weatherBlock = valueOf(arg);
    } else if (arg.startsWith("--horoscope-block=")) {
      opts.horoscopeBlock = valueOf(arg);
    } else if (arg.startsWith("--weather-label=")) {
      opts.weatherLabel = valueOf(arg);
    } else if (arg.startsWith("--horoscope-label=")) {
      opts.horoscopeLabel = valueOf(arg);
    } else if (arg.startsWith("--weather-trigger-secret=")) {
      opts.weatherTriggerSecret = valueOf(arg);
    } else if (arg.startsWith("--horoscope-trigger-secret=")) {
      opts.horoscopeTriggerSecret = valueOf(arg);
    } else {
      throw new Error(`unknown option: ${arg}\n\n${usage()}`);
    }
  }

  if (!["all", "weather", "horoscope"].includes(opts.only)) {
    throw new Error("--only must be one of: all, weather, horoscope");
  }
  opts.wooBaseUrl = stripTrailingSlash(opts.wooBaseUrl);
  opts.wizardToken = normalizeToken(opts.wizardToken);
  return opts;
}

function valueOf(arg) {
  return arg.slice(arg.indexOf("=") + 1);
}

function stripTrailingSlash(url) {
  return String(url || "").replace(/\/+$/, "");
}

function normalizeToken(token) {
  token = String(token || "").trim();
  if (token.startsWith("Bearer ")) return token.slice("Bearer ".length).trim();
  return token;
}

function selectedPlugs(opts) {
  if (opts.only === "all") return ["weather", "horoscope"];
  return [opts.only];
}

function blockFor(opts, plug) {
  return plug === "weather" ? opts.weatherBlock : opts.horoscopeBlock;
}

function labelFor(opts, plug) {
  return plug === "weather" ? opts.weatherLabel : opts.horoscopeLabel;
}

function triggerSecretFor(opts, plug) {
  const existing = plug === "weather" ? opts.weatherTriggerSecret : opts.horoscopeTriggerSecret;
  return existing || randomBytes(32).toString("base64url");
}

function validate(opts, plugs) {
  if (!opts.wooBaseUrl) throw new Error("missing WOO_BASE_URL; set env or pass --woo-base-url");
  if (!opts.dryRun && !opts.wizardToken) {
    throw new Error("missing wizard token; set WOO_WIZARD_TOKEN, WOO_APIKEY, or WOO_MCP_TOKEN");
  }
  if (plugs.includes("weather") && !opts.dryRun && !opts.tomorrowIoApiKey) {
    throw new Error("missing TOMORROW_IO_API_KEY; set env or pass --tomorrow-io-api-key");
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const plugs = selectedPlugs(opts);
  validate(opts, plugs);

  console.log(`woo: ${opts.wooBaseUrl}`);
  console.log(`plugs: ${plugs.join(", ")}`);
  console.log(`deploy: ${opts.deploy ? "yes" : "no"}`);
  console.log(`trigger: ${opts.trigger ? "yes" : "no"}`);
  console.log(`revoke existing labels: ${opts.revokeExistingLabels ? "yes" : "no"}`);

  if (opts.dryRun) {
    for (const plug of plugs) {
      console.log(`[dry-run] ${plug}: would mint key for ${blockFor(opts, plug)} label=${JSON.stringify(labelFor(opts, plug))}`);
      console.log(`[dry-run] ${plug}: would set WOO_BASE_URL and BLOCK_ID in ${PLUGS[plug].dir}/wrangler.toml`);
      console.log(`[dry-run] ${plug}: would store WOO_APIKEY and TRIGGER_SECRET as Wrangler secrets`);
      if (plug === "weather") console.log(`[dry-run] ${plug}: would store TOMORROW_IO_API_KEY`);
      if (opts.deploy) console.log(`[dry-run] ${plug}: would run wrangler deploy`);
      if (opts.trigger) console.log(`[dry-run] ${plug}: would trigger if ${PLUGS[plug].triggerUrlEnv} is set`);
    }
    return;
  }

  const wizard = await authenticate(opts.wooBaseUrl, opts.wizardToken);
  console.log(`authenticated: actor=${wizard.actor} token_class=${wizard.token_class}`);
  if (wizard.actor !== "$wiz") {
    console.warn("warning: token did not authenticate as $wiz; key minting may fail unless this actor owns the blocks");
  }

  const oldKeys = opts.revokeExistingLabels ? await listApiKeys(opts.wooBaseUrl, wizard.session) : [];
  const minted = [];
  for (const plug of plugs) {
    const block = blockFor(opts, plug);
    const label = labelFor(opts, plug);
    const key = await directCall(opts.wooBaseUrl, wizard.session, "$system", "create_api_key", [block, label]);
    const token = `apikey:${key.id}:${key.secret}`;
    const check = await authenticate(opts.wooBaseUrl, token);
    if (check.actor !== block || check.token_class !== "apikey") {
      throw new Error(`${plug}: minted key authenticated as actor=${check.actor} token_class=${check.token_class}, expected ${block}/apikey`);
    }
    minted.push({ plug, block, label, id: key.id, token, triggerSecret: triggerSecretFor(opts, plug) });
    console.log(`${plug}: minted key ${key.id} for ${block}`);
  }

  for (const item of minted) {
    const plug = PLUGS[item.plug];
    const cwd = path.join(ROOT, plug.dir);
    await setWranglerVars(cwd, { WOO_BASE_URL: opts.wooBaseUrl, BLOCK_ID: item.block });
    await putSecret(cwd, "WOO_APIKEY", item.token);
    await putSecret(cwd, "TRIGGER_SECRET", item.triggerSecret);
    if (item.plug === "weather") {
      await putSecret(cwd, "TOMORROW_IO_API_KEY", opts.tomorrowIoApiKey);
    }
  }

  if (opts.deploy) {
    for (const item of minted) {
      await run("npm", ["run", "deploy"], { cwd: path.join(ROOT, PLUGS[item.plug].dir) });
    }
  }

  if (opts.trigger) {
    for (const item of minted) {
      const url = stripTrailingSlash(process.env[PLUGS[item.plug].triggerUrlEnv] || "");
      if (!url) {
        console.log(`${item.plug}: skipped manual trigger; set ${PLUGS[item.plug].triggerUrlEnv} to enable it`);
        continue;
      }
      await triggerPlug(url, item.triggerSecret, item.plug);
    }
  }

  if (opts.revokeExistingLabels) {
    for (const item of minted) {
      const toRevoke = oldKeys.filter((key) =>
        key.actor === item.block &&
        key.label === item.label &&
        key.revoked_at == null &&
        key.id !== item.id
      );
      for (const key of toRevoke) {
        await directCall(opts.wooBaseUrl, wizard.session, "$system", "revoke_api_key", [key.id]);
        console.log(`${item.plug}: revoked old key ${key.id}`);
      }
    }
  }

  console.log("done");
}

async function authenticate(baseUrl, token) {
  return requestJson(baseUrl, "POST", "/api/auth", undefined, { token });
}

async function listApiKeys(baseUrl, session) {
  const body = await requestJson(baseUrl, "POST", "/api/objects/%24system/calls/list_api_keys", session, { args: [] });
  return Array.isArray(body.result) ? body.result : [];
}

async function directCall(baseUrl, session, target, verb, args) {
  const pathName = `/api/objects/${encodeURIComponent(target)}/calls/${encodeURIComponent(verb)}`;
  const body = await requestJson(baseUrl, "POST", pathName, session, { args });
  return body.result;
}

async function requestJson(baseUrl, method, pathname, session, body) {
  const headers = { "content-type": "application/json" };
  if (session) headers.authorization = `Session ${session}`;
  const response = await fetch(`${baseUrl}${pathname}`, {
    method,
    headers,
    body: JSON.stringify(body)
  });
  const text = await response.text();
  const parsed = text ? JSON.parse(text) : {};
  if (!response.ok) {
    const err = parsed.error || {};
    throw new Error(`${method} ${pathname} failed: ${err.code || response.status} ${err.message || response.statusText}`);
  }
  return parsed;
}

async function putSecret(cwd, name, value) {
  console.log(`${path.relative(ROOT, cwd)}: wrangler secret put ${name}`);
  await run("npm", ["exec", "--", "wrangler", "secret", "put", name], {
    cwd,
    input: `${value}\n`,
    redact: value
  });
}

async function setWranglerVars(cwd, vars) {
  const file = path.join(cwd, "wrangler.toml");
  let text = await readFile(file, "utf8");
  for (const [name, value] of Object.entries(vars)) {
    const line = `${name} = ${JSON.stringify(value)}`;
    const re = new RegExp(`^#?\\s*${escapeRegExp(name)}\\s*=.*$`, "m");
    if (re.test(text)) text = text.replace(re, line);
    else text = text.replace(/(\[vars\]\n)/, `$1${line}\n`);
  }
  await writeFile(file, text);
  console.log(`${path.relative(ROOT, file)}: set ${Object.keys(vars).join(", ")}`);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function triggerPlug(url, secret, plug) {
  const response = await fetch(`${url}/`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}` }
  });
  const text = await response.text();
  let parsed = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text.slice(0, 200) };
  }
  if (!response.ok) {
    throw new Error(`${plug}: manual trigger failed: HTTP ${response.status} ${JSON.stringify(parsed)}`);
  }
  console.log(`${plug}: manual trigger ok`);
}

async function run(command, args, options) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    child.stdout.on("data", (chunk) => process.stdout.write(redact(String(chunk), options.redact)));
    child.stderr.on("data", (chunk) => process.stderr.write(redact(String(chunk), options.redact)));
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${command} ${args.join(" ")} exited ${code}`));
    });
    if (options.input !== undefined) child.stdin.end(options.input);
    else child.stdin.end();
  });
}

function redact(text, secret) {
  if (!secret) return text;
  return text.split(secret).join("[redacted]");
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
