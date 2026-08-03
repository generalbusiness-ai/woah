/**
 * Fail-closed Durable Object rows-written gate and scheduled alert probe.
 *
 * Examples:
 *   npm run gate:net-storage -- --worker woah-net-canary \
 *     --from 2026-08-02T12:00:00Z --max-rows-written 250000 \
 *     --max-rows-written-per-object 50000
 *
 * A failing process is the primary alert channel (CI/scheduler notification).
 * WOO_STORAGE_ALERT_WEBHOOK_URL optionally receives the same bounded report.
 */

import {
  evaluateDurableObjectStorage,
  queryWorkerDurableObjectStorage,
  storageReportForOutput
} from "./cloudflare-do-storage";

function value(args: string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at < 0 ? undefined : args[at + 1];
}

function requiredNumber(raw: string | undefined, name: string): number {
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${name} must be a non-negative integer`);
  return parsed;
}

async function sendAlert(webhook: string, payload: unknown): Promise<void> {
  const response = await fetch(webhook, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload)
  });
  if (!response.ok) throw new Error(`storage alert webhook failed HTTP ${response.status}`);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const accountId = process.env.CF_ACCOUNT_ID;
  const token = process.env.CF_ANALYTICS_TOKEN;
  if (!accountId || !token) throw new Error("CF_ACCOUNT_ID and CF_ANALYTICS_TOKEN are required");
  const worker = value(args, "--worker");
  const from = value(args, "--from");
  const to = value(args, "--to") ?? new Date().toISOString();
  if (!worker || !from) throw new Error("--worker and --from are required");
  const budget = {
    maxRowsWritten: requiredNumber(value(args, "--max-rows-written"), "--max-rows-written"),
    maxRowsWrittenPerObject: requiredNumber(
      value(args, "--max-rows-written-per-object"),
      "--max-rows-written-per-object"
    )
  };
  const report = await queryWorkerDurableObjectStorage({ accountId, token, worker, from, to });
  const decision = evaluateDurableObjectStorage(report, budget);
  const output = { ...storageReportForOutput(report), budget, decision };
  console.log(JSON.stringify(output, null, 2));
  if (decision.state !== "pass") {
    const webhook = process.env.WOO_STORAGE_ALERT_WEBHOOK_URL;
    if (webhook) await sendAlert(webhook, output);
    process.exitCode = decision.state === "violation" ? 2 : 3;
  }
}

if (process.argv[1]?.endsWith("net-storage-gate.ts")) {
  void main().catch((error) => {
    console.error(String(error));
    process.exitCode = 1;
  });
}
