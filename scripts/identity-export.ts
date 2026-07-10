// identity-export — pull the §8 identity carry-over from a live v2
// worker (cutover item B; normative protocol:
// spec/operations/net-cutover.md).
//
//   WOO_INTERNAL_SECRET=... npx tsx scripts/identity-export.ts \
//     --base-url https://<worker-host> [--out identity-export.json] \
//     [--allow-unfrozen]
//
// Read-only and idempotent (re-running re-reads). The route REFUSES on
// an unfrozen world (--allow-unfrozen is the rehearsal override), and
// this tool exports TWICE and requires equal watermarks — the quiescence
// proof that no in-flight write landed between the two reads. A watermark
// mismatch means writes were still draining when the export ran: wait
// and re-run; never feed a moving export into the cutover. The output
// feeds scripts/net-install.ts --identity.
import { writeFileSync } from "node:fs";
import { parseIdentityExport } from "../src/net/identity";
import { signInternalRequest } from "../src/worker/internal-auth";

function parseArgs(argv: string[]): { baseUrl: string; out: string; allowUnfrozen: boolean; acknowledgeFreeze: string | null } {
  const args = { baseUrl: "", out: "identity-export.json", allowUnfrozen: false, acknowledgeFreeze: null as string | null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--base-url") args.baseUrl = argv[++i] ?? "";
    else if (arg === "--out") args.out = argv[++i] ?? args.out;
    else if (arg === "--allow-unfrozen") args.allowUnfrozen = true;
    else if (arg === "--acknowledge-freeze") args.acknowledgeFreeze = argv[++i] ?? null;
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.baseUrl) throw new Error("--base-url is required");
  return args;
}

type ExportEnvelope = {
  frozen: boolean;
  freeze_generation: string | null;
  watermark: string;
  exported_at: number;
  identity: unknown;
};

async function fetchExport(baseUrl: string, allowUnfrozen: boolean, env: { WOO_INTERNAL_SECRET?: string }): Promise<ExportEnvelope> {
  const suffix = allowUnfrozen ? "?allow-unfrozen=1" : "";
  const request = new Request(`${baseUrl}/net-install/identity-export${suffix}`);
  const response = await fetch(await signInternalRequest(env, request));
  const raw = (await response.json()) as ExportEnvelope | { error?: unknown };
  if (!response.ok) throw new Error(`identity export failed: ${response.status} ${JSON.stringify(raw)}`);
  const envelope = raw as ExportEnvelope;
  if (typeof envelope.watermark !== "string" || envelope.watermark.length === 0) {
    throw new Error(`identity export returned no watermark: ${JSON.stringify(raw).slice(0, 300)}`);
  }
  return envelope;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const env = { WOO_INTERNAL_SECRET: process.env.WOO_INTERNAL_SECRET };
  if (!env.WOO_INTERNAL_SECRET) throw new Error("WOO_INTERNAL_SECRET is required to sign the export request");

  // Finding 6: acknowledge the write fence at the AUTHORITY before
  // exporting — the export refuses without both the env flag and this
  // persisted generation, and the receipt records the echoed value.
  if (args.acknowledgeFreeze) {
    const request = new Request(`${args.baseUrl}/net-install/freeze`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // V3 finding 5: acknowledgment is CAS'd from the UNFROZEN state
      // (expected null) — a replay after the value is set is idempotent,
      // and it cannot silently overwrite a different operator's fence.
      body: JSON.stringify({ generation: args.acknowledgeFreeze, expected_generation: null })
    });
    const response = await fetch(await signInternalRequest(env, request));
    const ack = (await response.json()) as { freeze_generation?: string | null };
    if (!response.ok || ack.freeze_generation !== args.acknowledgeFreeze) {
      throw new Error(`freeze acknowledgment failed: ${response.status} ${JSON.stringify(ack)}`);
    }
    console.log(`freeze acknowledged: generation ${args.acknowledgeFreeze}`);
  }

  // The quiescence proof: two reads, one verdict. Equal watermarks over
  // the full serialized world show the frozen image is STABLE — every
  // in-flight pre-freeze write has landed (or none will).
  const first = await fetchExport(args.baseUrl, args.allowUnfrozen, env);
  const second = await fetchExport(args.baseUrl, args.allowUnfrozen, env);
  if (first.watermark !== second.watermark) {
    // Two benign causes exist alongside the dangerous one: (a) in-flight
    // pre-freeze writes still draining, and (b) the world DO's one-time
    // derived-contents repair on its first warm fetch (a cold-started
    // DO converges exactly once). Both resolve by waiting and re-running;
    // a watermark that KEEPS moving across re-runs means the freeze is
    // not actually holding — stop the cutover and investigate.
    throw new Error(
      `watermark mismatch — the world image moved between reads: ` +
        `${first.watermark.slice(0, 16)}… vs ${second.watermark.slice(0, 16)}…; ` +
        `wait and re-run (a mismatch that persists across re-runs means the freeze is not holding)`
    );
  }
  if (!second.frozen) {
    console.log("WARNING: rehearsal export from an UNFROZEN world — never feed this into a real cutover");
  }

  // Shape-check BEFORE writing: a malformed export must never become the
  // cutover's input file.
  const identity = parseIdentityExport(second.identity);
  writeFileSync(args.out, JSON.stringify(identity, null, 2));
  console.log(
    `identity-export ok: ${Object.keys(identity.api_keys).length} api keys, ${identity.actors.length} actors → ${args.out}`
  );
  console.log(
    `watermark ${second.watermark} (frozen=${second.frozen}, generation=${String(second.freeze_generation)}) — record this in the cutover receipt`
  );
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
