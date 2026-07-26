/**
 * Identity export/import (cutover plan item B —
 * notes/2026-07-08-net-cutover-tooling-plan.md; ratified schema:
 * notes/2026-07-04-simplest-system-plan.md "Phase 5", owner-approved §8
 * decision 1).
 *
 * The cutover reinstalls the world from catalogs; the ONE thing carried
 * over is identity: the historical `$system.api_keys` compatibility map,
 * actor-owned `api_keys` authorities, and the reachable identity actor graph,
 * including agent-owner chains, with PRESERVED object ids (apikey records
 * point at actor objects by id; preserving ids means no ref rewriting
 * anywhere). Bearer tokens
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
import { deriveCustomerAttribution, PROP_CUSTOMER_OF } from "./attribution";

/**
 * AU3.1 "every actor" closure for a BUILT world (install pipeline):
 * derive and materialize `customer_of` for every live `$actor`
 * descendant instance that does not already carry one — the preseeded
 * guest pool, `$wiz`, and any catalog-seeded actors, which the
 * per-lifecycle writers (import, provisioning, guest mint) never see.
 * Returns the ids no rule covers. Idempotent; install-time only (the
 * whole-world walk is the install pipeline's privilege, never the
 * runtime's).
 */
export function materializeCustomerAttributions(world: WooWorld): string[] {
  const source = world.attributionSource();
  const unattributed: string[] = [];
  for (const obj of world.exportWorld().objects) {
    if (obj.id.startsWith("$")) {
      // Seed-class objects: only $wiz is itself an acting principal.
      if (obj.id !== "$wiz") continue;
    }
    if (!liveChainReaches(world, obj.id, "$actor")) continue;
    if (world.propOrNull(obj.id, PROP_CUSTOMER_OF) !== null) continue;
    const derived = deriveCustomerAttribution(source, obj.id);
    if (derived === null) {
      unattributed.push(obj.id);
      continue;
    }
    world.setCustomerOf(obj.id, derived);
  }
  return unattributed;
}

/** The §8 closed allow-list of identity properties, plus deliberate
 * additions surfaced here rather than silently made:
 * - `email`: account lookup for password login is BY email
 *   (`world.findAccountByEmail`) — a carried account without it could
 *   never log in again, defeating "humans re-authenticate by password";
 * - `deactivated_at` (reviewer finding 2): omitting it REACTIVATED
 *   deactivated identities at cutover — the lifecycle verdict must
 *   carry;
 * - `primary_actor` (reviewer finding 3): the account's human UI entry
 *   point — rebuilt-from-bindings guesses wrong for multi-actor
 *   accounts, so the original mapping carries (export filters it to
 *   exported actors; import verifies resolution). `actors` carries too,
 *   filtered the same way;
 * - `features` / `features_version`: an actor's composed authoring surface
 *   is capability, not cosmetic room state. A programmer agent
 *   (`$agent` + attached `$programmer` feature) that lost its features at
 *   cutover would keep the `programmer` flag but silently drop the surface —
 *   a flag-without-surface break. The feature refs are catalog classes that
 *   reinstall fresh, so they resolve after the graft;
 * - `api_keys`: the actor is now the credential authority. Import merges
 *   this map monotonically so an aged carry cannot overwrite a newer
 *   revocation in the destination. */
const IDENTITY_PROPS = [
  "name",
  "account",
  "created_via",
  "profile_id",
  "password_salt",
  "password_hash",
  "email",
  "deactivated_at",
  "primary_actor",
  "actors",
  "last_seen_at",
  "features",
  "features_version",
  "api_keys"
] as const;

