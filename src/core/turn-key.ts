import type { SerializedObject, SerializedWorld } from "./repository";
import type { ObjRef } from "./types";
import type { EffectTranscript, TranscriptCell } from "./effect-transcript";
import { hashSource } from "./source-hash";

// VTN11 effect mask: the classes of effect a turn performs. An executor's ad
// advertises the classes it `accepts` (ad.effects); a turn routes to an ad only
// when the turn's effects are a SUBSET of the ad's. A turn whose effect mask is
// not covered must not route there even if the Bloom atoms appear covered.
export const SHADOW_EFFECT_READ = 1 << 0;
export const SHADOW_EFFECT_PROP_WRITE = 1 << 1;
export const SHADOW_EFFECT_VERB_WRITE = 1 << 2;
export const SHADOW_EFFECT_MOVE = 1 << 3;       // location writes / object moves
export const SHADOW_EFFECT_CREATE = 1 << 4;
export const SHADOW_EFFECT_LIFECYCLE = 1 << 5;  // recycle / delete
export const SHADOW_EFFECT_OBSERVE = 1 << 6;
export const SHADOW_EFFECT_SEQUENCED = 1 << 7;
// Full capability: a node that owns/holds the scope state accepts every class.
export const SHADOW_EFFECTS_ALL = (1 << 8) - 1;
// Wildcard scope generation: matches any key/ad epoch. Concrete epochs are
// minted by route-epoch migration (CA10), which is deferred; until then keys and
// in-process ads carry the wildcard so epoch selection is a no-op that becomes
// load-bearing the moment a migration stamps a concrete generation.
export const SHADOW_EPOCH_WILDCARD = "shadow";

export type ShadowTurnKey = {
  kind: "woo.turn_key.shadow.v1";
  scope: ObjRef;
  // VTN11 scope generation this key planned against (SHADOW_EPOCH_WILDCARD until
  // route-epoch migration stamps concrete generations).
  epoch: string;
  actor: ObjRef;
  target: ObjRef;
  verb: string;
  // VTN11 effect mask of the turn (bitwise-OR of SHADOW_EFFECT_*).
  effects: number;
  preimages: string[];
  atom_hashes: string[];
  read_preimages: string[];
  read_atom_hashes: string[];
  write_preimages: string[];
  write_atom_hashes: string[];
  accept_preimages: string[];
  accept_atom_hashes: string[];
};

export function shadowTurnEffectsFromTranscript(transcript: EffectTranscript): number {
  let effects = 0;
  if (transcript.reads.length > 0 || (transcript.stateProbes?.length ?? 0) > 0) effects |= SHADOW_EFFECT_READ;
  for (const write of transcript.writes) {
    switch (write.cell.kind) {
      case "prop": effects |= SHADOW_EFFECT_PROP_WRITE; break;
      case "verb": effects |= SHADOW_EFFECT_VERB_WRITE; break;
      case "location": effects |= SHADOW_EFFECT_MOVE; break;
      case "lifecycle": effects |= SHADOW_EFFECT_LIFECYCLE; break;
      // `contents` is a per-member projection (A4), not an authoritative effect
      // class that constrains executor capability — excluded from the mask.
      case "contents": break;
    }
  }
  if (transcript.moves.length > 0) effects |= SHADOW_EFFECT_MOVE;
  if (transcript.creates.length > 0) effects |= SHADOW_EFFECT_CREATE;
  if (transcript.observations.length > 0) effects |= SHADOW_EFFECT_OBSERVE;
  if (transcript.route === "sequenced") effects |= SHADOW_EFFECT_SEQUENCED;
  return effects;
}

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
    epoch: SHADOW_EPOCH_WILDCARD,
    actor: transcript.call.actor,
    target: transcript.call.target,
    verb: transcript.call.verb,
    effects: shadowTurnEffectsFromTranscript(transcript),
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

