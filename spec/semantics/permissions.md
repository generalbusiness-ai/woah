---
date: 2026-04-30
status: implemented
---

# Permissions and security

> Part of the [woo specification](../../SPEC.md). Layer: **semantics**.

Covers object flags, verb/property perms, the `progr` discipline, the trust boundary between persistent and transient hosts, and per-owner quotas.

---

## 11. Permissions and security

### 11.1 Object-level flags

| Flag | Meaning |
|---|---|
| `wizard` | Object grants its `progr` activations bypass on perm checks. |
| `programmer` | Actor may author/edit verbs and properties on objects it owns. |
| `fertile` | Other users can `chparent` to this object. |

### 11.2 Verb perms

Bits: `r` (source readable to non-owner), `w` (writable by non-owner), `x` (executable as command), `d` (direct-callable shorthand). The persisted verb metadata field is `direct_callable`; `rxd` in source or a catalog manifest is ingestion shorthand for `perms: "rx"` plus `direct_callable: true`. Runtime storage should prefer the normalized form (`perms: "rx"`, `direct_callable: true`); older imported worlds may still contain `d` in `perms`, and loaders should treat it as the same shorthand when repairing or reinstalling verbs.

Owner of a verb is the principal under which the verb runs (`progr`). This is set when the verb is created; it is not the caller.

### 11.3 Property perms

Bits: `r` (readable), `w` (writable), `c` (chown — owner can be changed by anyone with this bit).

### 11.4 Effective permission

Every frame has a `progr` field (the verb owner at the time of compilation). Permission checks within the verb body use `progr`, not `caller`. This is MOO's discipline and we keep it; it means a verb runs at *its author's* permission, not its invoker's.

A wizard `progr` bypasses all perm checks except where explicitly restricted.

Dispatch route is not an authority model. Direct calls, sequenced `$space:call`,
REST/WS ingress, parked-task resumes, and VM `CALL_VERB`/`PASS` choose ordering,
durability, presence, and transport behavior; all object behavior still enters
the same permission kernel:

1. Resolve the verb by normal object lookup.
2. Check that the caller's current `progr` may execute it: `x`, verb owner, or
   wizard.
3. Run the new frame with `progr` set to the resolved verb's owner.
4. Check property reads, writes, definitions, and metadata changes against the
   current frame's `progr`.

Public wizard-owned verbs are therefore public capabilities. This is allowed and
MOO-like, but such verbs must either be deliberately capability-shaped or check
`actor`/`player` and drop effective permissions before doing caller-controlled
work. `set_task_perms(actor)` is the minimal drop primitive: it changes the
current task's effective `progr` for subsequent VM operations. `task_perms()`
returns the current effective principal; `caller_perms()` returns the effective
principal of the caller frame. Only a wizard-privileged frame may set task
permissions to a different object; non-wizard frames may only set them to their
current value. Generic wizard-owned setters on a universal ancestor are not safe
public capabilities.

### 11.5 Cross-host trust

When a task calls between persistent hosts within the same deployment, the receiver trusts the call envelope's `progr`. The deployment boundary is the trust boundary.

When a task calls from a persistent host into a transient host (browser), the originating host retains the canonical task identity. The transient host may not modify `progr`; on return, the originating host uses its stored identity fields and treats browser output as untrusted return data.

See [protocol/hosts.md §3.3](../protocol/hosts.md#33-trust-model-across-hosts) and [§3.4](../protocol/hosts.md#34-host-rpc-invariants) for the protocol-level rules.

### 11.6 Capabilities (deferred)

Fine-grained per-verb-call capability tokens are not in v1. Wizard-vs-not-wizard is the only privilege gradient. Capabilities may be added in a later version.

### 11.7 Storage quotas and accounting

Each object owns durable state (its persistent storage footprint plus any forked/suspended tasks parked on its host). Per-owner caps prevent runaway resource consumption.

| Quota | Default | Enforcement |
|---|---|---|
| Object count per owner | 1000 | At `create()` time, against the owner's `created` list. Real-time. |
| Storage bytes per owner | 100 MiB | Eventually consistent. |
| Active parked tasks per owner | 10000 | At `FORK`/`SUSPEND` time, against owner's running counter. Real-time. |

Storage accounting is **eventually consistent**: a periodic accounting job sums each owner's footprint and writes it back to a per-owner record, which `create()` and large `SET_PROP` calls consult. A burst write can briefly exceed quota before accounting catches up. Strict real-time accounting would require a central allocator and contradict the decentralized minting story ([objects.md §5.5](objects.md#55-id-allocation)).

Wizards override per-owner quotas with `set_quota(owner, kind, value)`. Quota changes are logged (deferred wizard audit, see [LATER.md](../../LATER.md)).

The v1 implementation of accounting (a `QuotaAccountant` singleton DO running daily passes) is in [../reference/quotas.md](../reference/quotas.md).
