// AP11 operator CLI (scripts/net-provision-wizard.ts). The driver composes three
// independently idempotent signed calls; these cases pin the composition, the
// ordering constraint that forces it, and the argument refusals.
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { provisionNetWizard } from "../../scripts/net-provision-wizard";
import { verifyInternalRequest } from "../../src/worker/internal-auth";

const SECRET = "operator-wizard-cli-secret";
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

type Call = { url: string; body: Record<string, unknown> };

function harness(credentialFile: string) {
  const calls: Call[] = [];
  let agent = "agent_7";
  const fetchImpl: typeof fetch = async (input) => {
    const request = input instanceof Request ? input : new Request(input);
    // Every hop must carry a valid internal signature.
    await verifyInternalRequest({ WOO_INTERNAL_SECRET: SECRET }, request.clone());
    const body = await request.json() as Record<string, unknown>;
    calls.push({ url: request.url, body });
    if (request.url.endsWith("/net-operator/identity/anchor")) {
      return new Response(JSON.stringify({ ok: true, created: true, human: "human_op_abc", account: "account_op_abc", scope: "cluster:human_op_abc" }), {
        headers: { "content-type": "application/json" }
      });
    }
    if (request.url.endsWith("/net-operator/wizard/provision")) {
      const first = calls.filter((call) => call.url.endsWith("/net-operator/wizard/provision")).length === 1;
      return new Response(JSON.stringify({
        ok: true,
        scope: "cluster:human_2",
        result: {
          actor_id: agent,
          account: "account_1",
          created: first,
          promoted: first,
          flagged: first,
          api_key_id: (body.api_key_id as string | undefined) ?? null,
          agent_quota: 5,
          agent_count: 1,
          programmer_grant_quota: 1,
          programmer_agent_count: 1
        }
      }), { headers: { "content-type": "application/json" } });
    }
    // The credential hop must already have the operator's tuple on disk.
    expect(statSync(credentialFile).mode & 0o777).toBe(0o600);
    return new Response(JSON.stringify({ ok: true, status: "applied", actor: body.actor, id: body.id }), {
      headers: { "content-type": "application/json" }
    });
  };
  return { calls, fetchImpl, setAgent: (id: string) => { agent = id; } };
}

