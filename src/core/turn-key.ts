import { hashSource } from "./source-hash";
import type { ObjRef } from "./types";
import type { EffectTranscript, TranscriptCell } from "./effect-transcript";

export type ShadowTurnKey = {
  kind: "woo.turn_key.shadow.v1";
  scope: ObjRef;
  actor: ObjRef;
  target: ObjRef;
  verb: string;
  preimages: string[];
  atom_hashes: string[];
};

export function shadowTurnKeyFromTranscript(transcript: EffectTranscript): ShadowTurnKey {
  const preimages = new Set<string>();
  preimages.add(`actor:${transcript.call.actor}`);
  preimages.add(`target:${transcript.call.target}`);
  preimages.add(`call:${transcript.call.target}:${transcript.call.verb}`);
  preimages.add(`scope:${transcript.scope}`);
  for (const read of transcript.reads) preimages.add(`read:${cellPreimage(read.cell)}`);
  for (const write of transcript.writes) preimages.add(`write:${cellPreimage(write.cell)}`);
  const sorted = Array.from(preimages).sort();
  return {
    kind: "woo.turn_key.shadow.v1",
    scope: transcript.scope,
    actor: transcript.call.actor,
    target: transcript.call.target,
    verb: transcript.call.verb,
    preimages: sorted,
    atom_hashes: sorted.map((preimage) => hashSource(preimage))
  };
}

function cellPreimage(cell: TranscriptCell): string {
  switch (cell.kind) {
    case "prop":
      return `cell:prop:${cell.object}.${cell.name}`;
    case "verb":
      return `cell:verb:${cell.object}:${cell.name}`;
    case "location":
      return `cell:location:${cell.object}`;
    case "contents":
      return `cell:contents:${cell.object}`;
    case "lifecycle":
      return `cell:lifecycle:${cell.object}`;
  }
}
