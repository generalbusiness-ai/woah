// Minimal woo REST client for plug Workers. Auth once, then direct-call verbs.
//
// Contract (see src/core/protocol.ts; objectRoute requires the plural):
//   POST /api/auth                              { token } -> { actor, session, expires_at, token_class }
//   GET  /api/objects/<id>/properties/<name>    -> { value, ... }
//   POST /api/objects/<id>/calls/<verb>         { args } -> { result, observations, ... }
//
// Authorization on subsequent calls: header `Authorization: Session <session>`.

export type WooSession = {
  actor: string;
  session: string;
  expiresAt: number | null;
  tokenClass: string;
};

export class WooError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number,
    public readonly value?: unknown
  ) {
    super(message);
    this.name = "WooError";
  }
}

export type WooClientOptions = {
  baseUrl: string;
  fetchImpl?: typeof fetch;
};

export class WooClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private session: WooSession | null = null;

  constructor(options: WooClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  get currentSession(): WooSession | null {
    return this.session;
  }

  async authenticate(token: string): Promise<WooSession> {
    const body = await this.postJson("/api/auth", { token });
    this.session = {
      actor: String(body.actor),
      session: String(body.session),
      expiresAt: body.expires_at == null ? null : Number(body.expires_at),
      tokenClass: String(body.token_class)
    };
    return this.session;
  }

  async getProperty(target: string, name: string): Promise<unknown> {
    this.requireSession();
    const path = `/api/objects/${encodeURIComponent(target)}/properties/${encodeURIComponent(name)}`;
    const body = await this.requestJson("GET", path);
    return body.value;
  }

  async directCall(target: string, verb: string, args: unknown[] = []): Promise<unknown> {
    this.requireSession();
    const path = `/api/objects/${encodeURIComponent(target)}/calls/${encodeURIComponent(verb)}`;
    const body = await this.requestJson("POST", path, { args });
    return body.result;
  }

  private requireSession(): WooSession {
    if (!this.session) throw new WooError("E_NOSESSION", "WooClient.authenticate() not yet called", 401);
    return this.session;
  }

  private async postJson(path: string, payload: unknown): Promise<Record<string, any>> {
    return this.requestJson("POST", path, payload);
  }

  private async requestJson(method: string, path: string, payload?: unknown): Promise<Record<string, any>> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json"
    };
    if (this.session) headers["Authorization"] = `Session ${this.session.session}`;

    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: payload === undefined ? undefined : JSON.stringify(payload)
    });

    const text = await response.text();
    let parsed: any = null;
    if (text.length > 0) {
      try {
        parsed = JSON.parse(text);
      } catch {
        throw new WooError("E_INVARG", `non-JSON response (${response.status})`, response.status, text.slice(0, 200));
      }
    }

    if (!response.ok) {
      const error = parsed?.error ?? {};
      throw new WooError(
        String(error.code ?? `E_HTTP_${response.status}`),
        String(error.message ?? `HTTP ${response.status} ${response.statusText}`),
        response.status,
        error.value
      );
    }

    return parsed ?? {};
  }
}
