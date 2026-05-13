import { describe, expect, it } from "vitest";
import { createWorld } from "../src/core/bootstrap";
import { profileShadowTurnAcrossNetworkShapes } from "../src/core/shadow-gossip-profile";
import { runShadowTurnCall, type ShadowTurnCall } from "../src/core/shadow-turn-call";
import { shadowTurnKeyFromTranscript } from "../src/core/turn-key";

describe("shadow gossip profiling", () => {
  it("profiles a real dubspace turn across warm, cold, remote, and stale-ad shapes", async () => {
    const world = createWorld();
    const session = world.auth("guest:shadow-profile");
    const actor = session.actor;
    await world.directCall("shadow-profile-enter", actor, "the_dubspace", "enter", [], { sessionId: session.id });

    const serializedBefore = world.exportWorld();
    const call: ShadowTurnCall = {
      kind: "woo.turn_call.shadow.v1",
      id: "shadow-profile-set-control",
      route: "sequenced",
      scope: "the_dubspace",
      session: session.id,
      actor,
      target: "the_dubspace",
      verb: "set_control",
      args: ["delay_1", "wet", 0.61]
    };
    const planned = await runShadowTurnCall(serializedBefore, call);
    expect(planned.frame).toMatchObject({ op: "applied", space: "the_dubspace", seq: 1 });
    const key = shadowTurnKeyFromTranscript(planned.transcript);
    const profiles = await profileShadowTurnAcrossNetworkShapes({
      serializedBefore,
      call,
      key,
      options: {
        actor_anchor_rtt_ms: 80,
        actor_executor_rtt_ms: 18,
        stale_executor_rtt_ms: 24,
        transfer_bandwidth_bytes_per_ms: 200_000
      }
    });
    const byShape = Object.fromEntries(profiles.map((profile) => [profile.shape, profile]));

    expect(profiles).toHaveLength(4);
    expect(profiles.every((profile) => profile.accepted)).toBe(true);
    expect(new Set(profiles.map((profile) => profile.transcript_hash))).toEqual(new Set([planned.transcript.hash]));
    expect(byShape.warm_actor_local.transfer_bytes).toBe(0);
    expect(byShape.cold_actor_anchor_transfer.steps.map((step) => step.kind)).toEqual([
      "local_missing_state",
      "anchor_cell_page_transfer",
      "local_retry_execute"
    ]);
    expect(byShape.near_executor_remote.steps.map((step) => step.kind)).toEqual([
      "ad_rank_selected",
      "remote_execute_and_cell_page_transfer"
    ]);
    expect(byShape.stale_ad_anchor_fallback.steps.map((step) => step.kind)).toEqual([
      "ad_rank_selected",
      "remote_missing_state",
      "anchor_cell_page_transfer",
      "local_retry_execute"
    ]);
    expect(byShape.cold_actor_anchor_transfer.transfer_bytes).toBeLessThan(
      Buffer.byteLength(JSON.stringify(serializedBefore), "utf8")
    );
    expect(byShape.near_executor_remote.transfer_bytes).toBeLessThan(
      Buffer.byteLength(JSON.stringify(serializedBefore), "utf8")
    );
    expect(byShape.warm_actor_local.total_latency_ms).toBeLessThan(byShape.near_executor_remote.total_latency_ms);
    expect(byShape.near_executor_remote.total_latency_ms).toBeLessThan(byShape.cold_actor_anchor_transfer.total_latency_ms);
    expect(byShape.cold_actor_anchor_transfer.total_latency_ms).toBeLessThan(byShape.stale_ad_anchor_fallback.total_latency_ms);
  });
});
