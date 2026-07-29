import type { SerializedObject } from "./repository";
import { hashSource } from "./source-hash";
import type { ObjRef, WooObject, WooValue } from "./types";

export type ShadowStructuralCellKind = "location" | "contents" | "lifecycle";

type VersionedObject =
  Pick<WooObject | SerializedObject, "id" | "name" | "parent" | "owner" | "location" | "anchor" | "flags"> & {
    contents: Iterable<ObjRef>;
  };

export type ShadowLifecycleCellValue = {
  parent: ObjRef | null;
  owner: ObjRef;
  name: string;
  anchor: ObjRef | null;
  flags: WooObject["flags"];
};

/** Canonical semantic value of object_lineage/lifecycle.
 *
 * Keep this beside the content-version function: the recorder and every
 * authority validator must read the same five fields whose hash determines
 * the lifecycle version. Presence is represented by the existence of the
 * cell, not by replacing its value with a host-language sentinel. */
export function shadowLifecycleCellValue(object: VersionedObject): ShadowLifecycleCellValue {
  return {
    parent: object.parent,
    owner: object.owner,
    name: object.name,
    anchor: object.anchor,
    flags: { ...object.flags }
  };
}

/** Parse an untrusted transcript lifecycle replacement without accepting an
 * open-ended namespace. Unknown semantic fields or flag names are refused so
 * adding a lineage field requires an explicit recorder/authority decision. */
export function parseShadowLifecycleCellValue(value: WooValue): ShadowLifecycleCellValue | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, WooValue>;
  const allowed = new Set(["parent", "owner", "name", "anchor", "flags"]);
  const keys = Object.keys(record);
  // Exact own-key equality prevents both open-ended host metadata and values
  // inherited through a forged JavaScript prototype from becoming authority
  // input. The lifecycle map is data, never a host-language namespace.
  if (keys.length !== allowed.size || keys.some((key) => !allowed.has(key))) return null;
  if (
    (typeof record.parent !== "string" && record.parent !== null) ||
    typeof record.owner !== "string" ||
    typeof record.name !== "string" ||
    record.name.length === 0 ||
    (typeof record.anchor !== "string" && record.anchor !== null) ||
    !record.flags ||
    typeof record.flags !== "object" ||
    Array.isArray(record.flags)
  ) {
    return null;
  }
  const rawFlags = record.flags as Record<string, WooValue>;
  const flags: WooObject["flags"] = {};
  for (const [key, raw] of Object.entries(rawFlags)) {
    if (key !== "fertile" && key !== "programmer" && key !== "wizard") return null;
    if (typeof raw !== "boolean") return null;
    flags[key] = raw;
  }
  return {
    parent: record.parent,
    owner: record.owner,
    name: record.name,
    anchor: record.anchor,
    flags
  };
}

// Shadow transcripts must replay to the same hashes on another node. These
// versions are therefore derived from deterministic cell content, not from the
// runtime's wall-clock `modified` field.
export function shadowStructuralCellVersion(kind: ShadowStructuralCellKind, object: VersionedObject): string {
  switch (kind) {
    case "location":
      return shadowVersionHash({ cell: "location", object: object.id, location: object.location });
    case "contents":
      return shadowVersionHash({ cell: "contents", object: object.id, contents: Array.from(object.contents).sort() });
    case "lifecycle": {
      const lineage = shadowLifecycleCellValue(object);
      return shadowVersionHash({
        cell: "lifecycle",
        object: object.id,
        name: lineage.name,
        parent: lineage.parent,
        owner: lineage.owner,
        anchor: lineage.anchor,
        flags: stableFlags(lineage.flags)
      });
    }
  }
}

export function shadowOwnerCellVersion(object: ObjRef, owner: ObjRef): string {
  return shadowVersionHash({ cell: "owner", object, owner });
}

function shadowVersionHash(payload: Record<string, WooValue>): string {
  return hashSource(stableShadowJson({
    kind: "woo.shadow_cell_version.v1",
    ...payload
  }));
}

function stableFlags(flags: WooObject["flags"]): Record<string, WooValue> {
  const out: Record<string, WooValue> = {};
  for (const key of ["fertile", "programmer", "wizard"] as const) {
    if (flags[key] !== undefined) out[key] = flags[key] === true;
  }
  return out;
}

export function stableShadowJson(value: WooValue): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableShadowJson(item)).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableShadowJson(value[key])}`)
    .join(",")}}`;
}
