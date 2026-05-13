// CommitScopeDO is the future durable home for v2 commit-scope state.
//
// The M4 transport initially drives the existing in-process shadow commit scope
// from the gateway, but production config needs the class and storage namespace
// before we can move commit arbitration out of the gateway without another DO
// migration. Keep this DO intentionally small until the wire path has callers.

export class CommitScopeDO {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: unknown
  ) {
    void this.state;
    void this.env;
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/healthz") {
      return jsonResponse({
        ok: true,
        kind: "woo.commit_scope_do.v1",
        ts: Date.now()
      });
    }
    return jsonResponse({
      error: {
        code: "E_NOT_IMPLEMENTED",
        message: "CommitScopeDO storage is reserved for the v2 turn-network commit scope"
      }
    }, 501);
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" }
  });
}
