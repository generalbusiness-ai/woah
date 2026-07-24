---
date: 2026-07-19
status: draft
---

# Quota accounting

> Part of the [woo specification](../../SPEC.md). Layer: **reference**. CF-specific implementation of the per-owner quotas defined abstractly in [../semantics/permissions.md §11.7](../semantics/permissions.md#117-storage-quotas-and-accounting).

> **Revision note (2026-07-19).** The original R5 described a singleton
> QuotaAccountant DO that walked every known owner on a daily alarm and
> RPC'd every owned DO — global enumeration, a Big-World violation — and it
> gated growth only at `create()`/large `SET_PROP`, leaving every other
> growth path (verb installs, property definitions, metadata, notes)
> uncharged. This revision replaces that design. Nothing of the old design
> was implemented, so there is no migration.

---

## R5. Storage accounting as a projection of committed deltas

Storage charging is **generic over committed positive storage deltas**, not
surface-specific checks. Every committed turn produces an effect transcript
([coherence.md](../protocol/coherence.md) CO9); the bytes each write adds or
frees are measurable there, per cell, at commit time. The accounting rule:

1. **Measure at commit.** The committing scope computes, per turn, the net
   storage delta attributable to each *owner* whose objects the turn wrote:
   V2-canonical encoded size of new cell values minus replaced ones, with
   object creation and verb/property-definition writes included. Any path
   that grows state is charged by construction, because charging keys off
   the transcript, not off which builtin ran.
2. **Deliver to the owner's accounting row.** Deltas route to a per-owner
   row via the same routed-delivery pattern the audit trail uses
   ([audit.md](../operations/audit.md)): accounting state is keyed/sharded
   **by owner**, so no component ever enumerates all owners. Delivery is
   asynchronous and idempotent (keyed by commit id); replays and retries do
   not double-charge.
3. **Admit against a cached standing.** Scopes cache the committing owner's
   quota standing (total + limit, refreshed opportunistically from the
   owner's row). A turn whose net positive delta would exceed the limit is
   refused `E_QUOTA` at validation. The cache may be stale — see R5.1.

`E_QUOTA` maps to HTTP 429 at the gateway.

### R5.1 Eventual consistency

A burst across scopes can briefly exceed quota before deltas land and cached
standings refresh; the next refresh blocks further growth. This is the
accepted trade — strict global admission would require a synchronous central
allocator, contradicting both the decentralized minting story
([../semantics/objects.md §5.5](../semantics/objects.md#55-id-allocation))
and Big-World discipline. Freed bytes credit the same way, with the same lag.

### R5.2 Owner accounting row

Per-owner state, one row, held by the owner's accounting shard:

```jsonc
{
  "owner":            "<account/actor ULID>",
  "bytes_used":       0,
  "object_count":     0,
  "delivery_watermark": {"<scope>": "<last commit id charged>"},  // idempotency
  "override_bytes":   null,   // wizard override; null = deployment default
  "override_count":   null
}
```

`object_count` maintains from create/recycle deltas the same way bytes do.
(Pending scheduled turns are out of scope here: they are bounded per scope
and per object as scope-local state under
[coherence.md §CO16.7](../protocol/coherence.md#co167-quotas), not as owner
storage.)

### R5.3 Reconciliation

Delta accounting drifts only through bugs or lost deliveries, but a repair
path is required and must be bounded: `account_now(owner)` — wizard-invoked,
**one owner at a time** — recounts that owner's storage via a paginated walk
of the owner's own created-objects relation and rewrites the row. There is
no whole-world pass, scheduled or otherwise. A discrepancy between recount
and running total is logged as a diagnostic: it indicates a charging bug to
investigate, not a number to silently correct.

### R5.4 Deferred

- Per-team rollups ([../identity/teams.md](../identity/teams.md)) — same
  mechanism keyed by team, once account→team attribution is settled.
- Surfacing quota standing to users (an `$account` projection property).
- Byte-precise accounting of derived/projection state (charged to the
  system, not to owners, in v1).
