import { installVerb } from "../src/core/authoring";
import { createWorld } from "../src/core/bootstrap";
import { effectTranscriptFromRecordedTurn } from "../src/core/effect-transcript";
import { profileShadowTurnAcrossNetworkShapes } from "../src/core/shadow-gossip-profile";
import { InMemoryTurnRecorder } from "../src/core/turn-recorder";
import { shadowTurnKeyFromTranscript } from "../src/core/turn-key";

const world = createWorld();
const session = world.auth("guest:shadow-profile-cli");
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
if (!installed.ok) throw new Error("failed to install profile verb");

const serializedBefore = world.exportWorld();
const recorder = new InMemoryTurnRecorder();
world.setTurnRecorder(recorder);
const result = await world.directCall("shadow-profile-cli-bump", actor, "profile_box", "bump", [], { sessionId: session.id });
if (result.op !== "result") throw new Error(`profile turn failed: ${JSON.stringify(result.error)}`);

const transcript = effectTranscriptFromRecordedTurn(recorder.turns[0]);
const key = shadowTurnKeyFromTranscript(transcript);
const profiles = await profileShadowTurnAcrossNetworkShapes({ serializedBefore, turn: recorder.turns[0], key });

console.log("Shadow turn network profile");
console.log(`turn=${transcript.id ?? "(none)"} transcript=${transcript.hash} atoms=${key.atom_hashes.length}`);
console.table(profiles.map((profile) => ({
  shape: profile.shape,
  accepted: profile.accepted,
  attempts: profile.attempts,
  latency_ms: profile.total_latency_ms,
  transfer_kib: Math.round(profile.transfer_bytes / 102.4) / 10,
  steps: profile.steps.map((step) => step.kind).join(" -> ")
})));