describe("AP11 operator wizard provisioning CLI", () => {
  it("provisions, then binds a locally generated credential, then records the pointer", async () => {
    const home = mkdtempSync(join(tmpdir(), "woo-provision-wizard-"));
    temporaryDirectories.push(home);
    const credentialFile = join(home, ".config", "generalbusiness", "woo_net_credentials.env");
    const { calls, fetchImpl } = harness(credentialFile);
    const logs: string[] = [];
    const args = [
      "--base-url", "https://woo.test",
      "--human", "human_2",
      "--provision-id", "ops-wizard-1",
      "--name", "OpsWizard",
      "--credential-name", "OPS_WIZARD_WOO_APIKEY",
      "--credential-file", credentialFile
    ];
    const deps = { homeDir: home, fetch: fetchImpl, log: (m: string) => logs.push(m) };
    process.env.WOO_INTERNAL_SECRET = SECRET;

    const result = await provisionNetWizard(args, deps);

    // Three calls in the only order the id grammar permits: a routed api-key id
    // embeds its actor, so the credential cannot be generated before the agent
    // exists, and the pointer cannot be recorded before the credential.
    expect(calls.map((call) => call.url)).toEqual([
      "https://woo.test/net-operator/wizard/provision",
      "https://woo.test/net-operator/credentials/ensure",
      "https://woo.test/net-operator/wizard/provision"
    ]);
    expect(calls[0]!.body).toEqual({
      human: "human_2",
      provision_id: "ops-wizard-1",
      name: "OpsWizard",
      purpose: "operator-provisioned wizard"
    });
    // No credential material in the provisioning call, and only a salted
    // verifier in the credential call.
    expect(calls[0]!.body).not.toHaveProperty("api_key_id");
    const ensure = calls[1]!.body as { actor: string; id: string; record: Record<string, unknown> };
    expect(ensure.actor).toBe("agent_7");
    expect(ensure.id).toMatch(/^n1_/);
    expect(Object.keys(ensure.record).sort()).toEqual(["actor", "created_at", "hash", "label", "salt"]);
    expect(calls[2]!.body.api_key_id).toBe(ensure.id);
    expect(result.api_key_id).toBe(ensure.id);

    // The replayable secret stays on the operator machine, owner-only.
    const stored = readFileSync(credentialFile, "utf8");
    expect(stored).toMatch(/OPS_WIZARD_WOO_APIKEY='apikey:n1_/);
    expect(statSync(credentialFile).mode & 0o077).toBe(0);
  });

  it("re-runs idempotently against the stored tuple", async () => {
    const home = mkdtempSync(join(tmpdir(), "woo-provision-wizard-"));
    temporaryDirectories.push(home);
    const credentialFile = join(home, ".config", "generalbusiness", "woo_net_credentials.env");
    const { calls, fetchImpl } = harness(credentialFile);
    const args = [
      "--base-url", "https://woo.test",
      "--human", "human_2",
      "--provision-id", "ops-wizard-1",
      "--credential-name", "OPS_WIZARD_WOO_APIKEY",
      "--credential-file", credentialFile
    ];
    const deps = { homeDir: home, fetch: fetchImpl, log: () => {} };
    process.env.WOO_INTERNAL_SECRET = SECRET;

    await provisionNetWizard(args, deps);
    const afterFirst = readFileSync(credentialFile, "utf8");
    await provisionNetWizard(args, deps);

    // The credential file is byte-identical: the second run reuses the exact
    // id/salt/hash tuple rather than minting a second secret.
    expect(readFileSync(credentialFile, "utf8")).toBe(afterFirst);
    const ensures = calls.filter((call) => call.url.endsWith("/credentials/ensure"));
    expect(ensures).toHaveLength(2);
    expect(ensures[1]!.body).toEqual(ensures[0]!.body);
  });

  it("seeds the anchor first when given a token instead of an existing human", async () => {
    // A fresh net world seeds NO $human, so the anchor step is the normal
    // opening move of the runbook, not an edge case.
    const home = mkdtempSync(join(tmpdir(), "woo-provision-wizard-"));
    temporaryDirectories.push(home);
    const credentialFile = join(home, ".config", "generalbusiness", "woo_net_credentials.env");
    const { calls, fetchImpl } = harness(credentialFile);
    process.env.WOO_INTERNAL_SECRET = SECRET;

    await provisionNetWizard([
      "--base-url", "https://woo.test",
      "--anchor-id", "ops-anchor",
      "--provision-id", "ops-wizard-1",
      "--credential-name", "OPS_WIZARD_WOO_APIKEY",
      "--credential-file", credentialFile
    ], { homeDir: home, fetch: fetchImpl, log: () => {} });

    expect(calls.map((call) => call.url)).toEqual([
      "https://woo.test/net-operator/identity/anchor",
      "https://woo.test/net-operator/wizard/provision",
      "https://woo.test/net-operator/credentials/ensure",
      "https://woo.test/net-operator/wizard/provision"
    ]);
    expect(calls[0]!.body).toEqual({ anchor_id: "ops-anchor", label: "operator anchor ops-anchor" });
    // The human the anchor returned is what provisioning then targets.
    expect(calls[1]!.body.human).toBe("human_op_abc");
  });

  it("probes without mutating, and reports what to run next", async () => {
    const home = mkdtempSync(join(tmpdir(), "woo-provision-wizard-"));
    temporaryDirectories.push(home);
    const credentialFile = join(home, ".config", "generalbusiness", "woo_net_credentials.env");
    const { calls, fetchImpl } = harness(credentialFile);
    process.env.WOO_INTERNAL_SECRET = SECRET;

    await provisionNetWizard([
      "--base-url", "https://woo.test",
      "--human", "human_2",
      "--provision-id", "ops-wizard-1",
      "--probe",
      "--credential-file", credentialFile
    ], { homeDir: home, fetch: fetchImpl, log: () => {} });

    // Exactly one call, flagged as a probe, and no credential was generated.
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://woo.test/net-operator/wizard/provision");
    expect(calls[0]!.body).toEqual({ human: "human_2", provision_id: "ops-wizard-1", probe: true });
    calls.length = 0;

    // Probing from a TOKEN must stay read-only too: the anchor hop is flagged
    // as a probe and carries no label, so it cannot seed an identity.
    await provisionNetWizard([
      "--base-url", "https://woo.test",
      "--anchor-id", "ops-anchor",
      "--provision-id", "ops-wizard-1",
      "--probe",
      "--credential-file", credentialFile
    ], { homeDir: home, fetch: fetchImpl, log: () => {} });
    expect(calls.map((c) => c.url)).toEqual([
      "https://woo.test/net-operator/identity/anchor",
      "https://woo.test/net-operator/wizard/provision"
    ]);
    expect(calls[0]!.body).toEqual({ anchor_id: "ops-anchor", probe: true });
    expect(calls[1]!.body.probe).toBe(true);
    // No credential was generated at all — probe does not even create the file.
    expect(existsSync(credentialFile)).toBe(false);
  });

  it("refuses arguments that cannot describe a valid provisioning", async () => {
    const home = mkdtempSync(join(tmpdir(), "woo-provision-wizard-"));
    temporaryDirectories.push(home);
    const credentialFile = join(home, ".config", "generalbusiness", "woo_net_credentials.env");
    const { fetchImpl } = harness(credentialFile);
    const deps = { homeDir: home, fetch: fetchImpl, log: () => {} };
    process.env.WOO_INTERNAL_SECRET = SECRET;
    const base = ["--base-url", "https://woo.test", "--credential-file", credentialFile, "--credential-name", "X_WOO_APIKEY"];

    // `$wiz` is precisely the identity this op replaces; naming it is a refusal,
    // not a fallback.
    await expect(provisionNetWizard([...base, "--human", "$wiz", "--provision-id", "a"], deps)).rejects.toThrow(/non-\$/);
    // --human and --anchor-id are alternatives, and one is required.
    await expect(provisionNetWizard([...base, "--provision-id", "a"], deps)).rejects.toThrow(/--human .* or --anchor-id/);
    await expect(provisionNetWizard([...base, "--human", "human_2", "--anchor-id", "x", "--provision-id", "a"], deps)).rejects.toThrow(/alternatives/);
    await expect(provisionNetWizard([...base, "--anchor-id", "bad token", "--provision-id", "a"], deps)).rejects.toThrow(/anchor-id/);
    await expect(provisionNetWizard([...base, "--human", "human_2"], deps)).rejects.toThrow(/provision-id/);
    await expect(provisionNetWizard([...base, "--human", "human_2", "--provision-id", "bad id"], deps)).rejects.toThrow(/provision-id/);
    await expect(provisionNetWizard([
      "--base-url", "https://woo.test", "--credential-file", credentialFile,
      "--human", "human_2", "--provision-id", "a"
    ], deps)).rejects.toThrow(/credential-name/);
  });
});
