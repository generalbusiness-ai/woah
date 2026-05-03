---
date: 2026-04-29
status: partial
---

# Backups

> Part of the [woo specification](../../SPEC.md). Layer: **operations**.

How a woo world is exported, archived, and restored. The contract for moving a world between environments and recovering from disaster.

This workflow is primarily for the Cloudflare production profile with required
dev/staging/prod progression. In-memory and local SQLite modes use the same
archive format for portability, but typically target one deployment and skip
multi-environment choreography by default.

This document covers the same cross-environment lifecycle used by the Cloudflare production profile. In in-memory and local SQLite modes, export/restore are still valid backup primitives, but there is typically one durable deployment target and no mandatory dev/staging/prod progression.

For deployment/authoring setup around restores and environment moves, see [DEPLOY.md](../../DEPLOY.md).

---

## B1. The backup problem

Persistence is real but not a backup. A deployment's storage survives crashes, restarts, and platform incidents within that target. It does not survive:

- A bad deploy that corrupts data via wrong code.
- Operator error (recycle the wrong object, force-bypass a perm check, run the wrong migration).
- Catastrophic platform incident.
- A world being moved to a different deployment.

Backups are the operational answer. They produce:

- A complete, restorable snapshot of the world's state, code, and history.
- An archive that can be moved between environments (dev → staging → prod), as used by Cloudflare production deployments.
- A baseline for disaster recovery within stated RPO/RTO.

---

## B2. World export format

A world export is a single canonical archive:

```
woo-world-export-v1/
├── manifest.json              — spec version, export time, scope, integrity hashes
├── seeds.json                 — universal classes (the bootstrap graph)
├── corenames.json             — $foo → ULID map from the Directory
├── objects/
│   ├── <ulid>.json            — one file per object (metadata, props, verbs, schemas)
│   └── ...
├── spaces/
│   ├── <space-ulid>.log       — space message log (V2-canonical, one message per line)
│   └── <space-ulid>.snap      — latest snapshot per space, if any
├── sessions.json              — active session records (optional)
└── metadata.json              — arbitrary world-level metadata
```

Format is JSONL where appropriate (large logs); single JSON files for smaller artifacts. All values are V2-canonical encoded ([values.md §V2](../semantics/values.md#v2-canonical-json-encoding)).

`manifest.json`:

```ts
{
  woo_version:    "v0.1.0",       // spec version implemented by the source world
  exported_at:    "2026-04-29T12:00:00Z",
  exported_by:    ObjRef,         // wizard who initiated
  scope:          "world" | "cluster",
  cluster_root?:  ObjRef,
  object_count:   int,
  total_messages: int,
  hash:           string          // sha256 over the directory's V8-canonical bytes
}
```

The hash makes archives content-addressable: two exports of the same world state at the same seqs produce identical hashes. This composes with replay-canonical encoding ([values.md §V8](../semantics/values.md#v8-replay-canonical-form)).

---

## B3. Cluster export

For partial backup or worktree promotion across deployments, a single anchor cluster can be exported on its own. Format is a subset of B2: only the affected objects, only the cluster's space, with `manifest.scope = "cluster"` and `cluster_root` set.

Cluster exports cannot be restored as standalone worlds (they need universal classes); they're restored *into* an existing world's matching cluster.

---

## B4. Schedule

Operator policy. Reference defaults:

- **Continuous incremental.** Per-space message logs are appended-to durable storage in real time; the platform's per-DO durability covers this.
- **Hourly snapshot rollup.** Every hour, the platform writes per-space snapshots and bundles them into an incremental archive.
- **Daily full export.** Once daily, a full world export is generated and archived to long-term storage (off-deployment if available).
- **Weekly restoration drill.** Once weekly (recommended), the daily export is restored to a staging deployment to verify the export is good. Drift between live and restored is alerted.

Retention defaults: hourly for 7 days, daily for 30 days, weekly for 1 year, monthly indefinitely. Tunable per-world.

---

## B5. Restore

```
restore_world(archive_url, options)
```

Options:

- `target_deployment` — the deployment to restore into. Default: current.
- `replace_existing` — if `true`, the existing world is wiped first. Default `false` (refuses if any objects exist).
- `seed_only` — load only universal classes; skip world-specific content. Useful for fresh starts.
- `up_to_seq` — restore each space only up to the specified seq. Useful for "restore to before the bad seq."

Restore is wizard-only. It runs as a background job:
1. Validate archive integrity (hash matches manifest).
2. Create objects in dependency order (parents before children, anchors before anchored).
3. Replay space message logs in seq order, reconstructing materialized state. (Snapshots may be loaded directly to skip earlier replay.)
4. Reattach sessions if `--with-sessions` (rare; usually sessions are cleared on restore).
5. Report completion or failure.

A restore failure mid-run (e.g., archive corruption discovered partway through) leaves the deployment in a partial state. The platform tracks the partial-restore state so a subsequent restore can resume or roll back.

---

## B6. Disaster recovery scenarios

| Scenario | Action |
|---|---|
| Single-DO data corruption | Restore that object's state from the most recent snapshot + log replay. |
| Whole-world corruption | Restore from latest daily export to a fresh deployment; redirect traffic. |
| Bad deploy (code regression) | Roll back code via worktree; data unaffected. |
| Bad data (operator error) | Restore affected cluster from the most recent hourly snapshot. |
| Platform-wide incident | Restore from off-deployment archive into a new deployment. |
| Need to inspect old state | Restore daily export to a sandbox; query directly. |

Each scenario uses the same primitives: the export format and `restore_world`.

---

## B7. Cross-environment migration

Backups are also how worlds move between environments:

- Export from prod → restore into staging for QA.
- Export from staging → restore into a fresh dev deployment for a developer's local environment.
- Export from one cloud region → restore into another (latency-driven move).

The restore flow above handles this transparently. Cross-environment restores typically use `replace_existing: true` (wiping the target) and `up_to_seq` to align with a known-good source state.

This composes with worktrees: a Cloudflare production workflow is: a developer
working on a feature in dev can take a snapshot of prod, restore it into a fresh
sandbox, develop against representative data, then promote their patch series back
through dev → staging → prod.

---

## B8. What's deferred

- **Encrypted-at-rest backups.** Default exports are plaintext (signed by the operator's key for integrity). Encrypted archives are a v2 feature; key management is non-trivial.
- **Differential backups.** Currently each daily export is a full copy. Differentials (only changed objects since last export) are a v2 optimization.
- **Point-in-time recovery to a chosen seq.** `up_to_seq` covers "stop replay at N" but not "restore to *exactly* what state was at that seq, with no later effects" — those rare cases use a full export from a specific seq, which is heavier.
- **Automated cross-deployment failover.** Backups are restorable; automating the failover policy is operational tooling, not core spec.
