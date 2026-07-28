import type { WooValue } from "./types";

/** Hard upper bound for every adapter's account-authority snapshot.
 *
 * Both the member-bearing arrays and their de-duplicated union are checked
 * before the planner runs. Keeping the limit beside the shared contract
 * prevents the monolithic and Net adapters from drifting into different
 * resource envelopes. */
export const ACCOUNT_REPAIR_MEMBER_LIMIT = 1024;

/** One bounded member of an account authority supplied to the pure repair
 * planner. Adapters are responsible for proving that the object facts came
 * from the addressed authority; the planner never enumerates a world. */
export type AccountRepairMember = {
  id: string;
  kind: "human" | "agent" | "other";
  owner: string | null;
  authority_root: string | null;
  account: string | null;
  flags: Record<string, boolean>;
  features: unknown;
  api_key_id: unknown;
  api_keys: unknown;
  deactivated_at: unknown;
  retired_at: unknown;
  provision_id: unknown;
};

export type AccountRepairSnapshot = {
  account: string;
  authority_scope: string;
  authority_root: string;
  primary_actor: unknown;
  actors: unknown;
  agent_count: unknown;
  programmer_agent_count: unknown;
  operator_provisioned_agents: unknown;
  programmer_surface: unknown;
  explicit_candidates?: string[];
  members: AccountRepairMember[];
};

export type AccountRepairConflict = {
  code: string;
  object: string;
  field: string;
  detail?: Record<string, WooValue>;
};

export type AccountRepairPatch =
  | {
      kind: "property";
      object: string;
      name: string;
      before: WooValue;
      after: WooValue;
      reason: string;
    }
  | {
      kind: "lineage_flags";
      object: string;
      before: Record<string, boolean>;
      after: Record<string, boolean>;
      reason: string;
    };

export type AccountRepairPlan = {
  kind: "woo.account_state_repair.v1";
  account: string;
  authority_scope: string;
  status: "empty" | "would_apply" | "conflict";
  patches: AccountRepairPatch[];
  conflicts: AccountRepairConflict[];
  inspected: {
    registry_members: number;
    agents: number;
    operator_ledger_entries: number;
  };
};

export type AccountRepairPatchSummary =
  | Pick<Extract<AccountRepairPatch, { kind: "property" }>, "kind" | "object" | "name" | "reason">
  | Pick<Extract<AccountRepairPatch, { kind: "lineage_flags" }>, "kind" | "object" | "reason">;

export type AccountRepairResult = Omit<AccountRepairPlan, "status" | "patches"> & {
  status: AccountRepairPlan["status"] | "applied";
  /** Operator-visible patch descriptions deliberately omit before/after
   * values. In particular, credential repairs must never print verifier
   * hashes or salts into a terminal, HTTP response, or operations log. */
  patches: AccountRepairPatchSummary[];
  dry_run: boolean;
  changed: string[];
};

type CredentialRecord = Record<string, WooValue>;

/**
 * Derive the only repairs whose intended value follows from durable account
 * facts. A conflict suppresses every patch: operators never receive a
 * half-repair merely because an unrelated-looking inconsistency was found
 * later in the same authority snapshot.
 */
