export type ObjRef = string;

export type WooValue =
  | null
  | boolean
  | number
  | string
  | ObjRef
  | WooValue[]
  | { [key: string]: WooValue };

export type ErrorValue = {
  code: string;
  message?: string;
  value?: WooValue;
  trace?: WooValue[];
};

export type Message = {
  actor: ObjRef;
  target: ObjRef;
  verb: string;
  args: WooValue[];
  body?: Record<string, WooValue>;
};

export type Observation = Record<string, WooValue> & {
  type: string;
};

export function sessionActiveScopeFromRecord(record: Record<string, unknown> | null | undefined): ObjRef | null {
  if (typeof record?.active_scope === "string") return record.active_scope;
  if (typeof record?.current_location === "string") return record.current_location;
  return null;
}

// Tool descriptor returned by ExecutorContext.enumerateRemoteTools so the gateway
// can surface verbs on objects that live on a different host. Mirrors the
// gateway-side McpTool shape without name sanitization (the gateway dedupes
// names across the merged set).
export type RemoteToolDescriptor = {
  object: ObjRef;
  verb: string;
  /** Object that defines the verb. Sparse gateways use it as a support root for inherited tool calls. */
  definer?: ObjRef;
  aliases: string[];
  arg_spec: Record<string, WooValue>;
  direct: boolean;
  reads_room_presence?: boolean;
  source: string;
  enclosingSpace: ObjRef | null;
  source_rows?: Array<{ table: "objects"; authority_scope: ObjRef; key: ObjRef }>;
  stale?: boolean;
  stale_reason?: "owner_timeout" | "retention_gap" | "cache_miss" | "disabled";
};

export type RemoteToolProjection = "tools" | "obvious";

export type RemoteToolRequest = {
  id: ObjRef;
  projection?: RemoteToolProjection;
  expandContents?: boolean;
  contentsProjection?: RemoteToolProjection;
  forceRefresh?: boolean;
};

export type PresenceProjectionDef =
  | {
      kind: "presence";
      key: "actor";
    }
  | {
      kind: "presence";
      key: "session";
      sessionField: string;
      actorField: string;
    };

// Per spec/semantics/events.md §12.7.1, directed observations route by an
// explicit recipient field rather than by audience-space presence. The set
// is closed in v1; additions here require a spec update so transports stay
// in sync. `told` carries `to`/`from`; `text` (the substrate `tell()`
// primitive's emission) carries `target` — both are routed straight to the
// recipient's sockets regardless of whether the calling verb has a space
// audience. Without `text` here, an item or actor verb running outside a
// space audience can emit tell() observations that vanish into the
// audience-broadcast path because directAudience(...) returns null.
export const DIRECTED_OBSERVATION_TYPES: ReadonlySet<string> = new Set(["told", "text"]);

export type DirectedRecipients = { to: ObjRef | null; from: ObjRef | null };

export function directedRecipients(observation: Observation): DirectedRecipients {
  if (!DIRECTED_OBSERVATION_TYPES.has(observation.type)) return { to: null, from: null };
  if (observation.type === "text") {
    // `text` is the substrate `tell(actor, …)` primitive's emission. It
    // routes ONLY to the explicit recipient — `actor` is the sender and
    // does not get an echo. Verbs that want the sender to also see the
    // line emit a separate tell(actor, …) themselves.
    return {
      to: typeof observation.target === "string" ? observation.target : null,
      from: null
    };
  }
  return {
    to: typeof observation.to === "string" ? observation.to : null,
    from: typeof observation.from === "string" ? observation.from : null
  };
}

export type AppliedFrame = {
  op: "applied";
  id?: string;
  space: ObjRef;
  seq: number;
  ts: number;
  message: Message;
  observations: Observation[];
  result?: WooValue;
  audienceSessions?: string[];
  observationSessionAudiences?: string[][];
};

export function publicAppliedFrame(frame: AppliedFrame): AppliedFrame {
  return { ...frame, id: undefined, result: undefined };
}

export type DirectResultFrame = {
  op: "result";
  id?: string;
  command?: unknown;
  result: WooValue;
  observations: Observation[];
  audience: ObjRef | null;
  audienceActors?: ObjRef[];
  observationAudiences?: ObjRef[][];
  audienceSessions?: string[];
  observationSessionAudiences?: string[][];
};

export type LiveEventFrame = {
  op: "event";
  observation: Observation;
};

export type ErrorFrame = {
  op: "error";
  id?: string;
  error: ErrorValue;
};

export type CommandFrame = AppliedFrame | DirectResultFrame | ErrorFrame;

export type TinyOp = [string, ...WooValue[]];

export type TinyBytecode = {
  ops: TinyOp[];
  literals: WooValue[];
  num_locals: number;
  max_stack: number;
  max_ticks?: number;
  max_memory?: number;
  max_wall_ms?: number;
  version: number;
};

