import type { SerializedObject } from "./repository";

const SYSTEM_SENSITIVE_PROPERTY_NAMES = [
  "api_keys",
  "bearer_tokens",
  "pending_email_verifications",
  "signup_invites",
  "provision_state_nonces"
] as const;

export function sensitiveSerializedPropertyNames(obj: SerializedObject): Set<string> {
  const sensitive = new Set<string>();
  if (obj.id === "$system") {
    for (const name of SYSTEM_SENSITIVE_PROPERTY_NAMES) sensitive.add(name);
  }
  // Account credential field names are sensitive wherever they appear. Keeping
  // this name-based avoids adding a new bootstrap class dependency to shared
  // serialization code.
  sensitive.add("password_hash");
  sensitive.add("password_salt");
  sensitive.add("oauth_identities");
  return sensitive;
}

export function isSensitiveSerializedPropertyName(obj: SerializedObject | string, name: string): boolean {
  const id = typeof obj === "string" ? obj : obj.id;
  if (id === "$system" && (SYSTEM_SENSITIVE_PROPERTY_NAMES as readonly string[]).includes(name)) return true;
  return name === "password_hash" || name === "password_salt" || name === "oauth_identities";
}

export function redactSensitiveSerializedPropertyValues(obj: SerializedObject): SerializedObject {
  const sensitive = sensitiveSerializedPropertyNames(obj);
  if (sensitive.size === 0) return obj;
  return {
    ...obj,
    properties: obj.properties.filter(([name]) => !sensitive.has(name)),
    propertyVersions: obj.propertyVersions.filter(([name]) => !sensitive.has(name))
  };
}
