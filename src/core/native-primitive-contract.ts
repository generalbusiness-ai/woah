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
  },
  match_verb: {
    kind: "woo.native_primitive_contract.shadow.v1",
    handler: "match_verb",
    version: 1,
    transcript: "tracked",
    deterministic: true,
    reads: ["target visibility", "verb metadata"],
    writes: [],
    emits: [],
    note: "Command verb matching is read-only; verb metadata reads are recorded through dispatch/summary accessors."
  },
  match_command_verb: {
    kind: "woo.native_primitive_contract.shadow.v1",
    handler: "match_command_verb",
    version: 1,
    transcript: "tracked",
    deterministic: true,
    reads: ["target visibility", "command verb metadata"],
    writes: [],
    emits: [],
    note: "Command dispatch planning is read-only and produces only matched verb metadata."
  },
  plan_command: {
    kind: "woo.native_primitive_contract.shadow.v1",
    handler: "plan_command",
    version: 1,
    transcript: "tracked",
    deterministic: true,
    reads: ["space presence", "visible objects", "command parser metadata"],
    writes: [],
    emits: [],
    note: "Planner output is a read-only logical result; subsequent execution records the actual verb dispatch."
  },
  parse_command: {
    kind: "woo.native_primitive_contract.shadow.v1",
    handler: "parse_command",
    version: 1,
    transcript: "tracked",
    deterministic: true,
    reads: ["space presence", "visible objects", "command parser metadata"],
    writes: [],
    emits: [],
    note: "Command parsing is read-only and all semantic candidates are read through tracked match helpers."
  },
  list_api_keys: {
    kind: "woo.native_primitive_contract.shadow.v1",
    handler: "list_api_keys",
    version: 1,
    transcript: "tracked",
    deterministic: true,
    reads: ["$system.api_keys"],
    writes: [],
    emits: [],
    note: "API key listing is read-only and returns redacted metadata only."
  },
  list_api_keys_for_owner: {
    kind: "woo.native_primitive_contract.shadow.v1",
    handler: "list_api_keys_for_owner",
    version: 1,
    transcript: "tracked",
    deterministic: true,
    reads: ["$system.api_keys", "actor ownership"],
    writes: [],
    emits: [],
    note: "Owner-scoped API key listing is read-only and returns redacted metadata only."
  },
  revoke_api_key: {
    kind: "woo.native_primitive_contract.shadow.v1",
    handler: "revoke_api_key",
    version: 1,
    transcript: "tracked",
    deterministic: true,
    reads: ["$system.api_keys", "actor ownership", "local sessions"],
    writes: ["$system.api_keys.revoked_at", "local sessions"],
    emits: [],
    note: "Revocation records the authoritative property mutation in the transcript; gateway and Directory session cleanup runs only after an accepted commit."
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