export type VerbDef =
  | {
      kind: "bytecode";
      name: string;
      aliases: string[];
      owner: ObjRef;
      perms: string;
      arg_spec: Record<string, WooValue>;
      source: string;
      source_hash: string;
      bytecode: TinyBytecode;
      version: number;
      /** 1-based local verb slot, assigned from the object's ordered verb list. */
      slot?: number;
      line_map: Record<string, WooValue>;
      direct_callable?: boolean;
      skip_presence_check?: boolean;
      tool_exposed?: boolean;
      // Catalog metadata for sparse gateways: this verb renders or otherwise
      // depends on a room/workspace roster, so a gateway that only holds
      // session stubs must seed current Directory presence for candidate rooms.
      reads_room_presence?: boolean;
      // Declares the verb performs no observable state mutation: no property
      // writes, no moveto, no observe-with-side-effects, no recycle, no host
      // effects. May be set by the static analyzer (derived from bytecode +
      // call graph) OR by a catalog manifest assertion — see `pure_declared`
      // for the manifest-declared bit alone.
      pure?: boolean;
      // True iff the catalog manifest currently asserts `pure: true` for this
      // verb. Distinct from `pure` (which can also be true via call-graph
      // propagation). Drift detection compares this flag, so a catalog can
      // remove a `pure: true` declaration without changing the source.
      pure_declared?: boolean;
      // Verb-call sites recorded by the DSL compiler. Used to (a) validate
      // every `this:name()` resolves on the definer's class chain at
      // install time and (b) propagate purity transitively across the
      // call graph. An empty array means "compiled with the extractor, no
      // call sites" (e.g. PASS-only or no calls); `undefined` means the
      // metadata predates the extractor and should be treated as opaque.
      calls?: VerbCallSite[];
    }
  | {
      kind: "native";
      name: string;
      aliases: string[];
      owner: ObjRef;
      perms: string;
      arg_spec: Record<string, WooValue>;
      source: string;
      source_hash: string;
      version: number;
      /** 1-based local verb slot, assigned from the object's ordered verb list. */
      slot?: number;
      line_map: Record<string, WooValue>;
      native: string;
      direct_callable?: boolean;
      skip_presence_check?: boolean;
      tool_exposed?: boolean;
      reads_room_presence?: boolean;
      pure?: boolean;
      pure_declared?: boolean;
      calls?: VerbCallSite[];
    };

export type PropertyDef = {
  name: string;
  defaultValue: WooValue;
  typeHint?: string;
  owner: ObjRef;
  perms: string;
  version: number;
  presenceProjection?: PresenceProjectionDef;
};

export type WooObject = {
  id: ObjRef;
  name: string;
  parent: ObjRef | null;
  owner: ObjRef;
  location: ObjRef | null;
  anchor: ObjRef | null;
  flags: {
    wizard?: boolean;
    programmer?: boolean;
    fertile?: boolean;
  };
  created: number;
  modified: number;
  propertyDefs: Map<string, PropertyDef>;
  properties: Map<string, WooValue>;
  propertyVersions: Map<string, number>;
  verbs: VerbDef[];
  children: Set<ObjRef>;
  contents: Set<ObjRef>;
  eventSchemas: Map<string, Record<string, WooValue>>;
};

