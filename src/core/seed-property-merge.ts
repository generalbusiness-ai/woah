/**
 * Generic key-wise merge for map-valued seeded properties — the semantics
 * behind the `set_property` seed-hook mode `"merge_map"`
 * (spec/discovery/catalogs.md §CT5.4).
 *
 * A catalog that seeds a map database (e.g. a help-topic table) cannot use
 * plain `set` on upgrade — that clobbers operator edits — and cannot use
 * `set_if_missing` — that never delivers corrected entries to an
 * already-installed world. `merge_map` closes the gap declaratively: the
 * manifest's hook `value` is the current shipped map, and the hook's
 * `supersedes` block lists, per key, the historical shipped values it is
 * allowed to replace. The merge then
 *
 *   - adds every seeded key the stored map lacks,
 *   - replaces a stored key only when its value is byte-for-byte one of that
 *     key's declared superseded values (i.e. still a shipped default nobody
 *     edited), and
 *   - leaves every other key — operator edits and unrelated entries — alone.
 *
 * The declaration lives in the catalog manifest, so core stays free of any
 * catalog identity, property name, or prose. Both delivery lanes share this
 * one function: the local-boot catalog schema drift pass
 * (`applySeedProperty` in catalog-installer.ts) and the signed Net operator
 * repair (`/net/repair-seed-properties` in scope-do.ts), which keeps a
 * repaired aged world and a fresh install byte-identical.
 *
 * Idempotent by construction: after one merge, every seeded key either equals
 * the shipped value (no longer matches any superseded fingerprint in a way
 * that would change it) or was operator-edited (never matched), so a second
 * merge reports `changed: false`.
 */

export type SeedMapSupersedes = Record<string, readonly unknown[]>;

export type SeedMapMergeResult = {
  merged: Record<string, unknown>;
  changed: boolean;
};

/** Order-insensitive structural equality for fingerprint comparison. */
export function stableValueKey(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => stableValueKey(item)).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableValueKey(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function isPlainMap(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Merge the seeded map into the stored value. Returns `null` when the stored
 * value exists but is not a map — a malformed world is left alone rather than
 * clobbered (the caller treats `null` as "nothing to do"). An absent stored
 * value (fresh seed) merges into an empty map, i.e. the full seeded value.
 */
export function mergeSeedMapProperty(
  current: unknown,
  seeded: Record<string, unknown>,
  supersedes: SeedMapSupersedes | undefined
): SeedMapMergeResult | null {
  if (current !== null && current !== undefined && !isPlainMap(current)) return null;
  const base: Record<string, unknown> = isPlainMap(current) ? current : {};
  const merged: Record<string, unknown> = { ...base };
  let changed = false;
  for (const [key, value] of Object.entries(seeded)) {
    if (!(key in merged)) {
      merged[key] = value;
      changed = true;
      continue;
    }
    const storedKey = stableValueKey(merged[key]);
    if (storedKey === stableValueKey(value)) continue;
    const priors = supersedes?.[key];
    if (priors?.some((prior) => stableValueKey(prior) === storedKey)) {
      merged[key] = value;
      changed = true;
    }
  }
  return { merged, changed };
}
