import type { WooValue } from "./types";

export type NativePrimitiveContract = {
  kind: "woo.native_primitive_contract.shadow.v1";
  handler: string;
  version: number;
  transcript: "tracked";
  deterministic: true;
  reads: string[];
  writes: string[];
  emits: string[];
  note: string;
};

const CONTRACTS: Record<string, NativePrimitiveContract> = {
  thing_moveto: {
    kind: "woo.native_primitive_contract.shadow.v1",
    handler: "thing_moveto",
    version: 1,
    transcript: "tracked",
    deterministic: true,
    reads: [
      "object.location",
      "target.acceptable dispatch",
      "old-location.exitfunc dispatch",
      "target.enterfunc dispatch"
    ],
    writes: [
      "object.location",
      "container.contents"
    ],
    emits: [
      "object_move",
      "cell_write"
    ],
    note: "Movement is transcript-safe only through movetoChecked/moveObjectChecked instrumentation."
  },
  match_object: {
    kind: "woo.native_primitive_contract.shadow.v1",
    handler: "match_object",
    version: 1,
    transcript: "tracked",
    deterministic: true,
    reads: [
      "visible container contents",
      "candidate names",
      "candidate aliases",
      "candidate ancestry",
      "candidate readable-summary properties"
    ],
    writes: [],
    emits: [],
    note: "Name resolution is transcript-safe only while every semantic candidate read goes through recorded world accessors."
  },
  embodied_room_roster: {
    kind: "woo.native_primitive_contract.shadow.v1",
    handler: "embodied_room_roster",
    version: 1,
    transcript: "tracked",
    deterministic: true,
    reads: [
      "room contents",
      "actor display names",
      "actor session activity"
    ],
    writes: [],
    emits: [
      "logical_input"
    ],
    note: "Room roster construction is read-only; the native path exists to keep embodied presence filtering centralized."
  },
  workspace_room_roster: {
    kind: "woo.native_primitive_contract.shadow.v1",
    handler: "workspace_room_roster",
    version: 1,
    transcript: "tracked",
    deterministic: true,
    reads: [
      "session presence rows",
      "actor display names",
      "actor session activity"
    ],
    writes: [],
    emits: [
      "logical_input"
    ],
    note: "Workspace roster construction is read-only; the native path filters live session presence without mutating legacy mirrors."
  }
};

export function nativePrimitiveContract(handler: string | undefined): NativePrimitiveContract | null {
  if (!handler) return null;
  return CONTRACTS[handler] ?? null;
}

export function nativePrimitiveIsTranscriptTracked(handler: string | undefined): boolean {
  return nativePrimitiveContract(handler)?.transcript === "tracked";
}

export function nativePrimitiveContractValue(handler: string | undefined): WooValue {
  const contract = nativePrimitiveContract(handler);
  return contract ? structuredClone(contract) as unknown as WooValue : null;
}