// Engine-level instrumentation. Hosts install a hook (`WooWorld.setMetricsHook`)
// that drains these and emits structured logs (`woo.metric ...`) so tail-based
// debugging can reason about audience size, cross-host RPC cost, and
// per-broadcast fanout without rebuilding the verb path. The set is closed in
// v1; new kinds need a spec note + emission point.
export type MetricEvent =
  | { kind: "broadcast"; audience_size: number; obs_count: number; ms: number; origin_session?: string }
  | { kind: "compose_look"; room: ObjRef; present_count: number; contents_count: number; remote_titles: number; remote_describe_batches: number; ms: number }
  | { kind: "cross_host_rpc"; route: string; host: string; ms: number; status: "ok" | "error" | "timeout"; error?: string; queue_ms?: number; rpc_id?: string }
  | { kind: "storage_flush"; objects: number; properties: number; sessions: number; deleted_sessions: number; tasks: number; deleted_tasks: number; counters: boolean; ms: number; rows?: number; top_properties?: Array<[string, number]>; top_objects?: Array<[ObjRef, number]> }
  // `rows` is a logical-operations estimate, not a measured SQL row count.
  // Single-row ops (`session`, `task`, `tombstone`, `snapshot`,
  // `log_outcome`) report 1. Direct `property`/`property_delete` report 3
  // (def/value/version rows), direct `counters` reports 3, flush `counters`
  // reports 4 (version + three counters), and `log_append` reports 4 (3 from
  // the implicit next_seq saveProperty plus the space_message insert).
  // `log_truncate` is the only `what` that reports the engine-returned count
  // (the DELETE's row total). For object writes the count is derived from the
  // SerializedObject shape — `serializedObjectRowCount` in src/core/world.ts.
  // Object deletes report 1 (the cascade DELETEs across property_def,
  // property_value, property_version, verb, child, content, event_schema were
  // already accounted for when those rows were last written; the metric is
  // counting "logical persistence operations", not physical SQL row touches).
  | { kind: "storage_direct_write"; what: "object" | "object_delete" | "property" | "property_delete" | "session" | "session_delete" | "task" | "task_delete" | "counters" | "log_append" | "log_outcome" | "snapshot" | "log_truncate" | "tombstone"; ms: number; rows?: number }
  // Full-world rewrites (`repository.save`). One emission per call, regardless
  // of backend. `trigger` names the call site so a regression like the May 2026
  // counter-drift loop is visible from a single grep. `rows` follows the same
  // logical-operations convention as `storage_direct_write` — it's the sum
  // from `serializedWorldRowStats`, derived from SerializedWorld shape rather
  // than measured against the SQL engine.
  | { kind: "storage_full_save"; trigger: "world_persist" | "persist_full_snapshot" | "host_seed_apply"; rows: number; objects: number; properties: number; verbs: number; logs: number; snapshots: number; sessions: number; tasks: number; tombstones: number; ms: number }
  | { kind: "subscribers_write"; space: ObjRef; size: number; delta: number }
  | { kind: "applied"; space: ObjRef; seq: number; verb: string; ms: number }
  | { kind: "direct_call"; target: ObjRef; verb: string; audience: ObjRef | null; observations: number; ms: number; status: "ok" | "error"; error?: string }
  | { kind: "mcp_request"; method: string; tool?: string; ms: number; status: "ok" | "error" }
  | { kind: "mcp_tool_refresh_taken"; actor: ObjRef; source: "invoke" | "accepted_frame"; reason: string; transcript: boolean; session_id?: string; active_scope?: ObjRef | null }
  | { kind: "mcp_tool_refresh_skipped"; actor: ObjRef; source: "invoke" | "accepted_frame"; reason: string; transcript: boolean; session_id?: string; active_scope?: ObjRef | null }
  | { kind: "directory_sessions_for_scopes"; scopes: number; sessions: number; ms: number; status: "ok" | "error" | "timeout"; error?: string }
  // Tool-resolution diagnostic: emitted by createMcpServer's findReachableTool
  // whenever a tools/call requests a specific (object, verb). Captures the
  // gateway's view of the actor's session at decision time so a miss can be
  // classified as stale-client (wrong call shape), session/location desync
  // (gateway has the actor in another room), or genuine tool absence.
  | { kind: "mcp_tool_resolve"; actor: ObjRef; session_id: string; object: ObjRef; verb: string; active_scope: ObjRef | null; actor_location: ObjRef | null; status: "hit" | "miss"; miss_reason?: "not_reachable" | "verb_not_exposed" | "remote_lookup_unavailable" }
  | { kind: "do_constructor"; class: "PersistentObjectDO" | "DirectoryDO" | "CommitScopeDO"; ms: number }
  | { kind: "do_handler"; class: "PersistentObjectDO" | "DirectoryDO" | "CommitScopeDO"; method: string; route: string; ms: number; status: "ok" | "error"; error?: string; error_detail?: string; rpc_id?: string }
  | { kind: "shadow_apply_step"; phase: "clone_world" | "index_objects" | "collect_writes" | "apply_creates" | "apply_writes" | "apply_session" | "sort_objects" | "apply_log" | "counters" | "total"; scope: ObjRef; route: string; ms: number; objects: number; creates: number; writes: number; projection_bytes?: number }
  | { kind: "serialized_world_materialized"; scope: ObjRef; seq: number; reason: string; ms: number; objects: number; sessions: number; logs: number }
  | { kind: "shadow_gateway_apply_step"; phase: "capture_runtime" | "export_world" | "clone_world" | "index_objects" | "collect_writes" | "apply_creates" | "apply_writes" | "apply_session" | "sort_objects" | "apply_log" | "counters" | "apply_serialized" | "import_world" | "restore_runtime" | "total"; scope: ObjRef; route: string; ms: number; objects: number; properties: number; sessions: number; logs: number; creates: number; writes: number }
  | { kind: "shadow_transcript_anomaly"; scope: ObjRef; route: string; reason: "contents_remove_without_move"; object: ObjRef; id?: string }
  | { kind: "shadow_open_executable_seed_bytes"; scope: ObjRef; node: string; bytes: number; pages: number; inline_pages: number; status: "ok" | "warn" }
  | { kind: "v2_open_step"; phase: string; scope?: ObjRef; node?: string; actor?: ObjRef; route?: string; method?: string; path?: string; what?: string; reason?: string; ms: number; status: "ok" | "error"; count?: number; bytes?: number; transfer_mode?: string; executable_transfer_cache?: "hit" | "miss"; full_save?: boolean; error?: string; error_detail?: string }
  | { kind: "v2_open"; scope?: ObjRef; node?: string; ms: number; status: "ok" | "error"; transfer_mode?: string; executable_transfer_cache?: "hit" | "miss"; executable_transfer_bytes?: number; executable_transfer_pages?: number; executable_transfer_inline_pages?: number; preseeded_objects?: number; full_save?: boolean; error?: string; error_detail?: string }
  | { kind: "v2_state_transfer"; scope?: ObjRef; node?: string; ms: number; status: "ok" | "error"; transfer_mode?: string; full_save?: boolean; error?: string; error_detail?: string }
  | { kind: "v2_envelope"; scope?: ObjRef; node?: string; ms: number; status: "ok" | "error"; fresh?: boolean; reply?: "none" | "accepted" | "live" | "missing_state" | "commit_rejected"; fanout?: number; full_save?: boolean; projection_bytes?: number; tail_rows_written?: number; tail_bytes_retained?: number; request_bytes?: number; reply_bytes?: number; receiver_reply_bytes?: number; fanout_bytes?: number; error?: string; error_detail?: string }
  | { kind: "commit_reply_replay"; scope?: ObjRef; node?: string; route: "/v2/envelope"; mode: "fresh" | "cached_sql" | "cached_kv" | "miss_after_hibernate"; status: "ok" | "miss"; reply?: "none" | "accepted" | "live" | "missing_state" | "commit_rejected"; bytes?: number; ms: number }
  | { kind: "v2_envelope_bytes"; scope?: ObjRef; node?: string; relay_warmth: string; request_bytes: number; authority_bytes: number; capsule_authority_bytes: number; capsule_present: boolean; sessions_bytes: number; session_objects_bytes: number; envelope_bytes: number }
  | { kind: "mcp_envelope_slim_reseed"; scope?: ObjRef; mode: "slim" | "capsule" }
  | { kind: "authority_tail"; scope: ObjRef; ms: number; tail_rows_written: number; tail_rows_pruned: number; tail_bytes_retained: number; accepted_frames_retained: number; transcript_tail_retained: number }
  | { kind: "gateway_projection_apply"; scope: ObjRef; rows: number; projection_bytes: number; source: "rest" | "mcp" | "fanout" }
  | { kind: "gateway_projection_cache_write"; scope: ObjRef; rows: number; bytes: number; projection_bytes: number; gateway_projection_rows_written: number; gateway_projection_bytes: number; source: "rest" | "mcp" | "fanout" }
  | { kind: "gateway_tool_surface_source_rows"; scope: ObjRef; object: ObjRef; rows: number; scope_rows: number; shard_rows: number; cap: number; shard_cap: number; saturated: boolean; saturation_reason?: "scope" | "shard" | "scope_and_shard" }
  | { kind: "same_host_fallback"; route: "/__internal/enumerate-tools"; host: string; rows: number; reason: "owner_timeout" | "cache_hit" }
  | { kind: "v2_ws_reject"; scope?: ObjRef; node?: string; ms: number; status: "error"; error: string; error_detail?: string }
  | { kind: "v2_ws_open"; scope: ObjRef; node: string; actor: ObjRef; ms: number; status: "ok" }
  | { kind: "v2_ws_close"; scope?: ObjRef; node?: string; actor?: ObjRef; code: number; clean: boolean; reason?: string; ms: number; status: "ok" }
  | { kind: "v2_ws_error"; scope?: ObjRef; node?: string; actor?: ObjRef; ms: number; status: "error"; error: string; error_detail?: string }
  | { kind: "browser_activity"; phase: string; source: "v2_browser_worker" | "main"; scope?: ObjRef; node?: string; actor?: ObjRef; route?: string; method?: string; path?: string; what?: string; reason?: string; ms: number; status: "ok" | "error"; count?: number; bytes?: number; records?: number; request_bytes?: number; request_body_bytes?: number; request_known_pages?: number; request_known_page_hash_bytes?: number; request_known_page_cache?: number; request_known_page_cache_count?: number; request_known_page_cache_bytes?: number; request_atom_hashes?: number; request_missing_atoms?: number; request_missing_atom_preimages?: number; request_missing_atom_bytes?: number; request_missing_read_verbs?: number; request_missing_read_props?: number; request_missing_read_contents?: number; request_missing_lifecycle?: number; request_missing_writes?: number; request_missing_other?: number; request_key_atoms?: number; request_key_preimages?: number; request_key_read_verbs?: number; request_key_read_props?: number; request_key_read_contents?: number; request_key_lifecycle?: number; request_key_writes?: number; request_key_other?: number; reply_bytes?: number; reply_metadata_bytes?: number; reply_page_ref_bytes?: number; reply_inline_bytes?: number; reply_preimage_bytes?: number; reply_atom_hash_bytes?: number; reply_page_refs?: number; reply_inline_pages?: number; reply_omitted_pages?: number; reply_preimages?: number; reply_atom_hashes?: number; reply_sessions?: number; reply_logs?: number; reply_snapshots?: number; reply_parked_tasks?: number; reply_tombstones?: number; reply_source_pages?: number; reply_source_objects?: number; reply_known_page_cache?: number; reply_known_page_cache_count?: number; reply_known_page_cache_bytes?: number; transfer_mode?: string; executable_transfer_cache?: "hit" | "miss"; error?: string; error_detail?: string }
  | { kind: "rest_v2_in_process_fallback"; reason: "no_commit_scope"; scope: ObjRef; target: ObjRef; verb: string; route: "direct" | "sequenced"; persistence: "durable" | "live" }
  | { kind: "shadow_commit_accepted"; scope: ObjRef; seq: number; node?: string; id?: string; fanout?: number }
  // B6: a turn whose write set reduced to two or more distinct non-planning
  // authority owners (a genuine multi-scope turn). Emitted so the multi-scope
  // rate is measurable before B8 route-home enforcement decides reject-vs-mint.
  | { kind: "commit_scope_multi"; scope: ObjRef; owners: number; verb?: string }
  | { kind: "shadow_commit_rejected"; scope?: ObjRef; node?: string; id?: string; reason: string }
  | { kind: "v2_host_apply_fanout"; scope: ObjRef; hosts: number; touched: number; ms: number; status: "ok" | "error"; error?: string }
  | { kind: "mcp_fanout"; scope: ObjRef; shards: number; observations: number; affected_scopes?: number; scoped_shards?: number; audience_session_shards?: number; subscriber_shards?: number; local_suppressed?: boolean; origin_session?: string | null }
  | { kind: "init"; phase: "world" | "mcp_gateway"; ms: number }
  | { kind: "startup_storage"; phase: "cf_repository_migrate" | "cf_repository_load" | "cf_repository_save" | "host_seed_fetch" | "host_seed_fetch_kv_miss" | "mcp_gateway_snapshot_fetch" | "directory_schema" | "directory_register_objects" | "directory_register_objects_skip" | "directory_register_session" | "directory_inherit_tombstones"; ms: number; status: "ok" | "error"; objects?: number; properties?: number; sessions?: number; logs?: number; snapshots?: number; tasks?: number; routes?: number; writes?: number; statements?: number; stored?: boolean; error?: string; error_detail?: string; count?: number; inserted?: number; routes_removed?: number; batch_seq?: number; final?: boolean; source?: "kv" | "do" | "digest_hit" | "directory" }
  | { kind: "state_projection"; ms: number; objects: number; remote_hosts: number }
  | { kind: "host_schema_sync"; host: string; planned: number; skipped: number; ms: number }
  // Diagnostic events for the host-task serialization queue (world.ts
  // enqueueHostTask). Used to fingerprint wedges where one task never settles
  // and blocks every subsequent verb call. `host_task_blocked` fires when a
  // new task enqueues while another is already running (so the wedge target
  // is identified). `host_task_long_running` is a 3-second watchdog that
  // fires repeatedly for tasks that haven't settled — without this, a wedge
  // produces no log at all.
  | { kind: "host_task_enqueue"; id: number; label: string; queue_depth: number }
  | { kind: "host_task_start"; id: number; label: string; queued_ms: number }
  | { kind: "host_task_done"; id: number; label: string; ms: number; status: "ok" | "error"; error?: string }
  | { kind: "host_task_blocked"; new_id: number; new_label: string; current_id: number; current_label: string; current_elapsed_ms: number; queue_depth: number }
  | { kind: "host_task_long_running"; id: number; label: string; elapsed_ms: number }
  // Logged when a cross-host RPC fires (the `cross_host_rpc` end event only
  // logs on settle, so a wedged fetch leaves no trace at all).
  | { kind: "cross_host_rpc_start"; route: string; host: string; rpc_id?: string }
  // Legacy event emitted by the former timeout policy that omitted remote rows
  // outright. Kept in the union so log-analysis scripts can parse older tails.
  | { kind: "authority_slice_omitted"; host: string; object_count: number; reason?: "timeout" | "snapshot_fallback" }
  // Emitted by v2GatewayAuthorityPayload when a per-envelope refresh's
  // /__internal/authority-slice fetch to a remote host timed out and we chose
  // to fall back to the gateway's last-known authority rows. The sender
  // already records a `cross_host_rpc{status:"timeout", rpc_id}` for the
  // underlying RPC; this distinct event captures the higher-level policy
  // decision so cross_host_rpc latency stats stay clean.
  | { kind: "authority_slice_stale_fallback"; host: string; object_count: number; reason: "timeout" | "snapshot_fallback" | "content_expansion_timeout" }
  // Sparse MCP gateway pre-plan expansion from a requested scope's direct
  // contents to the contained objects' owner authority. This is bounded identity
  // repair for roster/name reads, not global enumeration.
  | { kind: "authority_slice_content_expansion"; roots: number; objects: number; hosts: number; cap: number }
  // Emitted every time an authority slice is reconstructed on the turn path
  // (step 2a of the cell-authority perf plan, notes/2026-05-31-...). This is
  // the measurement that lets 2b–2e prove they remove per-turn reconstruction
  // and that lets warm-turn cost be tracked SEPARATELY from cold-open and from
  // genuine missing-state repair (plan §"Success metrics — warm vs cold").
  //
  // `reason` is the bucket that keeps those apart; it MUST distinguish:
  //  - "warm_turn_refresh"   — per-envelope / per-turn authority refresh against
  //                            an already-open scope. This is the bucket step 2
  //                            must drive toward zero; a healthy steady state has
  //                            none of these.
  //  - "cold_open"           — first-open seeding of a scope (session open /
  //                            relay creation). A bounded, expected cost.
  //  - "missing_state_repair"— a CommitScopeDO snapshot-required reseed after a
  //                            genuine miss (E_SNAPSHOT_REQUIRED). Expected and
  //                            healthy; tracked as its own bucket so it never
  //                            reads as a warm-turn regression.
  //  - "slice_served"        — the source-host /__internal/authority-slice
  //                            handler assembling and returning a slice to a
  //                            requesting gateway. `source_host` is the local
  //                            (serving) host here; the assembly buckets above
  //                            report the assembling gateway's own host.
  // (A5 removed the in-memory authority checkpoint, so the warm_checkpoint_*
  // reasons it emitted — hit / caught_up / repaired / seeded — are retired. A
  // warm turn now reconstructs from local rows + owner slices; a future
  // read-through over the durable gateway projection cache may reintroduce a
  // distinct hit bucket, but it is not this checkpoint.)
  // `scope` is the commit/turn scope being reconstructed (`$nowhere` when no
  // scope is in hand, e.g. the source-host handler). `object_count` and
  // `page_count` size the slice — page_count counts cell pages for the new
  // cell-slice representation (CA12), or object rows for the legacy slice.
  // `source_host` is the host that did the reconstruction.
  | { kind: "authority_slice_reconstructed"; reason: "warm_turn_refresh" | "cold_open" | "missing_state_repair" | "slice_served"; scope: ObjRef; object_count: number; page_count: number; source_host: string }
  // CA11.2 instrumentation: the set of object ids a gateway turn could NOT
  // resolve locally and partitioned to a remote owner host. Fires for every
  // remote host the planning/commit authority refresh touches, whether the
  // remote resolution is a real /__internal/authority-slice RPC or a
  // commit-scope snapshot fallback. It exists because the in-process cf-local
  // harness masks the wire RPC behind the snapshot fallback, so the only
  // harness-independent signal that a cold turn paid for a neighbor's lineage
  // is the partition decision itself. Topology pre-seeding (CA11.2) drives a
  // served scope's one-hop neighbor ids OUT of this partition. `objects` is
  // the sorted remote-id set for `host`; bounded by the turn's read set.
  | { kind: "authority_slice_partition"; host: string; reason: "warm_turn_refresh" | "cold_open" | "missing_state_repair"; object_count: number; objects: ObjRef[] }
  // CA11.2: a gateway shard merged the bounded one-hop topology closure for a
  // served scope into its live world (lineage-only neighbor rooms + shared
  // catalog-class chain), so a cold move resolves neighbor lineage locally. Fires
  // only when at least one row was newly added (idempotent re-runs are silent).
  | { kind: "scope_topology_seed"; scopes: number; seeded: number }
  // Fires once per reapExpiredSessions sweep only when at least one session is
  // actually reaped. This keeps background sweep noise out of data-path tails
  // while preserving enough volume information for retention debugging.
  | { kind: "session_reap"; inspected: number; reaped: number; ms: number; guest_reaped: number; credential_reaped: number }
  // Fired on a peer MCP gateway shard when it receives a remote commit or
  // live-event fanout (acceptRemoteV2Commit / acceptRemoteV2Live). Captures
  // whether the receiving shard has any sessions bound (`queue_count`) and
  // whether this commit was deduped against a prior receipt. Bug A
  // (peer-not-seeing-observation) hinges on these two: if `queue_count` is
  // 0 the shard has nobody to deliver to; if `dedup_skipped` is true the
  // earlier path already handled it.
  | { kind: "mcp_remote_commit_received"; scope: ObjRef; commit_scope: ObjRef; seq: number; origin_session: string | null; observations: number; queue_count: number; dedup_skipped: boolean }
  | { kind: "mcp_remote_live_received"; scope: ObjRef; origin_session: string | null; observations: number; queue_count: number; dedup_skipped: boolean }
  // Summary of one routeShadowAcceptedFrame pass. Distinguishes "scanned
  // queues=N, delivered to M" from "scanned queues=0" (nobody to deliver
  // to) and "scanned queues=N, delivered to 0" (audience filter rejected
  // everyone).
  | { kind: "mcp_observation_routed"; scope: ObjRef; observation_type: string; queues_scanned: number; deliveries: number; route: "live" | "accepted" }
  // Fired on each lazy McpGateway init, after persisted sessions belonging
  // to this shard are re-bound into McpHost.queues. Lets us see whether the
  // rebind on cold-load is actually finding sessions (sessions_rebound > 0)
  // or whether the shard genuinely has nothing to bind (e.g., a fresh DO).
  | { kind: "mcp_gateway_rebind"; host_key: string; sessions_rebound: number; ms: number }
  // Fired from WooWorld.movetoActorChecked when an actor (with an active
  // session) is moved through the session-aware path. Reports whether the
  // primary-session guard fired the physical-move branch, which is the
  // branch that produces the object_move transcript entry. Bug B
  // (outline:leave server-vs-client divergence) hinges on this: a non-
  // primary or remote-actor case updates session.activeScope but not
  // actor.location, leaving the apply transcript without a move write so
  // committed state diverges from the immediate reply.
  | { kind: "moveto_actor"; actor: ObjRef; session_id: string; from: ObjRef | null; to: ObjRef; is_primary: boolean; primary_session_id: string | null; remote_actor_host: boolean; defer_host_effect: boolean }
  // Fired from buildHostSeedForDeliveryWithDigest on every host-seed request
  // so we can measure WORLD's cache effectiveness before/after per-host
  // invalidation changes. A hit is a Map lookup; a miss runs
  // exportHostScopedWorld + canonicalJsonStringify + hashSource over the
  // full host slice. reason: "version_changed" means mutationCounter moved;
  // "absent" means the entry was never built or was explicitly deleted.
  // ms reports the compute cost on a miss.
  | { kind: "host_seed_cache"; host: ObjRef; status: "hit" | "miss"; reason?: "version_changed" | "absent"; ms: number }
  // Distinguishes KV cache absence from bytecode-restore drift. A no_pointer
  // or no_entry is normal during rollout/TTL churn; hash_mismatch means the
  // local/catalog bytecode reservoir no longer matches WORLD's authoritative
  // bytecode hash and the reader fell back to the signed DO response.
  | { kind: "host_seed_kv_restore_miss"; cache: "host_seed"; host: string; reason: "no_pointer" | "no_entry" | "invalid_payload" | "digest_mismatch" | "invalid_bytecode_hashes" | "duplicate_bytecode_hash" | "missing_bytecode_hash" | "inline_hash_mismatch" | "hash_mismatch" | "reservoir_miss" | "incomplete_legacy_bytecode"; ms: number }
  // One-time per Worker isolate and auto-install catalog configuration when a
  // bytecode-free KV entry cannot be restored from local SQL alone.
  | { kind: "kv_catalog_reservoir_build"; catalog_key: string; ms: number; status: "ok" | "error"; objects?: number; verbs?: number; error?: string; error_detail?: string }
  // Emitted on every verb dispatch from the worker's host bridge, so each
  // dispatch leaves a trace of (a) where it routed and (b) which path it
  // took. `path` is "local" when the destination is the same host, "read"
  // for a remote pure verb (forwardInternalReadChecked, 2.5s timeout), and
  // "mutating" for a remote impure verb (forwardInternalChecked, no
  // timeout). Critical for diagnosing wedges that previously left no trail.
  | { kind: "dispatch_resolved"; target: ObjRef; verb: string; host: string; path: "local" | "read" | "mutating"; pure: boolean }
  // Phase attribution for a single submitTurnIntent turn (Slice 1). Splits the
  // turn's wall time across the loop's phases so a slow /mcp POST can be charged
  // to authority reconstruction/fan-in vs local serialize/plan-build/VM compute
  // vs the commit-envelope RPC, and so the repair loop's amplification is
  // visible (`attempts` > 1 multiplies every phase). Each *_ms field sums across
  // attempts; `authority_calls` counts authorityPayload invocations (each a
  // potential cross-host authority-slice round trip). `outcome` distinguishes a
  // committed turn from a local error frame that never reached submitEnvelope.
  | { kind: "turn_phase_timing"; scope: ObjRef; commit_scope: ObjRef | null; target: ObjRef; verb: string; route: string; attempts: number; outcome: "submitted" | "local_frame" | "error"; total_ms: number; ensure_client_ms: number; authority_ms: number; authority_calls: number; serialize_ms: number; plan_build_ms: number; vm_ms: number; submit_ms: number; retry_ms?: number; ensure_detail_ms?: Record<string, number>; submit_detail_ms?: Record<string, number>; retry_detail_ms?: Record<string, number> }
  // Emitted only when submitTurnIntent commits to another attempt. Names the
  // repair trigger and object/cell set that widened the next authority refresh,
  // so sparse-planning retries can be reduced without guessing from aggregate
  // `E_NEED_STATE` counts.
  | { kind: "turn_repair_attempt"; scope: ObjRef; commit_scope: ObjRef | null; target: ObjRef; verb: string; route: string; attempt: number; source: "planning_throw" | "planning_frame" | "commit_reply"; reason: "missing_state" | "lookup_error" | "commit_rejected"; objects: ObjRef[]; atoms?: string[]; commit_reason?: string }
  // MCP-only relocation prewarm timing. A gateway may start the likely actor
  // commit-scope head/session open before local planning proves a B6 relocation;
  // this metric confirms the overlap happened and whether it failed harmlessly.
  | { kind: "mcp_relocation_prewarm"; scope: ObjRef; commit_scope: ObjRef; target: ObjRef; verb: string; ms: number; status: "ok" | "error"; error?: string; error_detail?: string }
  // Phase attribution for the PersistentObjectDO `/mcp` dispatch wrapper (Slice
  // 1). Covers the steps OUTSIDE submitTurnIntent — session forwarding, the SDK
  // transport handle (which for POST contains the turn, for DELETE is just
  // closeSession), and Directory route (de)registration — so a slow DELETE
  // teardown (the worst smoke endpoint at 22s CPU) can be charged to a concrete
  // step instead of guessed. `method` distinguishes POST turns from DELETE
  // teardowns; `forward_ms`/`handle_ms`/`register_ms` split the block.
  | { kind: "mcp_dispatch_timing"; method: string; host: string; cold_world: boolean; status: "ok" | "error"; total_ms: number; get_world_ms: number; forward_ms: number; handle_ms: number; register_ms: number }
  // Emitted when a parent-chain walk hits a missing intermediate. The parent
  // ref on `start` (or one of its ancestors) points at `missing`, which has
  // no entry in the local objects map. Treated as end-of-chain by the walk
  // (so dispatch keeps working) and surfaced here so the orphan can be
  // repaired via a host-scoped data migration. `tombstoned` distinguishes
  // a recycled-out-from-under-it ancestor from a never-present id.
  | { kind: "dangling_parent_ref"; start: ObjRef; missing: ObjRef; tombstoned: boolean };

