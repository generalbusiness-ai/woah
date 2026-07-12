// Signed operator client for the persisted half of the v2 cutover fence.
// Use the literal `none` for JSON null; transitions are CAS'd against the
// expected generation so a stale command cannot reopen or replace a fence.
import { signInternalRequest } from "../src/worker/internal-auth";

export type FreezeTransitionArgs = {
  baseUrl: string;
  generation: string | null;
  expectedGeneration: string | null;
};

function nullableGeneration(raw: string | undefined, flag: string): string | null {
  if (raw === undefined || raw.length === 0) throw new Error(`${flag} is required`);
  return raw === "none" ? null : raw;
}

export function parseFreezeArgs(argv: string[]): FreezeTransitionArgs {
  const value = (flag: string): string | undefined => {
    const at = argv.indexOf(flag);
    return at === -1 ? undefined : argv[at + 1];
  };
  const known = new Set(["--base-url", "--generation", "--expected-generation"]);
  for (let i = 0; i < argv.length; i += 2) {
    if (!known.has(argv[i] ?? "")) throw new Error(`unknown argument: ${argv[i] ?? ""}`);
    if (argv[i + 1] === undefined) throw new Error(`${argv[i]} is required`);
  }
  const baseUrl = value("--base-url")?.replace(/\/$/, "") ?? "";
  if (!/^https:\/\//.test(baseUrl)) throw new Error("--base-url https://... is required");
  return {
    baseUrl,
    generation: nullableGeneration(value("--generation"), "--generation"),
    expectedGeneration: nullableGeneration(value("--expected-generation"), "--expected-generation")
  };
}

export async function transitionFreeze(
  args: FreezeTransitionArgs,
  secret: string,
  send: typeof fetch = fetch
): Promise<{ freeze_generation: string | null }> {
  if (!secret) throw new Error("WOO_INTERNAL_SECRET is required to sign the freeze transition");
  const request = new Request(`${args.baseUrl}/net-install/freeze`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ generation: args.generation, expected_generation: args.expectedGeneration })
  });
  const response = await send(await signInternalRequest({ WOO_INTERNAL_SECRET: secret }, request));
  const body = (await response.json().catch(() => ({}))) as { freeze_generation?: unknown; error?: unknown };
  if (!response.ok || body.freeze_generation !== args.generation) {
    throw new Error(`freeze transition failed: ${response.status} ${JSON.stringify(body)}`);
  }
  return { freeze_generation: args.generation };
}

async function main(): Promise<void> {
  const args = parseFreezeArgs(process.argv.slice(2));
  const result = await transitionFreeze(args, process.env.WOO_INTERNAL_SECRET ?? "");
  console.log(`freeze generation: ${result.freeze_generation ?? "none"}`);
}

if (process.argv[1]?.endsWith("net-freeze.ts")) {
  void main().catch((err) => {
    console.error(String(err));
    process.exitCode = 1;
  });
}