export function planAccountStateRepair(snapshot: AccountRepairSnapshot): AccountRepairPlan {
  const conflicts: AccountRepairConflict[] = [];
  const proposed: AccountRepairPatch[] = [];
  const members = new Map(snapshot.members.map((member) => [member.id, member]));
  const primary = typeof snapshot.primary_actor === "string" ? snapshot.primary_actor : null;
  if (!primary) {
    conflict(conflicts, "invalid_primary_actor", snapshot.account, "primary_actor");
  }

  const registry = stringList(snapshot.actors);
  if (!registry) {
    conflict(conflicts, "invalid_actor_registry", snapshot.account, "actors");
  }
  const ledger = stringMap(snapshot.operator_provisioned_agents);
  if (!ledger) {
    conflict(conflicts, "invalid_operator_ledger", snapshot.account, "operator_provisioned_agents");
  }

  const registryBefore = registry ?? [];
  const registryAfter = unique(registryBefore);
  if (primary && !registryAfter.includes(primary)) registryAfter.unshift(primary);
  const ledgerEntries = ledger ? Object.entries(ledger) : [];
  for (const [, id] of ledgerEntries) {
    if (!registryAfter.includes(id)) registryAfter.push(id);
  }

  const primaryMember = primary ? members.get(primary) : undefined;
  if (primary && !primaryMember) {
    conflict(conflicts, "primary_actor_missing", primary, "object_lineage");
  } else if (primaryMember) {
    if (primaryMember.kind !== "human" || primaryMember.account !== snapshot.account) {
      conflict(conflicts, "primary_actor_account_mismatch", primaryMember.id, "account");
    }
    if (primaryMember.authority_root !== snapshot.authority_root) {
      conflict(conflicts, "primary_actor_authority_mismatch", primaryMember.id, "authority_root");
    }
  }

  const validHumans = new Set<string>();
  for (const id of registryAfter) {
    const member = members.get(id);
    if (!member) {
      conflict(conflicts, "registered_actor_missing", id, "object_lineage");
      continue;
    }
    if (member.authority_root !== snapshot.authority_root) {
      conflict(conflicts, "registered_actor_authority_mismatch", id, "authority_root");
      continue;
    }
    if (member.kind === "human") {
      if (member.account !== snapshot.account) {
        conflict(conflicts, "registered_human_account_mismatch", id, "account");
      } else {
        validHumans.add(id);
      }
    }
  }

  if (primary) validHumans.add(primary);
  for (const id of snapshot.explicit_candidates ?? []) {
    const member = members.get(id);
    if (!member) {
      conflict(conflicts, "explicit_candidate_missing", id, "object_lineage");
    } else if (member.kind !== "agent") {
      conflict(conflicts, "explicit_candidate_is_not_account_actor", id, "object_lineage");
    } else if (member.authority_root !== snapshot.authority_root) {
      conflict(conflicts, "explicit_candidate_authority_mismatch", id, "authority_root");
    } else if (!member.owner || !validHumans.has(member.owner)) {
      conflict(conflicts, "explicit_candidate_owner_mismatch", id, "owner");
    }
  }
  const ledgerByAgent = new Map<string, string>();
  for (const [provisionId, agent] of ledgerEntries) {
    const prior = ledgerByAgent.get(agent);
    if (prior && prior !== provisionId) {
      conflict(conflicts, "operator_ledger_aliases_agent", agent, "operator_provisioned_agents");
    } else {
      ledgerByAgent.set(agent, provisionId);
    }
  }

  // Every authority-supplied agent owned by an account human must either be in
  // the account registry or carry the AP11 forward+reverse operation evidence
  // that makes adding it unambiguous. Ordinary failed-create residue has no
  // such evidence and remains a conflict; this planner never recycles it.
  for (const member of snapshot.members) {
    if (member.kind !== "agent" || !member.owner || !validHumans.has(member.owner)) continue;
    if (member.authority_root !== snapshot.authority_root) continue;
    if (registryAfter.includes(member.id)) continue;
    const provisionId = typeof member.provision_id === "string" ? member.provision_id : null;
    if (provisionId && ledger?.[provisionId] === member.id) {
      registryAfter.push(member.id);
    } else {
      conflict(conflicts, "unregistered_agent_without_operation_evidence", member.id, "actors", {
        has_reverse_pointer: provisionId !== null
      });
    }
  }

  const surface = typeof snapshot.programmer_surface === "string" && snapshot.programmer_surface
    ? snapshot.programmer_surface
    : null;
  const registeredAgents: AccountRepairMember[] = [];
  for (const id of registryAfter) {
    const member = members.get(id);
    if (!member || member.kind === "human") continue;
    if (member.kind !== "agent") {
      conflict(conflicts, "registered_actor_is_not_account_actor", id, "object_lineage");
      continue;
    }
    if (!member.owner || !validHumans.has(member.owner)) {
      conflict(conflicts, "registered_agent_owner_mismatch", id, "owner");
      continue;
    }
    registeredAgents.push(member);

    if (Object.values(member.flags).some((value) => typeof value !== "boolean")) {
      conflict(conflicts, "malformed_actor_flags", id, "object_lineage");
      continue;
    }
    const features = stringList(member.features);
    if (!features) {
      conflict(conflicts, "malformed_feature_list", id, "features");
      continue;
    }
    const provisionId = ledgerByAgent.get(id) ?? null;
    if (provisionId !== null && member.provision_id !== provisionId) {
      conflict(conflicts, "operator_ledger_reverse_pointer_mismatch", id, "provision_id");
    } else if (
      typeof member.provision_id === "string" &&
      (!ledger || ledger[member.provision_id] !== id)
    ) {
      conflict(conflicts, "operator_reverse_pointer_missing_from_ledger", id, "provision_id");
    }

    const retired = nullableTimestamp(member.retired_at);
    const deactivated = nullableTimestamp(member.deactivated_at);
    if (!retired.valid) conflict(conflicts, "invalid_retired_at", id, "retired_at");
    if (!deactivated.valid) conflict(conflicts, "invalid_deactivated_at", id, "deactivated_at");
    if (!retired.valid || !deactivated.valid) continue;

    const nextFlags = { ...member.flags };
    let nextFeatures = [...features];
    if (retired.value !== null) {
      if (deactivated.value === null) {
        propertyPatch(proposed, id, "deactivated_at", null, retired.value, "retirement implies authentication tombstone");
      }
      if (nextFlags.programmer === true) {
        nextFlags.programmer = false;
      }
      if (surface && nextFeatures.includes(surface)) {
        nextFeatures = nextFeatures.filter((item) => item !== surface);
      }
    } else if (provisionId !== null) {
      if (!surface) {
        conflict(conflicts, "operator_agent_missing_programmer_surface", id, "features");
      } else {
        nextFlags.programmer = true;
        nextFlags.wizard = true;
        if (!nextFeatures.includes(surface)) nextFeatures.push(surface);
      }
    } else if (surface) {
      const hasSurface = nextFeatures.includes(surface);
      if ((nextFlags.programmer === true) !== hasSurface) {
        conflict(conflicts, "programmer_surface_intent_ambiguous", id, "features", {
          programmer: nextFlags.programmer === true,
          surface_present: hasSurface
        });
      }
    }
    if (!sameBooleanMap(member.flags, nextFlags)) {
      proposed.push({
        kind: "lineage_flags",
        object: id,
        before: { ...member.flags },
        after: nextFlags,
        reason: retired.value !== null ? "retired agents are not programmers" : "AP11 ledger proves programmer and wizard intent"
      });
    }
    if (!sameStringList(features, nextFeatures)) {
      propertyPatch(
        proposed,
        id,
        "features",
        features as unknown as WooValue,
        nextFeatures as unknown as WooValue,
        retired.value !== null ? "retirement removes programmer surface" : "AP11 ledger proves programmer surface intent"
      );
    }

    inspectCredentials(snapshot, member, retired.value, conflicts, proposed);
  }

  if (registry && !sameStringList(registry, registryAfter)) {
    propertyPatch(
      proposed,
      snapshot.account,
      "actors",
      registry as unknown as WooValue,
      registryAfter as unknown as WooValue,
      "deduplicate registry and add only mutually attested account actors"
    );
  }

  const finalProgrammer = new Map(registeredAgents.map((member) => [member.id, member.flags.programmer === true]));
  for (const patch of proposed) {
    if (patch.kind === "lineage_flags") finalProgrammer.set(patch.object, patch.after.programmer === true);
  }
  const liveAgents = registeredAgents.filter((member) => nullableTimestamp(member.retired_at).value === null);
  const expectedAgentCount = liveAgents.length;
  const expectedProgrammerCount = liveAgents.filter((member) => finalProgrammer.get(member.id) === true).length;
  const currentAgentCount = safeNonnegativeInt(snapshot.agent_count);
  const currentProgrammerCount = safeNonnegativeInt(snapshot.programmer_agent_count);
  if (currentAgentCount === null || currentAgentCount !== expectedAgentCount) {
    propertyPatch(
      proposed,
      snapshot.account,
      "agent_count",
      asDetailValue(snapshot.agent_count),
      expectedAgentCount,
      "derive quota count from registered non-retired agents"
    );
  }
  if (currentProgrammerCount === null || currentProgrammerCount !== expectedProgrammerCount) {
    propertyPatch(
      proposed,
      snapshot.account,
      "programmer_agent_count",
      asDetailValue(snapshot.programmer_agent_count),
      expectedProgrammerCount,
      "derive programmer count from registered non-retired programmer agents"
    );
  }

  const patches = conflicts.length === 0 ? proposed : [];
  return {
    kind: "woo.account_state_repair.v1",
    account: snapshot.account,
    authority_scope: snapshot.authority_scope,
    status: conflicts.length > 0 ? "conflict" : patches.length > 0 ? "would_apply" : "empty",
    patches,
    conflicts: conflicts.sort(compareConflict),
    inspected: {
      registry_members: registryAfter.length,
      agents: registeredAgents.length,
      operator_ledger_entries: ledgerEntries.length
    }
  };
}

