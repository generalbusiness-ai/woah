import { describe, expect, it } from "vitest";
import { createWorld } from "../src/core/bootstrap";
import { handleRestProtocolRequest, type RestProtocolHost, type RestProtocolRequest } from "../src/core/protocol";
import type { Session, WooValue } from "../src/core/types";
import type { WooWorld } from "../src/core/world";

function req(method: string, pathname: string, body: Record<string, unknown> = {}, headers: Record<string, string> = {}, query: Record<string, string> = {}): RestProtocolRequest {
  return {
    method,
    pathname,
    query: (name) => query[name] ?? null,
    header: (name) => headers[name.toLowerCase()] ?? null,
    readJson: async () => body
  };
}

function host(world: WooWorld, session: Session | null = null): RestProtocolHost {
  return {
    world,
    requireSession: () => {
      if (!session) throw { code: "E_NOSESSION", message: "no session" };
      return session;
    },
    authenticateToken: (token) => world.auth(token),
    onAuthenticated: () => undefined,
    broadcastApplied: async () => undefined,
    broadcastLiveEvents: async () => undefined
  };
}

async function signup(world: WooWorld, email = "person@example.com"): Promise<{ account: string; actor: string; bearer: string; session: Session }> {
  const started = await world.beginSignup(email, "correct horse battery staple");
  const verified = world.verifySignup(started.verification_token);
  return { account: verified.account, actor: verified.actor, bearer: verified.bearer, session: verified.session };
}

function expectError(fn: () => unknown, code: string): void {
  try {
    fn();
  } catch (err: unknown) {
    expect((err as { code?: string }).code).toBe(code);
    return;
  }
  throw new Error(`expected ${code}`);
}

