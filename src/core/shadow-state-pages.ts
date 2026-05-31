import type { SerializedObject, SerializedWorld } from "./repository";
import { stableShadowJson } from "./shadow-cell-version";
import { hashSource, utf8ByteLength } from "./source-hash";
import type { ObjRef, PropertyDef, VerbDef, WooValue } from "./types";

// Shadow state pages are deliberately below object granularity: a node can
// cache immutable class bytecode separately from live instance cells, then
// install only the page hashes it is missing for the next VM turn.
export type ShadowStatePage =
  | ShadowObjectLineagePage
  | ShadowObjectLivePage
  | ShadowPropertyCellPage
  | ShadowVerbBytecodePage;

export type ShadowObjectLineagePage = {
  kind: "woo.state_page.object_lineage.shadow.v1";
  page: "object_lineage";
  object: ObjRef;
  name: string;
  parent: ObjRef | null;
  owner: ObjRef;
  anchor: ObjRef | null;
  flags: SerializedObject["flags"];
  created: number;
  modified: number;
  eventSchemas: SerializedObject["eventSchemas"];
};

export type ShadowObjectLivePage = {
  kind: "woo.state_page.object_live.shadow.v1";
  page: "object_live";
  object: ObjRef;
  location: ObjRef | null;
  children: ObjRef[];
  contents: ObjRef[];
};

export type ShadowPropertyCellPage = {
  kind: "woo.state_page.property_cell.shadow.v1";
  page: "property_cell";
  object: ObjRef;
  name: string;
  def: PropertyDef | null;
  has_value: boolean;
  value?: WooValue;
  version: number;
};

export type ShadowVerbBytecodePage = {
  kind: "woo.state_page.verb_bytecode.shadow.v1";
  page: "verb_bytecode";
  object: ObjRef;
  name: string;
  verb: VerbDef;
};

export type ShadowStatePageRef = {
  object: ObjRef;
  page: ShadowStatePage["page"];
  name?: string;
  hash: string;
  bytes: number;
  inline: boolean;
};

export function shadowStatePagesForObject(obj: SerializedObject): ShadowStatePage[] {
  return [
    shadowObjectLineagePage(obj),
    shadowObjectLivePage(obj),
    ...shadowPropertyCellPages(obj),
    ...shadowVerbBytecodePages(obj)
  ];
}

export function shadowObjectLineagePage(obj: SerializedObject): ShadowObjectLineagePage {
  return {
    kind: "woo.state_page.object_lineage.shadow.v1",
    page: "object_lineage",
    object: obj.id,
    name: obj.name,
    parent: obj.parent,
    owner: obj.owner,
    anchor: obj.anchor,
    flags: structuredClone(obj.flags) as SerializedObject["flags"],
    created: obj.created,
    modified: obj.modified,
    eventSchemas: (structuredClone(obj.eventSchemas) as SerializedObject["eventSchemas"])
      .sort(([a], [b]) => a.localeCompare(b))
  };
}

export function shadowObjectLivePage(obj: SerializedObject): ShadowObjectLivePage {
  return {
    kind: "woo.state_page.object_live.shadow.v1",
    page: "object_live",
    object: obj.id,
    location: obj.location,
    // Preserve serialized order. The contents cell's version hash treats the
    // collection as a set, but the VM records read values in iteration order.
    children: [...obj.children],
    contents: [...obj.contents]
  };
}

export function shadowPropertyCellPages(obj: SerializedObject): ShadowPropertyCellPage[] {
  const defs = new Map(obj.propertyDefs.map((def) => [def.name, def] as const));
  const values = new Map(obj.properties);
  const versions = new Map(obj.propertyVersions);
  const names = new Set<string>([...defs.keys(), ...values.keys(), ...versions.keys()]);
  return Array.from(names).sort().map((name) => shadowPropertyCellPageFromMaps(obj, name, defs, values, versions));
}

export function shadowPropertyCellPage(obj: SerializedObject, name: string): ShadowPropertyCellPage {
  const defs = new Map(obj.propertyDefs.map((def) => [def.name, def] as const));
  const values = new Map(obj.properties);
  const versions = new Map(obj.propertyVersions);
  return shadowPropertyCellPageFromMaps(obj, name, defs, values, versions);
}

function shadowPropertyCellPageFromMaps(
  obj: SerializedObject,
  name: string,
  defs: Map<string, PropertyDef>,
  values: Map<string, WooValue>,
  versions: Map<string, number>
): ShadowPropertyCellPage {
  const hasValue = values.has(name);
  return {
    kind: "woo.state_page.property_cell.shadow.v1",
    page: "property_cell",
    object: obj.id,
    name,
    def: defs.has(name) ? structuredClone(defs.get(name)!) as PropertyDef : null,
    has_value: hasValue,
    ...(hasValue ? { value: structuredClone(values.get(name)!) as WooValue } : {}),
    version: versions.get(name) ?? 0
  };
}

