// Transport-neutral object-host write-through fan-out.
//
// An accepted v2 commit must reach every object-host that owns a touched cell:
// the host this node represents applies locally, every other host receives a
// forwarded apply. On Cloudflare those forwards are Durable Object RPCs that can
// time out, fail individually, or race a route change; localdev historically
// applied every host slice in one in-process world with no forward step and so
// never exercised those failure modes.
//
// This module owns the part that is identical across runtimes — local apply,
// concurrent remote forward, the success/error metric, and the `E_RETRY`
// contract when any forward fails — parameterised over the per-host *slice*
// (the whole transcript in transcript mode; that host's projection rows in
// projection mode). Each caller keeps its own partition (host resolution) and
// supplies the apply/forward closures, so CF keeps its RPC transport and Directory
// routing while localdev can drive the same fan-out through an in-process,
// fault-injectable transport.

import { wooError, type MetricEvent, type ObjRef } from "./types";
import { normalizeError } from "./world";
import type { ProjectionWrite } from "./projection-delta";

// Resolve the object-host that owns an id. Async on CF (Directory lookup), sync
// on localdev (route map). The same routing both runtimes use to partition a
// commit's writes by owning host.
export type HostResolver = (id: ObjRef) => string | Promise<string>;

// Partition a commit's projection writes by the host that owns each row, so each
// host receives only the rows it is authoritative for. Mirrors the table→host
// routing both runtimes need: object/tombstone rows route by their object id;
// log/snapshot rows by their space; parked tasks by their parked_on (or the
// scope on delete); sessions/counters/tool-surfaces stay on the fallback
// (gateway) host. Empty/falsy host keys are dropped.
export async function partitionProjectionWritesByHost(
  writes: readonly ProjectionWrite[],
  scope: ObjRef,
  fallbackHost: string,
  resolveHost: HostResolver
): Promise<Map<string, ProjectionWrite[]>> {
  const byHost = new Map<string, ProjectionWrite[]>();
  const add = (hostKey: string, write: ProjectionWrite): void => {
    if (!hostKey) return;
    const list = byHost.get(hostKey) ?? [];
    list.push(write);
    byHost.set(hostKey, list);
  };
  for (const write of writes) {
    switch (write.table) {
      case "objects":
      case "tombstones":
        add(await resolveHost(write.key), write);
        break;
      case "logs":
      case "snapshots":
        add(await resolveHost(write.key.space), write);
        break;
      case "parked_tasks":
        add(write.op === "upsert" ? await resolveHost(write.row.parked_on) : await resolveHost(scope), write);
        break;
      case "sessions":
      case "counters":
      case "tool_surfaces":
        add(fallbackHost, write);
        break;
    }
  }
  return byHost;
}

// The local materialization a write-through reports back to the commit path:
// the host that applied locally (so the caller can skip re-applying it) plus
// whether that host is the gateway/WORLD host. `null` when this node owned no
// touched cell and only forwarded.
export type HostWriteThroughResult = { hostKey: string; gatewayHost: boolean } | null;

export interface HostWriteFanout<TSlice> {
  // The host this node represents; its slice (if any) is applied locally.
  localHostKey: string;
  // True when `hostKey` is the gateway/WORLD host (governs the reported result).
  isGatewayHost: (hostKey: string) => boolean;
  // The commit partitioned by owning host. Slices for hosts other than
  // `localHostKey` are forwarded; the `localHostKey` slice is applied locally.
  slicesByHost: Map<string, TSlice>;
  // Apply the local host's slice to this node's state.
  applyLocal: (slice: TSlice) => Promise<void> | void;
  // Forward a remote host's slice (RPC on CF; in-process on localdev). A throw
  // (timeout, rejection) fails the whole write-through with E_RETRY, matching
  // the CF contract where a partial fanout must be retried, not silently lost.
  forwardRemote: (hostKey: string, slice: TSlice) => Promise<void>;
  // Diagnostics.
  scope: ObjRef;
  touched: number;
  retryMessage: string;
  onMetric?: (event: MetricEvent) => void;
}

// Run the local apply + concurrent remote forward for one accepted commit.
// Behaviour mirrors persistent-object-do's writeThrough* methods exactly: local
// host applies first and is removed from the forward set; all remaining hosts
// forward concurrently; any failure throws E_RETRY so the commit is retried
// rather than left partially materialized.
export async function fanOutHostWrites<TSlice>(fanout: HostWriteFanout<TSlice>): Promise<HostWriteThroughResult> {
  const { localHostKey, slicesByHost, scope, touched, retryMessage } = fanout;
  const startedAt = Date.now();
  const remote = new Map(slicesByHost);
  let localApplied = false;
  try {
    const localSlice = remote.get(localHostKey);
    if (localSlice !== undefined) {
      await fanout.applyLocal(localSlice);
      remote.delete(localHostKey);
      localApplied = true;
    }
    await Promise.all(Array.from(remote, ([host, slice]) => fanout.forwardRemote(host, slice)));
    fanout.onMetric?.({
      kind: "v2_host_apply_fanout",
      scope,
      hosts: remote.size + (localApplied ? 1 : 0),
      touched,
      ms: Date.now() - startedAt,
      status: "ok"
    });
    return localApplied ? { hostKey: localHostKey, gatewayHost: fanout.isGatewayHost(localHostKey) } : null;
  } catch (err) {
    const error = normalizeError(err);
    fanout.onMetric?.({
      kind: "v2_host_apply_fanout",
      scope,
      hosts: remote.size,
      touched,
      ms: Date.now() - startedAt,
      status: "error",
      error: error.code
    });
    throw wooError("E_RETRY", `${retryMessage}: ${error.message}`, { scope, error });
  }
}
