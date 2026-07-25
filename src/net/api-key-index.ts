/**
 * Authority-private API-key verifier index.
 *
 * The actor's `api_keys` property is the sole authority. This index exists
 * only inside that actor's owning Scope DO so authentication can read one
 * verifier in O(1). It is deliberately not a CO13 relation: it never enters
 * closure transfers, subscriber fanout, gateway mirrors, or public relation
 * vocabulary.
 */
import { parseRoutedApiKeyId } from "../core/api-key-id";
import type { Cell } from "./cells";

export const ACTOR_API_KEYS_PROPERTY = "api_keys";

export type ApiKeyVerifierRow = {
  actor: string;
  id: string;
  record: Record<string, unknown>;
};

export function apiKeyVerifierKey(actor: string, id: string): string {
  return `${actor}\0${id}`;
}

export function apiKeyVerifierRowsForActor(actor: string, value: unknown): Map<string, ApiKeyVerifierRow> {
  const payload = value && typeof value === "object" && !Array.isArray(value)
    ? value as { value?: unknown }
    : {};
  const map =
    payload.value && typeof payload.value === "object" && !Array.isArray(payload.value)
      ? payload.value as Record<string, unknown>
      : {};
  const rows = new Map<string, ApiKeyVerifierRow>();
  for (const [id, record] of Object.entries(map)) {
    const routed = parseRoutedApiKeyId(id);
    if (!routed || routed.actor !== actor || !record || typeof record !== "object" || Array.isArray(record)) continue;
    const row = { actor, id, record: record as Record<string, unknown> };
    rows.set(apiKeyVerifierKey(actor, id), row);
  }
  return rows;
}

/** Rebuild is bounded by one authority scope's cells. */
export function rebuildApiKeyVerifierIndex(cells: Iterable<Cell>): Map<string, ApiKeyVerifierRow> {
  const rows = new Map<string, ApiKeyVerifierRow>();
  for (const cell of cells) {
    if (
      cell.kind !== "property_cell" ||
      cell.object === "$system" ||
      cell.name !== ACTOR_API_KEYS_PROPERTY
    ) continue;
    for (const [key, row] of apiKeyVerifierRowsForActor(cell.object, cell.value)) rows.set(key, row);
  }
  return rows;
}
