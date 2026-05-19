import type { ObjRef } from "./types";
import type { EffectTranscript, TranscriptCell } from "./effect-transcript";
import { hashSource } from "./source-hash";

export type ShadowTurnKey = {
  kind: "woo.turn_key.shadow.v1";
  scope: ObjRef;
  actor: ObjRef;
  target: ObjRef;
  verb: string;
  preimages: string[];
  atom_hashes: string[];
  read_preimages: string[];
  read_atom_hashes: string[];
  write_preimages: string[];
  write_atom_hashes: string[];
  accept_preimages: string[];
  accept_atom_hashes: string[];
};

export function shadowTurnKeyFromTranscript(transcript: EffectTranscript): ShadowTurnKey {
  const preimages = new Set<string>();
  const readPreimages = new Set<string>();
  const writePreimages = new Set<string>();
  const acceptPreimages = new Set<string>();

  for (const preimage of [
    `actor:${transcript.call.actor}`,
    `target:${transcript.call.target}`,
    `scope:${transcript.scope}`
  ]) preimages.add(preimage);

  for (const preimage of [
    `scope:${transcript.scope}`,
    `target:${transcript.call.target}`,
    `call:${transcript.call.target}:${transcript.call.verb}`
  ]) {
    acceptPreimages.add(preimage);
    preimages.add(preimage);
  }

  for (const read of transcript.reads) {
    const preimage = shadowReadCellPreimage(read.cell);
    readPreimages.add(preimage);
    preimages.add(preimage);
  }
  for (const cell of transcript.stateProbes ?? []) {
    const preimage = shadowReadCellPreimage(cell);
    readPreimages.add(preimage);
    preimages.add(preimage);
  }
  for (const write of transcript.writes) {
    const preimage = shadowWriteCellPreimage(write.cell);
    writePreimages.add(preimage);
    preimages.add(preimage);
  }

  const sorted = Array.from(preimages).sort();
  const sortedReads = Array.from(readPreimages).sort();
  const sortedWrites = Array.from(writePreimages).sort();
  const sortedAccepts = Array.from(acceptPreimages).sort();
  return {
    kind: "woo.turn_key.shadow.v1",
    scope: transcript.scope,
    actor: transcript.call.actor,
    target: transcript.call.target,
    verb: transcript.call.verb,
    preimages: sorted,
    atom_hashes: sorted.map((preimage) => shadowAtomHash(preimage)),
    read_preimages: sortedReads,
    read_atom_hashes: sortedReads.map((preimage) => shadowAtomHash(preimage)),
    write_preimages: sortedWrites,
    write_atom_hashes: sortedWrites.map((preimage) => shadowAtomHash(preimage)),
    accept_preimages: sortedAccepts,
    accept_atom_hashes: sortedAccepts.map((preimage) => shadowAtomHash(preimage))
  };
}

export function shadowAtomHash(preimage: string): string {
  return hashSource(preimage);
}

export function shadowReadCellPreimage(cell: TranscriptCell): string {
  return `read:${shadowCellPreimage(cell)}`;
}

export function shadowWriteCellPreimage(cell: TranscriptCell): string {
  return `write:${shadowCellPreimage(cell)}`;
}

export function shadowCellPreimage(cell: TranscriptCell): string {
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
