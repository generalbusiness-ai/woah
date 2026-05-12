import { describe, expect, it } from "vitest";
import { installVerb } from "../src/core/authoring";
import { createWorld } from "../src/core/bootstrap";
import { effectTranscriptFromRecordedTurn } from "../src/core/effect-transcript";
import { profileShadowTurnAcrossNetworkShapes } from "../src/core/shadow-gossip-profile";
import { InMemoryTurnRecorder } from "../src/core/turn-recorder";
import { shadowTurnKeyFromTranscript } from "../src/core/turn-key";

describe("shadow gossip profiling", () => {
  it("executes a recorded turn across warm, cold, remote, and stale-ad shapes", async () => {
    const world = createWorld();
    const session = world.auth("guest:shadow-profile");
    const actor = session.actor;
    world.createObject({ id: "profile_box", name: "Profile Box", parent: "$thing", owner: actor });
    world.defineProperty("profile_box", { name: "counter", defaultValue: 0, owner: actor, perms: "rw", typeHint: "int" });
    const installed = installVerb(
      world,
      "profile_box",
      "bump",
      `verb :bump() rxd {
        let before = this.counter;
        this.counter = before + 1;
        return this.counter;
      }`,
      null
    );
    expect(installed.ok).toBe(true);

    const serializedBefore = world.exportWorld();
    const recorder = new InMemoryTurnRecorder();
    world.setTurnRecorder(recorder);
    const result = await world.directCall("shadow-profile-bump", actor, "profile_box", "bump", [], { sessionId: session.id });
    expect(result.op).toBe("result");

    const transcript = effectTranscriptFromRecordedTurn(recorder.turns[0]);
    const key = shadowTurnKeyFromTranscript(transcript);
    const profiles = await profileShadowTurnAcrossNetworkShapes({
      serializedBefore,
      turn: recorder.turns[0],
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
    expect(new Set(profiles.map((profile) => profile.transcript_hash))).toEqual(new Set([transcript.hash]));
    expect(byShape.warm_actor_local.transfer_bytes).toBe(0);
    expect(byShape.cold_actor_anchor_transfer.steps.map((step) => step.kind)).toEqual([
      "local_missing_state",
      "anchor_closure_transfer",
      "local_retry_execute"
    ]);
    expect(byShape.near_executor_remote.steps.map((step) => step.kind)).toEqual([
      "ad_rank_selected",
      "remote_execute_and_transfer"
    ]);
    expect(byShape.stale_ad_anchor_fallback.steps.map((step) => step.kind)).toEqual([
      "ad_rank_selected",
      "remote_missing_state",
      "anchor_closure_transfer",
      "local_retry_execute"
    ]);
    expect(byShape.warm_actor_local.total_latency_ms).toBeLessThan(byShape.near_executor_remote.total_latency_ms);
    expect(byShape.near_executor_remote.total_latency_ms).toBeLessThan(byShape.cold_actor_anchor_transfer.total_latency_ms);
    expect(byShape.cold_actor_anchor_transfer.total_latency_ms).toBeLessThan(byShape.stale_ad_anchor_fallback.total_latency_ms);
  });
});
