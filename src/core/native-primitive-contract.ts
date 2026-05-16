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
  },
  help_db_find_topics: {
    kind: "woo.native_primitive_contract.shadow.v1",
    handler: "help_db_find_topics",
    version: 1,
    transcript: "tracked",
    deterministic: true,
    reads: ["help database topics"],
    writes: [],
    emits: [],
    note: "Help topic matching is a read-only projection over the tracked topics property."
  },
  help_db_get_topic: {
    kind: "woo.native_primitive_contract.shadow.v1",
    handler: "help_db_get_topic",
    version: 1,
    transcript: "tracked",
    deterministic: true,
    reads: ["help database topics", "forwarded help database topics", "object or verb docs when directives request them"],
    writes: [],
    emits: [],
    note: "Help topic rendering is read-only except when caller separately invokes record_miss."
  },
  help_db_dump_topic: {
    kind: "woo.native_primitive_contract.shadow.v1",
    handler: "help_db_dump_topic",
    version: 1,
    transcript: "tracked",
    deterministic: true,
    reads: ["help database topics"],
    writes: [],
    emits: [],
    note: "Help dump_topic is a read-only exact/abbreviation lookup over the tracked topics property."
  },
  help_db_record_miss: {
    kind: "woo.native_primitive_contract.shadow.v1",
    handler: "help_db_record_miss",
    version: 1,
    transcript: "tracked",
    deterministic: true,
    reads: ["help database missed_topics"],
    writes: ["help database missed_topics"],
    emits: ["logical_input"],
    note: "Help miss recording writes only the bounded missed_topics list and records its timestamp as a logical input."
  },
  player_join: {
    kind: "woo.native_primitive_contract.shadow.v1",
    handler: "player_join",
    version: 1,
    transcript: "tracked",
    deterministic: true,
    reads: ["target player name", "target player location", "actor location"],
    writes: ["actor location", "room contents", "presence mirrors through movement hooks"],
    emits: ["text observations", "left observation", "entered observation", "object_move", "cell_write", "logical_input"],
    note: "Join is transcript-safe through movetoChecked plus logical timestamps for emitted movement observations."
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
