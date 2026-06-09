import {
  nativePrimitiveContract,
  nativePrimitiveOpenSeedCatalogPropertyNames,
  nativePrimitiveOpenSeedDispatchVerbNames,
  nativePrimitiveOpenSeedObjectPropertyNames,
  nativePrimitiveOpenSeedVerbLookups,
  type NativePrimitiveOpenSeedVerbLookup
} from "./native-primitive-contract";

type BrowserOpenSeedPropertyContract = {
  name: string;
  reason: string;
};

// Browser open seeds are a first-turn execution contract, not a catalog
// shortcut. Native primitives declare command/movement needs in
// native-primitive-contract; this file holds only substrate/browser-holder state
// that is independent of bundled catalogs and ordinary command words.
const SUBSTRATE_OBJECT_PROPERTIES: BrowserOpenSeedPropertyContract[] = [
  { name: "mount_room", reason: "Browser-held tool scopes may route first-turn movement or observations through their mounted room." },
  { name: "subscribers", reason: "Compatibility actor presence projection for local applied-frame routing." },
  { name: "session_subscribers", reason: "Authoritative session presence rows for local applied-frame routing." },
  { name: "focus_by_actor", reason: "Browser focus state participates in first-turn tool visibility." },
  { name: "last_undo", reason: "Browser undo state must survive the open seed without fetching broad user state." }
];

const SUBSTRATE_CATALOG_PROPERTIES: BrowserOpenSeedPropertyContract[] = [
  { name: "features", reason: "Feature attachments extend the dispatch parent chain." },
  { name: "features_version", reason: "Feature-chain freshness invalidates stale executable seeds." },
  { name: "host_placement", reason: "Host placement is structural routing metadata, not catalog behavior." }
];

export type BrowserOpenSeedVerbLookup = NativePrimitiveOpenSeedVerbLookup;

export function browserOpenSeedVerbLookups(): BrowserOpenSeedVerbLookup[] {
  return nativePrimitiveOpenSeedVerbLookups();
}

export function browserOpenSeedDispatchVerbNames(): string[] {
  return nativePrimitiveOpenSeedDispatchVerbNames();
}

export function browserOpenSeedObjectPropertyNames(): string[] {
  return uniqueSorted([
    ...SUBSTRATE_OBJECT_PROPERTIES.map((entry) => entry.name),
    ...nativePrimitiveOpenSeedObjectPropertyNames()
  ]);
}

export function browserOpenSeedCommandSurfacePropertyNames(): string[] {
  return uniqueSorted(nativePrimitiveContract("plan_command")?.open_seed?.object_property_names ?? []);
}

export function browserOpenSeedCommandSurfaceVerbLookupNames(): string[] {
  return uniqueSorted(nativePrimitiveContract("plan_command")?.open_seed?.object_verb_lookup_names ?? []);
}

export function browserOpenSeedCatalogPropertyNames(): string[] {
  return uniqueSorted([
    ...SUBSTRATE_CATALOG_PROPERTIES.map((entry) => entry.name),
    ...nativePrimitiveOpenSeedCatalogPropertyNames()
  ]);
}

function uniqueSorted(values: Iterable<string>): string[] {
  return Array.from(new Set(values)).sort();
}
