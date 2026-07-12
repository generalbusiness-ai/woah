import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const deploy = readFileSync(new URL("../../scripts/deploy.sh", import.meta.url), "utf8");

describe("deploy postflight contract", () => {
  it("probes the live authenticated projection with an explicit 200 contract", () => {
    expect(deploy).not.toContain("$WORKER_URL/api/state");
    expect(deploy).toContain('retry_status_until 200 GET "$WORKER_URL/api/me"');
    expect(deploy).toContain('[[ -n "$me_actor" ]]');
  });

  it("derives warm and routed targets from the bounded /api/me projection", () => {
    expect(deploy).toContain("...(state.here?.contents ?? [])");
    expect(deploy).toContain("...(state.here?.roster ?? [])");
    expect(deploy).not.toContain("Object.keys(state.objects");
  });

  it("branches on the authoritative selected stack and has a v2-free net postflight", () => {
    expect(deploy).toContain('retry_status_until 200 GET "$WORKER_URL/client-config"');
    expect(deploy).toContain('if [[ "$selected_stack" == "net" ]]');
    expect(deploy).toContain('scripts/net-canary-load.ts --base-url "$WORKER_URL"');
    expect(deploy).toContain('POSTFLIGHT_NET_SESSIONS+=("$net_sid")');
  });
});