export type SequencedMessage = {
  space: ObjRef;
  seq: number;
  message: Message;
};

export type SpaceLogEntry = {
  space: ObjRef;
  seq: number;
  ts: number;
  actor: ObjRef;
  message: Message;
  observations: Observation[];
  applied_ok: boolean;
  error?: ErrorValue;
};

export type Session = {
  id: string;
  actor: ObjRef;
  started: number;
  expiresAt: number;
  lastDetachAt: number | null;
  tokenClass: "guest" | "bearer" | "apikey";
  activeScope: ObjRef;
  attachedSockets: Set<string>;
  /** Wall-clock ms of the most recent meaningful input frame on this session.
   * In-memory only — not persisted. Bumped on session create, socket attach,
   * and WS/REST ingress for op: call | direct | input. Drives the LambdaMOO-
   * shaped `idle_seconds` / `is_connected` builtins. */
  lastInputAt: number;
  /** The apikey record id this session was minted from, when tokenClass is
   * "apikey". Lets revokeApiKey close live sessions whose credential was
   * just revoked, instead of leaving them usable until expiry. */
  apikeyId?: string;
};

export type CompileDiagnostic = {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  span?: {
    line: number;
    column: number;
    end_line?: number;
    end_column?: number;
  };
};

// One verb-call site recorded by the DSL compiler. `name` is the verb name
// at the call site (`this:name(...)` → `name`). `this_call` is true when the
// receiver is the literal `this` keyword (statically resolvable on the
// definer's class chain), false for any other receiver expression where the
// target class is not knowable at compile time.
export type VerbCallSite = { name: string; this_call: boolean };

