/**
 * Versioned, self-routing API-key identifiers.
 *
 * The id is deliberately public metadata. It names the immutable authority
 * root and bound actor so a cold Net gateway can fetch one bounded cluster
 * before it knows the credential record. Authentication still depends only on
 * the separately generated secret and its salted hash.
 *
 * Hex encoding keeps the grammar unambiguous for arbitrary UTF-8 object ids;
 * underscores separate fields and never occur in a hex payload.
 */

export const ROUTED_API_KEY_PREFIX = "n1_";

export type RoutedApiKeyId = {
  authorityRoot: string;
  actor: string;
  entropy: string;
};

// Runtime object ids are opaque but bounded at this public routing boundary.
// The Net cell grammar reserves `:`, and a header-sized attacker must not be
// able to make a gateway allocate or route an arbitrarily large DO name.
const MAX_ROUTED_OBJECT_REF_BYTES = 256;

function utf8Hex(value: string): string {
  return [...new TextEncoder().encode(value)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function fromUtf8Hex(value: string): string | null {
  if (
    !value ||
    value.length > MAX_ROUTED_OBJECT_REF_BYTES * 2 ||
    value.length % 2 !== 0 ||
    !/^[0-9a-f]+$/.test(value)
  ) return null;
  const bytes = new Uint8Array(value.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(value.slice(index * 2, index * 2 + 2), 16);
  }
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return validRoutedObjectRef(decoded) && utf8Hex(decoded) === value ? decoded : null;
  } catch {
    return null;
  }
}

function validRoutedObjectRef(value: string): boolean {
  return Boolean(
    value &&
    !value.includes(":") &&
    new TextEncoder().encode(value).byteLength <= MAX_ROUTED_OBJECT_REF_BYTES
  );
}

export function routedApiKeyId(authorityRoot: string, actor: string, entropy: string): string {
  if (!validRoutedObjectRef(authorityRoot) || !validRoutedObjectRef(actor)) {
    throw new Error("routed apikey requires bounded concrete authority-root and actor refs");
  }
  if (!/^[0-9a-f]{32}$/.test(entropy)) throw new Error("routed apikey entropy must be 16-byte lowercase hex");
  return `${ROUTED_API_KEY_PREFIX}${utf8Hex(authorityRoot)}_${utf8Hex(actor)}_${entropy}`;
}

export function parseRoutedApiKeyId(id: string): RoutedApiKeyId | null {
  if (!id.startsWith(ROUTED_API_KEY_PREFIX)) return null;
  const fields = id.slice(ROUTED_API_KEY_PREFIX.length).split("_");
  if (fields.length !== 3 || !/^[0-9a-f]{32}$/.test(fields[2])) return null;
  const authorityRoot = fromUtf8Hex(fields[0]);
  const actor = fromUtf8Hex(fields[1]);
  if (!authorityRoot || !actor) return null;
  return { authorityRoot, actor, entropy: fields[2] };
}

export function routedApiKeyScope(id: string): string | null {
  const parsed = parseRoutedApiKeyId(id);
  if (!parsed) return null;
  return parsed.authorityRoot.startsWith("$") ? "catalog" : `cluster:${parsed.authorityRoot}`;
}