/** Remove mutable values from an operator-facing repair report. */
export function summarizeAccountRepairPatches(
  patches: readonly AccountRepairPatch[]
): AccountRepairPatchSummary[] {
  return patches.map((patch) => patch.kind === "property"
    ? {
        kind: patch.kind,
        object: patch.object,
        name: patch.name,
        reason: patch.reason
      }
    : {
        kind: patch.kind,
        object: patch.object,
        reason: patch.reason
      });
}

function inspectCredentials(
  snapshot: AccountRepairSnapshot,
  member: AccountRepairMember,
  retiredAt: number | null,
  conflicts: AccountRepairConflict[],
  proposed: AccountRepairPatch[]
): void {
  const keys = valueMap(member.api_keys);
  if (!keys) {
    conflict(conflicts, "invalid_api_key_map", member.id, "api_keys");
    return;
  }
  const pointer = member.api_key_id;
  if (pointer !== null && typeof pointer !== "string") {
    conflict(conflicts, "invalid_api_key_pointer", member.id, "api_key_id");
    return;
  }
  if (typeof pointer !== "string" || pointer.length === 0) {
    const active = Object.entries(keys).filter(([, raw]) => credentialRecord(raw)?.revoked_at == null);
    if (active.length > 0) {
      conflict(conflicts, "active_credentials_without_current_pointer", member.id, "api_key_id", {
        active_credentials: active.length
      });
    }
    return;
  }
  const record = credentialRecord(keys[pointer]);
  if (!record) {
    conflict(conflicts, "current_credential_record_missing", member.id, "api_key_id");
    return;
  }
  if (record.actor !== member.id) {
    conflict(conflicts, "current_credential_actor_mismatch", member.id, "api_keys");
    return;
  }
  if (retiredAt === null) {
    if (record.revoked_at != null) {
      conflict(conflicts, "live_agent_points_to_revoked_credential", member.id, "api_key_id");
    }
    return;
  }
  if (record.revoked_at == null) {
    const next = { ...keys, [pointer]: { ...record, revoked_at: retiredAt } } as unknown as WooValue;
    propertyPatch(
      proposed,
      member.id,
      "api_keys",
      keys as unknown as WooValue,
      next,
      "retirement revokes the current credential at the durable retirement time"
    );
  }
  const unpointedActive = Object.entries(keys).filter(([id, raw]) =>
    id !== pointer && credentialRecord(raw)?.revoked_at == null
  );
  if (unpointedActive.length > 0) {
    conflict(conflicts, "retired_actor_has_unpointed_active_credentials", member.id, "api_keys", {
      active_credentials: unpointedActive.length
    });
  }
}

