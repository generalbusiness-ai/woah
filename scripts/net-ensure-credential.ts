/**
 * Ensure one actor-owned Net API key through the internal-signed operator
 * route, keeping the replayable secret entirely on the operator machine.
 *
 * The candidate token is written to an owner-only file BEFORE the network
 * call. If the reply is lost after authority commits, rerunning this command
 * reuses the exact id/salt/hash tuple and receives idempotent success.
 *
 * Example:
 *   npm run credential:net-ensure -- \
 *     --actor the_weather \
 *     --authority-root the_weather \
 *     --name WEATHER_WOO_APIKEY
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { routedApiKeyId, routedApiKeyScope } from "../src/core/api-key-id";
import { hashSource, randomHex } from "../src/core/source-hash";
import { signInternalRequest } from "../src/worker/internal-auth";

type Args = {
  actor: string;
  authorityRoot: string;
  name: string;
  baseUrl: string;
  credentialFile: string;
  label: string;
};

function parseArgs(argv: string[], homeDir = homedir()): Args {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`expected --name value arguments; stopped at ${JSON.stringify(flag)}`);
    }
    values.set(flag.slice(2), value);
    index += 1;
  }
  const actor = values.get("actor") ?? "";
  const authorityRoot = values.get("authority-root") ?? actor;
  const name = values.get("name") ?? "";
  if (!actor || !authorityRoot || !/^[A-Z][A-Z0-9_]*$/.test(name)) {
    throw new Error("--actor, --authority-root, and uppercase shell-safe --name are required");
  }
  return {
    actor,
    authorityRoot,
    name,
    baseUrl: (values.get("base-url") ?? "https://woah1.generalbusiness.ai").replace(/\/+$/, ""),
    credentialFile: resolve(values.get("credential-file") ?? `${homeDir}/.config/generalbusiness/woo_net_credentials.env`),
    label: values.get("label") ?? `${actor} net credential`
  };
}

function shellValue(raw: string): string {
  const value = raw.trim().replace(/^export\s+/, "");
  const equals = value.indexOf("=");
  if (equals < 1) return "";
  let result = value.slice(equals + 1).trim();
  if (
    result.length >= 2 &&
    ((result.startsWith("'") && result.endsWith("'")) ||
      (result.startsWith('"') && result.endsWith('"')))
  ) result = result.slice(1, -1);
  return result;
}

function envFile(path: string): Record<string, string> {
  if (!existsSync(path)) return {};
  const values: Record<string, string> = {};
  for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const normalized = trimmed.replace(/^export\s+/, "");
    const equals = normalized.indexOf("=");
    if (equals < 1) continue;
    values[normalized.slice(0, equals).trim()] = shellValue(trimmed);
  }
  return values;
}

function quote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function ensurePrivateFile(path: string): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  if (!existsSync(path)) {
    writeFileSync(path, "# Woo Net credentials — replayable secrets; owner access only.\n", { mode: 0o600 });
  }
  chmodSync(path, 0o600);
  if ((statSync(path).mode & 0o077) !== 0) throw new Error(`credential file is not owner-only: ${path}`);
}

/** Replace the owner-only file atomically. The credential candidate must be
 * durable before the authority request: a dropped reply can then reuse the
 * exact verifier tuple instead of orphaning an unknowable secret. */
function appendPrivateBlock(path: string, block: string): void {
  const temp = `${path}.tmp-${process.pid}-${randomHex(8)}`;
  try {
    writeFileSync(temp, `${readFileSync(path, "utf8").replace(/\s*$/, "\n")}${block}`, {
      mode: 0o600,
      flag: "wx"
    });
    chmodSync(temp, 0o600);
    renameSync(temp, path);
  } catch (error) {
    if (existsSync(temp)) unlinkSync(temp);
    throw error;
  }
}

export async function ensureNetCredential(
  argv: string[],
  deps: {
    env?: Record<string, string | undefined>;
    homeDir?: string;
    fetch?: typeof fetch;
    log?: (message: string) => void;
  } = {}
): Promise<void> {
  const args = parseArgs(argv, deps.homeDir);
  ensurePrivateFile(args.credentialFile);
  const stored = envFile(args.credentialFile);
  const operatorEnvPath = `${deps.homeDir ?? homedir()}/.config/generalbusiness/cloudflare_woo.env`;
  const operatorEnv = envFile(operatorEnvPath);
  const internalSecret =
    deps.env?.WOO_INTERNAL_SECRET ??
    process.env.WOO_INTERNAL_SECRET ??
    stored.WOO_INTERNAL_SECRET ??
    operatorEnv.WOO_INTERNAL_SECRET;
  if (!internalSecret) {
    throw new Error(
      `WOO_INTERNAL_SECRET is absent from the environment, ${args.credentialFile}, and ${operatorEnvPath}`
    );
  }
  const tokenName = args.name;
  const saltName = `${args.name}_SALT`;
  const createdName = `${args.name}_CREATED_AT`;
  const scopeName = `${args.name}_AUTHORITY_SCOPE`;

  let token = stored[tokenName];
  let salt = stored[saltName];
  let createdAt = Number(stored[createdName]);
  let id = "";
  let secret = "";
  if (token) {
    const match = /^apikey:([^:]+):(.+)$/.exec(token);
    if (!match || !salt || !Number.isSafeInteger(createdAt)) {
      throw new Error(`existing ${tokenName} record is incomplete; refusing to overwrite ${args.credentialFile}`);
    }
    [, id, secret] = match;
  } else {
    id = routedApiKeyId(args.authorityRoot, args.actor, randomHex(16));
    secret = randomHex(32);
    salt = randomHex(16);
    createdAt = Date.now();
    token = `apikey:${id}:${secret}`;
    const scope = routedApiKeyScope(id);
    appendPrivateBlock(
      args.credentialFile,
      [
        `# ${args.actor}: generated ${new Date(createdAt).toISOString()}`,
        `${tokenName}=${quote(token)}`,
        `${saltName}=${quote(salt)}`,
        `${createdName}=${quote(String(createdAt))}`,
        `${scopeName}=${quote(scope ?? "")}`,
        ""
      ].join("\n")
    );
    chmodSync(args.credentialFile, 0o600);
  }

  const scope = routedApiKeyScope(id);
  if (!scope || (scope !== `cluster:${args.authorityRoot}` && scope !== "catalog")) {
    throw new Error("stored credential id does not match the requested authority root");
  }
  const record = {
    hash: hashSource(`${salt}:${secret}`),
    salt,
    actor: args.actor,
    label: args.label,
    created_at: createdAt
  };
  const unsigned = new Request(`${args.baseUrl}/net-operator/credentials/ensure`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      authority_scope: scope,
      actor: args.actor,
      id,
      record
    })
  });
  const response = await (deps.fetch ?? fetch)(
    await signInternalRequest({ WOO_INTERNAL_SECRET: internalSecret }, unsigned)
  );
  const body = await response.text();
  if (!response.ok) throw new Error(`credential ensure failed: ${response.status} ${body}`);
  const result = JSON.parse(body) as { ok?: unknown; actor?: unknown; id?: unknown; status?: unknown };
  if (result.ok !== true || result.actor !== args.actor || result.id !== id) {
    throw new Error(`credential ensure returned an invalid receipt: ${body}`);
  }
  const log = deps.log ?? console.log;
  log(`credential ensured for ${args.actor} (${String(result.status)})`);
  log(`credential stored owner-only at ${args.credentialFile}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await ensureNetCredential(process.argv.slice(2));
}
