---
date: 2026-05-02
status: partial
---

# Observability

> Part of the [woo specification](../../SPEC.md). Layer: **operations**.

The contract for what an operator can see about a running woo deployment: logs, metrics, traces, audit. The operational counterpart to the user-facing `:on_$error` observation: those tell users *their* call failed; this tells operators *the platform* is or isn't healthy.

---

## O1. Three flavors of telemetry

- **Logs** — discrete events: a host started, a session ended, a wizard ran a migration, a quota was exceeded. Structured records, queryable.
- **Metrics** — aggregate counters and histograms: calls/sec, p99 latency, storage bytes, memory used. Time-series.
- **Traces** — per-call execution: each `$space:call` produces a span tree showing validate → sequence → resolve verb → run → emit. Sampled.

Each addresses a different operator question. Logs answer "what just happened?" Metrics answer "is the platform healthy?" Traces answer "why was this call slow?"

---

## O2. Per-call traces

> Correlation ids and propagation for these traces are specified in
> [audit.md §AU2](audit.md#au2-correlation-otel-semantics-w3c-propagation)
> (**draft**): `trace_id` follows the OTel/W3C model, is minted or
> adopted at the gateway, and joins these spans to the audit trail.

Every `$space:call` produces a structured trace:

```ts
{
  trace_id:   str,            // unique per call
  call:       { space, message, seq? },
  spans: [
    { name: "validate",     start: int, end: int, status: "ok" | "fail" },
    { name: "authorize",    start: int, end: int, status: ... },
    { name: "sequence",     start: int, end: int, seq_assigned: int },
    { name: "resolve_verb", start: int, end: int, verb: { definer, name, version } },
    { name: "run",          start: int, end: int, ticks: int, mem_peak: int },
    { name: "commit",       start: int, end: int },
    { name: "emit",         start: int, end: int, observation_count: int }
  ],
  result: "applied" | "rejected" | "behavior_failed",
  error?: ErrValue
}
```

Traces are sampled by default (e.g., 1 in 100 calls). The platform may dial up sampling for spaces under investigation. Wizard ops force-trace any call.

Trace storage is operator policy: defaults to 7-day retention with structured query (op id, error code, latency bucket).

---

## O3. Per-host metrics

Each persistent host emits standard metrics:

- `calls_per_sec` (rate)
- `direct_calls_per_sec` and sequenced `applied` frames (rates by route)
- `call_latency_p50/p95/p99` (histogram, ms)
- `error_rate` (rate, per error code)
- `tick_budget_consumed_p99` (histogram)
- `memory_peak_bytes` (histogram)
- `storage_bytes_used` (gauge)
- `storage_flush_slices` (histogram/counter by slice kind: objects, properties, sessions, tasks, counters)
- `startup_storage` events for cold-init repository migration/load/save work, host-seed fetches, and Directory route registration (both object-route and session-route registration; the per-call `writes` count separates diff-deduped no-ops from actual row writes). These are emitted before `WooWorld` finishes initialization, so startup write amplification is visible even when the ordinary world metrics hook is not installed yet.
- Durable Object lifecycle events: `do_constructor` records constructor-body wallclock by DO class, and `do_handler` records method/route handler wallclock by DO class. These split a cold request tail into isolate/constructor time versus actual handler work (for example `/__internal/room-snapshot`). `host_key` is the object host key for `PersistentObjectDO`, the directory key for `DirectoryDO`, and the scope key for `CommitScopeDO`.
- v2 turn-network events: `v2_open` records commit-scope open latency/status, transfer mode, executable-seed cache hit/miss, executable transfer size/page counts, preseeded object count, and full-save use; `shadow_open_executable_seed_bytes` records the executable seed transfer size, total page count, inline page count, and `ok`/`warn` status for each browser scope open; `v2_envelope` records envelope latency/status, idempotency freshness, reply class, fanout, full-save use, projection bytes, append-only tail rows written, and retained tail bytes; `commit_reply_replay` records reply-idempotency mode (`fresh`, `cached_sql`, `cached_kv`, or `miss_after_hibernate`), status, reply class, bytes, and latency so durable reply-row hit rates can be measured before any KV/offload decision; `authority_tail` records accepted-frame/transcript tail rows written/pruned and retained byte counts; `shadow_commit_accepted` and `shadow_commit_rejected` split commit outcomes into tail-queryable counters so operators can answer "is v2 healthy?" without inferring from generic request or cross-host RPC traffic. `v2_host_apply_fanout` records the post-accept write-through from an accepted transcript or row-body-complete projection writes to routed object hosts, including touched row/object count, host count, latency, and retryable failures.
- Turn executor events: `turn_phase_timing` records one row per submitted turn attempt loop with total wall time, repair attempt count, outcome, route, commit scope, and phase totals for `ensure_client`, `authority`, `serialize`, `plan_build`, `vm`, and `submit`. When a caller has finer-grained probes, `ensure_detail_ms` and `submit_detail_ms` carry per-label millisecond maps inside those two phase totals. MCP gateway relays also emit `mcp_relocation_prewarm` when they speculatively open a likely actor commit scope in parallel with planning; the metric records the planning scope, prewarmed commit scope, target, verb, duration, and whether the non-fatal prewarm failed.
- `shadow_apply_step` events partition authoritative shadow transcript application, including object indexing, write collection/application, log application, counters, projection bytes, and total time. Operators use these to explain expensive `/v2/envelope` commits without guessing whether `structuredClone(SerializedWorld)` dominated. `serialized_world_materialized` is emitted at each explicit legacy/export/checkpoint/execution boundary that derives a `SerializedWorld` from indexed state; normal accepted commits must not emit it.
- `shadow_transcript_anomaly` records malformed transcript shapes that are rejected or no-op materialized instead of being silently applied, such as a `contents:remove` write with no corresponding move record.
- `gateway_projection_apply` and `gateway_projection_cache_write` record accepted projection writes consumed by the gateway, including source (`rest`, `mcp`, or `fanout`). `gateway_projection_cache_write` carries `gateway_projection_rows_written` and `gateway_projection_bytes` so smoke-tail reports can distinguish SQL cache writes from generic row counts. `gateway_tool_surface_source_rows` records per-scope and per-shard tool-surface reverse-index growth and cap hits so active-room source-row sizing is visible in smoke tails. `shadow_gateway_apply_step` remains only a legacy/fallback probe for the temporary export → serialized apply → import path; a fresh v2 tail with `projection_delta` present should show gateway projection rows, not gateway whole-world apply scans. `same_host_fallback` records descriptor reads served from the gateway-local projection cache when an owner refresh is unavailable or unnecessary.
- `session_reap` is emitted once per sweep only when at least one session is reaped. It includes `inspected`, `reaped`, `guest_reaped`, `credential_reaped`, and sweep latency so background retention work does not dominate data-path metric counts.
- Browser workers emit `woo.v2.shadow_browser_compose_view` and
  `woo.v2.shadow_browser_execution_promotion` diagnostics to the page for local
  execution-cache composition and accepted write-cell promotion. These are
  client-side probes rather than Analytics Engine events; they report compose
  milliseconds, installed transfer count, tentative overlay count, accepted
  promotion sequence, promoted transcript count, and accepted write-cell page
  count.
- `parked_tasks` (gauge)
- `inbound_rate_drops` (counter)
- `outbound_overflow_drops` (counter)

These are scraped per host on a fixed interval (default 30s). Aggregated up to per-cluster, per-deployment views.

### Long-poll requests

The MCP `woo_wait` tool ([protocol/mcp.md §M5](../protocol/mcp.md#m5-observation-queue)) holds the worker request open for up to its `timeout_ms` budget when the per-session observation queue is empty. In `wrangler tail` these appear as `/net-api/mcp` requests with `wallTime ≈ timeout_ms` (commonly ~1000ms in MCP smoke runs) and `cpuTime ≈ 0` — pure idle holds, not CPU work.

When investigating warm-path tail latency (`/mcp` p95 ≫ p50), partition by `cpuTime / wallTime`:

- `cpuTime ≈ wallTime` → real handler work; investigate the route.
- `cpuTime ≪ wallTime` → idle hold; almost always `woo_wait` or another long-poll. Not a perf bug; do not chase.

Long-poll holds on `/net-api/mcp` should be excluded from any "is the Net turn path slow?" measurement.

---

## O4. Per-actor / per-space metrics

For multi-developer, multi-team operations:

- `calls_by_actor` (counter, per actor)
- `errors_by_actor` (counter, per actor)
- `quota_consumed_by_owner` (gauge: storage, object count, parked tasks)
- `space_active_subscribers` (gauge, per space)
- `replay_request_rate` (rate, per space — useful for catching gap-recovery storms)

These let operators see who's consuming what, surface noisy actors, and bound team-level quota usage ([teams.md](../identity/teams.md)).

---

## O5. Audit log

> Generalized by [audit.md](audit.md) (**draft**): the wizard/privileged
> channel below becomes the operator partition of the unified audit
> trail (`action.kind: "admin"`, AU5). The requirements here remain
> normative for that partition.

Wizard actions and high-privilege operations log to a separate, immutable, append-only audit channel:

- Wizard-flag bypass invocations (`is_wizard(progr)` returning true on a permission check).
- `set_verb_code` / `set_verb_info` / `define_property` / `delete_property` against objects the caller doesn't own.
- `set_quota` overrides.
- Account suspensions, deletions, recovery uses.
- Worktree promotes (who, when, what cluster, what patches).
- Migration runs (who, when, which migration, completion status).
- Backup/restore operations.

Audit retention defaults to indefinite with archival rotation; review tooling lives in the IDE or external observability.

---

## O6. Logs

Structured logs flow from every host. Standard fields: `ts`, `host`, `level`, `event`, plus event-specific data. Levels: `debug`, `info`, `warn`, `error`, `fatal`.

Standard event types include:

- `host.started` / `host.hibernated` / `host.crashed`
- `session.opened` / `session.closed` / `session.detached`
- `space.call.applied` (sample-routed; full traces are separate)
- `space.call.failed` with full err
- `quota.exceeded`
- `migration.started` / `migration.batch_complete` / `migration.complete`
- `wizard.action` (cross-references audit)

Logs are queryable by structured field; the platform's log backend is operator choice.

---

## O7. Dashboards and alerts

Reference dashboards (operators may customize):

- **Overview**: per-deployment calls/sec, error rate, p99 latency, storage utilization.
- **Per-space health**: each major `$space`'s sequencing rate, applied-ok rate, gap-recovery rate.
- **Per-actor activity**: top actors by call rate, error rate.
- **Migrations**: in-flight migration progress, recent runs.

Reference alerts:

- p99 latency > 5s for 10 minutes.
- Error rate > 5% for 5 minutes.
- Outbound overflow > N drops in 1 minute.
- Quota exceeded for any owner.
- Migration stalled (no batch progress for 1 hour).
- Audit events of severity warn or above.

---

## O8. Privacy / PII

Logs and traces capture call payloads. If those payloads contain user data, the platform must:

- Redact known-PII fields by default (configurable via per-property flag).
- Permit per-event sampling reduction.
- Allow operators to drop specific fields from trace storage.
- Encrypt audit logs at rest.

This is a configuration policy, not a runtime mandate; implementations may ship with conservative defaults (redact all string property values longer than 64 bytes in traces; only object refs and schema-tagged fields go through verbatim).

---

## O9. What's deferred

- **Distributed tracing across worlds.** When federation v1 lands, traces should propagate; deferred.
- **Profiling** (per-verb tick distributions, hot-path identification). Different feature; richer than per-call traces.
- **Anomaly detection / ML-based alerts.** Pattern-based alerts as above are sufficient for the current contract; learned baselines are v2.
- **Operator runbooks keyed off specific failure modes** (failures.md §F11). These layer on top of observability; not part of the spec.
