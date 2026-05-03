---
date: 2026-04-29
status: partial
---

# Worktrees

> Part of the [woo specification](../../SPEC.md). Layer: **operations**.

The contract for staging changes to a live woo world without making them
visible until the change is ready: developing a multi-verb refactor, testing
against representative state, promoting atomically when it works.

This is targeted at Cloudflare mode (see [SPEC.md §1.1](../../SPEC.md)); in-memory and local SQLite modes may implement worktrees as local snapshots using the same patch/promote data model.

This is what makes woo serious for multi-developer teams. LambdaMOO let wizards edit live and discover breakage by trying; that worked when one wizard owned the world. With many programmers, schema changes, and multi-verb refactors, "edit live, hope nothing breaks" is no longer table-stakes.

---

## W1. Vocabulary

- **Patch.** A single normalized object/state mutation: a verb edit, a property def, a value set, a recycle, etc. Each patch carries the *expected* prior state so it can be rebased or reverted.
- **Patch series.** An ordered list of patches; the unit of a developer's pending work.
- **Sandbox.** An isolated runtime: a copy of the world (or a subset) that accepts calls and applies patches without affecting the live world.
- **Worktree.** A `{sandbox, patch series}` pair owned by a developer. The sandbox provides a runtime to test against; the patch series records what's been changed so it can be promoted.
- **Promote.** Apply a worktree's patch series to the live world. **Atomic per anchor cluster** (§W13); cross-cluster promotes are sequenced cluster-by-cluster, with explicit handling of partial-success outcomes.

The git analogy:
- A *worktree* is a working state of the world.
- A *patch series* is the diff the worktree introduces.
- *Promote* is `git push` to live, with `expected_version` as the equivalent of fast-forward checks.

---

## W2. The unit of branching

Two compositions:

**Per-anchor-cluster.** The smallest worktree is one anchor cluster. The dubspace and its anchored controls fork as a unit because they share a host and atomicity boundary; you can't sensibly fork half of them.

**Per-world.** A world worktree is the union of cluster worktrees plus the seed graph itself: every relevant cluster gets its own sandbox, plus the universal classes (`$system`, `$root`, `$space`, etc.).

Per-cluster is the primitive; per-world is composition. A developer refactoring just the dubspace creates a cluster worktree; a developer overhauling the seed graph creates a world worktree.

Worktrees do not *bisect* anchor clusters. The cluster is atomic in the live runtime and atomic in worktrees too.

---

## W3. Patches

A patch is the normalized form of a single mutation. Canonical types:

| Patch type | Args | Reversible |
|---|---|---|
| `set_verb_code` | obj, name, source, expected_version | yes (capture old source/version) |
| `set_verb_info` | obj, name, expected_version, info | yes |
| `define_property` | obj, name, default, perms, type_hint?, expected_version | yes (delete) |
| `set_property_info` | obj, name, expected_version, info | yes |
| `set_property_value` | obj, name, value, expected_version? | yes (capture old value) |
| `delete_property` | obj, name, expected_version | yes (recreate from captured) |
| `create_object` | parent, owner, anchor?, initial_props? | yes (recycle) |
| `recycle_object` | obj | partial — state is lost; only the ref slot is reusable |
| `chparent` | obj, new_parent | yes (revert) |
| `migrate_property` | class, name, transform_verb, batch_size? | partial — see [migrations.md §M3](migrations.md) |

