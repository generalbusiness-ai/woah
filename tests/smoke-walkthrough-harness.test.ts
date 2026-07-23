import { describe, expect, it } from "vitest";

import {
  isTimeoutDetail,
  smokeMcpTokens,
  SmokeCascadeHalt,
  raceWithAbort
} from "../scripts/smoke-walkthrough";
import { ensureInChatroom } from "../scripts/smoke/scenario";
import { SmokeSession, type McpTransport } from "../scripts/smoke/session";

describe("smoke walkthrough harness", () => {
  it("uses the authenticated Net actor from initialize without probing removed native tools", async () => {
    const methods: string[] = [];
    const transport: McpTransport = async (request) => {
      const body = request.body ? JSON.parse(String(request.body)) : {};
      methods.push(body.method);
      if (body.method === "initialize") {
        return Response.json({
          jsonrpc: "2.0",
          id: 1,
          result: {
            protocolVersion: "2025-06-18",
            instructions: "You are woo actor carried_alice. Dynamic tools follow your context."
          }
        }, { headers: { "mcp-session-id": "s_net-api-0_walkthrough" } });
      }
      if (body.method === "notifications/initialized") {
        return new Response(null, { status: 202 });
      }
      throw new Error(`unexpected MCP method ${String(body.method)}`);
    };

    const session = await SmokeSession.open(transport, {
      token: "apikey:key:secret",
      label: "alice",
      clientName: "smoke-session-test"
    });

    expect(session.actor).toBe("carried_alice");
    expect(methods).toEqual(["initialize", "notifications/initialized"]);
  });

  it("requires two explicit API keys for the deployed Net MCP walkthrough", () => {
    expect(smokeMcpTokens({
      WOO_SMOKE_ALICE_APIKEY: "apikey:alice:secret-a",
      WOO_SMOKE_BOB_APIKEY: "apikey:bob:secret-b"
    })).toEqual({
      alice: "apikey:alice:secret-a",
      bob: "apikey:bob:secret-b"
    });
    expect(() => smokeMcpTokens({})).toThrow("WOO_SMOKE_ALICE_APIKEY");
    expect(() => smokeMcpTokens({
      WOO_SMOKE_ALICE_APIKEY: "session:s_alice",
      WOO_SMOKE_BOB_APIKEY: "apikey:bob:secret-b"
    })).toThrow("apikey:<id>:<secret>");
  });

  it("routes a persistent taskboard actor back to the chatroom through public exits", async () => {
    const calls: string[] = [];
    const sessionStub: {
      currentRoom: string | null;
      label: string;
      callTool(): Promise<unknown>;
      call(object: string, verb: string, args: string[]): Promise<unknown>;
    } = {
      currentRoom: null,
      label: "bob",
      async callTool(): Promise<unknown> {
        return {
          result: {
            structuredContent: {
              result: {
                active_scope: "the_taskboard",
                tools: [
                  { object: "the_taskboard", verb: "look" },
                  { object: "the_taskboard", verb: "go" }
                ]
              }
            }
          }
        };
      },
      async call(object: string, verb: string, args: string[]): Promise<unknown> {
        calls.push(`${object}:${verb}:${args[0]}`);
        const next =
          object === "the_taskboard" ? "the_garden" :
          object === "the_garden" ? "the_deck" :
          "the_chatroom";
        sessionStub.currentRoom = next;
        return { room: next };
      }
    };
    const session = sessionStub as unknown as SmokeSession;

    await ensureInChatroom(session);

    expect(calls).toEqual([
      "the_taskboard:go:out",
      "the_garden:go:north",
      "the_deck:go:west"
    ]);
    expect(session.currentRoom).toBe("the_chatroom");
  });

  it("fails closed when the reachable surface does not identify one current room", async () => {
    const session = {
      currentRoom: null,
      label: "bob",
      async callTool(): Promise<unknown> {
        return { result: { structuredContent: { result: { tools: [] } } } };
      }
    } as unknown as SmokeSession;

    await expect(ensureInChatroom(session)).rejects.toThrow("active_scope=null");
  });

  it("aborts the in-flight step body when the watchdog fires", async () => {
    let observedAbort = false;
    const startedAt = Date.now();

    await expect(raceWithAbort(async (signal) => {
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener("abort", () => {
          observedAbort = true;
          reject(signal.reason instanceof Error ? signal.reason : new Error("aborted"));
        }, { once: true });
      });
    }, 10, "step deadline")).rejects.toThrow("step deadline");

    expect(observedAbort).toBe(true);
    expect(Date.now() - startedAt).toBeLessThan(1000);
  });

  it("does not abort work that finishes before the watchdog", async () => {
    let observedAbort = false;

    const result = await raceWithAbort(async (signal) => {
      signal.addEventListener("abort", () => {
        observedAbort = true;
      }, { once: true });
      return 42;
    }, 1000, "step deadline");

    expect(result).toBe(42);
    expect(observedAbort).toBe(false);
  });

  it("classifies gateway-saturation timeouts but not real protocol errors", () => {
    // These are the failure messages that should drive the cascade halt: a
    // saturated gateway times out the MCP POST, the per-RPC deadline, or the
    // step watchdog.
    expect(isTimeoutDetail("MCP POST https://woah1.generalbusiness.ai/mcp timed out after 20000ms")).toBe(true);
    expect(isTimeoutDetail("MCP request exceeded 20000ms deadline")).toBe(true);
    expect(isTimeoutDetail('step "enter:chatroom" exceeded 60000ms watchdog')).toBe(true);

    // Real protocol / content failures must NOT count — they are genuine
    // assertion failures, not gateway saturation, and should be reported
    // individually rather than triggering a halt. In particular a waitFor
    // "timeout after Nms waiting for matching observation" is a fanout/delivery
    // gap (the call succeeded; the expected observation never arrived), so it
    // must not be misread as a saturation timeout.
    expect(isTimeoutDetail("timeout after 5000ms waiting for matching observation")).toBe(false);
    expect(isTimeoutDetail('I don\'t see "mug" here.')).toBe(false);
    expect(isTimeoutDetail("reachable MCP tool not found: the_outline:add_item")).toBe(false);
    expect(isTimeoutDetail("MCP session not found; reinitialize")).toBe(false);
    expect(isTimeoutDetail(undefined)).toBe(false);
  });

  it("carries the consecutive-timeout count on the cascade-halt error", () => {
    const halt = new SmokeCascadeHalt(2);
    expect(halt).toBeInstanceOf(Error);
    expect(halt.name).toBe("SmokeCascadeHalt");
    expect(halt.count).toBe(2);
    expect(halt.message).toContain("2 consecutive timeout-class failures");
  });
});