describe("onboarding provisioning", () => {
  it("seeds account, human, and agent classes", () => {
    const world = createWorld({ catalogs: false });
    expect(world.object("$account").parent).toBe("$root");
    expect(world.object("$human").parent).toBe("$player");
    expect(world.object("$agent").parent).toBe("$player");
  });

  it("runs signup verification, creates a human, and authenticates the returned bearer", async () => {
    const world = createWorld({ catalogs: false });
    const started = await world.beginSignup("Person@Example.COM", "correct horse battery staple");
    const verified = world.verifySignup(started.verification_token);

    expect(world.getProp(verified.account, "email")).toBe("person@example.com");
    expect(String(world.getProp(verified.account, "password_hash"))).toMatch(/^pbkdf2-sha256:600000:/);
    expect(world.getProp(verified.account, "primary_actor")).toBe(verified.actor);
    expect(world.getProp(verified.actor, "account")).toBe(verified.account);
    expect(world.auth(verified.bearer).actor).toBe(verified.actor);
    expectError(() => world.verifySignup(started.verification_token), "E_NOSESSION");
  });

  it("promotes a same-session guest to $human during email verification", async () => {
    const world = createWorld({ catalogs: false });
    const guestSession = world.auth("guest:onboarding");
    const started = await world.beginSignup("guest@example.com", "correct horse battery staple");
    const verified = world.verifySignup(started.verification_token, guestSession.id);

    expect(verified.actor).toBe(guestSession.actor);
    expect(verified.promoted_guest).toBe(true);
    expect(world.object(guestSession.actor).parent).toBe("$human");
    expect(world.getProp(guestSession.actor, "account")).toBe(verified.account);
  });

  it("strips account credential material from delivered host seeds", async () => {
    const world = createWorld({ catalogs: false });
    const { account, actor } = await signup(world, "seed-safety@example.com");
    world.setProp(actor, "host_placement", "self");
    const seed = world.buildHostSeedForDelivery(actor);
    const accountEntry = seed.objects.find((obj) => obj.id === account);
    expect(accountEntry).toBeDefined();
    expect(accountEntry?.properties.map(([name]) => name)).not.toContain("password_hash");
    expect(accountEntry?.properties.map(([name]) => name)).not.toContain("password_salt");
    expect(accountEntry?.properties.map(([name]) => name)).not.toContain("oauth_identities");
  });

  it("lets humans provision, list, rotate, authenticate, and revoke owned agents within quota", async () => {
    const world = createWorld({ catalogs: false });
    const { actor, account } = await signup(world);

    const created = await world.directCall("create-agent", actor, actor, "create_agent", ["Agent One", "tests"], {});
    expect(created.op).toBe("result");
    if (created.op !== "result") throw new Error("expected result");
    const result = created.result as Record<string, WooValue>;
    const agent = String(result.actor_id);
    const apiKey = String(result.api_key);
    expect(world.auth(apiKey).actor).toBe(agent);
    expect(world.getProp(account, "agent_count")).toBe(1);

    const listed = await world.directCall("list-agents", actor, actor, "list_agents", [], {});
    expect(listed.op).toBe("result");
    if (listed.op !== "result") throw new Error("expected result");
    expect((listed.result as Array<Record<string, WooValue>>).map((row) => row.actor_id)).toContain(agent);

    const rotated = await world.directCall("rotate-agent", actor, actor, "rotate_agent_key", [agent], {});
    expect(rotated.op).toBe("result");
    if (rotated.op !== "result") throw new Error("expected result");
    expect(() => world.auth(apiKey)).toThrow();
    expect(world.auth(String((rotated.result as Record<string, WooValue>).api_key)).actor).toBe(agent);

    const revoked = await world.directCall("revoke-agent", actor, actor, "revoke_agent", [agent, "done"], {});
    expect(revoked.op).toBe("result");
    expect(world.getProp(account, "agent_count")).toBe(0);
    expectError(() => world.auth(String((rotated.result as Record<string, WooValue>).api_key)), "E_NOSESSION");
  });

	  it("enforces agent and programmer-agent quotas", async () => {
	    const world = createWorld({ catalogs: false });
	    const { actor, account } = await signup(world, "quota@example.com");
	    world.setProp(account, "agent_quota", 1);

    const first = await world.directCall("first-agent", actor, actor, "create_agent", ["A"], {});
    expect(first.op).toBe("result");
    const second = await world.directCall("second-agent", actor, actor, "create_agent", ["B"], {});
    expect(second.op).toBe("error");
    if (second.op !== "error") throw new Error("expected quota error");
	    expect(second.error.code).toBe("E_QUOTA_EXCEEDED");

	    world.setProp(account, "agent_quota", 2);
	    const programmer = await world.directCall("programmer-agent", actor, actor, "create_agent", ["C", "", true], {});
	    expect(programmer.op).toBe("error");
	    if (programmer.op !== "error") throw new Error("expected programmer quota error");
	    expect(programmer.error.code).toBe("E_QUOTA_EXCEEDED");

	    world.setProp(account, "programmer_grant_quota", 1);
	    const allowedProgrammer = await world.directCall("allowed-programmer-agent", actor, actor, "create_agent", ["D", "", true], {});
	    expect(allowedProgrammer.op).toBe("result");
	    if (allowedProgrammer.op !== "result") throw new Error("expected programmer agent");
	    const programmerAgent = String((allowedProgrammer.result as Record<string, WooValue>).actor_id);
	    expect(world.getProp(account, "programmer_agent_count")).toBe(1);

	    const idempotentFlag = await world.directCall("idempotent-programmer-flag", "$wiz", "$system", "set_actor_flag", [programmerAgent, "programmer", true], {});
	    expect(idempotentFlag.op).toBe("result");
	    expect(world.getProp(account, "programmer_agent_count")).toBe(1);

	    world.setProp(account, "agent_quota", 3);
	    const secondProgrammer = await world.directCall("second-programmer-agent", actor, actor, "create_agent", ["E", "", true], {});
	    expect(secondProgrammer.op).toBe("error");
	    if (secondProgrammer.op !== "error") throw new Error("expected programmer quota error");
	    expect(secondProgrammer.error.code).toBe("E_QUOTA_EXCEEDED");
	  });

  it("reconnects Hermes by profile_id without consuming another quota slot", async () => {
    const world = createWorld({ catalogs: false });
    const { actor, account } = await signup(world, "hermes@example.com");

    const first = world.connectHermes(actor, "hermes://profile/woo", "state-1", "profile-uuid");
    const second = world.connectHermes(actor, "hermes://profile/woo", "state-2", "profile-uuid");

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.actor_id).toBe(first.actor_id);
    expect(world.getProp(account, "agent_count")).toBe(1);
    expect(world.auth(second.api_key).actor).toBe(first.actor_id);
    expectError(() => world.connectHermes(actor, "hermes://profile/woo", "state-2", "profile-uuid"), "E_REPLAY");
  });

  it("sweeps expired pending credential ledgers", async () => {
    const world = createWorld({ catalogs: false });
    world.setProp("$system", "bearer_tokens", { stale: { actor: "$wiz", expires_at: 1 } });
    world.setProp("$system", "pending_email_verifications", [{ token_hash: "stale", account_id: "$account", expires_at: 1 }]);
    world.setProp("$system", "provision_state_nonces", [{ state_hash: "stale", issued_at: 1 }]);
    world.setProp("$system", "signup_invites", [{ code: "used", expires_at: 1, used_by: "$wiz", used_at: 1 }]);

    const swept = await world.directCall("gc-pending", "$wiz", "$system", "gc_pending_credentials", [], {});
    expect(swept.op).toBe("result");
    expect(world.getProp("$system", "bearer_tokens")).toEqual({});
    expect(world.getProp("$system", "pending_email_verifications")).toEqual([]);
    expect(world.getProp("$system", "provision_state_nonces")).toEqual([]);
    expect(world.getProp("$system", "signup_invites")).toEqual([]);
  });

  it("exposes signup, password, bearer auth, and connect through REST protocol", async () => {
    const world = createWorld({ catalogs: false });
    const started = await handleRestProtocolRequest(req("POST", "/api/signup", {
      email: "rest@example.com",
      password: "correct horse battery staple",
      turnstile_token: "test-token"
    }), host(world));
    expect(started.handled).toBe(true);
    if (!started.handled || "raw" in started) throw new Error("unexpected result");
    expect(started.status).toBe(201);

    const token = String((started.body as Record<string, WooValue>).verification_token);
    const verified = await handleRestProtocolRequest(req("POST", "/api/signup/verify", { token }), host(world));
    expect(verified.handled).toBe(true);
    if (!verified.handled || "raw" in verified) throw new Error("unexpected result");
    const bearer = String((verified.body as Record<string, WooValue>).bearer);

    const password = await handleRestProtocolRequest(req("POST", "/api/auth/password", {
      email: "rest@example.com",
      password: "correct horse battery staple"
    }), host(world));
    expect(password.handled).toBe(true);
    if (!password.handled || "raw" in password) throw new Error("unexpected result");
    expect(String((password.body as Record<string, WooValue>).bearer)).toMatch(/^bearer:/);

    const auth = await handleRestProtocolRequest(req("POST", "/api/auth", { token: bearer }), host(world));
    expect(auth.handled).toBe(true);
    if (!auth.handled || "raw" in auth) throw new Error("unexpected result");
    const session = world.auth(`session:${String((auth.body as Record<string, WooValue>).session)}`);

    const connected = await handleRestProtocolRequest(req("POST", "/api/connect", {
      return: "hermes://rest/woo",
      state: "rest-state",
      profile_id: "rest-profile"
    }), host(world, session));
    expect(connected.handled).toBe(true);
    if (!connected.handled || "raw" in connected) throw new Error("unexpected result");
    expect(String((connected.body as Record<string, WooValue>).redirect_url)).toContain("api_key=");

    const unauthConnect = await handleRestProtocolRequest(req("GET", "/connect", {}, {}, {
      return: "hermes://rest/woo",
      state: "rest-state-2",
      profile_id: "rest-profile-2",
      force: "1"
    }), host(world));
    expect(unauthConnect.handled).toBe(true);
    if (!unauthConnect.handled || "raw" in unauthConnect) throw new Error("unexpected result");
    expect(unauthConnect.status).toBe(302);
    expect(unauthConnect.headers?.Location).toContain("/signup?return=");
    expect(decodeURIComponent(unauthConnect.headers?.Location ?? "")).not.toContain("force=1");
  });
});
