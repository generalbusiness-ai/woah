/**
 * Identity export/import (cutover plan item B —
 * notes/2026-07-08-net-cutover-tooling-plan.md; ratified schema:
 * notes/2026-07-04-simplest-system-plan.md "Phase 5", owner-approved §8
 * decision 1).
 *
 * The cutover reinstalls the world from catalogs; the ONE thing carried
 * over is identity: the `$system.api_keys` map verbatim (salted hashes —
 * plugs and agents keep authenticating) and the reachable identity actor
 * graph with PRESERVED object ids (apikey records point at actor objects
 * by id; preserving ids means no ref rewriting anywhere). Bearer tokens
 * are dropped by design (60-minute TTL; humans re-login by password).
 *
 * Export is a pure walk over a SerializedWorld (no live world needed —
 * the v2 export route hands the serialized image straight in). Import
 * grafts onto a freshly installed world BEFORE the net partition/seed,
 * so carried identity partitions like any other world state. Both are
 * idempotent (the migration rule): re-exporting is read-only; re-importing
 * over an already-imported world re-creates nothing (createObject returns
 * the existing object) and re-sets the same values.
 *
 * Verification is part of import and ABORTS on failure (§8: "any dangling
 * ref fails the import — abort, not warn"): every `api_keys[*].actor`
 * must resolve to a live `$actor` descendant and every actor's `account`
 * binding must resolve.
 */
import type { SerializedObject, SerializedWorld } from "../core/repository";
import type { WooWorld } from "../core/world";

/** The §8 closed allow-list of identity properties, plus `email`: the §8
 * enumeration omits it, but account lookup for password login is BY
 * email (`world.findAccountByEmail`), so a carried account without its
 * email could never log in again — which would defeat the §8 intent
 * ("humans re-authenticate by password"). The addition is deliberate and
 * surfaced here rather than silently made. */
const IDENTITY_PROPS = [
  "name",
  "account",
  "created_via",
  "profile_id",
  "password_salt",
  "password_hash",
  "email",
  "last_seen_at"
] as const;

export type IdentityActorExport = {
  /** Original object id — imports re-create with the SAME id. */
  id: string;
  /** Parent CLASS id (e.g. "$agent", "$account"), resolved against the
   * freshly installed catalogs at import. */
  parent: string;
  name: string;
  owner: string;
  /** Permission/deactivation flags verbatim (actorCanAuthenticate inputs). */
  flags: Record<string, unknown>;
  /** Present identity properties from the closed allow-list. */
  props: Record<string, unknown>;
};

export type IdentityExport = {
  kind: "woo.identity_export.v1";
  exported_at: number;
  /** `$system.api_keys` verbatim: id → {hash, salt, actor, label, created_at, ...}. */
  api_keys: Record<string, unknown>;
  /** Dependency-ordered: accounts precede the actors that bind them. */
  actors: IdentityActorExport[];
};

/** Parse + shape-check an untrusted identity-export JSON (the script
 * reads it from disk; the cutover runbook moves it between machines). */
export function parseIdentityExport(raw: unknown): IdentityExport {
  const value = raw as Partial<IdentityExport> | null;
  if (!value || typeof value !== "object" || value.kind !== "woo.identity_export.v1") {
    throw new Error("identity export: expected kind woo.identity_export.v1");
  }
  if (!value.api_keys || typeof value.api_keys !== "object" || Array.isArray(value.api_keys)) {
    throw new Error("identity export: api_keys must be a map");
  }
  if (!Array.isArray(value.actors)) throw new Error("identity export: actors must be a list");
  for (const actor of value.actors) {
    if (typeof actor?.id !== "string" || typeof actor?.parent !== "string" || !actor.parent.startsWith("$")) {
      throw new Error(`identity export: malformed actor entry ${JSON.stringify(actor?.id)}`);
    }
  }
  return value as IdentityExport;
}

/** Walk a serialized world's parent chain; true when it reaches `cls`. */
function chainReaches(objects: Map<string, SerializedObject>, id: string, cls: string): boolean {
  let current: string | null | undefined = id;
  const guard = new Set<string>();
  while (current && !guard.has(current)) {
    if (current === cls) return true;
    guard.add(current);
    current = objects.get(current)?.parent;
  }
  return false;
}

function propsOf(obj: SerializedObject): Map<string, unknown> {
  return new Map(obj.properties as Array<[string, unknown]>);
}

/**
 * Export the identity graph from a serialized v2 world image: the
 * api_keys map verbatim, every `$account` instance, and every `$actor`
 * descendant referenced by an apikey record or carrying an account
 * binding. Nothing else — inventories, locations, and world furniture
 * are deliberately not carried; imported actors rehome to the catalog
 * start location (§8).
 */
