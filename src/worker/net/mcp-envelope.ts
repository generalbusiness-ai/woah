/**
 * The `/net-api/mcp` response envelope (spec/protocol/mcp.md §M1.2).
 *
 * MCP is JSON-RPC. A JSON-RPC request must be answered with a JSON-RPC
 * message, and this module is the single place that renders one. It exists
 * because the gateway used to answer transport- and auth-level refusals on
 * this endpoint with its generic `{error:{code,message,detail}}` body — a
 * shape no JSON-RPC client can parse. A stdio bridge validating that body
 * against the MCP message schema got a schema-validation failure instead of
 * "apikey not found or revoked", so the whole diagnosis was replaced by a
 * couple of kilobytes of parser noise before it reached the agent.
 *
 * Deliberately dependency-free so tests, the bridge's compatibility path, and
 * the gateway can all agree on one shape.
 */

/**
 * The numeric JSON-RPC code every woo-shaped refusal on this endpoint uses.
 *
 * -32000 is the first slot of JSON-RPC 2.0's implementation-defined
 * "server error" range (-32000..-32099). The gateway has emitted it for
 * session refusals since the MCP adapter landed, so it is grandfathered: a
 * client already keying on it keeps working.
 *
 * It is also the only number we may safely use. The 2026-07-28 MCP revision
 * reserves -32020..-32099 for the protocol itself, and -32001..-32019 are
 * unallocated — minting one there would be inventing private numeric
 * vocabulary that no client can interpret and that a future revision could
 * collide with. woo's own distinctions are already carried, stably and
 * legibly, by the STRING code in `error.data.code`; a parallel numeric
 * taxonomy would be a second source of truth for the same fact.
 */
export const MCP_JSONRPC_SERVER_ERROR = -32000;

/** JSON-RPC's own parse-error code, for a body that is not a request at all. */
export const MCP_JSONRPC_PARSE_ERROR = -32700;

/** JSON-RPC's own code for a method this server does not implement. Genuine
 * protocol errors keep their standard codes; only woo refusals map to
 * {@link MCP_JSONRPC_SERVER_ERROR}. */
export const MCP_JSONRPC_METHOD_NOT_FOUND = -32601;

/** JSON-RPC's own code for a request whose params are structurally wrong —
 * a missing or non-string `uri` on `resources/read`, for example. This is a
 * PROTOCOL error, not a woo refusal: no world state was consulted. */
export const MCP_JSONRPC_INVALID_PARAMS = -32602;

/**
 * The id to echo on a reply.
 *
 * `null` here means "genuinely unknown" — a refusal raised before the body was
 * parsed (foreign `Origin`), a body that could not be parsed, a `GET`/`DELETE`
 * that carries no JSON-RPC request at all, or a notification, which has no id
 * by construction.
 */
export type McpRequestId = number | string | null;

/** A woo refusal, in the vocabulary the rest of the gateway speaks. */
export type McpWooRefusal = {
  code: string;
  message: string;
  detail?: unknown;
  /** E_BUDGET's attempt trace (CO6), preserved rather than flattened away. */
  attempts?: unknown;
};

export type McpJsonRpcErrorBody = {
  jsonrpc: "2.0";
  id?: number | string;
  error: { code: number; message: string; data?: unknown };
};

/**
 * Build the JSON-RPC error body for a refusal.
 *
 * **On the id.** When the originating id is known it is echoed, because that
 * is the only thing that lets a client correlate the refusal with its call.
 * When it is not, the member is OMITTED rather than set to `null`.
 *
 * That choice is forced, not stylistic. MCP's Streamable HTTP transport
 * explicitly sanctions "a JSON-RPC error response that has no id" for input
 * the server cannot accept, and the official MCP SDK's
 * `JSONRPCErrorResponseSchema` declares `id` optional over `string | number`.
 * `id: null` therefore FAILS that schema — measured: it produces ~3.4 kB of
 * Zod union noise — which would reintroduce, for every SDK-based client, the
 * exact failure this envelope exists to remove. JSON-RPC 2.0 §5 would spell
 * the same "no correlatable id" as `null`; MCP's profile of JSON-RPC governs
 * this endpoint, and its spelling is an absent member.
 *
 * **On the payload.** The woo code and detail are preserved verbatim under
 * `error.data`, never flattened into prose. `error.message` stays the woo
 * message — one concise sentence, which is what JSON-RPC asks for and what a
 * client actually shows a user.
 */
export function mcpJsonRpcError(
  id: McpRequestId,
  code: number,
  message: string,
  data?: unknown
): McpJsonRpcErrorBody {
  return {
    jsonrpc: "2.0",
    ...(id === null ? {} : { id }),
    error: { code, message, ...(data === undefined ? {} : { data }) }
  };
}

/**
 * Render a woo refusal as a JSON-RPC error body.
 *
 * `http_status` rides in `data` as well as on the response, because a body
 * that gets copied out of a log or forwarded by an intermediary must still
 * carry the fact that decided its severity.
 */
export function mcpWooErrorBody(
  id: McpRequestId,
  refusal: McpWooRefusal,
  status: number
): McpJsonRpcErrorBody {
  return mcpJsonRpcError(id, MCP_JSONRPC_SERVER_ERROR, refusal.message, {
    code: refusal.code,
    ...(refusal.detail === undefined ? {} : { detail: refusal.detail }),
    ...(refusal.attempts === undefined ? {} : { attempts: refusal.attempts }),
    http_status: status
  });
}