export function shadowTurnKeyFromCall(call: {
  scope: ObjRef;
  actor: ObjRef;
  target: ObjRef;
  verb: string;
}): ShadowTurnKey {
  // Static intent keys deliberately name only the routing/acceptance atoms known
  // before VM execution. Sparse executors then discover the real read/write
  // closure by guarded execution: each missing dispatch/property/object cell
  // becomes `missing_state`, the caller hydrates, and the whole turn retries.
  const preimages = new Set<string>();
  const acceptPreimages = new Set<string>();
  for (const preimage of [
    `actor:${call.actor}`,
    `target:${call.target}`,
    `scope:${call.scope}`
  ]) preimages.add(preimage);
  for (const preimage of [
    `scope:${call.scope}`,
    `target:${call.target}`,
    `call:${call.target}:${call.verb}`
  ]) {
    acceptPreimages.add(preimage);
    preimages.add(preimage);
  }
  const sorted = Array.from(preimages).sort();
  const sortedAccepts = Array.from(acceptPreimages).sort();
  return {
    kind: "woo.turn_key.shadow.v1",
    scope: call.scope,
    epoch: SHADOW_EPOCH_WILDCARD,
    actor: call.actor,
    target: call.target,
    verb: call.verb,
    // A static pre-execution intent key does not yet know its effect closure;
    // claiming no effects (0) imposes no effect-subset constraint on routing —
    // the executor proves the real closure by executing or returning missing_state.
    effects: 0,
    preimages: sorted,
    atom_hashes: sorted.map((preimage) => shadowAtomHash(preimage)),
    read_preimages: [],
    read_atom_hashes: [],
    write_preimages: [],
    write_atom_hashes: [],
    accept_preimages: sortedAccepts,
    accept_atom_hashes: sortedAccepts.map((preimage) => shadowAtomHash(preimage))
  };
}

export function shadowMaterializedAtomHashesFromSerialized(serialized: SerializedWorld): string[] {
  return shadowMaterializedCellPreimagesFromSerialized(serialized).map((preimage) => shadowAtomHash(preimage));
}

export function shadowMaterializedCellPreimagesFromSerialized(serialized: SerializedWorld): string[] {
  const preimages = new Set<string>();
  const byId = new Map(serialized.objects.map((obj) => [obj.id, obj] as const));
  for (const obj of serialized.objects) {
    for (const preimage of shadowMaterializedCellPreimagesForObject(byId, obj)) preimages.add(preimage);
  }
  return Array.from(preimages).sort();
}

function shadowMaterializedCellPreimagesForObject(
  byId: ReadonlyMap<ObjRef, SerializedObject>,
  obj: SerializedObject
): string[] {
  // These atoms represent what the serialized slice actually materializes, not
  // what a turn is statically predicted to touch. A guarded whole-scope
  // executor can therefore run once when its slice is complete, while an
  // absent object still becomes a lifecycle materialization miss.
  const preimages = new Set<string>();
  preimages.add(`read:cell:lifecycle:${obj.id}`);
  preimages.add(`read:cell:location:${obj.id}`);
  preimages.add(`write:cell:location:${obj.id}`);
  preimages.add(`read:cell:contents:${obj.id}`);
  preimages.add(`write:cell:contents:${obj.id}`);

  const propNames = materializedPropertyNamesForObject(byId, obj);
  for (const name of Array.from(propNames).sort()) {
    preimages.add(`read:cell:prop:${obj.id}.${name}`);
    if (name !== "owner") preimages.add(`write:cell:prop:${obj.id}.${name}`);
  }

  for (const verb of obj.verbs) {
    preimages.add(`read:cell:verb:${obj.id}:${verb.name}`);
    preimages.add(`write:cell:verb:${obj.id}:${verb.name}`);
  }
  return Array.from(preimages).sort();
}

function materializedPropertyNamesForObject(
  byId: ReadonlyMap<ObjRef, SerializedObject>,
  obj: SerializedObject
): Set<string> {
  const names = new Set<string>(["name", "owner"]);
  for (const def of obj.propertyDefs) names.add(def.name);
  for (const [name] of obj.properties) names.add(name);
  for (const [name] of obj.propertyVersions) names.add(name);
  const seen = new Set<ObjRef>();
  let parent = obj.parent;
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    const ancestor = byId.get(parent);
    if (!ancestor) break;
    for (const def of ancestor.propertyDefs) names.add(def.name);
    parent = ancestor.parent;
  }
  return names;
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
