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
  open_seed?: NativePrimitiveOpenSeedContract;
  note: string;
};

export type NativePrimitiveOpenSeedVerbLookup = {
  receiver: "scope" | "actor_location";
  names: string[];
  reason: string;
};

export type NativePrimitiveOpenSeedContract = {
  verb_lookups?: NativePrimitiveOpenSeedVerbLookup[];
  object_property_names?: string[];
  object_verb_lookup_names?: string[];
  catalog_property_names?: string[];
  dispatch_verb_names?: string[];
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
    open_seed: {
      verb_lookups: [
        {
          receiver: "actor_location",
          names: ["exitfunc"],
          reason: "The movement chain probes the old container hook before moving an actor out."
        },
        {
          receiver: "scope",
          names: ["acceptable", "enterfunc"],
          reason: "A first local enter needs target admission and post-entry hooks without a repair round."
        }
      ]
    },
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
    open_seed: {
      verb_lookups: [
        {
          receiver: "scope",
          names: ["command_plan"],
          reason: "Text command planning must enter through the catalog wrapper on a cold browser scope."
        }
      ],
      // "text" is included because catalog classes that define a match_names verb
      // may read this.text to extract line-based match names from their body. The
      // match_names verb bytecode is seeded via object_verb_lookup_names; its data
      // dependency (text) must be in the atom-guard set or planning returns
      // missing_state for any room that contains such an object. Cell pages for
      // text are already included for objects that carry the property; this entry
      // ensures the preimage is registered so missingAtomsForShadowTurn accepts it.
      object_property_names: ["aliases", "description", "name", "text"],
      object_verb_lookup_names: ["match_names"],
      dispatch_verb_names: ["command_plan"]
    },
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
  create_api_key: {
    kind: "woo.native_primitive_contract.shadow.v1",
    handler: "create_api_key",
    version: 1,
    transcript: "tracked",
    deterministic: true,
    reads: ["$system.api_keys", "target actor existence", "target actor ancestry", "actor wizard authority"],
    writes: ["$system.api_keys", "$system.wizard_actions"],
    emits: [],
    note: "Wizard-authority minting: records the authoritative api_keys insertion and audit append in the transcript. The minted secret is derived from randomness recorded by the host as a logical input — replay produces the same record."
  },
  create_api_key_for_owner: {
    kind: "woo.native_primitive_contract.shadow.v1",
    handler: "create_api_key_for_owner",
    version: 1,
    transcript: "tracked",
    deterministic: true,
    reads: ["$system.api_keys", "target actor existence", "target actor ancestry", "target actor ownership", "actor wizard authority"],
    writes: ["$system.api_keys", "$system.wizard_actions"],
    emits: [],
    note: "Owner-mint path used by block mint_apikey: same effect shape as create_api_key, with the wizard-authority check replaced by an ownership read."
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
  catalog_registry_install: {
    kind: "woo.native_primitive_contract.shadow.v1",
    handler: "catalog_registry_install",
    version: 1,
    transcript: "tracked",
    deterministic: true,
    reads: ["$catalog_registry.installed_catalogs", "world class registry", "world object existence", "actor wizard authority"],
    writes: ["$catalog_registry.installed_catalogs", "world classes", "world seed objects", "world verbs", "world property defs", "world event schemas", "feature attachments"],
    emits: ["catalog_install"],
    note: "Catalog install runs as a sequenced $catalog_registry call. All authoritative mutations (class creation, seed_hook instance creation, feature attachment) flow through the recorded transcript; recovery from a partial install is operator-driven (CT14.3)."
  },
  catalog_registry_update: {
    kind: "woo.native_primitive_contract.shadow.v1",
    handler: "catalog_registry_update",
    version: 1,
    transcript: "tracked",
    deterministic: true,
    reads: ["$catalog_registry.installed_catalogs", "world class registry", "world object state", "actor wizard authority"],
    writes: ["$catalog_registry.installed_catalogs", "world classes", "world seed objects", "world verbs", "world property defs", "migration_state"],
    emits: ["catalog_update", "migration_failed"],
    note: "Catalog update reuses the install pipeline plus any optional migration steps; same transcript-completeness contract."
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
  },
  actor_focus: {
    kind: "woo.native_primitive_contract.shadow.v1",
    handler: "actor_focus",
    version: 1,
    transcript: "tracked",
    deterministic: true,
    reads: ["target existence", "target actor ancestry", "target name visibility", "actor focus_list"],
    writes: ["actor focus_list"],
    emits: ["cell_write"],
    note: "Focus is transcript-safe because it only appends a validated object ref to the bounded actor-owned focus_list property."
  },
  actor_unfocus: {
    kind: "woo.native_primitive_contract.shadow.v1",
    handler: "actor_unfocus",
    version: 1,
    transcript: "tracked",
    deterministic: true,
    reads: ["actor focus_list"],
    writes: ["actor focus_list"],
    emits: ["cell_write"],
    note: "Unfocus is transcript-safe because it only removes an object ref from the actor-owned focus_list property."
  },
  actor_focus_list: {
    kind: "woo.native_primitive_contract.shadow.v1",
    handler: "actor_focus_list",
    version: 1,
    transcript: "tracked",
    deterministic: true,
    reads: ["actor focus_list"],
    writes: [],
    emits: [],
    note: "Focus-list reads are deterministic actor-local property reads."
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

export function nativePrimitiveOpenSeedVerbLookups(): NativePrimitiveOpenSeedVerbLookup[] {
  return Object.values(CONTRACTS).flatMap((contract) =>
    (contract.open_seed?.verb_lookups ?? []).map((lookup) => ({
      receiver: lookup.receiver,
      names: uniqueSorted(lookup.names),
      reason: `${contract.handler}: ${lookup.reason}`
    }))
  );
}

export function nativePrimitiveOpenSeedObjectPropertyNames(): string[] {
  return uniqueSorted(Object.values(CONTRACTS).flatMap((contract) => contract.open_seed?.object_property_names ?? []));
}

export function nativePrimitiveOpenSeedCatalogPropertyNames(): string[] {
  return uniqueSorted(Object.values(CONTRACTS).flatMap((contract) => contract.open_seed?.catalog_property_names ?? []));
}

export function nativePrimitiveOpenSeedDispatchVerbNames(): string[] {
  return uniqueSorted(Object.values(CONTRACTS).flatMap((contract) => contract.open_seed?.dispatch_verb_names ?? []));
}

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort();
}
