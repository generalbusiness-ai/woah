import { randomUUID } from "node:crypto";

type JsonMap = Record<string, unknown>;

type SmokeResponse = {
  status: number;
  headers: Headers;
  body: unknown;
  text: string;
};

type SmokeConfig = {
  worldUrl: string;
  email: string;
  password: string;
  turnstileToken: string;
  hermesReturn: string;
  profileId: string;
  timeoutMs: number;
};

const checks: string[] = [];

async function main(): Promise<void> {
  const config = readConfig();
  cachedConfig = config;

  const start = await request("POST", "/api/signup", {
    body: {
      email: config.email,
      password: config.password,
      turnstile_token: config.turnstileToken
    },
    expectStatus: 201,
    timeoutMs: config.timeoutMs
  });
  const verificationToken = expectString(start.body, "verification_token");
  assert(!hasFieldNamed(start.body, "password_hash"), "signup response must not expose password_hash");
  pass("signup starts and returns an out-of-band verification token");

  const duplicate = await request("POST", "/api/signup", {
    body: {
      email: config.email,
      password: config.password,
      turnstile_token: config.turnstileToken
    },
    expectOk: false,
    timeoutMs: config.timeoutMs
  });
  expectErrorCode(duplicate.body, "E_EXISTS");
  pass("duplicate signup is rejected");

  const verified = await request("POST", "/api/signup/verify", {
    body: { token: verificationToken },
    timeoutMs: config.timeoutMs
  });
  const account = expectString(verified.body, "account");
  const human = expectString(verified.body, "actor");
  const bearer = expectString(verified.body, "bearer");
  const session = expectSessionId(verified.body);
  pass("verification creates account, human actor, bearer, and session");

  const reusedVerification = await request("POST", "/api/signup/verify", {
    body: { token: verificationToken },
    expectOk: false,
    timeoutMs: config.timeoutMs
  });
  expectErrorCode(reusedVerification.body, "E_NOSESSION");
  pass("verification token is single-use");

  const me = await request("GET", "/api/me", {
    session,
    timeoutMs: config.timeoutMs
  });
  assert(meActor(me.body) === human, "/api/me actor should be the verified human");
  pass("session authorizes /api/me as the verified human");

  const wrongPassword = await request("POST", "/api/auth/password", {
    body: { email: config.email, password: `${config.password}-wrong` },
    expectOk: false,
    timeoutMs: config.timeoutMs
  });
  expectErrorCode(wrongPassword.body, "E_NOSESSION");
  pass("wrong password is rejected");

  const passwordLogin = await request("POST", "/api/auth/password", {
    body: { email: config.email, password: config.password },
    timeoutMs: config.timeoutMs
  });
  const passwordSession = expectSessionId(passwordLogin.body);
  assert(expectString(passwordLogin.body, "actor") === human, "password login should return the same human actor");
  pass("password login returns a session for the verified human");

  const bearerLogin = await request("POST", "/api/auth", {
    body: { token: bearer },
    timeoutMs: config.timeoutMs
  });
  assert(expectString(bearerLogin.body, "actor") === human, "bearer auth should return the same human actor");
  pass("bearer token authenticates");

  const firstState = `smoke-state-1-${randomUUID()}`;
  const firstConnect = await request("POST", "/api/connect", {
    session: passwordSession,
    body: {
      return: config.hermesReturn,
      state: firstState,
      profile_id: config.profileId
    },
    timeoutMs: config.timeoutMs
  });
  const agent = expectString(firstConnect.body, "actor_id");
  const firstApiKey = expectApiKey(firstConnect.body);
  assert(expectString(firstConnect.body, "redirect_url").startsWith(config.hermesReturn), "connect redirect_url should use the requested return URL");
  pass("Hermes connect creates an agent and API key");

  const replayConnect = await request("POST", "/api/connect", {
    session: passwordSession,
    body: {
      return: config.hermesReturn,
      state: firstState,
      profile_id: config.profileId
    },
    expectOk: false,
    timeoutMs: config.timeoutMs
  });
  expectErrorCode(replayConnect.body, "E_REPLAY");
  pass("Hermes connect state is replay-protected");

  const secondConnect = await request("POST", "/api/connect", {
    session: passwordSession,
    body: {
      return: config.hermesReturn,
      state: `smoke-state-2-${randomUUID()}`,
      profile_id: config.profileId
    },
    timeoutMs: config.timeoutMs
  });
  const secondAgent = expectString(secondConnect.body, "actor_id");
  const secondApiKey = expectApiKey(secondConnect.body);
  assert(secondAgent === agent, "Hermes reconnect should reuse the existing profile agent");
  assert(secondApiKey !== firstApiKey, "Hermes reconnect should rotate the profile API key");
  pass("Hermes reconnect reuses the agent and rotates its key");

  const oldApiKeyAuth = await request("POST", "/api/auth", {
    body: { token: firstApiKey },
    expectOk: false,
    timeoutMs: config.timeoutMs
  });
  expectErrorCode(oldApiKeyAuth.body, "E_NOSESSION");
  pass("old Hermes API key is revoked after reconnect");

  const newApiKeyAuth = await request("POST", "/api/auth", {
    body: { token: secondApiKey },
    timeoutMs: config.timeoutMs
  });
  assert(expectString(newApiKeyAuth.body, "actor") === agent, "new API key should authenticate as the Hermes agent");
  pass("new Hermes API key authenticates as the agent");

  const unauthConnect = await request("GET", `/connect?return=${encodeURIComponent(config.hermesReturn)}&state=smoke-redirect&profile_id=${encodeURIComponent(config.profileId)}&force=1`, {
    expectStatus: 302,
    timeoutMs: config.timeoutMs
  });
  const location = unauthConnect.headers.get("location") ?? "";
  assert(location.includes("/signup?return="), "unauthenticated /connect should redirect to signup");
  const signupUrl = new URL(location, config.worldUrl);
  const returnPath = signupUrl.searchParams.get("return") ?? "";
  assert(returnPath.startsWith("/connect?"), "signup redirect should carry a /connect return path");
  assert(returnPath.includes("return="), "return path should preserve return parameter");
  assert(returnPath.includes("state=smoke-redirect"), "return path should preserve state parameter");
  assert(returnPath.includes(`profile_id=${encodeURIComponent(config.profileId)}`) || returnPath.includes(`profile_id=${config.profileId}`), "return path should preserve profile_id parameter");
  assert(!returnPath.includes("force=1"), "return path must drop force=1");
  pass("unauthenticated /connect redirects to signup and strips force");

  const summary = {
    ok: true,
    world: config.worldUrl,
    email: config.email,
    account,
    human,
    agent,
    checks: checks.length,
    passed: checks
  };
  console.log(JSON.stringify(summary, null, 2));
}

