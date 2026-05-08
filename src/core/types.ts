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

// Tool descriptor returned by HostBridge.enumerateRemoteTools so the gateway
// can surface verbs on objects that live on a different host. Mirrors the
// gateway-side McpTool shape without name sanitization (the gateway dedupes
// names across the merged set).
export type RemoteToolDescriptor = {
  object: ObjRef;
  verb: string;
  aliases: string[];
  arg_spec: Record<string, WooValue>;
  direct: boolean;
  source: string;
  enclosingSpace: ObjRef | null;
};

// Per spec/semantics/events.md §12.7.1, directed observations route by an
// explicit recipient field rather than by audience-space presence. The set
// is closed in v1; additions here require a spec update so transports stay
// in sync. `told` carries `to`/`from`; `text` (the substrate `tell()`
// primitive's emission) carries `target` — both are routed straight to the
// recipient's sockets regardless of whether the calling verb has a space
// audience. Without `text` here, a verb like `$portable:give` running off
// any $space (the_mug isn't a space, neither is its carrier) emits tell()
// observations that vanish into the audience-broadcast path because
// directAudience(...) returns null.
export const DIRECTED_OBSERVATION_TYPES: ReadonlySet<string> = new Set(["told", "text"]);

export type DirectedRecipients = { to: ObjRef | null; from: ObjRef | null };

export function directedRecipients(observation: Observation): DirectedRecipients {
  if (!DIRECTED_OBSERVATION_TYPES.has(observation.type)) return { to: null, from: null };
  if (observation.type === "text") {
    // `text` is the substrate `tell(actor, …)` primitive's emission. It
    // routes ONLY to the explicit recipient — `actor` is the sender and
    // does not get an echo. Verbs that want the sender to also see the
    // line emit a separate tell(actor, …) themselves (the
    // `:give` / `:take` / `:drop` etc. pattern).
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
    };

export type PropertyDef = {
  name: string;
  defaultValue: WooValue;
  typeHint?: string;
  owner: ObjRef;
  perms: string;
  version: number;
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
  | { kind: "cross_host_rpc"; route: string; host: string; ms: number; status: "ok" | "error" | "timeout"; error?: string; queue_ms?: number }
  | { kind: "storage_flush"; objects: number; properties: number; sessions: number; deleted_sessions: number; tasks: number; deleted_tasks: number; counters: boolean; ms: number; top_properties?: Array<[string, number]>; top_objects?: Array<[ObjRef, number]> }
  | { kind: "storage_direct_write"; what: "object" | "object_delete" | "property" | "property_delete" | "session" | "session_delete" | "task" | "task_delete" | "counters"; ms: number }
  | { kind: "subscribers_write"; space: ObjRef; size: number; delta: number }
  | { kind: "applied"; space: ObjRef; seq: number; verb: string; ms: number }
  | { kind: "direct_call"; target: ObjRef; verb: string; audience: ObjRef | null; observations: number; ms: number; status: "ok" | "error"; error?: string }
  | { kind: "mcp_request"; method: string; tool?: string; ms: number; status: "ok" | "error" }
  | { kind: "init"; phase: "world" | "mcp_gateway"; ms: number }
  | { kind: "startup_storage"; phase: "cf_repository_migrate" | "cf_repository_load" | "cf_repository_save" | "host_seed_fetch" | "directory_schema" | "directory_register_objects" | "directory_inherit_tombstones"; ms: number; status: "ok" | "error"; objects?: number; properties?: number; sessions?: number; logs?: number; snapshots?: number; tasks?: number; routes?: number; writes?: number; statements?: number; stored?: boolean; error?: string; count?: number; inserted?: number; routes_removed?: number; batch_seq?: number; final?: boolean }
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
  | { kind: "cross_host_rpc_start"; route: string; host: string };

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
  currentLocation: ObjRef;
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

export function cloneValue<T extends WooValue>(value: T): T {
  return structuredClone(value);
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