export type CompileResult = {
  ok: boolean;
  diagnostics: CompileDiagnostic[];
  bytecode?: TinyBytecode;
  source_hash?: string;
  line_map?: Record<string, WooValue>;
  metadata?: {
    name?: string;
    perms?: string;
    arg_spec?: Record<string, WooValue>;
    calls?: VerbCallSite[];
  };
};

export type InstallResult = {
  ok: boolean;
  version: number;
  diagnostics?: CompileDiagnostic[];
};

export function wooError(code: string, message?: string, value?: WooValue): ErrorValue {
  return { code, message, value };
}

// Guarded recursive clone for plain JSON-shaped data. This is the hot clone
// path: `cloneValue` runs on every property write, verb install, VM literal
// push, and frame snapshot, and bootstrap/import fan out through it. It replaces
// `structuredClone`, whose worker-transfer serializer dominated localdev cost —
// ~2.6s of a ~3s cold `createWorld` was inside structuredClone (see
// notes/2026-05-29-clone-plain-data.md).
//
// The data woo clones is plain: WooValue, plus structurally-plain runtime records
// cast through `cloneValue` (VerbDef, TinyBytecode, Message, observations, VM
// handlers, ParkedTaskRecord, SpaceLogEntry). For that, a direct recursive copy
// is ~50x cheaper than structuredClone. Unlike structuredClone it deliberately
// does NOT support Date, Map, Set, RegExp, class instances, functions, or cyclic
// references — none are valid woo data, so we THROW rather than silently emit a
// `{}` or loop forever, surfacing a bad caller immediately. Primitives (including
// `undefined`) pass through unchanged, and the result is always freshly mutable —
// callers like the VM's literal push rely on a mutable copy even of frozen
// bytecode literals.
export function clonePlainData<T>(value: T): T {
  return clonePlainDataRecursive(value, undefined);
}