function readConfig(): SmokeConfig {
  const args = new Map<string, string>();
  for (const arg of process.argv.slice(2)) {
    const match = /^--([^=]+)=(.*)$/.exec(arg);
    if (match) args.set(match[1], match[2]);
  }
  const worldUrl = trimTrailingSlash(args.get("world") ?? process.env.WORLD_URL ?? process.env.WOO_WORKER_URL ?? "");
  if (!worldUrl) usage("WORLD_URL or --world is required");
  const runId = args.get("run") ?? process.env.SMOKE_RUN_ID ?? `${Date.now()}-${randomUUID().slice(0, 8)}`;
  return {
    worldUrl,
    email: args.get("email") ?? process.env.SMOKE_EMAIL ?? `smoke+${runId}@example.com`,
    password: args.get("password") ?? process.env.SMOKE_PASSWORD ?? `smoke-password-${runId}`,
    turnstileToken: args.get("turnstile-token") ?? process.env.SMOKE_TURNSTILE_TOKEN ?? "XXXX.DUMMY.TOKEN.XXXX",
    hermesReturn: args.get("return") ?? process.env.SMOKE_HERMES_RETURN ?? "hermes://smoke/woo",
    profileId: args.get("profile-id") ?? process.env.SMOKE_PROFILE_ID ?? `smoke-profile-${runId}`,
    timeoutMs: Number(args.get("timeout-ms") ?? process.env.SMOKE_TIMEOUT_MS ?? 15_000)
  };
}

