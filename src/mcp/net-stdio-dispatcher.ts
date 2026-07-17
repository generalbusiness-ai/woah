import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { NetMcpStdioProxy } from "./net-stdio-proxy";

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

  constructor(
    private readonly proxy: SessionAwareProxy,
    private readonly send: (message: JSONRPCMessage) => Promise<void>,
    private readonly onError: (error: unknown) => void
  ) {}

  dispatch(message: JSONRPCMessage): Promise<void> {
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

  /** Wait for all currently accepted messages before closing the HTTP session. */
  async idle(): Promise<void> {
    await Promise.all([...this.inFlight]);
  }
}