function clonePlainDataRecursive<T>(value: T, path: Set<object> | undefined): T {
  if (value === null) return value;
  const type = typeof value;
  if (type !== "object") {
    if (type === "function" || type === "symbol") {
      throw new TypeError(`clonePlainData: cannot clone a ${type}`);
    }
    return value;
  }
  const node = value as unknown as object;
  if (path?.has(node)) throw new TypeError("clonePlainData: cannot clone a cyclic structure");
  // Lazily allocate the DFS path set so cloning scalars/shallow data stays
  // allocation-free; deleting on unwind makes this detect true cycles without
  // rejecting a shared (non-cyclic) sub-object reached by two paths.
  const ancestors = path ?? new Set<object>();
  ancestors.add(node);
  let out: unknown;
  if (Array.isArray(value)) {
    out = value.map((item) => clonePlainDataRecursive(item, ancestors));
  } else {
    const proto = Object.getPrototypeOf(node);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError(`clonePlainData: cannot clone non-plain object (${node.constructor?.name ?? "unknown prototype"})`);
    }
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(node as Record<string, unknown>)) {
      copy[key] = clonePlainDataRecursive((node as Record<string, unknown>)[key], ancestors);
    }
    out = copy;
  }
  ancestors.delete(node);
  return out as T;
}

