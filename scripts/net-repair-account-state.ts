/**
 * Bounded historical native-exception repair for one Net account authority.
 *
 * Dry-run is the default; `--apply` is the explicit reviewed second step. The
 * authority derives replacements from its own cells; this driver supplies
 * only addressing facts and cannot choose a counter, flag, feature,
 * credential, or object disposition.
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { signInternalRequest } from "../src/worker/internal-auth";

type Args = {
  baseUrl: string;
  authorityScope: string;
  account: string;
  human: string;
  candidates: string[];
  apply: boolean;
};

export function parseAccountRepairArgs(argv: string[]): Args {
  const values = new Map<string, string>();
  const valueFlags = new Set(["--base-url", "--authority-scope", "--account", "--human", "--candidate"]);
  const candidates: string[] = [];
  let apply = false;
  let explicitDryRun = false;
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--dry-run") {
      explicitDryRun = true;
      continue;
    }
    if (flag === "--apply") {
      apply = true;
      continue;
    }
    if (!flag || !valueFlags.has(flag)) {
      throw new Error(`unknown account-repair argument: ${flag}`);
    }
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`expected --name value arguments; stopped at ${JSON.stringify(flag)}`);
    }
    if (flag === "--candidate") candidates.push(value);
    else values.set(flag.slice(2), value);
    index += 1;
  }
  const authorityScope = values.get("authority-scope") ?? "";
  const account = values.get("account") ?? "";
  const human = values.get("human") ?? "";
  if (!authorityScope.startsWith("cluster:") || !account || !human) {
    throw new Error("--authority-scope cluster:<root>, --account, and --human are required");
  }
  if (apply && explicitDryRun) throw new Error("--dry-run and --apply are mutually exclusive");
  if (candidates.length > 256) throw new Error("at most 256 explicit --candidate objects may be inspected");
  return {
    baseUrl: (values.get("base-url") ?? "https://woah1.generalbusiness.ai").replace(/\/+$/, ""),
    authorityScope,
    account,
    human,
    candidates: [...new Set(candidates)],
    apply
  };
}

function internalSecret(homeDir = homedir()): string {
  if (process.env.WOO_INTERNAL_SECRET) return process.env.WOO_INTERNAL_SECRET;
  const path = `${homeDir}/.config/generalbusiness/cloudflare_woo.env`;
  if (existsSync(path)) {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?WOO_INTERNAL_SECRET\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const raw = (match[1] ?? "").trim();
      const value = raw.length >= 2 && (
        (raw.startsWith("'") && raw.endsWith("'")) ||
        (raw.startsWith('"') && raw.endsWith('"'))
      ) ? raw.slice(1, -1) : raw;
      if (value) return value;
    }
  }
  throw new Error("WOO_INTERNAL_SECRET is required (environment or cloudflare_woo.env)");
}

export async function repairNetAccountState(
  argv: string[],
  deps: {
    fetch?: typeof fetch;
    secret?: string;
    log?: (message: string) => void;
  } = {}
): Promise<Record<string, unknown>> {
  const args = parseAccountRepairArgs(argv);
  const request = new Request(`${args.baseUrl}/net-operator/account/repair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      authority_scope: args.authorityScope,
      account: args.account,
      human: args.human,
      candidates: args.candidates,
      dry_run: !args.apply
    })
  });
  const response = await (deps.fetch ?? fetch)(
    await signInternalRequest({ WOO_INTERNAL_SECRET: deps.secret ?? internalSecret() }, request)
  );
  const text = await response.text();
  const result = text ? JSON.parse(text) as Record<string, unknown> : {};
  if (!response.ok) {
    if (result.status === "conflict") {
      throw new Error(`account repair conflicts require operator disposition: ${text}`);
    }
    throw new Error(`account repair failed: ${response.status} ${text}`);
  }
  (deps.log ?? console.log)(`${args.apply ? "account repair apply" : "account repair dry-run"}: ${text}`);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await repairNetAccountState(process.argv.slice(2));
}
