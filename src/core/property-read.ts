import { cloneValue, type ObjRef, type PropertyDef, type WooValue } from "./types";

export type PropertyReadableObject = {
  id: ObjRef;
  name: string;
  parent: ObjRef | null;
  owner: ObjRef;
  properties: Pick<Map<string, WooValue>, "get" | "has">;
  propertyDefs: Pick<Map<string, PropertyDef>, "get">;
};

export function readObjectPropertyValue(input: {
  object: PropertyReadableObject;
  name: string;
  lookupParent: (parent: ObjRef, start: ObjRef) => PropertyReadableObject | null | undefined;
  propertyNotFound: (name: string) => unknown;
}): WooValue {
  const { object, name } = input;
  if (name === "owner") return object.owner;
  if (object.properties.has(name)) return cloneValue(object.properties.get(name)!);
  // The substrate object name is visible before inherited defaults when there
  // is no explicit property value on the object. This is the single shared
  // implementation for WooWorld.getProp and serialized transcript validation.
  if (name === "name") return object.name;
  let parent = object.parent;
  const seen = new Set<ObjRef>();
  while (parent && !seen.has(parent)) {
    seen.add(parent);
    const ancestor = input.lookupParent(parent, object.id);
    if (!ancestor) break;
    const def = ancestor.propertyDefs.get(name);
    if (def) return cloneValue(def.defaultValue);
    parent = ancestor.parent;
  }
  throw input.propertyNotFound(name);
}