export function cloneValue<T extends WooValue>(value: T): T {
  return clonePlainData(value);
}

// Brand of values this module deep-froze. `Object.isFrozen` is NOT a safe
// "deep-frozen" signal — a caller can shallow-freeze the top of an object while
// its arrays/children stay mutable. We therefore track our own deep-freezes in
// a WeakSet so the recursion stop and the share-by-reference gate trust only
// freezes we performed, never an arbitrary external freeze.
const deeplyFrozenValues = new WeakSet<object>();

// True only for values deep-frozen by deepFreezePlainValue. Sharing a bytecode
// object by reference (instead of cloning) is safe ONLY when this returns true;
// an externally shallow-frozen object reports `Object.isFrozen === true` but is
// not safe to share.
export function isDeeplyFrozen(value: unknown): boolean {
  return typeof value === "object" && value !== null && deeplyFrozenValues.has(value as object);
}

// Recursively freeze a JSON-shaped value in place and brand it. The stop signal
// is our own brand (deeplyFrozenValues), not Object.isFrozen — a shallow-frozen
// subtree must still be walked and its children frozen. Used to make compiled
// bytecode immutable so worlds can share one object by reference instead of
// deep-cloning it on every import (see freezeTinyBytecode / importBytecode).
export function deepFreezePlainValue<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  if (deeplyFrozenValues.has(value as object)) return value;
  deeplyFrozenValues.add(value as object);
  Object.freeze(value);
  if (Array.isArray(value)) {
    for (const item of value) deepFreezePlainValue(item);
  } else {
    for (const key of Object.keys(value as Record<string, unknown>)) {
      deepFreezePlainValue((value as Record<string, unknown>)[key]);
    }
  }
  return value;
}

