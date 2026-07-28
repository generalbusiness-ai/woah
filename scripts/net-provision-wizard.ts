/**
 * AP11 — provision a usable wizard on a deployed net world.
 *
 * A deployed world's only wizard is the catalog seed `$wiz`, which cannot plan
 * a client turn at all (its anchor classifies as `catalog`). This driver mints
 * a NON-`$` wizard-flagged, programmer-surfaced agent anchored under an
 * existing human account, then hands it a credential the operator generated
 * locally. See spec/identity/provisioning.md §AP11.
 *
 * Three internal-signed calls, each independently idempotent:
 *
 *   1. POST /net-operator/wizard/provision  -> returns the agent id.
 *      Idempotent on `--provision-id`; re-running returns the same agent and
 *      moves no counter.
 *   2. POST /net-operator/credentials/ensure (via net-ensure-credential) ->
 *      installs the salted verifier. The secret is generated HERE and written
 *      to the owner-only credential file BEFORE the network call, so a lost
 *      reply replays the exact tuple instead of orphaning a secret.
 *   3. POST /net-operator/wizard/provision again, now carrying `api_key_id`,
 *      so the agent's key pointer names the credential the operator holds.
 *
 * Step 2 cannot precede step 1: a routed api-key id embeds the actor it is
 * bound to, and the actor does not exist until step 1 commits.
 *
 * Example:
 *   WOO_INTERNAL_SECRET=... npm run provision:net-wizard -- \
 *     --base-url https://woah1.generalbusiness.ai \
 *     --human human_2 \
 *     --provision-id ops-wizard-1 \
 *     --name OpsWizard \
 *     --credential-name OPS_WIZARD_WOO_APIKEY
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { signInternalRequest } from "../src/worker/internal-auth";
import { ensureNetCredential } from "./net-ensure-credential";

type Args = {
  baseUrl: string;
  human: string;
  anchorId: string;
  probe: boolean;
  provisionId: string;
  name: string;
  purpose: string;
  credentialName: string;
  credentialFile: string;
  skipCredential: boolean;
};

function parseArgs(argv: string[], homeDir = homedir()): Args {
  const values = new Map<string, string>();
  const flags = new Set<string>();
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (!flag?.startsWith("--")) throw new Error(`expected --name value arguments; stopped at ${JSON.stringify(flag)}`);
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      flags.add(flag.slice(2));
      continue;
    }
    values.set(flag.slice(2), value);
    index += 1;
  }
  const anchorId = values.get("anchor-id") ?? "";
  const probe = flags.has("probe");
  // --human and --anchor-id are alternatives: name an EXISTING human, or name
  // an operator anchor token and let the driver seed/reuse the identity it
  // derives. A fresh net world has no human at all (the install plan seeds
  // none), so --anchor-id is the normal case there.
  const human = values.get("human") ?? "";
  const provisionId = values.get("provision-id") ?? "";
  const name = values.get("name") ?? provisionId;
  const credentialName = values.get("credential-name") ?? "";
  const skipCredential = flags.has("skip-credential");
  if (!human && !anchorId) {
    throw new Error("one of --human (an existing human actor) or --anchor-id (seed/reuse an operator anchor) is required");
  }
  if (human && anchorId) throw new Error("--human and --anchor-id are alternatives; pass exactly one");
  if (human && human.startsWith("$")) {
    throw new Error("--human must name a concrete (non-$) human actor; $wiz is exactly the identity this op exists to replace");
  }
  if (anchorId && !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(anchorId)) {
    throw new Error("--anchor-id must be 1..128 chars of [A-Za-z0-9._:-]");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(provisionId)) {
    throw new Error("--provision-id is required: 1..128 chars of [A-Za-z0-9._:-]");
  }
  if (!probe && !skipCredential && !/^[A-Z][A-Z0-9_]*$/.test(credentialName)) {
    throw new Error("--credential-name must be an uppercase shell-safe env name (or pass --skip-credential)");
  }
  return {
    baseUrl: (values.get("base-url") ?? "https://woah1.generalbusiness.ai").replace(/\/+$/, ""),
    human,
    anchorId,
    probe,
    provisionId,
    name,
    purpose: values.get("purpose") ?? "operator-provisioned wizard",
    credentialName,
    credentialFile: resolve(values.get("credential-file") ?? `${homeDir}/.config/generalbusiness/woo_net_credentials.env`),
    skipCredential
  };
}

/** The same secret lookup order net-ensure-credential uses, so one operator
 * environment drives both halves of the runbook. */
function internalSecret(homeDir: string, credentialFile: string): string {
  const fromEnv = process.env.WOO_INTERNAL_SECRET;
  if (fromEnv) return fromEnv;
  for (const path of [credentialFile, `${homeDir}/.config/generalbusiness/cloudflare_woo.env`]) {
    if (!existsSync(path)) continue;
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const match = /^\s*(?:export\s+)?WOO_INTERNAL_SECRET\s*=\s*(.*)$/.exec(line);
      if (!match) continue;
      const raw = (match[1] ?? "").trim();
      const unquoted = raw.length >= 2 && ((raw.startsWith("'") && raw.endsWith("'")) || (raw.startsWith('"') && raw.endsWith('"')))
        ? raw.slice(1, -1)
        : raw;
      if (unquoted) return unquoted;
    }
  }
  throw new Error("WOO_INTERNAL_SECRET is required (environment, credential file, or cloudflare_woo.env)");
}

