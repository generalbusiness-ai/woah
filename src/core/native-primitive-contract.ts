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
  player_moveto: {
    kind: "woo.native_primitive_contract.shadow.v1",
    handler: "player_moveto",
    version: 1,
    transcript: "tracked",
    deterministic: true,
    reads: [
      "actor session",
      "actor.location",
      "target.acceptable dispatch",
      "old-location.exitfunc dispatch",
      "target.enterfunc dispatch"
    ],
    writes: [
      "actor.location",
      "session.activeScope",
      "container.contents"
    ],
    emits: [
      "object_move",
      "session_scope",
      "cell_write"
    ],
    open_seed: {
      dispatch_verb_names: ["moveto"],
      verb_lookups: [
        {
          receiver: "actor_location",
          names: ["exitfunc"],
          reason: "The movement chain probes the old container hook before moving an actor out."
        },
        {
          receiver: "scope",
          names: ["acceptable", "enterfunc"],
          reason: "A first local actor movement needs target admission and post-entry hooks without a repair round."
        }
      ]
    },
    note: "Player movement is transcript-safe through movetoActorChecked, which records physical location and session-scope presence transitions."
  },
  guest_on_disfunc: {
    kind: "woo.native_primitive_contract.shadow.v1",
    handler: "guest_on_disfunc",
    version: 1,
    transcript: "tracked",
    deterministic: true,
    reads: [
      "guest ancestry",
      "guest.home",
      "optional reset destination",
      "guest.location",
      "guest.contents",
      "carried-item home and location",
      "reset destination existence",
      "container contents projections",
      "guest.features_version"
    ],
    writes: [
      "carried-item location",
      "guest.location",
      "container.contents",
      "guest.description",
      "guest.aliases",
      "guest.features",
      "guest.features_version"
    ],
    emits: ["object_move", "cell_write"],
    note: "Guest reset is transcript-safe because inventory ejection and actor placement use recorded movement, while every durable reset field uses recorded property writes. The optional destination is a trusted cleanup override; omitted calls retain home/$nowhere behavior. returnGuest only updates the classic runtime's in-memory allocator and is a no-op while a live exclusive session owns the actor."
  },
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
      dispatch_verb_names: ["moveto"],
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
    reads: ["target actor api_keys", "target actor existence", "target actor ancestry", "target actor authority anchor", "actor wizard authority"],
    writes: ["target actor api_keys"],
    emits: [],
    note: "Wizard-authority minting: the target actor cluster owns the verifier record; the accepted authenticated transcript is the issuance audit. Cleartext is returned once and never stored."
  },
  create_api_key_for_owner: {
    kind: "woo.native_primitive_contract.shadow.v1",
    handler: "create_api_key_for_owner",
    version: 1,
    transcript: "tracked",
    deterministic: true,
    reads: ["target actor api_keys", "target actor existence", "target actor ancestry", "target actor authority anchor", "target actor ownership", "actor wizard authority"],
    writes: ["target actor api_keys"],
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
    note: "Historical global-registry compatibility listing is read-only and returns redacted metadata only; actor-owned authorities are not globally enumerable."
  },
  list_api_keys_for_owner: {
    kind: "woo.native_primitive_contract.shadow.v1",
    handler: "list_api_keys_for_owner",
    version: 1,
    transcript: "tracked",
    deterministic: true,
    reads: ["explicit target actor api_keys", "target actor existence and ancestry", "actor ownership"],
    writes: [],
    emits: [],
    note: "Bounded actor-authority listing is read-only and returns redacted metadata only; the target is an explicit argument, never inferred from the caller frame."
  },
  revoke_api_key: {
    kind: "woo.native_primitive_contract.shadow.v1",
    handler: "revoke_api_key",
    version: 1,
    transcript: "tracked",
    deterministic: true,
    reads: ["routed actor api_keys or legacy $system.api_keys", "actor ownership", "local sessions"],
    writes: ["routed actor api_keys.revoked_at or legacy $system.api_keys.revoked_at", "local sessions"],
    emits: [],
    note: "Revocation records the authoritative property mutation in the transcript; gateway and Directory session cleanup runs only after an accepted commit."
  },
  human_promote_agent_to_programmer: {
    kind: "woo.native_primitive_contract.shadow.v1",
    handler: "human_promote_agent_to_programmer",
    version: 1,
    transcript: "tracked",
    deterministic: true,
    reads: [
      "human/agent lineage and ownership",
      "human.account and account binding",
      "account.programmer_grant_quota",
      "account.programmer_agent_count",
      "$system.programmer_surface",
      "agent.features and features_version",
      "agent ancestry (surface composability)"
    ],
    writes: [
      "agent lineage (programmer flag, via the object_lineage seam)",
      "agent.features",
      "agent.features_version",
      "account.programmer_agent_count"
    ],
    emits: ["cell_write"],
    open_seed: {
      object_property_names: [
        "account",
        "programmer_grant_quota",
        "programmer_agent_count",
        "features",
        "features_version"
      ],
      catalog_property_names: ["programmer_surface"]
    },
    note: "Human self-service promote. Flips the agent's programmer flag through the object_lineage lineage seam (a recorded lineage replacement), attaches the published programmer surface as a feature, and increments the account programmer count — all recorded lineage/property writes, co-resident in the human authority cluster. The audit is the durable commit record; the $system.wizard_actions catalog write is suppressed by the profile sink on Net (audit.md AU1)."
  },
  human_demote_agent_from_programmer: {
    kind: "woo.native_primitive_contract.shadow.v1",
    handler: "human_demote_agent_from_programmer",
    version: 1,
    transcript: "tracked",
    deterministic: true,
    reads: [
      "human/agent lineage and ownership",
      "human.account and account binding",
      "account.programmer_agent_count",
      "$system.programmer_surface",
      "agent.features and features_version"
    ],
    writes: [
      "agent lineage (programmer flag, via the object_lineage seam)",
      "agent.features",
      "agent.features_version",
      "account.programmer_agent_count"
    ],
    emits: ["cell_write"],
    open_seed: {
      object_property_names: [
        "account",
        "programmer_agent_count",
        "features",
        "features_version"
      ],
      catalog_property_names: ["programmer_surface"]
    },
    note: "Human self-service demote: the inverse of promote. Clears the agent's programmer flag through the lineage seam, removes the programmer surface feature, and decrements the account programmer count — all recorded, co-resident. Audit is the commit record; no catalog $system write on Net."
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
    note: "Help topic rendering is read-only; a miss returns a not_found reply carrying the topic list, and writes nothing."
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
  },
  replay: {
    kind: "woo.native_primitive_contract.shadow.v1",
    handler: "replay",
    version: 1,
    transcript: "tracked",
    deterministic: true,
    reads: ["owner-attested committed replay page (transcript.replayReads)"],
    writes: [],
    emits: [],
    note: "The sequenced-log read wrapper (sequenced-log.md SL2/SL4) is transcript-safe on the sparse planning path because it resolves ONLY to an owner-served committed page installed for the exact (space, from, limit) query — attested in replayReads and re-derived by the owning scope at commit — and misses uncatchably (E_NEED_REPLAY_PAGE) otherwise. A complete local runtime reads its own durable log, which is equally deterministic pre-commit."
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
