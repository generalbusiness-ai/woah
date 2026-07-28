// Aged-world verb-slot repair (CO4.7 / CT14.7).
//
// Until 2026-07-27 the Net authoring path could not see an object's other verb
// pages, so every verb it wrote claimed `slot: 1` and every metadata edit
// demoted a live verb to slot 1 as well (notes/2026-07-27-net-verb-slots.md).
// Authoring is fixed, but committed cells are not rewritten by a runtime, so
// worlds authored before the fix still hold objects whose pages share an
// ordinal. Slot order is the dispatcher's tie-breaker, so such an object has no
// well-defined order of its own — the MCP resolver refuses those calls
// (`verb_order_unavailable`, spec/protocol/mcp.md §M2.1) rather than guess, and
// the authority's allocation floor sits above the mess but cannot untangle it.
//
// THE TRUE INSERTION ORDER IS NOT RECOVERABLE. A verb page carries no
// timestamp (the bridge zeroes `created`/`modified` — they would churn content
// addresses), and `version` counts edits to that one verb, not global writes.
// Nothing anywhere in the committed state records which of two slot-1 verbs was
// authored first.
//
// So the repair does not attempt to recover it. It applies the tie-break the
// whole system ALREADY uses — slot ascending, then name ascending, which is the
// order `serializedFromCells`, `shadowVerbBytecodePages`, and `world.orderVerbs`
// all produce — and writes that order out as dense ordinals 1..N. The result is
// BEHAVIOUR-PRESERVING BY CONSTRUCTION: every node resolving the unrepaired
// object today computes exactly this sequence, so no dispatch changes. What
// changes is that the sequence becomes explicit, so slot descriptors mean
// something again, the MCP refusal stops firing, and later appends allocate
// above a set of distinct ordinals.

/** One verb page as the repair sees it: the cell name and the `slot` its value
 * carries (absent/invalid → null, an even older page than the duplicates). */
export type VerbSlotPage = { name: string; slot: number | null };

/** The repaired ordinal for each page, or null when the object needs no work.
 *
 * A no-op is defined as "already a strictly ascending, distinct, slot-carrying
 * set in resolution order" — NOT "already dense". Gaps are legitimate
 * (removeVerb leaves them and never reuses an ordinal), so an object with slots
 * 1/3/4 is healthy and must be left alone; renumbering it would invalidate slot
 * descriptors for no gain. Returning null for those is also what makes the
 * operator op idempotent: a second run finds nothing to change.
 */
export function repairedVerbSlots(pages: readonly VerbSlotPage[]): Map<string, number> | null {
  if (pages.length === 0) return null;
  const ordered = [...pages].sort((a, b) =>
    (a.slot ?? 0) - (b.slot ?? 0) || a.name.localeCompare(b.name));
  const healthy = ordered.every((page, index) =>
    page.slot !== null && (index === 0 || page.slot > (ordered[index - 1].slot as number)));
  if (healthy) return null;
  return new Map(ordered.map((page, index) => [page.name, index + 1]));
}