type ProvisionResult = {
  actor_id: string;
  account: string;
  created: boolean;
  promoted: boolean;
  flagged: boolean;
  api_key_id: string | null;
  agent_quota: number;
  agent_count: number;
  programmer_grant_quota: number;
  programmer_agent_count: number;
};

async function postSigned(url: string, secret: string, payload: unknown, doFetch: typeof fetch): Promise<Record<string, unknown>> {
  const request = new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  const response = await doFetch(await signInternalRequest({ WOO_INTERNAL_SECRET: secret }, request));
  const body = await response.text();
  if (!response.ok) throw new Error(`${url} failed: ${response.status} ${body}`);
  return JSON.parse(body) as Record<string, unknown>;
}

/** Seed (or find) the operator anchor identity this provisioning will hang
 * from. A fresh net world seeds no `$human` at all, so without this the whole
 * runbook has nothing to anchor to. Idempotent on the token. */
async function ensureAnchor(args: Args, secret: string, doFetch: typeof fetch, log: (m: string) => void): Promise<string> {
  const receipt = await postSigned(`${args.baseUrl}/net-operator/identity/anchor`, secret, {
    anchor_id: args.anchorId,
    label: `operator anchor ${args.anchorId}`
  }, doFetch);
  const human = typeof receipt.human === "string" ? receipt.human : "";
  if (receipt.ok !== true || !human) throw new Error(`identity anchor returned an invalid receipt: ${JSON.stringify(receipt)}`);
  log(`anchor ${human} (account ${String(receipt.account)}) ${receipt.created === true ? "created" : "already present"}`);
  return human;
}

async function postProvision(
  args: Args,
  secret: string,
  apiKeyId: string | null,
  doFetch: typeof fetch
): Promise<ProvisionResult> {
  const parsed = await postSigned(`${args.baseUrl}/net-operator/wizard/provision`, secret, {
    human: args.human,
    provision_id: args.provisionId,
    name: args.name,
    purpose: args.purpose,
    ...(apiKeyId ? { api_key_id: apiKeyId } : {})
  }, doFetch) as { ok?: unknown; result?: ProvisionResult };
  if (parsed.ok !== true || !parsed.result || typeof parsed.result.actor_id !== "string") {
    throw new Error(`wizard provision returned an invalid receipt: ${JSON.stringify(parsed)}`);
  }
  return parsed.result;
}

export async function provisionNetWizard(
  argv: string[],
  deps: { homeDir?: string; fetch?: typeof fetch; log?: (message: string) => void } = {}
): Promise<ProvisionResult> {
  const homeDir = deps.homeDir ?? homedir();
  const args = parseArgs(argv, homeDir);
  const doFetch = deps.fetch ?? fetch;
  const log = deps.log ?? console.log;
  const secret = internalSecret(homeDir, args.credentialFile);

  // Step 0 — the anchor. A fresh net world seeds no `$human`, so when the
  // operator names a token instead of an existing actor, seed/reuse it first.
  if (args.anchorId) args.human = await ensureAnchor(args, secret, doFetch, log);

  // A read-only report: what does the world hold, and what should run next?
  // The only way to tell "no human" from "no primitive" without mutating.
  if (args.probe) {
    const receipt = await postSigned(`${args.baseUrl}/net-operator/wizard/provision`, secret, {
      human: args.human,
      provision_id: args.provisionId,
      probe: true
    }, doFetch);
    log(JSON.stringify(receipt, null, 2));
    return receipt as unknown as ProvisionResult;
  }

  // Step 1 — mint (or converge on) the agent.
  const provisioned = await postProvision(args, secret, null, doFetch);
  log(
    `provisioned ${provisioned.actor_id} under ${args.human}/${provisioned.account} ` +
    `(created=${provisioned.created} promoted=${provisioned.promoted} flagged=${provisioned.flagged})`
  );
  log(
    `account counters: agents ${provisioned.agent_count}/${provisioned.agent_quota}, ` +
    `programmers ${provisioned.programmer_agent_count}/${provisioned.programmer_grant_quota}`
  );
  if (args.skipCredential) return provisioned;

  // Step 2 — the credential, generated locally and durable before the call.
  await ensureNetCredential(
    [
      "--actor", provisioned.actor_id,
      "--authority-root", args.human,
      "--name", args.credentialName,
      "--base-url", args.baseUrl,
      "--credential-file", args.credentialFile,
      "--label", `${args.provisionId} operator wizard`
    ],
    { env: { WOO_INTERNAL_SECRET: secret }, homeDir, ...(deps.fetch ? { fetch: deps.fetch } : {}), log }
  );

  // Step 3 — record the pointer. Re-runs the same idempotent op, so it creates
  // nothing; it only makes the agent's api_key_id name the operator's key.
  const stored = readFileSync(args.credentialFile, "utf8");
  const tokenLine = stored.split(/\r?\n/).find((line) => line.trim().startsWith(`${args.credentialName}=`));
  const token = tokenLine?.slice(tokenLine.indexOf("=") + 1).trim().replace(/^['"]|['"]$/g, "") ?? "";
  const apiKeyId = /^apikey:([^:]+):/.exec(token)?.[1] ?? "";
  if (!apiKeyId) throw new Error(`could not read ${args.credentialName} back from ${args.credentialFile}`);
  const final = await postProvision(args, secret, apiKeyId, doFetch);
  log(`credential ${apiKeyId} recorded on ${final.actor_id}`);
  log(`present it as: Authorization: Bearer $${args.credentialName}`);
  return final;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  provisionNetWizard(process.argv.slice(2)).catch((error) => {
    console.error(String(error));
    process.exit(1);
  });
}
