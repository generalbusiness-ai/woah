// Minimal woo net client for plug Workers. Operational verbs remain hidden
// from MCP discovery; the plug invokes them through authenticated net turns.

export type WooSession = {
  actor: string;
  session: string;
  expiresAt: number | null;
  tokenClass: "apikey";
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

export type WooClientOptions = { baseUrl: string; fetchImpl?: typeof fetch };

export class WooClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private session: WooSession | null = null;
  private token: string | null = null;

  constructor(options: WooClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  get currentSession(): WooSession | null {
    return this.session;
  }

  async authenticate(token: string): Promise<WooSession> {
    this.token = token;
    const body = await this.requestJson("POST", "/net-api/session", {});
    this.session = {
      actor: String(body.actor),
      session: String(body.session),
      expiresAt: body.expires_at == null ? null : Number(body.expires_at),
      tokenClass: "apikey"
    };
    return this.session;
  }

  /** Reuse a still-live net session on a warm isolate. The credential remains
   * required because every net request independently authenticates its actor. */
  adoptSession(session: WooSession, token: string): void {
    this.session = session;
    this.token = token;
  }

  async getProperty(target: string, name: string): Promise<unknown> {
    const session = this.requireSession();
    const key = `property_cell:${target}:${name}`;
    const path = `/net-api/cell?session=${encodeURIComponent(session.session)}&key=${encodeURIComponent(key)}`;
    const body = await this.requestJson("GET", path);
    const cell = body.cell as { value?: { value?: unknown } } | null | undefined;
    if (!cell?.value || !Object.prototype.hasOwnProperty.call(cell.value, "value")) {
      throw new WooError("E_PROPNF", `property not found: ${target}.${name}`, 404, { target, name });
    }
    return cell.value.value;
  }

  async directCall(target: string, verb: string, args: unknown[] = []): Promise<unknown> {
    const session = this.requireSession();
    const body = await this.requestJson("POST", "/net-api/turn", {
      target,
      verb,
      args,
      session: session.session,
      idempotency_key: `plug:${crypto.randomUUID()}`
    });
    if ((body.reply as { status?: string } | undefined)?.status !== "accepted") {
      const error = body.error as { code?: string; message?: string; detail?: unknown } | undefined;
      throw new WooError(
        String(error?.code ?? "E_REJECTED"),
        String(error?.message ?? `${target}:${verb} was rejected`),
        409,
        error?.detail ?? error
      );
    }
    return body.result;
  }

  private requireSession(): WooSession {
    if (!this.session || !this.token) throw new WooError("E_NOSESSION", "WooClient.authenticate() not yet called", 401);
    return this.session;
  }

  private async requestJson(method: string, path: string, payload?: unknown): Promise<Record<string, any>> {
    const headers: Record<string, string> = {};
    if (payload !== undefined) headers["Content-Type"] = "application/json";
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
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
        error.detail ?? error.value
      );
    }
    return parsed ?? {};
  }
}