function propertyPatch(
  patches: AccountRepairPatch[],
  object: string,
  name: string,
  before: WooValue,
  after: WooValue,
  reason: string
): void {
  if (JSON.stringify(before) === JSON.stringify(after)) return;
  patches.push({ kind: "property", object, name, before, after, reason });
}

function conflict(
  conflicts: AccountRepairConflict[],
  code: string,
  object: string,
  field: string,
  detail?: Record<string, WooValue>
): void {
  conflicts.push({ code, object, field, ...(detail ? { detail } : {}) });
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || item.length === 0)) return null;
  return [...value];
}

function stringMap(value: unknown): Record<string, string> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!key || typeof item !== "string" || !item) return null;
    out[key] = item;
  }
  return out;
}

function valueMap(value: unknown): Record<string, WooValue> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return { ...(value as Record<string, WooValue>) };
}

function credentialRecord(value: unknown): CredentialRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as CredentialRecord
    : null;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function safeNonnegativeInt(value: unknown): number | null {
  return Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null;
}

function nullableTimestamp(value: unknown): { valid: boolean; value: number | null } {
  if (value === null || value === undefined) return { valid: true, value: null };
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? { valid: true, value }
    : { valid: false, value: null };
}

function sameBooleanMap(a: Record<string, boolean>, b: Record<string, boolean>): boolean {
  const keys = unique([...Object.keys(a), ...Object.keys(b)]).sort();
  return keys.every((key) => a[key] === b[key]);
}

function sameStringList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function asDetailValue(value: unknown): WooValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    Array.isArray(value) ||
    (typeof value === "object" && value !== undefined)
  ) return value as WooValue;
  return String(value);
}

function compareConflict(a: AccountRepairConflict, b: AccountRepairConflict): number {
  return a.object.localeCompare(b.object) || a.field.localeCompare(b.field) || a.code.localeCompare(b.code);
}
