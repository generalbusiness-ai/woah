/**
 * Local-SQLite account-family diagnostic/repair.
 *
 * Dry-run is the default. `--apply` is an explicit second invocation after an
 * operator reviews the plan. Inputs identify the database, account, and
 * optional orphan candidates only; all replacement values come from the same
 * pure planner used by Net.
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { existsSync, statSync } from "node:fs";
import { createWorldFromSerialized } from "../src/core/bootstrap";
import type { AccountRepairResult } from "../src/core/account-state-repair";
import { constantTimeEqual } from "../src/core/source-hash";
import { LocalSQLiteRepository } from "../src/server/sqlite-repository";

export type LocalAccountRepairArgs = {
  database: string;
  account: string;
  candidates: string[];
  apply: boolean;
  reviewToken: string | null;
};

export function parseLocalAccountRepairArgs(argv: string[]): LocalAccountRepairArgs {
  let database = "";
  let account = "";
  let apply = false;
  let explicitDryRun = false;
  let reviewToken: string | null = null;
  const candidates: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--apply") {
      apply = true;
      continue;
    }
    if (flag === "--dry-run") {
      explicitDryRun = true;
      continue;
    }
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(`expected --name value arguments; stopped at ${JSON.stringify(flag)}`);
    }
    if (flag === "--db") database = resolve(value);
    else if (flag === "--account") account = value;
    else if (flag === "--candidate") candidates.push(value);
    else if (flag === "--review-token") reviewToken = value;
    else throw new Error(`unknown account-repair argument: ${flag}`);
    index += 1;
  }
  if (!database || !account) {
    throw new Error("--db /absolute/or/relative/world.sqlite and --account are required");
  }
  if (apply && explicitDryRun) throw new Error("--dry-run and --apply are mutually exclusive");
  if (apply && !reviewToken) {
    throw new Error("--apply requires --review-token from the reviewed dry-run");
  }
  if (!apply && reviewToken) {
    throw new Error("--review-token is valid only with --apply");
  }
  if (candidates.length > 256) throw new Error("at most 256 explicit --candidate objects may be inspected");
  return { database, account, candidates: [...new Set(candidates)], apply, reviewToken };
}

export function repairLocalAccountState(
  argv: string[],
  log: (message: string) => void = console.log
): AccountRepairResult {
  const args = parseLocalAccountRepairArgs(argv);
  if (!existsSync(args.database) || !statSync(args.database).isFile()) {
    throw new Error(`SQLite world does not exist or is not a file: ${args.database}`);
  }
  const repo = new LocalSQLiteRepository(args.database, {
    requireExistingCurrentWorld: true,
    // BEGIN IMMEDIATE protects the database snapshot below; this lifetime
    // lease additionally proves there is no live in-memory WooWorld that can
    // later flush an older image over the accepted repair.
    exclusiveWorldAccess: true
  });
  try {
    // The exclusive world lease proves the server is stopped. BEGIN IMMEDIATE
    // then covers load + plan + apply, so no second database writer can commit
    // between the diagnostic snapshot and its savepointed writes.
    const result = repo.transaction(() => {
      const stored = repo.load();
      if (!stored) {
        throw new Error(`SQLite file contains no persisted woo world: ${args.database}`);
      }
      // Loading the stored snapshot directly is essential for dry-run purity:
      // createWorld() performs local-boot migration/repair before returning and
      // may persist those unrelated changes even when this command is probing.
      const world = createWorldFromSerialized(stored, { repository: repo, persist: false });
      if (args.apply) {
        const current = world.repairAccountState(args.account, {
          dryRun: true,
          candidateActors: args.candidates
        });
        if (
          current.status === "would_apply" &&
          (
            !current.review_token ||
            !args.reviewToken ||
            !constantTimeEqual(current.review_token, args.reviewToken)
          )
        ) {
          throw new Error(
            "account repair review token no longer matches; run dry-run again and review the current plan"
          );
        }
      }
      return world.repairAccountState(args.account, {
        ...(args.apply ? { apply: true as const } : { dryRun: true as const }),
        candidateActors: args.candidates
      });
    });
    log(JSON.stringify(result, null, 2));
    return result;
  } finally {
    repo.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const result = repairLocalAccountState(process.argv.slice(2));
  if (result.status === "conflict") process.exitCode = 2;
}