export function shadowVerbBytecodePages(obj: SerializedObject): ShadowVerbBytecodePage[] {
  return obj.verbs
    .map((verb) => ({
      kind: "woo.state_page.verb_bytecode.shadow.v1" as const,
      page: "verb_bytecode" as const,
      object: obj.id,
      name: verb.name,
      verb: structuredClone(verb) as VerbDef
    }))
    .sort((a, b) => (a.verb.slot ?? 0) - (b.verb.slot ?? 0) || a.name.localeCompare(b.name));
}

export function shadowStatePageHash(page: ShadowStatePage): string {
  return hashSource(stableShadowJson(page as unknown as WooValue));
}

export function shadowStatePageRef(page: ShadowStatePage, inline: boolean): ShadowStatePageRef {
  const json = stableShadowJson(page as unknown as WooValue);
  return {
    object: page.object,
    page: page.page,
    ...(page.page === "property_cell" || page.page === "verb_bytecode" ? { name: page.name } : {}),
    hash: hashSource(json),
    bytes: utf8ByteLength(json),
    inline
  };
}

export function cacheShadowStatePages(cache: Map<string, ShadowStatePage>, pages: ShadowStatePage[]): void {
  for (const page of pages) cache.set(shadowStatePageHash(page), structuredClone(page) as ShadowStatePage);
}

export function serializedStatePageHashes(serialized: SerializedWorld | undefined): string[] {
  return serialized?.objects.flatMap((obj) => shadowStatePagesForObject(obj).map(shadowStatePageHash)) ?? [];
}

export function mergeShadowStatePagesIntoSerialized(
  current: SerializedWorld | undefined,
  pages: ShadowStatePage[],
  empty: () => SerializedWorld
): SerializedWorld {
  const base = current ? structuredClone(current) as SerializedWorld : empty();
  const byId = new Map<ObjRef, SerializedObject>(base.objects.map((obj) => [obj.id, obj]));
  const pagesByObject = new Map<ObjRef, ShadowStatePage[]>();
  for (const page of pages) {
    const list = pagesByObject.get(page.object) ?? [];
    list.push(page);
    pagesByObject.set(page.object, list);
  }

  for (const [id, objectPages] of pagesByObject) {
    const currentObj = byId.get(id);
    const lineage = objectPages.find((page): page is ShadowObjectLineagePage => page.page === "object_lineage");
    if (!currentObj && !lineage) throw new Error(`state page set missing lineage page for ${id}`);
    const next = currentObj
      ? structuredClone(currentObj) as SerializedObject
      : emptySerializedObjectFromLineage(lineage!);

    for (const page of objectPages) applyStatePageToObject(next, page);
    normalizeSerializedObject(next);
    byId.set(id, next);
  }

  return {
    ...base,
    objects: Array.from(byId.values()).sort((a, b) => a.id.localeCompare(b.id))
  };
}

function emptySerializedObjectFromLineage(page: ShadowObjectLineagePage): SerializedObject {
  return {
    id: page.object,
    name: page.name,
    parent: page.parent,
    owner: page.owner,
    location: null,
    anchor: page.anchor,
    flags: structuredClone(page.flags) as SerializedObject["flags"],
    created: page.created,
    modified: page.modified,
    propertyDefs: [],
    properties: [],
    propertyVersions: [],
    verbs: [],
    children: [],
    contents: [],
    eventSchemas: structuredClone(page.eventSchemas) as SerializedObject["eventSchemas"]
  };
}

function applyStatePageToObject(obj: SerializedObject, page: ShadowStatePage): void {
  switch (page.page) {
    case "object_lineage":
      obj.name = page.name;
      obj.parent = page.parent;
      obj.owner = page.owner;
      obj.anchor = page.anchor;
      obj.flags = structuredClone(page.flags) as SerializedObject["flags"];
      obj.created = page.created;
      obj.modified = page.modified;
      obj.eventSchemas = structuredClone(page.eventSchemas) as SerializedObject["eventSchemas"];
      break;
    case "object_live":
      obj.location = page.location;
      obj.children = [...page.children];
      obj.contents = [...page.contents];
      break;
    case "property_cell":
      obj.propertyDefs = obj.propertyDefs.filter((def) => def.name !== page.name);
      if (page.def) obj.propertyDefs.push(structuredClone(page.def) as PropertyDef);
      obj.properties = obj.properties.filter(([name]) => name !== page.name);
      if (page.has_value) obj.properties.push([page.name, structuredClone(page.value ?? null) as WooValue]);
      obj.propertyVersions = obj.propertyVersions.filter(([name]) => name !== page.name);
      obj.propertyVersions.push([page.name, page.version]);
      break;
    case "verb_bytecode":
      obj.verbs = obj.verbs.filter((verb) => verb.name !== page.name);
      obj.verbs.push(structuredClone(page.verb) as VerbDef);
      break;
  }
}

function normalizeSerializedObject(obj: SerializedObject): void {
  obj.propertyDefs.sort((a, b) => a.name.localeCompare(b.name));
  obj.properties.sort(([a], [b]) => a.localeCompare(b));
  obj.propertyVersions.sort(([a], [b]) => a.localeCompare(b));
  obj.verbs.sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0) || a.name.localeCompare(b.name));
  obj.children = [...new Set(obj.children)];
  obj.contents = [...new Set(obj.contents)];
  obj.eventSchemas.sort(([a], [b]) => a.localeCompare(b));
}