// Compiled bytecode is immutable after compilation: a verb edit builds a fresh
// bytecode object, the VM reads ops/literals read-only, and PUSH_LIT clones
// literals via cloneValue before they reach the stack. Deep-freezing it once on
// the restore/import paths (reservoir build, KV restore, importWorld) lets every
// world share the same branded object by reference with no defensive per-import
// clone, and turns any accidental future in-place mutation into a thrown error
// rather than silent cross-world corruption. (Verbs installed at runtime via
// addVerb are NOT frozen here — only the import/restore paths that share.)
export function freezeTinyBytecode(bytecode: TinyBytecode): TinyBytecode {
  return deepFreezePlainValue(bytecode);
}

export function valuesEqual(left: WooValue, right: WooValue): boolean {
  if (left === right) return true;
  if (typeof left !== typeof right) return false;
  if (left === null || right === null) return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => valuesEqual(value, right[index]));
  }
  if (typeof left === "object" && typeof right === "object") {
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key, index) => key === rightKeys[index] && valuesEqual(left[key], right[key]));
  }
  return false;
}

export function assertString(value: WooValue, code = "E_TYPE"): string {
  if (typeof value !== "string") {
    throw wooError(code, "expected string", value);
  }
  return value;
}

export function assertObj(value: WooValue): ObjRef {
  if (typeof value !== "string") {
    throw wooError("E_TYPE", "expected object reference", value);
  }
  return value;
}

export function assertMap(value: WooValue): Record<string, WooValue> {
  if (value === null || Array.isArray(value) || typeof value !== "object") {
    throw wooError("E_TYPE", "expected map", value);
  }
  return value as Record<string, WooValue>;
}

export function isErrorValue(value: unknown): value is ErrorValue {
  return Boolean(value && typeof value === "object" && "code" in value);
}