export function exportIdentity(serialized: SerializedWorld): IdentityExport {
  const objects = new Map<string, SerializedObject>(serialized.objects.map((obj) => [obj.id, obj]));
  const system = objects.get("$system");
  const apiKeysRaw = system ? propsOf(system).get("api_keys") : undefined;
  const apiKeys =
    apiKeysRaw && typeof apiKeysRaw === "object" && !Array.isArray(apiKeysRaw)
      ? (apiKeysRaw as Record<string, unknown>)
      : {};

  const wanted = new Set<string>();
  // Every $account instance (the class object itself is catalog state and
  // reinstalls fresh — only INSTANCES carry).
  for (const obj of serialized.objects) {
    if (obj.id !== "$account" && chainReaches(objects, obj.id, "$account")) wanted.add(obj.id);
  }
  // Every $actor descendant an apikey record references.
  for (const record of Object.values(apiKeys)) {
    const actor = (record as { actor?: unknown } | null)?.actor;
    if (typeof actor === "string" && chainReaches(objects, actor, "$actor")) wanted.add(actor);
  }
  // Every $actor descendant carrying an account binding.
  for (const obj of serialized.objects) {
    if (!chainReaches(objects, obj.id, "$actor") || obj.id === "$actor") continue;
    const account = propsOf(obj).get("account");
    if (typeof account === "string" && account.length > 0) wanted.add(obj.id);
  }

  const actors: IdentityActorExport[] = [];
  for (const id of [...wanted].sort()) {
    const obj = objects.get(id);
    if (!obj) continue;
    if (!obj.parent || !obj.parent.startsWith("$")) {
      // §8 carries parent CLASS names; an identity actor parented to a
      // non-catalog object cannot be faithfully re-created in a fresh
      // install — surface it, never guess.
      throw new Error(`identity export: ${id} is parented to non-class ${String(obj.parent)}; cannot carry`);
    }
    const props: Record<string, unknown> = {};
    const present = propsOf(obj);
    for (const name of IDENTITY_PROPS) {
      const value = present.get(name);
      if (value !== undefined) props[name] = value;
    }
    actors.push({
      id,
      parent: obj.parent,
      name: obj.name,
      owner: obj.owner,
      flags: (obj.flags ?? {}) as Record<string, unknown>,
      props
    });
  }

  // Dependency order: accounts first, so an actor's `account` prop always
  // points at an object the import has already created.
  actors.sort((a, b) => {
    const aAccount = chainReaches(objects, a.id, "$account") ? 0 : 1;
    const bAccount = chainReaches(objects, b.id, "$account") ? 0 : 1;
    return aAccount - bAccount || a.id.localeCompare(b.id);
  });

  return { kind: "woo.identity_export.v1", exported_at: Date.now(), api_keys: apiKeys, actors };
}

/** Live-world parent-chain walk (import side; world.object throws on a
 * missing id, so probe via a try). */
function liveChainReaches(world: WooWorld, id: string, cls: string): boolean {
  const guard = new Set<string>();
  let current: string | null = id;
  while (current && !guard.has(current)) {
    if (current === cls) return true;
    guard.add(current);
    try {
      current = world.object(current).parent;
    } catch {
      return false;
    }
  }
  return false;
}

/**
 * Graft an identity export onto a freshly installed world (BEFORE the
 * net partition/seed — install.ts's `graft` hook). Re-creates each actor
 * with its ORIGINAL id under its class parent, applies flags and the
 * allow-listed props, merges api_keys (export wins on collision), then
 * VERIFIES: every apikey actor resolves to a live $actor descendant,
 * every account binding resolves, every owner resolves. Any dangling ref
 * throws — abort, not warn (§8).
 */
