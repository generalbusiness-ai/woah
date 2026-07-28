import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { hasRequestId, type NetMcpStdioProxy } from "./net-stdio-proxy";

type SessionAwareProxy = Pick<NetMcpStdioProxy, "sessionReady" | "forward">;

/**
 * Orders only the pre-session prefix of an MCP stdio stream.
 *
 * A pipelined client may write `initialize`, `notifications/initialized`, and
 * its first request without awaiting replies. Those messages must wait until
 * initialize has installed the HTTP session id. Once that happens, MCP permits
 * concurrent requests and a long `woo_wait` must not block unrelated calls or
 * keepalive traffic behind it.
 */
export class NetMcpStdioDispatcher {
  private preSessionTail: Promise<void> = Promise.resolve();
  private readonly inFlight = new Set<Promise<void>>();
  private closed = false;

  constructor(
    private readonly proxy: SessionAwareProxy,
    private readonly send: (message: JSONRPCMessage) => Promise<void>,
    private readonly onError: (error: unknown) => void
  ) {}

  /** Stop admitting new work.
   *
   * Shutdown calls this first so the set `idle()` waits on cannot keep growing
   * while it drains. It is deliberately not the same thing as closing the
   * proxy: already-accepted requests are still allowed to finish. */
  close(): void {
    this.closed = true;
  }

  dispatch(message: JSONRPCMessage): Promise<void> {
    if (this.closed) return this.refuse(message);
    const waitsForSession = !this.proxy.sessionReady;
    const forward = async (): Promise<void> => {
      const reply = await this.proxy.forward(message);
      if (reply) await this.send(reply);
    };
    const scheduled = waitsForSession
      ? this.preSessionTail.then(forward)
      : forward();
    const settled = scheduled.catch((error) => {
      this.onError(error);
    });

    // Preserve ordering only for messages observed before initialize finished.
    // Capturing waitsForSession prevents a session-id update during forward()
    // from accidentally retaining the permanent global promise chain.
    if (waitsForSession) this.preSessionTail = settled;
    this.inFlight.add(settled);
    void settled.then(() => this.inFlight.delete(settled));
    return settled;
  }

  /** Wait for all currently accepted messages before closing the HTTP session.
   *
   * Callers on a shutdown path must bound this wait: a request the Net endpoint
   * never answers would otherwise make it wait forever. */
  async idle(): Promise<void> {
    await Promise.all([...this.inFlight]);
  }

  /** Answer a message that arrived after `close()`.
   *
   * The HTTP session is about to be deleted, so the request cannot be served.
   * Replying beats dropping: a client that pipelined into our shutdown gets a
   * correlated error instead of waiting on a reply that will never arrive. */
  private async refuse(message: JSONRPCMessage): Promise<void> {
    if (!hasRequestId(message)) return;
    try {
      await this.send({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: "Net MCP stdio bridge is shutting down" }
      });
    } catch (error) {
      // stdout may already be closed; that is not worth a second failure.
      this.onError(error);
    }
  }
}