async function request(method: string, path: string, options: {
  body?: JsonMap;
  session?: string;
  expectOk?: boolean;
  expectStatus?: number;
  timeoutMs: number;
}): Promise<SmokeResponse> {
  const url = path.startsWith("http") ? path : `${readConfigCached().worldUrl}${path}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      redirect: "manual",
      headers: {
        ...(options.body ? { "content-type": "application/json" } : {}),
        ...(options.session ? { authorization: `Session ${options.session}` } : {})
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });
    const text = await response.text();
    const body = parseBody(text);
    if (options.expectStatus !== undefined) {
      assert(response.status === options.expectStatus, `${method} ${path} returned ${response.status}, expected ${options.expectStatus}: ${text}`);
    } else if (options.expectOk === false) {
      assert(!response.ok, `${method} ${path} unexpectedly succeeded: ${text}`);
    } else {
      assert(response.ok, `${method} ${path} returned ${response.status}: ${text}`);
    }
    return { status: response.status, headers: response.headers, body, text };
  } finally {
    clearTimeout(timer);
  }
}

let cachedConfig: SmokeConfig | null = null;
function readConfigCached(): SmokeConfig {
  cachedConfig ??= readConfig();
  return cachedConfig;
}

function parseBody(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function expectSessionId(body: unknown): string {
  assert(body !== null && typeof body === "object" && !Array.isArray(body), "response body should be an object for session");
  const session = (body as JsonMap).session;
  assert(typeof session === "string" && session.length > 0, "response field session should be a non-empty string");
  return session;
}

function expectApiKey(body: unknown): string {
  const apiKey = expectString(body, "api_key");
  assert(/^apikey:[^:]+:[^:]+$/.test(apiKey), "api_key should have apikey:<id>:<secret> shape");
  return apiKey;
}

function meActor(body: unknown): string {
  const session = expectRecord(body, "session");
  return expectString(session, "actor");
}

function expectErrorCode(body: unknown, code: string): void {
  const error = expectRecord(body, "error");
  assert(error.code === code, `expected error code ${code}, got ${String(error.code)} (${JSON.stringify(body)})`);
}

function expectRecord(body: unknown, field: string): JsonMap {
  assert(body !== null && typeof body === "object" && !Array.isArray(body), `response body should be an object for field ${field}`);
  const value = (body as JsonMap)[field];
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `response field ${field} should be an object`);
  return value as JsonMap;
}

function expectString(body: unknown, field: string): string {
  assert(body !== null && typeof body === "object" && !Array.isArray(body), `response body should be an object for field ${field}`);
  const value = (body as JsonMap)[field];
  assert(typeof value === "string" && value.length > 0, `response field ${field} should be a non-empty string`);
  return value;
}

function hasFieldNamed(value: unknown, field: string): boolean {
  if (!value || typeof value !== "object") return false;
  if (Array.isArray(value)) return value.some((item) => hasFieldNamed(item, field));
  return Object.entries(value as JsonMap).some(([key, child]) => key === field || hasFieldNamed(child, field));
}

function pass(name: string): void {
  checks.push(name);
  console.error(`ok ${checks.length} - ${name}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function usage(message: string): never {
  console.error(message);
  console.error("Usage: WORLD_URL=https://<worker> npm run smoke:onboarding");
  console.error("Optional env: SMOKE_EMAIL, SMOKE_PASSWORD, SMOKE_TURNSTILE_TOKEN, SMOKE_HERMES_RETURN, SMOKE_PROFILE_ID, SMOKE_TIMEOUT_MS");
  process.exit(2);
}

main().catch((err) => {
  console.error(JSON.stringify({
    ok: false,
    error: err instanceof Error ? err.message : String(err),
    checks,
    failed_after: checks.length
  }, null, 2));
  process.exit(1);
});