export async function importIdentity(world: WooWorld, identity: IdentityExport): Promise<{ actors: number; api_keys: number }> {
  const exportedIds = new Set(identity.actors.map((actor) => actor.id));
  const dangling: string[] = [];

  // §8: imported actors REHOME to the catalog-defined start location —
  // the same `$system.guest_initial_room` convention that places fresh
  // guests (core stays catalog-agnostic; unset → the actor sits at no
  // location, exactly like a fresh world without the convention).
  // Accounts are records, not embodied — they never take a location.
  const startRaw = world.propOrNull("$system", "guest_initial_room");
  let start: string | null = null;
  if (typeof startRaw === "string" && startRaw.length > 0) {
    try {
      world.object(startRaw);
      start = startRaw;
    } catch {
      start = null;
    }
  }

  for (const actor of identity.actors) {
    let parentExists = true;
    try {
      world.object(actor.parent);
    } catch {
      parentExists = false;
    }
    if (!parentExists) {
      dangling.push(`${actor.id}: parent class ${actor.parent} not in the installed catalogs`);
      continue;
    }
    // Owner must resolve to the installed world, another carried actor,
    // or the actor itself — anything else is a ref the §8 inventory does
    // not carry, and inventing one would be a silent rewrite.
    let ownerResolves = actor.owner === actor.id || exportedIds.has(actor.owner);
    if (!ownerResolves) {
      try {
        world.object(actor.owner);
        ownerResolves = true;
      } catch {
        ownerResolves = false;
      }
    }
    if (!ownerResolves) {
      dangling.push(`${actor.id}: owner ${actor.owner} resolves nowhere`);
      continue;
    }
    // The id may ALREADY exist in the fresh world: the boot snapshot
    // ships stock objects (e.g. pre-allocated guest actors), and a
    // re-run of the import finds its own creations. Preserved-id
    // semantics make the id the identity, so a same-class existing
    // object is ADOPTED (identity props overwrite it); a DIFFERENT
    // class under the same id is a genuine conflict — abort, never
    // silently re-purpose.
    const embodied = liveChainReaches(world, actor.parent, "$actor");
    let existing: { parent: string | null; location: string | null } | null = null;
    try {
      const obj = world.object(actor.id);
      existing = { parent: obj.parent, location: obj.location };
    } catch {
      existing = null;
    }
    if (existing && existing.parent !== actor.parent) {
      dangling.push(`${actor.id}: exists in the fresh world as ${String(existing.parent)}, export says ${actor.parent}`);
      continue;
    }
    if (!existing) {
      world.createObject({
        id: actor.id,
        name: actor.name,
        parent: actor.parent,
        owner: actor.owner,
        flags: actor.flags as never,
        ...(embodied && start !== null ? { location: start } : {})
      });
    } else {
      // Adopt: identity flags overwrite; the §8 rehome applies when the
      // stock object sits nowhere (never displaces a placed object —
      // that placement is fresh-world state, not carried state).
      Object.assign(world.object(actor.id).flags, actor.flags);
      if (embodied && start !== null && (existing.location === null || existing.location === "$nowhere")) {
        world.moveObject(actor.id, start);
      }
    }
    for (const [name, value] of Object.entries(actor.props)) {
      world.setProp(actor.id, name, value as never);
    }
  }

  // api_keys: merge, export winning — a fresh install has an empty map,
  // so this is a plain set; the merge keeps re-runs and
  // partially-provisioned dev worlds sane.
  const existingRaw = world.propOrNull("$system", "api_keys");
  const existing =
    existingRaw && typeof existingRaw === "object" && !Array.isArray(existingRaw)
      ? (existingRaw as Record<string, unknown>)
      : {};
  world.setProp("$system", "api_keys", { ...existing, ...identity.api_keys } as never);

  // Rebuild the account→actor half of the binding (identity-door
  // requirement): the §8 allow-list deliberately carries only the
  // ACTOR-side `account` prop (`primary_actor`/`actors` reference world
  // objects the export may not include, so carrying them risks dangling
  // refs), but password login resolves THROUGH `account.primary_actor`
  // (v2 authenticatePassword parity). Invert the carried bindings:
  // first-bound actor wins primary (deterministic — export order), and
  // `actors[]` collects every bound actor. Idempotent: re-runs find the
  // same values.
  for (const actor of identity.actors) {
    const account = actor.props.account;
    if (typeof account !== "string" || account.length === 0) continue;
    let accountExists = true;
    try {
      world.object(account);
    } catch {
      accountExists = false;
    }
    if (!accountExists) continue; // the verification below names it
    const primary = world.propOrNull(account, "primary_actor");
    if (typeof primary !== "string" || primary.length === 0) {
      world.setProp(account, "primary_actor", actor.id as never);
    }
    const boundRaw = world.propOrNull(account, "actors");
    const bound = Array.isArray(boundRaw) ? boundRaw.filter((id): id is string => typeof id === "string") : [];
    if (!bound.includes(actor.id)) {
      world.setProp(account, "actors", [...bound, actor.id] as never);
    }
  }

  // §8 import verification — abort on ANY dangling ref.
  for (const [keyId, record] of Object.entries(identity.api_keys)) {
    const actor = (record as { actor?: unknown } | null)?.actor;
    if (typeof actor !== "string" || !liveChainReaches(world, actor, "$actor")) {
      dangling.push(`api_keys[${keyId}]: actor ${String(actor)} is not a live $actor descendant`);
    }
  }
  for (const actor of identity.actors) {
    const account = actor.props.account;
    if (typeof account === "string" && account.length > 0 && !liveChainReaches(world, account, "$account")) {
      dangling.push(`${actor.id}: account ${account} is not a live $account descendant`);
    }
  }
  if (dangling.length > 0) {
    throw new Error(`identity import verification failed (${dangling.length} dangling refs):\n  ${dangling.join("\n  ")}`);
  }
  return { actors: identity.actors.length, api_keys: Object.keys(identity.api_keys).length };
}
