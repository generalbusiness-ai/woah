/**
 * Reclaim a disposable Net canary, including its Durable Object namespaces.
 *
 * `wrangler delete` alone removes the Worker but is not the class-lifecycle
 * operation that destroys Durable Object storage. This tool first deploys a
 * tombstone-only revision with `deleted_classes`, then removes the Worker and
 * its dedicated KV namespace. It is dry-run by default and requires an exact
 * worker+KV confirmation string for irreversible execution.
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

function value(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
}

export function assertDisposableCanaryName(worker: string): void {
  const segments = worker.split("-");
  if (!/^[a-z0-9][a-z0-9-]*$/.test(worker) || segments.length < 2 || !segments.includes("canary")) {
    throw new Error(`refusing non-canary Worker name ${JSON.stringify(worker)}`);
  }
  if (worker === "woah" || worker === "woah-prod" || worker === "woah-production") {
    throw new Error(`refusing protected production Worker ${JSON.stringify(worker)}`);
  }
}

export function canaryCleanupConfig(input: {
  worker: string;
  accountId: string;
  templateText: string;
}): { text: string; deletedClasses: string[] } {
  assertDisposableCanaryName(input.worker);
  if (!/^[a-f0-9]{32}$/.test(input.accountId)) throw new Error("CF_ACCOUNT_ID must be a 32-character lowercase hex id");
  const migrationsAt = input.templateText.indexOf("[[migrations]]");
  if (migrationsAt < 0) throw new Error("canary template has no Durable Object migration history");
  const migrations = input.templateText.slice(migrationsAt).trim();
  const deletedClasses = [...new Set(
    [...migrations.matchAll(/new_sqlite_classes\s*=\s*\[([^\]]*)\]/g)]
      .flatMap((match) => [...match[1].matchAll(/"([A-Za-z0-9_]+)"/g)].map((entry) => entry[1]))
  )].sort();
  if (deletedClasses.length === 0) throw new Error("canary template declares no SQLite Durable Object classes");
  const text = [
    `name = ${JSON.stringify(input.worker)}`,
    `account_id = ${JSON.stringify(input.accountId)}`,
    'main = "./retired.mjs"',
    'compatibility_date = "2026-08-02"',
    "workers_dev = true",
    "",
    migrations,
    "",
    "[[migrations]]",
    'tag = "canary-storage-cleanup-v1"',
    `deleted_classes = ${JSON.stringify(deletedClasses)}`,
    ""
  ].join("\n");
  return { text, deletedClasses };
}

function run(command: string, args: string[]): void {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.join(" ")} exited ${result.status ?? "without status"}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const worker = value(args, "--worker") ?? "";
  const kvNamespaceId = value(args, "--kv-namespace-id") ?? "";
  const templatePath = resolve(value(args, "--template") ?? "wrangler.net-canary.template.toml");
  const accountId = process.env.CF_ACCOUNT_ID ?? "";
  assertDisposableCanaryName(worker);
  if (!/^[a-f0-9]{32}$/.test(kvNamespaceId)) throw new Error("--kv-namespace-id must be a 32-character lowercase hex id");
  const generated = canaryCleanupConfig({
    worker,
    accountId,
    templateText: readFileSync(templatePath, "utf8")
  });
  const execute = args.includes("--execute");
  const expectedConfirmation = `${worker}:${kvNamespaceId}`;
  if (execute && value(args, "--confirm") !== expectedConfirmation) {
    throw new Error(`--execute requires --confirm ${expectedConfirmation}`);
  }

  const directory = mkdtempSync(join(tmpdir(), "woo-net-canary-cleanup-"));
  const configPath = join(directory, "wrangler.cleanup.toml");
  try {
    writeFileSync(configPath, generated.text);
    writeFileSync(join(directory, "retired.mjs"), "export default { fetch() { return new Response('retired', { status: 410 }); } };\n");
    console.error(JSON.stringify({
      mode: execute ? "execute" : "dry-run",
      worker,
      kv_namespace_id: kvNamespaceId,
      durable_object_classes: generated.deletedClasses,
      stages: ["deploy deleted_classes tombstone", "delete Worker", "delete dedicated KV namespace"]
    }, null, 2));

    // Dry-run validates that the generated tombstone revision builds without
    // touching Cloudflare. Execution is deliberately sequential: never delete
    // the Worker/KV if namespace reclamation failed.
    run("npx", ["wrangler", "deploy", "--config", configPath, ...(execute ? [] : ["--dry-run"])]);
    if (!execute) {
      console.error(`dry-run complete; execute only with --execute --confirm ${expectedConfirmation}`);
      return;
    }
    run("npx", ["wrangler", "delete", worker, "--force"]);
    run("npx", ["wrangler", "kv", "namespace", "delete", "--namespace-id", kvNamespaceId, "--skip-confirmation"]);
    console.error(`deleted ${worker}, its Durable Object class storage, and KV ${kvNamespaceId}; this cannot be recovered`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

if (process.argv[1]?.endsWith("net-canary-cleanup.ts")) {
  void main().catch((error) => {
    console.error(String(error));
    process.exitCode = 1;
  });
}