Each patch is a value per [values.md §V2](../semantics/values.md#v2-canonical-json-encoding); a patch series is a list of canonical maps. Worktrees can be exported, shared, code-reviewed, archived. Two developers can review each other's patch series outside the runtime.

`expected_version` on a patch records the live world's state at authoring time. On promote, if live has advanced past `expected_version`, the patch refuses to apply and the worktree must be rebased (W6).

---

## W4. Sandboxes

A sandbox is an isolated runtime that:

- Starts from a snapshot of the live world (for cluster scope: the relevant cluster snapshot; for world scope: the full seed plus all owned clusters).
- Receives the worktree's patch series applied at creation time.
- Accepts calls and applies them just like the live world, but writes go to sandbox-only state. Live world is unaffected.
- Has its own actor connections; sessions established against the sandbox do not surface to live actors and vice versa.
- Can be discarded freely without affecting live.

In Cloudflare mode, a sandbox is a separate Worker namespace (or a sub-namespace within the deployment). Connections are routed by URL or token: `wss://world.example/connect?worktree=<id>` reaches the sandbox; `wss://world.example/connect` reaches live. In-memory and local SQLite modes may implement a process-local sandbox clone with an equivalent isolate of the runtime.

A sandbox costs real durable storage. The platform caps:

- Concurrent sandboxes per developer (default 5).
- Sandbox storage budget per worktree (default 1 GiB).
- Idle sandbox TTL (default 7 days; reset on developer activity).

These are tunable per-world. Idle sandboxes are reaped — their patch series is preserved as audit; the runtime state is freed.

---

## W5. The worktree lifecycle

```
1. Create
   create_worktree({ scope: "cluster"|"world", anchor?, base_seq?: int })
     - Allocates a sandbox.
     - Snapshots the relevant cluster(s) at base_seq (default: current live seq).
     - Returns worktree_id and a connection URL/token.

2. Develop
     - Each compile_verb / set_verb_code / define_property / etc. issued
       against the sandbox is also recorded as a patch in the worktree's series.
     - Patches accumulate in author order.
     - The developer may make calls against the sandbox to test the changes.

3. Test
     - Sandbox accepts calls; applied state diverges from live as expected.
     - Test corpora can replay against the sandbox.
     - Other worktree owners may have read-only views of the sandbox.

4. Review
     export_worktree(id) -> patch series (canonical JSON)
     - Externally diff-able and code-reviewable.
     - Two reviewers can compare their worktrees side by side.

5. Promote
     promote_worktree(id, options?) -> PromoteResult
     - Patches are grouped by their target anchor cluster.
     - For each cluster, the cluster's patches apply atomically: all-or-nothing
       within the cluster, using captured reverse-patches on any
       expected_version mismatch or apply failure.
     - Clusters are committed sequentially in dependency order.
     - On a cluster's failure: that cluster's patches are rolled back via
       reverse-patches; prior clusters remain applied. PromoteResult lists
       which clusters committed and which failed:
         { committed_clusters, failed_cluster?, failure?: PatchConflict | err,
           pending_clusters }
     - The developer chooses: (a) saga rollback — apply reverse-patches to
       committed clusters, returning the world to its pre-promote state;
       (b) forward retry — rebase the failed cluster's patches and retry;
       or (c) accept partial — some patches landed, others did not, audit
       trail records the state.
     - On full success: live world has all patches applied; worktree is closed.

6. Discard
     discard_worktree(id) -> bool
     - Sandbox storage freed.
     - Patch series preserved as audit for default retention (e.g., 90 days).
```

---

## W6. Conflict and rebase

A worktree's patches were authored against the world at `base_seq`. Between authoring and promotion, the live world advances. When `expected_version` fails on promote, the developer rebases:

- For each conflicting patch, re-read live's current version for the affected object.
- Update the patch's `expected_version` to match.
- Optionally, re-test in a refreshed sandbox.
- Retry promote.

Most rebases are mechanical: `expected_version` fields bump and that's it. A real conflict — someone else edited the same verb after my fork, and the new live source is incompatible with my patch — is a developer-to-developer conversation, not a runtime concern. The platform does not auto-merge.

The audit trail (patch series + base_seq + observed conflicts) is what makes the conversation possible: each developer can see what the other is doing.

---

## W7. State divergence

A subtle case: while developing in a sandbox, the developer ran calls that mutated sandbox state (testing their new code). On promote, only the *patch series* (object/code/schema changes) is applied to live — the divergent *state* is not copied back. This is correct: sandbox state was test data; live keeps its own state.

If a developer wants to migrate live state through their new code (a real schema or data migration), that's a separate operation. The worktree's patch series can include `migrate_property` patches; promoting them runs the live migration in batches. See [migrations.md](migrations.md).

---

## W8. Permissions

| Operation | Who can |
|---|---|
| Create worktree | Any actor with `programmer` flag and at least one editable object in scope. |
| Edit worktree (add patches) | Worktree creator, or wizards. |
| Read worktree | Per-worktree visibility setting; default `private` (creator + wizards). `team` (creator's team) and `public` are also valid. |
| Promote worktree | Requires write authority on every object the patch series touches in live. Wizards can promote any worktree. |
| Discard worktree | Worktree creator or wizards. |

Worktrees bound on object permissions: a developer can author a patch against any object their session-as-actor would normally be able to mutate live. They cannot bypass live perms by going through a worktree.

---

## W9. Quotas

| Quota | Default | Notes |
|---|---|---|
| Concurrent worktrees per developer | 5 | Tunable per-world. |
| Sandbox storage budget per worktree | 1 GiB | Larger via wizard override. |
| Idle sandbox TTL | 7 days | Reset on developer activity. Reaped sandboxes preserve their patch series. |
| Patch series length | 1000 patches | Beyond this, refactor as multiple worktrees. |
| Total worktree storage per developer | 5 GiB | Sum across active sandboxes. |

These constrain platform cost. Operators can raise them per-developer for active maintainers.

---

## W10. Audit

Every worktree action is logged:
- creation (who, when, scope, base_seq)
- patch additions (who, when, what)
- promotion (who, when, applied_count, conflicts)
- rebase (who, when, conflicts resolved)
- discard (who, when, retention)

The log is append-only. Wizards may inspect any developer's worktree history; developers may inspect their own. Beyond the audit retention window (default 90 days), worktree history is summarized to "developer X promoted Y patches across Z worktrees in this period."

---

## W11. What's not in worktrees

- **Auto-merge of conflicting patches.** Worktree conflicts are a developer conversation, not a runtime feature. The platform records conflict details; resolution is manual.
- **Per-actor private branches.** "Every actor's session sees their own version of the world" is a different model (per-session overlay) and not specced here. Worktrees are explicit and materialized.
- **Time-travel** ("rewind live by N seqs"). Worktrees fork *forward*; rewinding live state is a separate operation handled by snapshot restoration in [migrations.md](migrations.md).
- **Audited approval workflows** ("PR-style review before promote"). Worktrees provide the data structure; an approval workflow is a policy on top, implementable by guarding `promote_worktree` with a verb that consults a `$reviews` space. Out of scope for this document.
- **Branching from a non-current snapshot.** `base_seq` parameter exists but typical use is `current`. Branching from an older snapshot — replaying live's recent log against your patch series — is a power-user feature that adds complexity without clear v1 demand.

---

## W12. Implementation pressure

Worktrees expose four primitives the runtime must provide:

1. **Sandbox runtime.** An isolated execution environment that runs the same code as live.
2. **Patch capture.** Every authoring mutation issued against a sandbox is automatically recorded as a patch.
3. **Atomic promote within an anchor cluster.** A cluster's patches apply to live in order with full `expected_version` checking, with clean rollback (via captured reverse-patches) on any partial failure. Cross-cluster promotes commit cluster-by-cluster with explicit per-cluster atomicity; partial cross-cluster failures are observable rather than hidden.
4. **Snapshot fork.** Cluster (and world) snapshots can be cheaply duplicated for sandbox seeding.

These are each non-trivial. In Cloudflare mode, sandbox runtime requires Worker namespace support; in-memory and local SQLite modes use process-local snapshots. Patch capture requires authoring-API instrumentation; atomic-per-cluster promote requires a transactional within-DO apply with `expected_version` semantics on every patch type.

The minimal IDE ([authoring/minimal-ide.md](../authoring/minimal-ide.md)) is the consumer of these primitives. Worktrees are how the IDE becomes a tool that real developers can use without fear of breaking live.

---

## W13. Atomicity scope

The atomicity guarantee is **per anchor cluster**, not per promote operation.

Why: an anchor cluster is the runtime's atomicity unit ([objects.md §4.1](../semantics/objects.md#41-anchor-and-atomicity-scope)) — one host, one transaction. Patches within a cluster apply as one transaction. A promote that touches multiple clusters is, at the runtime level, multiple transactions on multiple hosts.

A multi-cluster promote sequences cluster-transactions in dependency order. If any single transaction fails:

- That cluster's transaction rolls back via captured reverse-patches.
- Prior clusters remain committed.
- Subsequent clusters are not attempted.

The PromoteResult surfaces which clusters committed, which failed, and what's pending. Three operator responses:

- **Saga rollback.** Apply reverse-patches to committed clusters; the world returns to its pre-promote state. Cost: applies twice; subject to per-cluster `expected_version` checks at rollback; if the live world has advanced since the original commit, rollback is rejected and manual reconciliation is needed.
- **Forward retry.** Rebase the failed cluster's patches against the latest live state, retry. Subsequent clusters proceed if the failed cluster commits.
- **Accept partial.** Some patches landed; others didn't. Useful when the partial state is itself coherent. Recorded in audit.

The goal is honest atomicity: don't promise "all-or-nothing across the whole promote" when the runtime's transaction unit is the cluster. Saga rollback is available as an explicit operation, not pretended to be implicit.

Single-cluster promotes: same machinery, simpler outcome — one transaction, all-or-nothing as the user expects.