export type IdentityActorExport = {
  /** Original object id — imports re-create with the SAME id. */
  id: string;
  /** Parent CLASS id (for example, the agent class or "$account"), resolved against the
   * freshly installed catalogs at import. */
  parent: string;
  name: string;
  owner: string;
  /** Authority anchor (an object field, not a prop): the actor that roots this
   * object's authority scope. Carried so a co-located identity family (account
   * + owned agents anchored to their human) reconstructs its single-cluster
   * placement after the graft; without it they would rehome anchorless and
   * split across catalog + per-agent clusters. Absent for an anchorless root. */
  anchor?: string;
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

function isSerializedActor(objects: Map<string, SerializedObject>, id: string): boolean {
  return chainReaches(objects, id, "$actor");
}

function propsOf(obj: SerializedObject): Map<string, unknown> {
  return new Map(obj.properties as Array<[string, unknown]>);
}

/**
 * Export the identity graph from a serialized v2 world image: the
 * api_keys map verbatim, every `$account` instance, every acting-principal
 * descendant referenced by either credential authority or carrying an
 * account binding, and the transitive agent-owner chain needed to preserve
 * that actor's authentication verdict. Nothing else — inventories, locations,
 * and world furniture are deliberately not carried; imported actors
 * rehome to the catalog start location (§8).
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
    if (typeof actor === "string" && isSerializedActor(objects, actor)) wanted.add(actor);
  }
  // An actor-owned verifier map is itself a root in the identity inventory.
  // It must not depend on a legacy registry or account binding to be carried.
  for (const obj of serialized.objects) {
    if (!isSerializedActor(objects, obj.id) || obj.id === "$actor") continue;
    const owned = propsOf(obj).get("api_keys");
    if (owned && typeof owned === "object" && !Array.isArray(owned) && Object.keys(owned).length > 0) {
      wanted.add(obj.id);
    }
  }
  // Every $actor descendant carrying an account binding.
  for (const obj of serialized.objects) {
    if (!isSerializedActor(objects, obj.id) || obj.id === "$actor") continue;
    const account = propsOf(obj).get("account");
    if (typeof account === "string" && account.length > 0) wanted.add(obj.id);
  }
  // An agent's eligibility is recursive through object ownership. Carry the
  // full actor-owner chain even when an owner has neither an API key nor an
  // account binding of its own. Without this closure a same-id stock guest
  // can be adopted at import with fresh flags/properties, silently
  // reactivating every carried agent below a deactivated owner.
  const pendingOwners = [...wanted];
  while (pendingOwners.length > 0) {
    const id = pendingOwners.pop()!;
    const obj = objects.get(id);
    if (!obj || !chainReaches(objects, id, "$agent")) continue;
    const owner = objects.get(obj.owner);
    if (!owner || !chainReaches(objects, owner.id, "$actor") || wanted.has(owner.id)) continue;
    wanted.add(owner.id);
    pendingOwners.push(owner.id);
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
      let value = present.get(name);
      if (value === undefined) continue;
      // Account→actor refs carry ONLY when the referenced actor rides
      // this export (finding 3): a filtered-out ref would dangle at
      // import and abort the whole carry. A dropped primary_actor is
      // then rebuilt from the actor-side bindings (the import fallback).
      if (name === "primary_actor" && typeof value === "string" && !wanted.has(value)) continue;
      if (name === "actors" && Array.isArray(value)) {
        value = value.filter((ref) => typeof ref === "string" && wanted.has(ref));
        if ((value as unknown[]).length === 0) continue;
      }
      props[name] = value;
    }
    actors.push({
      id,
      parent: obj.parent,
      name: obj.name,
      owner: obj.owner,
      // The authority anchor is object-lineage state, not a property, and it
      // determines the carried object's Net scope (topology.ts scopeNameOf). An
      // identity family co-located under a human authority root (account +
      // owned agents anchored to the human) must keep that anchor across the
      // carry, or it would re-diverge to catalog/self-cluster on import.
      ...(obj.anchor ? { anchor: obj.anchor } : {}),
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
export async function importIdentity(
  world: WooWorld,
  identity: IdentityExport
): Promise<{ actors: number; api_keys: number; unattributed: string[] }> {
  const exportedIds = new Set(identity.actors.map((actor) => actor.id));
  const dangling: string[] = [];
  // Carried feature refs that did not resolve in the fresh install; dropped
  // (not fatal) so cutover is never blocked by a non-reinstallable custom
  // feature, but surfaced so an operator can see a capability was not carried.
  const droppedFeatures: string[] = [];

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
        // Anchor is set at creation and never patched (world.ts) — it must ride
        // the create call, not a later setProp, to reconstruct the authority
        // family's single-cluster placement. Verified below to resolve.
        ...(actor.anchor ? { anchor: actor.anchor } : {}),
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
      if (name === "features" && Array.isArray(value)) {
        // A carried feature ref must resolve in the freshly installed world.
        // Bundled surface classes (e.g. $programmer) reinstall and resolve; a
        // custom/live feature absent from the fresh install is dropped rather
        // than imported as a dangling capability (it rehomes to defaults, like
        // any uncarried world state). Catalogs are installed before this import.
        const resolved = value.filter((ref) => typeof ref === "string" && world.objects.has(ref));
        if (resolved.length !== value.length) {
          for (const ref of value) {
            if (typeof ref !== "string" || !world.objects.has(ref)) {
              droppedFeatures.push(`${actor.id}: feature ${String(ref)} does not resolve in the fresh install`);
            }
          }
        }
        world.setProp(actor.id, name, resolved as never);
        continue;
      }
      if (name === "api_keys") {
        const carried =
          value && typeof value === "object" && !Array.isArray(value)
            ? value as Record<string, unknown>
            : {};
        const currentRaw = world.propOrNull(actor.id, "api_keys");
        const current =
          currentRaw && typeof currentRaw === "object" && !Array.isArray(currentRaw)
            ? currentRaw as Record<string, unknown>
            : {};
        // Existing wins: retrying an older export cannot resurrect a record
        // that this destination has since revoked or otherwise advanced.
        world.setProp(actor.id, "api_keys", { ...carried, ...current } as never);
        continue;
      }
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

  // Customer attribution (audit.md AU3.1): materialize `customer_of` on
  // every imported actor now, while the whole account graph is in hand —
  // the runtime never walks the graph. Derivation is the closed AU3.1
  // rule set through the privileged setter (the property is reserved
  // below ordinary authoring); setCustomerOf no-ops on equal values so
  // re-imports stay idempotent. An uncovered actor is REPORTED, not
  // aborted: unlike a dangling ref (a broken inventory), a missing
  // attribution is a named pipeline gap the audit trail surfaces
  // per-record (`unattributed`).
  const unattributed: string[] = [];
  const source = world.attributionSource();
  for (const actor of identity.actors) {
    if (!liveChainReaches(world, actor.id, "$actor")) continue; // verification below names it
    const derived = deriveCustomerAttribution(source, actor.id);
    if (derived === null) {
      unattributed.push(actor.id);
      continue;
    }
    world.setCustomerOf(actor.id, derived);
  }

  // §8 import verification — abort on ANY dangling ref.
  for (const [keyId, record] of Object.entries(identity.api_keys)) {
    const actor = (record as { actor?: unknown } | null)?.actor;
    if (typeof actor !== "string" || !liveChainReaches(world, actor, "$actor")) {
      dangling.push(`api_keys[${keyId}]: actor ${String(actor)} is not a live $actor descendant`);
    }
  }
  for (const actor of identity.actors) {
    const owned = actor.props.api_keys;
    if (!owned || typeof owned !== "object" || Array.isArray(owned)) continue;
    for (const [keyId, record] of Object.entries(owned as Record<string, unknown>)) {
      const bound = (record as { actor?: unknown } | null)?.actor;
      if (bound !== actor.id) {
        dangling.push(`${actor.id}.api_keys[${keyId}]: actor ${String(bound)} does not match its authority`);
      }
    }
  }
  for (const actor of identity.actors) {
    const account = actor.props.account;
    if (typeof account === "string" && account.length > 0 && !liveChainReaches(world, account, "$account")) {
      dangling.push(`${actor.id}: account ${account} is not a live $account descendant`);
    }
    // Finding 3: a carried primary_actor must resolve (export filters to
    // exported ids, so a dangle here is a real inventory bug).
    const primary = actor.props.primary_actor;
    if (typeof primary === "string" && primary.length > 0 && !liveChainReaches(world, primary, "$actor")) {
      dangling.push(`${actor.id}: primary_actor ${primary} is not a live $actor descendant`);
    }
    // A carried authority anchor must resolve to a live actor — a dangling
    // anchor would misroute the object's Net scope (topology.ts scopeNameOf
    // throws E_LINEAGE when the anchor walk leaves the lineage set), so abort.
    if (typeof actor.anchor === "string" && actor.anchor.length > 0 && !liveChainReaches(world, actor.anchor, "$actor")) {
      dangling.push(`${actor.id}: authority anchor ${actor.anchor} is not a live $actor descendant`);
    }
  }
  if (dangling.length > 0) {
    throw new Error(`identity import verification failed (${dangling.length} dangling refs):\n  ${dangling.join("\n  ")}`);
  }
  if (droppedFeatures.length > 0) {
    console.warn(`identity import dropped ${droppedFeatures.length} non-reinstallable feature ref(s):\n  ${droppedFeatures.join("\n  ")}`);
  }
  return { actors: identity.actors.length, api_keys: Object.keys(identity.api_keys).length, unattributed };
}
